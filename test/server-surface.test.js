const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { after, before, test } = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BASE_PATH = '/pdf-signing/';

let serverProcess;
let baseUrl;
let tempDir;
let testConfigPath;

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
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Server startup timed out. ${stderr}`));
    }, 10000);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('pdf-signing-demo listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited during startup with code ${code}. ${stderr}`));
    });
  });
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-signing-surface-'));
  testConfigPath = path.join(tempDir, 'stamp-config.json');
  fs.copyFileSync(path.join(PROJECT_ROOT, 'config', 'stamp-config.json'), testConfigPath);

  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}${BASE_PATH}`;
  serverProcess = spawn(process.execPath, ['src/server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      BASE_PATH,
      PORT: String(port),
      STAMP_CONFIG_PATH: testConfigPath,
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
  fs.rmSync(tempDir, { recursive: true, force: true });
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
      signer: {
        subjectName: 'CN=Surface Test',
        issuerName: 'CN=Surface Test',
        thumbprint: 'SURFACE-TEST',
        serialNumber: '01',
        validToDate: '2030-01-01T00:00:00Z',
      },
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.sessionId, 'string');
  assert.equal(Buffer.from(payload.contentToSignBase64, 'base64').length > 0, true);
  assert.equal(payload.byteRange.length, 4);
});

test('liveness and readiness are available only through the production base path', async () => {
  const liveResponse = await fetch(new URL('health/live', baseUrl));
  assert.equal(liveResponse.status, 200);
  assert.deepEqual(await liveResponse.json(), {
    ok: true,
    service: 'pdf-signing-demo',
  });

  const readyResponse = await fetch(new URL('health/ready', baseUrl));
  assert.equal(readyResponse.status, 200);
  assert.deepEqual(await readyResponse.json(), {
    ok: true,
    service: 'pdf-signing-demo',
    checks: {
      python: true,
      config: true,
      storage: true,
    },
  });

  const rootHealth = await fetch(new URL('/health', baseUrl));
  assert.equal(rootHealth.status, 404);
});
