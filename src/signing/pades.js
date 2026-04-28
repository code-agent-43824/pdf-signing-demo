const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fontkit = require('@pdf-lib/fontkit');
const { PDFDocument, rgb } = require('pdf-lib');
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
const { SUBFILTER_ETSI_CADES_DETACHED, findByteRange } = require('@signpdf/utils');

const DEFAULT_SIGNATURE_LENGTH = 16000;
const STAMP_MARGIN = 24;
const STAMP_WIDTH = 230;
const STAMP_HEIGHT = 112;
const FALLBACK_FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

function removeTrailingNewLine(buffer) {
  if (buffer[buffer.length - 1] === 0x0a) return buffer.subarray(0, buffer.length - 1);
  return buffer;
}

function sanitizeStampValue(value, fallback = '—') {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean || fallback;
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

function wrapText(text, maxChars) {
  const words = sanitizeStampValue(text).split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines;
}

async function drawVisibleStamp({ pdfDoc, signer = {} }) {
  pdfDoc.registerFontkit(fontkit);
  const fontBytes = fs.readFileSync(FALLBACK_FONT_PATH);
  const font = await pdfDoc.embedFont(fontBytes, { subset: true });
  const page = pdfDoc.getPages()[0];
  const { width } = page.getSize();
  const stampX = width - STAMP_WIDTH - STAMP_MARGIN;
  const stampY = STAMP_MARGIN;
  const signerName = sanitizeStampValue(extractDnField(signer.subjectName, 'CN') || signer.displayName || signer.subjectName);
  const issuerName = sanitizeStampValue(extractDnField(signer.issuerName, 'CN') || signer.issuerName);
  const certificateId = sanitizeStampValue(signer.thumbprint || signer.serialNumber || signer.certificateId);

  page.drawRectangle({
    x: stampX,
    y: stampY,
    width: STAMP_WIDTH,
    height: STAMP_HEIGHT,
    color: rgb(0.97, 0.98, 1),
    borderColor: rgb(0.18, 0.36, 0.78),
    borderWidth: 1,
    opacity: 0.96,
  });

  page.drawText('Электронная подпись', {
    x: stampX + 10,
    y: stampY + STAMP_HEIGHT - 16,
    size: 10,
    font,
    color: rgb(0.1, 0.2, 0.45),
  });

  const lines = [
    ['Подписант:', wrapText(signerName, 26)],
    ['Выдан:', wrapText(issuerName, 26)],
    ['ID:', wrapText(certificateId, 26)],
  ];

  let cursorY = stampY + STAMP_HEIGHT - 30;
  for (const [label, values] of lines) {
    page.drawText(label, {
      x: stampX + 10,
      y: cursorY,
      size: 7,
      font,
      color: rgb(0.24, 0.28, 0.35),
    });
    cursorY -= 9;
    for (const line of values.slice(0, label === 'ID:' ? 2 : 2)) {
      page.drawText(line, {
        x: stampX + 10,
        y: cursorY,
        size: 8,
        font,
        color: rgb(0.08, 0.08, 0.08),
      });
      cursorY -= 9;
    }
  }

  return {
    widgetRect: [stampX, stampY, stampX + STAMP_WIDTH, stampY + STAMP_HEIGHT],
  };
}

async function createPreparedPdf({ sourcePath, signatureLength = DEFAULT_SIGNATURE_LENGTH, signer = {} }) {
  const source = fs.readFileSync(sourcePath);
  const pdfDoc = await PDFDocument.load(source);
  const { widgetRect } = await drawVisibleStamp({ pdfDoc, signer });

  pdflibAddPlaceholder({
    pdfDoc,
    reason: 'Подписание формуляра',
    contactInfo: 'watson@openclaw.local',
    name: sanitizeStampValue(extractDnField(signer.subjectName, 'CN') || signer.displayName || signer.subjectName || 'Kirill'),
    location: 'Web UI',
    signatureLength,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    widgetRect,
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
