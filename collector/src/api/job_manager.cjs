'use strict';

/**
 * Facade: the job manager lives in ./job_manager/ (index + mixins).  Export
 * names are unchanged for routes.cjs, server.cjs and tests.
 */

const { CollectorJobManager } = require('./job_manager/index.cjs');
const {
  ACTIVE_STATUSES,
  COLLECTOR_ROOT,
  METADATA_SCRIPT,
  QUESTION_SCRIPT,
  SITE_PAGE_LIMIT,
  TERMINAL_STATUSES,
} = require('./job_manager/constants.cjs');
const { deploymentBoolean, intInRange } = require('./request_validation.cjs');
const { lastError, looksBlocked, sealOrphanContentRun, sealOrphanMetadataRun } = require('./orphan_runs.cjs');

module.exports = {
  ACTIVE_STATUSES,
  COLLECTOR_ROOT,
  CollectorJobManager,
  METADATA_SCRIPT,
  QUESTION_SCRIPT,
  SITE_PAGE_LIMIT,
  TERMINAL_STATUSES,
  deploymentBoolean,
  intInRange,
  looksBlocked,
  lastError,
  sealOrphanContentRun,
  sealOrphanMetadataRun,
};
