const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const MODULE_DIR = path.resolve(__dirname, '..', 'public', 'modules');

function loadBrowserModules(names) {
  const window = {};
  const context = vm.createContext({ window });
  for (const name of names) {
    vm.runInContext(fs.readFileSync(path.join(MODULE_DIR, name), 'utf8'), context);
  }
  return window;
}

function loadBrowserModule(name) {
  return loadBrowserModules([name]);
}

function certificateWithPublicKeyOid(oidHex) {
  const der = (tag, content) => {
    const length = content.length;
    return Buffer.concat([Buffer.from([tag, length]), content]);
  };
  const empty = der(0x30, Buffer.alloc(0));
  const spki = der(
    0x30,
    Buffer.concat([der(0x30, der(0x06, Buffer.from(oidHex, 'hex'))), der(0x03, Buffer.from([0]))]),
  );
  const tbs = der(
    0x30,
    Buffer.concat([der(0x02, Buffer.from([1])), empty, empty, empty, empty, spki]),
  );
  return der(0x30, Buffer.concat([tbs, empty, der(0x03, Buffer.from([0]))])).toString('base64');
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

  assert.deepEqual(
    calls.map(({ url }) => url),
    ['./api/stamp-config', './api/fonts', './api/sign/prepare', './api/sign/complete'],
  );
  assert.equal(calls[0].options, undefined);
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(calls[2].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[2].options.body), { value: 'prepare' });

  const failing = PdfSigningApi.createApiClient(async () => ({
    ok: false,
    json: async () => ({ ok: false, message: 'safe failure' }),
  }));
  await assert.rejects(failing.loadFonts(), /^Error: safe failure$/);

  const rejected = PdfSigningApi.createApiClient(async () => ({
    ok: false,
    json: async () => ({
      ok: false,
      code: 'CMS_INTEGRITY_FAILED',
      reason: 'CONTENT_DIGEST_MISMATCH',
      message: 'CMS-подпись не прошла обязательную проверку целостности.',
      requestId: 'request-id',
    }),
  }));
  await assert.rejects(rejected.complete({}), (error) => {
    assert.equal(
      error.message,
      'CMS-подпись не прошла обязательную проверку целостности. '
        + 'Код причины: CONTENT_DIGEST_MISMATCH.',
    );
    assert.equal(error.code, 'CMS_INTEGRITY_FAILED');
    assert.equal(error.reason, 'CONTENT_DIGEST_MISMATCH');
    assert.equal(error.requestId, 'request-id');
    return true;
  });
});

test('PDF upload rejects oversized and non-PDF bytes before signing', async () => {
  const { PdfSigningPdfUpload: upload } = loadBrowserModule('pdf-upload.js');
  const file = (bytes, size = bytes.length) => ({
    size,
    slice: (_start, end) => ({
      arrayBuffer: async () => Uint8Array.from(bytes.subarray(0, end)).buffer,
    }),
  });
  await upload.validate(file(Buffer.from('%PDF-1.7')));
  await assert.rejects(upload.validate(file(Buffer.from('%PDF-'), 10 * 1024 * 1024 + 1)), /10 МиБ/);
  await assert.rejects(upload.validate(file(Buffer.from('not a pdf'))), /не PDF-файл/);
});

test('certificate helpers preserve date, key-usage and DN boundaries', () => {
  const { PdfSigningCertificates: certificates } = loadBrowserModule('certificates.js');
  const now = Date.parse('2026-08-24T09:00:00Z');

  assert.equal(
    certificates.isCertificateDateWindowValid('2026-08-23T09:00:00Z', '2026-08-25T09:00:00Z', now),
    true,
  );
  assert.equal(
    certificates.isCertificateDateWindowValid('2026-08-23T09:00:00Z', '2026-08-24T09:00:00Z', now),
    false,
  );
  assert.equal(
    certificates.isSigningKeyUsageAllowed({
      present: true,
      digitalSignature: false,
      nonRepudiation: false,
    }),
    false,
  );
  assert.deepEqual(
    Array.from(
      certificates.collectKeyUsageTokens({
        digitalSignature: true,
        nested: ['keyEncipherment'],
      }),
    ),
    ['digitalSignature', 'keyEncipherment'],
  );
  assert.equal(
    certificates.getCertificateCommonName('CN="Иванов, Иван", O=Компания'),
    'Иванов, Иван',
  );
  assert.equal(certificates.getCertificateIssuerLabel('OU=УЦ, O=Организация'), 'Организация');
});

test('Rutoken PIN dialog preserves letters and requires deliberate retry for a short PIN', async () => {
  const window = loadBrowserModule('dialogs.js');
  const elements = new Map();
  const node = () => ({
    value: '',
    textContent: '',
    dataset: {},
    listeners: {},
    classList: { add() {}, remove() {} },
    addEventListener(name, callback) {
      this.listeners[name] = callback;
    },
    focus() {},
    remove() {
      this.removed = true;
    },
    querySelectorAll() {
      return [elements.get('#rutokenPinInput')];
    },
  });
  for (const id of [
    '.dialog-backdrop',
    '#rutokenPinPrompt',
    '#rutokenPinInput',
    '#rutokenPinError',
    '#confirmRutokenPin',
    '#cancelRutokenPin',
  ])
    elements.set(id, node());
  const fragment = {
    querySelector(selector) {
      return elements.get(selector);
    },
    querySelectorAll() {
      return [];
    },
  };
  const document = {
    getElementById() {
      return {
        content: {
          cloneNode() {
            return fragment;
          },
        },
      };
    },
    body: { appendChild() {} },
  };
  window.requestAnimationFrame = (callback) => callback();
  const dialogs = window.PdfSigningDialogs.createDialogManager(document, {});
  const input = elements.get('#rutokenPinInput');
  const confirm = elements.get('#confirmRutokenPin');

  const fullPin = dialogs.openPin();
  input.value = 'Demo2026pin';
  input.listeners.input();
  assert.equal(input.value, 'Demo2026pin');
  confirm.listeners.click();
  assert.equal(await fullPin, 'Demo2026pin');
  assert.equal(input.value, '');

  const shortPin = dialogs.openPin();
  input.value = '123';
  input.listeners.input();
  confirm.listeners.click();
  assert.equal(elements.get('#rutokenPinError').textContent.includes('короче 6'), true);
  assert.equal(input.value, '123');
  confirm.listeners.click();
  assert.equal(await shortPin, '123');

  const cancelledPin = dialogs.openPin();
  input.value = 'secret';
  elements.get('#cancelRutokenPin').listeners.click();
  await assert.rejects(cancelledPin, (error) => error.code === 'USER_CANCELLED');
  assert.equal(input.value, '');

  for (const id of [
    '#confirmationDocumentName',
    '#confirmationDocumentDigest',
    '#confirmationCertificateName',
    '#confirmationCertificateFingerprint',
    '#confirmSigning',
    '#cancelSigning',
  ])
    elements.set(id, node());
  const cancelledSigning = dialogs.openSigningConfirmation({
    documentName: 'test.pdf',
    documentDigest: 'digest',
    certificate: { label: 'Test' },
  });
  elements.get('#cancelSigning').listeners.click();
  await assert.rejects(cancelledSigning, (error) => error.code === 'USER_CANCELLED');
});

test('CryptoPro adapter builds detached CAdES-BES from the prepared digest', async () => {
  const { PdfSigningCryptoPro: adapter } = loadBrowserModules([
    'certificates.js',
    'cryptopro-adapter.js',
  ]);
  const calls = [];
  const objects = {
    'CAdESCOM.HashedData': {
      propset_Algorithm(value) {
        calls.push(['algorithm', value]);
      },
      propset_DataEncoding(value) {
        calls.push(['encoding', value]);
      },
      async Hash(value) {
        calls.push(['hash', value]);
      },
    },
    'CAdESCOM.CPSigner': {
      propset_Certificate(value) {
        calls.push(['certificate', value]);
      },
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
    async CreateObjectAsync(name) {
      return objects[name];
    },
  };

  const result = await adapter.sign(
    plugin,
    {
      algorithm: 'ГОСТ Р 34.10-2012 256',
      label: 'Тест',
      certificate: { id: 'certificate' },
    },
    'digest-base64',
  );

  assert.equal(result, 'YWJj');
  assert.deepEqual(
    calls.map(([name]) => name),
    ['algorithm', 'encoding', 'hash', 'certificate', 'sign'],
  );
  assert.equal(calls[0][1], 101);
  assert.equal(calls[2][1], 'digest-base64');
  assert.equal(calls[4][3], 7);
});

test('CryptoPro environment owns plugin discovery, diagnostics and certificate refresh', async () => {
  const window = loadBrowserModules(['certificates.js', 'cryptopro-adapter.js']);
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
    async loadScript() {
      scriptLoads += 1;
    },
    setDiagnostic(key, state, text) {
      diagnostics.set(key, { state, text });
    },
  });

  const snapshot = await environment.initialize();

  assert.equal(scriptLoads, 1);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.client, plugin);
  assert.deepEqual(Array.from(snapshot.certificates), []);
  assert.deepEqual(diagnostics.get('extension'), {
    state: 'pending',
    text: 'отдельно не подтверждено',
  });
  assert.deepEqual(diagnostics.get('plugin'), { state: 'ready', text: 'доступен' });
  assert.deepEqual(diagnostics.get('csp'), { state: 'ready', text: '5.0' });
  assert.equal(
    environment.isOperational({
      client: plugin,
      diagnostics: Object.fromEntries(diagnostics),
    }),
    true,
  );
});

test('CryptoPro CSP version is awaited through the async plugin API', async () => {
  const window = loadBrowserModules(['certificates.js', 'cryptopro-adapter.js']);
  const diagnostics = new Map();
  // In the async CAdES API every method returns a Promise, the version
  // object's toString() included.
  const plugin = {
    async CreateObjectAsync(name) {
      if (name === 'CAdESCOM.About') {
        return {
          async CSPVersion() {
            return { toString: async () => '5.0.13000' };
          },
        };
      }
      if (name === 'CAdESCOM.Store') {
        return { Certificates: { Count: 0 }, async Open() {}, async Close() {} };
      }
      throw new Error(`Unexpected object: ${name}`);
    },
  };
  window.cadesplugin = plugin;
  const environment = window.PdfSigningCryptoPro.createEnvironment({
    async loadScript() {},
    setDiagnostic(key, state, text) {
      diagnostics.set(key, { state, text });
    },
  });

  await environment.initialize();

  assert.deepEqual(diagnostics.get('csp'), { state: 'ready', text: '5.0.13000' });
});

test('CryptoPro loader alone never proves the extension is installed', async () => {
  const window = loadBrowserModules(['certificates.js', 'cryptopro-adapter.js']);
  const diagnostics = new Map();
  const environment = window.PdfSigningCryptoPro.createEnvironment({
    async loadScript() {
      window.cadesplugin = Promise.reject(new Error('CryptoPro extension missing'));
    },
    setDiagnostic(key, state, text) {
      diagnostics.set(key, { state, text });
    },
  });
  await assert.rejects(environment.initialize(), /extension missing/);
  assert.deepEqual(diagnostics.get('extension'), {
    state: 'pending',
    text: 'отдельно не подтверждено',
  });
  assert.equal(diagnostics.get('plugin').state, 'error');
});

test('aborted CryptoPro initialization stops waiting and silences the vendor overlay', async () => {
  const window = loadBrowserModules(['certificates.js', 'cryptopro-adapter.js']);
  const diagnostics = new Map();
  const environment = window.PdfSigningCryptoPro.createEnvironment({
    async loadScript() {},
    setDiagnostic(key, state, text) {
      diagnostics.set(key, { state, text });
    },
  });

  window.cadesplugin = new Promise(() => {});
  const waitingForPlugin = new AbortController();
  const waiting = environment.initialize({ signal: waitingForPlugin.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(window.cadesplugin_skip_extension_install, false);

  waitingForPlugin.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(window.cadesplugin_skip_extension_install, true);
  assert.deepEqual(diagnostics.get('plugin'), { state: 'pending', text: 'Проверка…' });

  const created = [];
  const queryingCsp = new AbortController();
  window.cadesplugin = {
    async CreateObjectAsync(name) {
      created.push(name);
      queryingCsp.abort();
      return { CSPVersion: '5.0' };
    },
  };
  await assert.rejects(environment.initialize({ signal: queryingCsp.signal }), {
    name: 'AbortError',
  });
  assert.deepEqual(created, ['CAdESCOM.About']);

  window.cadesplugin = {
    async CreateObjectAsync(name) {
      if (name === 'CAdESCOM.About') return { CSPVersion: '5.0' };
      return {
        Certificates: { Count: 0 },
        async Open() {},
        async Close() {},
      };
    },
  };
  const snapshot = await environment.initialize({ signal: new AbortController().signal });
  assert.equal(snapshot.ready, true);
  assert.equal(window.cadesplugin_skip_extension_install, false);
});

test('Rutoken adapter keeps signing detached and maps provider login errors', async () => {
  const window = loadBrowserModules(['certificates.js', 'rutoken-adapter.js']);
  window.atob = (value) => Buffer.from(value, 'base64').toString('binary');
  const { PdfSigningRutoken: adapter } = window;
  const rsaCertificate = certificateWithPublicKeyOid('2a864886f70d010101');
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

  const result = await adapter.sign(
    plugin,
    {
      deviceId: 'device-1',
      certId: 'cert-1',
      certificateBase64: rsaCertificate,
      algorithm: 'ГОСТ',
      label: 'Тест',
    },
    'digest-base64',
  );

  assert.equal(result, 'ZGV0YWNoZWQ=');
  assert.deepEqual(calls[0].slice(0, 4), ['device-1', 'cert-1', 'digest-base64', 'base64']);
  assert.deepEqual(
    { ...calls[0][4] },
    {
      detached: true,
      addSignTime: true,
      addEssCert: true,
      rsaHashAlgorithm: 'sha256',
    },
  );
  assert.equal(adapter.isAlreadyLoggedInError(new Error('93'), plugin), true);
  assert.equal(adapter.getErrorMessage(new Error('93'), plugin), 'ALREADY_LOGGED_IN (93)');
});

test('Rutoken signing reads public-key OID, never the subject name', async () => {
  const window = loadBrowserModules(['certificates.js', 'rutoken-adapter.js']);
  window.atob = (value) => Buffer.from(value, 'base64').toString('binary');
  const adapter = window.PdfSigningRutoken;
  const calls = [];
  const plugin = {
    DATA_FORMAT_BASE64: 'base64',
    HASH_TYPE_SHA256: 'sha256',
    async sign(...args) {
      calls.push(args);
      return 'YQ==';
    },
  };
  const rsa = {
    deviceId: 1,
    certId: 'rsa',
    label: 'Тестов Тест ivanov',
    certificateBase64: certificateWithPublicKeyOid('2a864886f70d010101'),
  };
  const gost = {
    deviceId: 1,
    certId: 'gost',
    label: 'rsa в имени',
    certificateBase64: certificateWithPublicKeyOid('2a85030701010101'),
  };
  assert.equal(adapter.assertSupportedAlgorithm(rsa), 'rsa');
  assert.equal(adapter.assertSupportedAlgorithm(gost), 'gost2012-256');
  assert.equal(
    adapter.assertSupportedAlgorithm({
      certificateBase64: certificateWithPublicKeyOid('2a85030701010102'),
    }),
    'gost2012-512',
  );
  assert.throws(
    () => adapter.assertSupportedAlgorithm({ certificateBase64: 'aW52YWxpZA==' }),
    /Некорректный DER/,
  );
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-signing-rutoken-oid-'));
  try {
    const key = path.join(temporary, 'key.pem');
    const cert = path.join(temporary, 'cert.der');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=Ordinary Name',
        '-keyout',
        key,
        '-out',
        cert,
        '-outform',
        'DER',
        '-days',
        '1',
      ],
      { stdio: 'ignore' },
    );
    assert.equal(
      adapter.assertSupportedAlgorithm({
        certificateBase64: fs.readFileSync(cert).toString('base64'),
      }),
      'rsa',
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  await adapter.sign(plugin, rsa, 'digest');
  await adapter.sign(plugin, gost, 'digest');
  assert.equal(calls[0][4].rsaHashAlgorithm, 'sha256');
  assert.equal('rsaHashAlgorithm' in calls[1][4], false);
  const unsupported = {
    ...gost,
    certificateBase64: certificateWithPublicKeyOid('2a8503070101017f'),
  };
  assert.throws(() => adapter.assertSupportedAlgorithm(unsupported), /не поддерживается/);
  await assert.rejects(adapter.sign(plugin, unsupported, 'digest'), /не поддерживается/);
  assert.equal(calls.length, 2);

  const app = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');
  const login = app.match(
    /async function ensureRutokenLogin\(deviceId\) \{[\s\S]*?dialogManager\.openPin/,
  )?.[0];
  assert.ok(login.indexOf('assertSupportedAlgorithm') < login.indexOf('openPin'));
});

test('Rutoken requires a matching private key after login, before signing', async () => {
  const { PdfSigningRutoken: adapter } = loadBrowserModules([
    'certificates.js',
    'rutoken-adapter.js',
  ]);
  const certificate = { deviceId: 7, certId: 'cert-1' };
  const calls = [];
  const plugin = {
    errorCodes: { KEY_NOT_FOUND: 20 },
    async getKeyByCertificate(deviceId, certId) {
      calls.push(['lookup', deviceId, certId]);
      return 'AABB';
    },
    async enumerateKeys(deviceId, marker) {
      calls.push(['keys', deviceId, marker]);
      return ['aabb'];
    },
  };
  await adapter.assertPrivateKeyAvailable(plugin, certificate);
  assert.deepEqual(calls, [
    ['lookup', 7, 'cert-1'],
    ['keys', 7, ''],
  ]);
  plugin.enumerateKeys = async () => [];
  await assert.rejects(
    adapter.assertPrivateKeyAvailable(plugin, certificate),
    /не найден закрытый ключ/,
  );
  plugin.getKeyByCertificate = async () => {
    throw new Error('20');
  };
  await assert.rejects(
    adapter.assertPrivateKeyAvailable(plugin, certificate),
    /не найден закрытый ключ/,
  );
  await assert.rejects(
    adapter.assertPrivateKeyAvailable({}, certificate),
    /не позволяет проверить/,
  );
});

test('Rutoken environment owns discovery, refresh events and debounced token monitoring', async () => {
  const window = loadBrowserModules(['certificates.js', 'rutoken-adapter.js']);
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
    async enumerateDevices() {
      return devices;
    },
    async enumerateCertificates() {
      return [];
    },
    async getDeviceInfo(deviceId) {
      return `Token ${deviceId}`;
    },
    tokenMonitor(callback) {
      monitorCallback = callback;
    },
  };
  window.chrome = {};
  window.addEventListener = (name) => browserEvents.push(name);
  window.rutoken = {
    ready: Promise.resolve(),
    async isExtensionInstalled() {
      return true;
    },
    async isPluginInstalled() {
      return true;
    },
    async loadPlugin() {
      return plugin;
    },
  };
  const document = {
    hidden: false,
    addEventListener(name) {
      documentEvents.push(name);
    },
  };
  const environment = window.PdfSigningRutoken.createEnvironment({
    document,
    async loadScript() {},
    onTokenEvent(event) {
      tokenEvents.push(event);
    },
    setDiagnostic(key, state, text) {
      diagnostics.set(key, { state, text });
    },
    schedule(callback) {
      scheduledCallback = callback;
      return 1;
    },
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
  assert.equal(
    environment.isOperational({
      client: plugin,
      diagnostics: Object.fromEntries(diagnostics),
    }),
    true,
  );

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

test('Rutoken initialization reports an extension or plugin that never answers', async () => {
  const window = loadBrowserModules(['certificates.js', 'rutoken-adapter.js']);
  const diagnostics = new Map();
  const timers = new Map();
  let nextTimer = 1;
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  window.chrome = {};
  const environment = window.PdfSigningRutoken.createEnvironment({
    document: { hidden: false, addEventListener() {} },
    async loadScript() {},
    setDiagnostic(key, state, text) {
      diagnostics.set(key, { state, text });
    },
    schedule(callback) {
      timers.set(nextTimer, callback);
      nextTimer += 1;
      return nextTimer - 1;
    },
    cancelSchedule(timer) {
      timers.delete(timer);
    },
  });

  window.rutoken = { ready: new Promise(() => {}) };
  const waitingForExtension = environment.initialize();
  await settle();
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  await assert.rejects(waitingForExtension, /Расширение 'Адаптер Рутокен Плагина' не ответило/);
  assert.equal(timers.size, 0);
  assert.deepEqual(diagnostics.get('extension'), { state: 'error', text: 'не отвечает' });
  assert.deepEqual(diagnostics.get('plugin'), { state: 'error', text: 'недоступен' });
  assert.deepEqual(diagnostics.get('token'), { state: 'error', text: 'не найден' });

  window.rutoken = {
    ready: Promise.resolve(),
    async isExtensionInstalled() {
      return true;
    },
    async isPluginInstalled() {
      return true;
    },
    loadPlugin: () => new Promise(() => {}),
  };
  const loadingPlugin = environment.initialize();
  await settle();
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  await assert.rejects(loadingPlugin, /Рутокен Плагин не ответил/);
  assert.deepEqual(diagnostics.get('extension'), { state: 'ready', text: 'доступно' });
  assert.deepEqual(diagnostics.get('plugin'), { state: 'error', text: 'не отвечает' });
});

test('signing state machine rejects duplicate and impossible workflow transitions', () => {
  const { PdfSigningState } = loadBrowserModule('signing-state.js');
  const changes = [];
  const workflow = PdfSigningState.createSigningStateMachine((change) =>
    changes.push({ ...change }),
  );

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
  const window = loadBrowserModule('preview-ui.js');
  const { PdfSigningPreview: preview } = window;
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
  const expiresAt = preview.validateResult(
    {
      signedPdfUrl: `./api/results/${token}`,
      downloadUrl: `./api/results/${token}`,
      resultExpiresAt: '2026-08-25T22:00:00.000Z',
    },
    Date.parse('2026-08-25T21:00:00.000Z'),
  );
  assert.equal(expiresAt.toISOString(), '2026-08-25T22:00:00.000Z');
  assert.throws(
    () =>
      preview.validateResult(
        {
          signedPdfUrl: 'https://example.test/result.pdf',
          downloadUrl: `./api/results/${token}`,
          resultExpiresAt: '2026-08-25T22:00:00.000Z',
        },
        0,
      ),
    /некорректную ссылку/,
  );
});

test('signed result expires in an open tab and a 404 download removes stale links', async () => {
  const window = loadBrowserModule('preview-ui.js');
  const elements = new Map();
  const node = () => ({
    textContent: '',
    src: '',
    href: '',
    listeners: {},
    attributes: {},
    classList: {
      values: new Set(),
      add(value) {
        this.values.add(value);
      },
      remove(value) {
        this.values.delete(value);
      },
      toggle(value, state) {
        if (state) this.values.add(value);
        else this.values.delete(value);
      },
    },
    addEventListener(name, callback) {
      this.listeners[name] = callback;
    },
    removeAttribute(name) {
      delete this[name];
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute(name) {
      return this.attributes[name];
    },
  });
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, node());
      return elements.get(id);
    },
    addEventListener() {},
    createElement() {
      return { click() {} };
    },
  };
  window.setTimeout = (callback) => {
    window.timer = callback;
    return 1;
  };
  window.clearTimeout = () => {};
  window.addEventListener = () => {};
  window.URL = {
    createObjectURL() {
      return 'blob:test';
    },
    revokeObjectURL() {},
  };
  window.fetch = async () => ({ status: 404 });
  let clock = Date.parse('2026-08-25T21:59:00Z');
  let expiredCount = 0;
  const ui = window.PdfSigningPreview.createPreviewUi(document, {
    now: () => clock,
    onExpired: () => {
      expiredCount += 1;
    },
  });
  const token = 'A'.repeat(43);
  const result = {
    signedPdfUrl: `./api/results/${token}`,
    downloadUrl: `./api/results/${token}`,
    resultExpiresAt: '2026-08-25T22:00:00.000Z',
    verification: {
      schemaVersion: 1,
      integrity: {
        status: 'valid',
        code: 'CMS_INTEGRITY_VALID',
        signerCertificateMatched: true,
        signaturesVerified: 1,
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
      qualified: { status: 'not_checked', code: 'QUALIFIED_STATUS_NOT_CHECKED' },
    },
  };
  ui.showSigned(result, clock);
  assert.equal(elements.get('downloadLink').href, result.downloadUrl);
  clock = Date.parse(result.resultExpiresAt);
  window.timer();
  assert.equal(expiredCount, 1);
  assert.equal(elements.get('downloadLink').href, undefined);
  assert.equal(elements.get('signedPdf').src, undefined);
  assert.match(elements.get('signedState').textContent, /истёк/);

  clock -= 60_000;
  ui.showSigned(result, clock);
  await elements.get('downloadLink').listeners.click({ preventDefault() {} });
  assert.equal(expiredCount, 2);
  assert.equal(elements.get('downloadLink').href, undefined);
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
    classList: {
      toggle(_className, value) {
        this.active = value;
      },
    },
    setAttribute(_name, value) {
      this.pressed = value;
    },
  }));
  const controller = placement.createPlacementController({
    document: { querySelectorAll: () => buttons },
    ensureShape: (value) => JSON.parse(JSON.stringify(value)),
    getConfig: () => config,
    getDefaultRule: (value) => value.placements.rules[0],
    getSelected: () => selected,
    setConfig: (value) => {
      config = value;
    },
    setSelected: (value) => {
      selected = value;
    },
  });

  assert.equal(controller.getPresetKey(config, { preferSelected: false }), 'left');
  assert.equal(controller.apply('right'), true);
  assert.equal(selected, 'right');
  assert.equal(config.appearance.width, 128);
  assert.deepEqual(
    { ...config.placements.rules[0].placement },
    {
      anchor: 'bottom-right',
      columns: 1,
      mode: 'anchored',
      offsetX: 24,
      offsetY: 24,
      stepX: 0,
      stepY: 0,
    },
  );
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
  const workflow = PdfSigningState.createSigningStateMachine(({ phase }) =>
    calls.push(`phase:${phase}`),
  );
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
    async confirm() {
      calls.push('confirm');
    },
    async ensureRutokenLogin() {
      calls.push('login');
    },
    async exportCertificate() {
      calls.push('certificate');
      return 'certificate-base64';
    },
    getContext: () => ({
      certificate: { deviceId: 'device', label: 'Test certificate' },
      async logoutRutoken() {
        calls.push('logout');
      },
      mode: 'rutoken',
      pdfBase64: 'pdf-base64',
      pdfName: 'document.pdf',
      pluginReady: true,
      providerLabel: 'Рутокен',
      stampConfig: { schemaVersion: 1 },
      stampPosition: 'right',
    }),
    async refreshRutoken() {
      calls.push('refresh');
    },
    async sha256() {
      calls.push('sha256');
      return 'document-digest';
    },
    showResult() {
      calls.push('show-result');
      return new Date('2026-08-25T22:00:00Z');
    },
    async signCryptoPro() {
      throw new Error('wrong provider');
    },
    async signRutoken() {
      calls.push('sign');
      return 'cms-base64';
    },
    status(message) {
      calls.push(`status:${message.split('…')[0]}`);
    },
    updateAction() {
      calls.push('update-action');
    },
    workflow,
  });

  await orchestrator.run();
  assert.deepEqual(
    calls.filter(
      (item) =>
        [
          'confirm',
          'certificate',
          'login',
          'sign',
          'logout',
          'show-result',
          'update-action',
        ].includes(item) || /^(prepare|complete):/.test(item),
    ),
    [
      'confirm',
      'certificate',
      'prepare:certificate-base64',
      'login',
      'sign',
      'logout',
      'complete:cms-base64',
      'show-result',
      'update-action',
    ],
  );
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

test('legacy issuer text is not presented as a signing reason', () => {
  const { PdfSigningStampConfig } = loadBrowserModule('stamp-config.js');
  const store = PdfSigningStampConfig.createStampConfigStore(
    {
      getItem: () => JSON.stringify({ signatureObject: { reason: 'Выдан: {signer.issuer}' } }),
    },
    'stamp',
  );
  const resolved = store.resolve({ signatureObject: { reason: '' } });
  assert.equal(resolved.signatureObject.reason, '');
});

test('dialog manager fails closed before touching DOM when no certificate exists', async () => {
  const { PdfSigningDialogs } = loadBrowserModule('dialogs.js');
  const manager = PdfSigningDialogs.createDialogManager(
    {},
    {
      formatCertificateDate: String,
      getCertificateKey: () => '',
    },
  );
  await assert.rejects(manager.openCertificate([]), /Не найдено доступных сертификатов/);
});
