const express = require('express');
const { HttpError } = require('../http/validation');
const { sendSafeError } = require('../http/errors');

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

function createResultsRouter({ results }) {
  const router = express.Router();

  router.head('/:token', (_req, res) => {
    res.set(resultHeaders('download')).status(405).end();
  });

  router.get('/:token', (req, res) => {
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

  return router;
}

module.exports = { createResultsRouter, resultHeaders };
