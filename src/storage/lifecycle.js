const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

class StorageLimitError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StorageLimitError';
    this.code = code;
  }
}

function bufferBytes(value) {
  if (Buffer.isBuffer(value)) return value.length;
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + bufferBytes(item), 0);
  }
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value)
    .reduce((total, item) => total + bufferBytes(item), 0);
}

function createSessionStore({
  ttlMs,
  tombstoneTtlMs = ttlMs,
  maxSessions,
  maxSessionsPerOwner,
  maxMemoryBytes,
  now = Date.now,
}) {
  const sessions = new Map();
  const ownerCounts = new Map();
  let memoryBytes = 0;

  function releasePrepared(session) {
    if (session.state !== 'prepared') return;
    memoryBytes -= session.memoryBytes;
    const ownerCount = ownerCounts.get(session.ownerKey) || 0;
    if (ownerCount <= 1) ownerCounts.delete(session.ownerKey);
    else ownerCounts.set(session.ownerKey, ownerCount - 1);
    delete session.payload;
    delete session.ownerKey;
    delete session.memoryBytes;
  }

  function transition(session, state, timestamp) {
    releasePrepared(session);
    session.state = state;
    session.finishedAt = timestamp;
  }

  function expireIfNeeded(session, timestamp) {
    if (session.state === 'prepared' && timestamp >= session.expiresAt) {
      transition(session, 'expired', timestamp);
    }
  }

  return {
    create(payload, ownerKey) {
      const timestamp = now();
      this.cleanup(timestamp);
      const ownerCount = ownerCounts.get(ownerKey) || 0;
      const payloadBytes = bufferBytes(payload);
      const activeSessions = this.stats().prepared;
      if (activeSessions >= maxSessions) {
        throw new StorageLimitError('SESSION_COUNT_LIMIT');
      }
      if (ownerCount >= maxSessionsPerOwner) {
        throw new StorageLimitError('SESSION_OWNER_LIMIT');
      }
      if (payloadBytes > maxMemoryBytes || memoryBytes + payloadBytes > maxMemoryBytes) {
        throw new StorageLimitError('SESSION_MEMORY_LIMIT');
      }

      const id = crypto.randomUUID();
      sessions.set(id, {
        id,
        state: 'prepared',
        createdAt: timestamp,
        expiresAt: timestamp + ttlMs,
        ownerKey,
        memoryBytes: payloadBytes,
        payload,
      });
      ownerCounts.set(ownerKey, ownerCount + 1);
      memoryBytes += payloadBytes;
      return id;
    },

    getPrepared(id) {
      const session = sessions.get(id);
      if (!session) return null;
      expireIfNeeded(session, now());
      return session.state === 'prepared' ? session.payload : null;
    },

    complete(id) {
      const session = sessions.get(id);
      if (!session || session.state !== 'prepared') return false;
      transition(session, 'completed', now());
      return true;
    },

    fail(id) {
      const session = sessions.get(id);
      if (!session || session.state !== 'prepared') return false;
      transition(session, 'failed', now());
      return true;
    },

    cleanup(timestamp = now()) {
      for (const [id, session] of sessions.entries()) {
        expireIfNeeded(session, timestamp);
        if (
          session.state !== 'prepared'
          && timestamp - session.finishedAt >= tombstoneTtlMs
        ) {
          sessions.delete(id);
        }
      }
    },

    stats() {
      const states = {
        prepared: 0,
        completed: 0,
        failed: 0,
        expired: 0,
      };
      for (const session of sessions.values()) {
        states[session.state] += 1;
      }
      return {
        ...states,
        memoryBytes,
        maxSessions,
        maxSessionsPerOwner,
        maxMemoryBytes,
      };
    },
  };
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const RESULT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

function createResultStore({
  resultsDir,
  ttlMs,
  maxResults,
  maxDiskBytes,
  now = Date.now,
}) {
  const results = new Map();
  const capabilities = new Map();
  const deletions = new Map();
  const expiryTimers = new Map();
  let diskBytes = 0;
  let pendingCount = 0;
  let pendingBytes = 0;

  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(resultsDir, 0o700);

  function scheduleExpiry(result) {
    const existing = expiryTimers.get(result.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void deleteResult(result.id).catch(() => {
        // The background cleanup loop retries and reports filesystem failures.
      });
    }, Math.max(0, result.expiresAt - now()));
    timer.unref?.();
    expiryTimers.set(result.id, timer);
  }

  function restoreStoredResults() {
    const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
    const retainedPaths = new Set();
    const timestamp = now();

    for (const entry of entries) {
      const match = /^result-(.+)\.json$/.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
      const metadataPath = path.join(resultsDir, entry.name);
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const id = match[1];
        const filePath = path.join(resultsDir, `result-${id}.pdf`);
        const stats = fs.lstatSync(filePath);
        const valid = (
          metadata?.schemaVersion === 1
          && id === metadata.id
          && RESULT_ID_PATTERN.test(id)
          && stats.isFile()
          && !stats.isSymbolicLink()
          && Number.isSafeInteger(metadata.size)
          && metadata.size === stats.size
          && Number.isSafeInteger(metadata.createdAt)
          && Number.isSafeInteger(metadata.expiresAt)
          && metadata.expiresAt > metadata.createdAt
          && metadata.expiresAt <= metadata.createdAt + ttlMs
          && metadata.expiresAt > timestamp
          && TOKEN_HASH_PATTERN.test(metadata.previewTokenHash)
          && TOKEN_HASH_PATTERN.test(metadata.downloadTokenHash)
          && metadata.previewTokenHash !== metadata.downloadTokenHash
          && !capabilities.has(metadata.previewTokenHash)
          && !capabilities.has(metadata.downloadTokenHash)
        );
        if (!valid) continue;

        fs.chmodSync(filePath, 0o600);
        fs.chmodSync(metadataPath, 0o600);

        const result = {
          id,
          filePath,
          metadataPath,
          size: metadata.size,
          createdAt: metadata.createdAt,
          expiresAt: metadata.expiresAt,
          previewTokenHash: metadata.previewTokenHash,
          downloadTokenHash: metadata.downloadTokenHash,
        };
        results.set(id, result);
        capabilities.set(result.previewTokenHash, { resultId: id, kind: 'preview' });
        capabilities.set(result.downloadTokenHash, { resultId: id, kind: 'download' });
        diskBytes += result.size;
        retainedPaths.add(filePath);
        retainedPaths.add(metadataPath);
        scheduleExpiry(result);
      } catch (_error) {
        // Invalid or incomplete records are removed by the orphan sweep below.
      }
    }

    for (const entry of entries) {
      const entryPath = path.join(resultsDir, entry.name);
      if (
        (entry.isFile() || entry.isSymbolicLink())
        && !retainedPaths.has(entryPath)
      ) {
        fs.unlinkSync(entryPath);
      }
    }
  }

  async function deleteResult(id) {
    if (deletions.has(id)) return deletions.get(id);
    const result = results.get(id);
    if (!result) return;
    const deletion = (async () => {
      let deletionError = null;
      for (const candidate of [result.filePath, result.metadataPath]) {
        try {
          await fsp.unlink(candidate);
        } catch (error) {
          if (error.code !== 'ENOENT' && !deletionError) deletionError = error;
        }
      }
      if (!deletionError && results.get(id) === result) {
        results.delete(id);
        capabilities.delete(result.previewTokenHash);
        capabilities.delete(result.downloadTokenHash);
        const expiryTimer = expiryTimers.get(id);
        if (expiryTimer) clearTimeout(expiryTimer);
        expiryTimers.delete(id);
        diskBytes -= result.size;
      }
      if (deletionError) throw deletionError;
    })().finally(() => {
      deletions.delete(id);
    });
    deletions.set(id, deletion);
    return deletion;
  }

  restoreStoredResults();

  async function cleanup(timestamp = now()) {
    const expired = [];
    for (const [id, result] of results.entries()) {
      if (timestamp >= result.expiresAt) expired.push(id);
    }
    await Promise.all(expired.map((id) => deleteResult(id)));
  }

  return {
    async save(buffer) {
      await cleanup();
      if (results.size + pendingCount >= maxResults) {
        throw new StorageLimitError('RESULT_COUNT_LIMIT');
      }
      if (
        buffer.length > maxDiskBytes
        || diskBytes + pendingBytes + buffer.length > maxDiskBytes
      ) {
        throw new StorageLimitError('RESULT_DISK_LIMIT');
      }
      pendingCount += 1;
      pendingBytes += buffer.length;

      const id = crypto.randomUUID();
      const fileName = `result-${id}.pdf`;
      const filePath = path.join(resultsDir, fileName);
      const tempPath = path.join(resultsDir, `.result-${id}.tmp`);
      const metadataPath = path.join(resultsDir, `result-${id}.json`);
      const tempMetadataPath = path.join(resultsDir, `.result-${id}.json.tmp`);
      const previewToken = crypto.randomBytes(32).toString('base64url');
      const downloadToken = crypto.randomBytes(32).toString('base64url');
      const previewTokenHash = tokenHash(previewToken);
      const downloadTokenHash = tokenHash(downloadToken);
      const createdAt = now();
      const result = {
        id,
        filePath,
        metadataPath,
        size: buffer.length,
        createdAt,
        expiresAt: createdAt + ttlMs,
        previewTokenHash,
        downloadTokenHash,
      };
      const metadata = {
        schemaVersion: 1,
        id,
        size: result.size,
        createdAt: result.createdAt,
        expiresAt: result.expiresAt,
        previewTokenHash,
        downloadTokenHash,
      };

      try {
        try {
          await fsp.writeFile(tempPath, buffer, { mode: 0o600, flag: 'wx' });
          await fsp.writeFile(
            tempMetadataPath,
            `${JSON.stringify(metadata)}\n`,
            { mode: 0o600, flag: 'wx' },
          );
          await fsp.rename(tempPath, filePath);
          await fsp.rename(tempMetadataPath, metadataPath);
        } catch (error) {
          for (const candidate of [tempPath, tempMetadataPath, filePath, metadataPath]) {
            try {
              await fsp.unlink(candidate);
            } catch (cleanupError) {
              if (cleanupError.code !== 'ENOENT') throw cleanupError;
            }
          }
          throw error;
        }

        results.set(id, result);
        capabilities.set(previewTokenHash, { resultId: id, kind: 'preview' });
        capabilities.set(downloadTokenHash, { resultId: id, kind: 'download' });
        diskBytes += buffer.length;
        scheduleExpiry(result);

        return {
          previewToken,
          downloadToken,
          expiresAt: result.expiresAt,
        };
      } finally {
        pendingCount -= 1;
        pendingBytes -= buffer.length;
      }
    },

    resolve(token) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const capability = capabilities.get(tokenHash(token));
      if (!capability) return null;
      const result = results.get(capability.resultId);
      if (!result || now() >= result.expiresAt) {
        if (result) {
          void deleteResult(result.id).catch(() => {
            // The background cleanup loop retries and reports filesystem failures.
          });
        }
        return null;
      }
      return {
        kind: capability.kind,
        filePath: result.filePath,
        size: result.size,
        expiresAt: result.expiresAt,
      };
    },

    cleanup,

    close() {
      for (const timer of expiryTimers.values()) clearTimeout(timer);
      expiryTimers.clear();
    },

    stats() {
      return {
        count: results.size,
        diskBytes,
        pendingCount,
        pendingBytes,
        maxResults,
        maxDiskBytes,
      };
    },
  };
}

module.exports = {
  StorageLimitError,
  bufferBytes,
  createResultStore,
  createSessionStore,
};
