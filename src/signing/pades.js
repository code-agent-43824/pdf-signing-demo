const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
const { SUBFILTER_ETSI_CADES_DETACHED, findByteRange } = require('@signpdf/utils');

const DEFAULT_SIGNATURE_LENGTH = 16000;

function removeTrailingNewLine(buffer) {
  if (buffer[buffer.length - 1] === 0x0a) return buffer.subarray(0, buffer.length - 1);
  return buffer;
}

function normalizeValue(value, fallback = '') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized || fallback;
}

function splitDistinguishedName(value) {
  return String(value || '')
    .split(/,(?=(?:[^\\]|\\.)*$)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractDnField(dn, fieldName) {
  const upper = `${fieldName}=`.toUpperCase();
  const parts = splitDistinguishedName(dn);
  const match = parts.find((part) => part.toUpperCase().startsWith(upper));
  return match ? match.slice(fieldName.length + 1).trim() : '';
}

function buildSignatureMetadata(signer = {}) {
  const name = normalizeValue(
    extractDnField(signer.subjectName, 'CN') || signer.subjectName,
    'Kirill',
  );
  const issuer = normalizeValue(
    extractDnField(signer.issuerName, 'CN') || signer.issuerName,
    'не указан',
  );
  const certId = normalizeValue(signer.thumbprint || signer.serialNumber, 'не указан');

  return {
    name,
    reason: `Выдан: ${issuer}`,
    contactInfo: `Cert ID: ${certId}`,
  };
}

async function createPreparedPdf({ sourcePath, signatureLength = DEFAULT_SIGNATURE_LENGTH, signer = {} }) {
  const source = fs.readFileSync(sourcePath);
  const pdfDoc = await PDFDocument.load(source);
  const metadata = buildSignatureMetadata(signer);

  pdflibAddPlaceholder({
    pdfDoc,
    reason: metadata.reason,
    contactInfo: metadata.contactInfo,
    name: metadata.name,
    location: 'Web UI',
    signatureLength,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    widgetRect: [56, 430, 276, 520],
    appName: 'pdf-signing-demo',
  });

  let pdf = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  pdf = removeTrailingNewLine(pdf);

  const { byteRangePlaceholder, byteRangePlaceholderPosition } = findByteRange(pdf);
  if (!byteRangePlaceholder) {
    throw new Error('ByteRange placeholder not found');
  }

  const byteRangeEnd = byteRangePlaceholderPosition + byteRangePlaceholder.length;
  const contentsTagPos = pdf.indexOf('/Contents ', byteRangeEnd);
  const placeholderPos = pdf.indexOf('<', contentsTagPos);
  const placeholderEnd = pdf.indexOf('>', placeholderPos);
  const placeholderLengthWithBrackets = placeholderEnd + 1 - placeholderPos;
  const placeholderLength = placeholderLengthWithBrackets - 2;

  const byteRange = [0, 0, 0, 0];
  byteRange[1] = placeholderPos;
  byteRange[2] = byteRange[1] + placeholderLengthWithBrackets;
  byteRange[3] = pdf.length - byteRange[2];

  let actualByteRange = `/ByteRange [${byteRange.join(' ')}]`;
  actualByteRange += ' '.repeat(byteRangePlaceholder.length - actualByteRange.length);

  const patchedPdf = Buffer.concat([
    pdf.slice(0, byteRangePlaceholderPosition),
    Buffer.from(actualByteRange),
    pdf.slice(byteRangeEnd),
  ]);

  const contentToSign = Buffer.concat([
    patchedPdf.slice(0, byteRange[1]),
    patchedPdf.slice(byteRange[2], byteRange[2] + byteRange[3]),
  ]);

  return {
    preparedPdf: patchedPdf,
    contentToSign,
    byteRange,
    placeholderLength,
    placeholderPos,
  };
}

function embedCmsSignature({ preparedPdf, byteRange, cmsBase64, placeholderLength }) {
  const raw = Buffer.from(cmsBase64, 'base64');
  if (raw.length * 2 > placeholderLength) {
    throw new Error(`CMS signature exceeds placeholder length: ${raw.length * 2} > ${placeholderLength}`);
  }

  let signatureHex = raw.toString('hex');
  signatureHex += Buffer.from(String.fromCharCode(0).repeat(placeholderLength / 2 - raw.length)).toString('hex');

  return Buffer.concat([
    preparedPdf.slice(0, byteRange[1]),
    Buffer.from(`<${signatureHex}>`),
    preparedPdf.slice(byteRange[2]),
  ]);
}

function createSessionStore({ generatedDir }) {
  const sessions = new Map();

  return {
    create(prepared) {
      const id = crypto.randomUUID();
      sessions.set(id, { ...prepared, createdAt: Date.now() });
      return id;
    },
    get(id) {
      return sessions.get(id);
    },
    consume(id) {
      const value = sessions.get(id);
      sessions.delete(id);
      return value;
    },
    saveSignedPdf(buffer) {
      const fileName = `signed-${crypto.randomUUID()}.pdf`;
      const filePath = path.join(generatedDir, fileName);
      fs.writeFileSync(filePath, buffer);
      return fileName;
    },
    cleanup(maxAgeMs = 60 * 60 * 1000) {
      const now = Date.now();
      for (const [id, session] of sessions.entries()) {
        if (now - session.createdAt > maxAgeMs) sessions.delete(id);
      }
    },
  };
}

module.exports = {
  createPreparedPdf,
  embedCmsSignature,
  createSessionStore,
  DEFAULT_SIGNATURE_LENGTH,
};
