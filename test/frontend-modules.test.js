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
