const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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

function withPrivateTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-signing-verify-'));
  fs.chmodSync(tempDir, 0o700);
  try {
    return callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runVerifier(args) {
  try {
    const output = execFileSync('python3', [VERIFY_CMS_SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    return JSON.parse(output);
  } catch (error) {
    throw new CmsVerificationError(parseVerifierFailure(error), error);
  }
}

function writePrivateFile(filePath, payload) {
  fs.writeFileSync(filePath, payload, { mode: 0o600 });
}

function inspectCertificate(certificateDer) {
  return withPrivateTempDir((tempDir) => {
    const certificatePath = path.join(tempDir, 'certificate.der');
    writePrivateFile(certificatePath, certificateDer);
    return runVerifier(['inspect-certificate', certificatePath]);
  });
}

function verifyCmsSignature({
  cmsDer,
  content,
  expectedCertificateSha256 = null,
}) {
  return withPrivateTempDir((tempDir) => {
    const cmsPath = path.join(tempDir, 'signature.der');
    const contentPath = path.join(tempDir, 'content.bin');
    writePrivateFile(cmsPath, cmsDer);
    writePrivateFile(contentPath, content);
    return runVerifier([
      'verify',
      cmsPath,
      contentPath,
      ...(expectedCertificateSha256 ? [expectedCertificateSha256] : []),
    ]);
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

function verifyEveryEmbeddedSignature(pdf, {
  expectedLastCertificateSha256 = null,
} = {}) {
  const signatures = extractEmbeddedSignatures(pdf);
  if (signatures.length === 0) {
    throw new CmsVerificationError('PDF_SIGNATURE_NOT_FOUND');
  }
  return signatures.map((signature, index) => verifyCmsSignature({
    cmsDer: signature.cmsDer,
    content: signature.content,
    expectedCertificateSha256: (
      index === signatures.length - 1 ? expectedLastCertificateSha256 : null
    ),
  }));
}

module.exports = {
  CmsVerificationError,
  extractEmbeddedSignatures,
  inspectCertificate,
  verifyCmsSignature,
  verifyEveryEmbeddedSignature,
};
