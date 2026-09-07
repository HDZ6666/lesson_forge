'use strict';

/**
 * Sealing of runs a child left in `running` (crash, kill, restart) and the
 * log-text fallbacks used only when no structured error event arrived.
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { readRunSnapshotSummary } = require('../storage/readers/index.cjs');
const { isResumablePartialRun, isTransientResumeError } = require('../storage/resume.cjs');

function orphanRunIsResumable(dbPath, runId) {
  try {
    const summary = readRunSnapshotSummary(dbPath, runId, { allowIncomplete: true });
    return isResumablePartialRun({
      ...summary,
      status: 'interrupted',
      snapshotLockedAt: new Date().toISOString(),
    });
  } catch {
    return false;
  }
}

function looksBlocked(lines) {
  const text = lines.join('\n').toLowerCase();
  return [
    '验证码', '安全验证', '异常访问', '访问过于频繁', 'robots', '熔断', '契约',
    '授权范围', 'http 401', 'http 403', '收到 sig',
  ].some((marker) => text.includes(marker));
}

function lastError(lines, fallback) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = String(lines[index] || '').trim();
    if (line.includes('[错误]') || line.startsWith('Error:') || line.startsWith('[错误]')) return line.slice(0, 1000);
  }
  return fallback;
}

function sealOrphanContentRun(dbPath, runId, status, message = null) {
  const parsedRunId = Number(runId);
  if (!Number.isSafeInteger(parsedRunId) || parsedRunId < 1) return false;
  const terminalStatus = String(status || '').trim();
  if (!['failed', 'blocked', 'interrupted', 'cancelled'].includes(terminalStatus)) return false;
  let db;
  try {
    db = new DatabaseSync(path.resolve(dbPath));
    db.exec('PRAGMA busy_timeout = 5000;');
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE sync_runs
      SET finished_at = COALESCE(finished_at, ?),
          status = ?,
          message = COALESCE(message, ?),
          catalog_item_count = COALESCE((SELECT COUNT(*) FROM sync_run_catalog_items WHERE run_id = ?), 0),
          question_item_count = COALESCE((SELECT COUNT(*) FROM sync_run_question_items WHERE run_id = ?), 0),
          question_catalog_count = COALESCE((SELECT COUNT(*) FROM sync_run_question_catalogs WHERE run_id = ?), 0),
          question_tag_count = COALESCE((SELECT COUNT(*) FROM sync_run_question_tags WHERE run_id = ?), 0),
          question_asset_count = COALESCE((SELECT COUNT(*) FROM sync_run_question_assets WHERE run_id = ?), 0),
          snapshot_complete = 0,
          snapshot_locked_at = COALESCE(snapshot_locked_at, ?)
      WHERE id = ? AND status = 'running' AND snapshot_locked_at IS NULL
    `).run(
      now,
      terminalStatus,
      message ? String(message).slice(0, 4000) : null,
      parsedRunId,
      parsedRunId,
      parsedRunId,
      parsedRunId,
      parsedRunId,
      now,
      parsedRunId,
    );
    return Number(result?.changes || 0) > 0;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

function orphanHasResumablePartial(dbPath, runId, lines) {
  if (!isTransientResumeError({ message: (lines || []).join('\n') })) return false;
  try {
    const summary = readRunSnapshotSummary(dbPath, runId, { allowIncomplete: true });
    return isResumablePartialRun({
      ...summary,
      status: 'interrupted',
      snapshotLockedAt: new Date().toISOString(),
    });
  } catch {
    return false;
  }
}

function sealOrphanMetadataRun(dbPath, runId, status, message = null) {
  const parsedRunId = Number(runId);
  if (!Number.isSafeInteger(parsedRunId) || parsedRunId < 1) return false;
  const terminalStatus = String(status || '').trim();
  if (!['failed', 'blocked', 'cancelled'].includes(terminalStatus)) return false;
  let db;
  try {
    db = new DatabaseSync(path.resolve(dbPath));
    db.exec('PRAGMA busy_timeout = 5000;');
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE source_metadata_runs
      SET finished_at = COALESCE(finished_at, ?),
          status = ?,
          message = COALESCE(message, ?),
          snapshot_locked_at = COALESCE(snapshot_locked_at, ?)
      WHERE id = ? AND status = 'running' AND snapshot_locked_at IS NULL
    `).run(now, terminalStatus, message ? String(message).slice(0, 4000) : null, now, parsedRunId);
    return Number(result?.changes || 0) > 0;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

module.exports = {
  lastError,
  looksBlocked,
  orphanHasResumablePartial,
  orphanRunIsResumable,
  sealOrphanContentRun,
  sealOrphanMetadataRun,
};
