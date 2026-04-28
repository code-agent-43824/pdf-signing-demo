const state = {
  certificates: [],
  pluginReady: false,
  cryptopro: null,
  helper: null,
};

function setStatus(message) {
  document.getElementById('statusLog').textContent = message;
}

function setPluginState(message) {
  document.getElementById('pluginState').textContent = message;
}

async function boot() {
  const response = await fetch('./api/form');
  const data = await response.json();
  document.getElementById('sourcePdf').src = data.pdfUrl;
  document.getElementById('docMeta').textContent = `${Math.round(data.size / 1024)} KB`;
  await initCryptoPro();
}

async function initCryptoPro() {
  try {
    if (!window.cadesplugin || !window.cryptopro) {
      throw new Error('CryptoPro plugin API script not loaded');
    }

    const plugin = await window.cryptopro.getPlugin(window);
    const helper = await window.cryptopro.createHelper(plugin);
    const cryptokeys = await window.cryptopro.createCryptoKeys(helper);
    const certificates = await cryptokeys.getKeysByExtendedKeyUsages(['1.2.643.2.2.34.6', '1.3.6.1.5.5.7.3.2']).catch(() => []);

    state.pluginReady = true;
    state.cryptopro = window.cryptopro;
    state.helper = helper;
    state.cryptokeys = cryptokeys;
    state.certificates = certificates || [];

    setPluginState(`CryptoPro готов, сертификатов найдено: ${state.certificates.length}`);
    setStatus('Можно готовить документ и выбирать сертификат для подписи.');
  } catch (error) {
    setPluginState('CryptoPro недоступен');
    setStatus(`Не удалось инициализировать CryptoPro: ${error.message}`);
  }
}

function openCertificateDialog(certificates) {
  return new Promise((resolve, reject) => {
    if (!certificates.length) {
      reject(new Error('Не найдено доступных сертификатов.'));
      return;
    }

    const fragment = document.getElementById('certificateDialogTemplate').content.cloneNode(true);
    const backdrop = fragment.querySelector('.dialog-backdrop');
    const select = fragment.querySelector('#certificateSelect');
    const confirm = fragment.querySelector('#confirmCertificate');
    const cancel = fragment.querySelector('#cancelCertificate');

    certificates.forEach((certificate, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = certificate.name || certificate.id || `Сертификат ${index + 1}`;
      select.appendChild(option);
    });

    confirm.addEventListener('click', () => {
      const picked = certificates[Number(select.value)];
      backdrop.remove();
      resolve(picked);
    });

    cancel.addEventListener('click', () => {
      backdrop.remove();
      reject(new Error('Выбор сертификата отменён.'));
    });

    document.body.appendChild(backdrop);
  });
}

function detectHashAlgorithm(certificateName = '') {
  const name = String(certificateName).toLowerCase();
  if (name.includes('512')) return 'GOST R 34.11-2012-512';
  if (name.includes('2001')) return 'GOST R 34.11-94';
  return 'GOST R 34.11-2012-256';
}

async function signPreparedContent(selectedCertificate, contentToSignBase64) {
  const buffer = Uint8Array.from(atob(contentToSignBase64), (char) => char.charCodeAt(0)).buffer;
  const subtle = await state.cryptopro.createSubtleCrypto(state.helper);
  const hashAlgorithm = detectHashAlgorithm(selectedCertificate.name);
  const digest = await subtle.digest(hashAlgorithm, buffer);
  const cmsSignature = await subtle.sign('CADES_BES', selectedCertificate, digest);
  return btoa(String.fromCharCode(...new Uint8Array(cmsSignature)));
}

async function prepareAndSign() {
  if (!state.pluginReady) {
    throw new Error('CryptoPro plugin не готов.');
  }

  setStatus('Подготавливаю PDF под PAdES…');
  const prepareResponse = await fetch('./api/sign/prepare', { method: 'POST' });
  const prepareData = await prepareResponse.json();
  if (!prepareResponse.ok || !prepareData.ok) {
    throw new Error(prepareData.message || 'Не удалось подготовить PDF.');
  }

  const selectedCertificate = await openCertificateDialog(state.certificates);
  setStatus(`Считаю хеш и прошу CryptoPro подписать его сертификатом: ${selectedCertificate.name}`);
  const cmsSignatureBase64 = await signPreparedContent(selectedCertificate, prepareData.contentToSignBase64);

  setStatus('Встраиваю CMS-подпись обратно в PDF…');
  const completeResponse = await fetch('./api/sign/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: prepareData.sessionId,
      cmsSignatureBase64,
    }),
  });
  const completeData = await completeResponse.json();
  if (!completeResponse.ok || !completeData.ok) {
    throw new Error(completeData.message || 'Не удалось встроить подпись в PDF.');
  }

  const signedPdf = document.getElementById('signedPdf');
  const signedState = document.getElementById('signedState');
  const downloadLink = document.getElementById('downloadLink');
  signedPdf.src = completeData.signedPdfUrl;
  signedPdf.classList.remove('hidden');
  signedState.classList.add('hidden');
  downloadLink.href = completeData.signedPdfUrl;
  downloadLink.classList.remove('hidden');
  setStatus('Готово: подписанный PDF собран и доступен для скачивания.');
}

document.getElementById('signButton').addEventListener('click', async () => {
  const button = document.getElementById('signButton');
  button.disabled = true;
  try {
    await prepareAndSign();
  } catch (error) {
    setStatus(`Ошибка: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

boot().catch((error) => {
  document.getElementById('docMeta').textContent = `Ошибка загрузки: ${error.message}`;
  setStatus(`Ошибка запуска страницы: ${error.message}`);
});
