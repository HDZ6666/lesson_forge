'use strict';

/**
 * One question-list collection run for a single textbook scope.
 *
 * runSync orchestrates the phases; each phase lives in src/jobs/question/:
 *   1 prepare   lock, run row, browser session (browser_session.cjs), catalog tree
 *   2 probe     textbook-level total (display only)
 *   3 crawl     per catalog paging windows (catalog_crawler.cjs)
 *   4 seal      completeness verdict, finishRun, sealed/error events (run_seal.cjs)
 *   5 dispose   release browser / tab / lock
 * Structured events go to the API manager over IPC; console output stays
 * diagnostic.  This module never touches the formal database or service.
 */

const path = require('node:path');

const { QuestionSyncError } = require('../shared/errors.cjs');
const { ensureDir, sleep } = require('../shared/utils.cjs');
const { LOCK_SUFFIX, acquireLock: acquireSharedLock } = require('../shared/lock.cjs');
const { assertAllowedUrl: assertAllowedUrlShared } = require('../shared/url_policy.cjs');
const { validateQuestionListResumeSourceRun } = require('../storage/resume.cjs');
const { normalizeDisplayTotal } = require('../sources/zujuan/question_parser.cjs');
const { normalizeCatalogTree, selectCatalogs } = require('../sources/zujuan/catalog_parser.cjs');
const { createRequestGate } = require('../policies/retry.cjs');
const { fetchCatalogTree, postQuestionListTotal } = require('../sources/zujuan/list_window.cjs');
const { QuestionSyncStore } = require('../storage/question_store/index.cjs');
const { createProcessEventEmitter } = require('../jobs/events.cjs');
// This collector reports lock and host-policy failures with its own coded
// error class so the API manager and resume rules can classify them.
const questionSyncErrorFactory = (message, code, cause) => new QuestionSyncError(message, code, cause);
const assertAllowedUrl = (value, hosts) => assertAllowedUrlShared(value, hosts, questionSyncErrorFactory);
const acquireLock = (lockPath) =>
  acquireSharedLock(lockPath, {
    openError: (target, cause) => new QuestionSyncError(`无法创建题库同步锁：${target}`, 'collector_locked', cause),
    conflictError: (target, cause) =>
      new QuestionSyncError(`已有题库同步正在运行：${target}`, 'collector_locked', cause),
  });

const { buildScope } = require('./question_scope.cjs');
const { assertMathSource } = require('../sources/registry.cjs');
const { SourceControl } = require('../policies/source_control.cjs');
const { SourceBudget } = require('../policies/source_budget.cjs');
const { ResourceGuard } = require('../policies/resource_guard.cjs');
const { descendantsMemoryMb } = require('../api/process_tree.cjs');
const { BrowserSession } = require('./question/browser_session.cjs');
const { createCatalogCrawler } = require('./question/catalog_crawler.cjs');
const { sealCompleted, sealFailed } = require('./question/run_seal.cjs');

/**
 * Textbook-level total for display.  The provider returns the complete
 * textbook total from the textbook page session.  This is a total-only
 * probe: the response also contains ten question cards, but they must not
 * become a page/checkpoint or question snapshot.  Never fails the run.
 */
async function probeTextbookTotal(page, opts, requestGate) {
  try {
    await requestGate(opts.sleepFn || sleep);
    const textbookRoot = {
      externalId: String(opts.textbookId),
      categoryId: String(opts.textbookId),
      catelogTokpointId: '0',
    };
    const rootProbe = await postQuestionListTotal(page, opts, textbookRoot, 1);
    const total = normalizeDisplayTotal(rootProbe?.total);
    if (total == null) {
      console.warn('[统计] 教材根目录 total 不可用，继续采集');
      return {
        textbookExpectedTotal: null,
        textbookExpectedTotalObservedAt: null,
        summaryStrategy: 'textbook_root_probe_unavailable',
      };
    }
    console.log(`[统计] 教材根目录 total=${total}`);
    return {
      textbookExpectedTotal: total,
      textbookExpectedTotalObservedAt: new Date().toISOString(),
      summaryStrategy: 'textbook_root_probe',
    };
  } catch (error) {
    console.warn(`[统计] 教材根目录 total 探针失败，继续采集：${error.message || error}`);
    return {
      textbookExpectedTotal: null,
      textbookExpectedTotalObservedAt: null,
      summaryStrategy: 'textbook_root_probe_unavailable',
    };
  }
}

/**
 * SIGTERM/SIGINT from the API manager or a container stop.  Node's default
 * action would exit immediately: no `finally`, Chrome left running with a
 * stale profile lock, run left `running`.  Instead remember the signal and
 * stop at the next safe point (between windows) as a resumable interrupt.
 */
function installStopSignal(register, sourceBudget) {
  let stopSignal = null;
  const onStopSignal = (signal) => {
    if (stopSignal) return;
    stopSignal = String(signal || 'SIGTERM');
    console.warn(`[停止] 收到 ${stopSignal}，将在当前窗口结算后封存为可续采运行`);
  };
  const handlers = { SIGTERM: () => onStopSignal('SIGTERM'), SIGINT: () => onStopSignal('SIGINT') };
  const registerStop =
    register ||
    ((entries) => {
      for (const [signal, handler] of Object.entries(entries)) process.on(signal, handler);
      return () => {
        for (const [signal, handler] of Object.entries(entries)) process.removeListener(signal, handler);
      };
    });
  const unregister = registerStop(handlers) || (() => {});
  const assertNotStopped = () => {
    sourceBudget.assertRunning();
    if (!stopSignal) return;
    throw new QuestionSyncError(`收到 ${stopSignal}，采集在安全点停止`, 'stop_requested');
  };
  return { assertNotStopped, unregister };
}

/**
 * Flow:
 *   1 prepare   lock, run row, browser session, textbook page, catalog tree
 *   2 probe     textbook-level total (display only)
 *   3 crawl     createCatalogCrawler: per catalog, paging windows
 *   4 seal      sealCompleted / sealFailed
 *   5 dispose   release browser / tab / lock
 */
async function runSync(options, dependencies = {}) {
  const opts = { ...options };
  opts.sourceNamespace = assertMathSource(opts);
  ensureDir(opts.dataDir);
  ensureDir(opts.profileDir);
  const store = dependencies.store || new QuestionSyncStore(opts.dbPath, { dataDir: opts.dataDir });
  opts.sourceControl = new SourceControl(opts.dbPath);
  opts.sourceBudget = new SourceBudget(opts.dbPath, dependencies.sourceBudgetOptions);
  opts.resourceGuard = new ResourceGuard({
    ...dependencies.resourceGuardOptions,
    paths: {
      database: path.dirname(opts.dbPath),
      data: opts.dataDir,
      profile: opts.profileDir,
    },
  });
  const release = acquireLock(`${opts.dbPath}${LOCK_SUFFIX}`);
  const initialScope = buildScope(opts);
  let runId;
  const counters = {
    pagesOk: 0,
    questionsSeen: 0,
    questionsInserted: 0,
    questionsUpdated: 0,
    assetsDownloaded: 0,
    errors: 0,
  };
  const progress = { catalogsDone: 0 };
  let selectedCatalogs = [];
  const requestGate = createRequestGate(opts.delayMin, opts.delayMax);
  let scope = initialScope;
  const events = dependencies.events || createProcessEventEmitter({ stdout: opts.eventsStdout === true });
  const emitProgress = (state, pageNumber, resultType) =>
    events.emit('progress', {
      runId,
      catalogCount: selectedCatalogs.length,
      catalogsDone: progress.catalogsDone,
      pagesOk: counters.pagesOk,
      questionsSeen: counters.questionsSeen,
      assetsDownloaded: counters.assetsDownloaded,
      errors: counters.errors,
      catalogExternalId: state?.catalog?.externalId,
      pageNumber,
      resultType,
      sourceTotal: state?.expectedTotal,
    });
  opts.onVerificationWait = (info) => events.emit('verification_wait', { runId, ...info });

  const { assertNotStopped, unregister: unregisterStop } = installStopSignal(
    dependencies.registerStopSignal,
    opts.sourceBudget,
  );
  const rssMb = () => Math.round(process.memoryUsage().rss / (1024 * 1024));
  const browserMb = dependencies.browserMemoryMb || (() => descendantsMemoryMb(process.pid));
  const heartbeat = (stage) => events.emit('heartbeat', { runId, stage, rssMb: rssMb(), browserRssMb: browserMb() });
  const session = new BrowserSession({
    opts,
    dependencies,
    resourceGuard: opts.resourceGuard,
    browserMb,
    heartbeat,
    assertNotStopped,
  });

  try {
    // 1 prepare
    if (opts.resumeRunId != null) {
      validateQuestionListResumeSourceRun(opts.dbPath, opts.resumeRunId, initialScope);
    }
    runId = store.beginRun(initialScope, {
      resume: opts.resume,
      resumeRunId: opts.resumeRunId,
    });
    opts.runId = runId;
    let resumeHints = {};
    if (store.lastBeginMeta?.reused || store.lastBeginMeta?.clonedFrom) {
      resumeHints = store.resetRunScan(runId);
      console.log('[续采] 保留旧成果，刷新首屏；按来源题 ID 核对旧边界后继续未覆盖尾段');
    }
    const resumeCoverageGaps = [];
    const persistResumeScope = () => {
      scope.resumeScanHints = resumeHints;
      scope.resumeCoverageGaps = resumeCoverageGaps;
      store.updateRunScope(runId, scope);
    };
    persistResumeScope();
    console.log(`run=${runId}`);
    events.emit('run_created', {
      runId,
      runType: 'content',
      textbookExternalId: opts.textbookId,
      resumedFromRunId: opts.resumeRunId,
    });
    opts.sourceControl.assertAllowed();
    opts.resourceGuard.assertAllowed();
    opts.sourceBudget.startRun(`content:${runId}`, 'content');
    opts.sourceBudget.startTiming();
    await session.open();
    const rawTree = dependencies.catalogTree || (await fetchCatalogTree(session.page, opts));
    const tree = normalizeCatalogTree(rawTree, opts);
    const eligibleCatalogs = selectCatalogs(tree, { ...opts, maxCatalogs: 0 });
    selectedCatalogs = opts.maxCatalogs > 0 ? eligibleCatalogs.slice(0, opts.maxCatalogs) : eligibleCatalogs;
    if (selectedCatalogs.length === 0) throw new QuestionSyncError('未选择任何目录。', 'catalog_not_found');
    scope = buildScope(opts, eligibleCatalogs.length, selectedCatalogs.length);
    store.updateRunScope(runId, scope);
    store.saveCatalogTree(runId, opts.textbookId, tree.nodes);
    console.log(`[目录] 全部节点 ${tree.nodes.length}，本次目录 ${selectedCatalogs.length}`);
    events.emit('progress', {
      runId,
      catalogCount: selectedCatalogs.length,
      catalogsDone: 0,
      pagesOk: 0,
      questionsSeen: 0,
    });

    // 2 probe.  A bounded `--limit` run intentionally skips this extra
    // request: the limit contract is that only complete real API pages are
    // requested and persisted, and the denominator is explicitly unknown for
    // that diagnostic run.
    const scanCatalogIds = selectedCatalogs.map((catalog) => String(catalog.externalId));
    if (opts.limit > 0) {
      scope = buildScope(opts, eligibleCatalogs.length, selectedCatalogs.length, {
        textbookExpectedTotal: null,
        summaryStrategy: 'unknown_limited_run',
        scanCatalogIds,
      });
      persistResumeScope();
      console.log('[统计] --limit 运行跳过教材根目录 total 探针');
    } else {
      const probe = await probeTextbookTotal(session.page, opts, requestGate);
      scope = buildScope(opts, eligibleCatalogs.length, selectedCatalogs.length, { ...probe, scanCatalogIds });
      persistResumeScope();
    }

    // 3 crawl
    const crawler = createCatalogCrawler({
      opts,
      store,
      runId,
      tree,
      session,
      counters,
      progress,
      selectedCatalogs,
      emitProgress,
      heartbeat,
      assertNotStopped,
      requestGate,
      assetCache: new Map(),
      resumeHints,
      resumeCoverageGaps,
      persistResumeScope,
      // The interrupted execution this run continues, if any: its saved
      // results are carried over, so an unfinished head may resume.
      resumedFromRunId: store.lastBeginMeta?.clonedFrom ?? (store.lastBeginMeta?.reused ? runId : null),
    });
    await crawler.crawlAll();

    // 4 seal
    return sealCompleted({ store, events, runId, scope, selectedCatalogs, counters });
  } catch (error) {
    sealFailed({ store, events, runId, scope, selectedCatalogs, counters, sourceControl: opts.sourceControl }, error);
    throw error;
  } finally {
    // 5 dispose
    opts.sourceBudget.stopTiming();
    await session.dispose();
    unregisterStop();
    store.close();
    release();
  }
}

module.exports = {
  buildScope,
  runSync,
};
