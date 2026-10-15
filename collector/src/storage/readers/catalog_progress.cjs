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
const { buildCatalogProgressTree } = require('../catalog_progress_tree.cjs');

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
    const nodes = db
      .prepare(
        `
      SELECT external_id, parent_external_id, node_level, name
      FROM textbook_nodes WHERE provider = ?
    `,
      )
      .all(PROVIDER)
      .map((row) => ({
        externalId: String(row.external_id),
        parentExternalId: row.parent_external_id,
        level: row.node_level,
        name: row.name,
        path: row.name,
      }));
    const memberships = tables.has('question_catalog_memberships')
      ? db
          .prepare(
            `
          SELECT catalog_external_id, question_external_id
          FROM question_catalog_memberships WHERE provider = ?
        `,
          )
          .all(PROVIDER)
          .map((row) => ({
            catalogExternalId: String(row.catalog_external_id),
            questionExternalId: String(row.question_external_id),
          }))
      : [];
    const stats = {};
    if (tables.has('catalog_list_stats')) {
      for (const row of db
        .prepare(
          `
        SELECT catalog_external_id, expected_total, expected_pages, last_completed_page, updated_at
        FROM catalog_list_stats WHERE provider = ? ORDER BY updated_at DESC
      `,
        )
        .all(PROVIDER)) {
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
      for (const row of db
        .prepare(
          `
        SELECT run_id, worker_id, catalog_external_id, catalog_name, catalog_path,
               current_page, expected_pages, expected_total, updated_at
        FROM sync_progress ORDER BY updated_at DESC
      `,
        )
        .all()) {
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
  readCatalogProgress,
};
