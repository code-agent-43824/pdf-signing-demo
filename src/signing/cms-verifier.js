const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  WorkerProcessError,
  runIsolatedProcess,
} = require('../runtime/process-runner');

const VERIFY_CMS_SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'verify-cms.py');

class CmsVerificationError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CmsVerificationError';
    this.code = code;
    this.cause = cause;
  }
}

function parseVerifierFailure(error) {
  const stderr = String(error?.stderr || '').trim();
  try {
    const payload = JSON.parse(stderr);
    if (payload?.code) return payload.code;
  } catch {}
  return 'CMS_VERIFIER_FAILED';
}

async function withPrivateTempDir(callback) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf-signing-verify-'));
  await fsp.chmod(tempDir, 0o700);
  try {
    return await callback(tempDir);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function runVerifier(args, { cwd, signal } = {}) {
  try {
    const result = await runIsolatedProcess(
      'python3',
      [VERIFY_CMS_SCRIPT_PATH, ...args],
      {
        cwd,
        signal,
        timeoutMs: 15000,
        maxBuffer: 1024 * 1024,
      },
    );
    return JSON.parse(result.stdout);
  } catch (error) {
    if (
      error instanceof WorkerProcessError
      && ['WORKER_TIMEOUT', 'WORKER_ABORTED'].includes(error.code)
    ) {
      throw error;
    }
    throw new CmsVerificationError(parseVerifierFailure(error), error);
  }
}

function writePrivateFile(filePath, payload) {
  return fsp.writeFile(filePath, payload, { mode: 0o600 });
}

function inspectCertificate(certificateDer, { signal = null } = {}) {
  return withPrivateTempDir(async (tempDir) => {
    const certificatePath = path.join(tempDir, 'certificate.der');
    await writePrivateFile(certificatePath, certificateDer);
    return runVerifier(
      ['inspect-certificate', certificatePath],
      { cwd: tempDir, signal },
    );
  });
}

async function verifyCmsSignature({
  cmsDer,
  content,
  expectedCertificateSha256 = null,
  signal = null,
}) {
  return withPrivateTempDir(async (tempDir) => {
    const cmsPath = path.join(tempDir, 'signature.der');
    const contentPath = path.join(tempDir, 'content.bin');
    await Promise.all([
      writePrivateFile(cmsPath, cmsDer),
      writePrivateFile(contentPath, content),
    ]);
    return runVerifier([
      'verify',
      cmsPath,
      contentPath,
      ...(expectedCertificateSha256 ? [expectedCertificateSha256] : []),
    ], { cwd: tempDir, signal });
  });
}

function readDerLength(payload) {
  if (payload.length < 2 || payload[0] !== 0x30) {
    throw new CmsVerificationError('INVALID_CMS_DER');
  }
  const firstLength = payload[1];
  if ((firstLength & 0x80) === 0) {
    const total = 2 + firstLength;
    if (total > payload.length) throw new CmsVerificationError('INVALID_CMS_DER');
    return total;
  }
  const lengthOctets = firstLength & 0x7f;
  if (lengthOctets === 0 || lengthOctets > 4 || 2 + lengthOctets > payload.length) {
    throw new CmsVerificationError('INVALID_CMS_DER');
  }
  const contentLength = payload
    .subarray(2, 2 + lengthOctets)
    .reduce((value, octet) => (value * 256) + octet, 0);
  if (contentLength < 128) {
    throw new CmsVerificationError('NON_CANONICAL_CMS_DER');
  }
  const total = 2 + lengthOctets + contentLength;
  if (total > payload.length) throw new CmsVerificationError('INVALID_CMS_DER');
  return total;
}

function extractEmbeddedSignatures(pdf) {
  const latin = pdf.toString('latin1');
  const byteRangePattern = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const signatures = [];

  for (const match of latin.matchAll(byteRangePattern)) {
    const byteRange = match.slice(1).map(Number);
    const [start, firstLength, secondStart, secondLength] = byteRange;
    const contentsEnd = secondStart - 1;
    const signedRevisionEnd = secondStart + secondLength;
    if (
      start !== 0
      || firstLength < 0
      || secondStart <= firstLength
      || signedRevisionEnd > pdf.length
      || pdf[firstLength] !== 0x3c
      || pdf[contentsEnd] !== 0x3e
    ) {
      throw new CmsVerificationError('INVALID_PDF_BYTE_RANGE');
    }
    const hex = pdf
      .subarray(firstLength + 1, contentsEnd)
      .toString('ascii')
      .replace(/\s+/g, '');
    if (!hex || hex.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(hex)) {
      throw new CmsVerificationError('INVALID_PDF_CMS_CONTENTS');
    }
    const paddedCms = Buffer.from(hex, 'hex');
    const cmsLength = readDerLength(paddedCms);
    if (paddedCms.subarray(cmsLength).some((octet) => octet !== 0)) {
      throw new CmsVerificationError('INVALID_PDF_CMS_PADDING');
    }
    signatures.push({
      byteRange,
      cmsDer: paddedCms.subarray(0, cmsLength),
      content: Buffer.concat([
        pdf.subarray(0, firstLength),
        pdf.subarray(secondStart, signedRevisionEnd),
      ]),
    });
  }
  return signatures;
}

async function verifyEveryEmbeddedSignature(pdf, {
  expectedLastCertificateSha256 = null,
  signal = null,
} = {}) {
  const signatures = extractEmbeddedSignatures(pdf);
  if (signatures.length === 0) {
    throw new CmsVerificationError('PDF_SIGNATURE_NOT_FOUND');
  }
  const results = [];
  for (const [index, signature] of signatures.entries()) {
    results.push(await verifyCmsSignature({
      cmsDer: signature.cmsDer,
      content: signature.content,
      expectedCertificateSha256: (
        index === signatures.length - 1 ? expectedLastCertificateSha256 : null
      ),
      signal,
    }));
  }
  return results;
}

module.exports = {
  CmsVerificationError,
  extractEmbeddedSignatures,
  inspectCertificate,
  verifyCmsSignature,
  verifyEveryEmbeddedSignature,
};
