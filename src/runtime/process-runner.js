const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PRLIMIT_PATH = '/usr/bin/prlimit';
const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024;
const DEFAULT_CPU_SECONDS = 60;
const DEFAULT_MAX_BUFFER = 1024 * 1024;
const KILL_GRACE_MS = 250;

class WorkerProcessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkerProcessError';
    this.code = code;
    Object.assign(this, details);
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function createWorkerEnvironment(extra = {}) {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
    PYTHONUNBUFFERED: '1',
    ...extra,
  };
}

function createLimitedCommand(command, args, limits = {}) {
  if (limits.enabled === false) {
    return { command, args };
  }
  if (!fs.existsSync(PRLIMIT_PATH)) {
    if (process.env.NODE_ENV === 'production') {
      throw new WorkerProcessError(
        'WORKER_LIMITS_UNAVAILABLE',
        'prlimit is required for production worker isolation',
      );
    }
    return { command, args };
  }
  const memoryBytes = boundedInteger(
    limits.memoryBytes ?? process.env.PDF_WORKER_MEMORY_BYTES,
    DEFAULT_MEMORY_BYTES,
    256 * 1024 * 1024,
    2 * 1024 * 1024 * 1024,
  );
  const cpuSeconds = boundedInteger(
    limits.cpuSeconds ?? process.env.PDF_WORKER_CPU_SECONDS,
    DEFAULT_CPU_SECONDS,
    5,
    300,
  );
  return {
    command: PRLIMIT_PATH,
    args: [
      `--as=${memoryBytes}`,
      `--cpu=${cpuSeconds}`,
      '--nofile=128',
      '--',
      command,
      ...args,
    ],
  };
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function runIsolatedProcess(command, args, {
  cwd,
  env = {},
  input = null,
  timeoutMs = 15000,
  maxBuffer = DEFAULT_MAX_BUFFER,
  signal = null,
  limits = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const limited = createLimitedCommand(command, args, limits);
    const child = spawn(limited.command, limited.args, {
      cwd,
      env: createWorkerEnvironment(env),
      detached: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let failureCode = null;
    let killTimer = null;
    let timeout = null;
    let settled = false;

    const terminate = (code) => {
      if (failureCode) return;
      failureCode = code;
      killProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        try {
          killProcessGroup(child, 'SIGKILL');
        } catch {}
      }, KILL_GRACE_MS);
    };

    const appendOutput = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > maxBuffer) {
        terminate('WORKER_OUTPUT_LIMIT');
        return next.subarray(0, maxBuffer);
      }
      return next;
    };

    const abort = () => terminate('WORKER_ABORTED');
    if (signal?.aborted) {
      terminate('WORKER_ABORTED');
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.stdin.on('error', () => {
      // A worker that exits before consuming stdin is handled by its close event.
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      reject(new WorkerProcessError(
        'WORKER_SPAWN_FAILED',
        'Unable to start isolated worker process',
        { cause: error, stdout: stdout.toString(), stderr: stderr.toString() },
      ));
    });
    child.once('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      const details = {
        exitCode: code,
        signal: closeSignal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      };
      if (failureCode) {
        reject(new WorkerProcessError(
          failureCode,
          `Isolated worker failed: ${failureCode}`,
          details,
        ));
      } else if (code !== 0) {
        reject(new WorkerProcessError(
          'WORKER_EXIT_FAILED',
          `Isolated worker exited with code ${code}`,
          details,
        ));
      } else {
        resolve(details);
      }
    });

    timeout = setTimeout(() => terminate('WORKER_TIMEOUT'), timeoutMs);
    if (input === null || input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(input);
    }
  });
}

module.exports = {
  WorkerProcessError,
  createWorkerEnvironment,
  runIsolatedProcess,
};
