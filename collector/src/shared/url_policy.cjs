'use strict';

const { StopCrawlError } = require('./errors.cjs');

// Every network request made by any collector must target one of these hosts
// over HTTPS.  The sets are shared so a new entry point cannot silently widen
// the allow-list.
const ALLOWED_PAGE_HOSTS = new Set(['zujuan.xkw.com']);
const ALLOWED_TREE_HOSTS = new Set(['static.zxxk.com']);
const ALLOWED_ASSET_HOSTS = new Set(['staticzujuan.xkw.com', 'img.xkw.com', 'zujuan.xkw.com']);

function defaultMakeError(message, code) {
  return new StopCrawlError(message, code);
}

/**
 * Return the normalized href when `value` is an HTTPS URL on an allowed host,
 * otherwise throw.  `makeError(message, code, cause)` lets each collector keep
 * its own error class (StopCrawlError by default, QuestionSyncError for the
 * question collector).
 */
function assertAllowedUrl(value, hosts, makeError = defaultMakeError) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw makeError(`非法 URL：${value}`, 'host_not_allowed', error);
  }
  if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname)) {
    throw makeError(`拒绝访问未授权域名：${parsed.href}`, 'host_not_allowed');
  }
  return parsed.href;
}

module.exports = {
  ALLOWED_ASSET_HOSTS,
  ALLOWED_PAGE_HOSTS,
  ALLOWED_TREE_HOSTS,
  assertAllowedUrl,
};
