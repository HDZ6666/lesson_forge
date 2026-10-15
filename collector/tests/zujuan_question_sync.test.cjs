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
  parseQuestionListTotalPayload,
  parseDifficulty,
  parseArgs,
  postQuestionList,
  retryDelay,
  runSync,
  selectCatalogs,
  serializeFormBody,
  validatePageResult,
  listWindow,
  catalogLastPage,
  catalogSafetyPageLimit,
  growTargetPages,
  isCookieSwitchError,
  isPageLevelError,
  DEFAULT_LIST_CONCURRENCY,
  DEFAULT_PAGINATION_SAFETY_LIMIT,
  PAGE_RESULT,
  SITE_PAGE_LIMIT,
  VerificationRequiredError,
} = require('../zujuan_question_sync.cjs');
const { readLiveRunProgress } = require('../src/storage/readers/index.cjs');

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

function listHtml(questionId) {
  return LIST_HTML.replaceAll('35020603', String(questionId));
}

function listApiText(total, questionIds) {
  const html = (Array.isArray(questionIds) ? questionIds : []).map((id) => listHtml(id)).join('');
  return JSON.stringify({ code: '0', data: { total, html } });
}

function mockSyncPage(handler) {
  return {
    goto: async () => ({ status: 200 }),
    url: () => 'https://zujuan.xkw.com/czsx/zj261285/',
    isClosed: () => false,
    evaluate: async (_fn, args) => {
      if (!args || typeof args !== 'object' || !args.body) {
        return { challenge: false, text: '', title: '' };
      }
      const params = new URLSearchParams(args.body);
      return handler({
        curPage: Number(params.get('curPage')),
        categoryId: String(params.get('categoryId') || ''),
        params,
      });
    },
    close: async () => {},
  };
}

function baseSyncOptions(directory, dbPath, extra = {}) {
  return {
    baseUrl: 'https://zujuan.xkw.com',
    treeBaseUrl: 'https://static.zxxk.com',
    apiPath: '/zujuan-api/question/list',
    bankId: 2,
    bankPath: 'czsx',
    textbookId: '260617',
    catalogIds: [],
    catalogLevels: [],
    maxCatalogs: 0,
    startPage: 1,
    maxPages: 1000,
    maxPagesProvided: false,
    limit: 0,
    headless: false,
    cdpUrl: null,
    delayMin: 0,
    delayMax: 0,
    timeout: 1000,
    verificationTimeout: 1000,
    verificationPoll: 0,
    verificationProbeInterval: 1,
    downloadAssets: false,
    saveRaw: false,
    resume: false,
    concurrency: 8,
    fallbackProfileDirs: [],
    dbPath,
    dataDir: directory,
    profileDir: directory,
    sleepFn: async () => {},
    randomFn: () => 0,
    ...extra,
  };
}

const SAMPLE_TREE = {
  id: '260617',
  title: '九年级上册',
  children: [{ id: '261285', title: '第一章', children: [] }],
};

test('目录归一化使用嵌套 display parent，并正确生成知识点接口参数', () => {
  const tree = normalizeCatalogTree({
    bankId: 2,
    id: '260617',
    parentId: '195847',
    title: '九年级上册',
    children: [
      {
        id: '261285',
        title: '第一章',
        isKnowledge: 0,
        parentId: '260617',
        children: [
          {
            id: '261286',
            title: '第一节',
            isKnowledge: 0,
            parentId: '261285',
            children: [
              {
                id: '5597',
                title: '知识点',
                isKnowledge: 1,
                parentId: '9999',
                href: '/czsx/zj261286/ctk5597',
                children: [],
              },
            ],
          },
        ],
      },
    ],
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
  const body = buildQuestionListBody(
    options,
    {
      externalId: '5597',
      categoryId: '261286',
      catelogTokpointId: '5597',
    },
    7,
  );
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
  await postQuestionList(
    page,
    {
      baseUrl: 'https://zujuan.xkw.com',
      bankId: 2,
      delayMin: 0,
      delayMax: 0,
    },
    { externalId: '261285', categoryId: '261285', catelogTokpointId: '0' },
    1,
  );
  assert.equal(typeof evaluateArgs.body, 'string');
  assert.match(evaluateArgs.body, /categoryIds%5B0%5D=0/);
  assert.equal(evaluateArgs.credentials, 'include');
  assert.equal(evaluateArgs.headers['X-Requested-With'], 'XMLHttpRequest');
});

test('题型、页面三档难度、原始 qdid、来源分类和使用统计完整保留', () => {
  const parsed = parseQuestionListPayload({
    code: '0',
    data: { total: 1, html: LIST_HTML },
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
  assert.deepEqual(
    question.knowledge.map((entry) => [entry.kind, entry.externalId]),
    [
      ['knowledge_point', '223709'],
      ['ability', '15091'],
    ],
  );
  assert.deepEqual(
    question.providerLabels.map((entry) => entry.value),
    ['名校', '新题'],
  );
  assert.equal(question.assets[0].type, 'formula_image');
  assert.ok(FORMAL_ASSET_TYPES.includes(question.assets[0].assetType));
  assert.equal(normalizeAssetType('https://x/thing.svg'), 'svg');
  assert.equal(normalizeAssetType('https://x/thing.bin'), 'other');
});

test('分页校验允许空页和跨页部分重复，但拒绝完全相同的非空页', () => {
  const page = {
    total: 10012,
    questions: Array.from({ length: 10 }, (_, index) => ({ externalId: String(index + 1) })),
    questionIds: Array.from({ length: 10 }, (_, index) => String(index + 1)),
  };
  const signature = validatePageResult(page, 1, 1002, new Set());
  assert.equal(typeof signature, 'string');
  assert.equal(validatePageResult({ total: 10013, questions: [], questionIds: [] }, 2, 1002, new Set()), null);
  const overlapping = {
    total: 10013,
    questions: [{ externalId: '9' }, { externalId: '11' }],
    questionIds: ['9', '11'],
  };
  assert.equal(
    typeof validatePageResult(overlapping, 2, 1002, new Set([signature]), new Set(page.questionIds), 10012),
    'string',
  );
  assert.throws(() => validatePageResult(page, 2, 1002, new Set([signature])), /重复/);
  assert.throws(
    () =>
      validatePageResult(
        { total: 1, questions: [{ externalId: '1' }, { externalId: '1' }], questionIds: ['1', '1'] },
        1,
        1,
        new Set(),
      ),
    /重复/,
  );
});

test('HTTP 重试/验证分类及退避策略', () => {
  assert.equal(isPageLevelError({ code: 'http_500' }), true);
  assert.equal(isPageLevelError({ code: 'waiting_verification' }), false);
  assert.equal(classifyQuestionResponse({ status: 503, text: 'busy' }).kind, 'retry');
  assert.equal(classifyQuestionResponse({ status: 429, text: 'slow' }).throttled, true);
  assert.equal(classifyQuestionResponse({ status: 403, text: 'forbidden' }).kind, 'fatal');
  assert.equal(classifyQuestionResponse({ status: 403, text: '请完成滑块验证' }).kind, 'verification');
  assert.equal(classifyQuestionResponse({ status: 200, text: '<html>验证码</html>' }).kind, 'verification');
  assert.equal(
    retryDelay('normal', 0, {}, () => 0),
    2000,
  );
  assert.equal(
    retryDelay('normal', 2, {}, () => 0),
    12000,
  );
  assert.equal(
    retryDelay('429', 0, { 'retry-after': '7' }, () => 0),
    7000,
  );
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
    downloadAsset(
      context,
      {
        timeout: 1000,
        dataDir: os.tmpdir(),
        sleepFn: async (ms) => waits.push(ms),
        randomFn: () => 0,
      },
      { sourceUrl: 'https://staticzujuan.xkw.com/quesimg/a.png', type: 'question_image' },
    ),
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
      textbookId: '260617',
      bankId: 2,
      bankPath: 'czsx',
      downloadAssets: false,
      maxCatalogs: 1,
      maxPages: 1,
      limit: 5,
    });
    store.finishRun(noAssets, 'interrupted', {});
    const withAssets = store.beginRun({
      textbookId: '260617',
      bankId: 2,
      bankPath: 'czsx',
      downloadAssets: true,
      maxCatalogs: 100,
      maxPages: 1000,
      limit: 0,
    });
    assert.notEqual(withAssets, noAssets);
    assert.equal(store.lastBeginMeta.clonedFrom, null);

    const limited = store.beginRun({
      textbookId: '260617',
      bankId: 2,
      bankPath: 'czsx',
      downloadAssets: false,
      limitTo1000Pages: true,
      maxCatalogs: 100,
      maxPages: 1000,
      limit: 0,
    });
    assert.notEqual(limited, noAssets);
    assert.equal(store.lastBeginMeta.clonedFrom, null);

    const widerProbe = store.beginRun({
      textbookId: '260617',
      bankId: 2,
      bankPath: 'czsx',
      downloadAssets: false,
      maxCatalogs: 100,
      maxPages: 1000,
      limit: 0,
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
    const nodes = [
      {
        externalId: '261285',
        name: '第一章',
        level: 1,
        type: 'chapter',
        ancestorIds: ['261285'],
        categoryId: '261285',
        catelogTokpointId: '0',
      },
    ];
    const question = parseQuestionListPayload({ code: '0', data: { total: 1, html: LIST_HTML } }).questions[0];
    store.savePage({
      runId,
      textbookExternalId: '260617',
      catalog: { ...nodes[0], chapterExternalId: '261285' },
      nodes,
      pageNumber: 1,
      expectedTotal: 1,
      expectedPages: 1,
      questions: [question],
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
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('source_snapshots', 'sync_errors')",
        )
        .get().n,
      2,
    );
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
      {
        externalId: '261285',
        name: '第一章',
        level: 1,
        type: 'chapter',
        ancestorIds: ['261285'],
        categoryId: '261285',
        catelogTokpointId: '0',
      },
      {
        externalId: '261286',
        parentExternalId: '261285',
        name: '第一节',
        level: 2,
        type: 'section',
        ancestorIds: ['261285', '261286'],
        categoryId: '261286',
        catelogTokpointId: '0',
      },
      {
        externalId: '5597',
        parentExternalId: '261286',
        name: '知识点',
        level: 3,
        type: 'point',
        isKnowledge: true,
        ancestorIds: ['261285', '261286', '5597'],
        categoryId: '261286',
        catelogTokpointId: '5597',
      },
    ];
    const question = parseQuestionListPayload({ code: '0', data: { total: 1, html: LIST_HTML } }).questions[0];
    question.assets[0] = { ...question.assets[0], storagePath: 'assets/aa/formula.png', contentSha256: 'a'.repeat(64) };
    store.saveCatalogTree(runId, '260617', nodes);
    const catalog = { ...nodes[2], chapterExternalId: '261285' };
    store.savePage({
      runId,
      textbookExternalId: '260617',
      catalog,
      nodes,
      pageNumber: 1,
      expectedTotal: 1,
      expectedPages: 1,
      questions: [question],
      queryFingerprint: 'scope-1',
    });
    store.savePage({
      runId,
      textbookExternalId: '260617',
      catalog,
      nodes,
      pageNumber: 1,
      expectedTotal: 1,
      expectedPages: 1,
      questions: [question],
      queryFingerprint: 'scope-1',
    });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM questions').get().n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_run_question_items').get().n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_run_question_catalogs').get().n, 3);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_run_question_assets').get().n, 1);
    assert.equal(store.getRunCheckpoint(runId, 'scope-1'), 1);
    const row = store.db
      .prepare('SELECT detail_fetched, content_source, content_complete, answer_status FROM sync_run_question_items')
      .get();
    assert.deepEqual(
      { ...row },
      { detail_fetched: 0, content_source: 'list_api', content_complete: 1, answer_status: 'not_collected' },
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM sync_run_question_tags WHERE dimension = 'provider_category'").get()
        .n,
      1,
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM sync_run_question_tags WHERE dimension = 'category'").get().n,
      0,
    );
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
  assert.equal(options.concurrency, 8);
  assert.equal(options.limitTo1000Pages, false);
  assert.equal(script.parseArgs(['--limit-to-1000-pages']).limitTo1000Pages, true);
  assert.equal(DEFAULT_LIST_CONCURRENCY, 8);
  assert.deepEqual(listWindow(1, Infinity, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(listWindow(1002, 1005, 8), [1002, 1003, 1004, 1005]);
  assert.equal(catalogLastPage({ maxPagesProvided: false, maxPages: 1000 }), DEFAULT_PAGINATION_SAFETY_LIMIT);
  assert.equal(catalogLastPage({ maxPagesProvided: false }), DEFAULT_PAGINATION_SAFETY_LIMIT);
  assert.equal(catalogLastPage({ maxPagesProvided: true, maxPages: 3 }), 3);
  assert.equal(catalogLastPage({ maxPages: 5000 }), DEFAULT_PAGINATION_SAFETY_LIMIT);
  assert.equal(catalogLastPage({ maxPagesProvided: true, maxPages: 5000 }), 5000);
  assert.equal(catalogSafetyPageLimit({}), DEFAULT_PAGINATION_SAFETY_LIMIT);
  assert.equal(growTargetPages(0, 10020, 10), 1002);
  assert.equal(growTargetPages(1002, 10000, 10), 1002);
  assert.equal(SITE_PAGE_LIMIT, 1000);
  assert.equal(script.parseArgs(['--concurrency', '8']).concurrency, 8);
  assert.equal(script.parseDifficulty('较易 (0.85)').label, '较易');
  const emptyPage = script.parseQuestionListPayload({ code: '0', data: { total: 1, html: '' } });
  assert.deepEqual(emptyPage.questionIds, []);
  assert.equal(emptyPage.total, 1);
  assert.throws(() => script.parseQuestionListPayload({ code: '1', data: { total: 1, html: '' } }), QuestionSyncError);
  assert.throws(() => script.parseQuestionListPayload('not-json'), QuestionSyncError);
});

test('HTTP Collector 兼容参数映射为固定教材范围，并支持指定 run 续采', () => {
  const options = parseArgs([
    '--acknowledge-source-policy',
    '--textbook-id',
    '260617',
    '--chapter-id',
    '261314',
    '--max-pages',
    '3',
    '--resume-run-id',
    '19',
  ]);
  assert.equal(options.chapterId, '261314');
  assert.equal(options.resumeRunId, 19);
  assert.deepEqual(buildScope(options).chapterIds, ['261314']);
  assert.deepEqual(buildScope(options).catalogLevels, [1, 2, 3]);
  assert.equal(buildScope(options).detailFallback, true);
  assert.equal(buildScope(options).requireAssets, true);
  assert.throws(() => parseArgs(['--resume-run-id', '19', '--no-resume']), /不能与 --no-resume 同时使用/);
});

test('CDP 连接共享 context 但新建专用 tab，结束不关闭用户 browser/context', async () => {
  const { directory, dbPath } = tempDb();
  const userPage = {
    url: () => 'https://zujuan.xkw.com/czsx/zj260617/',
    close: async () => {
      throw new Error('user tab must not close');
    },
  };
  let ownPageClosed = false;
  const page = {
    goto: async () => ({ status: 200 }),
    evaluate: async (_fn, args) => {
      if (!args || typeof args !== 'object' || !args.body) {
        return { challenge: false, text: '', title: '' };
      }
      const curPage = Number(new URLSearchParams(args.body).get('curPage'));
      const categoryId = String(new URLSearchParams(args.body).get('categoryId') || '');
      if (categoryId === '261285' && curPage > 1) {
        return { status: 200, headers: {}, text: listApiText(1, []) };
      }
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          code: '0',
          data: { total: 1, html: LIST_HTML },
        }),
      };
    },
    close: async () => {
      ownPageClosed = true;
    },
  };
  let contextClosed = false;
  let browserClosed = false;
  const context = {
    pages: () => [userPage],
    newPage: async () => page,
    close: async () => {
      contextClosed = true;
    },
  };
  const browser = {
    contexts: () => [context],
    close: async () => {
      browserClosed = true;
    },
  };
  try {
    const result = await runSync(
      {
        baseUrl: 'https://zujuan.xkw.com',
        treeBaseUrl: 'https://static.zxxk.com',
        apiPath: '/zujuan-api/question/list',
        bankId: 2,
        bankPath: 'czsx',
        textbookId: '260617',
        catalogIds: [],
        catalogLevels: [],
        maxCatalogs: 0,
        startPage: 1,
        maxPages: 1000,
        maxPagesProvided: false,
        limit: 0,
        headless: false,
        cdpUrl: 'http://127.0.0.1:9222',
        delayMin: 0,
        delayMax: 0,
        timeout: 1000,
        verificationTimeout: 1000,
        verificationPoll: 0,
        verificationProbeInterval: 1,
        downloadAssets: false,
        saveRaw: false,
        resume: false,
        dbPath,
        dataDir: directory,
        profileDir: directory,
        sleepFn: async () => {},
        randomFn: () => 0,
      },
      {
        playwright: { chromium: { connectOverCDP: async () => browser } },
        catalogTree: { id: '260617', title: '九年级上册', children: [{ id: '261285', title: '第一章', children: [] }] },
      },
    );
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
  const firstPageHtml = Array.from({ length: 10 }, (_, index) =>
    LIST_HTML.replaceAll('35020603', String(70000000 + index)),
  ).join('');
  const apiPages = [];
  const page = {
    goto: async () => ({ status: 200 }),
    evaluate: async (_fetchFn, args) => {
      if (args?.body) apiPages.push(Number(new URLSearchParams(args.body).get('curPage')));
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          code: '0',
          data: { total: 11, html: firstPageHtml },
        }),
      };
    },
  };
  const options = {
    baseUrl: 'https://zujuan.xkw.com',
    treeBaseUrl: 'https://static.zxxk.com',
    apiPath: '/zujuan-api/question/list',
    bankId: 2,
    bankPath: 'czsx',
    textbookId: '260617',
    catalogIds: [],
    catalogLevels: [],
    maxCatalogs: 0,
    startPage: 1,
    maxPages: 1000,
    maxPagesProvided: false,
    limit: 5,
    headless: false,
    cdpUrl: null,
    delayMin: 0,
    delayMax: 0,
    timeout: 1000,
    verificationTimeout: 1000,
    verificationPoll: 0,
    verificationProbeInterval: 1,
    downloadAssets: false,
    saveRaw: false,
    resume: false,
    dbPath,
    dataDir: directory,
    profileDir: directory,
    sleepFn: async () => {},
    randomFn: () => 0,
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
      const checkpoint = replay.db
        .prepare('SELECT last_completed_page FROM sync_run_checkpoints WHERE run_id = ?')
        .get(result.runId);
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
    const wait = async (ms) => {
      waits.push(ms);
      now += ms;
    };
    await gate(wait);
    await gate(wait);
    assert.deepEqual(waits, [10]);
  } finally {
    Date.now = originalNow;
  }
});

test('total 从 10012 变为 10013 后继续抓取，空页结束目录', async () => {
  const { directory, dbPath } = tempDb();
  const catalogPages = [];
  const totals = [];
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') {
      return { status: 200, headers: {}, text: listApiText(10012, ['35020603']) };
    }
    catalogPages.push(curPage);
    if (curPage === 1) {
      totals.push(10012);
      return { status: 200, headers: {}, text: listApiText(10012, ['80000001']) };
    }
    if (curPage === 2) {
      totals.push(10013);
      return { status: 200, headers: {}, text: listApiText(10013, ['80000002']) };
    }
    return { status: 200, headers: {}, text: listApiText(10013, []) };
  });
  try {
    const result = await runSync(baseSyncOptions(directory, dbPath), {
      context: {},
      page,
      catalogTree: SAMPLE_TREE,
    });
    assert.equal(result.status, 'success');
    assert.deepEqual(
      [...new Set(catalogPages)].sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.deepEqual(
      [...totals].sort((a, b) => a - b),
      [10012, 10013],
    );
    assert.equal(result.completeness.scanComplete, true);
    assert.equal(result.completeness.complete, true);
    assert.equal(result.completeness.counts.questionCount, 2);
    const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const progress = replay.getRunCatalogProgress(result.runId, '260617', '261285');
      assert.equal(progress.status, 'completed');
      assert.equal(progress.expectedTotal, 10013);
      assert.equal(progress.lastCompletedPage, 2);
      assert.equal(
        replay.db
          .prepare(
            "SELECT COUNT(*) AS n FROM sync_run_catalog_pages WHERE COALESCE(result_type, 'success') = 'success'",
          )
          .get().n,
        2,
      );
    } finally {
      replay.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('到达 expectedPages 后仍有题目时继续抓取', async () => {
  const { directory, dbPath } = tempDb();
  const catalogPages = [];
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') {
      return { status: 200, headers: {}, text: listApiText(10, ['35020603']) };
    }
    catalogPages.push(curPage);
    if (curPage === 1) return { status: 200, headers: {}, text: listApiText(10, ['80000011']) };
    if (curPage === 2) return { status: 200, headers: {}, text: listApiText(10, ['80000012']) };
    return { status: 200, headers: {}, text: listApiText(10, []) };
  });
  try {
    const result = await runSync(baseSyncOptions(directory, dbPath), {
      context: {},
      page,
      catalogTree: SAMPLE_TREE,
    });
    assert.equal(result.status, 'success');
    assert.deepEqual(
      [...new Set(catalogPages)].sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(result.completeness.counts.questionCount, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('跨页部分题号重复时按唯一题号统计且不失败', async () => {
  const { directory, dbPath } = tempDb();
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') {
      return { status: 200, headers: {}, text: listApiText(100, ['35020603']) };
    }
    if (curPage === 1) return { status: 200, headers: {}, text: listApiText(100, ['90000001', '90000002']) };
    if (curPage === 2) return { status: 200, headers: {}, text: listApiText(100, ['90000002', '90000003']) };
    return { status: 200, headers: {}, text: listApiText(100, []) };
  });
  try {
    const result = await runSync(baseSyncOptions(directory, dbPath), {
      context: {},
      page,
      catalogTree: SAMPLE_TREE,
    });
    assert.equal(result.status, 'success');
    assert.equal(result.counters.questionsSeen, 4);
    assert.equal(result.completeness.counts.questionCount, 3);
    const live = readLiveRunProgress(dbPath, result.runId, { textbookExternalId: '260617' });
    assert.equal(live.available, true);
    assert.equal(live.collectedQuestionCount, 3);
    assert.equal(live.uniqueQuestionCount, 3);
    assert.equal(live.scanComplete, true);
    assert.equal(live.progressPercent, 100);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('完全相同的非空页重复时记录异常并结束扫描，不中断整本任务', async () => {
  const { directory, dbPath } = tempDb();
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') {
      return { status: 200, headers: {}, text: listApiText(20, ['35020603']) };
    }
    return { status: 200, headers: {}, text: listApiText(20, ['91000001']) };
  });
  try {
    const result = await runSync(baseSyncOptions(directory, dbPath), {
      context: {},
      page,
      catalogTree: SAMPLE_TREE,
    });
    assert.equal(result.status, 'success');
    assert.equal(result.completeness.scanComplete, true);
    assert.equal(result.completeness.dataComplete, false);
    assert.equal(result.completeness.snapshotComplete, false);
    assert.equal(result.completeness.completionQuality, 'completed_with_issues');
    const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const progress = replay.getRunCatalogProgress(result.runId, '260617', '261285');
      assert.equal(progress.scanComplete, true);
      assert.equal(progress.dataComplete, false);
      assert.ok(progress.duplicatePageCount > 0);
    } finally {
      replay.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('未遇到空页就达到 --max-pages 或 --limit 时任务仍不完整', async () => {
  const { directory, dbPath } = tempDb();
  const maxPage = mockSyncPage(({ categoryId }) => ({
    status: 200,
    headers: {},
    text: categoryId === '261285' ? listApiText(10012, ['92000001']) : listApiText(10012, ['35020603']),
  }));
  try {
    const maxPagesResult = await runSync(
      baseSyncOptions(directory, dbPath, {
        maxPages: 1,
        maxPagesProvided: true,
      }),
      {
        context: {},
        page: maxPage,
        catalogTree: SAMPLE_TREE,
      },
    );
    assert.equal(maxPagesResult.status, 'interrupted');
    assert.equal(maxPagesResult.completeness.complete, false);
    assert.equal(maxPagesResult.completeness.scanComplete, false);
    assert.ok(maxPagesResult.completeness.reasons.some((reason) => /扫描完成|limit/.test(reason)));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const { directory: limitDir, dbPath: limitDb } = tempDb();
  const limitPage = mockSyncPage(({ categoryId }) => ({
    status: 200,
    headers: {},
    text: categoryId === '261285' ? listApiText(11, ['93000001', '93000002']) : listApiText(11, ['35020603']),
  }));
  try {
    const limitResult = await runSync(baseSyncOptions(limitDir, limitDb, { limit: 1 }), {
      context: {},
      page: limitPage,
      catalogTree: SAMPLE_TREE,
    });
    assert.equal(limitResult.status, 'interrupted');
    assert.equal(limitResult.completeness.complete, false);
    assert.ok(limitResult.completeness.reasons.some((reason) => /limit/.test(reason)));
  } finally {
    fs.rmSync(limitDir, { recursive: true, force: true });
  }
});

for (const pageLimit of [3, 1000, 1500]) {
  test(`计划数字上限 ${pageLimit} 不请求下一页，继续其他目录，到达窗口上限按正常结束`, async () => {
    const { directory, dbPath } = tempDb();
    const requested = new Map([
      ['261285', []],
      ['261286', []],
    ]);
    const page = mockSyncPage(({ curPage, categoryId }) => {
      if (!requested.has(categoryId)) return { status: 200, headers: {}, text: listApiText(104269, ['35020603']) };
      requested.get(categoryId).push(curPage);
      if (categoryId === '261285')
        return { status: 200, headers: {}, text: listApiText(104269, [String(97000000 + curPage)]) };
      return { status: 200, headers: {}, text: listApiText(1, curPage === 1 ? ['98000001'] : []) };
    });
    try {
      const result = await runSync(baseSyncOptions(directory, dbPath, { catalogPageLimit: pageLimit }), {
        context: {},
        page,
        catalogTree: {
          id: '260617',
          title: '测试教材',
          children: [
            { id: '261285', title: '大目录', children: [] },
            { id: '261286', title: '下一目录', children: [] },
          ],
        },
      });
      // Limits above the 1000-page window are clamped to it.
      const effective = Math.min(pageLimit, 1000);
      assert.equal(Math.max(...requested.get('261285')), effective);
      assert.ok(!requested.get('261285').includes(effective + 1));
      assert.ok(requested.get('261286').length > 0);
      // Reaching the configured window is a normal end (spec 5.1), not a gap.
      assert.equal(result.completeness.scanComplete, true);
      const store = new QuestionSyncStore(dbPath, { dataDir: directory });
      try {
        const progress = store.getRunCatalogProgress(result.runId, '260617', '261285');
        assert.equal(progress.pageLimitReached, true);
        assert.equal(progress.dataComplete, true);
        assert.equal(progress.stallReason, 'configured_page_limit');
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('最多 1000 页策略不请求第 1001 页、继续其他目录且按策略正常完成', async () => {
  const { directory, dbPath } = tempDb();
  const requested = new Map([
    ['261285', []],
    ['261286', []],
  ]);
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (!requested.has(categoryId)) return { status: 200, headers: {}, text: listApiText(10001, ['35020603']) };
    requested.get(categoryId).push(curPage);
    if (categoryId === '261285') {
      return { status: 200, headers: {}, text: listApiText(10001, [String(97000000 + curPage)]) };
    }
    return curPage === 1
      ? { status: 200, headers: {}, text: listApiText(1, ['98000001']) }
      : { status: 200, headers: {}, text: listApiText(1, []) };
  });
  try {
    const result = await runSync(
      baseSyncOptions(directory, dbPath, {
        limitTo1000Pages: true,
        safetyPageLimit: SITE_PAGE_LIMIT,
      }),
      {
        context: {},
        page,
        catalogTree: {
          id: '260617',
          title: '九年级上册',
          children: [
            { id: '261285', title: '第一章', children: [] },
            { id: '261286', title: '第二章', children: [] },
          ],
        },
      },
    );
    assert.equal(result.status, 'success');
    assert.equal(result.completeness.complete, true);
    assert.equal(Math.max(...requested.get('261285')), 1000);
    assert.ok(!requested.get('261285').includes(1001));
    assert.ok(requested.get('261286').length > 0, '达到上限后仍应继续其他目录');
    const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const limited = replay.getRunCatalogProgress(result.runId, '260617', '261285');
      assert.equal(limited.status, 'completed');
      assert.equal(limited.scanComplete, true);
      assert.equal(limited.dataComplete, true);
      assert.equal(limited.pageLimitReached, true);
      assert.equal(limited.stallReason, 'page_limit_1000');
      assert.equal(limited.targetPages, 1000);
      const second = replay.getRunCatalogProgress(result.runId, '260617', '261286');
      assert.equal(second.status, 'completed');
      const live = readLiveRunProgress(dbPath, result.runId, { textbookExternalId: '260617' });
      assert.equal(live.pageLimitReached, true);
      assert.equal(live.tree.find((node) => node.externalId === '261285')?.pageLimitReached, true);
    } finally {
      replay.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('最多 1000 页策略不会洗掉失败页，且失败页进度目标仍不超过上限', () => {
  const { directory, dbPath } = tempDb();
  const store = new QuestionSyncStore(dbPath, { dataDir: directory });
  try {
    const runId = store.beginRun({ textbookId: '260617', limitTo1000Pages: true });
    const catalog = {
      externalId: '261285',
      chapterExternalId: '261285',
      title: '第一章',
    };
    store.recordPageAttempt({
      runId,
      textbookExternalId: '260617',
      catalog,
      pageNumber: 1000,
      resultType: PAGE_RESULT.REQUEST_FAILED,
      errorCode: 'request_failed',
      queryFingerprint: 'policy-scope',
      expectedTotal: 10001,
      targetPages: 1000,
      targetPageLimit: SITE_PAGE_LIMIT,
    });
    const running = store.getRunCatalogProgress(runId, '260617', '261285');
    assert.equal(running.targetPages, SITE_PAGE_LIMIT);
    assert.equal(running.failedPageCount, 1);

    store.completeCatalog({
      runId,
      textbookExternalId: '260617',
      catalog,
      expectedTotal: 10001,
      expectedPages: SITE_PAGE_LIMIT,
      queryFingerprint: 'policy-scope',
      targetPageLimit: SITE_PAGE_LIMIT,
      pageLimitReached: true,
    });
    const completed = store.getRunCatalogProgress(runId, '260617', '261285');
    assert.equal(completed.pageLimitReached, true);
    assert.equal(completed.failedPageCount, 1);
    assert.equal(completed.dataComplete, false);
    assert.equal(completed.completionQuality, 'completed_with_issues');
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('最新排序续采重新扫描首屏，保留旧成果并补齐分页漂移的新题', async () => {
  const { directory, dbPath } = tempDb();
  const firstPage = mockSyncPage(({ categoryId }) => ({
    status: 200,
    headers: {},
    text: categoryId === '261285' ? listApiText(10012, ['94000001']) : listApiText(10012, ['35020603']),
  }));
  try {
    const first = await runSync(
      baseSyncOptions(directory, dbPath, {
        maxPages: 1,
        maxPagesProvided: true,
      }),
      {
        context: {},
        page: firstPage,
        catalogTree: SAMPLE_TREE,
      },
    );
    assert.equal(first.status, 'interrupted');
    const seed = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      seed.db
        .prepare(
          `
        UPDATE sync_run_catalog_progress
        SET status = 'completed', expected_pages = 1, expected_total = 10012
        WHERE run_id = ?
      `,
        )
        .run(first.runId);
      assert.equal(
        seed.getRunCheckpoint(
          first.runId,
          seed.db.prepare('SELECT scope_key FROM sync_run_checkpoints WHERE run_id = ?').get(first.runId).scope_key,
        ),
        1,
      );
    } finally {
      seed.close();
    }

    const catalogPages = [];
    const resumePage = mockSyncPage(({ curPage, categoryId }) => {
      if (categoryId !== '261285') {
        return { status: 200, headers: {}, text: listApiText(10013, ['35020603']) };
      }
      catalogPages.push(curPage);
      if (curPage === 2) return { status: 200, headers: {}, text: listApiText(10013, ['94000002']) };
      if (curPage >= 3) return { status: 200, headers: {}, text: listApiText(10013, []) };
      return { status: 200, headers: {}, text: listApiText(10013, ['94000003']) };
    });
    const second = await runSync(baseSyncOptions(directory, dbPath, { resume: true }), {
      context: {},
      page: resumePage,
      catalogTree: SAMPLE_TREE,
    });
    assert.equal(second.status, 'success');
    assert.equal(Math.min(...catalogPages), 1);
    assert.ok(catalogPages.includes(1));
    assert.equal(second.completeness.counts.questionCount, 3);
    const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const progress = replay.getRunCatalogProgress(second.runId, '260617', '261285');
      assert.equal(progress.status, 'completed');
      assert.equal(progress.lastCompletedPage, 2);
      assert.equal(progress.expectedTotal, 10013);
    } finally {
      replay.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('运行中目录 expectedTotal 跟随上游 total，完成后使用唯一题数', async () => {
  const { directory, dbPath } = tempDb();
  const store = new QuestionSyncStore(dbPath, { dataDir: directory });
  try {
    const runId = store.beginRun({ textbookId: '260617', bankId: 2, bankPath: 'czsx' });
    store.updateRunScope(runId, {
      textbookId: '260617',
      textbookExpectedTotal: 10012,
      summaryStrategy: 'textbook_root_probe',
    });
    const nodes = [
      {
        externalId: '261285',
        name: '第一章',
        level: 1,
        type: 'chapter',
        ancestorIds: ['261285'],
        categoryId: '261285',
        catelogTokpointId: '0',
      },
    ];
    const first = parseQuestionListPayload({ code: '0', data: { total: 1, html: listHtml('95000001') } }).questions[0];
    const second = parseQuestionListPayload({ code: '0', data: { total: 1, html: listHtml('95000002') } }).questions[0];
    store.saveCatalogTree(runId, '260617', nodes);
    const catalog = { ...nodes[0], chapterExternalId: '261285' };
    store.savePage({
      runId,
      textbookExternalId: '260617',
      catalog,
      nodes,
      pageNumber: 1,
      expectedTotal: 10012,
      expectedPages: 1002,
      questions: [first],
      queryFingerprint: 'live-total',
    });
    store.savePage({
      runId,
      textbookExternalId: '260617',
      catalog,
      nodes,
      pageNumber: 2,
      expectedTotal: 10013,
      expectedPages: 1002,
      questions: [second],
      queryFingerprint: 'live-total',
    });
    store.close();
    const running = readLiveRunProgress(dbPath, runId, { textbookExternalId: '260617' });
    assert.equal(running.available, true);
    assert.equal(running.tree[0].expectedTotal, 10013);
    assert.equal(running.tree[0].collectedCount, 2);
    assert.equal(running.collectedQuestionCount, 2);
    assert.equal(running.totalQuestionCount, 10012);
    assert.ok(running.progressPercent == null || running.progressPercent < 100);

    const finisher = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      finisher.completeCatalog({
        runId,
        textbookExternalId: '260617',
        catalog,
        expectedTotal: 10013,
        expectedPages: 1002,
        queryFingerprint: 'live-total',
      });
      const completeness = finisher.validateRunCompleteness(
        runId,
        {
          textbookId: '260617',
        },
        nodes,
        {},
      );
      assert.equal(completeness.complete, true);
      finisher.finishRun(runId, 'success', {}, null, { ...completeness, scope: { textbookId: '260617' } });
    } finally {
      finisher.close();
    }
    const done = readLiveRunProgress(dbPath, runId, { textbookExternalId: '260617' });
    assert.equal(done.collectedQuestionCount, 2);
    assert.equal(done.uniqueQuestionCount, 2);
    assert.equal(done.progressPercent, 100);
    assert.equal(done.scanComplete, true);
    assert.equal(done.tree[0].latestSourceTotal, 10013);
    assert.equal(done.tree[0].uniqueQuestionCount, 2);
    assert.equal(done.tree[0].collectedCount, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('total 缺失、非法或与题目矛盾时只忽略展示值，不失败', () => {
  const missing = parseQuestionListPayload({ code: '0', data: { html: LIST_HTML } });
  assert.equal(missing.questions[0].externalId, '35020603');
  assert.equal(missing.total, null);

  const invalid = parseQuestionListPayload({ code: '0', data: { total: 'abc', html: LIST_HTML } });
  assert.equal(invalid.questions.length, 1);
  assert.equal(invalid.total, null);

  const contradictory = parseQuestionListPayload({ code: '0', data: { total: 0, html: LIST_HTML } });
  assert.equal(contradictory.questions.length, 1);
  assert.equal(contradictory.total, null);

  const emptyKnown = parseQuestionListPayload({ code: '0', data: { total: 0, html: '' } });
  assert.deepEqual(emptyKnown.questionIds, []);
  assert.equal(emptyKnown.total, 0);

  assert.equal(parseQuestionListTotalPayload({ code: '0', data: {} }).total, null);
  const signature = validatePageResult(
    {
      total: null,
      questions: [{ externalId: '1' }],
      questionIds: ['1'],
    },
    1,
    null,
    new Set(),
  );
  assert.equal(typeof signature, 'string');
});

test('教材根目录 total 探针失败时降级为警告并继续采集', async () => {
  const { directory, dbPath } = tempDb();
  const catalogPages = [];
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') {
      return { status: 400, headers: {}, text: 'probe failed' };
    }
    catalogPages.push(curPage);
    if (curPage === 1)
      return { status: 200, headers: {}, text: JSON.stringify({ code: '0', data: { html: listHtml('96000001') } }) };
    return { status: 200, headers: {}, text: JSON.stringify({ code: '0', data: { html: '' } }) };
  });
  try {
    const result = await runSync(baseSyncOptions(directory, dbPath), {
      context: {},
      page,
      catalogTree: SAMPLE_TREE,
    });
    assert.equal(result.status, 'success');
    assert.ok(catalogPages.includes(1) && catalogPages.includes(2));
    assert.equal(result.completeness.counts.questionCount, 1);
    const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const scope = JSON.parse(replay.getRun(result.runId).scope_json);
      assert.equal(scope.textbookExpectedTotal, null);
      assert.equal(scope.summaryStrategy, 'textbook_root_probe_unavailable');
    } finally {
      replay.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('分页 total=0 但页面有题时继续抓取，空页仍结束目录', async () => {
  const { directory, dbPath } = tempDb();
  const catalogPages = [];
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') {
      return { status: 200, headers: {}, text: listApiText(0, []) };
    }
    catalogPages.push(curPage);
    if (curPage === 1) return { status: 200, headers: {}, text: listApiText(0, ['97000001']) };
    return { status: 200, headers: {}, text: listApiText(0, []) };
  });
  try {
    const result = await runSync(baseSyncOptions(directory, dbPath), {
      context: {},
      page,
      catalogTree: SAMPLE_TREE,
    });
    assert.equal(result.status, 'success');
    assert.ok(catalogPages.includes(1) && catalogPages.includes(2));
    assert.equal(result.completeness.counts.questionCount, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('列表默认 8 路并发请求，空页仍结束目录', async () => {
  const { directory, dbPath } = tempDb();
  const catalogPages = [];
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') {
      return { status: 200, headers: {}, text: listApiText(40, ['35020603']) };
    }
    catalogPages.push(curPage);
    if (curPage <= 2) {
      return { status: 200, headers: {}, text: listApiText(40, [`9800000${curPage}`]) };
    }
    return { status: 200, headers: {}, text: listApiText(40, []) };
  });
  try {
    const result = await runSync(baseSyncOptions(directory, dbPath), {
      context: {},
      page,
      catalogTree: SAMPLE_TREE,
    });
    assert.equal(result.status, 'success');
    assert.deepEqual(
      [...new Set(catalogPages)].sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(result.completeness.counts.questionCount, 2);
    const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      assert.equal(replay.getRunCatalogProgress(result.runId, '260617', '261285').lastCompletedPage, 2);
    } finally {
      replay.close();
    }
    const live = readLiveRunProgress(dbPath, result.runId, { textbookExternalId: '260617' });
    assert.equal(live.fetchWindows.length, 1);
    assert.equal(live.fetchWindows[0].catalogExternalId, '261285');
    assert.equal(live.fetchWindows[0].slots.length, 8);
    assert.equal(live.fetchWindows[0].slots[0].pageNumber, 1);
    assert.equal(live.fetchWindows[0].slots[0].status, 'saved');
    assert.match(String(live.fetchWindows[0].slots[0].line), /catalog=261285 page=1 questions=1 total=40/);
    assert.equal(live.fetchWindows[0].slots[2].status, 'empty');
    assert.equal(live.tree[0].current, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('人工验证仍失败才公共暂停，保留同窗口成功页，后续教材也不能换会话继续', async () => {
  const { directory, dbPath } = tempDb();
  let persistentLaunches = 0;
  let freshLaunches = 0;
  const makePage = (blocked) =>
    mockSyncPage(({ curPage, categoryId }) => {
      if (categoryId !== '261285') {
        return { status: 200, headers: {}, text: listApiText(20, ['35020603']) };
      }
      if (blocked && curPage === 2) {
        return { status: 403, headers: {}, text: '<html>验证码</html>' };
      }
      if (curPage === 1) return { status: 200, headers: {}, text: listApiText(30, ['99000001']) };
      if (curPage === 2) return { status: 200, headers: {}, text: listApiText(20, ['99000002']) };
      if (curPage === 3) return { status: 200, headers: {}, text: listApiText(30, ['99000003']) };
      return { status: 200, headers: {}, text: listApiText(20, []) };
    });
  const firstPage = makePage(true);
  const secondPage = makePage(false);
  const makeContext = (current) => ({
    pages: () => [current],
    newPage: async () => current,
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    close: async () => {},
  });
  const playwright = {
    chromium: {
      launchPersistentContext: async () => {
        persistentLaunches += 1;
        return makeContext(firstPage);
      },
      launch: async () => {
        freshLaunches += 1;
        return {
          newContext: async () => makeContext(secondPage),
          close: async () => {},
        };
      },
    },
  };
  try {
    await assert.rejects(
      runSync(
        baseSyncOptions(directory, dbPath, {
          profileDir: path.join(directory, 'main-profile'),
        }),
        {
          playwright,
          catalogTree: SAMPLE_TREE,
        },
      ),
      (error) => error.code === 'waiting_verification',
    );
    assert.equal(persistentLaunches, 1);
    assert.equal(freshLaunches, 0);
    const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const run = replay.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
      assert.equal(run.status, 'blocked');
      assert.equal(replay.db.prepare('SELECT COUNT(*) AS n FROM sync_run_question_items').get().n, 2);
    } finally {
      replay.close();
    }
    await assert.rejects(
      runSync(baseSyncOptions(directory, dbPath), { playwright }),
      (error) => error.code === 'source_verification',
    );
    assert.equal(persistentLaunches, 1);
    assert.equal(isCookieSwitchError(new VerificationRequiredError('x')), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const mode of ['source_budget', 'resource_pressure']) {
  test(`${mode} 暂停会封存同窗口成功页和后续失败页`, async () => {
    const { directory, dbPath } = tempDb();
    let memory = 100 * 1024 * 1024;
    let clock = Date.now();
    let listCalls = 0;
    const page = mockSyncPage(({ curPage, categoryId }) => {
      if (categoryId !== '261285') return { status: 200, headers: {}, text: listApiText(30, ['35020603']) };
      listCalls += 1;
      if (curPage === 1) {
        if (mode === 'resource_pressure') memory = 0;
        return { status: 200, headers: {}, text: listApiText(30, ['99000101']) };
      }
      throw new Error('额度/水位暂停后不应继续请求后续页');
    });
    try {
      await assert.rejects(
        runSync(baseSyncOptions(directory, dbPath, { concurrency: 8 }), {
          context: {},
          page,
          catalogTree: SAMPLE_TREE,
          sourceBudgetOptions: { requestLimit: mode === 'source_budget' ? 3 : 0 },
          resourceGuardOptions: { minMemoryMiB: 1, memoryReader: () => memory, clock: () => (clock += 1001) },
        }),
        (error) => error.code === mode,
      );
      assert.equal(listCalls, 1);
      const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
      try {
        const run = replay.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
        assert.equal(run.status, 'blocked');
        assert.ok(run.snapshot_locked_at);
        const ids = replay.db.prepare('SELECT question_external_id FROM sync_run_question_items').all();
        assert.deepEqual(
          ids.map((row) => row.question_external_id),
          ['99000101'],
        );
        const pages = replay.db
          .prepare('SELECT page_number, result_type FROM sync_run_catalog_pages ORDER BY page_number')
          .all();
        assert.equal(pages[0].result_type, PAGE_RESULT.SUCCESS);
        assert.ok(pages.some((row) => row.page_number > 1 && row.result_type !== PAGE_RESULT.SUCCESS));
      } finally {
        replay.close();
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('安全页数上限只标记知识点异常并继续，不作为正常完成', async () => {
  const { directory, dbPath } = tempDb();
  const catalogPages = [];
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') {
      return { status: 200, headers: {}, text: listApiText(40, ['35020603']) };
    }
    catalogPages.push(curPage);
    return { status: 200, headers: {}, text: listApiText(40, [String(96000000 + curPage)]) };
  });
  try {
    const result = await runSync(
      baseSyncOptions(directory, dbPath, {
        maxPages: 1000,
        maxPagesProvided: false,
        safetyPageLimit: 3,
        concurrency: 8,
      }),
      {
        context: {},
        page,
        catalogTree: SAMPLE_TREE,
      },
    );
    assert.equal(result.status, 'success');
    assert.equal(Math.max(...catalogPages), 3);
    assert.ok(!catalogPages.includes(4));
    assert.equal(result.completeness.scanComplete, true);
    assert.equal(result.completeness.dataComplete, false);
    assert.equal(result.completeness.snapshotComplete, false);
    const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const progress = replay.getRunCatalogProgress(result.runId, '260617', '261285');
      assert.equal(progress.status, 'stalled');
      assert.equal(progress.stallReason, 'pagination_safety_limit');
      assert.equal(progress.scanComplete, true);
      assert.equal(progress.dataComplete, false);
    } finally {
      replay.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('并发窗口中间页失败时仍保存后续成功页', async () => {
  const { directory, dbPath } = tempDb();
  const catalogPages = [];
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') {
      return { status: 200, headers: {}, text: listApiText(30, ['35020603']) };
    }
    catalogPages.push(curPage);
    if (curPage === 2) return { status: 500, headers: {}, text: 'busy' };
    if (curPage === 1) return { status: 200, headers: {}, text: listApiText(30, ['98100001']) };
    if (curPage === 3) return { status: 200, headers: {}, text: listApiText(30, ['98100003']) };
    return { status: 200, headers: {}, text: listApiText(30, []) };
  });
  try {
    const result = await runSync(baseSyncOptions(directory, dbPath, { concurrency: 8 }), {
      context: {},
      page,
      catalogTree: SAMPLE_TREE,
    });
    assert.equal(result.status, 'success');
    assert.equal(result.completeness.scanComplete, true);
    assert.equal(result.completeness.dataComplete, false);
    assert.equal(result.completeness.snapshotComplete, false);
    assert.ok(catalogPages.includes(1) && catalogPages.includes(3));
    const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const ids = replay.db
        .prepare('SELECT question_external_id AS id FROM sync_run_question_items ORDER BY question_external_id')
        .all()
        .map((row) => row.id);
      assert.deepEqual(ids, ['98100001', '98100003']);
      const pages = replay.db
        .prepare('SELECT page_number, result_type FROM sync_run_catalog_pages ORDER BY page_number')
        .all();
      assert.equal(pages.find((row) => Number(row.page_number) === 2).result_type, PAGE_RESULT.REQUEST_FAILED);
      assert.equal(pages.find((row) => Number(row.page_number) === 3).result_type, PAGE_RESULT.SUCCESS);
      const progress = replay.getRunCatalogProgress(result.runId, '260617', '261285');
      assert.equal(progress.lastCompletedPage, 1);
      assert.ok(progress.highestAttemptedPage >= 3);
    } finally {
      replay.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('目标范围内空页且后续仍有题时继续采集并记为数据异常', async () => {
  const { directory, dbPath } = tempDb();
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') {
      return { status: 200, headers: {}, text: listApiText(40, ['35020603']) };
    }
    if (curPage === 1) return { status: 200, headers: {}, text: listApiText(40, ['98200001']) };
    if (curPage === 2) return { status: 200, headers: {}, text: listApiText(40, []) };
    if (curPage === 3) return { status: 200, headers: {}, text: listApiText(40, ['98200003']) };
    return { status: 200, headers: {}, text: listApiText(40, []) };
  });
  try {
    const result = await runSync(baseSyncOptions(directory, dbPath), {
      context: {},
      page,
      catalogTree: SAMPLE_TREE,
    });
    assert.equal(result.status, 'success');
    assert.equal(result.completeness.scanComplete, true);
    assert.equal(result.completeness.dataComplete, false);
    const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const ids = replay.db
        .prepare('SELECT question_external_id AS id FROM sync_run_question_items ORDER BY question_external_id')
        .all()
        .map((row) => row.id);
      assert.deepEqual(ids, ['98200001', '98200003']);
      const empty = replay.db
        .prepare("SELECT page_number FROM sync_run_catalog_pages WHERE result_type = 'empty_page'")
        .all();
      assert.ok(empty.some((row) => Number(row.page_number) === 2));
    } finally {
      replay.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('一个知识点卡死后继续采集下一个知识点', async () => {
  const { directory, dbPath } = tempDb();
  const requested = [];
  const tree = {
    id: '260617',
    title: '九年级上册',
    children: [
      { id: '261285', title: '第一章', children: [] },
      { id: '261286', title: '第二章', children: [] },
    ],
  };
  const page = mockSyncPage(({ curPage, categoryId }) => {
    requested.push(`${categoryId}:${curPage}`);
    if (categoryId === '261285') {
      return { status: 200, headers: {}, text: listApiText(30, [`${97000000 + curPage}`]) };
    }
    if (categoryId === '261286') {
      if (curPage === 1) return { status: 200, headers: {}, text: listApiText(10, ['98300001']) };
      return { status: 200, headers: {}, text: listApiText(10, []) };
    }
    return { status: 200, headers: {}, text: listApiText(10, ['35020603']) };
  });
  try {
    const result = await runSync(
      baseSyncOptions(directory, dbPath, {
        safetyPageLimit: 3,
        concurrency: 1,
      }),
      {
        context: {},
        page,
        catalogTree: tree,
      },
    );
    assert.equal(result.status, 'success');
    assert.ok(requested.some((item) => item.startsWith('261286:')));
    const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const first = replay.getRunCatalogProgress(result.runId, '260617', '261285');
      const second = replay.getRunCatalogProgress(result.runId, '260617', '261286');
      assert.equal(first.status, 'stalled');
      assert.equal(second.status, 'completed');
      assert.equal(second.scanComplete, true);
      assert.equal(
        replay.db
          .prepare("SELECT COUNT(*) AS n FROM sync_run_question_items WHERE question_external_id = '98300001'")
          .get().n,
        1,
      );
    } finally {
      replay.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('图片下载失败时仍保存题目，并标记数据不完整', async () => {
  const { directory, dbPath } = tempDb();
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') {
      return { status: 200, headers: {}, text: listApiText(10, ['35020603']) };
    }
    if (curPage === 1) return { status: 200, headers: {}, text: listApiText(10, ['98400001']) };
    return { status: 200, headers: {}, text: listApiText(10, []) };
  });
  const context = {
    pages: () => [page],
    newPage: async () => page,
    request: {
      get: async () => {
        throw Object.assign(new Error('素材 503'), { code: 'asset_http_503' });
      },
    },
  };
  try {
    const result = await runSync(baseSyncOptions(directory, dbPath, { downloadAssets: true }), {
      context,
      page,
      catalogTree: SAMPLE_TREE,
    });
    assert.equal(result.status, 'success');
    assert.equal(result.completeness.scanComplete, true);
    assert.equal(result.completeness.dataComplete, false);
    assert.equal(result.completeness.snapshotComplete, false);
    const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      assert.equal(replay.db.prepare('SELECT COUNT(*) AS n FROM sync_run_question_items').get().n, 1);
      const asset = replay.db.prepare('SELECT source_url, content_sha256 FROM sync_run_question_assets').get();
      assert.ok(asset?.source_url);
      assert.equal(asset.content_sha256, null);
      const progress = replay.getRunCatalogProgress(result.runId, '260617', '261285');
      assert.ok(progress.assetErrorCount > 0);
    } finally {
      replay.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('image-only list content is complete while unresolved images and empty content are not', () => {
  const url = 'https://staticzujuan.xkw.com/quesimg/Upload/formula/only.png';
  const image = finalizeQuestion({
    contentHtml: `<img src="${url}">`,
    assets: [{ sourceUrl: url, type: 'formula_image' }],
  });
  assert.equal(image.contentComplete, true);
  assert.equal(image.plainText, null);
  assert.equal(image.detailFetched, false);
  assert.equal(finalizeQuestion({ contentHtml: `<img src="${url}">`, assets: [] }).contentComplete, false);
  assert.equal(finalizeQuestion({ contentHtml: '<p> </p>', assets: [] }).contentComplete, false);
});

test('sealing refuses incomplete list content even when catalog scan is complete', () => {
  const { directory, dbPath } = tempDb();
  const store = new QuestionSyncStore(dbPath, { dataDir: directory });
  try {
    const scope = { textbookId: '260617' };
    const runId = store.beginRun(scope, { resume: false });
    const catalog = {
      externalId: '261285',
      name: '第一章',
      level: 1,
      type: 'chapter',
      ancestorIds: ['261285'],
      categoryId: '261285',
      catelogTokpointId: '0',
      chapterExternalId: '261285',
    };
    store.saveCatalogTree(runId, '260617', [catalog]);
    const question = parseQuestionListPayload({ code: '0', data: { total: 1, html: listHtml('95000001') } })
      .questions[0];
    question.contentComplete = false;
    store.savePage({
      runId,
      textbookExternalId: '260617',
      catalog,
      nodes: [catalog],
      pageNumber: 1,
      expectedTotal: 1,
      expectedPages: 1,
      questions: [question],
      queryFingerprint: 'incomplete-test',
    });
    // savePage finalizes valid input again; simulate an incomplete persisted
    // row before sealing, while the run is still mutable.
    store.db.prepare('UPDATE sync_run_question_items SET content_complete = 0 WHERE run_id = ?').run(runId);
    store.completeCatalog({
      runId,
      textbookExternalId: '260617',
      catalog,
      expectedTotal: 1,
      expectedPages: 1,
      queryFingerprint: 'incomplete-test',
    });
    const result = store.validateRunCompleteness(runId, scope, [catalog], {});
    assert.equal(result.scanComplete, true);
    assert.equal(result.complete, false);
    assert.ok(result.dataReasons.includes('列表题干不完整'));
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('补采核对当前边界题 ID 后继续尾段，保留累计题且不冒充连续完整扫描', async () => {
  const { directory, dbPath } = tempDb();
  try {
    const first = await runSync(
      baseSyncOptions(directory, dbPath, {
        maxPages: 3,
        maxPagesProvided: true,
        concurrency: 1,
      }),
      {
        context: {},
        catalogTree: SAMPLE_TREE,
        page: mockSyncPage(({ curPage }) => ({
          status: 200,
          headers: {},
          text: listApiText(50, [`9600000${curPage}`]),
        })),
      },
    );
    const pages = [];
    const resumed = await runSync(
      baseSyncOptions(directory, dbPath, {
        resume: true,
        resumeRunId: first.runId,
        maxPages: 8,
        concurrency: 1,
      }),
      {
        context: {},
        catalogTree: SAMPLE_TREE,
        page: mockSyncPage(({ curPage, categoryId }) => {
          if (categoryId === '261285') pages.push(curPage);
          const ids = curPage === 1 ? ['96000100'] : curPage === 4 ? ['96000003'] : curPage === 5 ? ['96000101'] : [];
          return { status: 200, headers: {}, text: listApiText(60, ids) };
        }),
      },
    );
    assert.ok(pages.includes(1) && pages.includes(4) && pages.includes(5));
    assert.ok(!pages.includes(2) && !pages.includes(3));
    const store = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const row = store.getRun(resumed.runId);
      const scope = JSON.parse(row.scope_json);
      assert.equal(row.snapshot_complete, 0);
      const { validateQuestionListResumeSourceRun } = require('../src/storage/resume.cjs');
      assert.equal(
        validateQuestionListResumeSourceRun(
          dbPath,
          resumed.runId,
          buildScope(baseSyncOptions(directory, dbPath, { resume: true })),
        ).resumable,
        true,
      );
      assert.deepEqual(scope.resumeCoverageGaps, ['261285']);
      assert.equal(scope.resumeScanHints['261285'].finished, true);
      assert.equal(store.runSnapshotCounts(resumed.runId).questionCount, 5);
      const next = store.beginRun(buildScope(baseSyncOptions(directory, dbPath, { resume: true })), {
        resume: true,
        resumeRunId: resumed.runId,
      });
      assert.deepEqual(store.resetRunScan(next), {});
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('旧边界题不在当前页时回到前部扫描，不能盲目跳过页码', async () => {
  const { directory, dbPath } = tempDb();
  try {
    const first = await runSync(
      baseSyncOptions(directory, dbPath, { maxPages: 3, maxPagesProvided: true, concurrency: 1 }),
      {
        context: {},
        catalogTree: SAMPLE_TREE,
        page: mockSyncPage(({ curPage }) => ({
          status: 200,
          headers: {},
          text: listApiText(50, [`9700000${curPage}`]),
        })),
      },
    );
    const pages = [];
    const second = await runSync(
      baseSyncOptions(directory, dbPath, { resume: true, resumeRunId: first.runId, concurrency: 1 }),
      {
        context: {},
        catalogTree: SAMPLE_TREE,
        page: mockSyncPage(({ curPage, categoryId }) => {
          if (categoryId === '261285') pages.push(curPage);
          return { status: 200, headers: {}, text: listApiText(50, curPage <= 4 ? [`9700010${curPage}`] : []) };
        }),
      },
    );
    assert.ok(pages.includes(2) && pages.includes(3));
    const store = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      assert.deepEqual(JSON.parse(store.getRun(second.runId).scope_json).resumeCoverageGaps, []);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('其他教材超过 50 次运行后仍能找到本教材旧成果', () => {
  const { directory, dbPath } = tempDb();
  const store = new QuestionSyncStore(dbPath, { dataDir: directory });
  try {
    const scope = { textbookId: 'book-a', bankId: 2, bankPath: 'czsx', downloadAssets: false };
    const old = store.beginRun(scope, { resume: false });
    store.finishRun(old, 'interrupted', {}, 'budget');
    for (let i = 0; i < 60; i++) {
      const other = store.beginRun({ ...scope, textbookId: `book-${i}` }, { resume: false });
      store.finishRun(other, 'interrupted', {}, 'budget');
    }
    store.beginRun(scope, { resume: true });
    assert.equal(store.lastBeginMeta.clonedFrom, old);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('封存部分成果的补采可以保留非瞬时失败的有效页，旧就地恢复仍拒绝该失败', () => {
  const { directory, dbPath } = tempDb();
  const store = new QuestionSyncStore(dbPath, { dataDir: directory });
  try {
    const scope = buildScope(baseSyncOptions(directory, dbPath));
    const runId = store.beginRun(scope, { resume: false });
    const tree = normalizeCatalogTree(SAMPLE_TREE).nodes;
    const catalog = { ...tree[0], chapterExternalId: '261285' };
    store.saveCatalogTree(runId, '260617', tree);
    store.savePage({
      runId,
      textbookExternalId: '260617',
      catalog,
      nodes: tree,
      pageNumber: 1,
      expectedTotal: 50,
      expectedPages: 5,
      queryFingerprint: 'refill',
      questions: parseQuestionListPayload({ code: '0', data: { total: 50, html: listHtml('98000001') } }).questions,
    });
    store.finishRun(runId, 'failed', { pagesOk: 1 }, 'parse_error');
    const { validateQuestionListResumeSourceRun, validateResumeSourceRun } = require('../src/storage/resume.cjs');
    assert.throws(() => validateResumeSourceRun(dbPath, runId, scope), /不是可续采的瞬时错误/);
    assert.equal(validateQuestionListResumeSourceRun(dbPath, runId, scope).resumable, true);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('跨章节重复知识点持久化两处目录关系，各自保存页码断点', () => {
  const { directory, dbPath } = tempDb();
  const store = new QuestionSyncStore(dbPath, { dataDir: directory });
  try {
    const raw = {
      id: '195861',
      title: '七年级上册',
      children: ['196009', '196010'].map((id) => ({
        id,
        title: `章节 ${id}`,
        href: `/czsx/zj${id}/`,
        children: [
          {
            id: '4712',
            title: '数轴正负',
            isKnowledge: 1,
            href: `/czsx/zj${id}/ctk4712`,
          },
        ],
      })),
    };
    const { nodes } = normalizeCatalogTree(raw, { textbookId: '195861' });
    const runId = store.beginRun({ textbookId: '195861', bankId: 2, bankPath: 'czsx' });
    store.saveCatalogTree(runId, '195861', nodes);
    const question = parseQuestionListPayload({ code: '0', data: { total: 1, html: LIST_HTML } }).questions[0];
    for (const catalog of nodes.filter((n) => n.isKnowledge)) {
      store.savePage({
        runId,
        textbookExternalId: '195861',
        catalog,
        nodes,
        pageNumber: 1,
        expectedTotal: 1,
        expectedPages: 1,
        questions: [question],
        queryFingerprint: catalog.externalId,
      });
      assert.equal(store.getRunCheckpoint(runId, catalog.externalId), 1);
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_run_catalog_items').get().n, 4);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_run_question_items').get().n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_run_question_catalogs').get().n, 4);
    const relations = store.db.prepare('SELECT catalog_external_id FROM sync_run_question_catalogs').all();
    assert.deepEqual(relations.map((r) => r.catalog_external_id).sort(), nodes.map((n) => n.externalId).sort());
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('增量：第二次运行接上历史头部后结束，只请求新增页和少量重叠页；全量模式仍扫描到窗口末尾', async () => {
  const { directory, dbPath } = tempDb();
  const tree = {
    id: '260617',
    title: '测试教材',
    children: [{ id: '261285', title: '大目录', children: [] }],
  };
  // One question id per page keeps the mock small; matching needs min(3, ids).
  const pageIds = (offset) => (curPage) => [String(70000000 + curPage - offset)];
  let current = pageIds(0);
  const requested = [];
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') return { status: 200, headers: {}, text: listApiText(104269, ['35020603']) };
    requested.push(curPage);
    return { status: 200, headers: {}, text: listApiText(400, current(curPage)) };
  });
  const options = (extra = {}) => baseSyncOptions(directory, dbPath, { catalogPageLimit: 40, ...extra });
  try {
    await runSync(options(), { context: {}, page, catalogTree: tree });
    assert.equal(Math.max(...requested), 40);
    // Five new pages at the head: old page p is now page p + 5.
    requested.length = 0;
    current = (curPage) => (curPage <= 5 ? [String(80000000 + curPage)] : pageIds(5)(curPage));
    const second = await runSync(options(), { context: {}, page, catalogTree: tree });
    assert.ok(Math.max(...requested) <= 8 + 8, `incremental stopped early, requested ${Math.max(...requested)}`);
    assert.ok(requested.includes(1) && requested.includes(8));
    const store = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const progress = store.getRunCatalogProgress(second.runId, '260617', '261285');
      assert.equal(progress.stallReason, 'incremental_joined');
      const scopeKey = store.db.prepare('SELECT scope_key FROM catalog_baselines').get().scope_key;
      const baseline = store.getCatalogBaseline(scopeKey).confirmed;
      assert.equal(baseline.headPages[0].ids[0], '80000001');
      assert.equal(baseline.reliableEnd, 40);
    } finally {
      store.close();
    }
    requested.length = 0;
    await runSync(options({ syncMode: 'full' }), { context: {}, page, catalogTree: tree });
    assert.equal(Math.max(...requested), 40, 'full mode never stops on an old range');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('不同页码连续返回同一页时有界停止并保留真实原因', async () => {
  const { directory, dbPath } = tempDb();
  const requested = [];
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') return { status: 200, headers: {}, text: listApiText(104269, ['35020603']) };
    requested.push(curPage);
    const ids = curPage <= 2 ? [String(71000000 + curPage)] : ['71009999'];
    return { status: 200, headers: {}, text: listApiText(100000, ids) };
  });
  try {
    const result = await runSync(baseSyncOptions(directory, dbPath, { catalogPageLimit: 1000 }), {
      context: {},
      page,
      catalogTree: { id: '260617', title: '测试教材', children: [{ id: '261285', title: '大目录', children: [] }] },
    });
    assert.ok(Math.max(...requested) < 40, `stopped after ${Math.max(...requested)} pages`);
    const store = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      assert.equal(store.getRunCatalogProgress(result.runId, '260617', '261285').stallReason, 'duplicate_pages');
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('A20：头部中断后续采接着上次未完成的头部继续，不从新第一页误判接上', async () => {
  const { directory, dbPath } = tempDb();
  const tree = { id: '260617', title: '测试教材', children: [{ id: '261285', title: '大目录', children: [] }] };
  let current = (curPage) => [String(70000000 + curPage)];
  const requested = [];
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') return { status: 200, headers: {}, text: listApiText(104269, ['35020603']) };
    requested.push(curPage);
    return { status: 200, headers: {}, text: listApiText(400, current(curPage)) };
  });
  const options = (extra = {}) => baseSyncOptions(directory, dbPath, { catalogPageLimit: 60, ...extra });
  const baselineRow = () => {
    const store = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      return store.getCatalogBaseline(store.db.prepare('SELECT scope_key FROM catalog_baselines').get().scope_key);
    } finally {
      store.close();
    }
  };
  try {
    await runSync(options(), { context: {}, page, catalogTree: tree });
    // Thirty new head pages; the next run stops after 20 (head not joined yet).
    current = (curPage) => (curPage <= 30 ? [String(80000000 + curPage)] : [String(70000000 + curPage - 30)]);
    requested.length = 0;
    await runSync(options({ maxPages: 20, maxPagesProvided: true }), { context: {}, page, catalogTree: tree });
    assert.equal(Math.max(...requested), 20);
    let baseline = baselineRow();
    assert.equal(baseline.confirmed.headPages[0].ids[0], '70000001', 'interrupted head keeps the old baseline');
    assert.equal(baseline.candidate.headPages[0].ids[0], '80000001');
    requested.length = 0;
    const resumed = await runSync(options({ resume: true }), { context: {}, page, catalogTree: tree });
    assert.ok(requested.includes(1) && requested.includes(3), 'the head is re-confirmed');
    assert.ok(!requested.includes(10), `pages already scanned are skipped: ${requested.join(',')}`);
    assert.ok(Math.max(...requested) <= 33 + 8, `joined the old range after the head: ${Math.max(...requested)}`);
    const store = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      assert.equal(store.getRunCatalogProgress(resumed.runId, '260617', '261285').stallReason, 'incremental_joined');
    } finally {
      store.close();
    }
    baseline = baselineRow();
    assert.equal(baseline.confirmed.headPages[0].ids[0], '80000001');
    assert.equal(baseline.confirmed.reliableEnd, 60);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('下一轮自动执行（非续采）也接着上一轮未完成的头部，新插入的页按位移处理', async () => {
  const { directory, dbPath } = tempDb();
  const tree = { id: '260617', title: '测试教材', children: [{ id: '261285', title: '大目录', children: [] }] };
  let current = (curPage) => [String(70000000 + curPage)];
  const requested = [];
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') return { status: 200, headers: {}, text: listApiText(104269, ['35020603']) };
    requested.push(curPage);
    return { status: 200, headers: {}, text: listApiText(400, current(curPage)) };
  });
  const options = (extra = {}) => baseSyncOptions(directory, dbPath, { catalogPageLimit: 60, ...extra });
  try {
    await runSync(options(), { context: {}, page, catalogTree: tree });
    current = (curPage) => (curPage <= 30 ? [String(80000000 + curPage)] : [String(70000000 + curPage - 30)]);
    requested.length = 0;
    await runSync(options({ maxPages: 20, maxPagesProvided: true }), { context: {}, page, catalogTree: tree });
    assert.equal(Math.max(...requested), 20);
    // Before the next round, 5 more new pages appear on top.
    current = (curPage) =>
      curPage <= 5
        ? [String(90000000 + curPage)]
        : curPage <= 35
          ? [String(80000000 + curPage - 5)]
          : [String(70000000 + curPage - 35)];
    requested.length = 0;
    const next = await runSync(options(), { context: {}, page, catalogTree: tree });
    assert.ok(
      requested.includes(1) && requested.includes(8),
      `new head and the match are read: ${requested.join(',')}`,
    );
    assert.ok(
      !requested.includes(15),
      `pages saved by the previous round are not requested again: ${requested.join(',')}`,
    );
    const store = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      assert.equal(store.getRunCatalogProgress(next.runId, '260617', '261285').stallReason, 'incremental_joined');
      const baseline = store.getCatalogBaseline(
        store.db.prepare('SELECT scope_key FROM catalog_baselines').get().scope_key,
      );
      assert.equal(baseline.confirmed.headPages[0].ids[0], '90000001');
      assert.equal(baseline.confirmed.reliableEnd, 60);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('E10：采集中浏览器上下文关闭后重建并只补抓未返回的页，运行正常结束', async () => {
  const { directory, dbPath } = tempDb();
  const tree = { id: '260617', title: '测试教材', children: [{ id: '261285', title: '大目录', children: [] }] };
  const requested = [];
  let closedOnce = false;
  const handler = ({ curPage, categoryId }) => {
    if (categoryId !== '261285') return { status: 200, headers: {}, text: listApiText(104269, ['35020603']) };
    requested.push(curPage);
    return { status: 200, headers: {}, text: listApiText(120, [String(72000000 + curPage)]) };
  };
  const brokenPage = mockSyncPage(handler);
  const evaluate = brokenPage.evaluate;
  brokenPage.evaluate = async (fn, args) => {
    const page = args?.body ? Number(new URLSearchParams(args.body).get('curPage')) : null;
    if (page === 5 && !closedOnce) {
      closedOnce = true;
      throw new Error('page.evaluate: Target page, context or browser has been closed');
    }
    return evaluate(fn, args);
  };
  let reopened = 0;
  try {
    const result = await runSync(baseSyncOptions(directory, dbPath, { catalogPageLimit: 12 }), {
      context: {},
      page: brokenPage,
      catalogTree: tree,
      reopenBrowser: async () => {
        reopened += 1;
        return { context: {}, page: mockSyncPage(handler) };
      },
    });
    assert.equal(reopened, 1);
    assert.equal(requested.filter((page) => page === 5).length, 1, 'page 5 fetched once after the rebuild');
    assert.equal(Math.max(...requested), 12);
    assert.notEqual(result.status, 'interrupted');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('review repeated interrupted head preserves carried coverage', async () => {
  const { directory, dbPath } = tempDb();
  const tree = { id: '260617', title: '测试教材', children: [{ id: '261285', title: '大目录', children: [] }] };
  let phase = 0;
  const requested = [];
  const page = mockSyncPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') return { status: 200, headers: {}, text: listApiText(104269, ['35020603']) };
    requested.push(curPage);
    if (phase === 2 && curPage === 31) return { status: 403, headers: {}, text: '<html>验证码</html>' };
    const id = phase === 0 ? 70000000 + curPage : curPage <= 50 ? 80000000 + curPage : 70000000 + curPage - 50;
    return { status: 200, headers: {}, text: listApiText(1000, [String(id)]) };
  });
  const options = (extra = {}) =>
    baseSyncOptions(directory, dbPath, { catalogPageLimit: 100, concurrency: 1, ...extra });
  try {
    await runSync(options(), { context: {}, page, catalogTree: tree });
    phase = 1;
    await runSync(options({ maxPages: 20, maxPagesProvided: true }), { context: {}, page, catalogTree: tree });
    phase = 2;
    requested.length = 0;
    await assert.rejects(
      runSync(options(), { context: {}, page, catalogTree: tree }),
      (error) => error.code === 'waiting_verification',
    );
    assert.ok(!requested.includes(10), `previous coverage skipped: ${requested}`);
    const store = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const key = store.db.prepare('SELECT scope_key FROM catalog_baselines').get().scope_key;
      const candidate = store.getCatalogBaseline(key).candidate;
      assert.ok(
        candidate.scannedPages.includes(10),
        `lost carried coverage: ${JSON.stringify(candidate.scannedPages)}`,
      );
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const [permanent, pageLimit] of [
  [false, 4],
  [false, 8],
  [true, 8],
]) {
  test(`异常 HTML/405 有限恢复并优先补缺页（上限 ${pageLimit}）：${permanent ? '持续失败封存' : '恢复后继续'}`, async () => {
    const { directory, dbPath } = tempDb();
    const calls = [];
    let recovered = false,
      reopened = 0;
    const page = mockSyncPage(({ categoryId, curPage }) => {
      if (categoryId !== '261285') return { status: 200, text: listApiText(80, ['35020603']) };
      calls.push({ page: curPage, recovered });
      if ((curPage === 2 || curPage === 3) && (permanent || !recovered))
        return {
          status: curPage === 2 ? 200 : 405,
          headers: { 'content-type': 'text/html' },
          text: '<html><head><title>Temporary error</title></head><body>暂时不可用</body></html>',
        };
      return { status: 200, text: listApiText(80, [`99000${curPage}`]) };
    });
    const dependencies = {
      context: {},
      page,
      catalogTree: SAMPLE_TREE,
      reopenBrowser: async () => {
        recovered = true;
        reopened += 1;
        return { context: {}, page };
      },
    };
    const options = baseSyncOptions(directory, dbPath, { concurrency: 4, catalogPageLimit: pageLimit });
    try {
      if (permanent)
        await assert.rejects(runSync(options, dependencies), (error) => error.code === 'list_response_unavailable');
      else await runSync(options, dependencies);
      assert.equal(reopened, 1);
      const replay = new QuestionSyncStore(dbPath, { dataDir: directory });
      try {
        const run = replay.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
        const pages = replay.db
          .prepare(
            'SELECT page_number,result_type,raw_snapshot_path FROM sync_run_catalog_pages WHERE run_id=? ORDER BY page_number',
          )
          .all(run.id);
        if (permanent) {
          assert.equal(run.status, 'interrupted');
          assert.ok(
            calls.every((call) => call.page <= 4),
            '不能继续空跑后续页',
          );
          assert.deepEqual(
            pages.filter((p) => p.result_type === 'success').map((p) => p.page_number),
            [1, 4],
          );
          assert.ok(pages.find((p) => p.page_number === 2).raw_snapshot_path);
        } else {
          assert.equal(pages.length, pageLimit);
          assert.ok(pages.every((p) => p.result_type === 'success'));
          const after = calls.filter((call) => call.recovered).map((call) => call.page);
          assert.deepEqual(after.slice(0, 2), [2, 3], '会话恢复后先补原页，再向后翻页');
        }
        assert.equal(
          replay.db.prepare('SELECT manual_required FROM collector_source_control').get().manual_required,
          0,
        );
        const files = fs.readdirSync(
          path.join(directory, 'raw', new Date().toISOString().slice(0, 10), `run-${run.id}`),
        );
        assert.ok(files.some((name) => name.startsWith('list-failure-')));
      } finally {
        replay.close();
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('重置续采扫描证据保留最大成功页之前的失败缺口', async () => {
  const { directory, dbPath } = tempDb();
  try {
    const first = await runSync(
      baseSyncOptions(directory, dbPath, { maxPages: 6, maxPagesProvided: true, concurrency: 1 }),
      {
        context: {},
        catalogTree: SAMPLE_TREE,
        page: mockSyncPage(({ curPage }) => ({ status: 200, text: listApiText(100, [`9800000${curPage}`]) })),
      },
    );
    const store = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const next = store.beginRun(buildScope(baseSyncOptions(directory, dbPath, { resume: true })), {
        resume: true,
        resumeRunId: first.runId,
      });
      store.db
        .prepare(
          "UPDATE sync_run_catalog_pages SET result_type='request_failed',error_code='unexpected_html' WHERE run_id=? AND page_number=3",
        )
        .run(next);
      const hints = store.resetRunScan(next);
      assert.equal(hints['261285'].lastPage, 6);
      assert.deepEqual(hints['261285'].failedPages, [3]);
      assert.equal(hints['261285'].finished, false);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('续采核对旧尾部后先补尾部之前的已知缺页，再继续后面的页', async () => {
  const { directory, dbPath } = tempDb();
  try {
    const first = await runSync(
      baseSyncOptions(directory, dbPath, { maxPages: 6, maxPagesProvided: true, concurrency: 1 }),
      {
        context: {},
        catalogTree: SAMPLE_TREE,
        page: mockSyncPage(({ curPage, categoryId }) =>
          categoryId === '261285' && curPage === 3
            ? { status: 500, text: 'busy' }
            : { status: 200, text: listApiText(60, [`9900000${curPage}`]) },
        ),
      },
    );
    const pages = [];
    await runSync(
      baseSyncOptions(directory, dbPath, { resume: true, resumeRunId: first.runId, concurrency: 1, maxPages: 8 }),
      {
        context: {},
        catalogTree: SAMPLE_TREE,
        page: mockSyncPage(({ curPage, categoryId }) => {
          if (categoryId === '261285') pages.push(curPage);
          return { status: 200, text: listApiText(60, curPage <= 6 ? [`9900000${curPage}`] : []) };
        }),
      },
    );
    assert.deepEqual(pages.slice(0, 4), [1, 6, 3, 7]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
