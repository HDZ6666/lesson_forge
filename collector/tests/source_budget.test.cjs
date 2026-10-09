'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { SourceBudget, SourceBudgetError } = require('../src/policies/source_budget.cjs');
const { SourceControl } = require('../src/policies/source_control.cjs');
const { ResourceGuard, ResourcePressureError } = require('../src/policies/resource_guard.cjs');
const { collectorReadiness } = require('../src/policies/collector_readiness.cjs');
const { postQuestionList, fetchCatalogTree, navigateToTextbook } = require('../src/sources/zujuan/list_window.cjs');
const { fetchTextbooksForVersion } = require('../src/jobs/metadata_run.cjs');
const { downloadAsset } = require('../src/assets/download.cjs');
const { createCollectorServer, CollectorJobManager } = require('../server.cjs');

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-budget-'));
  const dbPath = path.join(directory, 'collector.sqlite3');
  let now = Date.UTC(2026, 9, 3, 23, 59, 59);
  const budget = new SourceBudget(dbPath, { clock: () => now, ...options });
  return { directory, dbPath, budget, advance: (ms) => { now += ms; } };
}

test('当日主动请求配额跨教材和重启共享，到下一 UTC 日恢复而不改旧记录', () => {
  const f = fixture({ requestLimit: 2, bookLimit: 3 });
  try {
    assert.equal(f.budget.request(), 1);
    const next = new SourceBudget(f.dbPath, { clock: f.budget.clock, requestLimit: 2, bookLimit: 3 });
    assert.equal(next.request(), 2);
    assert.throws(() => f.budget.request(), SourceBudgetError);
    assert.equal(next.status().notBefore, '2026-10-04T00:00:00.000Z');
    assert.equal(next.status().usage.requests, 2);
    f.advance(1001);
    assert.equal(next.status().paused, false);
    assert.equal(next.request(), 1);
    assert.equal(next.withDb((db) => db.prepare('SELECT SUM(requests) AS n FROM collector_source_usage').get().n), 3);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('开始身份幂等；最大启动本数不结束当前教材或禁止发现，来源请求仍共享', () => {
  const f = fixture({ requestLimit: 4, bookLimit: 1 });
  try {
    assert.equal(f.budget.startRun('content:1', 'content'), true);
    assert.equal(f.budget.startRun('content:1', 'content'), false);
    assert.throws(() => f.budget.startRun('content:2', 'content'), SourceBudgetError);
    assert.equal(f.budget.startRun('metadata:1', 'metadata'), true);
    f.budget.request();
    assert.equal(f.budget.status('metadata').paused, false);
    assert.equal(f.budget.status().usage.bookStarts, 1);
    f.advance(1001);
    assert.equal(f.budget.startRun('content:1', 'content'), false);
    assert.equal(f.budget.startRun('content:2', 'content'), true);
    assert.equal(f.budget.status().usage.bookStarts, 1);
    assert.throws(() => f.budget.startRun('metadata:2', 'content'), /运行身份/);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('两个真实子进程竞争请求配额，SQLite 原子领取最多允许配置次数', async () => {
  const f = fixture({ requestLimit: 37 });
  const modulePath = require.resolve('../src/policies/source_budget.cjs');
  const script = `const {SourceBudget}=require(process.argv[1]);
    const b=new SourceBudget(process.argv[2],{requestLimit:37,clock:()=>Date.UTC(2026,9,3,23,59,59)});
    let accepted=0; for(let i=0;i<50;i++){try{b.request();accepted++;}catch(e){if(e.code!=='source_budget')throw e;}}
    process.stdout.write(String(accepted));`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, modulePath, f.dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Number(output)) : reject(new Error(`budget subprocess ${code}`)));
  });
  try {
    const accepted = await Promise.all([run(), run()]);
    assert.equal(accepted[0] + accepted[1], 37);
    assert.equal(f.budget.status().usage.requests, 37);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('探针/重试占用主动请求，额度耗尽后目录/教材/素材不再发新请求', async () => {
  const f = fixture({ requestLimit: 2 });
  let calls = 0;
  const page = { evaluate: async () => { calls += 1; return { status: 500, text: 'busy' }; } };
  const opts = { sourceBudget: f.budget, baseUrl: 'https://zujuan.xkw.com', bankPath: 'czsx', textbookId: '1', sleepFn: async () => {} };
  try {
    await assert.rejects(postQuestionList(page, opts, { externalId: '1' }, 1), SourceBudgetError);
    assert.equal(calls, 2);
    await assert.rejects(fetchCatalogTree(page, opts), SourceBudgetError);
    await assert.rejects(fetchTextbooksForVersion(page, { externalVersionId: '1' }, opts), SourceBudgetError);
    page.goto = async () => { calls += 1; throw new Error('must not request'); };
    await assert.rejects(navigateToTextbook(page, 'https://zujuan.xkw.com/czsx/zj1/', opts), SourceBudgetError);
    await assert.rejects(downloadAsset({ request: { get: page.goto } }, opts,
      { sourceUrl: 'https://staticzujuan.xkw.com/a.png' }), SourceBudgetError);
    assert.equal(calls, 2);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('人工解除验证不能清零预算；提高部署上限也保留已用记录', () => {
  const f = fixture({ requestLimit: 1 });
  try {
    f.budget.request();
    const control = new SourceControl(f.dbPath);
    assert.throws(() => control.requireManual(), /来源/);
    control.resume(control.status().revision);
    assert.throws(() => f.budget.request(), SourceBudgetError);
    const changed = new SourceBudget(f.dbPath, { clock: f.budget.clock, requestLimit: 2 });
    assert.equal(changed.request(), 2);
    assert.throws(() => changed.request(), SourceBudgetError);
    for (const value of [-1, 1.5, 'NaN', true]) assert.throws(() => new SourceBudget(f.dbPath, { requestLimit: value }), /非负整数/);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('资源检查区分存储卷，不公开路径；采集途中压力恢复后可继续', () => {
  let now = 0;
  let memory = 200;
  let data = 300;
  const guard = new ResourceGuard({ paths: { data: '/private/data', profile: '/private/profile' },
    minDiskMiB: 100, minMemoryMiB: 100, clock: () => now,
    diskReader: (p) => (p.endsWith('data') ? data : 400) * 1024 * 1024,
    memoryReader: () => memory * 1024 * 1024 });
  guard.assertAllowed();
  data = 50; now += 1001;
  assert.throws(() => guard.assertAllowed(), ResourcePressureError);
  assert.equal(JSON.stringify(guard.status()).includes('/private'), false);
  data = 300; memory = 99; now += 1001;
  assert.throws(() => guard.assertAllowed(), /内存/);
  memory = 200; now += 1001;
  guard.assertAllowed();
  const unknown = new ResourceGuard({ paths: { data: '/missing' }, minDiskMiB: 1,
    diskReader: () => { throw new Error('unavailable'); } });
  assert.throws(() => unknown.assertAllowed(), /无法确认/);
});

test('健康组合状态取所有限制的最晚时间，解除来源不绕过预算或主机压力', () => {
  const f = fixture({ requestLimit: 1 });
  try {
    f.budget.request();
    const control = new SourceControl(f.dbPath, { clock: f.budget.clock });
    assert.throws(() => control.observe(429, { 'retry-after': '600' }), /冷却/);
    const resources = new ResourceGuard({ minMemoryMiB: 100, memoryReader: () => 0, clock: f.budget.clock });
    const state = collectorReadiness({ sourceControl: control, sourceBudget: f.budget, resourceGuard: resources });
    assert.equal(state.sourceControl.paused, true);
    assert.equal(state.sourceControl.notBefore, '2026-10-04T00:09:59.000Z');
    assert.match(state.sourceControl.reason, /预算/);
    assert.match(state.sourceControl.reason, /内存/);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('API 显示只读预算；调用方不能用任务载荷提高额度或借恢复入口清零', async () => {
  const f = fixture({ requestLimit: 1 });
  const manager = new CollectorJobManager({ dbPath: f.dbPath,
    sourceBudgetOptions: { requestLimit: 1 }, spawnImpl: () => { throw new Error('must not start'); } });
  manager.sourceBudget.request();
  const server = createCollectorServer({ manager, token: 'budget-fixture' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/v1/source-budget`)).status, 401);
    const headers = { Authorization: 'Bearer budget-fixture', 'Content-Type': 'application/json' };
    const health = await (await fetch(`${base}/v1/health`, { headers })).json();
    assert.equal(health.ok, true);
    assert.equal(health.sourceControl.paused, true);
    assert.equal(health.sourceBudget.usage.requests, 1);
    const response = await fetch(`${base}/v1/jobs`, { method: 'POST', headers,
      body: JSON.stringify({ runType: 'metadata', acknowledgeSourcePolicy: true, requestLimit: 0 }) });
    assert.equal(response.status, 423);
    assert.equal((await response.json()).error.code, 'source_budget');
    const budget = await (await fetch(`${base}/v1/source-budget`, { headers })).json();
    assert.equal(budget.usage.requests, 1);
  } finally {
    await manager.shutdown(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('采集时长共享、UTC 跨日计数与重启不退款', () => {
  const f = fixture({ activeSeconds: 2 });
  try {
    f.budget.startTiming();
    assert.equal(f.budget.status().usage.activeMilliseconds, 1000);
    f.advance(1000);
    f.budget.assertRunning();
    assert.equal(f.budget.status().day, '2026-10-04');
    assert.equal(f.budget.status().usage.activeMilliseconds, 1000);
    f.advance(1000); f.budget.assertRunning();
    assert.equal(f.budget.status().usage.activeMilliseconds, 2000);
    f.advance(1000);
    assert.throws(()=>f.budget.request(), SourceBudgetError);
    const restarted=new SourceBudget(f.dbPath,{clock:f.budget.clock,activeSeconds:2});
    assert.throws(()=>restarted.assertCanStart(), SourceBudgetError);
  } finally { f.budget.stopTiming(); fs.rmSync(f.directory,{recursive:true,force:true}); }
});

test('下载失败越过额度的响应块也保存字节用量，后续请求禁止', () => {
  const f=fixture({downloadMiB:1});
  try {
    f.budget.downloadReceived(1048570);
    assert.throws(()=>f.budget.downloadReceived(100),SourceBudgetError);
    assert.equal(f.budget.status().usage.downloadBytes,1048670);
    assert.throws(()=>f.budget.request(),SourceBudgetError);
  } finally {fs.rmSync(f.directory,{recursive:true,force:true});}
});

test('真实流式素材复用会话且拒绝越界重定向，超额停止读取', async () => {
  const {openAssetResponse}=require('../src/assets/request.cjs');
  let received=0,requests=0,cookieUrl;
  const context={cookies:async url=>{cookieUrl=url;return [{name:'session',value:'fixture'}]},pages:()=>[]};
  const response=await openAssetResponse(context,'https://img.xkw.com/a.png',{
    assetFetch:async(url,opts)=>{requests++;assert.equal(opts.headers.cookie,'session=fixture');return new Response(new ReadableStream({pull(controller){received++;controller.enqueue(new Uint8Array(65536));}}),{headers:{'content-type':'image/png'}})},
    sourceBudget:{request(){},downloadReceived(){if(received>=2)throw new SourceBudgetError({reason:'素材预算耗尽'})}},
  });
  await assert.rejects(response.body(),SourceBudgetError);
  await response.dispose();
  assert.ok(received<=4);assert.equal(requests,1);assert.equal(cookieUrl,'https://img.xkw.com/a.png');
  await assert.rejects(openAssetResponse(context,'https://img.xkw.com/a.png',{
    assetFetch:async()=>new Response('',{status:302,headers:{location:'https://evil.example/a'}}),
  }),/域名|host|允许/);
});
