const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');

const {
  createPreparedPdf,
  embedCmsSignature,
} = require('../src/signing/pades');
const {
  CmsVerificationError,
  verifyCmsSignature,
  verifyEveryEmbeddedSignature,
} = require('../src/signing/cms-verifier');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(__dirname, 'fixtures');
const SIMPLE_PDF = path.join(FIXTURE_ROOT, 'pdf', 'simple.pdf');

let tempDir;
let certPath;
let keyPath;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function derPayloadLength(payload) {
  assert.equal(payload[0], 0x30, 'CMS must start with a DER SEQUENCE');
  const firstLength = payload[1];
  if ((firstLength & 0x80) === 0) {
    return 2 + firstLength;
  }
  const lengthOctets = firstLength & 0x7f;
  assert.ok(lengthOctets > 0 && lengthOctets <= 4, 'unsupported DER length');
  let contentLength = 0;
  for (let index = 0; index < lengthOctets; index += 1) {
    contentLength = (contentLength * 256) + payload[2 + index];
  }
  return 2 + lengthOctets + contentLength;
}

function extractEmbeddedSignatures(pdf) {
  const latin = pdf.toString('latin1');
  const byteRangePattern = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const results = [];

  for (const match of latin.matchAll(byteRangePattern)) {
    const byteRange = match.slice(1).map(Number);
    const contentsStart = byteRange[1];
    const contentsEnd = byteRange[2] - 1;
    assert.equal(pdf[contentsStart], 0x3c, 'reserved region must start with <');
    assert.equal(pdf[contentsEnd], 0x3e, 'reserved region must end with >');

    const paddedCms = Buffer.from(
      pdf
        .subarray(contentsStart + 1, contentsEnd)
        .toString('ascii')
        .replace(/\s+/g, ''),
      'hex',
    );
    const cmsLength = derPayloadLength(paddedCms);
    const content = Buffer.concat([
      pdf.subarray(byteRange[0], byteRange[0] + byteRange[1]),
      pdf.subarray(byteRange[2], byteRange[2] + byteRange[3]),
    ]);
    results.push({
      byteRange,
      cms: paddedCms.subarray(0, cmsLength),
      content,
    });
  }

  return results;
}

function validateEveryCmsWithOpenSsl(pdf, label) {
  const signatures = extractEmbeddedSignatures(pdf);
  signatures.forEach((signature, index) => {
    const cmsPath = path.join(tempDir, `${label}-${index + 1}.der`);
    const contentPath = path.join(tempDir, `${label}-${index + 1}.bin`);
    fs.writeFileSync(cmsPath, signature.cms);
    fs.writeFileSync(contentPath, signature.content);
    run('openssl', [
      'cms',
      '-verify',
      '-binary',
      '-inform',
      'DER',
      '-in',
      cmsPath,
      '-content',
      contentPath,
      '-noverify',
      '-out',
      path.join(tempDir, `${label}-${index + 1}.verified`),
    ]);
  });
  return signatures;
}

function validatePdfWithPyHanko(pdfPath) {
  const raw = run('python3', [
    path.join('test', 'validate_pdf.py'),
    pdfPath,
    certPath,
  ]);
  return JSON.parse(raw);
}

function createCms(content, index, { attached = false } = {}) {
  const contentPath = path.join(tempDir, `content-${index}.bin`);
  const cmsPath = path.join(tempDir, `signature-${index}.der`);
  fs.writeFileSync(contentPath, content);
  run('python3', [
    path.join('test', 'create_cms.py'),
    contentPath,
    certPath,
    keyPath,
    cmsPath,
    ...(attached ? ['--attached'] : []),
  ]);
  return fs.readFileSync(cmsPath);
}

function createNonCadesCms(content, index) {
  const contentPath = path.join(tempDir, `non-cades-content-${index}.bin`);
  const cmsPath = path.join(tempDir, `non-cades-signature-${index}.der`);
  fs.writeFileSync(contentPath, content);
  run('openssl', [
    'cms',
    '-sign',
    '-binary',
    '-in',
    contentPath,
    '-signer',
    certPath,
    '-inkey',
    keyPath,
    '-outform',
    'DER',
    '-out',
    cmsPath,
    '-md',
    'sha256',
    '-nosmimecap',
  ]);
  return fs.readFileSync(cmsPath);
}

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-signing-golden-'));
  certPath = path.join(tempDir, 'golden-cert.pem');
  keyPath = path.join(tempDir, 'golden-key.pem');
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=PDF Signing Golden Test Signer',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '2',
  ]);
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('committed corpus matches its manifest and rejects malformed inputs', () => {
  const result = JSON.parse(run('python3', [path.join('test', 'validate_corpus.py')]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.dynamicSignatureCounts, [1, 2, 3, 4]);

  const invalidCmsPath = path.join(FIXTURE_ROOT, 'invalid', 'malformed-cms.der');
  const verification = spawnSync('openssl', [
    'cms',
    '-verify',
    '-binary',
    '-inform',
    'DER',
    '-in',
    invalidCmsPath,
    '-noverify',
    '-out',
    path.join(tempDir, 'invalid-cms-output'),
  ]);
  assert.notEqual(verification.status, 0, 'OpenSSL must reject malformed CMS');
});

test('structural corpus variants can be prepared without rewriting their prefix', async () => {
  const fixtureNames = [
    'simple.pdf',
    'multipage.pdf',
    'acroform.pdf',
    'empty-signature-field.pdf',
    'nonstandard-geometry.pdf',
  ];

  for (const fixtureName of fixtureNames) {
    const source = fs.readFileSync(path.join(FIXTURE_ROOT, 'pdf', fixtureName));
    const prepared = await createPreparedPdf({
      sourceBuffer: source,
      signer: {
        subjectName: 'CN=PDF Signing Golden Test Signer',
        issuerName: 'CN=PDF Signing Golden Test Signer',
        thumbprint: 'GOLDEN-TEST',
        serialNumber: '01',
        validToDate: '2030-01-01T00:00:00Z',
      },
    });
    assert.ok(
      prepared.preparedPdf.subarray(0, source.length).equals(source),
      `${fixtureName} must be updated incrementally`,
    );
    assert.deepEqual(
      prepared.contentToSign,
      Buffer.concat([
        prepared.preparedPdf.subarray(0, prepared.byteRange[1]),
        prepared.preparedPdf.subarray(
          prepared.byteRange[2],
          prepared.byteRange[2] + prepared.byteRange[3],
        ),
      ]),
    );
    assert.equal(prepared.placeholderLength, 16000);
  }
});

test('one through four incremental signatures preserve and validate every signature', async () => {
  let currentPdf = fs.readFileSync(SIMPLE_PDF);

  for (let signatureIndex = 1; signatureIndex <= 4; signatureIndex += 1) {
    const previousPdf = currentPdf;
    const prepared = await createPreparedPdf({
      sourceBuffer: previousPdf,
      signer: {
        subjectName: 'CN=PDF Signing Golden Test Signer',
        issuerName: 'CN=PDF Signing Golden Test Signer',
        thumbprint: 'GOLDEN-TEST',
        serialNumber: String(signatureIndex).padStart(2, '0'),
        validToDate: '2030-01-01T00:00:00Z',
      },
    });

    assert.ok(
      prepared.preparedPdf.subarray(0, previousPdf.length).equals(previousPdf),
      `signature ${signatureIndex} must be an incremental update`,
    );

    const cms = createCms(prepared.contentToSign, signatureIndex);
    assert.equal(
      verifyCmsSignature({
        cmsDer: cms,
        content: prepared.contentToSign,
      }).ok,
      true,
    );
    currentPdf = embedCmsSignature({
      preparedPdf: prepared.preparedPdf,
      byteRange: prepared.byteRange,
      cmsBase64: cms.toString('base64'),
      placeholderLength: prepared.placeholderLength,
    });
    assert.equal(currentPdf.length, prepared.preparedPdf.length);

    const signedPdfPath = path.join(tempDir, `signed-${signatureIndex}.pdf`);
    fs.writeFileSync(signedPdfPath, currentPdf);

    const opensslResults = validateEveryCmsWithOpenSsl(
      currentPdf,
      `signed-${signatureIndex}`,
    );
    assert.equal(opensslResults.length, signatureIndex);
    assert.equal(
      verifyEveryEmbeddedSignature(currentPdf).length,
      signatureIndex,
    );

    const pyhankoResult = validatePdfWithPyHanko(signedPdfPath);
    assert.equal(pyhankoResult.ok, true);
    assert.equal(pyhankoResult.signatures.length, signatureIndex);
    for (const status of pyhankoResult.signatures) {
      assert.equal(status.intact, true);
      assert.equal(status.valid, true);
      assert.equal(status.trusted, true);
      assert.equal(status.bottomLine, true);
    }
  }
});

test('malformed PDF is rejected by the preparation pipeline', async () => {
  const outputPath = path.join(tempDir, 'malformed-prepared.pdf');
  const preparation = spawnSync('python3', [
    path.join(PROJECT_ROOT, 'scripts', 'prepare-pyhanko.py'),
    path.join(FIXTURE_ROOT, 'invalid', 'malformed.pdf'),
    '{}',
    outputPath,
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(preparation.status, 0);
  assert.match(preparation.stderr, /PdfReadError|malformed PDF/i);
  assert.equal(fs.existsSync(outputPath), false);
});

test('CMS verifier rejects malformed CMS and content or signature tampering', async () => {
  const source = fs.readFileSync(SIMPLE_PDF);
  const prepared = await createPreparedPdf({
    sourceBuffer: source,
    signer: {
      subjectName: 'CN=PDF Signing Golden Test Signer',
      issuerName: 'CN=PDF Signing Golden Test Signer',
      thumbprint: 'GOLDEN-TEST',
      serialNumber: '01',
      validToDate: '2030-01-01T00:00:00Z',
    },
  });
  const cms = createCms(prepared.contentToSign, 'negative');

  assert.throws(
    () => verifyCmsSignature({
      cmsDer: fs.readFileSync(
        path.join(FIXTURE_ROOT, 'invalid', 'malformed-cms.der'),
      ),
      content: prepared.contentToSign,
    }),
    CmsVerificationError,
  );

  const tamperedContent = Buffer.from(prepared.contentToSign);
  tamperedContent[0] ^= 0x01;
  assert.throws(
    () => verifyCmsSignature({ cmsDer: cms, content: tamperedContent }),
    (error) => (
      error instanceof CmsVerificationError
      && error.code === 'CONTENT_DIGEST_MISMATCH'
    ),
  );

  const tamperedCms = Buffer.from(cms);
  tamperedCms[tamperedCms.length - 1] ^= 0x01;
  assert.throws(
    () => verifyCmsSignature({
      cmsDer: tamperedCms,
      content: prepared.contentToSign,
    }),
    CmsVerificationError,
  );

  assert.throws(
    () => verifyCmsSignature({
      cmsDer: createCms(prepared.contentToSign, 'attached', { attached: true }),
      content: prepared.contentToSign,
    }),
    (error) => (
      error instanceof CmsVerificationError
      && error.code === 'CMS_MUST_BE_DETACHED'
    ),
  );

  assert.throws(
    () => verifyCmsSignature({
      cmsDer: createNonCadesCms(prepared.contentToSign, 'missing-ess'),
      content: prepared.contentToSign,
    }),
    (error) => (
      error instanceof CmsVerificationError
      && error.code === 'INVALID_SIGNED_ATTRIBUTES'
    ),
  );
});
