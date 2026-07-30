const Ajv = require('ajv');
const { PDFDocument } = require('pdf-lib');

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_CMS_BYTES = 128 * 1024;
const MAX_PDF_PAGES = 200;
const MAX_PAGE_DIMENSION = 14400;
const MAX_STAMP_PIXELS = 4096 * 4096;
const MAX_BASE64_PDF_LENGTH = 14 * 1024 * 1024;
const MAX_BASE64_CMS_LENGTH = 256 * 1024;
const FONT_ID_PATTERN = '^font-[0-9a-f]{16}$';
const COLOR_PATTERN = '^#[0-9A-Fa-f]{6}$';

class HttpError extends Error {
  constructor(status, code, publicMessage, details = null) {
    super(publicMessage);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
    this.details = details;
  }
}

const boundedInteger = (minimum, maximum) => ({
  type: 'integer',
  minimum,
  maximum,
});

const boundedNumber = (minimum, maximum) => ({
  type: 'number',
  minimum,
  maximum,
});

const boundedString = (maxLength, minLength = 0) => ({
  type: 'string',
  minLength,
  maxLength,
});

const stampConfigSchema = {
  $id: 'https://pdf-signing-demo.local/schemas/stamp-config.json',
  type: 'object',
  additionalProperties: false,
  required: ['appearance', 'content', 'signatureObject', 'placements', 'limits'],
  properties: {
    appearance: {
      type: 'object',
      additionalProperties: false,
      required: [
        'width',
        'height',
        'imageScale',
        'backgroundColor',
        'borderColor',
        'borderWidth',
        'borderRadius',
        'textColor',
        'separator',
        'fonts',
        'layout',
      ],
      properties: {
        width: boundedInteger(80, 1200),
        height: boundedInteger(40, 1200),
        imageScale: boundedInteger(1, 8),
        backgroundColor: { type: 'string', pattern: COLOR_PATTERN },
        borderColor: { type: 'string', pattern: COLOR_PATTERN },
        borderWidth: boundedInteger(0, 16),
        borderRadius: boundedInteger(0, 48),
        textColor: { type: 'string', pattern: COLOR_PATTERN },
        separator: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled', 'y', 'left', 'right', 'color', 'width'],
          properties: {
            enabled: { type: 'boolean' },
            y: boundedInteger(0, 1200),
            left: boundedInteger(0, 1200),
            right: boundedInteger(0, 1200),
            color: { type: 'string', pattern: COLOR_PATTERN },
            width: boundedInteger(1, 12),
          },
        },
        fonts: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'label', 'value'],
          properties: {
            title: { $ref: '#/$defs/font' },
            label: { $ref: '#/$defs/font' },
            value: { $ref: '#/$defs/font' },
          },
        },
        layout: {
          type: 'object',
          additionalProperties: false,
          required: [
            'contentLeft',
            'contentRight',
            'startY',
            'titleLineHeight',
            'afterTitleGap',
            'rowLabelGap',
            'rowExtraGap',
            'valueLineHeight',
            'defaultMaxLines',
          ],
          properties: {
            contentLeft: boundedInteger(0, 1200),
            contentRight: boundedInteger(0, 1200),
            startY: boundedInteger(0, 1200),
            titleLineHeight: boundedInteger(0, 1200),
            afterTitleGap: boundedInteger(0, 1200),
            rowLabelGap: boundedInteger(0, 1200),
            rowExtraGap: boundedInteger(0, 1200),
            valueLineHeight: boundedInteger(0, 1200),
            defaultMaxLines: boundedInteger(1, 20),
          },
        },
      },
    },
    content: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'rows'],
      properties: {
        title: {
          type: 'array',
          maxItems: 8,
          items: boundedString(256),
        },
        rows: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'value', 'maxLines', 'breakAnywhere'],
            properties: {
              label: boundedString(256),
              value: boundedString(1024),
              maxLines: boundedInteger(1, 20),
              breakAnywhere: { type: 'boolean' },
            },
          },
        },
      },
    },
    signatureObject: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'reason', 'contactInfo', 'location', 'bytesReserved', 'subfilter'],
      properties: {
        name: boundedString(1024),
        reason: boundedString(1024),
        contactInfo: boundedString(1024),
        location: boundedString(1024),
        bytesReserved: boundedInteger(4096, 262144),
        subfilter: {
          type: 'string',
          enum: ['PADES', 'adbe.pkcs7.detached'],
        },
      },
    },
    placements: {
      type: 'object',
      additionalProperties: false,
      required: ['rules'],
      properties: {
        rules: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: { $ref: '#/$defs/placementRule' },
        },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: ['maxSignatures'],
      properties: {
        maxSignatures: boundedInteger(1, 20),
      },
    },
  },
  $defs: {
    font: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'size'],
      properties: {
        path: {
          type: 'string',
          pattern: FONT_ID_PATTERN,
        },
        size: boundedInteger(8, 72),
      },
    },
    pages: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'widgetPageMode'],
      allOf: [
        {
          if: {
            properties: { mode: { const: 'single' } },
            required: ['mode'],
          },
          then: {
            properties: { page: true },
            required: ['page'],
          },
        },
        {
          if: {
            properties: { mode: { const: 'range' } },
            required: ['mode'],
          },
          then: {
            properties: { start: true, end: true },
            required: ['start', 'end'],
          },
        },
        {
          if: {
            properties: { mode: { const: 'list' } },
            required: ['mode'],
          },
          then: {
            properties: { pages: true },
            required: ['pages'],
          },
        },
      ],
      properties: {
        mode: {
          type: 'string',
          enum: ['single', 'all', 'range', 'list'],
        },
        page: boundedInteger(1, MAX_PDF_PAGES),
        start: boundedInteger(1, MAX_PDF_PAGES),
        end: boundedInteger(1, MAX_PDF_PAGES),
        pages: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_PDF_PAGES,
          uniqueItems: true,
          items: boundedInteger(1, MAX_PDF_PAGES),
        },
        widgetPageMode: {
          type: 'string',
          enum: ['first', 'last'],
        },
      },
    },
    placement: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      allOf: [
        {
          if: {
            properties: {
              mode: { enum: ['absolute', 'fixed'] },
            },
            required: ['mode'],
          },
          then: {
            properties: { x: true, y: true },
            required: ['x', 'y'],
          },
        },
        {
          if: {
            properties: {
              mode: { enum: ['anchored', 'grid'] },
            },
            required: ['mode'],
          },
          then: {
            properties: {
              anchor: true,
              offsetX: true,
              offsetY: true,
            },
            required: ['anchor', 'offsetX', 'offsetY'],
          },
        },
        {
          if: {
            properties: { mode: { const: 'grid' } },
            required: ['mode'],
          },
          then: {
            properties: {
              columns: true,
              stepX: true,
              stepY: true,
            },
            required: ['columns', 'stepX', 'stepY'],
          },
        },
      ],
      properties: {
        mode: {
          type: 'string',
          enum: ['absolute', 'fixed', 'anchored', 'grid'],
        },
        anchor: {
          type: 'string',
          enum: [
            'bottom-left',
            'bottom-center',
            'bottom-right',
            'middle-left',
            'center',
            'middle-right',
            'top-left',
            'top-center',
            'top-right',
          ],
        },
        x: boundedNumber(-20000, 20000),
        y: boundedNumber(-20000, 20000),
        offsetX: boundedNumber(-20000, 20000),
        offsetY: boundedNumber(-20000, 20000),
        columns: boundedInteger(1, 20),
        stepX: boundedNumber(-20000, 20000),
        stepY: boundedNumber(-20000, 20000),
      },
    },
    match: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        signatureIndex: boundedInteger(1, 20),
        signatureIndexes: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
          items: boundedInteger(1, 20),
        },
        signatureIndexFrom: boundedInteger(1, 20),
        signatureIndexTo: boundedInteger(1, 20),
      },
    },
    placementRule: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'pages', 'placement'],
      properties: {
        name: boundedString(128),
        match: { $ref: '#/$defs/match' },
        pages: { $ref: '#/$defs/pages' },
        placement: { $ref: '#/$defs/placement' },
      },
    },
  },
};

const signerSchema = {
  $id: 'https://pdf-signing-demo.local/schemas/signer.json',
  type: 'object',
  additionalProperties: false,
  properties: {
    subjectName: boundedString(4096),
    issuerName: boundedString(4096),
    thumbprint: boundedString(256),
    serialNumber: boundedString(256),
    validToDate: boundedString(128),
  },
};

const prepareSchema = {
  $id: 'https://pdf-signing-demo.local/schemas/prepare.json',
  type: 'object',
  additionalProperties: false,
  required: ['signer'],
  properties: {
    pdfBase64: boundedString(MAX_BASE64_PDF_LENGTH, 4),
    stampConfig: { $ref: stampConfigSchema.$id },
    requestedStampPosition: {
      type: 'string',
      enum: ['left', 'center-left', 'center-right', 'right'],
    },
    signer: { $ref: signerSchema.$id },
  },
};

const completeSchema = {
  $id: 'https://pdf-signing-demo.local/schemas/complete.json',
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'cmsSignatureBase64'],
  properties: {
    sessionId: {
      type: 'string',
      maxLength: 64,
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
    cmsSignatureBase64: boundedString(MAX_BASE64_CMS_LENGTH, 4),
  },
};

const ajv = new Ajv({
  allErrors: true,
  strict: true,
});
ajv.addSchema(stampConfigSchema);
ajv.addSchema(signerSchema);
const validatePrepareSchema = ajv.compile(prepareSchema);
const validateCompleteSchema = ajv.compile(completeSchema);
const validateStampConfigSchema = ajv.getSchema(stampConfigSchema.$id);

function assertSchema(validator, value, label) {
  if (!validator(value)) {
    throw new HttpError(
      400,
      'INVALID_REQUEST',
      'Некорректный запрос.',
      {
        label,
        errors: validator.errors,
      },
    );
  }
}

function decodeStrictBase64(value, maxBytes, label) {
  if (!isStrictBase64(value)) {
    throw new HttpError(
      400,
      'INVALID_BASE64',
      'Некорректный запрос.',
      { label },
    );
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > maxBytes) {
    throw new HttpError(
      413,
      'PAYLOAD_TOO_LARGE',
      'Размер данных превышает допустимый лимит.',
      { label, decodedBytes: decoded.length, maxBytes },
    );
  }
  return decoded;
}

function isStrictBase64(value) {
  if (!value || value.length % 4 !== 0) {
    return false;
  }

  let contentLength = value.length;
  let padding = 0;
  while (contentLength > 0 && value.charCodeAt(contentLength - 1) === 61) {
    contentLength -= 1;
    padding += 1;
  }
  if (padding > 2) {
    return false;
  }
  if (
    (padding === 0 && contentLength % 4 !== 0)
    || (padding === 1 && contentLength % 4 !== 3)
    || (padding === 2 && contentLength % 4 !== 2)
  ) {
    return false;
  }

  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (
      (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47
    );
    if (!valid) return false;
  }
  return true;
}

function validateStampConfig(config) {
  assertSchema(validateStampConfigSchema, config, 'stampConfig');

  const { width, height, imageScale } = config.appearance;
  const renderedWidth = width * imageScale;
  const renderedHeight = height * imageScale;
  if (
    renderedWidth > 4096
    || renderedHeight > 4096
    || renderedWidth * renderedHeight > MAX_STAMP_PIXELS
  ) {
    throw new HttpError(
      400,
      'STAMP_TOO_LARGE',
      'Некорректная конфигурация штампа.',
      { renderedWidth, renderedHeight, maxPixels: MAX_STAMP_PIXELS },
    );
  }

  for (const [index, rule] of config.placements.rules.entries()) {
    const match = rule.match;
    if (
      match?.signatureIndexFrom
      && match?.signatureIndexTo
      && match.signatureIndexTo < match.signatureIndexFrom
    ) {
      throw new HttpError(
        400,
        'INVALID_STAMP_RULE',
        'Некорректная конфигурация штампа.',
        { rule: index, reason: 'signature index range is reversed' },
      );
    }
  }
}

function validatePrepareBody(body) {
  assertSchema(validatePrepareSchema, body, 'prepare');
  if (Object.values(body.signer).some((value) => value.includes('\0'))) {
    throw new HttpError(
      400,
      'INVALID_SIGNER',
      'Некорректные данные сертификата.',
      { reason: 'NUL byte in signer metadata' },
    );
  }
  if (body.stampConfig) {
    validateStampConfig(body.stampConfig);
  }
}

function validateCompleteBody(body) {
  assertSchema(validateCompleteSchema, body, 'complete');
}

function validateStampConfigForDocument(config, pageCount) {
  if (!config) return;

  for (const [index, rule] of config.placements.rules.entries()) {
    const pages = rule.pages;
    const referencedPages = [];
    if (pages.mode === 'single') {
      referencedPages.push(pages.page);
    } else if (pages.mode === 'range') {
      if (pages.end < pages.start) {
        throw new HttpError(
          400,
          'INVALID_PAGE_RANGE',
          'Некорректная конфигурация страниц штампа.',
          { rule: index, start: pages.start, end: pages.end },
        );
      }
      referencedPages.push(pages.start, pages.end);
    } else if (pages.mode === 'list') {
      referencedPages.push(...pages.pages);
    }

    if (referencedPages.some((page) => page > pageCount)) {
      throw new HttpError(
        400,
        'STAMP_PAGE_OUT_OF_RANGE',
        'Настройки штампа ссылаются на отсутствующую страницу PDF.',
        { rule: index, pageCount, referencedPages },
      );
    }
  }
}

function decodePdfBase64(value) {
  return decodeStrictBase64(value, MAX_PDF_BYTES, 'pdfBase64');
}

function decodeCmsBase64(value) {
  return decodeStrictBase64(value, MAX_CMS_BYTES, 'cmsSignatureBase64');
}

async function validatePdfBuffer(pdf) {
  if (pdf.length > MAX_PDF_BYTES) {
    throw new HttpError(
      413,
      'PDF_TOO_LARGE',
      'Размер PDF превышает допустимый лимит.',
      { decodedBytes: pdf.length, maxBytes: MAX_PDF_BYTES },
    );
  }
  if (pdf.length < 5 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new HttpError(
      400,
      'INVALID_PDF',
      'Передан некорректный PDF-документ.',
    );
  }

  let document;
  try {
    document = await PDFDocument.load(pdf, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
  } catch (error) {
    throw new HttpError(
      400,
      'INVALID_PDF',
      'Передан некорректный PDF-документ.',
      { parserError: error.message },
    );
  }

  const pages = document.getPages();
  if (pages.length < 1 || pages.length > MAX_PDF_PAGES) {
    throw new HttpError(
      400,
      'PDF_PAGE_LIMIT',
      'PDF-документ превышает допустимое число страниц.',
      { pages: pages.length, maxPages: MAX_PDF_PAGES },
    );
  }

  pages.forEach((page, index) => {
    const width = page.getWidth();
    const height = page.getHeight();
    if (
      !Number.isFinite(width)
      || !Number.isFinite(height)
      || width <= 0
      || height <= 0
      || width > MAX_PAGE_DIMENSION
      || height > MAX_PAGE_DIMENSION
    ) {
      throw new HttpError(
        400,
        'PDF_PAGE_DIMENSIONS',
        'PDF-документ содержит неподдерживаемый размер страницы.',
        { page: index + 1, width, height, maxDimension: MAX_PAGE_DIMENSION },
      );
    }
  });

  return {
    bytes: pdf.length,
    pages: pages.length,
  };
}

module.exports = {
  HttpError,
  MAX_CMS_BYTES,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  decodeCmsBase64,
  decodePdfBase64,
  validateCompleteBody,
  validatePdfBuffer,
  validatePrepareBody,
  validateStampConfig,
  validateStampConfigForDocument,
};
