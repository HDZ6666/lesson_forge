'use strict';

// Source-specific constants for the zujuan (组卷网) public question bank.

const PROVIDER = 'zujuan';
const DEFAULT_BASE_URL = 'https://zujuan.xkw.com';
const DEFAULT_SEED_URL = 'https://zujuan.xkw.com/czsx/zj261314/o2/';
const CHAPTER_TEXTBOOKS_PATH = '/zujuan-api/chaptertextbooks';
const DEFAULT_API_PATH = '/zujuan-api/question/list';
const DEFAULT_BANK_ID = 2;
const DEFAULT_BANK_PATH = 'czsx';
const DEFAULT_TEXTBOOK_ID = '260617';

// Request pacing and bounds for the question list collector.
const DEFAULT_DELAY_MIN = 2500;
const DEFAULT_DELAY_MAX = 4000;
const DEFAULT_TIMEOUT = 30000;
const SITE_PAGE_LIMIT = 1000;
const DEFAULT_PAGE_CAPACITY = 10;
const DEFAULT_PAGINATION_SAFETY_LIMIT = 10000;
const DEFAULT_LIST_CONCURRENCY = 8;
const MAX_LIST_CONCURRENCY = 16;
// Asset (image / formula) downloads hit the static CDN hosts, not the list
// API.  They are prefetched per paging window with this many in flight.
const DEFAULT_ASSET_CONCURRENCY = 8;
const MAX_ASSET_CONCURRENCY = 32;
const COOKIE_SWITCH_WAIT_MS = 3000;
const MAX_SESSION_SWITCHES = 3;
const MAX_RETRIES = 3;
const DEFAULT_CONSECUTIVE_EMPTY_PAGES = 2;
const DEFAULT_STALL_WINDOWS = 2;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const RETRYABLE_HTTP = new Set([408, 500, 502, 503, 504]);

// Per-page outcome vocabulary shared by the collector, its SQLite store and
// the API's live progress projection.
const PAGE_RESULT = Object.freeze({
  SUCCESS: 'success',
  DUPLICATE_PAGE: 'duplicate_page',
  EMPTY_PAGE: 'empty_page',
  PARSE_FAILED: 'parse_failed',
  REQUEST_FAILED: 'request_failed',
  PAGE_DUPLICATE_QUESTIONS: 'page_duplicate_questions',
  NO_NEW_QUESTIONS: 'no_new_questions',
  SAFETY_LIMIT: 'pagination_safety_limit',
});
const SCAN_ISSUE_RESULTS = new Set([
  PAGE_RESULT.DUPLICATE_PAGE,
  PAGE_RESULT.PARSE_FAILED,
  PAGE_RESULT.REQUEST_FAILED,
  PAGE_RESULT.PAGE_DUPLICATE_QUESTIONS,
  PAGE_RESULT.NO_NEW_QUESTIONS,
  PAGE_RESULT.SAFETY_LIMIT,
]);

// Error codes that stop the whole textbook instead of one page.
const TEXTBOOK_FATAL_CODES = new Set([
  'collector_locked',
  'page_unavailable',
  'cdp_unavailable',
  'cdp_connect',
  'cdp_context',
  'navigation_error',
  'tree_network_error',
  'tree_contract',
  'catalog_not_found',
  'checkpoint_contract',
  'asset_storage_error',
  'resume_source_invalid',
  'list_response_unavailable',
  // Operator/manager stop signal: end the whole run at a safe point.
  'stop_requested',
]);

const FORMAL_ASSET_TYPES = Object.freeze(['question_image', 'formula_image', 'svg', 'other']);

// Markers used by the metadata collector to recognise a hard protection page.
const BLOCK_TEXT_MARKERS = [
  '已阻断',
  '阻断页面',
  '安全威胁',
  '访问被阻断',
  '滑动验证',
  '请完成安全验证',
  '访问过于频繁',
  '异常访问',
  '拖动滑块完成拼图',
  '请按住滑块',
  '访问验证',
  '请输入验证码',
  'captcha',
];

// Selector proving a source page rendered real content instead of a
// protection interstitial.
const SOURCE_CONTENT_SELECTOR = '#chapter_textbook_version, .tk-tree, .tk-quest-item, .quest-content .quesroot';

// Markers used by the question list collector for API/HTML protection text.
const PROTECTION_MARKERS = Object.freeze([
  'challenge',
  'captcha',
  '验证码',
  '安全验证',
  '滑块验证',
  '请按住滑块',
  '拖动滑块',
  '访问验证',
  '访问过于频繁',
  '异常访问',
  'cf-chl-',
  'access denied',
  'forbidden',
]);

const DEFAULT_VERIFICATION_TIMEOUT = 10 * 60 * 1000;
const DEFAULT_VERIFICATION_POLL = 1000;
const DEFAULT_VERIFICATION_PROBE_INTERVAL = 5000;

module.exports = {
  BLOCK_TEXT_MARKERS,
  CHAPTER_TEXTBOOKS_PATH,
  COOKIE_SWITCH_WAIT_MS,
  DEFAULT_API_PATH,
  DEFAULT_BANK_ID,
  DEFAULT_BANK_PATH,
  DEFAULT_BASE_URL,
  DEFAULT_CONSECUTIVE_EMPTY_PAGES,
  DEFAULT_ASSET_CONCURRENCY,
  DEFAULT_DELAY_MAX,
  DEFAULT_DELAY_MIN,
  DEFAULT_LIST_CONCURRENCY,
  DEFAULT_PAGE_CAPACITY,
  DEFAULT_PAGINATION_SAFETY_LIMIT,
  DEFAULT_SEED_URL,
  DEFAULT_STALL_WINDOWS,
  DEFAULT_TEXTBOOK_ID,
  DEFAULT_TIMEOUT,
  DEFAULT_VERIFICATION_POLL,
  DEFAULT_VERIFICATION_PROBE_INTERVAL,
  DEFAULT_VERIFICATION_TIMEOUT,
  FORMAL_ASSET_TYPES,
  MAX_ASSET_BYTES,
  MAX_ASSET_CONCURRENCY,
  MAX_LIST_CONCURRENCY,
  MAX_RETRIES,
  MAX_SESSION_SWITCHES,
  PAGE_RESULT,
  PROTECTION_MARKERS,
  PROVIDER,
  RETRYABLE_HTTP,
  SCAN_ISSUE_RESULTS,
  SITE_PAGE_LIMIT,
  SOURCE_CONTENT_SELECTOR,
  TEXTBOOK_FATAL_CODES,
};
