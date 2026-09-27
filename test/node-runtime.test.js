const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { parseNodeVersion, satisfiesPin } = require('../scripts/check-node-runtime');
const {
  compareVersions,
  missedSecurityReleases,
} = require('../scripts/check-node-security-releases');

const GATE_PATH = path.join(__dirname, '..', 'scripts', 'check-node-runtime.js');

// Runs a copy of the gate next to a .node-version holding `pin`, since the
// gate reads the pin relative to its own location.
function runGate(pin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-gate-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(GATE_PATH, path.join(dir, 'scripts', 'check-node-runtime.js'));
    fs.writeFileSync(path.join(dir, '.node-version'), `${pin}\n`);
    return spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-node-runtime.js')], {
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Node runtime gate accepts only the pinned major, not older than the pin', () => {
  assert.equal(satisfiesPin('22.22.2', '22.22.2'), true);
  assert.equal(satisfiesPin('22.22.2', 'v22.22.2'), true);
  assert.equal(satisfiesPin('22.22.2', '22.22.10'), true);
  assert.equal(satisfiesPin('22.22.2', '22.23.0'), true);
  assert.equal(satisfiesPin('22.23.3', '22.23.2'), false);
  assert.equal(satisfiesPin('22.23.3', '22.22.9'), false);
  assert.equal(satisfiesPin('22.22.2', '24.0.0'), false);
  assert.equal(satisfiesPin('22.22.2', '21.99.99'), false);

  assert.deepEqual(parseNodeVersion('v22.23.3\n'), [22, 23, 3]);
  for (const malformed of ['', '22', '22.23', '22.23.3-rc.1', 'v22.x.1', 'lts']) {
    assert.throws(() => parseNodeVersion(malformed), /not a Node\.js version/);
  }
});

test('Node runtime gate reports the running Node and fails closed', () => {
  const running = process.versions.node;
  const passed = runGate(running);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, `node ${running} satisfies the pin ${running}\n`);

  const nextMajor = `${parseNodeVersion(running)[0] + 1}.0.0`;
  const tooOld = runGate(nextMajor);
  assert.equal(tooOld.status, 1);
  assert.equal(tooOld.stdout, '');
  assert.ok(tooOld.stderr.startsWith(`Node ${running} does not satisfy the pin ${nextMajor}`));

  const malformed = runGate('lts');
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /not a Node\.js version/);
});

// Shape of nodejs.org/dist/index.json; versions and dates are made up.
const RELEASE_INDEX = [
  { version: 'v24.40.0', date: '2031-05-01', security: true },
  { version: 'v22.41.1', date: '2031-04-20', security: false },
  { version: 'v22.41.0', date: '2031-04-01', security: true },
  { version: 'v22.40.2', date: '2031-03-01', security: true },
  { version: 'v22.40.1', date: '2031-02-01', security: false },
  { version: 'v22.40.0', date: '2031-01-01', security: true },
  { version: 'v20.40.0', date: '2031-04-01', security: true },
];

test('weekly check lists security releases of the pinned major newer than the pin', () => {
  assert.deepEqual(missedSecurityReleases('22.40.0', RELEASE_INDEX), [
    '22.41.0 (2031-04-01)',
    '22.40.2 (2031-03-01)',
  ]);
  assert.deepEqual(missedSecurityReleases('22.40.2', RELEASE_INDEX), ['22.41.0 (2031-04-01)']);
  assert.deepEqual(missedSecurityReleases('22.41.1', RELEASE_INDEX), []);
  assert.deepEqual(missedSecurityReleases('22.41.0', RELEASE_INDEX), []);

  assert.ok(compareVersions('v22.40.10', '22.40.2') > 0);
  assert.ok(compareVersions('22.9.0', '22.10.0') < 0);
  assert.equal(compareVersions('v22.40.2', '22.40.2'), 0);

  assert.throws(() => missedSecurityReleases('22.40.0', { releases: [] }), /not a list/);
  assert.throws(
    () => missedSecurityReleases('22.40.0', [{ version: 'latest', security: true }]),
    /not a Node\.js version/,
  );
});
