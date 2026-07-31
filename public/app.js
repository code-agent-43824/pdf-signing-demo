const state = {
  certificates: [],
  selectedCertificate: null,
  pluginReady: false,
  busyDepth: 0,
  activeCryptoStack: 'cryptopro',
  activeDialog: null,
  selectedStampPosition: 'right',
  cryptoProviders: {
    cryptopro: {
      ready: false,
      checked: false,
      certificates: [],
      client: null,
      diagnostics: {
        extension: { state: 'pending', text: 'Проверка…' },
        plugin: { state: 'pending', text: 'Проверка…' },
        csp: { state: 'pending', text: 'Проверка…' },
      },
    },
    rutoken: {
      ready: false,
      checked: false,
      certificates: [],
      client: null,
      tokenMonitorAttached: false,
      tokenMonitorTimer: null,
      diagnostics: {
        extension: { state: 'pending', text: 'Проверка…' },
        plugin: { state: 'pending', text: 'Проверка…' },
        token: { state: 'pending', text: 'Проверка…' },
      },
    },
  },
  uploadedPdfBase64: null,
  uploadedPdfName: null,
  uploadedPdfObjectUrl: null,
  defaultStampConfig: null,
  stampConfig: null,
  availableFonts: [],
};

const CRYPTO_STACK_LABELS = {
  cryptopro: 'CryptoPro',
  rutoken: 'Рутокен',
};

const CRYPTO_DIAGNOSTIC_LAYOUTS = {
  cryptopro: [
    { key: 'extension', label: 'Расширение CryptoPro' },
    { key: 'plugin', label: 'Плагин CryptoPro' },
    { key: 'csp', label: 'CryptoPro CSP' },
  ],
  rutoken: [
    { key: 'extension', label: 'Расширение Рутокен' },
    { key: 'plugin', label: 'Плагин Рутокен' },
    { key: 'token', label: 'Вставленный токен' },
  ],
};

const CRYPTO_STACK_STORAGE_KEY = 'pdf-signing-demo.crypto-stack';
const STAMP_CONFIG_STORAGE_KEY = 'pdf-signing-demo.stamp-config';
const CRYPTO_SCRIPTS = {
  cryptopro: {
    src: './vendor/cadesplugin_api.js',
    integrity: 'sha384-5w5a3gj2rEglmho8SnY3toHnjMQcHhMaXB5mtbfOLeQlxELCBi7zLlvwgG5pvUwT',
  },
  rutoken: {
    src: './vendor/rutoken-plugin.min.js',
    integrity: 'sha384-Lu5PgN+MfVF7y+8cpsOnSbHd03PcEWEAJPQYmsRlhDX3u1NuI/eR3N4r9z16f8YQ',
  },
};

const STAMP_POSITION_PRESETS = {
  left: {
    label: 'Слева',
    anchor: 'bottom-left',
    offsetX: 24,
    offsetY: 24,
  },
  'center-left': {
    label: 'По центру слева',
    anchor: 'bottom-left',
    offsetX: 163,
    offsetY: 24,
  },
  'center-right': {
    label: 'По центру справа',
    anchor: 'bottom-right',
    offsetX: 163,
    offsetY: 24,
  },
  right: {
    label: 'Справа',
    anchor: 'bottom-right',
    offsetX: 24,
    offsetY: 24,
  },
};

const TEMPLATE_TOKEN_OPTIONS = [
  { value: '{signer.cert_id}', label: 'ID сертификата' },
  { value: '{signer.name}', label: 'ФИО владельца' },
  { value: '{signer.issuer}', label: 'Кем выдан' },
  { value: '{signer.valid_to}', label: 'Срок действия' },
  { value: '{signer.subject_dn}', label: 'Subject DN' },
  { value: '{signer.issuer_dn}', label: 'Issuer DN' },
  { value: '{signer.thumbprint}', label: 'Thumbprint' },
  { value: '{signer.serial_number}', label: 'Serial number' },
];

function setStatus(message) {
  document.getElementById('statusLog').textContent = message;
}

function pushBusyOverlay(message = 'Выполняется криптографическая операция…') {
  state.busyDepth += 1;
  const overlay = document.getElementById('busyOverlay');
  const text = document.getElementById('busyOverlayMessage');
  if (text) {
    text.textContent = message;
  }
  overlay?.classList.remove('hidden');
}

function popBusyOverlay() {
  state.busyDepth = Math.max(0, state.busyDepth - 1);
  if (state.busyDepth > 0) {
    return;
  }
  document.getElementById('busyOverlay')?.classList.add('hidden');
}

async function withBusyOverlay(message, task) {
  pushBusyOverlay(message);
  try {
    return await task();
  } finally {
    popBusyOverlay();
  }
}

function isCryptoEnvironmentOperational(mode = state.activeCryptoStack) {
  const provider = state.cryptoProviders[mode];
  if (!provider?.client) {
    return false;
  }

  if (mode === 'cryptopro') {
    return provider.diagnostics.extension?.state === 'ready'
      && provider.diagnostics.plugin?.state === 'ready'
      && provider.diagnostics.csp?.state === 'ready';
  }

  if (mode === 'rutoken') {
    return provider.diagnostics.extension?.state === 'ready'
      && provider.diagnostics.plugin?.state === 'ready'
      && provider.diagnostics.token?.state === 'ready';
  }

  return false;
}

async function withOperationalCryptoBusyOverlay(message, task, { mode = state.activeCryptoStack } = {}) {
  if (!isCryptoEnvironmentOperational(mode)) {
    return task();
  }
  return withBusyOverlay(message, task);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function setProviderDiagnostic(mode, key, nextState, text) {
  const provider = state.cryptoProviders[mode];
  if (!provider?.diagnostics?.[key]) return;
  provider.diagnostics[key] = {
    state: nextState,
    text,
  };
  if (mode === state.activeCryptoStack) {
    updateEnvironmentDiagnostics();
  }
}

function getCryptoStackLabel(mode = state.activeCryptoStack) {
  return CRYPTO_STACK_LABELS[mode] || mode;
}

function getActiveProviderState() {
  return state.cryptoProviders[state.activeCryptoStack];
}

function getCertificateKey(certificate, mode = state.activeCryptoStack) {
  if (!certificate) return '';
  if (mode === 'rutoken') {
    return `${certificate.deviceId || ''}:${certificate.certId || certificate.thumbprint || ''}`;
  }
  return String(certificate.thumbprint || certificate.serialNumber || certificate.label || '');
}

function requestRutokenEnvironmentRefresh(options = {}) {
  if (state.activeCryptoStack !== 'rutoken' || !state.cryptoProviders.rutoken.client) {
    return Promise.resolve();
  }
  return refreshRutokenEnvironment(options).catch(() => {
    // Ошибку уже показываем в статусах диагностики.
  });
}

function bindRutokenRefreshEvents() {
  window.addEventListener('focus', () => {
    requestRutokenEnvironmentRefresh({ silentStatus: true });
  });
  window.addEventListener('pageshow', () => {
    requestRutokenEnvironmentRefresh({ silentStatus: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      requestRutokenEnvironmentRefresh({ silentStatus: true });
    }
  });
}

function getStampPlacementPresetKey(config = state.stampConfig, { preferSelected = true } = {}) {
  if (preferSelected && STAMP_POSITION_PRESETS[state.selectedStampPosition]) {
    return state.selectedStampPosition;
  }
  const rule = getDefaultPlacementRule(ensureStampConfigShape(config));
  const placement = rule?.placement || {};
  const anchor = String(placement.anchor || 'bottom-right');
  const offsetX = Number(placement.offsetX || 0);
  const offsetY = Number(placement.offsetY || 0);

  return Object.entries(STAMP_POSITION_PRESETS).find(([, preset]) => (
    preset.anchor === anchor
    && Number(preset.offsetX) === offsetX
    && Number(preset.offsetY) === offsetY
  ))?.[0] || 'right';
}

function updateStampPlacementUi() {
  const activePreset = getStampPlacementPresetKey();
  document.querySelectorAll('[data-stamp-position]').forEach((button) => {
    const isActive = button.dataset.stampPosition === activePreset;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function applyStampPlacementPreset(presetKey) {
  const preset = STAMP_POSITION_PRESETS[presetKey];
  if (!preset) return;

  const draft = ensureStampConfigShape(state.stampConfig);
  draft.appearance.width = 128;
  state.selectedStampPosition = presetKey;
  const rule = getDefaultPlacementRule(draft);
  rule.placement.mode = 'anchored';
  rule.placement.anchor = preset.anchor;
  rule.placement.offsetX = preset.offsetX;
  rule.placement.offsetY = preset.offsetY;
  rule.placement.columns = 1;
  rule.placement.stepX = 0;
  rule.placement.stepY = 0;
  state.stampConfig = draft;
  updateStampPlacementUi();
}

function bindRutokenTokenMonitor(plugin) {
  const provider = state.cryptoProviders.rutoken;
  const monitorSource = plugin?.originalObject && typeof plugin.originalObject.tokenMonitor === 'function'
    ? plugin.originalObject
    : plugin;
  if (provider.tokenMonitorAttached || typeof monitorSource?.tokenMonitor !== 'function') {
    return;
  }

  const scheduleRefresh = (type, slotId) => {
    if (provider.tokenMonitorTimer) {
      window.clearTimeout(provider.tokenMonitorTimer);
      provider.tokenMonitorTimer = null;
    }

    if (type === 'disconnected') {
      provider.certificates = [];
      setProviderDiagnostic('rutoken', 'token', 'error', 'не вставлен');
      if (state.activeCryptoStack === 'rutoken') {
        syncActiveProviderState();
        setStatus('Рутокен извлечён.');
      }
    } else if (type === 'connected') {
      setProviderDiagnostic('rutoken', 'token', 'pending', 'обновление…');
      if (state.activeCryptoStack === 'rutoken') {
        setStatus('Рутокен подключён, обновляю состояние…');
      }
    }

    provider.tokenMonitorTimer = window.setTimeout(async () => {
      provider.tokenMonitorTimer = null;
      try {
        await refreshRutokenEnvironment({ silentStatus: true });
        if (state.activeCryptoStack !== 'rutoken') {
          return;
        }

        if (type === 'connected') {
          let label = `Рутокен ${slotId}`;
          try {
            label = await provider.client?.getDeviceInfo(slotId, provider.client.TOKEN_INFO_LABEL) || label;
          } catch (_error) {
            // ignore label lookup failure
          }
          setStatus(`Рутокен подключён: ${label}.`);
        } else if (type === 'disconnected') {
          setStatus('Рутокен извлечён.');
        }
      } catch (_error) {
        // Ошибку уже показываем в диагностике.
      }
    }, type === 'connected' ? 500 : 150);
  };

  monitorSource.tokenMonitor((type, slotId) => {
    scheduleRefresh(type, slotId);
  });

  provider.tokenMonitorAttached = true;
}

function updateSelectedCertificateUi() {
  const labelNode = document.getElementById('selectedCertificateLabel');
  const countNode = document.getElementById('certificateCountHint');
  const button = document.getElementById('chooseCertificateButton');
  const certificateCount = state.certificates.length;

  if (labelNode) {
    if (state.selectedCertificate) {
      labelNode.textContent = `Выбран: ${state.selectedCertificate.label}`;
    } else {
      labelNode.textContent = 'Сертификат не выбран.';
    }
  }

  if (countNode) {
    if (!state.pluginReady) {
      countNode.textContent = 'Сначала дождитесь готовности криптокомпонентов.';
    } else if (!certificateCount) {
      countNode.textContent = 'Нет доступных сертификатов для подписи.';
    } else {
      countNode.textContent = `Доступно сертификатов для подписи: ${certificateCount}.`;
    }
  }

  if (button) {
    button.disabled = !state.pluginReady || !certificateCount;
    button.textContent = state.selectedCertificate ? 'Выбрать другой сертификат' : 'Выбрать сертификат';
  }
}

function syncSelectedCertificate({ announceMissing = false } = {}) {
  if (!state.selectedCertificate) {
    updateSelectedCertificateUi();
    return;
  }

  const selectedKey = getCertificateKey(state.selectedCertificate);
  const refreshed = state.certificates.find((certificate) => getCertificateKey(certificate) === selectedKey);
  if (refreshed) {
    state.selectedCertificate = refreshed;
    updateSelectedCertificateUi();
    return;
  }

  state.selectedCertificate = null;
  updateSelectedCertificateUi();
  if (announceMissing) {
    setStatus('Ранее выбранный сертификат больше недоступен. Выберите сертификат заново.');
  }
}

function renderEnvironmentStatusStrip() {
  const root = document.getElementById('environmentStatusStrip');
  if (!root) return;

  const provider = getActiveProviderState();
  const layout = CRYPTO_DIAGNOSTIC_LAYOUTS[state.activeCryptoStack] || [];
  root.innerHTML = layout.map(({ key, label }) => {
    const diagnostic = provider?.diagnostics?.[key] || { state: 'pending', text: 'Проверка…' };
    return `
      <div class="environment-status-pill is-${escapeHtml(diagnostic.state)}">
        <div class="environment-status-pill-head">
          <span class="environment-status-pill-dot" aria-hidden="true"></span>
          <span class="environment-status-pill-title">${escapeHtml(label)}</span>
        </div>
        <div class="environment-status-pill-value" title="${escapeHtml(diagnostic.text)}">${escapeHtml(diagnostic.text)}</div>
      </div>
    `;
  }).join('');
}

function getSavedCryptoStack() {
  try {
    const fromDom = document.querySelector('input[name="cryptoStack"]:checked')?.value;
    if (CRYPTO_STACK_LABELS[fromDom]) {
      return fromDom;
    }
    const fromStorage = window.localStorage.getItem(CRYPTO_STACK_STORAGE_KEY);
    if (CRYPTO_STACK_LABELS[fromStorage]) {
      return fromStorage;
    }
  } catch (_error) {
    // ignore storage issues
  }
  return 'cryptopro';
}

function syncCryptoStackControls() {
  document.querySelectorAll('input[name="cryptoStack"]').forEach((input) => {
    input.checked = input.value === state.activeCryptoStack;
  });
  try {
    window.localStorage.setItem(CRYPTO_STACK_STORAGE_KEY, state.activeCryptoStack);
  } catch (_error) {
    // ignore storage issues
  }
}

function getScriptElementId(mode) {
  return `crypto-script-${mode}`;
}

function loadExternalScript(mode) {
  const asset = CRYPTO_SCRIPTS[mode];
  if (!asset) {
    return Promise.reject(new Error(`Неизвестный криптоплагин: ${mode}`));
  }

  const existing = document.getElementById(getScriptElementId(mode));
  if (existing?.dataset.loaded === 'true') {
    return Promise.resolve();
  }
  if (existing?.dataset.loading === 'true') {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Не удалось загрузить скрипт ${mode}.`)), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = existing || document.createElement('script');
    script.id = getScriptElementId(mode);
    script.src = asset.src;
    script.integrity = asset.integrity;
    script.crossOrigin = 'anonymous';
    script.async = true;
    script.dataset.loading = 'true';
    script.addEventListener('load', () => {
      script.dataset.loading = 'false';
      script.dataset.loaded = 'true';
      resolve();
    }, { once: true });
    script.addEventListener('error', () => {
      script.dataset.loading = 'false';
      reject(new Error(`Не удалось загрузить скрипт ${mode}.`));
    }, { once: true });
    if (!existing) {
      document.head.appendChild(script);
    }
  });
}

function syncActiveProviderState() {
  const provider = getActiveProviderState();
  state.pluginReady = Boolean(provider?.ready);
  state.certificates = provider?.certificates || [];
  syncSelectedCertificate();
  updateEnvironmentDiagnostics();
  updatePrimaryActionState();
}

function setUploadState(message, { empty = false } = {}) {
  const node = document.getElementById('uploadState');
  const card = document.getElementById('uploadCard');
  node.textContent = message;
  card?.classList.toggle('is-empty', empty);
}

function updatePrimaryActionState() {
  const button = document.getElementById('signButton');
  if (!button) return;
  const canSign = Boolean(state.uploadedPdfBase64 && state.pluginReady && state.selectedCertificate);
  button.disabled = !canSign;
  button.classList.toggle('is-disabled', !canSign);
  updateSelectedCertificateUi();
}

function setPreviewMode(mode = 'empty') {
  const sourceEmpty = document.getElementById('sourceEmpty');
  const sourcePdf = document.getElementById('sourcePdf');
  const signedState = document.getElementById('signedState');
  const signedPdf = document.getElementById('signedPdf');
  const previewTitle = document.getElementById('previewTitle');
  const previewHint = document.getElementById('previewHint');
  const successBanner = document.getElementById('successBanner');

  sourceEmpty.classList.toggle('hidden', mode !== 'empty');
  sourcePdf.classList.toggle('hidden', mode !== 'source');
  signedState.classList.toggle('hidden', mode !== 'signed-empty');
  signedPdf.classList.toggle('hidden', mode !== 'signed');
  successBanner.classList.toggle('hidden', mode !== 'signed');

  if (mode === 'signed') {
    previewTitle.textContent = 'Подписанный документ';
    previewHint.textContent = 'Финальная версия PDF после встраивания подписи и штампа';
    return;
  }

  previewTitle.textContent = 'Предпросмотр документа';
  previewHint.textContent = mode === 'source'
    ? 'Исходный загруженный PDF перед подписанием'
    : 'После загрузки PDF-файла его предпросмотр появится здесь';
}

function getSignatureCountLabel(count) {
  const absolute = Math.abs(Number(count) || 0) % 100;
  const lastDigit = absolute % 10;
  if (absolute > 10 && absolute < 20) return 'подписей';
  if (lastDigit === 1) return 'подпись';
  if (lastDigit >= 2 && lastDigit <= 4) return 'подписи';
  return 'подписей';
}

function setVerificationDetailsExpanded(expanded) {
  const toggle = document.getElementById('resultInfoToggle');
  const details = document.getElementById('verificationDetails');
  toggle.setAttribute('aria-expanded', String(expanded));
  details.classList.toggle('hidden', !expanded);
}

function renderVerificationResult(verification) {
  const trustChecks = verification?.trust?.checks;
  const trustChecksAreExplicitlyUnknown = trustChecks
    && ['chain', 'validity', 'revocation', 'keyUsage']
      .every((name) => trustChecks[name] === 'not_checked');
  const validContract = (
    verification?.schemaVersion === 1
    && verification?.integrity?.status === 'valid'
    && verification.integrity.code === 'CMS_INTEGRITY_VALID'
    && verification.integrity.signerCertificateMatched === true
    && Number.isInteger(verification.integrity.signaturesVerified)
    && verification.integrity.signaturesVerified > 0
    && verification?.trust?.status === 'not_checked'
    && verification.trust.code === 'CERTIFICATE_TRUST_NOT_CHECKED'
    && trustChecksAreExplicitlyUnknown
    && verification?.qualified?.status === 'not_checked'
    && verification.qualified.code === 'QUALIFIED_STATUS_NOT_CHECKED'
  );
  if (!validContract) {
    throw new Error('Сервер не вернул полный и однозначный результат проверки подписи.');
  }

  const signatureCount = verification.integrity.signaturesVerified;
  document.getElementById('verificationTitle').textContent = 'Подписанный файл готов';
  document.getElementById('verificationMessage').textContent = (
    'Документ доступен для просмотра и скачивания в течение 15 минут.'
  );
  document.getElementById('integrityStatusBadge').textContent = 'Подтверждена';
  document.getElementById('integrityStatusText').textContent = (
    `Криптографически проверено ${signatureCount} ${getSignatureCountLabel(signatureCount)} в PDF; `
    + 'сертификат подписанта совпадает с выбранным.'
  );
  document.getElementById('trustStatusBadge').textContent = 'Не проверено';
  document.getElementById('trustStatusText').textContent = (
    'Цепочка доверия, срок, отзыв и назначение ключа не проверялись.'
  );
  document.getElementById('qualifiedStatusBadge').textContent = 'Не подтверждён';
  document.getElementById('qualifiedStatusText').textContent = (
    'Проверка по политике квалифицированной электронной подписи не выполнялась.'
  );
  setVerificationDetailsExpanded(false);
}

function updateEnvironmentDiagnostics() {
  renderEnvironmentStatusStrip();

  const activeLabel = document.getElementById('activePluginLabel');
  if (activeLabel) {
    activeLabel.textContent = `Активен ${getCryptoStackLabel()}`;
  }

  updateSelectedCertificateUi();
}

function showSourceEmptyState(message = 'PDF ещё не загружен') {
  setPreviewMode('empty');
  document.getElementById('sourcePdf').removeAttribute('src');
  document.getElementById('docMeta').textContent = message;
  const viewerFileName = document.getElementById('viewerFileName');
  if (viewerFileName) {
    viewerFileName.textContent = 'Документ не загружен';
  }
  updatePrimaryActionState();
}

async function fetchJsonOk(url, options, fallbackMessage) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.message || fallbackMessage);
  }
  return data;
}

async function fetchStampConfig() {
  const data = await fetchJsonOk('./api/stamp-config', undefined, 'Не удалось загрузить конфиг штампа.');
  state.defaultStampConfig = ensureStampConfigShape(data.config);
  state.stampConfig = resolveEffectiveStampConfig(state.defaultStampConfig);
  state.selectedStampPosition = getStampPlacementPresetKey(state.stampConfig, { preferSelected: false });
  updateStampPlacementUi();
  return data;
}

async function fetchAvailableFonts() {
  const data = await fetchJsonOk('./api/fonts', undefined, 'Не удалось загрузить список шрифтов.');
  state.availableFonts = data.fonts || [];
  return data;
}

function showPdf(url, metaText) {
  document.getElementById('sourcePdf').src = url;
  setPreviewMode('source');
  document.getElementById('docMeta').textContent = metaText;
  const viewerFileName = document.getElementById('viewerFileName');
  if (viewerFileName) {
    viewerFileName.textContent = state.uploadedPdfName || 'Загруженный документ';
  }
  updatePrimaryActionState();
}

async function boot() {
  state.activeCryptoStack = getSavedCryptoStack();
  syncCryptoStackControls();
  bindRutokenRefreshEvents();

  await Promise.all([fetchStampConfig(), fetchAvailableFonts()]);
  migrateLegacyStampFontReferences();
  showSourceEmptyState();
  setUploadState('PDF ещё не выбран.', { empty: true });
  await initActiveCryptoStack({ force: true });
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

function isCertificateDateWindowValid(validFromDate, validToDate, now = Date.now()) {
  const validFrom = new Date(validFromDate);
  const validTo = new Date(validToDate);
  return !Number.isNaN(validFrom.getTime())
    && !Number.isNaN(validTo.getTime())
    && validFrom.getTime() <= now
    && validTo.getTime() > now;
}

function isSigningKeyUsageAllowed({
  present,
  digitalSignature,
  nonRepudiation,
}) {
  return present === false || digitalSignature === true || nonRepudiation === true;
}

function collectKeyUsageTokens(value, result = []) {
  if (typeof value === 'string' || typeof value === 'number') {
    result.push(String(value));
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeyUsageTokens(item, result));
    return result;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (item === true) {
        result.push(key);
      } else if (item !== false && item !== null && item !== undefined) {
        collectKeyUsageTokens(item, result);
      }
    });
  }
  return result;
}

async function inspectCryptoProSigningCapability(certificate) {
  const validFromDate = await getProp(certificate, 'ValidFromDate', 'ValidFromDate');
  const validToDate = await getProp(certificate, 'ValidToDate', 'ValidToDate');
  const hasPrivateKey = Boolean(
    await getProp(certificate, 'HasPrivateKey', 'HasPrivateKey'),
  );
  const keyUsage = await getProp(certificate, 'KeyUsage', 'KeyUsage');
  const usage = {
    present: Boolean(await getProp(keyUsage, 'IsPresent', 'IsPresent')),
    digitalSignature: Boolean(
      await getProp(keyUsage, 'IsDigitalSignatureEnabled', 'IsDigitalSignatureEnabled'),
    ),
    nonRepudiation: Boolean(
      await getProp(keyUsage, 'IsNonRepudiationEnabled', 'IsNonRepudiationEnabled'),
    ),
  };
  return {
    validFromDate,
    validToDate,
    hasPrivateKey,
    keyUsageAllowed: isSigningKeyUsageAllowed(usage),
  };
}

function parseDistinguishedName(value) {
  const source = String(value || '').trim();
  if (!source) return {};

  return source
    .split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/)
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((accumulator, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) return accumulator;
      const key = part.slice(0, separatorIndex).trim();
      const valuePart = part.slice(separatorIndex + 1).trim().replace(/^"|"$/g, '');
      if (key) {
        accumulator[key] = valuePart;
      }
      return accumulator;
    }, {});
}

function getCertificateCommonName(subjectName) {
  const parsed = parseDistinguishedName(subjectName);
  return parsed.CN || parsed.commonName || parsed.name || String(subjectName || '').trim();
}

function getCertificateIssuerLabel(issuerName) {
  const parsed = parseDistinguishedName(issuerName);
  return parsed.CN || parsed.O || parsed.OU || String(issuerName || '').trim();
}

function formatCertificateDate(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(parsed);
}

function closeActiveDialog() {
  state.activeDialog?.querySelectorAll?.('[data-sensitive-input]').forEach((input) => {
    input.value = '';
  });
  state.activeDialog?.remove();
  state.activeDialog = null;
}

function rejectDialog(reject, message, close = closeActiveDialog) {
  close();
  reject(new Error(message));
}

function revokeUploadedPdfObjectUrl() {
  if (state.uploadedPdfObjectUrl) {
    URL.revokeObjectURL(state.uploadedPdfObjectUrl);
    state.uploadedPdfObjectUrl = null;
  }
}

function resetUploadedPdfSelection() {
  revokeUploadedPdfObjectUrl();
  state.uploadedPdfBase64 = null;
  state.uploadedPdfName = null;
}

function resetSignedPdfPreview() {
  const signedPdf = document.getElementById('signedPdf');
  const downloadLink = document.getElementById('downloadLink');
  signedPdf.removeAttribute('src');
  setPreviewMode(state.uploadedPdfBase64 ? 'source' : 'empty');
  downloadLink.classList.add('hidden');
  downloadLink.removeAttribute('href');
  setVerificationDetailsExpanded(false);
  updatePrimaryActionState();
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
      let capability;
      try {
        capability = await inspectCryptoProSigningCapability(certificate);
      } catch (_error) {
        continue;
      }
      if (
        !isCertificateDateWindowValid(
          capability.validFromDate,
          capability.validToDate,
        )
        || !capability.hasPrivateKey
        || !capability.keyUsageAllowed
      ) {
        continue;
      }
      const publicKey = await certificate.PublicKey();
      const algorithm = await publicKey.Algorithm;
      const friendlyName = await getProp(algorithm, 'FriendlyName', 'FriendlyName');
      result.push({
        label: getCertificateCommonName(subjectName),
        commonName: getCertificateCommonName(subjectName),
        subjectName,
        issuerName,
        issuerLabel: getCertificateIssuerLabel(issuerName),
        thumbprint,
        serialNumber,
        validFromDate: capability.validFromDate,
        validToDate: capability.validToDate,
        hasPrivateKey: true,
        keyUsageAllowed: true,
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
  const provider = state.cryptoProviders.cryptopro;
  provider.checked = true;
  setProviderDiagnostic('cryptopro', 'extension', 'pending', 'Проверка…');
  setProviderDiagnostic('cryptopro', 'plugin', 'pending', 'Проверка…');
  setProviderDiagnostic('cryptopro', 'csp', 'pending', 'Проверка…');
  try {
    await loadExternalScript('cryptopro');
    if (!window.cadesplugin) {
      throw new Error('Скрипт cadesplugin_api.js не загрузился');
    }
    setProviderDiagnostic('cryptopro', 'extension', 'ready', 'доступно');

    await Promise.resolve(window.cadesplugin);
    const about = await createObject('CAdESCOM.About');
    setProviderDiagnostic('cryptopro', 'plugin', 'ready', 'доступен');

    let cspText = 'доступен';
    try {
      const cspVersion = await getProp(about, 'CSPVersion', 'CSPVersion');
      if (cspVersion) {
        cspText = String(cspVersion.toString?.() || cspVersion);
      }
    } catch (_error) {
      // Оставляем нейтральное значение, если версия не читается.
    }
    setProviderDiagnostic('cryptopro', 'csp', 'ready', cspText);

    const certificates = await enumerateCertificates();
    provider.ready = true;
    provider.certificates = certificates;
    provider.client = window.cadesplugin;
    if (state.activeCryptoStack === 'cryptopro') {
      syncActiveProviderState();
      setStatus('CryptoPro готов. Можно выбрать сертификат и подписать документ.');
    }
  } catch (error) {
    provider.ready = false;
    provider.certificates = [];
    provider.client = null;
    setProviderDiagnostic('cryptopro', 'plugin', 'error', 'недоступен');
    setProviderDiagnostic('cryptopro', 'csp', 'error', 'недоступен');
    if (state.activeCryptoStack === 'cryptopro') {
      syncActiveProviderState();
      const details = window.cadesplugin?.getLastError ? window.cadesplugin.getLastError(error) : error.message;
      if (!window.cadesplugin) {
        setProviderDiagnostic('cryptopro', 'extension', 'error', 'не найдено');
      }
      setStatus(`Не удалось инициализировать CryptoPro: ${details}`);
    }
  }
}

function isBrowserWithRutokenExtension() {
  return Boolean(window.chrome || typeof InstallTrigger !== 'undefined');
}

function normalizeRutokenDn(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeRutokenDn(item)).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    const preferred = value.commonName || value.CN || value.title || value.name;
    if (preferred) return String(preferred);
    if ('rdn' in value && 'value' in value) {
      return `${value.rdn}=${value.value}`;
    }
    return Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== null && item !== '')
      .map(([key, item]) => {
        if (Array.isArray(item)) {
          const normalized = item.map((entry) => normalizeRutokenDn(entry)).filter(Boolean).join(', ');
          return normalized || '';
        }
        if (item && typeof item === 'object' && 'rdn' in item && 'value' in item) {
          return `${item.rdn}=${item.value}`;
        }
        return `${key}=${normalizeRutokenDn(item)}`;
      })
      .filter(Boolean)
      .join(', ');
  }
  return String(value);
}

function getRutokenDnField(value, fieldNames = []) {
  const wanted = new Set(fieldNames.map((field) => String(field).toLowerCase()));
  if (!value) return '';
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = getRutokenDnField(item, fieldNames);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (wanted.has(String(key).toLowerCase()) && item !== undefined && item !== null && item !== '') {
        return String(item);
      }
    }
    if ('rdn' in value && 'value' in value && wanted.has(String(value.rdn).toLowerCase())) {
      return String(value.value);
    }
    for (const item of Object.values(value)) {
      const found = getRutokenDnField(item, fieldNames);
      if (found) return found;
    }
  }
  return '';
}

function getRutokenDnCommonName(value) {
  const commonName = getRutokenDnField(value, ['commonName', 'CN']);
  return commonName || normalizeRutokenDn(value);
}

function parseRutokenDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

function base64ToHex(base64) {
  const bytes = atob(base64);
  return Array.from(bytes, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function normalizeCmsBase64(value) {
  return String(value || '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
}

function detectRutokenHashAlgorithmConstant(certificate, plugin) {
  const name = `${certificate.algorithm || ''} ${certificate.label || ''}`.toLowerCase();
  if (name.includes('2012') && name.includes('512')) {
    return plugin.HASH_TYPE_GOST3411_12_512;
  }
  if (name.includes('2012') && name.includes('256')) {
    return plugin.HASH_TYPE_GOST3411_12_256;
  }
  if (name.includes('sha-512') || name.includes('sha512')) {
    return plugin.HASH_TYPE_SHA512;
  }
  if (name.includes('sha-384') || name.includes('sha384')) {
    return plugin.HASH_TYPE_SHA384;
  }
  if (name.includes('sha-256') || name.includes('sha256') || name.includes('rsa')) {
    return plugin.HASH_TYPE_SHA256;
  }
  return plugin.HASH_TYPE_GOST3411_94;
}

function isRutokenRsaCertificate(certificate) {
  const name = `${certificate.algorithm || ''} ${certificate.label || ''}`.toLowerCase();
  return name.includes('rsa');
}

function getRutokenErrorMessage(error, plugin = state.cryptoProviders.rutoken.client) {
  if (!error) return 'Неизвестная ошибка.';
  if (typeof error === 'string') return error;
  if (error.message && Number.isNaN(Number(error.message))) return error.message;
  if (plugin?.errorCodes && error?.message) {
    const code = Number(error.message);
    const matched = Object.entries(plugin.errorCodes).find(([, value]) => Number(value) === code);
    if (matched) {
      return `${matched[0]} (${error.message})`;
    }
  }
  return error.message || String(error);
}

function getRutokenErrorCode(error) {
  const message = typeof error === 'string' ? error : String(error?.message || error || '');
  const numericPrefix = message.match(/^\s*(-?\d+)/);
  if (numericPrefix) {
    return Number(numericPrefix[1]);
  }
  const numericOnly = Number(message);
  return Number.isFinite(numericOnly) ? numericOnly : null;
}

function isRutokenAlreadyLoggedInError(error, plugin = state.cryptoProviders.rutoken.client) {
  const message = getRutokenErrorMessage(error, plugin);
  const rawMessage = typeof error === 'string' ? error : String(error?.message || error || '');
  const code = getRutokenErrorCode(error);
  const alreadyLoggedInCode = Number(plugin?.errorCodes?.ALREADY_LOGGED_IN ?? 93);

  return message.includes('ALREADY_LOGGED_IN')
    || rawMessage.includes('ALREADY_LOGGED_IN')
    || /login has already been performed/i.test(message)
    || /login has already been performed/i.test(rawMessage)
    || (Number.isFinite(code) && Number.isFinite(alreadyLoggedInCode) && code === alreadyLoggedInCode);
}

async function enumerateRutokenCertificates(plugin) {
  const deviceIds = await plugin.enumerateDevices({ mode: plugin.ENUMERATE_DEVICES_LIST });
  const result = [];

  for (const deviceId of deviceIds || []) {
    let tokenLabel = `Устройство ${deviceId}`;
    try {
      tokenLabel = await plugin.getDeviceInfo(deviceId, plugin.TOKEN_INFO_LABEL);
    } catch (_error) {
      // ignore label lookup failure
    }

    // USER certificates are the Rutoken category linked to a private key.
    const categories = [plugin.CERT_CATEGORY_USER].filter((value) => value !== undefined);
    const seenCertIds = new Set();

    for (const category of categories) {
      const certIds = await plugin.enumerateCertificates(deviceId, category);
      for (const certId of certIds || []) {
        if (seenCertIds.has(certId)) {
          continue;
        }
        seenCertIds.add(certId);

        const pem = await plugin.getCertificate(deviceId, certId);
        const parsed = await plugin.parseCertificateFromString(pem);
        const validFromDate = parseRutokenDate(
          parsed?.notBefore || parsed?.validFrom || parsed?.validNotBefore,
        );
        const validToDate = parseRutokenDate(
          parsed?.notAfter || parsed?.validTo || parsed?.validNotAfter,
        );
        if (
          !validFromDate
          || !validToDate
          || !isCertificateDateWindowValid(
            validFromDate.toISOString(),
            validToDate.toISOString(),
          )
        ) {
          continue;
        }
        const keyUsageSource = parsed?.keyUsages ?? parsed?.keyUsage;
        const normalizedKeyUsages = collectKeyUsageTokens(keyUsageSource)
          .map((usage) => String(usage).toLowerCase().replace(/[^a-zа-я0-9]/g, ''));
        const keyUsageAllowed = keyUsageSource === undefined
          || keyUsageSource === null
          || normalizedKeyUsages.some((usage) => (
            usage.includes('digitalsignature')
            || usage.includes('nonrepudiation')
            || usage.includes('contentcommitment')
            || usage.includes('цифроваяподпись')
          ));
        if (!keyUsageAllowed) {
          continue;
        }

        const subjectNameRaw = normalizeRutokenDn(parsed?.subject) || certId;
        const issuerNameRaw = normalizeRutokenDn(parsed?.issuer);
        const commonName = getRutokenDnCommonName(parsed?.subject) || subjectNameRaw;
        const issuerCommonName = getRutokenDnCommonName(parsed?.issuer) || issuerNameRaw;
        const algorithm = parsed?.publicKeyAlgorithm || parsed?.signatureAlgorithm || 'Rutoken certificate';
        result.push({
          label: commonName,
          commonName,
          subjectName: commonName,
          issuerName: issuerCommonName,
          subjectNameRaw,
          issuerNameRaw,
          issuerLabel: issuerCommonName,
          thumbprint: parsed?.thumbprint || parsed?.fingerprint || certId,
          serialNumber: parsed?.serialNumber || certId,
          validFromDate: validFromDate.toISOString(),
          validToDate: validToDate.toISOString(),
          hasPrivateKey: true,
          keyUsageAllowed: true,
          algorithm,
          certificateBase64: normalizeCmsBase64(pem),
          certId,
          deviceId,
          tokenLabel,
        });
      }
    }
  }

  return result;
}

async function getRutokenDeviceLabels(plugin, deviceIds = []) {
  const labels = [];
  for (const deviceId of deviceIds || []) {
    try {
      const label = await plugin.getDeviceInfo(deviceId, plugin.TOKEN_INFO_LABEL);
      labels.push(label || `Устройство ${deviceId}`);
    } catch (_error) {
      labels.push(`Устройство ${deviceId}`);
    }
  }
  return labels;
}

async function refreshRutokenEnvironment({ silentStatus = false } = {}) {
  const provider = state.cryptoProviders.rutoken;
  const plugin = provider.client;
  if (!plugin) {
    provider.ready = false;
    provider.certificates = [];
    setProviderDiagnostic('rutoken', 'plugin', 'error', 'недоступен');
    setProviderDiagnostic('rutoken', 'token', 'error', 'не найден');
    if (state.activeCryptoStack === 'rutoken') {
      syncActiveProviderState();
    }
    return;
  }

  const deviceIds = await plugin.enumerateDevices({ mode: plugin.ENUMERATE_DEVICES_LIST });
  const certificates = await enumerateRutokenCertificates(plugin);
  provider.certificates = certificates;
  provider.ready = true;

  const tokenLabels = Array.from(new Set([
    ...(await getRutokenDeviceLabels(plugin, deviceIds)),
    ...certificates.map((certificate) => certificate.tokenLabel).filter(Boolean),
  ]));
  if (deviceIds?.length) {
    setProviderDiagnostic('rutoken', 'token', 'ready', tokenLabels[0] || `Подключено: ${deviceIds.length}`);
  } else {
    setProviderDiagnostic('rutoken', 'token', 'error', 'не вставлен');
  }

  if (state.activeCryptoStack === 'rutoken') {
    const selectedKey = getCertificateKey(state.selectedCertificate, 'rutoken');
    const selectedStillAvailable = selectedKey
      ? certificates.some((certificate) => getCertificateKey(certificate, 'rutoken') === selectedKey)
      : true;
    syncActiveProviderState();
    if (selectedKey && !selectedStillAvailable) {
      setStatus('Ранее выбранный сертификат на Рутокене больше недоступен. Выберите сертификат заново.');
    }
    if (!silentStatus) {
      setStatus(deviceIds?.length
        ? 'Рутокен готов. Можно выбрать сертификат и подписать документ.'
        : 'Рутокен плагин доступен, но токен не вставлен.');
    }
  }
}

async function initRutoken() {
  const provider = state.cryptoProviders.rutoken;
  provider.checked = true;
  setProviderDiagnostic('rutoken', 'extension', 'pending', 'Проверка…');
  setProviderDiagnostic('rutoken', 'plugin', 'pending', 'Проверка…');
  setProviderDiagnostic('rutoken', 'token', 'pending', 'Проверка…');
  try {
    await loadExternalScript('rutoken');
    if (!window.rutoken) {
      throw new Error('Скрипт rutoken-plugin.min.js не загрузился');
    }

    await window.rutoken.ready;
    if (isBrowserWithRutokenExtension()) {
      const extensionInstalled = await window.rutoken.isExtensionInstalled();
      if (!extensionInstalled) {
        throw new Error("Не найдено расширение 'Адаптер Рутокен Плагина'.");
      }
      setProviderDiagnostic('rutoken', 'extension', 'ready', 'доступно');
    } else {
      setProviderDiagnostic('rutoken', 'extension', 'ready', 'не требуется');
    }

    const pluginInstalled = await window.rutoken.isPluginInstalled();
    if (!pluginInstalled) {
      throw new Error('Рутокен Плагин не установлен.');
    }

    const plugin = await window.rutoken.loadPlugin();
    if (!plugin?.valid) {
      throw new Error('Не удалось загрузить Рутокен Плагин.');
    }
    provider.client = plugin;
    provider.ready = true;
    bindRutokenTokenMonitor(plugin);
    setProviderDiagnostic('rutoken', 'plugin', 'ready', 'доступен');
    await refreshRutokenEnvironment();
  } catch (error) {
    provider.ready = false;
    provider.certificates = [];
    provider.client = null;
    if (provider.tokenMonitorTimer) {
      window.clearTimeout(provider.tokenMonitorTimer);
      provider.tokenMonitorTimer = null;
    }
    provider.tokenMonitorAttached = false;
    setProviderDiagnostic('rutoken', 'plugin', 'error', 'недоступен');
    setProviderDiagnostic('rutoken', 'token', 'error', 'не найден');
    if (state.activeCryptoStack === 'rutoken') {
      syncActiveProviderState();
      if (!window.rutoken) {
        setProviderDiagnostic('rutoken', 'extension', 'error', 'не найдено');
      }
      setStatus(`Не удалось инициализировать Рутокен: ${getRutokenErrorMessage(error)}`);
    }
  }
}

async function initActiveCryptoStack({ force = false } = {}) {
  const provider = getActiveProviderState();
  if (!force && provider?.ready) {
    syncActiveProviderState();
    if (state.activeCryptoStack === 'rutoken') {
      await withOperationalCryptoBusyOverlay('Проверяю состояние Рутокена…', () => refreshRutokenEnvironment({ silentStatus: true }));
    }
    setStatus(`Активен ${getCryptoStackLabel()}. Можно выбрать сертификат и подписать документ.`);
    return;
  }

  syncActiveProviderState();
  setStatus(`Проверяю расширение и плагин ${getCryptoStackLabel()}…`);

  if (state.activeCryptoStack === 'rutoken') {
    await initRutoken();
    return;
  }

  await initCryptoPro();
}

async function switchCryptoStack(mode) {
  if (!CRYPTO_STACK_LABELS[mode] || mode === state.activeCryptoStack) {
    return;
  }
  state.activeCryptoStack = mode;
  state.selectedCertificate = null;
  syncCryptoStackControls();
  syncActiveProviderState();
  await initActiveCryptoStack({ force: true });
}

async function signPreparedContentRutoken(selectedCertificate, contentToSignBase64) {
  return withOperationalCryptoBusyOverlay('Рутокен подписывает данные…', async () => {
    const plugin = state.cryptoProviders.rutoken.client;
    if (!plugin) {
      throw new Error('Рутокен плагин не готов.');
    }

    const options = {
      detached: true,
      addSignTime: true,
      addEssCert: true,
    };
    if (isRutokenRsaCertificate(selectedCertificate)) {
      options.rsaHashAlgorithm = detectRutokenHashAlgorithmConstant(selectedCertificate, plugin);
    }

    const cmsSignature = await plugin.sign(
      selectedCertificate.deviceId,
      selectedCertificate.certId,
      contentToSignBase64,
      plugin.DATA_FORMAT_BASE64,
      options,
    );
    return normalizeCmsBase64(cmsSignature);
  });
}

function renderCertificateCard(certificate, index, isSelected) {
  return `
    <button
      type="button"
      class="certificate-card${isSelected ? ' is-selected' : ''}"
      data-index="${index}"
      role="option"
      aria-selected="${isSelected ? 'true' : 'false'}"
    >
      <dl class="certificate-meta">
        <dt>Common Name</dt>
        <dd>${escapeHtml(certificate.commonName || certificate.label || '—')}</dd>
        <dt>Issuer</dt>
        <dd>${escapeHtml(certificate.issuerLabel || certificate.issuerName || '—')}</dd>
        <dt>Срок действия</dt>
        <dd>${escapeHtml(formatCertificateDate(certificate.validToDate))}</dd>
      </dl>
    </button>
  `;
}

function openRutokenPinDialog({ title = 'Введите PIN-код токена.', errorMessage = '' } = {}) {
  return new Promise((resolve, reject) => {
    closeActiveDialog();

    const fragment = document.getElementById('rutokenPinDialogTemplate').content.cloneNode(true);
    const backdrop = fragment.querySelector('.dialog-backdrop');
    const prompt = fragment.querySelector('#rutokenPinPrompt');
    const input = fragment.querySelector('#rutokenPinInput');
    const error = fragment.querySelector('#rutokenPinError');
    const confirm = fragment.querySelector('#confirmRutokenPin');
    const cancel = fragment.querySelector('#cancelRutokenPin');

    state.activeDialog = backdrop;
    prompt.textContent = title;
    if (errorMessage) {
      error.textContent = errorMessage;
      error.classList.remove('hidden');
    }

    const close = () => closeActiveDialog();
    const submit = () => {
      let pin = String(input.value || '').replace(/\D+/g, '');
      if (!pin) {
        error.textContent = 'PIN-код пустой.';
        error.classList.remove('hidden');
        input.focus();
        return;
      }
      input.value = '';
      close();
      resolve(pin);
      pin = '';
    };

    fragment.querySelectorAll('.pin-key').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.key;
        const action = button.dataset.action;
        if (key) {
          input.value = `${input.value}${key}`;
          error.classList.add('hidden');
          return;
        }
        if (action === 'clear') {
          input.value = '';
        }
        if (action === 'backspace') {
          input.value = input.value.slice(0, -1);
        }
        input.focus();
      });
    });

    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D+/g, '');
      error.classList.add('hidden');
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });

    confirm.addEventListener('click', submit);
    cancel.addEventListener('click', () => {
      rejectDialog(reject, 'Ввод PIN-кода отменён.', close);
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        rejectDialog(reject, 'Ввод PIN-кода отменён.', close);
      }
    });

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => input.focus());
  });
}

async function getRutokenPinRetriesLeft(plugin, deviceId) {
  try {
    const pinsInfo = await plugin.getDeviceInfo(deviceId, plugin.TOKEN_INFO_PINS_INFO);
    const retriesLeft = pinsInfo?.retriesLeft;
    if (Number.isFinite(Number(retriesLeft))) {
      return Number(retriesLeft);
    }
  } catch (_error) {
    // ignore and try legacy fallback below
  }

  try {
    const retriesLeft = await plugin.getDeviceInfo(deviceId, plugin.TOKEN_INFO_PIN_RETRIES_LEFT);
    if (Number.isFinite(Number(retriesLeft))) {
      return Number(retriesLeft);
    }
  } catch (_error) {
    // ignore legacy fallback failure
  }

  return null;
}

async function ensureRutokenLogin(deviceId) {
  const plugin = state.cryptoProviders.rutoken.client;
  if (!plugin) {
    throw new Error('Рутокен плагин не готов.');
  }

  let errorMessage = '';
  while (true) {
    let pin = '';
    let loginError = null;
    try {
      pin = await openRutokenPinDialog({
        title: 'Рутокен не запрашивает PIN сам. Введите PIN-код токена, чтобы продолжить подпись.',
        errorMessage,
      });
      await withOperationalCryptoBusyOverlay('Проверяю PIN-код на Рутокене…', () => plugin.login(deviceId, pin), { mode: 'rutoken' });
      return;
    } catch (error) {
      if (error?.message === 'Ввод PIN-кода отменён.') {
        throw error;
      }
      if (isRutokenAlreadyLoggedInError(error, plugin)) {
        return;
      }
      loginError = error;
    } finally {
      pin = '';
      document.querySelectorAll('[data-sensitive-input]').forEach((input) => {
        input.value = '';
      });
    }
    const message = getRutokenErrorMessage(loginError, plugin);
    const retriesLeft = await getRutokenPinRetriesLeft(plugin, deviceId);
    const retriesSuffix = Number.isFinite(Number(retriesLeft))
      ? ` Осталось попыток: ${retriesLeft}.`
      : '';
    errorMessage = `Не удалось авторизоваться: ${message}.${retriesSuffix}`;
  }
}

async function sha256HexFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);
  bytes.fill(0);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function openSigningConfirmationDialog({
  documentName,
  documentDigest,
  certificate,
}) {
  return new Promise((resolve, reject) => {
    closeActiveDialog();
    const fragment = document
      .getElementById('signingConfirmationDialogTemplate')
      .content
      .cloneNode(true);
    const backdrop = fragment.querySelector('.dialog-backdrop');
    fragment.querySelector('#confirmationDocumentName').textContent = documentName;
    fragment.querySelector('#confirmationDocumentDigest').textContent = documentDigest;
    fragment.querySelector('#confirmationCertificateName').textContent = (
      certificate.commonName || certificate.label || '—'
    );
    fragment.querySelector('#confirmationCertificateFingerprint').textContent = (
      certificate.thumbprint || '—'
    );
    const confirm = fragment.querySelector('#confirmSigning');
    const cancel = fragment.querySelector('#cancelSigning');
    state.activeDialog = backdrop;
    confirm.addEventListener('click', () => {
      closeActiveDialog();
      resolve();
    });
    cancel.addEventListener('click', () => {
      rejectDialog(reject, 'Подписание отменено пользователем.');
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        rejectDialog(reject, 'Подписание отменено пользователем.');
      }
    });
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => confirm.focus());
  });
}

function openCertificateDialog(certificates, preselectedCertificate = null) {
  return new Promise((resolve, reject) => {
    if (!certificates.length) {
      reject(new Error('Не найдено доступных сертификатов.'));
      return;
    }

    closeActiveDialog();
    const fragment = document.getElementById('certificateDialogTemplate').content.cloneNode(true);
    const backdrop = fragment.querySelector('.dialog-backdrop');
    const list = fragment.querySelector('#certificateList');
    const confirm = fragment.querySelector('#confirmCertificate');
    const cancel = fragment.querySelector('#cancelCertificate');
    const preselectedKey = getCertificateKey(preselectedCertificate);
    let selectedIndex = Math.max(0, certificates.findIndex((certificate) => getCertificateKey(certificate) === preselectedKey));

    state.activeDialog = backdrop;

    const render = () => {
      list.innerHTML = certificates
        .map((certificate, index) => renderCertificateCard(certificate, index, index === selectedIndex))
        .join('');

      list.querySelectorAll('.certificate-card').forEach((card) => {
        card.addEventListener('click', () => {
          selectedIndex = Number(card.dataset.index);
          render();
        });
      });
    };

    render();

    confirm.addEventListener('click', () => {
      const picked = certificates[selectedIndex];
      closeActiveDialog();
      resolve(picked);
    });

    cancel.addEventListener('click', () => {
      rejectDialog(reject, 'Выбор сертификата отменён.');
    });

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        rejectDialog(reject, 'Выбор сертификата отменён.');
      }
    });

    document.body.appendChild(backdrop);
  });
}

function cloneConfig(config) {
  if (config === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(config));
}

function mergeConfig(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return cloneConfig(override ?? base);
  }
  if (!base || typeof base !== 'object') {
    return cloneConfig(override ?? base);
  }
  const result = cloneConfig(base);
  if (!override || typeof override !== 'object') {
    return result;
  }
  Object.entries(override).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = mergeConfig(result[key], value);
    } else {
      result[key] = cloneConfig(value);
    }
  });
  return result;
}

function loadSavedStampConfig() {
  try {
    const raw = window.localStorage.getItem(STAMP_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function savePersonalStampConfig(config) {
  window.localStorage.setItem(STAMP_CONFIG_STORAGE_KEY, JSON.stringify(config));
}

function clearPersonalStampConfig() {
  window.localStorage.removeItem(STAMP_CONFIG_STORAGE_KEY);
}

function hasPersonalStampConfig() {
  return Boolean(loadSavedStampConfig());
}

function resolveEffectiveStampConfig(serverConfig) {
  const saved = loadSavedStampConfig();
  if (!saved) {
    return ensureStampConfigShape(serverConfig);
  }
  return ensureStampConfigShape(mergeConfig(serverConfig, saved));
}

function migrateLegacyStampFontReferences() {
  let changed = false;
  const saved = hasPersonalStampConfig();
  const effectiveFonts = state.stampConfig?.appearance?.fonts || {};
  const defaultFonts = state.defaultStampConfig?.appearance?.fonts || {};

  for (const role of ['title', 'label', 'value']) {
    const current = effectiveFonts[role];
    if (!current) continue;
    if (state.availableFonts.some((font) => font.id === current.path)) {
      continue;
    }

    const legacyLabel = String(current.path || '')
      .split(/[\\/]/)
      .pop()
      .replace(/\.(ttf|otf|ttc)$/i, '')
      .toLowerCase();
    const matches = state.availableFonts.filter(
      (font) => font.label.toLowerCase() === legacyLabel,
    );
    current.path = matches.length === 1
      ? matches[0].id
      : defaultFonts[role]?.path;
    changed = true;
  }

  if (changed && saved) {
    savePersonalStampConfig(state.stampConfig);
  }
}

function ensureStampConfigShape(config) {
  const draft = cloneConfig(config);
  draft.appearance ||= {};
  draft.appearance.separator ||= {};
  draft.appearance.fonts ||= {};
  draft.appearance.fonts.title ||= {};
  draft.appearance.fonts.label ||= {};
  draft.appearance.fonts.value ||= {};
  draft.appearance.layout ||= {};
  draft.content ||= {};
  draft.content.title ||= [];
  draft.content.rows ||= [];
  draft.signatureObject ||= {};
  draft.placements ||= {};
  draft.placements.rules ||= [{}];
  if (!draft.placements.rules.length) {
    draft.placements.rules.push({});
  }
  draft.placements.rules[0].pages ||= {};
  draft.placements.rules[0].placement ||= {};
  draft.limits ||= {};
  return draft;
}

function normalizeColor(value, fallback = '#000000') {
  const candidate = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(candidate) ? candidate.toUpperCase() : fallback;
}

function bindRangeValue(root, inputId, outputId) {
  const input = root.querySelector(`#${inputId}`);
  const output = root.querySelector(`#${outputId}`);
  const sync = () => {
    output.value = input.value;
    output.textContent = input.value;
  };
  input.addEventListener('input', sync);
  sync();
}

function bindColorPair(root, colorId, textId) {
  const color = root.querySelector(`#${colorId}`);
  const text = root.querySelector(`#${textId}`);

  const syncFromColor = () => {
    text.value = color.value.toUpperCase();
  };

  const syncFromText = () => {
    const normalized = normalizeColor(text.value, color.value);
    color.value = normalized;
    text.value = normalized;
  };

  color.addEventListener('input', syncFromColor);
  text.addEventListener('change', syncFromText);
  text.addEventListener('blur', syncFromText);
  syncFromColor();
}

function fillFontSelect(select, currentPath) {
  const options = [];
  if (currentPath && !state.availableFonts.some((font) => font.id === currentPath)) {
    options.push({ id: currentPath, label: 'Текущий шрифт' });
  }
  options.push(...state.availableFonts);
  select.innerHTML = '';
  options.forEach((font) => {
    const option = document.createElement('option');
    option.value = font.id;
    option.textContent = font.label;
    select.appendChild(option);
  });
  if (currentPath) {
    select.value = currentPath;
  }
}

function renderTokenOptions(selectedValue) {
  const normalized = String(selectedValue || '');
  const known = TEMPLATE_TOKEN_OPTIONS.some((option) => option.value === normalized);
  const current = known ? normalized : '__custom__';
  return [
    `<option value="__custom__" ${current === '__custom__' ? 'selected' : ''}>Свое значение…</option>`,
    ...TEMPLATE_TOKEN_OPTIONS.map((option) => `<option value="${escapeHtml(option.value)}" ${current === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`),
  ].join('');
}

function getDefaultPlacementRule(config) {
  const rules = config?.placements?.rules || [];
  return rules.find((rule) => !rule.match || Object.keys(rule.match).length === 0) || rules[0] || {};
}

function getSignatureOverrideRule(config, signatureIndex) {
  const rules = config?.placements?.rules || [];
  return rules.find((rule) => Number(rule?.match?.signatureIndex) === signatureIndex) || null;
}

function renderSignatureOverrides(root, config) {
  const container = root.querySelector('#signatureOverridesEditor');
  container.innerHTML = '';
  const defaultRule = getDefaultPlacementRule(config);

  for (let signatureIndex = 1; signatureIndex <= 4; signatureIndex += 1) {
    const overrideRule = getSignatureOverrideRule(config, signatureIndex);
    const placement = overrideRule?.placement || {};
    const enabled = Boolean(overrideRule);
    const anchor = placement.anchor || defaultRule?.placement?.anchor || 'bottom-right';
    const offsetX = Number(placement.offsetX ?? defaultRule?.placement?.offsetX ?? 24);
    const offsetY = Number(placement.offsetY ?? defaultRule?.placement?.offsetY ?? 24);

    const card = document.createElement('div');
    card.className = `signature-override-card ${enabled ? '' : 'is-disabled'}`.trim();
    card.innerHTML = `
      <div class="signature-override-head">
        <div>
          <div class="signature-override-title">Подпись ${signatureIndex}</div>
          <div class="muted">Override поверх общей сетки</div>
        </div>
        <label class="field field-checkbox field-checkbox-compact">
          <input type="checkbox" data-override-enabled="${signatureIndex}" ${enabled ? 'checked' : ''} />
          <span>Своя позиция</span>
        </label>
      </div>
      <div class="signature-override-body">
        <div class="form-grid">
          <label class="field">
            <span>Якорь</span>
            <select data-override-anchor="${signatureIndex}" ${enabled ? '' : 'disabled'}>
              <option value="bottom-right" ${anchor === 'bottom-right' ? 'selected' : ''}>bottom-right</option>
              <option value="bottom-left" ${anchor === 'bottom-left' ? 'selected' : ''}>bottom-left</option>
              <option value="top-right" ${anchor === 'top-right' ? 'selected' : ''}>top-right</option>
              <option value="top-left" ${anchor === 'top-left' ? 'selected' : ''}>top-left</option>
              <option value="bottom-center" ${anchor === 'bottom-center' ? 'selected' : ''}>bottom-center</option>
              <option value="top-center" ${anchor === 'top-center' ? 'selected' : ''}>top-center</option>
              <option value="center" ${anchor === 'center' ? 'selected' : ''}>center</option>
              <option value="middle-left" ${anchor === 'middle-left' ? 'selected' : ''}>middle-left</option>
              <option value="middle-right" ${anchor === 'middle-right' ? 'selected' : ''}>middle-right</option>
            </select>
          </label>
          <label class="field">
            <span>Offset X</span>
            <input data-override-offset-x="${signatureIndex}" type="number" min="-2000" max="2000" step="1" value="${offsetX}" ${enabled ? '' : 'disabled'} />
          </label>
          <label class="field">
            <span>Offset Y</span>
            <input data-override-offset-y="${signatureIndex}" type="number" min="-2000" max="2000" step="1" value="${offsetY}" ${enabled ? '' : 'disabled'} />
          </label>
        </div>
      </div>
    `;
    container.appendChild(card);
  }
}

function renderStampRows(root, rows) {
  const container = root.querySelector('#stampRowsEditor');
  container.innerHTML = '';

  rows.forEach((row, index) => {
    const value = String(row.value || '');
    const card = document.createElement('div');
    card.className = 'row-card';
    card.innerHTML = `
      <div class="row-card-head">
        <span class="row-card-index">Строка ${index + 1}</span>
        <button class="secondary row-remove" type="button" data-index="${index}">Удалить</button>
      </div>
      <div class="row-card-grid">
        <label class="field">
          <span>Label</span>
          <input type="text" data-field="label" value="${escapeHtml(row.label || '')}" />
        </label>
        <label class="field">
          <span>Value</span>
          <div class="row-value-grid">
            <select data-field="valueTemplate">${renderTokenOptions(value)}</select>
            <input type="text" data-field="value" value="${escapeHtml(value)}" />
          </div>
        </label>
        <label class="field">
          <span>Max lines</span>
          <input type="number" min="1" max="20" step="1" data-field="maxLines" value="${Number(row.maxLines || 2)}" />
        </label>
        <label class="field field-checkbox">
          <input type="checkbox" data-field="breakAnywhere" ${row.breakAnywhere ? 'checked' : ''} />
          <span>Разрывать в любом месте</span>
        </label>
      </div>
    `;
    container.appendChild(card);
  });
}

function fontPreviewFamily(fontPath, fallback = 'sans-serif') {
  const selectedFont = state.availableFonts.find((font) => font.id === fontPath);
  const value = String(selectedFont?.label || fontPath || '').toLowerCase();
  if (value.includes('pt sans caption')) return '"PT Sans Caption Stamp", "PT Sans Caption", Arial, sans-serif';
  if (value.includes('ibm plex sans')) return '"IBM Plex Sans Stamp", "IBM Plex Sans", Arial, sans-serif';
  if (value.includes('roboto condensed')) return '"Roboto Condensed Stamp", "Roboto Condensed", Arial, sans-serif';
  if (value.includes('noto sans semicondensed')) return '"Noto Sans SemiCondensed Stamp", "Noto Sans", Arial, sans-serif';
  if (value.includes('golos text')) return '"Golos Text Stamp", "Golos Text", Arial, sans-serif';
  if (value.includes('serif')) return 'Georgia, "Times New Roman", serif';
  if (value.includes('mono')) return '"SFMono-Regular", Consolas, monospace';
  if (value.includes('sans')) return 'Inter, Arial, sans-serif';
  return fallback;
}

function replacePreviewTokens(value) {
  return String(value || '')
    .replaceAll('{signer.cert_id}', '78AB-CDEF-9012-3456')
    .replaceAll('{signer.name}', 'Иванов Иван Иванович')
    .replaceAll('{signer.issuer}', 'ООО УЦ «Демо Сертификат»')
    .replaceAll('{signer.valid_to}', '31.12.2027')
    .replaceAll('{signer.value}', 'Демо-значение');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function updateStampPreview(root, config) {
  const draft = ensureStampConfigShape(config);
  const previewPage = root.querySelector('#stampPreviewPage');
  const previewCard = root.querySelector('#stampPreviewCard');
  if (!previewPage || !previewCard) {
    return;
  }

  const rule = getDefaultPlacementRule(draft) || { pages: {}, placement: {} };
  const appearance = draft.appearance || {};
  const layout = appearance.layout || {};
  const separator = appearance.separator || {};
  const fonts = appearance.fonts || {};
  const width = Number(appearance.width || 128);
  const height = Number(appearance.height || 108);
  const pageRect = previewPage.getBoundingClientRect();
  const pageWidth = pageRect.width || 420;
  const pageHeight = pageRect.height || 594;
  const scale = Math.min((pageWidth * 0.72) / width, (pageHeight * 0.42) / height, 2.2);
  const stampWidth = Math.max(120, Math.round(width * scale));
  const stampHeight = Math.max(72, Math.round(height * scale));

  previewCard.style.width = `${stampWidth}px`;
  previewCard.style.minHeight = `${stampHeight}px`;
  previewCard.style.background = normalizeColor(appearance.backgroundColor, '#F5F8FF');
  previewCard.style.color = normalizeColor(appearance.textColor, '#1A2842');
  previewCard.style.border = `${Math.max(0, Math.round(Number(appearance.borderWidth || 0) * scale * 0.7))}px solid ${normalizeColor(appearance.borderColor, '#3F68B8')}`;
  previewCard.style.borderRadius = `${Math.round(Number(appearance.borderRadius || 0) * scale * 0.7)}px`;

  const leftPadding = Math.max(10, Math.round(Number(layout.contentLeft || 12) * scale * 0.62));
  const rightPadding = Math.max(10, Math.round(Number(layout.contentRight || 12) * scale * 0.62));
  const topPadding = Math.max(10, Math.round(Number(layout.startY || 10) * scale * 0.62));
  const titleSize = clamp(Math.round(Number(fonts.title?.size || 30) * scale * 0.52), 10, 34);
  const labelSize = clamp(Math.round(Number(fonts.label?.size || 27) * scale * 0.48), 9, 24);
  const valueSize = clamp(Math.round(Number(fonts.value?.size || 27) * scale * 0.48), 9, 24);
  const titleGap = Math.max(8, Math.round(Number(layout.afterTitleGap || 16) * scale * 0.4));
  const rowLabelGap = Math.max(5, Math.round(Number(layout.rowLabelGap || 12) * scale * 0.34));
  const rowExtraGap = Math.max(5, Math.round(Number(layout.rowExtraGap || 8) * scale * 0.34));
  const separatorHeight = Math.max(1, Math.round(Number(separator.width || 1) * scale * 0.6));
  const separatorMarginLeft = Math.max(0, Math.round(Number(separator.left || 0) * scale * 0.6));
  const separatorMarginRight = Math.max(0, Math.round(Number(separator.right || 0) * scale * 0.6));

  const titleHtml = (draft.content.title || [])
    .map((line) => escapeHtml(replacePreviewTokens(line)))
    .join('<br>');

  const rowsHtml = (draft.content.rows || []).map((row) => {
    const label = escapeHtml(replacePreviewTokens(row.label));
    const value = escapeHtml(replacePreviewTokens(row.value));
    return `
      <div class="preview-stamp-row" style="margin-top:${rowLabelGap}px; margin-bottom:${rowExtraGap}px;">
        <div class="preview-stamp-label" style="font-size:${labelSize}px; font-family:${fontPreviewFamily(fonts.label?.path, 'Georgia, serif')};">${label}</div>
        <div class="preview-stamp-value" style="font-size:${valueSize}px; font-family:${fontPreviewFamily(fonts.value?.path, 'Inter, Arial, sans-serif')};">${value}</div>
      </div>
    `;
  }).join('');

  previewCard.innerHTML = `
    <div class="preview-stamp-inner" style="padding:${topPadding}px ${rightPadding}px ${topPadding}px ${leftPadding}px;">
      <div class="preview-stamp-title" style="font-size:${titleSize}px; font-family:${fontPreviewFamily(fonts.title?.path, 'Georgia, serif')};">${titleHtml || 'Документ подписан<br>электронной подписью'}</div>
      ${separator.enabled ? `<div class="preview-stamp-separator" style="height:${separatorHeight}px; background:${normalizeColor(separator.color, '#6E87BC')}; margin:${titleGap}px ${separatorMarginRight}px 0 ${separatorMarginLeft}px; width:calc(100% - ${separatorMarginLeft + separatorMarginRight}px);"></div>` : ''}
      <div class="preview-stamp-rows" style="margin-top:${separator.enabled ? Math.max(8, Math.round(titleGap * 0.72)) : titleGap}px;">${rowsHtml}</div>
    </div>
  `;

  const anchor = String(rule.placement.anchor || 'bottom-right');
  const offsetX = Number(rule.placement.offsetX || 0);
  const offsetY = Number(rule.placement.offsetY || 0);
  const x = Math.round(Math.abs(offsetX) * 0.35);
  const y = Math.round(Math.abs(offsetY) * 0.35);
  previewCard.style.left = 'auto';
  previewCard.style.right = 'auto';
  previewCard.style.top = 'auto';
  previewCard.style.bottom = 'auto';

  if (anchor.includes('right')) previewCard.style.right = `${clamp(x, 10, 80)}px`;
  if (anchor.includes('left')) previewCard.style.left = `${clamp(x, 10, 80)}px`;
  if (anchor.includes('top')) previewCard.style.top = `${clamp(y, 10, 80)}px`;
  if (anchor.includes('bottom')) previewCard.style.bottom = `${clamp(y, 10, 80)}px`;

  root.querySelector('#previewRuleName').textContent = rule.name || 'default-rule';
  root.querySelector('#previewPageMode').textContent = rule.pages.mode === 'single'
    ? `single · стр. ${rule.pages.page || 1}`
    : (rule.pages.mode || 'single');
  root.querySelector('#previewAnchor').textContent = `${anchor} · x:${offsetX} · y:${offsetY}`;
  root.querySelector('#previewGrid').textContent = `${rule.placement.mode || 'grid'} · колонок ${rule.placement.columns || 1} · шаг ${rule.placement.stepX || 0}/${rule.placement.stepY || 0}`;
}

function populateVisualForm(root, config) {
  const draft = ensureStampConfigShape(config);
  const rule = getDefaultPlacementRule(draft);

  root.querySelector('#appearanceWidth').value = Number(draft.appearance.width || 128);
  root.querySelector('#appearanceHeight').value = Number(draft.appearance.height || 108);
  root.querySelector('#appearanceImageScale').value = Number(draft.appearance.imageScale || 4);
  root.querySelector('#appearanceBorderWidth').value = Number(draft.appearance.borderWidth || 0);
  root.querySelector('#appearanceBorderRadius').value = Number(draft.appearance.borderRadius || 0);

  const backgroundColor = normalizeColor(draft.appearance.backgroundColor, '#F5F8FF');
  const borderColor = normalizeColor(draft.appearance.borderColor, '#3F68B8');
  const textColor = normalizeColor(draft.appearance.textColor, '#1A2842');
  const separatorColor = normalizeColor(draft.appearance.separator.color, '#6E87BC');

  root.querySelector('#appearanceBackgroundColor').value = backgroundColor;
  root.querySelector('#appearanceBackgroundColorText').value = backgroundColor;
  root.querySelector('#appearanceBorderColor').value = borderColor;
  root.querySelector('#appearanceBorderColorText').value = borderColor;
  root.querySelector('#appearanceTextColor').value = textColor;
  root.querySelector('#appearanceTextColorText').value = textColor;

  root.querySelector('#separatorEnabled').checked = Boolean(draft.appearance.separator.enabled);
  root.querySelector('#separatorY').value = Number(draft.appearance.separator.y || 0);
  root.querySelector('#separatorLeft').value = Number(draft.appearance.separator.left || 0);
  root.querySelector('#separatorRight').value = Number(draft.appearance.separator.right || 0);
  root.querySelector('#separatorWidth').value = Number(draft.appearance.separator.width || 1);
  root.querySelector('#separatorColor').value = separatorColor;
  root.querySelector('#separatorColorText').value = separatorColor;

  fillFontSelect(root.querySelector('#fontTitlePath'), draft.appearance.fonts.title.path || '');
  fillFontSelect(root.querySelector('#fontLabelPath'), draft.appearance.fonts.label.path || '');
  fillFontSelect(root.querySelector('#fontValuePath'), draft.appearance.fonts.value.path || '');
  root.querySelector('#fontTitleSize').value = Number(draft.appearance.fonts.title.size || 30);
  root.querySelector('#fontLabelSize').value = Number(draft.appearance.fonts.label.size || 27);
  root.querySelector('#fontValueSize').value = Number(draft.appearance.fonts.value.size || 27);

  root.querySelector('#contentTitle').value = (draft.content.title || []).join('\n');
  renderStampRows(root, draft.content.rows || []);
  renderSignatureOverrides(root, draft);

  root.querySelector('#signatureName').value = draft.signatureObject.name || '';
  root.querySelector('#signatureReason').value = draft.signatureObject.reason || '';
  root.querySelector('#signatureContactInfo').value = draft.signatureObject.contactInfo || '';
  root.querySelector('#signatureLocation').value = draft.signatureObject.location || '';
  root.querySelector('#signatureBytesReserved').value = Number(draft.signatureObject.bytesReserved || 16000);
  root.querySelector('#signatureSubfilter').value = draft.signatureObject.subfilter || 'PADES';
  root.querySelector('#signatureMetadataEnabled').checked = false;
  root.querySelector('#signatureMetadataFieldset').disabled = true;

  root.querySelector('#placementRuleName').value = rule.name || '';
  root.querySelector('#placementPagesMode').value = rule.pages.mode || 'single';
  root.querySelector('#placementPage').value = Number(rule.pages.page || 1);
  root.querySelector('#placementWidgetPageMode').value = rule.pages.widgetPageMode || 'first';
  root.querySelector('#placementMode').value = rule.placement.mode || 'grid';
  root.querySelector('#placementAnchor').value = rule.placement.anchor || 'bottom-right';
  root.querySelector('#placementOffsetX').value = Number(rule.placement.offsetX || 0);
  root.querySelector('#placementOffsetY').value = Number(rule.placement.offsetY || 0);
  root.querySelector('#placementColumns').value = Number(rule.placement.columns || 1);
  root.querySelector('#placementStepX').value = Number(rule.placement.stepX || 0);
  root.querySelector('#placementStepY').value = Number(rule.placement.stepY || 0);
  root.querySelector('#limitsMaxSignatures').value = Number(draft.limits.maxSignatures || 1);

  root.querySelector('#layoutContentLeft').value = Number(draft.appearance.layout.contentLeft || 0);
  root.querySelector('#layoutContentRight').value = Number(draft.appearance.layout.contentRight || 0);
  root.querySelector('#layoutStartY').value = Number(draft.appearance.layout.startY || 0);
  root.querySelector('#layoutTitleLineHeight').value = Number(draft.appearance.layout.titleLineHeight || 0);
  root.querySelector('#layoutAfterTitleGap').value = Number(draft.appearance.layout.afterTitleGap || 0);
  root.querySelector('#layoutRowLabelGap').value = Number(draft.appearance.layout.rowLabelGap || 0);
  root.querySelector('#layoutRowExtraGap').value = Number(draft.appearance.layout.rowExtraGap || 0);
  root.querySelector('#layoutValueLineHeight').value = Number(draft.appearance.layout.valueLineHeight || 0);
  root.querySelector('#layoutDefaultMaxLines').value = Number(draft.appearance.layout.defaultMaxLines || 2);

  [
    ['appearanceImageScale', 'appearanceImageScaleValue'],
    ['appearanceBorderWidth', 'appearanceBorderWidthValue'],
    ['appearanceBorderRadius', 'appearanceBorderRadiusValue'],
    ['separatorWidth', 'separatorWidthValue'],
    ['fontTitleSize', 'fontTitleSizeValue'],
    ['fontLabelSize', 'fontLabelSizeValue'],
    ['fontValueSize', 'fontValueSizeValue'],
  ].forEach(([inputId, outputId]) => bindRangeValue(root, inputId, outputId));

  [
    ['appearanceBackgroundColor', 'appearanceBackgroundColorText'],
    ['appearanceBorderColor', 'appearanceBorderColorText'],
    ['appearanceTextColor', 'appearanceTextColorText'],
    ['separatorColor', 'separatorColorText'],
  ].forEach(([colorId, textId]) => bindColorPair(root, colorId, textId));

  updateStampPreview(root, draft);
}

function collectStampRows(root) {
  return Array.from(root.querySelectorAll('.row-card')).map((card) => ({
    label: card.querySelector('[data-field="label"]').value.trim(),
    value: card.querySelector('[data-field="value"]').value.trim(),
    maxLines: Number(card.querySelector('[data-field="maxLines"]').value || 2),
    breakAnywhere: card.querySelector('[data-field="breakAnywhere"]').checked,
  }));
}

function collectSignatureOverrides(root, baseRule) {
  const overrides = [];
  for (let signatureIndex = 1; signatureIndex <= 4; signatureIndex += 1) {
    const enabled = root.querySelector(`[data-override-enabled="${signatureIndex}"]`)?.checked;
    if (!enabled) continue;
    overrides.push({
      name: `signature-${signatureIndex}-override`,
      match: { signatureIndex },
      pages: cloneConfig(baseRule.pages || {}),
      placement: {
        mode: 'anchored',
        anchor: root.querySelector(`[data-override-anchor="${signatureIndex}"]`).value,
        offsetX: Number(root.querySelector(`[data-override-offset-x="${signatureIndex}"]`).value || 0),
        offsetY: Number(root.querySelector(`[data-override-offset-y="${signatureIndex}"]`).value || 0),
      },
    });
  }
  return overrides;
}

function readVisualForm(root) {
  const draft = ensureStampConfigShape(state.stampConfig);
  draft.appearance.width = Number(root.querySelector('#appearanceWidth').value);
  draft.appearance.height = Number(root.querySelector('#appearanceHeight').value);
  draft.appearance.imageScale = Number(root.querySelector('#appearanceImageScale').value);
  draft.appearance.backgroundColor = normalizeColor(root.querySelector('#appearanceBackgroundColorText').value, '#F5F8FF');
  draft.appearance.borderColor = normalizeColor(root.querySelector('#appearanceBorderColorText').value, '#3F68B8');
  draft.appearance.borderWidth = Number(root.querySelector('#appearanceBorderWidth').value);
  draft.appearance.borderRadius = Number(root.querySelector('#appearanceBorderRadius').value);
  draft.appearance.textColor = normalizeColor(root.querySelector('#appearanceTextColorText').value, '#1A2842');

  draft.appearance.separator.enabled = root.querySelector('#separatorEnabled').checked;
  draft.appearance.separator.y = Number(root.querySelector('#separatorY').value);
  draft.appearance.separator.left = Number(root.querySelector('#separatorLeft').value);
  draft.appearance.separator.right = Number(root.querySelector('#separatorRight').value);
  draft.appearance.separator.color = normalizeColor(root.querySelector('#separatorColorText').value, '#6E87BC');
  draft.appearance.separator.width = Number(root.querySelector('#separatorWidth').value);

  draft.appearance.fonts.title.path = root.querySelector('#fontTitlePath').value;
  draft.appearance.fonts.title.size = Number(root.querySelector('#fontTitleSize').value);
  draft.appearance.fonts.label.path = root.querySelector('#fontLabelPath').value;
  draft.appearance.fonts.label.size = Number(root.querySelector('#fontLabelSize').value);
  draft.appearance.fonts.value.path = root.querySelector('#fontValuePath').value;
  draft.appearance.fonts.value.size = Number(root.querySelector('#fontValueSize').value);

  draft.appearance.layout.contentLeft = Number(root.querySelector('#layoutContentLeft').value);
  draft.appearance.layout.contentRight = Number(root.querySelector('#layoutContentRight').value);
  draft.appearance.layout.startY = Number(root.querySelector('#layoutStartY').value);
  draft.appearance.layout.titleLineHeight = Number(root.querySelector('#layoutTitleLineHeight').value);
  draft.appearance.layout.afterTitleGap = Number(root.querySelector('#layoutAfterTitleGap').value);
  draft.appearance.layout.rowLabelGap = Number(root.querySelector('#layoutRowLabelGap').value);
  draft.appearance.layout.rowExtraGap = Number(root.querySelector('#layoutRowExtraGap').value);
  draft.appearance.layout.valueLineHeight = Number(root.querySelector('#layoutValueLineHeight').value);
  draft.appearance.layout.defaultMaxLines = Number(root.querySelector('#layoutDefaultMaxLines').value);

  draft.content.title = root.querySelector('#contentTitle').value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  draft.content.rows = collectStampRows(root);

  draft.signatureObject.name = root.querySelector('#signatureName').value.trim();
  draft.signatureObject.reason = root.querySelector('#signatureReason').value.trim();
  draft.signatureObject.contactInfo = root.querySelector('#signatureContactInfo').value.trim();
  draft.signatureObject.location = root.querySelector('#signatureLocation').value.trim();
  draft.signatureObject.bytesReserved = Number(root.querySelector('#signatureBytesReserved').value);
  draft.signatureObject.subfilter = root.querySelector('#signatureSubfilter').value;

  const rule = cloneConfig(getDefaultPlacementRule(draft));
  rule.name = root.querySelector('#placementRuleName').value.trim();
  rule.pages.mode = root.querySelector('#placementPagesMode').value;
  rule.pages.page = Number(root.querySelector('#placementPage').value);
  rule.pages.widgetPageMode = root.querySelector('#placementWidgetPageMode').value;
  rule.placement.mode = root.querySelector('#placementMode').value;
  rule.placement.anchor = root.querySelector('#placementAnchor').value;
  rule.placement.offsetX = Number(root.querySelector('#placementOffsetX').value);
  rule.placement.offsetY = Number(root.querySelector('#placementOffsetY').value);
  rule.placement.columns = Number(root.querySelector('#placementColumns').value);
  rule.placement.stepX = Number(root.querySelector('#placementStepX').value);
  rule.placement.stepY = Number(root.querySelector('#placementStepY').value);
  draft.limits.maxSignatures = Number(root.querySelector('#limitsMaxSignatures').value);

  const preservedRules = (draft.placements.rules || []).filter((candidate) => {
    if (!candidate || candidate === rule) return false;
    if (!candidate.match || Object.keys(candidate.match).length === 0) return false;
    const signatureIndex = Number(candidate?.match?.signatureIndex);
    return !(signatureIndex >= 1 && signatureIndex <= 4);
  });
  draft.placements.rules = [
    ...collectSignatureOverrides(root, rule),
    rule,
    ...preservedRules,
  ];

  return draft;
}

function switchStampTab(root, nextTab) {
  const visualTab = root.querySelector('#stampTabVisual');
  const jsonTab = root.querySelector('#stampTabJson');
  const visualPanel = root.querySelector('#stampVisualPanel');
  const jsonPanel = root.querySelector('#stampJsonPanel');
  const editor = root.querySelector('#stampConfigEditor');

  if (nextTab === 'json') {
    state.stampConfig = readVisualForm(root);
    updateStampPlacementUi();
    editor.value = `${JSON.stringify(state.stampConfig, null, 2)}\n`;
    visualTab.classList.remove('is-active');
    jsonTab.classList.add('is-active');
    visualTab.setAttribute('aria-selected', 'false');
    jsonTab.setAttribute('aria-selected', 'true');
    visualPanel.classList.add('hidden');
    jsonPanel.classList.remove('hidden');
    return;
  }

  const parsed = JSON.parse(editor.value || '{}');
  state.stampConfig = ensureStampConfigShape(parsed);
  updateStampPlacementUi();
  populateVisualForm(root, state.stampConfig);
  jsonTab.classList.remove('is-active');
  visualTab.classList.add('is-active');
  jsonTab.setAttribute('aria-selected', 'false');
  visualTab.setAttribute('aria-selected', 'true');
  jsonPanel.classList.add('hidden');
  visualPanel.classList.remove('hidden');
}

function wireStampSettingsForm(root) {
  const refreshPreview = () => {
    try {
      updateStampPreview(root, readVisualForm(root));
    } catch {
      // Игнорируем промежуточные невалидные состояния ввода в превью.
    }
  };

  root.querySelector('#addStampRow').addEventListener('click', () => {
    const nextConfig = readVisualForm(root);
    nextConfig.content.rows.push({
      label: 'Новое поле',
      value: '{signer.value}',
      maxLines: 2,
      breakAnywhere: false,
    });
    state.stampConfig = nextConfig;
    updateStampPlacementUi();
    populateVisualForm(root, state.stampConfig);
  });

  root.querySelector('#stampRowsEditor').addEventListener('click', (event) => {
    const button = event.target.closest('.row-remove');
    if (!button) return;
    const index = Number(button.dataset.index);
    const nextConfig = readVisualForm(root);
    nextConfig.content.rows.splice(index, 1);
    state.stampConfig = nextConfig;
    updateStampPlacementUi();
    populateVisualForm(root, state.stampConfig);
  });

  root.querySelector('#stampRowsEditor').addEventListener('change', (event) => {
    const select = event.target.closest('[data-field="valueTemplate"]');
    if (!select) return;
    const card = select.closest('.row-card');
    const input = card?.querySelector('[data-field="value"]');
    if (!input) return;
    if (select.value !== '__custom__') {
      input.value = select.value;
    }
    refreshPreview();
  });

  root.querySelector('#stampRowsEditor').addEventListener('input', (event) => {
    const input = event.target.closest('[data-field="value"]');
    if (!input) return;
    const select = input.closest('.row-value-grid')?.querySelector('[data-field="valueTemplate"]');
    if (!select) return;
    const matched = TEMPLATE_TOKEN_OPTIONS.find((option) => option.value === input.value.trim());
    select.value = matched ? matched.value : '__custom__';
  });

  root.querySelector('#signatureOverridesEditor').addEventListener('change', (event) => {
    const toggle = event.target.closest('[data-override-enabled]');
    if (!toggle) return;
    const signatureIndex = toggle.getAttribute('data-override-enabled');
    const card = toggle.closest('.signature-override-card');
    const controls = card?.querySelectorAll(`[data-override-anchor="${signatureIndex}"], [data-override-offset-x="${signatureIndex}"], [data-override-offset-y="${signatureIndex}"]`);
    card?.classList.toggle('is-disabled', !toggle.checked);
    controls?.forEach((control) => {
      control.disabled = !toggle.checked;
    });
    refreshPreview();
  });

  root.querySelector('#signatureMetadataEnabled').addEventListener('change', (event) => {
    root.querySelector('#signatureMetadataFieldset').disabled = !event.target.checked;
  });

  root.querySelector('#stampVisualPanel').addEventListener('input', refreshPreview);
  root.querySelector('#stampVisualPanel').addEventListener('change', refreshPreview);

  root.querySelector('#stampTabVisual').addEventListener('click', () => {
    try {
      switchStampTab(root, 'visual');
    } catch (error) {
      setStatus(`Ошибка JSON: ${error.message}`);
    }
  });

  root.querySelector('#stampTabJson').addEventListener('click', () => {
    state.stampConfig = readVisualForm(root);
    updateStampPlacementUi();
    switchStampTab(root, 'json');
  });
}

function openStampSettingsDialog() {
  return new Promise((resolve, reject) => {
    const fragment = document.getElementById('stampSettingsDialogTemplate').content.cloneNode(true);
    const backdrop = fragment.querySelector('.dialog-backdrop');
    const configStatus = fragment.querySelector('#stampConfigPath');
    const reset = fragment.querySelector('#resetStampSettings');
    const save = fragment.querySelector('#saveStampSettings');
    const cancel = fragment.querySelector('#cancelStampSettings');
    const root = backdrop;

    state.stampConfig = ensureStampConfigShape(state.stampConfig);
    configStatus.textContent = hasPersonalStampConfig()
      ? 'Есть персональные настройки в браузере'
      : 'Используются серверные настройки по умолчанию';
    populateVisualForm(root, state.stampConfig);
    root.querySelector('#stampConfigEditor').value = `${JSON.stringify(state.stampConfig, null, 2)}\n`;
    wireStampSettingsForm(root);

    const close = () => backdrop.remove();

    cancel.addEventListener('click', () => {
      close();
      reject(new Error('Настройка штампа отменена.'));
    });

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        close();
        reject(new Error('Настройка штампа отменена.'));
      }
    });

    reset.addEventListener('click', () => {
      clearPersonalStampConfig();
      state.stampConfig = ensureStampConfigShape(state.defaultStampConfig);
      state.selectedStampPosition = getStampPlacementPresetKey(state.stampConfig, { preferSelected: false });
      configStatus.textContent = 'Используются серверные настройки по умолчанию';
      populateVisualForm(root, state.stampConfig);
      root.querySelector('#stampConfigEditor').value = `${JSON.stringify(state.stampConfig, null, 2)}\n`;
      updateStampPlacementUi();
      setStatus('Персональные настройки штампа сброшены. Сейчас используются серверные значения по умолчанию.');
    });

    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const isJsonVisible = !root.querySelector('#stampJsonPanel').classList.contains('hidden');
        const parsed = isJsonVisible
          ? ensureStampConfigShape(JSON.parse(root.querySelector('#stampConfigEditor').value))
          : readVisualForm(root);
        savePersonalStampConfig(parsed);
        state.stampConfig = parsed;
        state.selectedStampPosition = getStampPlacementPresetKey(state.stampConfig, { preferSelected: false });
        updateStampPlacementUi();
        close();
        resolve();
      } catch (error) {
        save.disabled = false;
        setStatus(`Ошибка настройки штампа: ${error.message}`);
      }
    });

    document.body.appendChild(backdrop);
    root.querySelector('#appearanceWidth').focus();
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
  return withOperationalCryptoBusyOverlay('CryptoPro подписывает данные…', async () => {
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
    const cmsSignature = await oSignedData.SignHash(
      oHashedData,
      oSigner,
      window.cadesplugin.CADESCOM_CADES_BES,
    );
    return normalizeCmsBase64(cmsSignature);
  });
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

async function exportSelectedCertificateBase64(certificate) {
  if (certificate.certificateBase64) {
    return normalizeCmsBase64(certificate.certificateBase64);
  }
  if (!certificate.certificate) {
    throw new Error('Выбранный сертификат нельзя экспортировать для серверной проверки.');
  }
  const exported = await certificate.certificate.Export(
    window.cadesplugin.CADESCOM_ENCODE_BASE64,
  );
  const normalized = normalizeCmsBase64(exported);
  if (!normalized) {
    throw new Error('Не удалось экспортировать выбранный сертификат.');
  }
  return normalized;
}

async function prepareAndSign() {
  if (state.activeCryptoStack === 'rutoken') {
    await withOperationalCryptoBusyOverlay('Проверяю состояние Рутокена…', () => requestRutokenEnvironmentRefresh({ silentStatus: true }));
  }
  if (!state.pluginReady) {
    throw new Error(`${getCryptoStackLabel()} plugin не готов.`);
  }
  if (!state.uploadedPdfBase64) {
    throw new Error('Сначала загрузите PDF-документ для подписи.');
  }
  if (!state.selectedCertificate) {
    throw new Error('Сначала выберите сертификат для подписи.');
  }

  const selectedCertificate = state.selectedCertificate;
  const documentDigest = await sha256HexFromBase64(state.uploadedPdfBase64);
  await openSigningConfirmationDialog({
    documentName: state.uploadedPdfName || 'Документ.pdf',
    documentDigest,
    certificate: selectedCertificate,
  });
  const certificateBase64 = await exportSelectedCertificateBase64(selectedCertificate);

  setStatus('Подготавливаю PDF под PAdES…');
  const prepareData = await fetchJsonOk('./api/sign/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pdfBase64: state.uploadedPdfBase64,
      stampConfig: state.stampConfig,
      requestedStampPosition: state.selectedStampPosition,
      signer: {
        certificateBase64,
      },
    }),
  }, 'Не удалось подготовить PDF.');

  setStatus(`Прошу ${getCryptoStackLabel()} подписать хеш сертификатом: ${selectedCertificate.label}`);
  let cmsSignatureBase64;
  try {
    if (state.activeCryptoStack === 'rutoken') {
      await ensureRutokenLogin(selectedCertificate.deviceId);
    }
    cmsSignatureBase64 = state.activeCryptoStack === 'rutoken'
      ? await signPreparedContentRutoken(selectedCertificate, prepareData.contentToSignBase64)
      : await signPreparedContent(selectedCertificate, prepareData.contentToSignBase64);
  } finally {
    if (state.activeCryptoStack === 'rutoken') {
      try {
        await state.cryptoProviders.rutoken.client?.logout(selectedCertificate.deviceId);
      } catch (_error) {
        // ignore logout failure
      }
    }
  }

  setStatus('Встраиваю CMS-подпись обратно в PDF…');
  const completeData = await fetchJsonOk('./api/sign/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: prepareData.sessionId,
      cmsSignatureBase64,
    }),
  }, 'Не удалось встроить подпись в PDF.');

  renderVerificationResult(completeData.verification);
  const resultExpiresAt = new Date(completeData.resultExpiresAt);
  if (
    !/^\.\/api\/results\/[A-Za-z0-9_-]{43}$/.test(completeData.signedPdfUrl)
    || !/^\.\/api\/results\/[A-Za-z0-9_-]{43}$/.test(completeData.downloadUrl)
    || Number.isNaN(resultExpiresAt.getTime())
    || resultExpiresAt.getTime() <= Date.now()
  ) {
    throw new Error('Сервер вернул некорректную ссылку на результат.');
  }
  const signedPdf = document.getElementById('signedPdf');
  const downloadLink = document.getElementById('downloadLink');
  signedPdf.src = completeData.signedPdfUrl;
  setPreviewMode('signed');
  const viewerFileName = document.getElementById('viewerFileName');
  if (viewerFileName) {
    viewerFileName.textContent = 'Подписанный документ';
  }
  downloadLink.href = completeData.downloadUrl;
  downloadLink.download = completeData.downloadName || 'signed-formular.pdf';
  downloadLink.classList.remove('hidden');
  setStatus(
    'Готово. Подписанный PDF можно просматривать и скачивать несколько раз '
    + `до ${resultExpiresAt.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    })} (15 минут).`,
  );
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
    revokeUploadedPdfObjectUrl();
    state.uploadedPdfBase64 = await fileToBase64(file);
    state.uploadedPdfName = file.name;
    state.uploadedPdfObjectUrl = URL.createObjectURL(file);
    resetSignedPdfPreview();
    showPdf(state.uploadedPdfObjectUrl, `${file.name} · ${Math.round(file.size / 1024)} KB`);
    setUploadState(`${file.name} · PDF документ · ${Math.round(file.size / 1024)} КБ`);
    setStatus('PDF загружен. Теперь можно выбрать сертификат и подписать документ.');
  } catch (error) {
    setStatus(`Ошибка загрузки PDF: ${error.message}`);
  }
});

document.querySelectorAll('[data-upload-proxy]').forEach((input) => {
  input.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const realInput = document.getElementById('pdfUpload');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    realInput.files = transfer.files;
    realInput.dispatchEvent(new Event('change', { bubbles: true }));
    event.target.value = '';
  });
});

document.querySelectorAll('input[name="cryptoStack"]').forEach((input) => {
  input.addEventListener('change', async (event) => {
    if (!event.target.checked) {
      return;
    }
    try {
      await switchCryptoStack(event.target.value);
    } catch (error) {
      setStatus(`Ошибка переключения криптоплагина: ${error.message}`);
    }
  });
});

document.getElementById('chooseCertificateButton').addEventListener('click', async () => {
  const button = document.getElementById('chooseCertificateButton');
  button.disabled = true;
  try {
    if (state.activeCryptoStack === 'rutoken') {
      await withOperationalCryptoBusyOverlay('Читаю состояние Рутокена…', () => requestRutokenEnvironmentRefresh({ silentStatus: true }));
    }
    const selectedCertificate = await openCertificateDialog(state.certificates, state.selectedCertificate);
    state.selectedCertificate = selectedCertificate;
    updatePrimaryActionState();
    setStatus(`Сертификат выбран: ${selectedCertificate.label}. Теперь можно запускать подпись.`);
  } catch (error) {
    if (!String(error.message || '').includes('отменён')) {
      setStatus(`Ошибка выбора сертификата: ${error.message}`);
    }
  } finally {
    updateSelectedCertificateUi();
  }
});

document.getElementById('signButton').addEventListener('click', async () => {
  const button = document.getElementById('signButton');
  button.disabled = true;
  try {
    await prepareAndSign();
  } catch (error) {
    const details = state.activeCryptoStack === 'rutoken'
      ? getRutokenErrorMessage(error)
      : (window.cadesplugin?.getLastError ? window.cadesplugin.getLastError(error) : error.message);
    setStatus(`Ошибка: ${details}`);
  } finally {
    updatePrimaryActionState();
  }
});

document.getElementById('resultInfoToggle').addEventListener('click', () => {
  const toggle = document.getElementById('resultInfoToggle');
  setVerificationDetailsExpanded(toggle.getAttribute('aria-expanded') !== 'true');
});

document.getElementById('stampSettingsButton').addEventListener('click', async () => {
  const button = document.getElementById('stampSettingsButton');
  button.disabled = true;
  try {
    await Promise.all([fetchStampConfig(), fetchAvailableFonts()]);
    await openStampSettingsDialog();
    setStatus('Персональные настройки штампа сохранены в этом браузере. Следующая подготовка PDF возьмёт новые параметры.');
  } catch (error) {
    if (!String(error.message || '').includes('отменена')) {
      setStatus(`Ошибка: ${error.message}`);
    }
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll('[data-stamp-position]').forEach((button) => {
  button.addEventListener('click', () => {
    applyStampPlacementPreset(button.dataset.stampPosition);
    setStatus(`Положение штампа обновлено: ${STAMP_POSITION_PRESETS[button.dataset.stampPosition]?.label || 'выбрано'}.`);
  });
});

boot().catch((error) => {
  document.getElementById('docMeta').textContent = `Ошибка загрузки: ${error.message}`;
  setStatus(`Ошибка запуска страницы: ${error.message}`);
});
