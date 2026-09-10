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

function readLiveRunProgress(dbPath, runId, options = {}) {
  const requestedTextbookId = optionalExternalId(
    options.textbookExternalId,
    'textbookExternalId',
  );
  let db = null;
  const unavailable = (message = 'collector 实时进度暂不可用', error = null) => ({
    available: false,
    live: false,
    runId: Number.isSafeInteger(Number(runId)) ? Number(runId) : null,
    textbookExternalId: requestedTextbookId,
    message: boundedString(message, 400),
    errorCode: error?.code || null,
  });

  try {
    db = openReadOnly(dbPath);
    if (!db) return unavailable('collector SQLite 不存在');
    const run = resolveContentRun(db, runId);
    const tables = tableNames(db);
    const required = ['sync_run_catalog_items', 'sync_run_catalog_progress'];
    const missing = required.filter((table) => !tables.has(table));
    if (missing.length) return unavailable(`collector SQLite 缺少实时进度表：${missing.join(', ')}`);
    assertRunTextbook(db, run, requestedTextbookId);

    const textbookExternalId = requestedTextbookId || run.textbookExternalId || null;
    const predicates = ['item.run_id = ?', 'item.provider = ?'];
    const parameters = [run.id, PROVIDER];
    if (textbookExternalId) {
      predicates.push('item.textbook_external_id = ?');
      parameters.push(textbookExternalId);
    }
    const where = predicates.join(' AND ');
    const itemColumns = tableColumns(db, 'sync_run_catalog_items');
    const progressPredicates = [
      'progress.run_id = ?', 'progress.provider = ?',
    ];
    const progressParameters = [run.id, PROVIDER];
    if (textbookExternalId) {
      progressPredicates.push('progress.textbook_external_id = ?');
      progressParameters.push(textbookExternalId);
    }
    const progressWhere = progressPredicates.join(' AND ');
    const maxNodes = Math.min(
      MAX_LIVE_TREE_NODES,
      Number.isSafeInteger(Number(options.maxNodes)) && Number(options.maxNodes) > 0
        ? Number(options.maxNodes) : MAX_LIVE_TREE_NODES,
    );
    const catalogCount = Number(db.prepare(`
      SELECT COUNT(*) AS n FROM sync_run_catalog_items AS item WHERE ${where}
    `).get(...parameters).n || 0);
    const levelCounts = new Map(db.prepare(`
      SELECT COALESCE(item.node_level, 0) AS level, COUNT(*) AS n
      FROM sync_run_catalog_items AS item
      WHERE ${where}
      GROUP BY COALESCE(item.node_level, 0)
    `).all(...parameters).map((row) => [Number(row.level || 0), Number(row.n || 0)]));
    const progressColumns = tableColumns(db, 'sync_run_catalog_progress');
    const progressRows = db.prepare(`
      SELECT progress.catalog_external_id, progress.expected_total,
             progress.page_capacity, progress.expected_pages,
             progress.last_completed_page, progress.list_seen_count,
             progress.status, progress.observed_at
             ${progressColumns.has('target_pages') ? ', progress.target_pages' : ''}
             ${progressColumns.has('max_observed_total') ? ', progress.max_observed_total' : ''}
             ${progressColumns.has('highest_attempted_page') ? ', progress.highest_attempted_page' : ''}
             ${progressColumns.has('scan_complete') ? ', progress.scan_complete' : ''}
             ${progressColumns.has('data_complete') ? ', progress.data_complete' : ''}
             ${progressColumns.has('completion_quality') ? ', progress.completion_quality' : ''}
             ${progressColumns.has('failed_page_count') ? ', progress.failed_page_count' : ''}
             ${progressColumns.has('duplicate_page_count') ? ', progress.duplicate_page_count' : ''}
             ${progressColumns.has('empty_page_count') ? ', progress.empty_page_count' : ''}
             ${progressColumns.has('parse_error_count') ? ', progress.parse_error_count' : ''}
             ${progressColumns.has('asset_error_count') ? ', progress.asset_error_count' : ''}
             ${progressColumns.has('stall_reason') ? ', progress.stall_reason' : ''}
             ${progressColumns.has('scan_percent_high_water') ? ', progress.scan_percent_high_water' : ''}
      FROM sync_run_catalog_progress AS progress
      WHERE ${progressWhere}
    `).all(...progressParameters);
    // Derive the occurrence counter from the idempotent page snapshot when
    // available.  Progress rows are copied during resume, so trusting their
    // historical counter alone could preserve a pre-fix double count.
    const pageColumns = tables.has('sync_run_catalog_pages')
      ? tableColumns(db, 'sync_run_catalog_pages') : new Set();
    const pageOccurrencesByCatalog = new Map();
    if (['run_id', 'provider', 'textbook_external_id', 'catalog_external_id', 'question_count']
      .every((column) => pageColumns.has(column))) {
      const pagePredicates = [
        'page.run_id = ?', 'page.provider = ?',
      ];
      const pageParameters = [run.id, PROVIDER];
      if (textbookExternalId) {
        pagePredicates.push('page.textbook_external_id = ?');
        pageParameters.push(textbookExternalId);
      }
      const pageRows = db.prepare(`
        SELECT page.catalog_external_id, COALESCE(SUM(page.question_count), 0) AS n
        FROM sync_run_catalog_pages AS page
        WHERE ${pagePredicates.join(' AND ')}
        GROUP BY page.catalog_external_id
      `).all(...pageParameters);
      for (const row of pageRows) {
        pageOccurrencesByCatalog.set(
          String(row.catalog_external_id),
          Math.max(0, Number(row.n || 0)),
        );
      }
    }
    const uniqueByCatalog = new Map();
    const catalogLinkColumns = tables.has('sync_run_question_catalogs')
      ? tableColumns(db, 'sync_run_question_catalogs') : new Set();
    if (['run_id', 'textbook_external_id', 'catalog_external_id', 'question_external_id']
      .every((column) => catalogLinkColumns.has(column))) {
      const linkPredicates = ['link.run_id = ?'];
      const linkParameters = [run.id];
      if (textbookExternalId) {
        linkPredicates.push('link.textbook_external_id = ?');
        linkParameters.push(textbookExternalId);
      }
      const uniqueRows = db.prepare(`
        SELECT link.catalog_external_id, COUNT(DISTINCT link.question_external_id) AS n
        FROM sync_run_question_catalogs AS link
        WHERE ${linkPredicates.join(' AND ')}
        GROUP BY link.catalog_external_id
      `).all(...linkParameters);
      for (const row of uniqueRows) {
        uniqueByCatalog.set(String(row.catalog_external_id), Math.max(0, Number(row.n || 0)));
      }
    }
    const attemptedByCatalog = new Map();
    if (['run_id', 'provider', 'textbook_external_id', 'catalog_external_id', 'page_number']
      .every((column) => pageColumns.has(column))) {
      const pagePredicates = ['page.run_id = ?', 'page.provider = ?'];
      const pageParameters = [run.id, PROVIDER];
      if (textbookExternalId) {
        pagePredicates.push('page.textbook_external_id = ?');
        pageParameters.push(textbookExternalId);
      }
      const attemptedRows = db.prepare(`
        SELECT page.catalog_external_id, COUNT(*) AS n, COALESCE(MAX(page.page_number), 0) AS highest
        FROM sync_run_catalog_pages AS page
        WHERE ${pagePredicates.join(' AND ')}
        GROUP BY page.catalog_external_id
      `).all(...pageParameters);
      for (const row of attemptedRows) {
        attemptedByCatalog.set(String(row.catalog_external_id), {
          attemptedPageCount: Math.max(0, Number(row.n || 0)),
          highestAttemptedPage: Math.max(0, Number(row.highest || 0)),
        });
      }
    }
    const progressByCatalog = new Map(progressRows.map((row) => [
      String(row.catalog_external_id), {
        expectedTotal: row.expected_total == null ? null : Number(row.expected_total),
        latestSourceTotal: row.expected_total == null ? null : Number(row.expected_total),
        maxObservedTotal: row.max_observed_total == null
          ? (row.expected_total == null ? null : Number(row.expected_total))
          : Number(row.max_observed_total),
        pageCapacity: row.page_capacity == null ? null : Number(row.page_capacity),
        expectedPages: row.expected_pages == null ? null : Number(row.expected_pages),
        targetPages: row.target_pages == null
          ? (row.expected_pages == null ? null : Number(row.expected_pages))
          : Number(row.target_pages),
        lastCompletedPage: Number(row.last_completed_page || 0),
        lastContiguousSuccessfulPage: Number(row.last_completed_page || 0),
        highestAttemptedPage: Number(row.highest_attempted_page
          || attemptedByCatalog.get(String(row.catalog_external_id))?.highestAttemptedPage
          || 0),
        attemptedPageCount: attemptedByCatalog.get(String(row.catalog_external_id))?.attemptedPageCount || 0,
        // Occurrence count from saved page cards; unique count comes from the
        // association table and is a different metric.
        listSeenCount: pageOccurrencesByCatalog.has(String(row.catalog_external_id))
          ? pageOccurrencesByCatalog.get(String(row.catalog_external_id))
          : Number(row.list_seen_count || 0),
        uniqueQuestionCount: uniqueByCatalog.get(String(row.catalog_external_id)) || 0,
        status: String(row.status || 'running'),
        scanComplete: Number(row.scan_complete || 0) === 1
          || ['completed', 'stalled'].includes(String(row.status || '')),
        dataComplete: Number(row.data_complete || 0) === 1,
        completionQuality: row.completion_quality || null,
        pageLimitReached: row.stall_reason === 'page_limit_1000',
        failedPageCount: Number(row.failed_page_count || 0),
        duplicatePageCount: Number(row.duplicate_page_count || 0),
        emptyPageCount: Number(row.empty_page_count || 0),
        parseErrorCount: Number(row.parse_error_count || 0),
        assetErrorCount: Number(row.asset_error_count || 0),
        scanPercentHighWater: row.scan_percent_high_water == null
          ? null : Number(row.scan_percent_high_water),
        observedAt: row.observed_at || null,
      },
    ]));

    // The textbook summary uses the unique question snapshot rows saved for
    // this run/textbook.  This is deliberately a different metric from the
    // per-catalog occurrence count above: a question listed in two catalogs
    // contributes to each catalog's `listSeenCount`, but only one
    // `sync_run_question_items` row contributes to the textbook summary.
    const questionItemColumns = tables.has('sync_run_question_items')
      ? tableColumns(db, 'sync_run_question_items') : new Set();
    const questionItemsAvailable = Boolean(textbookExternalId)
      && ['run_id', 'provider', 'textbook_external_id', 'question_external_id']
        .every((column) => questionItemColumns.has(column));
    let uniqueQuestionCount = null;
    if (questionItemsAvailable) {
      const row = db.prepare(`
        SELECT COUNT(*) AS n FROM sync_run_question_items AS question
        WHERE question.run_id = ?
          AND question.provider = ?
          AND question.textbook_external_id = ?
      `).get(run.id, PROVIDER, textbookExternalId);
      uniqueQuestionCount = Math.max(0, Number(row?.n || 0));
    }

    const rawRows = db.prepare(`
      SELECT item.textbook_external_id, item.catalog_external_id,
             ${optionalSelect(itemColumns, 'item', 'parent_external_id')},
             ${optionalSelect(itemColumns, 'item', 'node_level')},
             ${optionalSelect(itemColumns, 'item', 'node_type')},
             item.name,
             ${optionalSelect(itemColumns, 'item', 'source_path')},
             ${optionalSelect(itemColumns, 'item', 'catalog_path')},
             ${optionalSelect(itemColumns, 'item', 'sort_order')},
             ${optionalSelect(itemColumns, 'item', 'captured_at')}
      FROM sync_run_catalog_items AS item
      WHERE ${where}
      ORDER BY COALESCE(item.sort_order, 2147483647) ASC,
               COALESCE(item.node_level, 2147483647) ASC,
               item.catalog_external_id ASC
      LIMIT ?
    `).all(...parameters, maxNodes + 1);
    const truncated = rawRows.length > maxNodes;
    const rows = rawRows.slice(0, maxNodes);
    const runScanComplete = run.scanComplete === true
      || (['success', 'completed'].includes(String(run.status || '').toLowerCase())
        && [...progressByCatalog.values()].length > 0
        && [...progressByCatalog.values()].every((item) => item.scanComplete));
    const nodes = rows.map((row) => {
      const externalId = String(row.catalog_external_id);
      const progress = progressByCatalog.get(externalId) || null;
      const occurrenceCount = progress
        ? Math.max(0, Number(progress.listSeenCount || 0))
        : 0;
      const uniqueQuestionCount = progress
        ? Math.max(0, Number(progress.uniqueQuestionCount || 0))
        : 0;
      const latestSourceTotal = progress?.latestSourceTotal == null
        ? null : Math.max(0, Number(progress.latestSourceTotal));
      const targetPages = progress?.targetPages == null ? null : Math.max(0, Number(progress.targetPages));
      const attemptedPages = progress
        ? Math.max(0, Number(progress.attemptedPageCount || 0))
        : 0;
      const level = row.node_level == null ? null : Number(row.node_level);
      return {
        nodeKey: `${textbookExternalId || row.textbook_external_id || ''}:${externalId}`,
        externalId,
        externalCatalogId: externalId,
        textbookExternalId: String(row.textbook_external_id),
        parentExternalId: row.parent_external_id == null ? null : String(row.parent_external_id),
        level,
        nodeLevel: level,
        type: row.node_type || null,
        nodeType: row.node_type || null,
        name: boundedString(row.name, 1000) || externalId,
        label: boundedString(row.name, 1000) || externalId,
        sourcePath: boundedString(row.source_path, 4000),
        path: boundedString(row.catalog_path || row.name, 8000),
        sortOrder: row.sort_order == null ? null : Number(row.sort_order),
        expectedTotal: latestSourceTotal,
        expected: latestSourceTotal,
        total: latestSourceTotal,
        latestSourceTotal,
        sourceReportedTotal: latestSourceTotal,
        collectedCount: uniqueQuestionCount,
        collected: uniqueQuestionCount,
        uniqueQuestionCount,
        occurrenceCount,
        listSeenCount: occurrenceCount,
        questionCount: uniqueQuestionCount,
        expectedPages: targetPages,
        targetPages,
        attemptedPages,
        lastCompletedPage: progress?.lastCompletedPage || 0,
        lastContiguousSuccessfulPage: progress?.lastContiguousSuccessfulPage || 0,
        highestAttemptedPage: progress?.highestAttemptedPage || 0,
        failedPageCount: progress?.failedPageCount || 0,
        duplicatePageCount: progress?.duplicatePageCount || 0,
        emptyPageCount: progress?.emptyPageCount || 0,
        parseErrorCount: progress?.parseErrorCount || 0,
        assetErrorCount: progress?.assetErrorCount || 0,
        scanComplete: Boolean(progress?.scanComplete),
        dataComplete: Boolean(progress && (
          progress.dataComplete === true
          || (progress.scanComplete
            && progress.completionQuality !== 'completed_with_issues'
            && progress.status !== 'stalled'
            && !(progress.failedPageCount || progress.duplicatePageCount
              || progress.parseErrorCount || progress.assetErrorCount)
          )
        )),
        completionQuality: progress?.completionQuality || null,
        pageLimitReached: progress?.pageLimitReached === true,
        status: progress?.status || 'pending',
        queried: Boolean(progress),
        hasProgress: Boolean(progress),
        observedAt: progress?.observedAt || row.captured_at || null,
        children: [],
      };
    });

    const runScope = run.scope && typeof run.scope === 'object' ? run.scope : {};
    // parent_external_id is produced by the static nested provider tree.  It
    // is the only relationship used here; raw provider parentId is never
    // consulted.  Keep malformed/cyclic trees renderable by promoting the
    // problematic node to the root.
    const nodeById = new Map(nodes.map((node) => [node.externalId, node]));
    const roots = [];
    const createsCycle = (child, parent) => {
      const seen = new Set([child.externalId]);
      let current = parent;
      while (current) {
        if (seen.has(current.externalId)) return true;
        seen.add(current.externalId);
        current = current.parentExternalId ? nodeById.get(current.parentExternalId) : null;
      }
      return false;
    };
    for (const node of nodes) {
      const parent = node.parentExternalId ? nodeById.get(node.parentExternalId) : null;
      if (parent && parent !== node && !createsCycle(node, parent)) parent.children.push(node);
      else roots.push(node);
    }

    // `textbookExpectedTotal` comes only from the root probe and is not
    // inferred by summing child catalog totals.  A missing probe therefore
    // keeps the denominator/progress explicitly unknown.
    const expectedTotalRaw = runScope.textbookExpectedTotal;
    const expectedTotalNumber = expectedTotalRaw == null || expectedTotalRaw === ''
      ? NaN : Number(expectedTotalRaw);
    const textbookExpectedTotal = Number.isSafeInteger(expectedTotalNumber)
      && expectedTotalNumber >= 0 ? expectedTotalNumber : null;
    const collectedQuestionCount = uniqueQuestionCount;
    const queriedProgress = [...progressByCatalog.values()];

    // Run-level progress is page based over the WHOLE selected catalog set,
    // not only over catalogs that already started.  Catalogs that have not
    // started yet are estimated per level (average target pages of started
    // catalogs at that level, else the root-probe total spread over the
    // level).  This replaces the old "attempted / started-target, max'ed
    // with the best single catalog" formula, which hit 99% during the first
    // chapter and then stayed there for the rest of the textbook.
    const pageCapacity = Math.max(1, Number(runScope.pageCapacity) || 10);
    const selectedLevels = Array.isArray(runScope.catalogLevels) && runScope.catalogLevels.length
      ? runScope.catalogLevels.map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : [1, 2, 3];
    const selectedIds = Array.isArray(runScope.catalogIds) && runScope.catalogIds.length
      ? new Set(runScope.catalogIds.map((value) => String(value)))
      : null;
    const levelByCatalog = new Map(db.prepare(`
      SELECT item.catalog_external_id, item.node_level
      FROM sync_run_catalog_items AS item
      WHERE ${where}
      LIMIT 20000
    `).all(...parameters).map((row) => [String(row.catalog_external_id), row.node_level == null ? null : Number(row.node_level)]));
    const isSelected = (catalogId, level) => (
      selectedIds ? selectedIds.has(String(catalogId)) : selectedLevels.includes(Number(level))
    );
    const selectedCountByLevel = new Map();
    for (const [catalogId, level] of levelByCatalog) {
      if (!isSelected(catalogId, level)) continue;
      selectedCountByLevel.set(level, (selectedCountByLevel.get(level) || 0) + 1);
    }
    const startedByLevel = new Map();
    let attemptedPages = 0;
    let knownTargetPages = 0;
    let completedCatalogCount = 0;
    for (const [catalogId, item] of progressByCatalog) {
      const level = levelByCatalog.get(catalogId) ?? null;
      const target = Math.max(0, Number(item.targetPages || item.expectedPages || 0));
      const attempted = Math.max(0, Number(item.attemptedPageCount || 0));
      // A finished catalog counts exactly its real pages; a running one counts
      // its current target (the provider total can still grow).
      const known = item.scanComplete ? attempted : Math.max(target, attempted);
      knownTargetPages += known;
      attemptedPages += item.scanComplete ? attempted : Math.min(attempted, known);
      if (item.scanComplete) completedCatalogCount += 1;
      const bucket = startedByLevel.get(level) || { count: 0, pages: 0 };
      bucket.count += 1;
      bucket.pages += known;
      startedByLevel.set(level, bucket);
    }
    let estimatedRemainingPages = 0;
    let estimateComplete = true;
    const levelDerivedCount = [...selectedCountByLevel.values()].reduce((sum, count) => sum + count, 0);
    const scopeSelectedCount = Number(runScope.selectedCatalogCount) > 0 ? Number(runScope.selectedCatalogCount) : null;
    let selectedCatalogCount = levelDerivedCount;
    if (scopeSelectedCount != null && scopeSelectedCount < levelDerivedCount) {
      // `--max-catalogs` truncated the selection; levels are not known per
      // selected catalog, so estimate the remainder with the overall average.
      selectedCatalogCount = scopeSelectedCount;
      const unstarted = Math.max(0, selectedCatalogCount - queriedProgress.length);
      if (unstarted > 0) {
        if (queriedProgress.length > 0) estimatedRemainingPages = unstarted * (knownTargetPages / queriedProgress.length);
        else if (textbookExpectedTotal != null) estimatedRemainingPages = Math.ceil(textbookExpectedTotal / pageCapacity);
        else estimateComplete = false;
      }
    } else {
      for (const [level, selectedCount] of selectedCountByLevel) {
        const started = startedByLevel.get(level) || { count: 0, pages: 0 };
        const unstarted = Math.max(0, selectedCount - started.count);
        if (unstarted === 0) continue;
        let perCatalog = null;
        if (started.count > 0) perCatalog = started.pages / started.count;
        else if (textbookExpectedTotal != null) perCatalog = Math.ceil(textbookExpectedTotal / pageCapacity) / selectedCount;
        if (perCatalog == null) {
          estimateComplete = false;
          continue;
        }
        estimatedRemainingPages += unstarted * perCatalog;
      }
    }
    const estimatedTotalPages = Math.round(knownTargetPages + estimatedRemainingPages);
    // "All started catalogs are complete" is not "the run is complete" while
    // selected catalogs have not started yet.
    const allSelectedStarted = selectedCatalogCount === 0 || queriedProgress.length >= selectedCatalogCount;
    const scanComplete = runScanComplete
      || (queriedProgress.length > 0 && allSelectedStarted && queriedProgress.every((item) => item.scanComplete));
    const dataComplete = run.snapshotComplete === true
      || run.dataComplete === true
      || (scanComplete && queriedProgress.every((item) => (
        item.dataComplete === true
        || (item.completionQuality !== 'completed_with_issues'
          && item.status !== 'stalled'
          && !(item.failedPageCount || item.duplicatePageCount
            || item.parseErrorCount || item.assetErrorCount))
      )));
    const pageLimitReached = [...progressByCatalog.values()].some((item) => item.pageLimitReached === true);
    let totalsKnown;
    let statisticsPending;
    let totalQuestionCount;
    let progressPercent;
    if (scanComplete) {
      totalsKnown = true;
      statisticsPending = false;
      totalQuestionCount = textbookExpectedTotal;
      progressPercent = 100;
    } else {
      totalsKnown = textbookExpectedTotal != null || knownTargetPages > 0;
      statisticsPending = !questionItemsAvailable && queriedProgress.length === 0;
      totalQuestionCount = textbookExpectedTotal;
      progressPercent = estimatedTotalPages > 0
        ? Math.min(99, Math.round((attemptedPages / estimatedTotalPages) * 1000) / 10)
        : null;
    }
    const counts = (level) => Number(levelCounts.get(level) || 0);
    const fetchWindows = [];
    if (tables.has('sync_progress')) {
      const slotColumns = tableColumns(db, 'sync_progress');
      const slotPredicates = ['slot.run_id = ?'];
      const slotParameters = [run.id];
      const slotRows = db.prepare(`
        SELECT slot.worker_id, slot.catalog_external_id, slot.catalog_name, slot.catalog_path,
               slot.current_page, slot.expected_pages, slot.expected_total, slot.updated_at
               ${slotColumns.has('slot_status') ? ', slot.slot_status' : ''}
               ${slotColumns.has('question_count') ? ', slot.question_count' : ''}
               ${slotColumns.has('result_type') ? ', slot.result_type' : ''}
               ${slotColumns.has('message') ? ', slot.message' : ''}
        FROM sync_progress AS slot
        WHERE ${slotPredicates.join(' AND ')}
        ORDER BY slot.worker_id ASC
      `).all(...slotParameters);
      const byCatalog = new Map();
      for (const row of slotRows) {
        const catalogId = row.catalog_external_id == null ? '' : String(row.catalog_external_id);
        if (!byCatalog.has(catalogId)) {
          byCatalog.set(catalogId, {
            catalogExternalId: catalogId || null,
            catalogName: boundedString(row.catalog_name, 1000) || catalogId || null,
            catalogPath: boundedString(row.catalog_path, 4000),
            targetPages: row.expected_pages == null ? null : Number(row.expected_pages),
            latestSourceTotal: row.expected_total == null ? null : Number(row.expected_total),
            updatedAt: row.updated_at || null,
            slots: [],
          });
        }
        const window = byCatalog.get(catalogId);
        const pageNumber = row.current_page == null ? null : Number(row.current_page);
        const questionCount = row.question_count == null ? null : Number(row.question_count);
        const status = String(row.slot_status || (pageNumber == null ? 'idle' : 'fetching'));
        const sourceTotal = row.expected_total == null ? null : Number(row.expected_total);
        const line = boundedString(row.message, 500) || (
          catalogId && pageNumber != null
            ? `catalog=${catalogId} page=${pageNumber}`
              + (questionCount == null ? '' : ` questions=${questionCount}`)
              + (sourceTotal == null ? '' : ` total=${sourceTotal}`)
            : null
        );
        window.slots.push({
          slot: Number(row.worker_id || 0),
          pageNumber,
          status,
          questionCount,
          resultType: row.result_type || null,
          sourceTotal,
          line,
          updatedAt: row.updated_at || null,
        });
        if (row.updated_at && (!window.updatedAt || String(row.updated_at) > String(window.updatedAt))) {
          window.updatedAt = row.updated_at;
        }
      }
      fetchWindows.push(...byCatalog.values());
    }
    const currentCatalogIds = new Set(
      fetchWindows.map((item) => String(item.catalogExternalId || '')).filter(Boolean),
    );
    if (currentCatalogIds.size) {
      const markCurrent = (nodes) => {
        for (const node of nodes || []) {
          node.current = currentCatalogIds.has(String(node.externalId || ''));
          markCurrent(node.children);
        }
      };
      markCurrent(roots);
    }
    return {
      available: true,
      live: true,
      message: 'collector 实时目录进度可用',
      runId: run.id,
      collectorRunId: run.id,
      textbookExternalId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      summaryStrategy: String(runScope.summaryStrategy || 'textbook_root_probe'),
      textbookExpectedTotal,
      firstRoundComplete: totalsKnown,
      totalsKnown,
      statisticsPending,
      totalQuestionCount,
      expectedQuestionCount: totalQuestionCount,
      latestSourceTotal: textbookExpectedTotal,
      sourceReportedTotal: textbookExpectedTotal,
      collectedQuestionCount,
      // This alias is retained for old clients, but its value is the global
      // unique-question snapshot count, not the per-catalog occurrence sum.
      uniqueQuestionCount: collectedQuestionCount,
      listSeenCount: collectedQuestionCount,
      scanComplete,
      dataComplete,
      completionQuality: scanComplete
        ? (dataComplete ? 'completed' : 'completed_with_issues')
        : (run.completionQuality || null),
      pageLimitReached,
      snapshotComplete: run.snapshotComplete === true,
      progressPercent,
      progress: progressPercent,
      // Progress basis, so a UI can show "已扫描 X / 约 Y 页" instead of a bare
      // percentage.  `estimateComplete=false` means some level has no basis
      // for estimating unstarted catalogs yet.
      progressBasis: 'pages_estimated',
      attemptedPages,
      knownTargetPages,
      estimatedTotalPages: estimatedTotalPages > 0 ? estimatedTotalPages : null,
      estimateComplete,
      selectedCatalogCount,
      startedCatalogCount: queriedProgress.length,
      completedCatalogCount,
      chapterCount: counts(1),
      knowledgePointCount: counts(2),
      secondaryKnowledgePointCount: counts(3),
      catalogCount,
      catalogLevelCounts: Object.fromEntries([...levelCounts.entries()].map(([level, count]) => [String(level), count])),
      summaryCatalogIds: [],
      summaryCatalogLevel: null,
      summaryNodeCount: 0,
      questionItemsAvailable,
      tree: roots,
      catalogs: roots,
      catalogTree: roots,
      treeNodeCount: nodes.length,
      treeTruncated: truncated || catalogCount > nodes.length,
      fetchWindows,
      currentCatalogIds: [...currentCatalogIds],
    };
  } catch (error) {
    return unavailable('collector 实时进度读取失败', error);
  } finally {
    try { db?.close(); } catch {}
  }
}

module.exports = {
  readLiveRunProgress,
};
