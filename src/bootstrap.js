const { positiveInteger } = require('./runtime/operation-queue');

function startServer({
  app,
  basePath,
  completeRateLimiter,
  port,
  prepareRateLimiter,
  results,
  sessions,
  storageCleanupIntervalMs,
}) {
  setInterval(() => {
    sessions.cleanup();
    void results.cleanup().catch((error) => {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'result_cleanup_failed',
        error: {
          name: error?.name || 'Error',
          message: String(error?.message || 'Unknown error').slice(0, 1000),
        },
      }));
    });
    prepareRateLimiter.cleanup();
    completeRateLimiter.cleanup();
  }, storageCleanupIntervalMs).unref();

  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`pdf-signing-demo listening on http://127.0.0.1:${port}${basePath}`);
  });
  server.headersTimeout = positiveInteger(
    process.env.HTTP_HEADERS_TIMEOUT_MS,
    10000,
    1000,
    60000,
  );
  server.requestTimeout = positiveInteger(
    process.env.HTTP_REQUEST_TIMEOUT_MS,
    70000,
    5000,
    300000,
  );
  server.keepAliveTimeout = 5000;
  server.setTimeout(server.requestTimeout);
  return server;
}

module.exports = { startServer };
