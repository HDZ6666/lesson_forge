#!/usr/bin/env node
'use strict';

/*
 * Version / textbook metadata discovery (CLI entry + compatibility
 * re-exports).  Implementation: src/jobs/metadata_run.cjs (the run),
 * src/cli/metadata_sync_cli.cjs (arguments), src/sources/zujuan (parsing,
 * session), src/storage (SQLite).  Discovers versions and textbooks only;
 * never writes MySQL.
 */

const {
  DEFAULT_SEED_URL,
  PROVIDER,
  BLOCK_TEXT_MARKERS,
} = require('./src/sources/zujuan/constants.cjs');
const {
  METADATA_TERMINAL_STATUSES,
  ensureMetadataSnapshotSchema,
  migrateMetadataSnapshotSchema,
} = require('./src/storage/metadata_schema.cjs');
const {
  MetadataStore,
  buildReport,
  formatReport,
  lookupBootstrapChapter,
  lookupTextbookByNames,
  pickExactByName,
} = require('./src/storage/metadata_store.cjs');
const {
  StopCrawlError,
} = require('./src/shared/errors.cjs');
const {
  assertDiscoveryIds,
  normalizeIsNew,
  normalizeTextbookRecords,
  normalizeVersionRecords,
  parseBootstrapChapterFromHtml,
  parseGradeVolume,
  parseTextbooksFromApiHtml,
  parseTextbooksFromHtml,
  parseVersionsFromHtml,
  textbookListSignature,
  validateDiscovery,
} = require('./src/sources/zujuan/metadata_parser.cjs');
const {
  applyInitialChromeMode,
  canFallbackToHeaded,
  chooseInitialHeadless,
  classifyProtectionState,
  closeCollectorContext,
  collectorPageIsBlank,
  collectorPageIsOpen,
  createCollectorPageFactory,
  describeChromeMode,
  dismissStaleCollectorTabs,
  launchCollectorContext,
  minimizeCollectorWindow,
  minimizeCollectorWindowWithLog,
  newCollectorPage,
  prepareCollectorPage,
  profileLooksWarm,
  settleSourcePage,
} = require('./src/sources/zujuan/session.cjs');
const {
  buildChapterTextbooksUrl,
} = require('./src/sources/zujuan/urls.cjs');
const {
  isStableExternalId,
} = require('./src/shared/utils.cjs');
const {
  readBootstrapChapter,
  readVersionsFromPage,
  selectVersion,
  waitForTextbookList,
} = require('./src/jobs/metadata_run.cjs');
const {
  main,
  parseArgs,
  usage,
} = require('./src/cli/metadata_sync_cli.cjs');
const {
  decodeHtmlEntities,
} = require('./src/shared/html.cjs');

module.exports = {
  DEFAULT_SEED_URL,
  METADATA_TERMINAL_STATUSES,
  MetadataStore,
  PROVIDER,
  StopCrawlError,
  assertDiscoveryIds,
  BLOCK_TEXT_MARKERS,
  buildReport,
  applyInitialChromeMode,
  buildChapterTextbooksUrl,
  canFallbackToHeaded,
  chooseInitialHeadless,
  classifyProtectionState,
  closeCollectorContext,
  collectorPageIsBlank,
  collectorPageIsOpen,
  createCollectorPageFactory,
  describeChromeMode,
  dismissStaleCollectorTabs,
  formatReport,
  ensureMetadataSnapshotSchema,
  isStableExternalId,
  launchCollectorContext,
  minimizeCollectorWindow,
  minimizeCollectorWindowWithLog,
  newCollectorPage,
  lookupBootstrapChapter,
  lookupTextbookByNames,
  pickExactByName,
  readBootstrapChapter,
  readVersionsFromPage,
  selectVersion,
  waitForTextbookList,
  normalizeIsNew,
  normalizeTextbookRecords,
  normalizeVersionRecords,
  migrateMetadataSnapshotSchema,
  parseArgs,
  prepareCollectorPage,
  profileLooksWarm,
  parseBootstrapChapterFromHtml,
  parseGradeVolume,
  decodeHtmlEntities,
  parseTextbooksFromApiHtml,
  parseTextbooksFromHtml,
  parseVersionsFromHtml,
  settleSourcePage,
  textbookListSignature,
  usage,
  validateDiscovery,
};

if (require.main === module) {
  main();
}
