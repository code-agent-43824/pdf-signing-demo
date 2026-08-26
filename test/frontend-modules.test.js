const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const MODULE_DIR = path.resolve(__dirname, '..', 'public', 'modules');

function loadBrowserModules(names) {
  const window = {};
  const context = vm.createContext({ window });
  names.forEach((name) => vm.runInContext(
    fs.readFileSync(path.join(MODULE_DIR, name), 'utf8'),
    context,
  ));
  return window;
}

function loadBrowserModule(name) {
  return loadBrowserModules([name]);
}

test('frontend API client preserves endpoints, JSON requests and safe errors', async () => {
  const { PdfSigningApi } = loadBrowserModule('api-client.js');
  const calls = [];
  const client = PdfSigningApi.createApiClient(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, url }) };
  });

  await client.loadStampConfig();
  await client.loadFonts();
  await client.prepare({ value: 'prepare' });
  await client.complete({ value: 'complete' });

  assert.deepEqual(calls.map(({ url }) => url), [
    './api/stamp-config',
    './api/fonts',
    './api/sign/prepare',
    './api/sign/complete',
  ]);
  assert.equal(calls[0].options, undefined);
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(calls[2].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[2].options.body), { value: 'prepare' });

  const failing = PdfSigningApi.createApiClient(async () => ({
    ok: false,
    json: async () => ({ ok: false, message: 'safe failure' }),
  }));
  await assert.rejects(failing.loadFonts(), /safe failure/);
});

test('certificate helpers preserve date, key-usage and DN boundaries', () => {
  const { PdfSigningCertificates: certificates } = loadBrowserModule('certificates.js');
  const now = Date.parse('2026-08-24T09:00:00Z');

  assert.equal(certificates.isCertificateDateWindowValid(
    '2026-08-23T09:00:00Z',
    '2026-08-25T09:00:00Z',
    now,
  ), true);
  assert.equal(certificates.isCertificateDateWindowValid(
    '2026-08-23T09:00:00Z',
    '2026-08-24T09:00:00Z',
    now,
  ), false);
  assert.equal(certificates.isSigningKeyUsageAllowed({
    present: true,
    digitalSignature: false,
    nonRepudiation: false,
  }), false);
  assert.deepEqual(
    Array.from(certificates.collectKeyUsageTokens({
      digitalSignature: true,
      nested: ['keyEncipherment'],
    })),
    ['digitalSignature', 'keyEncipherment'],
  );
  assert.equal(
    certificates.getCertificateCommonName('CN="Иванов, Иван", O=Компания'),
    'Иванов, Иван',
  );
  assert.equal(
    certificates.getCertificateIssuerLabel('OU=УЦ, O=Организация'),
    'Организация',
  );
});

test('CryptoPro adapter builds detached CAdES-BES from the prepared digest', async () => {
  const { PdfSigningCryptoPro: adapter } = loadBrowserModules([
    'certificates.js',
    'cryptopro-adapter.js',
  ]);
  const calls = [];
  const objects = {
    'CAdESCOM.HashedData': {
      propset_Algorithm(value) { calls.push(['algorithm', value]); },
      propset_DataEncoding(value) { calls.push(['encoding', value]); },
      async Hash(value) { calls.push(['hash', value]); },
    },
    'CAdESCOM.CPSigner': {
      propset_Certificate(value) { calls.push(['certificate', value]); },
    },
    'CAdESCOM.CadesSignedData': {
      async SignHash(hashedData, signer, type) {
        calls.push(['sign', hashedData, signer, type]);
        return '-----BEGIN CMS-----\nYWJj\n-----END CMS-----';
      },
    },
  };
  const plugin = {
    CADESCOM_HASH_ALGORITHM_CP_GOST_3411_2012_256: 101,
    CADESCOM_BASE64_TO_BINARY: 1,
    CADESCOM_CADES_BES: 7,
    async CreateObjectAsync(name) { return objects[name]; },
  };

  const result = await adapter.sign(plugin, {
    algorithm: 'ГОСТ Р 34.10-2012 256',
    label: 'Тест',
    certificate: { id: 'certificate' },
  }, 'digest-base64');

  assert.equal(result, 'YWJj');
  assert.deepEqual(calls.map(([name]) => name), [
    'algorithm', 'encoding', 'hash', 'certificate', 'sign',
  ]);
  assert.equal(calls[0][1], 101);
  assert.equal(calls[2][1], 'digest-base64');
  assert.equal(calls[4][3], 7);
});

test('CryptoPro environment owns plugin discovery, diagnostics and certificate refresh', async () => {
  const window = loadBrowserModules([
    'certificates.js',
    'cryptopro-adapter.js',
  ]);
  const diagnostics = new Map();
  const plugin = {
    async CreateObjectAsync(name) {
      if (name === 'CAdESCOM.About') return { CSPVersion: '5.0' };
      if (name === 'CAdESCOM.Store') {
        return {
          Certificates: { Count: 0 },
          async Open() {},
          async Close() {},
        };
      }
      throw new Error(`Unexpected object: ${name}`);
    },
  };
  window.cadesplugin = plugin;
  let scriptLoads = 0;
  const environment = window.PdfSigningCryptoPro.createEnvironment({
    async loadScript() { scriptLoads += 1; },
    setDiagnostic(key, state, text) { diagnostics.set(key, { state, text }); },
  });

  const snapshot = await environment.initialize();

  assert.equal(scriptLoads, 1);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.client, plugin);
  assert.deepEqual(Array.from(snapshot.certificates), []);
  assert.deepEqual(diagnostics.get('extension'), { state: 'ready', text: 'доступно' });
  assert.deepEqual(diagnostics.get('plugin'), { state: 'ready', text: 'доступен' });
  assert.deepEqual(diagnostics.get('csp'), { state: 'ready', text: '5.0' });
  assert.equal(environment.isOperational({
    client: plugin,
    diagnostics: Object.fromEntries(diagnostics),
  }), true);
});

test('Rutoken adapter keeps signing detached and maps provider login errors', async () => {
  const { PdfSigningRutoken: adapter } = loadBrowserModules([
    'certificates.js',
    'rutoken-adapter.js',
  ]);
  const calls = [];
  const plugin = {
    DATA_FORMAT_BASE64: 'base64',
    HASH_TYPE_SHA256: 'sha256',
    errorCodes: { ALREADY_LOGGED_IN: 93 },
    async sign(...args) {
      calls.push(args);
      return '-----BEGIN CMS-----\nZGV0YWNoZWQ=\n-----END CMS-----';
    },
  };

  const result = await adapter.sign(plugin, {
    deviceId: 'device-1',
    certId: 'cert-1',
    algorithm: 'RSA SHA-256',
    label: 'Тест',
  }, 'digest-base64');

  assert.equal(result, 'ZGV0YWNoZWQ=');
  assert.deepEqual(calls[0].slice(0, 4), [
    'device-1', 'cert-1', 'digest-base64', 'base64',
  ]);
  assert.deepEqual({ ...calls[0][4] }, {
    detached: true,
    addSignTime: true,
    addEssCert: true,
    rsaHashAlgorithm: 'sha256',
  });
  assert.equal(adapter.isAlreadyLoggedInError(new Error('93'), plugin), true);
  assert.equal(adapter.getErrorMessage(new Error('93'), plugin), 'ALREADY_LOGGED_IN (93)');
});

test('Rutoken environment owns discovery, refresh events and debounced token monitoring', async () => {
  const window = loadBrowserModules([
    'certificates.js',
    'rutoken-adapter.js',
  ]);
  const diagnostics = new Map();
  const tokenEvents = [];
  const browserEvents = [];
  const documentEvents = [];
  let devices = [7];
  let monitorCallback;
  let scheduledCallback;
  const plugin = {
    valid: true,
    ENUMERATE_DEVICES_LIST: 'list',
    CERT_CATEGORY_USER: 'user',
    TOKEN_INFO_LABEL: 'label',
    async enumerateDevices() { return devices; },
    async enumerateCertificates() { return []; },
    async getDeviceInfo(deviceId) { return `Token ${deviceId}`; },
    tokenMonitor(callback) { monitorCallback = callback; },
  };
  window.chrome = {};
  window.addEventListener = (name) => browserEvents.push(name);
  window.rutoken = {
    ready: Promise.resolve(),
    async isExtensionInstalled() { return true; },
    async isPluginInstalled() { return true; },
    async loadPlugin() { return plugin; },
  };
  const document = {
    hidden: false,
    addEventListener(name) { documentEvents.push(name); },
  };
  const environment = window.PdfSigningRutoken.createEnvironment({
    document,
    async loadScript() {},
    onTokenEvent(event) { tokenEvents.push(event); },
    setDiagnostic(key, state, text) { diagnostics.set(key, { state, text }); },
    schedule(callback) { scheduledCallback = callback; return 1; },
    cancelSchedule() {},
  });

  const snapshot = await environment.initialize();
  environment.bindRefreshEvents(() => {});

  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.client, plugin);
  assert.deepEqual(Array.from(snapshot.deviceIds), [7]);
  assert.deepEqual(Array.from(snapshot.tokenLabels), ['Token 7']);
  assert.deepEqual(diagnostics.get('extension'), { state: 'ready', text: 'доступно' });
  assert.deepEqual(diagnostics.get('plugin'), { state: 'ready', text: 'доступен' });
  assert.deepEqual(diagnostics.get('token'), { state: 'ready', text: 'Token 7' });
  assert.deepEqual(browserEvents, ['focus', 'pageshow']);
  assert.deepEqual(documentEvents, ['visibilitychange']);
  assert.equal(environment.isOperational({
    client: plugin,
    diagnostics: Object.fromEntries(diagnostics),
  }), true);

  devices = [];
  monitorCallback('disconnected', 7);
  await Promise.resolve();
  await scheduledCallback();

  assert.equal(tokenEvents[0].phase, 'detected');
  assert.equal(tokenEvents[1].phase, 'refreshed');
  assert.deepEqual(Array.from(tokenEvents[1].snapshot.deviceIds), []);
  assert.deepEqual(diagnostics.get('token'), { state: 'error', text: 'не вставлен' });

  window.rutoken.isExtensionInstalled = async () => false;
  await assert.rejects(environment.initialize(), /Не найдено расширение/);
  assert.deepEqual(diagnostics.get('extension'), { state: 'error', text: 'не найдено' });
});

test('signing state machine rejects duplicate and impossible workflow transitions', () => {
  const { PdfSigningState } = loadBrowserModule('signing-state.js');
  const changes = [];
  const workflow = PdfSigningState.createSigningStateMachine((change) => changes.push({ ...change }));

  assert.equal(workflow.phase, 'idle');
  assert.equal(workflow.can('start'), true);
  workflow.transition('start');
  assert.equal(workflow.active, true);
  assert.throws(() => workflow.transition('start'), /not allowed/);
  assert.throws(() => workflow.transition('reset'), /not allowed/);
  workflow.transition('confirmed');
  assert.throws(() => workflow.transition('completed'), /not allowed/);
  workflow.transition('prepared');
  workflow.transition('signed');
  workflow.transition('completed');
  assert.equal(workflow.phase, 'complete');
  assert.equal(workflow.active, false);
  assert.throws(() => workflow.transition('completed'), /not allowed/);
  assert.equal(changes.length, 5);

  workflow.transition('start');
  workflow.transition('failed');
  assert.equal(workflow.phase, 'failed');
  assert.equal(workflow.can('start'), true);
  workflow.transition('reset');
  assert.equal(workflow.phase, 'idle');
});

test('preview UI validates result capabilities and independent verification statuses', () => {
  const { PdfSigningPreview: preview } = loadBrowserModule('preview-ui.js');
  const verification = {
    schemaVersion: 1,
    integrity: {
      status: 'valid',
      code: 'CMS_INTEGRITY_VALID',
      signerCertificateMatched: true,
      signaturesVerified: 2,
    },
    trust: {
      status: 'not_checked',
      code: 'CERTIFICATE_TRUST_NOT_CHECKED',
      checks: {
        chain: 'not_checked',
        validity: 'not_checked',
        revocation: 'not_checked',
        keyUsage: 'not_checked',
      },
    },
    qualified: {
      status: 'not_checked',
      code: 'QUALIFIED_STATUS_NOT_CHECKED',
    },
  };
  assert.equal(preview.validateVerification(verification), 2);
  assert.equal(preview.getSignatureCountLabel(2), 'подписи');
  assert.throws(
    () => preview.validateVerification({ ...verification, trust: { status: 'valid' } }),
    /полный и однозначный результат/,
  );
  const token = 'A'.repeat(43);
  const expiresAt = preview.validateResult({
    signedPdfUrl: `./api/results/${token}`,
    downloadUrl: `./api/results/${token}`,
    resultExpiresAt: '2026-08-25T22:00:00.000Z',
  }, Date.parse('2026-08-25T21:00:00.000Z'));
  assert.equal(expiresAt.toISOString(), '2026-08-25T22:00:00.000Z');
  assert.throws(() => preview.validateResult({
    signedPdfUrl: 'https://example.test/result.pdf',
    downloadUrl: `./api/results/${token}`,
    resultExpiresAt: '2026-08-25T22:00:00.000Z',
  }, 0), /некорректную ссылку/);
});

test('placement controller maps presets and updates config without hidden DOM state', () => {
  const { PdfSigningPlacement: placement } = loadBrowserModule('placement.js');
  let config = {
    appearance: { width: 144 },
    placements: { rules: [{ placement: { anchor: 'bottom-left', offsetX: 24, offsetY: 24 } }] },
  };
  let selected = 'left';
  const buttons = ['left', 'right'].map((name) => ({
    dataset: { stampPosition: name },
    classList: { toggle(_className, value) { this.active = value; } },
    setAttribute(_name, value) { this.pressed = value; },
  }));
  const controller = placement.createPlacementController({
    document: { querySelectorAll: () => buttons },
    ensureShape: (value) => JSON.parse(JSON.stringify(value)),
    getConfig: () => config,
    getDefaultRule: (value) => value.placements.rules[0],
    getSelected: () => selected,
    setConfig: (value) => { config = value; },
    setSelected: (value) => { selected = value; },
  });

  assert.equal(controller.getPresetKey(config, { preferSelected: false }), 'left');
  assert.equal(controller.apply('right'), true);
  assert.equal(selected, 'right');
  assert.equal(config.appearance.width, 128);
  assert.deepEqual({ ...config.placements.rules[0].placement }, {
    anchor: 'bottom-right',
    columns: 1,
    mode: 'anchored',
    offsetX: 24,
    offsetY: 24,
    stepX: 0,
    stepY: 0,
  });
  assert.equal(buttons[1].classList.active, true);
  assert.equal(buttons[1].pressed, 'true');
  assert.equal(controller.apply('unknown'), false);
});

test('signing orchestrator preserves confirmation, prepare, sign and complete order', async () => {
  const { PdfSigningState, PdfSigningOrchestrator } = loadBrowserModules([
    'signing-state.js',
    'signing-orchestrator.js',
  ]);
  const calls = [];
  const workflow = PdfSigningState.createSigningStateMachine(({ phase }) => calls.push(`phase:${phase}`));
  const orchestrator = PdfSigningOrchestrator.createSigningOrchestrator({
    apiClient: {
      async prepare(body) {
        calls.push(`prepare:${body.signer.certificateBase64}`);
        return { sessionId: 'session', contentToSignBase64: 'digest' };
      },
      async complete(body) {
        calls.push(`complete:${body.cmsSignatureBase64}`);
        return { ok: true };
      },
    },
    async confirm() { calls.push('confirm'); },
    async ensureRutokenLogin() { calls.push('login'); },
    async exportCertificate() { calls.push('certificate'); return 'certificate-base64'; },
    getContext: () => ({
      certificate: { deviceId: 'device', label: 'Test certificate' },
      async logoutRutoken() { calls.push('logout'); },
      mode: 'rutoken',
      pdfBase64: 'pdf-base64',
      pdfName: 'document.pdf',
      pluginReady: true,
      providerLabel: 'Рутокен',
      stampConfig: { schemaVersion: 1 },
      stampPosition: 'right',
    }),
    async refreshRutoken() { calls.push('refresh'); },
    async sha256() { calls.push('sha256'); return 'document-digest'; },
    showResult() { calls.push('show-result'); return new Date('2026-08-25T22:00:00Z'); },
    async signCryptoPro() { throw new Error('wrong provider'); },
    async signRutoken() { calls.push('sign'); return 'cms-base64'; },
    status(message) { calls.push(`status:${message.split('…')[0]}`); },
    updateAction() { calls.push('update-action'); },
    workflow,
  });

  await orchestrator.run();
  assert.deepEqual(calls.filter((item) => [
    'confirm', 'certificate', 'login', 'sign', 'logout', 'show-result', 'update-action',
  ].includes(item) || /^(prepare|complete):/.test(item)), [
    'confirm',
    'certificate',
    'prepare:certificate-base64',
    'login',
    'sign',
    'logout',
    'complete:cms-base64',
    'show-result',
    'update-action',
  ]);
  assert.equal(workflow.phase, 'complete');
});

test('stamp configuration store merges browser overrides without mutating defaults', () => {
  const { PdfSigningStampConfig } = loadBrowserModule('stamp-config.js');
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const store = PdfSigningStampConfig.createStampConfigStore(storage, 'stamp');
  const defaults = {
    appearance: { width: 128, fonts: {} },
    content: { title: ['Default'], rows: [] },
    placements: { rules: [] },
  };
  store.save({ appearance: { width: 144 }, content: { title: ['Personal'] } });
  const resolved = JSON.parse(JSON.stringify(store.resolve(defaults)));

  assert.equal(resolved.appearance.width, 144);
  assert.deepEqual(resolved.content.title, ['Personal']);
  assert.equal(resolved.placements.rules.length, 1);
  assert.equal(defaults.appearance.width, 128);
  assert.equal(store.has(), true);
  store.clear();
  assert.equal(store.has(), false);
});

test('dialog manager fails closed before touching DOM when no certificate exists', async () => {
  const { PdfSigningDialogs } = loadBrowserModule('dialogs.js');
  const manager = PdfSigningDialogs.createDialogManager({}, {
    formatCertificateDate: String,
    getCertificateKey: () => '',
  });
  await assert.rejects(manager.openCertificate([]), /Не найдено доступных сертификатов/);
});
