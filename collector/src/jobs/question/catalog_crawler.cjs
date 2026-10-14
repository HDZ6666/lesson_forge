'use strict';

/**
 * The crawl phase of one question run: per catalog, paging windows fetched
 * concurrently and settled page by page.
 *
 * createCatalogCrawler(ctx) builds the per-catalog paging state from the
 * run's checkpoints and returns { catalogStates, crawlAll }.  crawlAll()
 * walks every selected catalog; a catalog-level failure marks that catalog
 * stalled and moves on, while session, textbook-fatal and browser-recycle
 * failures propagate and end the run.
 *
 * The browser is always reached through ctx.session (page/context change
 * when the session recycles), and the counters object is shared with the
 * run so the seal step sees the totals.
 */

const { normalizeId, sha256, sleep } = require('../../shared/utils.cjs');
const {
  DEFAULT_CONSECUTIVE_EMPTY_PAGES,
  DEFAULT_LIST_CONCURRENCY,
  DEFAULT_PAGE_CAPACITY,
  DEFAULT_STALL_WINDOWS,
  PAGE_RESULT,
  PROVIDER,
  SITE_PAGE_LIMIT,
} = require('../../sources/zujuan/constants.cjs');
const {
  classifyListPageContent,
  closedContextError,
  isClosedContextError,
  isCookieSwitchError,
  isTextbookFatalError,
  pageResultFromError,
} = require('../../sources/zujuan/response_classifier.cjs');
const { waitForVerification } = require('../../sources/zujuan/session.cjs');
const { normalizeDisplayTotal } = require('../../sources/zujuan/question_parser.cjs');
const { catalogLastPage, catalogSafetyPageLimit, growTargetPages } = require('../../policies/pagination.cjs');
const { listWindow, postQuestionList } = require('../../sources/zujuan/list_window.cjs');
const { downloadAsset, prefetchAssets } = require('../../assets/download.cjs');
const { saveRawPage } = require('../../storage/raw_pages.cjs');
const {
  createJoinTracker,
  nextBaseline,
  planAfterJoin,
  tuning: incrementalTuning,
  usableBaseline,
} = require('../../policies/incremental_window.cjs');

/**
 * @param {object} ctx
 * @param {object} ctx.opts, ctx.store, ctx.session, ctx.events
 * @param {number} ctx.runId
 * @param {object} ctx.tree                 normalized catalog tree
 * @param {object[]} ctx.selectedCatalogs
 * @param {object} ctx.counters             shared run counters (mutated)
 * @param {{catalogsDone: number}} ctx.progress   shared progress (mutated)
 * @param {Function} ctx.emitProgress, ctx.heartbeat, ctx.assertNotStopped, ctx.requestGate
 * @param {Map} ctx.assetCache
 * @param {object} ctx.resumeHints          per-catalog resume hints (mutated)
 * @param {string[]} ctx.resumeCoverageGaps (mutated)
 * @param {Function} ctx.persistResumeScope
 */
function createCatalogCrawler(ctx) {
  const {
    opts,
    store,
    runId,
    tree,
    session,
    counters,
    progress: runProgress,
    selectedCatalogs,
    emitProgress,
    heartbeat,
    assertNotStopped,
    requestGate,
    assetCache,
    resumeHints,
    resumeCoverageGaps,
    persistResumeScope,
    resumedFromRunId = null,
  } = ctx;
  let cookieWaitCycles = 0;

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
      download: (asset) => downloadAsset(session.context, opts, asset),
      onSuccess: (result) => {
        if (result?.contentSha256) counters.assetsDownloaded += 1;
      },
      onFailure: (error, asset) => {
        console.warn(`[素材] 预取失败：${asset.sourceUrl || asset.url} ${error.message}`);
      },
    });
    if (summary.requested > 0) {
      heartbeat(`assets:${summary.downloaded}/${summary.requested}`);
    }
    return summary;
  }

  const safetyPageLimit = catalogSafetyPageLimit(opts);
  const explicitLastPage = catalogLastPage(opts);
  const capTargetPages = (value) => {
    const target = Math.max(0, Number(value) || 0);
    return opts.limitTo1000Pages === true ? Math.min(explicitLastPage, target) : target;
  };
  const consecutiveEmptyPages =
    Number(opts.consecutiveEmptyPages) > 0 ? Number(opts.consecutiveEmptyPages) : DEFAULT_CONSECUTIVE_EMPTY_PAGES;
  const stallWindows = Number(opts.stallWindows) > 0 ? Number(opts.stallWindows) : DEFAULT_STALL_WINDOWS;
  // Full mode rescans each catalog's window and never stops early on an old
  // range; incremental (default) joins the saved head and skips it.
  const fullMode = opts.syncMode === 'full';
  const incremental = incrementalTuning(opts);
  const baselines = typeof store.getCatalogBaseline === 'function';
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
    const previousSignatures = new Set(savedPages.filter((entry) => entry.signature).map((entry) => entry.signature));
    const previousQuestionIds = new Set(savedPages.flatMap((entry) => entry.questionIds));
    const savedProgress = opts.resume ? store.getRunCatalogProgress(runId, opts.textbookId, catalog.externalId) : null;
    const hasPageOne = savedPageNumbers.has(1);
    const lastSavedPage =
      savedPages.find((entry) => entry.resultType === PAGE_RESULT.SUCCESS && Number(entry.questionCount || 0) > 0) ||
      null;
    const maxObserved = Number(savedProgress?.maxObservedTotal || savedProgress?.expectedTotal || 0);
    // A fresh scan starts at page 1. A resumed run replays the pages it
    // already holds (cloned from the interrupted execution) so an unfinished
    // head continues where it stopped instead of restarting (A20).
    const trackBaseline = baselines;
    const stored = trackBaseline ? store.getCatalogBaseline(scopeKey) : null;
    const baseline = !fullMode && usableBaseline(stored?.confirmed) ? stored.confirmed : null;
    // An unfinished head from the execution this run continues: when the
    // current head still matches it, skip what it already covered (A20).
    // Its results were carried into this run, so nothing is lost.
    const candidate =
      !fullMode &&
      resumedFromRunId != null &&
      stored?.candidate?.headPages?.length &&
      Number(stored.candidateRunId) === Number(resumedFromRunId)
        ? stored.candidate
        : null;
    const candidateThrough = candidate ? contiguousThrough(candidate.scannedPages || []) : 0;
    return {
      candidateTracker:
        candidateThrough > 0
          ? createJoinTracker(
              {
                version: 1,
                headPages: candidate.headPages,
                reliableEnd: candidateThrough,
                gaps: [],
                reachedEnd: false,
              },
              opts,
            )
          : null,
      candidateThrough,
      candidateCovered: 0,
      trackBaseline,
      baseline,
      joinTracker: createJoinTracker(baseline, opts),
      joinPlan: null,
      gapPages: [],
      successPages: new Map(),
      savedEntries: hasPageOne ? savedPages : [],
      duplicateStreak: 0,
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
      targetPages: capTargetPages(
        growTargetPages(savedProgress?.targetPages ?? savedProgress?.expectedPages ?? 0, maxObserved || null),
      ),
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
  for (const state of catalogStates) replaySavedPages(state);

  const listConcurrency = opts.limit > 0 ? 1 : Math.max(1, Number(opts.concurrency) || DEFAULT_LIST_CONCURRENCY);

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

  const finishCatalogScan = (
    state,
    { stalled = false, stallReason = null, pageLimitReached = false, rawSnapshot = null } = {},
  ) => {
    runProgress.catalogsDone += 1;
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
    saveBaseline(state, { stalled, stallReason, pageLimitReached });
    const id = String(state.catalog.externalId);
    if (resumeHints[id]) resumeHints[id].finished = !stalled && !pageLimitReached;
    persistResumeScope();
    if (resumeCoverageGaps.includes(id)) {
      store.db
        .prepare(
          `UPDATE sync_run_catalog_progress SET scan_complete=0, data_complete=0,
        completion_quality='completed_with_issues', stall_reason='resume_coverage_unverified'
        WHERE run_id=? AND catalog_external_id=?`,
        )
        .run(runId, id);
    }
    const progress = store.getRunCatalogProgress(runId, opts.textbookId, state.catalog.externalId);
    console.log(
      `[列表] catalog=${state.catalog.externalId} scan=${pageLimitReached ? 'limited' : stalled ? 'stalled' : 'complete'}` +
        ` quality=${progress?.completionQuality || ''} last=${progress?.lastCompletedPage || 0}` +
        ` target=${state.targetPages || 0}`,
    );
  };

  function saveBaseline(state, { stalled = false, stallReason = null, pageLimitReached = false } = {}) {
    if (!state.trackBaseline) return;
    const windowReason = ['configured_page_limit', 'page_limit_1000'].includes(String(stallReason || ''));
    const joined = state.joinPlan ? state.joinTracker.joined : null;
    const successPages = new Map(state.successPages);
    // Pages the continued head already saved count as covered.
    for (let page = 1; page <= state.candidateCovered; page += 1) {
      if (!successPages.has(page)) successPages.set(page, []);
    }
    const { confirmed, candidate } = nextBaseline({
      previous: state.baseline,
      join: joined,
      successPages,
      windowEnd: explicitLastPage,
      reachedEnd: !stalled && !pageLimitReached && !windowReason && stallReason !== 'incremental_joined' && !joined,
      // A diagnostic --max-pages truncation is never a window end.
      reachedWindowEnd: (pageLimitReached || windowReason) && !opts.maxPagesProvided,
      opts,
    });
    try {
      store.saveCatalogBaseline({
        scopeKey: state.scopeKey,
        textbookExternalId: opts.textbookId,
        catalogExternalId: state.catalog.externalId,
        runId,
        confirmed: confirmed === state.baseline ? undefined : confirmed,
        candidate,
      });
    } catch (error) {
      console.warn(`[增量] catalog=${state.catalog.externalId} 基线写入失败：${error.message}`);
    }
  }

  function contiguousThrough(pages) {
    const set = new Set(pages.map(Number));
    let page = 0;
    while (set.has(page + 1)) page += 1;
    return page;
  }

  /** Continue an interrupted head when the current head still matches it. */
  function trackCandidate(state, page, ids) {
    if (!state.candidateTracker || state.joinPlan || state.candidateCovered) return;
    const join = state.candidateTracker.observe(page, ids);
    if (!join) return;
    state.candidateTracker = null;
    if (join.shift !== 0) return; // The head moved again; rescan normally.
    state.candidateCovered = state.candidateThrough;
    const resumeFrom = Math.max(state.nextPage, state.candidateThrough - incremental.backtrackPages + 1);
    console.log(
      `[增量] catalog=${state.catalog.externalId} 头部与上次未完成的扫描一致，跳过已扫到的 ${state.candidateThrough} 页，从 ${resumeFrom} 页继续`,
    );
    state.nextPage = resumeFrom;
  }

  /** Track one settled page for the baseline, the head join and duplicate stops. */
  function trackPage(state, row, saved) {
    const page = Number(row.pageNumber);
    const type = saved?.resultType;
    if (type === PAGE_RESULT.SUCCESS || type === PAGE_RESULT.NO_NEW_QUESTIONS) {
      const ids = (row.parsed?.questionIds || []).map((value) => normalizeId(value)).filter(Boolean);
      state.successPages.set(page, ids);
      if (type === PAGE_RESULT.SUCCESS) state.duplicateStreak = 0;
      trackCandidate(state, page, ids);
      if (!state.joinPlan && state.joinTracker.enabled) {
        const join = state.joinTracker.observe(page, ids);
        if (join) {
          const plan = planAfterJoin(state.baseline, join, {
            windowEnd: explicitLastPage,
            nextPage: state.nextPage,
            ...opts,
          });
          state.joinPlan = plan;
          state.gapPages = plan.gapPages.filter((gap) => !state.successPages.has(gap));
          if (!plan.covered) state.nextPage = Math.max(state.nextPage, plan.resumeFrom);
          console.log(
            `[增量] catalog=${state.catalog.externalId} 已在 page=${join.confirmedAtPage} 接上历史保存范围（位移 ${plan.shift} 页），` +
              (plan.covered
                ? `当前窗口已覆盖，补 ${state.gapPages.length} 个缺口后结束`
                : `跳过 ${plan.skippedRange[0]}～${plan.skippedRange[1]} 页，从 ${plan.resumeFrom} 页续采`),
          );
        }
      }
    } else if (type === PAGE_RESULT.DUPLICATE_PAGE) {
      state.duplicateStreak += 1;
    }
  }

  function replaySavedPages(state) {
    for (const entry of state.savedEntries) {
      trackPage(
        state,
        { pageNumber: entry.pageNumber, parsed: { questionIds: entry.questionIds } },
        { resultType: entry.resultType },
      );
    }
    state.savedEntries = [];
    // A head that already joined the old range needs no page-number hint.
    if (state.joinPlan) state.resumeChecked = true;
  }

  function saveCandidate(state) {
    if (!state.trackBaseline || state.joinPlan || state.successPages.size === 0) return;
    const { candidate } = nextBaseline({
      previous: state.baseline,
      successPages: state.successPages,
      windowEnd: explicitLastPage,
      opts,
    });
    if (!candidate) return;
    try {
      store.saveCatalogBaseline({
        scopeKey: state.scopeKey,
        textbookExternalId: opts.textbookId,
        catalogExternalId: state.catalog.externalId,
        runId,
        confirmed: undefined,
        candidate,
      });
    } catch (error) {
      console.warn(`[增量] catalog=${state.catalog.externalId} 候选基线写入失败：${error.message}`);
    }
  }

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
        const retried = await postQuestionList(session.page, opts, catalog, pageNumber, {
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
      console.log(
        `[列表] catalog=${catalog.externalId} page=${pageNumber} result=${resultType} total=${state.expectedTotal}`,
      );
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
              result = await downloadAsset(session.context, opts, asset);
              if (result.contentSha256) counters.assetsDownloaded += 1;
            } catch (error) {
              if (error.blocked || error.contextClosed || String(error?.code || '') === 'asset_storage_error')
                throw error;
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
    console.log(
      `[列表] catalog=${catalog.externalId} page=${pageNumber} questions=${questions.length} total=${state.expectedTotal}`,
    );
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
      console.warn(
        `[列表] catalog=${state.catalog.externalId} page=${row.pageNumber} ${resultType}: ${row.error.message}`,
      );
      return { resultType, empty: false, newCount: 0, questions: [] };
    }
    return persistCatalogPage(state, row.pageNumber, row.parsed);
  };

  const windowForState = (state) => {
    if (state.gapPages.length) return state.gapPages.splice(0, listConcurrency);
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
    await waitForVerification(session.page, {
      ...opts,
      requireProbe: true,
      verificationReason: error?.code || 'waiting_verification',
    });
  }

  async function fetchWindow(state, pageNumbers) {
    heartbeat(`fetch_window:${state.catalog.externalId}:${pageNumbers[0]}`);
    const rows = await Promise.all(
      pageNumbers.map(async (pageNumber) => {
        try {
          const parsed = await postQuestionList(session.page, opts, state.catalog, pageNumber, {
            allowVerificationWait: false,
          });
          return { pageNumber, parsed, error: null };
        } catch (error) {
          return { pageNumber, parsed: null, error };
        }
      }),
    );
    const closed = rows.find((row) => isClosedContextError(row.error));
    if (closed) {
      // Stop this window: later pages on the same closed context can only
      // fail, and recording them would fake per-page source failures.
      for (const row of rows.filter((item) => item.parsed)) {
        const saved = await settleFetchedPage(state, row);
        noteFetchSlot(state, row.pageNumber, saved);
        trackPage(state, row, saved);
      }
      const error = closedContextError(closed.error);
      // Pages that never got a response are fetched again after a rebuild.
      error.pages = rows.filter((row) => row.error).map((row) => row.pageNumber);
      throw error;
    }
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
          line:
            `catalog=${state.catalog.externalId} page=${pageNumber} 抓取中` +
            (state.expectedTotal == null ? '' : ` total=${state.expectedTotal}`),
        })),
      });
    } catch (error) {
      console.warn(`[进度] 窗口状态写入失败：${error.message}`);
    }
  }

  function noteFetchSlot(state, pageNumber, saved) {
    const resultType = saved?.resultType || (saved?.empty ? PAGE_RESULT.EMPTY_PAGE : PAGE_RESULT.SUCCESS);
    const questionCount = Array.isArray(saved?.questions) ? saved.questions.length : saved?.empty ? 0 : null;
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
        line:
          `catalog=${state.catalog.externalId} page=${pageNumber}` +
          (questionCount == null ? '' : ` questions=${questionCount}`) +
          (state.expectedTotal == null ? '' : ` total=${state.expectedTotal}`) +
          (status === 'saved' ? '' : ` ${status}`),
      });
    } catch (error) {
      console.warn(`[进度] 窗口页状态写入失败：${error.message}`);
    }
  }

  async function verifyResumeFrontier(state) {
    const hint = state.resumeHint;
    // Question-ID evidence (continued head or joined history) already
    // located this catalog; a page-number hint adds nothing.
    if (state.candidateCovered || state.joinPlan) state.resumeChecked = true;
    if (!hint || state.resumeChecked || state.nextPage < 2) return;
    state.resumeChecked = true;
    if (hint.lastPage < 3 || !hint.anchorId || opts.limit > 0) return;
    const growth =
      state.expectedTotal != null && hint.total != null ? Math.max(0, state.expectedTotal - hint.total) : 0;
    const boundary = Math.min(
      explicitLastPage,
      safetyPageLimit,
      Math.max(2, hint.lastPage + Math.floor(growth / DEFAULT_PAGE_CAPACITY)),
    );
    // A page number is only a search hint. Require the saved boundary ID in
    // a current response; otherwise continue the fresh scan from page 2.
    for (const pageNumber of [boundary, boundary + 1]) {
      if (pageNumber > explicitLastPage || pageNumber > safetyPageLimit) break;
      assertNotStopped();
      await requestGate(opts.sleepFn || sleep);
      const parsed = await postQuestionList(session.page, opts, state.catalog, pageNumber, {
        allowVerificationWait: false,
      });
      if (!(parsed.questionIds || []).map(String).includes(String(hint.anchorId))) continue;
      resumeCoverageGaps.push(String(state.catalog.externalId));
      persistResumeScope();
      await persistCatalogPage(state, pageNumber, parsed);
      state.nextPage = pageNumber + 1;
      if (hint.finished && growth < DEFAULT_PAGE_CAPACITY) finishCatalogScan(state);
      console.log(
        `[续采] catalog=${state.catalog.externalId} 边界题 ${hint.anchorId} 已在当前 page=${pageNumber} 复核`,
      );
      return;
    }
    console.log(`[续采] catalog=${state.catalog.externalId} 旧边界未匹配，继续从前部重新扫描`);
  }

  async function crawlAll() {
    // All real catalogs start from their own saved checkpoint.  Nodes without
    // a saved page 1 begin at page 1 here; the root total probe above is never
    // represented as a catalog page or question snapshot.  Each concurrent
    // window is settled page-by-page: a failed/duplicate/empty page is
    // recorded and later successes in the same window are still saved.
    for (const state of catalogStates) {
      if (opts.limit > 0 && counters.questionsSeen >= opts.limit) break;
      try {
        for (;;) {
          try {
            await crawlCatalog(state);
            break;
          } catch (error) {
            if (!isClosedContextError(error) || !(await session.recoverClosedContext(error))) throw error;
            state.gapPages = [...new Set([...(error.pages || []), ...state.gapPages])].sort((a, b) => a - b);
            console.log(`[浏览器] catalog=${state.catalog.externalId} 浏览器已重建，从中断的页继续`);
          }
        }
      } catch (error) {
        if (error?.recycleFailure || isCookieSwitchError(error) || isTextbookFatalError(error)) throw error;
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
  }

  async function crawlCatalog(state) {
    catalogPages: while (!state.finished) {
      await verifyResumeFrontier(state);
      if (state.finished) break;
      if (state.joinPlan?.covered && state.gapPages.length === 0) {
        finishCatalogScan(state, { stallReason: 'incremental_joined' });
        break;
      }
      if (opts.limit > 0 && counters.questionsSeen >= opts.limit) break;
      if (opts.catalogPageLimit != null && !opts.maxPagesProvided && state.nextPage > explicitLastPage) {
        // Finish this directory, then move on. A bounded traversal is
        // not evidence that every source question has been collected.
        finishCatalogScan(state, { pageLimitReached: true, stallReason: 'configured_page_limit' });
        break;
      }
      // Check the task policy boundary before the generic safety ceiling.
      // This keeps an explicitly configured safetyPageLimit of 1000 from
      // turning the intentional policy stop into a stalled catalog.
      if (
        opts.limitTo1000Pages === true &&
        !opts.maxPagesProvided &&
        explicitLastPage === SITE_PAGE_LIMIT &&
        state.nextPage > explicitLastPage
      ) {
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
      await session.safePoint();
      beginFetchWindow(state, pageNumbers);
      await requestGate(opts.sleepFn || sleep);
      const rows = await fetchWindow(state, pageNumbers);
      session.notePagesFetched(pageNumbers.length);
      let sourcePause = rows.find((row) => row.error?.blocked)?.error;
      if (!sourcePause) {
        try {
          await prefetchWindowAssets(rows);
        } catch (error) {
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
              if (url && !assetCache.has(url))
                assetCache.set(url, {
                  ...asset,
                  sourceUrl: url,
                  downloadFailed: true,
                  errorCode: sourcePause.code,
                  errorMessage: sourcePause.message,
                });
            }
          }
        }
        for (const row of rows.filter((item) => item.parsed)) {
          const saved = await settleFetchedPage(state, row);
          noteFetchSlot(state, row.pageNumber, saved);
          trackPage(state, row, saved);
        }
        for (const row of rows.filter((item) => item.error)) {
          store.recordPageAttempt({
            runId,
            textbookExternalId: opts.textbookId,
            catalog: normalizedCatalogOf(state.catalog),
            pageNumber: row.pageNumber,
            resultType: PAGE_RESULT.REQUEST_FAILED,
            errorCode: row.error.code || sourcePause.code,
            queryFingerprint: state.scopeKey,
            filterJson: state.filterJson,
            expectedTotal: state.expectedTotal,
            targetPages: state.targetPages,
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
          trackPage(state, row, saved);
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
        trackPage(state, row, saved);
        if (saved.newCount > 0) cookieWaitCycles = 0;
        newCount += Number(saved.newCount || 0);
        if (opts.limit > 0 && counters.questionsSeen >= opts.limit) break catalogPages;
      }
      saveCandidate(state);
      if (state.duplicateStreak >= incremental.duplicateStopPages) {
        // Different page numbers keep returning one page: stop paging
        // with the real reason instead of walking to the window end.
        finishCatalogScan(state, { stalled: true, stallReason: 'duplicate_pages' });
        break;
      }
      if (state.joinPlan) {
        if (state.joinPlan.covered && state.gapPages.length === 0) {
          finishCatalogScan(state, { stallReason: 'incremental_joined' });
          break;
        }
        if (state.gapPages.length) continue;
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
  }

  return { catalogStates, crawlAll };
}

module.exports = { createCatalogCrawler };
