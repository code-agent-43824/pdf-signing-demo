const OPERATIONS = new Set(['prepare', 'complete']);

function metricLine(name, labels, value) {
  const encodedLabels = Object.entries(labels)
    .map(([key, item]) => `${key}="${String(item).replace(/[\\"\n]/g, '_')}"`)
    .join(',');
  return `${name}${encodedLabels ? `{${encodedLabels}}` : ''} ${value}`;
}

function createObservabilityMetrics({ now = Date.now } = {}) {
  const startedAt = now() / 1000;
  const operations = new Map();
  const failures = new Map();
  const rateLimits = new Map();
  let pdfCount = 0;
  let pdfBytes = 0;
  let pdfPages = 0;
  let cleanupFailures = 0;

  function operationName(value) {
    return OPERATIONS.has(value) ? value : 'unknown';
  }

  function errorCode(value) {
    return /^[A-Z][A-Z0-9_]{0,63}$/.test(value || '')
      ? value
      : 'INTERNAL_ERROR';
  }

  function observeRequest(operation, durationSeconds, status, code = null) {
    const name = operationName(operation);
    const outcome = status < 400 ? 'success' : 'error';
    const key = `${name}:${outcome}`;
    const current = operations.get(key) || { count: 0, sum: 0 };
    current.count += 1;
    current.sum += Math.max(0, durationSeconds);
    operations.set(key, current);
    if (outcome === 'error') {
      const failureKey = `${name}:${errorCode(code)}`;
      failures.set(failureKey, (failures.get(failureKey) || 0) + 1);
    }
    if (status === 429) {
      rateLimits.set(name, (rateLimits.get(name) || 0) + 1);
    }
  }

  function observePdf(bytes, pages) {
    pdfCount += 1;
    pdfBytes += Math.max(0, Number(bytes) || 0);
    pdfPages += Math.max(0, Number(pages) || 0);
  }

  function recordCleanupFailure() {
    cleanupFailures += 1;
  }

  function render({ operationQueue, results, sessions }) {
    const queue = operationQueue.stats();
    const sessionStats = sessions.stats();
    const resultStats = results.stats();
    const memory = process.memoryUsage();
    const lines = [
      '# HELP pdf_signing_process_start_time_seconds Unix process start time.',
      '# TYPE pdf_signing_process_start_time_seconds gauge',
      metricLine('pdf_signing_process_start_time_seconds', {}, startedAt),
      '# HELP pdf_signing_operation_duration_seconds Signing request duration.',
      '# TYPE pdf_signing_operation_duration_seconds summary',
    ];
    for (const [key, value] of operations) {
      const [operation, outcome] = key.split(':');
      const labels = { operation, outcome };
      lines.push(metricLine('pdf_signing_operation_duration_seconds_count', labels, value.count));
      lines.push(metricLine('pdf_signing_operation_duration_seconds_sum', labels, value.sum));
    }
    lines.push(
      '# HELP pdf_signing_failures_total Failed signing requests by safe error code.',
      '# TYPE pdf_signing_failures_total counter',
    );
    for (const [key, value] of failures) {
      const separator = key.indexOf(':');
      lines.push(metricLine('pdf_signing_failures_total', {
        operation: key.slice(0, separator),
        code: key.slice(separator + 1),
      }, value));
    }
    lines.push(
      '# HELP pdf_signing_rate_limited_total Rejected signing requests.',
      '# TYPE pdf_signing_rate_limited_total counter',
    );
    for (const operation of OPERATIONS) {
      lines.push(metricLine('pdf_signing_rate_limited_total', { operation }, rateLimits.get(operation) || 0));
    }
    lines.push(
      '# HELP pdf_signing_pdf_documents_total Validated source PDF documents.',
      '# TYPE pdf_signing_pdf_documents_total counter',
      metricLine('pdf_signing_pdf_documents_total', {}, pdfCount),
      '# HELP pdf_signing_pdf_bytes_total Validated source PDF bytes.',
      '# TYPE pdf_signing_pdf_bytes_total counter',
      metricLine('pdf_signing_pdf_bytes_total', {}, pdfBytes),
      '# HELP pdf_signing_pdf_pages_total Validated source PDF pages.',
      '# TYPE pdf_signing_pdf_pages_total counter',
      metricLine('pdf_signing_pdf_pages_total', {}, pdfPages),
      '# HELP pdf_signing_cleanup_failures_total Result cleanup failures.',
      '# TYPE pdf_signing_cleanup_failures_total counter',
      metricLine('pdf_signing_cleanup_failures_total', {}, cleanupFailures),
      '# HELP pdf_signing_workers Current worker queue state.',
      '# TYPE pdf_signing_workers gauge',
      metricLine('pdf_signing_workers', { state: 'active' }, queue.active),
      metricLine('pdf_signing_workers', { state: 'queued' }, queue.queued),
      metricLine('pdf_signing_workers', { state: 'concurrency' }, queue.concurrency),
      metricLine('pdf_signing_workers', { state: 'max_queue' }, queue.maxQueue),
      '# HELP pdf_signing_sessions Current signing session state.',
      '# TYPE pdf_signing_sessions gauge',
    );
    for (const state of ['prepared', 'completed', 'failed', 'expired']) {
      lines.push(metricLine('pdf_signing_sessions', { state }, sessionStats[state]));
    }
    lines.push(
      '# HELP pdf_signing_session_memory_bytes Session memory usage and limit.',
      '# TYPE pdf_signing_session_memory_bytes gauge',
      metricLine('pdf_signing_session_memory_bytes', { kind: 'used' }, sessionStats.memoryBytes),
      metricLine('pdf_signing_session_memory_bytes', { kind: 'limit' }, sessionStats.maxMemoryBytes),
      '# HELP pdf_signing_results Current result storage state.',
      '# TYPE pdf_signing_results gauge',
      metricLine('pdf_signing_results', { state: 'stored' }, resultStats.count),
      metricLine('pdf_signing_results', { state: 'pending' }, resultStats.pendingCount),
      '# HELP pdf_signing_result_disk_bytes Result storage usage and limit.',
      '# TYPE pdf_signing_result_disk_bytes gauge',
      metricLine('pdf_signing_result_disk_bytes', { kind: 'used' }, resultStats.diskBytes),
      metricLine('pdf_signing_result_disk_bytes', { kind: 'pending' }, resultStats.pendingBytes),
      metricLine('pdf_signing_result_disk_bytes', { kind: 'limit' }, resultStats.maxDiskBytes),
      '# HELP pdf_signing_process_resident_memory_bytes Resident process memory.',
      '# TYPE pdf_signing_process_resident_memory_bytes gauge',
      metricLine('pdf_signing_process_resident_memory_bytes', {}, memory.rss),
      '',
    );
    return lines.join('\n');
  }

  return {
    observePdf,
    observeRequest,
    recordCleanupFailure,
    render,
  };
}

module.exports = { createObservabilityMetrics };
