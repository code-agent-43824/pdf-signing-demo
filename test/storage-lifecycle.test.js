const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');
const {
  StorageLimitError,
  createResultStore,
  createSessionStore,
} = require('../src/storage/lifecycle');

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-signing-storage-'));
  tempDirs.push(dir);
  return dir;
}

test('session state machine releases buffers on completed, failed and expired states', () => {
  let timestamp = 1000;
  const store = createSessionStore({
    ttlMs: 100,
    tombstoneTtlMs: 200,
    maxSessions: 3,
    maxSessionsPerOwner: 2,
    maxMemoryBytes: 12,
    now: () => timestamp,
  });

  const completed = store.create({ preparedPdf: Buffer.alloc(4) }, 'owner-a');
  const failed = store.create({ preparedPdf: Buffer.alloc(4) }, 'owner-a');
  assert.equal(store.stats().memoryBytes, 8);
  assert.throws(
    () => store.create({ preparedPdf: Buffer.alloc(1) }, 'owner-a'),
    (error) => (
      error instanceof StorageLimitError
      && error.code === 'SESSION_OWNER_LIMIT'
    ),
  );

  assert.equal(store.complete(completed), true);
  assert.equal(store.fail(failed), true);
  assert.equal(store.getPrepared(completed), null);
  assert.equal(store.stats().memoryBytes, 0);
  assert.deepEqual(
    {
      prepared: store.stats().prepared,
      completed: store.stats().completed,
      failed: store.stats().failed,
    },
    { prepared: 0, completed: 1, failed: 1 },
  );

  const expired = store.create({ preparedPdf: Buffer.alloc(12) }, 'owner-b');
  timestamp += 101;
  assert.equal(store.getPrepared(expired), null);
  assert.equal(store.stats().expired, 1);
  assert.equal(store.stats().memoryBytes, 0);

  timestamp += 200;
  store.cleanup();
  assert.deepEqual(
    {
      prepared: store.stats().prepared,
      completed: store.stats().completed,
      failed: store.stats().failed,
      expired: store.stats().expired,
    },
    { prepared: 0, completed: 0, failed: 0, expired: 0 },
  );
});

test('session store enforces total memory and active-session limits', () => {
  const store = createSessionStore({
    ttlMs: 1000,
    maxSessions: 2,
    maxSessionsPerOwner: 2,
    maxMemoryBytes: 8,
  });
  store.create({ one: Buffer.alloc(5) }, 'owner-a');
  assert.throws(
    () => store.create({ two: Buffer.alloc(4) }, 'owner-b'),
    (error) => (
      error instanceof StorageLimitError
      && error.code === 'SESSION_MEMORY_LIMIT'
    ),
  );
  store.create({ two: Buffer.alloc(3) }, 'owner-b');
  assert.throws(
    () => store.create({}, 'owner-c'),
    (error) => (
      error instanceof StorageLimitError
      && error.code === 'SESSION_COUNT_LIMIT'
    ),
  );
});

test('result capabilities expire, download is one-time and cleanup removes files', async () => {
  let timestamp = 5000;
  const resultsDir = makeTempDir();
  fs.writeFileSync(path.join(resultsDir, 'orphan.pdf'), 'orphan');
  fs.writeFileSync(path.join(resultsDir, '.partial.tmp'), 'partial');
  const store = createResultStore({
    resultsDir,
    ttlMs: 100,
    maxResults: 2,
    maxDiskBytes: 16,
    now: () => timestamp,
  });
  assert.deepEqual(fs.readdirSync(resultsDir), []);

  const saved = await store.save(Buffer.from('%PDF-result'));
  const preview = store.resolve(saved.previewToken);
  assert.equal(preview.kind, 'preview');
  assert.equal(store.resolve(saved.previewToken).kind, 'preview');
  assert.equal(store.resolve(saved.downloadToken).kind, 'download');
  assert.equal(store.resolve(saved.downloadToken), null);
  assert.equal(fs.statSync(preview.filePath).mode & 0o777, 0o600);

  timestamp += 101;
  assert.equal(store.resolve(saved.previewToken), null);
  await Promise.all([store.cleanup(), store.cleanup()]);
  assert.deepEqual(fs.readdirSync(resultsDir), []);
  assert.deepEqual(store.stats(), {
    count: 0,
    diskBytes: 0,
    pendingCount: 0,
    pendingBytes: 0,
    maxResults: 2,
    maxDiskBytes: 16,
  });
});

test('concurrent result writes reserve capacity before touching disk', async () => {
  const resultsDir = makeTempDir();
  const store = createResultStore({
    resultsDir,
    ttlMs: 1000,
    maxResults: 1,
    maxDiskBytes: 8,
  });
  const first = store.save(Buffer.alloc(8));
  await assert.rejects(
    store.save(Buffer.alloc(1)),
    (error) => (
      error instanceof StorageLimitError
      && error.code === 'RESULT_COUNT_LIMIT'
    ),
  );
  await first;
  assert.equal(store.stats().count, 1);
  assert.equal(store.stats().pendingCount, 0);
});

test('result store rejects aggregate disk and result-count overflow', async () => {
  const resultsDir = makeTempDir();
  const store = createResultStore({
    resultsDir,
    ttlMs: 1000,
    maxResults: 1,
    maxDiskBytes: 8,
  });
  await assert.rejects(
    store.save(Buffer.alloc(9)),
    (error) => (
      error instanceof StorageLimitError
      && error.code === 'RESULT_DISK_LIMIT'
    ),
  );
  await store.save(Buffer.alloc(8));
  await assert.rejects(
    store.save(Buffer.alloc(1)),
    (error) => (
      error instanceof StorageLimitError
      && error.code === 'RESULT_COUNT_LIMIT'
    ),
  );
});

test('server rejects a result directory placed inside the public web root', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const result = spawnSync(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RESULTS_DIR: path.join(projectRoot, 'public', 'generated'),
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RESULTS_DIR must be outside the public web root/);
});
