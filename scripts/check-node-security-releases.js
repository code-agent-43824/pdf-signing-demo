#!/usr/bin/env node
'use strict';

// Weekly CI check: fails when nodejs.org lists a security release of the
// pinned major that is newer than .node-version. npm audit and pip-audit do
// not cover Node itself, which is how the pin once fell two security releases
// behind unnoticed (docs/JOURNAL.md, 2026-09-27). It runs only in scheduled
// and manual runs: on push a new Node release would block every commit until
// the server is upgraded (docs/SUPPLY_CHAIN.md, "Обновление Node").

const fs = require('node:fs');
const path = require('node:path');
const { parseNodeVersion } = require('./check-node-runtime');

const PIN_PATH = path.join(__dirname, '..', '.node-version');
const INDEX_URL = 'https://nodejs.org/dist/index.json';
const FETCH_TIMEOUT_MS = 30000;

function compareVersions(left, right) {
  const a = parseNodeVersion(left);
  const b = parseNodeVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

// `releases` has the shape of nodejs.org/dist/index.json.
function missedSecurityReleases(pinned, releases) {
  if (!Array.isArray(releases)) throw new Error('release index is not a list');
  const [major] = parseNodeVersion(pinned);
  return releases
    .filter((release) => release.security === true)
    .filter((release) => parseNodeVersion(release.version)[0] === major)
    .filter((release) => compareVersions(release.version, pinned) > 0)
    .map((release) => `${parseNodeVersion(release.version).join('.')} (${release.date})`);
}

async function main() {
  const pinned = fs.readFileSync(PIN_PATH, 'utf8').trim();
  const response = await fetch(INDEX_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${INDEX_URL} answered HTTP ${response.status}`);
  const missed = missedSecurityReleases(pinned, await response.json());
  if (missed.length) {
    throw new Error(
      `Node pin ${pinned} misses security releases ${missed.join(', ')}: upgrade Node on the server, then the pin (docs/SUPPLY_CHAIN.md)`,
    );
  }
  const [major] = parseNodeVersion(pinned);
  process.stdout.write(`no Node ${major} security release is newer than the pin ${pinned}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { compareVersions, missedSecurityReleases };
