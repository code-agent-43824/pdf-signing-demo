const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const { HttpError } = require('../src/http/validation');
const { createStampConfiguration } = require('../src/stamp/configuration');

const temporaryDirectories = [];

test('default stamp has no invented signing reason and renders certificate expiry in UTC', () => {
  const script = `import json, runpy\nfrom copy import deepcopy\nm = runpy.run_path('scripts/prepare-pyhanko.py')\nsigner = {'issuerName': 'CN=Test CA', 'validToDate': '2027-09-28T16:36:05+03:00'}\nmetadata = m['build_rendered_metadata'](m['DEFAULT_CONFIG'], signer)\nlegacy = deepcopy(m['DEFAULT_CONFIG'])\nlegacy['signatureObject']['reason'] = 'Выдан: {signer.issuer}'\nlegacy_reason = m['build_rendered_metadata'](legacy, signer)['reason']\nlegacy['signatureObject']['reason'] = 'Согласовано'\nexplicit_reason = m['build_rendered_metadata'](legacy, signer)['reason']\nprint(json.dumps({'reason': metadata['reason'], 'row': metadata['rows'][-1]['value'], 'raw': signer['validToDate'], 'legacy': legacy_reason, 'explicit': explicit_reason}))`;
  const result = JSON.parse(
    execFileSync('python3', ['-c', script], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    }),
  );
  assert.equal(result.reason, '');
  assert.equal(result.legacy, '');
  assert.equal(result.explicit, 'Согласовано');
  assert.equal(result.row, '28.09.2027 13:36 UTC');
  assert.equal(result.raw, '2027-09-28T16:36:05+03:00');
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-config-'));
  temporaryDirectories.push(projectRoot);
  const fontsDir = path.join(projectRoot, 'assets', 'fonts');
  fs.mkdirSync(path.join(fontsDir, 'nested'), { recursive: true });
  const regularFont = path.join(fontsDir, 'Regular.ttf');
  const boldFont = path.join(fontsDir, 'nested', 'Bold.otf');
  fs.writeFileSync(regularFont, 'regular-font-fixture');
  fs.writeFileSync(boldFont, 'bold-font-fixture');
  fs.writeFileSync(path.join(fontsDir, 'ignored.txt'), 'not-a-font');

  const config = {
    appearance: {
      fonts: {
        title: { path: path.relative(projectRoot, boldFont), size: 18 },
        label: { path: path.relative(projectRoot, regularFont), size: 12 },
        value: { path: path.relative(projectRoot, regularFont), size: 12 },
      },
    },
  };
  const stampConfigPath = path.join(projectRoot, 'stamp-config.json');
  fs.writeFileSync(stampConfigPath, JSON.stringify(config));
  const service = createStampConfiguration({
    projectRoot,
    localFontsDir: fontsDir,
    stampConfigPath,
    fontDirs: [fontsDir],
  });
  return { boldFont, config, regularFont, service };
}

test('stamp configuration maps server font paths to opaque IDs and back', () => {
  const { boldFont, config, regularFont, service } = createFixture();
  const catalog = service.createCatalog();
  const clientConfig = service.toClient(config, catalog);

  assert.equal(catalog.fonts.length, 2);
  for (const role of ['title', 'label', 'value']) {
    assert.match(clientConfig.appearance.fonts[role].path, /^font-[0-9a-f]{16}$/);
    assert.equal(path.isAbsolute(clientConfig.appearance.fonts[role].path), false);
  }
  assert.deepEqual(
    service.listAvailable(catalog),
    catalog.fonts.map((font) => ({ id: font.id, label: font.label })),
  );
  assert.deepEqual(
    service
      .listAvailable(catalog)
      .map((font) => font.label)
      .sort(),
    ['Bold', 'Regular'],
  );

  const serverConfig = service.toServer(clientConfig, catalog);
  assert.equal(serverConfig.appearance.fonts.title.path, boldFont);
  assert.equal(serverConfig.appearance.fonts.label.path, regularFont);
  assert.equal(serverConfig.appearance.fonts.value.path, regularFont);
  assert.deepEqual(config.appearance.fonts.label.path, 'assets/fonts/Regular.ttf');
});

test('stamp configuration rejects unavailable paths and unknown opaque IDs', () => {
  const { config, service } = createFixture();
  const catalog = service.createCatalog();
  const missingPathConfig = structuredClone(config);
  missingPathConfig.appearance.fonts.title.path = 'assets/fonts/Missing.ttf';
  assert.throws(
    () => service.toClient(missingPathConfig, catalog),
    /Configured stamp font is unavailable/,
  );

  const clientConfig = service.toClient(config, catalog);
  clientConfig.appearance.fonts.title.path = 'font-0000000000000000';
  assert.throws(
    () => service.toServer(clientConfig, catalog),
    (error) => error instanceof HttpError && error.status === 400 && error.code === 'UNKNOWN_FONT',
  );
});

test('stamp configuration reads only a JSON object', () => {
  const { service } = createFixture();
  assert.equal(typeof service.parse(service.read()), 'object');
  assert.throws(() => service.parse('[]'), /must be a JSON object/);
  assert.throws(() => service.parse('null'), /must be a JSON object/);
  assert.throws(() => service.parse('{'), SyntaxError);
});
