const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { createPreparedPdf, embedCmsSignature, createSessionStore } = require('./signing/pades');

const app = express();
const PORT = process.env.PORT || 3010;
const BASE_PATH = process.env.BASE_PATH || '/';
const FORM_PDF_NAME = 'formular.pdf';
const CMS_NORMALIZER_PATH = path.join(__dirname, '..', 'scripts', 'normalize-cms.py');
const publicDir = path.join(__dirname, '..', 'public');
const projectRoot = path.join(__dirname, '..');
const assetsDir = path.join(publicDir, 'assets');
const localFontsDir = path.join(assetsDir, 'fonts');
const generatedDir = path.join(publicDir, 'generated');
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
app.use(express.json({ limit: '20mb' }));

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
    const font = catalog.byId.get(entry.path)
      || catalog.byServerPath.get(resolveConfiguredFontPath(entry.path));
    if (!font) {
      throw new Error('Unknown stamp font identifier.');
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
    parseStampConfig(readStampConfig());
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
    console.warn('CMS normalization skipped:', error.message);
    return payload;
  }
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
    res.json({ ok: true, config: createClientStampConfig(config, catalog) });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.get('/api/fonts', (_req, res) => {
  try {
    res.json({ ok: true, fonts: listAvailableFonts(createFontCatalog()) });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.get('/api/form', (_req, res) => {
  const stats = fs.statSync(formPdfPath);
  res.json({
    ok: true,
    title: 'Формуляр на подпись',
    pdfUrl: `./assets/${FORM_PDF_NAME}`,
    size: stats.size,
  });
});

router.post('/api/sign/prepare', async (req, res) => {
  try {
    const signer = req.body?.signer || {};
    const pdfBase64 = req.body?.pdfBase64;
    const stampConfig = req.body?.stampConfig
      ? createServerStampConfig(req.body.stampConfig, createFontCatalog())
      : null;
    const requestedStampPosition = req.body?.requestedStampPosition || null;
    const sourceBuffer = pdfBase64 ? Buffer.from(pdfBase64, 'base64') : undefined;
    const prepared = await createPreparedPdf({ sourcePath: formPdfPath, sourceBuffer, signer, stampConfig, requestedStampPosition });
    const sessionId = sessions.create(prepared);
    res.json({
      ok: true,
      sessionId,
      contentToSignBase64: prepared.contentToSign.toString('base64'),
      byteRange: prepared.byteRange,
      placeholderLength: prepared.placeholderLength,
      note: 'PDF prepared for detached CMS signature (PAdES / ETSI.CAdES.detached).',
    });
  } catch (error) {
    res.status(500).json({ ok: false, stage: 'prepare', message: error.message });
  }
});

router.post('/api/sign/complete', (req, res) => {
  try {
    const { sessionId, cmsSignatureBase64 } = req.body || {};
    if (!sessionId || !cmsSignatureBase64) {
      return res.status(400).json({ ok: false, stage: 'complete', message: 'sessionId and cmsSignatureBase64 are required.' });
    }

    const session = sessions.consume(sessionId);
    if (!session) {
      return res.status(404).json({ ok: false, stage: 'complete', message: 'Signing session not found or expired.' });
    }

    const normalizedCmsSignatureBase64 = normalizeCmsSignatureBase64(cmsSignatureBase64);

    const signedPdf = embedCmsSignature({
      preparedPdf: session.preparedPdf,
      byteRange: session.byteRange,
      cmsBase64: normalizedCmsSignatureBase64,
      placeholderLength: session.placeholderLength,
    });

    const fileName = sessions.saveSignedPdf(signedPdf);
    return res.json({
      ok: true,
      signedPdfUrl: `./generated/${fileName}`,
      downloadName: 'signed-formular.pdf',
    });
  } catch (error) {
    return res.status(500).json({ ok: false, stage: 'complete', message: error.message });
  }
});

router.use(express.static(publicDir, { extensions: ['html'] }));
app.use(BASE_PATH, router);

setInterval(() => sessions.cleanup(), 10 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`pdf-signing-demo listening on http://127.0.0.1:${PORT}${BASE_PATH}`);
});
