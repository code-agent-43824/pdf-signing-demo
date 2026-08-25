const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createObservabilityMetrics } = require('../src/observability/metrics');
const { evaluate, parseMetrics } = require('../scripts/check-observability');

function stores() {
  return {
    operationQueue: {
      stats: () => ({ active: 1, queued: 0, concurrency: 1, maxQueue: 8 }),
    },
    sessions: {
      stats: () => ({
        prepared: 1,
        completed: 0,
        failed: 0,
        expired: 0,
        memoryBytes: 1024,
        maxMemoryBytes: 4096,
      }),
    },
    results: {
      stats: () => ({
        count: 1,
        pendingCount: 0,
        diskBytes: 2048,
        pendingBytes: 0,
        maxDiskBytes: 8192,
      }),
    },
  };
}

test('metrics expose only bounded aggregate labels and counters', () => {
  const metrics = createObservabilityMetrics({ now: () => 1_000 });
  metrics.observeRequest('prepare', 0.25, 200);
  metrics.observeRequest('complete', 0.5, 429, 'RATE_LIMITED');
  metrics.observeRequest('attacker-value', 0.5, 500, 'bad\nlabel');
  metrics.observePdf(1234, 2);
  metrics.recordCleanupFailure();
  const rendered = metrics.render(stores());

  assert.match(rendered, /pdf_signing_operation_duration_seconds_sum\{operation="prepare",outcome="success"\} 0\.25/);
  assert.match(rendered, /pdf_signing_failures_total\{operation="complete",code="RATE_LIMITED"\} 1/);
  assert.match(rendered, /pdf_signing_failures_total\{operation="unknown",code="INTERNAL_ERROR"\} 1/);
  assert.match(rendered, /pdf_signing_rate_limited_total\{operation="complete"\} 1/);
  assert.match(rendered, /pdf_signing_pdf_bytes_total 1234/);
  assert.match(rendered, /pdf_signing_cleanup_failures_total 1/);
  assert.doesNotMatch(rendered, /attacker-value|bad\nlabel/);
});

test('production checks detect persistent pressure, counter bursts and recovery', () => {
  const metrics = parseMetrics([
    'pdf_signing_workers{state="queued"} 8',
    'pdf_signing_workers{state="max_queue"} 8',
    'pdf_signing_session_memory_bytes{kind="used"} 80',
    'pdf_signing_session_memory_bytes{kind="limit"} 100',
    'pdf_signing_result_disk_bytes{kind="used"} 10',
    'pdf_signing_result_disk_bytes{kind="pending"} 0',
    'pdf_signing_result_disk_bytes{kind="limit"} 100',
    'pdf_signing_failures_total{operation="prepare",code="INVALID_PDF"} 7',
    'pdf_signing_rate_limited_total{operation="prepare"} 6',
    'pdf_signing_cleanup_failures_total 1',
  ].join('\n'));
  const result = evaluate({
    localReady: false,
    publicReady: true,
    serviceState: 'active',
    restarts: 0,
    diskAvailableBytes: 1024 ** 3,
    diskAvailableRatio: 0.1,
    metrics,
  });

  assert.deepEqual(result.alerts, [
    'local_readiness_failed',
    'worker_queue_full',
    'session_memory_high',
  ]);
  assert.deepEqual(result.events, [
    'signing_failures:7',
    'rate_limits:6',
    'cleanup_failures:1',
  ]);
  const recovered = evaluate({
    localReady: true,
    publicReady: true,
    serviceState: 'active',
    restarts: 0,
    diskAvailableBytes: 1024 ** 3,
    diskAvailableRatio: 0.1,
    metrics: parseMetrics([
      'pdf_signing_workers{state="queued"} 0',
      'pdf_signing_workers{state="max_queue"} 8',
      'pdf_signing_session_memory_bytes{kind="used"} 0',
      'pdf_signing_session_memory_bytes{kind="limit"} 100',
    ].join('\n')),
  }, result);
  assert.deepEqual(recovered.recovered, result.persistent);
});
