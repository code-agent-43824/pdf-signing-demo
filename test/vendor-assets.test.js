const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(PROJECT_ROOT, 'public', 'vendor');

test('runtime crypto scripts are local, checksummed and SRI-pinned', () => {
  const manifest = fs.readFileSync(
    path.join(VENDOR_DIR, 'SHA256SUMS'),
    'utf8',
  );
  const app = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'app.js'),
    'utf8',
  );
  const entries = manifest
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.match(/^([0-9a-f]{64}) {2}([A-Za-z0-9_.-]+)$/);
      assert.ok(match, `invalid checksum line: ${line}`);
      return { expected: match[1], name: match[2] };
    });

  assert.deepEqual(
    entries.map(({ name }) => name).sort(),
    ['cadesplugin_api.js', 'rutoken-plugin.min.js'],
  );
  for (const { expected, name } of entries) {
    const content = fs.readFileSync(path.join(VENDOR_DIR, name));
    assert.equal(
      crypto.createHash('sha256').update(content).digest('hex'),
      expected,
    );
    const sri = `sha384-${crypto
      .createHash('sha384')
      .update(content)
      .digest('base64')}`;
    assert.match(app, new RegExp(sri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const runtimeConfig = app.match(
    /const CRYPTO_SCRIPTS = \{[\s\S]*?\n\};/,
  )?.[0] || '';
  assert.match(runtimeConfig, /cryptopro:[\s\S]*\.\/vendor\/cadesplugin_api\.js/);
  assert.match(runtimeConfig, /rutoken:[\s\S]*\.\/vendor\/rutoken-plugin\.min\.js/);
  assert.doesNotMatch(runtimeConfig, /https?:\/\//);
  assert.match(app, /script\.integrity = asset\.integrity/);
  assert.match(app, /script\.crossOrigin = 'anonymous'/);
});

// Runs the pinned CryptoPro loader as Firefox without the CryptoPro extension
// and returns its load timer and everything it appended to <body>.
function loadCryptoProLoaderInFirefox() {
  const timers = [];
  const appended = [];
  const byId = new Map();
  const createElement = () => ({
    style: {},
    innerHTML: '',
    addEventListener() {},
    getElementsByTagName: () => [],
  });
  const body = {
    appendChild(element) {
      appended.push(element);
      byId.set(element.id, element);
    },
  };
  const sandbox = {
    Promise,
    navigator: {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:156.0) Gecko/20100101 Firefox/156.0',
      mimeTypes: {},
    },
    document: {
      hidden: false,
      readyState: 'complete',
      createElement,
      getElementsByTagName: () => [body],
      getElementById: (id) => byId.get(id) || createElement(),
      addEventListener() {},
    },
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    postMessage() {},
    addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.runInContext(
    fs.readFileSync(path.join(VENDOR_DIR, 'cadesplugin_api.js'), 'utf8'),
    vm.createContext(sandbox),
  );
  return { appended, sandbox, timers };
}

test('CryptoPro loader reads the install-prompt flag when its load timer fires', async () => {
  const silenced = loadCryptoProLoaderInFirefox();
  assert.equal(silenced.timers.length, 1);
  silenced.sandbox.cadesplugin_skip_extension_install = true;
  silenced.timers[0]();
  assert.deepEqual(silenced.appended, []);
  await assert.rejects(silenced.sandbox.cadesplugin, /Истекло время ожидания загрузки плагина/);

  const prompting = loadCryptoProLoaderInFirefox();
  prompting.timers[0]();
  assert.deepEqual(prompting.appended.map(({ id }) => id), ['cadesplugin_ovr']);
  await assert.rejects(prompting.sandbox.cadesplugin, /Истекло время ожидания загрузки плагина/);
});

test('HTML has no inline script or event-handler escape hatch', () => {
  const html = fs.readFileSync(
    path.join(PROJECT_ROOT, 'public', 'index.html'),
    'utf8',
  );
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    assert.match(script[1], /\bsrc=/i);
    assert.equal(script[2].trim(), '');
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});
