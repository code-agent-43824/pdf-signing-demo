const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const MODULE_DIR = path.resolve(__dirname, '..', 'public', 'modules');

function loadBrowserModule(name) {
  const window = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(MODULE_DIR, name), 'utf8'),
    { window },
  );
  return window;
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
