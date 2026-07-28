#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE_URL = 'https://mescheryakov.pro/pdf-signing/';

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    output: path.join(
      process.cwd(),
      'test',
      'baseline',
      'production-2026-07-28.json',
    ),
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--base-url') args.baseUrl = argv[++index];
    else if (argv[index] === '--output') args.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return args;
}

function sanitizeJson(relativePath, body) {
  const value = JSON.parse(body.toString('utf8'));
  if (relativePath === 'api/stamp-config') {
    delete value.configPath;
  }
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

async function captureEndpoint(baseUrl, relativePath, expectedStatus) {
  const url = new URL(relativePath, baseUrl);
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { 'user-agent': 'pdf-signing-demo-baseline/1.0' },
  });
  const rawBody = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? sanitizeJson(relativePath, rawBody)
    : rawBody;

  if (response.status !== expectedStatus) {
    throw new Error(`${url} returned ${response.status}; expected ${expectedStatus}`);
  }

  return {
    path: relativePath || '.',
    status: response.status,
    contentType,
    bodyBytes: body.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.baseUrl.endsWith('/') ? args.baseUrl : `${args.baseUrl}/`;
  const endpoints = [
    ['', 200],
    ['app.js', 200],
    ['api/form', 200],
    ['api/stamp-config', 200],
    ['health', 404],
  ];
  const results = [];
  for (const [relativePath, expectedStatus] of endpoints) {
    results.push(await captureEndpoint(baseUrl, relativePath, expectedStatus));
  }

  const payload = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    baseUrl,
    note: 'Read-only baseline. Absolute server paths are removed before hashing JSON.',
    endpoints: results,
  };
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(args.output);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
