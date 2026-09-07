'use strict';

const {
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
  MAX_SNAPSHOT_PAGE_BYTES,
  MAX_SNAPSHOT_PAGE_SIZE,
  MAX_SNAPSHOT_FETCH_BATCH_SIZE,
  MAX_ASSET_BYTES,
  ASSET_SHA256,
  STRICT_SNAPSHOT_RUN_COLUMNS,
  SNAPSHOT_COLLECTIONS,
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
} = require('./common.cjs');

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
    const pageColumns = tableNames(db).has('sync_run_catalog_pages')
      ? tableColumns(db, 'sync_run_catalog_pages') : new Set();
    const hasPageOccurrenceSnapshot = [
      'run_id', 'provider', 'textbook_external_id', 'catalog_external_id', 'question_count',
    ].every((column) => pageColumns.has(column));
    const questionCountSql = hasPageOccurrenceSnapshot
      ? `(
           SELECT COALESCE(SUM(page.question_count), 0)
           FROM sync_run_catalog_pages AS page
           WHERE page.run_id = item.run_id
             AND page.provider = item.provider
             AND page.textbook_external_id = item.textbook_external_id
             AND page.catalog_external_id = item.catalog_external_id
         )`
      : `(
           SELECT COUNT(*)
           FROM sync_run_question_catalogs AS link
           WHERE link.run_id = item.run_id
             AND link.provider = item.provider
             AND link.textbook_external_id = item.textbook_external_id
             AND link.catalog_external_id = item.catalog_external_id
         )`;
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
             ${questionCountSql} AS question_count
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

/**
 * Read the small, mutable progress projection used by the task detail page.
 *
 * This intentionally does not use the apply/compare snapshot readers above:
 * a running run is expected here. Per-catalog page counters are occurrence
 * counters (the same question appearing in two catalog queries counts twice),
 * while the textbook summary is the unique-question row count from
 * sync_run_question_items.
 * Every error is converted into an unavailable projection so polling this
 * endpoint can never make the collector worker fail.
 */
module.exports = {
  readRunCatalogs,
};
