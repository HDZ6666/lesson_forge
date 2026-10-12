'use strict';

const { PROVIDER, safeExternalId, tableNames, tableColumns, httpError } = require('./common.cjs');

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function captureRunCoverage(db, run, textbookId, scopeIds, { withProgress = true } = {}) {
  const scope = run.scope || {};
  // A legacy multi-book declaration cannot assign its aggregate totals to a book.
  const ownScope = scopeIds.size === 1 && String(scope.textbookId || scope.textbookExternalId || '') === textbookId;
  const sourceCount =
    ownScope && scope.summaryStrategy === 'textbook_root_probe' ? count(scope.textbookExpectedTotal) : null;
  const observed =
    sourceCount != null &&
    typeof scope.textbookExpectedTotalObservedAt === 'string' &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(scope.textbookExpectedTotalObservedAt)
      ? new Date(scope.textbookExpectedTotalObservedAt)
      : null;
  const sourceReport = {
    count: sourceCount,
    observedAt: observed && Number.isFinite(observed.getTime()) ? observed.toISOString() : null,
    basis: sourceCount == null ? null : 'textbook_root_probe',
  };
  const scan = {
    availableCatalogCount: ownScope ? count(scope.availableCatalogCount) : null,
    selectedCatalogCount: ownScope ? count(scope.selectedCatalogCount) : null,
    observedCatalogCount: null,
    scanCompletedCatalogCount: null,
    dataCompletedCatalogCount: null,
    failedPageCount: null,
    duplicatePageCount: null,
    parseErrorCount: null,
    assetErrorCount: null,
    catalogSelectionTruncated:
      ownScope && typeof scope.catalogSelectionTruncated === 'boolean' ? scope.catalogSelectionTruncated : null,
    startPage: ownScope ? count(scope.startPage) : null,
    maxPages: ownScope ? count(scope.maxPages) : null,
    questionLimit: ownScope ? count(scope.limit) : null,
    targetsKnown: false,
    unscannedCatalogCount: null,
  };
  const targets = ownScope && Array.isArray(scope.scanCatalogIds) ? scope.scanCatalogIds : [];
  scan.targetsKnown =
    scope.coverageFormat === 'run-coverage-v1' &&
    scan.selectedCatalogCount != null &&
    targets.length === scan.selectedCatalogCount &&
    new Set(targets).size === targets.length &&
    targets.every(safeExternalId);
  if (withProgress && tableNames(db).has('sync_run_catalog_progress')) {
    const columns = tableColumns(db, 'sync_run_catalog_progress');
    const currentFormat = scope.coverageFormat === 'run-coverage-v1';
    const sums = [
      ['scan_complete', 'scanCompletedCatalogCount'],
      ['data_complete', 'dataCompletedCatalogCount'],
      ['failed_page_count', 'failedPageCount'],
      ['duplicate_page_count', 'duplicatePageCount'],
      ['parse_error_count', 'parseErrorCount'],
      ['asset_error_count', 'assetErrorCount'],
    ].map(
      ([column, alias]) =>
        `${currentFormat && columns.has(column) ? `COALESCE(SUM("${column}"),0)` : 'NULL'} AS "${alias}"`,
    );
    const result = db
      .prepare(
        `SELECT COUNT(*) AS observedCatalogCount, ${sums.join(', ')}
      FROM sync_run_catalog_progress WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
      ${scan.targetsKnown ? 'AND catalog_external_id IN (SELECT value FROM json_each(?))' : ''}`,
      )
      .get(run.id, PROVIDER, textbookId, ...(scan.targetsKnown ? [JSON.stringify(targets)] : []));
    for (const [key, value] of Object.entries(result)) scan[key] = value == null ? null : Number(value);
    if (scan.targetsKnown && scan.scanCompletedCatalogCount != null) {
      scan.unscannedCatalogCount = Math.max(0, scan.selectedCatalogCount - scan.scanCompletedCatalogCount);
    }
  }
  return { format: 'run-coverage-v1', collectorRunId: run.id, textbookExternalId: textbookId, sourceReport, scan };
}

function readRunCoverage(db, run, textbookId, scopeIds) {
  const sealed = run.scope?.sealedCoverageEvidence;
  if (sealed != null) {
    if (
      sealed.format !== 'run-coverage-v1' ||
      sealed.collectorRunId !== run.id ||
      sealed.textbookExternalId !== textbookId ||
      scopeIds.size !== 1 ||
      !sealed.sourceReport ||
      !sealed.scan
    ) {
      throw httpError('封存覆盖记录与运行范围不一致', 409, 'snapshot_incomplete');
    }
    return structuredClone(sealed);
  }
  // Legacy progress rows are not immutable. Only the old frozen declaration
  // can be reported; never reconstruct historical metrics from a live table.
  return captureRunCoverage(db, run, textbookId, scopeIds, { withProgress: false });
}

module.exports = { readRunCoverage, captureRunCoverage };
