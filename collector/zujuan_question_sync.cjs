#!/usr/bin/env node
'use strict';

/*
 * Independent, list-API-only question collector (CLI entry + compatibility
 * re-exports).  Implementation: src/jobs/question_run.cjs (the run),
 * src/cli/question_sync_cli.cjs (arguments), src/sources/zujuan (parsing,
 * requests, session), src/storage (SQLite), src/policies, src/assets.
 * It writes only collector SQLite/run snapshots and never talks to the
 * formal database or service code.
 */

const {
  ALLOWED_ASSET_HOSTS,
} = require('./src/shared/url_policy.cjs');
const {
  DEFAULT_API_PATH,
  DEFAULT_BANK_ID,
  DEFAULT_BANK_PATH,
  DEFAULT_BASE_URL,
  DEFAULT_TEXTBOOK_ID,
  DEFAULT_LIST_CONCURRENCY,
  DEFAULT_PAGE_CAPACITY,
  DEFAULT_PAGINATION_SAFETY_LIMIT,
  PAGE_RESULT,
  MAX_SESSION_SWITCHES,
  DEFAULT_VERIFICATION_PROBE_INTERVAL,
  FORMAL_ASSET_TYPES,
  MAX_RETRIES,
  PROTECTION_MARKERS,
  SITE_PAGE_LIMIT,
} = require('./src/sources/zujuan/constants.cjs');
const {
  QuestionSyncError,
  VerificationRequiredError,
} = require('./src/shared/errors.cjs');
const {
  QuestionSyncStore,
} = require('./src/storage/question_store/index.cjs');
const {
  buildQuestionListBody,
  buildQuestionListRequest,
  responseStatus,
  serializeFormBody,
} = require('./src/sources/zujuan/request.cjs');
const {
  buildScope,
  runSync,
} = require('./src/jobs/question_run.cjs');
const {
  catalogTreeUrl,
  initialTextbookUrl,
} = require('./src/sources/zujuan/urls.cjs');
const {
  classifyAsset,
  finalizeQuestion,
  normalizeAssetType,
  normalizeDisplayTotal,
  parseDifficulty,
  parseQuestionBlock,
  parseQuestionListHtml,
  parseQuestionListPayload,
  parseQuestionListTotalPayload,
} = require('./src/sources/zujuan/question_parser.cjs');
const {
  classifyQuestionResponse,
  isCookieSwitchError,
  isProtectionText,
  classifyListPageContent,
  isPageLevelError,
  isTextbookFatalError,
  looksLikeHtml,
} = require('./src/sources/zujuan/response_classifier.cjs');
const {
  connectCollectorOverCDP,
  launchFreshCollectorSession,
  waitForVerification,
} = require('./src/sources/zujuan/session.cjs');
const {
  decodeHtmlEntities,
  stripHtml,
} = require('./src/shared/html.cjs');
const {
  downloadAsset,
} = require('./src/assets/download.cjs');
const {
  fetchCatalogTree,
  listWindow,
  postQuestionList,
  postQuestionListTotal,
} = require('./src/sources/zujuan/list_window.cjs');
const {
  catalogLastPage,
  catalogSafetyPageLimit,
  growTargetPages,
  validatePageResult,
} = require('./src/policies/pagination.cjs');
const {
  normalizeCatalogTree,
  selectCatalogs,
} = require('./src/sources/zujuan/catalog_parser.cjs');
const {
  normalizeWhitespace,
} = require('./src/shared/utils.cjs');
const {
  parseArgs,
  usage,
  runCli,
} = require('./src/cli/question_sync_cli.cjs');
const {
  retryAfterMs,
  retryDelay,
  createRequestGate,
} = require('./src/policies/retry.cjs');
const {
  validateQuestionListResumeSourceRun,
} = require('./src/storage/resume.cjs');

module.exports = {
  ALLOWED_ASSET_HOSTS,
  DEFAULT_API_PATH,
  DEFAULT_BANK_ID,
  DEFAULT_BANK_PATH,
  DEFAULT_BASE_URL,
  DEFAULT_TEXTBOOK_ID,
  DEFAULT_LIST_CONCURRENCY,
  DEFAULT_PAGE_CAPACITY,
  DEFAULT_PAGINATION_SAFETY_LIMIT,
  PAGE_RESULT,
  MAX_SESSION_SWITCHES,
  DEFAULT_VERIFICATION_PROBE_INTERVAL,
  FORMAL_ASSET_TYPES,
  MAX_RETRIES,
  PROTECTION_MARKERS,
  QuestionSyncError,
  QuestionSyncStore,
  SITE_PAGE_LIMIT,
  VerificationRequiredError,
  buildQuestionListBody,
  buildQuestionListRequest,
  buildScope,
  catalogTreeUrl,
  classifyAsset,
  classifyQuestionResponse,
  connectCollectorOverCDP,
  decodeHtmlEntities,
  downloadAsset,
  fetchCatalogTree,
  finalizeQuestion,
  initialTextbookUrl,
  isCookieSwitchError,
  isProtectionText,
  launchFreshCollectorSession,
  catalogLastPage,
  catalogSafetyPageLimit,
  classifyListPageContent,
  growTargetPages,
  isPageLevelError,
  isTextbookFatalError,
  listWindow,
  looksLikeHtml,
  normalizeAssetType,
  normalizeCatalogTree,
  normalizeDisplayTotal,
  normalizeWhitespace,
  parseArgs,
  parseDifficulty,
  parseQuestionBlock,
  parseQuestionListHtml,
  parseQuestionListPayload,
  parseQuestionListTotalPayload,
  postQuestionList,
  postQuestionListTotal,
  retryAfterMs,
  retryDelay,
  responseStatus,
  createRequestGate,
  selectCatalogs,
  serializeFormBody,
  stripHtml,
  usage,
  validatePageResult,
  validateQuestionListResumeSourceRun,
  waitForVerification,
  runSync,
  runCli,
};

if (require.main === module) runCli();
