'use strict';

/**
 * The Chrome session one question run works in: launch or attach, recycle at
 * window safe points (COL-016), and release.
 *
 * Everything else in the run reaches the browser through `session.page` and
 * `session.context` at call time, because a recycle replaces both.
 *
 * Ownership rules (unchanged from the inline version):
 *   - an injected context/page (tests) is never closed here, except a tab
 *     this session opened on a CDP-attached browser;
 *   - a CDP-attached browser belongs to someone else: only the tab we opened
 *     is closed, and it is never recycled;
 *   - a browser this run launched is closed on dispose and may be recycled.
 */

const { QuestionSyncError } = require('../../shared/errors.cjs');
const { sleep } = require('../../shared/utils.cjs');
const diagnostics = require('../../shared/diagnostics.cjs');
const { isCookieSwitchError, isTextbookFatalError } = require('../../sources/zujuan/response_classifier.cjs');
const {
  chooseCollectorPage,
  closeCollectorContext,
  connectCollectorOverCDP,
  launchCollectorContext,
  loadPlaywright,
} = require('../../sources/zujuan/session.cjs');
const { navigateToTextbook } = require('../../sources/zujuan/list_window.cjs');
const { initialTextbookUrl } = require('../../sources/zujuan/urls.cjs');

// One Chrome context serving tens of thousands of in-page fetches grows
// steadily (about 10 MiB/min in production) until the host watermark stops
// the whole run.  Closing and reopening the persistent context at a window
// boundary returns that memory while keeping the profile session and the
// page checkpoint, so the run continues instead of sealing.
const DEFAULT_BROWSER_RECYCLE_PAGES = 400;
const DEFAULT_BROWSER_RECYCLE_MB = 1000;
const MIN_PAGES_BETWEEN_PRESSURE_RECYCLES = 40;
const PRESSURE_WAIT_STEP_MS = 5000;

function recycleSetting(value, envName, fallback) {
  const raw = value ?? process.env[envName];
  if (raw == null || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw))) {
    throw new QuestionSyncError(`${envName} 必须是非负整数，0 表示关闭`, 'invalid_option');
  }
  return Number(raw);
}

class BrowserSession {
  /**
   * @param {object} options
   * @param {object} options.opts            run options (headless, cdpUrl, sleepFn, recycle overrides…)
   * @param {object} options.dependencies    test seams: context, page, playwright, reopenBrowser
   * @param {object} options.resourceGuard   ResourceGuard of this run
   * @param {() => number|null} options.browserMb   Chrome process-tree memory reader
   * @param {(stage: string) => void} options.heartbeat
   * @param {() => void} options.assertNotStopped
   */
  constructor({ opts, dependencies = {}, resourceGuard, browserMb, heartbeat, assertNotStopped }) {
    this.opts = opts;
    this.dependencies = dependencies;
    this.resourceGuard = resourceGuard;
    this.browserMb = browserMb;
    this.heartbeat = heartbeat;
    this.assertNotStopped = assertNotStopped;
    this.context = dependencies.context || null;
    this.page = dependencies.page || null;
    this.playwright = dependencies.playwright || null;
    this.connectedOverCDP = false;
    this.ownedPage = false;
    this.ownedBrowser = null;
    this.recycle = {
      pages: recycleSetting(opts.browserRecyclePages, 'COLLECTOR_BROWSER_RECYCLE_PAGES', DEFAULT_BROWSER_RECYCLE_PAGES),
      browserMb: recycleSetting(opts.browserRecycleMb, 'COLLECTOR_BROWSER_RECYCLE_MB', DEFAULT_BROWSER_RECYCLE_MB),
      pressureMinPages: recycleSetting(
        opts.browserPressureMinPages,
        'COLLECTOR_BROWSER_PRESSURE_MIN_PAGES',
        MIN_PAGES_BETWEEN_PRESSURE_RECYCLES,
      ),
      pagesSince: 0,
      savedSince: 0,
      failedSince: 0,
      count: 0,
    };
  }

  get injected() {
    return Boolean(this.dependencies.context || this.dependencies.page);
  }

  /** Launch (or attach over CDP) and open the textbook page. */
  async open() {
    const { opts } = this;
    if (!this.context) {
      this.playwright = this.playwright || (await loadPlaywright());
      if (opts.cdpUrl) {
        const connected = await connectCollectorOverCDP(this.playwright, opts);
        this.context = connected.context;
        this.connectedOverCDP = true;
      } else {
        this.context = await launchCollectorContext(this.playwright, {
          ...opts,
          // New script contract: default is explicitly headed.  The metadata
          // launcher receives the same stable persistent profile path.
          headless: opts.headless === true,
        });
      }
    }
    if (!this.page) {
      if (this.connectedOverCDP) {
        const selected = await chooseCollectorPage(this.context);
        this.page = selected.page;
        this.ownedPage = selected.owned;
      } else {
        this.page = this.context.pages?.()[0] || (await this.context.newPage());
      }
    }
    await navigateToTextbook(this.page, initialTextbookUrl(opts), opts);
  }

  /** Pages fetched since the last recycle (counts toward the page trigger). */
  notePagesFetched(count) {
    this.recycle.pagesSince += Number(count) || 0;
  }

  notePageResult(result) {
    if (['success', 'no_new_questions'].includes(result)) this.recycle.savedSince += 1;
    else if (result !== 'empty_page') this.recycle.failedSince += 1;
  }

  async recoverListResponse() {
    this.assertNotStopped();
    this.opts.sourceControl?.assertAllowed?.();
    if (this.canRecycle()) await this.recycleNow('题目列表持续返回异常内容，保留同一档案恢复');
    else await navigateToTextbook(this.page, initialTextbookUrl(this.opts), this.opts);
  }

  // Only a browser this run launched itself can be recycled.  A CDP-attached
  // browser belongs to someone else, and injected test contexts opt in
  // through `dependencies.reopenBrowser`.
  canRecycle() {
    return (
      typeof this.dependencies.reopenBrowser === 'function' ||
      (!this.injected && !this.connectedOverCDP && this.context != null)
    );
  }

  recycleReason() {
    const { recycle } = this;
    if (recycle.pages > 0 && recycle.pagesSince >= recycle.pages)
      return `已调度 ${recycle.pagesSince} 页（含失败页和补采页）`;
    const current = recycle.browserMb > 0 ? this.browserMb() : null;
    if (current != null && current >= recycle.browserMb) return `Chrome 占用 ${current}MB`;
    const pressure = this.resourceGuard.status({ fresh: true }).pressure;
    if ((pressure === 'soft' || pressure === 'low') && recycle.pagesSince >= recycle.pressureMinPages) {
      return pressure === 'low' ? '主机内存低于保留水位' : '主机内存低于预警水位';
    }
    return null;
  }

  async recycleNow(reason) {
    const before = this.browserMb();
    const pageStats = {
      scheduled: this.recycle.pagesSince,
      saved: this.recycle.savedSince,
      failed: this.recycle.failedSince,
    };
    this.heartbeat('browser_recycle');
    if (typeof this.dependencies.reopenBrowser === 'function') {
      const reopened = await this.dependencies.reopenBrowser({ context: this.context, page: this.page, reason });
      this.context = reopened?.context ?? this.context;
      this.page = reopened?.page ?? this.page;
    } else {
      await closeCollectorContext(this.context);
      this.context = null;
      this.page = null;
      this.context = await launchCollectorContext(this.playwright, {
        ...this.opts,
        headless: this.opts.headless === true,
      });
      this.page = this.context.pages?.()[0] || (await this.context.newPage());
    }
    this.recycle.pagesSince = 0;
    this.recycle.savedSince = 0;
    this.recycle.failedSince = 0;
    this.recycle.count += 1;
    // List requests are built from options, not page state, but they run
    // inside the page origin, so return to the textbook page first.
    await navigateToTextbook(this.page, initialTextbookUrl(this.opts), this.opts);
    const after = this.browserMb();
    console.log(
      `[浏览器] 第 ${this.recycle.count} 次回收（${reason}）：Chrome ${before ?? '?'}MB → ${after ?? '?'}MB；本浏览器调度 ${pageStats.scheduled} 页次，成功保存 ${pageStats.saved} 页次，失败 ${pageStats.failed} 页次`,
    );
    diagnostics.write('browser_recycled', { reason, ...pageStats, beforeMb: before, afterMb: after });
    this.heartbeat('browser_recycled');
  }

  /**
   * The browser context closed under the run (crash, OOM kill of Chrome).
   * Rebuild it a bounded number of times when this run owns the browser and
   * is still allowed to run; otherwise the caller ends the run as a
   * resumable interruption. Stop requests and source pauses are checked
   * first, so a deliberate pause never reopens the browser (spec E10).
   */
  async recoverClosedContext(error) {
    this.closedRecoveries = Number(this.closedRecoveries || 0);
    const limit = recycleSetting(this.opts.closedContextRecoveries, 'COLLECTOR_CLOSED_CONTEXT_RECOVERIES', 2);
    if (!this.canRecycle() || this.closedRecoveries >= limit) return false;
    this.assertNotStopped();
    this.opts.sourceControl?.assertAllowed?.();
    this.closedRecoveries += 1;
    try {
      await this.recycleNow(`浏览器上下文已关闭，第 ${this.closedRecoveries} 次重建`);
    } catch (reopenError) {
      if (isTextbookFatalError(reopenError) && !String(reopenError.code || '').startsWith('browser_context'))
        throw reopenError;
      console.warn(`[浏览器] 关闭后重建失败：${reopenError.message}；原因：${error?.message || ''}`);
      return false;
    }
    return true;
  }

  // Called between windows, where every fetched page is already settled and
  // the checkpoint is durable.  After recycling, a host still under the hard
  // watermark gets the guard's grace period to recover; if it does not, the
  // next guarded request raises resource_pressure exactly as before.
  async safePoint() {
    if (!this.canRecycle()) return;
    const reason = this.recycleReason();
    if (!reason) return;
    try {
      await this.recycleNow(reason);
    } catch (error) {
      if (isTextbookFatalError(error) || isCookieSwitchError(error)) throw error;
      // Never let a reopen failure fall into the per-catalog "skip this
      // point" handler: stop the run as a resumable interrupt instead.
      const failure = new QuestionSyncError(
        `浏览器回收后无法恢复采集页面：${error.message}`,
        'browser_recycle_failed',
        error,
      );
      failure.recycleFailure = true;
      throw failure;
    }
    const waitLimit = Number(this.resourceGuard.limits?.memoryGraceMs || 0);
    const wait = this.opts.sleepFn || sleep;
    let waited = 0;
    while (waited < waitLimit && this.resourceGuard.status({ fresh: true }).pressure === 'low') {
      this.assertNotStopped();
      this.heartbeat('memory_wait');
      await wait(PRESSURE_WAIT_STEP_MS);
      waited += PRESSURE_WAIT_STEP_MS;
    }
  }

  async closeOwnedTab() {
    if (this.ownedPage && this.page && typeof this.page.close === 'function') {
      try {
        await this.page.close();
      } catch {}
    }
  }

  async dispose() {
    try {
      await this.disposeOnce();
    } catch {
      if (this.connectedOverCDP) await this.closeOwnedTab();
      else if (this.context && !this.dependencies.context) await closeCollectorContext(this.context);
    }
  }

  async disposeOnce() {
    if (this.injected) {
      if (this.connectedOverCDP) await this.closeOwnedTab();
      return;
    }
    if (this.connectedOverCDP) {
      await this.closeOwnedTab();
      return;
    }
    if (this.ownedBrowser) {
      try {
        await this.context?.close();
      } catch {}
      try {
        await this.ownedBrowser.close();
      } catch {}
      this.ownedBrowser = null;
      this.context = null;
      this.page = null;
      return;
    }
    if (this.context) {
      await closeCollectorContext(this.context);
      this.context = null;
      this.page = null;
    }
  }
}

module.exports = {
  BrowserSession,
  DEFAULT_BROWSER_RECYCLE_MB,
  DEFAULT_BROWSER_RECYCLE_PAGES,
  MIN_PAGES_BETWEEN_PRESSURE_RECYCLES,
  recycleSetting,
};
