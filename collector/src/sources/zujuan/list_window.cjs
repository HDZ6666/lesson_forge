'use strict';

/**
 * Network layer of the question list collector: in-page fetch of the list
 * API, the paging window, the static catalog tree and textbook navigation.
 * Every request runs inside the collector's Chrome page so the anonymous
 * session cookies are reused; protection responses hand over to a human via
 * session.waitForVerification and are never bypassed.
 */

const { QuestionSyncError, VerificationRequiredError } = require('../../shared/errors.cjs');
const { sleep } = require('../../shared/utils.cjs');
const {
  DEFAULT_BASE_URL,
  DEFAULT_VERIFICATION_TIMEOUT,
  MAX_RETRIES,
  RETRYABLE_HTTP,
} = require('./constants.cjs');
const { catalogTreeUrl } = require('./urls.cjs');
const { buildQuestionListRequest, responseHeaders, responseStatus } = require('./request.cjs');
const { classifyQuestionResponse, looksLikeHtml } = require('./response_classifier.cjs');
const { parseQuestionListPayload, parseQuestionListTotalPayload } = require('./question_parser.cjs');
const { waitForVerification } = require('./session.cjs');
const { retryDelay } = require('../../policies/retry.cjs');

async function evaluateFetch(page, url, request) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new QuestionSyncError('缺少可执行 fetch 的采集页面。', 'page_unavailable');
  }
  return page.evaluate(async ({ target, body, headers, credentials }) => {
    try {
      const response = await fetch(target, {
        method: 'POST',
        credentials,
        headers,
        body,
      });
      const text = await response.text();
      const responseHeaders = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      return { status: response.status, headers: responseHeaders, text };
    } catch (error) {
      return {
        status: 0,
        headers: {},
        text: '',
        networkError: String(error?.message || error),
      };
    }
  }, {
    target: url,
    body: request.body,
    headers: request.headers,
    credentials: request.credentials,
  });
}

function listWindow(startPage, lastPage, concurrency) {
  const start = Math.max(1, Number(startPage) || 1);
  const cap = Math.max(1, Number(concurrency) || 1);
  if (!Number.isFinite(Number(lastPage))) {
    return Array.from({ length: cap }, (_, index) => start + index);
  }
  const end = Math.min(Number(lastPage), start + cap - 1);
  if (end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

async function postQuestionList(page, options, catalog, pageNumber, {
  totalOnly = false,
  allowVerificationWait = true,
} = {}) {
  const request = buildQuestionListRequest(options, catalog, pageNumber);
  const wait = options.sleepFn || sleep;
  let retryIndex = 0;
  let networkRetryIndex = 0;
  let verificationCycles = 0;
  let verificationStartedAt = null;
  while (true) {
    options.sourceControl?.assertAllowed();
    options.resourceGuard?.assertAllowed();
    options.sourceBudget?.request();
    const result = await evaluateFetch(page, request.url, request);
    options.sourceControl?.observe(Number(result.status || 0), result.headers);
    const classification = classifyQuestionResponse(result);
    if (classification.kind === 'verification') {
      options.sourceControl?.requireManual('题目列表返回验证/防护，请人工核对后恢复');
      if (!allowVerificationWait) {
        throw new VerificationRequiredError(
          `题目列表返回验证/防护：目录 ${catalog?.externalId || ''} 第 ${pageNumber} 页`,
          classification,
        );
      }
      verificationCycles += 1;
      const maxVerificationCycles = Number(options.maxVerificationCycles);
      if (Number.isFinite(maxVerificationCycles) && maxVerificationCycles >= 0
        && verificationCycles > maxVerificationCycles) {
        throw new VerificationRequiredError(
          `题目列表仍处于验证/防护状态，已等待 ${maxVerificationCycles} 次；请人工恢复后续跑同一页。`,
          classification,
        );
      }
      if (verificationStartedAt == null) verificationStartedAt = Date.now();
      const configuredTimeout = Number(options.verificationTimeout ?? DEFAULT_VERIFICATION_TIMEOUT);
      const elapsed = Date.now() - verificationStartedAt;
      const remainingTimeout = Math.max(0, configuredTimeout - elapsed);
      if (configuredTimeout >= 0 && remainingTimeout <= 0) {
        throw new VerificationRequiredError('人工验证等待超时，已保留当前浏览器档案和页码断点。', classification);
      }
      await waitForVerification(page, {
        ...options,
        requireProbe: true,
        verificationReason: classification.code,
        verificationTimeout: remainingTimeout,
      });
      // Verification is not counted as an API retry.  Once the operator has
      // restored the page, retry exactly this catalog/page request.
      continue;
    }
    if (classification.kind === 'retry') {
      if (retryIndex >= MAX_RETRIES) {
        throw new QuestionSyncError(
          `题目列表请求重试耗尽：HTTP ${classification.status}`,
          classification.code,
          classification,
        );
      }
      const delay = retryDelay(
        classification.throttled ? '429' : 'normal',
        retryIndex,
        result.headers,
        options.randomFn || Math.random,
      );
      retryIndex += 1;
      console.warn(`[重试] 目录 ${catalog?.externalId || ''} 第 ${pageNumber} 页 HTTP ${classification.status}，等待 ${(delay / 1000).toFixed(1)} 秒`);
      await wait(delay);
      continue;
    }
    if (classification.kind === 'fatal') {
      throw new QuestionSyncError(
        `题目列表请求失败：HTTP ${classification.status}`,
        classification.code,
        classification,
      );
    }
    if (result.networkError) {
      if (networkRetryIndex >= MAX_RETRIES) {
        throw new QuestionSyncError(`题目列表网络请求失败：${result.networkError}`, 'network_error', result);
      }
      const delay = retryDelay('normal', networkRetryIndex, {}, options.randomFn || Math.random);
      networkRetryIndex += 1;
      await wait(delay);
      continue;
    }
    try {
      const payload = result.payload
        || classification.payload
        || (result && result.code != null ? result : JSON.parse(String(result.text || '')));
      return totalOnly
        ? parseQuestionListTotalPayload(payload)
        : parseQuestionListPayload(payload, options.baseUrl || DEFAULT_BASE_URL);
    } catch (error) {
      if (error instanceof QuestionSyncError && error.code === 'list_api_contract') throw error;
      if (looksLikeHtml(result.text)) {
        if (!allowVerificationWait) {
          throw new VerificationRequiredError(
            `题目列表返回验证/防护：目录 ${catalog?.externalId || ''} 第 ${pageNumber} 页`,
            { code: 'json_html', text: result.text },
          );
        }
        if (verificationStartedAt == null) verificationStartedAt = Date.now();
        const configuredTimeout = Number(options.verificationTimeout ?? DEFAULT_VERIFICATION_TIMEOUT);
        const elapsed = Date.now() - verificationStartedAt;
        const remainingTimeout = Math.max(0, configuredTimeout - elapsed);
        await waitForVerification(page, {
          ...options,
          requireProbe: true,
          verificationReason: 'json_html',
          verificationTimeout: remainingTimeout,
        });
        continue;
      }
      throw new QuestionSyncError(
        `题目列表接口 JSON 解析失败：${error.message}`,
        'list_api_contract',
      );
    }
  }
}

async function postQuestionListTotal(page, options, catalog, pageNumber) {
  return postQuestionList(page, options, catalog, pageNumber, { totalOnly: true });
}

async function fetchCatalogTree(page, options) {
  const url = catalogTreeUrl(options);
  if (!page || typeof page.evaluate !== 'function') {
    throw new QuestionSyncError('缺少读取目录 JSON 的采集页面。', 'page_unavailable');
  }
  options.sourceControl?.assertAllowed();
  options.resourceGuard?.assertAllowed();
  options.sourceBudget?.request();
  const result = await page.evaluate(async (target) => {
    try {
      const response = await fetch(target, { method: 'GET', credentials: 'omit', cache: 'no-store' });
      return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() };
    } catch (error) {
      return { status: 0, text: '', networkError: String(error?.message || error) };
    }
  }, url);
  options.sourceControl?.observe(Number(result?.status || 0), result?.headers, { verification: false });
  if (result && typeof result === 'object' && Array.isArray(result.children)) return result;
  if (Array.isArray(result)) return result;
  if (result?.networkError) {
    // static.zxxk.com may omit CORS headers on a particular edge.  The
    // browser context still represents the same real Chrome session, so use
    // its request client only as a safe same-session fallback for this public
    // static JSON (never for the question API).
    try {
      const context = typeof page.context === 'function' ? page.context() : null;
      if (context?.request?.get) {
        options.sourceControl?.assertAllowed();
        options.resourceGuard?.assertAllowed();
        options.sourceBudget?.request();
        const response = await context.request.get(url, {
          timeout: options.timeout,
          failOnStatusCode: false,
        });
        const status = responseStatus(response);
        let text;
        try {
          options.sourceControl?.observe(status, responseHeaders(response), { verification: false });
          text = status < 400 ? await response.text() : null;
        } finally { try { await response.dispose?.(); } catch {} }
        if (text != null) return JSON.parse(text);
      }
    } catch (error) { if (error.blocked) throw error; }
    throw new QuestionSyncError(`目录请求失败：${result.networkError}`, 'tree_network_error');
  }
  if (Number(result?.status || 0) >= 400) {
    throw new QuestionSyncError(`目录请求返回 HTTP ${result.status}`, `tree_http_${result.status}`);
  }
  try {
    return JSON.parse(String(result?.text || ''));
  } catch (error) {
    throw new QuestionSyncError(`目录 JSON 解析失败：${error.message}`, 'tree_contract');
  }
}

async function navigateToTextbook(page, url, options) {
  if (!page || typeof page.goto !== 'function') throw new QuestionSyncError('缺少采集页面。', 'page_unavailable');
  let retryIndex = 0;
  let verificationStartedAt = null;
  const wait = options.sleepFn || sleep;
  while (true) {
    let response;
    options.sourceControl?.assertAllowed();
    options.resourceGuard?.assertAllowed();
    options.sourceBudget?.request();
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeout });
    } catch (error) {
      if (retryIndex >= MAX_RETRIES) throw new QuestionSyncError(`打开教材入口失败：${error.message}`, 'navigation_error');
      await wait(retryDelay('normal', retryIndex, {}, options.randomFn || Math.random));
      retryIndex += 1;
      continue;
    }
    const status = responseStatus(response);
    options.sourceControl?.observe(status, responseHeaders(response));
    if (status === 401 || status === 403) {
      if (verificationStartedAt == null) verificationStartedAt = Date.now();
      const configuredTimeout = Number(options.verificationTimeout ?? DEFAULT_VERIFICATION_TIMEOUT);
      const remainingTimeout = Math.max(0, configuredTimeout - (Date.now() - verificationStartedAt));
      await waitForVerification(page, {
        ...options,
        requireProbe: true,
        verificationReason: `http_${status}`,
        verificationTimeout: remainingTimeout,
      });
      continue;
    }
    if (status === 429 || RETRYABLE_HTTP.has(status)) {
      if (retryIndex >= MAX_RETRIES) throw new QuestionSyncError(`教材入口 HTTP ${status} 重试耗尽。`, `http_${status}`);
      await wait(retryDelay(status === 429 ? '429' : 'normal', retryIndex, responseHeaders(response), options.randomFn || Math.random));
      retryIndex += 1;
      continue;
    }
    if (status >= 400) throw new QuestionSyncError(`教材入口 HTTP ${status}`, `http_${status}`);
    await waitForVerification(page, { ...options, verificationInitialWait: 0 });
    return response;
  }
}

module.exports = {
  evaluateFetch,
  fetchCatalogTree,
  listWindow,
  navigateToTextbook,
  postQuestionList,
  postQuestionListTotal,
};
