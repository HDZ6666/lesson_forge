'use strict';

/**
 * SQLite persistence for API jobs (`collector_jobs`).
 *
 * One row per job.  `active_slot` is 1 while a job is queued/running and NULL
 * once terminal; the unique index on it is the cross-process mutex: a second
 * manager (same or another process) gets a constraint error and answers 409.
 * `owner_pid` / `owner_token` / `heartbeat_at` let a fresh manager tell a live
 * owner from a crashed one and seal what the crash left behind.
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const JOB_TABLE = 'collector_jobs';
const MAX_LOADED_JOBS = 100;
const MAX_RETAINED_JOBS = 500;
const MAX_LOG_TAIL_CHARS = 24000;
const MAX_PAYLOAD_CHARS = 512 * 1024;

// In-process registry of live managers.  A row whose owner token is still
// registered belongs to a manager in this very process and is never treated
// as an orphan, even though it shares our pid.
const LIVE_OWNER_TOKENS = new Set();

const PERSISTED_FIELDS = [
  'id', 'runType', 'status', 'phase', 'metadataRunId', 'collectorRunId',
  'textbookExternalIds', 'scopeItems', 'maxPages', 'totalVersions',
  'completedVersions', 'totalTextbooks', 'completedTextbooks', 'catalogCount',
  'questionCount', 'questionCatalogCount', 'questionTagCount',
  'questionAssetCount', 'snapshotLockedAt', 'snapshotComplete',
  'currentTextbookId', 'currentTextbookName', 'progressPercent',
  'errorMessage', 'errorCode', 'createdAt', 'startedAt', 'finishedAt',
  'cancelRequested', 'partialInterrupted', 'partialMessage', 'abortCode',
  'lastErrorEvent', 'waitingReason', 'waitingSince', 'childRssMb', 'childRssPeakMb',
];

function ensureJobSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${JOB_TABLE} (
      id TEXT PRIMARY KEY,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT,
      active_slot INTEGER,
      owner_pid INTEGER,
      owner_token TEXT,
      payload_json TEXT NOT NULL,
      scope_json TEXT,
      metadata_run_id INTEGER,
      collector_run_id INTEGER,
      progress_percent REAL,
      error_code TEXT,
      error_message TEXT,
      current_textbook_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      heartbeat_at TEXT,
      child_pid INTEGER,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      log_tail TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_${JOB_TABLE}_active_slot ON ${JOB_TABLE}(active_slot);
    CREATE INDEX IF NOT EXISTS ix_${JOB_TABLE}_created_at ON ${JOB_TABLE}(created_at);
  `);
}

function isUniqueViolation(error) {
  const code = String(error?.code || error?.errcode || '');
  const message = String(error?.message || '');
  return code.includes('CONSTRAINT') || /UNIQUE constraint failed/i.test(message);
}

function serializeJob(job) {
  const payload = {};
  for (const field of PERSISTED_FIELDS) {
    if (job[field] !== undefined) payload[field] = job[field];
  }
  let json = JSON.stringify(payload);
  if (json.length > MAX_PAYLOAD_CHARS) {
    // Scope items dominate payload size for very large selections.  Drop the
    // optional live counters but keep identity and terminal state.
    payload.scopeItems = (payload.scopeItems || []).map((scope) => ({
      sourceProvider: scope.sourceProvider,
      externalVersionId: scope.externalVersionId,
      externalTextbookId: scope.externalTextbookId,
      textbookName: scope.textbookName,
      bootstrapChapterExternalId: scope.bootstrapChapterExternalId,
      resumeFromCollectorRunId: scope.resumeFromCollectorRunId,
      collectorRunId: scope.collectorRunId,
      status: scope.status,
      error: scope.error,
      errorCode: scope.errorCode,
      resumable: scope.resumable,
      snapshotComplete: scope.snapshotComplete,
    }));
    json = JSON.stringify(payload).slice(0, MAX_PAYLOAD_CHARS);
  }
  return json;
}

function deserializeJob(row) {
  if (!row) return null;
  let payload = {};
  try {
    payload = JSON.parse(row.payload_json || '{}') || {};
  } catch {
    payload = {};
  }
  const logTail = String(row.log_tail || '');
  return {
    ...payload,
    id: String(row.id),
    runType: String(row.run_type || payload.runType || 'content'),
    status: String(row.status || payload.status || 'failed'),
    phase: row.phase == null ? payload.phase ?? null : String(row.phase),
    metadataRunId: row.metadata_run_id == null ? payload.metadataRunId ?? null : Number(row.metadata_run_id),
    collectorRunId: row.collector_run_id == null ? payload.collectorRunId ?? null : Number(row.collector_run_id),
    progressPercent: row.progress_percent == null ? payload.progressPercent ?? 0 : Number(row.progress_percent),
    errorCode: row.error_code == null ? payload.errorCode ?? null : String(row.error_code),
    errorMessage: row.error_message == null ? payload.errorMessage ?? null : String(row.error_message),
    currentTextbookId: row.current_textbook_id == null ? null : String(row.current_textbook_id),
    createdAt: String(row.created_at || payload.createdAt || ''),
    startedAt: row.started_at == null ? payload.startedAt ?? null : String(row.started_at),
    finishedAt: row.finished_at == null ? payload.finishedAt ?? null : String(row.finished_at),
    heartbeatAt: row.heartbeat_at == null ? null : String(row.heartbeat_at),
    cancelRequested: Number(row.cancel_requested || 0) === 1,
    scopeItems: Array.isArray(payload.scopeItems) ? payload.scopeItems : [],
    textbookExternalIds: Array.isArray(payload.textbookExternalIds) ? payload.textbookExternalIds : [],
    lines: logTail ? logTail.split('\n') : [],
    child: null,
    childPid: row.child_pid == null ? null : Number(row.child_pid),
    ownerPid: row.owner_pid == null ? null : Number(row.owner_pid),
    ownerToken: row.owner_token == null ? null : String(row.owner_token),
    persisted: true,
  };
}

class JobStore {
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    ensureJobSchema(this.db);
    this.closed = false;
  }

  _rowValues(job, owner) {
    const activeSlot = ['queued', 'running', 'cancelling'].includes(String(job.status)) ? 1 : null;
    return {
      id: String(job.id),
      run_type: String(job.runType || 'content'),
      status: String(job.status || 'queued'),
      phase: job.phase == null ? null : String(job.phase),
      active_slot: activeSlot,
      owner_pid: owner?.pid == null ? null : Number(owner.pid),
      owner_token: owner?.token == null ? null : String(owner.token),
      payload_json: serializeJob(job),
      scope_json: JSON.stringify(job.scopeItems || []).slice(0, MAX_PAYLOAD_CHARS),
      metadata_run_id: job.metadataRunId == null ? null : Number(job.metadataRunId),
      collector_run_id: job.collectorRunId == null ? null : Number(job.collectorRunId),
      progress_percent: job.progressPercent == null ? null : Number(job.progressPercent),
      error_code: job.errorCode == null ? null : String(job.errorCode).slice(0, 120),
      error_message: job.errorMessage == null ? null : String(job.errorMessage).slice(0, 4000),
      current_textbook_id: job.currentTextbookId == null ? null : String(job.currentTextbookId),
      created_at: String(job.createdAt || new Date().toISOString()),
      started_at: job.startedAt == null ? null : String(job.startedAt),
      finished_at: job.finishedAt == null ? null : String(job.finishedAt),
      heartbeat_at: new Date().toISOString(),
      child_pid: job.child?.pid == null ? (job.childPid ?? null) : Number(job.child.pid),
      cancel_requested: job.cancelRequested ? 1 : 0,
      log_tail: (job.lines || []).join('\n').slice(-MAX_LOG_TAIL_CHARS),
    };
  }

  /**
   * Insert a new active job.  Throws a 409-coded error when another active
   * job already holds the slot, whichever process owns it.
   */
  insertActive(job, owner) {
    if (this.closed) return;
    const values = this._rowValues(job, owner);
    values.active_slot = 1;
    const columns = Object.keys(values);
    try {
      this.db.prepare(`
        INSERT INTO ${JOB_TABLE} (${columns.join(', ')})
        VALUES (${columns.map(() => '?').join(', ')})
      `).run(...columns.map((column) => values[column]));
    } catch (error) {
      if (isUniqueViolation(error)) {
        const conflict = new Error('采集器已有任务正在运行');
        conflict.statusCode = 409;
        conflict.code = 'job_conflict';
        throw conflict;
      }
      throw error;
    }
    this.trim();
  }

  save(job, owner) {
    if (this.closed) return;
    const values = this._rowValues(job, owner);
    const columns = Object.keys(values).filter((column) => column !== 'id');
    this.db.prepare(`
      UPDATE ${JOB_TABLE}
      SET ${columns.map((column) => `${column} = ?`).join(', ')}
      WHERE id = ?
    `).run(...columns.map((column) => values[column]), values.id);
  }

  heartbeat(jobId) {
    if (this.closed) return;
    this.db.prepare(`UPDATE ${JOB_TABLE} SET heartbeat_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), String(jobId));
  }

  release(jobId) {
    if (this.closed) return;
    this.db.prepare(`UPDATE ${JOB_TABLE} SET active_slot = NULL WHERE id = ?`).run(String(jobId));
  }

  load(jobId) {
    if (this.closed) return null;
    const row = this.db.prepare(`SELECT * FROM ${JOB_TABLE} WHERE id = ?`).get(String(jobId));
    return deserializeJob(row);
  }

  loadRecent(limit = MAX_LOADED_JOBS) {
    if (this.closed) return [];
    const rows = this.db.prepare(`
      SELECT * FROM ${JOB_TABLE} ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(Math.max(1, Math.min(MAX_RETAINED_JOBS, Number(limit) || MAX_LOADED_JOBS)));
    return rows.map(deserializeJob).filter(Boolean);
  }

  findActive() {
    if (this.closed) return [];
    return this.db.prepare(`
      SELECT * FROM ${JOB_TABLE}
      WHERE active_slot = 1 OR status IN ('queued', 'running', 'cancelling')
      ORDER BY created_at ASC
    `).all().map(deserializeJob).filter(Boolean);
  }

  trim(keep = MAX_RETAINED_JOBS) {
    if (this.closed) return;
    this.db.prepare(`
      DELETE FROM ${JOB_TABLE}
      WHERE active_slot IS NULL AND id IN (
        SELECT id FROM ${JOB_TABLE}
        WHERE active_slot IS NULL
        ORDER BY created_at DESC, rowid DESC
        LIMIT -1 OFFSET ?
      )
    `).run(Math.max(1, Number(keep) || MAX_RETAINED_JOBS));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } catch {}
  }
}

function registerOwner(token) {
  LIVE_OWNER_TOKENS.add(String(token));
}

function unregisterOwner(token) {
  LIVE_OWNER_TOKENS.delete(String(token));
}

function ownerIsLive(token) {
  return LIVE_OWNER_TOKENS.has(String(token));
}

function pidAlive(pid) {
  const number = Number(pid);
  if (!Number.isSafeInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

module.exports = {
  JOB_TABLE,
  JobStore,
  MAX_LOADED_JOBS,
  deserializeJob,
  ensureJobSchema,
  ownerIsLive,
  pidAlive,
  registerOwner,
  serializeJob,
  unregisterOwner,
};
