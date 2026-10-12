'use strict';

/**
 * SQLite schema for the question list collector's mutable candidate tables.
 * Additive and idempotent; run snapshot tables come from run_snapshots.cjs.
 */

const { quoteIdentifier, sha256 } = require('../shared/utils.cjs');
const { migrateRunSnapshotSchema } = require('./run_snapshots.cjs');

function ensureColumn(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => String(row.name)));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`);
}

function ensureCollectorSchema(db) {
  migrateRunSnapshotSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_checkpoints (
      scope_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      filter_json TEXT NOT NULL,
      last_completed_page INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS textbook_nodes (
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      textbook_external_id TEXT,
      parent_external_id TEXT,
      node_level INTEGER,
      node_type TEXT,
      name TEXT NOT NULL,
      source_path TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (provider, external_id)
    );
    CREATE TABLE IF NOT EXISTS questions (
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      bank_id INTEGER,
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
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (provider, external_id)
    );
    CREATE TABLE IF NOT EXISTS question_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      data_json TEXT NOT NULL,
      UNIQUE(provider, question_external_id, content_hash)
    );
    CREATE TABLE IF NOT EXISTS question_knowledge (
      provider TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      knowledge_external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      knowledge_kind TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(provider, question_external_id, knowledge_external_id, knowledge_kind)
    );
    CREATE TABLE IF NOT EXISTS question_catalog_memberships (
      provider TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      catalog_external_id TEXT NOT NULL,
      catalog_level INTEGER,
      catalog_name TEXT,
      catalog_path TEXT,
      evidence_type TEXT NOT NULL,
      query_fingerprint TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(provider, question_external_id, catalog_external_id, evidence_type, query_fingerprint)
    );
    CREATE TABLE IF NOT EXISTS question_facets (
      provider TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      dimension TEXT NOT NULL,
      value TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      query_fingerprint TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(provider, question_external_id, dimension, value, evidence_type, query_fingerprint)
    );
    CREATE TABLE IF NOT EXISTS question_assets (
      provider TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      local_path TEXT,
      sha256 TEXT,
      mime_type TEXT,
      byte_size INTEGER,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(provider, question_external_id, source_url)
    );
    CREATE TABLE IF NOT EXISTS catalog_list_stats (
      scope_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      catalog_external_id TEXT NOT NULL,
      chapter_id TEXT,
      filter_json TEXT NOT NULL,
      expected_total INTEGER,
      page_capacity INTEGER,
      expected_pages INTEGER,
      list_seen_count INTEGER NOT NULL DEFAULT 0,
      last_completed_page INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_progress (
      run_id INTEGER NOT NULL,
      worker_id INTEGER NOT NULL,
      catalog_external_id TEXT,
      catalog_name TEXT,
      catalog_path TEXT,
      current_page INTEGER,
      expected_pages INTEGER,
      expected_total INTEGER,
      updated_at TEXT NOT NULL,
      slot_status TEXT,
      question_count INTEGER,
      result_type TEXT,
      message TEXT,
      PRIMARY KEY(run_id, worker_id)
    );
    CREATE TABLE IF NOT EXISTS sync_run_catalog_progress (
      run_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      textbook_external_id TEXT NOT NULL,
      catalog_external_id TEXT NOT NULL,
      expected_total INTEGER,
      page_capacity INTEGER,
      expected_pages INTEGER,
      last_completed_page INTEGER NOT NULL DEFAULT 0,
      list_seen_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      observed_at TEXT NOT NULL,
      target_pages INTEGER,
      max_observed_total INTEGER,
      highest_attempted_page INTEGER NOT NULL DEFAULT 0,
      scan_complete INTEGER NOT NULL DEFAULT 0,
      data_complete INTEGER NOT NULL DEFAULT 0,
      completion_quality TEXT,
      failed_page_count INTEGER NOT NULL DEFAULT 0,
      duplicate_page_count INTEGER NOT NULL DEFAULT 0,
      empty_page_count INTEGER NOT NULL DEFAULT 0,
      parse_error_count INTEGER NOT NULL DEFAULT 0,
      asset_error_count INTEGER NOT NULL DEFAULT 0,
      stall_reason TEXT,
      scan_percent_high_water REAL,
      PRIMARY KEY(run_id, provider, textbook_external_id, catalog_external_id),
      FOREIGN KEY(run_id) REFERENCES sync_runs(id)
    );
    CREATE TABLE IF NOT EXISTS sync_run_catalog_pages (
      run_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      textbook_external_id TEXT NOT NULL,
      catalog_external_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      page_signature TEXT NOT NULL,
      question_count INTEGER NOT NULL DEFAULT 0,
      question_ids_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      attempt_status TEXT NOT NULL DEFAULT 'resolved',
      attempt_count INTEGER NOT NULL DEFAULT 1,
      result_type TEXT NOT NULL DEFAULT 'success',
      error_code TEXT,
      raw_snapshot_path TEXT,
      first_seen_at TEXT,
      finished_at TEXT,
      new_question_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(run_id, provider, textbook_external_id, catalog_external_id, page_number),
      FOREIGN KEY(run_id) REFERENCES sync_runs(id)
    );
    CREATE TABLE IF NOT EXISTS source_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      snapshot_type TEXT NOT NULL,
      source_url TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      file_path TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES sync_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_source_snapshots_run
      ON source_snapshots (run_id, captured_at);
    CREATE TABLE IF NOT EXISTS sync_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      source_url TEXT,
      stage TEXT NOT NULL,
      error_code TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES sync_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_errors_run
      ON sync_errors (run_id, created_at);
  `);

  // Collector-only additive fields.  Existing formal/apply contracts keep
  // their original columns; these fields make list completeness explicit.
  const questionColumns = {
    content_source: "TEXT NOT NULL DEFAULT 'unknown'",
    content_complete: 'INTEGER NOT NULL DEFAULT 0',
    category_external_id: 'TEXT',
    category_name: 'TEXT',
    title_abbreviation: 'TEXT',
    website_time_text: 'TEXT',
    reference_count: 'INTEGER',
    reference_papers_json: 'TEXT',
    difficulty_qdid: 'TEXT',
  };
  const nodeColumns = {
    raw_json: "TEXT NOT NULL DEFAULT '{}'",
    category_id: 'TEXT',
    catelog_tokpoint_id: 'TEXT',
    is_knowledge: 'INTEGER NOT NULL DEFAULT 0',
    sort_order: 'INTEGER',
    catalog_path: 'TEXT',
  };
  for (const [column, definition] of Object.entries(questionColumns)) {
    ensureColumn(db, 'questions', column, definition);
    ensureColumn(db, 'sync_run_question_items', column, definition);
  }
  for (const [column, definition] of Object.entries(nodeColumns)) {
    ensureColumn(db, 'textbook_nodes', column, definition);
    ensureColumn(db, 'sync_run_catalog_items', column, definition);
  }
  const progressColumns = {
    target_pages: 'INTEGER',
    max_observed_total: 'INTEGER',
    highest_attempted_page: 'INTEGER NOT NULL DEFAULT 0',
    scan_complete: 'INTEGER NOT NULL DEFAULT 0',
    data_complete: 'INTEGER NOT NULL DEFAULT 0',
    completion_quality: 'TEXT',
    failed_page_count: 'INTEGER NOT NULL DEFAULT 0',
    duplicate_page_count: 'INTEGER NOT NULL DEFAULT 0',
    empty_page_count: 'INTEGER NOT NULL DEFAULT 0',
    parse_error_count: 'INTEGER NOT NULL DEFAULT 0',
    asset_error_count: 'INTEGER NOT NULL DEFAULT 0',
    stall_reason: 'TEXT',
    scan_percent_high_water: 'REAL',
  };
  const pageAttemptColumns = {
    attempt_status: "TEXT NOT NULL DEFAULT 'resolved'",
    attempt_count: 'INTEGER NOT NULL DEFAULT 1',
    result_type: "TEXT NOT NULL DEFAULT 'success'",
    error_code: 'TEXT',
    raw_snapshot_path: 'TEXT',
    first_seen_at: 'TEXT',
    finished_at: 'TEXT',
    new_question_count: 'INTEGER NOT NULL DEFAULT 0',
  };
  const runScanColumns = {
    scan_complete: 'INTEGER NOT NULL DEFAULT 0',
    data_complete: 'INTEGER NOT NULL DEFAULT 0',
    completion_quality: 'TEXT',
  };
  for (const [column, definition] of Object.entries(progressColumns)) {
    ensureColumn(db, 'sync_run_catalog_progress', column, definition);
  }
  for (const [column, definition] of Object.entries(pageAttemptColumns)) {
    ensureColumn(db, 'sync_run_catalog_pages', column, definition);
  }
  for (const [column, definition] of Object.entries(runScanColumns)) {
    ensureColumn(db, 'sync_runs', column, definition);
  }
  const progressSlotColumns = {
    slot_status: 'TEXT',
    question_count: 'INTEGER',
    result_type: 'TEXT',
    message: 'TEXT',
  };
  for (const [column, definition] of Object.entries(progressSlotColumns)) {
    ensureColumn(db, 'sync_progress', column, definition);
  }
}

module.exports = {
  ensureCollectorSchema,
  ensureColumn,
};
