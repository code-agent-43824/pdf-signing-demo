class FixedWindowRateLimiter {
  constructor({
    limit,
    windowMs,
    now = () => Date.now(),
    maxEntries = 10000,
  }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  take(key) {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || now - entry.startedAt >= this.windowMs) {
      if (!entry && this.entries.size >= this.maxEntries) {
        this.cleanup();
        if (this.entries.size >= this.maxEntries) {
          const oldestKey = this.entries.keys().next().value;
          this.entries.delete(oldestKey);
        }
      }
      entry = { startedAt: now, count: 0 };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    const retryAfterMs = Math.max(0, this.windowMs - (now - entry.startedAt));
    return {
      allowed: entry.count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfterMs,
      resetAt: entry.startedAt + this.windowMs,
    };
  }

  cleanup() {
    const oldest = this.now() - this.windowMs;
    for (const [key, entry] of this.entries.entries()) {
      if (entry.startedAt < oldest) this.entries.delete(key);
    }
  }
}

function createRateLimitMiddleware({ limiter, HttpError, scope }) {
  return (req, res, next) => {
    const result = limiter.take(`${scope}:${req.ip}`);
    res.setHeader('RateLimit-Limit', result.limit);
    res.setHeader('RateLimit-Remaining', result.remaining);
    res.setHeader('RateLimit-Reset', Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
    if (result.allowed) return next();
    res.setHeader('Retry-After', Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
    return next(new HttpError(
      429,
      'RATE_LIMITED',
      'Слишком много запросов. Повторите попытку позже.',
    ));
  };
}

module.exports = {
  FixedWindowRateLimiter,
  createRateLimitMiddleware,
};
