const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const {
  captureInjectedScripts,
  computeRutokenFirefoxCspHashes,
} = require('../scripts/rutoken-firefox-csp-hashes');

// Same injection shape as the Firefox build of the Rutoken plugin adapter:
// an inline bootstrap at load, then webpage.js as a second inline script on
// the page's "initialize" message.
function syntheticContentScript({ injectWebpage = true } = {}) {
  return `(function () {
    var _browser = (!!window.chrome && !!chrome.runtime) ? chrome : browser;
    var extId = _browser.runtime.id;
    window.addEventListener('message', function (event) {
      if (event.source != window || event.data.rutoken.action !== 'initialize') return;
      if (!${injectWebpage}) return;
      var req = new XMLHttpRequest();
      req.onreadystatechange = function () {
        if (req.readyState == 4 && req.status == 200) {
          var s = document.createElement('script');
          s.appendChild(document.createTextNode("(function () {\\n" + req.responseText + "})();"));
          (document.head || document.documentElement).appendChild(s);
        }
      };
      req.open('GET', _browser.extension.getURL('webpage.js'));
      req.send();
    });
    var script = document.createElement('script');
    script.textContent = '(' + function (id) { window[id] = {}; } + ')(' + JSON.stringify(extId) + ')';
    (document.head || document.documentElement).appendChild(script);
    script.parentNode.removeChild(script);
  }());`;
}

const sha256 = (text) =>
  `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;

test('Rutoken Firefox CSP hashes cover exactly the inline scripts the extension injects', async () => {
  const input = {
    contentScript: syntheticContentScript(),
    webpageScript: 'window.fromWebpage = true;\n',
    extensionId: 'rutokenplugin@rutoken.ru',
  };
  const expected = [
    '(function (id) { window[id] = {}; })("rutokenplugin@rutoken.ru")',
    '(function () {\nwindow.fromWebpage = true;\n})();',
  ];

  assert.deepEqual(await captureInjectedScripts(input), expected);
  assert.deepEqual(
    await computeRutokenFirefoxCspHashes(input),
    expected.map((text) => ({ hash: sha256(text), length: text.length })),
  );
});

test('Rutoken Firefox CSP hash tool fails when the injection shape changes', async () => {
  await assert.rejects(
    computeRutokenFirefoxCspHashes({
      contentScript: syntheticContentScript({ injectWebpage: false }),
      webpageScript: '',
      extensionId: 'rutokenplugin@rutoken.ru',
    }),
    /Expected 2 inline scripts, the extension injected 1/,
  );
});
