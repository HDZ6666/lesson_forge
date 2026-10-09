'use strict';

/**
 * One version/textbook discovery run: robots check, anonymous Chrome session,
 * seed page, chaptertextbooks API per version, UPSERT into the candidate
 * tables and an immutable per-run snapshot.  Structured events go to the API
 * manager over IPC; console output stays diagnostic.
 */

const process = require('node:process');
const path = require('node:path');

const { StopCrawlError } = require('../shared/errors.cjs');
const {
  ensureDir,
  isStableExternalId,
  nowIso,
  safeFilePart: sharedSafeFilePart,
  sleep,
} = require('../shared/utils.cjs');
const { acquireLock } = require('../shared/lock.cjs');
const { ALLOWED_PAGE_HOSTS, assertAllowedUrl } = require('../shared/url_policy.cjs');
const {
  applyInitialChromeMode,
  canFallbackToHeaded,
  closeCollectorContext,
  createCollectorPageFactory,
  describeChromeMode,
  inspectRobots,
  launchCollectorContext,
  loadPlaywright,
  protectionStopMessage,
  safeGoto,
  settleSourcePage,
} = require('../sources/zujuan/session.cjs');

// Historical raw-page file names for this collector were truncated at 120.
const safeFilePart = (value) => sharedSafeFilePart(value, 120);

const {
  assertDiscoveryIds,
  emptyValidation,
  normalizeTextbookRecords,
  normalizeVersionRecords,
  parseTextbooksFromApiHtml,
  textbookListSignature,
  validateDiscovery,
} = require('../sources/zujuan/metadata_parser.cjs');
const { buildChapterTextbooksUrl } = require('../sources/zujuan/urls.cjs');
const { classifyHtmlProtection } = require('../sources/zujuan/response_classifier.cjs');

const { PoliteGate } = require('../policies/retry.cjs');
const {
  MetadataStore,
  buildReport,
  formatReport,
  writeJsonOutput,
} = require('../storage/metadata_store.cjs');
const { saveRawHtml } = require('../storage/raw_pages.cjs');
const { createProcessEventEmitter } = require('../jobs/events.cjs');
const { assertMathSource } = require('../sources/registry.cjs');
const { SourceControl } = require('../policies/source_control.cjs');
const { SourceBudget } = require('../policies/source_budget.cjs');
const { ResourceGuard } = require('../policies/resource_guard.cjs');

async function readVersionsFromPage(page, sourceUrl) {
  const raw = await page.evaluate(() => {
    const root = document.querySelector('#chapter_textbook_version');
    if (!root) return { error: 'missing_version_container' };
    return Array.from(root.querySelectorAll('a')).map((el, index) => ({
      externalVersionId: el.getAttribute('versionid')
        || el.getAttribute('data-versionid')
        || el.getAttribute('data-version-id'),
      versionName: (el.textContent || '').replace(/\u00a0/g, ' ').trim(),
      className: el.getAttribute('class') || '',
      selected: el.classList.contains('selected'),
      urlTemplate: el.getAttribute('url'),
      href: el.getAttribute('href'),
      qbmid: el.getAttribute('data-qbmid'),
      sortOrder: index,
      attributes: Object.fromEntries(Array.from(el.attributes).map((item) => [item.name, item.value])),
    }));
  });
  if (raw?.error === 'missing_version_container') {
    throw new StopCrawlError('页面缺少版本选择区域 #chapter_textbook_version。', 'version_contract');
  }
  return normalizeVersionRecords((raw || []).map((item) => ({ ...item, sourceUrl })));
}

async function readTextbookState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#chapter_textbooks');
    if (!root) return { error: 'missing_textbook_container', loading: false, items: [] };
    const text = root.textContent || '';
    if (text.includes('加载中err')) return { error: 'textbook_list_error', loading: false, items: [] };
    const loading = text.includes('加载中');
    const items = Array.from(root.querySelectorAll('a')).map((el, index) => {
      const href = el.getAttribute('href') || '';
      const fromHref = href.match(/\/zj(\d+)\b/);
      return {
        externalTextbookId: el.getAttribute('chapter-id') || (fromHref ? fromHref[1] : null),
        textbookName: (el.textContent || '').replace(/\u00a0/g, ' ').trim(),
        href,
        qbmid: el.getAttribute('data-qbmid'),
        selected: el.classList.contains('selected'),
        className: el.getAttribute('class') || '',
        sortOrder: index,
        attributes: Object.fromEntries(Array.from(el.attributes).map((item) => [item.name, item.value])),
      };
    }).filter((item) => item.textbookName && !item.textbookName.includes('加载中'));
    return { loading, items, error: null };
  });
}

async function waitForTextbookList(page, { previousSignature, allowUnchanged, timeout }) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    const state = await readTextbookState(page);
    if (state.error === 'textbook_list_error') {
      throw new StopCrawlError('教材列表加载失败。', 'textbook_list_error');
    }
    if (state.error === 'missing_textbook_container' || state.loading) {
      lastError = state.error || 'loading';
      await sleep(120);
      continue;
    }
    const records = normalizeTextbookRecords(state.items, { allowEmpty: true });
    const signature = textbookListSignature(records);
    if (allowUnchanged || !previousSignature || signature !== previousSignature) {
      return records;
    }
    lastError = 'unchanged';
    await sleep(120);
  }
  throw new StopCrawlError(
    `等待教材列表签名变化超时（${lastError || 'unknown'}），可能发生页面契约变化。`,
    'textbook_list_timeout',
  );
}

async function fetchTextbooksForVersion(page, version, options) {
  const requestUrl = assertAllowedUrl(buildChapterTextbooksUrl(version, options), ALLOWED_PAGE_HOSTS);
  options.sourceControl?.assertAllowed();
  options.resourceGuard?.assertAllowed();
  options.sourceBudget?.request();
  const payload = await page.evaluate(async (href) => {
    try {
      const response = await fetch(href, {
        credentials: 'include',
        headers: {
          Accept: 'text/html, */*;q=0.1',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text(), error: null };
    } catch (error) {
      return { status: 0, text: '', error: String(error && error.message ? error.message : error) };
    }
  }, requestUrl);
  options.sourceControl?.observe(payload.status, payload.headers);
  if (payload.error) throw new Error(`教材列表接口失败：${payload.error}`);
  if ([401, 403].includes(payload.status)) {
    throw new StopCrawlError(`HTTP ${payload.status}，任务已熔断。`, `http_${payload.status}`);
  }
  if (payload.status >= 400) throw new Error(`教材列表接口返回 HTTP ${payload.status}`);
  const protection = classifyHtmlProtection(payload.text);
  if (protection.terminalBlock || (protection.transientChallenge && !protection.hasContent)) {
    options.sourceControl?.requireManual(protectionStopMessage(protection));
    throw new StopCrawlError(protectionStopMessage(protection), 'challenge');
  }
  const textbooks = parseTextbooksFromApiHtml(payload.text, {
    versionExternalId: version.externalVersionId,
    baseUrl: options.baseUrl,
    bankPath: options.bankPath,
    seedUrl: options.seedUrl,
    allowEmpty: true,
  });
  if (textbooks.length === 0) {
    throw new StopCrawlError(
      `版本 ${version.versionName} 的教材列表为空，可能发生接口契约变化。`,
      'textbook_contract',
    );
  }
  return textbooks;
}

async function selectVersion(page, version, gate, options, _previousSignature) {
  await gate.wait(`拉取版本教材 ${version.versionName}`);
  return fetchTextbooksForVersion(page, version, options);
}

async function readBootstrapChapter(page) {
  return page.evaluate(() => {
    const tree = document.querySelector('.tk-tree');
    if (!tree) return { error: 'missing_tree' };
    const first = tree.querySelector('li.tree-node[data-level="1"]');
    const bootstrap = first?.getAttribute('tree-id')
      || first?.querySelector(':scope > .tree-node-name[data-tree-id]')?.getAttribute('data-tree-id')
      || null;
    return {
      textbookTreeId: tree.getAttribute('tree-id'),
      bootstrapChapterExternalId: bootstrap,
    };
  });
}

async function runDiscovery(options) {
  assertMathSource(options);
  if (!options.acknowledgeSourcePolicy) {
    throw new Error(
      '运行前必须传 --acknowledge-source-policy，确认已核对来源站规则、授权范围和内容使用边界。',
    );
  }

  const playwright = await loadPlaywright();
  ensureDir(options.dataDir);
  ensureDir(options.profileDir);
  const store = new MetadataStore(options.dbPath);
  options.sourceControl = new SourceControl(options.dbPath);
  options.sourceBudget = new SourceBudget(options.dbPath);
  options.resourceGuard = new ResourceGuard({ paths: {
    database: path.dirname(options.dbPath), data: options.dataDir, profile: options.profileDir,
  } });
  let releaseLock;
  try {
    releaseLock = acquireLock(`${options.dbPath}.lock`);
  } catch (error) {
    store.close();
    throw error;
  }

  const runId = store.beginRun(options.seedUrl);
  const counters = {
    versionsSeen: 0,
    textbooksSeen: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
  };
  const seenVersionIds = new Set();
  const seenTextbookIds = new Set();
  const allTextbooks = [];
  const gate = new PoliteGate(options.delayMin, options.delayMax);
  let context;
  let signalName = null;
  const onSigint = () => {
    signalName = 'SIGINT';
    console.warn('\n[停止] 收到 SIGINT，将在当前安全点结束。');
  };
  const onSigterm = () => {
    signalName = 'SIGTERM';
    console.warn('\n[停止] 收到 SIGTERM，将在当前安全点结束。');
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  let finalStatus = 'success';
  let finalMessage = null;
  let report = null;
  const validation = emptyValidation();
  const events = options.events || createProcessEventEmitter({ stdout: options.eventsStdout === true });

  try {
    console.log(`[启动] metadata-run=${runId}，数据库：${options.dbPath}`);
    events.emit('metadata_run_created', { runId });
    options.sourceControl.assertAllowed();
    options.resourceGuard.assertAllowed();
    options.sourceBudget.startRun(`metadata:${runId}`, 'metadata');
    options.sourceBudget.startTiming();
    applyInitialChromeMode(options);
    console.log(`[环境] ${describeChromeMode(options)}，入口 ${options.seedUrl}`);
    const boot = async () => {
      const next = await launchCollectorContext(playwright, options);
      try {
        const createPage = createCollectorPageFactory(next, options);
        const robots = await inspectRobots(next, options);
        if (robots.status === 'disallowed') {
          throw new StopCrawlError('robots.txt 明确禁止访问目标题库路径。', 'robots_disallowed');
        }
        if (robots.status !== 'allowed') {
          console.warn(`[提醒] robots.txt 状态未知：${robots.reason || robots.status}。仅按已确认的授权范围运行。`);
        }
        const page = await createPage();
        await safeGoto(page, options.seedUrl, gate, options, '加载元数据入口页');
        await settleSourcePage(page, options, {
          contentSelector: '#chapter_textbook_version a[versionid]',
          label: '版本列表',
        });
        return { context: next, page };
      } catch (error) {
        await closeCollectorContext(next);
        throw error;
      }
    };
    let session;
    try {
      session = await boot();
    } catch (error) {
      if (!canFallbackToHeaded(options, error)) throw error;
      console.warn(`[环境] 无头被防护阻断，改用有头 Chrome 重试：${String(error.message).split('\n')[0]}`);
      options.headless = false;
      session = await boot();
    }
    context = session.context;
    const page = session.page;
    if (options.saveRaw) saveRawHtml(options.dataDir, runId, 'seed', 'entry', await page.content());

    const versions = await readVersionsFromPage(page, options.seedUrl);
    assertDiscoveryIds(versions, []);
    counters.versionsSeen = versions.length;
    console.log(`[版本] 发现 ${versions.length} 个版本`);

    for (const version of versions) {
      if (signalName) throw new StopCrawlError(`收到 ${signalName}，任务安全停止。`, 'signal');
      console.log(`[版本] ${version.versionName} (${version.externalVersionId})`);
      const listed = await selectVersion(page, version, gate, options);
      const textbooks = normalizeTextbookRecords(listed, {
        versionExternalId: version.externalVersionId,
        baseUrl: options.baseUrl,
        bankPath: options.bankPath,
        seedUrl: options.seedUrl,
        allowEmpty: true,
      });
      assertDiscoveryIds([version], textbooks);
      console.log(`[教材] ${version.versionName} 共 ${textbooks.length} 本`);
      if (options.saveRaw) {
        saveRawHtml(
          options.dataDir,
          runId,
          'version',
          version.externalVersionId,
          await page.content(),
        );
      }

      for (const textbook of textbooks) {
        if (signalName) throw new StopCrawlError(`收到 ${signalName}，任务安全停止。`, 'signal');
        if (!textbook.sourceUrl) {
          throw new StopCrawlError(
            `教材 ${textbook.textbookName} 缺少可追溯来源地址。`,
            'textbook_url_missing',
          );
        }
        console.log(
          `[教材] ${version.versionName} / ${textbook.textbookName} (${textbook.externalTextbookId}) ${textbook.sourceUrl || textbook.href || ''}`,
        );
        if (!isStableExternalId(textbook.bootstrapChapterExternalId)) {
          validation.missingBootstrapChapters.push({
            externalTextbookId: textbook.externalTextbookId,
            textbookName: textbook.textbookName,
          });
        }
        seenTextbookIds.add(String(textbook.externalTextbookId));
        allTextbooks.push(textbook);
      }

      const observedAt = nowIso();
      const saved = store.saveVersionGroup(version, textbooks, observedAt, runId);
      counters.inserted += saved.inserted;
      counters.updated += saved.updated;
      counters.unchanged += saved.unchanged;
      counters.textbooksSeen += textbooks.length;
      seenVersionIds.add(String(version.externalVersionId));
    }

    const idValidation = validateDiscovery(versions, allTextbooks);
    validation.missingIds = idValidation.missingIds;
    validation.duplicateIds = idValidation.duplicateIds;
    if (signalName === 'SIGINT' || signalName === 'SIGTERM') {
      throw new StopCrawlError(`收到 ${signalName}，任务安全停止。`, 'signal');
    }
    report = buildReport(store, {
      validation,
      counts: {
        inserted: counters.inserted,
        updated: counters.updated,
        unchanged: counters.unchanged,
      },
      unseen: store.unseenCandidates(seenVersionIds, seenTextbookIds),
    });
    console.log(formatReport(report));
    writeJsonOutput(options.jsonOutput, report);
  } catch (error) {
    counters.errors += 1;
    finalStatus = signalName === 'SIGINT' || signalName === 'SIGTERM'
      ? 'cancelled'
      : (error instanceof StopCrawlError ? 'blocked' : 'failed');
    finalMessage = error.message;
    events.emit('error', {
      runId,
      code: error.code || error.name || 'run_failed',
      message: finalMessage,
      recoverable: finalStatus === 'cancelled',
      blocked: finalStatus === 'blocked',
      stage: 'run',
    });
    error.eventEmitted = true;
    try {
      report = buildReport(store, {
        validation,
        counts: {
          inserted: counters.inserted,
          updated: counters.updated,
          unchanged: counters.unchanged,
        },
      });
    } catch {}
    throw error;
  } finally {
    options.sourceBudget.stopTiming();
    await closeCollectorContext(context);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    store.finishRun(runId, finalStatus, counters, finalMessage, report);
    store.close();
    releaseLock?.();
    console.log(`[完成] metadata-run=${runId} status=${finalStatus}`, counters);
    events.emit('metadata_summary', {
      runId,
      status: finalStatus,
      versionCount: counters.versionsSeen,
      textbookCount: counters.textbooksSeen,
    });
    events.emit('sealed', {
      runId,
      status: finalStatus,
      snapshotComplete: finalStatus === 'success',
      scanComplete: finalStatus === 'success',
      dataComplete: finalStatus === 'success',
      message: finalMessage,
      counts: { ...counters },
    });
  }
}

module.exports = {
  fetchTextbooksForVersion,
  readBootstrapChapter,
  readTextbookState,
  readVersionsFromPage,
  runDiscovery,
  selectVersion,
  waitForTextbookList,
};
