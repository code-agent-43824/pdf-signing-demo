const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { createPreparedPdf, embedCmsSignature, createSessionStore } = require('./signing/pades');
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

const app = express();
const PORT = process.env.PORT || 3010;
const BASE_PATH = process.env.BASE_PATH || '/';
const FORM_PDF_NAME = 'formular.pdf';
const CMS_NORMALIZER_PATH = path.join(__dirname, '..', 'scripts', 'normalize-cms.py');
const publicDir = path.join(__dirname, '..', 'public');
const projectRoot = path.join(__dirname, '..');
const assetsDir = path.join(publicDir, 'assets');
const localFontsDir = path.join(assetsDir, 'fonts');
const generatedDir = process.env.GENERATED_DIR
  ? path.resolve(process.env.GENERATED_DIR)
  : path.join(publicDir, 'generated');
const formPdfPath = path.join(assetsDir, FORM_PDF_NAME);
const stampConfigPath = process.env.STAMP_CONFIG_PATH
  ? path.resolve(process.env.STAMP_CONFIG_PATH)
  : path.join(__dirname, '..', 'config', 'stamp-config.json');
const sessions = createSessionStore({ generatedDir });
const FONT_DIRS = [
  localFontsDir,
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  path.join(process.env.HOME || '', '.fonts'),
  path.join(process.env.HOME || '', '.local', 'share', 'fonts'),
].filter(Boolean);

fs.mkdirSync(generatedDir, { recursive: true });
app.disable('x-powered-by');
app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);
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

function readStampConfig() {
  return fs.readFileSync(stampConfigPath, 'utf8');
}

function parseStampConfig(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stamp config must be a JSON object.');
  }
  return parsed;
}

function collectFontFiles(dirPath, result = []) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return result;
  }

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectFontFiles(fullPath, result);
      continue;
    }
    if (/\.(ttf|otf|ttc)$/i.test(entry.name)) {
      result.push(fullPath);
    }
  }

  return result;
}

function resolveConfiguredFontPath(fontPath) {
  return path.normalize(
    path.isAbsolute(fontPath) ? fontPath : path.resolve(projectRoot, fontPath),
  );
}

function createFontCatalog() {
  const fonts = Array.from(new Set(FONT_DIRS.flatMap((dir) => collectFontFiles(dir))))
    .sort((left, right) => left.localeCompare(right, 'ru'))
    .map((fontPath) => ({
      id: `font-${crypto.createHash('sha256').update(fontPath).digest('hex').slice(0, 16)}`,
      serverPath: path.normalize(fontPath),
      label: path.basename(fontPath).replace(/\.(ttf|otf|ttc)$/i, ''),
    }));

  return {
    fonts,
    byId: new Map(fonts.map((font) => [font.id, font])),
    byServerPath: new Map(fonts.map((font) => [font.serverPath, font])),
  };
}

function visitConfiguredFonts(config, callback) {
  const fonts = config?.appearance?.fonts;
  for (const role of ['title', 'label', 'value']) {
    const entry = fonts?.[role];
    if (entry?.path) {
      callback(entry, role);
    }
  }
}

function createClientStampConfig(config, catalog) {
  const clientConfig = structuredClone(config);
  visitConfiguredFonts(clientConfig, (entry) => {
    const serverPath = resolveConfiguredFontPath(entry.path);
    const font = catalog.byServerPath.get(serverPath);
    if (!font) {
      throw new Error('Configured stamp font is unavailable.');
    }
    entry.path = font.id;
  });
  return clientConfig;
}

function createServerStampConfig(config, catalog) {
  const serverConfig = structuredClone(config);
  visitConfiguredFonts(serverConfig, (entry) => {
    const font = catalog.byId.get(entry.path);
    if (!font) {
      throw new HttpError(
        400,
        'UNKNOWN_FONT',
        'Некорректная конфигурация штампа.',
        { fontId: entry.path },
      );
    }
    entry.path = font.serverPath;
  });
  return serverConfig;
}

function listAvailableFonts(catalog) {
  return catalog.fonts.map((font) => ({
    id: font.id,
    label: font.label,
  }));
}

function getReadiness() {
  const checks = {
    python: false,
    config: false,
    storage: false,
  };

  try {
    execFileSync('python3', ['--version'], {
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: 2000,
    });
    checks.python = true;
  } catch {}

  try {
    const config = parseStampConfig(readStampConfig());
    const clientConfig = createClientStampConfig(config, createFontCatalog());
    validateStampConfig(clientConfig);
    checks.config = true;
  } catch {}

  try {
    fs.accessSync(generatedDir, fs.constants.W_OK);
    checks.storage = true;
  } catch {}

  return {
    ok: Object.values(checks).every(Boolean),
    service: 'pdf-signing-demo',
    checks,
  };
}

function normalizeCmsSignatureBase64(cmsSignatureBase64) {
  const payload = String(cmsSignatureBase64 || '').trim();
  if (!payload) {
    return payload;
  }

  try {
    return execFileSync('python3', [CMS_NORMALIZER_PATH], {
      input: payload,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }).trim() || payload;
  } catch (error) {
    throw new CmsVerificationError('CMS_NORMALIZATION_FAILED', error);
  }
}

function createCmsIntegrityError(error) {
  return new HttpError(
    400,
    'CMS_INTEGRITY_FAILED',
    'CMS-подпись не прошла обязательную проверку целостности.',
    { verifierCode: error.code || 'CMS_VERIFIER_FAILED' },
  );
}

function createCertificateError(error) {
  return new HttpError(
    400,
    'INVALID_SIGNER_CERTIFICATE',
    'Не удалось проверить выбранный сертификат.',
    { verifierCode: error.code || 'CERTIFICATE_INSPECTION_FAILED' },
  );
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

function logRequestError(req, res, error, stage, code) {
  const record = {
    timestamp: new Date().toISOString(),
    level: error instanceof HttpError ? 'warn' : 'error',
    event: 'request_failed',
    requestId: res.locals.requestId,
    method: req.method,
    path: req.path,
    stage,
    code,
    error: {
      name: error?.name || 'Error',
      message: String(error?.message || 'Unknown error').slice(0, 1000),
    },
  };
  if (error instanceof HttpError && error.details) {
    record.details = error.details;
  }
  console.error(JSON.stringify(record));
}

function sendSafeError(req, res, error, stage = null) {
  const known = error instanceof HttpError;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'INTERNAL_ERROR';
  const message = known
    ? error.publicMessage
    : 'Сервис временно не может выполнить операцию.';
  logRequestError(req, res, error, stage, code);

  return res.status(status).json({
    ok: false,
    ...(stage ? { stage } : {}),
    code,
    message,
    requestId: res.locals.requestId,
  });
}

const router = express.Router();

router.get('/health/live', (_req, res) => {
  res.json({ ok: true, service: 'pdf-signing-demo' });
});

router.get('/health/ready', (_req, res) => {
  const readiness = getReadiness();
  res.status(readiness.ok ? 200 : 503).json(readiness);
});

router.get('/api/stamp-config', (_req, res) => {
  try {
    const raw = readStampConfig();
    const config = parseStampConfig(raw);
    const catalog = createFontCatalog();
    const clientConfig = createClientStampConfig(config, catalog);
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
    res.json({ ok: true, fonts: listAvailableFonts(createFontCatalog()) });
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

router.post('/api/sign/prepare', async (req, res) => {
  try {
    validatePrepareBody(req.body);
    const certificateDer = decodeCertificateBase64(
      req.body.signer.certificateBase64,
    );
    let signer;
    try {
      signer = inspectCertificate(certificateDer);
    } catch (error) {
      if (error instanceof CmsVerificationError) {
        throw createCertificateError(error);
      }
      throw error;
    }
    const sourceBuffer = req.body.pdfBase64
      ? decodePdfBase64(req.body.pdfBase64)
      : fs.readFileSync(formPdfPath);
    const pdfInfo = await validatePdfBuffer(sourceBuffer);
    validateStampConfigForDocument(req.body.stampConfig, pdfInfo.pages);
    const stampConfig = req.body.stampConfig
      ? createServerStampConfig(req.body.stampConfig, createFontCatalog())
      : null;
    const requestedStampPosition = req.body.requestedStampPosition || null;
    const prepared = await createPreparedPdf({
      sourceBuffer,
      signer,
      stampConfig,
      requestedStampPosition,
    });
    const sessionId = sessions.create({
      ...prepared,
      expectedCertificateSha256: signer.certificateSha256,
    });
    res.json({
      ok: true,
      sessionId,
      contentToSignBase64: prepared.contentToSign.toString('base64'),
      byteRange: prepared.byteRange,
      placeholderLength: prepared.placeholderLength,
      note: 'PDF prepared for detached CMS signature (PAdES / ETSI.CAdES.detached).',
    });
  } catch (error) {
    sendSafeError(req, res, error, 'prepare');
  }
});

router.post('/api/sign/complete', (req, res) => {
  try {
    validateCompleteBody(req.body);
    const { sessionId, cmsSignatureBase64 } = req.body;
    const decodedCms = decodeCmsBase64(cmsSignatureBase64);

    const session = sessions.get(sessionId);
    if (!session) {
      throw new HttpError(
        404,
        'SESSION_NOT_FOUND',
        'Сессия подписания не найдена или истекла.',
      );
    }
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
      normalizedCmsSignatureBase64 = normalizeCmsSignatureBase64(cmsSignatureBase64);
      normalizedCms = decodeCmsBase64(normalizedCmsSignatureBase64);
      if (normalizedCms.length * 2 > session.placeholderLength) {
        throw new CmsVerificationError('CMS_EXCEEDS_PLACEHOLDER');
      }
      integrity = verifyCmsSignature({
        cmsDer: normalizedCms,
        content: session.contentToSign,
        expectedCertificateSha256: session.expectedCertificateSha256,
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
      embeddedIntegrity = verifyEveryEmbeddedSignature(signedPdf, {
        expectedLastCertificateSha256: session.expectedCertificateSha256,
      });
    } catch (error) {
      if (error instanceof CmsVerificationError) {
        throw createCmsIntegrityError(error);
      }
      throw error;
    }

    const fileName = sessions.saveSignedPdf(signedPdf);
    sessions.consume(sessionId);
    return res.json({
      ok: true,
      signedPdfUrl: `./generated/${fileName}`,
      downloadName: 'signed-formular.pdf',
      verification: createVerificationResult(integrity, embeddedIntegrity),
    });
  } catch (error) {
    return sendSafeError(req, res, error, 'complete');
  }
});

router.use('/generated', express.static(generatedDir));
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

setInterval(() => sessions.cleanup(), 10 * 60 * 1000).unref();

app.listen(PORT, '127.0.0.1', () => {
  console.log(`pdf-signing-demo listening on http://127.0.0.1:${PORT}${BASE_PATH}`);
});
