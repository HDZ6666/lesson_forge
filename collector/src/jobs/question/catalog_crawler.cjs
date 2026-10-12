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
              result = await downloadAsset(session.context, opts, asset);
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
    await waitForVerification(session.page, {
      ...opts,
      requireProbe: true,
      verificationReason: error?.code || 'waiting_verification',
    });
  }

  async function fetchWindow(state, pageNumbers) {
    heartbeat(`fetch_window:${state.catalog.externalId}:${pageNumbers[0]}`);
    const rows = await Promise.all(pageNumbers.map(async (pageNumber) => {
      try {
        const parsed = await postQuestionList(session.page, opts, state.catalog, pageNumber, {
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
      const parsed = await postQuestionList(session.page, opts, state.catalog, pageNumber, { allowVerificationWait: false });
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

  async function crawlAll() {
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
          await session.safePoint();
          beginFetchWindow(state, pageNumbers);
          await requestGate(opts.sleepFn || sleep);
          const rows = await fetchWindow(state, pageNumbers);
          session.notePagesFetched(pageNumbers.length);
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

  return { catalogStates, crawlAll };
}

module.exports = { createCatalogCrawler };
