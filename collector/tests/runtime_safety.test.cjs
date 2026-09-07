'use strict';

/**
 * Production incident 2026-09-07 (COL-015): undisposed Playwright API
 * responses leaked ~2GB in a long crawl and swapped the host; SIGTERM killed
 * the crawler without closing Chrome.  These tests pin the fixes:
 * every response body is disposed, a stop signal ends the run at a safe
 * point as a resumable interrupt with Chrome closed, and the manager can
 * stop a child whose reported RSS exceeds the configured limit.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { downloadAsset } = require('../src/assets/download.cjs');
const { runSync } = require('../src/jobs/question_run.cjs');
const { QuestionSyncStore } = require('../src/storage/question_store/index.cjs');
const { CollectorJobManager, publicJob } = require('../server.cjs');
const { MetadataStore } = require('../zujuan_metadata_sync.cjs');

const LIST_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'zujuan', 'list-261285-p470-q26996136.card.html'), 'utf8');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeResponse({ status = 200, headers = { 'content-type': 'image/png' }, body = Buffer.from('png') } = {}) {
  const response = {
    disposed: 0,
    status: () => status,
    headers: () => headers,
    body: async () => body,
    text: async () => body.toString('utf8'),
    dispose: async () => { response.disposed += 1; },
  };
  return response;
}

test('素材下载：成功、非 2xx、body 为空三种路径都会 dispose 响应体', async () => {
  const dataDir = tempDir('collector-dispose-');
  const responses = [];
  const context = {
    request: {
      get: async (url) => {
        const response = url.includes('fail')
          ? fakeResponse({ status: 404 })
          : (url.includes('empty') ? fakeResponse({ body: Buffer.alloc(0) }) : fakeResponse());
        responses.push(response);
        return response;
      },
    },
  };
  const options = { timeout: 1000, dataDir, sleepFn: async () => {}, randomFn: () => 0 };
  try {
    const ok = await downloadAsset(context, options, { sourceUrl: 'https://staticzujuan.xkw.com/quesimg/ok.png', type: 'question_image' });
    assert.ok(ok.contentSha256);
    await assert.rejects(
      downloadAsset(context, options, { sourceUrl: 'https://staticzujuan.xkw.com/quesimg/fail.png', type: 'question_image' }),
      /HTTP 404/,
    );
    await assert.rejects(
      downloadAsset(context, options, { sourceUrl: 'https://staticzujuan.xkw.com/quesimg/empty.png', type: 'question_image' }),
      /body 为空/,
    );
    assert.ok(responses.length >= 3);
    for (const response of responses) {
      assert.equal(response.disposed, 1, '每个响应恰好 dispose 一次');
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function listApiText(total, questionIds) {
  const html = questionIds.map((id) => LIST_HTML.replaceAll('26996136', String(id))).join('');
  return JSON.stringify({ code: '0', data: { total, html } });
}

function mockPage(handler) {
  return {
    goto: async () => ({ status: 200 }),
    url: () => 'https://zujuan.xkw.com/czsx/zj261285/',
    isClosed: () => false,
    evaluate: async (_fn, args) => {
      if (!args || typeof args !== 'object' || !args.body) return { challenge: false, text: '', title: '' };
      const params = new URLSearchParams(args.body);
      return handler({ curPage: Number(params.get('curPage')), categoryId: String(params.get('categoryId') || '') });
    },
    bringToFront: async () => {},
    close: async () => {},
    context: () => null,
  };
}

test('收到停止信号后在窗口边界安全停止：运行封存为 interrupted，浏览器会话被释放', async () => {
  const directory = tempDir('collector-stop-');
  const dbPath = path.join(directory, 'collector.sqlite3');
  let windows = 0;
  let triggerStop = null;
  const page = mockPage(({ curPage, categoryId }) => {
    if (categoryId !== '261285') return { status: 200, headers: {}, text: listApiText(400, ['35020603']) };
    if (curPage === 1) windows += 1;
    if (curPage === 9 && triggerStop) { triggerStop(); triggerStop = null; }
    return { status: 200, headers: {}, text: listApiText(400, [`9900${String(curPage).padStart(4, '0')}`]) };
  });
  let closed = 0;
  const context = { pages: () => [page], newPage: async () => page, close: async () => { closed += 1; } };
  const options = {
    baseUrl: 'https://zujuan.xkw.com', treeBaseUrl: 'https://static.zxxk.com', apiPath: '/zujuan-api/question/list',
    bankId: 2, bankPath: 'czsx', textbookId: '260617', catalogIds: [], catalogLevels: [], maxCatalogs: 0,
    startPage: 1, maxPages: 1000, maxPagesProvided: false, limit: 0, headless: false, cdpUrl: null,
    delayMin: 0, delayMax: 0, timeout: 1000, verificationTimeout: 0, verificationPoll: 1, verificationProbeInterval: 1,
    downloadAssets: false, saveRaw: false, resume: false, resumeRunId: null,
    dbPath, dataDir: directory, profileDir: path.join(directory, 'profile'), fallbackProfileDirs: [], concurrency: 8,
    sleepFn: async () => {},
  };
  let unregistered = 0;
  const registerStopSignal = (handlers) => {
    triggerStop = () => handlers.SIGTERM();
    return () => { unregistered += 1; };
  };
  const sealed = [];
  const events = { emit: (type, payload) => { if (type === 'sealed' || type === 'error') sealed.push({ type, ...payload }); } };
  try {
    await assert.rejects(
      runSync(options, {
        context, page, events, registerStopSignal,
        catalogTree: { id: '260617', title: '九年级上册', children: [{ id: '261285', title: '第一章', children: [] }] },
      }),
      (error) => error.code === 'stop_requested',
    );
    assert.equal(unregistered, 1, '信号处理器应被注销');
    const errorEvent = sealed.find((item) => item.type === 'error');
    const sealedEvent = sealed.find((item) => item.type === 'sealed');
    assert.equal(errorEvent.code, 'stop_requested');
    assert.equal(errorEvent.recoverable, true);
    assert.equal(sealedEvent.status, 'interrupted');
    const store = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const run = store.db.prepare('SELECT status, snapshot_locked_at, pages_ok FROM sync_runs ORDER BY id DESC LIMIT 1').get();
      assert.equal(run.status, 'interrupted');
      assert.ok(run.snapshot_locked_at);
      assert.ok(run.pages_ok >= 8, '停止前已结算的整窗口页面保留');
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function seedMetadata(dbPath) {
  const store = new MetadataStore(dbPath);
  const runId = store.beginRun('https://zujuan.xkw.com/');
  store.saveVersionGroup({ externalVersionId: 'v1', versionName: '测试版', sourceUrl: 'https://zujuan.xkw.com/v1', isNew: 'N', sortOrder: 1, raw: {} }, [{
    externalTextbookId: 'tb1', versionExternalId: 'v1', textbookName: '教材 tb1', grade: '九年级', volume: '上册',
    sourceUrl: 'https://zujuan.xkw.com/tb1', sortOrder: 1, bootstrapChapterExternalId: 'tb1-c1', raw: {},
  }], new Date().toISOString(), runId);
  store.finishRun(runId, 'success', { versionsSeen: 1, textbooksSeen: 1, inserted: 2, updated: 0, unchanged: 0, errors: 0 }, null, null);
  store.close();
}

test('管理器：心跳上报的 RSS 超过 COLLECTOR_CHILD_MAX_RSS_MB 时终止子进程，errorCode=memory_limit', async () => {
  const directory = tempDir('collector-memlimit-');
  const dbPath = path.join(directory, 'collector.sqlite3');
  seedMetadata(dbPath);
  let child;
  const manager = new CollectorJobManager({
    dbPath,
    childMaxRssMb: '1024',
    spawnImpl() {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 2147483647;
      child.killed = [];
      child.kill = (signal) => { child.killed.push(signal); return true; };
      return child;
    },
  });
  try {
    const started = manager.start({ runType: 'content', acknowledgeSourcePolicy: true, metadataRunId: 1, textbookExternalIds: ['tb1'], maxPages: 1 });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !child) await new Promise((resolve) => setTimeout(resolve, 5));
    child.emit('message', { type: 'heartbeat', stage: 'fetch', rssMb: 900 });
    assert.equal(manager.get(started.id).abortCode, null);
    assert.equal(publicJob(manager.get(started.id)).childRssMb, 900);
    child.emit('message', { type: 'heartbeat', stage: 'fetch', rssMb: 1500 });
    assert.equal(manager.get(started.id).abortCode, 'memory_limit');
    assert.ok(child.killed.length > 0, '子进程应被终止');
    child.stdout.end(); child.stderr.end(); child.emit('close', -15, null);
    while (Date.now() < deadline + 2000 && !['failed', 'interrupted'].includes(manager.get(started.id)?.status)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const job = publicJob(manager.get(started.id));
    assert.equal(job.errorCode, 'memory_limit');
    assert.equal(job.childRssPeakMb, 1500);
    assert.match(job.errorMessage, /内存 1500MB 超过上限 1024MB/);
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
