'use strict';

/**
 * One question-list collection run for a single textbook scope.
 *
 * Flow inside runSync (see the numbered section comments):
 *   1 prepare   lock, run row, browser session, textbook page, catalog tree
 *   2 probe     textbook-level total (display only)
 *   3 crawl     per catalog: paging windows, settle each page independently
 *   4 seal      completeness verdict, finishRun, structured sealed/error event
 *   5 dispose   release browser / tab / lock
 * Structured events go to the API manager over IPC; console output stays
 * diagnostic.  This module never touches the formal database or service.
 */

const path = require('node:path');

const {
  QuestionSyncError,
  StopCrawlError,
  VerificationRequiredError,
} = require('../shared/errors.cjs');
const {
  ensureDir,
  normalizeId,
  sha256,
  sleep,
} = require('../shared/utils.cjs');
const { LOCK_SUFFIX, acquireLock: acquireSharedLock } = require('../shared/lock.cjs');
const {
  assertAllowedUrl: assertAllowedUrlShared,
} = require('../shared/url_policy.cjs');
const {
  DEFAULT_CONSECUTIVE_EMPTY_PAGES,
  DEFAULT_LIST_CONCURRENCY,
  DEFAULT_PAGE_CAPACITY,
  DEFAULT_STALL_WINDOWS,
  PAGE_RESULT,
  PROVIDER,
  SITE_PAGE_LIMIT,
} = require('../sources/zujuan/constants.cjs');
const {
  classifyListPageContent,
  isCookieSwitchError,
  isTextbookFatalError,
  pageResultFromError,
} = require('../sources/zujuan/response_classifier.cjs');
const {
  chooseCollectorPage,
  closeCollectorContext,
  connectCollectorOverCDP,
  launchCollectorContext,
  loadPlaywright,
  waitForVerification,
} = require('../sources/zujuan/session.cjs');
const {
  validateQuestionListResumeSourceRun,
} = require('../storage/resume.cjs');
const {
  initialTextbookUrl,
} = require('../sources/zujuan/urls.cjs');
const {
  normalizeDisplayTotal,
} = require('../sources/zujuan/question_parser.cjs');
const {
  normalizeCatalogTree,
  selectCatalogs,
} = require('../sources/zujuan/catalog_parser.cjs');
const {
  catalogLastPage,
  catalogSafetyPageLimit,
  growTargetPages,
} = require('../policies/pagination.cjs');
const { createRequestGate } = require('../policies/retry.cjs');
const {
  fetchCatalogTree,
  listWindow,
  navigateToTextbook,
  postQuestionList,
  postQuestionListTotal,
} = require('../sources/zujuan/list_window.cjs');
const { downloadAsset, prefetchAssets } = require('../assets/download.cjs');
const { QuestionSyncStore } = require('../storage/question_store/index.cjs');
const { saveRawPage } = require('../storage/raw_pages.cjs');
const { createProcessEventEmitter } = require('../jobs/events.cjs');
// This collector reports lock and host-policy failures with its own coded
// error class so the API manager and resume rules can classify them.
const questionSyncErrorFactory = (message, code, cause) => new QuestionSyncError(message, code, cause);
const assertAllowedUrl = (value, hosts) => assertAllowedUrlShared(value, hosts, questionSyncErrorFactory);
const acquireLock = (lockPath) => acquireSharedLock(lockPath, {
  openError: (target, cause) => new QuestionSyncError(`无法创建题库同步锁：${target}`, 'collector_locked', cause),
  conflictError: (target, cause) => new QuestionSyncError(`已有题库同步正在运行：${target}`, 'collector_locked', cause),
});

const { buildScope } = require('./question_scope.cjs');
const { assertMathSource } = require('../sources/registry.cjs');
const { SourceControl } = require('../policies/source_control.cjs');
const { SourceBudget } = require('../policies/source_budget.cjs');
const { ResourceGuard } = require('../policies/resource_guard.cjs');

async function runSync(options, dependencies = {}) {
  const opts = { ...options };
  opts.sourceNamespace = assertMathSource(opts);
  ensureDir(opts.dataDir);
  ensureDir(opts.profileDir);
  const store = dependencies.store || new QuestionSyncStore(opts.dbPath, { dataDir: opts.dataDir });
  opts.sourceControl = new SourceControl(opts.dbPath);
  opts.sourceBudget = new SourceBudget(opts.dbPath, dependencies.sourceBudgetOptions);
  opts.resourceGuard = new ResourceGuard({ ...dependencies.resourceGuardOptions, paths: {
    database: path.dirname(opts.dbPath), data: opts.dataDir, profile: opts.profileDir,
  } });
  const release = acquireLock(`${opts.dbPath}${LOCK_SUFFIX}`);
  const initialScope = buildScope(opts);
  let runId;
  let context = dependencies.context || null;
  let page = dependencies.page || null;
  let playwrightRef = dependencies.playwright || null;
  let connectedOverCDP = false;
  let ownedPage = false;
  let ownedBrowser = null;
  let cookieWaitCycles = 0;
  const counters = {
    pagesOk: 0,
    questionsSeen: 0,
    questionsInserted: 0,
    questionsUpdated: 0,
    assetsDownloaded: 0,
    errors: 0,
  };
  let selectedCatalogs = [];
  let tree = null;
  const requestGate = createRequestGate(opts.delayMin, opts.delayMax);
  const assetCache = new Map();
  let scope = initialScope;
  let finalStatus = 'success';
  let finalMessage = null;
  const events = dependencies.events || createProcessEventEmitter({ stdout: opts.eventsStdout === true });
  let catalogsDone = 0;
  const emitProgress = (state, pageNumber, resultType) => events.emit('progress', {
    runId,
    catalogCount: selectedCatalogs.length,
    catalogsDone,
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

  // SIGTERM/SIGINT from the API manager or a container stop.  Node's default
  // action would exit immediately: no `finally`, Chrome left running with a
  // stale profile lock, run left `running`.  Instead remember the signal and
  // stop at the next safe point (between windows) as a resumable interrupt.
  let stopSignal = null;
  const onStopSignal = (signal) => {
    if (stopSignal) return;
    stopSignal = String(signal || 'SIGTERM');
    console.warn(`[停止] 收到 ${stopSignal}，将在当前窗口结算后封存为可续采运行`);
  };
  const stopHandlers = { SIGTERM: () => onStopSignal('SIGTERM'), SIGINT: () => onStopSignal('SIGINT') };
  const registerStop = dependencies.registerStopSignal || ((handlers) => {
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    return () => {
      for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler);
    };
  });
  const unregisterStop = registerStop(stopHandlers) || (() => {});
  const assertNotStopped = () => {
    opts.sourceBudget.assertRunning();
    if (!stopSignal) return;
    throw new QuestionSyncError(`收到 ${stopSignal}，采集在安全点停止`, 'stop_requested');
  };
  const rssMb = () => Math.round(process.memoryUsage().rss / (1024 * 1024));

  // Assets dominate per-page time (tens of CDN downloads per page).  Fetch a
  // whole window's assets with a bounded pool before settling its pages, so
  // the per-page persist step only reads the cache.  List API pressure is
  // unchanged: this only parallelises static asset hosts.
  async function prefetchWindowAssets(rows) {
    if (!opts.downloadAssets) return null;
    const assets = [];
    for (const row of rows) {
      for (const question of row?.parsed?.questions || []) {
        for (const asset of question.assets || []) assets.push(asset);
      }
    }
    if (!assets.length) return null;
    const summary = await prefetchAssets(assets, {
      concurrency: opts.assetConcurrency,
      cache: assetCache,
      download: (asset) => downloadAsset(context, opts, asset),
      onSuccess: (result) => {
        if (result?.contentSha256) counters.assetsDownloaded += 1;
      },
      onFailure: (error, asset) => {
        console.warn(`[素材] 预取失败：${asset.sourceUrl || asset.url} ${error.message}`);
      },
    });
    if (summary.requested > 0) {
      events.emit('heartbeat', { runId, stage: `assets:${summary.downloaded}/${summary.requested}`, rssMb: rssMb() });
    }
    return summary;
  }

  async function disposeCollectorSession() {
    if (dependencies.context || dependencies.page) {
      if (connectedOverCDP && ownedPage && page && typeof page.close === 'function') {
        try { await page.close(); } catch {}
      }
      return;
    }
    if (connectedOverCDP) {
      if (ownedPage && page && typeof page.close === 'function') {
        try { await page.close(); } catch {}
      }
      return;
    }
    if (ownedBrowser) {
      try { await context?.close(); } catch {}
      try { await ownedBrowser.close(); } catch {}
      ownedBrowser = null;
      context = null;
      page = null;
      return;
    }
    if (context) {
      await closeCollectorContext(context);
      context = null;
      page = null;
    }
  }

  try {
    if (opts.resumeRunId != null) {
      validateQuestionListResumeSourceRun(opts.dbPath, opts.resumeRunId, initialScope);
    }
    runId = store.beginRun(initialScope, {
      resume: opts.resume,
      resumeRunId: opts.resumeRunId,
    });
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
    if (!context) {
      playwrightRef = playwrightRef || await loadPlaywright();
      if (opts.cdpUrl) {
        const connected = await connectCollectorOverCDP(playwrightRef, opts);
        context = connected.context;
        connectedOverCDP = true;
      } else {
        context = await launchCollectorContext(playwrightRef, {
          ...opts,
          // New script contract: default is explicitly headed.  The metadata
          // launcher receives the same stable persistent profile path.
          headless: opts.headless === true,
        });
      }
    }
    if (!page) {
      if (connectedOverCDP) {
        const selected = await chooseCollectorPage(context);
        page = selected.page;
        ownedPage = selected.owned;
      } else {
        page = context.pages?.()[0] || await context.newPage();
      }
    }
    await navigateToTextbook(page, initialTextbookUrl(opts), opts);
    const rawTree = dependencies.catalogTree || await fetchCatalogTree(page, opts);
    tree = normalizeCatalogTree(rawTree, opts);
    const eligibleCatalogs = selectCatalogs(tree, { ...opts, maxCatalogs: 0 });
    selectedCatalogs = opts.maxCatalogs > 0
      ? eligibleCatalogs.slice(0, opts.maxCatalogs)
      : eligibleCatalogs;
    if (selectedCatalogs.length === 0) throw new QuestionSyncError('未选择任何目录。', 'catalog_not_found');
    scope = buildScope(opts, eligibleCatalogs.length, selectedCatalogs.length);
    store.updateRunScope(runId, scope);
    store.saveCatalogTree(runId, opts.textbookId, tree.nodes);
    console.log(`[目录] 全部节点 ${tree.nodes.length}，本次目录 ${selectedCatalogs.length}`);
    events.emit('progress', { runId, catalogCount: selectedCatalogs.length, catalogsDone: 0, pagesOk: 0, questionsSeen: 0 });

    // The provider can return the complete textbook total from the textbook
    // page session.  This is a total-only probe: the response also contains
    // ten question cards, but they must not become a page/checkpoint or
    // question snapshot.  A bounded `--limit` run intentionally skips this
    // extra request: the limit contract is that only complete real API pages
    // are requested and persisted, and the denominator is explicitly
    // unknown for that diagnostic run.
    if (opts.limit > 0) {
      scope = buildScope(
        opts,
        eligibleCatalogs.length,
        selectedCatalogs.length,
        { textbookExpectedTotal: null, summaryStrategy: 'unknown_limited_run',
          scanCatalogIds: selectedCatalogs.map((catalog) => String(catalog.externalId)) },
      );
      persistResumeScope();
      console.log('[统计] --limit 运行跳过教材根目录 total 探针');
    } else {
      let textbookExpectedTotal = null;
      let textbookExpectedTotalObservedAt = null;
      let summaryStrategy = 'textbook_root_probe_unavailable';
      try {
        await requestGate(opts.sleepFn || sleep);
        const textbookRoot = {
          externalId: String(opts.textbookId),
          categoryId: String(opts.textbookId),
          catelogTokpointId: '0',
        };
        const rootProbe = await postQuestionListTotal(page, opts, textbookRoot, 1);
        textbookExpectedTotal = normalizeDisplayTotal(rootProbe?.total);
        if (textbookExpectedTotal == null) {
          console.warn('[统计] 教材根目录 total 不可用，继续采集');
        } else {
          summaryStrategy = 'textbook_root_probe';
          textbookExpectedTotalObservedAt = new Date().toISOString();
          console.log(`[统计] 教材根目录 total=${textbookExpectedTotal}`);
        }
      } catch (error) {
        console.warn(`[统计] 教材根目录 total 探针失败，继续采集：${error.message || error}`);
      }
      scope = buildScope(
        opts,
        eligibleCatalogs.length,
        selectedCatalogs.length,
        { textbookExpectedTotal, textbookExpectedTotalObservedAt, summaryStrategy,
          scanCatalogIds: selectedCatalogs.map((catalog) => String(catalog.externalId)) },
      );
      persistResumeScope();
    }

    const safetyPageLimit = catalogSafetyPageLimit(opts);
    const explicitLastPage = catalogLastPage(opts);
    const capTargetPages = (value) => {
      const target = Math.max(0, Number(value) || 0);
      return opts.limitTo1000Pages === true ? Math.min(explicitLastPage, target) : target;
    };
    const consecutiveEmptyPages = Number(opts.consecutiveEmptyPages) > 0
      ? Number(opts.consecutiveEmptyPages)
      : DEFAULT_CONSECUTIVE_EMPTY_PAGES;
    const stallWindows = Number(opts.stallWindows) > 0
      ? Number(opts.stallWindows)
      : DEFAULT_STALL_WINDOWS;
    const catalogStates = selectedCatalogs.map((catalog) => {
      const filterJson = '{}';
      const scopeKey = sha256(`${PROVIDER}|${opts.textbookId}|${catalog.externalId}|${filterJson}`);
      // A new run must replay a successful source from page 1.  Resume
      // boundaries are run-owned (stale running runs are reused and sealed
      // partial runs are cloned in beginRun); consulting the old mutable
      // provider-wide checkpoint here would silently create an incomplete
      // fresh snapshot after a previous successful run.
      const checkpoint = opts.resume ? store.getRunCheckpoint(runId, scopeKey) : 0;
      const savedPages = opts.resume ? store.getRunPageSignatures(runId, catalog.externalId) : [];
      const savedPageNumbers = new Set(savedPages.map((entry) => Number(entry.pageNumber)));
      const previousSignatures = new Set(savedPages
        .filter((entry) => entry.signature)
        .map((entry) => entry.signature));
      const previousQuestionIds = new Set(savedPages.flatMap((entry) => entry.questionIds));
      const savedProgress = opts.resume
        ? store.getRunCatalogProgress(runId, opts.textbookId, catalog.externalId)
        : null;
      const hasPageOne = savedPageNumbers.has(1);
      const lastSavedPage = savedPages.find((entry) => (
        entry.resultType === PAGE_RESULT.SUCCESS && Number(entry.questionCount || 0) > 0
      )) || null;
      const maxObserved = Number(savedProgress?.maxObservedTotal || savedProgress?.expectedTotal || 0);
      return {
        catalog,
        filterJson,
        scopeKey,
        checkpoint,
        savedPageNumbers,
        previousSignatures,
        previousQuestionIds,
        lastPageSignature: lastSavedPage?.signature || null,
        expectedPages: capTargetPages(savedProgress?.targetPages ?? savedProgress?.expectedPages ?? 0),
        expectedTotal: savedProgress?.expectedTotal ?? null,
        maxObservedTotal: maxObserved || 0,
        targetPages: capTargetPages(growTargetPages(
          savedProgress?.targetPages ?? savedProgress?.expectedPages ?? 0,
          maxObserved || null,
        )),
        emptyStreak: 0,
        zeroNewWindows: 0,
        boundaryProbe: false,
        finished: false,
        resumeHint: resumeHints[String(catalog.externalId)] || null,
        resumeChecked: false,
        // A node with no persisted page 1 must start at page 1 in its normal
        // turn. Resumed nodes with cloned pages continue from checkpoint+1.
        nextPage: hasPageOne ? Math.max(opts.startPage, checkpoint + 1, 2) : 1,
      };
    });
    catalogStates.sort((a, b) => Number(Boolean(a.resumeHint?.finished)) - Number(Boolean(b.resumeHint?.finished)));
    for (const state of catalogStates) {
      store.reopenCatalogProgress(runId, opts.textbookId, state.catalog.externalId);
    }

    const listConcurrency = opts.limit > 0
      ? 1
      : Math.max(1, Number(opts.concurrency) || DEFAULT_LIST_CONCURRENCY);

    const normalizedCatalogOf = (catalog) => ({
      ...catalog,
      chapterExternalId: String(catalog.chapterExternalId || catalog.externalId),
      ancestorIds: catalog.ancestorIds || [catalog.externalId],
    });

    const applyObservedTotal = (state, parsed) => {
      const pageTotal = normalizeDisplayTotal(parsed?.total);
      if (pageTotal == null) return;
      state.expectedTotal = pageTotal;
      state.maxObservedTotal = Math.max(Number(state.maxObservedTotal) || 0, pageTotal);
      state.targetPages = capTargetPages(growTargetPages(state.targetPages, state.maxObservedTotal));
      state.expectedPages = state.targetPages;
    };

    const finishCatalogScan = (state, {
      stalled = false,
      stallReason = null,
      pageLimitReached = false,
      rawSnapshot = null,
    } = {}) => {
      catalogsDone += 1;
      store.completeCatalog({
        runId,
        textbookExternalId: opts.textbookId,
        catalog: normalizedCatalogOf(state.catalog),
        expectedTotal: state.expectedTotal,
        pageCapacity: DEFAULT_PAGE_CAPACITY,
        expectedPages: state.targetPages || state.expectedPages,
        queryFingerprint: state.scopeKey,
        filterJson: state.filterJson,
        rawSnapshot,
        targetPageLimit: opts.limitTo1000Pages === true ? explicitLastPage : null,
        stalled,
        stallReason,
        pageLimitReached,
      });
      state.finished = true;
      const id = String(state.catalog.externalId);
      if (resumeHints[id]) resumeHints[id].finished = !stalled && !pageLimitReached;
      persistResumeScope();
      if (resumeCoverageGaps.includes(id)) {
        store.db.prepare(`UPDATE sync_run_catalog_progress SET scan_complete=0, data_complete=0,
          completion_quality='completed_with_issues', stall_reason='resume_coverage_unverified'
          WHERE run_id=? AND catalog_external_id=?`).run(runId, id);
      }
      const progress = store.getRunCatalogProgress(runId, opts.textbookId, state.catalog.externalId);
      console.log(
        `[列表] catalog=${state.catalog.externalId} scan=${pageLimitReached ? 'limited' : (stalled ? 'stalled' : 'complete')}`
        + ` quality=${progress?.completionQuality || ''} last=${progress?.lastCompletedPage || 0}`
        + ` target=${state.targetPages || 0}`,
      );
    };

    const persistCatalogPage = async (state, pageNumber, parsed, { allowRetry = true } = {}) => {
      const { catalog, filterJson, scopeKey } = state;
      applyObservedTotal(state, parsed);
      const normalizedCatalog = normalizedCatalogOf(catalog);
      const rawSnapshot = saveRawPage(opts, runId, catalog, pageNumber, parsed.rawPayload || parsed.html);
      const ids = (parsed.questionIds || []).map((value) => normalizeId(value)).filter(Boolean);
      const signature = ids.length ? sha256(ids.join(',')) : null;
      let resultType = classifyListPageContent(parsed.html, ids);
      if (ids.length && new Set(ids).size !== ids.length) resultType = PAGE_RESULT.PAGE_DUPLICATE_QUESTIONS;
      else if (ids.length && signature && state.previousSignatures.has(signature)) {
        resultType = PAGE_RESULT.DUPLICATE_PAGE;
      } else if (ids.length) {
        const newCount = ids.filter((id) => !state.previousQuestionIds.has(String(id))).length;
        resultType = newCount > 0 ? PAGE_RESULT.SUCCESS : PAGE_RESULT.NO_NEW_QUESTIONS;
      }

      if ((resultType === PAGE_RESULT.DUPLICATE_PAGE || resultType === PAGE_RESULT.PARSE_FAILED) && allowRetry) {
        try {
          const retried = await postQuestionList(page, opts, catalog, pageNumber, {
            allowVerificationWait: false,
          });
          return persistCatalogPage(state, pageNumber, retried, { allowRetry: false });
        } catch (error) {
          if (isCookieSwitchError(error) || isTextbookFatalError(error)) throw error;
          resultType = pageResultFromError(error);
          store.recordPageAttempt({
            runId,
            textbookExternalId: opts.textbookId,
            catalog: normalizedCatalog,
            pageNumber,
            resultType,
            errorCode: error.code || 'request_failed',
            questionIds: ids,
            queryFingerprint: scopeKey,
            filterJson,
            expectedTotal: state.expectedTotal,
            targetPages: state.targetPages,
            targetPageLimit: opts.limitTo1000Pages === true ? explicitLastPage : null,
            rawSnapshot,
          });
          state.savedPageNumbers.add(Number(pageNumber));
          state.nextPage = Math.max(state.nextPage, Number(pageNumber) + 1);
          state.emptyStreak = 0;
          return { resultType, empty: false, newCount: 0, questions: [] };
        }
      }

      if (resultType === PAGE_RESULT.EMPTY_PAGE) {
        store.recordPageAttempt({
          runId,
          textbookExternalId: opts.textbookId,
          catalog: normalizedCatalog,
          pageNumber,
          resultType,
          questionIds: [],
          queryFingerprint: scopeKey,
          filterJson,
          expectedTotal: state.expectedTotal,
          targetPages: state.targetPages,
          targetPageLimit: opts.limitTo1000Pages === true ? explicitLastPage : null,
          rawSnapshot,
        });
        state.savedPageNumbers.add(Number(pageNumber));
        state.nextPage = Math.max(state.nextPage, Number(pageNumber) + 1);
        state.emptyStreak += 1;
        console.log(`[列表] catalog=${catalog.externalId} page=${pageNumber} empty=1 total=${state.expectedTotal}`);
        emitProgress(state, pageNumber, resultType);
        return { resultType, empty: true, newCount: 0, questions: [] };
      }

      if (resultType !== PAGE_RESULT.SUCCESS) {
        store.recordPageAttempt({
          runId,
          textbookExternalId: opts.textbookId,
          catalog: normalizedCatalog,
          pageNumber,
          resultType,
          errorCode: resultType,
          questionIds: ids,
          queryFingerprint: scopeKey,
          filterJson,
          expectedTotal: state.expectedTotal,
          targetPages: state.targetPages,
          targetPageLimit: opts.limitTo1000Pages === true ? explicitLastPage : null,
          rawSnapshot,
        });
        if (signature) state.previousSignatures.add(signature);
        state.savedPageNumbers.add(Number(pageNumber));
        state.nextPage = Math.max(state.nextPage, Number(pageNumber) + 1);
        state.emptyStreak = 0;
        console.log(`[列表] catalog=${catalog.externalId} page=${pageNumber} result=${resultType} total=${state.expectedTotal}`);
        emitProgress(state, pageNumber, resultType);
        return { resultType, empty: false, newCount: 0, questions: [] };
      }

      state.previousSignatures.add(signature);
      state.lastPageSignature = signature;
      state.savedPageNumbers.add(Number(pageNumber));
      const questions = parsed.questions || [];
      const newIds = ids.filter((id) => !state.previousQuestionIds.has(String(id)));
      for (const questionId of ids) state.previousQuestionIds.add(String(questionId));
      let assetErrorDelta = 0;
      if (opts.downloadAssets) {
        for (const question of questions) {
          const downloaded = [];
          for (const asset of question.assets || []) {
            const sourceUrl = String(asset.sourceUrl || asset.url || '');
            let result = assetCache.get(sourceUrl);
            const wasCached = assetCache.has(sourceUrl);
            if (!wasCached) {
              try {
                result = await downloadAsset(context, opts, asset);
                if (result.contentSha256) counters.assetsDownloaded += 1;
              } catch (error) {
                if (error.blocked || String(error?.code || '') === 'asset_storage_error') throw error;
                result = {
                  ...asset,
                  sourceUrl,
                  url: sourceUrl,
                  downloadFailed: true,
                  errorCode: error.code || 'asset_download_failed',
                  errorMessage: String(error.message || error),
                };
                assetErrorDelta += 1;
                console.warn(`[素材] catalog=${catalog.externalId} page=${pageNumber} 下载失败：${error.message}`);
              }
              assetCache.set(sourceUrl, result);
            } else if (result?.downloadFailed) assetErrorDelta += 1;
            downloaded.push(result);
          }
          question.assets = downloaded;
        }
      }
      const result = store.savePage({
        runId,
        textbookExternalId: opts.textbookId,
        catalog: normalizedCatalog,
        nodes: tree.nodes,
        pageNumber,
        expectedTotal: state.expectedTotal,
        pageCapacity: DEFAULT_PAGE_CAPACITY,
        expectedPages: state.targetPages,
        questions,
        queryFingerprint: scopeKey,
        filterJson,
        rawSnapshot,
        targetPageLimit: opts.limitTo1000Pages === true ? explicitLastPage : null,
      });
      counters.pagesOk += 1;
      counters.questionsSeen += questions.length;
      counters.questionsInserted += result.inserted || 0;
      counters.questionsUpdated += result.updated || 0;
      state.emptyStreak = 0;
      state.nextPage = Math.max(state.nextPage, Number(pageNumber) + 1);
      console.log(`[列表] catalog=${catalog.externalId} page=${pageNumber} questions=${questions.length} total=${state.expectedTotal}`);
      emitProgress(state, pageNumber, PAGE_RESULT.SUCCESS);
      return {
        resultType: PAGE_RESULT.SUCCESS,
        empty: false,
        newCount: newIds.length,
        questions,
        result,
      };
    };

    const settleFetchedPage = async (state, row) => {
      if (row.error) {
        if (isCookieSwitchError(row.error) || isTextbookFatalError(row.error)) throw row.error;
        const resultType = pageResultFromError(row.error);
        store.recordPageAttempt({
          runId,
          textbookExternalId: opts.textbookId,
          catalog: normalizedCatalogOf(state.catalog),
          pageNumber: row.pageNumber,
          resultType,
          errorCode: row.error.code || 'request_failed',
          queryFingerprint: state.scopeKey,
          filterJson: state.filterJson,
          expectedTotal: state.expectedTotal,
          targetPages: state.targetPages,
          targetPageLimit: opts.limitTo1000Pages === true ? explicitLastPage : null,
        });
        state.savedPageNumbers.add(Number(row.pageNumber));
        state.nextPage = Math.max(state.nextPage, Number(row.pageNumber) + 1);
        state.emptyStreak = 0;
        console.warn(`[列表] catalog=${state.catalog.externalId} page=${row.pageNumber} ${resultType}: ${row.error.message}`);
        return { resultType, empty: false, newCount: 0, questions: [] };
      }
      return persistCatalogPage(state, row.pageNumber, row.parsed);
    };

    const windowForState = (state) => {
      const start = Math.max(1, Number(state.nextPage) || 1);
      if (start > explicitLastPage) return [];
      if (start > safetyPageLimit) return [];
      let endBound;
      if (state.boundaryProbe || !state.targetPages) {
        endBound = Math.min(explicitLastPage, safetyPageLimit, start + listConcurrency - 1);
      } else {
        endBound = Math.min(
          explicitLastPage,
          safetyPageLimit,
          Math.max(state.targetPages, start),
          start + listConcurrency - 1,
        );
      }
      return listWindow(start, endBound, listConcurrency);
    };

    async function recoverBlockedSession(reason, error) {
      cookieWaitCycles += 1;
      if (cookieWaitCycles > 2) throw error;
      await waitForVerification(page, {
        ...opts,
        requireProbe: true,
        verificationReason: error?.code || 'waiting_verification',
      });
    }

    async function fetchWindow(state, pageNumbers) {
      events.emit('heartbeat', { runId, stage: `fetch_window:${state.catalog.externalId}:${pageNumbers[0]}`, rssMb: rssMb() });
      const rows = await Promise.all(pageNumbers.map(async (pageNumber) => {
        try {
          const parsed = await postQuestionList(page, opts, state.catalog, pageNumber, {
            allowVerificationWait: false,
          });
          return { pageNumber, parsed, error: null };
        } catch (error) {
          return { pageNumber, parsed: null, error };
        }
      }));
      return rows.sort((left, right) => left.pageNumber - right.pageNumber);
    }

    function beginFetchWindow(state, pageNumbers) {
      try {
        store.upsertFetchWindow({
          runId,
          catalog: state.catalog,
          expectedPages: state.targetPages || state.expectedPages,
          expectedTotal: state.expectedTotal,
          slots: pageNumbers.map((pageNumber, index) => ({
            slot: index + 1,
            pageNumber,
            status: 'fetching',
            line: `catalog=${state.catalog.externalId} page=${pageNumber} 抓取中`
              + (state.expectedTotal == null ? '' : ` total=${state.expectedTotal}`),
          })),
        });
      } catch (error) {
        console.warn(`[进度] 窗口状态写入失败：${error.message}`);
      }
    }

    function noteFetchSlot(state, pageNumber, saved) {
      const resultType = saved?.resultType
        || (saved?.empty ? PAGE_RESULT.EMPTY_PAGE : PAGE_RESULT.SUCCESS);
      const questionCount = Array.isArray(saved?.questions)
        ? saved.questions.length
        : (saved?.empty ? 0 : null);
      let status = 'saved';
      if (saved?.empty || resultType === PAGE_RESULT.EMPTY_PAGE) status = 'empty';
      else if (resultType === PAGE_RESULT.DUPLICATE_PAGE) status = 'duplicate';
      else if (resultType && resultType !== PAGE_RESULT.SUCCESS) status = 'failed';
      try {
        store.updateFetchSlot(runId, pageNumber, {
          status,
          questionCount,
          resultType,
          sourceTotal: state.expectedTotal,
          targetPages: state.targetPages,
          line: `catalog=${state.catalog.externalId} page=${pageNumber}`
            + (questionCount == null ? '' : ` questions=${questionCount}`)
            + (state.expectedTotal == null ? '' : ` total=${state.expectedTotal}`)
            + (status === 'saved' ? '' : ` ${status}`),
        });
      } catch (error) {
        console.warn(`[进度] 窗口页状态写入失败：${error.message}`);
      }
    }

    async function verifyResumeFrontier(state) {
      const hint = state.resumeHint;
      if (!hint || state.resumeChecked || state.nextPage < 2) return;
      state.resumeChecked = true;
      if (hint.lastPage < 3 || !hint.anchorId || opts.limit > 0) return;
      const growth = state.expectedTotal != null && hint.total != null
        ? Math.max(0, state.expectedTotal - hint.total) : 0;
      const boundary = Math.min(explicitLastPage, safetyPageLimit,
        Math.max(2, hint.lastPage + Math.floor(growth / DEFAULT_PAGE_CAPACITY)));
      // A page number is only a search hint. Require the saved boundary ID in
      // a current response; otherwise continue the fresh scan from page 2.
      for (const pageNumber of [boundary, boundary + 1]) {
        if (pageNumber > explicitLastPage || pageNumber > safetyPageLimit) break;
        assertNotStopped();
        await requestGate(opts.sleepFn || sleep);
        const parsed = await postQuestionList(page, opts, state.catalog, pageNumber, { allowVerificationWait: false });
        if (!(parsed.questionIds || []).map(String).includes(String(hint.anchorId))) continue;
        resumeCoverageGaps.push(String(state.catalog.externalId));
        persistResumeScope();
        await persistCatalogPage(state, pageNumber, parsed);
        state.nextPage = pageNumber + 1;
        if (hint.finished && growth < DEFAULT_PAGE_CAPACITY) finishCatalogScan(state);
        console.log(`[续采] catalog=${state.catalog.externalId} 边界题 ${hint.anchorId} 已在当前 page=${pageNumber} 复核`);
        return;
      }
      console.log(`[续采] catalog=${state.catalog.externalId} 旧边界未匹配，继续从前部重新扫描`);
    }

    // All real catalogs start from their own saved checkpoint.  Nodes without
    // a saved page 1 begin at page 1 here; the root total probe above is never
    // represented as a catalog page or question snapshot.  Each concurrent
    // window is settled page-by-page: a failed/duplicate/empty page is
    // recorded and later successes in the same window are still saved.
    for (const state of catalogStates) {
      if (opts.limit > 0 && counters.questionsSeen >= opts.limit) break;
      try {
        catalogPages:
        while (!state.finished) {
          await verifyResumeFrontier(state);
          if (state.finished) break;
          if (opts.limit > 0 && counters.questionsSeen >= opts.limit) break;
          // Check the task policy boundary before the generic safety ceiling.
          // This keeps an explicitly configured safetyPageLimit of 1000 from
          // turning the intentional policy stop into a stalled catalog.
          if (opts.limitTo1000Pages === true && !opts.maxPagesProvided
            && explicitLastPage === SITE_PAGE_LIMIT && state.nextPage > explicitLastPage) {
            finishCatalogScan(state, {
              pageLimitReached: true,
              stallReason: 'page_limit_1000',
            });
            break;
          }
          if (state.nextPage > safetyPageLimit) {
            finishCatalogScan(state, { stalled: true, stallReason: 'pagination_safety_limit' });
            break;
          }
          if (state.nextPage > explicitLastPage) {
            // `--max-pages` is an explicit diagnostic truncation and keeps
            // its historical incomplete-run semantics.
            break;
          }
          if (state.targetPages > 0 && state.nextPage > state.targetPages && !state.boundaryProbe) {
            state.boundaryProbe = true;
          }
          const pageNumbers = windowForState(state);
          if (pageNumbers.length === 0) {
            if (state.targetPages > 0 && state.nextPage > state.targetPages) {
              finishCatalogScan(state);
            }
            break;
          }
          assertNotStopped();
          beginFetchWindow(state, pageNumbers);
          await requestGate(opts.sleepFn || sleep);
          const rows = await fetchWindow(state, pageNumbers);
          let sourcePause = rows.find((row) => row.error?.blocked)?.error;
          if (!sourcePause) {
            try { await prefetchWindowAssets(rows); }
            catch (error) {
              if (!error.blocked) throw error;
              sourcePause = error;
            }
          }
          if (sourcePause) {
            // Settle good responses already in flight. Do not initiate asset
            // requests after the shared pause; missing bytes remain explicit
            // and the import checker can isolate those questions later.
            for (const row of rows) {
              for (const question of row.parsed?.questions || []) {
                for (const asset of question.assets || []) {
                  const url = String(asset.sourceUrl || asset.url || '');
                  if (url && !assetCache.has(url)) assetCache.set(url, {
                    ...asset, sourceUrl: url, downloadFailed: true,
                    errorCode: sourcePause.code, errorMessage: sourcePause.message,
                  });
                }
              }
            }
            for (const row of rows.filter((item) => item.parsed)) {
              const saved = await settleFetchedPage(state, row);
              noteFetchSlot(state, row.pageNumber, saved);
            }
            for (const row of rows.filter((item) => item.error)) {
              store.recordPageAttempt({
                runId, textbookExternalId: opts.textbookId,
                catalog: normalizedCatalogOf(state.catalog), pageNumber: row.pageNumber,
                resultType: PAGE_RESULT.REQUEST_FAILED, errorCode: row.error.code || sourcePause.code,
                queryFingerprint: state.scopeKey, filterJson: state.filterJson,
                expectedTotal: state.expectedTotal, targetPages: state.targetPages,
              });
              noteFetchSlot(state, row.pageNumber, { resultType: PAGE_RESULT.REQUEST_FAILED });
            }
            throw sourcePause;
          }
          const sessionRows = rows.filter((row) => row.error && isCookieSwitchError(row.error));
          if (sessionRows.length) {
            const sessionPages = new Set(sessionRows.map((row) => row.pageNumber));
            let newCount = 0;
            for (const row of rows) {
              if (sessionPages.has(row.pageNumber)) continue;
              const saved = await settleFetchedPage(state, row);
              noteFetchSlot(state, row.pageNumber, saved);
              if (saved.newCount > 0) cookieWaitCycles = 0;
              newCount += Number(saved.newCount || 0);
              if (opts.limit > 0 && counters.questionsSeen >= opts.limit) break catalogPages;
            }
            await recoverBlockedSession(sessionRows[0].error.message, sessionRows[0].error);
            state.nextPage = Math.min(...sessionPages);
            continue;
          }
          let newCount = 0;
          for (const row of rows) {
            const saved = await settleFetchedPage(state, row);
            noteFetchSlot(state, row.pageNumber, saved);
            if (saved.newCount > 0) cookieWaitCycles = 0;
            newCount += Number(saved.newCount || 0);
            if (opts.limit > 0 && counters.questionsSeen >= opts.limit) break catalogPages;
          }
          if (newCount > 0) {
            state.zeroNewWindows = 0;
            if (state.boundaryProbe && state.targetPages > 0 && state.nextPage <= state.targetPages) {
              state.boundaryProbe = false;
            }
          } else {
            state.zeroNewWindows += 1;
          }
          if (state.emptyStreak >= consecutiveEmptyPages) {
            finishCatalogScan(state);
            break;
          }
          if (state.targetPages > 0 && state.nextPage > state.targetPages) {
            if (state.zeroNewWindows >= stallWindows || state.emptyStreak > 0) {
              finishCatalogScan(state);
              break;
            }
            state.boundaryProbe = true;
          } else if (!state.targetPages && state.zeroNewWindows >= stallWindows) {
            finishCatalogScan(state, { stalled: true, stallReason: 'no_new_questions' });
            break;
          }
        }
      } catch (error) {
        if (isCookieSwitchError(error) || isTextbookFatalError(error)) throw error;
        console.warn(`[列表] catalog=${state.catalog.externalId} 跳过当前知识点：${error.message}`);
        try {
          finishCatalogScan(state, {
            stalled: true,
            stallReason: String(error.code || 'catalog_stalled'),
          });
        } catch (finishError) {
          if (isTextbookFatalError(finishError)) throw finishError;
          console.warn(`[列表] catalog=${state.catalog.externalId} 记录跳过状态失败：${finishError.message}`);
        }
      }
    }
    const completeness = store.validateRunCompleteness(runId, scope, selectedCatalogs, counters);
    if (completeness.scanComplete) finalStatus = 'success';
    else if (!completeness.complete) finalStatus = 'interrupted';
    store.finishRun(runId, finalStatus, counters, finalMessage, { ...completeness, scope });
    events.emit('sealed', {
      runId,
      status: finalStatus,
      snapshotComplete: ['success', 'completed'].includes(finalStatus) && completeness.complete === true,
      scanComplete: completeness.scanComplete === true,
      dataComplete: completeness.dataComplete === true,
      completionQuality: completeness.completionQuality,
      message: finalMessage,
      counts: { ...counters },
    });
    return { runId, status: finalStatus, counters, completeness };
  } catch (error) {
    if (['waiting_verification', 'challenge', 'http_401', 'http_403', 'http_405'].includes(error.code)) {
      try { opts.sourceControl.markManual(error.message); }
      catch (pauseError) { console.warn(`[暂停记录失败] ${pauseError.message}`); }
    }
    counters.errors += 1;
    finalMessage = String(error.message || error);
    if (runId) {
      // Error persistence is diagnostic only. A damaged/old database must
      // never replace the original crawl failure with a secondary SQLite
      // error (for example, a missing sync_errors table).
      try {
        store.recordError(runId, 'run', error);
      } catch (recordErrorFailure) {
        console.error(`[错误记录失败] ${recordErrorFailure.message}`);
      }
    }
    if (error instanceof VerificationRequiredError || error.code === 'waiting_verification') finalStatus = 'blocked';
    else if (['network_error', 'navigation_error', 'tree_network_error', 'stop_requested'].includes(String(error.code || ''))
      || /^http_(408|429|5\d\d)$/.test(String(error.code || ''))) finalStatus = 'interrupted';
    else finalStatus = error instanceof StopCrawlError ? 'blocked' : 'failed';
    let completeness = null;
    if (runId) {
      completeness = store.validateRunCompleteness(runId, scope, selectedCatalogs, counters);
      try {
        store.finishRun(runId, finalStatus, counters, finalMessage, { ...completeness, scope });
      } catch (sealError) {
        // The API manager may already have sealed this run (shutdown/abort)
        // before the child reached its safe point; the immutable trigger then
        // rejects a second terminal write.  Keep the original error.
        console.warn(`[封存] 运行 ${runId} 已被封存，跳过重复写入：${sealError.message}`);
      }
    }
    events.emit('error', {
      runId,
      code: error.code || error.name || 'run_failed',
      message: finalMessage,
      recoverable: finalStatus === 'interrupted' || finalStatus === 'blocked',
      blocked: finalStatus === 'blocked',
      stage: 'run',
    });
    error.eventEmitted = true;
    if (runId) {
      events.emit('sealed', {
        runId,
        status: finalStatus,
        snapshotComplete: false,
        scanComplete: completeness?.scanComplete === true,
        dataComplete: completeness?.dataComplete === true,
        completionQuality: completeness?.completionQuality,
        message: finalMessage,
        counts: { ...counters },
      });
    }
    throw error;
  } finally {
    opts.sourceBudget.stopTiming();
    try {
      await disposeCollectorSession();
    } catch {
      if (connectedOverCDP) {
        if (ownedPage && page && typeof page.close === 'function') {
          try { await page.close(); } catch {}
        }
      } else if (context && !dependencies.context) {
        await closeCollectorContext(context);
      }
    }
    unregisterStop();
    store.close();
    release();
  }
}

module.exports = {
  buildScope,
  runSync,
};
