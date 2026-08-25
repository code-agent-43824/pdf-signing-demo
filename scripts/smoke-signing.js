#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const baseUrl = new URL(process.argv[2] || process.env.SMOKE_BASE_URL || '');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-signing-smoke-'));

function run(command, args) {
  return execFileSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function expectOk(response, label) {
  const body = await response.text();
  assert.equal(response.ok, true, `${label}: HTTP ${response.status}: ${body}`);
  return body;
}

async function postJson(relativeUrl, body) {
  return fetch(new URL(relativeUrl, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function fetchPdf(relativeUrl, label) {
  const response = await fetch(new URL(relativeUrl, baseUrl));
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.ok, true, `${label}: HTTP ${response.status}`);
  assert.equal(body.subarray(0, 5).toString(), '%PDF-', `${label}: not a PDF`);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  return body;
}

async function main() {
  const certPath = path.join(tempDir, 'smoke-cert.pem');
  const keyPath = path.join(tempDir, 'smoke-key.pem');
  const certDerPath = path.join(tempDir, 'smoke-cert.der');
  const contentPath = path.join(tempDir, 'content.bin');
  const cmsPath = path.join(tempDir, 'signature.der');
  const signedPdfPath = path.join(tempDir, 'signed.pdf');

  run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-subj', '/CN=PDF Signing Deployment Smoke',
    '-keyout', keyPath, '-out', certPath, '-days', '2',
  ]);
  run('openssl', [
    'x509', '-in', certPath, '-outform', 'DER', '-out', certDerPath,
  ]);

  const ready = JSON.parse(await expectOk(
    await fetch(new URL('health/ready', baseUrl)),
    'readiness',
  ));
  assert.equal(ready.ok, true);

  const prepare = JSON.parse(await expectOk(
    await postJson('api/sign/prepare', {
      signer: { certificateBase64: fs.readFileSync(certDerPath).toString('base64') },
    }),
    'prepare',
  ));
  assert.equal(prepare.ok, true);
  fs.writeFileSync(contentPath, Buffer.from(prepare.contentToSignBase64, 'base64'));
  run('python3', [
    path.join('test', 'create_cms.py'),
    contentPath,
    certPath,
    keyPath,
    cmsPath,
  ]);

  const complete = JSON.parse(await expectOk(
    await postJson('api/sign/complete', {
      sessionId: prepare.sessionId,
      cmsSignatureBase64: fs.readFileSync(cmsPath).toString('base64'),
    }),
    'complete',
  ));
  assert.equal(complete.verification.integrity.status, 'valid');
  assert.equal(complete.verification.trust.status, 'not_checked');
  assert.equal(complete.verification.qualified.status, 'not_checked');

  const preview1 = await fetchPdf(complete.signedPdfUrl, 'preview 1');
  const preview2 = await fetchPdf(complete.signedPdfUrl, 'preview 2');
  const download1 = await fetchPdf(complete.downloadUrl, 'download 1');
  const download2 = await fetchPdf(complete.downloadUrl, 'download 2');
  const hashes = [preview1, preview2, download1, download2]
    .map((payload) => crypto.createHash('sha256').update(payload).digest('hex'));
  assert.equal(new Set(hashes).size, 1, 'preview/download payloads differ');

  fs.writeFileSync(signedPdfPath, download1);
  const validation = JSON.parse(run('python3', [
    path.join('test', 'validate_pdf.py'),
    signedPdfPath,
    certPath,
  ]));
  assert.equal(validation.ok, true);
  assert.equal(validation.signatures.length, 1);
  assert.equal(validation.signatures[0].coverage, 'ENTIRE_FILE');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    sha256: hashes[0],
    verification: {
      integrity: complete.verification.integrity.status,
      trust: complete.verification.trust.status,
      qualified: complete.verification.qualified.status,
    },
    pdfValidation: validation.signatures[0],
  })}\n`);
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
