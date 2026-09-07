'use strict';

/**
 * Request construction and response accessors for the question list API.
 * The body is form-urlencoded because `page.evaluate` receives it by
 * structured clone and `fetch` would otherwise stringify an object.
 */

const { DEFAULT_BANK_ID } = require('./constants.cjs');
const { questionListApiUrl } = require('./urls.cjs');

function buildQuestionListBody(options, catalog, pageNumber) {
  const node = catalog || {};
  return {
    pageName: 'zj',
    bankId: String(options.bankId ?? DEFAULT_BANK_ID),
    courseId: '0',
    canTreeMultiple: 'false',
    canCategoryId: 'true',
    'categoryIds[0]': '0',
    quesType: '0',
    quesDiff: '0',
    difficultyMin: '-1',
    difficultyMax: '-1',
    quesYear: '0',
    paperTypeId: '0',
    scenarioizedTypeId: '0',
    tagId: '0',
    provinceId: '-1',
    learngrade: '0',
    term: '0',
    orderBy: '2',
    curPage: String(pageNumber),
    quesAttributeId: '0',
    examMethodId: '0',
    isFresh: '0',
    treeMultiple: 'false',
    categoryId: String(node.categoryId ?? node.externalId ?? '0'),
    catelogTokpointId: String(node.catelogTokpointId ?? '0'),
  };
}

function serializeFormBody(body) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body || {})) form.set(key, String(value ?? ''));
  return form.toString();
}

function buildQuestionListRequest(options, catalog, pageNumber) {
  const body = buildQuestionListBody(options, catalog, pageNumber);
  return {
    url: questionListApiUrl(options),
    // page.evaluate receives this value by structured clone.  Pass the
    // actual form-urlencoded string, never the body object (which fetch
    // would stringify as "[object Object]").
    body: serializeFormBody(body),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    credentials: 'include',
  };
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers === 'object' && !Array.isArray(headers)) {
    return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
      String(key).toLowerCase(), String(value),
    ]));
  }
  return {};
}

function responseStatus(response) {
  if (!response) return 0;
  try {
    if (typeof response.status === 'function') return Number(response.status()) || 0;
  } catch {}
  return Number(response.status || 0) || 0;
}

function responseHeaders(response) {
  if (!response) return {};
  try {
    if (typeof response.headers === 'function') return response.headers() || {};
  } catch {}
  return response.headers && typeof response.headers === 'object' ? response.headers : {};
}

module.exports = {
  buildQuestionListBody,
  buildQuestionListRequest,
  normalizeHeaders,
  responseHeaders,
  responseStatus,
  serializeFormBody,
};
