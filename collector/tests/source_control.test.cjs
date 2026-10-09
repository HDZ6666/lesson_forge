'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SourceControl, SourcePausedError } = require('../src/policies/source_control.cjs');
const { postQuestionList, navigateToTextbook, fetchCatalogTree } = require('../src/sources/zujuan/list_window.cjs');
const { safeGoto, inspectRobots, waitForVerification } = require('../src/sources/zujuan/session.cjs');
const { downloadAsset, prefetchAssets } = require('../src/assets/download.cjs');
const { createCollectorServer, CollectorJobManager } = require('../server.cjs');
const { fetchTextbooksForVersion } = require('../src/jobs/metadata_run.cjs');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-source-control-'));
  const dbPath = path.join(directory, 'source.sqlite3');
  let now = Date.UTC(2026, 9, 3);
  const control = new SourceControl(dbPath, { clock: () => now });
  return { directory, dbPath, control, advance: (ms) => { now += ms; } };
}

test('来源冷却跨实例重启保留，Retry-After 只能延长；人工恢复不能缩短冷却', () => {
  const f = fixture();
  try {
    assert.throws(() => f.control.observe(429, { 'Retry-After': '600' }), SourcePausedError);
    const first = f.control.status();
    assert.throws(() => f.control.observe(429, { 'retry-after': '0' }), SourcePausedError);
    const restarted = new SourceControl(f.dbPath, { clock: () => Date.UTC(2026, 9, 3) });
    assert.equal(restarted.status().notBefore, first.notBefore);
    assert.equal(restarted.resume(restarted.status().revision).paused, true);
    f.advance(600001);
    assert.equal(f.control.status().paused, false);
    f.control.assertAllowed();
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('验证暂停必须显式恢复，迟到恢复不能覆盖新事件；CDN 单素材 403 不扩大为来源问题', () => {
  const f = fixture();
  try {
    f.control.observe(403, {}, { verification: false });
    assert.equal(f.control.status().paused, false);
    assert.throws(() => f.control.observe(403), /HTTP 403/);
    const first = f.control.status();
    f.advance(24 * 3600000);
    assert.equal(f.control.status().manualRequired, true);
    assert.throws(() => f.control.observe(429, { 'retry-after': '120' }), SourcePausedError);
    assert.throws(() => f.control.resume(first.revision), (error) => error.code === 'source_control_conflict');
    assert.equal(f.control.resume(f.control.status().revision).manualRequired, false);
    assert.equal(f.control.status().paused, true);
    f.advance(120001);
    assert.equal(f.control.status().paused, false);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('Retry-After 支持 HTTP 日期，坏值至少冷却一分钟', () => {
  const f = fixture();
  try {
    assert.throws(() => f.control.observe(429, { 'Retry-After': 'Sat, 03 Oct 2026 00:15:00 GMT' }), SourcePausedError);
    assert.equal(f.control.status().notBefore, '2026-10-03T00:15:00.000Z');
    f.advance(900001);
    assert.throws(() => f.control.observe(429, { 'Retry-After': 'invalid' }), SourcePausedError);
    f.advance(59999);
    assert.equal(f.control.status().paused, true);
    f.advance(2);
    assert.equal(f.control.status().paused, false);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('列表首次 429 即暂停，换教材/元数据/目录/素材入口均不会再发请求', async () => {
  const f = fixture();
  let calls = 0;
  const page = { evaluate: async () => { calls += 1; return { status: 429, headers: { 'retry-after': '120' }, text: '' }; } };
  const opts = { sourceControl: f.control, baseUrl: 'https://zujuan.xkw.com', bankPath: 'czsx', textbookId: '1', timeout: 1000 };
  try {
    await assert.rejects(postQuestionList(page, opts, { externalId: 'c1' }, 1), SourcePausedError);
    const context = { request: { get: async () => { calls += 1; throw new Error('must not request'); } } };
    page.goto = context.request.get;
    await assert.rejects(navigateToTextbook(page, 'https://zujuan.xkw.com/czsx/zj1/', opts), SourcePausedError);
    await assert.rejects(fetchCatalogTree(page, opts), SourcePausedError);
    await assert.rejects(safeGoto(page, 'https://zujuan.xkw.com/czsx/', { wait: async () => {} }, opts, 'metadata'), SourcePausedError);
    await assert.rejects(inspectRobots(context, opts), SourcePausedError);
    await assert.rejects(downloadAsset(context, opts, { sourceUrl: 'https://staticzujuan.xkw.com/test.png' }), SourcePausedError);
    assert.equal(calls, 1);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('验证/防护列表停止并保留公共状态；素材并发池等待已发请求收尾后传播暂停', async () => {
  const f = fixture();
  try {
    await assert.rejects(postQuestionList({ evaluate: async () => ({ status: 200, text: '<html>captcha</html>' }) },
      { sourceControl: f.control }, { externalId: 'c1' }, 1), SourcePausedError);
    assert.equal(f.control.status().manualRequired, true);
    let settled = false;
    const pause = new SourcePausedError(f.control.status());
    await assert.rejects(prefetchAssets([{ sourceUrl: 'a' }, { sourceUrl: 'b' }, { sourceUrl: 'c' }], {
      concurrency: 2, cache: new Map(), download: async (asset) => {
        if (asset.sourceUrl === 'a') throw pause;
        await new Promise((resolve) => setImmediate(resolve));
        settled = true;
        return asset;
      },
    }), SourcePausedError);
    assert.equal(settled, true);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('受保护来源 API 显示公共暂停，新作业拒绝；恢复需 token 和当前 revision', async () => {
  const f = fixture();
  const manager = new CollectorJobManager({ dbPath: f.dbPath, spawnImpl: () => { throw new Error('must not spawn'); } });
  const server = createCollectorServer({ manager, token: 'source-fixture' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.throws(() => manager.sourceControl.requireManual(), SourcePausedError);
    const current = manager.sourceControl.status();
    assert.throws(() => manager.start({ runType: 'metadata', acknowledgeSourcePolicy: true }), SourcePausedError);
    assert.equal((await fetch(`${base}/v1/source-control`)).status, 401);
    const headers = { Authorization: 'Bearer source-fixture', 'Content-Type': 'application/json' };
    const health = await (await fetch(`${base}/v1/health`, { headers })).json();
    assert.equal(health.ok, true);
    assert.equal(health.sourceControl.manualRequired, true);
    const stale = await fetch(`${base}/v1/source-control/resume`, { method: 'POST', headers,
      body: JSON.stringify({ expectedRevision: current.revision - 1 }) });
    assert.equal(stale.status, 409);
    const resumed = await (await fetch(`${base}/v1/source-control/resume`, { method: 'POST', headers,
      body: JSON.stringify({ expectedRevision: current.revision }) })).json();
    assert.equal(resumed.paused, false);
  } finally {
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('元数据请求和素材请求的 429 保存公共冷却，素材响应被释放且不重试', async () => {
  for (const kind of ['metadata', 'asset']) {
    const f = fixture();
    let calls = 0;
    let disposed = 0;
    const opts = { sourceControl: f.control, baseUrl: 'https://zujuan.xkw.com', bankPath: 'czsx', qbmid: '2', timeout: 1000 };
    try {
      if (kind === 'metadata') {
        await assert.rejects(fetchTextbooksForVersion({ evaluate: async () => {
          calls += 1; return { status: 429, headers: { 'retry-after': '180' }, text: '', error: null };
        } }, { externalVersionId: '1' }, opts), SourcePausedError);
      } else {
        const context = { request: { get: async () => {
          calls += 1;
          return { status: () => 429, headers: () => ({ 'retry-after': '180' }), dispose: async () => { disposed += 1; } };
        } } };
        await assert.rejects(downloadAsset(context, opts, { sourceUrl: 'https://staticzujuan.xkw.com/test.png' }), SourcePausedError);
        assert.equal(disposed, 1);
      }
      assert.equal(calls, 1);
      assert.equal(f.control.status().notBefore, '2026-10-03T00:03:00.000Z');
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
  }
});

test('暂停期间重放同一已创建的派发 UUID 仍返回原作业，不能重复启动', async () => {
  const f = fixture();
  let spawned = 0;
  const manager = new CollectorJobManager({ dbPath: f.dbPath, spawnImpl: () => {
    spawned += 1; throw new Error('fixture: process start unavailable');
  } });
  try {
    const payload = { runType: 'metadata', acknowledgeSourcePolicy: true, jobId: '53354a2e-1f63-4d0a-9dac-ae01e91d92af' };
    const started = manager.start(payload);
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => manager.sourceControl.requireManual(), SourcePausedError);
    assert.equal(manager.start(payload).id, started.id);
    assert.equal(spawned, 1);
    assert.throws(() => manager.start({ ...payload, jobId: '03b2aabc-a4a6-4d3e-b2e5-de38873445c7' }), SourcePausedError);
  } finally { await manager.shutdown(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('正常来源内容中的验证码字样不会误触发公共暂停', async () => {
  const f = fixture();
  try {
    const state = await waitForVerification({ evaluate: async () => ({
      challenge: false, hasContent: true, title: '数学题', text: '计算验证码的排列方式',
    }) }, { sourceControl: f.control, verificationTimeout: 0, verificationInitialWait: 0 });
    assert.equal(state.hasContent, true);
    assert.equal(f.control.status().paused, false);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
