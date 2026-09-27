#!/usr/bin/env node
'use strict';

// Deploy gate for the server runtime. The Node that runs this script, the
// same binary that will run the release, must have the major version of the
// pin in .node-version and must not be older than the pin: the range that
// package.json#engines declares. npm ci only warns about engines, so without
// this gate a pin bump would silently deploy onto an older runtime. The
// checked version goes to the deploy log.

const fs = require('node:fs');
const path = require('node:path');

const PIN_PATH = path.join(__dirname, '..', '.node-version');

function parseNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  if (!match) throw new Error(`not a Node.js version: ${JSON.stringify(value)}`);
  return match.slice(1).map(Number);
}

function satisfiesPin(pinned, actual) {
  const [pinMajor, pinMinor, pinPatch] = parseNodeVersion(pinned);
  const [major, minor, patch] = parseNodeVersion(actual);
  if (major !== pinMajor) return false;
  if (minor !== pinMinor) return minor > pinMinor;
  return patch >= pinPatch;
}

function main() {
  const pinned = fs.readFileSync(PIN_PATH, 'utf8').trim();
  const actual = process.versions.node;
  if (!satisfiesPin(pinned, actual)) {
    const [major] = parseNodeVersion(pinned);
    throw new Error(
      `Node ${actual} does not satisfy the pin ${pinned}: need Node ${major}, not older than the pin`,
    );
  }
  process.stdout.write(`node ${actual} satisfies the pin ${pinned}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseNodeVersion, satisfiesPin };
