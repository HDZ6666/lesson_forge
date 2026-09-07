'use strict';

/**
 * URL construction and href parsing for zujuan pages and APIs.
 */

const { QuestionSyncError } = require('../../shared/errors.cjs');
const { isStableExternalId, normalizeId } = require('../../shared/utils.cjs');
const {
  CHAPTER_TEXTBOOKS_PATH,
  DEFAULT_API_PATH,
  DEFAULT_BASE_URL,
} = require('./constants.cjs');

function parseCatalogQueryFromHref(value, fallbackCategoryId = null) {
  const source = String(value || '').trim();
  const fallback = normalizeId(fallbackCategoryId);
  if (!source) {
    return {
      categoryId: fallback || null,
      catelogTokpointId: '0',
      parsed: false,
    };
  }
  let pathname = source;
  try { pathname = new URL(source, DEFAULT_BASE_URL).pathname; } catch {}
  const match = pathname.match(/\/zj([^/?#]+)(?:\/ctk([^/?#]+))?/i);
  if (!match) {
    throw new QuestionSyncError(`目录 href 无法解析题目查询参数：${source}`, 'tree_contract');
  }
  return {
    categoryId: normalizeId(match[1]),
    catelogTokpointId: normalizeId(match[2]) || '0',
    parsed: true,
  };
}

function catalogTreeUrl(options) {
  const url = new URL(
    `/zujuan/tree/ct_${options.bankId}_${options.textbookId}.json`,
    options.treeBaseUrl || 'https://static.zxxk.com',
  );
  url.searchParams.set('v', String(options.timestamp || Date.now()));
  url.searchParams.set('withCredentials', 'false');
  return url.href;
}

function initialTextbookUrl(options) {
  return new URL(
    `/${options.bankPath}/zj${options.textbookId}/`,
    options.baseUrl || DEFAULT_BASE_URL,
  ).href;
}

function questionListApiUrl(options) {
  return new URL(options.apiPath || DEFAULT_API_PATH, options.baseUrl || DEFAULT_BASE_URL).href;
}

function textbookSourceUrl(item, options = {}) {
  const href = item.href || item.attributes?.href;
  if (href && !String(href).startsWith('javascript:')) {
    try {
      return new URL(href, options.baseUrl || options.seedUrl || DEFAULT_BASE_URL).href;
    } catch {}
  }
  const id = item.externalTextbookId;
  if (isStableExternalId(id)) {
    const bankPath = options.bankPath || 'czsx';
    const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    return new URL(`/${bankPath}/zj${id}/`, baseUrl).href;
  }
  return null;
}

function buildChapterTextbooksUrl(version, options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const bankPath = options.bankPath || 'czsx';
  const template = version.urlTemplate
    || version.raw?.url
    || version.raw?.attributes?.url
    || version.attributes?.url
    || `/${bankPath}/zj{0}/`;
  const parsed = new URL(CHAPTER_TEXTBOOKS_PATH, baseUrl);
  parsed.searchParams.set('textbookVersionId', String(version.externalVersionId));
  parsed.searchParams.set('url', String(template));
  return parsed.href;
}

module.exports = {
  buildChapterTextbooksUrl,
  catalogTreeUrl,
  initialTextbookUrl,
  parseCatalogQueryFromHref,
  questionListApiUrl,
  textbookSourceUrl,
};
