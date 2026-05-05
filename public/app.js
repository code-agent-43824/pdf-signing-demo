const state = {
  certificates: [],
  pluginReady: false,
  defaultPdfUrl: null,
  uploadedPdfBase64: null,
  uploadedPdfName: null,
  uploadedPdfObjectUrl: null,
  stampConfig: null,
  stampConfigPath: null,
  availableFonts: [],
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

async function fetchStampConfig() {
  const response = await fetch('./api/stamp-config');
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.message || 'Не удалось загрузить конфиг штампа.');
  }
  state.stampConfig = data.config;
  state.stampConfigPath = data.configPath;
  return data;
}

async function fetchAvailableFonts() {
  const response = await fetch('./api/fonts');
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.message || 'Не удалось загрузить список шрифтов.');
  }
  state.availableFonts = data.fonts || [];
  return data;
}

function showPdf(url, metaText) {
  document.getElementById('sourcePdf').src = url;
  document.getElementById('docMeta').textContent = metaText;
}

async function boot() {
  const [formResponse] = await Promise.all([
    fetch('./api/form').then((response) => response.json()),
    fetchStampConfig(),
    fetchAvailableFonts(),
  ]);
  state.defaultPdfUrl = formResponse.pdfUrl;
  showPdf(formResponse.pdfUrl, `${Math.round(formResponse.size / 1024)} KB`);
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

function isCertificateDateValid(validToDate) {
  const parsed = new Date(validToDate);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now();
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
      if (!isCertificateDateValid(validToDate)) {
        continue;
      }
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
    setPluginState(`CryptoPro готов, доступных непpосроченных сертификатов: ${certificates.length}`);
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

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config || {}));
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
  if (currentPath && !state.availableFonts.some((font) => font.path === currentPath)) {
    options.push({ path: currentPath, label: `${currentPath.split('/').pop()} (текущий путь)` });
  }
  options.push(...state.availableFonts);
  select.innerHTML = '';
  options.forEach((font) => {
    const option = document.createElement('option');
    option.value = font.path;
    option.textContent = `${font.label} — ${font.path}`;
    select.appendChild(option);
  });
  if (currentPath) {
    select.value = currentPath;
  }
}

function renderStampRows(root, rows) {
  const container = root.querySelector('#stampRowsEditor');
  container.innerHTML = '';

  rows.forEach((row, index) => {
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
          <input type="text" data-field="value" value="${escapeHtml(row.value || '')}" />
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

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function populateVisualForm(root, config) {
  const draft = ensureStampConfigShape(config);
  const rule = draft.placements.rules[0];

  root.querySelector('#appearanceWidth').value = Number(draft.appearance.width || 176);
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

  root.querySelector('#signatureName').value = draft.signatureObject.name || '';
  root.querySelector('#signatureReason').value = draft.signatureObject.reason || '';
  root.querySelector('#signatureContactInfo').value = draft.signatureObject.contactInfo || '';
  root.querySelector('#signatureLocation').value = draft.signatureObject.location || '';
  root.querySelector('#signatureBytesReserved').value = Number(draft.signatureObject.bytesReserved || 16000);
  root.querySelector('#signatureSubfilter').value = draft.signatureObject.subfilter || 'PADES';

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
}

function collectStampRows(root) {
  return Array.from(root.querySelectorAll('.row-card')).map((card) => ({
    label: card.querySelector('[data-field="label"]').value.trim(),
    value: card.querySelector('[data-field="value"]').value.trim(),
    maxLines: Number(card.querySelector('[data-field="maxLines"]').value || 2),
    breakAnywhere: card.querySelector('[data-field="breakAnywhere"]').checked,
  }));
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

  const rule = draft.placements.rules[0];
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
  populateVisualForm(root, state.stampConfig);
  jsonTab.classList.remove('is-active');
  visualTab.classList.add('is-active');
  jsonTab.setAttribute('aria-selected', 'false');
  visualTab.setAttribute('aria-selected', 'true');
  jsonPanel.classList.add('hidden');
  visualPanel.classList.remove('hidden');
}

function wireStampSettingsForm(root) {
  root.querySelector('#addStampRow').addEventListener('click', () => {
    const nextConfig = readVisualForm(root);
    nextConfig.content.rows.push({
      label: 'Новое поле',
      value: '{signer.value}',
      maxLines: 2,
      breakAnywhere: false,
    });
    state.stampConfig = nextConfig;
    populateVisualForm(root, state.stampConfig);
  });

  root.querySelector('#stampRowsEditor').addEventListener('click', (event) => {
    const button = event.target.closest('.row-remove');
    if (!button) return;
    const index = Number(button.dataset.index);
    const nextConfig = readVisualForm(root);
    nextConfig.content.rows.splice(index, 1);
    state.stampConfig = nextConfig;
    populateVisualForm(root, state.stampConfig);
  });

  root.querySelector('#stampTabVisual').addEventListener('click', () => {
    try {
      switchStampTab(root, 'visual');
    } catch (error) {
      setStatus(`Ошибка JSON: ${error.message}`);
    }
  });

  root.querySelector('#stampTabJson').addEventListener('click', () => {
    state.stampConfig = readVisualForm(root);
    switchStampTab(root, 'json');
  });
}

function openStampSettingsDialog() {
  return new Promise((resolve, reject) => {
    const fragment = document.getElementById('stampSettingsDialogTemplate').content.cloneNode(true);
    const backdrop = fragment.querySelector('.dialog-backdrop');
    const configPath = fragment.querySelector('#stampConfigPath');
    const save = fragment.querySelector('#saveStampSettings');
    const cancel = fragment.querySelector('#cancelStampSettings');
    const root = backdrop;

    state.stampConfig = ensureStampConfigShape(state.stampConfig);
    configPath.textContent = state.stampConfigPath || '';
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

    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const isJsonVisible = !root.querySelector('#stampJsonPanel').classList.contains('hidden');
        const parsed = isJsonVisible
          ? ensureStampConfigShape(JSON.parse(root.querySelector('#stampConfigEditor').value))
          : readVisualForm(root);
        const response = await fetch('./api/stamp-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: parsed }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.message || 'Не удалось сохранить конфиг штампа.');
        }
        state.stampConfig = parsed;
        state.stampConfigPath = data.configPath || state.stampConfigPath;
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

document.getElementById('stampSettingsButton').addEventListener('click', async () => {
  const button = document.getElementById('stampSettingsButton');
  button.disabled = true;
  try {
    await Promise.all([fetchStampConfig(), fetchAvailableFonts()]);
    await openStampSettingsDialog();
    setStatus('Конфиг штампа сохранён. Следующая подготовка PDF возьмёт новые параметры.');
  } catch (error) {
    if (!String(error.message || '').includes('отменена')) {
      setStatus(`Ошибка: ${error.message}`);
    }
  } finally {
    button.disabled = false;
  }
});

boot().catch((error) => {
  document.getElementById('docMeta').textContent = `Ошибка загрузки: ${error.message}`;
  setStatus(`Ошибка запуска страницы: ${error.message}`);
});
