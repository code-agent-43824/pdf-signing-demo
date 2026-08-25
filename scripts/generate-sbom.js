#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'sbom');

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeName(name) {
  return name.toLowerCase().replace(/[_.]+/g, '-');
}

function generateNodeSbom() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const output = execFileSync(
    'npm',
    [
      'sbom',
      '--omit=dev',
      '--package-lock-only',
      '--sbom-format=cyclonedx',
      '--sbom-type=application',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const sbom = JSON.parse(output);
  delete sbom.serialNumber;
  if (sbom.metadata) {
    delete sbom.metadata.timestamp;
    sbom.metadata.component.name = manifest.name;
  }
  return sbom;
}

function generatePythonSbom() {
  const lock = fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8');
  const components = [];
  const requirementPattern = /^([A-Za-z0-9_.-]+)==([^\s\\]+)\s*\\/gm;
  let match;

  while ((match = requirementPattern.exec(lock)) !== null) {
    const name = normalizeName(match[1]);
    const version = match[2];
    components.push({
      'bom-ref': `pkg:pypi/${name}@${version}`,
      type: 'library',
      name,
      version,
      purl: `pkg:pypi/${name}@${version}`,
    });
  }

  components.sort((left, right) => left.name.localeCompare(right.name));
  const rootRef = 'pkg:generic/pdf-signing-demo-python@3.0.0';

  return {
    $schema: 'https://cyclonedx.org/schema/bom-1.5.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        'bom-ref': rootRef,
        type: 'application',
        name: 'pdf-signing-demo-python',
        version: '3.0.0',
        purl: rootRef,
      },
      properties: [
        {
          name: 'pdf-signing-demo:source',
          value: 'requirements.txt (pip-compile, hashes required)',
        },
      ],
    },
    components,
    dependencies: [
      {
        ref: rootRef,
        dependsOn: components.map((component) => component['bom-ref']),
      },
      ...components.map((component) => ({
        ref: component['bom-ref'],
        dependsOn: [],
      })),
    ],
  };
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
  path.join(outputDir, 'node.cdx.json'),
  stableJson(generateNodeSbom()),
);
fs.writeFileSync(
  path.join(outputDir, 'python.cdx.json'),
  stableJson(generatePythonSbom()),
);
