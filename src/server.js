const crypto = require('crypto');
const path = require('path');
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
const {
  createStampConfiguration,
} = require('./stamp/configuration');
const { createApplication } = require('./application');
const { startServer } = require('./bootstrap');

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

function ownerKeyForRequest(req) {
  return crypto
    .createHmac('sha256', storageOwnerSecret)
    .update(req.ip)
    .digest('hex');
}

const app = createApplication({
  basePath: BASE_PATH,
  completeRateLimiter,
  formPdfName: FORM_PDF_NAME,
  formPdfPath,
  operationQueue,
  ownerKeyForRequest,
  prepareRateLimiter,
  publicDir,
  results,
  resultsDir,
  sessions,
  stampConfiguration,
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
