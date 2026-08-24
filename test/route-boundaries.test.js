const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createApplication } = require('../src/application');
const { startServer } = require('../src/bootstrap');
const { resultHeaders } = require('../src/routes/results');

function applicationDependencies(overrides = {}) {
  const statsStore = { stats: () => ({}) };
  return {
    basePath: '/pdf-signing/',
    completeRateLimiter: {},
    formPdfName: 'formular.pdf',
    formPdfPath: '/unused/formular.pdf',
    operationQueue: { stats: () => ({ concurrency: 1, queued: 0, maxQueue: 8 }) },
    ownerKeyForRequest: () => 'owner',
    prepareRateLimiter: {},
    publicDir: '/unused/public',
    results: { ...statsStore, resolve: () => null },
    resultsDir: '/unused/results',
    sessions: statsStore,
    stampConfiguration: {},
    ...overrides,
  };
}

test('result routes keep preview and download security contracts distinct', () => {
  const preview = resultHeaders('preview');
  const download = resultHeaders('download');

  assert.equal(preview['Content-Disposition'], 'inline; filename="signed-formular.pdf"');
  assert.equal(preview['X-Frame-Options'], 'SAMEORIGIN');
  assert.equal(
    preview['Content-Security-Policy'],
    "default-src 'none'; frame-ancestors 'self'",
  );
  assert.equal(download['Content-Disposition'], 'attachment; filename="signed-formular.pdf"');
  assert.equal(Object.hasOwn(download, 'X-Frame-Options'), false);
  assert.equal(Object.hasOwn(download, 'Content-Security-Policy'), false);
  assert.equal(download['Cache-Control'], 'no-store, private, max-age=0');
});

test('bootstrap binds loopback and applies bounded HTTP timeouts', () => {
  const calls = [];
  const server = {
    setTimeout(value) {
      calls.push(['setTimeout', value]);
    },
  };
  const app = {
    listen(...args) {
      calls.push(['listen', ...args.slice(0, 2)]);
      return server;
    },
  };
  const noopStore = { cleanup() {} };
  const noopResults = { cleanup: async () => {} };

  const started = startServer({
    app,
    basePath: '/pdf-signing/',
    completeRateLimiter: noopStore,
    port: 3010,
    prepareRateLimiter: noopStore,
    results: noopResults,
    sessions: noopStore,
    storageCleanupIntervalMs: 60_000,
  });

  assert.equal(started, server);
  assert.deepEqual(calls[0], ['listen', 3010, '127.0.0.1']);
  assert.equal(server.headersTimeout, 10_000);
  assert.equal(server.requestTimeout, 70_000);
  assert.equal(server.keepAliveTimeout, 5_000);
  assert.deepEqual(calls[1], ['setTimeout', 70_000]);
});

test('application factory remains listener-free and keeps Express hardening', () => {
  const app = createApplication(applicationDependencies());

  assert.equal(typeof app.listen, 'function');
  assert.equal(app.enabled('x-powered-by'), false);
  assert.equal(typeof app.get('trust proxy fn'), 'function');
});

test('public routes preserve form metadata and close legacy generated storage', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-routes-'));
  const publicDir = path.join(tempDir, 'public');
  const formPdfPath = path.join(publicDir, 'assets', 'formular.pdf');
  fs.mkdirSync(path.dirname(formPdfPath), { recursive: true });
  fs.writeFileSync(formPdfPath, '%PDF-form');
  const app = createApplication(applicationDependencies({
    formPdfPath,
    publicDir,
  }));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const formResponse = await fetch(`${origin}/pdf-signing/api/form`);
    assert.equal(formResponse.status, 200);
    assert.deepEqual(await formResponse.json(), {
      ok: true,
      title: 'Формуляр на подпись',
      pdfUrl: './assets/formular.pdf',
      size: 9,
    });

    const generatedResponse = await fetch(
      `${origin}/pdf-signing/generated/legacy.pdf`,
    );
    assert.equal(generatedResponse.status, 404);
    assert.match(generatedResponse.headers.get('cache-control'), /no-store/);
    const generated = await generatedResponse.json();
    assert.equal(generated.code, 'RESULT_NOT_FOUND');
    assert.equal(generated.requestId, generatedResponse.headers.get('x-request-id'));

    const outsideResponse = await fetch(`${origin}/health/live`);
    assert.equal(outsideResponse.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
