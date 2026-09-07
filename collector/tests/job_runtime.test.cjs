'use strict';

/**
 * Stage 3 runtime mechanisms of the collector API manager:
 * structured events instead of log regexes, durable collector_jobs rows,
 * cross-process mutex, restart recovery and stall / timeout handling.
 * No Chrome is started; children are EventEmitter fakes.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const { CollectorJobManager, createCollectorServer, publicJob } = require('../server.cjs');
const { JobStore } = require('../src/api/job_store.cjs');
const { formatEventLine } = require('../src/jobs/events.cjs');
const { MetadataStore } = require('../zujuan_metadata_sync.cjs');
const { SyncStore } = require('../legacy/zujuan_sync.cjs');
const { parseArgs, usage } = require('../zujuan_question_sync.cjs');

const ROOT = path.resolve(__dirname, '..');

function temporaryDb(prefix = 'collector-runtime-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { directory, dbPath: path.join(directory, 'collector.sqlite3') };
}

function seedMetadata(dbPath, textbookIds = ['tb1']) {
  const store = new MetadataStore(dbPath);
  const runId = store.beginRun('https://zujuan.xkw.com/');
  const observedAt = new Date().toISOString();
  store.saveVersionGroup({
    externalVersionId: 'v1',
    versionName: '测试版',
    sourceUrl: 'https://zujuan.xkw.com/v1',
    isNew: 'N',
    sortOrder: 1,
    raw: {},
  }, textbookIds.map((externalTextbookId, index) => ({
    externalTextbookId,
    versionExternalId: 'v1',
    textbookName: `教材 ${externalTextbookId}`,
    grade: '九年级',
    volume: '上册',
    sourceUrl: `https://zujuan.xkw.com/${externalTextbookId}`,
    sortOrder: index + 1,
    bootstrapChapterExternalId: `${externalTextbookId}-c1`,
    raw: {},
  })), observedAt, runId);
  store.finishRun(runId, 'success', {
    versionsSeen: 1, textbooksSeen: textbookIds.length, inserted: textbookIds.length + 1,
    updated: 0, unchanged: 0, errors: 0,
  }, null, null);
  store.close();
  return runId;
}

function seedChildRun(dbPath, textbookId, status = 'success', { finish = true } = {}) {
  const store = new SyncStore(dbPath);
  const runId = store.beginRun({ textbookId });
  const catalogId = `${textbookId}-c1`;
  const questionId = `${textbookId}-q1`;
  store.saveRunCatalogTree(runId, textbookId, [{
    externalId: catalogId, level: 1, name: `目录 ${textbookId}`, path: `/${catalogId}`,
  }]);
  store.saveRunQuestion(runId, textbookId, {
    externalId: questionId, questionType: '单选题', contentHtml: `<p>${textbookId}</p>`, plainText: textbookId,
  }, catalogId);
  store.saveRunQuestionCatalogs(runId, textbookId, questionId, [{
    externalId: catalogId, level: 1, name: `目录 ${textbookId}`, path: `/${catalogId}`,
  }]);
  if (finish) {
    store.finishRun(runId, status, {
      pagesOk: 2, questionsSeen: 1, questionsInserted: 1, errors: status === 'success' ? 0 : 1,
    }, status === 'success' ? null : `教材 ${textbookId} 采集失败`);
  }
  store.close();
  return runId;
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 2147483647;
  child.killed = [];
  child.kill = (signal) => { child.killed.push(signal); return true; };
  child.finish = (exitCode = 0) => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode, null);
  };
  return child;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor 超时');
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  await server.collectorManager.shutdown();
  await new Promise((resolve) => server.close(resolve));
}

const contentPayload = (ids = ['tb1']) => ({
  runType: 'content', acknowledgeSourcePolicy: true, metadataRunId: 1, textbookExternalIds: ids, maxPages: 1,
});

test('A3-2 管理器源码不再用日志正则推导 run、计数或版本数', () => {
  const sources = ['src/api/job_manager.cjs', 'src/api/routes.cjs', 'src/api/progress.cjs', 'server.cjs']
    .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /match\(\/\(?(metadata-run|发现|textbooksSeen|本次同步|questionsSeen|run=)/);
});

test('A3-3 run_created 事件立即回绑 collectorRunId；结构化 error 决定 blocked 与 errorCode，不被帮助提示覆盖', async () => {
  const { directory, dbPath } = temporaryDb();
  seedMetadata(dbPath);
  let child;
  let runId;
  const manager = new CollectorJobManager({
    dbPath,
    spawnImpl(_node, args) {
      const textbookId = args[args.indexOf('--textbook-id') + 1];
      runId = seedChildRun(dbPath, textbookId, 'blocked');
      child = fakeChild();
      assert.equal(args.includes('--headful'), false);
      return child;
    },
  });
  const server = createCollectorServer({ manager });
  const base = await listen(server);
  try {
    const started = manager.start(contentPayload());
    await waitFor(() => child != null);
    child.emit('message', { type: 'run_created', runId, runType: 'content', textbookExternalId: 'tb1' });
    const live = await (await fetch(`${base}/v1/jobs/${started.id}`)).json();
    assert.equal(live.status, 'running');
    assert.equal(live.collectorRunId, runId, '子进程一发出 run_created，GET 就应读到 collectorRunId');
    assert.equal(live.scopeItems[0].collectorRunId, runId);

    child.stdout.write('[列表] 一些人类可读日志\n');
    child.emit('message', {
      type: 'error', code: 'verification_required', message: '人工验证等待超时，已保留断点。', recoverable: true,
      failedPages: [{ catalogExternalId: 'tb1-c1', pageNumber: 470, resultType: 'request_failed' }],
    });
    child.stderr.write('[错误] 人工验证等待超时，已保留断点。\n使用 --help 查看参数。\n');
    child.finish(1);
    await waitFor(() => ['blocked', 'failed'].includes(manager.get(started.id)?.status));
    const finished = await (await fetch(`${base}/v1/jobs/${started.id}`)).json();
    assert.equal(finished.status, 'blocked');
    assert.equal(finished.errorCode, 'verification_required');
    assert.equal(finished.errorMessage, '人工验证等待超时，已保留断点。');
    assert.notEqual(finished.errorMessage, '使用 --help 查看参数。');
    assert.equal(finished.scopeItems[0].errorCode, 'verification_required');
    assert.equal(finished.scopeItems[0].status, 'blocked');
    assert.match(finished.logTail, /一些人类可读日志/);
    assert.doesNotMatch(finished.logTail, /@@event/);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT status, error_code, active_slot, collector_run_id FROM collector_jobs WHERE id = ?').get(started.id);
    db.close();
    assert.equal(row.status, 'blocked');
    assert.equal(row.error_code, 'verification_required');
    assert.equal(row.active_slot, null);
    assert.equal(row.collector_run_id, runId);
  } finally {
    await closeServer(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('A3-3b stdout 上的 @@event 行作为第二事件通道，同样不进入 logTail', async () => {
  const { directory, dbPath } = temporaryDb();
  seedMetadata(dbPath);
  let child;
  let runId;
  const manager = new CollectorJobManager({
    dbPath,
    spawnImpl(_node, args) {
      runId = seedChildRun(dbPath, args[args.indexOf('--textbook-id') + 1], 'success');
      child = fakeChild();
      return child;
    },
  });
  try {
    const started = manager.start(contentPayload());
    await waitFor(() => child != null);
    child.stdout.write(`${formatEventLine({ type: 'run_created', runId, runType: 'content' })}\n`);
    child.stdout.write(`${formatEventLine({ type: 'progress', runId, pagesOk: 7, questionsSeen: 70, catalogCount: 3 })}\n`);
    await waitFor(() => manager.get(started.id)?.scopeItems[0].collectorRunId === runId);
    const job = manager.get(started.id);
    assert.equal(job.scopeItems[0].pagesOk, 7);
    assert.equal(job.scopeItems[0].questionsSeen, 70);
    assert.doesNotMatch(job.lines.join('\n'), /@@event/);
    child.finish(0);
    await waitFor(() => manager.get(started.id)?.status === 'completed');
    assert.equal(publicJob(manager.get(started.id)).errorCode, null);
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('A3-4 两个管理器共用同一 SQLite：第二个 start 得到 409，第一个终态后第二个可启动', async () => {
  const { directory, dbPath } = temporaryDb();
  seedMetadata(dbPath, ['tb1', 'tb2']);
  let firstChild;
  const first = new CollectorJobManager({
    dbPath,
    spawnImpl(_node, args) {
      seedChildRun(dbPath, args[args.indexOf('--textbook-id') + 1], 'success');
      firstChild = fakeChild();
      return firstChild;
    },
  });
  const second = new CollectorJobManager({
    dbPath,
    spawnImpl(_node, args) {
      seedChildRun(dbPath, args[args.indexOf('--textbook-id') + 1], 'success');
      const child = fakeChild();
      queueMicrotask(() => child.finish(0));
      return child;
    },
  });
  try {
    const started = first.start(contentPayload(['tb1']));
    await waitFor(() => firstChild != null);
    assert.throws(() => second.start(contentPayload(['tb2'])), (error) => error.statusCode === 409);
    assert.equal(second.activeJob, null, '被拒绝的任务不能留在第二个管理器的内存里');
    firstChild.finish(0);
    await waitFor(() => first.get(started.id)?.status === 'completed');
    const next = second.start(contentPayload(['tb2']));
    await waitFor(() => second.get(next.id)?.status === 'completed');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT id, status, active_slot FROM collector_jobs ORDER BY created_at').all();
    db.close();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.active_slot), [null, null]);
  } finally {
    await first.shutdown();
    await second.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('A3-5 重启恢复：前一管理器崩溃后新管理器把遗留活动任务封存为 interrupted/failed 并回绑 run', async () => {
  const { directory, dbPath } = temporaryDb();
  seedMetadata(dbPath);
  let child;
  let orphanRunId;
  const crashed = new CollectorJobManager({
    dbPath,
    spawnImpl(_node, args) {
      orphanRunId = seedChildRun(dbPath, args[args.indexOf('--textbook-id') + 1], 'running', { finish: false });
      child = fakeChild();
      return child;
    },
  });
  const started = crashed.start(contentPayload());
  await waitFor(() => child != null);
  child.emit('message', { type: 'run_created', runId: orphanRunId, runType: 'content' });
  await waitFor(() => crashed.get(started.id)?.scopeItems[0].collectorRunId === orphanRunId);
  // Simulate a crash: forget the manager without cancelling or finishing.
  crashed.dispose();

  const restarted = new CollectorJobManager({ dbPath, spawnImpl() { throw new Error('不应再次启动子进程'); } });
  try {
    const recovered = restarted.get(started.id);
    assert.ok(recovered, '重启后 GET 仍能读到该任务');
    assert.ok(['interrupted', 'failed'].includes(recovered.status), recovered.status);
    assert.equal(recovered.errorCode, 'collector_restarted');
    assert.equal(recovered.scopeItems[0].collectorRunId, orphanRunId);
    assert.equal(publicJob(recovered).errorCode, 'collector_restarted');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const run = db.prepare('SELECT status, snapshot_locked_at FROM sync_runs WHERE id = ?').get(orphanRunId);
    const row = db.prepare('SELECT active_slot FROM collector_jobs WHERE id = ?').get(started.id);
    db.close();
    assert.ok(run.snapshot_locked_at, '孤儿 run 必须被封存');
    assert.ok(['interrupted', 'failed'].includes(run.status));
    assert.equal(row.active_slot, null, '恢复后互斥槽必须释放');
    // The slot is free again: a new job can start.
    const fresh = new CollectorJobManager({
      dbPath,
      spawnImpl(_node, args) {
        seedChildRun(dbPath, args[args.indexOf('--textbook-id') + 1], 'success');
        const next = fakeChild();
        queueMicrotask(() => next.finish(0));
        return next;
      },
    });
    try {
      const next = fresh.start(contentPayload());
      await waitFor(() => fresh.get(next.id)?.status === 'completed');
    } finally {
      await fresh.shutdown();
    }
  } finally {
    await restarted.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('A3-6 停滞检测：无心跳的子进程被终止并记 stalled；持续 verification_wait 不判停滞', async () => {
  const { directory, dbPath } = temporaryDb();
  seedMetadata(dbPath, ['tb1', 'tb2']);
  let child;
  const manager = new CollectorJobManager({
    dbPath,
    stallTimeoutMs: 200,
    spawnImpl(_node, args) {
      seedChildRun(dbPath, args[args.indexOf('--textbook-id') + 1], 'running', { finish: false });
      child = fakeChild();
      return child;
    },
  });
  try {
    const started = manager.start(contentPayload(['tb1']));
    await waitFor(() => child != null);
    await waitFor(() => child.killed.length > 0 || manager.get(started.id)?.abortCode, 2000);
    assert.equal(manager.get(started.id).abortCode, 'stalled');
    child.finish(-15);
    await waitFor(() => ['interrupted', 'failed'].includes(manager.get(started.id)?.status));
    const job = publicJob(manager.get(started.id));
    assert.equal(job.errorCode, 'stalled');
    assert.match(job.errorMessage, /没有任何进度或心跳/);
    assert.equal(job.scopeItems[0].errorCode, 'stalled');

    // Second job: only verification_wait events, well past the stall window.
    let waiting;
    const patient = new CollectorJobManager({
      dbPath,
      stallTimeoutMs: 200,
      spawnImpl() {
        waiting = fakeChild();
        return waiting;
      },
    });
    try {
      const next = patient.start({
        runType: 'content', acknowledgeSourcePolicy: true, maxPages: 1,
        textbookExternalIds: ['tb2'],
        textbookScopes: [{
          sourceProvider: 'zujuan', externalVersionId: 'v1', externalTextbookId: 'tb2',
          versionName: '测试版', textbookName: '教材 tb2',
        }],
      });
      await waitFor(() => waiting != null);
      const ticker = setInterval(() => {
        waiting.emit('message', { type: 'verification_wait', reason: 'http_403', elapsedMs: 1 });
      }, 40);
      await new Promise((resolve) => setTimeout(resolve, 700));
      clearInterval(ticker);
      assert.equal(patient.get(next.id).abortCode, null, '人工验证等待期间不应判停滞');
      assert.equal(patient.get(next.id).status, 'running');
      assert.equal(publicJob(patient.get(next.id)).waitingReason, 'http_403');
      assert.equal(waiting.killed.length, 0);
      patient.cancel(next.id);
      waiting.finish(-15);
      await waitFor(() => patient.get(next.id)?.status === 'cancelled');
    } finally {
      await patient.shutdown();
    }
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('A3-6b 任务总时限到期后终止子进程并记 job_timeout', async () => {
  const { directory, dbPath } = temporaryDb();
  seedMetadata(dbPath);
  let child;
  const manager = new CollectorJobManager({
    dbPath,
    jobTimeoutMs: 150,
    stallTimeoutMs: 60000,
    spawnImpl(_node, args) {
      seedChildRun(dbPath, args[args.indexOf('--textbook-id') + 1], 'running', { finish: false });
      child = fakeChild();
      return child;
    },
  });
  let ticker;
  try {
    const started = manager.start(contentPayload());
    await waitFor(() => child != null);
    ticker = setInterval(() => child.emit('message', { type: 'heartbeat', stage: 'fetch' }), 30);
    await waitFor(() => manager.get(started.id)?.abortCode === 'job_timeout', 2000);
    clearInterval(ticker);
    assert.ok(child.killed.length > 0);
    child.finish(-15);
    await waitFor(() => ['interrupted', 'failed'].includes(manager.get(started.id)?.status));
    assert.equal(publicJob(manager.get(started.id)).errorCode, 'job_timeout');
  } finally {
    clearInterval(ticker);
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('真实子进程通过 IPC 通道发送结构化 error（不启动 Chrome）', async () => {
  const { spawn } = require('node:child_process');
  const received = [];
  const child = spawn(process.execPath, [path.join(ROOT, 'zujuan_question_sync.cjs'), '--no-such-flag'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', (message) => received.push(message));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exitCode, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'error');
  assert.equal(received[0].stage, 'cli');
  assert.match(received[0].message, /未知参数/);
  assert.match(stderr, /使用 --help 查看参数/, 'CLI 文本提示仍然保留给人看');
  assert.doesNotMatch(received[0].message, /--help/, '结构化错误不含帮助提示');
});

test('API 侧关闭 IPC 通道后，子进程 emitter 继续运行而不会因 process error 崩溃', async () => {
  const { spawn } = require('node:child_process');
  const { directory } = temporaryDb();
  const script = path.join(directory, 'emitter-child.cjs');
  fs.writeFileSync(script, `
    const { createProcessEventEmitter } = require(${JSON.stringify(path.join(ROOT, 'src', 'jobs', 'events.cjs'))});
    const events = createProcessEventEmitter();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      events.emit('heartbeat', { stage: 'tick' });
      if (ticks >= 12) { clearInterval(timer); process.stdout.write('survived ipcOpen=' + events.ipcOpen + '\\n'); process.exit(0); }
    }, 40);
  `);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve) => child.once('message', resolve));
  child.disconnect();
  // After a parent-side disconnect Node may not emit 'close' for the IPC
  // handle; wait for the process exit and the stdout stream end instead.
  const stdoutDone = new Promise((resolve) => child.stdout.once('end', resolve));
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  await Promise.race([stdoutDone, new Promise((resolve) => setTimeout(resolve, 500))]);
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /survived ipcOpen=false/);
  assert.doesNotMatch(stderr, /ERR_IPC_CHANNEL_CLOSED/);
});

test('A3-7 --events-stdout 是隐藏诊断参数：--help 不提及，parseArgs 接受', () => {
  assert.doesNotMatch(usage(), /events-stdout/);
  assert.equal(parseArgs(['--textbook-id', '260617']).eventsStdout, false);
  assert.equal(parseArgs(['--textbook-id', '260617', '--events-stdout']).eventsStdout, true);
});

test('JobStore 只新增 collector_jobs 表与两个索引，其它 schema 对象不变', () => {
  const { directory, dbPath } = temporaryDb();
  try {
    const before = new SyncStore(dbPath);
    before.close();
    const snapshot = () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all();
      db.close();
      return rows;
    };
    const baseline = snapshot();
    const store = new JobStore(dbPath);
    store.close();
    const after = snapshot();
    const added = after.filter((row) => !baseline.some((item) => item.name === row.name));
    assert.deepEqual(added.map((row) => row.name).sort(), [
      'collector_jobs', 'ix_collector_jobs_created_at', 'ux_collector_jobs_active_slot',
    ]);
    const unchanged = after.filter((row) => baseline.some((item) => item.name === row.name));
    assert.deepEqual(unchanged, baseline);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
