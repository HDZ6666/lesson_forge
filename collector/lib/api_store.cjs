'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const { buildCatalogProgressTree } = require('../zujuan_sync.cjs');

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
  return new DatabaseSync(resolved, { readOnly: true });
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
  for (const table of [
    'sync_run_catalog_items',
    'sync_run_question_items',
    'sync_run_question_catalogs',
    'sync_run_question_tags',
    'sync_run_question_assets',
  ]) {
    for (const row of db.prepare(`
      SELECT DISTINCT textbook_external_id FROM "${table}"
      WHERE run_id = ? AND provider = ?
    `).all(run.id, PROVIDER)) {
      if (row.textbook_external_id != null) scopeIds.add(String(row.textbook_external_id));
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

function readRunCatalogs(dbPath, runId, options = {}) {
  const textbookExternalId = optionalExternalId(
    options.textbookExternalId,
    'textbookExternalId',
  );
  const page = positiveInt(options.page, 'page', 1, MAX_RUN_PAGE_NUMBER);
  const pageSize = positiveInt(
    options.pageSize,
    'pageSize',
    DEFAULT_CATALOG_PAGE_SIZE,
    MAX_CATALOG_PAGE_SIZE,
  );
  const db = openReadOnly(dbPath);
  if (!db) throw httpError('collector SQLite 不存在', 503, 'snapshot_unavailable');
  try {
    const run = resolveContentRun(db, runId);
    assertSnapshotTables(db);
    assertRunTextbook(db, run, textbookExternalId);
    const itemColumns = tableColumns(db, 'sync_run_catalog_items');
    const predicates = ['item.run_id = ?', 'item.provider = ?'];
    const parameters = [run.id, PROVIDER];
    if (textbookExternalId) {
      predicates.push('item.textbook_external_id = ?');
      parameters.push(textbookExternalId);
    }
    const where = predicates.join(' AND ');
    const total = Number(db.prepare(`
      SELECT COUNT(*) AS total FROM sync_run_catalog_items AS item WHERE ${where}
    `).get(...parameters).total || 0);
    const offset = pageBounds(page, pageSize);
    const rows = db.prepare(`
      SELECT item.textbook_external_id, item.catalog_external_id,
             ${optionalSelect(itemColumns, 'item', 'parent_external_id')},
             ${optionalSelect(itemColumns, 'item', 'node_level')},
             ${optionalSelect(itemColumns, 'item', 'node_type')},
             item.name,
             ${optionalSelect(itemColumns, 'item', 'source_path')},
             ${optionalSelect(itemColumns, 'item', 'catalog_path')},
             ${optionalSelect(itemColumns, 'item', 'sort_order')},
             ${optionalSelect(itemColumns, 'item', 'captured_at')},
             (
               SELECT COUNT(DISTINCT link.question_external_id)
               FROM sync_run_question_catalogs AS link
               WHERE link.run_id = item.run_id
                 AND link.provider = item.provider
                 AND link.textbook_external_id = item.textbook_external_id
                 AND link.catalog_external_id = item.catalog_external_id
             ) AS question_count
      FROM sync_run_catalog_items AS item
      WHERE ${where}
      ORDER BY item.textbook_external_id ASC,
               ${itemColumns.has('sort_order') ? 'COALESCE(item.sort_order, 2147483647)' : 'CAST(2147483647 AS INTEGER)'} ASC,
               ${itemColumns.has('node_level') ? 'COALESCE(item.node_level, 2147483647)' : 'CAST(2147483647 AS INTEGER)'} ASC,
               item.catalog_external_id ASC
      LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, offset).map((row) => ({
      sourceProvider: PROVIDER,
      externalTextbookId: String(row.textbook_external_id),
      externalCatalogId: String(row.catalog_external_id),
      parentExternalId: row.parent_external_id == null ? null : String(row.parent_external_id),
      nodeLevel: row.node_level == null ? null : Number(row.node_level),
      nodeType: row.node_type || null,
      name: boundedString(row.name, 4000) || '',
      sourcePath: boundedString(row.source_path, 4000),
      catalogPath: boundedString(row.catalog_path || row.name, 8000),
      sortOrder: row.sort_order == null ? null : Number(row.sort_order),
      questionCount: Number(row.question_count || 0),
      capturedAt: row.captured_at,
    }));
    return {
      available: true,
      message: 'collector 运行目录快照可用',
      run,
      total,
      page,
      pageSize,
      rows,
    };
  } finally {
    db.close();
  }
}

function readRunQuestions(dbPath, runId, options = {}) {
  const textbookExternalId = optionalExternalId(
    options.textbookExternalId,
    'textbookExternalId',
  );
  const catalogExternalId = optionalExternalId(
    options.catalogExternalId,
    'catalogExternalId',
  );
  const questionType = boundedText(options.questionType, 'questionType', 80);
  const keyword = boundedText(options.keyword, 'keyword', 120);
  const page = positiveInt(options.page, 'page', 1, MAX_RUN_PAGE_NUMBER);
  const pageSize = positiveInt(
    options.pageSize,
    'pageSize',
    DEFAULT_RUN_PAGE_SIZE,
    MAX_RUN_PAGE_SIZE,
  );
  const db = openReadOnly(dbPath);
  if (!db) throw httpError('collector SQLite 不存在', 503, 'snapshot_unavailable');
  try {
    const run = resolveContentRun(db, runId);
    assertSnapshotTables(db);
    assertRunTextbook(db, run, textbookExternalId);
    assertRunCatalog(db, run, catalogExternalId, textbookExternalId);
    const itemColumns = tableColumns(db, 'sync_run_question_items');
    const predicates = ['item.run_id = ?', 'item.provider = ?'];
    const parameters = [run.id, PROVIDER];
    if (textbookExternalId) {
      predicates.push('item.textbook_external_id = ?');
      parameters.push(textbookExternalId);
    }
    if (catalogExternalId) {
      predicates.push(`EXISTS (
        SELECT 1 FROM sync_run_question_catalogs AS link
        WHERE link.run_id = item.run_id
          AND link.provider = item.provider
          AND link.textbook_external_id = item.textbook_external_id
          AND link.question_external_id = item.question_external_id
          AND link.catalog_external_id = ?
      )`);
      parameters.push(catalogExternalId);
    }
    if (questionType) {
      if (itemColumns.has('question_type_id')) {
        predicates.push('(item.question_type = ? OR item.question_type_id = ?)');
        parameters.push(questionType, questionType);
      } else {
        predicates.push('item.question_type = ?');
        parameters.push(questionType);
      }
    }
    if (keyword) {
      const like = `%${escapeLike(keyword)}%`;
      const keywordPredicates = [
        'item.question_external_id LIKE ? ESCAPE \'\\\'',
        'COALESCE(item.plain_text, \'\') LIKE ? ESCAPE \'\\\'',
        'COALESCE(item.content_html, \'\') LIKE ? ESCAPE \'\\\'',
      ];
      const keywordParameters = [like, like, like];
      if (itemColumns.has('source_title')) {
        keywordPredicates.splice(2, 0, 'COALESCE(item.source_title, \'\') LIKE ? ESCAPE \'\\\'');
        keywordParameters.splice(2, 0, like);
      }
      predicates.push(`(${keywordPredicates.join('\n        OR ')})`);
      parameters.push(...keywordParameters);
    }
    const where = predicates.join(' AND ');
    const total = Number(db.prepare(`
      SELECT COUNT(*) AS total FROM sync_run_question_items AS item WHERE ${where}
    `).get(...parameters).total || 0);
    const offset = pageBounds(page, pageSize);
    const rows = db.prepare(`
      SELECT item.textbook_external_id, item.question_external_id,
             ${optionalSelect(itemColumns, 'item', 'chapter_id')},
             ${optionalSelect(itemColumns, 'item', 'detail_url')},
             ${optionalSelect(itemColumns, 'item', 'source_short')},
             ${optionalSelect(itemColumns, 'item', 'source_title')},
             ${optionalSelect(itemColumns, 'item', 'source_url')},
             item.question_type,
             ${optionalSelect(itemColumns, 'item', 'question_type_id')},
             ${optionalSelect(itemColumns, 'item', 'difficulty_label')},
             ${optionalSelect(itemColumns, 'item', 'difficulty_code')},
             ${optionalSelect(itemColumns, 'item', 'ease_coefficient')},
             ${optionalSelect(itemColumns, 'item', 'content_hash')},
             ${optionalSelect(itemColumns, 'item', 'list_content_hash')},
             ${optionalSelect(itemColumns, 'item', 'detail_content_hash')},
             ${optionalSelect(itemColumns, 'item', 'content_version')},
             ${optionalSelect(itemColumns, 'item', 'question_version')},
             ${optionalSelect(itemColumns, 'item', 'snapshot_version')},
             ${optionalSelect(itemColumns, 'item', 'detail_fetched')},
             ${optionalSelect(itemColumns, 'item', 'subquestion_count')},
             ${optionalSelect(itemColumns, 'item', 'child_count')},
             ${optionalSelect(itemColumns, 'item', 'has_image')},
             ${optionalSelect(itemColumns, 'item', 'has_formula')},
             ${optionalSelect(itemColumns, 'item', 'has_table')},
             ${optionalSelect(itemColumns, 'item', 'is_new')},
             ${optionalSelect(itemColumns, 'item', 'use_count')},
             ${optionalSelect(itemColumns, 'item', 'provider_updated_at')},
             substr(item.plain_text, 1, 500) AS plain_text,
             substr(item.content_html, 1, 4000) AS content_html,
             ${optionalSelect(itemColumns, 'item', 'answer_html')},
             ${optionalSelect(itemColumns, 'item', 'analysis_html')},
             ${optionalSelect(itemColumns, 'item', 'answer_status')},
             ${optionalSelect(itemColumns, 'item', 'solution_html')},
             ${optionalSelect(itemColumns, 'item', 'captured_at')},
             (
               SELECT COUNT(*) FROM sync_run_question_catalogs AS link
               WHERE link.run_id = item.run_id
                 AND link.provider = item.provider
                 AND link.textbook_external_id = item.textbook_external_id
                 AND link.question_external_id = item.question_external_id
             ) AS catalog_count
      FROM sync_run_question_items AS item
      WHERE ${where}
      ORDER BY item.question_external_id ASC
      LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, offset).map((row) => ({
      sourceProvider: PROVIDER,
      externalTextbookId: String(row.textbook_external_id),
      externalQuestionId: String(row.question_external_id),
      chapterId: row.chapter_id == null ? null : String(row.chapter_id),
      detailUrl: boundedString(row.detail_url, 4000),
      sourceShort: boundedString(row.source_short, 1000),
      sourceTitle: boundedString(row.source_title, 4000),
      sourceUrl: boundedString(row.source_url, 4000),
      questionType: boundedString(row.question_type, 200),
      questionTypeId: boundedString(row.question_type_id, 200),
      difficultyLabel: boundedString(row.difficulty_label, 200),
      difficultyCode: boundedString(row.difficulty_code, 200),
      easeCoefficient: row.ease_coefficient == null ? null : Number(row.ease_coefficient),
      contentHtml: boundedString(row.content_html, 4000),
      plainText: boundedString(row.plain_text, 1000) || '',
      answerHtml: boundedString(row.answer_html, 4000),
      analysisHtml: boundedString(row.analysis_html, 4000),
      answerStatus: boundedString(row.answer_status, 80) || 'not_collected',
      solutionHtml: boundedString(row.solution_html, 4000),
      contentHash: boundedString(row.content_hash, 200),
      listContentHash: boundedString(row.list_content_hash, 200),
      detailContentHash: boundedString(row.detail_content_hash, 200),
      contentVersion: boundedString(row.content_version, 200),
      questionVersion: Number(row.question_version || 1),
      snapshotVersion: Number(row.snapshot_version || 1),
      detailFetched: Boolean(row.detail_fetched),
      subquestionCount: Number(row.subquestion_count || 0),
      childCount: row.child_count == null ? null : Number(row.child_count),
      hasImage: Boolean(row.has_image),
      hasFormula: Boolean(row.has_formula),
      hasTable: Boolean(row.has_table),
      isNew: Boolean(row.is_new),
      useCount: row.use_count == null ? null : Number(row.use_count),
      providerUpdatedAt: row.provider_updated_at || null,
      catalogCount: Number(row.catalog_count || 0),
      capturedAt: row.captured_at,
    }));
    return {
      available: true,
      message: 'collector 运行题目快照可用',
      run,
      total,
      page,
      pageSize,
      rows,
    };
  } finally {
    db.close();
  }
}

function mapRunQuestionRow(row, { detail = false } = {}) {
  const item = {
    sourceProvider: PROVIDER,
    externalTextbookId: String(row.textbook_external_id),
    externalQuestionId: String(row.question_external_id),
    chapterId: row.chapter_id == null ? null : String(row.chapter_id),
    detailUrl: boundedString(row.detail_url, 4000),
    sourceShort: boundedString(row.source_short, 1000),
    sourceTitle: boundedString(row.source_title, 4000),
    sourceUrl: boundedString(row.source_url, 4000),
    questionType: boundedString(row.question_type, 200),
    questionTypeId: boundedString(row.question_type_id, 200),
    difficultyLabel: boundedString(row.difficulty_label, 200),
    difficultyCode: boundedString(row.difficulty_code, 200),
    easeCoefficient: row.ease_coefficient == null ? null : Number(row.ease_coefficient),
    contentHtml: boundedString(row.content_html, detail ? MAX_RUN_TEXT_LENGTH : 4000),
    plainText: boundedString(row.plain_text, detail ? MAX_RUN_TEXT_LENGTH : 1000) || '',
    // `solutionHtml` is the historical combined answer/analysis block.  New
    // runs may additionally expose independently captured public fields; do
    // not infer either field from the combined compatibility value.
    answerStatus: boundedString(row.answer_status, 80) || 'not_collected',
    solutionHtml: detail ? boundedString(row.solution_html, MAX_RUN_TEXT_LENGTH) : undefined,
    contentHash: boundedString(row.content_hash, 200),
    listContentHash: boundedString(row.list_content_hash, 200),
    detailContentHash: boundedString(row.detail_content_hash, 200),
    contentVersion: boundedString(row.content_version, 200),
    questionVersion: Number(row.question_version || 1),
    snapshotVersion: Number(row.snapshot_version || 1),
    detailFetched: Boolean(row.detail_fetched),
    subquestionCount: Number(row.subquestion_count || 0),
    childCount: row.child_count == null ? null : Number(row.child_count),
    hasImage: Boolean(row.has_image),
    hasFormula: Boolean(row.has_formula),
    hasTable: Boolean(row.has_table),
    isNew: Boolean(row.is_new),
    useCount: row.use_count == null ? null : Number(row.use_count),
    providerUpdatedAt: boundedString(row.provider_updated_at, 4000),
    capturedAt: row.captured_at || null,
  };
  if (detail && (
    row.answer_html != null
    || row.analysis_html != null
    || ['public_captured', 'not_visible', 'login_required'].includes(item.answerStatus)
  )) {
    item.answerHtml = boundedString(row.answer_html, MAX_RUN_TEXT_LENGTH);
    item.analysisHtml = boundedString(row.analysis_html, MAX_RUN_TEXT_LENGTH);
  }
  if (detail) item.rawData = parseJsonObject(row.raw_json);
  if (!detail) {
    item.catalogCount = Number(row.catalog_count || 0);
    delete item.solutionHtml;
  }
  return item;
}

function readRunQuestion(dbPath, runId, externalId, options = {}) {
  if (typeof options === 'string') options = { textbookExternalId: options };
  const questionExternalId = optionalExternalId(externalId, 'externalId');
  if (!questionExternalId) throw httpError('externalId 不能为空');
  const textbookExternalId = optionalExternalId(
    options?.textbookExternalId,
    'textbookExternalId',
  );
  const db = openReadOnly(dbPath);
  if (!db) throw httpError('collector SQLite 不存在', 503, 'snapshot_unavailable');
  try {
    const run = resolveContentRun(db, runId);
    assertSnapshotTables(db);
    assertRunTextbook(db, run, textbookExternalId);
    const predicates = [
      'run_id = ?',
      'provider = ?',
      'question_external_id = ?',
    ];
    const parameters = [run.id, PROVIDER, questionExternalId];
    if (textbookExternalId) {
      predicates.push('textbook_external_id = ?');
      parameters.push(textbookExternalId);
    }
    const rows = db.prepare(`
      SELECT * FROM sync_run_question_items
      WHERE ${predicates.join(' AND ')}
      ORDER BY textbook_external_id ASC LIMIT 2
    `).all(...parameters);
    if (!rows.length) {
      throw httpError(
        `内容运行 ${run.id} 中不存在题目 ${questionExternalId}`,
        404,
        'question_not_found',
      );
    }
    if (rows.length > 1) {
      throw httpError('题目来源 ID 在该运行中不唯一', 409, 'question_ambiguous');
    }
    const row = rows[0];
    const catalogColumns = tableColumns(db, 'sync_run_question_catalogs');
    const catalogs = db.prepare(`
      SELECT textbook_external_id, catalog_external_id,
             ${optionalSelect(catalogColumns, '', 'catalog_level')},
             ${optionalSelect(catalogColumns, '', 'catalog_name')},
             ${optionalSelect(catalogColumns, '', 'catalog_path')},
             ${optionalSelect(catalogColumns, '', 'evidence_type')}
      FROM sync_run_question_catalogs
      WHERE run_id = ? AND provider = ?
        AND textbook_external_id = ? AND question_external_id = ?
      ORDER BY ${catalogColumns.has('catalog_level') ? 'COALESCE(catalog_level, 2147483647)' : 'CAST(2147483647 AS INTEGER)'}, catalog_external_id
    `).all(run.id, PROVIDER, row.textbook_external_id, questionExternalId).map((item) => ({
      externalTextbookId: String(item.textbook_external_id),
      externalCatalogId: String(item.catalog_external_id),
      catalogLevel: item.catalog_level == null ? null : Number(item.catalog_level),
      catalogName: boundedString(item.catalog_name, 4000),
      catalogPath: boundedString(item.catalog_path, 8000),
      evidenceType: boundedString(item.evidence_type, 200),
    }));
    const item = mapRunQuestionRow(row, { detail: true });
    item.catalogs = catalogs;
    return {
      available: true,
      message: 'collector 运行题目详情快照可用',
      run,
      item,
      // `question` is a friendly alias used by older consumers; `item` is
      // the canonical field for the run snapshot API.
      question: item,
    };
  } finally {
    db.close();
  }
}

function snapshotValue(value, maxLength = MAX_RUN_TEXT_LENGTH) {
  if (value == null) return value;
  if (typeof value === 'string') return boundedString(value, maxLength);
  return value;
}

function snapshotRowObject(row, table) {
  const output = {};
  for (const [key, value] of Object.entries(row || {})) {
    const limit = [
      'content_html', 'plain_text', 'answer_html', 'analysis_html', 'solution_html',
    ].includes(key)
      ? MAX_RUN_TEXT_LENGTH
      : (key === 'raw_json' ? MAX_RUN_RAW_JSON_LENGTH : 10000);
    output[key] = snapshotValue(value, limit);
  }
  if (table === 'sync_run_catalog_items') {
    output.externalTextbookId = String(output.textbook_external_id || '');
    output.externalCatalogId = String(output.catalog_external_id || '');
    output.parentExternalId = output.parent_external_id == null ? null : String(output.parent_external_id);
    output.nodeLevel = output.node_level == null ? null : Number(output.node_level);
    output.nodeType = output.node_type || null;
    output.name = boundedString(output.name, 4000) || '';
    output.sourcePath = boundedString(output.source_path, 4000);
    output.catalogPath = boundedString(output.catalog_path, 8000);
  } else if (table === 'sync_run_question_items') {
    output.externalTextbookId = String(output.textbook_external_id || '');
    output.externalQuestionId = String(output.question_external_id || '');
    output.detailFetched = Boolean(output.detail_fetched);
    output.questionType = output.question_type || null;
    output.contentHtml = output.content_html == null ? null : output.content_html;
    output.plainText = output.plain_text == null ? '' : output.plain_text;
    output.answerHtml = output.answer_html == null ? null : output.answer_html;
    output.analysisHtml = output.analysis_html == null ? null : output.analysis_html;
    output.answerStatus = output.answer_status || 'not_collected';
    output.contentHash = output.content_hash || null;
    output.detailContentHash = output.detail_content_hash || null;
  } else if (table === 'sync_run_question_catalogs') {
    output.externalTextbookId = String(output.textbook_external_id || '');
    output.externalQuestionId = String(output.question_external_id || '');
    output.externalCatalogId = String(output.catalog_external_id || '');
  } else if (table === 'sync_run_question_tags') {
    output.externalTextbookId = String(output.textbook_external_id || '');
    output.externalQuestionId = String(output.question_external_id || '');
    output.tagExternalId = output.tag_external_id == null ? '' : String(output.tag_external_id);
    output.tagValue = output.tag_value == null ? '' : String(output.tag_value);
  } else if (table === 'sync_run_question_assets') {
    output.externalTextbookId = String(output.textbook_external_id || '');
    output.externalQuestionId = String(output.question_external_id || '');
    output.assetKey = output.asset_key == null ? '' : String(output.asset_key);
    output.assetType = output.asset_type || null;
    output.sourceUrl = output.source_url || null;
    output.contentSha256 = output.content_sha256 || null;
    output.storagePath = output.storage_path || null;
    if (output.storage_path && isAbsoluteStoragePath(String(output.storage_path))) {
      const normalized = String(output.storage_path).replace(/\\/g, '/');
      const marker = normalized.lastIndexOf('/assets/');
      output.storagePath = marker >= 0 ? normalized.slice(marker + 1) : null;
      // Keep the canonical snake-case field safe as well; consumers that use
      // the snake form should not accidentally receive a host-specific path.
      output.storage_path = output.storagePath;
    } else if (output.storage_path && String(output.storage_path).replace(/\\/g, '/').split('/').includes('..')) {
      // A traversal value is not a host path, but publishing it would invite
      // consumers to resolve it unsafely.  Keep the row visible while hiding
      // the unusable storage reference; the byte endpoint performs the
      // authoritative integrity/path rejection.
      output.storagePath = null;
      output.storage_path = null;
    }
  }
  return output;
}

function snapshotPageCountObject(counts) {
  const output = {
    catalogItemCount: Number(counts.catalogItemCount || 0),
    questionItemCount: Number(counts.questionItemCount || 0),
    questionCatalogCount: Number(counts.questionCatalogCount || 0),
    questionTagCount: Number(counts.questionTagCount || 0),
    questionAssetCount: Number(counts.questionAssetCount || 0),
  };
  Object.assign(output, {
    catalogCount: output.catalogItemCount,
    questionCount: output.questionItemCount,
    tagCount: output.questionTagCount,
    assetCount: output.questionAssetCount,
  });
  return output;
}

function snapshotPageSuffixBytes(suffix, nextCursor) {
  const marker = '"nextCursor":null';
  const markerIndex = suffix.indexOf(marker);
  if (markerIndex < 0) return null;
  const replacement = `"nextCursor":${JSON.stringify(nextCursor)}`;
  return Buffer.byteLength(
    `${suffix.slice(0, markerIndex)}${replacement}${suffix.slice(markerIndex + marker.length)}`,
  );
}

function snapshotOrderBy(db, collection, definition) {
  const columns = tableColumns(db, definition.table);
  const column = (name, fallback = "''") => columns.has(name) ? name : fallback;
  const nullableNumber = (name) => columns.has(name)
    ? `COALESCE(${name}, 2147483647)`
    : '2147483647';
  if (collection === 'catalogs') {
    return `
      textbook_external_id ASC,
      ${nullableNumber('sort_order')} ASC,
      ${nullableNumber('node_level')} ASC,
      catalog_external_id ASC
    `;
  }
  if (collection === 'questions') {
    return 'textbook_external_id ASC, question_external_id ASC';
  }
  if (collection === 'questionCatalogs') {
    return `
      textbook_external_id ASC,
      question_external_id ASC,
      ${nullableNumber('catalog_level')} ASC,
      catalog_external_id ASC
    `;
  }
  if (collection === 'tags') {
    return [
      'textbook_external_id ASC',
      'question_external_id ASC',
      `${column('dimension')} ASC`,
      `${column('tag_external_id')} ASC`,
      `${column('tag_value')} ASC`,
      `${column('relation_type')} ASC`,
      `${column('evidence_type')} ASC`,
      `${column('query_fingerprint')} ASC`,
    ].join(', ');
  }
  return [
    'textbook_external_id ASC',
    'question_external_id ASC',
    `${column('asset_key')} ASC`,
    `${column('content_sha256')} ASC`,
    `${column('storage_path')} ASC`,
  ].join(', ');
}

/**
 * Read one bounded page of a sealed run snapshot.
 *
 * The page owns one read-only connection for its run header, scope, five
 * scoped counts, and bounded row reads.  The service obtains the complete
 * snapshot summary once before consuming pages; repeating its orphan scans
 * for every page would turn a large run into an N-times full-table audit.
 * Sealed snapshot triggers make the page rows immutable after the strict
 * header check.  If the byte budget stops the batch early, the unread tail is
 * deliberately left for the next request, whose offset advances only by the
 * rows actually returned.
 */
function readRunSnapshotPage(dbPath, runId, options = {}) {
  const collection = options && typeof options === 'object' ? options.collection : null;
  if (typeof collection !== 'string' || !Object.hasOwn(SNAPSHOT_COLLECTIONS, collection)) {
    throw httpError(
      'collection 必须是 catalogs、questions、questionCatalogs、tags 或 assets',
    );
  }
  const requestedTextbookId = optionalExternalId(
    options?.textbookExternalId,
    'textbookExternalId',
  );
  const cursor = nonNegativeInt(options?.cursor, 'cursor', 0, MAX_RUN_OFFSET);
  let pageSize;
  if (options?.pageSize == null || options.pageSize === '') {
    pageSize = 500;
  } else {
    pageSize = positiveInt(
      options.pageSize,
      'pageSize',
      500,
      MAX_SNAPSHOT_PAGE_SIZE,
    );
    if (typeof options.pageSize === 'boolean') {
      throw httpError(`pageSize 必须是 1 到 ${MAX_SNAPSHOT_PAGE_SIZE} 之间的整数`);
    }
  }
  const definition = SNAPSHOT_COLLECTIONS[collection];

  const db = openReadOnly(dbPath);
  if (!db) throw httpError('collector SQLite 不存在', 503, 'snapshot_unavailable');
  try {
    const run = resolveContentRun(db, runId);
    assertSnapshotTables(db, { all: true });
    assertApplyableSnapshotRun(db, run);
    const { textbookExternalId } = resolveSnapshotTextbook(db, run, requestedTextbookId);

    const scopedCounts = {};
    for (const item of Object.values(SNAPSHOT_COLLECTIONS)) {
      const row = db.prepare(`
        SELECT COUNT(*) AS value
        FROM "${item.table}"
        WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
      `).get(run.id, PROVIDER, textbookExternalId);
      scopedCounts[item.count] = Number(row?.value || 0);
    }
    for (const [name, value] of Object.entries(scopedCounts)) {
      if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RUN_OFFSET) {
        throw httpError(`运行快照 ${name} 计数超出安全范围`, 413, 'snapshot_too_large');
      }
    }
    const expectedTotal = scopedCounts[definition.count];
    if (cursor > expectedTotal) throw httpError('cursor 超出当前集合范围');

    const pageRun = {
      ...run,
      id: run.id,
      runId: run.id,
      collectorRunId: run.id,
      provider: PROVIDER,
      textbookExternalId,
      textbookExternalIds: [textbookExternalId],
      snapshotLockedAt: run.snapshotLockedAt,
      snapshot_locked_at: run.snapshotLockedAt,
      snapshotComplete: run.snapshotComplete,
      snapshot_complete: run.snapshotComplete ? 1 : 0,
    };
    const counts = snapshotPageCountObject(scopedCounts);
    // Keep `items` in the template as null so the fixed envelope can be
    // measured by replacing only the array portion.  This avoids repeatedly
    // serialising the accumulated page while still measuring exact UTF-8
    // JSON bytes for every candidate row.
    const template = {
      available: true,
      immutable: snapshotLockPresent(run.snapshotLockedAt),
      snapshotComplete: run.snapshotComplete,
      run: pageRun,
      counts,
      collection,
      cursor,
      items: null,
      total: expectedTotal,
      nextCursor: null,
    };
    const templateJson = JSON.stringify(template);
    const itemsMarker = '"items":null';
    const itemsIndex = templateJson.indexOf(itemsMarker);
    if (itemsIndex < 0) {
      throw httpError('响应模板无法序列化', 500, 'serialization_error');
    }
    const prefix = templateJson.slice(0, itemsIndex + '"items":'.length);
    const suffix = templateJson.slice(itemsIndex + itemsMarker.length);
    const suffixNullBytes = snapshotPageSuffixBytes(suffix, null);
    if (suffixNullBytes == null) {
      throw httpError('响应模板无法序列化', 500, 'serialization_error');
    }
    const prefixBytes = Buffer.byteLength(prefix);
    const items = [];
    let itemBytes = 0;
    const statement = db.prepare(`
      SELECT * FROM "${definition.table}"
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
      ORDER BY ${snapshotOrderBy(db, collection, definition)}
      LIMIT ? OFFSET ?
    `);

    // Fetch fixed-size batches rather than materialising a caller-sized page
    // (which may be 5000 rows) or issuing one OFFSET query per row.  A batch
    // may be only partly returned when the byte budget is reached; the unread
    // tail is deliberately left for the next request because nextCursor uses
    // only the number of items actually appended to the response.
    const remaining = Math.min(pageSize, expectedTotal - cursor);
    let rowsRead = 0;
    let budgetReached = false;
    while (rowsRead < remaining) {
      const fetchCount = Math.min(
        MAX_SNAPSHOT_FETCH_BATCH_SIZE,
        remaining - rowsRead,
      );
      // Keep each fetchedRows array scoped to one iteration.  Once this
      // block ends, only the bounded result items remain reachable.
      const fetchedRows = statement.all(
        run.id,
        PROVIDER,
        textbookExternalId,
        fetchCount,
        cursor + rowsRead,
      );
      if (fetchedRows.length !== fetchCount) {
        throw httpError('运行快照分页行数与计数不一致', 409, 'snapshot_incomplete');
      }
      rowsRead += fetchedRows.length;

      for (const row of fetchedRows) {
        const item = snapshotRowObject(row, definition.table);
        const encodedItem = JSON.stringify(item);
        if (encodedItem == null) {
          throw httpError('运行快照行无法序列化', 409, 'snapshot_incomplete');
        }
        const encodedItemBytes = Buffer.byteLength(encodedItem);
        const itemCount = items.length + 1;
        const nextCursor = cursor + itemCount < expectedTotal
          ? cursor + itemCount
          : null;
        const suffixBytes = snapshotPageSuffixBytes(suffix, nextCursor);
        const candidateBytes = prefixBytes
          + 1 // opening `[`
          + itemBytes
          + (items.length ? items.length : 0) // commas between items
          + encodedItemBytes
          + 1 // closing `]`
          + suffixBytes;
        if (candidateBytes > MAX_SNAPSHOT_PAGE_BYTES) {
          if (!items.length) {
            // Snapshot row text is bounded by snapshotRowObject.  A defensive
            // hard check still prevents sendJson from ever turning an
            // unexpectedly huge single row into a second 413 response.
            throw httpError(
              '运行快照单行超过安全响应上限',
              413,
              'snapshot_row_too_large',
            );
          }
          budgetReached = true;
          break;
        }
        items.push(item);
        itemBytes += encodedItemBytes;
      }
      if (budgetReached) break;
    }

    const nextCursor = cursor + items.length < expectedTotal
      ? cursor + items.length
      : null;
    const output = {
      available: true,
      immutable: snapshotLockPresent(run.snapshotLockedAt),
      snapshotComplete: run.snapshotComplete,
      run: pageRun,
      counts,
      collection,
      cursor,
      items,
      total: expectedTotal,
      nextCursor,
    };
    const actualBytes = Buffer.byteLength(JSON.stringify(output));
    if (actualBytes > MAX_SNAPSHOT_PAGE_BYTES) {
      throw httpError('运行快照页超过安全响应上限', 413, 'snapshot_too_large');
    }
    return output;
  } finally {
    db.close();
  }
}

function isAbsoluteStoragePath(value) {
  const text = String(value || '');
  return path.isAbsolute(text)
    || path.posix.isAbsolute(text)
    || path.win32.isAbsolute(text)
    // Reject drive-relative spellings (`C:foo`) too; they are not absolute
    // on Windows but can escape the intended drive when resolved there.
    || /^[A-Za-z]:/.test(text)
    || /^\\\\/.test(text);
}

function resolveAssetFile(dataDir, storagePath) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw httpError('collector 素材目录未配置', 503, 'asset_unavailable');
  }
  if (typeof storagePath !== 'string' || !storagePath.trim()
    || /[\u0000-\u001f\u007f]/.test(storagePath)
    || isAbsoluteStoragePath(storagePath)) {
    throw httpError('素材存储路径不安全', 404, 'asset_not_found');
  }
  // Collector paths are persisted as POSIX-style relative paths.  Treat a
  // backslash as a separator too, otherwise a Windows traversal can become
  // a harmless-looking filename when served on Linux (and vice versa).
  const normalizedStoragePath = storagePath.replace(/\\/g, '/');
  const parts = normalizedStoragePath.split('/');
  if (parts.some((part) => part === '..')) {
    throw httpError('素材存储路径不安全', 404, 'asset_not_found');
  }
  const root = path.resolve(dataDir);
  const candidate = path.resolve(root, normalizedStoragePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw httpError('素材存储路径不安全', 404, 'asset_not_found');
  }
  let rootReal;
  let candidateReal;
  let stat;
  try {
    rootReal = fs.realpathSync.native(root);
    candidateReal = fs.realpathSync.native(candidate);
    stat = fs.statSync(candidateReal);
    const realRelative = path.relative(rootReal, candidateReal);
    if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(realRelative) || !stat.isFile()) {
      throw new Error('asset path outside root');
    }
  } catch (error) {
    if (error?.statusCode) throw error;
    throw httpError('素材文件不存在或不可用', 404, 'asset_not_found');
  }
  return { path: candidateReal, stat };
}

function sha256File(filePath, { keepOpen = false } = {}) {
  let descriptor;
  let retained = false;
  const hash = createHash('sha256');
  let total = 0;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!read) break;
      total += read;
      if (total > MAX_ASSET_BYTES) {
        throw httpError('素材文件超过安全大小上限', 413, 'asset_too_large');
      }
      hash.update(buffer.subarray(0, read));
    }
    const result = { digest: hash.digest('hex'), bytes: total };
    if (keepOpen) {
      result.descriptor = descriptor;
      retained = true;
    }
    return result;
  } finally {
    if (!retained) {
      try { if (descriptor != null) fs.closeSync(descriptor); } catch {}
    }
  }
}

function safeAssetMimeType(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) {
    return 'application/octet-stream';
  }
  // Keep the value suitable for a Node response header.  Unknown but
  // syntactically harmless media types are still useful to clients.
  if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+*-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+*-]*(?:\s*;\s*[A-Za-z0-9_-]+=[^\r\n;]+)*$/.test(text)) {
    return 'application/octet-stream';
  }
  return text;
}

/**
 * Resolve and integrity-check one immutable run asset without returning the
 * host path in the serialisable result.  The non-enumerable file descriptor
 * is an internal hand-off for server.cjs to stream after this read-only DB
 * scope is closed.  Keeping the descriptor opened during verification also
 * prevents a path replacement between hashing and HTTP streaming.
 */
function readRunAsset(dbPath, runId, contentSha256, options = {}) {
  const suppliedHash = typeof contentSha256 === 'string'
    ? contentSha256.trim()
    : String(contentSha256 ?? '').trim();
  if (!ASSET_SHA256.test(suppliedHash)) {
    throw httpError('contentSha256 必须是 64 位十六进制 SHA-256');
  }
  const digest = suppliedHash.toLowerCase();
  const requestedTextbookId = optionalExternalId(
    options?.textbookExternalId,
    'textbookExternalId',
  );
  const dataDir = options?.dataDir;

  const db = openReadOnly(dbPath);
  if (!db) throw httpError('collector SQLite 不存在', 503, 'snapshot_unavailable');
  try {
    const run = resolveContentRun(db, runId);
    assertSnapshotTables(db, { all: true });
    assertApplyableSnapshotRun(db, run);
    const { textbookExternalId } = resolveSnapshotTextbook(db, run, requestedTextbookId);
    const hashValues = digest === digest.toUpperCase()
      ? [digest]
      : [digest, digest.toUpperCase()];
    const assetIndexes = new Set(db.prepare(
      `PRAGMA index_list("sync_run_question_assets")`,
    ).all().map((index) => String(index.name)));
    // The composite index is installed by ensureRunSnapshotSchema.  Keep the
    // fallback for callers reading a legacy DB directly, while making the
    // production path deterministic even when SQLite's cost estimates prefer
    // the asset identity index because of the ORDER BY clause.
    const assetIndexHint = assetIndexes.has('idx_sync_run_question_assets_scope_hash')
      ? ' INDEXED BY idx_sync_run_question_assets_scope_hash'
      : '';
    const row = db.prepare(`
      SELECT question_external_id, asset_key, asset_type, source_url,
             content_sha256, storage_path, mime_type, byte_size,
             ${tableColumns(db, 'sync_run_question_assets').has('observed_at')
               ? 'observed_at' : 'NULL'} AS observed_at
      FROM sync_run_question_assets${assetIndexHint}
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        AND content_sha256 IN (${hashValues.map(() => '?').join(', ')})
      ORDER BY question_external_id ASC, asset_key ASC, storage_path ASC
      LIMIT 1
    `).get(run.id, PROVIDER, textbookExternalId, ...hashValues);
    if (!row) {
      throw httpError('指定素材不存在', 404, 'asset_not_found');
    }

    const declaredSize = row.byte_size == null || row.byte_size === ''
      ? null : Number(row.byte_size);
    if (declaredSize != null
      && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) {
      throw httpError('素材大小元数据无效', 409, 'asset_unavailable');
    }
    if (declaredSize != null && declaredSize > MAX_ASSET_BYTES) {
      throw httpError('素材文件超过安全大小上限', 413, 'asset_too_large');
    }
    const resolved = resolveAssetFile(dataDir, row.storage_path);
    if (resolved.stat.size > MAX_ASSET_BYTES) {
      throw httpError('素材文件超过安全大小上限', 413, 'asset_too_large');
    }
    const beforeSize = resolved.stat.size;
    let checked;
    let verifiedDescriptor = null;
    try {
      checked = sha256File(resolved.path, { keepOpen: true });
      verifiedDescriptor = checked.descriptor;
      const after = fs.fstatSync(verifiedDescriptor);
      if (after.size !== beforeSize || checked.bytes !== beforeSize) {
        throw httpError('素材文件在读取期间发生变化', 409, 'asset_integrity_error');
      }
      if (checked.digest.toLowerCase() !== digest) {
        throw httpError('素材文件内容摘要不匹配', 409, 'asset_integrity_error');
      }
    } catch (error) {
      try { if (verifiedDescriptor != null) fs.closeSync(verifiedDescriptor); } catch {}
      if (error?.statusCode) throw error;
      throw httpError('素材文件不可用', 404, 'asset_not_found');
    }

    const result = {
      available: true,
      immutable: true,
      run: {
        ...run,
        id: run.id,
        runId: run.id,
        collectorRunId: run.id,
        provider: PROVIDER,
        textbookExternalId,
        textbookExternalIds: [textbookExternalId],
        snapshotComplete: run.snapshotComplete,
        snapshot_complete: run.snapshotComplete ? 1 : 0,
        snapshotLockedAt: run.snapshotLockedAt,
        snapshot_locked_at: run.snapshotLockedAt,
      },
      asset: {
        sourceProvider: PROVIDER,
        externalTextbookId: textbookExternalId,
        externalQuestionId: String(row.question_external_id || ''),
        assetKey: String(row.asset_key || ''),
        assetType: row.asset_type == null ? null : String(row.asset_type),
        sourceUrl: row.source_url == null ? null : boundedString(row.source_url, 10000),
        contentSha256: digest,
        mimeType: safeAssetMimeType(row.mime_type),
        byteSize: beforeSize,
        observedAt: row.observed_at == null ? null : boundedString(row.observed_at, 80),
      },
      contentType: safeAssetMimeType(row.mime_type),
      contentLength: beforeSize,
      etag: `"${digest}"`,
      cacheControl: 'public, max-age=31536000, immutable',
    };
    Object.defineProperty(result, 'filePath', {
      value: resolved.path,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(result, 'fileDescriptor', {
      value: verifiedDescriptor,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return result;
  } finally {
    db.close();
  }
}

/**
 * Read one complete, immutable content-run scope.  Every returned array is
 * selected solely from its run-id/textbook-id rows; no global mutable table is
 * consulted, so later crawls cannot change an already sealed apply payload.
 */
function readRunSnapshot(dbPath, runId, options = {}) {
  const requestedTextbookId = optionalExternalId(
    typeof options === 'string' ? options : options?.textbookExternalId,
    'textbookExternalId',
  );
  const db = openReadOnly(dbPath);
  if (!db) throw httpError('collector SQLite 不存在', 503, 'snapshot_unavailable');
  try {
    const run = resolveContentRun(db, runId);
    assertSnapshotTables(db, { all: true });
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
    const runColumns = tableColumns(db, 'sync_runs');
    const requiredRunColumns = [
      'finished_at', 'scope_json', 'error_count', 'snapshot_locked_at',
      'snapshot_complete', 'catalog_item_count', 'question_item_count',
      'question_catalog_count', 'question_tag_count', 'question_asset_count',
    ];
    const missingRunColumns = requiredRunColumns.filter((column) => !runColumns.has(column));
    if (missingRunColumns.length) {
      throw httpError(
        `collector SQLite sync_runs 字段不完整：${missingRunColumns.join(', ')}`,
        503,
        'snapshot_unavailable',
      );
    }

    let textbookExternalId = requestedTextbookId;
    if (!textbookExternalId) {
      const ids = new Set(run.textbookExternalIds || []);
      for (const table of [
        'sync_run_catalog_items',
        'sync_run_question_items',
        'sync_run_question_catalogs',
        'sync_run_question_tags',
        'sync_run_question_assets',
      ]) {
        for (const row of db.prepare(`
          SELECT DISTINCT textbook_external_id FROM "${table}"
          WHERE run_id = ? AND provider = ?
        `).all(run.id, PROVIDER)) {
          if (row.textbook_external_id != null) ids.add(String(row.textbook_external_id));
        }
      }
      if (ids.size !== 1) {
        throw httpError(
          `内容运行 ${run.id} 包含多个教材范围，必须指定 textbookExternalId`,
          400,
          'textbook_scope_required',
        );
      }
      textbookExternalId = [...ids][0];
    }
    assertRunTextbook(db, run, textbookExternalId);

    const tableNamesForSnapshot = [
      'sync_run_catalog_items',
      'sync_run_question_items',
      'sync_run_question_catalogs',
      'sync_run_question_tags',
      'sync_run_question_assets',
    ];
    const rows = {};
    let totalRows = 0;
    for (const table of tableNamesForSnapshot) {
      const found = db.prepare(`
        SELECT * FROM "${table}"
        WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        LIMIT ?
      `).all(run.id, PROVIDER, textbookExternalId, MAX_RUN_SNAPSHOT_ROWS + 1);
      if (found.length > MAX_RUN_SNAPSHOT_ROWS) {
        throw httpError('运行快照超过安全响应上限，请缩小教材范围', 413, 'snapshot_too_large');
      }
      rows[table] = found.map((row) => snapshotRowObject(row, table));
      totalRows += rows[table].length;
    }
    if (totalRows > MAX_RUN_SNAPSHOT_ROWS * 2) {
      throw httpError('运行快照超过安全响应上限，请缩小教材范围', 413, 'snapshot_too_large');
    }

    const catalogs = rows.sync_run_catalog_items;
    const questions = rows.sync_run_question_items;
    const questionCatalogs = rows.sync_run_question_catalogs;
    const questionIds = new Set(questions.map((row) => String(row.question_external_id || '')));
    const catalogIds = new Set(catalogs.map((row) => String(row.catalog_external_id || '')));
    if (!catalogs.length || !questions.length || !questionCatalogs.length) {
      throw httpError(`内容运行 ${run.id} 的快照缺少必要目录、题目或关系`, 409, 'snapshot_incomplete');
    }
    for (const relation of questionCatalogs) {
      if (!questionIds.has(String(relation.question_external_id || ''))
        || !catalogIds.has(String(relation.catalog_external_id || ''))) {
        throw httpError(`内容运行 ${run.id} 的目录关系包含孤儿行`, 409, 'snapshot_incomplete');
      }
    }
    for (const table of ['sync_run_question_tags', 'sync_run_question_assets']) {
      for (const row of rows[table]) {
        if (!questionIds.has(String(row.question_external_id || ''))) {
          throw httpError(`内容运行 ${run.id} 的 ${table} 包含孤儿行`, 409, 'snapshot_incomplete');
        }
      }
    }

    const counts = {
      catalogItemCount: catalogs.length,
      questionItemCount: questions.length,
      questionCatalogCount: questionCatalogs.length,
      questionTagCount: rows.sync_run_question_tags.length,
      questionAssetCount: rows.sync_run_question_assets.length,
    };
    // A complete snapshot must agree with the declaration sealed in
    // sync_runs.  The response is scoped to one textbook, while a legacy
    // multi-textbook run stores aggregate counters; compare that case with
    // aggregate immutable rows instead of silently replacing the declaration
    // with this response's array lengths.
    const scopeIds = new Set(run.textbookExternalIds || []);
    for (const table of tableNamesForSnapshot) {
      for (const row of db.prepare(`
        SELECT DISTINCT textbook_external_id FROM "${table}"
        WHERE run_id = ? AND provider = ?
      `).all(run.id, PROVIDER)) {
        if (row.textbook_external_id != null) scopeIds.add(String(row.textbook_external_id));
      }
    }
    const wholeRunScope = scopeIds.size <= 1;
    const declaredCounts = {
      catalogItemCount: run.catalogItemCount,
      questionItemCount: run.questionItemCount,
      questionCatalogCount: run.questionCatalogCount,
      questionTagCount: run.questionTagCount,
      questionAssetCount: run.questionAssetCount,
    };
    const aggregateCounts = {};
    if (!wholeRunScope) {
      for (const [table, field] of [
        ['sync_run_catalog_items', 'catalogItemCount'],
        ['sync_run_question_items', 'questionItemCount'],
        ['sync_run_question_catalogs', 'questionCatalogCount'],
        ['sync_run_question_tags', 'questionTagCount'],
        ['sync_run_question_assets', 'questionAssetCount'],
      ]) {
        aggregateCounts[field] = Number(db.prepare(`
          SELECT COUNT(*) AS value FROM "${table}"
          WHERE run_id = ? AND provider = ?
        `).get(run.id, PROVIDER).value || 0);
      }
    }
    for (const field of Object.keys(declaredCounts)) {
      const actual = wholeRunScope ? counts[field] : aggregateCounts[field];
      if (Number(declaredCounts[field]) !== Number(actual)) {
        throw httpError(
          `内容运行 ${run.id} 的 ${field} 计数不一致`,
          409,
          'snapshot_incomplete',
        );
      }
    }
    // Also expose the short names used by older service clients.  The
    // canonical five counters above always equal the actual filtered arrays.
    Object.assign(counts, {
      catalogCount: counts.catalogItemCount,
      questionCount: counts.questionItemCount,
      tagCount: counts.questionTagCount,
      assetCount: counts.questionAssetCount,
    });
    const snapshotRun = {
      ...run,
      textbookExternalId,
      textbookExternalIds: [textbookExternalId],
      snapshotComplete: true,
      snapshot_locked_at: run.snapshotLockedAt,
      snapshot_complete: 1,
      // Preserve the historical snake-case header fields, but keep the
      // values declared by sync_runs.  They have already been checked above
      // against the immutable row counts and must never be replaced with the
      // current scoped array lengths.
      catalog_item_count: run.catalogItemCount,
      question_item_count: run.questionItemCount,
      question_catalog_count: run.questionCatalogCount,
      question_tag_count: run.questionTagCount,
      question_asset_count: run.questionAssetCount,
    };
    return {
      available: true,
      immutable: true,
      run: snapshotRun,
      counts,
      catalogs,
      questions,
      questionCatalogs,
      tags: rows.sync_run_question_tags,
      assets: rows.sync_run_question_assets,
    };
  } finally {
    db.close();
  }
}

/**
 * Read only the header of an immutable run snapshot.  The default is strict
 * because this function backs the applyability/summary contract.  Internal
 * job orchestration may opt into `allowIncomplete` to inspect a failed or
 * still-running child run without making that state applyable.
 */
function readRunSnapshotSummary(dbPath, runId, expectedTextbookExternalId = null, options = {}) {
  let expected = expectedTextbookExternalId;
  let config = options && typeof options === 'object' ? options : {};
  if (expectedTextbookExternalId && typeof expectedTextbookExternalId === 'object') {
    config = expectedTextbookExternalId;
    expected = config.textbookExternalId ?? config.externalTextbookId ?? null;
  }
  const textbookExternalId = optionalExternalId(expected, 'textbookExternalId');
  const allowIncomplete = config.allowIncomplete === true || config.requireComplete === false;
  const db = openReadOnly(dbPath);
  if (!db) {
    if (allowIncomplete) return null;
    throw httpError('collector SQLite 不存在', 503, 'snapshot_unavailable');
  }
  try {
    const run = resolveContentRun(db, runId);
    assertSnapshotTables(db, { all: !allowIncomplete });

    if (!allowIncomplete) {
      assertApplyableSnapshotRun(db, run);
    }

    // Scope is derived from the run declaration plus immutable rows.  A
    // summary with no explicit textbook is only safe when exactly one scope
    // exists; never silently aggregate a multi-textbook run.
    const scopeIds = new Set(run.textbookExternalIds || []);
    for (const table of [
      'sync_run_catalog_items',
      'sync_run_question_items',
      'sync_run_question_catalogs',
      'sync_run_question_tags',
      'sync_run_question_assets',
    ]) {
      for (const row of db.prepare(`
        SELECT DISTINCT textbook_external_id FROM "${table}"
        WHERE run_id = ? AND provider = ?
      `).all(run.id, PROVIDER)) {
        if (row.textbook_external_id != null) scopeIds.add(String(row.textbook_external_id));
      }
    }
    let scopeId = textbookExternalId;
    if (!scopeId) {
      if (scopeIds.size !== 1) {
        throw httpError(
          `内容运行 ${run.id} 包含多个教材范围，必须指定 textbookExternalId`,
          400,
          'textbook_scope_required',
        );
      }
      scopeId = [...scopeIds][0];
    }
    assertRunTextbook(db, run, scopeId);

    const filter = ' AND provider = ? AND textbook_external_id = ?';
    const parameters = [run.id, PROVIDER, scopeId];
    const availableTables = tableNames(db);
    const countFor = (table) => availableTables.has(table)
      ? Number(db.prepare(`
        SELECT COUNT(*) AS value FROM "${table}" WHERE run_id = ?${filter}
      `).get(...parameters).value || 0)
      : 0;
    const counts = {
      catalogItemCount: countFor('sync_run_catalog_items'),
      questionItemCount: countFor('sync_run_question_items'),
      questionCatalogCount: countFor('sync_run_question_catalogs'),
      questionTagCount: countFor('sync_run_question_tags'),
      questionAssetCount: countFor('sync_run_question_assets'),
    };
    Object.assign(counts, {
      catalogCount: counts.catalogItemCount,
      questionCount: counts.questionItemCount,
      tagCount: counts.questionTagCount,
      assetCount: counts.questionAssetCount,
    });

    if (!allowIncomplete) {
      if (!counts.catalogItemCount || !counts.questionItemCount || !counts.questionCatalogCount) {
        throw httpError(`内容运行 ${run.id} 的快照缺少必要目录、题目或关系`, 409, 'snapshot_incomplete');
      }
      const orphanChecks = [
        {
          table: 'sync_run_question_catalogs',
          sql: `SELECT 1 FROM sync_run_question_catalogs AS r
                WHERE r.run_id = ? AND r.provider = ? AND r.textbook_external_id = ?
                  AND (NOT EXISTS (
                    SELECT 1 FROM sync_run_question_items AS q
                    WHERE q.run_id = r.run_id AND q.provider = r.provider
                      AND q.textbook_external_id = r.textbook_external_id
                      AND q.question_external_id = r.question_external_id
                  ) OR NOT EXISTS (
                    SELECT 1 FROM sync_run_catalog_items AS c
                    WHERE c.run_id = r.run_id AND c.provider = r.provider
                      AND c.textbook_external_id = r.textbook_external_id
                      AND c.catalog_external_id = r.catalog_external_id
                  )) LIMIT 1`,
        },
        {
          table: 'sync_run_question_tags',
          sql: `SELECT 1 FROM sync_run_question_tags AS r
                WHERE r.run_id = ? AND r.provider = ? AND r.textbook_external_id = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM sync_run_question_items AS q
                    WHERE q.run_id = r.run_id AND q.provider = r.provider
                      AND q.textbook_external_id = r.textbook_external_id
                      AND q.question_external_id = r.question_external_id
                  ) LIMIT 1`,
        },
        {
          table: 'sync_run_question_assets',
          sql: `SELECT 1 FROM sync_run_question_assets AS r
                WHERE r.run_id = ? AND r.provider = ? AND r.textbook_external_id = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM sync_run_question_items AS q
                    WHERE q.run_id = r.run_id AND q.provider = r.provider
                      AND q.textbook_external_id = r.textbook_external_id
                      AND q.question_external_id = r.question_external_id
                  ) LIMIT 1`,
        },
      ];
      for (const check of orphanChecks) {
        if (db.prepare(check.sql).get(...parameters)) {
          throw httpError(`内容运行 ${run.id} 的 ${check.table} 包含孤儿行`, 409, 'snapshot_incomplete');
        }
      }

      // Persisted five counters are exact declarations, not lower bounds.
      // A single-textbook response can compare them directly with its scoped
      // rows.  A legacy multi-textbook run stores aggregate counters, so
      // compare against all immutable rows while retaining scoped output.
      const wholeRunScope = scopeIds.size <= 1;
      if (wholeRunScope) {
        const expectedCounts = {
          catalogItemCount: run.catalogItemCount,
          questionItemCount: run.questionItemCount,
          questionCatalogCount: run.questionCatalogCount,
          questionTagCount: run.questionTagCount,
          questionAssetCount: run.questionAssetCount,
        };
        for (const [key, expectedCount] of Object.entries(expectedCounts)) {
          if (Number(expectedCount) !== Number(counts[key])) {
            throw httpError(
              `内容运行 ${run.id} 的 ${key} 计数不一致`,
              409,
              'snapshot_incomplete',
            );
          }
        }
      } else {
        const aggregateCounts = {};
        for (const [table, field] of [
          ['sync_run_catalog_items', 'catalogItemCount'],
          ['sync_run_question_items', 'questionItemCount'],
          ['sync_run_question_catalogs', 'questionCatalogCount'],
          ['sync_run_question_tags', 'questionTagCount'],
          ['sync_run_question_assets', 'questionAssetCount'],
        ]) {
          aggregateCounts[field] = Number(db.prepare(`
            SELECT COUNT(*) AS value FROM "${table}"
            WHERE run_id = ? AND provider = ?
          `).get(run.id, PROVIDER).value || 0);
        }
        const expectedCounts = {
          catalogItemCount: run.catalogItemCount,
          questionItemCount: run.questionItemCount,
          questionCatalogCount: run.questionCatalogCount,
          questionTagCount: run.questionTagCount,
          questionAssetCount: run.questionAssetCount,
        };
        for (const [key, expectedCount] of Object.entries(expectedCounts)) {
          if (Number(expectedCount) !== Number(aggregateCounts[key])) {
            throw httpError(
              `内容运行 ${run.id} 的 ${key} 计数不一致`,
              409,
              'snapshot_incomplete',
            );
          }
        }
      }
    }

    const snapshotRun = {
      ...run,
      externalTextbookId: scopeId,
      textbookExternalId: scopeId,
      snapshotLockedAt: run.snapshotLockedAt,
      snapshotComplete: run.snapshotComplete,
      snapshot_locked_at: run.snapshotLockedAt,
      snapshot_complete: run.snapshotComplete ? 1 : 0,
    };
    const scoped = {
      textbookExternalId: scopeId,
      ...counts,
    };
    const output = {
      available: true,
      immutable: !allowIncomplete || snapshotLockPresent(run.snapshotLockedAt),
      snapshotComplete: run.snapshotComplete,
      run: snapshotRun,
      scoped,
      counts,
    };
    if (allowIncomplete) {
      const errorTableAvailable = tableNames(db).has('sync_errors');
      output.errors = errorTableAvailable
        ? (() => {
          const errorColumns = tableColumns(db, 'sync_errors');
          const orderBy = errorColumns.has('id') ? ' ORDER BY id ASC' : '';
          return db.prepare(`
            SELECT run_id,
                   ${optionalSelect(errorColumns, '', 'source_url')},
                   ${optionalSelect(errorColumns, '', 'stage')},
                   ${optionalSelect(errorColumns, '', 'error_code')},
                   ${optionalSelect(errorColumns, '', 'message')},
                   ${optionalSelect(errorColumns, '', 'created_at')}
            FROM sync_errors WHERE run_id = ?${orderBy} LIMIT ${MAX_RUN_ERRORS}
          `).all(run.id).map((row) => ({
            sourceUrl: boundedString(row.source_url, 4000),
            stage: boundedString(row.stage, 200),
            errorCode: boundedString(row.error_code, 200),
            message: boundedString(row.message, 4000),
            createdAt: boundedString(row.created_at, 80),
          }));
        })()
        : [];
    }

    // Keep the historical flat summary shape for the job manager and older
    // integrations.  These are all scalar/header fields; the new
    // snapshot-summary endpoint still returns no catalogs, questions, tags,
    // or assets arrays.  `run`, `scoped`, and `counts` remain the canonical
    // structured representation for newer callers.
    Object.assign(output, {
      id: run.id,
      runId: run.id,
      collectorRunId: run.id,
      provider: run.provider,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      scope: run.scope,
      textbookExternalId: scopeId,
      textbookExternalIds: [scopeId],
      pagesOk: run.pagesOk,
      questionsSeen: run.questionsSeen,
      questionsInserted: run.questionsInserted,
      questionsUpdated: run.questionsUpdated,
      detailsFetched: run.detailsFetched,
      assetsDownloaded: run.assetsDownloaded,
      errorCount: run.errorCount,
      message: run.message,
      snapshotLockedAt: run.snapshotLockedAt,
      snapshot_locked_at: run.snapshotLockedAt,
      snapshot_complete: run.snapshotComplete ? 1 : 0,
      catalogItemCount: counts.catalogItemCount,
      questionItemCount: counts.questionItemCount,
      questionCatalogCount: counts.questionCatalogCount,
      questionTagCount: counts.questionTagCount,
      questionAssetCount: counts.questionAssetCount,
      catalogCount: counts.catalogItemCount,
      questionCount: counts.questionItemCount,
      tagCount: counts.questionTagCount,
      assetCount: counts.questionAssetCount,
    });
    return output;
  } finally {
    db.close();
  }
}

function readRunSnapshotScopes(dbPath, runId) {
  const db = openReadOnly(dbPath);
  if (!db) throw httpError('collector SQLite 不存在', 503, 'snapshot_unavailable');
  try {
    const run = resolveContentRun(db, runId);
    assertSnapshotTables(db);
    const ids = new Set(run.textbookExternalIds || []);
    for (const table of ['sync_run_catalog_items', 'sync_run_question_items']) {
      for (const row of db.prepare(`
        SELECT DISTINCT textbook_external_id
        FROM ${table} WHERE run_id = ? AND provider = ?
      `).all(run.id, PROVIDER)) {
        if (row.textbook_external_id != null) ids.add(String(row.textbook_external_id));
      }
    }
    const errors = tableNames(db).has('sync_errors')
      ? (() => {
        const errorColumns = tableColumns(db, 'sync_errors');
        const orderBy = errorColumns.has('id') ? ' ORDER BY id ASC' : '';
        return db.prepare(`
          SELECT ${optionalSelect(errorColumns, '', 'stage')},
                 ${optionalSelect(errorColumns, '', 'message')}
          FROM sync_errors
          WHERE run_id = ?${orderBy} LIMIT ${MAX_RUN_ERRORS}
        `).all(run.id);
      })()
      : [];
    return [...ids].map((textbookExternalId) => {
      const catalogCount = Number(db.prepare(`
        SELECT COUNT(*) AS n FROM sync_run_catalog_items
        WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
      `).get(run.id, PROVIDER, textbookExternalId).n || 0);
      const questionCount = Number(db.prepare(`
        SELECT COUNT(*) AS n FROM sync_run_question_items
        WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
      `).get(run.id, PROVIDER, textbookExternalId).n || 0);
      const questionCatalogCount = Number(db.prepare(`
        SELECT COUNT(*) AS n FROM sync_run_question_catalogs
        WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
      `).get(run.id, PROVIDER, textbookExternalId).n || 0);
      const scopedCount = (table) => tableNames(db).has(table)
        ? Number(db.prepare(`
          SELECT COUNT(*) AS n FROM "${table}"
          WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        `).get(run.id, PROVIDER, textbookExternalId).n || 0)
        : 0;
      const questionTagCount = scopedCount('sync_run_question_tags');
      const questionAssetCount = scopedCount('sync_run_question_assets');
      return {
        externalTextbookId,
        textbookName: boundedString(
          run.scope?.textbookName
            || run.scope?.textbookNames?.[run.textbookExternalIds?.indexOf(textbookExternalId)],
          4000,
        ),
        collectorRunId: run.id,
        status: run.status,
        catalogCount,
        questionCount,
        questionCatalogCount,
        questionTagCount,
        questionAssetCount,
        catalogItemCount: catalogCount,
        questionItemCount: questionCount,
        snapshotLockedAt: run.snapshotLockedAt,
        snapshotComplete: run.snapshotComplete,
        pagesOk: run.pagesOk,
        questionsSeen: run.questionsSeen,
        questionsInserted: run.questionsInserted,
        questionsUpdated: run.questionsUpdated,
        detailsFetched: run.detailsFetched,
        assetsDownloaded: run.assetsDownloaded,
        errorCount: run.errorCount,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        error: errors.length ? boundedString(errors[0].message, 4000) : null,
      };
    });
  } finally {
    db.close();
  }
}

function contentRunWatermark(dbPath) {
  const db = openReadOnly(dbPath);
  if (!db) return 0;
  try {
    if (!tableNames(db).has('sync_runs')) return 0;
    const columns = tableColumns(db, 'sync_runs');
    const where = columns.has('provider') ? ' WHERE provider = ?' : '';
    const row = columns.has('provider')
      ? db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM sync_runs${where}`).get(PROVIDER)
      : db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM sync_runs').get();
    return Number(row.id || 0);
  } finally {
    db.close();
  }
}

function contentRunAfter(dbPath, watermark, textbookExternalId = null) {
  const expected = optionalExternalId(textbookExternalId, 'textbookExternalId');
  const db = openReadOnly(dbPath);
  if (!db) return null;
  try {
    if (!tableNames(db).has('sync_runs')) return null;
    for (const row of db.prepare(`
      SELECT id, scope_json FROM sync_runs
      WHERE provider = ? AND id > ? ORDER BY id DESC LIMIT 20
    `).all(PROVIDER, Number(watermark) || 0)) {
      const scope = parseJsonObject(row.scope_json);
      if (expected && !scopeTextbookIds(scope).includes(expected)) continue;
      return readRunSnapshotSummary(dbPath, Number(row.id), expected, { allowIncomplete: true });
    }
    return null;
  } finally {
    db.close();
  }
}

function resolveMetadataRun(db, metadataRunId = null) {
  const tables = tableNames(db);
  if (!tables.has('source_metadata_runs')) return null;
  const columns = tableColumns(db, 'source_metadata_runs');
  const hasProvider = columns.has('provider');
  const lock = columns.has('snapshot_locked_at')
    ? ', snapshot_locked_at AS snapshotLockedAt'
    : '';
  const selected = hasProvider
    ? `id, provider, started_at, finished_at, status, version_count, textbook_count${lock}`
    : `id, started_at, finished_at, status, version_count, textbook_count${lock}`;
  let run;
  if (metadataRunId == null) {
    run = hasProvider
      ? db.prepare(`
          SELECT ${selected} FROM source_metadata_runs
          WHERE provider = ? AND status = 'success' AND finished_at IS NOT NULL
          ORDER BY id DESC LIMIT 1
        `).get(PROVIDER)
      : db.prepare(`
          SELECT ${selected} FROM source_metadata_runs
          WHERE status = 'success' AND finished_at IS NOT NULL
          ORDER BY id DESC LIMIT 1
        `).get();
  } else {
    run = db.prepare(`SELECT ${selected} FROM source_metadata_runs WHERE id = ?`).get(Number(metadataRunId));
  }
  if (!run) {
    if (metadataRunId == null) return null;
    throw new Error(`元数据运行 ${metadataRunId} 不存在`);
  }
  if (hasProvider && String(run.provider || '') !== PROVIDER) {
    throw new Error(`元数据运行 ${run.id} 来源不受支持`);
  }
  if (String(run.status || '') !== 'success' || !run.finished_at) {
    throw new Error(`元数据运行 ${run.id} 未成功完成`);
  }
  if (!run.started_at) throw new Error(`元数据运行 ${run.id} 缺少有效时间窗口`);
  return { ...run, id: Number(run.id) };
}

function readCandidateRowsFromDb(db, entityType, {
  provider = null,
  textbookExternalId = null,
  timeWindow = null,
} = {}) {
  const entity = ENTITIES[entityType];
  if (!entity) throw new Error('不支持的同步实体类型');
  const tables = tableNames(db);
  if (!tables.has(entity.table)) {
    return { available: false, message: `collector SQLite 缺少表：${entity.table}`, rows: [] };
  }
  const columns = tableColumns(db, entity.table);
  const missing = ['provider', entity.idColumn].filter((column) => !columns.has(column));
  if (missing.length) {
    return {
      available: false,
      message: `collector 表 ${entity.table} 缺少字段：${missing.join(', ')}`,
      rows: [],
    };
  }
  const selected = entity.columns
    .filter((column) => columns.has(column))
    .map((column) => (
      entityType === 'question' && column === 'plain_text'
        ? 'substr("plain_text", 1, 360) AS "plain_text"'
        : `"${column}"`
    ));
  const predicates = [];
  const parameters = [];
  if (provider) {
    predicates.push('"provider" = ?');
    parameters.push(String(provider));
  }
  if (timeWindow) {
    if (!columns.has('last_seen_at')) {
      return {
        available: false,
        message: `collector 表 ${entity.table} 缺少 last_seen_at，无法绑定元数据运行`,
        rows: [],
      };
    }
    predicates.push('"last_seen_at" >= ? AND "last_seen_at" <= ?');
    parameters.push(String(timeWindow[0]), String(timeWindow[1]));
  }
  if (entityType === 'catalog' && textbookExternalId) {
    predicates.push('"textbook_external_id" = ?');
    parameters.push(String(textbookExternalId));
  }
  if (entityType === 'question' && textbookExternalId) {
    if (!tables.has('question_catalog_memberships') || !tables.has('textbook_nodes')) {
      return {
        available: false,
        message: 'collector SQLite 缺少题目目录关系表，无法按教材过滤题目',
        rows: [],
      };
    }
    predicates.push(`EXISTS (
      SELECT 1 FROM "question_catalog_memberships" AS qcm
      JOIN "textbook_nodes" AS tn
        ON tn."provider" = qcm."provider"
       AND tn."external_id" = qcm."catalog_external_id"
      WHERE qcm."provider" = "${entity.table}"."provider"
        AND qcm."question_external_id" = "${entity.table}"."external_id"
        AND tn."textbook_external_id" = ?
    )`);
    parameters.push(String(textbookExternalId));
  }
  let sql = `SELECT ${selected.join(', ')} FROM "${entity.table}"`;
  if (predicates.length) sql += ` WHERE ${predicates.join(' AND ')}`;
  sql += ` ORDER BY "provider" ASC, "${entity.idColumn}" ASC LIMIT ${MAX_CANDIDATE_ROWS}`;
  return {
    available: true,
    message: 'collector SQLite 可用',
    rows: db.prepare(sql).all(...parameters),
  };
}

function readMetadataRunRowsFromDb(db, entityType, run, { provider = PROVIDER } = {}) {
  const definition = {
    version: {
      table: 'source_metadata_run_versions',
      idColumn: 'external_version_id',
      columns: [
        'provider', 'external_version_id', 'version_name', 'source_url', 'is_new',
        'sort_order', 'status', 'raw_json', 'captured_at',
      ],
      expectedCount: Number(run?.version_count || 0),
    },
    textbook: {
      table: 'source_metadata_run_textbooks',
      idColumn: 'external_textbook_id',
      columns: [
        'provider', 'external_textbook_id', 'version_external_id', 'textbook_name',
        'grade', 'volume', 'source_url', 'sort_order', 'status',
        'bootstrap_chapter_external_id', 'raw_json', 'captured_at',
      ],
      expectedCount: Number(run?.textbook_count || 0),
    },
  }[entityType];
  if (!definition || !tableNames(db).has(definition.table)) return null;
  const columns = tableColumns(db, definition.table);
  const required = ['run_id', 'provider', definition.idColumn];
  if (required.some((column) => !columns.has(column))) return null;
  const selected = definition.columns
    .filter((column) => columns.has(column))
    .map((column) => `"${column}"`);
  if (columns.has('captured_at')) {
    selected.push('"captured_at" AS "first_seen_at"', '"captured_at" AS "last_seen_at"');
  }
  const rows = db.prepare(`
    SELECT ${selected.join(', ')}
    FROM "${definition.table}"
    WHERE run_id = ? AND provider = ?
    ORDER BY sort_order ASC, "${definition.idColumn}" ASC
    LIMIT ${MAX_CANDIDATE_ROWS}
  `).all(Number(run.id), String(provider || PROVIDER));
  // Databases created before immutable metadata snapshots existed are
  // backfilled on collector startup.  If a caller opens such a database
  // directly and the backfill has not run yet, fall back to the legacy time
  // window below instead of returning a false empty snapshot.
  if (!rows.length && definition.expectedCount > 0) return null;
  return {
    available: true,
    message: 'collector 元数据运行快照可用',
    rows,
    immutable: true,
  };
}

function readCandidates(dbPath, entityType, options = {}) {
  const db = openReadOnly(dbPath);
  if (!db) return { available: false, message: 'collector SQLite 不存在', rows: [], run: null };
  try {
    if (entityType === 'version' || entityType === 'textbook') {
      const tables = tableNames(db);
      if (!tables.has('source_metadata_runs')) {
        if (options.metadataRunId != null) throw new Error('采集库缺少 source_metadata_runs 表，不能验证 metadataRunId');
        return { ...readCandidateRowsFromDb(db, entityType, options), run: null };
      }
      const run = resolveMetadataRun(db, options.metadataRunId ?? null);
      if (!run) return { available: false, message: 'collector SQLite 没有成功的元数据运行', rows: [], run: null };
      const snapshot = readMetadataRunRowsFromDb(db, entityType, run, {
        provider: options.provider || PROVIDER,
      });
      if (snapshot) return { ...snapshot, run };
      return {
        ...readCandidateRowsFromDb(db, entityType, {
          ...options,
          provider: options.provider || PROVIDER,
          timeWindow: [run.started_at, run.finished_at],
        }),
        run,
      };
    }
    return { ...readCandidateRowsFromDb(db, entityType, options), run: null };
  } finally {
    db.close();
  }
}

function readMetadataSnapshot(dbPath, metadataRunId = null) {
  const db = openReadOnly(dbPath);
  if (!db) {
    return {
      available: false,
      message: 'collector SQLite 不存在',
      run: null,
      versions: [],
      textbooks: [],
    };
  }
  try {
    const run = resolveMetadataRun(db, metadataRunId);
    if (!run) {
      return {
        available: false,
        message: 'collector SQLite 没有成功的元数据运行',
        run: null,
        versions: [],
        textbooks: [],
      };
    }
    const options = { provider: PROVIDER, timeWindow: [run.started_at, run.finished_at] };
    const versions = readMetadataRunRowsFromDb(db, 'version', run, options)
      || readCandidateRowsFromDb(db, 'version', options);
    const textbooks = readMetadataRunRowsFromDb(db, 'textbook', run, options)
      || readCandidateRowsFromDb(db, 'textbook', options);
    return {
      available: versions.available && textbooks.available,
      message: [versions.message, textbooks.message].filter(Boolean).join('；'),
      run,
      versions: versions.rows,
      textbooks: textbooks.rows,
      immutable: versions.immutable === true && textbooks.immutable === true,
    };
  } finally {
    db.close();
  }
}

function validateMetadataSelection(dbPath, metadataRunId, selectedIds) {
  if (!Array.isArray(selectedIds)) throw new Error('教材选择列表必须是数组');
  const requested = selectedIds.map((value) => String(value || '').trim());
  if (!requested.length || requested.length > MAX_SELECTED_TEXTBOOKS) {
    throw new Error(`教材选择数量必须在 1 到 ${MAX_SELECTED_TEXTBOOKS} 之间`);
  }
  if (new Set(requested).size !== requested.length) throw new Error('教材选择列表不能包含重复 ID');
  if (requested.some((value) => !safeExternalId(value))) throw new Error('教材来源 ID 不安全');
  const db = openReadOnly(dbPath);
  if (!db) throw new Error('collector SQLite 不存在，请先完成版本和教材同步');
  try {
    const run = resolveMetadataRun(db, metadataRunId);
    if (!run) throw new Error(`元数据运行 ${metadataRunId} 不存在`);
    const snapshot = readMetadataRunRowsFromDb(db, 'textbook', run, { provider: PROVIDER });
    const tables = tableNames(db);
    let rows;
    if (snapshot) {
      rows = snapshot.rows.filter((row) => String(row.status ?? '0') !== '1');
    } else {
      if (!tables.has('source_textbooks')) throw new Error('collector SQLite 缺少 source_textbooks 表');
      rows = db.prepare(`
        SELECT provider, external_textbook_id, textbook_name,
               version_external_id, bootstrap_chapter_external_id
        FROM source_textbooks
        WHERE provider = ?
          AND COALESCE(status, '0') <> '1'
          AND last_seen_at >= ? AND last_seen_at <= ?
        ORDER BY version_external_id ASC, sort_order ASC, external_textbook_id ASC
      `).all(PROVIDER, run.started_at, run.finished_at);
    }
    const byId = new Map(rows.map((row) => [String(row.external_textbook_id || '').trim(), row]));
    const unknown = requested.filter((value) => !byId.has(value));
    if (unknown.length) throw new Error(`教材不属于元数据运行 ${metadataRunId} 的快照：${unknown.slice(0, 5).join(', ')}`);
    const textbooks = requested.map((value) => {
      const row = byId.get(value);
      const bootstrap = String(row.bootstrap_chapter_external_id || '').trim();
      if (!safeExternalId(bootstrap)) throw new Error(`教材 ${value} 缺少真实入口章节，不能同步题库`);
      return {
        externalTextbookId: value,
        textbookName: String(row.textbook_name || '').trim() || value,
        versionExternalId: String(row.version_external_id || '').trim() || null,
        bootstrapChapterExternalId: bootstrap,
      };
    });
    return { run, textbooks };
  } finally {
    db.close();
  }
}

function metadataWatermark(dbPath) {
  const db = openReadOnly(dbPath);
  if (!db) return 0;
  try {
    if (!tableNames(db).has('source_metadata_runs')) return 0;
    return Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM source_metadata_runs').get().id || 0);
  } finally {
    db.close();
  }
}

function metadataRunAfter(dbPath, watermark) {
  const db = openReadOnly(dbPath);
  if (!db) return null;
  try {
    if (!tableNames(db).has('source_metadata_runs')) return null;
    const row = db.prepare(`
      SELECT id, provider, started_at, finished_at, status, version_count, textbook_count
      FROM source_metadata_runs
      WHERE provider = ? AND id > ?
      ORDER BY id DESC LIMIT 1
    `).get(PROVIDER, Number(watermark) || 0);
    return row ? { ...row, id: Number(row.id) } : null;
  } finally {
    db.close();
  }
}

function readCatalogProgress(dbPath) {
  const db = openReadOnly(dbPath);
  const empty = {
    questionUnique: 0,
    catalogCount: 0,
    pagesDone: 0,
    pagesTotal: 0,
    progressPercent: null,
    current: [],
    catalogs: [],
    available: false,
    message: '',
  };
  if (!db) return { ...empty, message: 'collector SQLite 不存在' };
  try {
    const tables = tableNames(db);
    if (!tables.has('textbook_nodes')) return { ...empty, message: 'collector SQLite 缺少 textbook_nodes' };
    const nodes = db.prepare(`
      SELECT external_id, parent_external_id, node_level, name
      FROM textbook_nodes WHERE provider = ?
    `).all(PROVIDER).map((row) => ({
      externalId: String(row.external_id),
      parentExternalId: row.parent_external_id,
      level: row.node_level,
      name: row.name,
      path: row.name,
    }));
    const memberships = tables.has('question_catalog_memberships')
      ? db.prepare(`
          SELECT catalog_external_id, question_external_id
          FROM question_catalog_memberships WHERE provider = ?
        `).all(PROVIDER).map((row) => ({
          catalogExternalId: String(row.catalog_external_id),
          questionExternalId: String(row.question_external_id),
        }))
      : [];
    const stats = {};
    if (tables.has('catalog_list_stats')) {
      for (const row of db.prepare(`
        SELECT catalog_external_id, expected_total, expected_pages, last_completed_page, updated_at
        FROM catalog_list_stats WHERE provider = ? ORDER BY updated_at DESC
      `).all(PROVIDER)) {
        const id = String(row.catalog_external_id);
        if (stats[id]) continue;
        stats[id] = {
          expectedTotal: row.expected_total,
          expectedPages: row.expected_pages,
          lastCompletedPage: row.last_completed_page,
        };
      }
    }
    const currentByCatalog = {};
    if (tables.has('sync_progress')) {
      for (const row of db.prepare(`
        SELECT run_id, worker_id, catalog_external_id, catalog_name, catalog_path,
               current_page, expected_pages, expected_total, updated_at
        FROM sync_progress ORDER BY updated_at DESC
      `).all()) {
        if (!row.catalog_external_id) continue;
        const id = String(row.catalog_external_id);
        if (currentByCatalog[id]) continue;
        currentByCatalog[id] = {
          runId: row.run_id,
          workerId: row.worker_id,
          currentPage: row.current_page,
          catalogName: row.catalog_name,
          catalogPath: row.catalog_path,
        };
      }
    }
    return {
      ...buildCatalogProgressTree({ nodes, memberships, stats, currentByCatalog }),
      available: true,
      message: 'collector SQLite 可用',
    };
  } finally {
    db.close();
  }
}

module.exports = {
  ENTITIES,
  MAX_CANDIDATE_ROWS,
  MAX_CATALOG_PAGE_SIZE,
  MAX_ASSET_BYTES,
  MAX_SNAPSHOT_PAGE_BYTES,
  MAX_SNAPSHOT_PAGE_SIZE,
  MAX_SNAPSHOT_FETCH_BATCH_SIZE,
  MAX_RUN_PAGE_SIZE,
  MAX_RUN_PAGE_NUMBER,
  MAX_SELECTED_TEXTBOOKS,
  PROVIDER,
  contentRunAfter,
  contentRunWatermark,
  metadataRunAfter,
  metadataWatermark,
  readCandidates,
  readCatalogProgress,
  readRunCatalogs,
  readRunAsset,
  readRunQuestion,
  readRunQuestions,
  readRunSnapshot,
  readRunSnapshotPage,
  readRunSnapshotScopes,
  readRunSnapshotSummary,
  readMetadataSnapshot,
  safeExternalId,
  validateMetadataSelection,
};
