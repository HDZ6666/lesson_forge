'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SNAPSHOT_TABLES } = require('./run_snapshots.cjs');
const { httpError, tableNames, requiredRunId, snapshotScopeIds, resolveContentRun } = require('./readers/common.cjs');

/**
 * The newest run of a textbook may be reclaimed only once nothing depends on
 * its heavy snapshot (spec 7.3, A32): the Service confirmed a fully accepted
 * import (allowLatest), the run sealed successfully, and every catalog it
 * scanned already has a durable incremental baseline at or after this run,
 * so the next increment can still locate its position.
 */
function latestReleasable(db, id, textbookId, payload) {
  if (payload?.allowLatest !== true) return false;
  const run = db.prepare('SELECT status FROM sync_runs WHERE id=?').get(id);
  if (!run || !['success', 'completed'].includes(String(run.status))) return false;
  const names = tableNames(db);
  if (!names.has('catalog_baselines') || !names.has('sync_run_catalog_progress')) return false;
  const catalogs = db
    .prepare(
      'SELECT DISTINCT catalog_external_id AS id FROM sync_run_catalog_progress WHERE run_id=? AND textbook_external_id=?',
    )
    .all(id, String(textbookId));
  if (catalogs.length === 0) return false;
  const covered = db.prepare(
    `SELECT 1 FROM catalog_baselines WHERE textbook_external_id=? AND catalog_external_id=?
       AND confirmed_json IS NOT NULL AND confirmed_run_id>=? LIMIT 1`,
  );
  return catalogs.every((row) => covered.get(String(textbookId), String(row.id), id));
}

// Invoked only by the authenticated Service after a settled import. No run
// header is rewritten: the tombstone explains why historical content is gone.
function reclaimRun(dbPath, dataDir, runId, payload) {
  const id = requiredRunId(runId);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sync_result_cleanup (
      run_id INTEGER PRIMARY KEY, reclaimed_at TEXT NOT NULL, files_json TEXT NOT NULL,
      deleted_bytes INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_cleanup_question_ref ON sync_run_question_items(provider,question_external_id); CREATE INDEX IF NOT EXISTS idx_cleanup_asset_ref ON sync_run_question_assets(storage_path)',
    );
    if (tableNames(db).has('question_assets'))
      db.exec('CREATE INDEX IF NOT EXISTS idx_cleanup_local_asset ON question_assets(local_path)');
    let record = db.prepare('SELECT * FROM sync_result_cleanup WHERE run_id=?').get(id);
    if (!record) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const run = resolveContentRun(db, id);
        const scope = [...snapshotScopeIds(db, run)];
        if (
          !run.finishedAt ||
          !run.snapshotLockedAt ||
          scope.length !== 1 ||
          scope[0] !== String(payload.textbookExternalId) ||
          Date.parse(run.snapshotLockedAt) !== Date.parse(payload.snapshotLockedAt)
        ) {
          throw httpError('回收身份与已封存成果不一致', 409, 'cleanup_identity');
        }
        if (db.prepare("SELECT 1 FROM sync_runs WHERE status='running' LIMIT 1").get()) {
          throw httpError('采集进行中，稍后自动回收', 409, 'cleanup_busy');
        }
        // Keep the latest *nonempty* observation, including incomplete runs,
        // so a failed empty retry never destroys the only usable checkpoint.
        const newer = db
          .prepare(
            `SELECT 1 FROM sync_run_question_items
          WHERE run_id>? AND textbook_external_id=? LIMIT 1`,
          )
          .get(id, scope[0]);
        if (!newer && !latestReleasable(db, id, scope[0], payload)) {
          throw httpError('保留本教材最新成果供补采使用', 409, 'cleanup_latest');
        }
        const names = tableNames(db);
        const files = new Set(
          db
            .prepare('SELECT storage_path FROM sync_run_question_assets WHERE run_id=? AND storage_path IS NOT NULL')
            .all(id)
            .map((r) => r.storage_path),
        );
        if (names.has('source_snapshots'))
          for (const row of db.prepare('SELECT file_path FROM source_snapshots WHERE run_id=?').all(id))
            files.add(row.file_path);
        db.exec(
          'CREATE TEMP TABLE cleanup_questions (provider TEXT, external_id TEXT, PRIMARY KEY(provider,external_id))',
        );
        db.prepare(
          'INSERT OR IGNORE INTO cleanup_questions SELECT provider,question_external_id FROM sync_run_question_items WHERE run_id=?',
        ).run(id);
        const tables = [
          ...SNAPSHOT_TABLES,
          'sync_run_checkpoints',
          'sync_run_catalog_pages',
          'sync_run_catalog_progress',
          'sync_progress',
          'source_snapshots',
        ].filter((t) => names.has(t));
        const triggers = db
          .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%BEFORE DELETE%'")
          .all()
          .filter((t) => tables.some((name) => t.sql.includes(`ON ${name}\n`) || t.sql.includes(`ON ${name} `)));
        // DDL and deletion are one transaction. Other writers never observe
        // disabled guards; rollback restores both data and trigger definitions.
        for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
        for (const table of tables) db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(id);
        for (const trigger of triggers) db.exec(trigger.sql);
        db.exec(`DELETE FROM cleanup_questions WHERE EXISTS (SELECT 1 FROM sync_run_question_items r
          WHERE r.provider=cleanup_questions.provider AND r.question_external_id=cleanup_questions.external_id)`);
        if (names.has('question_assets')) {
          for (const row of db
            .prepare(
              `SELECT local_path FROM question_assets a JOIN cleanup_questions q
            ON a.provider=q.provider AND a.question_external_id=q.external_id WHERE local_path IS NOT NULL`,
            )
            .all())
            files.add(row.local_path);
        }
        for (const table of [
          'question_assets',
          'question_revisions',
          'question_knowledge',
          'question_facets',
          'question_catalog_memberships',
        ]) {
          if (names.has(table))
            db.exec(
              `DELETE FROM ${table} WHERE (provider,question_external_id) IN (SELECT provider,external_id FROM cleanup_questions)`,
            );
        }
        if (names.has('questions'))
          db.exec(
            'DELETE FROM questions WHERE (provider,external_id) IN (SELECT provider,external_id FROM cleanup_questions)',
          );
        db.prepare('INSERT INTO sync_result_cleanup(run_id,reclaimed_at,files_json) VALUES(?,?,?)').run(
          id,
          new Date().toISOString(),
          JSON.stringify([...files].filter(Boolean)),
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      record = db.prepare('SELECT * FROM sync_result_cleanup WHERE run_id=?').get(id);
    }
    if (!record.finished) {
      const root = fs.realpathSync(dataDir);
      let bytes = Number(record.deleted_bytes || 0);
      const names = tableNames(db);
      for (const value of JSON.parse(record.files_json)) {
        const target = path.resolve(root, value);
        if (!target.startsWith(root + path.sep)) continue;
        const referenced =
          db.prepare('SELECT 1 FROM sync_run_question_assets WHERE storage_path=? LIMIT 1').get(value) ||
          (names.has('question_assets') &&
            db.prepare('SELECT 1 FROM question_assets WHERE local_path=? LIMIT 1').get(value)) ||
          (names.has('source_snapshots') &&
            db.prepare('SELECT 1 FROM source_snapshots WHERE file_path=? LIMIT 1').get(value));
        if (referenced) continue;
        try {
          const actual = fs.realpathSync(target);
          if (!actual.startsWith(root + path.sep) || !fs.statSync(actual).isFile()) continue;
          const size = fs.statSync(actual).size;
          fs.unlinkSync(actual);
          bytes += size;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      db.prepare("UPDATE sync_result_cleanup SET finished=1,deleted_bytes=?,files_json='[]' WHERE run_id=?").run(
        bytes,
        id,
      );
      record = db.prepare('SELECT * FROM sync_result_cleanup WHERE run_id=?').get(id);
    }
    // Freed SQLite pages are reused by subsequent collection. Avoid a full
    // VACUUM which needs another database-sized allocation and blocks writers.
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    return {
      runId: id,
      reclaimedAt: record.reclaimed_at,
      deletedBytes: record.deleted_bytes,
      reusableDatabaseBytes:
        Number(db.prepare('PRAGMA freelist_count').get().freelist_count) *
        Number(db.prepare('PRAGMA page_size').get().page_size),
    };
  } finally {
    db.close();
  }
}
module.exports = { reclaimRun };
