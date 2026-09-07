'use strict';

/**
 * Build the frozen scope of one question-list run from CLI/API options.  The
 * scope is what the run snapshot is keyed by and what a resume must match.
 */

const {
  PROVIDER,
} = require('../sources/zujuan/constants.cjs');

function buildScope(options, catalogCount = 0, selectedCount = 0, summaryInfo = {}) {
  const effectiveCatalogLevels = options.catalogLevels.length > 0
    ? options.catalogLevels
    : [1, 2, 3];
  const explicitlySelectedCatalogs = options.catalogIds.length > 0 || options.catalogLevels.length > 0;
  // Keep the old array form readable for existing callers, but new runs use
  // the single textbook-root total probe instead of a chapter-total sum.
  const summaryCatalogs = Array.isArray(summaryInfo) ? summaryInfo : [];
  const textbookExpectedTotalRaw = Array.isArray(summaryInfo)
    ? null : summaryInfo?.textbookExpectedTotal;
  const textbookExpectedTotalNumber = textbookExpectedTotalRaw == null || textbookExpectedTotalRaw === ''
    ? NaN : Number(textbookExpectedTotalRaw);
  const textbookExpectedTotal = Number.isSafeInteger(textbookExpectedTotalNumber)
    && textbookExpectedTotalNumber >= 0
    ? textbookExpectedTotalNumber
    : null;
  const summaryStrategy = String(
    Array.isArray(summaryInfo) ? 'textbook_root_probe' : (summaryInfo?.summaryStrategy || 'textbook_root_probe'),
  );
  const summaryCatalogIds = Array.isArray(summaryCatalogs)
    ? summaryCatalogs.map((catalog) => String(catalog?.externalId || '')).filter(Boolean)
    : [];
  const summaryLevels = Array.isArray(summaryCatalogs)
    ? summaryCatalogs.map((catalog) => Number(catalog?.level)).filter(Number.isFinite)
    : [];
  return {
    provider: PROVIDER,
    bankId: options.bankId,
    bankPath: options.bankPath,
    textbookId: options.textbookId,
    catalogIds: options.catalogIds,
    chapterIds: [String(options.chapterId || options.textbookId)],
    catalogLevels: effectiveCatalogLevels,
    allCatalogs: !explicitlySelectedCatalogs,
    withinChapterIds: [],
    filters: {
      scene: null,
      questionType: null,
      difficulty: null,
      category: null,
      year: null,
      fresh: false,
      sort: { id: 2, name: '最新' },
    },
    availableCatalogCount: catalogCount,
    selectedCatalogCount: selectedCount,
    // This is the provider's textbook-root total.  It is intentionally kept
    // separate from each catalog progress row, whose counts are page
    // occurrences and whose expected_total is only that node's total.
    textbookExpectedTotal,
    summaryStrategy,
    summaryCatalogIds,
    summaryCatalogLevel: summaryLevels.length > 0 ? Math.min(...summaryLevels) : null,
    catalogSelectionTruncated: !explicitlySelectedCatalogs
      && Number(options.maxCatalogs || 0) > 0
      && selectedCount < catalogCount,
    startPage: options.startPage,
    maxPages: options.maxPages,
    maxPagesProvided: options.maxPagesProvided,
    limit: options.limit,
    downloadAssets: options.downloadAssets,
    contentSource: 'list_api',
    details: false,
    detailFallback: true,
    refreshDetails: false,
    includeVisibleSolutions: false,
    answerStatus: 'not_collected',
    requireDetails: false,
    requireAssets: options.downloadAssets,
    resumeFromRunId: options.resumeRunId,
  };
}

module.exports = { buildScope };
