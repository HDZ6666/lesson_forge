'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SNAPSHOT_TABLES = Object.freeze([
  'sync_run_catalog_items',
  'sync_run_question_items',
  'sync_run_question_catalogs',
  'sync_run_question_tags',
  'sync_run_question_assets',
]);
// Checkpoints are deliberately kept separate from the five immutable scope
// snapshots. They carry resumable progress, but are still run-owned and
// therefore become immutable when that run is sealed.
const RUN_CHECKPOINT_TABLE = 'sync_run_checkpoints';

// `success` is the status written by the standalone collector scripts while
// `completed` is the status exposed by the HTTP job API.  `interrupted` is a
// sealed, deliberately incomplete checkpoint.  All represent terminal runs
// and therefore must be covered by the lock/trigger rules.
const TERMINAL_RUN_STATUSES = Object.freeze([
  'success',
  'completed',
  'failed',
  'blocked',
  // An interrupted run is a sealed, deliberately incomplete checkpoint.  It
  // is eligible as the immutable source of a later resume, but never as an
  // applyable snapshot.
  'interrupted',
  'cancelled',
]);
const TERMINAL_RUN_STATUS_SQL = TERMINAL_RUN_STATUSES.map((status) => `'${status}'`).join(', ');

// `sync_runs` predates the run-level snapshot tables in a few local
// databases.  Keep the migration deliberately additive so an operator can
// point a newer collector at an existing database without losing history.
const RUN_COLUMN_MIGRATIONS = Object.freeze({
  provider: 'TEXT NOT NULL DEFAULT \'zujuan\'',
  started_at: 'TEXT NOT NULL DEFAULT \'\'',
  finished_at: 'TEXT',
  status: 'TEXT NOT NULL DEFAULT \'unknown\'',
  scope_json: 'TEXT NOT NULL DEFAULT \'{}\'',
  pages_ok: 'INTEGER NOT NULL DEFAULT 0',
  questions_seen: 'INTEGER NOT NULL DEFAULT 0',
  questions_inserted: 'INTEGER NOT NULL DEFAULT 0',
  questions_updated: 'INTEGER NOT NULL DEFAULT 0',
  details_fetched: 'INTEGER NOT NULL DEFAULT 0',
  assets_downloaded: 'INTEGER NOT NULL DEFAULT 0',
  error_count: 'INTEGER NOT NULL DEFAULT 0',
  message: 'TEXT',
  // A separate lock timestamp means a terminal run remains immutable even
  // if somebody later edits the human-readable status column by hand.
  snapshot_locked_at: 'TEXT',
  // A sealed run may still be partial.  Keep an explicit readiness bit so
  // downstream apply code never has to infer completeness from status alone.
  snapshot_complete: 'INTEGER NOT NULL DEFAULT 0',
  scan_complete: 'INTEGER NOT NULL DEFAULT 0',
  data_complete: 'INTEGER NOT NULL DEFAULT 0',
  completion_quality: 'TEXT',
  catalog_item_count: 'INTEGER NOT NULL DEFAULT 0',
  question_item_count: 'INTEGER NOT NULL DEFAULT 0',
  question_catalog_count: 'INTEGER NOT NULL DEFAULT 0',
  question_tag_count: 'INTEGER NOT NULL DEFAULT 0',
  question_asset_count: 'INTEGER NOT NULL DEFAULT 0',
});

const COLUMN_MIGRATIONS = Object.freeze({
  sync_run_catalog_items: {
    run_id: 'INTEGER',
    provider: 'TEXT',
    textbook_external_id: 'TEXT',
    catalog_external_id: 'TEXT',
    parent_external_id: 'TEXT',
    node_level: 'INTEGER',
    node_type: 'TEXT',
    name: 'TEXT',
    source_path: 'TEXT',
    catalog_path: 'TEXT',
    sort_order: 'INTEGER',
    captured_at: 'TEXT',
  },
  sync_run_question_items: {
    run_id: 'INTEGER',
    provider: 'TEXT',
    textbook_external_id: 'TEXT',
    question_external_id: 'TEXT',
    chapter_id: 'TEXT',
    detail_url: 'TEXT',
    source_short: 'TEXT',
    source_title: 'TEXT',
    source_url: 'TEXT',
    question_type: 'TEXT',
    question_type_id: 'TEXT',
    difficulty_label: 'TEXT',
    difficulty_code: 'TEXT',
    ease_coefficient: 'REAL',
    content_html: 'TEXT',
    plain_text: 'TEXT',
    content_hash: 'TEXT',
    list_content_hash: 'TEXT',
    detail_content_hash: 'TEXT',
    content_version: 'TEXT',
    question_version: 'INTEGER',
    snapshot_version: 'INTEGER NOT NULL DEFAULT 1',
    detail_fetched: 'INTEGER NOT NULL DEFAULT 0',
    subquestion_count: 'INTEGER NOT NULL DEFAULT 0',
    child_count: 'INTEGER',
    has_image: 'INTEGER NOT NULL DEFAULT 0',
    has_formula: 'INTEGER NOT NULL DEFAULT 0',
    has_table: 'INTEGER NOT NULL DEFAULT 0',
    is_new: 'INTEGER NOT NULL DEFAULT 0',
    use_count: 'INTEGER',
    provider_updated_at: 'TEXT',
    // Keep the historical combined field for compatibility, while adding
    // independently captured public answer/analysis fields.  A NULL value is
    // intentional when the page did not expose that section.
    answer_html: 'TEXT',
    analysis_html: 'TEXT',
    answer_status: "TEXT NOT NULL DEFAULT 'not_collected'",
    solution_html: 'TEXT',
    raw_json: 'TEXT',
    captured_at: 'TEXT',
  },
  sync_run_question_catalogs: {
    run_id: 'INTEGER',
    provider: 'TEXT',
    textbook_external_id: 'TEXT',
    question_external_id: 'TEXT',
    catalog_external_id: 'TEXT',
    catalog_level: 'INTEGER',
    catalog_name: 'TEXT',
    catalog_path: 'TEXT',
    evidence_type: 'TEXT',
    captured_at: 'TEXT',
  },
  sync_run_question_tags: {
    run_id: 'INTEGER',
    provider: 'TEXT',
    textbook_external_id: 'TEXT',
    question_external_id: 'TEXT',
    dimension: 'TEXT',
    tag_external_id: 'TEXT NOT NULL DEFAULT \'\'',
    tag_value: 'TEXT',
    relation_type: 'TEXT',
    evidence_type: 'TEXT',
    query_fingerprint: 'TEXT NOT NULL DEFAULT \'\'',
    captured_at: 'TEXT',
    // Keep captured_at for compatibility with the intermediate schema; the
    // public contract uses observed_at.
    observed_at: "TEXT NOT NULL DEFAULT ''",
  },
  sync_run_question_assets: {
    run_id: 'INTEGER',
    provider: 'TEXT',
    textbook_external_id: 'TEXT',
    question_external_id: 'TEXT',
    asset_key: 'TEXT',
    asset_type: 'TEXT',
    source_url: 'TEXT',
    content_sha256: 'TEXT',
    storage_path: 'TEXT',
    mime_type: 'TEXT',
    byte_size: 'INTEGER',
    captured_at: 'TEXT',
    observed_at: "TEXT NOT NULL DEFAULT ''",
  },
});

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function tableColumns(db, table) {
  return new Set(
    db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => String(row.name)),
  );
}

function addMissingColumns(db, table, definitions) {
  const columns = tableColumns(db, table);
  for (const [name, definition] of Object.entries(definitions)) {
    if (columns.has(name)) continue;
    db.exec(
      `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(name)} ${definition}`,
    );
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(String(table)));
}

/**
 * Intermediate collector builds used a pair of non-contract column names for
 * assets.  Preserve those rows when upgrading in place.  The UPDATE is
 * intentionally conditional so a canonical value always wins.
 */
function copyLegacyAssetColumns(db) {
  if (!tableExists(db, 'sync_run_question_assets')) return;
  const columns = tableColumns(db, 'sync_run_question_assets');
  if (columns.has('storage_path') && columns.has('local_path')) {
    db.exec(`
      UPDATE ${quoteIdentifier('sync_run_question_assets')}
      SET storage_path = COALESCE(NULLIF(storage_path, ''), local_path)
      WHERE (storage_path IS NULL OR storage_path = '')
        AND local_path IS NOT NULL AND local_path <> ''
    `);
  }
  if (columns.has('content_sha256') && columns.has('sha256')) {
    db.exec(`
      UPDATE ${quoteIdentifier('sync_run_question_assets')}
      SET content_sha256 = COALESCE(NULLIF(content_sha256, ''), sha256)
      WHERE (content_sha256 IS NULL OR content_sha256 = '')
        AND sha256 IS NOT NULL AND sha256 <> ''
    `);
  }
  if (columns.has('observed_at') && columns.has('captured_at')) {
    db.exec(`
      UPDATE ${quoteIdentifier('sync_run_question_assets')}
      SET observed_at = COALESCE(NULLIF(observed_at, ''), captured_at)
      WHERE (observed_at IS NULL OR observed_at = '')
        AND captured_at IS NOT NULL AND captured_at <> ''
    `);
  }
}

function copyLegacyTagColumns(db) {
  if (!tableExists(db, 'sync_run_question_tags')) return;
  const columns = tableColumns(db, 'sync_run_question_tags');
  if (columns.has('observed_at') && columns.has('captured_at')) {
    db.exec(`
      UPDATE ${quoteIdentifier('sync_run_question_tags')}
      SET observed_at = COALESCE(NULLIF(observed_at, ''), captured_at)
      WHERE (observed_at IS NULL OR observed_at = '')
        AND captured_at IS NOT NULL AND captured_at <> ''
    `);
  }
  // Some very early snapshots called the displayed value `value`.  Additive
  // migration keeps that data usable under the stable `tag_value` contract.
  if (columns.has('tag_value') && columns.has('value')) {
    db.exec(`
      UPDATE ${quoteIdentifier('sync_run_question_tags')}
      SET tag_value = COALESCE(NULLIF(tag_value, ''), value)
      WHERE (tag_value IS NULL OR tag_value = '') AND value IS NOT NULL
    `);
  }
}

function normalizeLegacyAnswerColumns(db) {
  if (!tableExists(db, 'sync_run_question_items')) return;
  const columns = tableColumns(db, 'sync_run_question_items');
  if (columns.has('answer_status')) {
    db.exec(`
      UPDATE ${quoteIdentifier('sync_run_question_items')}
      SET answer_status = 'not_collected'
      WHERE answer_status IS NULL OR answer_status = ''
    `);
  }
}

/** Remove duplicate legacy rows before installing the contract identity index. */
function dedupeRows(db, table, columns) {
  if (!tableExists(db, table)) return;
  const actual = tableColumns(db, table);
  if (columns.some((column) => !actual.has(column))) return;
  // A complete, non-null unique key already proves there are no duplicates.
  // Avoid re-scanning every historical row at each API startup. Nullable or
  // partially indexed legacy schemas still take the repair path below.
  const info = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  if (columns.every(column => info.some(item => item.name === column && item.notnull))) {
    const indexes = db.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all();
    if (indexes.some(index => index.unique && !index.partial && (() => {
      const keys = db.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all().map(item => item.name);
      return keys.length === columns.length && columns.every(column => keys.includes(column));
    })())) return;
  }
  // Tables created by this collector are rowid tables.  A defensive catch
  // keeps migration usable if an operator imported a WITHOUT ROWID table.
  try {
    const quotedTable = quoteIdentifier(table);
    const key = columns.map(quoteIdentifier).join(', ');
    db.exec(`
      DELETE FROM ${quotedTable}
      WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM ${quotedTable} GROUP BY ${key}
      )
    `);
  } catch {
    // The subsequent unique-index creation will provide a useful error for a
    // genuinely incompatible schema; do not make an otherwise safe upgrade
    // fail merely because rowid is unavailable.
  }
}

function ensureSyncRunColumns(db) {
  const columns = tableColumns(db, 'sync_runs');
  for (const [name, definition] of Object.entries(RUN_COLUMN_MIGRATIONS)) {
    if (columns.has(name)) continue;
    db.exec(
      `ALTER TABLE ${quoteIdentifier('sync_runs')} ADD COLUMN ${quoteIdentifier(name)} ${definition}`,
    );
  }
}

function copyLegacyRunCountColumns(db) {
  if (!tableExists(db, 'sync_runs')) return;
  const columns = tableColumns(db, 'sync_runs');
  const aliases = {
    catalog_item_count: ['catalog_count', 'catalogs_count'],
    question_item_count: ['question_count', 'questions_count'],
    question_catalog_count: ['question_catalogs_count', 'catalog_link_count'],
    question_tag_count: ['tag_count', 'tags_count'],
    question_asset_count: ['asset_count', 'assets_count'],
  };
  for (const [canonical, candidates] of Object.entries(aliases)) {
    if (!columns.has(canonical)) continue;
    const source = candidates.find((name) => columns.has(name));
    if (!source) continue;
    db.exec(`
      UPDATE ${quoteIdentifier('sync_runs')}
      SET ${quoteIdentifier(canonical)} = COALESCE(${quoteIdentifier(canonical)}, ${quoteIdentifier(source)}, 0)
      WHERE ${quoteIdentifier(canonical)} IS NULL OR ${quoteIdentifier(canonical)} = 0
    `);
  }
}

function migrateRunSnapshotSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      pages_ok INTEGER NOT NULL DEFAULT 0,
      questions_seen INTEGER NOT NULL DEFAULT 0,
      questions_inserted INTEGER NOT NULL DEFAULT 0,
      questions_updated INTEGER NOT NULL DEFAULT 0,
      details_fetched INTEGER NOT NULL DEFAULT 0,
      assets_downloaded INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      snapshot_locked_at TEXT,
      snapshot_complete INTEGER NOT NULL DEFAULT 0,
      catalog_item_count INTEGER NOT NULL DEFAULT 0,
      question_item_count INTEGER NOT NULL DEFAULT 0,
      question_catalog_count INTEGER NOT NULL DEFAULT 0,
      question_tag_count INTEGER NOT NULL DEFAULT 0,
      question_asset_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sync_run_catalog_items (
      run_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      textbook_external_id TEXT NOT NULL,
      catalog_external_id TEXT NOT NULL,
      parent_external_id TEXT,
      node_level INTEGER,
      node_type TEXT,
      name TEXT NOT NULL,
      source_path TEXT,
      catalog_path TEXT,
      sort_order INTEGER,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (run_id, provider, textbook_external_id, catalog_external_id),
      FOREIGN KEY (run_id) REFERENCES sync_runs(id)
    );

    CREATE TABLE IF NOT EXISTS sync_run_question_items (
      run_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      textbook_external_id TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      chapter_id TEXT,
      detail_url TEXT,
      source_short TEXT,
      source_title TEXT,
      source_url TEXT,
      question_type TEXT,
      question_type_id TEXT,
      difficulty_label TEXT,
      difficulty_code TEXT,
      ease_coefficient REAL,
      content_html TEXT,
      plain_text TEXT,
      content_hash TEXT,
      list_content_hash TEXT,
      detail_content_hash TEXT,
      content_version TEXT,
      question_version INTEGER,
      snapshot_version INTEGER NOT NULL DEFAULT 1,
      detail_fetched INTEGER NOT NULL DEFAULT 0,
      subquestion_count INTEGER NOT NULL DEFAULT 0,
      child_count INTEGER,
      has_image INTEGER NOT NULL DEFAULT 0,
      has_formula INTEGER NOT NULL DEFAULT 0,
      has_table INTEGER NOT NULL DEFAULT 0,
      is_new INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER,
      provider_updated_at TEXT,
      answer_html TEXT,
      analysis_html TEXT,
      answer_status TEXT NOT NULL DEFAULT 'not_collected',
      solution_html TEXT,
      raw_json TEXT,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (run_id, provider, textbook_external_id, question_external_id),
      FOREIGN KEY (run_id) REFERENCES sync_runs(id)
    );

    CREATE TABLE IF NOT EXISTS sync_run_question_catalogs (
      run_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      textbook_external_id TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      catalog_external_id TEXT NOT NULL,
      catalog_level INTEGER,
      catalog_name TEXT,
      catalog_path TEXT,
      evidence_type TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (
        run_id,
        provider,
        textbook_external_id,
        question_external_id,
        catalog_external_id
      ),
      FOREIGN KEY (run_id) REFERENCES sync_runs(id)
    );

    CREATE TABLE IF NOT EXISTS sync_run_question_tags (
      run_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      textbook_external_id TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      dimension TEXT NOT NULL,
      tag_external_id TEXT NOT NULL DEFAULT '',
      tag_value TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      query_fingerprint TEXT NOT NULL DEFAULT '',
      captured_at TEXT,
      observed_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (
        run_id,
        provider,
        textbook_external_id,
        question_external_id,
        dimension,
        tag_external_id,
        tag_value,
        relation_type,
        evidence_type,
        query_fingerprint
      ),
      FOREIGN KEY (run_id) REFERENCES sync_runs(id)
    );

    CREATE TABLE IF NOT EXISTS sync_run_question_assets (
      run_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      textbook_external_id TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      asset_key TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      source_url TEXT NOT NULL,
      content_sha256 TEXT,
      storage_path TEXT,
      mime_type TEXT,
      byte_size INTEGER,
      captured_at TEXT,
      observed_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (
        run_id,
        provider,
        textbook_external_id,
        question_external_id,
        asset_key
      ),
      FOREIGN KEY (run_id) REFERENCES sync_runs(id)
    );

    CREATE TABLE IF NOT EXISTS sync_run_checkpoints (
      run_id INTEGER NOT NULL,
      scope_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      filter_json TEXT NOT NULL,
      last_completed_page INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, scope_key),
      FOREIGN KEY (run_id) REFERENCES sync_runs(id)
    );
  `);

  ensureSyncRunColumns(db);
  copyLegacyRunCountColumns(db);

  // An older collector may already have installed a narrower lock trigger.
  // Drop it before backfilling terminal rows so the migration itself can
  // repair their missing marker; the current trigger is recreated below.
  db.exec('DROP TRIGGER IF EXISTS trg_sync_runs_no_reopen');

  // Databases created before `snapshot_locked_at` existed already have
  // terminal runs.  Backfill their lock marker once, before installing the
  // write guards, so those historical rows are immutable as well.  Do not
  // rely solely on finished_at here: older interrupted/hand-edited databases
  // can contain a terminal status with no end timestamp.
  db.exec(`
    UPDATE ${quoteIdentifier('sync_runs')}
    SET snapshot_locked_at = COALESCE(
      snapshot_locked_at,
      NULLIF(finished_at, ''),
      NULLIF(started_at, ''),
      datetime('now')
    )
    WHERE snapshot_locked_at IS NULL
      AND COALESCE(status, '') IN (${TERMINAL_RUN_STATUS_SQL})
  `);

  // Remove guards from an intermediate schema before repairing/deduplicating
  // its rows.  They are recreated with the canonical definitions below.
  db.exec(`
    DROP TRIGGER IF EXISTS trg_sync_run_catalog_items_no_insert;
    DROP TRIGGER IF EXISTS trg_sync_run_catalog_items_no_update;
    DROP TRIGGER IF EXISTS trg_sync_run_catalog_items_no_delete;
    DROP TRIGGER IF EXISTS trg_sync_run_question_items_no_insert;
    DROP TRIGGER IF EXISTS trg_sync_run_question_items_no_update;
    DROP TRIGGER IF EXISTS trg_sync_run_question_items_no_delete;
    DROP TRIGGER IF EXISTS trg_sync_run_question_catalogs_no_insert;
    DROP TRIGGER IF EXISTS trg_sync_run_question_catalogs_no_update;
    DROP TRIGGER IF EXISTS trg_sync_run_question_catalogs_no_delete;
    DROP TRIGGER IF EXISTS trg_sync_run_question_tags_no_insert;
    DROP TRIGGER IF EXISTS trg_sync_run_question_tags_no_update;
    DROP TRIGGER IF EXISTS trg_sync_run_question_tags_no_delete;
    DROP TRIGGER IF EXISTS trg_sync_run_question_assets_no_insert;
    DROP TRIGGER IF EXISTS trg_sync_run_question_assets_no_update;
    DROP TRIGGER IF EXISTS trg_sync_run_question_assets_no_delete;
    DROP TRIGGER IF EXISTS trg_snapshot_question_tags_no_insert;
    DROP TRIGGER IF EXISTS trg_snapshot_question_tags_no_update;
    DROP TRIGGER IF EXISTS trg_snapshot_question_tags_no_delete;
    DROP TRIGGER IF EXISTS trg_snapshot_question_assets_no_insert;
    DROP TRIGGER IF EXISTS trg_snapshot_question_assets_no_update;
    DROP TRIGGER IF EXISTS trg_snapshot_question_assets_no_delete;
    DROP TRIGGER IF EXISTS trg_snapshot_run_checkpoints_no_insert;
    DROP TRIGGER IF EXISTS trg_snapshot_run_checkpoints_no_update;
    DROP TRIGGER IF EXISTS trg_snapshot_run_checkpoints_no_delete;
  `);

  for (const table of SNAPSHOT_TABLES) {
    addMissingColumns(db, table, COLUMN_MIGRATIONS[table]);
  }

  // Repair aliases and remove duplicate rows before installing identity
  // indexes.  This keeps upgrades from old/intermediate collector schemas
  // additive and deterministic.
  copyLegacyTagColumns(db);
  copyLegacyAssetColumns(db);
  normalizeLegacyAnswerColumns(db);
  dedupeRows(db, 'sync_run_catalog_items', [
    'run_id', 'provider', 'textbook_external_id', 'catalog_external_id',
  ]);
  dedupeRows(db, 'sync_run_question_items', [
    'run_id', 'provider', 'textbook_external_id', 'question_external_id',
  ]);
  dedupeRows(db, 'sync_run_question_catalogs', [
    'run_id', 'provider', 'textbook_external_id', 'question_external_id',
    'catalog_external_id',
  ]);
  dedupeRows(db, 'sync_run_question_tags', [
    'run_id', 'provider', 'textbook_external_id', 'question_external_id',
    'dimension', 'tag_external_id', 'tag_value', 'relation_type',
    'evidence_type', 'query_fingerprint',
  ]);
  dedupeRows(db, 'sync_run_question_assets', [
    'run_id', 'provider', 'textbook_external_id', 'question_external_id',
    'asset_key',
  ]);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_run_catalog_items_identity
      ON sync_run_catalog_items (
        run_id, provider, textbook_external_id, catalog_external_id
      );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_run_question_items_identity
      ON sync_run_question_items (
        run_id, provider, textbook_external_id, question_external_id
      );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_run_question_catalogs_identity
      ON sync_run_question_catalogs (
        run_id, provider, textbook_external_id,
        question_external_id, catalog_external_id
      );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_run_question_tags_identity
      ON sync_run_question_tags (
        run_id, provider, textbook_external_id, question_external_id,
        dimension, tag_external_id, tag_value, relation_type,
        evidence_type, query_fingerprint
      );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_run_question_assets_identity
      ON sync_run_question_assets (
        run_id, provider, textbook_external_id, question_external_id, asset_key
      );
    CREATE INDEX IF NOT EXISTS idx_sync_run_catalog_items_scope
      ON sync_run_catalog_items (run_id, textbook_external_id, node_level, catalog_external_id);
    CREATE INDEX IF NOT EXISTS idx_sync_run_question_items_scope
      ON sync_run_question_items (run_id, textbook_external_id, question_type, question_external_id);
    CREATE INDEX IF NOT EXISTS idx_sync_run_question_catalogs_catalog
      ON sync_run_question_catalogs (
        run_id, textbook_external_id, catalog_external_id, question_external_id
      );
    CREATE INDEX IF NOT EXISTS idx_sync_run_question_catalogs_question
      ON sync_run_question_catalogs (
        run_id, textbook_external_id, question_external_id, catalog_external_id
      );
    CREATE INDEX IF NOT EXISTS idx_sync_run_question_tags_question
      ON sync_run_question_tags (
        run_id, textbook_external_id, question_external_id, dimension, tag_value
      );
    CREATE INDEX IF NOT EXISTS idx_sync_run_question_assets_question
      ON sync_run_question_assets (
        run_id, textbook_external_id, question_external_id, asset_key
      );
    CREATE INDEX IF NOT EXISTS idx_sync_run_question_assets_hash
      ON sync_run_question_assets (content_sha256);
    -- Asset API lookups always constrain one immutable run scope as well as
    -- the content digest.  Keep that predicate indexable so serving tens of
    -- thousands of unique assets does not scan every asset row in the run.
    CREATE INDEX IF NOT EXISTS idx_sync_run_question_assets_scope_hash
      ON sync_run_question_assets (
        run_id, provider, textbook_external_id, content_sha256
      );
    CREATE INDEX IF NOT EXISTS idx_sync_run_checkpoints_scope
      ON sync_run_checkpoints (scope_key, last_completed_page);
    CREATE INDEX IF NOT EXISTS idx_sync_run_checkpoints_run
      ON sync_run_checkpoints (run_id, scope_key);

    DROP TRIGGER IF EXISTS trg_sync_runs_no_reopen;
    DROP TRIGGER IF EXISTS trg_sync_run_catalog_items_no_update;
    DROP TRIGGER IF EXISTS trg_sync_run_catalog_items_no_insert;
    DROP TRIGGER IF EXISTS trg_sync_run_catalog_items_no_delete;
    DROP TRIGGER IF EXISTS trg_sync_run_question_items_no_update;
    DROP TRIGGER IF EXISTS trg_sync_run_question_items_no_insert;
    DROP TRIGGER IF EXISTS trg_sync_run_question_items_no_delete;
    DROP TRIGGER IF EXISTS trg_sync_run_question_catalogs_no_update;
    DROP TRIGGER IF EXISTS trg_sync_run_question_catalogs_no_insert;
    DROP TRIGGER IF EXISTS trg_sync_run_question_catalogs_no_delete;
    DROP TRIGGER IF EXISTS trg_sync_run_question_tags_no_update;
    DROP TRIGGER IF EXISTS trg_sync_run_question_tags_no_insert;
    DROP TRIGGER IF EXISTS trg_sync_run_question_tags_no_delete;
    DROP TRIGGER IF EXISTS trg_sync_run_question_assets_no_update;
    DROP TRIGGER IF EXISTS trg_sync_run_question_assets_no_insert;
    DROP TRIGGER IF EXISTS trg_sync_run_question_assets_no_delete;
    DROP TRIGGER IF EXISTS trg_snapshot_question_tags_no_update;
    DROP TRIGGER IF EXISTS trg_snapshot_question_tags_no_insert;
    DROP TRIGGER IF EXISTS trg_snapshot_question_tags_no_delete;
    DROP TRIGGER IF EXISTS trg_snapshot_question_assets_no_update;
    DROP TRIGGER IF EXISTS trg_snapshot_question_assets_no_insert;
    DROP TRIGGER IF EXISTS trg_snapshot_question_assets_no_delete;
    DROP TRIGGER IF EXISTS trg_snapshot_run_checkpoints_no_update;
    DROP TRIGGER IF EXISTS trg_snapshot_run_checkpoints_no_insert;
    DROP TRIGGER IF EXISTS trg_snapshot_run_checkpoints_no_delete;
    DROP TRIGGER IF EXISTS trg_snapshot_runs_require_complete;

    -- Once a run has reached a terminal state, it may not be reopened.  The
    -- snapshot triggers below also check status, so this is defence in depth
    -- for direct SQL users of the collector database.
    CREATE TRIGGER trg_sync_runs_no_reopen
    BEFORE UPDATE ON sync_runs
    WHEN OLD.snapshot_locked_at IS NOT NULL
      OR COALESCE(OLD.status, '') IN (${TERMINAL_RUN_STATUS_SQL})
    BEGIN
      SELECT RAISE(ABORT, 'terminal sync runs are immutable');
    END;

    -- A successful/completed row must be locked.  snapshot_complete=1 is the
    -- applyable seal; scan_complete=1 with snapshot_complete=0 is a finished
    -- scan that still has page/asset issues and must not be applied.
    CREATE TRIGGER trg_snapshot_runs_require_complete
    BEFORE UPDATE ON sync_runs
    WHEN COALESCE(NEW.status, '') IN ('success', 'completed')
      AND (
        NEW.snapshot_locked_at IS NULL
        OR (
          COALESCE(NEW.snapshot_complete, 0) <> 1
          AND COALESCE(NEW.scan_complete, 0) <> 1
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'successful sync runs require a complete locked snapshot; terminal sync runs are immutable');
    END;

    CREATE TRIGGER trg_sync_run_catalog_items_no_insert
    BEFORE INSERT ON sync_run_catalog_items
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'run catalog snapshots are immutable');
    END;

    CREATE TRIGGER trg_sync_run_catalog_items_no_update
    BEFORE UPDATE ON sync_run_catalog_items
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
      OR NOT EXISTS (
        SELECT 1 FROM sync_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
    BEGIN
      SELECT RAISE(ABORT, 'run catalog snapshots are immutable');
    END;

    CREATE TRIGGER trg_sync_run_catalog_items_no_delete
    BEFORE DELETE ON sync_run_catalog_items
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'run catalog snapshots are immutable');
    END;

    CREATE TRIGGER trg_sync_run_question_items_no_insert
    BEFORE INSERT ON sync_run_question_items
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'run question snapshots are immutable');
    END;

    CREATE TRIGGER trg_sync_run_question_items_no_update
    BEFORE UPDATE ON sync_run_question_items
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
      OR NOT EXISTS (
        SELECT 1 FROM sync_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
    BEGIN
      SELECT RAISE(ABORT, 'run question snapshots are immutable');
    END;

    CREATE TRIGGER trg_sync_run_question_items_no_delete
    BEFORE DELETE ON sync_run_question_items
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'run question snapshots are immutable');
    END;

    CREATE TRIGGER trg_sync_run_question_catalogs_no_insert
    BEFORE INSERT ON sync_run_question_catalogs
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'run question catalog snapshots are immutable');
    END;

    CREATE TRIGGER trg_sync_run_question_catalogs_no_update
    BEFORE UPDATE ON sync_run_question_catalogs
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
      OR NOT EXISTS (
        SELECT 1 FROM sync_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
    BEGIN
      SELECT RAISE(ABORT, 'run question catalog snapshots are immutable');
    END;

    CREATE TRIGGER trg_sync_run_question_catalogs_no_delete
    BEFORE DELETE ON sync_run_question_catalogs
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'run question catalog snapshots are immutable');
    END;

    CREATE TRIGGER trg_snapshot_question_tags_no_insert
    BEFORE INSERT ON sync_run_question_tags
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'run question tag snapshots are immutable');
    END;

    CREATE TRIGGER trg_snapshot_question_tags_no_update
    BEFORE UPDATE ON sync_run_question_tags
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
      OR NOT EXISTS (
        SELECT 1 FROM sync_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
    BEGIN
      SELECT RAISE(ABORT, 'run question tag snapshots are immutable');
    END;

    CREATE TRIGGER trg_snapshot_question_tags_no_delete
    BEFORE DELETE ON sync_run_question_tags
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'run question tag snapshots are immutable');
    END;

    CREATE TRIGGER trg_snapshot_question_assets_no_insert
    BEFORE INSERT ON sync_run_question_assets
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'run question asset snapshots are immutable');
    END;

    CREATE TRIGGER trg_snapshot_question_assets_no_update
    BEFORE UPDATE ON sync_run_question_assets
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
      OR NOT EXISTS (
        SELECT 1 FROM sync_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
    BEGIN
      SELECT RAISE(ABORT, 'run question asset snapshots are immutable');
    END;

    CREATE TRIGGER trg_snapshot_question_assets_no_delete
    BEFORE DELETE ON sync_run_question_assets
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'run question asset snapshots are immutable');
    END;

    CREATE TRIGGER trg_snapshot_run_checkpoints_no_insert
    BEFORE INSERT ON sync_run_checkpoints
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'run checkpoints are immutable');
    END;

    CREATE TRIGGER trg_snapshot_run_checkpoints_no_update
    BEFORE UPDATE ON sync_run_checkpoints
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
      OR NOT EXISTS (
        SELECT 1 FROM sync_runs
        WHERE id = NEW.run_id AND status = 'running' AND snapshot_locked_at IS NULL
      )
    BEGIN
      SELECT RAISE(ABORT, 'run checkpoints are immutable');
    END;

    CREATE TRIGGER trg_snapshot_run_checkpoints_no_delete
    BEFORE DELETE ON sync_run_checkpoints
    WHEN NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id = OLD.run_id AND status = 'running' AND snapshot_locked_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'run checkpoints are immutable');
    END;
  `);
}

function ensureRunSnapshotSchema(dbPath) {
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    migrateRunSnapshotSchema(db);
  } finally {
    db.close();
  }
}

module.exports = {
  RUN_CHECKPOINT_TABLE,
  SNAPSHOT_TABLES,
  TERMINAL_RUN_STATUSES,
  ensureRunSnapshotSchema,
  migrateRunSnapshotSchema,
};
