'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { MetadataStore } = require('../zujuan_metadata_sync.cjs');
const {
  DEFAULT_CHAPTER_ID,
  ANSWER_STATUSES,
  buildCatalogPageUrl,
  buildListUrl,
  classifyAsset,
  countSubquestions,
  createLazyCollectorPage,
  extractDetailPage,
  filterFacets,
  isListReadyState,
  isResumablePartialRun,
  parsePagerState,
  nextCatalogPage,
  jumpPlan,
  mergeQuestion,
  normalizeWhitespace,
  parseArgs,
  listNeedsDetailFallback,
  shouldFetchQuestionDetail,
  parseDifficultyText,
  parseListUsageMeta,
  parseQuestionListPayload,
  partitionCatalogsByChapter,
  pickWorkerFailure,
  buildCatalogProgressTree,
  checkpointFilterJson,
  checkpointScopeKey,
  validateResumeSourceRun,
  resolveSyncScope,
  selectCatalogs,
  questionListRequestParams,
  listQuestionIdsMatch,
  StopCrawlError,
  SyncStore,
} = require('../zujuan_sync.cjs');

test('题目详情页在第一次真正需要时才创建，后续复用', async () => {
  let created = 0;
  const firstPage = { isClosed: () => false };
  const getDetailPage = createLazyCollectorPage(async () => {
    created += 1;
    return firstPage;
  });
  assert.equal(created, 0);
  assert.equal(await getDetailPage(), firstPage);
  assert.equal(await getDetailPage(), firstPage);
  assert.equal(created, 1);
});

test('题目列表接口参数与题号可用于分页双重校验', () => {
  const response = {
    url: () => 'https://zujuan.xkw.com/zujuan-api/question/list',
    request: () => ({
      method: () => 'POST',
      postData: () => 'curPage=470&categoryId=261285&catelogTokpointId=0',
    }),
  };
  assert.deepEqual(questionListRequestParams(response), {
    curPage: '470',
    categoryId: '261285',
    catelogTokpointId: '0',
  });
  assert.equal(questionListRequestParams({
    url: () => 'https://zujuan.xkw.com/other',
    request: response.request,
  }), null);

  const parsed = parseQuestionListPayload({
    code: 0,
    data: {
      total: 9750,
      html: '<div class="tk-quest-item" questionid="26951034"></div>'
        + '<div class="tk-quest-item" questionid="26996136"></div>',
    },
  });
  assert.deepEqual(parsed, {
    total: 9750,
    questionIds: ['26951034', '26996136'],
  });
  assert.equal(listQuestionIdsMatch(parsed.questionIds, ['26951034', '26996136']), true);
  assert.equal(listQuestionIdsMatch(parsed.questionIds, ['26996136', '26951034']), false);
  assert.throws(
    () => parseQuestionListPayload({ code: 1, message: '失败' }),
    (error) => error instanceof StopCrawlError && error.code === 'list_api_contract',
  );
});

test('题目详情页被关闭后按需重建', async () => {
  let created = 0;
  const pages = [
    { isClosed: () => true },
    { isClosed: () => false },
  ];
  const getDetailPage = createLazyCollectorPage(async () => pages[created++]);
  assert.equal(await getDetailPage(), pages[0]);
  assert.equal(await getDetailPage(), pages[1]);
  assert.equal(created, 2);
});

test('答案采集保持安全默认，并只接受显式公开可见开关', () => {
  assert.equal(parseArgs([]).includeVisibleSolutions, false);
  assert.equal(parseArgs(['--include-visible-solutions']).includeVisibleSolutions, true);
  assert.deepEqual([...ANSWER_STATUSES], [
    'not_collected', 'not_visible', 'login_required', 'public_captured',
  ]);
  assert.match(extractDetailPage.toString(), /\.answer-box \.answer/);
  assert.match(extractDetailPage.toString(), /\.answer-box \.analysis/);
  assert.match(extractDetailPage.toString(), /\.answer-box \.parse/);
});

test('答案、解析和兼容 solution 字段按公开状态写入运行快照与全局题目', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zujuan-answer-fields-'));
  const dbPath = path.join(directory, 'collector.sqlite3');
  const store = new SyncStore(dbPath);
  try {
    const runId = store.beginRun({ textbookId: 'tb-answer' });
    store.saveRunQuestion(runId, 'tb-answer', {
      externalId: 'q-answer',
      contentHtml: '<p>题干</p>',
      plainText: '题干',
      answerHtml: '<p>A</p>',
      analysisHtml: '<p>因为 A</p>',
      solutionHtml: '<p>A 因为 A</p>',
      answerStatus: 'public_captured',
    }, 'cat-answer');
    let row = store.db.prepare(`
      SELECT answer_html, analysis_html, answer_status, solution_html
      FROM sync_run_question_items WHERE run_id = ?
    `).get(runId);
    assert.deepEqual({ ...row }, {
      answer_html: '<p>A</p>',
      analysis_html: '<p>因为 A</p>',
      answer_status: 'public_captured',
      solution_html: '<p>A 因为 A</p>',
    });

    // A later login-required observation must clear all answer content in the
    // still-open run instead of retaining stale/public-looking HTML.
    store.saveRunQuestion(runId, 'tb-answer', {
      externalId: 'q-answer',
      contentHtml: '<p>题干</p>',
      plainText: '题干',
      answerHtml: '<p>不应保存</p>',
      analysisHtml: '<p>不应保存</p>',
      solutionHtml: '<p>不应保存</p>',
      answerStatus: 'login_required',
      loginRequired: true,
    }, 'cat-answer');
    row = store.db.prepare(`
      SELECT answer_html, analysis_html, answer_status, solution_html
      FROM sync_run_question_items WHERE run_id = ?
    `).get(runId);
    assert.deepEqual({ ...row }, {
      answer_html: null,
      analysis_html: null,
      answer_status: 'login_required',
      solution_html: null,
    });

    store.saveQuestion({
      externalId: 'q-global',
      contentHtml: '<p>题干</p>',
      plainText: '题干',
      answerHtml: '<p>A</p>',
      analysisHtml: '<p>因为 A</p>',
      solutionHtml: '<p>A 因为 A</p>',
      answerStatus: 'public_captured',
    }, 'cat-answer');
    row = store.db.prepare(`
      SELECT answer_html, analysis_html, answer_status, solution_html
      FROM questions WHERE external_id = 'q-global'
    `).get();
    assert.deepEqual({ ...row }, {
      answer_html: '<p>A</p>',
      analysis_html: '<p>因为 A</p>',
      answer_status: 'public_captured',
      solution_html: '<p>A 因为 A</p>',
    });
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('构造默认第五章最新排序 URL', () => {
  const options = parseArgs([]);
  assert.equal(
    buildListUrl(options, '261314', 1),
    'https://zujuan.xkw.com/czsx/zj261314/o2/',
  );
  assert.equal(
    buildListUrl(options, '261314', 2),
    'https://zujuan.xkw.com/czsx/zj261314/o2p2/',
  );
});

test('筛选 URL 遵循站点参数顺序', () => {
  const options = parseArgs([
    '--question-type', '单选题',
    '--difficulty', '容易',
    '--year', '2026',
    '--scene', '作业',
    '--category', '典型题',
    '--fresh',
    '--sort', '最新',
  ]);
  assert.equal(
    buildListUrl(options, '261314', 3),
    'https://zujuan.xkw.com/czsx/zj261314/qt1101d1y2026cjh18fl4081x4o2p3/',
  );
});

test('知识点 URL 保留所属教材小节并支持分页', () => {
  const options = parseArgs([]);
  assert.equal(
    buildCatalogPageUrl(options, {
      externalId: '5597',
      parentExternalId: '261287',
      level: 3,
      sourcePath: '/czsx/zj261287/ctk5597',
    }, 2),
    'https://zujuan.xkw.com/czsx/zj261287/ctk5597o2p2',
  );
});

test('目录选择支持指定知识点并解析所属章', () => {
  const options = parseArgs(['--catalog-id', '5597']);
  const selected = selectCatalogs(options, [
    { externalId: '261285', level: 1, parentExternalId: null, name: '第一章' },
    { externalId: '261287', level: 2, parentExternalId: '261285', name: '第2节' },
    { externalId: '5597', level: 3, parentExternalId: '261287', name: '知识点' },
  ]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].chapterExternalId, '261285');
});

test('批量目录可限制在第五章', () => {
  const options = parseArgs([
    '--all-catalogs', '--catalog-level', '3', '--within-chapter', '261314',
  ]);
  const selected = selectCatalogs(options, [
    { externalId: '261314', level: 1, parentExternalId: null, name: '第五章' },
    { externalId: '261315', level: 2, parentExternalId: '261314', name: '小节' },
    { externalId: '5208', level: 3, parentExternalId: '261315', name: '点' },
    { externalId: '261285', level: 1, parentExternalId: null, name: '第一章' },
    { externalId: '5000', level: 3, parentExternalId: '261285', name: '别的点' },
  ]);
  assert.deepEqual(selected.map((item) => item.externalId), ['5208']);
});

test('筛选条件只作为 query_membership 证据输入', () => {
  const options = parseArgs(['--scene', '预习', '--category', '压轴题']);
  assert.deepEqual(filterFacets(options), [
    { dimension: 'scene', value: '预习' },
    { dimension: 'category', value: '压轴题' },
  ]);
});

test('解析组卷次数、卷引用数量和引用卷名单', () => {
  const parsed = parseListUsageMeta({
    titles: ['2026/08/15', '160次组卷'],
    referenceLabel: '2卷引用：第二十五章 一元二次方程 追梦第二十五章章末复习 一元二次方程',
    papers: [
      {
        name: '第二十五章 一元二次方程 追梦第二十五章章末复习 一元二次方程',
        url: 'https://zujuan.xkw.com/2p3410562.html',
      },
      {
        name: '第二章 一元二次方程 追梦第二章章末复习 一元二次方程',
        url: 'https://zujuan.xkw.com/2p3410198.html',
      },
    ],
  });
  assert.equal(parsed.useCount, 160);
  assert.equal(parsed.referenceCount, 2);
  assert.equal(parsed.referencePapers.length, 2);
  assert.equal(parsed.referencePapers[1].url, 'https://zujuan.xkw.com/2p3410198.html');
});

test('0次组卷保留为 0，卷引用名单按隐藏下拉里的全部链接入库', () => {
  const parsed = parseListUsageMeta({
    titles: ['今日', '0次组卷'],
    referenceLabel: '7卷引用：26.1 二次函数的概念 课前预习',
    papers: [
      { name: '26.1 二次函数的概念 课前预习', url: 'https://zujuan.xkw.com/2p3386178.html' },
      { name: '第27章 二次函数 单元测试A', url: 'https://zujuan.xkw.com/2p3361876.html' },
      { name: '第21章 二次函数与反比例函数 单元检测B', url: 'https://zujuan.xkw.com/2p3343231.html' },
      { name: '第13讲 认识二次函数', url: 'https://zujuan.xkw.com/2p3338323.html' },
      { name: '第10讲 二次函数及确定表达式', url: 'https://zujuan.xkw.com/2p3337022.html' },
      { name: '暑假收心卷02', url: 'https://zujuan.xkw.com/2p3336923.html' },
      { name: '甘肃省张掖市肃南裕固族自治县康乐明德学校试卷', url: 'https://zujuan.xkw.com/2p3295794.html' },
    ],
  });
  assert.equal(parsed.useCount, 0);
  assert.equal(parsed.referenceCount, 7);
  assert.equal(parsed.referencePapers.length, 7);
  assert.equal(parsed.referencePapers[6].url, 'https://zujuan.xkw.com/2p3295794.html');
});

test('解析难度文字和小问数量', () => {
  assert.deepEqual(parseDifficultyText('适中 (0.65)'), {
    label: '适中',
    coefficient: 0.65,
  });
  assert.equal(countSubquestions('题干\n(1) 第一问\n（2）第二问'), 2);
});

test('分页页数按分页器容量计算，最后一页不足容量也稳定', () => {
  const total = 23;
  const pagerCapacity = 10;
  assert.equal(Math.ceil(total / pagerCapacity), 3);
});

test('超过站点跳页上限时先跳到 1000 再点下一页', () => {
  assert.deepEqual(jumpPlan(1), { goto: null, nextClicks: 0 });
  assert.deepEqual(jumpPlan(500), { goto: 500, nextClicks: 0 });
  assert.deepEqual(jumpPlan(1000), { goto: 1000, nextClicks: 0 });
  assert.deepEqual(jumpPlan(1001), { goto: 1000, nextClicks: 1 });
  assert.deepEqual(jumpPlan(1129), { goto: 1000, nextClicks: 129 });
});

test('未显式传 --max-pages 时全书模式不把 1000 当作真实停页', () => {
  const named = parseArgs(['--version-name', '北师大版', '--textbook-name', '九年级上册']);
  assert.equal(named.maxPagesProvided, false);
  const limited = parseArgs(['--max-pages', '3']);
  assert.equal(limited.maxPagesProvided, true);
  assert.equal(limited.maxPages, 3);
});

test('目录进度按题号去重上卷，分母用该节点自己的共计', () => {
  const tree = buildCatalogProgressTree({
    nodes: [
      { externalId: 'ch1', parentExternalId: null, level: 1, name: '第一章' },
      { externalId: 's1', parentExternalId: 'ch1', level: 2, name: '第一节' },
      { externalId: 'p1', parentExternalId: 's1', level: 3, name: '知识点A' },
      { externalId: 'p2', parentExternalId: 's1', level: 3, name: '知识点B' },
    ],
    memberships: [
      { catalogExternalId: 'ch1', questionExternalId: 'q1' },
      { catalogExternalId: 'ch1', questionExternalId: 'q2' },
      { catalogExternalId: 's1', questionExternalId: 'q1' },
      { catalogExternalId: 'p1', questionExternalId: 'q1' },
      { catalogExternalId: 'p2', questionExternalId: 'q3' },
    ],
    stats: {
      ch1: { expectedTotal: 9734, expectedPages: 974, lastCompletedPage: 974 },
      s1: { expectedTotal: 100, expectedPages: 10, lastCompletedPage: 10 },
      p1: { expectedTotal: 40, expectedPages: 4, lastCompletedPage: 4 },
      p2: { expectedTotal: 90, expectedPages: 9, lastCompletedPage: 2 },
    },
  });
  assert.equal(tree.catalogs.length, 1);
  const chapter = tree.catalogs[0];
  assert.equal(chapter.expectedTotal, 9734);
  assert.equal(chapter.crawledUnique, 3);
  assert.equal(chapter.children[0].crawledUnique, 2);
  assert.equal(chapter.children[0].children[0].crawledUnique, 1);
  assert.equal(chapter.children[0].children[1].expectedTotal, 90);
  assert.equal(chapter.children[0].children[1].lastCompletedPage, 2);
  assert.equal(tree.pagesTotal, 974 + 10 + 4 + 9);
});

test('目录断点超过总页数则跳过，不跳到不存在的页', () => {
  assert.equal(nextCatalogPage(974, 1, 974), null);
  assert.equal(nextCatalogPage(973, 1, 974), 974);
  assert.equal(nextCatalogPage(0, 1, 974), 1);
  assert.equal(nextCatalogPage(0, 5, 0), 5);
});

test('分页器状态由页面控件推导，下一页在末页禁用', () => {
  const first = parsePagerState({
    currentPage: 1,
    total: 9731,
    pageCapacity: 10,
    nextDisabled: false,
  });
  assert.equal(first.totalPages, 974);
  assert.equal(first.hasNext, true);
  const last = parsePagerState({
    currentPage: 974,
    total: 9731,
    pageCapacity: 10,
    nextDisabled: true,
  });
  assert.equal(last.hasNext, false);
});

test('列表等待同时接受题目和明确的空目录状态', () => {
  assert.equal(isListReadyState({ questionCount: 1 }), true);
  assert.equal(isListReadyState({ totalText: '0 道题' }), true);
  assert.equal(isListReadyState({ emptyText: '暂无相关试题' }), true);
  assert.equal(isListReadyState({ totalText: '12 道题', emptyText: '' }), false);
  assert.equal(isListReadyState({ emptyText: '题库加载中' }), false);
});

test('每日批处理脚本按 shell 参数安全传递筛选条件', () => {
  const script = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'zujuan_sync_daily.sh'),
    'utf8',
  );
  assert.match(script, /run_sync --scene 作业/);
  assert.match(script, /run_sync --category 压轴题/);
  assert.match(script, /"\$@"/);
});

test('素材分类区分公式 SVG 和题图', () => {
  assert.equal(
    classifyAsset('https://staticzujuan.xkw.com/quesimg/Upload/formula/a.svg'),
    'formula',
  );
  assert.equal(
    classifyAsset('https://img.xkw.com/editorImg/a.png'),
    'image',
  );
});

test('详情数据合并时保留列表页新题标签并去重知识点', () => {
  const list = {
    externalId: '1',
    contentHtml: '<p>题目</p>',
    plainText: '题目',
    isNew: true,
    providerLabels: [{ dimension: 'fresh', value: '新题' }],
    knowledge: [{ externalId: '10', name: '知识点A', kind: 'knowledge_point' }],
    assets: [],
  };
  const detail = {
    externalId: '1',
    contentHtml: '<p>题目</p>',
    plainText: '题目',
    isNew: false,
    knowledge: [
      { externalId: '10', name: '知识点A', kind: 'knowledge_point' },
      { externalId: '11', name: '知识点B', kind: 'knowledge_point' },
    ],
    assets: [],
  };
  const merged = mergeQuestion(list, detail);
  assert.equal(merged.isNew, true);
  assert.equal(merged.detailFetched, true);
  assert.match(merged.listContentHash, /^[a-f0-9]{64}$/);
  assert.match(merged.detailContentHash, /^[a-f0-9]{64}$/);
  assert.equal(merged.knowledge.length, 2);
  assert.equal(merged.providerLabels.length, 1);
  assert.match(merged.contentHash, /^[a-f0-9]{64}$/);
});

test('空白规范化稳定', () => {
  assert.equal(normalizeWhitespace('  A\u00a0  B \n  C  '), 'A B\nC');
});

test('非法参数会失败', () => {
  assert.throws(() => parseArgs(['--max-pages', '0']), /正整数/);
  assert.throws(() => parseArgs(['--difficulty', '极难']), /不支持/);
  assert.throws(() => parseArgs(['--all-catalogs']), /catalog-level/);
  assert.throws(() => parseArgs(['--catalog-level', '4']), /只能是/);
  assert.throws(() => parseArgs(['--textbook-id', 'tb 1']), /稳定来源 ID/);
  assert.throws(() => parseArgs(['--textbook-id', 'tb/1']), /稳定来源 ID/);
  assert.throws(() => parseArgs(['--unknown']), /未知参数/);
});

test('textbook-id 支持稳定的字母数字来源 ID并规范化首尾空白', () => {
  const options = parseArgs(['--textbook-id', '  tb-1  ']);
  assert.equal(options.textbookId, 'tb-1');
  assert.equal(options.textbookIdProvided, true);
  assert.deepEqual(options.chapterIds, []);
});

test('只传 textbook-id 时不会回退到 261314，而是使用元数据入口章节', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zujuan-sync-scope-'));
  const dbPath = path.join(dir, 'collector.sqlite3');
  const store = new MetadataStore(dbPath);
  try {
    store.saveVersionGroup({
      externalVersionId: '195847',
      versionName: '北师大版',
      isNew: 'Y',
      sortOrder: 0,
      sourceUrl: 'https://zujuan.xkw.com/czsx/zj261314/o2/',
      raw: {},
    }, [{
      externalTextbookId: '195861',
      versionExternalId: '195847',
      textbookName: '七年级上册',
      grade: '七年级',
      volume: '上册',
      sourceUrl: 'https://zujuan.xkw.com/czsx/zj195861/',
      sortOrder: 0,
      bootstrapChapterExternalId: '195870',
      raw: {},
    }], '2026-01-01T00:00:00.000Z');
  } finally {
    store.close();
  }

  const options = parseArgs(['--textbook-id', '195861', '--db', dbPath]);
  assert.equal(options.textbookId, '195861');
  assert.deepEqual(options.chapterIds, []);
  assert.ok(!options.chapterIds.includes(DEFAULT_CHAPTER_ID));
  const resolved = resolveSyncScope(options, { dbPath });
  assert.deepEqual(resolved.chapterIds, ['195870']);
  assert.equal(
    buildListUrl(resolved, resolved.chapterIds[0], 1),
    'https://zujuan.xkw.com/czsx/zj195870/o2/',
  );
  assert.doesNotMatch(buildListUrl(resolved, resolved.chapterIds[0], 1), /261314/);
});

test('题库独立任务在采集库没有 source_textbooks 表时使用教材来源 ID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zujuan-sync-no-textbook-table-'));
  const dbPath = path.join(dir, 'collector.sqlite3');
  const db = new DatabaseSync(dbPath);
  db.close();
  try {
    const options = parseArgs(['--textbook-id', '260617', '--db', dbPath]);
    const resolved = resolveSyncScope(options, { dbPath });
    assert.deepEqual(resolved.chapterIds, ['260617']);
    assert.equal(
      buildListUrl(resolved, resolved.chapterIds[0], 1),
      'https://zujuan.xkw.com/czsx/zj260617/o2/',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('题库独立任务在采集库没有对应教材行时使用教材来源 ID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zujuan-sync-no-textbook-row-'));
  const dbPath = path.join(dir, 'collector.sqlite3');
  const store = new MetadataStore(dbPath);
  store.close();
  try {
    const options = parseArgs(['--textbook-id', '260617', '--db', dbPath]);
    const resolved = resolveSyncScope(options, { dbPath });
    assert.deepEqual(resolved.chapterIds, ['260617']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('题库独立任务在入口章节为空时使用教材来源 ID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zujuan-sync-empty-bootstrap-'));
  const dbPath = path.join(dir, 'collector.sqlite3');
  const store = new MetadataStore(dbPath);
  try {
    store.saveVersionGroup({
      externalVersionId: '195847',
      versionName: '北师大版',
      isNew: 'Y',
      sortOrder: 0,
      sourceUrl: 'https://zujuan.xkw.com/czsx/zj261314/o2/',
      raw: {},
    }, [{
      externalTextbookId: '260617',
      versionExternalId: '195847',
      textbookName: '九年级上册',
      grade: '九年级',
      volume: '上册',
      sourceUrl: 'https://zujuan.xkw.com/czsx/zj260617/',
      sortOrder: 0,
      bootstrapChapterExternalId: null,
      raw: {},
    }], '2026-01-01T00:00:00.000Z');
  } finally {
    store.close();
  }
  try {
    const options = parseArgs(['--textbook-id', '260617', '--db', dbPath]);
    const resolved = resolveSyncScope(options, { dbPath });
    assert.deepEqual(resolved.chapterIds, ['260617']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未传教材和章节时仍使用原默认入口 261314', () => {
  const options = parseArgs([]);
  assert.deepEqual(options.chapterIds, ['261314']);
  assert.equal(
    buildListUrl(options, options.chapterIds[0], 1),
    'https://zujuan.xkw.com/czsx/zj261314/o2/',
  );
});

test('按版本名和教材名进入全书模式，不回退 261314', () => {
  const options = parseArgs(['--version-name', '北师大版', '--textbook-name', '九年级上册']);
  assert.equal(options.namedTextbook, true);
  assert.equal(options.versionName, '北师大版');
  assert.equal(options.textbookName, '九年级上册');
  assert.equal(options.allCatalogs, true);
  assert.deepEqual(options.catalogLevels, [1, 2, 3]);
  assert.equal(options.maxPages, 1000);
  assert.equal(options.details, false);
  assert.equal(options.detailFallback, true);
  assert.equal(options.workers, 4);
  assert.equal(options.downloadAssets, true);
  assert.deepEqual(options.chapterIds, []);
  assert.ok(!options.chapterIds.includes(DEFAULT_CHAPTER_ID));
  const resolved = resolveSyncScope(options);
  assert.deepEqual(resolved.chapterIds, []);
});

test('只传 textbook-id 时脚本自己补全书列表默认值', () => {
  const options = parseArgs(['--textbook-id', '195861']);
  assert.equal(options.textbookIdProvided, true);
  assert.equal(options.allCatalogs, true);
  assert.deepEqual(options.catalogLevels, [1, 2, 3]);
  assert.equal(options.maxPages, 1000);
  assert.equal(options.downloadAssets, true);
  assert.equal(options.details, false);
  assert.equal(options.detailFallback, true);
  assert.equal(options.refreshDetails, false);
});

test('列表缺题干或有图无素材时才兜底详情', () => {
  assert.equal(listNeedsDetailFallback({ contentHtml: '<p>题干</p>', plainText: '题干', assets: [] }), false);
  assert.equal(listNeedsDetailFallback({ contentHtml: '', plainText: '', assets: [] }), true);
  assert.equal(listNeedsDetailFallback({
    contentHtml: '<p><img src="https://staticzujuan.xkw.com/a.png"></p>',
    plainText: '见图',
    assets: [],
  }), true);
  assert.equal(listNeedsDetailFallback({
    contentHtml: '<p><img src="https://staticzujuan.xkw.com/a.png"></p>',
    plainText: '见图',
    assets: [{ url: 'https://staticzujuan.xkw.com/a.png', type: 'image' }],
  }), false);
  assert.equal(shouldFetchQuestionDetail(
    { contentHtml: '<p>题干</p>', plainText: '题干', assets: [] },
    null,
    { details: false, detailFallback: true, refreshDetails: false },
    false,
  ), false);
  assert.equal(shouldFetchQuestionDetail(
    { contentHtml: '', plainText: '', assets: [] },
    null,
    { details: false, detailFallback: true, refreshDetails: false },
    false,
  ), true);
  assert.equal(shouldFetchQuestionDetail(
    { contentHtml: '<p>题干</p>', plainText: '题干', assets: [] },
    { detail_fetched: 1 },
    { details: false, detailFallback: true, refreshDetails: true },
    true,
  ), true);
});

test('全书模式默认下载题图公式，可用 --no-download-assets 关闭', () => {
  assert.equal(parseArgs([]).downloadAssets, false);
  const on = parseArgs(['--version-name', '北师大版', '--textbook-name', '九年级上册']);
  assert.equal(on.downloadAssets, true);
  const off = parseArgs([
    '--version-name', '北师大版',
    '--textbook-name', '九年级上册',
    '--no-download-assets',
  ]);
  assert.equal(off.downloadAssets, false);
});

test('默认单章模式只有 1 个工作标签，全书可用 --workers 覆盖', () => {
  assert.equal(parseArgs([]).workers, 1);
  const options = parseArgs([
    '--version-name', '北师大版',
    '--textbook-name', '九年级上册',
    '--workers', '3',
  ]);
  assert.equal(options.workers, 3);
  assert.throws(
    () => parseArgs(['--version-name', '北师大版', '--textbook-name', '九年级上册', '--workers', '9']),
    /不能超过 8/,
  );
});

test('目录按章分配到工作标签，同一章的节和知识点不拆开', () => {
  const catalogs = [
    { externalId: '261285', chapterExternalId: '261285', level: 1, name: '第一章' },
    { externalId: 's1', chapterExternalId: '261285', level: 2, name: '1.1' },
    { externalId: '261293', chapterExternalId: '261293', level: 1, name: '第二章' },
    { externalId: 's2', chapterExternalId: '261293', level: 2, name: '2.1' },
    { externalId: '261300', chapterExternalId: '261300', level: 1, name: '第三章' },
  ];
  const [single] = partitionCatalogsByChapter(catalogs, 1);
  assert.deepEqual(single.map((item) => item.externalId), ['261285', 's1', '261293', 's2', '261300']);

  const buckets = partitionCatalogsByChapter(catalogs, 4);
  assert.equal(buckets.length, 3);
  assert.deepEqual(buckets[0].map((item) => item.externalId), ['261285', 's1']);
  assert.deepEqual(buckets[1].map((item) => item.externalId), ['261293', 's2']);
  assert.deepEqual(buckets[2].map((item) => item.externalId), ['261300']);
});

test('并行失败时保留原始错误，不把连带 STOP 当成根因', () => {
  const original = new Error('locator.click: Timeout 15000ms exceeded');
  const cascade = new StopCrawlError('收到 STOP，任务安全停止。', 'signal');
  const picked = pickWorkerFailure([cascade, original, cascade]);
  assert.equal(picked, original);
  const onlySignal = new StopCrawlError('收到 SIGTERM，任务安全停止。', 'signal');
  assert.equal(pickWorkerFailure([onlySignal]).message, onlySignal.message);
});

test('只传 version-name 或 textbook-name 会失败', () => {
  assert.throws(() => parseArgs(['--version-name', '北师大版']), /同时提供/);
  assert.throws(() => parseArgs(['--textbook-name', '九年级上册']), /同时提供/);
});

test('全书名称模式需要详情时用 --refresh-details', () => {
  const options = parseArgs([
    '--version-name', '北师大版',
    '--textbook-name', '九年级上册',
    '--refresh-details',
  ]);
  assert.equal(options.details, true);
  assert.equal(options.refreshDetails, true);
});

test('可续采快照要求目录、题目和目录关系分别非空', () => {
  const base = {
    status: 'interrupted',
    snapshotLockedAt: '2026-08-30T03:15:35.526Z',
    snapshotComplete: false,
    catalogCount: 1,
    questionCount: 1,
    questionCatalogCount: 1,
    errors: [],
  };
  assert.equal(isResumablePartialRun(base), true);
  assert.equal(isResumablePartialRun({ ...base, catalogCount: 0 }), false);
  assert.equal(isResumablePartialRun({ ...base, questionCount: 0, catalogCount: 3 }), false);
  assert.equal(isResumablePartialRun({ ...base, questionCatalogCount: 0, questionCount: 3 }), false);
});

test('续采参数启用 checkpoint 且不能与 --no-resume 冲突', () => {
  const options = parseArgs(['--resume-run-id', '19']);
  assert.equal(options.resumeRunId, 19);
  assert.equal(options.resume, true);
  assert.throws(
    () => parseArgs(['--no-resume', '--resume-run-id', '19']),
    /不能与 --no-resume 同时使用/,
  );
  assert.throws(() => parseArgs(['--resume-run-id', '0']), /必须是正整数/);
  assert.throws(() => parseArgs(['--resume-run-id', '1.5']), /必须是正整数/);
});

function resumeScopeFixture() {
  return {
    chapterIds: ['c1'],
    textbookId: 'tb-resume',
    catalogLevels: [1, 2, 3],
    catalogIds: [],
    allCatalogs: true,
    withinChapterIds: [],
    filters: {
      scene: null,
      questionType: null,
      difficulty: null,
      category: null,
      year: null,
      fresh: false,
      sort: { id: 2, name: '最新' },
    },
    startPage: 1,
    maxPages: 3,
    details: false,
    detailFallback: true,
    refreshDetails: false,
    includeVisibleSolutions: false,
    downloadAssets: true,
    requireDetails: false,
    requireAssets: true,
    limit: 0,
    truncated: false,
  };
}

function seedResumableRun(store, scope, status = 'interrupted', message = 'ECONNRESET') {
  const runId = store.beginRun(scope);
  store.saveRunCatalogTree(runId, scope.textbookId, [{
    externalId: 'c1',
    level: 1,
    type: 'chapter',
    name: '第一章',
    path: '/第一章',
  }]);
  store.saveRunQuestion(runId, scope.textbookId, {
    externalId: 'q1',
    contentHtml: '<p>题干</p>',
    plainText: '题干',
    providerLabels: [{ dimension: 'provider_tag', value: '同步题' }],
    assets: [{
      url: 'https://staticzujuan.xkw.com/q1.png',
      type: 'image',
      localPath: 'assets/q1.png',
      sha256: 'a'.repeat(64),
    }],
  }, 'c1');
  store.saveRunQuestionCatalogs(runId, scope.textbookId, 'q1', [{
    externalId: 'c1', level: 1, name: '第一章', path: '/第一章',
  }]);
  store.finishRun(runId, status, {
    pagesOk: status === 'interrupted' ? 1 : 2,
    questionsSeen: 1,
    questionsInserted: 1,
    errors: status === 'success' ? 0 : 1,
  }, message);
  return runId;
}

test('续采创建新 run 原子复制五类快照并支持链式续采，旧 run 不可变', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zujuan-resume-'));
  const dbPath = path.join(directory, 'collector.sqlite3');
  const store = new SyncStore(dbPath);
  try {
    const scope = resumeScopeFixture();
    const sourceRunId = seedResumableRun(store, scope);
    const before = store.db.prepare(`
      SELECT plain_text, content_html FROM sync_run_question_items WHERE run_id = ?
    `).get(sourceRunId);
    const resumedRunId = store.beginRun({ ...scope, resumeFromRunId: sourceRunId });
    assert.equal(store.getRun(resumedRunId).status, 'running');
    assert.equal(JSON.parse(store.getRun(resumedRunId).scope_json).resumeFromRunId, sourceRunId);
    assert.deepEqual(store.runSnapshotCounts(resumedRunId), {
      catalogCount: 1,
      questionCount: 1,
      questionCatalogCount: 1,
      questionTagCount: 1,
      questionAssetCount: 1,
    });
    assert.deepEqual(store.db.prepare(`
      SELECT plain_text, content_html FROM sync_run_question_items WHERE run_id = ?
    `).get(sourceRunId), before);
    assert.throws(
      () => store.db.prepare(
        "UPDATE sync_run_question_items SET plain_text = '篡改' WHERE run_id = ?",
      ).run(sourceRunId),
      /immutable/,
    );

    store.finishRun(resumedRunId, 'interrupted', { pagesOk: 0, errors: 1 }, 'TimeoutError: Timeout 30000ms exceeded.');
    const chainedRunId = store.beginRun({ ...scope, resumeFromRunId: resumedRunId });
    assert.deepEqual(store.runSnapshotCounts(chainedRunId), store.runSnapshotCounts(resumedRunId));
    assert.equal(validateResumeSourceRun(dbPath, resumedRunId, scope).resumable, true);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('续采只继承来源 run 的断点，绝不采用更大的全局断点', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zujuan-resume-checkpoint-'));
  const dbPath = path.join(directory, 'collector.sqlite3');
  const store = new SyncStore(dbPath);
  try {
    const scope = resumeScopeFixture();
    const sourceRunId = seedResumableRun(store, scope);
    const filterJson = checkpointFilterJson(scope);
    const scopeKey = checkpointScopeKey('c1', filterJson);
    const observedAt = new Date().toISOString();
    store.db.prepare(`
      INSERT INTO sync_progress (
        run_id, worker_id, catalog_external_id, catalog_name, catalog_path,
        current_page, expected_pages, expected_total, updated_at
      ) VALUES (?, 1, 'c1', '第一章', '/第一章', 191, 975, 9743, ?)
    `).run(sourceRunId, observedAt);
    store.db.prepare(`
      INSERT INTO sync_checkpoints (
        scope_key, provider, chapter_id, filter_json, last_completed_page, updated_at
      ) VALUES (?, 'zujuan', 'c1', ?, 900, ?)
      ON CONFLICT(scope_key) DO UPDATE SET last_completed_page = 900, updated_at = excluded.updated_at
    `).run(scopeKey, filterJson, observedAt);

    const resumedRunId = store.beginRun({ ...scope, resumeFromRunId: sourceRunId });
    assert.equal(store.getCheckpoint(scopeKey), 900);
    assert.equal(store.getRunCheckpoint(resumedRunId, scopeKey), 191);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('明确指定已阻断 run 时可继承其已封存的完整页', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zujuan-resume-blocked-'));
  const dbPath = path.join(directory, 'collector.sqlite3');
  const store = new SyncStore(dbPath);
  try {
    const scope = resumeScopeFixture();
    const blockedRunId = seedResumableRun(store, scope, 'blocked', '滑块验证');
    const validation = validateResumeSourceRun(dbPath, blockedRunId, scope);
    assert.equal(validation.resumable, true);
    assert.equal(validation.run.status, 'blocked');
    const resumedRunId = store.beginRun({ ...scope, resumeFromRunId: blockedRunId });
    assert.deepEqual(store.runSnapshotCounts(resumedRunId), store.runSnapshotCounts(blockedRunId));
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('续采严格拒绝确定性失败和作用域不匹配', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zujuan-resume-reject-'));
  const dbPath = path.join(directory, 'collector.sqlite3');
  const store = new SyncStore(dbPath);
  try {
    const scope = resumeScopeFixture();
    const failedRunId = seedResumableRun(store, scope, 'failed', 'robots.txt disallowed');
    assert.throws(
      () => store.beginRun({ ...scope, resumeFromRunId: failedRunId }),
      /不是可续采的瞬时错误/,
    );
    const transientRunId = seedResumableRun(store, scope, 'failed', 'page.waitForFunction: Timeout 30000ms exceeded.');
    assert.throws(
      () => store.beginRun({ ...scope, chapterIds: ['other'], resumeFromRunId: transientRunId }),
      /采集范围不匹配/,
    );
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
