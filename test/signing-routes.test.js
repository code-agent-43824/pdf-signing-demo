const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createVerificationResult,
} = require('../src/routes/signing');

test('signing verification response preserves independent status semantics', () => {
  const result = createVerificationResult(
    {
      ok: true,
      digestAlgorithm: 'sha256',
      signatureAlgorithm: 'rsa',
    },
    [{ ok: true }, { ok: true }],
  );

  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.integrity, {
    status: 'valid',
    code: 'CMS_INTEGRITY_VALID',
    signaturesVerified: 2,
    signerCertificateMatched: true,
    digestAlgorithm: 'sha256',
    signatureAlgorithm: 'rsa',
  });
  assert.equal(result.trust.status, 'not_checked');
  assert.equal(result.qualified.status, 'not_checked');
});

test('signing verification response remains fail-closed', () => {
  for (const [integrity, embedded] of [
    [null, [{ ok: true }]],
    [{ ok: false }, [{ ok: true }]],
    [{ ok: true }, []],
    [{ ok: true }, [{ ok: false }]],
  ]) {
    assert.throws(
      () => createVerificationResult(integrity, embedded),
      /Cannot report a successful verification result/,
    );
  }
});
