'use strict';

// COL-016: browser recycling at window safe points and the two-tier memory
// watermark.  A long run must shed Chrome memory and continue from the same
// checkpoint instead of sealing on the first low-memory sample.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runSync } = require('../zujuan_question_sync.cjs');
const { ResourceGuard, ResourcePressureError } = require('../src/policies/resource_guard.cjs');
const { descendantsMemoryMb } = require('../src/api/process_tree.cjs');
const { QuestionSyncStore } = require('../src/storage/question_store/index.cjs');

const MIB = 1024 * 1024;
const SAMPLE_TREE = {
  id: '260617',
  title: '九年级上册',
  children: [{ id: '261285', title: '第一章', children: [] }],
};
const ITEM =
  '<div class="tk-quest-item quesroot new" questionid="QID" bankid="2">' +
  '<div class="ques-additional"><div class="info-cnt">解答题-问答题</div><div class="info-cnt">适中 (0.55)</div></div>' +
  '<div class="exam-item__cnt">1 . 计算 QID</div>' +
  '<div class="ctrl-box"><a class="addques" quesid="QID" qyid="1103" qyname="解答题" qdid="3" qdname="适中" qdvalue="0.55">加入</a></div></div>';

function tempDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-recycle-'));
  return { directory, dbPath: path.join(directory, 'collector.sqlite3') };
}

function listText(total, ids) {
  return JSON.stringify({
    code: '0',
    data: { total, html: ids.map((id) => ITEM.replaceAll('QID', String(id))).join('') },
  });
}

const TOTAL = 60;
function pageIds(pageNumber) {
  if (pageNumber > TOTAL / 10) return [];
  return Array.from({ length: 10 }, (_, index) => 97000000 + pageNumber * 100 + index);
}

function mockPage(label, log) {
  return {
    label,
    goto: async () => {
      log.push(`goto:${label}`);
      return { status: 200 };
    },
    url: () => 'https://zujuan.xkw.com/czsx/zj261285/',
    isClosed: () => false,
    evaluate: async (_fn, args) => {
      if (!args || typeof args !== 'object' || !args.body) return { challenge: false, text: '', title: '' };
      const params = new URLSearchParams(args.body);
      const curPage = Number(params.get('curPage'));
      if (String(params.get('categoryId')) !== '261285') {
        return { status: 200, headers: {}, text: listText(TOTAL, [96999999]) };
      }
      log.push(`fetch:${label}:${curPage}`);
      return { status: 200, headers: {}, text: listText(TOTAL, pageIds(curPage)) };
    },
    close: async () => {},
  };
}

function options(directory, dbPath, extra = {}) {
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
    concurrency: 2,
    fallbackProfileDirs: [],
    dbPath,
    dataDir: directory,
    profileDir: directory,
    sleepFn: async () => {},
    randomFn: () => 0,
    browserRecycleMb: 0,
    ...extra,
  };
}

test('内存短暂低于硬水位不立即暂停，持续超过宽限期才拒绝工作', () => {
  let now = 0;
  let memory = 900;
  const guard = new ResourceGuard({
    minMemoryMiB: 500,
    softMemoryMiB: 800,
    memoryGraceMs: 60000,
    clock: () => now,
    memoryReader: () => memory * MIB,
  });
  assert.equal(guard.status().pressure, 'ok');
  memory = 700;
  now += 1001;
  assert.equal(guard.status().pressure, 'soft');
  guard.assertAllowed();
  memory = 400;
  now += 1001;
  assert.equal(guard.status().pressure, 'low');
  guard.assertAllowed();
  now += 30000;
  guard.assertAllowed();
  memory = 600;
  now += 1001;
  assert.equal(guard.status().pressure, 'soft');
  memory = 400;
  now += 1001;
  guard.assertAllowed();
  now += 59000;
  guard.assertAllowed();
  now += 1001;
  assert.throws(() => guard.assertAllowed(), ResourcePressureError);
  assert.equal(guard.status().pressure, 'paused');
});

test('未配置宽限期时保持原来的立即暂停语义', () => {
  let now = 0;
  const guard = new ResourceGuard({ minMemoryMiB: 500, clock: () => now, memoryReader: () => 100 * MIB });
  assert.throws(() => guard.assertAllowed(), /内存/);
  assert.equal(guard.status({ fresh: true }).pressure, 'paused');
});

test('浏览器内存按子进程树汇总，不含采集进程本身', () => {
  const rows = [{ pid: 11 }, { pid: 12 }, { pid: 13 }];
  const sizes = { 11: 300 * MIB, 12: 200 * MIB, 13: 24 * MIB };
  assert.equal(descendantsMemoryMb(10, { list: () => rows, read: (pid) => sizes[pid] }), 524);
  assert.equal(descendantsMemoryMb(10, { list: () => [], read: () => 0 }), 0);
});

test('达到页数阈值时在窗口间回收浏览器，并从同一断点继续采完', async () => {
  const { directory, dbPath } = tempDb();
  const log = [];
  let generation = 0;
  let reopenCalls = 0;
  try {
    const result = await runSync(options(directory, dbPath, { browserRecyclePages: 2 }), {
      context: {},
      page: mockPage('p0', log),
      catalogTree: SAMPLE_TREE,
      reopenBrowser: async () => {
        reopenCalls += 1;
        generation += 1;
        return { context: {}, page: mockPage(`p${generation}`, log) };
      },
      browserMemoryMb: () => 0,
    });
    assert.equal(result.status, 'success');
    assert.ok(reopenCalls >= 2, `expected recycles, got ${reopenCalls}`);
    const fetched = log.filter((line) => line.startsWith('fetch:')).map((line) => Number(line.split(':')[2]));
    // Every real page is requested exactly once across browser generations.
    for (let pageNumber = 1; pageNumber <= TOTAL / 10; pageNumber += 1) {
      assert.equal(fetched.filter((value) => value === pageNumber).length, 1, `page ${pageNumber}`);
    }
    // Each reopened page navigates to the textbook before fetching.
    for (let index = 1; index <= generation; index += 1) {
      const gotoAt = log.indexOf(`goto:p${index}`);
      const firstFetch = log.findIndex((line) => line.startsWith(`fetch:p${index}:`));
      assert.ok(gotoAt >= 0 && (firstFetch === -1 || gotoAt < firstFetch));
    }
    const store = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const count = store.db
        .prepare('SELECT COUNT(*) AS n FROM sync_run_question_items WHERE run_id = ?')
        .get(result.runId).n;
      assert.equal(count, TOTAL);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Chrome 内存超过阈值时回收；阈值为 0 且未注入时不回收', async () => {
  const { directory, dbPath } = tempDb();
  const log = [];
  let reopenCalls = 0;
  let browser = 1500;
  try {
    const result = await runSync(options(directory, dbPath, { browserRecyclePages: 0, browserRecycleMb: 1000 }), {
      context: {},
      page: mockPage('p0', log),
      catalogTree: SAMPLE_TREE,
      reopenBrowser: async () => {
        reopenCalls += 1;
        browser = 300;
        return { context: {}, page: mockPage('p1', log) };
      },
      browserMemoryMb: () => browser,
    });
    assert.equal(result.status, 'success');
    assert.equal(reopenCalls, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const second = tempDb();
  try {
    const result = await runSync(options(second.directory, second.dbPath, { browserRecyclePages: 1 }), {
      context: {},
      page: mockPage('p0', []),
      catalogTree: SAMPLE_TREE,
      browserMemoryMb: () => 0,
    });
    // Injected contexts without a reopen hook are never recycled.
    assert.equal(result.status, 'success');
  } finally {
    fs.rmSync(second.directory, { recursive: true, force: true });
  }
});

test('主机内存进入预警水位时回收浏览器，而不是封存整轮', async () => {
  const { directory, dbPath } = tempDb();
  let memory = 700;
  let clock = Date.now();
  let reopenCalls = 0;
  try {
    const result = await runSync(options(directory, dbPath, { browserRecyclePages: 0, browserPressureMinPages: 2 }), {
      context: {},
      page: mockPage('p0', []),
      catalogTree: SAMPLE_TREE,
      browserMemoryMb: () => 0,
      resourceGuardOptions: {
        minMemoryMiB: 500,
        softMemoryMiB: 800,
        memoryGraceMs: 60000,
        memoryReader: () => memory * MIB,
        clock: () => (clock += 1001),
      },
      reopenBrowser: async () => {
        reopenCalls += 1;
        memory = 1500;
        return { context: {}, page: mockPage('p1', []) };
      },
    });
    assert.equal(result.status, 'success');
    // Pressure recycles once after the minimum page spacing; memory then recovers.
    assert.equal(reopenCalls, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('回收后无法重新打开页面时整轮按可续采中断，而不是跳过知识点', async () => {
  const { directory, dbPath } = tempDb();
  try {
    await assert.rejects(
      runSync(options(directory, dbPath, { browserRecyclePages: 2 }), {
        context: {},
        page: mockPage('p0', []),
        catalogTree: SAMPLE_TREE,
        browserMemoryMb: () => 0,
        reopenBrowser: async () => {
          throw new Error('chrome exited');
        },
      }),
      (error) => error.code === 'browser_recycle_failed',
    );
    const store = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const run = store.db.prepare('SELECT status FROM sync_runs ORDER BY id DESC LIMIT 1').get();
      assert.equal(run.status, 'interrupted');
      const stalled = store.db
        .prepare("SELECT COUNT(*) AS n FROM sync_run_catalog_progress WHERE stall_reason = 'browser_recycle_failed'")
        .get();
      assert.equal(stalled.n, 0);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Chrome 启动参数：采集与人工验证共用一套，人工验证不最小化', () => {
  const { collectorLaunchOptions } = require('../src/sources/zujuan/session.cjs');
  const crawl = collectorLaunchOptions({ headless: false });
  const manual = collectorLaunchOptions({ headless: false, minimize: false, viewport: { width: 1440, height: 900 } });
  assert.ok(crawl.args.includes('--start-minimized'));
  assert.ok(!manual.args.includes('--start-minimized'));
  assert.deepEqual(
    manual.args,
    crawl.args.filter((arg) => arg !== '--start-minimized'),
  );
  assert.deepEqual(manual.ignoreDefaultArgs, ['--enable-automation']);
  assert.equal(manual.channel, crawl.channel);
  assert.deepEqual(manual.viewport, { width: 1440, height: 900 });
  const headless = collectorLaunchOptions({ headless: true });
  assert.equal(headless.args, undefined);
  assert.equal(headless.headless, true);
});
