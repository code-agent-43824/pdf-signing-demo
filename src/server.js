const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const {
  HttpError,
  validateStampConfig,
} = require('./http/validation');
const {
  sendSafeError,
} = require('./http/errors');
const {
  FixedWindowRateLimiter,
} = require('./http/rate-limit');
const {
  OperationQueue,
  positiveInteger,
} = require('./runtime/operation-queue');
const {
  createResultStore,
  createSessionStore,
} = require('./storage/lifecycle');
const { createSigningRouter } = require('./routes/signing');
const { createHealthRouter } = require('./routes/health');
const { createResultsRouter } = require('./routes/results');
const {
  createStampConfiguration,
} = require('./stamp/configuration');
const { startServer } = require('./bootstrap');

const app = express();
const PORT = process.env.PORT || 3010;
const BASE_PATH = process.env.BASE_PATH || '/';
const FORM_PDF_NAME = 'formular.pdf';
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

const router = express.Router();

function ownerKeyForRequest(req) {
  return crypto
    .createHmac('sha256', storageOwnerSecret)
    .update(req.ip)
    .digest('hex');
}

router.use('/health', createHealthRouter({
  operationQueue,
  results,
  resultsDir,
  sessions,
  stampConfiguration,
}));

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

router.use('/api/results', createResultsRouter({ results }));

router.use('/api/sign', createSigningRouter({
  completeRateLimiter,
  formPdfPath,
  operationQueue,
  ownerKeyForRequest,
  prepareRateLimiter,
  results,
  sessions,
  stampConfiguration,
}));

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

startServer({
  app,
  basePath: BASE_PATH,
  completeRateLimiter,
  port: PORT,
  prepareRateLimiter,
  results,
  sessions,
  storageCleanupIntervalMs,
});
