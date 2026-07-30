const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runIsolatedProcess } = require('../runtime/process-runner');

const PREPARE_PYHANKO_SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'prepare-pyhanko.py');
const DEFAULT_SIGNATURE_LENGTH = 16000;

function findLastByteRange(pdf) {
  const matches = [...pdf.toString('latin1').matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  if (!matches.length) {
    throw new Error('ByteRange not found');
  }
  const last = matches[matches.length - 1];
  return last.slice(1).map((value) => Number(value));
}

async function createPreparedPdfWithPyhanko({
  source,
  signer,
  stampConfig,
  requestedStampPosition,
  signal,
}) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf-signing-pyhanko-'));
  await fsp.chmod(tempDir, 0o700);
  const inputPath = path.join(tempDir, 'input.pdf');
  const outputPath = path.join(tempDir, 'prepared.pdf');
  const tempConfigPath = stampConfig ? path.join(tempDir, 'stamp-config.json') : null;

  try {
    await fsp.writeFile(inputPath, source, { mode: 0o600 });
    if (tempConfigPath) {
      const effectiveConfig = {
        ...stampConfig,
        ...(requestedStampPosition ? { requestedStampPosition } : {}),
      };
      await fsp.writeFile(
        tempConfigPath,
        `${JSON.stringify(effectiveConfig, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    }
    await runIsolatedProcess(
      'python3',
      [PREPARE_PYHANKO_SCRIPT_PATH, inputPath, JSON.stringify(signer || {}), outputPath],
      {
        cwd: tempDir,
        signal,
        timeoutMs: 30000,
        maxBuffer: 20 * 1024 * 1024,
        env: tempConfigPath ? { STAMP_CONFIG_PATH: tempConfigPath } : {},
      },
    );

    const preparedPdf = await fsp.readFile(outputPath);
    const byteRange = findLastByteRange(preparedPdf);
    const placeholderLength = byteRange[2] - byteRange[1] - 2;
    const contentToSign = Buffer.concat([
      preparedPdf.slice(0, byteRange[1]),
      preparedPdf.slice(byteRange[2], byteRange[2] + byteRange[3]),
    ]);

    return {
      preparedPdf,
      contentToSign,
      byteRange,
      placeholderLength,
      placeholderPos: byteRange[1],
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function createPreparedPdf({
  sourcePath,
  sourceBuffer,
  signer = {},
  stampConfig = null,
  requestedStampPosition = null,
  signal = null,
}) {
  const source = sourceBuffer || await fsp.readFile(sourcePath);
  return createPreparedPdfWithPyhanko({
    source,
    signer,
    stampConfig,
    requestedStampPosition,
    signal,
  });
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
