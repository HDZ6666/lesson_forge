'use strict';

/**
 * Bounded retention for raw provider pages and diagnostics logs.
 *
 * - Raw pages of a run are deleted after COLLECTOR_RAW_RETENTION_DAYS (3)
 *   only when that run is terminal and either reclaimed or sealed as a clean
 *   success, i.e. no import or unresolved failure can still need them.
 *   Runs that failed, were interrupted or are still open keep their evidence.
 * - Diagnostics files older than COLLECTOR_DIAGNOSTICS_RETENTION_DAYS (7)
 *   are deleted; the file a running job is appending to is newer than that.
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
    const reclaimed = db.prepare('SELECT 1 FROM sync_result_cleanup WHERE run_id=?').get(runId);
    if (reclaimed) return true;
  } catch {}
  try {
    const run = db.prepare('SELECT status, snapshot_locked_at FROM sync_runs WHERE id=?').get(runId);
    return Boolean(run && run.snapshot_locked_at && ['success', 'completed'].includes(String(run.status)));
  } catch {
    return false;
  }
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
    for (const entry of fs.readdirSync(diagnosticsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.jsonl\.gz$/.test(entry.name)) continue;
      const full = path.join(diagnosticsRoot, entry.name);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs < diagnosticsDays * DAY_MS) continue;
      fs.unlinkSync(full);
      result.diagnosticsFiles += 1;
      result.diagnosticsBytes += stat.size;
    }
  }
  return result;
}

module.exports = { pruneRetention };
