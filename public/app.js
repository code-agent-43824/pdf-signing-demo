const state = {
  certificates: [],
  pluginReady: false,
  defaultPdfUrl: null,
  uploadedPdfBase64: null,
  uploadedPdfName: null,
  uploadedPdfObjectUrl: null,
};

function setStatus(message) {
  document.getElementById('statusLog').textContent = message;
}

function setPluginState(message) {
  document.getElementById('pluginState').textContent = message;
}

function setUploadState(message) {
  document.getElementById('uploadState').textContent = message;
}

function showPdf(url, metaText) {
  document.getElementById('sourcePdf').src = url;
  document.getElementById('docMeta').textContent = metaText;
}

async function boot() {
  const response = await fetch('./api/form');
  const data = await response.json();
  state.defaultPdfUrl = data.pdfUrl;
  showPdf(data.pdfUrl, `${Math.round(data.size / 1024)} KB`);
  setUploadState('Сейчас используется тестовый PDF с сервера.');
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
      const issuerName = await getProp(certificate, 'IssuerName', 'IssuerName');
      const thumbprint = await getProp(certificate, 'Thumbprint', 'Thumbprint');
      const serialNumber = await getProp(certificate, 'SerialNumber', 'SerialNumber');
      const validToDate = await getProp(certificate, 'ValidToDate', 'ValidToDate');
      const publicKey = await certificate.PublicKey();
      const algorithm = await publicKey.Algorithm;
      const friendlyName = await getProp(algorithm, 'FriendlyName', 'FriendlyName');
      result.push({
        label: subjectName,
        subjectName,
        issuerName,
        thumbprint,
        serialNumber,
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
  const oHashedData = await createObject('CAdESCOM.HashedData');
  await setProp(
    oHashedData,
    'propset_Algorithm',
    'Algorithm',
    detectHashAlgorithmConstant(selectedCertificate),
  );
  await setProp(
    oHashedData,
    'propset_DataEncoding',
    'DataEncoding',
    window.cadesplugin.CADESCOM_BASE64_TO_BINARY,
  );
  await oHashedData.Hash(contentToSignBase64);

  const oSigner = await createObject('CAdESCOM.CPSigner');
  await setProp(oSigner, 'propset_Certificate', 'Certificate', selectedCertificate.certificate);

  const oSignedData = await createObject('CAdESCOM.CadesSignedData');
  return oSignedData.SignHash(
    oHashedData,
    oSigner,
    window.cadesplugin.CADESCOM_CADES_BES,
  );
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}


async function prepareAndSign() {
  if (!state.pluginReady) {
    throw new Error('CryptoPro plugin не готов.');
  }

  const selectedCertificate = await openCertificateDialog(state.certificates);

  setStatus('Подготавливаю PDF под PAdES…');
  const prepareResponse = await fetch('./api/sign/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pdfBase64: state.uploadedPdfBase64,
      signer: {
        subjectName: selectedCertificate.subjectName,
        issuerName: selectedCertificate.issuerName,
        thumbprint: selectedCertificate.thumbprint,
        serialNumber: selectedCertificate.serialNumber,
        validToDate: selectedCertificate.validToDate,
      },
    }),
  });
  const prepareData = await prepareResponse.json();
  if (!prepareResponse.ok || !prepareData.ok) {
    throw new Error(prepareData.message || 'Не удалось подготовить PDF.');
  }

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
  setStatus('Готово: подписанный PDF собран и показан отдельно. Исходный документ в левом окне не менялся.');
}

document.getElementById('pdfUpload').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.type !== 'application/pdf') {
    setStatus('Ошибка: нужен именно PDF-файл.');
    event.target.value = '';
    return;
  }

  try {
    if (state.uploadedPdfObjectUrl) URL.revokeObjectURL(state.uploadedPdfObjectUrl);
    state.uploadedPdfBase64 = await fileToBase64(file);
    state.uploadedPdfName = file.name;
    state.uploadedPdfObjectUrl = URL.createObjectURL(file);
    showPdf(state.uploadedPdfObjectUrl, `${file.name} · ${Math.round(file.size / 1024)} KB`);
    setUploadState(`Загружен пользовательский PDF: ${file.name}`);
    setStatus('Пользовательский PDF загружен. Теперь можно подписывать именно его.');
  } catch (error) {
    setStatus(`Ошибка загрузки PDF: ${error.message}`);
  }
});

document.getElementById('useDefaultPdf').addEventListener('click', async () => {
  if (state.uploadedPdfObjectUrl) {
    URL.revokeObjectURL(state.uploadedPdfObjectUrl);
  }
  state.uploadedPdfBase64 = null;
  state.uploadedPdfName = null;
  state.uploadedPdfObjectUrl = null;
  const response = await fetch('./api/form');
  const data = await response.json();
  state.defaultPdfUrl = data.pdfUrl;
  showPdf(data.pdfUrl, `${Math.round(data.size / 1024)} KB`);
  setUploadState('Сейчас используется тестовый PDF с сервера.');
  setStatus('Возвратился к тестовому PDF с сервера.');
  document.getElementById('pdfUpload').value = '';
});

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
