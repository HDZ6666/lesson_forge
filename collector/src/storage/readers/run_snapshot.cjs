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
  MAX_RUN_SNAPSHOT_ROWS,
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
const { snapshotRowObject } = require('./snapshot_page.cjs');

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
        externalTextbookId: textbookExternalId,
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
module.exports = {
  readRunSnapshot,
  readRunSnapshotSummary,
  readRunSnapshotScopes,
};
