const express = require('express');
const fs = require('fs');
const { validateStampConfig } = require('../http/validation');
const { sendSafeError } = require('../http/errors');
const { runIsolatedProcess } = require('../runtime/process-runner');

function createHealthRouter({
  metrics,
  operationQueue,
  results,
  resultsDir,
  sessions,
  stampConfiguration,
}) {
  const router = express.Router();
  let readinessValue = null;
  let readinessExpiresAt = 0;
  let readinessInFlight = null;

  async function computeReadiness() {
    const checks = {
      python: false,
      config: false,
      storage: false,
      workerLimits: false,
    };

    try {
      await runIsolatedProcess('python3', ['--version'], {
        timeoutMs: 2000,
        maxBuffer: 64 * 1024,
        limits: { enabled: false },
      });
      checks.python = true;
    } catch {}

    try {
      fs.accessSync('/usr/bin/prlimit', fs.constants.X_OK);
      checks.workerLimits = true;
    } catch {}

    try {
      const config = stampConfiguration.parse(stampConfiguration.read());
      const clientConfig = stampConfiguration.toClient(
        config,
        stampConfiguration.createCatalog(),
      );
      validateStampConfig(clientConfig);
      checks.config = true;
    } catch {}

    try {
      fs.accessSync(resultsDir, fs.constants.W_OK);
      checks.storage = true;
    } catch {}

    return {
      ok: Object.values(checks).every(Boolean),
      service: 'pdf-signing-demo',
      checks,
    };
  }

  async function getReadiness() {
    const now = Date.now();
    let base = readinessValue && now < readinessExpiresAt
      ? readinessValue
      : null;
    if (!base) {
      if (!readinessInFlight) {
        readinessInFlight = computeReadiness()
          .then((value) => {
            readinessValue = value;
            readinessExpiresAt = Date.now() + 5000;
            return value;
          })
          .finally(() => {
            readinessInFlight = null;
          });
      }
      base = await readinessInFlight;
    }
    const queueStats = operationQueue.stats();
    const workerQueue = queueStats.concurrency > 0
      && queueStats.queued <= queueStats.maxQueue;
    return {
      ...base,
      ok: base.ok && workerQueue,
      checks: {
        ...base.checks,
        workerQueue,
      },
      workers: queueStats,
      storage: {
        sessions: sessions.stats(),
        results: results.stats(),
      },
    };
  }

  router.get('/live', (_req, res) => {
    res.json({ ok: true, service: 'pdf-signing-demo' });
  });

  router.get('/ready', async (req, res) => {
    try {
      const readiness = await getReadiness();
      res.status(readiness.ok ? 200 : 503).json(readiness);
    } catch (error) {
      sendSafeError(req, res, error);
    }
  });

  router.get('/metrics', (_req, res) => {
    res.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render({
      operationQueue,
      results,
      sessions,
    }));
  });

  return router;
}

module.exports = { createHealthRouter };
