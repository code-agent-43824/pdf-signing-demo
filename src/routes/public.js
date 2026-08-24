const express = require('express');
const fs = require('fs');
const { HttpError, validateStampConfig } = require('../http/validation');
const { sendSafeError } = require('../http/errors');

function createPublicRouter({
  formPdfName,
  formPdfPath,
  stampConfiguration,
}) {
  const router = express.Router();

  router.get('/api/stamp-config', (req, res) => {
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
      sendSafeError(req, res, serverError);
    }
  });

  router.get('/api/fonts', (req, res) => {
    try {
      const catalog = stampConfiguration.createCatalog();
      res.json({ ok: true, fonts: stampConfiguration.listAvailable(catalog) });
    } catch (error) {
      sendSafeError(req, res, error);
    }
  });

  router.get('/api/form', (req, res) => {
    try {
      const stats = fs.statSync(formPdfPath);
      res.json({
        ok: true,
        title: 'Формуляр на подпись',
        pdfUrl: `./assets/${formPdfName}`,
        size: stats.size,
      });
    } catch (error) {
      sendSafeError(req, res, error);
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

  return router;
}

module.exports = { createPublicRouter };
