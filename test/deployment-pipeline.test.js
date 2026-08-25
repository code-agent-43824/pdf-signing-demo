const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

test('production deployment keeps required safety gates', () => {
  const deployPath = path.join(projectRoot, 'scripts', 'deploy-production.sh');
  const verifyPath = path.join(projectRoot, 'scripts', 'verify-release.sh');
  const workflow = fs.readFileSync(
    path.join(projectRoot, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  const deploy = fs.readFileSync(deployPath, 'utf8');

  execFileSync('bash', ['-n', deployPath]);
  execFileSync('bash', ['-n', verifyPath]);
  assert.match(workflow, /needs: golden-pades/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /\[skip deploy\]/);
  assert.match(workflow, /PRODUCTION_KNOWN_HOSTS/);
  assert.match(deploy, /flock -n/);
  assert.match(deploy, /verify-release\.sh/);
  assert.match(deploy, /smoke-signing\.js/);
  assert.match(deploy, /mv -Tf/);
  assert.match(deploy, /rolling back/);
});
