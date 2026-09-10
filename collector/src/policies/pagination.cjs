'use strict';

/**
 * Pagination bounds for one catalog: the safety ceiling, the operator page
 * cap, and how the target page count grows when the provider reports a
 * larger total.  `total` is display-only and never a success criterion.
 */

const { QuestionSyncError } = require('../shared/errors.cjs');
const { normalizeId, sha256 } = require('../shared/utils.cjs');
const {
  DEFAULT_PAGE_CAPACITY,
  DEFAULT_PAGINATION_SAFETY_LIMIT,
  SITE_PAGE_LIMIT,
} = require('../sources/zujuan/constants.cjs');

function catalogSafetyPageLimit(options = {}) {
  const configured = Number(options.safetyPageLimit);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_PAGINATION_SAFETY_LIMIT;
}

function catalogLastPage(options = {}) {
  const safety = catalogSafetyPageLimit(options);
  // The task-level policy cap is deliberately independent from the debug
  // `--max-pages` bound.  When enabled, a catalog may request at most the
  // provider's 1000-page policy window; the caller decides whether reaching
  // this boundary is a normal (policy-limited) completion.
  const policyLimit = options.limitTo1000Pages === true
    ? Math.min(safety, SITE_PAGE_LIMIT)
    : safety;
  if (options.maxPagesProvided) {
    const configured = Number(options.maxPages);
    if (Number.isFinite(configured) && configured > 0) return Math.min(policyLimit, configured);
  }
  return policyLimit;
}

function growTargetPages(currentTarget, maxObservedTotal, pageCapacity = DEFAULT_PAGE_CAPACITY) {
  const capacity = Number(pageCapacity) > 0 ? Number(pageCapacity) : DEFAULT_PAGE_CAPACITY;
  const current = Math.max(0, Number(currentTarget) || 0);
  const total = Number(maxObservedTotal);
  if (!Number.isSafeInteger(total) || total <= 0) return current;
  return Math.max(current, Math.ceil(total / capacity));
}

function validatePageResult(
  parsed,
  pageNumber,
  _expectedPages,
  previousSignatures,
  _previousQuestionIds = null,
  _expectedTotal = null,
) {
  if (!parsed || !Array.isArray(parsed.questions) || !Array.isArray(parsed.questionIds)) {
    throw new QuestionSyncError('题目列表页解析结果不完整。', 'list_api_contract');
  }
  const page = Number(pageNumber);
  if (parsed.questions.length !== parsed.questionIds.length) {
    throw new QuestionSyncError('题目列表页题卡数与题号数不一致。', 'list_api_contract');
  }
  if (parsed.questionIds.some((value) => value == null
    || ['null', 'undefined'].includes(normalizeId(value).toLowerCase())
    || !normalizeId(value))) {
    throw new QuestionSyncError('题目列表页存在空题号。', 'list_api_contract');
  }
  const ids = parsed.questionIds.map((value) => normalizeId(value));
  if (new Set(ids).size !== ids.length) throw new QuestionSyncError('单页题号重复。', 'page_duplicate_questions');
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new QuestionSyncError(`题目列表页码 ${pageNumber} 无效。`, 'pagination_contract');
  }
  if (ids.length === 0) return null;
  const signature = sha256(ids.join(','));
  if (previousSignatures?.has(signature)) {
    throw new QuestionSyncError(`第 ${pageNumber} 页与此前页面重复。`, 'pagination_loop');
  }
  return signature;
}

module.exports = {
  catalogLastPage,
  catalogSafetyPageLimit,
  growTargetPages,
  validatePageResult,
};
