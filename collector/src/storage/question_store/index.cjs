'use strict';

/**
 * QuestionSyncStore: SQLite persistence for the question list collector.
 *
 * The class body here holds construction and scope identity; behaviour is
 * split by responsibility into sibling modules and mixed into the prototype.
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { ensureDir, quoteIdentifier } = require('../../shared/utils.cjs');
const { DEFAULT_BANK_ID, DEFAULT_BANK_PATH, PROVIDER } = require('../../sources/zujuan/constants.cjs');
const { ensureCollectorSchema } = require('../schema.cjs');
const { RunLifecycleMethods } = require('./run_lifecycle.cjs');
const { CatalogRepoMethods } = require('./catalog_repo.cjs');
const { PageRepoMethods } = require('./page_repo.cjs');
const { ProgressProjectionMethods } = require('./progress_projection.cjs');
const { ErrorLogMethods } = require('./error_log.cjs');
const { assertMathSource } = require('../../sources/registry.cjs');

class QuestionSyncStore {
  constructor(dbPath, { dataDir = null } = {}) {
    ensureDir(path.dirname(path.resolve(dbPath)));
    this.dataDir = dataDir ? path.resolve(dataDir) : null;
    this.db = new DatabaseSync(path.resolve(dbPath));
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    ensureCollectorSchema(this.db);
    this.lastBeginMeta = null;
  }

  _scopeObject(scope) {
    const value = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {};
    const { sealedCoverageEvidence: _ignored, ...unsealed } = value;
    return { ...unsealed, sourceNamespace: assertMathSource(value) };
  }

  _scopeIdentity(scope) {
    const value = this._scopeObject(scope);
    return JSON.stringify({
      provider: PROVIDER,
      sourceNamespace: value.sourceNamespace,
      bankId: String(value.bankId ?? DEFAULT_BANK_ID),
      bankPath: String(value.bankPath ?? DEFAULT_BANK_PATH),
      textbookId: String(value.textbookId ?? ''),
      catalogIds: [...(value.catalogIds || [])].map(String).sort(),
      catalogLevels: [...(value.catalogLevels || [])].map(Number).sort(),
      // max-catalogs/max-pages (or a row limit) are operational bounds and
      // may widen when an interrupted probe is resumed. Asset collection and
      // the 1000-page policy are data/scope semantics, so they stay frozen.
      downloadAssets: value.downloadAssets !== false,
      limitTo1000Pages: value.limitTo1000Pages === true,
      filters: value.filters || {},
    });
  }

  _latestRun(scope, statuses) {
    const rows = this.db.prepare(`
      SELECT * FROM sync_runs WHERE provider = ?
        AND CAST(json_extract(scope_json, '$.textbookId') AS TEXT) = ?
        AND NOT EXISTS (SELECT 1 FROM sync_result_cleanup WHERE run_id=sync_runs.id)
      ORDER BY id DESC LIMIT 50
    `).all(PROVIDER, String(scope.textbookId ?? ''));
    const identity = this._scopeIdentity(scope);
    return rows.find((row) => {
      if (!statuses.includes(String(row.status || ''))) return false;
      try { return this._scopeIdentity(JSON.parse(row.scope_json || '{}')) === identity; } catch { return false; }
    }) || null;
  }

  _copyTableRows(table, sourceRunId, targetRunId) {
    const columns = this.db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => String(row.name));
    if (!columns.includes('run_id')) return 0;
    const copyColumns = columns.filter((column) => column !== 'run_id');
    const insertColumns = ['run_id', ...copyColumns].map(quoteIdentifier).join(', ');
    const selectColumns = ['?', ...copyColumns.map(quoteIdentifier)].join(', ');
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO ${quoteIdentifier(table)} (${insertColumns})
      SELECT ${selectColumns} FROM ${quoteIdentifier(table)} WHERE run_id = ?
    `).run(Number(targetRunId), Number(sourceRunId));
    return Number(result?.changes || 0);
  }


  status() {
    return {
      counts: this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM questions) AS questions,
          (SELECT COUNT(*) FROM textbook_nodes) AS nodes,
          (SELECT COUNT(*) FROM question_catalog_memberships) AS catalog_links,
          (SELECT COUNT(*) FROM question_knowledge) AS knowledge_links,
          (SELECT COUNT(*) FROM question_facets) AS facets,
          (SELECT COUNT(*) FROM question_assets) AS assets
      `).get(),
      recentRuns: this.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20').all(),
    };
  }

  close() {
    try { this.db.close(); } catch {}
  }

}

function mixin(Target, Source) {
  for (const name of Object.getOwnPropertyNames(Source.prototype)) {
    if (name === 'constructor') continue;
    Object.defineProperty(
      Target.prototype,
      name,
      Object.getOwnPropertyDescriptor(Source.prototype, name),
    );
  }
}

mixin(QuestionSyncStore, RunLifecycleMethods);
mixin(QuestionSyncStore, CatalogRepoMethods);
mixin(QuestionSyncStore, PageRepoMethods);
mixin(QuestionSyncStore, ProgressProjectionMethods);
mixin(QuestionSyncStore, ErrorLogMethods);

module.exports = { QuestionSyncStore };
