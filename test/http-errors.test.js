const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createCertificateError,
  createCmsIntegrityError,
  createOperationError,
  sendSafeError,
  shouldSkipResponse,
} = require('../src/http/errors');
const { HttpError } = require('../src/http/validation');
const {
  OperationControlError,
} = require('../src/runtime/operation-queue');
const {
  WorkerProcessError,
} = require('../src/runtime/process-runner');
const {
  StorageLimitError,
} = require('../src/storage/lifecycle');

test('HTTP error mapping preserves the established public status and codes', () => {
  const cases = [
    [new StorageLimitError('SESSION_OWNER_LIMIT'), 429, 'SESSION_LIMIT_REACHED'],
    [new StorageLimitError('SESSION_COUNT_LIMIT'), 503, 'STORAGE_CAPACITY_REACHED'],
    [new OperationControlError('OPERATION_TIMEOUT'), 504, 'OPERATION_TIMEOUT'],
    [new OperationControlError('QUEUE_FULL'), 503, 'SERVER_BUSY'],
    [new OperationControlError('QUEUE_TIMEOUT'), 503, 'SERVER_BUSY'],
    [new WorkerProcessError('WORKER_TIMEOUT', 'timeout'), 504, 'OPERATION_TIMEOUT'],
  ];

  for (const [source, status, code] of cases) {
    const mapped = createOperationError(source);
    assert.ok(mapped instanceof HttpError);
    assert.equal(mapped.status, status);
    assert.equal(mapped.code, code);
  }

  const unknown = new Error('unknown');
  assert.equal(createOperationError(unknown), unknown);
});

test('certificate and CMS errors retain only bounded verifier metadata', () => {
  const certificate = createCertificateError({ code: 'BAD_CERT' });
  assert.equal(certificate.status, 400);
  assert.equal(certificate.code, 'INVALID_SIGNER_CERTIFICATE');
  assert.deepEqual(certificate.details, { verifierCode: 'BAD_CERT' });

  const cms = createCmsIntegrityError({ code: 'BAD_CMS' });
  assert.equal(cms.status, 400);
  assert.equal(cms.code, 'CMS_INTEGRITY_FAILED');
  assert.deepEqual(cms.details, { verifierCode: 'BAD_CMS' });
});

test('safe error responses hide internal details and redact capability paths in logs', () => {
  const req = {
    method: 'GET',
    path: '/api/results/secret-capability',
  };
  let status;
  let payload;
  const res = {
    locals: { requestId: 'request-id' },
    status(value) {
      status = value;
      return this;
    },
    json(value) {
      payload = value;
      return value;
    },
  };
  const records = [];
  const originalConsoleError = console.error;
  console.error = (record) => records.push(JSON.parse(record));
  try {
    sendSafeError(
      req,
      res,
      new HttpError(400, 'SAFE_CODE', 'Safe message', { secret: 'internal' }),
      'complete',
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(status, 400);
  assert.deepEqual(payload, {
    ok: false,
    stage: 'complete',
    code: 'SAFE_CODE',
    message: 'Safe message',
    requestId: 'request-id',
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].path, '/api/results/:capability');
  assert.deepEqual(records[0].details, { secret: 'internal' });
  assert.doesNotMatch(JSON.stringify(records[0]), /secret-capability/);
});

test('aborted or already-finished responses are skipped', () => {
  assert.equal(shouldSkipResponse({ destroyed: true }, new Error()), true);
  assert.equal(shouldSkipResponse({ writableEnded: true }, new Error()), true);
  assert.equal(
    shouldSkipResponse({}, new OperationControlError('REQUEST_ABORTED')),
    true,
  );
  assert.equal(
    shouldSkipResponse({}, new WorkerProcessError('WORKER_ABORTED', 'aborted')),
    true,
  );
  assert.equal(shouldSkipResponse({}, new Error()), false);
});
