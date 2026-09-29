const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SPIKE_DIR = path.join(PROJECT_ROOT, 'spikes', '001-cades-bes-provider-capability');
const PUBLIC_SPIKE_DIR = path.join(PROJECT_ROOT, 'public', 'spikes');
const FIXTURE = Buffer.from(
  fs.readFileSync(path.join(SPIKE_DIR, 'fixture.hex'), 'ascii').trim(),
  'hex',
);
const ALL_RESULTS = [
  'cryptopro:attached',
  'cryptopro:detached',
  'rutoken:attached',
  'rutoken:detached',
];

let tempDir;
let certPath;
let keyPath;
let fileCounter = 0;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cades-bes-spike-'));
  certPath = path.join(tempDir, 'cert.pem');
  keyPath = path.join(tempDir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '1',
      '-subj',
      '/CN=CAdES BES spike test',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: 'ignore' },
  );
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function nextPath(name) {
  fileCounter += 1;
  return path.join(tempDir, `${fileCounter}-${name}`);
}

function loadSpike(name, window = {}) {
  Object.assign(window, { btoa, crypto: crypto.webcrypto });
  const context = vm.createContext({ window });
  vm.runInContext(fs.readFileSync(path.join(PUBLIC_SPIKE_DIR, name), 'utf8'), context);
  return window;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// A real CMS over exactly the bytes a provider received, wrapped the way the
// plugins return base64.
function signLikeProvider(contentBase64, detached) {
  const content = nextPath('content.bin');
  const output = nextPath('cms.der');
  fs.writeFileSync(content, Buffer.from(contentBase64, 'base64'));
  execFileSync('python3', [
    path.join(PROJECT_ROOT, 'test', 'create_cms.py'),
    content,
    certPath,
    keyPath,
    output,
    ...(detached ? [] : ['--attached']),
  ]);
  return fs.readFileSync(output).toString('base64').replace(/.{64}/g, '$&\r\n');
}

function createProviders(calls, { failRutokenSign = null } = {}) {
  const cryptoPro = {
    CADESCOM_BASE64_TO_BINARY: 1,
    CADESCOM_CADES_BES: 1,
    async CreateObjectAsync(name) {
      if (name === 'CAdESCOM.CPSigner') {
        return {
          async propset_Certificate(value) {
            calls.push(['cp-certificate', value]);
          },
        };
      }
      if (name !== 'CAdESCOM.CadesSignedData') throw new Error(name);
      const signed = { encoding: null, content: null };
      return {
        async propset_ContentEncoding(value) {
          signed.encoding = value;
        },
        async propset_Content(value) {
          // CryptoPro decodes base64 content only when the encoding came first.
          assert.equal(signed.encoding, cryptoPro.CADESCOM_BASE64_TO_BINARY);
          signed.content = value;
        },
        async SignCades(_signer, type, detached) {
          calls.push(['cp-sign', type, detached]);
          return signLikeProvider(signed.content, detached);
        },
      };
    },
  };
  const rutoken = {
    DATA_FORMAT_BASE64: 7,
    HASH_TYPE_SHA256: 3,
    async sign(deviceId, certId, content, format, options) {
      calls.push(['rt-sign', deviceId, certId, format, { ...options }]);
      if (failRutokenSign?.(options)) throw new Error('rutoken sign failed');
      return signLikeProvider(content, options.detached);
    },
    async logout(deviceId) {
      calls.push(['rt-logout', deviceId]);
    },
  };
  return { cryptoPro, rutoken };
}

function analyze(...bundles) {
  const paths = bundles.map((bundle) => {
    const file = nextPath('bundle.json');
    fs.writeFileSync(file, JSON.stringify(bundle));
    return file;
  });
  return spawnSync('python3', [path.join(SPIKE_DIR, 'analyze.py'), ...paths], {
    encoding: 'utf8',
  });
}

test('CAdES-BES spike signs the exact fixture with both plugins and the analyzer validates it', async () => {
  const calls = [];
  const { cryptoPro, rutoken } = createProviders(calls);
  const window = loadSpike('cades-bes-runner.js');
  const context = { mode: 'cryptopro', client: cryptoPro, certificate: { certificate: 'cp-cert' } };
  const runner = window.PdfSigningCadesBesSpike.createRunner({
    ensureRutokenLogin: async (deviceId) => calls.push(['rt-login', deviceId]),
    getContext: () => context,
    rutokenAlgorithm: () => 'rsa',
    withBusy: async (message, task) => {
      calls.push(['busy', message]);
      return task();
    },
  });
  assert.deepEqual(plain(runner.status()), { completed: [], total: 4 });

  assert.deepEqual(plain(await runner.run()).completed, ALL_RESULTS.slice(0, 2));
  Object.assign(context, {
    mode: 'rutoken',
    client: rutoken,
    certificate: { deviceId: 9, certId: 'rt-cert' },
  });
  assert.deepEqual(plain(await runner.run()).completed, ALL_RESULTS);

  const bundle = plain(await runner.exportBundle());
  assert.equal(bundle.version, 1);
  assert.equal(bundle.fixtureSha256, crypto.createHash('sha256').update(FIXTURE).digest('hex'));
  assert.deepEqual(
    bundle.results.map(({ provider, packaging }) => `${provider}:${packaging}`),
    ALL_RESULTS,
  );
  assert.ok(bundle.results.every(({ cmsBase64 }) => /^[A-Za-z0-9+/]+=*$/.test(cmsBase64)));

  assert.deepEqual(
    calls.filter(([name]) => name === 'cp-sign').map((call) => call.slice(1)),
    [
      [cryptoPro.CADESCOM_CADES_BES, true],
      [cryptoPro.CADESCOM_CADES_BES, false],
    ],
  );
  assert.deepEqual(
    calls.filter(([name]) => name.startsWith('rt-')).map(([name]) => name),
    ['rt-login', 'rt-sign', 'rt-sign', 'rt-logout'],
  );
  const rutokenOptions = { addUserCertificate: true, addSignTime: true, addEssCert: true };
  assert.deepEqual(
    calls.filter(([name]) => name === 'rt-sign').map((call) => call.slice(1)),
    [
      [9, 'rt-cert', 7, { detached: true, ...rutokenOptions, rsaHashAlgorithm: 3 }],
      [9, 'rt-cert', 7, { detached: false, ...rutokenOptions, rsaHashAlgorithm: 3 }],
    ],
  );
  assert.deepEqual(
    calls.filter(([name]) => name === 'busy').map(([, message]) => message),
    [
      'CryptoPro подписывает тестовые данные…',
      'CryptoPro подписывает тестовые данные…',
      'Рутокен подписывает тестовые данные…',
      'Рутокен подписывает тестовые данные…',
    ],
  );

  const analyzed = analyze(bundle);
  assert.equal(analyzed.status, 0, analyzed.stderr);
  const report = JSON.parse(analyzed.stdout);
  assert.equal(report.verdict, 'VALIDATED');
  assert.equal(report.fixtureBytes, FIXTURE.length);
  assert.deepEqual(
    report.results.map((item) => [
      `${item.provider}:${item.packaging}`,
      item.embeddedContentPresent,
      item.cryptographicIntegrity,
      item.signingCertificateV2,
    ]),
    ALL_RESULTS.map((key) => [key, key.endsWith(':attached'), 'valid', true]),
  );

  // Plugins in two browsers give two files; together they are one result.
  const only = (provider) => ({
    ...bundle,
    results: bundle.results.filter((item) => item.provider === provider),
  });
  const split = analyze(only('cryptopro'), only('rutoken'));
  assert.equal(split.status, 0, split.stderr);
  assert.equal(JSON.parse(split.stdout).verdict, 'VALIDATED');
  assert.match(analyze(only('cryptopro')).stderr, /all four unique provider\/packaging/);
  assert.match(analyze(bundle, only('rutoken')).stderr, /all four unique provider\/packaging/);
  assert.match(
    analyze(only('cryptopro'), { ...only('rutoken'), fixtureSha256: '0'.repeat(64) }).stderr,
    /fixture identity mismatch/,
  );
  const swapped = plain(bundle);
  const cryptoProResults = swapped.results.filter((item) => item.provider === 'cryptopro');
  [cryptoProResults[0].cmsBase64, cryptoProResults[1].cmsBase64] = [
    cryptoProResults[1].cmsBase64,
    cryptoProResults[0].cmsBase64,
  ];
  assert.match(analyze(swapped).stderr, /packaging does not match/);
});

test('CAdES-BES spike fails closed before a provider call and always logs Rutoken out', async () => {
  const window = loadSpike('cades-bes-runner.js');
  const calls = [];
  const { cryptoPro, rutoken } = createProviders(calls, {
    failRutokenSign: (options) => options.detached === false,
  });
  const context = { mode: 'cryptopro', client: cryptoPro, certificate: null };
  let algorithm = 'gost2012-256';
  let login = async (deviceId) => calls.push(['rt-login', deviceId]);
  const runner = window.PdfSigningCadesBesSpike.createRunner({
    ensureRutokenLogin: (deviceId) => login(deviceId),
    getContext: () => context,
    rutokenAlgorithm: () => {
      if (!algorithm) throw new Error('unsupported key');
      return algorithm;
    },
  });

  await assert.rejects(runner.run(), /Сначала выберите сертификат/);
  context.certificate = { certificate: 'cp-cert' };
  context.client = null;
  await assert.rejects(runner.run(), /Плагин не готов/);
  context.mode = 'other';
  await assert.rejects(runner.run(), /Неизвестный криптоплагин/);
  assert.deepEqual(calls, []);

  Object.assign(context, {
    mode: 'rutoken',
    client: rutoken,
    certificate: { deviceId: 4, certId: 'rt-cert' },
  });
  algorithm = null;
  await assert.rejects(runner.run(), /unsupported key/);
  algorithm = 'gost2012-256';
  login = async () => {
    throw Object.assign(new Error('cancelled'), { code: 'USER_CANCELLED' });
  };
  await assert.rejects(runner.run(), (error) => error.code === 'USER_CANCELLED');
  assert.deepEqual(calls, []);

  login = async (deviceId) => calls.push(['rt-login', deviceId]);
  await assert.rejects(runner.run(), /rutoken sign failed/);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['rt-login', 'rt-sign', 'rt-sign', 'rt-logout'],
  );
  assert.equal(calls[1][4].rsaHashAlgorithm, undefined);
  assert.deepEqual(plain(runner.status()).completed, ['rutoken:detached']);

  calls.length = 0;
  algorithm = 'rsa';
  delete rutoken.HASH_TYPE_SHA256;
  await assert.rejects(runner.run(), /RSA\/SHA-256/);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['rt-login', 'rt-logout'],
  );
});

function createFakeDocument() {
  const nodes = [];
  const createElement = (tag) => {
    const node = {
      tag,
      attributes: {},
      children: [],
      clicks: 0,
      disabled: false,
      listeners: {},
      textContent: '',
      addEventListener(name, callback) {
        this.listeners[name] = callback;
      },
      after(sibling) {
        this.nextSibling = sibling;
      },
      append(...children) {
        this.children.push(...children);
      },
      click() {
        this.clicks += 1;
      },
      remove() {
        this.removed = true;
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
    };
    nodes.push(node);
    return node;
  };
  return {
    body: createElement('body'),
    createElement,
    byId: (id) => nodes.find((node) => node.id === id),
    byTag: (tag) => nodes.filter((node) => node.tag === tag),
  };
}

test('CAdES-BES spike panel runs the active plugin and saves the bundle as a file', async () => {
  const blobs = [];
  const revoked = [];
  const window = loadSpike('cades-bes-panel.js', {
    Blob: class {
      constructor(parts, options) {
        this.text = parts.join('');
        this.type = options.type;
        blobs.push(this);
      }
    },
    URL: {
      createObjectURL: (blob) => `blob:${blobs.indexOf(blob)}`,
      revokeObjectURL: (url) => revoked.push(url),
    },
  });
  const document = createFakeDocument();
  const anchor = document.createElement('section');
  let completed = [];
  let failure = null;
  const runner = {
    status: () => ({ completed, total: 4 }),
    async run() {
      if (failure) throw failure;
      completed = ['cryptopro:attached', 'cryptopro:detached'];
    },
    async exportBundle() {
      return {
        version: 1,
        fixtureSha256: 'f'.repeat(64),
        results: completed.map((key) => ({ key })),
      };
    },
  };
  const section = window.PdfSigningCadesBesSpikePanel.mount(document, {
    anchor,
    describeError: (error) => `подробности: ${error.message}`,
    getProviderLabel: () => 'CryptoPro',
    runner,
  });

  assert.equal(anchor.nextSibling, section);
  assert.equal(section.attributes['aria-labelledby'], 'cadesBesSpikeTitle');
  assert.equal(document.byId('cadesBesSpikeTitle').textContent, 'Проверка CAdES-BES');
  const progress = document.byId('cadesBesSpikeProgress');
  const message = document.byId('cadesBesSpikeMessage');
  const runButton = document.byId('cadesBesSpikeRun');
  const downloadButton = document.byId('cadesBesSpikeDownload');
  assert.equal(progress.textContent, 'Готово 0 из 4: CryptoPro — нет, Рутокен — нет.');
  assert.equal(downloadButton.disabled, true);

  await runButton.listeners.click();
  assert.equal(progress.textContent, 'Готово 2 из 4: CryptoPro — готово, Рутокен — нет.');
  assert.equal(message.textContent, 'CryptoPro: тестовые данные подписаны.');
  assert.equal(downloadButton.disabled, false);
  assert.equal(runButton.disabled, false);

  failure = new Error('нет ключа');
  await runButton.listeners.click();
  assert.equal(message.textContent, 'CryptoPro: ошибка — подробности: нет ключа');
  failure = Object.assign(new Error('cancelled'), { code: 'USER_CANCELLED' });
  await runButton.listeners.click();
  assert.equal(message.textContent, 'CryptoPro: отменено.');
  assert.equal(runButton.disabled, false);

  await downloadButton.listeners.click();
  await downloadButton.listeners.click();
  assert.equal(blobs.length, 2);
  assert.equal(blobs[1].type, 'application/json');
  assert.deepEqual(JSON.parse(blobs[1].text), await runner.exportBundle());
  assert.deepEqual(revoked, ['blob:0']);
  const links = document.byTag('a');
  assert.equal(links.length, 2);
  assert.deepEqual(
    links.map(({ href, download, clicks, removed }) => [href, download, clicks, removed]),
    [
      ['blob:0', 'cades-bes-spike.json', 1, true],
      ['blob:1', 'cades-bes-spike.json', 1, true],
    ],
  );
  assert.deepEqual(document.body.children, links);
  assert.match(message.textContent, /cades-bes-spike\.json сохранён: подписей 2 из 4/);
});

test('CAdES-BES spike loads only on its explicit page flag', () => {
  const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(html, /spikes\//);
  const starter =
    app.match(/async function startCadesBesSpikeOnRequest\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  const flag = starter.indexOf("get('spike') !== 'cades-bes') return;");
  const load = starter.indexOf('await loadSpikeScript(src)');
  assert.ok(flag !== -1 && load !== -1 && flag < load);
  assert.match(
    app,
    /const CADES_BES_SPIKE_SCRIPTS = \['\.\/spikes\/cades-bes-runner\.js', '\.\/spikes\/cades-bes-panel\.js'\];/,
  );
});
