const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function lockedPythonPackages() {
  const lock = fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8');
  const packages = new Map();
  const entries = lock.split(/(?=^[A-Za-z0-9_.-]+==)/m);

  for (const entry of entries) {
    const match = entry.match(/^([A-Za-z0-9_.-]+)==([^\s\\]+)/);
    if (!match) continue;
    assert.match(entry, /--hash=sha256:/, `${match[1]} must be hash locked`);
    packages.set(match[1].toLowerCase().replace(/[_.]+/g, '-'), match[2]);
  }
  return packages;
}

test('runtime dependency trees are minimal and fully locked', () => {
  const packageJson = readJson('package.json');
  assert.deepEqual(
    Object.keys(packageJson.dependencies).sort(),
    ['ajv', 'express', 'pdf-lib'],
  );
  assert.equal(packageJson.engines.node, '>=22.22.2 <23');
  assert.equal(
    fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim(),
    '22.22.2',
  );

  const packageLock = readJson('package-lock.json');
  for (const removed of [
    '@qiwitech/cryptopro',
    '@signpdf/placeholder-pdf-lib',
    '@signpdf/signpdf',
    '@signpdf/utils',
  ]) {
    assert.equal(packageLock.packages[`node_modules/${removed}`], undefined);
  }

  const pythonPackages = lockedPythonPackages();
  assert.ok(pythonPackages.size >= 20);
  for (const direct of [
    'asn1crypto',
    'gostcrypto',
    'pillow',
    'pyhanko',
    'pypdf',
    'reportlab',
  ]) {
    assert.ok(pythonPackages.has(direct), `${direct} must be locked`);
  }
});

test('committed CycloneDX manifests match both lockfiles', () => {
  const pythonPackages = lockedPythonPackages();
  const pythonSbom = readJson('sbom/python.cdx.json');
  const sbomPythonPackages = new Map(
    pythonSbom.components.map((component) => [
      component.name,
      component.version,
    ]),
  );
  assert.deepEqual(sbomPythonPackages, pythonPackages);

  const nodeSbom = readJson('sbom/node.cdx.json');
  assert.equal(nodeSbom.bomFormat, 'CycloneDX');
  assert.equal(nodeSbom.specVersion, '1.5');
  assert.equal(nodeSbom.metadata.component.name, 'pdf-signing-demo');
  assert.equal(nodeSbom.metadata.component.type, 'application');
  assert.equal('serialNumber' in nodeSbom, false);
  assert.equal('timestamp' in nodeSbom.metadata, false);

  const nodeNames = new Set(
    nodeSbom.components.map((component) => component.name),
  );
  for (const direct of ['ajv', 'express', 'pdf-lib']) {
    assert.ok(nodeNames.has(direct), `${direct} must be present in Node SBOM`);
  }
});
