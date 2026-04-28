const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fontkit = require('@pdf-lib/fontkit');
const { PDFDocument, PDFName, PDFArray, PDFNumber } = require('pdf-lib');
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
const { SUBFILTER_ETSI_CADES_DETACHED, findByteRange } = require('@signpdf/utils');

const DEFAULT_SIGNATURE_LENGTH = 16000;
const FALLBACK_FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const STAMP_MARGIN = 24;
const STAMP_WIDTH = 210;
const STAMP_HEIGHT = 82;
const MULTISIGN_SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'prepare-multisign.py');

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
    issuer,
    certId,
    reason: `Выдан: ${issuer}`,
    contactInfo: `Cert ID: ${certId}`,
  };
}

function wrapText(value, maxLength = 26) {
  const words = normalizeValue(value, '—').split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxLength) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function createAppearanceStream({ pdfDoc, widgetRect, metadata }) {
  pdfDoc.registerFontkit(fontkit);
  const fontBytes = fs.readFileSync(FALLBACK_FONT_PATH);
  return pdfDoc.embedFont(fontBytes, { subset: true }).then((font) => {
    const width = widgetRect[2] - widgetRect[0];
    const height = widgetRect[3] - widgetRect[1];
    const lines = [
      { text: 'Электронная подпись', size: 10, x: 8, y: height - 16 },
      { text: `Подписант: ${metadata.name}`, size: 7, x: 8, y: height - 30 },
      ...wrapText(metadata.name, 28).slice(1, 2).map((text, idx) => ({ text, size: 7, x: 8, y: height - 39 - idx * 8 })),
      { text: `Выдан: ${metadata.issuer}`, size: 7, x: 8, y: height - 49 },
      ...wrapText(metadata.issuer, 30).slice(1, 2).map((text, idx) => ({ text, size: 7, x: 8, y: height - 58 - idx * 8 })),
      { text: `ID: ${metadata.certId}`, size: 7, x: 8, y: 10 },
    ];

    const textOps = lines.map(({ text, size, x, y }) => {
      const encoded = font.encodeText(text).toString();
      return `BT /F0 ${size} Tf 0.10 0.18 0.40 rg 1 0 0 1 ${x} ${y} Tm ${encoded} Tj ET`;
    }).join('\n');

    const content = [
      'q',
      '0.18 0.36 0.78 RG',
      '0.97 0.98 1 rg',
      '1 w',
      `0.5 0.5 ${Math.max(width - 1, 1)} ${Math.max(height - 1, 1)} re B`,
      textOps,
      'Q',
    ].join('\n');

    const resources = pdfDoc.context.obj({
      Font: {
        F0: font.ref,
      },
    });

    const apStream = pdfDoc.context.flateStream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, width, height],
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: resources,
    });

    return pdfDoc.context.register(apStream);
  });
}

async function applyVisibleSignatureAppearance({ pdfDoc, widgetRect, metadata }) {
  const acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
  const fields = acroForm.lookup(PDFName.of('Fields'), PDFArray);
  const widgetRef = fields.get(fields.size() - 1);
  const widgetDict = pdfDoc.context.lookup(widgetRef);
  const rect = PDFArray.withContext(pdfDoc.context);
  widgetRect.forEach((value) => rect.push(PDFNumber.of(value)));
  widgetDict.set(PDFName.of('Rect'), rect);
  const apRef = await createAppearanceStream({ pdfDoc, widgetRect, metadata });
  widgetDict.set(PDFName.of('AP'), pdfDoc.context.obj({ N: apRef }));
}

function hasExistingSignature(source) {
  return /\/ByteRange\s*\[/.test(source.toString('latin1'));
}

function createPreparedPdfIncremental({ source, signer }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-signing-multisign-'));
  const inputPath = path.join(tempDir, 'input.pdf');
  const outputPath = path.join(tempDir, 'prepared.pdf');

  try {
    fs.writeFileSync(inputPath, source);
    const stdout = execFileSync('python3', [MULTISIGN_SCRIPT_PATH, inputPath, JSON.stringify(signer || {}), outputPath], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    const payload = JSON.parse(stdout.trim());
    const preparedPdf = fs.readFileSync(outputPath);
    return {
      preparedPdf,
      contentToSign: Buffer.from(payload.contentToSignBase64, 'base64'),
      byteRange: payload.byteRange,
      placeholderLength: payload.placeholderLength,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function createPreparedPdf({ sourcePath, sourceBuffer, signatureLength = DEFAULT_SIGNATURE_LENGTH, signer = {} }) {
  const source = sourceBuffer || fs.readFileSync(sourcePath);

  if (hasExistingSignature(source)) {
    return createPreparedPdfIncremental({ source, signer });
  }

  const pdfDoc = await PDFDocument.load(source);
  const metadata = buildSignatureMetadata(signer);
  const firstPage = pdfDoc.getPages()[0];
  const { width } = firstPage.getSize();
  const widgetRect = [
    width - STAMP_WIDTH - STAMP_MARGIN,
    STAMP_MARGIN,
    width - STAMP_MARGIN,
    STAMP_MARGIN + STAMP_HEIGHT,
  ];

  pdflibAddPlaceholder({
    pdfDoc,
    reason: metadata.reason,
    contactInfo: metadata.contactInfo,
    name: metadata.name,
    location: 'Web UI',
    signatureLength,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    widgetRect,
    appName: 'pdf-signing-demo',
  });

  await applyVisibleSignatureAppearance({ pdfDoc, widgetRect, metadata });

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
