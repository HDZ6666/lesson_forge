'use strict';

/**
 * Bounded retention for raw provider pages and diagnostics logs.
 *
 * - Raw pages of a run are deleted after COLLECTOR_RAW_RETENTION_DAYS (3)
 *   only when the backend has explicitly released that run's result
 *   (sync_result_cleanup): a clean collection is not yet an import, and an
 *   unresolved problem may still need the pages. Everything else keeps its
 *   evidence.
 * - Diagnostics files older than COLLECTOR_DIAGNOSTICS_RETENTION_DAYS (7)
 *   are deleted only when no unreleased run can still need them: a job's
 *   file follows its run's release; a file that cannot be tied to a run is
 *   kept while any run up to its time is unreleased.
 * - 0 disables a rule.  Returns what was removed so callers can log the
 *   real space change.
 */

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;

function days(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  return /^\d+$/.test(raw) ? Number(raw) : fallback;
}

function dirSize(target) {
  let size = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) size += dirSize(full);
    else if (entry.isFile()) size += fs.statSync(full).size;
  }
  return size;
}

function releasableRun(db, runId) {
  if (!db) return false;
  try {
    return Boolean(db.prepare('SELECT 1 FROM sync_result_cleanup WHERE run_id=?').get(runId));
  } catch {
    return false;
  }
}

// Unreleased runs with their start time (null when unknown). Without a
// readable run table nothing can be proven released, so evidence is kept.
function unreleasedRuns(db) {
  if (!db) return null;
  try {
    let hasStarted = true;
    try {
      db.prepare('SELECT started_at FROM sync_runs LIMIT 0').all();
    } catch {
      hasStarted = false;
    }
    const rows = db.prepare(`SELECT id${hasStarted ? ', started_at' : ''} FROM sync_runs`).all();
    return rows
      .filter((row) => !releasableRun(db, row.id))
      .map((row) => ({ id: Number(row.id), startedAt: row.started_at ? Date.parse(row.started_at) : null }));
  } catch {
    return null;
  }
}

function jobRunId(db, jobId) {
  try {
    const row = db.prepare('SELECT collector_run_id FROM collector_jobs WHERE id=?').get(jobId);
    return row && row.collector_run_id != null ? Number(row.collector_run_id) : null;
  } catch {
    return null;
  }
}

function diagnosticsNeeded(db, name, mtimeMs, pending) {
  if (pending === null) return true;
  const job = name.match(/^job-([\w-]+)\.jsonl\.gz$/);
  const runId = job && db ? jobRunId(db, job[1]) : null;
  if (runId != null) return pending.some((run) => run.id === runId);
  // Not tied to a run: keep it while any run that may have written it is unreleased.
  return pending.some((run) => run.startedAt === null || Number.isNaN(run.startedAt) || run.startedAt <= mtimeMs);
}

function pruneRetention(dataDir, db, { now = Date.now() } = {}) {
  const result = { rawRuns: 0, rawBytes: 0, diagnosticsFiles: 0, diagnosticsBytes: 0, keptRawRuns: 0 };
  if (!dataDir) return result;
  const rawDays = days('COLLECTOR_RAW_RETENTION_DAYS', 3);
  const rawRoot = path.join(dataDir, 'raw');
  if (rawDays > 0 && fs.existsSync(rawRoot)) {
    for (const day of fs.readdirSync(rawRoot, { withFileTypes: true })) {
      if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
      if (now - Date.parse(`${day.name}T00:00:00Z`) < (rawDays + 1) * DAY_MS) continue;
      const dayDir = path.join(rawRoot, day.name);
      for (const run of fs.readdirSync(dayDir, { withFileTypes: true })) {
        const match = run.isDirectory() && run.name.match(/^run-(\d+)$/);
        if (!match) continue;
        if (!releasableRun(db, Number(match[1]))) {
          result.keptRawRuns += 1;
          continue;
        }
        const target = path.join(dayDir, run.name);
        result.rawBytes += dirSize(target);
        fs.rmSync(target, { recursive: true, force: true });
        result.rawRuns += 1;
      }
      if (fs.readdirSync(dayDir).length === 0) fs.rmdirSync(dayDir);
    }
  }
  const diagnosticsDays = days('COLLECTOR_DIAGNOSTICS_RETENTION_DAYS', 7);
  const diagnosticsRoot = process.env.COLLECTOR_DIAGNOSTICS_DIR || path.join(dataDir, 'diagnostics');
  if (diagnosticsDays > 0 && fs.existsSync(diagnosticsRoot)) {
    const pending = unreleasedRuns(db);
    for (const entry of fs.readdirSync(diagnosticsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.jsonl\.gz$/.test(entry.name)) continue;
      const full = path.join(diagnosticsRoot, entry.name);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs < diagnosticsDays * DAY_MS) continue;
      if (diagnosticsNeeded(db, entry.name, stat.mtimeMs, pending)) {
        result.keptDiagnosticsFiles = (result.keptDiagnosticsFiles || 0) + 1;
        continue;
      }
      fs.unlinkSync(full);
      result.diagnosticsFiles += 1;
      result.diagnosticsBytes += stat.size;
    }
  }
  return result;
}

module.exports = { pruneRetention };
