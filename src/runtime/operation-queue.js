class OperationControlError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OperationControlError';
    this.code = code;
  }
}

function positiveInteger(value, fallback, minimum = 1, maximum = 1000) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

class OperationQueue {
  constructor({
    concurrency = 2,
    maxQueue = 8,
    perKeyConcurrency = 1,
    queueTimeoutMs = 5000,
    operationTimeoutMs = 60000,
  } = {}) {
    this.concurrency = positiveInteger(concurrency, 2, 1, 16);
    this.maxQueue = positiveInteger(maxQueue, 8, 1, 128);
    this.perKeyConcurrency = positiveInteger(perKeyConcurrency, 1, 1, 8);
    this.queueTimeoutMs = positiveInteger(queueTimeoutMs, 5000, 100, 60000);
    this.operationTimeoutMs = positiveInteger(
      operationTimeoutMs,
      60000,
      1000,
      300000,
    );
    this.active = 0;
    this.activeByKey = new Map();
    this.pending = [];
  }

  stats() {
    return {
      active: this.active,
      queued: this.pending.length,
      concurrency: this.concurrency,
      maxQueue: this.maxQueue,
    };
  }

  run(task, { key = 'global', signal = null, timeoutMs = null } = {}) {
    if (signal?.aborted) {
      return Promise.reject(new OperationControlError('REQUEST_ABORTED'));
    }
    if (this.pending.length >= this.maxQueue) {
      return Promise.reject(new OperationControlError('QUEUE_FULL'));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        task,
        key,
        signal,
        timeoutMs: timeoutMs || this.operationTimeoutMs,
        resolve,
        reject,
        queueTimer: null,
        abortQueued: null,
      };
      entry.queueTimer = setTimeout(() => {
        const index = this.pending.indexOf(entry);
        if (index === -1) return;
        this.pending.splice(index, 1);
        signal?.removeEventListener('abort', entry.abortQueued);
        reject(new OperationControlError('QUEUE_TIMEOUT'));
      }, this.queueTimeoutMs);
      entry.abortQueued = () => {
        const index = this.pending.indexOf(entry);
        if (index === -1) return;
        this.pending.splice(index, 1);
        clearTimeout(entry.queueTimer);
        reject(new OperationControlError('REQUEST_ABORTED'));
      };
      signal?.addEventListener('abort', entry.abortQueued, { once: true });
      this.pending.push(entry);
      this.drain();
    });
  }

  drain() {
    while (this.active < this.concurrency) {
      const index = this.pending.findIndex(
        (entry) => (this.activeByKey.get(entry.key) || 0) < this.perKeyConcurrency,
      );
      if (index === -1) return;
      const [entry] = this.pending.splice(index, 1);
      clearTimeout(entry.queueTimer);
      entry.signal?.removeEventListener('abort', entry.abortQueued);
      this.start(entry);
    }
  }

  async start(entry) {
    this.active += 1;
    this.activeByKey.set(entry.key, (this.activeByKey.get(entry.key) || 0) + 1);
    const controller = new AbortController();
    let timeoutTriggered = false;
    const abortRunning = () => controller.abort();
    entry.signal?.addEventListener('abort', abortRunning, { once: true });
    const operationTimer = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort();
    }, entry.timeoutMs);

    try {
      const result = await entry.task(controller.signal);
      if (timeoutTriggered) {
        throw new OperationControlError('OPERATION_TIMEOUT');
      }
      if (entry.signal?.aborted) {
        throw new OperationControlError('REQUEST_ABORTED');
      }
      entry.resolve(result);
    } catch (error) {
      if (timeoutTriggered) {
        entry.reject(new OperationControlError('OPERATION_TIMEOUT'));
      } else if (entry.signal?.aborted) {
        entry.reject(new OperationControlError('REQUEST_ABORTED'));
      } else {
        entry.reject(error);
      }
    } finally {
      clearTimeout(operationTimer);
      entry.signal?.removeEventListener('abort', abortRunning);
      this.active -= 1;
      const keyActive = (this.activeByKey.get(entry.key) || 1) - 1;
      if (keyActive === 0) this.activeByKey.delete(entry.key);
      else this.activeByKey.set(entry.key, keyActive);
      this.drain();
    }
  }
}

module.exports = {
  OperationControlError,
  OperationQueue,
  positiveInteger,
};
