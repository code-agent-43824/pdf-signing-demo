const crypto = require('crypto');
const express = require('express');
const { HttpError } = require('./http/validation');
const { sendSafeError } = require('./http/errors');
const { createHealthRouter } = require('./routes/health');
const { createPublicRouter } = require('./routes/public');
const { createResultsRouter } = require('./routes/results');
const { createSigningRouter } = require('./routes/signing');

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

function createApplication({
  basePath,
  completeRateLimiter,
  formPdfName,
  formPdfPath,
  operationQueue,
  ownerKeyForRequest,
  prepareRateLimiter,
  publicDir,
  results,
  resultsDir,
  sessions,
  stampConfiguration,
}) {
  const app = express();

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
  router.use('/health', createHealthRouter({
    operationQueue,
    results,
    resultsDir,
    sessions,
    stampConfiguration,
  }));
  router.use(createPublicRouter({
    formPdfName,
    formPdfPath,
    stampConfiguration,
  }));
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
  router.use(express.static(publicDir, { extensions: ['html'] }));
  app.use(basePath, router);
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

  return app;
}

module.exports = { createApplication };
