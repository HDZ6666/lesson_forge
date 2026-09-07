'use strict';

const common = require('./common.cjs');
const { readRunCatalogs } = require('./catalogs.cjs');
const { readLiveRunProgress } = require('./live_progress.cjs');
const { readRunQuestions, readRunQuestion } = require('./questions.cjs');
const { readRunSnapshotPage } = require('./snapshot_page.cjs');
const { readRunAsset } = require('./assets.cjs');
const { readRunSnapshot, readRunSnapshotSummary, readRunSnapshotScopes } = require('./run_snapshot.cjs');
const { contentRunAfter, contentRunWatermark, metadataRunAfter, metadataWatermark } = require('./watermarks.cjs');
const { readCandidates, readMetadataSnapshot, validateMetadataSelection } = require('./metadata.cjs');
const { readCatalogProgress } = require('./catalog_progress.cjs');

module.exports = {
  ENTITIES: common.ENTITIES,
  MAX_CANDIDATE_ROWS: common.MAX_CANDIDATE_ROWS,
  MAX_CATALOG_PAGE_SIZE: common.MAX_CATALOG_PAGE_SIZE,
  MAX_ASSET_BYTES: common.MAX_ASSET_BYTES,
  MAX_SNAPSHOT_PAGE_BYTES: common.MAX_SNAPSHOT_PAGE_BYTES,
  MAX_SNAPSHOT_PAGE_SIZE: common.MAX_SNAPSHOT_PAGE_SIZE,
  MAX_SNAPSHOT_FETCH_BATCH_SIZE: common.MAX_SNAPSHOT_FETCH_BATCH_SIZE,
  MAX_RUN_PAGE_SIZE: common.MAX_RUN_PAGE_SIZE,
  MAX_RUN_PAGE_NUMBER: common.MAX_RUN_PAGE_NUMBER,
  MAX_SELECTED_TEXTBOOKS: common.MAX_SELECTED_TEXTBOOKS,
  PROVIDER: common.PROVIDER,
  contentRunAfter,
  contentRunWatermark,
  metadataRunAfter,
  metadataWatermark,
  readCandidates,
  readCatalogProgress,
  readLiveRunProgress,
  readRunCatalogs,
  readRunAsset,
  readRunQuestion,
  readRunQuestions,
  readRunSnapshot,
  readRunSnapshotPage,
  readRunSnapshotScopes,
  readRunSnapshotSummary,
  readMetadataSnapshot,
  safeExternalId: common.safeExternalId,
  validateMetadataSelection,
};
