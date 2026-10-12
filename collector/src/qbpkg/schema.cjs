'use strict';

const SNAPSHOT_TABLES = Object.freeze([
  'qb_textbook_version',
  'qb_textbook',
  'qb_catalog_node',
  'qb_question',
  'qb_question_catalog',
  'qb_question_tag',
  'qb_question_asset',
]);

const SNAPSHOT_SCHEMA_VERSION = '2';
const PACKAGE_FORMAT_VERSION = '1';

function createSnapshotSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    CREATE TABLE qb_textbook_version (
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      version_name TEXT NOT NULL,
      subject TEXT,
      grade TEXT,
      edition TEXT,
      source_url TEXT,
      metadata_json TEXT NOT NULL,
      PRIMARY KEY (provider, external_id)
    );
    CREATE TABLE qb_textbook (
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      version_external_id TEXT NOT NULL,
      textbook_name TEXT NOT NULL,
      subject TEXT,
      grade TEXT,
      edition TEXT,
      volume TEXT,
      source_url TEXT,
      metadata_json TEXT NOT NULL,
      PRIMARY KEY (provider, external_id),
      FOREIGN KEY (provider, version_external_id)
        REFERENCES qb_textbook_version(provider, external_id)
    );
    CREATE TABLE qb_catalog_node (
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      textbook_external_id TEXT,
      parent_external_id TEXT,
      node_level INTEGER,
      node_type TEXT,
      name TEXT NOT NULL,
      source_path TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL,
      PRIMARY KEY (provider, external_id),
      FOREIGN KEY (provider, textbook_external_id)
        REFERENCES qb_textbook(provider, external_id)
    );
    CREATE TABLE qb_question (
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      textbook_version_external_id TEXT,
      textbook_external_id TEXT,
      detail_url TEXT,
      source_short TEXT,
      source_title TEXT,
      source_url TEXT,
      source_original_json TEXT NOT NULL,
      question_type TEXT,
      question_type_id TEXT,
      difficulty_label TEXT,
      difficulty_code TEXT,
      ease_coefficient REAL,
      content_html TEXT,
      plain_text TEXT,
      content_hash TEXT,
      subquestion_count INTEGER NOT NULL DEFAULT 0,
      child_count INTEGER,
      has_image INTEGER NOT NULL DEFAULT 0,
      has_formula INTEGER NOT NULL DEFAULT 0,
      has_table INTEGER NOT NULL DEFAULT 0,
      is_new INTEGER NOT NULL DEFAULT 0,
      assemble_count INTEGER,
      reference_count INTEGER,
      year TEXT,
      region TEXT,
      exam_type TEXT,
      answer_html TEXT,
      solution_html TEXT,
      answer_status TEXT NOT NULL,
      first_seen_at TEXT,
      last_seen_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (provider, external_id),
      FOREIGN KEY (provider, textbook_version_external_id)
        REFERENCES qb_textbook_version(provider, external_id),
      FOREIGN KEY (provider, textbook_external_id)
        REFERENCES qb_textbook(provider, external_id)
    );
    CREATE TABLE qb_question_catalog (
      provider TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      catalog_external_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      query_fingerprint TEXT,
      observed_at TEXT,
      PRIMARY KEY (provider, question_external_id, catalog_external_id, relation_type, evidence_type, query_fingerprint),
      FOREIGN KEY (provider, question_external_id)
        REFERENCES qb_question(provider, external_id),
      FOREIGN KEY (provider, catalog_external_id)
        REFERENCES qb_catalog_node(provider, external_id)
    );
    CREATE TABLE qb_question_tag (
      provider TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      dimension TEXT NOT NULL,
      tag_external_id TEXT,
      tag_value TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      query_fingerprint TEXT,
      observed_at TEXT,
      PRIMARY KEY (provider, question_external_id, dimension, tag_external_id, tag_value, relation_type, evidence_type, query_fingerprint),
      FOREIGN KEY (provider, question_external_id)
        REFERENCES qb_question(provider, external_id)
    );
    CREATE TABLE qb_question_asset (
      provider TEXT NOT NULL,
      question_external_id TEXT NOT NULL,
      asset_key TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      source_url TEXT NOT NULL,
      content_sha256 TEXT,
      storage_path TEXT,
      mime_type TEXT,
      byte_size INTEGER,
      observed_at TEXT,
      PRIMARY KEY (provider, question_external_id, asset_key),
      FOREIGN KEY (provider, question_external_id)
        REFERENCES qb_question(provider, external_id)
    );
    CREATE INDEX qb_catalog_parent_idx ON qb_catalog_node(provider, parent_external_id);
    CREATE INDEX qb_question_catalog_catalog_idx ON qb_question_catalog(provider, catalog_external_id);
    CREATE INDEX qb_question_tag_value_idx ON qb_question_tag(provider, dimension, tag_value);
    CREATE INDEX qb_question_asset_url_idx ON qb_question_asset(provider, source_url);
  `);
}

module.exports = {
  PACKAGE_FORMAT_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_TABLES,
  createSnapshotSchema,
};
