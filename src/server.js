const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { createPreparedPdf, embedCmsSignature } = require('./signing/pades');
const {
  CmsVerificationError,
  inspectCertificate,
  verifyCmsSignature,
  verifyEveryEmbeddedSignature,
} = require('./signing/cms-verifier');
const {
  HttpError,
  decodeCertificateBase64,
  decodeCmsBase64,
  decodePdfBase64,
  validateCompleteBody,
  validatePdfBuffer,
  validatePrepareBody,
  validateStampConfig,
  validateStampConfigForDocument,
} = require('./http/validation');
const {
  createCertificateError,
  createCmsIntegrityError,
  createOperationError,
  sendSafeError,
  shouldSkipResponse,
} = require('./http/errors');
const {
  FixedWindowRateLimiter,
  createRateLimitMiddleware,
} = require('./http/rate-limit');
const {
  OperationQueue,
  positiveInteger,
} = require('./runtime/operation-queue');
const {
  WorkerProcessError,
  runIsolatedProcess,
} = require('./runtime/process-runner');
const {
  StorageLimitError,
  createResultStore,
  createSessionStore,
} = require('./storage/lifecycle');
const {
  createStampConfiguration,
} = require('./stamp/configuration');

const app = express();
const PORT = process.env.PORT || 3010;
const BASE_PATH = process.env.BASE_PATH || '/';
const FORM_PDF_NAME = 'formular.pdf';
const CMS_NORMALIZER_PATH = path.join(__dirname, '..', 'scripts', 'normalize-cms.py');
const publicDir = path.join(__dirname, '..', 'public');
const projectRoot = path.join(__dirname, '..');
const assetsDir = path.join(publicDir, 'assets');
const localFontsDir = path.join(assetsDir, 'fonts');
const resultsDir = process.env.RESULTS_DIR
  ? path.resolve(process.env.RESULTS_DIR)
  : path.join(projectRoot, 'var', 'results');
const resultsRelativeToPublic = path.relative(publicDir, resultsDir);
if (
  resultsRelativeToPublic === ''
  || (
    !resultsRelativeToPublic.startsWith(`..${path.sep}`)
    && resultsRelativeToPublic !== '..'
    && !path.isAbsolute(resultsRelativeToPublic)
  )
) {
  throw new Error('RESULTS_DIR must be outside the public web root.');
}
const formPdfPath = path.join(assetsDir, FORM_PDF_NAME);
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "script-src 'self' chrome-extension:",
  "script-src-attr 'none'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self' blob: cpnp-js-call:",
  "object-src 'self'",
  "media-src 'none'",
  "manifest-src 'none'",
  "worker-src 'self' blob:",
].join('; ');
const PERMISSIONS_POLICY = [
  'camera=()',
  'display-capture=()',
  'geolocation=()',
  'microphone=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'hid=()',
].join(', ');
const stampConfigPath = process.env.STAMP_CONFIG_PATH
  ? path.resolve(process.env.STAMP_CONFIG_PATH)
  : path.join(__dirname, '..', 'config', 'stamp-config.json');
const sessionTtlMs = positiveInteger(
  process.env.SIGNING_SESSION_TTL_MS,
  10 * 60 * 1000,
  1000,
  60 * 60 * 1000,
);
const resultTtlMs = positiveInteger(
  process.env.SIGNING_RESULT_TTL_MS,
  15 * 60 * 1000,
  1000,
  60 * 60 * 1000,
);
const storageCleanupIntervalMs = positiveInteger(
  process.env.STORAGE_CLEANUP_INTERVAL_MS,
  30 * 1000,
  100,
  10 * 60 * 1000,
);
const sessions = createSessionStore({
  ttlMs: sessionTtlMs,
  tombstoneTtlMs: sessionTtlMs,
  maxSessions: positiveInteger(process.env.SIGNING_MAX_SESSIONS, 16, 1, 256),
  maxSessionsPerOwner: positiveInteger(
    process.env.SIGNING_MAX_SESSIONS_PER_IP,
    3,
    1,
    32,
  ),
  maxMemoryBytes: positiveInteger(
    process.env.SIGNING_SESSION_MEMORY_BYTES,
    64 * 1024 * 1024,
    1024 * 1024,
    1024 * 1024 * 1024,
  ),
});
const results = createResultStore({
  resultsDir,
  ttlMs: resultTtlMs,
  maxResults: positiveInteger(process.env.SIGNING_MAX_RESULTS, 32, 1, 256),
  maxDiskBytes: positiveInteger(
    process.env.SIGNING_RESULT_DISK_BYTES,
    128 * 1024 * 1024,
    1024 * 1024,
    2 * 1024 * 1024 * 1024,
  ),
});
const storageOwnerSecret = crypto.randomBytes(32);
const operationQueue = new OperationQueue({
  concurrency: positiveInteger(process.env.SIGNING_CONCURRENCY, 1, 1, 8),
  maxQueue: positiveInteger(process.env.SIGNING_MAX_QUEUE, 8, 1, 64),
  perKeyConcurrency: 1,
  queueTimeoutMs: positiveInteger(
    process.env.SIGNING_QUEUE_TIMEOUT_MS,
    5000,
    100,
    60000,
  ),
  operationTimeoutMs: positiveInteger(
    process.env.SIGNING_OPERATION_TIMEOUT_MS,
    60000,
    5000,
    300000,
  ),
});
const rateLimitWindowMs = positiveInteger(
  process.env.SIGNING_RATE_WINDOW_MS,
  60000,
  1000,
  60 * 60 * 1000,
);
const prepareRateLimiter = new FixedWindowRateLimiter({
  limit: positiveInteger(process.env.PREPARE_RATE_LIMIT, 12, 1, 10000),
  windowMs: rateLimitWindowMs,
});
const completeRateLimiter = new FixedWindowRateLimiter({
  limit: positiveInteger(process.env.COMPLETE_RATE_LIMIT, 30, 1, 10000),
  windowMs: rateLimitWindowMs,
});
let readinessValue = null;
let readinessExpiresAt = 0;
let readinessInFlight = null;
const stampConfiguration = createStampConfiguration({
  projectRoot,
  localFontsDir,
  stampConfigPath,
});

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use((_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, private, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': PERMISSIONS_POLICY,
  });
  next();
});
app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});
app.use((req, res, next) => {
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  req.once('aborted', abortRequest);
  res.once('close', () => {
    if (!res.writableEnded) abortRequest();
  });
  res.locals.requestSignal = controller.signal;
  next();
});
app.use((req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    return sendSafeError(
      req,
      res,
      new HttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Для этого запроса требуется Content-Type: application/json.',
      ),
    );
  }
  return next();
});
app.use(express.json({
  limit: '15mb',
  strict: true,
}));

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

async function normalizeCmsSignatureBase64(cmsSignatureBase64, { signal = null } = {}) {
  const payload = String(cmsSignatureBase64 || '').trim();
  if (!payload) {
    return payload;
  }

  try {
    const result = await runIsolatedProcess('python3', [CMS_NORMALIZER_PATH], {
      input: payload,
      signal,
      timeoutMs: 10000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trim() || payload;
  } catch (error) {
    if (
      error instanceof WorkerProcessError
      && ['WORKER_TIMEOUT', 'WORKER_ABORTED'].includes(error.code)
    ) {
      throw error;
    }
    throw new CmsVerificationError('CMS_NORMALIZATION_FAILED', error);
  }
}

function createVerificationResult(integrity, embeddedIntegrity) {
  if (
    integrity?.ok !== true
    || !Array.isArray(embeddedIntegrity)
    || embeddedIntegrity.length === 0
    || embeddedIntegrity.some((item) => item?.ok !== true)
  ) {
    throw new Error('Cannot report a successful verification result');
  }

  return {
    schemaVersion: 1,
    integrity: {
      status: 'valid',
      code: 'CMS_INTEGRITY_VALID',
      signaturesVerified: embeddedIntegrity.length,
      signerCertificateMatched: true,
      digestAlgorithm: integrity.digestAlgorithm,
      signatureAlgorithm: integrity.signatureAlgorithm,
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
      policy: null,
    },
  };
}

const router = express.Router();

function ownerKeyForRequest(req) {
  return crypto
    .createHmac('sha256', storageOwnerSecret)
    .update(req.ip)
    .digest('hex');
}

function resultHeaders(kind) {
  const headers = {
    'Cache-Control': 'no-store, private, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': `${kind === 'download' ? 'attachment' : 'inline'}; filename="signed-formular.pdf"`,
  };
  if (kind === 'preview') {
    headers['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'self'";
    headers['X-Frame-Options'] = 'SAMEORIGIN';
  }
  return headers;
}

router.get('/health/live', (_req, res) => {
  res.json({ ok: true, service: 'pdf-signing-demo' });
});

router.get('/health/ready', async (req, res) => {
  try {
    const readiness = await getReadiness();
    res.status(readiness.ok ? 200 : 503).json(readiness);
  } catch (error) {
    sendSafeError(req, res, error);
  }
});

router.get('/api/stamp-config', (_req, res) => {
  try {
    const raw = stampConfiguration.read();
    const config = stampConfiguration.parse(raw);
    const catalog = stampConfiguration.createCatalog();
    const clientConfig = stampConfiguration.toClient(config, catalog);
    validateStampConfig(clientConfig);
    res.json({ ok: true, config: clientConfig });
  } catch (error) {
    const serverError = error instanceof HttpError
      ? new Error(`Server stamp configuration validation failed: ${error.message}`)
      : error;
    sendSafeError(_req, res, serverError);
  }
});

router.get('/api/fonts', (_req, res) => {
  try {
    const catalog = stampConfiguration.createCatalog();
    res.json({ ok: true, fonts: stampConfiguration.listAvailable(catalog) });
  } catch (error) {
    sendSafeError(_req, res, error);
  }
});

router.get('/api/form', (req, res) => {
  try {
    const stats = fs.statSync(formPdfPath);
    res.json({
      ok: true,
      title: 'Формуляр на подпись',
      pdfUrl: `./assets/${FORM_PDF_NAME}`,
      size: stats.size,
    });
  } catch (error) {
    sendSafeError(req, res, error);
  }
});

router.head('/api/results/:token', (_req, res) => {
  res.set(resultHeaders('download')).status(405).end();
});

router.get('/api/results/:token', (req, res) => {
  const result = results.resolve(req.params.token);
  if (!result) {
    return sendSafeError(
      req,
      res,
      new HttpError(
        404,
        'RESULT_NOT_FOUND',
        'Результат не найден или истёк 15-минутный срок хранения.',
      ),
      'download',
    );
  }
  return res.sendFile(
    result.filePath,
    {
      acceptRanges: result.kind !== 'download',
      headers: resultHeaders(result.kind),
    },
    (error) => {
      if (!error) return;
      if (!res.headersSent) {
        sendSafeError(req, res, error, 'download');
      } else {
        res.destroy(error);
      }
    },
  );
});

const prepareRateLimitMiddleware = createRateLimitMiddleware({
  limiter: prepareRateLimiter,
  HttpError,
  scope: 'prepare',
});
const completeRateLimitMiddleware = createRateLimitMiddleware({
  limiter: completeRateLimiter,
  HttpError,
  scope: 'complete',
});
const prepareRateLimit = (req, res, next) => prepareRateLimitMiddleware(
  req,
  res,
  (error) => (error ? sendSafeError(req, res, error, 'prepare') : next()),
);
const completeRateLimit = (req, res, next) => completeRateLimitMiddleware(
  req,
  res,
  (error) => (error ? sendSafeError(req, res, error, 'complete') : next()),
);

router.post('/api/sign/prepare', prepareRateLimit, async (req, res) => {
  try {
    validatePrepareBody(req.body);
    const certificateDer = decodeCertificateBase64(
      req.body.signer.certificateBase64,
    );
    const sourceBuffer = req.body.pdfBase64
      ? decodePdfBase64(req.body.pdfBase64)
      : await fsp.readFile(formPdfPath);
    const result = await operationQueue.run(async (signal) => {
      let signer;
      try {
        signer = await inspectCertificate(certificateDer, { signal });
      } catch (error) {
        if (error instanceof CmsVerificationError) {
          throw createCertificateError(error);
        }
        throw error;
      }
      const pdfInfo = await validatePdfBuffer(sourceBuffer);
      validateStampConfigForDocument(req.body.stampConfig, pdfInfo.pages);
      const stampConfig = req.body.stampConfig
        ? stampConfiguration.toServer(
          req.body.stampConfig,
          stampConfiguration.createCatalog(),
        )
        : null;
      const requestedStampPosition = req.body.requestedStampPosition || null;
      const prepared = await createPreparedPdf({
        sourceBuffer,
        signer,
        stampConfig,
        requestedStampPosition,
        signal,
      });
      const sessionId = sessions.create(
        {
          ...prepared,
          expectedCertificateSha256: signer.certificateSha256,
        },
        ownerKeyForRequest(req),
      );
      return { prepared, sessionId };
    }, {
      key: `prepare:${req.ip}`,
      signal: res.locals.requestSignal,
    });
    const { prepared, sessionId } = result;
    res.json({
      ok: true,
      sessionId,
      contentToSignBase64: prepared.contentToSign.toString('base64'),
      byteRange: prepared.byteRange,
      placeholderLength: prepared.placeholderLength,
      note: 'PDF prepared for detached CMS signature (PAdES / ETSI.CAdES.detached).',
    });
  } catch (error) {
    if (shouldSkipResponse(res, error)) return;
    sendSafeError(req, res, createOperationError(error), 'prepare');
  }
});

router.post('/api/sign/complete', completeRateLimit, async (req, res) => {
  try {
    validateCompleteBody(req.body);
    const { sessionId, cmsSignatureBase64 } = req.body;
    const decodedCms = decodeCmsBase64(cmsSignatureBase64);
    const completed = await operationQueue.run(async (signal) => {
      const session = sessions.getPrepared(sessionId);
      if (!session) {
        throw new HttpError(
          404,
          'SESSION_NOT_FOUND',
          'Сессия подписания не найдена или истекла.',
        );
      }
      try {
        if (decodedCms.length * 2 > session.placeholderLength) {
          throw new HttpError(
            400,
            'CMS_TOO_LARGE',
            'Размер CMS-подписи превышает допустимый лимит.',
            {
              decodedBytes: decodedCms.length,
              placeholderLength: session.placeholderLength,
            },
          );
        }

        let normalizedCmsSignatureBase64;
        let normalizedCms;
        let integrity;
        try {
          normalizedCmsSignatureBase64 = await normalizeCmsSignatureBase64(
            decodedCms.toString('base64'),
            { signal },
          );
          normalizedCms = decodeCmsBase64(normalizedCmsSignatureBase64);
          if (normalizedCms.length * 2 > session.placeholderLength) {
            throw new CmsVerificationError('CMS_EXCEEDS_PLACEHOLDER');
          }
          integrity = await verifyCmsSignature({
            cmsDer: normalizedCms,
            content: session.contentToSign,
            expectedCertificateSha256: session.expectedCertificateSha256,
            signal,
          });
        } catch (error) {
          if (error instanceof CmsVerificationError || error instanceof HttpError) {
            throw createCmsIntegrityError(error);
          }
          throw error;
        }

        const signedPdf = embedCmsSignature({
          preparedPdf: session.preparedPdf,
          byteRange: session.byteRange,
          cmsBase64: normalizedCmsSignatureBase64,
          placeholderLength: session.placeholderLength,
        });

        let embeddedIntegrity;
        try {
          embeddedIntegrity = await verifyEveryEmbeddedSignature(signedPdf, {
            expectedLastCertificateSha256: session.expectedCertificateSha256,
            signal,
          });
        } catch (error) {
          if (error instanceof CmsVerificationError) {
            throw createCmsIntegrityError(error);
          }
          throw error;
        }

        const storedResult = await results.save(signedPdf);
        sessions.complete(sessionId);
        return {
          storedResult,
          integrity,
          embeddedIntegrity,
        };
      } catch (error) {
        const retryable = error instanceof StorageLimitError
          || (
            error instanceof HttpError
            && ['CMS_INTEGRITY_FAILED', 'CMS_TOO_LARGE'].includes(error.code)
          );
        if (!retryable) sessions.fail(sessionId);
        throw error;
      }
    }, {
      key: `complete:${sessionId}`,
      signal: res.locals.requestSignal,
    });
    return res.json({
      ok: true,
      signedPdfUrl: `./api/results/${completed.storedResult.previewToken}`,
      downloadUrl: `./api/results/${completed.storedResult.downloadToken}`,
      downloadName: 'signed-formular.pdf',
      resultExpiresAt: new Date(completed.storedResult.expiresAt).toISOString(),
      verification: createVerificationResult(
        completed.integrity,
        completed.embeddedIntegrity,
      ),
    });
  } catch (error) {
    if (shouldSkipResponse(res, error)) return;
    return sendSafeError(req, res, createOperationError(error), 'complete');
  }
});

router.use('/generated', (req, res) => {
  res
    .set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    .status(404)
    .json({
      ok: false,
      code: 'RESULT_NOT_FOUND',
      message: 'Публичное хранилище результатов отключено.',
      requestId: res.locals.requestId,
    });
});
router.use(express.static(publicDir, { extensions: ['html'] }));
app.use(BASE_PATH, router);
app.use((error, req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    return sendSafeError(
      req,
      res,
      new HttpError(
        413,
        'REQUEST_TOO_LARGE',
        'Размер запроса превышает допустимый лимит.',
      ),
    );
  }
  if (error instanceof SyntaxError && error?.type === 'entity.parse.failed') {
    return sendSafeError(
      req,
      res,
      new HttpError(
        400,
        'INVALID_JSON',
        'Передан некорректный JSON.',
      ),
    );
  }
  return sendSafeError(req, res, error);
});

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

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`pdf-signing-demo listening on http://127.0.0.1:${PORT}${BASE_PATH}`);
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
