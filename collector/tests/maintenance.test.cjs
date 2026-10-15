'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Maintenance } = require('../src/api/maintenance.cjs');
const { checkpointDatabase } = require('../src/storage/maintenance.cjs');

const SLOW = path.join(__dirname, 'fixtures', 'workers', 'slow_maintenance_worker.cjs');

test('维护任务：同一任务重复请求合并，不同维护任务 409，启动采集暂缓为 423', async () => {
  const m = new Maintenance({ workerScript: SLOW });
  const first = m.run('reclaimRun', '7', 150);
  const again = m.run('reclaimRun', '7', 150);
  assert.equal(first, again);
  assert.equal(m.busy, true);
  assert.throws(
    () => m.assertIdle(),
    (error) => error.code === 'maintenance_busy' && error.statusCode === 423,
  );
  await assert.rejects(m.run('reclaimRun', '8', 1), (error) => error.code === 'maintenance_busy');
  assert.deepEqual(await first, { name: 'reclaimRun', ms: 150 });
  assert.equal(m.busy, false);
  m.assertIdle();
  assert.equal(m.status().joined, 1);
  assert.equal(m.status().rejectedBusy, 1);
});

test('维护任务：错误码透传，采集进行中拒绝执行', async () => {
  const m = new Maintenance({ workerScript: SLOW });
  await assert.rejects(m.run('reclaimRun', '1', 1, 'fail'), (error) => {
    return error.statusCode === 409 && error.code === 'cleanup_latest';
  });
  assert.equal(m.status().failed, 1);
  const active = new Maintenance({ workerScript: SLOW, isJobActive: () => true });
  await assert.rejects(active.run('reclaimRun', '1', 1), (error) => error.code === 'cleanup_busy');
  assert.equal(await active.checkpoint('/nonexistent'), null);
});

test('维护任务：执行期间主线程事件循环不被阻塞', async () => {
  const m = new Maintenance({ workerScript: SLOW });
  const started = Date.now();
  const task = m.run('reclaimRun', '1', 300);
  const tick = await new Promise((resolve) => setTimeout(() => resolve(Date.now() - started), 20));
  assert.ok(tick < 200, `event loop stalled for ${tick} ms`);
  await task;
});

test('维护任务：停止时超出宽限期终止线程，之后拒绝新任务', async () => {
  const m = new Maintenance({ workerScript: SLOW });
  const task = m.run('reclaimRun', '1', 10000);
  const started = Date.now();
  await m.close(50);
  assert.ok(Date.now() - started < 2000);
  await assert.rejects(task, (error) => error.code === 'maintenance_aborted');
  await assert.rejects(m.run('reclaimRun', '2', 1), (error) => error.statusCode === 503);
});

test('WAL 整理：空闲时截断 -wal 文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-maint-'));
  const dbPath = path.join(dir, 'c.sqlite3');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(v TEXT)');
    const insert = db.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < 2000; i++) insert.run('x'.repeat(200));
    assert.ok(fs.statSync(`${dbPath}-wal`).size > 100000);
    // The API's own connection stays open, so closing never cleans the WAL.
    const result = checkpointDatabase(dbPath);
    assert.equal(result.busy, false);
    assert.equal(fs.statSync(`${dbPath}-wal`).size, 0);
    // The real worker resolves the same task by name.
    const m = new Maintenance();
    const threaded = await m.run('checkpointDatabase', dbPath, dbPath);
    assert.equal(threaded.busy, false);
  } finally {
    try {
      db.close();
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
