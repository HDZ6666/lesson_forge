'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const { ReaderPool } = require('../src/api/reader_pool.cjs');
const { JobStore } = require('../src/api/job_store.cjs');

const FAKE_WORKER = path.join(__dirname, 'fixtures', 'workers', 'fake_reader_worker.cjs');

test('reader pool rejects names outside the reader allowlist', async () => {
  const pool = new ReaderPool({ threads: 1, workerScript: FAKE_WORKER });
  try {
    await assert.rejects(pool.call('constructor'), /未知读取函数/);
    await assert.rejects(pool.call('require', 'node:child_process'), /未知读取函数/);
  } finally {
    await pool.close();
  }
});

test('reader pool keeps HTTP status and code of reader errors', async () => {
  const pool = new ReaderPool({ threads: 1, workerScript: FAKE_WORKER });
  try {
    await assert.rejects(pool.call('readCatalogProgress'), (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'run_not_found');
      assert.equal(error.message, '运行不存在');
      return true;
    });
  } finally {
    await pool.close();
  }
});

test('a slow reader does not block the main event loop', async () => {
  const pool = new ReaderPool({ threads: 1, workerScript: FAKE_WORKER });
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  try {
    await pool.call('readCandidates', 0); // warm up the worker
    histogram.enable();
    const slow = pool.call('readCandidates', 600);
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 20);
    const result = await slow;
    clearInterval(ticker);
    histogram.disable();
    assert.equal(result.slept, 600);
    assert.notEqual(result.threadId, 0);
    assert.ok(ticks >= 15, `main thread should keep ticking, got ${ticks}`);
    assert.ok(histogram.max / 1e6 < 200, `event loop delay ${histogram.max / 1e6} ms`);
  } finally {
    await pool.close();
  }
});

test('reader timeout returns 504, replaces the worker and serves the next call', async () => {
  const pool = new ReaderPool({ threads: 1, timeoutMs: 1000, workerScript: FAKE_WORKER });
  try {
    await assert.rejects(pool.call('readCandidates', 5000), (error) => {
      assert.equal(error.statusCode, 504);
      assert.equal(error.code, 'reader_timeout');
      return true;
    });
    const next = await pool.call('readCandidates', 1);
    assert.equal(next.slept, 1);
    assert.equal(pool.status().timeouts, 1);
    assert.equal(pool.status().restarts, 1);
  } finally {
    await pool.close();
  }
});

test('calls beyond the thread count queue instead of failing', async () => {
  const pool = new ReaderPool({ threads: 2, workerScript: FAKE_WORKER });
  try {
    const started = Date.now();
    const results = await Promise.all([1, 2, 3, 4].map(() => pool.call('readCandidates', 200)));
    assert.equal(results.length, 4);
    // two threads, four 200 ms reads: two rounds, not four
    assert.ok(Date.now() - started < 750, `took ${Date.now() - started} ms`);
    assert.equal(pool.status().busy, 0);
    assert.equal(pool.status().queued, 0);
  } finally {
    await pool.close();
  }
});

test('asset descriptor survives the thread hop and stays out of JSON', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-pool-asset-'));
  const filePath = path.join(directory, 'a.txt');
  fs.writeFileSync(filePath, 'hello');
  const pool = new ReaderPool({ threads: 1, workerScript: FAKE_WORKER });
  try {
    const asset = await pool.call('readRunAsset', filePath);
    assert.equal(asset.contentLength, 5);
    assert.ok(Number.isInteger(asset.fileDescriptor));
    assert.equal(Object.keys(asset).includes('fileDescriptor'), false);
    assert.equal(JSON.stringify(asset).includes('escriptor'), false);
    const buffer = Buffer.alloc(5);
    fs.readSync(asset.fileDescriptor, buffer, 0, 5, 0);
    assert.equal(buffer.toString(), 'hello');
    fs.closeSync(asset.fileDescriptor);
  } finally {
    await pool.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('threads: 0 runs the real readers inline', async () => {
  const pool = new ReaderPool({ threads: 0 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-pool-inline-'));
  try {
    await assert.rejects(pool.call('readRunSnapshot', path.join(directory, 'missing.sqlite3'), 'not-a-run'));
    assert.equal(pool.status().threads, 0);
  } finally {
    await pool.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('closing the pool rejects queued calls with 503', async () => {
  const pool = new ReaderPool({ threads: 1, workerScript: FAKE_WORKER });
  const running = assert.rejects(pool.call('readCandidates', 300));
  const queued = assert.rejects(pool.call('readCandidates', 1), (error) => error.statusCode === 503);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await pool.close();
  await queued;
  await running;
  await assert.rejects(pool.call('readCandidates', 1), (error) => error.statusCode === 503);
});

test('job store skips rewriting a row whose content did not change', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'job-store-skip-'));
  const store = new JobStore(path.join(directory, 'jobs.sqlite3'));
  try {
    const job = {
      id: '00000000-0000-4000-8000-000000000001',
      runType: 'content',
      status: 'running',
      createdAt: new Date().toISOString(),
      progressPercent: 1,
      lines: ['a'],
    };
    store.insertActive(job, { pid: process.pid, token: 'owner' });
    assert.equal(store.save(job, { pid: process.pid, token: 'owner' }), true);
    assert.equal(store.save(job, { pid: process.pid, token: 'owner' }), false);
    job.progressPercent = 2;
    assert.equal(store.save(job, { pid: process.pid, token: 'owner' }), true);
    assert.equal(store.load(job.id).progressPercent, 2);
    store.release(job.id);
    assert.equal(store.save(job, { pid: process.pid, token: 'owner' }), true);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
