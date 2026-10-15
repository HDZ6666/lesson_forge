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
const { readRunSnapshotSummary } = require('./run_snapshot.cjs');

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
    for (const row of db
      .prepare(
        `
      SELECT id, scope_json FROM sync_runs
      WHERE provider = ? AND id > ? ORDER BY id DESC LIMIT 20
    `,
      )
      .all(PROVIDER, Number(watermark) || 0)) {
      const scope = parseJsonObject(row.scope_json);
      if (expected && !scopeTextbookIds(scope).includes(expected)) continue;
      return readRunSnapshotSummary(dbPath, Number(row.id), expected, { allowIncomplete: true });
    }
    return null;
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
    const row = db
      .prepare(
        `
      SELECT id, provider, started_at, finished_at, status, version_count, textbook_count
      FROM source_metadata_runs
      WHERE provider = ? AND id > ?
      ORDER BY id DESC LIMIT 1
    `,
      )
      .get(PROVIDER, Number(watermark) || 0);
    return row ? { ...row, id: Number(row.id) } : null;
  } finally {
    db.close();
  }
}

module.exports = {
  contentRunWatermark,
  contentRunAfter,
  metadataWatermark,
  metadataRunAfter,
};
