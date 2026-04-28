const express = require('express');
const path = require('path');
const fs = require('fs');
const { createPreparedPdf, embedCmsSignature, createSessionStore } = require('./signing/pades');

const app = express();
const PORT = process.env.PORT || 3010;
const BASE_PATH = process.env.BASE_PATH || '/';
const FORM_PDF_NAME = 'formular.pdf';
const publicDir = path.join(__dirname, '..', 'public');
const assetsDir = path.join(publicDir, 'assets');
const generatedDir = path.join(publicDir, 'generated');
const formPdfPath = path.join(assetsDir, FORM_PDF_NAME);
const sessions = createSessionStore({ generatedDir });

fs.mkdirSync(generatedDir, { recursive: true });
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'pdf-signing-demo' });
});

const router = express.Router();

router.get('/api/form', (_req, res) => {
  const stats = fs.statSync(formPdfPath);
  res.json({
    title: 'Формуляр на подпись',
    pdfUrl: `./assets/${FORM_PDF_NAME}`,
    size: stats.size,
  });
});

router.post('/api/sign/prepare', async (req, res) => {
  try {
    const signer = req.body?.signer || {};
    const pdfBase64 = req.body?.pdfBase64;
    const sourceBuffer = pdfBase64 ? Buffer.from(pdfBase64, 'base64') : undefined;
    const prepared = await createPreparedPdf({ sourcePath: formPdfPath, sourceBuffer, signer });
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

    const signedPdf = embedCmsSignature({
      preparedPdf: session.preparedPdf,
      byteRange: session.byteRange,
      cmsBase64: cmsSignatureBase64,
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
