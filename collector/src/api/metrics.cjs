'use strict';

/**
 * GET /metrics: Prometheus text exposition of the collector's state.
 *
 * Built only from in-memory state plus the two one-row source tables, so a
 * scrape never touches the large snapshot tables and stays cheap enough to
 * poll every 15 seconds.  Gauges describe the active job (or the most recent
 * one); counters are per API process lifetime.
 */

const PRESSURE_LEVELS = ['ok', 'soft', 'low', 'paused'];
const ACTIVE = new Set(['queued', 'running', 'cancelling']);

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

class MetricWriter {
  constructor() {
    this.lines = [];
    this.declared = new Set();
  }

  declare(name, type, help) {
    if (this.declared.has(name)) return;
    this.declared.add(name);
    this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  }

  sample(name, type, help, value, labels = null) {
    if (value == null || !Number.isFinite(Number(value))) return;
    this.declare(name, type, help);
    const labelText =
      labels && Object.keys(labels).length
        ? `{${Object.entries(labels)
            .map(([key, label]) => `${key}="${escapeLabel(label)}"`)
            .join(',')}}`
        : '';
    this.lines.push(`${name}${labelText} ${Number(value)}`);
  }

  text() {
    return `${this.lines.join('\n')}\n`;
  }
}

function currentJob(manager) {
  if (manager.activeJobId) {
    const active = manager.jobs?.get(manager.activeJobId);
    if (active) return active;
  }
  let latest = null;
  for (const job of manager.jobs?.values?.() || []) {
    if (!latest || String(job.createdAt || '') > String(latest.createdAt || '')) latest = job;
  }
  return latest;
}

function safely(read) {
  try {
    return read();
  } catch {
    return null;
  }
}

function renderMetrics({ manager, readers = null, now = Date.now() }) {
  const out = new MetricWriter();
  const metrics = manager.metrics || {};
  out.sample('collector_up', 'gauge', 'API process is serving (0 while shutting down)', manager.stopping ? 0 : 1);
  if (metrics.startedAt) {
    out.sample(
      'collector_uptime_seconds',
      'gauge',
      'Seconds since the API process started',
      Math.floor((now - metrics.startedAt) / 1000),
    );
  }

  const job = currentJob(manager);
  out.sample(
    'collector_job_active',
    'gauge',
    '1 while a job is queued, running or cancelling',
    job && ACTIVE.has(job.status) ? 1 : 0,
  );
  if (job) {
    const labels = { run_type: job.runType || 'content' };
    out.sample(
      'collector_job_progress_percent',
      'gauge',
      'Progress of the active or latest job',
      job.progressPercent ?? 0,
      labels,
    );
    const scopes = Array.isArray(job.scopeItems) ? job.scopeItems : [];
    const sum = (key) => scopes.reduce((total, scope) => total + Number(scope[key] || 0), 0);
    out.sample(
      'collector_job_pages_ok',
      'gauge',
      'List pages collected by the active or latest job',
      sum('pagesOk'),
      labels,
    );
    out.sample(
      'collector_job_questions_seen',
      'gauge',
      'Questions seen by the active or latest job',
      sum('questionsSeen'),
      labels,
    );
    out.sample(
      'collector_job_errors',
      'gauge',
      'Errors recorded by the active or latest job',
      sum('errorCount'),
      labels,
    );
    out.sample('collector_child_rss_mb', 'gauge', 'Crawl child process RSS (MB)', job.childRssMb, labels);
    out.sample('collector_child_rss_peak_mb', 'gauge', 'Crawl child process peak RSS (MB)', job.childRssPeakMb, labels);
    out.sample('collector_browser_rss_mb', 'gauge', 'Chrome process tree PSS (MB)', job.childBrowserRssMb, labels);
    out.sample(
      'collector_browser_rss_peak_mb',
      'gauge',
      'Chrome process tree peak PSS (MB)',
      job.childBrowserRssPeakMb,
      labels,
    );
    out.sample(
      'collector_job_browser_recycles',
      'gauge',
      'Browser recycles in the active or latest job',
      job.browserRecycleCount || 0,
      labels,
    );
    out.sample(
      'collector_job_waiting',
      'gauge',
      '1 while the job waits on source verification',
      job.waitingReason ? 1 : 0,
      labels,
    );
  }

  out.sample(
    'collector_browser_recycles_total',
    'counter',
    'Browser recycles since the API process started',
    metrics.browserRecycles || 0,
  );
  for (const [status, count] of Object.entries(metrics.jobsFinished || {})) {
    out.sample('collector_jobs_finished_total', 'counter', 'Jobs finished since the API process started', count, {
      status,
    });
  }
  for (const [code, count] of Object.entries(metrics.jobErrors || {})) {
    out.sample(
      'collector_job_errors_total',
      'counter',
      'Finished jobs by error code since the API process started',
      count,
      { code },
    );
  }

  const resources = safely(() => manager.resourceGuard?.status());
  if (resources) {
    out.sample('collector_host_memory_free_mib', 'gauge', 'Host available memory (MiB)', resources.memoryMiB);
    for (const level of PRESSURE_LEVELS) {
      out.sample(
        'collector_memory_pressure',
        'gauge',
        'Current memory pressure level (one-hot)',
        resources.pressure === level ? 1 : 0,
        { level },
      );
    }
    for (const disk of resources.disks || []) {
      out.sample('collector_disk_free_mib', 'gauge', 'Free space on a collector storage path (MiB)', disk.freeMiB, {
        kind: disk.kind,
      });
    }
  }
  const control = safely(() => manager.sourceControl?.status());
  if (control) {
    out.sample(
      'collector_source_paused',
      'gauge',
      '1 while the source is in cooldown or needs manual verification',
      control.paused ? 1 : 0,
    );
    out.sample(
      'collector_source_manual_required',
      'gauge',
      '1 while the source needs manual verification',
      control.manualRequired ? 1 : 0,
    );
  }
  const budget = safely(() => manager.sourceBudget?.status());
  if (budget?.usage) {
    out.sample('collector_budget_requests_used', 'gauge', 'Source requests used today', budget.usage.requests);
    out.sample(
      'collector_budget_requests_limit',
      'gauge',
      'Daily source request limit (0 = unlimited)',
      budget.limits?.requests,
    );
    out.sample(
      'collector_budget_download_bytes_used',
      'gauge',
      'Asset bytes downloaded today',
      budget.usage.downloadBytes,
    );
    out.sample('collector_budget_paused', 'gauge', '1 while a daily budget is exhausted', budget.paused ? 1 : 0);
  }

  if (readers) {
    const pool = readers.status();
    out.sample('collector_reader_threads', 'gauge', 'Configured API reader threads', pool.threads);
    out.sample('collector_reader_busy', 'gauge', 'Reader threads running a query', pool.busy);
    out.sample('collector_reader_queued', 'gauge', 'Reads waiting for a thread', pool.queued);
    out.sample('collector_reader_calls_total', 'counter', 'Reads served', pool.calls);
    out.sample('collector_reader_failures_total', 'counter', 'Reads that failed', pool.failures);
    out.sample('collector_reader_timeouts_total', 'counter', 'Reads aborted by the timeout', pool.timeouts);
  }
  if (manager.persistStats) {
    out.sample(
      'collector_job_persist_writes_total',
      'counter',
      'Job state writes to SQLite',
      manager.persistStats.writes,
    );
    out.sample(
      'collector_job_persist_failures_total',
      'counter',
      'Job state writes that failed',
      manager.persistStats.failures,
    );
  }
  return out.text();
}

module.exports = { renderMetrics };
