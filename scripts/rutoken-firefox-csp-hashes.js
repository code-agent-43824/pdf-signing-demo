#!/usr/bin/env node
'use strict';

// Recomputes the CSP hashes of the inline scripts that the Firefox build of
// "Адаптер Рутокен Плагин" injects into the page. The extension's own
// content.js runs against minimal DOM stubs, so the hashes cover exactly the
// text it inserts. Usage: unzip the XPI, then
//   node scripts/rutoken-firefox-csp-hashes.js <unpacked-xpi-dir>

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APPLICATION_PATH = path.join(__dirname, '..', 'src', 'application.js');

function cspHash(text) {
  return `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

async function captureInjectedScripts({ contentScript, webpageScript, extensionId }) {
  const injected = [];
  const messageListeners = [];
  const insert = (element) => {
    injected.push(element.text);
    element.parentNode = { removeChild() {} };
    return element;
  };
  const window = {
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.push(listener);
    },
    postMessage() {},
  };
  const document = {
    createElement(tag) {
      if (tag !== 'script') throw new Error(`Unexpected element: ${tag}`);
      return {
        text: '',
        set textContent(value) {
          this.text = String(value);
        },
        appendChild(node) {
          this.text += node.text;
        },
      };
    },
    createTextNode: (text) => ({ text: String(text) }),
    head: { appendChild: insert },
    documentElement: { appendChild: insert },
  };
  class XMLHttpRequest {
    open(_method, url) {
      this.url = url;
    }

    send() {
      this.readyState = 4;
      this.status = this.url === 'webpage.js' ? 200 : 404;
      this.responseText = this.status === 200 ? webpageScript : '';
      this.onreadystatechange();
    }
  }
  const browser = {
    runtime: { id: extensionId, getManifest: () => ({ manifest_version: 2 }) },
    extension: { getURL: (file) => file },
  };

  vm.runInNewContext(
    contentScript,
    { window, document, XMLHttpRequest, browser },
    {
      filename: 'content.js',
      timeout: 1000,
    },
  );
  const initialize = {
    source: window,
    data: { rutoken: { ext: extensionId, source: 'webpage', action: 'initialize' } },
  };
  messageListeners.forEach((listener) => {
    listener(initialize);
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  return injected;
}

async function computeRutokenFirefoxCspHashes(input) {
  const scripts = await captureInjectedScripts(input);
  if (scripts.length !== 2) {
    throw new Error(`Expected 2 inline scripts, the extension injected ${scripts.length}.`);
  }
  return scripts.map((text) => ({ hash: cspHash(text), length: text.length }));
}

async function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error('usage: rutoken-firefox-csp-hashes.js <unpacked-xpi-dir>');
  const read = (file) => fs.readFileSync(path.join(directory, file), 'utf8');
  const manifest = JSON.parse(read('manifest.json'));
  const extensionId = (manifest.browser_specific_settings || manifest.applications)?.gecko?.id;
  if (!extensionId) throw new Error('manifest.json has no gecko extension id');

  const hashes = await computeRutokenFirefoxCspHashes({
    contentScript: read('content.js'),
    webpageScript: read('webpage.js'),
    extensionId,
  });
  const application = fs.readFileSync(APPLICATION_PATH, 'utf8');
  process.stdout.write(`${extensionId} ${manifest.version}\n`);
  let missing = 0;
  for (const { hash, length } of hashes) {
    const present = application.includes(hash);
    if (!present) missing += 1;
    process.stdout.write(`${hash}  ${length} chars  ${present ? 'in CSP' : 'MISSING from CSP'}\n`);
  }
  if (missing) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { captureInjectedScripts, computeRutokenFirefoxCspHashes, cspHash };
