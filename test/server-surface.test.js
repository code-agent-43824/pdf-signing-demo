const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { after, before, test } = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BASE_PATH = '/pdf-signing/';

let serverProcess;
let serverPort;
let baseUrl;
let tempDir;
let testConfigPath;
let testCertPath;
let testKeyPath;
let testCertificateBase64;
let otherCertPath;
let otherKeyPath;
let publicLeakProbePath;
let testResultsDir;
let serverStderr = '';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Server startup timed out. ${serverStderr}`));
    }, 10000);

    child.stderr.on('data', (chunk) => {
      serverStderr += chunk.toString();
    });
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('pdf-signing-demo listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited during startup with code ${code}. ${serverStderr}`));
    });
  });
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-signing-surface-'));
  testConfigPath = path.join(tempDir, 'stamp-config.json');
  fs.copyFileSync(path.join(PROJECT_ROOT, 'config', 'stamp-config.json'), testConfigPath);
  testResultsDir = path.join(tempDir, 'results');
  fs.mkdirSync(testResultsDir);
  const publicGeneratedDir = path.join(PROJECT_ROOT, 'public', 'generated');
  fs.mkdirSync(publicGeneratedDir, { recursive: true });
  publicLeakProbePath = path.join(
    publicGeneratedDir,
    `surface-leak-probe-${process.pid}.pdf`,
  );
  fs.writeFileSync(publicLeakProbePath, '%PDF-public-leak-probe');
  testCertPath = path.join(tempDir, 'surface-cert.pem');
  testKeyPath = path.join(tempDir, 'surface-key.pem');
  const testCertDerPath = path.join(tempDir, 'surface-cert.der');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=PDF Signing Surface Test Signer',
    '-keyout',
    testKeyPath,
    '-out',
    testCertPath,
    '-days',
    '2',
  ], { stdio: 'ignore' });
  execFileSync('openssl', [
    'x509',
    '-in',
    testCertPath,
    '-outform',
    'DER',
    '-out',
    testCertDerPath,
  ]);
  testCertificateBase64 = fs.readFileSync(testCertDerPath).toString('base64');
  otherCertPath = path.join(tempDir, 'other-cert.pem');
  otherKeyPath = path.join(tempDir, 'other-key.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=Unexpected Surface Test Signer',
    '-keyout',
    otherKeyPath,
    '-out',
    otherCertPath,
    '-days',
    '2',
  ], { stdio: 'ignore' });

  serverPort = await reservePort();
  baseUrl = `http://127.0.0.1:${serverPort}${BASE_PATH}`;
  serverProcess = spawn(process.execPath, ['src/server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      BASE_PATH,
      PORT: String(serverPort),
      STAMP_CONFIG_PATH: testConfigPath,
      RESULTS_DIR: testResultsDir,
      PREPARE_RATE_LIMIT: '1000',
      COMPLETE_RATE_LIMIT: '1000',
      SIGNING_CONCURRENCY: '1',
      SIGNING_MAX_QUEUE: '1',
      SIGNING_MAX_SESSIONS: '128',
      SIGNING_MAX_SESSIONS_PER_IP: '32',
      SIGNING_SESSION_MEMORY_BYTES: String(256 * 1024 * 1024),
      SIGNING_RESULT_TTL_MS: '1000',
      STORAGE_CLEANUP_INTERVAL_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(serverProcess);
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await new Promise((resolve) => serverProcess.once('exit', resolve));
  }
  if (publicLeakProbePath) fs.rmSync(publicLeakProbePath, { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validSigner() {
  return { certificateBase64: testCertificateBase64 };
}

function createTestCms(content, label, {
  certPath = testCertPath,
  keyPath = testKeyPath,
} = {}) {
  const contentPath = path.join(tempDir, `${label}.bin`);
  const cmsPath = path.join(tempDir, `${label}.der`);
  fs.writeFileSync(contentPath, content);
  execFileSync('python3', [
    path.join(PROJECT_ROOT, 'test', 'create_cms.py'),
    contentPath,
    certPath,
    keyPath,
    cmsPath,
  ]);
  return fs.readFileSync(cmsPath);
}

async function postJson(relativePath, body) {
  return fetch(new URL(relativePath, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function assertSafeError(response, status, code, stage = null) {
  assert.equal(response.status, status);
  assert.equal(response.headers.has('x-powered-by'), false);
  const requestId = response.headers.get('x-request-id');
  assert.match(requestId, /^[0-9a-f-]{36}$/);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.code, code);
  assert.equal(payload.requestId, requestId);
  if (stage) assert.equal(payload.stage, stage);
  assert.equal(typeof payload.message, 'string');
  assert.equal(/\/(?:tmp|home|usr|var)\//.test(JSON.stringify(payload)), false);
  assert.equal(Object.hasOwn(payload, 'details'), false);
  return payload;
}

function assertBrowserSecurityHeaders(response) {
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp);
  assert.match(csp, /(?:^|; )default-src 'self'(?:;|$)/);
  assert.match(csp, /(?:^|; )script-src 'self' chrome-extension:(?:;|$)/);
  assert.match(csp, /(?:^|; )script-src-attr 'none'(?:;|$)/);
  assert.match(csp, /(?:^|; )frame-ancestors 'none'(?:;|$)/);
  assert.match(csp, /(?:^|; )object-src 'self'(?:;|$)/);
  assert.doesNotMatch(
    csp.match(/(?:^|; )script-src ([^;]+)/)?.[1] || '',
    /'unsafe-inline'|'unsafe-eval'|https?:/,
  );
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('permissions-policy') || '', /camera=\(\)/);
  assert.match(response.headers.get('permissions-policy') || '', /usb=\(\)/);
  assert.equal(
    response.headers.get('cache-control'),
    'no-store, private, max-age=0',
  );
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('expires'), '0');
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

test('browser security policy is enforcing on UI, API and health responses', async () => {
  const responses = await Promise.all([
    fetch(baseUrl),
    fetch(new URL('app.js', baseUrl)),
    fetch(new URL('api/stamp-config', baseUrl)),
    fetch(new URL('health/live', baseUrl)),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assertBrowserSecurityHeaders(response);
  }
});

test('stamp configuration is read-only and does not disclose server paths', async () => {
  const beforeConfig = fs.readFileSync(testConfigPath);
  const getResponse = await fetch(new URL('api/stamp-config', baseUrl));
  assert.equal(getResponse.status, 200);
  const payload = await getResponse.json();
  assert.equal(payload.ok, true);
  assert.equal(Object.hasOwn(payload, 'configPath'), false);

  for (const role of ['title', 'label', 'value']) {
    const fontId = payload.config.appearance.fonts[role].path;
    assert.match(fontId, /^font-[0-9a-f]{16}$/);
    assert.equal(path.isAbsolute(fontId), false);
  }

  const postResponse = await fetch(new URL('api/stamp-config', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: { overwritten: true } }),
  });
  assert.equal(postResponse.status, 404);
  assert.deepEqual(fs.readFileSync(testConfigPath), beforeConfig);
});

test('font API exposes opaque identifiers rather than filesystem paths', async () => {
  const response = await fetch(new URL('api/fonts', baseUrl));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.ok(payload.fonts.length > 0);
  for (const font of payload.fonts) {
    assert.deepEqual(Object.keys(font).sort(), ['id', 'label']);
    assert.match(font.id, /^font-[0-9a-f]{16}$/);
  }
});

test('client-facing font identifiers resolve during PDF preparation', async () => {
  const configResponse = await fetch(new URL('api/stamp-config', baseUrl));
  const { config } = await configResponse.json();
  const pdfBase64 = fs.readFileSync(
    path.join(PROJECT_ROOT, 'test', 'fixtures', 'pdf', 'simple.pdf'),
  ).toString('base64');

  const response = await fetch(new URL('api/sign/prepare', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pdfBase64,
      stampConfig: config,
      signer: validSigner(),
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.sessionId, 'string');
  assert.equal(Buffer.from(payload.contentToSignBase64, 'base64').length > 0, true);
  assert.equal(payload.byteRange.length, 4);
});

test('prepare rejects unknown fields, paths and extreme stamp settings', async () => {
  const configResponse = await fetch(new URL('api/stamp-config', baseUrl));
  const { config } = await configResponse.json();
  const pdfBase64 = fs.readFileSync(
    path.join(PROJECT_ROOT, 'test', 'fixtures', 'pdf', 'simple.pdf'),
  ).toString('base64');
  const validBody = {
    pdfBase64,
    stampConfig: config,
    signer: validSigner(),
  };

  await assertSafeError(
    await postJson('api/sign/prepare', { ...validBody, unexpected: true }),
    400,
    'INVALID_REQUEST',
    'prepare',
  );

  const pathConfig = clone(config);
  pathConfig.appearance.fonts.title.path = '/etc/passwd';
  await assertSafeError(
    await postJson('api/sign/prepare', { ...validBody, stampConfig: pathConfig }),
    400,
    'INVALID_REQUEST',
    'prepare',
  );

  const hugeStampConfig = clone(config);
  hugeStampConfig.appearance.width = 1200;
  hugeStampConfig.appearance.height = 1200;
  hugeStampConfig.appearance.imageScale = 8;
  await assertSafeError(
    await postJson('api/sign/prepare', { ...validBody, stampConfig: hugeStampConfig }),
    400,
    'STAMP_TOO_LARGE',
    'prepare',
  );
});

test('stamp, signer and placement limits reject every bounded field class', async () => {
  const configResponse = await fetch(new URL('api/stamp-config', baseUrl));
  const { config } = await configResponse.json();
  const pdfBase64 = fs.readFileSync(
    path.join(PROJECT_ROOT, 'test', 'fixtures', 'pdf', 'simple.pdf'),
  ).toString('base64');

  const cases = [
    {
      name: 'unknown signer field',
      signer: { unexpected: true },
      mutate: () => {},
    },
    {
      name: 'oversized certificate',
      signer: { certificateBase64: 'A'.repeat((128 * 1024) + 4) },
      mutate: () => {},
    },
    {
      name: 'font size',
      signer: validSigner(),
      mutate: (draft) => { draft.appearance.fonts.title.size = 73; },
    },
    {
      name: 'row count',
      signer: validSigner(),
      mutate: (draft) => {
        draft.content.rows = Array.from(
          { length: 21 },
          () => ({
            label: 'label',
            value: 'value',
            maxLines: 1,
            breakAnywhere: false,
          }),
        );
      },
    },
    {
      name: 'CMS reservation',
      signer: validSigner(),
      mutate: (draft) => { draft.signatureObject.bytesReserved = 262145; },
    },
    {
      name: 'placement coordinate',
      signer: validSigner(),
      mutate: (draft) => { draft.placements.rules[0].placement.offsetX = 20001; },
    },
    {
      name: 'signature count',
      signer: validSigner(),
      mutate: (draft) => { draft.limits.maxSignatures = 21; },
    },
    {
      name: 'configured page number',
      signer: validSigner(),
      mutate: (draft) => {
        draft.placements.rules[0].pages = {
          mode: 'single',
          page: 201,
          widgetPageMode: 'first',
        };
      },
    },
  ];

  for (const item of cases) {
    const stampConfig = clone(config);
    item.mutate(stampConfig);
    const response = await postJson('api/sign/prepare', {
      pdfBase64,
      stampConfig,
      signer: item.signer,
    });
    await assertSafeError(response, 400, 'INVALID_REQUEST', 'prepare');
  }
});

test('prepare enforces strict base64, decoded size, magic bytes and page limits', async () => {
  await assertSafeError(
    await postJson('api/sign/prepare', {
      pdfBase64: '%%%not-base64%%%',
      signer: validSigner(),
    }),
    400,
    'INVALID_BASE64',
    'prepare',
  );

  await assertSafeError(
    await postJson('api/sign/prepare', {
      pdfBase64: Buffer.from('not a pdf').toString('base64'),
      signer: validSigner(),
    }),
    400,
    'INVALID_PDF',
    'prepare',
  );

  await assertSafeError(
    await postJson('api/sign/prepare', {
      pdfBase64: Buffer.alloc((10 * 1024 * 1024) + 1).toString('base64'),
      signer: validSigner(),
    }),
    413,
    'PAYLOAD_TOO_LARGE',
    'prepare',
  );

  const { PDFDocument } = require('pdf-lib');
  const tooManyPages = await PDFDocument.create();
  for (let index = 0; index < 201; index += 1) {
    tooManyPages.addPage([100, 100]);
  }
  await assertSafeError(
    await postJson('api/sign/prepare', {
      pdfBase64: Buffer.from(await tooManyPages.save()).toString('base64'),
      signer: validSigner(),
    }),
    400,
    'PDF_PAGE_LIMIT',
    'prepare',
  );

  const oversizedPage = await PDFDocument.create();
  oversizedPage.addPage([15000, 100]);
  await assertSafeError(
    await postJson('api/sign/prepare', {
      pdfBase64: Buffer.from(await oversizedPage.save()).toString('base64'),
      signer: validSigner(),
    }),
    400,
    'PDF_PAGE_DIMENSIONS',
    'prepare',
  );
});

test('prepare rejects stamp page references outside the uploaded document', async () => {
  const configResponse = await fetch(new URL('api/stamp-config', baseUrl));
  const { config } = await configResponse.json();
  config.placements.rules[0].pages = {
    mode: 'single',
    page: 2,
    widgetPageMode: 'first',
  };
  const pdfBase64 = fs.readFileSync(
    path.join(PROJECT_ROOT, 'test', 'fixtures', 'pdf', 'simple.pdf'),
  ).toString('base64');

  await assertSafeError(
    await postJson('api/sign/prepare', {
      pdfBase64,
      stampConfig: config,
      signer: validSigner(),
    }),
    400,
    'STAMP_PAGE_OUT_OF_RANGE',
    'prepare',
  );
});

test('bounded queue keeps health responsive and rejects overflow', async () => {
  const pdfBase64 = fs.readFileSync(
    path.join(PROJECT_ROOT, 'test', 'fixtures', 'pdf', 'simple.pdf'),
  ).toString('base64');
  const body = {
    pdfBase64,
    signer: validSigner(),
  };
  const first = postJson('api/sign/prepare', body);
  const second = postJson('api/sign/prepare', body);

  let queueObserved = false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const ready = await fetch(new URL('health/ready', baseUrl));
    const readiness = await ready.json();
    if (readiness.workers?.active === 1 && readiness.workers?.queued === 1) {
      queueObserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(queueObserved, true);

  const healthStartedAt = performance.now();
  const liveResponse = await fetch(new URL('health/live', baseUrl));
  const healthDurationMs = performance.now() - healthStartedAt;
  assert.equal(liveResponse.status, 200);
  assert.ok(
    healthDurationMs < 250,
    `health endpoint was blocked for ${healthDurationMs.toFixed(1)} ms`,
  );

  await assertSafeError(
    await postJson('api/sign/prepare', body),
    503,
    'SERVER_BUSY',
    'prepare',
  );
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test('complete verifies CMS integrity, certificate binding and retry semantics', async () => {
  const pdfBase64 = fs.readFileSync(
    path.join(PROJECT_ROOT, 'test', 'fixtures', 'pdf', 'simple.pdf'),
  ).toString('base64');
  const prepareResponse = await postJson('api/sign/prepare', {
    pdfBase64,
    signer: validSigner(),
  });
  assert.equal(prepareResponse.status, 200);
  const prepared = await prepareResponse.json();
  const content = Buffer.from(prepared.contentToSignBase64, 'base64');

  const wrongContent = Buffer.from(content);
  wrongContent[0] ^= 0x01;
  const wrongDigestCms = createTestCms(wrongContent, 'wrong-digest');
  await assertSafeError(
    await postJson('api/sign/complete', {
      sessionId: prepared.sessionId,
      cmsSignatureBase64: wrongDigestCms.toString('base64'),
    }),
    400,
    'CMS_INTEGRITY_FAILED',
    'complete',
  );

  const wrongCertificateCms = createTestCms(content, 'wrong-certificate', {
    certPath: otherCertPath,
    keyPath: otherKeyPath,
  });
  await assertSafeError(
    await postJson('api/sign/complete', {
      sessionId: prepared.sessionId,
      cmsSignatureBase64: wrongCertificateCms.toString('base64'),
    }),
    400,
    'CMS_INTEGRITY_FAILED',
    'complete',
  );

  const validCms = createTestCms(content, 'valid-complete');
  const wrappedValidCmsBase64 = validCms
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\r\n');
  const completeResponse = await postJson('api/sign/complete', {
    sessionId: prepared.sessionId,
    cmsSignatureBase64: wrappedValidCmsBase64,
  });
  assert.equal(completeResponse.status, 200);
  const completed = await completeResponse.json();
  assert.deepEqual(completed.verification, {
    schemaVersion: 1,
    integrity: {
      status: 'valid',
      code: 'CMS_INTEGRITY_VALID',
      signaturesVerified: 1,
      signerCertificateMatched: true,
      digestAlgorithm: '2.16.840.1.101.3.4.2.1',
      signatureAlgorithm: '1.2.840.113549.1.1.11',
    },
    trust: {
      status: 'not_checked',
      code: 'CERTIFICATE_TRUST_NOT_CHECKED',
      checks: {
        chain: 'not_checked',
        validity: 'not_checked',
        revocation: 'not_checked',
        keyUsage: 'not_checked',
      },
    },
    qualified: {
      status: 'not_checked',
      code: 'QUALIFIED_STATUS_NOT_CHECKED',
      policy: null,
    },
  });
  assert.equal(Object.hasOwn(completed, 'integrity'), false);
  assert.match(completed.signedPdfUrl, /^\.\/api\/results\/[A-Za-z0-9_-]{43}$/);
  assert.match(completed.downloadUrl, /^\.\/api\/results\/[A-Za-z0-9_-]{43}$/);
  assert.notEqual(completed.signedPdfUrl, completed.downloadUrl);
  assert.ok(Date.parse(completed.resultExpiresAt) > Date.now());
  const signedPdfResponse = await fetch(
    new URL(completed.signedPdfUrl, baseUrl),
  );
  assert.equal(signedPdfResponse.status, 200);
  assert.equal(
    signedPdfResponse.headers.get('content-disposition'),
    'inline; filename="signed-formular.pdf"',
  );
  assert.match(
    signedPdfResponse.headers.get('cache-control'),
    /no-store/,
  );
  assert.equal(
    Buffer.from(await signedPdfResponse.arrayBuffer()).subarray(0, 5).toString(),
    '%PDF-',
  );
  const repeatedPreview = await fetch(
    new URL(completed.signedPdfUrl, baseUrl),
  );
  assert.equal(repeatedPreview.status, 200);
  await repeatedPreview.arrayBuffer();

  const downloadHead = await fetch(
    new URL(completed.downloadUrl, baseUrl),
    { method: 'HEAD' },
  );
  assert.equal(downloadHead.status, 405);
  const downloadResponse = await fetch(
    new URL(completed.downloadUrl, baseUrl),
    { headers: { range: 'bytes=0-9' } },
  );
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers.has('accept-ranges'), false);
  assert.equal(
    downloadResponse.headers.get('content-disposition'),
    'attachment; filename="signed-formular.pdf"',
  );
  assert.match(downloadResponse.headers.get('cache-control'), /no-store/);
  assert.equal(
    Buffer.from(await downloadResponse.arrayBuffer()).subarray(0, 5).toString(),
    '%PDF-',
  );
  await assertSafeError(
    await fetch(new URL(completed.downloadUrl, baseUrl)),
    404,
    'RESULT_NOT_FOUND',
    'download',
  );
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await assertSafeError(
    await fetch(new URL(completed.signedPdfUrl, baseUrl)),
    404,
    'RESULT_NOT_FOUND',
    'download',
  );
  assert.deepEqual(fs.readdirSync(testResultsDir), []);
  assert.equal(serverStderr.includes(completed.signedPdfUrl.slice(14)), false);
  assert.equal(serverStderr.includes(completed.downloadUrl.slice(14)), false);

  await assertSafeError(
    await postJson('api/sign/complete', {
      sessionId: prepared.sessionId,
      cmsSignatureBase64: validCms.toString('base64'),
    }),
    404,
    'SESSION_NOT_FOUND',
    'complete',
  );
});

test('legacy public generated files are not served by either static route', async () => {
  const response = await fetch(
    new URL(`generated/${path.basename(publicLeakProbePath)}`, baseUrl),
  );
  assert.equal(response.status, 404);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const payload = await response.json();
  assert.equal(payload.code, 'RESULT_NOT_FOUND');
});

test('prepare rejects malformed certificate DER before PDF preparation', async () => {
  const pdfBase64 = fs.readFileSync(
    path.join(PROJECT_ROOT, 'test', 'fixtures', 'pdf', 'simple.pdf'),
  ).toString('base64');
  await assertSafeError(
    await postJson('api/sign/prepare', {
      pdfBase64,
      signer: {
        certificateBase64: Buffer.from('not a certificate').toString('base64'),
      },
    }),
    400,
    'INVALID_SIGNER_CERTIFICATE',
    'prepare',
  );
});

test('complete has a strict schema and safe session errors', async () => {
  await assertSafeError(
    await postJson('api/sign/complete', {
      sessionId: 'not-a-session',
      cmsSignatureBase64: 'AAAA',
      unexpected: true,
    }),
    400,
    'INVALID_REQUEST',
    'complete',
  );

  await assertSafeError(
    await postJson('api/sign/complete', {
      sessionId: '00000000-0000-4000-8000-000000000000',
      cmsSignatureBase64: '%%%%',
    }),
    400,
    'INVALID_BASE64',
    'complete',
  );

  await assertSafeError(
    await postJson('api/sign/complete', {
      sessionId: '00000000-0000-4000-8000-000000000000',
      cmsSignatureBase64: 'AAAA',
    }),
    404,
    'SESSION_NOT_FOUND',
    'complete',
  );

  await assertSafeError(
    await postJson('api/sign/complete', {
      sessionId: '00000000-0000-4000-8000-000000000000',
      cmsSignatureBase64: 'AA\r\nAA',
    }),
    404,
    'SESSION_NOT_FOUND',
    'complete',
  );
});

test('malformed and oversized JSON receive fixed safe errors', async () => {
  const wrongContentType = await fetch(new URL('api/sign/prepare', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  });
  await assertSafeError(wrongContentType, 415, 'UNSUPPORTED_MEDIA_TYPE');

  const malformed = await fetch(new URL('api/sign/prepare', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"signer":',
  });
  await assertSafeError(malformed, 400, 'INVALID_JSON');

  const oversized = await fetch(new URL('api/sign/prepare', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(16 * 1024 * 1024) }),
  });
  await assertSafeError(oversized, 413, 'REQUEST_TOO_LARGE');
});

test('liveness and readiness are available only through the production base path', async () => {
  const liveResponse = await fetch(new URL('health/live', baseUrl));
  assert.equal(liveResponse.status, 200);
  assert.equal(liveResponse.headers.has('x-powered-by'), false);
  assert.deepEqual(await liveResponse.json(), {
    ok: true,
    service: 'pdf-signing-demo',
  });

  const readyResponse = await fetch(new URL('health/ready', baseUrl));
  assert.equal(readyResponse.status, 200);
  const ready = await readyResponse.json();
  assert.deepEqual({
    ok: ready.ok,
    service: ready.service,
    checks: ready.checks,
    workers: ready.workers,
  }, {
    ok: true,
    service: 'pdf-signing-demo',
    checks: {
      python: true,
      config: true,
      storage: true,
      workerLimits: true,
      workerQueue: true,
    },
    workers: {
      active: 0,
      queued: 0,
      concurrency: 1,
      maxQueue: 1,
    },
  });
  assert.equal(ready.storage.sessions.maxSessions, 128);
  assert.equal(ready.storage.sessions.maxSessionsPerOwner, 32);
  assert.equal(ready.storage.sessions.maxMemoryBytes, 256 * 1024 * 1024);
  assert.equal(ready.storage.results.maxResults, 32);
  assert.equal(ready.storage.results.maxDiskBytes, 128 * 1024 * 1024);

  const rootHealth = await fetch(new URL('/health', baseUrl));
  assert.equal(rootHealth.status, 404);
});

test('server socket is bound only to loopback', async (context) => {
  const externalAddress = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
  if (!externalAddress) {
    context.skip('No non-loopback IPv4 address is available in this environment.');
    return;
  }
  assert.equal(await canConnect(externalAddress, serverPort), false);
  assert.equal(await canConnect('127.0.0.1', serverPort), true);
});
