'use strict';

/**
 * Off-thread SQLite readers for the HTTP API.
 *
 * `node:sqlite` is synchronous.  Snapshot pages, run summaries and the live
 * progress projection can each take hundreds of milliseconds on a large run,
 * and while one runs on the main thread every other request — including
 * `/health` and the job status the service polls — waits behind it.  This
 * pool runs the read-only reader functions in `worker_threads` so the event
 * loop only parses requests and writes responses.
 *
 * Only the reader names in READER_NAMES can be called.  A call that exceeds
 * its timeout terminates that worker (the next call spawns a fresh one) and
 * rejects with HTTP 504, so one runaway query cannot wedge the pool.
 *
 * `threads: 0` runs the readers inline on the calling thread.  That keeps the
 * old behaviour available for debugging and for hosts where threads are not
 * wanted (COLLECTOR_READER_THREADS=0).
 */

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_SCRIPT = path.join(__dirname, 'reader_worker.cjs');

const READER_NAMES = Object.freeze([
  'readCandidates',
  'readCatalogProgress',
  'readLiveRunProgress',
  'readMetadataSnapshot',
  'readRunAsset',
  'readRunCatalogs',
  'readRunQuestion',
  'readRunQuestions',
  'readRunSnapshot',
  'readRunSnapshotPage',
  'readRunSnapshotSummary',
  'validateMetadataSelection',
]);
const READER_SET = new Set(READER_NAMES);

function serializeError(error) {
  return {
    message: String(error?.message || error),
    statusCode: error?.statusCode == null ? null : Number(error.statusCode),
    code: error?.code == null ? null : String(error.code),
  };
}

function reviveError(data) {
  const error = new Error(data?.message || '读取失败');
  if (data?.statusCode != null) error.statusCode = data.statusCode;
  if (data?.code != null) error.code = data.code;
  return error;
}

/**
 * Asset results carry the validated file descriptor as a non-enumerable
 * property so it never leaks into JSON.  Structured clone drops
 * non-enumerable properties, so the worker sends it explicitly and the main
 * thread restores the original shape.  Worker threads share the process file
 * descriptor table, so the descriptor stays valid.
 */
function packResult(name, result) {
  if (name !== 'readRunAsset' || !result || typeof result !== 'object') return result;
  return { ...result, __fileDescriptor: Number.isInteger(result.fileDescriptor) ? result.fileDescriptor : null };
}

function unpackResult(name, result) {
  if (name !== 'readRunAsset' || !result || typeof result !== 'object') return result;
  const { __fileDescriptor: fileDescriptor, ...rest } = result;
  if (Number.isInteger(fileDescriptor)) {
    Object.defineProperty(rest, 'fileDescriptor', { value: fileDescriptor, enumerable: false });
  }
  return rest;
}

function runInline(name, args) {
  // Lazy so the API process does not load every reader module up front when
  // threads are enabled.
  const readers = require('../storage/readers/index.cjs');
  return readers[name](...args);
}

class ReaderPool {
  constructor({ threads = 2, timeoutMs = 25000, workerScript = WORKER_SCRIPT } = {}) {
    this.threads = Math.max(0, Math.floor(Number(threads) || 0));
    this.timeoutMs = Math.max(1000, Math.floor(Number(timeoutMs) || 25000));
    this.workerScript = workerScript;
    this.workers = [];
    this.queue = [];
    this.nextId = 1;
    this.closed = false;
    this.stats = { calls: 0, failures: 0, timeouts: 0, restarts: 0 };
  }

  call(name, ...args) {
    if (!READER_SET.has(name)) return Promise.reject(new Error(`未知读取函数：${name}`));
    if (this.closed) return Promise.reject(Object.assign(new Error('采集器正在停止'), { statusCode: 503 }));
    this.stats.calls += 1;
    if (this.threads === 0) {
      try {
        return Promise.resolve(runInline(name, args));
      } catch (error) {
        this.stats.failures += 1;
        return Promise.reject(error);
      }
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, name, args, resolve, reject });
      this._drain();
    });
  }

  _spawn() {
    const worker = new Worker(this.workerScript);
    const slot = { worker, task: null, timer: null };
    worker.unref();
    worker.on('message', (message) => this._settle(slot, message));
    worker.on('error', (error) => this._fail(slot, error));
    worker.on('exit', (code) => {
      if (slot.task) this._fail(slot, new Error(`读取线程异常退出（${code}）`));
      this.workers = this.workers.filter((candidate) => candidate !== slot);
      if (!this.closed && this.queue.length) this._drain();
    });
    this.workers.push(slot);
    return slot;
  }

  _drain() {
    while (this.queue.length) {
      let slot = this.workers.find((candidate) => !candidate.task);
      if (!slot && this.workers.length < this.threads) slot = this._spawn();
      if (!slot) return;
      const task = this.queue.shift();
      slot.task = task;
      // Keep the process alive while a request waits on a reader.
      slot.worker.ref();
      slot.timer = setTimeout(() => this._timeout(slot), this.timeoutMs);
      slot.timer.unref?.();
      slot.worker.postMessage({ id: task.id, name: task.name, args: task.args });
    }
  }

  _release(slot) {
    clearTimeout(slot.timer);
    slot.timer = null;
    const task = slot.task;
    slot.task = null;
    slot.worker.unref();
    return task;
  }

  _settle(slot, message) {
    if (!slot.task || message?.id !== slot.task.id) return;
    const task = this._release(slot);
    if (message.ok) task.resolve(unpackResult(task.name, message.result));
    else {
      this.stats.failures += 1;
      task.reject(reviveError(message.error));
    }
    this._drain();
  }

  _fail(slot, error) {
    if (!slot.task) return;
    const task = this._release(slot);
    this.stats.failures += 1;
    task.reject(Object.assign(new Error(String(error?.message || error)), { statusCode: 500, code: 'reader_failed' }));
  }

  _timeout(slot) {
    if (!slot.task) return;
    const task = this._release(slot);
    this.stats.timeouts += 1;
    this.stats.restarts += 1;
    this.workers = this.workers.filter((candidate) => candidate !== slot);
    slot.worker.terminate().catch(() => {});
    task.reject(
      Object.assign(new Error(`读取超过 ${Math.round(this.timeoutMs / 1000)} 秒，已中止`), {
        statusCode: 504,
        code: 'reader_timeout',
      }),
    );
    this._drain();
  }

  status() {
    return {
      threads: this.threads,
      busy: this.workers.filter((slot) => slot.task).length,
      queued: this.queue.length,
      ...this.stats,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const pending = this.queue.splice(0);
    for (const task of pending) task.reject(Object.assign(new Error('采集器正在停止'), { statusCode: 503 }));
    const workers = this.workers.splice(0);
    await Promise.all(
      workers.map(async (slot) => {
        if (slot.task) this._fail(slot, new Error('采集器正在停止'));
        await slot.worker.terminate().catch(() => {});
      }),
    );
  }
}

module.exports = {
  READER_NAMES,
  ReaderPool,
  packResult,
  reviveError,
  serializeError,
  unpackResult,
};
