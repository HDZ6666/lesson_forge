'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PROVIDER = 'zujuan';
const MAX_CANDIDATE_ROWS = 20001;
const MAX_SELECTED_TEXTBOOKS = 200;
const DEFAULT_RUN_PAGE_SIZE = 50;
const MAX_RUN_PAGE_SIZE = 200;
const DEFAULT_CATALOG_PAGE_SIZE = 200;
const MAX_CATALOG_PAGE_SIZE = 500;
const MAX_RUN_PAGE_NUMBER = 100000;
const MAX_RUN_OFFSET = 20_000_000;
const MAX_RUN_TEXT_LENGTH = 120000;
const MAX_RUN_RAW_JSON_LENGTH = 160000;
const MAX_RUN_ERRORS = 50;
const MAX_RUN_SNAPSHOT_ROWS = 20000;
// The live tree is only a progress projection.  Keep it deliberately bounded
// so a malformed/very large provider tree can never turn every polling
// response into a large untrusted payload.
const MAX_LIVE_TREE_NODES = 1000;
// The page API deliberately uses a lower target than the HTTP hard limit.
// This leaves room for the response envelope and keeps a page safe even
// when a caller and the HTTP layer use slightly different limits.  Rows are
// fetched in fixed small batches, so a large assets table never becomes a
// giant in-memory array even when a caller requests the maximum page size.
const MAX_SNAPSHOT_PAGE_BYTES = 6 * 1024 * 1024;
const MAX_SNAPSHOT_PAGE_SIZE = 5000;
const MAX_SNAPSHOT_FETCH_BATCH_SIZE = 64;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const ASSET_SHA256 = /^[a-f0-9]{64}$/i;
const STRICT_SNAPSHOT_RUN_COLUMNS = Object.freeze([
  'finished_at', 'scope_json', 'error_count', 'snapshot_locked_at',
  'snapshot_complete', 'catalog_item_count', 'question_item_count',
  'question_catalog_count', 'question_tag_count', 'question_asset_count',
]);
const SNAPSHOT_COLLECTIONS = Object.freeze({
  catalogs: {
    table: 'sync_run_catalog_items',
    count: 'catalogItemCount',
    orderBy: `
      textbook_external_id ASC,
      COALESCE(sort_order, 2147483647) ASC,
      COALESCE(node_level, 2147483647) ASC,
      catalog_external_id ASC
    `,
  },
  questions: {
    table: 'sync_run_question_items',
    count: 'questionItemCount',
    orderBy: `
      textbook_external_id ASC,
      question_external_id ASC
    `,
  },
  questionCatalogs: {
    table: 'sync_run_question_catalogs',
    count: 'questionCatalogCount',
    orderBy: `
      textbook_external_id ASC,
      question_external_id ASC,
      COALESCE(catalog_level, 2147483647) ASC,
      catalog_external_id ASC
    `,
  },
  tags: {
    table: 'sync_run_question_tags',
    count: 'questionTagCount',
    orderBy: `
      textbook_external_id ASC,
      question_external_id ASC,
      dimension ASC,
      tag_external_id ASC,
      tag_value ASC,
      relation_type ASC,
      evidence_type ASC,
      query_fingerprint ASC
    `,
  },
  assets: {
    table: 'sync_run_question_assets',
    count: 'questionAssetCount',
    orderBy: `
      textbook_external_id ASC,
      question_external_id ASC,
      asset_key ASC,
      COALESCE(content_sha256, '') ASC,
      COALESCE(storage_path, '') ASC
    `,
  },
});
// Source IDs are used in API paths and SQL predicates. Keep the complete
// identifier, including numeric-only IDs, within the same 64-character
// contract instead of letting a numeric alternation bypass the bound.
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const ENTITIES = {
  version: {
    table: 'source_textbook_versions',
    idColumn: 'external_version_id',
    columns: [
      'provider', 'external_version_id', 'version_name', 'source_url', 'is_new',
      'sort_order', 'status', 'first_seen_at', 'last_seen_at',
    ],
  },
  textbook: {
    table: 'source_textbooks',
    idColumn: 'external_textbook_id',
    columns: [
      'provider', 'external_textbook_id', 'version_external_id', 'textbook_name',
      'grade', 'volume', 'source_url', 'sort_order', 'status',
      'bootstrap_chapter_external_id', 'first_seen_at', 'last_seen_at',
    ],
  },
  catalog: {
    table: 'textbook_nodes',
    idColumn: 'external_id',
    columns: [
      'provider', 'external_id', 'textbook_external_id', 'parent_external_id',
      'node_level', 'node_type', 'name', 'source_path', 'source_url', 'sort_order',
      'status', 'first_seen_at', 'last_seen_at',
    ],
  },
  question: {
    table: 'questions',
    idColumn: 'external_id',
    columns: [
      'provider', 'external_id', 'chapter_id', 'detail_url', 'source_short',
      'source_title', 'source_url', 'source_question_no', 'question_type',
      'difficulty_label', 'difficulty_code', 'ease_coefficient', 'content_hash',
      'detail_content_hash', 'plain_text', 'detail_fetched', 'subquestion_count', 'is_new',
      'provider_updated_at', 'first_seen_at', 'last_seen_at',
    ],
  },
};

function safeExternalId(value) {
  if (value == null) return false;
  return SAFE_EXTERNAL_ID.test(String(value).trim());
}

function httpError(message, statusCode = 400, code = 'bad_request') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function snapshotLockPresent(value) {
  if (value == null || value === '' || value === false || value === 0) return false;
  const text = String(value).trim().toLowerCase();
  return text !== '' && !['0', 'false', 'null', 'undefined'].includes(text)
    && !/^0+(?:\.0+)?$/.test(text);
}

function boundedText(value, name, maxLength, { optional = true } = {}) {
  if (value == null || value === '') {
    if (optional) return null;
    throw httpError(`${name} 不能为空`);
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw httpError(`${name} 格式不安全`);
  }
  const text = String(value).trim();
  if (!text && !optional) throw httpError(`${name} 不能为空`);
  if (!text) return null;
  if (text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw httpError(`${name} 格式不安全`);
  }
  return text;
}

function positiveInt(value, name, fallback, max) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    throw httpError(`${name} 必须是 1 到 ${max} 之间的整数`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw httpError(`${name} 必须是 1 到 ${max} 之间的整数`);
  }
  return parsed;
}

function nonNegativeInt(value, name, fallback, max) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    throw httpError(`${name} 必须是 0 到 ${max} 之间的整数`);
  }
  if (typeof value === 'boolean' || (typeof value !== 'string' && typeof value !== 'number')) {
    throw httpError(`${name} 必须是 0 到 ${max} 之间的整数`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw httpError(`${name} 必须是 0 到 ${max} 之间的整数`);
  }
  return parsed;
}

function requiredRunId(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    throw httpError('runId 必须是正整数');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw httpError('runId 必须是正整数');
  return parsed;
}

function optionalExternalId(value, name) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw httpError(`${name} 格式不安全`);
  }
  const text = String(value).trim();
  if (!safeExternalId(text)) throw httpError(`${name} 格式不安全`);
  return text;
}

function parseJsonObject(value) {
  try {
    const raw = String(value || '{}');
    if (raw.length > MAX_RUN_RAW_JSON_LENGTH) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function boundedString(value, maxLength = MAX_RUN_TEXT_LENGTH) {
  if (value == null) return null;
  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function pageBounds(page, pageSize) {
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset) || offset > MAX_RUN_OFFSET) {
    throw httpError(`page 超出安全查询范围（最多 ${MAX_RUN_PAGE_NUMBER} 页）`);
  }
  return offset;
}

function boundedScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return {};
  const output = {};
  for (const [key, value] of Object.entries(scope).slice(0, 64)) {
    if (typeof value === 'string') output[key] = boundedString(value, 4000);
    else if (typeof value === 'number' || typeof value === 'boolean' || value == null) output[key] = value;
    else if (Array.isArray(value)) {
      output[key] = value.slice(0, 500).map((item) => (
        typeof item === 'object' && item !== null ? boundedScope(item) : boundedString(item, 400)
      ));
    } else if (typeof value === 'object') output[key] = boundedScope(value);
  }
  return output;
}

function scopeTextbookIds(scope) {
  const ids = [];
  const add = (value) => {
    if (value == null || value === '') return;
    const text = String(value).trim();
    if (safeExternalId(text) && !ids.includes(text)) ids.push(text);
  };
  add(scope?.textbookId);
  add(scope?.textbookExternalId);
  for (const value of (Array.isArray(scope?.textbookIds) ? scope.textbookIds : [])) add(value);
  for (const value of (Array.isArray(scope?.textbookExternalIds) ? scope.textbookExternalIds : [])) add(value);
  return ids;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (character) => `\\${character}`);
}

function openReadOnly(dbPath) {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  const db = new DatabaseSync(resolved, { readOnly: true });
  // A page save runs in a short IMMEDIATE transaction.  WAL lets this
  // reader observe the previous committed snapshot while that transaction
  // is in flight, and busy_timeout covers the small checkpoint/lock window.
  try { db.exec('PRAGMA busy_timeout = 5000; PRAGMA query_only = true;'); } catch {}
  return db;
}

function tableNames(db) {
  return new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)),
  );
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => String(row.name)));
}

function optionalSelect(columns, tableAlias, column, alias = column) {
  const qualified = `${tableAlias ? `${tableAlias}.` : ''}"${column}"`;
  return columns.has(column) ? `${qualified} AS "${alias}"` : `NULL AS "${alias}"`;
}

function resolveContentRun(db, runId) {
  const id = requiredRunId(runId);
  if (!tableNames(db).has('sync_runs')) {
    throw httpError('collector SQLite 缺少 sync_runs 表', 503, 'snapshot_unavailable');
  }
  const columns = tableColumns(db, 'sync_runs');
  if (!columns.has('id') || !columns.has('provider') || !columns.has('status')) {
    throw httpError('collector SQLite 的 sync_runs 字段不完整', 503, 'snapshot_unavailable');
  }
  const optional = (name, alias = name) => columns.has(name)
    ? `"${name}" AS "${alias}"`
    : `NULL AS "${alias}"`;
  const row = db.prepare(`
    SELECT "id", "provider", "status",
           ${optional('started_at')}, ${optional('finished_at')},
           ${optional('scope_json')}, ${optional('pages_ok')},
           ${optional('questions_seen')}, ${optional('questions_inserted')},
           ${optional('questions_updated')}, ${optional('details_fetched')},
           ${optional('assets_downloaded')}, ${optional('error_count')},
           ${optional('message')}, ${optional('snapshot_locked_at')},
           ${optional('snapshot_complete')},
           ${optional('scan_complete')}, ${optional('data_complete')},
           ${optional('completion_quality')},
           ${optional('catalog_item_count')}, ${optional('question_item_count')},
           ${optional('question_catalog_count')}, ${optional('question_tag_count')},
           ${optional('question_asset_count')}
    FROM "sync_runs" WHERE "id" = ?
  `).get(id);
  if (!row) throw httpError(`内容运行 ${id} 不存在`, 404, 'run_not_found');
  if (String(row.provider || '') !== PROVIDER) {
    throw httpError(`内容运行 ${id} 来源不受支持`, 404, 'run_not_found');
  }
  const scope = boundedScope(parseJsonObject(row.scope_json));
  const textbookIds = scopeTextbookIds(scope);
  return {
    id: Number(row.id),
    runId: Number(row.id),
    collectorRunId: Number(row.id),
    provider: row.provider,
    status: String(row.status || ''),
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    scope,
    textbookExternalId: textbookIds.length === 1 ? textbookIds[0] : null,
    textbookExternalIds: textbookIds,
    pagesOk: Number(row.pages_ok || 0),
    questionsSeen: Number(row.questions_seen || 0),
    questionsInserted: Number(row.questions_inserted || 0),
    questionsUpdated: Number(row.questions_updated || 0),
    detailsFetched: Number(row.details_fetched || 0),
    assetsDownloaded: Number(row.assets_downloaded || 0),
    errorCount: Number(row.error_count || 0),
    message: boundedString(row.message, 4000),
    snapshotLockedAt: snapshotLockPresent(row.snapshot_locked_at)
      ? row.snapshot_locked_at : null,
    snapshotComplete: Number(row.snapshot_complete || 0) === 1,
    scanComplete: Number(row.scan_complete || 0) === 1,
    dataComplete: Number(row.data_complete || 0) === 1,
    completionQuality: row.completion_quality || null,
    catalogItemCount: Number(row.catalog_item_count || 0),
    questionItemCount: Number(row.question_item_count || 0),
    questionCatalogCount: Number(row.question_catalog_count || 0),
    questionTagCount: Number(row.question_tag_count || 0),
    questionAssetCount: Number(row.question_asset_count || 0),
  };
}

function assertSnapshotTables(db, { all = false } = {}) {
  const tables = tableNames(db);
  const missing = [
    'sync_run_catalog_items',
    'sync_run_question_items',
    'sync_run_question_catalogs',
    ...(all ? ['sync_run_question_tags', 'sync_run_question_assets'] : []),
  ].filter((table) => !tables.has(table));
  if (missing.length) {
    throw httpError(
      `collector SQLite 缺少运行快照表：${missing.join(', ')}`,
      503,
      'snapshot_unavailable',
    );
  }
  const requiredColumns = {
    sync_run_catalog_items: [
      'run_id', 'provider', 'textbook_external_id', 'catalog_external_id', 'name',
    ],
    sync_run_question_items: [
      'run_id', 'provider', 'textbook_external_id', 'question_external_id',
      'content_html', 'plain_text', 'question_type',
      'answer_html', 'analysis_html', 'answer_status', 'solution_html',
    ],
    sync_run_question_catalogs: [
      'run_id', 'provider', 'textbook_external_id', 'question_external_id',
      'catalog_external_id',
    ],
    ...(all ? {
      sync_run_question_tags: [
        'run_id', 'provider', 'textbook_external_id', 'question_external_id',
        'dimension', 'tag_external_id', 'tag_value', 'relation_type',
        'evidence_type', 'query_fingerprint', 'observed_at',
      ],
      sync_run_question_assets: [
        'run_id', 'provider', 'textbook_external_id', 'question_external_id',
        'asset_key', 'asset_type', 'source_url', 'content_sha256',
        'storage_path', 'mime_type', 'byte_size', 'observed_at',
      ],
    } : {}),
  };
  const invalid = Object.entries(requiredColumns).flatMap(([table, columns]) => {
    const actual = tableColumns(db, table);
    return columns.filter((column) => !actual.has(column)).map((column) => `${table}.${column}`);
  });
  if (invalid.length) {
    throw httpError(
      `collector SQLite 运行快照字段不完整：${invalid.join(', ')}`,
      503,
      'snapshot_unavailable',
    );
  }
}

/**
 * Check only the immutable run header required by the page/asset APIs.
 *
 * The full snapshot-summary endpoint additionally checks persisted counters
 * and orphan relations.  Those checks are intentionally not repeated for
 * every page or every asset request: once the run is sealed, the snapshot
 * tables are protected by SQLite triggers, while the service validates the
 * complete summary before it starts consuming pages/assets.
 */
function assertApplyableSnapshotRun(db, run) {
  const runColumns = tableColumns(db, 'sync_runs');
  const missingRunColumns = STRICT_SNAPSHOT_RUN_COLUMNS.filter((column) => !runColumns.has(column));
  if (missingRunColumns.length) {
    throw httpError(
      `collector SQLite sync_runs 字段不完整：${missingRunColumns.join(', ')}`,
      503,
      'snapshot_unavailable',
    );
  }
  if (!['success', 'completed'].includes(String(run.status || '').toLowerCase()) || !run.finishedAt) {
    throw httpError(`内容运行 ${run.id} 未成功完成，暂无可用快照`, 409, 'snapshot_unavailable');
  }
  if (!snapshotLockPresent(run.snapshotLockedAt)) {
    throw httpError(`内容运行 ${run.id} 尚未锁定，暂无可用快照`, 409, 'snapshot_unavailable');
  }
  if (run.snapshotComplete !== true) {
    throw httpError(`内容运行 ${run.id} 的快照不完整，不能应用`, 409, 'snapshot_incomplete');
  }
  if (!Number.isSafeInteger(run.errorCount) || run.errorCount < 0) {
    throw httpError(`内容运行 ${run.id} 的 error_count 无效`, 409, 'snapshot_incomplete');
  }
  if (run.errorCount > 0) {
    throw httpError(`内容运行 ${run.id} 包含采集错误，不能应用`, 409, 'snapshot_incomplete');
  }
}

function snapshotScopeIds(db, run) {
  const scopeIds = new Set(run.textbookExternalIds || []);
  const available = tableNames(db);
  for (const table of [
    'sync_run_catalog_items',
    'sync_run_question_items',
    'sync_run_question_catalogs',
    'sync_run_question_tags',
    'sync_run_question_assets',
  ]) {
    if (!available.has(table)) continue;
    // On a single-textbook run, DISTINCT would walk every tag/asset index
    // entry just to return one ID. The two indexed endpoints prove whether
    // this table contains one or several scopes without a full scan.
    const edge = (direction) => db.prepare(`
      SELECT textbook_external_id FROM "${table}"
      WHERE run_id = ? AND provider = ?
      ORDER BY textbook_external_id ${direction} LIMIT 1
    `).get(run.id, PROVIDER)?.textbook_external_id;
    const first = edge('ASC');
    if (first == null) continue;
    const last = edge('DESC');
    scopeIds.add(String(first));
    if (first !== last) {
      for (const row of db.prepare(`
        SELECT DISTINCT textbook_external_id FROM "${table}"
        WHERE run_id = ? AND provider = ?
      `).all(run.id, PROVIDER)) {
        if (row.textbook_external_id != null) scopeIds.add(String(row.textbook_external_id));
      }
    }
  }
  return scopeIds;
}

function resolveSnapshotTextbook(db, run, requestedTextbookId) {
  const declaredScopeIds = new Set(run.textbookExternalIds || []);
  // The service always supplies the textbook for a multi-scope apply.  In
  // that common path the run declaration plus one ownership check is enough;
  // do not rescan five large snapshot tables for every asset request.
  if (requestedTextbookId) {
    if (!safeExternalId(requestedTextbookId)) {
      throw httpError('快照缺少有效教材范围', 409, 'snapshot_incomplete');
    }
    assertRunTextbook(db, run, requestedTextbookId);
    return {
      textbookExternalId: requestedTextbookId,
      scopeIds: declaredScopeIds,
    };
  }

  // A declared single-textbook run does not need DISTINCT scans either.
  const scopeIds = declaredScopeIds.size === 1
    ? declaredScopeIds
    : snapshotScopeIds(db, run);
  let textbookExternalId = requestedTextbookId;
  if (!textbookExternalId) {
    if (scopeIds.size !== 1) {
      throw httpError(
        `内容运行 ${run.id} 包含多个教材范围，必须指定 textbookExternalId`,
        400,
        'textbook_scope_required',
      );
    }
    textbookExternalId = [...scopeIds][0];
  }
  if (!safeExternalId(textbookExternalId)) {
    throw httpError('快照缺少有效教材范围', 409, 'snapshot_incomplete');
  }
  assertRunTextbook(db, run, textbookExternalId);
  return { textbookExternalId, scopeIds };
}

function assertRunTextbook(db, run, textbookExternalId) {
  if (!textbookExternalId) return;
  const requested = String(textbookExternalId);
  const scopedIds = Array.isArray(run.textbookExternalIds) ? run.textbookExternalIds : [];
  if (scopedIds.length > 0 && !scopedIds.includes(requested)) {
    throw httpError(
      `内容运行 ${run.id} 不属于教材 ${requested}`,
      404,
      'run_scope_not_found',
    );
  }
  // Older runs may not have recorded a textbook in scope_json.  In that case
  // establish ownership from the immutable rows themselves instead of
  // silently accepting an arbitrary textbook filter.
  const tables = tableNames(db);
  if (scopedIds.length === 0) {
    const owned = (table) => tables.has(table) && Number(db.prepare(`
      SELECT COUNT(*) AS n FROM "${table}"
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
    `).get(run.id, PROVIDER, requested).n || 0) > 0;
    if (!owned('sync_run_catalog_items') && !owned('sync_run_question_items')) {
      throw httpError(
        `内容运行 ${run.id} 不属于教材 ${requested}`,
        404,
        'run_scope_not_found',
      );
    }
  }
}

function assertRunCatalog(db, run, catalogExternalId, textbookExternalId = null) {
  if (!catalogExternalId) return;
  const predicates = ['run_id = ?', 'provider = ?', 'catalog_external_id = ?'];
  const parameters = [run.id, PROVIDER, String(catalogExternalId)];
  if (textbookExternalId) {
    predicates.push('textbook_external_id = ?');
    parameters.push(String(textbookExternalId));
  }
  const catalogCount = Number(db.prepare(`
    SELECT COUNT(*) AS n FROM sync_run_catalog_items WHERE ${predicates.join(' AND ')}
  `).get(...parameters).n || 0);
  if (catalogCount > 0) return;
  // A partially migrated database may have relation rows but no catalog item;
  // those rows still provide sufficient run ownership evidence.
  const linkPredicates = ['run_id = ?', 'provider = ?', 'catalog_external_id = ?'];
  const linkParameters = [run.id, PROVIDER, String(catalogExternalId)];
  if (textbookExternalId) {
    linkPredicates.push('textbook_external_id = ?');
    linkParameters.push(String(textbookExternalId));
  }
  const linkCount = Number(db.prepare(`
    SELECT COUNT(*) AS n FROM sync_run_question_catalogs WHERE ${linkPredicates.join(' AND ')}
  `).get(...linkParameters).n || 0);
  if (linkCount === 0) {
    throw httpError(
      `内容运行 ${run.id} 中不存在目录 ${catalogExternalId}`,
      404,
      'catalog_not_found',
    );
  }
}


module.exports = {
  PROVIDER,
  MAX_CANDIDATE_ROWS,
  MAX_SELECTED_TEXTBOOKS,
  DEFAULT_RUN_PAGE_SIZE,
  MAX_RUN_PAGE_SIZE,
  DEFAULT_CATALOG_PAGE_SIZE,
  MAX_CATALOG_PAGE_SIZE,
  MAX_RUN_PAGE_NUMBER,
  MAX_RUN_OFFSET,
  MAX_RUN_TEXT_LENGTH,
  MAX_RUN_RAW_JSON_LENGTH,
  MAX_RUN_ERRORS,
  MAX_LIVE_TREE_NODES,
  MAX_RUN_SNAPSHOT_ROWS,
  MAX_SNAPSHOT_PAGE_BYTES,
  MAX_SNAPSHOT_PAGE_SIZE,
  MAX_SNAPSHOT_FETCH_BATCH_SIZE,
  MAX_ASSET_BYTES,
  ASSET_SHA256,
  STRICT_SNAPSHOT_RUN_COLUMNS,
  SNAPSHOT_COLLECTIONS,
  SAFE_EXTERNAL_ID,
  ENTITIES,
  safeExternalId,
  httpError,
  snapshotLockPresent,
  boundedText,
  positiveInt,
  nonNegativeInt,
  requiredRunId,
  optionalExternalId,
  parseJsonObject,
  boundedString,
  pageBounds,
  boundedScope,
  scopeTextbookIds,
  escapeLike,
  openReadOnly,
  tableNames,
  tableColumns,
  optionalSelect,
  resolveContentRun,
  assertSnapshotTables,
  assertApplyableSnapshotRun,
  snapshotScopeIds,
  resolveSnapshotTextbook,
  assertRunTextbook,
  assertRunCatalog,
};
