const { HttpError } = require('./validation');
const {
  OperationControlError,
} = require('../runtime/operation-queue');
const {
  WorkerProcessError,
} = require('../runtime/process-runner');
const {
  StorageLimitError,
} = require('../storage/lifecycle');

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

function createOperationError(error) {
  if (error instanceof StorageLimitError) {
    if (error.code === 'SESSION_OWNER_LIMIT') {
      return new HttpError(
        429,
        'SESSION_LIMIT_REACHED',
        'Для этого адреса уже создано слишком много активных сессий.',
      );
    }
    return new HttpError(
      503,
      'STORAGE_CAPACITY_REACHED',
      'Временное хранилище занято. Повторите попытку позже.',
    );
  }
  if (error instanceof OperationControlError) {
    if (error.code === 'OPERATION_TIMEOUT') {
      return new HttpError(
        504,
        'OPERATION_TIMEOUT',
        'Операция подписи превысила допустимое время выполнения.',
      );
    }
    if (['QUEUE_FULL', 'QUEUE_TIMEOUT'].includes(error.code)) {
      return new HttpError(
        503,
        'SERVER_BUSY',
        'Сервис занят. Повторите попытку позже.',
      );
    }
  }
  if (error instanceof WorkerProcessError && error.code === 'WORKER_TIMEOUT') {
    return new HttpError(
      504,
      'OPERATION_TIMEOUT',
      'Операция подписи превысила допустимое время выполнения.',
    );
  }
  return error;
}

function shouldSkipResponse(res, error) {
  return (
    res.destroyed
    || res.writableEnded
    || (
      error instanceof OperationControlError
      && error.code === 'REQUEST_ABORTED'
    )
    || (
      error instanceof WorkerProcessError
      && error.code === 'WORKER_ABORTED'
    )
  );
}

function logRequestError(req, res, error, stage, code) {
  const requestPath = (
    req.path.startsWith('/api/results/')
    || /\/api\/results\/[^/?]+/.test(req.originalUrl || '')
  )
    ? '/api/results/:capability'
    : req.path;
  const record = {
    timestamp: new Date().toISOString(),
    level: error instanceof HttpError ? 'warn' : 'error',
    event: 'request_failed',
    requestId: res.locals.requestId,
    method: req.method,
    path: requestPath,
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

module.exports = {
  createCertificateError,
  createCmsIntegrityError,
  createOperationError,
  sendSafeError,
  shouldSkipResponse,
};
