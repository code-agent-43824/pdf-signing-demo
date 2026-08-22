const assert = require('node:assert/strict');
const { test } = require('node:test');
const { startServer } = require('../src/bootstrap');
const { resultHeaders } = require('../src/routes/results');

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
