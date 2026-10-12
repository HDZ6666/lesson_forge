'use strict';

/**
 * Pure classification of provider responses and collector errors.
 *
 * Nothing here touches the network, the browser or SQLite; every function
 * takes already-fetched text/status or an Error and returns a verdict.
 */

const { StopCrawlError, VerificationRequiredError } = require('../../shared/errors.cjs');
const { normalizeId } = require('../../shared/utils.cjs');
const {
  BLOCK_TEXT_MARKERS,
  PAGE_RESULT,
  PROTECTION_MARKERS,
  RETRYABLE_HTTP,
  TEXTBOOK_FATAL_CODES,
} = require('./constants.cjs');

function isProtectionText(value) {
  const text = String(value || '').toLowerCase();
  return PROTECTION_MARKERS.some((marker) => text.includes(String(marker).toLowerCase()));
}

function looksLikeHtml(value) {
  const text = String(value || '')
    .trim()
    .toLowerCase();
  return /^<!doctype\s+html|^<html\b|<body\b|<script\b/.test(text) || isProtectionText(text);
}

/**
 * Parse the provider's JSON envelope when the response body is JSON.  Returns
 * `null` for non-JSON bodies (protection HTML, empty text, truncated output).
 */
function parseJsonEnvelope(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Classify one question list API response.
 *
 * A well-formed provider envelope (`{"code": ..., "data": ...}`) is never a
 * protection page: question stems legitimately contain words such as 验证码,
 * captcha or forbidden (see COL-003), so protection markers are only
 * consulted when the body is not a JSON envelope, or when the envelope itself
 * reports a non-zero code.
 */
function classifyQuestionResponse(result) {
  const response = result && typeof result === 'object' ? result : {};
  const status = Number(response.status || 0);
  const text = String(response.text ?? response.body ?? '');
  if (status === 401 || status === 403) {
    return { kind: 'verification', code: `http_${status}`, status, text };
  }
  if (status === 429) return { kind: 'retry', code: 'http_429', status, text, throttled: true };
  if (RETRYABLE_HTTP.has(status)) {
    return { kind: 'retry', code: `http_${status}`, status, text, throttled: false };
  }
  if (status >= 400) return { kind: 'fatal', code: `http_${status}`, status, text };
  const envelope = parseJsonEnvelope(text);
  if (envelope && envelope.code != null) {
    if (String(envelope.code) === '0') {
      return { kind: 'ok', code: 'ok', status, text, payload: envelope };
    }
    // A provider error envelope carries no question HTML, so protection
    // markers in its message are meaningful evidence.
    if (isProtectionText(text)) return { kind: 'verification', code: 'json_html', status, text };
    return { kind: 'ok', code: 'ok', status, text, payload: envelope };
  }
  if (looksLikeHtml(text)) return { kind: 'verification', code: 'json_html', status, text };
  return { kind: 'ok', code: 'ok', status, text };
}

function isCookieSwitchError(error) {
  if (!error) return false;
  if (error instanceof VerificationRequiredError) return true;
  const code = String(error.code || '');
  if (code === 'waiting_verification' || code === 'json_html') return true;
  return /^http_(401|403|405|429)$/.test(code);
}

function isTextbookFatalError(error) {
  if (!error) return false;
  if (error instanceof StopCrawlError) return true;
  const code = String(error.code || '');
  if (TEXTBOOK_FATAL_CODES.has(code)) return true;
  if (code.startsWith('tree_http_')) return true;
  if (code === 'ERR_SQLITE_ERROR' || code === 'SQLITE_FULL' || code === 'SQLITE_BUSY') return true;
  const message = String(error.message || '');
  if (/database is locked|disk is full|SQLITE_FULL|ENOSPC|no space left/i.test(message)) return true;
  return false;
}

function isPageLevelError(error) {
  if (!error) return false;
  if (isCookieSwitchError(error) || isTextbookFatalError(error)) return false;
  return true;
}

function classifyListPageContent(html, questionIds = []) {
  const ids = Array.isArray(questionIds) ? questionIds.map((value) => normalizeId(value)).filter(Boolean) : [];
  if (ids.length > 0) return PAGE_RESULT.SUCCESS;
  const source = String(html || '');
  if (!source.trim()) return PAGE_RESULT.EMPTY_PAGE;
  if (/quesroot|tk-quest-item|questionid\s*=|exam-item/i.test(source)) return PAGE_RESULT.PARSE_FAILED;
  return PAGE_RESULT.EMPTY_PAGE;
}

function pageResultFromError(error) {
  const code = String(error?.code || '');
  if (code === 'page_duplicate_questions') return PAGE_RESULT.PAGE_DUPLICATE_QUESTIONS;
  if (code === 'pagination_loop') return PAGE_RESULT.DUPLICATE_PAGE;
  if (code === 'list_api_contract') return PAGE_RESULT.PARSE_FAILED;
  return PAGE_RESULT.REQUEST_FAILED;
}

/**
 * Classify a rendered page state (title, visible text, content/challenge
 * probes) for the metadata collector and Chrome session guards.
 */
function classifyProtectionState(state = {}) {
  const title = String(state.title || '');
  const text = String(state.text || '');
  const combined = `${title} ${text}`;
  const lowered = combined.toLowerCase();
  const marker = BLOCK_TEXT_MARKERS.find((item) => lowered.includes(item.toLowerCase())) || null;
  const hasContent = Boolean(state.hasContent);
  const hasChallengeInputs = Boolean(state.hasChallengeInputs);
  return {
    title,
    hasContent,
    hasChallengeInputs,
    marker,
    terminalBlock: Boolean(marker) && !hasContent,
    transientChallenge: hasChallengeInputs && !hasContent && !marker,
  };
}

function protectionStopMessage(state) {
  const marker = state.marker ? ` 标记：${state.marker}` : '';
  const title = state.title ? ` 标题：${state.title}` : '';
  return `站点返回验证/防护页面，任务已熔断。${marker}${title}`.trim();
}

function classifyHtmlProtection(html) {
  const text = String(html || '');
  const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const captcha = /id=["']parm_[01]["']|aliyunCaptcha|滑动验证/i.test(text);
  const hasTextbookMarkup = /id=["']chapter_textbooks["']|chapter-id=|\/zj\d+\//i.test(text);
  return classifyProtectionState({
    title,
    text: `${title} ${stripped}`,
    hasChallengeInputs: captcha,
    hasContent: hasTextbookMarkup && !captcha,
  });
}

module.exports = {
  classifyHtmlProtection,
  classifyListPageContent,
  classifyProtectionState,
  classifyQuestionResponse,
  isCookieSwitchError,
  isPageLevelError,
  isProtectionText,
  isTextbookFatalError,
  looksLikeHtml,
  pageResultFromError,
  parseJsonEnvelope,
  protectionStopMessage,
};
