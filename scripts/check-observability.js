#!/usr/bin/env node
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_STATE_PATH = '/home/openclaw/services/pdf-signing-demo/monitor-state.json';

function parseMetrics(text) {
  const values = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^(\S+)\s+([0-9.eE+-]+)$/.exec(line);
    if (match) values.set(match[1], Number(match[2]));
  }
  return values;
}

function metric(metrics, name, labels = null) {
  const suffix = labels
    ? `{${Object.entries(labels).map(([key, value]) => `${key}="${value}"`).join(',')}}`
    : '';
  return metrics.get(`${name}${suffix}`) || 0;
}

function counterSnapshot(metrics) {
  const counters = {};
  for (const [name, value] of metrics) {
    if (
      name.startsWith('pdf_signing_failures_total{')
      || name.startsWith('pdf_signing_rate_limited_total{')
      || name === 'pdf_signing_cleanup_failures_total'
    ) {
      counters[name] = value;
    }
  }
  return counters;
}

function evaluate(snapshot, previous = {}) {
  const persistent = [];
  const events = [];
  const { metrics } = snapshot;
  if (!snapshot.localReady) persistent.push('local_readiness_failed');
  if (!snapshot.publicReady) persistent.push('public_readiness_failed');
  if (snapshot.serviceState !== 'active') persistent.push('service_inactive');
  if (snapshot.restarts > 0) persistent.push('service_restarted');
  if (snapshot.diskAvailableBytes < 512 * 1024 * 1024 || snapshot.diskAvailableRatio < 0.05) {
    persistent.push('host_disk_low');
  }
  const queued = metric(metrics, 'pdf_signing_workers', { state: 'queued' });
  const maxQueue = metric(metrics, 'pdf_signing_workers', { state: 'max_queue' });
  if (maxQueue > 0 && queued >= maxQueue) persistent.push('worker_queue_full');
  const sessionUsed = metric(metrics, 'pdf_signing_session_memory_bytes', { kind: 'used' });
  const sessionLimit = metric(metrics, 'pdf_signing_session_memory_bytes', { kind: 'limit' });
  if (sessionLimit > 0 && sessionUsed / sessionLimit >= 0.8) {
    persistent.push('session_memory_high');
  }
  const resultUsed = metric(metrics, 'pdf_signing_result_disk_bytes', { kind: 'used' })
    + metric(metrics, 'pdf_signing_result_disk_bytes', { kind: 'pending' });
  const resultLimit = metric(metrics, 'pdf_signing_result_disk_bytes', { kind: 'limit' });
  if (resultLimit > 0 && resultUsed / resultLimit >= 0.8) {
    persistent.push('result_storage_high');
  }

  const counters = counterSnapshot(metrics);
  let failureDelta = 0;
  let criticalFailureDelta = 0;
  let rateLimitDelta = 0;
  let cleanupDelta = 0;
  for (const [name, value] of Object.entries(counters)) {
    const delta = Math.max(0, value - (previous.counters?.[name] || 0));
    if (name.startsWith('pdf_signing_failures_total{')) {
      failureDelta += delta;
      if (/code="(?:INTERNAL_ERROR|WORKER_[A-Z0-9_]+|PDF_TOOL_FAILED)"/.test(name)) {
        criticalFailureDelta += delta;
      }
    }
    if (name.startsWith('pdf_signing_rate_limited_total{')) rateLimitDelta += delta;
    if (name === 'pdf_signing_cleanup_failures_total') cleanupDelta += delta;
  }
  if (criticalFailureDelta > 0) events.push(`critical_failures:${criticalFailureDelta}`);
  else if (failureDelta >= 5) events.push(`signing_failures:${failureDelta}`);
  if (rateLimitDelta >= 5) events.push(`rate_limits:${rateLimitDelta}`);
  if (cleanupDelta > 0) events.push(`cleanup_failures:${cleanupDelta}`);

  const previousPersistent = new Set(previous.persistent || []);
  const currentPersistent = new Set(persistent);
  return {
    alerts: persistent.filter((item) => !previousPersistent.has(item)),
    recovered: [...previousPersistent].filter((item) => !currentPersistent.has(item)),
    events,
    persistent,
    counters,
  };
}

async function fetchOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function collect() {
  const localBase = process.env.LOCAL_URL || 'http://127.0.0.1:3010/pdf-signing/';
  const publicBase = process.env.PUBLIC_URL || 'https://mescheryakov.pro/pdf-signing/';
  const metricsResponse = await fetch(`${localBase}health/metrics`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!metricsResponse.ok) throw new Error(`metrics returned HTTP ${metricsResponse.status}`);
  const disk = await fsp.statfs('/home/openclaw/services/pdf-signing-demo');
  const serviceProperties = execFileSync(
    'systemctl',
    ['--user', 'show', 'pdf-signing-demo.service', '-p', 'ActiveState', '-p', 'NRestarts'],
    { encoding: 'utf8', timeout: 5000 },
  );
  const properties = Object.fromEntries(serviceProperties.trim().split('\n').map((line) => line.split('=')));
  return {
    checkedAt: new Date().toISOString(),
    localReady: await fetchOk(`${localBase}health/ready`),
    publicReady: await fetchOk(`${publicBase}health/ready`),
    serviceState: properties.ActiveState || 'unknown',
    restarts: Number(properties.NRestarts || 0),
    diskAvailableBytes: Number(disk.bavail * disk.bsize),
    diskAvailableRatio: Number(disk.bavail) / Number(disk.blocks),
    metrics: parseMetrics(await metricsResponse.text()),
  };
}

async function main() {
  const statePath = process.env.OBSERVABILITY_STATE_PATH || DEFAULT_STATE_PATH;
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const snapshot = await collect();
  const evaluated = evaluate(snapshot, previous);
  const state = {
    checkedAt: snapshot.checkedAt,
    counters: evaluated.counters,
    persistent: evaluated.persistent,
  };
  await fsp.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const tempPath = `${statePath}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await fsp.rename(tempPath, statePath);
  process.stdout.write(`${JSON.stringify({
    ok: evaluated.persistent.length === 0,
    checkedAt: snapshot.checkedAt,
    alerts: evaluated.alerts,
    recovered: evaluated.recovered,
    events: evaluated.events,
    serviceState: snapshot.serviceState,
    restarts: snapshot.restarts,
    diskAvailableBytes: snapshot.diskAvailableBytes,
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      event: 'observability_check_failed',
      message: String(error?.message || error).slice(0, 500),
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { counterSnapshot, evaluate, metric, parseMetrics };
