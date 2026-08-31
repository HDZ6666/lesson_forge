'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  BLOCK_TEXT_MARKERS,
  MetadataStore,
  StopCrawlError,
  assertDiscoveryIds,
  buildReport,
  canFallbackToHeaded,
  chooseInitialHeadless,
  classifyProtectionState,
  createCollectorPageFactory,
  dismissStaleCollectorTabs,
  lookupBootstrapChapter,
  lookupTextbookByNames,
  minimizeCollectorWindow,
  minimizeCollectorWindowWithLog,
  newCollectorPage,
  pickExactByName,
  normalizeIsNew,
  parseArgs,
  parseBootstrapChapterFromHtml,
  parseGradeVolume,
  decodeHtmlEntities,
  parseTextbooksFromApiHtml,
  parseTextbooksFromHtml,
  parseVersionsFromHtml,
  buildChapterTextbooksUrl,
  profileLooksWarm,
  prepareCollectorPage,
  validateDiscovery,
} = require('../zujuan_metadata_sync.cjs');

const {
  DEFAULT_CHAPTER_ID,
  buildListUrl,
  parseArgs: parseSyncArgs,
  resolveSyncScope,
} = require('../zujuan_sync.cjs');

const VERSION_HTML = `
<div id="chapter_textbook_version" class="menu-item__navs">
  <a url="/czsx/zj{0}/" versionid="195847" data-qbmid="1255" data-type="selectVersion"
     class="item font-item selected new-version" href="javascript:void 0">北师大版</a>
  <a url="/czsx/zj{0}/" versionid="55474" data-qbmid="278" data-type="selectVersion"
     class="item font-item " href="javascript:void 0">北师大版（2012）</a>
  <a url="/czsx/zj{0}/" versionid="195846" data-type="selectVersion"
     class="item font-item new-version" href="javascript:void 0">人教版</a>
</div>
`;

const TEXTBOOK_HTML_A = `
<div class="title-menu__menu-item" id="chapter_textbooks">
  <span class="menu-item__title">教材：</span>
  <div class="menu-item__navs">
    <a class="item font-item" href="/czsx/zj195861/" chapter-id="195861" data-qbmid="6589">七年级上册</a>
    <a class="item font-item" href="/czsx/zj212429/" chapter-id="212429">七年级下册</a>
    <a class="item font-item selected" href="/czsx/zj260617/" chapter-id="260617">九年级上册</a>
    <a class="item font-item" href="/czsx/zj999001/" chapter-id="999001">全一册</a>
    <a class="item font-item" href="/czsx/zj999002/" chapter-id="999002">九年级下册</a>
  </div>
</div>
`;

const TEXTBOOK_HTML_B = `
<div id="chapter_textbooks">
  <div class="menu-item__navs">
    <a class="item font-item selected" href="/czsx/zj55480/" chapter-id="55480">七年级上册</a>
    <a class="item font-item" href="/czsx/zj55481/" chapter-id="55481">七年级下册</a>
  </div>
</div>
`;

const TREE_HTML = `
<div class="tk-tree" tree-id="260617">
  <ul>
    <li tree-id="261285" class="tree-node tree-children" data-level="1">
      <div class="tree-node-name" data-tree-id="261285"><a class="tree-anchor">第一章</a></div>
    </li>
    <li tree-id="261314" class="tree-node" data-level="1">
      <div class="tree-node-name" data-tree-id="261314"><a class="tree-anchor">第五章</a></div>
    </li>
  </ul>
</div>
`;

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zujuan-metadata-'));
  return {
    dir,
    dbPath: path.join(dir, 'collector.sqlite3'),
  };
}

function fakePage(url = 'about:blank') {
  let closed = false;
  return {
    url: () => url,
    isClosed: () => closed,
    close: async () => { closed = true; },
  };
}

test('Collector 复用唯一空白页，不额外创建标签', async () => {
  const blank = fakePage();
  let created = 0;
  const context = {
    pages: () => [blank],
    newPage: async () => {
      created += 1;
      return fakePage();
    },
  };
  assert.equal(await prepareCollectorPage(context), blank);
  assert.equal(created, 0);
});

test('Collector 页面工厂首次复用启动页，之后才新建页', async () => {
  const first = fakePage();
  const second = fakePage();
  let created = 0;
  const context = {
    pages: () => [first],
    newPage: async () => {
      created += 1;
      return second;
    },
  };
  const createPage = createCollectorPageFactory(context, { headless: true });
  assert.equal(await createPage(), first);
  assert.equal(created, 0);
  assert.equal(await createPage(), second);
  assert.equal(created, 1);
});

test('Collector 启动时保留一个空白页并清理恢复的旧标签', async () => {
  const stale = fakePage('https://zujuan.xkw.com/old');
  const blank = fakePage();
  const other = fakePage('chrome://newtab/');
  const context = { pages: () => [stale, blank, other] };
  assert.equal(await dismissStaleCollectorTabs(context), blank);
  assert.equal(stale.isClosed(), true);
  assert.equal(blank.isClosed(), false);
  assert.equal(other.isClosed(), true);
});

test('Collector 最小化必须经 CDP 回读确认', async () => {
  const page = fakePage();
  const calls = [];
  const session = {
    send: async (method, payload) => {
      calls.push([method, payload]);
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Browser.getWindowBounds') {
        return { bounds: { windowState: 'minimized' } };
      }
      return {};
    },
    detach: async () => {},
  };
  const context = {
    pages: () => [page],
    newCDPSession: async () => session,
  };
  assert.equal(await minimizeCollectorWindow(context), true);
  assert.deepEqual(calls.map(([method]) => method), [
    'Browser.getWindowForTarget',
    'Browser.setWindowBounds',
    'Browser.getWindowBounds',
  ]);
});

test('Collector 新建 worker 或详情页后会再次最小化', async () => {
  const page = fakePage();
  let created = 0;
  let minimized = 0;
  const context = {
    pages: () => [page],
    newPage: async () => {
      created += 1;
      return page;
    },
    newCDPSession: async () => ({
      send: async (method) => {
        if (method === 'Browser.getWindowForTarget') return { windowId: 9 };
        if (method === 'Browser.setWindowBounds') minimized += 1;
        if (method === 'Browser.getWindowBounds') {
          return { bounds: { windowState: 'minimized' } };
        }
        return {};
      },
      detach: async () => {},
    }),
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await newCollectorPage(context, { headless: false }), page);
  } finally {
    console.log = originalLog;
  }
  assert.equal(created, 1);
  assert.equal(minimized, 1);
});

test('Collector 最小化失败时返回 false 且不误报成功', async () => {
  const page = fakePage();
  const context = {
    pages: () => [page],
    newCDPSession: async () => ({
      send: async (method) => {
        if (method === 'Browser.getWindowForTarget') return { windowId: 8 };
        if (method === 'Browser.getWindowBounds') {
          return { bounds: { windowState: 'normal' } };
        }
        return {};
      },
      detach: async () => {},
    }),
  };
  const logged = [];
  const warned = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logged.push(args.join(' '));
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    assert.equal(
      await minimizeCollectorWindowWithLog(context, { headless: false }),
      false,
    );
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  assert.equal(logged.some((line) => line.includes('已最小化')), false);
  assert.equal(warned.some((line) => line.includes('未生效')), true);
});

function sampleVersion(overrides = {}) {
  return {
    externalVersionId: '195847',
    versionName: '北师大版',
    isNew: 'Y',
    sortOrder: 0,
    sourceUrl: 'https://zujuan.xkw.com/czsx/zj261314/o2/',
    raw: { versionid: '195847' },
    ...overrides,
  };
}

function sampleTextbook(overrides = {}) {
  return {
    externalTextbookId: '260617',
    versionExternalId: '195847',
    textbookName: '九年级上册',
    grade: '九年级',
    volume: '上册',
    sourceUrl: 'https://zujuan.xkw.com/czsx/zj260617/',
    sortOrder: 0,
    bootstrapChapterExternalId: '261285',
    raw: { 'chapter-id': '260617' },
    ...overrides,
  };
}

test('默认参数和非法参数', () => {
  const options = parseArgs([]);
  assert.equal(options.seedUrl, 'https://zujuan.xkw.com/czsx/zj261314/o2/');
  assert.equal(options.headless, true);
  assert.equal(options.saveRaw, true);
  assert.equal(options.acknowledgeSourcePolicy, false);
  assert.equal(options.statusOnly, false);
  assert.equal(options.delayMin, 2200);
  assert.equal(options.delayMax, 3800);

  const custom = parseArgs([
    '--acknowledge-source-policy',
    '--seed-url', 'https://zujuan.xkw.com/czsx/zj261296/',
    '--headful',
    '--no-save-raw',
    '--timeout', '15000',
    '--json-output', 'report.json',
  ]);
  assert.equal(custom.acknowledgeSourcePolicy, true);
  assert.equal(custom.seedUrl, 'https://zujuan.xkw.com/czsx/zj261296/');
  assert.equal(custom.headless, false);
  assert.equal(custom.saveRaw, false);
  assert.equal(custom.timeout, 15000);
  assert.match(custom.jsonOutput, /report\.json$/);

  assert.throws(() => parseArgs(['--unknown']), /未知参数/);
  assert.throws(() => parseArgs(['--timeout']), /缺少参数值/);
  assert.throws(() => parseArgs(['--timeout', '0']), /正整数/);
  assert.throws(() => parseArgs(['--delay-min', '4000', '--delay-max', '1000']), /不能小于/);
  assert.throws(() => parseArgs(['--seed-url', 'not-a-url']), /合法 URL/);
  assert.throws(() => parseArgs(['--seed-url', 'https://example.com/czsx/']), /zujuan\.xkw\.com/);
  assert.throws(() => parseArgs(['--seed-url', 'http://zujuan.xkw.com/czsx/zj261314/']), /zujuan\.xkw\.com/);
});

test('阻断页面识别为防护熔断，挑战页视为可等待跳转', () => {
  const blocked = classifyProtectionState({
    title: '阻断页面',
    text: '已阻断 很抱歉，由于您访问的URL有可能对网站造成安全威胁，您的访问被阻断',
    hasChallengeInputs: false,
    hasContent: false,
  });
  assert.equal(blocked.terminalBlock, true);
  assert.equal(blocked.marker, '已阻断');

  const content = classifyProtectionState({
    title: '第五章 二次函数练习题',
    text: '初中数学 章节选题',
    hasChallengeInputs: false,
    hasContent: true,
  });
  assert.equal(content.terminalBlock, false);
  assert.equal(content.transientChallenge, false);

  for (const marker of BLOCK_TEXT_MARKERS) {
    const normalQuestion = classifyProtectionState({
      title: '第一章 特殊平行四边形练习题',
      text: `这是正常公开题干，其中包含词语：${marker}`,
      hasChallengeInputs: false,
      hasContent: true,
    });
    assert.equal(normalQuestion.terminalBlock, false, `正常题干不应因「${marker}」被熔断`);
    assert.equal(normalQuestion.transientChallenge, false);
  }

  const challenge = classifyProtectionState({
    title: '',
    text: '',
    hasChallengeInputs: true,
    hasContent: false,
  });
  assert.equal(challenge.transientChallenge, true);
  assert.equal(challenge.terminalBlock, false);
});

test('冷档案改有头，热档案可先无头，被拦后才改有头', () => {
  const cold = fs.mkdtempSync(path.join(os.tmpdir(), 'zujuan-cold-'));
  assert.equal(profileLooksWarm(cold), false);
  assert.equal(chooseInitialHeadless({ headless: true, profileDir: cold }), false);
  assert.equal(chooseInitialHeadless({ headless: false, profileDir: cold }), false);

  const warm = fs.mkdtempSync(path.join(os.tmpdir(), 'zujuan-warm-'));
  fs.mkdirSync(path.join(warm, 'Default', 'Network'), { recursive: true });
  fs.writeFileSync(path.join(warm, 'Default', 'Network', 'Cookies'), 'session');
  assert.equal(profileLooksWarm(warm), true);
  assert.equal(chooseInitialHeadless({ headless: true, profileDir: warm }), true);
  assert.equal(chooseInitialHeadless({ headless: false, profileDir: warm }), false);

  const blocked = new StopCrawlError('站点返回验证/防护页面，任务已熔断。 标记：已阻断', 'challenge');
  assert.equal(canFallbackToHeaded({ headless: true }, blocked), true);
  assert.equal(canFallbackToHeaded({ headless: false }, blocked), false);
  assert.equal(canFallbackToHeaded({ headless: true }, new Error('timeout')), false);
});

test('版本名称保留括号年份，且不得合并同名不同年份版本', () => {
  const versions = parseVersionsFromHtml(VERSION_HTML, {
    sourceUrl: 'https://zujuan.xkw.com/czsx/zj261314/o2/',
  });
  assert.equal(versions.length, 3);
  const names = versions.map((item) => item.versionName);
  assert.deepEqual(names, ['北师大版', '北师大版（2012）', '人教版']);
  assert.notEqual(versions[0].externalVersionId, versions[1].externalVersionId);
  assert.equal(versions[0].versionName.includes('（2012）'), false);
  assert.equal(versions[1].versionName, '北师大版（2012）');
});

test('新教材标识转换为 Y/N/NULL', () => {
  assert.equal(normalizeIsNew({ className: 'item font-item new-version', attributes: {} }), 'Y');
  assert.equal(normalizeIsNew({ className: 'item font-item', attributes: {} }), 'N');
  assert.equal(normalizeIsNew(null), null);
  assert.equal(normalizeIsNew(undefined), null);
  assert.equal(normalizeIsNew('Y'), 'Y');
  assert.equal(normalizeIsNew('N'), 'N');
  const versions = parseVersionsFromHtml(VERSION_HTML);
  assert.equal(versions[0].isNew, 'Y');
  assert.equal(versions[1].isNew, 'N');
  assert.equal(versions[2].isNew, 'Y');
});

test('chaptertextbooks 接口 URL 带上版本 ID 和 url 模板', () => {
  const href = buildChapterTextbooksUrl(
    { externalVersionId: '55474', urlTemplate: '/czsx/zj{0}/' },
    { baseUrl: 'https://zujuan.xkw.com' },
  );
  const parsed = new URL(href);
  assert.equal(parsed.origin, 'https://zujuan.xkw.com');
  assert.equal(parsed.pathname, '/zujuan-api/chaptertextbooks');
  assert.equal(parsed.searchParams.get('textbookVersionId'), '55474');
  assert.equal(parsed.searchParams.get('url'), '/czsx/zj{0}/');
});

test('接口返回的 href 会保存为教材来源 URL', () => {
  const html = `
<div class="menu-item__navs">
    <a class="item font-item " href="/czsx/zj195860/" chapter-id="195860" data-qbmid="6588">&#x4E03;&#x5E74;&#x7EA7;&#x4E0A;&#x518C;</a>
    <a class="item font-item " href="/czsx/zj212428/" chapter-id="212428" data-qbmid="7067">&#x4E03;&#x5E74;&#x7EA7;&#x4E0B;&#x518C;</a>
</div>
`;
  const textbooks = parseTextbooksFromApiHtml(html, {
    versionExternalId: '195846',
    baseUrl: 'https://zujuan.xkw.com',
    bankPath: 'czsx',
  });
  assert.equal(textbooks.length, 2);
  assert.equal(textbooks[0].textbookName, '七年级上册');
  assert.equal(textbooks[0].externalTextbookId, '195860');
  assert.equal(textbooks[0].href, '/czsx/zj195860/');
  assert.equal(textbooks[0].sourceUrl, 'https://zujuan.xkw.com/czsx/zj195860/');
  assert.equal(textbooks[0].qbmid, '6588');
  assert.equal(textbooks[1].href, '/czsx/zj212428/');
  assert.equal(textbooks[1].sourceUrl, 'https://zujuan.xkw.com/czsx/zj212428/');
});

test('HTML 数字实体解码成中文教材名', () => {
  assert.equal(decodeHtmlEntities('&#x4E03;&#x5E74;&#x7EA7;&#x4E0B;&#x518C;'), '七年级下册');
  const textbooks = parseTextbooksFromApiHtml(`
    <a class="item font-item" href="/czsx/zj58065/" chapter-id="58065">&#x4E03;&#x5E74;&#x7EA7;&#x4E0B;&#x518C;</a>
  `, {
    versionExternalId: '58019',
    baseUrl: 'https://zujuan.xkw.com',
    bankPath: 'czsx',
  });
  assert.equal(textbooks[0].textbookName, '七年级下册');
  assert.deepEqual(parseGradeVolume(textbooks[0].textbookName), { grade: '七年级', volume: '下册' });
});

test('教材列表接口碎片没有 #chapter_textbooks 也能解析', () => {
  const fragment = `
    <span class="menu-item__title">教材：</span>
    <div class="menu-item__navs">
      <a class="item font-item" href="/czsx/zj195861/" chapter-id="195861">七年级上册</a>
      <a class="item font-item" href="/czsx/zj212429/" chapter-id="212429">七年级下册</a>
    </div>
  `;
  const textbooks = parseTextbooksFromApiHtml(fragment, {
    versionExternalId: '195846',
    baseUrl: 'https://zujuan.xkw.com',
    bankPath: 'czsx',
  });
  assert.equal(textbooks.length, 2);
  assert.equal(textbooks[0].externalTextbookId, '195861');
  assert.equal(textbooks[0].href, '/czsx/zj195861/');
  assert.equal(textbooks[0].sourceUrl, 'https://zujuan.xkw.com/czsx/zj195861/');
  assert.equal(textbooks[1].textbookName, '七年级下册');
});

test('教材列表接口返回滑动验证页时熔断', () => {
  const html = '<title>滑动验证页面</title><div>请完成安全验证</div>';
  assert.throws(
    () => parseTextbooksFromApiHtml(html),
    (error) => error instanceof StopCrawlError && error.code === 'challenge',
  );
});

test('七年级上册、九年级下册、全一册的 grade/volume 解析', () => {
  assert.deepEqual(parseGradeVolume('七年级上册'), { grade: '七年级', volume: '上册' });
  assert.deepEqual(parseGradeVolume('九年级下册'), { grade: '九年级', volume: '下册' });
  assert.deepEqual(parseGradeVolume('全一册'), { grade: null, volume: '全一册' });
  assert.deepEqual(parseGradeVolume('九年级全一册'), { grade: '九年级', volume: '全一册' });
  const textbooks = parseTextbooksFromHtml(TEXTBOOK_HTML_A, {
    versionExternalId: '195847',
    baseUrl: 'https://zujuan.xkw.com',
    bankPath: 'czsx',
  });
  const byName = Object.fromEntries(textbooks.map((item) => [item.textbookName, item]));
  assert.equal(byName['七年级上册'].grade, '七年级');
  assert.equal(byName['七年级上册'].volume, '上册');
  assert.equal(byName['九年级下册'].grade, '九年级');
  assert.equal(byName['九年级下册'].volume, '下册');
  assert.equal(byName['全一册'].grade, null);
  assert.equal(byName['全一册'].volume, '全一册');
  assert.equal(byName['九年级上册'].externalTextbookId, '260617');
  assert.equal(byName['九年级上册'].sourceUrl, 'https://zujuan.xkw.com/czsx/zj260617/');
});

test('同名教材在不同版本下的正确归属', () => {
  const { dbPath } = tempDb();
  const store = new MetadataStore(dbPath);
  try {
    store.saveVersionGroup(sampleVersion(), [
      sampleTextbook({
        externalTextbookId: '195861',
        textbookName: '七年级上册',
        grade: '七年级',
        volume: '上册',
        bootstrapChapterExternalId: '195870',
        sortOrder: 0,
      }),
    ], '2026-01-01T00:00:00.000Z');
    store.saveVersionGroup(sampleVersion({
      externalVersionId: '55474',
      versionName: '北师大版（2012）',
      isNew: 'N',
      sortOrder: 1,
    }), [
      sampleTextbook({
        externalTextbookId: '55480',
        versionExternalId: '55474',
        textbookName: '七年级上册',
        grade: '七年级',
        volume: '上册',
        sourceUrl: 'https://zujuan.xkw.com/czsx/zj55480/',
        bootstrapChapterExternalId: '55490',
        sortOrder: 0,
      }),
    ], '2026-01-01T00:00:00.000Z');

    const rows = store.listTextbooks().filter((row) => row.textbook_name === '七年级上册');
    assert.equal(rows.length, 2);
    const byId = Object.fromEntries(rows.map((row) => [row.external_textbook_id, row]));
    assert.equal(byId['195861'].version_external_id, '195847');
    assert.equal(byId['55480'].version_external_id, '55474');
  } finally {
    store.close();
  }
});

test('版本和教材按外部 ID 去重', () => {
  const versions = parseVersionsFromHtml(VERSION_HTML + VERSION_HTML.replace('chapter_textbook_version', 'other'));
  assert.equal(versions.length, 3);
  const textbooksA = parseTextbooksFromHtml(TEXTBOOK_HTML_A, { versionExternalId: '195847', allowEmpty: true });
  const textbooksB = parseTextbooksFromHtml(TEXTBOOK_HTML_B, { versionExternalId: '55474', allowEmpty: true });
  const duplicateTextbooks = [
    ...textbooksA,
    { ...textbooksA[0], versionExternalId: '195847' },
  ];
  const validation = validateDiscovery(versions, duplicateTextbooks);
  assert.equal(validation.duplicateIds.some((item) => item.type === 'textbook'), true);
  const unique = validateDiscovery(versions, [...textbooksA, ...textbooksB]);
  assert.deepEqual(unique.duplicateIds, []);
});

test('缺少稳定 external ID 时阻断', () => {
  const html = `
    <div id="chapter_textbook_version">
      <a class="item font-item" href="javascript:void 0">北师大版</a>
    </div>
  `;
  const versions = parseVersionsFromHtml(html);
  assert.equal(versions[0].externalVersionId, null);
  assert.throws(
    () => assertDiscoveryIds(versions, []),
    (error) => error instanceof StopCrawlError && error.code === 'missing_external_id',
  );
  const textbooks = parseTextbooksFromHtml(`
    <div id="chapter_textbooks">
      <a class="item font-item" href="javascript:void 0">七年级上册</a>
    </div>
  `, { versionExternalId: '195847', allowEmpty: true });
  assert.throws(
    () => assertDiscoveryIds([sampleVersion()], textbooks),
    /缺少稳定来源 ID/,
  );
});

test('source_textbooks 外键完整性', () => {
  const { dbPath } = tempDb();
  const store = new MetadataStore(dbPath);
  try {
    store.saveVersionGroup(sampleVersion(), [sampleTextbook()], '2026-01-01T00:00:00.000Z');
    assert.throws(() => {
      store.db.prepare(`
        INSERT INTO source_textbooks (
          provider, external_textbook_id, version_external_id, textbook_name,
          grade, volume, source_url, sort_order, status,
          bootstrap_chapter_external_id, first_seen_at, last_seen_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?, ?, ?)
      `).run(
        'zujuan',
        'orphan-1',
        'missing-version',
        '七年级上册',
        '七年级',
        '上册',
        'https://zujuan.xkw.com/czsx/zj1/',
        0,
        '1',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '{}',
      );
    }, /FOREIGN KEY|constraint/i);
    assert.equal(store.listTextbooks().length, 1);
  } finally {
    store.close();
  }
});

test('UPSERT 幂等，重复运行不增加行数', () => {
  const { dbPath } = tempDb();
  const store = new MetadataStore(dbPath);
  try {
    const first = store.saveVersionGroup(sampleVersion(), [sampleTextbook()], '2026-01-01T00:00:00.000Z');
    const second = store.saveVersionGroup(sampleVersion(), [sampleTextbook()], '2026-01-02T00:00:00.000Z');
    assert.equal(first.inserted, 2);
    assert.equal(second.inserted, 0);
    assert.equal(second.unchanged, 2);
    assert.equal(store.listVersions().length, 1);
    assert.equal(store.listTextbooks().length, 1);
  } finally {
    store.close();
  }
});

test('first_seen_at 保留、last_seen_at 更新', () => {
  const { dbPath } = tempDb();
  const store = new MetadataStore(dbPath);
  try {
    store.saveVersionGroup(sampleVersion(), [sampleTextbook()], '2026-01-01T00:00:00.000Z');
    store.saveVersionGroup(
      sampleVersion({ versionName: '北师大版', isNew: 'Y', sortOrder: 3 }),
      [sampleTextbook({ sortOrder: 4 })],
      '2026-08-01T00:00:00.000Z',
    );
    const version = store.getVersion('195847');
    const textbook = store.getTextbook('260617');
    assert.equal(version.first_seen_at, '2026-01-01T00:00:00.000Z');
    assert.equal(version.last_seen_at, '2026-08-01T00:00:00.000Z');
    assert.equal(textbook.first_seen_at, '2026-01-01T00:00:00.000Z');
    assert.equal(textbook.last_seen_at, '2026-08-01T00:00:00.000Z');
    assert.equal(version.sort_order, 3);
    assert.equal(textbook.sort_order, 4);
    assert.equal(version.status, '0');
    assert.equal(textbook.status, '0');
  } finally {
    store.close();
  }
});

test('扫描失败不删除、不停用历史数据', () => {
  const { dbPath } = tempDb();
  const store = new MetadataStore(dbPath);
  try {
    store.saveVersionGroup(sampleVersion(), [sampleTextbook()], '2026-01-01T00:00:00.000Z');
    assert.throws(() => assertDiscoveryIds([{ versionName: '损坏版本', externalVersionId: null }], []));
    assert.throws(() => {
      store.saveVersionGroup(
        sampleVersion({ externalVersionId: 'new-ok' }),
        [sampleTextbook({
          externalTextbookId: 'bad-book',
          versionExternalId: 'not-written-yet-other',
        })],
        '2026-02-01T00:00:00.000Z',
      );
    });
    const versions = store.listVersions();
    const textbooks = store.listTextbooks();
    assert.equal(versions.length, 1);
    assert.equal(textbooks.length, 1);
    assert.equal(versions[0].external_version_id, '195847');
    assert.equal(versions[0].status, '0');
    assert.equal(textbooks[0].status, '0');
    assert.equal(textbooks[0].external_textbook_id, '260617');
  } finally {
    store.close();
  }
});

test('JSON 汇总数量与 SQLite 实际数量一致', () => {
  const { dbPath } = tempDb();
  const store = new MetadataStore(dbPath);
  try {
    store.saveVersionGroup(sampleVersion(), [
      sampleTextbook(),
      sampleTextbook({
        externalTextbookId: '195861',
        textbookName: '七年级上册',
        grade: '七年级',
        volume: '上册',
        sourceUrl: 'https://zujuan.xkw.com/czsx/zj195861/',
        bootstrapChapterExternalId: '195870',
        sortOrder: 1,
      }),
    ], '2026-01-01T00:00:00.000Z');
    store.saveVersionGroup(sampleVersion({
      externalVersionId: '55474',
      versionName: '北师大版（2012）',
      isNew: 'N',
      sortOrder: 1,
    }), [
      sampleTextbook({
        externalTextbookId: '55480',
        versionExternalId: '55474',
        textbookName: '七年级上册',
        sourceUrl: 'https://zujuan.xkw.com/czsx/zj55480/',
        bootstrapChapterExternalId: '55490',
      }),
    ], '2026-01-01T00:00:00.000Z');

    const textbooks = [
      sampleTextbook(),
      sampleTextbook({ externalTextbookId: '195861', textbookName: '七年级上册', bootstrapChapterExternalId: null }),
      sampleTextbook({
        externalTextbookId: '55480',
        versionExternalId: '55474',
        textbookName: '七年级上册',
        bootstrapChapterExternalId: '55490',
      }),
    ];
    const validation = validateDiscovery([
      sampleVersion(),
      sampleVersion({ externalVersionId: '55474', versionName: '北师大版（2012）' }),
    ], textbooks);
    const report = buildReport(store, {
      validation,
      counts: { inserted: 5, updated: 0, unchanged: 0 },
    });
    assert.equal(report.versionCount, store.listVersions().length);
    assert.equal(report.textbookCount, store.listTextbooks().length);
    assert.equal(report.versions.reduce((sum, item) => sum + item.textbookCount, 0), report.textbookCount);
    assert.equal(report.validation.missingBootstrapChapters.length, 1);
    const byName = Object.fromEntries(report.versions.map((item) => [item.versionName, item]));
    assert.equal(byName['北师大版'].textbookCount, 2);
    assert.equal(byName['北师大版（2012）'].textbookCount, 1);
  } finally {
    store.close();
  }
});

test('从目录树提取真实入口章节，不推测', () => {
  const tree = parseBootstrapChapterFromHtml(TREE_HTML);
  assert.equal(tree.textbookTreeId, '260617');
  assert.equal(tree.bootstrapChapterExternalId, '261285');
  assert.notEqual(tree.bootstrapChapterExternalId, '260617');
});

test('textbook-id 自动解析 bootstrap chapter，且不会回退到 261314', () => {
  const { dbPath } = tempDb();
  const store = new MetadataStore(dbPath);
  try {
    store.saveVersionGroup(sampleVersion(), [
      sampleTextbook({
        externalTextbookId: '195861',
        textbookName: '七年级上册',
        bootstrapChapterExternalId: '195870',
        sourceUrl: 'https://zujuan.xkw.com/czsx/zj195861/',
      }),
    ], '2026-01-01T00:00:00.000Z');
  } finally {
    store.close();
  }

  const options = parseSyncArgs(['--textbook-id', '195861', '--db', dbPath]);
  assert.equal(options.textbookIdProvided, true);
  assert.deepEqual(options.chapterIds, []);
  assert.ok(!options.chapterIds.includes(DEFAULT_CHAPTER_ID));
  assert.ok(!options.chapterIds.includes('261314'));

  const resolved = resolveSyncScope(options, { dbPath });
  assert.equal(resolved.chapterIds.length, 1);
  assert.equal(resolved.chapterIds[0], '195870');
  assert.notEqual(resolved.chapterIds[0], '261314');
  assert.equal(
    buildListUrl(resolved, resolved.chapterIds[0], 1),
    'https://zujuan.xkw.com/czsx/zj195870/o2/',
  );
  assert.doesNotMatch(buildListUrl(resolved, resolved.chapterIds[0], 1), /zj261314/);
  assert.equal(lookupBootstrapChapter(dbPath, '195861'), '195870');
});

test('显式 chapter-id 保持现有行为，未传参数时仍默认 261314', () => {
  const defaults = parseSyncArgs([]);
  assert.deepEqual(defaults.chapterIds, ['261314']);
  assert.equal(defaults.textbookId, '260617');
  assert.equal(defaults.textbookIdProvided, false);

  const explicit = parseSyncArgs(['--chapter-id', '261296', '--textbook-id', '195861']);
  assert.deepEqual(explicit.chapterIds, ['261296']);
  const resolved = resolveSyncScope(explicit, { dbPath: '/tmp/not-used.sqlite3' });
  assert.deepEqual(resolved.chapterIds, ['261296']);
  assert.equal(buildListUrl(resolved, resolved.chapterIds[0], 1), 'https://zujuan.xkw.com/czsx/zj261296/o2/');
});

test('教材没有入口章节时用教材页 ID 作为同步入口，不回退 261314', () => {
  const { dbPath } = tempDb();
  const store = new MetadataStore(dbPath);
  try {
    store.saveVersionGroup(sampleVersion(), [
      sampleTextbook({
        externalTextbookId: '195861',
        textbookName: '七年级上册',
        bootstrapChapterExternalId: null,
        sourceUrl: 'https://zujuan.xkw.com/czsx/zj195861/',
      }),
    ], '2026-01-01T00:00:00.000Z');
  } finally {
    store.close();
  }
  const options = parseSyncArgs(['--textbook-id', '195861', '--db', dbPath]);
  const resolved = resolveSyncScope(options, { dbPath });
  assert.deepEqual(resolved.chapterIds, ['195861']);
  assert.notEqual(resolved.chapterIds[0], '261314');
  assert.equal(
    buildListUrl(resolved, resolved.chapterIds[0], 1),
    'https://zujuan.xkw.com/czsx/zj195861/o2/',
  );
});

test('再次发现教材时保留已有入口章节，不用空值覆盖', () => {
  const { dbPath } = tempDb();
  const store = new MetadataStore(dbPath);
  try {
    store.saveVersionGroup(sampleVersion(), [
      sampleTextbook({
        externalTextbookId: '195861',
        textbookName: '七年级上册',
        bootstrapChapterExternalId: '195870',
      }),
    ], '2026-01-01T00:00:00.000Z');
    store.saveVersionGroup(sampleVersion(), [
      sampleTextbook({
        externalTextbookId: '195861',
        textbookName: '七年级上册',
        bootstrapChapterExternalId: null,
      }),
    ], '2026-01-02T00:00:00.000Z');
    assert.equal(store.getTextbook('195861').bootstrap_chapter_external_id, '195870');
  } finally {
    store.close();
  }
});

test('非默认 textbook-id 缺少元数据时使用教材来源 ID，不回退默认教材', () => {
  const { dbPath } = tempDb();
  const store = new MetadataStore(dbPath);
  store.close();
  const options = parseSyncArgs(['--textbook-id', '195861', '--db', dbPath]);
  const resolved = resolveSyncScope(options, { dbPath });
  assert.deepEqual(resolved.chapterIds, ['195861']);
  assert.notEqual(resolved.chapterIds[0], DEFAULT_CHAPTER_ID);
  assert.equal(
    buildListUrl(resolved, resolved.chapterIds[0], 1),
    'https://zujuan.xkw.com/czsx/zj195861/o2/',
  );
});

test('版本名称精确匹配，北师大版不合并北师大版（2012）', () => {
  const versions = [
    { versionName: '北师大版', externalVersionId: '195847' },
    { versionName: '北师大版（2012）', externalVersionId: '55474' },
  ];
  const picked = pickExactByName(versions, '北师大版', { nameKey: 'versionName', label: '版本' });
  assert.equal(picked.externalVersionId, '195847');
  assert.throws(
    () => pickExactByName(versions, '北大师版', { nameKey: 'versionName', label: '版本' }),
    /未找到版本/,
  );
});

test('lookupTextbookByNames 用版本名和教材名解析入口章节', () => {
  const { dbPath } = tempDb();
  const store = new MetadataStore(dbPath);
  try {
    store.saveVersionGroup(sampleVersion(), [sampleTextbook({
      externalTextbookId: '260617',
      textbookName: '九年级上册',
      bootstrapChapterExternalId: '261285',
    })], '2026-01-01T00:00:00.000Z');
    store.saveVersionGroup(sampleVersion({
      externalVersionId: '55474',
      versionName: '北师大版（2012）',
      isNew: 'N',
    }), [sampleTextbook({
      externalTextbookId: '55480',
      versionExternalId: '55474',
      textbookName: '九年级上册',
      bootstrapChapterExternalId: '55490',
      sourceUrl: 'https://zujuan.xkw.com/czsx/zj55480/',
    })], '2026-01-01T00:00:00.000Z');
  } finally {
    store.close();
  }
  const hit = lookupTextbookByNames(dbPath, '北师大版', '九年级上册');
  assert.equal(hit.externalTextbookId, '260617');
  assert.equal(hit.bootstrapChapterExternalId, '261285');
  const other = lookupTextbookByNames(dbPath, '北师大版（2012）', '九年级上册');
  assert.equal(other.externalTextbookId, '55480');
  assert.equal(lookupTextbookByNames(dbPath, '人教版', '九年级上册'), null);
});
