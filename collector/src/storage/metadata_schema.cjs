'use strict';

/**
 * SQLite schema for metadata (version / textbook) discovery runs.
 *
 * `source_metadata_runs` plus the two per-run snapshot tables are sealed by
 * triggers once a run reaches a terminal status, mirroring the content run
 * snapshot rules in lib/run_snapshots.cjs.  The migration is additive and
 * idempotent so the API server can upgrade an older collector database.
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { ensureDir } = require('../shared/utils.cjs');

const METADATA_TERMINAL_STATUSES = Object.freeze([
  'success',
  'completed',
  'failed',
  'blocked',
  'cancelled',
]);
const METADATA_TERMINAL_STATUS_SQL = METADATA_TERMINAL_STATUSES
  .map((status) => `'${status}'`)
  .join(', ');
const METADATA_RUN_COLUMN_MIGRATIONS = Object.freeze({
  provider: "TEXT NOT NULL DEFAULT 'zujuan'",
  started_at: "TEXT NOT NULL DEFAULT ''",
  finished_at: 'TEXT',
  status: "TEXT NOT NULL DEFAULT 'unknown'",
  seed_url: 'TEXT',
  version_count: 'INTEGER NOT NULL DEFAULT 0',
  textbook_count: 'INTEGER NOT NULL DEFAULT 0',
  inserted_count: 'INTEGER NOT NULL DEFAULT 0',
  updated_count: 'INTEGER NOT NULL DEFAULT 0',
  unchanged_count: 'INTEGER NOT NULL DEFAULT 0',
  error_count: 'INTEGER NOT NULL DEFAULT 0',
  message: 'TEXT',
  report_json: 'TEXT',
  snapshot_locked_at: 'TEXT',
});

function metadataQuoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function metadataTableNames(db) {
  return new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)),
  );
}

function metadataTableColumns(db, table) {
  return new Set(
    db.prepare(`PRAGMA table_info(${metadataQuoteIdentifier(table)})`).all().map((row) => String(row.name)),
  );
}

function metadataColumn(columns, name, fallbackSql) {
  return columns.has(name) ? metadataQuoteIdentifier(name) : fallbackSql;
}

function backfillMetadataRunSnapshots(db) {
  const tables = metadataTableNames(db);
  if (!tables.has('source_metadata_runs')) return;
  if (tables.has('source_textbook_versions')) {
    const columns = metadataTableColumns(db, 'source_textbook_versions');
    if (columns.has('provider') && columns.has('external_version_id') && columns.has('version_name')) {
      db.exec(`
        INSERT OR IGNORE INTO source_metadata_run_versions (
          run_id, provider, external_version_id, version_name, source_url,
          is_new, sort_order, status, raw_json, captured_at
        )
        SELECT run.id, version.provider, version.external_version_id, version.version_name,
               ${metadataColumn(columns, 'source_url', 'NULL')},
               ${metadataColumn(columns, 'is_new', 'NULL')},
               ${metadataColumn(columns, 'sort_order', '0')},
               ${columns.has('status') ? 'version."status"' : "'0'"},
               ${metadataColumn(columns, 'raw_json', "'{}'")},
               ${metadataColumn(columns, 'last_seen_at', 'run.finished_at')}
        FROM source_metadata_runs AS run
        JOIN source_textbook_versions AS version
          ON version.provider = run.provider
        WHERE run.status IN ('success', 'completed')
          AND run.finished_at IS NOT NULL
          ${columns.has('last_seen_at')
    ? 'AND version.last_seen_at >= run.started_at AND version.last_seen_at <= run.finished_at'
    : ''}
      `);
    }
  }
  if (tables.has('source_textbooks')) {
    const columns = metadataTableColumns(db, 'source_textbooks');
    if (
      columns.has('provider')
      && columns.has('external_textbook_id')
      && columns.has('version_external_id')
      && columns.has('textbook_name')
    ) {
      db.exec(`
        INSERT OR IGNORE INTO source_metadata_run_textbooks (
          run_id, provider, external_textbook_id, version_external_id,
          textbook_name, grade, volume, source_url, sort_order, status,
          bootstrap_chapter_external_id, raw_json, captured_at
        )
        SELECT run.id, textbook.provider, textbook.external_textbook_id,
               textbook.version_external_id, textbook.textbook_name,
               ${metadataColumn(columns, 'grade', 'NULL')},
               ${metadataColumn(columns, 'volume', 'NULL')},
               ${metadataColumn(columns, 'source_url', 'NULL')},
               ${metadataColumn(columns, 'sort_order', '0')},
               ${columns.has('status') ? 'textbook."status"' : "'0'"},
               ${metadataColumn(columns, 'bootstrap_chapter_external_id', 'NULL')},
               ${metadataColumn(columns, 'raw_json', "'{}'")},
               ${metadataColumn(columns, 'last_seen_at', 'run.finished_at')}
        FROM source_metadata_runs AS run
        JOIN source_textbooks AS textbook
          ON textbook.provider = run.provider
        WHERE run.status IN ('success', 'completed')
          AND run.finished_at IS NOT NULL
          ${columns.has('last_seen_at')
    ? 'AND textbook.last_seen_at >= run.started_at AND textbook.last_seen_at <= run.finished_at'
    : ''}
      `);
    }
  }
}

function migrateMetadataSnapshotSchema(db) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS source_metadata_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        seed_url TEXT,
        version_count INTEGER NOT NULL DEFAULT 0,
        textbook_count INTEGER NOT NULL DEFAULT 0,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        message TEXT,
        report_json TEXT,
        snapshot_locked_at TEXT
      );
    `);
    const runColumns = metadataTableColumns(db, 'source_metadata_runs');
    for (const [name, definition] of Object.entries(METADATA_RUN_COLUMN_MIGRATIONS)) {
      if (runColumns.has(name)) continue;
      db.exec(
        `ALTER TABLE source_metadata_runs ADD COLUMN ${metadataQuoteIdentifier(name)} ${definition}`,
      );
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS source_metadata_run_versions (
        run_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        external_version_id TEXT NOT NULL,
        version_name TEXT NOT NULL,
        source_url TEXT,
        is_new TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '0',
        raw_json TEXT NOT NULL DEFAULT '{}',
        captured_at TEXT NOT NULL,
        PRIMARY KEY (run_id, provider, external_version_id),
        FOREIGN KEY (run_id) REFERENCES source_metadata_runs(id)
      );

      CREATE TABLE IF NOT EXISTS source_metadata_run_textbooks (
        run_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        external_textbook_id TEXT NOT NULL,
        version_external_id TEXT NOT NULL,
        textbook_name TEXT NOT NULL,
        grade TEXT,
        volume TEXT,
        source_url TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '0',
        bootstrap_chapter_external_id TEXT,
        raw_json TEXT NOT NULL DEFAULT '{}',
        captured_at TEXT NOT NULL,
        PRIMARY KEY (run_id, provider, external_textbook_id),
        FOREIGN KEY (run_id) REFERENCES source_metadata_runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_metadata_run_versions_order
        ON source_metadata_run_versions (run_id, provider, sort_order, external_version_id);
      CREATE INDEX IF NOT EXISTS idx_metadata_run_textbooks_version
        ON source_metadata_run_textbooks (
          run_id, provider, version_external_id, sort_order, external_textbook_id
        );

      DROP TRIGGER IF EXISTS trg_source_metadata_runs_no_reopen;
      DROP TRIGGER IF EXISTS trg_metadata_run_versions_no_insert;
      DROP TRIGGER IF EXISTS trg_metadata_run_versions_no_update;
      DROP TRIGGER IF EXISTS trg_metadata_run_versions_no_delete;
      DROP TRIGGER IF EXISTS trg_metadata_run_textbooks_no_insert;
      DROP TRIGGER IF EXISTS trg_metadata_run_textbooks_no_update;
      DROP TRIGGER IF EXISTS trg_metadata_run_textbooks_no_delete;
    `);
    backfillMetadataRunSnapshots(db);
    db.exec(`
      UPDATE source_metadata_runs
      SET snapshot_locked_at = COALESCE(
        snapshot_locked_at,
        NULLIF(finished_at, ''),
        NULLIF(started_at, ''),
        datetime('now')
      )
      WHERE snapshot_locked_at IS NULL
        AND COALESCE(status, '') IN (${METADATA_TERMINAL_STATUS_SQL});

      CREATE TRIGGER trg_source_metadata_runs_no_reopen
      BEFORE UPDATE ON source_metadata_runs
      WHEN OLD.snapshot_locked_at IS NOT NULL
        OR COALESCE(OLD.status, '') IN (${METADATA_TERMINAL_STATUS_SQL})
      BEGIN
        SELECT RAISE(ABORT, 'terminal metadata runs are immutable');
      END;

      CREATE TRIGGER trg_metadata_run_versions_no_insert
      BEFORE INSERT ON source_metadata_run_versions
      WHEN NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'metadata version snapshots are immutable');
      END;

      CREATE TRIGGER trg_metadata_run_versions_no_update
      BEFORE UPDATE ON source_metadata_run_versions
      WHEN NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      ) OR NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'metadata version snapshots are immutable');
      END;

      CREATE TRIGGER trg_metadata_run_versions_no_delete
      BEFORE DELETE ON source_metadata_run_versions
      WHEN NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'metadata version snapshots are immutable');
      END;

      CREATE TRIGGER trg_metadata_run_textbooks_no_insert
      BEFORE INSERT ON source_metadata_run_textbooks
      WHEN NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'metadata textbook snapshots are immutable');
      END;

      CREATE TRIGGER trg_metadata_run_textbooks_no_update
      BEFORE UPDATE ON source_metadata_run_textbooks
      WHEN NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      ) OR NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'metadata textbook snapshots are immutable');
      END;

      CREATE TRIGGER trg_metadata_run_textbooks_no_delete
      BEFORE DELETE ON source_metadata_run_textbooks
      WHEN NOT EXISTS (
        SELECT 1 FROM source_metadata_runs
        WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'metadata textbook snapshots are immutable');
      END;
    `);
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  }
}

function ensureMetadataSnapshotSchema(dbPath) {
  const resolved = path.resolve(dbPath);
  ensureDir(path.dirname(resolved));
  const db = new DatabaseSync(resolved);
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    const version = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
    const ready = (version & 1) !== 0 && Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_source_metadata_runs_no_reopen'",
    ).get());
    if (!ready) {
      migrateMetadataSnapshotSchema(db);
      db.exec(`PRAGMA user_version = ${version | 1};`);
    }
  } finally {
    db.close();
  }
}

module.exports = {
  METADATA_RUN_COLUMN_MIGRATIONS,
  METADATA_TERMINAL_STATUSES,
  METADATA_TERMINAL_STATUS_SQL,
  backfillMetadataRunSnapshots,
  ensureMetadataSnapshotSchema,
  metadataColumn,
  metadataQuoteIdentifier,
  metadataTableColumns,
  metadataTableNames,
  migrateMetadataSnapshotSchema,
};
