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
const { isAbsoluteStoragePath } = require('./assets.cjs');

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

module.exports = {
  snapshotValue,
  snapshotRowObject,
  snapshotPageCountObject,
  snapshotPageSuffixBytes,
  snapshotOrderBy,
  readRunSnapshotPage,
};
