const express = require('express');
const path = require('path');
const fsp = require('fs/promises');
const { createPreparedPdf, embedCmsSignature } = require('../signing/pades');
const {
  CmsVerificationError,
  inspectCertificate,
  verifyCmsSignature,
  verifyEveryEmbeddedSignature,
} = require('../signing/cms-verifier');
const {
  HttpError,
  decodeCertificateBase64,
  decodeCmsBase64,
  decodePdfBase64,
  validateCompleteBody,
  validatePdfBuffer,
  validatePrepareBody,
  validateStampConfigForDocument,
} = require('../http/validation');
const {
  createCertificateError,
  createCmsIntegrityError,
  createOperationError,
  sendSafeError,
  shouldSkipResponse,
} = require('../http/errors');
const {
  createRateLimitMiddleware,
} = require('../http/rate-limit');
const {
  WorkerProcessError,
  runIsolatedProcess,
} = require('../runtime/process-runner');
const {
  StorageLimitError,
} = require('../storage/lifecycle');

const CMS_NORMALIZER_PATH = path.join(
  __dirname,
  '..',
  '..',
  'scripts',
  'normalize-cms.py',
);

async function normalizeCmsSignatureBase64(cmsSignatureBase64, {
  signal = null,
} = {}) {
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

function createSigningRouter({
  completeRateLimiter,
  formPdfPath,
  metrics,
  operationQueue,
  ownerKeyForRequest,
  prepareRateLimiter,
  results,
  sessions,
  stampConfiguration,
}) {
  const router = express.Router();
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

  function observeRequest(operation) {
    return (_req, res, next) => {
      const startedAt = process.hrtime.bigint();
      let observed = false;
      const observe = (status = res.statusCode, code = res.locals.errorCode) => {
        if (observed) return;
        observed = true;
        const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        metrics.observeRequest(
          operation,
          durationSeconds,
          status,
          code,
        );
      };
      res.once('finish', observe);
      res.once('close', () => observe(
        res.writableEnded ? res.statusCode : 499,
        res.writableEnded ? res.locals.errorCode : 'REQUEST_ABORTED',
      ));
      next();
    };
  }

  router.post('/prepare', observeRequest('prepare'), prepareRateLimit, async (req, res) => {
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
        metrics.observePdf(sourceBuffer.length, pdfInfo.pages);
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

  router.post('/complete', observeRequest('complete'), completeRateLimit, async (req, res) => {
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

  return router;
}

module.exports = {
  createSigningRouter,
  createVerificationResult,
};
