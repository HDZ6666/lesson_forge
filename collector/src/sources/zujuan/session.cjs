'use strict';

/**
 * Chrome session management shared by every zujuan collector.
 *
 * This module owns how a collector obtains a browser context (persistent
 * profile, connect-over-CDP, or a fresh incognito session), how it recognises
 * protection pages, and how it waits for a human to clear a challenge.  It
 * never bypasses a challenge and never closes a browser it did not launch.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');

const { QuestionSyncError, StopCrawlError, VerificationRequiredError } = require('../../shared/errors.cjs');
const { randomBetween, sleep } = require('../../shared/utils.cjs');
const { ALLOWED_PAGE_HOSTS, assertAllowedUrl } = require('../../shared/url_policy.cjs');
const {
  DEFAULT_VERIFICATION_POLL,
  DEFAULT_VERIFICATION_PROBE_INTERVAL,
  DEFAULT_VERIFICATION_TIMEOUT,
  SOURCE_CONTENT_SELECTOR,
} = require('./constants.cjs');
const { classifyProtectionState, isProtectionText, protectionStopMessage } = require('./response_classifier.cjs');

async function loadPlaywright() {
  try {
    return require('playwright-core');
  } catch {
    const configured = process.env.PLAYWRIGHT_CORE_PATH;
    if (!configured) throw new Error('缺少 playwright-core。请先在 collector/ 目录运行 npm install。');
    try {
      const playwright = require(configured);
      console.warn(`[环境] 使用 PLAYWRIGHT_CORE_PATH=${configured}。`);
      return playwright;
    } catch {
      throw new Error(`无法加载 PLAYWRIGHT_CORE_PATH=${configured}。`);
    }
  }
}

function profileLooksWarm(profileDir) {
  const root = String(profileDir || '').trim();
  if (!root) return false;
  const candidates = [path.join(root, 'Default', 'Network', 'Cookies'), path.join(root, 'Default', 'Cookies')];
  return candidates.some((item) => {
    try {
      return fs.existsSync(item) && fs.statSync(item).size > 0;
    } catch {
      return false;
    }
  });
}

function chooseInitialHeadless(options = {}) {
  if (options.headless !== true) return false;
  if (!profileLooksWarm(options.profileDir)) return false;
  return true;
}

function applyInitialChromeMode(options) {
  const requestedHeadless = options.headless !== false;
  options.headless = chooseInitialHeadless(options);
  if (requestedHeadless && options.headless === false) {
    console.log('[环境] 采集档案是冷会话，直接使用有头 Chrome');
  }
  return options;
}

function describeChromeMode(options) {
  return `Chrome ${options.headless ? '无头' : '有头'}，档案${profileLooksWarm(options.profileDir) ? '已有会话' : '冷会话'}`;
}

function canFallbackToHeaded(options, error) {
  if (!options || options.headless !== true) return false;
  return Boolean(error) && error.name === 'StopCrawlError' && error.code === 'challenge';
}

function collectorPageIsOpen(page) {
  if (!page) return false;
  try {
    return typeof page.isClosed !== 'function' || !page.isClosed();
  } catch {
    return false;
  }
}

function collectorPageIsBlank(page) {
  if (!collectorPageIsOpen(page)) return false;
  try {
    const url = String(page.url() || '').trim();
    return url === '' || url === 'about:blank' || url === 'chrome://newtab/';
  } catch {
    return false;
  }
}

async function minimizeCollectorWindow(context, page = null) {
  let target = collectorPageIsOpen(page) ? page : context.pages().find(collectorPageIsOpen);
  let created = false;
  let session;
  try {
    if (!target) {
      target = await context.newPage();
      created = true;
    }
    session = await context.newCDPSession(target);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await session.send('Browser.getWindowBounds', { windowId });
      if (state?.bounds?.windowState === 'minimized') return true;
      if (attempt < 2) await sleep(100);
    }
    return false;
  } catch {
    // Headless, no window, or this Chrome build rejects window-state changes.
    return false;
  } finally {
    if (session && typeof session.detach === 'function') {
      await session.detach().catch(() => {});
    }
    if (created && collectorPageIsOpen(target)) {
      await target.close().catch(() => {});
    }
  }
}

async function minimizeCollectorWindowWithLog(context, options, page = null) {
  if (options?.headless !== false) return true;
  const minimized = await minimizeCollectorWindow(context, page);
  if (minimized) {
    console.log('[环境] Chrome 已最小化，避免挡住当前工作');
  } else {
    console.warn('[环境] Chrome 自动最小化未生效，采集仍会继续');
  }
  return minimized;
}

function markProfileCleanExit(profileDir) {
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  if (!fs.existsSync(prefsPath)) return;
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    if (!prefs.profile || typeof prefs.profile !== 'object') prefs.profile = {};
    prefs.profile.exit_type = 'Normal';
    prefs.profile.exited_cleanly = true;
    fs.writeFileSync(prefsPath, `${JSON.stringify(prefs)}\n`);
  } catch {
    // A unreadable profile must not block a new crawl.
  }
}

async function dismissStaleCollectorTabs(context) {
  const pages = context.pages().filter(collectorPageIsOpen);
  if (pages.length <= 1) return pages[0] || null;
  const keep = pages.find(collectorPageIsBlank) || pages[0];
  for (const page of pages) {
    if (page !== keep) await page.close().catch(() => {});
  }
  return keep;
}

async function prepareCollectorPage(context) {
  const pages = context.pages().filter(collectorPageIsOpen);
  const page = pages.find(collectorPageIsBlank) || pages[0];
  if (page) return page;
  return context.newPage();
}

async function newCollectorPage(context, options) {
  const page = await context.newPage();
  await minimizeCollectorWindowWithLog(context, options, page);
  return page;
}

function createCollectorPageFactory(context, options) {
  let firstPageAvailable = true;
  return async () => {
    if (firstPageAvailable) {
      firstPageAvailable = false;
      const page = await prepareCollectorPage(context);
      await minimizeCollectorWindowWithLog(context, options, page);
      return page;
    }
    return newCollectorPage(context, options);
  };
}

const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Chrome refuses to open a persistent profile whose `SingletonLock` names a
 * live process, and treats a lock from another hostname as "in use on another
 * computer" without checking the pid.  After a hard container restart the
 * old container's hostname/pid stay in the lock and every launch dies with
 * "Target page, context or browser has been closed".  Remove the lock only
 * when it is provably stale: different host, or a dead pid on this host.
 */
function clearStaleProfileLock(profileDir, { hostname = os.hostname(), isAlive = pidAlive } = {}) {
  const root = String(profileDir || '').trim();
  if (!root) return { cleared: false, reason: 'no_profile' };
  const lockPath = path.join(root, 'SingletonLock');
  let target;
  try {
    target = fs.readlinkSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { cleared: false, reason: 'no_lock' };
    if (error?.code === 'EINVAL') {
      // Not a symlink (unexpected); leave it to Chrome.
      return { cleared: false, reason: 'not_symlink' };
    }
    return { cleared: false, reason: error?.code || 'unreadable' };
  }
  const match = /^(.*)-(\d+)$/.exec(String(target));
  const lockHost = match ? match[1] : String(target);
  const lockPid = match ? Number(match[2]) : NaN;
  const sameHost = lockHost === String(hostname);
  if (sameHost && isAlive(lockPid)) return { cleared: false, reason: 'live', lockHost, lockPid };
  for (const name of SINGLETON_FILES) {
    try {
      fs.unlinkSync(path.join(root, name));
    } catch {}
  }
  return {
    cleared: true,
    reason: sameHost ? 'dead_pid' : 'other_host',
    lockHost,
    lockPid: Number.isSafeInteger(lockPid) ? lockPid : null,
  };
}

async function launchCollectorContext(playwright, options) {
  const stale = clearStaleProfileLock(options.profileDir);
  if (stale.cleared) {
    console.warn(`[环境] 清除过期的 Chrome profile 锁（${stale.reason}：${stale.lockHost}-${stale.lockPid ?? '?'}）`);
  }
  markProfileCleanExit(options.profileDir);
  const launchOptions = {
    channel: 'chrome',
    headless: options.headless === true,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (!options.headless) {
    launchOptions.args = [
      '--start-minimized',
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
      '--noerrdialogs',
    ];
  }
  const context = await playwright.chromium.launchPersistentContext(options.profileDir, launchOptions);
  try {
    context.setDefaultTimeout(options.timeout);
    context.setDefaultNavigationTimeout(options.timeout);
    await dismissStaleCollectorTabs(context);
    const page = await prepareCollectorPage(context);
    if (!options.headless) {
      await minimizeCollectorWindowWithLog(context, options, page);
    }
    return context;
  } catch (error) {
    await closeCollectorContext(context);
    throw error;
  }
}

async function closeCollectorContext(context) {
  if (!context) return;
  try {
    await context.close();
  } catch {}
}

async function connectCollectorOverCDP(playwright, options) {
  const cdpUrl = String(options?.cdpUrl || '').trim();
  if (!cdpUrl) return null;
  if (typeof playwright?.chromium?.connectOverCDP !== 'function') {
    throw new QuestionSyncError('当前 Playwright 不支持 connectOverCDP。', 'cdp_unavailable');
  }
  let browser;
  try {
    browser = await playwright.chromium.connectOverCDP(cdpUrl);
  } catch (error) {
    throw new QuestionSyncError(`连接 Chrome CDP 失败：${error.message}`, 'cdp_connect', error);
  }
  const contexts = typeof browser.contexts === 'function' ? browser.contexts() : [];
  const context = contexts[0] || null;
  if (!context) {
    // Do not call browser.close(): the CDP browser belongs to the operator.
    throw new QuestionSyncError('CDP Chrome 没有可用的浏览器上下文。', 'cdp_context');
  }
  return { browser, context };
}

async function chooseCollectorPage(context, preferredPage = null) {
  if (preferredPage) return { page: preferredPage, owned: false };
  // In CDP mode the context carries the operator's cookies/session, but the
  // user's existing tabs remain untouched.  Always use a dedicated tab so a
  // run cannot navigate or close a tab the operator is viewing.
  if (typeof context?.newPage !== 'function') {
    throw new QuestionSyncError('CDP 浏览器没有可用的新建采集 tab。', 'page_unavailable');
  }
  return { page: await context.newPage(), owned: true };
}

async function launchFreshCollectorSession(playwright, options) {
  const launchOptions = {
    channel: 'chrome',
    headless: options.headless === true,
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (options.headless !== true) {
    launchOptions.args = [
      '--start-minimized',
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
      '--noerrdialogs',
    ];
  }
  const browser = await playwright.chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
    });
    context.setDefaultTimeout(options.timeout);
    context.setDefaultNavigationTimeout(options.timeout);
    const page = await context.newPage();
    return { browser, context, page };
  } catch (error) {
    try {
      await browser.close();
    } catch {}
    throw error;
  }
}

async function readProtectionSnapshot(page, contentSelector = SOURCE_CONTENT_SELECTOR) {
  return page.evaluate((selector) => {
    const text = document.body?.innerText || '';
    return {
      title: document.title || '',
      text,
      url: location.href,
      hasChallengeInputs: Boolean(document.querySelector('#parm_0, #parm_1')),
      hasContent: Boolean(document.querySelector(selector)),
    };
  }, contentSelector);
}

async function settleSourcePage(page, options, extras = {}) {
  const contentSelector = extras.contentSelector || SOURCE_CONTENT_SELECTOR;
  const label = extras.label || '来源页';
  const deadline = Date.now() + (options.timeout || 30000);
  let sawChallenge = false;
  let lastState = classifyProtectionState({});
  while (Date.now() < deadline) {
    options.sourceControl?.assertAllowed();
    options.resourceGuard?.assertAllowed();
    try {
      lastState = classifyProtectionState(await readProtectionSnapshot(page, contentSelector));
    } catch (error) {
      if (String(error.message || '').includes('Execution context was destroyed')) {
        await sleep(200);
        continue;
      }
      throw error;
    }
    if (lastState.hasContent) return lastState;
    if (lastState.terminalBlock) {
      throw new StopCrawlError(protectionStopMessage(lastState), 'challenge');
    }
    if (lastState.transientChallenge && !sawChallenge) {
      sawChallenge = true;
      console.warn(`[防护] ${label} 遇到挑战页，等待跳转`);
    }
    await sleep(200);
  }
  if (lastState.terminalBlock || lastState.transientChallenge || lastState.hasChallengeInputs) {
    throw new StopCrawlError(protectionStopMessage(lastState), 'challenge');
  }
  throw new StopCrawlError(`${label} 未出现来源内容（${lastState.title || '无标题'}），可能仍在防护页。`, 'challenge');
}

async function detectBlockedPage(page) {
  const state = classifyProtectionState(await readProtectionSnapshot(page));
  if (state.terminalBlock || (state.hasChallengeInputs && !state.hasContent)) {
    throw new StopCrawlError(protectionStopMessage(state), 'challenge');
  }
  return state;
}

function retryAfterMsFromResponse(response) {
  if (!response) return null;
  const header = response.headers()['retry-after'];
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

async function safeGoto(page, url, gate, options, label) {
  const target = assertAllowedUrl(url, ALLOWED_PAGE_HOSTS);
  const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await gate.wait(label);
    options.sourceControl?.assertAllowed();
    try {
      options.sourceBudget?.request();
      const response = await page.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeout,
      });
      const status = response?.status() || 0;
      options.sourceControl?.observe(status, response?.headers() || {}, { verification: false });
      if ([401, 403].includes(status)) {
        throw new StopCrawlError(`HTTP ${status}，任务已熔断。`, `http_${status}`);
      }
      if (retryableStatuses.has(status)) {
        const retryMs = retryAfterMsFromResponse(response) ?? 1000 * 2 ** attempt + randomBetween(0, 1000);
        if (attempt === 3) throw new StopCrawlError(`HTTP ${status}，重试耗尽。`, `http_${status}`);
        console.warn(`[重试] ${label} 返回 HTTP ${status}，等待 ${(retryMs / 1000).toFixed(1)} 秒`);
        await sleep(retryMs);
        continue;
      }
      if (status >= 400) throw new Error(`${label} 返回 HTTP ${status}`);
      await page.waitForLoadState('domcontentloaded', { timeout: options.timeout });
      await settleSourcePage(page, options, { label });
      return response;
    } catch (error) {
      if (error instanceof StopCrawlError) throw error;
      lastError = error;
      if (attempt === 3) break;
      const backoff = 1000 * 2 ** attempt + randomBetween(0, 1000);
      console.warn(`[重试] ${label} 失败：${error.message}；等待 ${(backoff / 1000).toFixed(1)} 秒`);
      await sleep(backoff);
    }
  }
  throw lastError || new Error(`${label} 失败。`);
}

async function inspectRobots(context, options) {
  const url = new URL('/robots.txt', options.baseUrl).href;
  try {
    options.sourceControl?.assertAllowed();
    options.resourceGuard?.assertAllowed();
    options.sourceBudget?.request();
    const response = await context.request.get(url, {
      timeout: Math.min(options.timeout, 10000),
      failOnStatusCode: false,
    });
    try {
      options.sourceControl?.observe(response.status(), response.headers(), { verification: false });
    } catch (error) {
      try {
        await response.dispose?.();
      } catch {}
      throw error;
    }
    if ([401, 403].includes(response.status())) {
      try {
        await response.dispose?.();
      } catch {}
      return { status: 'unavailable', reason: `HTTP ${response.status()}` };
    }
    const text = await response.text();
    try {
      await response.dispose?.();
    } catch {}
    if (!/^\s*user-agent\s*:/im.test(text)) {
      return { status: 'unknown', reason: '返回内容不是可解析的 robots.txt（可能是 JS 防护页）' };
    }
    const disallows = [];
    let applies = false;
    for (const line of text.split(/\r?\n/)) {
      const cleaned = line.replace(/#.*/, '').trim();
      if (!cleaned) continue;
      const [key, ...rest] = cleaned.split(':');
      const value = rest.join(':').trim();
      if (key.toLowerCase() === 'user-agent') applies = value === '*';
      if (applies && key.toLowerCase() === 'disallow' && value) disallows.push(value);
    }
    const targetPath = `/${options.bankPath}/`;
    const blocked = disallows.some((rule) => rule === '/' || targetPath.startsWith(rule));
    return { status: blocked ? 'disallowed' : 'allowed', disallows };
  } catch (error) {
    if (error.blocked) throw error;
    return { status: 'unknown', reason: error.message };
  }
}

async function bringVerificationPageToFront(page) {
  if (!page || typeof page.bringToFront !== 'function') return false;
  try {
    await page.bringToFront();
    return true;
  } catch {
    return false;
  }
}

async function waitForVerification(page, options = {}) {
  const timeoutValue = Number(options.verificationTimeout ?? DEFAULT_VERIFICATION_TIMEOUT);
  const timeout = Number.isFinite(timeoutValue) && timeoutValue >= 0 ? timeoutValue : DEFAULT_VERIFICATION_TIMEOUT;
  const pollValue = Number(options.verificationPoll ?? DEFAULT_VERIFICATION_POLL);
  const poll = Math.max(100, Number.isFinite(pollValue) ? pollValue : DEFAULT_VERIFICATION_POLL);
  const requiresProbe = options.requireProbe === true;
  options.sourceControl?.assertAllowed();
  const probeValue = Number(options.verificationProbeInterval ?? DEFAULT_VERIFICATION_PROBE_INTERVAL);
  const probeInterval = Math.max(100, Number.isFinite(probeValue) ? probeValue : DEFAULT_VERIFICATION_PROBE_INTERVAL);
  const wait = options.sleepFn || sleep;
  const startedAt = Date.now();
  // Structured hook for the job manager: a human-verification wait is
  // legitimate inactivity, so the caller can keep its stall detector alive.
  const notifyWait = (state) => {
    if (typeof options.onVerificationWait !== 'function') return;
    let url = '';
    try {
      url = state?.url || (typeof page?.url === 'function' ? String(page.url()) : '');
    } catch {}
    try {
      options.onVerificationWait({
        reason: options.verificationReason || 'verification',
        url,
        elapsedMs: Date.now() - startedAt,
      });
    } catch {}
  };
  if (requiresProbe) {
    await bringVerificationPageToFront(page);
    let currentUrl = '';
    try {
      currentUrl = typeof page?.url === 'function' ? String(page.url()) : '';
    } catch {}
    console.warn(
      `[验证] 题目 API 返回 ${options.verificationReason || '验证/防护'}，请在当前 Chrome 窗口人工恢复${currentUrl ? `（${currentUrl}）` : ''}；不会自动绕过滑块。`,
    );
    notifyWait({ url: currentUrl });
  }
  const configuredInitialWait = Number(options.verificationInitialWait ?? poll);
  const initialWait =
    timeout === 0
      ? 0
      : Math.max(0, requiresProbe ? Math.max(configuredInitialWait, probeInterval) : configuredInitialWait);
  if (initialWait > 0) {
    const remaining = Math.max(0, timeout - (Date.now() - startedAt));
    await wait(Math.min(initialWait, remaining));
  }
  let announced = false;
  while (true) {
    let state = { challenge: false, text: '', title: '' };
    if (page && typeof page.evaluate === 'function') {
      try {
        state = await page.evaluate((contentSelector) => {
          const text = document.body?.innerText || '';
          const title = document.title || '';
          const combined = `${title}\n${text}`;
          const hasContent = Boolean(document.querySelector(contentSelector));
          return {
            challenge:
              Boolean(
                document.querySelector(
                  '#parm_0, #parm_1, [class*="slider"], [class*="captcha"], [data-captcha="true"]',
                ),
              ) ||
              (!hasContent &&
                /验证码|滑块|安全验证|请按住滑块|拖动滑块|challenge|captcha|access denied/i.test(combined)),
            hasContent,
            title,
            text: text.slice(0, 1000),
            url: location.href,
          };
        }, SOURCE_CONTENT_SELECTOR);
      } catch (error) {
        state = { challenge: true, text: error.message, title: '' };
      }
    }
    const challenge =
      Boolean(state?.challenge) ||
      (!state?.hasContent && isProtectionText(`${state?.title || ''} ${state?.text || ''}`));
    if (!challenge) {
      if (requiresProbe) {
        console.warn('[验证] 当前页未显示挑战控件；将以间隔 API probe，恢复后继续同一目录/页。');
      }
      return state;
    }
    if (!announced) {
      console.warn('[验证] 检测到验证/防护页面，请在当前 Chrome 窗口人工完成验证；不会自动拖动滑块。');
      announced = true;
    }
    notifyWait(state);
    if (timeout >= 0 && Date.now() - startedAt >= timeout) {
      throw new VerificationRequiredError('人工验证等待超时，已保留当前浏览器档案和页码断点。', state);
    }
    const remaining = Math.max(0, timeout - (Date.now() - startedAt));
    await wait(Math.min(Math.max(100, poll), remaining));
  }
}

module.exports = {
  applyInitialChromeMode,
  bringVerificationPageToFront,
  canFallbackToHeaded,
  chooseCollectorPage,
  chooseInitialHeadless,
  classifyProtectionState,
  clearStaleProfileLock,
  closeCollectorContext,
  collectorPageIsBlank,
  collectorPageIsOpen,
  connectCollectorOverCDP,
  createCollectorPageFactory,
  describeChromeMode,
  detectBlockedPage,
  dismissStaleCollectorTabs,
  inspectRobots,
  launchCollectorContext,
  launchFreshCollectorSession,
  loadPlaywright,
  markProfileCleanExit,
  minimizeCollectorWindow,
  minimizeCollectorWindowWithLog,
  newCollectorPage,
  prepareCollectorPage,
  profileLooksWarm,
  protectionStopMessage,
  readProtectionSnapshot,
  retryAfterMsFromResponse,
  safeGoto,
  settleSourcePage,
  waitForVerification,
};
