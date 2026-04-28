const state = {
  certificates: [],
  pluginReady: false,
};

function setStatus(message) {
  document.getElementById('statusLog').textContent = message;
}

function setPluginState(message) {
  document.getElementById('pluginState').textContent = message;
}

function bytesFromBase64(base64) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function base64FromBytes(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function boot() {
  const response = await fetch('./api/form');
  const data = await response.json();
  document.getElementById('sourcePdf').src = data.pdfUrl;
  document.getElementById('docMeta').textContent = `${Math.round(data.size / 1024)} KB`;
  await initCryptoPro();
}

async function createObject(name) {
  if (!window.cadesplugin) {
    throw new Error('cadesplugin не загружен');
  }
  if (window.cadesplugin.CreateObjectAsync) {
    return window.cadesplugin.CreateObjectAsync(name);
  }
  return window.cadesplugin.CreateObject(name);
}

async function getProp(object, asyncGetterName, syncGetterName) {
  if (typeof object[asyncGetterName] === 'function') return object[asyncGetterName]();
  if (syncGetterName in object) return object[syncGetterName];
  throw new Error(`Property ${asyncGetterName}/${syncGetterName} not available`);
}

async function setProp(object, asyncSetterName, syncSetterName, value) {
  if (typeof object[asyncSetterName] === 'function') return object[asyncSetterName](value);
  object[syncSetterName] = value;
}

async function enumerateCertificates() {
  const store = await createObject('CAdESCOM.Store');
  await store.Open(
    window.cadesplugin.CADESCOM_CURRENT_USER_STORE,
    window.cadesplugin.CAPICOM_MY_STORE,
    window.cadesplugin.CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED,
  );

  try {
    const certificates = await getProp(store, 'Certificates', 'Certificates');
    const count = await getProp(certificates, 'Count', 'Count');
    const result = [];

    for (let index = 1; index <= count; index += 1) {
      const certificate = await certificates.Item(index);
      const subjectName = await getProp(certificate, 'SubjectName', 'SubjectName');
      const thumbprint = await getProp(certificate, 'Thumbprint', 'Thumbprint');
      const validToDate = await getProp(certificate, 'ValidToDate', 'ValidToDate');
      const publicKey = await certificate.PublicKey();
      const algorithm = await publicKey.Algorithm;
      const friendlyName = await getProp(algorithm, 'FriendlyName', 'FriendlyName');
      result.push({
        label: subjectName,
        thumbprint,
        validToDate,
        algorithm: friendlyName,
        certificate,
      });
    }

    return result;
  } finally {
    await store.Close();
  }
}

async function initCryptoPro() {
  try {
    if (!window.cadesplugin) {
      throw new Error('Скрипт cadesplugin_api.js не загрузился');
    }

    await Promise.resolve(window.cadesplugin);
    const certificates = await enumerateCertificates();
    state.pluginReady = true;
    state.certificates = certificates;
    setPluginState(`CryptoPro готов, сертификатов найдено: ${certificates.length}`);
    setStatus('Расширение и plugin доступны. Можно готовить документ и выбирать сертификат.');
  } catch (error) {
    setPluginState('CryptoPro недоступен');
    const details = window.cadesplugin?.getLastError ? window.cadesplugin.getLastError(error) : error.message;
    setStatus(`Не удалось инициализировать CryptoPro: ${details}`);
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
      option.textContent = `${certificate.label} · ${certificate.algorithm} · до ${certificate.validToDate}`;
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

function detectHashAlgorithmConstant(certificate) {
  const name = `${certificate.algorithm} ${certificate.label}`.toLowerCase();
  if (name.includes('2012') && name.includes('512')) {
    return window.cadesplugin.CADESCOM_HASH_ALGORITHM_CP_GOST_3411_2012_512;
  }
  if (name.includes('2012') && name.includes('256')) {
    return window.cadesplugin.CADESCOM_HASH_ALGORITHM_CP_GOST_3411_2012_256;
  }
  return window.cadesplugin.CADESCOM_HASH_ALGORITHM_CP_GOST_3411;
}

async function signPreparedContent(selectedCertificate, contentToSignBase64) {
  const contentBytes = bytesFromBase64(contentToSignBase64);
  const digestBuffer = await crypto.subtle.digest('SHA-256', contentBytes);
  const digestHex = Array.from(new Uint8Array(digestBuffer))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

  const oHashedData = await createObject('CAdESCOM.HashedData');
  await setProp(
    oHashedData,
    'propset_Algorithm',
    'Algorithm',
    detectHashAlgorithmConstant(selectedCertificate),
  );
  await oHashedData.SetHashValue(digestHex);

  const oSigner = await createObject('CAdESCOM.CPSigner');
  await setProp(oSigner, 'propset_Certificate', 'Certificate', selectedCertificate.certificate);

  const oSignedData = await createObject('CAdESCOM.CadesSignedData');
  return oSignedData.SignHash(
    oHashedData,
    oSigner,
    window.cadesplugin.CADESCOM_CADES_BES,
  );
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
  setStatus(`Выбран сертификат. Прошу CryptoPro подписать хеш: ${selectedCertificate.label}`);
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
    const details = window.cadesplugin?.getLastError ? window.cadesplugin.getLastError(error) : error.message;
    setStatus(`Ошибка: ${details}`);
  } finally {
    button.disabled = false;
  }
});

boot().catch((error) => {
  document.getElementById('docMeta').textContent = `Ошибка загрузки: ${error.message}`;
  setStatus(`Ошибка запуска страницы: ${error.message}`);
});
