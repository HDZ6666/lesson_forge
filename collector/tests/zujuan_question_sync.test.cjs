'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  FORMAL_ASSET_TYPES,
  QuestionSyncError,
  QuestionSyncStore,
  buildQuestionListBody,
  buildScope,
  catalogTreeUrl,
  classifyQuestionResponse,
  createRequestGate,
  downloadAsset,
  finalizeQuestion,
  normalizeAssetType,
  normalizeCatalogTree,
  parseQuestionListPayload,
  parseDifficulty,
  parseArgs,
  postQuestionList,
  retryDelay,
  runSync,
  selectCatalogs,
  serializeFormBody,
  validatePageResult,
} = require('../zujuan_question_sync.cjs');

const LIST_HTML = `
<div class="tk-quest-item quesroot new" questionid="35020603" bankid="2">
  <div class="ques-additional">
    <div class="top-msg"><a class="ques-src" href="/2p3410930.html" title="原始出处：第二十五章 一元二次方程">26-27九年级上·全国·课后作业</a></div>
    <div class="info-cnt">解答题-问答题</div><div class="info-cnt">适中 (0.55)</div>
    <div class="knowledge-list"><a class="knowledge-item" href="/czsx/zsd223709/">化成一元二次方程的一般式</a><a class="knowledge-item" href="/czsx/zsd223709/tre5-15091">问题解决能力</a></div>
    <div class="right-msg"><span class="tag">名校</span></div>
  </div>
  <div class="exam-item__cnt">1 . 计算<img src="https://staticzujuan.xkw.com/quesimg/Upload/formula/a.png"><br>(1)求值</div>
  <div class="exam-item__info"><span class="no-bound" title="2026/08/16">2026/08/16</span><span title="470次组卷">470次组卷</span><span class="look-more-src"><span class="info-txt">2卷引用：试卷甲</span><div class="more-src-links"><a class="src-item" href="/2p1.html" title="试卷甲">试卷甲</a><a class="src-item" href="/2p2.html">试卷乙</a></div></span></div>
  <div class="ctrl-box"><a class="detail" href="/2q35020603.html">详情</a><a class="addques" quesid="35020603" qyid="1103" qyname="解答题" qdid="3" qdname="适中" qdvalue="0.55" categoryId="4690" categoryName="代数式" titleabbreviation="26-27九上—全国—作业">加入</a></div>
</div>`;

function tempDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zujuan-question-sync-'));
  return { directory, dbPath: path.join(directory, 'collector.sqlite3') };
}

test('目录归一化使用嵌套 display parent，并正确生成知识点接口参数', () => {
  const tree = normalizeCatalogTree({
    bankId: 2,
    id: '260617',
    parentId: '195847',
    title: '九年级上册',
    children: [{
      id: '261285', title: '第一章', isKnowledge: 0, parentId: '260617', children: [{
        id: '261286', title: '第一节', isKnowledge: 0, parentId: '261285', children: [{
          id: '5597', title: '知识点', isKnowledge: 1, parentId: '9999', href: '/czsx/zj261286/ctk5597', children: [],
        }],
      }],
    }],
  });
  assert.equal(tree.nodes.length, 3);
  assert.equal(tree.nodes[2].parentExternalId, '261286');
  assert.equal(tree.nodes[2].rawParentExternalId, '9999');
  assert.deepEqual(tree.nodes[2].ancestorIds, ['261285', '261286', '5597']);
  assert.equal(tree.nodes[2].categoryId, '261286');
  assert.equal(tree.nodes[2].catelogTokpointId, '5597');
  assert.equal(tree.nodes[0].categoryId, '261285');
  assert.equal(tree.root.externalId, '260617');
  assert.equal(tree.nodes[0].sortOrder, 0);
});

test('静态目录 URL、初中数学默认值和 API POST body 契约', () => {
  const options = { bankId: 2, textbookId: '260617', bankPath: 'czsx', baseUrl: 'https://zujuan.xkw.com' };
  const url = catalogTreeUrl({ ...options, timestamp: 123 });
  assert.equal(url, 'https://static.zxxk.com/zujuan/tree/ct_2_260617.json?v=123&withCredentials=false');
  const body = buildQuestionListBody(options, {
    externalId: '5597', categoryId: '261286', catelogTokpointId: '5597',
  }, 7);
  assert.equal(body.curPage, '7');
  assert.equal(body.categoryId, '261286');
  assert.equal(body.catelogTokpointId, '5597');
  assert.equal(body['categoryIds[0]'], '0');
  assert.equal(body.canTreeMultiple, 'false');
  assert.equal(body.credentials, undefined);
  const encoded = serializeFormBody(body);
  assert.match(encoded, /pageName=zj/);
  assert.match(encoded, /categoryIds%5B0%5D=0/);
});

test('浏览器 page.evaluate 实际收到 form-urlencoded 字符串而不是 body 对象', async () => {
  let evaluateArgs = null;
  const page = {
    evaluate: async (_fetchFn, args) => {
      evaluateArgs = args;
      return { status: 200, headers: {}, text: '{"code":"0","data":{"total":0,"html":""}}' };
    },
  };
  await postQuestionList(page, {
    baseUrl: 'https://zujuan.xkw.com',
    bankId: 2,
    delayMin: 0,
    delayMax: 0,
  }, { externalId: '261285', categoryId: '261285', catelogTokpointId: '0' }, 1);
  assert.equal(typeof evaluateArgs.body, 'string');
  assert.match(evaluateArgs.body, /categoryIds%5B0%5D=0/);
  assert.equal(evaluateArgs.credentials, 'include');
  assert.equal(evaluateArgs.headers['X-Requested-With'], 'XMLHttpRequest');
});

test('题型、页面三档难度、原始 qdid、来源分类和使用统计完整保留', () => {
  const parsed = parseQuestionListPayload({
    code: '0', data: { total: 1, html: LIST_HTML },
  });
  const question = parsed.questions[0];
  assert.equal(question.externalId, '35020603');
  assert.equal(question.questionType, '解答题-问答题');
  assert.equal(question.questionTypeId, '1103');
  assert.equal(question.questionTypeName, '解答题');
  assert.equal(question.difficultyLabel, '适中');
  assert.equal(question.difficultyCode, '3');
  assert.equal(question.rawDifficulty.qdid, '3');
  assert.equal(question.easeCoefficient, 0.55);
  assert.equal(question.sourceShort, '26-27九年级上·全国·课后作业');
  assert.equal(question.sourceTitle, '第二十五章 一元二次方程');
  assert.equal(question.sourceUrl, 'https://zujuan.xkw.com/2p3410930.html');
  assert.equal(question.detailUrl, 'https://zujuan.xkw.com/2q35020603.html');
  assert.equal(question.titleAbbreviation, '26-27九上—全国—作业');
  assert.equal(question.providerCategoryId, '4690');
  assert.equal(question.providerCategoryName, '代数式');
  assert.equal(question.websiteTimeText, '2026/08/16');
  assert.equal(question.useCount, 470);
  assert.equal(question.referenceCount, 2);
  assert.equal(question.referencePapers.length, 2);
  assert.equal(question.isNew, true);
  assert.equal(question.answerStatus, 'not_collected');
  assert.equal(question.detailFetched, false);
});

test('知识点、能力点、provider tags 和素材使用独立维度及规范类型', () => {
  const question = parseQuestionListPayload({ code: '0', data: { total: 1, html: LIST_HTML } }).questions[0];
  assert.deepEqual(question.knowledge.map((entry) => [entry.kind, entry.externalId]), [
    ['knowledge_point', '223709'], ['ability', '15091'],
  ]);
  assert.deepEqual(question.providerLabels.map((entry) => entry.value), ['名校', '新题']);
  assert.equal(question.assets[0].type, 'formula_image');
  assert.ok(FORMAL_ASSET_TYPES.includes(question.assets[0].assetType));
  assert.equal(normalizeAssetType('https://x/thing.svg'), 'svg');
  assert.equal(normalizeAssetType('https://x/thing.bin'), 'other');
});

test('分页校验拒绝重复页、提前空页和单页重复题号', () => {
  const page = {
    total: 21,
    questions: Array.from({ length: 10 }, (_, index) => ({ externalId: String(index + 1) })),
    questionIds: Array.from({ length: 10 }, (_, index) => String(index + 1)),
  };
  const signature = validatePageResult(page, 1, 3, new Set());
  assert.equal(typeof signature, 'string');
  assert.throws(() => validatePageResult(page, 2, 3, new Set([signature])), /重复/);
  assert.throws(() => validatePageResult({ total: 21, questions: [], questionIds: [] }, 2, 3, new Set()), /空页/);
  assert.throws(() => validatePageResult({ total: 1, questions: [{ externalId: '1' }, { externalId: '1' }], questionIds: ['1', '1'] }, 1, 1, new Set()), /重复/);
});

test('HTTP 重试/验证分类及退避策略', () => {
  assert.equal(classifyQuestionResponse({ status: 503, text: 'busy' }).kind, 'retry');
  assert.equal(classifyQuestionResponse({ status: 429, text: 'slow' }).throttled, true);
  assert.equal(classifyQuestionResponse({ status: 403, text: 'forbidden' }).kind, 'verification');
  assert.equal(classifyQuestionResponse({ status: 200, text: '<html>验证码</html>' }).kind, 'verification');
  assert.equal(retryDelay('normal', 0, {}, () => 0), 2000);
  assert.equal(retryDelay('normal', 2, {}, () => 0), 12000);
  assert.equal(retryDelay('429', 0, { 'retry-after': '7' }, () => 0), 7000);
});

test('素材 HTTP 失败 fail closed，并按 2/5/12 秒重试后抛错', async () => {
  const waits = [];
  let calls = 0;
  const context = {
    request: {
      get: async () => {
        calls += 1;
        return { status: 503, headers: {}, body: async () => Buffer.from('busy') };
      },
    },
  };
  await assert.rejects(
    downloadAsset(context, {
      timeout: 1000,
      dataDir: os.tmpdir(),
      sleepFn: async (ms) => waits.push(ms),
      randomFn: () => 0,
    }, { sourceUrl: 'https://staticzujuan.xkw.com/quesimg/a.png', type: 'question_image' }),
    /HTTP 503/,
  );
  assert.equal(calls, 4);
  assert.deepEqual(waits, [2000, 5000, 12000]);
});

test('resume scope 区分素材模式，但允许放宽验收边界继续克隆断点', () => {
  const { directory, dbPath } = tempDb();
  const store = new QuestionSyncStore(dbPath, { dataDir: directory });
  try {
    const noAssets = store.beginRun({
      textbookId: '260617', bankId: 2, bankPath: 'czsx', downloadAssets: false,
      maxCatalogs: 1, maxPages: 1, limit: 5,
    });
    store.finishRun(noAssets, 'interrupted', {});
    const withAssets = store.beginRun({
      textbookId: '260617', bankId: 2, bankPath: 'czsx', downloadAssets: true,
      maxCatalogs: 100, maxPages: 1000, limit: 0,
    });
    assert.notEqual(withAssets, noAssets);
    assert.equal(store.lastBeginMeta.clonedFrom, null);

    const widerProbe = store.beginRun({
      textbookId: '260617', bankId: 2, bankPath: 'czsx', downloadAssets: false,
      maxCatalogs: 100, maxPages: 1000, limit: 0,
    });
    assert.notEqual(widerProbe, noAssets);
    assert.equal(store.lastBeginMeta.clonedFrom, noAssets);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('全新 SQLite 自包含错误与原始列表快照表，且均可实际写入', () => {
  const { directory, dbPath } = tempDb();
  const store = new QuestionSyncStore(dbPath, { dataDir: directory });
  try {
    const runId = store.beginRun({ textbookId: '260617', bankId: 2, bankPath: 'czsx' });
    const nodes = [{
      externalId: '261285', name: '第一章', level: 1, type: 'chapter',
      ancestorIds: ['261285'], categoryId: '261285', catelogTokpointId: '0',
    }];
    store.savePage({
      runId,
      textbookExternalId: '260617',
      catalog: { ...nodes[0], chapterExternalId: '261285' },
      nodes,
      pageNumber: 1,
      expectedTotal: 0,
      expectedPages: 0,
      questions: [],
      queryFingerprint: 'fresh-db-raw',
      rawSnapshot: {
        sourceUrl: 'https://zujuan.xkw.com/zujuan-api/question/list',
        contentHash: 'b'.repeat(64),
        filePath: path.join(directory, 'raw', 'page.json.gz'),
      },
    });
    store.recordError(
      runId,
      'test',
      new QuestionSyncError('原始错误', 'original_failure'),
      'https://zujuan.xkw.com/zujuan-api/question/list',
    );
    assert.equal(store.db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('source_snapshots', 'sync_errors')",
    ).get().n, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM source_snapshots WHERE run_id = ?').get(runId).n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_errors WHERE run_id = ?').get(runId).n, 1);
    const foreignKeys = store.db.prepare('PRAGMA foreign_key_list(source_snapshots)').all();
    assert.ok(foreignKeys.some((row) => row.table === 'sync_runs' && row.from === 'run_id'));
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite 重放按 provider/question 去重，目录关系、素材、checkpoint 同事务保存', () => {
  const { directory, dbPath } = tempDb();
  const store = new QuestionSyncStore(dbPath, { dataDir: directory });
  try {
    const runId = store.beginRun({ textbookId: '260617', bankId: 2, bankPath: 'czsx' });
    const nodes = [
      { externalId: '261285', name: '第一章', level: 1, type: 'chapter', ancestorIds: ['261285'], categoryId: '261285', catelogTokpointId: '0' },
      { externalId: '261286', parentExternalId: '261285', name: '第一节', level: 2, type: 'section', ancestorIds: ['261285', '261286'], categoryId: '261286', catelogTokpointId: '0' },
      { externalId: '5597', parentExternalId: '261286', name: '知识点', level: 3, type: 'point', isKnowledge: true, ancestorIds: ['261285', '261286', '5597'], categoryId: '261286', catelogTokpointId: '5597' },
    ];
    const question = parseQuestionListPayload({ code: '0', data: { total: 1, html: LIST_HTML } }).questions[0];
    question.assets[0] = { ...question.assets[0], storagePath: 'assets/aa/formula.png', contentSha256: 'a'.repeat(64) };
    store.saveCatalogTree(runId, '260617', nodes);
    const catalog = { ...nodes[2], chapterExternalId: '261285' };
    store.savePage({ runId, textbookExternalId: '260617', catalog, nodes, pageNumber: 1, expectedTotal: 1, expectedPages: 1, questions: [question], queryFingerprint: 'scope-1' });
    store.savePage({ runId, textbookExternalId: '260617', catalog, nodes, pageNumber: 1, expectedTotal: 1, expectedPages: 1, questions: [question], queryFingerprint: 'scope-1' });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM questions').get().n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_run_question_items').get().n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_run_question_catalogs').get().n, 3);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_run_question_assets').get().n, 1);
    assert.equal(store.getRunCheckpoint(runId, 'scope-1'), 1);
    const row = store.db.prepare('SELECT detail_fetched, content_source, content_complete, answer_status FROM sync_run_question_items').get();
    assert.deepEqual({ ...row }, { detail_fetched: 0, content_source: 'list_api', content_complete: 1, answer_status: 'not_collected' });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_run_question_tags WHERE dimension = \'provider_category\'').get().n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_run_question_tags WHERE dimension = \'category\'').get().n, 0);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('默认有头、固定 profile，完整抓取才允许 success', () => {
  const script = require('../zujuan_question_sync.cjs');
  const options = script.parseArgs([]);
  assert.equal(options.headless, false);
  assert.match(options.profileDir, /zujuan-sync-profile$/);
  assert.equal(script.parseArgs(['--cdp-url', 'http://127.0.0.1:9222']).cdpUrl, 'http://127.0.0.1:9222');
  assert.equal(options.delayMin, 2500);
  assert.equal(options.delayMax, 4000);
  assert.equal(script.parseDifficulty('较易 (0.85)').label, '较易');
  assert.throws(() => script.parseQuestionListPayload({ code: '0', data: { total: 1, html: '' } }), QuestionSyncError);
});

test('HTTP Collector 兼容参数映射为固定教材范围，并支持指定 run 续采', () => {
  const options = parseArgs([
    '--acknowledge-source-policy',
    '--textbook-id', '260617',
    '--chapter-id', '261314',
    '--max-pages', '3',
    '--resume-run-id', '19',
  ]);
  assert.equal(options.chapterId, '261314');
  assert.equal(options.resumeRunId, 19);
  assert.deepEqual(buildScope(options).chapterIds, ['261314']);
  assert.deepEqual(buildScope(options).catalogLevels, [1, 2, 3]);
  assert.equal(buildScope(options).detailFallback, true);
  assert.equal(buildScope(options).requireAssets, true);
  assert.throws(
    () => parseArgs(['--resume-run-id', '19', '--no-resume']),
    /不能与 --no-resume 同时使用/,
  );
});

test('CDP 连接共享 context 但新建专用 tab，结束不关闭用户 browser/context', async () => {
  const { directory, dbPath } = tempDb();
  const userPage = {
    url: () => 'https://zujuan.xkw.com/czsx/zj260617/',
    close: async () => { throw new Error('user tab must not close'); },
  };
  let ownPageClosed = false;
  const page = {
    goto: async () => ({ status: 200 }),
    evaluate: async () => ({ status: 200, headers: {}, text: JSON.stringify({
      code: '0', data: { total: 1, html: LIST_HTML },
    }) }),
    close: async () => { ownPageClosed = true; },
  };
  let contextClosed = false;
  let browserClosed = false;
  const context = {
    pages: () => [userPage],
    newPage: async () => page,
    close: async () => { contextClosed = true; },
  };
  const browser = {
    contexts: () => [context],
    close: async () => { browserClosed = true; },
  };
  try {
    const result = await runSync({
      baseUrl: 'https://zujuan.xkw.com', treeBaseUrl: 'https://static.zxxk.com',
      apiPath: '/zujuan-api/question/list', bankId: 2, bankPath: 'czsx', textbookId: '260617',
      catalogIds: [], catalogLevels: [], maxCatalogs: 0, startPage: 1, maxPages: 1,
      maxPagesProvided: true, limit: 0, headless: false, cdpUrl: 'http://127.0.0.1:9222',
      delayMin: 0, delayMax: 0, timeout: 1000, verificationTimeout: 1000,
      verificationPoll: 0, verificationProbeInterval: 1, downloadAssets: false,
      saveRaw: false, resume: false, dbPath, dataDir: directory, profileDir: directory,
      sleepFn: async () => {}, randomFn: () => 0,
    }, {
      playwright: { chromium: { connectOverCDP: async () => browser } },
      catalogTree: { id: '260617', title: '九年级上册', children: [{ id: '261285', title: '第一章', children: [] }] },
    });
    assert.equal(result.status, 'success');
    assert.equal(ownPageClosed, true);
    assert.equal(contextClosed, false);
    assert.equal(browserClosed, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI CDP 收尾在不关闭远端 browser 的情况下退出 transport 句柄', () => {
  const { directory, dbPath } = tempDb();
  const scriptPath = path.resolve(__dirname, '..', 'zujuan_question_sync.cjs');
  const childCode = `
    const Module = require('node:module');
    const originalLoad = Module._load;
    const tree = { id: '260617', title: '九年级上册', children: [{ id: '261285', title: '第一章', children: [] }] };
    const page = {
      goto: async () => ({ status: 200 }),
      evaluate: async (_fn, arg) => {
        if (typeof arg === 'string') return tree;
        if (arg && typeof arg === 'object' && arg.body) {
          return { status: 200, headers: {}, text: JSON.stringify({ code: '0', data: { total: 0, html: '' } }) };
        }
        return { challenge: false, text: '', title: '' };
      },
      close: async () => {},
    };
    const context = { pages: () => [], newPage: async () => page };
    const browser = { contexts: () => [context] };
    const fakePlaywright = { chromium: { connectOverCDP: async () => browser } };
    Module._load = function(request, parent, isMain) {
      if (request === 'playwright-core') return fakePlaywright;
      return originalLoad.call(this, request, parent, isMain);
    };
    process.argv = [process.execPath, ${JSON.stringify(scriptPath)},
      '--cdp-url', 'http://127.0.0.1:9222', '--db', ${JSON.stringify(dbPath)},
      '--data-dir', ${JSON.stringify(directory)}, '--profile-dir', ${JSON.stringify(directory)},
      '--max-catalogs', '1', '--max-pages', '1', '--delay-min', '0', '--delay-max', '0',
      '--verification-timeout', '100', '--verification-probe-interval', '1',
      '--no-download-assets', '--no-save-raw'];
    setInterval(() => {}, 60000);
    require(${JSON.stringify(scriptPath)}).runCli();
  `;
  try {
    const child = spawnSync(process.execPath, ['-e', childCode], {
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(child.error, undefined, child.error?.stack || child.stderr);
    assert.equal(child.status, 0, child.stderr);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('--limit 只在完整 API 页落库后停止，不推进半页 checkpoint', async () => {
  const { directory, dbPath } = tempDb();
  const firstPageHtml = Array.from({ length: 10 }, (_, index) => (
    LIST_HTML.replaceAll('35020603', String(70000000 + index))
  )).join('');
  const apiPages = [];
  const page = {
    goto: async () => ({ status: 200 }),
    evaluate: async (_fetchFn, args) => {
      if (args?.body) apiPages.push(Number(new URLSearchParams(args.body).get('curPage')));
      return { status: 200, headers: {}, text: JSON.stringify({
        code: '0', data: { total: 11, html: firstPageHtml },
      }) };
    },
  };
  const options = {
    baseUrl: 'https://zujuan.xkw.com', treeBaseUrl: 'https://static.zxxk.com',
    apiPath: '/zujuan-api/question/list', bankId: 2, bankPath: 'czsx', textbookId: '260617',
    catalogIds: [], catalogLevels: [], maxCatalogs: 0, startPage: 1, maxPages: 1000,
    maxPagesProvided: false, limit: 5, headless: false, cdpUrl: null,
    delayMin: 0, delayMax: 0, timeout: 1000, verificationTimeout: 1000,
    verificationPoll: 0, verificationProbeInterval: 1, downloadAssets: false,
    saveRaw: false, resume: false, dbPath, dataDir: directory, profileDir: directory,
    sleepFn: async () => {}, randomFn: () => 0,
  };
  try {
    const result = await runSync(options, {
      context: {},
      page,
      catalogTree: { id: '260617', title: '九年级上册', children: [{ id: '261285', title: '第一章', children: [] }] },
    });
    assert.equal(result.status, 'interrupted');
    assert.equal(result.counters.questionsSeen, 10);
    assert.deepEqual(apiPages, [1]);
    const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const row = replay.db.prepare('SELECT page_number, question_count FROM sync_run_catalog_pages').get();
      assert.deepEqual({ ...row }, { page_number: 1, question_count: 10 });
      const checkpoint = replay.db.prepare('SELECT last_completed_page FROM sync_run_checkpoints WHERE run_id = ?').get(result.runId);
      assert.equal(checkpoint.last_completed_page, 1);
    } finally {
      replay.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('request gate 串行安排页面请求间隔', async () => {
  let now = 1000;
  const originalNow = Date.now;
  const waits = [];
  Date.now = () => now;
  try {
    const gate = createRequestGate(10, 10);
    const wait = async (ms) => { waits.push(ms); now += ms; };
    await gate(wait);
    await gate(wait);
    assert.deepEqual(waits, [10]);
  } finally {
    Date.now = originalNow;
  }
});
