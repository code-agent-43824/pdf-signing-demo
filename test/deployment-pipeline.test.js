const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

test('production deployment keeps required safety gates', () => {
  const deployPath = path.join(projectRoot, 'scripts', 'deploy-production.sh');
  const storagePath = path.join(projectRoot, 'scripts', 'manage-deploy-storage.sh');
  const verifyPath = path.join(projectRoot, 'scripts', 'verify-release.sh');
  const workflow = fs.readFileSync(
    path.join(projectRoot, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  const deploy = fs.readFileSync(deployPath, 'utf8');
  const caddy = fs.readFileSync(
    path.join(projectRoot, 'deploy', 'mescheryakov.pro.caddy'),
    'utf8',
  );

  execFileSync('bash', ['-n', deployPath]);
  execFileSync('bash', ['-n', storagePath]);
  execFileSync('bash', ['-n', verifyPath]);
  assert.match(workflow, /needs: golden-pades/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /\[skip deploy\]/);
  assert.match(workflow, /PRODUCTION_KNOWN_HOSTS/);
  assert.match(deploy, /flock -n/);
  assert.match(deploy, /verify-release\.sh/);
  assert.match(deploy, /smoke-signing\.js/);
  assert.match(deploy, /pdf_signing_process_start_time_seconds/);
  assert.match(deploy, /health\/metrics.*404/s);
  assert.match(deploy, /mv -Tf/);
  assert.match(deploy, /rolling back/);
  assert.match(deploy, /manage-deploy-storage\.sh.*preflight/s);
  assert.match(deploy, /manage-deploy-storage\.sh.*prune/s);
  assert.match(
    caddy,
    /handle \/pdf-signing\/health\/metrics \{\s+respond 404\s+\}\s+handle \/pdf-signing\/\*/,
  );
});

function makeServiceRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-deploy-storage-'));
  fs.mkdirSync(path.join(root, 'releases'));
  fs.mkdirSync(path.join(root, 'backups'));
  fs.mkdirSync(path.join(root, 'incoming'));
  return root;
}

function makeRelease(root, revision) {
  const release = path.join(root, 'releases', revision);
  fs.mkdirSync(release);
  fs.writeFileSync(path.join(release, '.release-revision'), `${revision}\n`);
  return release;
}

test('deploy storage preflight cleans stale transients and enforces headroom', () => {
  const script = path.join(projectRoot, 'scripts', 'manage-deploy-storage.sh');
  const root = makeServiceRoot();
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-deploy-outside-'));
  try {
    const currentRevision = 'a'.repeat(40);
    const current = makeRelease(root, currentRevision);
    fs.writeFileSync(path.join(current, 'payload'), Buffer.alloc(4096));
    fs.symlinkSync(current, path.join(root, 'current'));

    const activeStaging = path.join(root, 'releases', `.${'b'.repeat(40)}.staging`);
    const staleStaging = path.join(root, 'releases', `.${'c'.repeat(40)}.staging`);
    fs.mkdirSync(activeStaging);
    fs.mkdirSync(staleStaging);
    const outsideStaging = path.join(outsideRoot, `.${'f'.repeat(40)}.staging`);
    fs.mkdirSync(outsideStaging);
    fs.symlinkSync(outsideStaging, path.join(root, 'releases', `.${'9'.repeat(40)}.staging`));
    const oldArchive = path.join(root, 'incoming', `release-${'d'.repeat(40)}.tar.gz`);
    const freshArchive = path.join(root, 'incoming', `release-${'e'.repeat(40)}.tar.gz`);
    fs.writeFileSync(oldArchive, 'old');
    fs.writeFileSync(freshArchive, 'fresh');
    const oldTime = new Date(Date.now() - (2 * 60 * 60 * 1000));
    fs.utimesSync(oldArchive, oldTime, oldTime);

    execFileSync(script, ['preflight', root, activeStaging], {
      env: {
        ...process.env,
        DEPLOY_DISK_RESERVE_BYTES: '0',
        RETENTION_DRY_RUN: '1',
        STALE_DEPLOY_ARTIFACT_AGE_SECONDS: '3600',
      },
    });
    assert.equal(fs.existsSync(activeStaging), true);
    assert.equal(fs.existsSync(staleStaging), true);
    assert.equal(fs.existsSync(oldArchive), true);

    execFileSync(script, ['preflight', root, activeStaging], {
      env: {
        ...process.env,
        DEPLOY_DISK_RESERVE_BYTES: '0',
        STALE_DEPLOY_ARTIFACT_AGE_SECONDS: '3600',
      },
    });
    assert.equal(fs.existsSync(staleStaging), false);
    assert.equal(fs.existsSync(outsideStaging), true);
    assert.equal(fs.existsSync(oldArchive), false);
    assert.equal(fs.existsSync(freshArchive), true);

    const failed = spawnSync(script, ['preflight', root, activeStaging], {
      encoding: 'utf8',
      env: { ...process.env, DEPLOY_DISK_RESERVE_BYTES: '999999999999999' },
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /insufficient disk for deployment/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('deploy retention keeps rollback releases, recent backups and evidence', () => {
  const script = path.join(projectRoot, 'scripts', 'manage-deploy-storage.sh');
  const root = makeServiceRoot();
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-retention-outside-'));
  try {
    const current = makeRelease(root, 'a'.repeat(40));
    const previous = makeRelease(root, 'b'.repeat(40));
    const old = makeRelease(root, 'c'.repeat(40));
    const unknown = path.join(root, 'releases', 'manual-evidence');
    fs.mkdirSync(unknown);
    const outsideRelease = path.join(outsideRoot, 'd'.repeat(40));
    fs.mkdirSync(outsideRelease);
    fs.writeFileSync(path.join(outsideRelease, '.release-revision'), `${'d'.repeat(40)}\n`);
    fs.symlinkSync(outsideRelease, path.join(root, 'releases', 'e'.repeat(40)));
    fs.symlinkSync(current, path.join(root, 'current'));

    const backupNames = [
      '20260826T120000Z-cicd-aaaaaaaaaaaa',
      '20260826T130000Z-cicd-bbbbbbbbbbbb',
      '20260826T140000Z-cicd-cccccccccccc',
      '20260826T150000Z-cicd-dddddddddddd',
    ];
    for (const name of backupNames) fs.mkdirSync(path.join(root, 'backups', name));
    fs.writeFileSync(
      path.join(root, 'backups', backupNames[0], 'rollback-drill.log'),
      'evidence',
    );
    fs.mkdirSync(path.join(root, 'backups', 'manual-baseline'));

    const dryRun = execFileSync(script, ['prune', root, current, previous], {
      encoding: 'utf8',
      env: { ...process.env, RETENTION_DRY_RUN: '1' },
    });
    assert.match(dryRun, /would remove/);
    assert.equal(fs.existsSync(old), true);

    execFileSync(script, ['prune', root, current, previous]);
    assert.equal(fs.existsSync(current), true);
    assert.equal(fs.existsSync(previous), true);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(unknown), true);
    assert.equal(fs.existsSync(outsideRelease), true);
    assert.equal(fs.existsSync(path.join(root, 'backups', backupNames[0])), true);
    assert.equal(fs.existsSync(path.join(root, 'backups', backupNames[1])), false);
    assert.equal(fs.existsSync(path.join(root, 'backups', backupNames[2])), true);
    assert.equal(fs.existsSync(path.join(root, 'backups', backupNames[3])), true);
    assert.equal(fs.existsSync(path.join(root, 'backups', 'manual-baseline')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});
