const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  OperationControlError,
  OperationQueue,
} = require('../src/runtime/operation-queue');
const { WorkerProcessError, runIsolatedProcess } = require(
  '../src/runtime/process-runner',
);
const {
  FixedWindowRateLimiter,
  createRateLimitMiddleware,
} = require('../src/http/rate-limit');
const { HttpError } = require('../src/http/validation');
const { createPreparedPdf } = require('../src/signing/pades');

const WORKER_FIXTURE = path.join(__dirname, 'fixtures', 'process-worker.py');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error('condition timed out');
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('operation queue bounds global and per-key concurrency', async () => {
  const queue = new OperationQueue({
    concurrency: 2,
    maxQueue: 4,
    perKeyConcurrency: 1,
    queueTimeoutMs: 1000,
    operationTimeoutMs: 1000,
  });
  let active = 0;
  let maxActive = 0;
  const activeByKey = new Map();
  const maxByKey = new Map();
  const work = (key) => queue.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    activeByKey.set(key, (activeByKey.get(key) || 0) + 1);
    maxByKey.set(key, Math.max(maxByKey.get(key) || 0, activeByKey.get(key)));
    await delay(40);
    active -= 1;
    activeByKey.set(key, activeByKey.get(key) - 1);
    return key;
  }, { key });

  assert.deepEqual(
    await Promise.all([work('same'), work('same'), work('other')]),
    ['same', 'same', 'other'],
  );
  assert.equal(maxActive, 2);
  assert.equal(maxByKey.get('same'), 1);
  assert.deepEqual(queue.stats(), {
    active: 0,
    queued: 0,
    concurrency: 2,
    maxQueue: 4,
  });
});

test('operation queue rejects overflow and aborts timed-out work', async () => {
  const queue = new OperationQueue({
    concurrency: 1,
    maxQueue: 1,
    perKeyConcurrency: 1,
    queueTimeoutMs: 1000,
    operationTimeoutMs: 80,
  });
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const first = queue.run(() => blocker, { key: 'first', timeoutMs: 1000 });
  const second = queue.run(() => Promise.resolve('second'), { key: 'second' });
  await assert.rejects(
    queue.run(() => Promise.resolve('third'), { key: 'third' }),
    (error) => (
      error instanceof OperationControlError && error.code === 'QUEUE_FULL'
    ),
  );
  release('first');
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');

  await assert.rejects(
    queue.run(
      (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      { key: 'timeout' },
    ),
    (error) => (
      error instanceof OperationControlError
      && error.code === 'OPERATION_TIMEOUT'
    ),
  );
  assert.equal(queue.stats().active, 0);
});

test('fixed-window limiter separates keys and resets deterministically', () => {
  let now = 1000;
  const limiter = new FixedWindowRateLimiter({
    limit: 2,
    windowMs: 1000,
    now: () => now,
  });
  assert.equal(limiter.take('prepare:one').allowed, true);
  assert.equal(limiter.take('prepare:one').allowed, true);
  const denied = limiter.take('prepare:one');
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.equal(limiter.take('complete:one').allowed, true);
  now = 2000;
  assert.equal(limiter.take('prepare:one').allowed, true);
});

test('rate-limit middleware returns safe 429 metadata', () => {
  const limiter = new FixedWindowRateLimiter({
    limit: 1,
    windowMs: 60000,
    now: () => 1000,
  });
  const middleware = createRateLimitMiddleware({
    limiter,
    HttpError,
    scope: 'prepare',
  });
  const headers = new Map();
  const req = { ip: '192.0.2.10' };
  const res = {
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
  };
  let firstError;
  middleware(req, res, (error) => {
    firstError = error;
  });
  assert.equal(firstError, undefined);
  let denied;
  middleware(req, res, (error) => {
    denied = error;
  });
  assert.ok(denied instanceof HttpError);
  assert.equal(denied.status, 429);
  assert.equal(denied.code, 'RATE_LIMITED');
  assert.equal(headers.get('ratelimit-remaining'), 0);
  assert.equal(headers.get('retry-after'), 60);
});

test('isolated worker is asynchronous and timeout kills its process group', async () => {
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 10);
  await runIsolatedProcess('python3', [WORKER_FIXTURE, 'sleep', '0.25'], {
    timeoutMs: 2000,
  });
  clearInterval(ticker);
  assert.ok(ticks >= 10, `event loop advanced only ${ticks} times`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-worker-test-'));
  const childPidPath = path.join(tempDir, 'child.pid');
  try {
    const operation = runIsolatedProcess(
      'python3',
      [WORKER_FIXTURE, 'spawn-child', childPidPath],
      { cwd: tempDir, timeoutMs: 300 },
    );
    await waitFor(() => fs.existsSync(childPidPath));
    const childPid = Number(fs.readFileSync(childPidPath, 'ascii'));
    await assert.rejects(
      operation,
      (error) => (
        error instanceof WorkerProcessError && error.code === 'WORKER_TIMEOUT'
      ),
    );
    await waitFor(() => !processExists(childPid));
    assert.equal(processExists(childPid), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('aborted PDF worker removes its private temporary directory', async () => {
  const prefix = 'pdf-signing-pyhanko-';
  const before = new Set(
    fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix)),
  );
  const controller = new AbortController();
  const operation = createPreparedPdf({
    sourceBuffer: fs.readFileSync(
      path.join(__dirname, 'fixtures', 'pdf', 'simple.pdf'),
    ),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    operation,
    (error) => (
      error instanceof WorkerProcessError && error.code === 'WORKER_ABORTED'
    ),
  );
  await delay(50);
  const after = new Set(
    fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix)),
  );
  assert.deepEqual(after, before);
});
