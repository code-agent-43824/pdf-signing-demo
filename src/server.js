const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3010;
const BASE_PATH = process.env.BASE_PATH || '/';
const FORM_PDF_NAME = 'formular.pdf';
const publicDir = path.join(__dirname, '..', 'public');
const assetsDir = path.join(publicDir, 'assets');
const formPdfPath = path.join(assetsDir, FORM_PDF_NAME);

app.use(express.json({ limit: '2mb' }));
app.use(BASE_PATH, express.static(publicDir, { extensions: ['html'] }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'pdf-signing-demo' });
});

app.get('/api/form', (_req, res) => {
  const stats = fs.statSync(formPdfPath);
  res.json({
    title: 'Формуляр на подпись',
    pdfUrl: `${BASE_PATH.replace(/\/$/, '')}/assets/${FORM_PDF_NAME}`,
    size: stats.size,
  });
});

app.post('/api/sign/prepare', (_req, res) => {
  res.status(501).json({
    ok: false,
    stage: 'prepare',
    message: 'PAdES prepare pipeline will be implemented next.',
  });
});

app.post('/api/sign/complete', (_req, res) => {
  res.status(501).json({
    ok: false,
    stage: 'complete',
    message: 'Signature embedding pipeline will be implemented next.',
  });
});

app.listen(PORT, () => {
  console.log(`pdf-signing-demo listening on http://127.0.0.1:${PORT}${BASE_PATH}`);
});
