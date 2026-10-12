'use strict';

/**
 * Off-thread SQLite maintenance for the HTTP API: result reclaim and WAL
 * checkpoints.
 *
 * Reclaim deletes a whole run in one transaction and, on first use, builds
 * the indexes it needs on large tables.  That can take seconds to minutes.
 * Run on the main thread it froze `/health` and job polling, so the service
 * saw the collector as down.  Here each task runs in its own worker thread.
 *
 * Rules:
 * - One task at a time: maintenance writes, and two writers only contend.
 * - A repeated request for the same task joins the one in flight, so a
 *   service retry after its own HTTP timeout never starts a second delete.
 * - A different task while one runs gets 409 `maintenance_busy`.
 * - Crawl jobs cannot start while a task runs (`assertIdle`), and maintenance
 *   refuses to run while a job is active.
 * - No timeout: reclaim is one transaction and stopping it midway only rolls
 *   it back. On shutdown an unfinished task is terminated. SQLite rolls back
 *   the open transaction and the next request repeats it, because reclaim
 *   is idempotent.
 *
 * `threads: 0` runs tasks inline (tests, COLLECTOR_READER_THREADS=0).
 */

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_SCRIPT = path.join(__dirname, 'maintenance_worker.cjs');
const TASK_NAMES = Object.freeze(['reclaimRun', 'checkpointDatabase']);

function httpError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function serializeError(error) {
  return {
    message: String(error?.message || error),
    statusCode: error?.statusCode == null ? null : Number(error.statusCode),
    code: error?.code == null ? null : String(error.code),
  };
}

function reviveError(data) {
  const error = new Error(data?.message || '维护任务失败');
  if (data?.statusCode != null) error.statusCode = data.statusCode;
  if (data?.code != null) error.code = data.code;
  return error;
}

function runTask(name, args) {
  if (!TASK_NAMES.includes(name)) throw new Error(`未知维护任务：${name}`);
  const { checkpointDatabase } = require('../storage/maintenance.cjs');
  if (name === 'checkpointDatabase') return checkpointDatabase(...args);
  const result = require('../storage/result_cleanup.cjs').reclaimRun(...args);
  // Truncate the WAL the delete just filled. It runs in the same task so a
  // service retry right after never meets a separate checkpoint as "busy".
  try {
    checkpointDatabase(args[0]);
  } catch {}
  return result;
}

class Maintenance {
  constructor({ threads = 1, workerScript = WORKER_SCRIPT, isJobActive = () => false } = {}) {
    this.inline = Number(threads) === 0;
    this.workerScript = workerScript;
    this.isJobActive = isJobActive;
    this.current = null;
    this.closed = false;
    this.stats = { completed: 0, failed: 0, joined: 0, rejectedBusy: 0, lastDurationMs: 0 };
  }

  get busy() {
    return Boolean(this.current);
  }

  /** Throws 409 while a maintenance task holds the database. */
  assertIdle() {
    if (this.current) {
      throw httpError('采集器正在回收或整理数据库，请稍后再启动', 409, 'maintenance_busy');
    }
  }

  run(name, key, ...args) {
    if (this.closed) return Promise.reject(httpError('采集器正在停止', 503, 'stopping'));
    const taskKey = `${name}:${key}`;
    if (this.current) {
      if (this.current.key === taskKey) {
        this.stats.joined += 1;
        return this.current.promise;
      }
      this.stats.rejectedBusy += 1;
      return Promise.reject(httpError('采集器正在执行其他维护任务，稍后自动重试', 409, 'maintenance_busy'));
    }
    if (this.isJobActive()) {
      return Promise.reject(httpError('采集进行中，稍后自动回收', 409, 'cleanup_busy'));
    }
    const started = Date.now();
    const task = { key: taskKey, worker: null };
    task.promise = (this.inline ? this._inline(name, args) : this._threaded(task, name, args)).then(
      (result) => {
        this.stats.completed += 1;
        return result;
      },
      (error) => {
        this.stats.failed += 1;
        throw error;
      },
    );
    task.promise
      .finally(() => {
        this.stats.lastDurationMs = Date.now() - started;
        if (this.current === task) this.current = null;
      })
      .catch(() => {});
    this.current = task;
    return task.promise;
  }

  /** Checkpoint and truncate the WAL; skipped quietly when busy. */
  async checkpoint(dbPath) {
    if (!dbPath || this.current || this.isJobActive() || this.closed) return null;
    try {
      return await this.run('checkpointDatabase', dbPath, dbPath);
    } catch (error) {
      console.warn(`[维护] WAL 整理跳过：${String(error.message).slice(0, 200)}`);
      return null;
    }
  }

  async _inline(name, args) {
    await null;
    return runTask(name, args);
  }

  _threaded(task, name, args) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerScript, { workerData: { name, args } });
      task.worker = worker;
      let settled = false;
      worker.once('message', (message) => {
        settled = true;
        if (message?.ok) resolve(message.result);
        else reject(reviveError(message?.error));
      });
      worker.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(httpError(String(error?.message || error), 500, 'maintenance_failed'));
      });
      worker.once('exit', (code) => {
        if (settled) return;
        settled = true;
        reject(httpError(`维护线程意外退出（${code}）`, 503, 'maintenance_aborted'));
      });
    });
  }

  status() {
    return { busy: this.busy, task: this.current?.key.split(':')[0] || null, ...this.stats };
  }

  /** Waits up to graceMs for the running task, then terminates it. */
  async close(graceMs = 15000) {
    this.closed = true;
    const task = this.current;
    if (!task) return;
    let timer;
    const finished = task.promise.then(
      () => true,
      () => true,
    );
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
      timer.unref?.();
    });
    const done = await Promise.race([finished, expired]);
    clearTimeout(timer);
    if (!done && task.worker) await task.worker.terminate().catch(() => {});
  }
}

module.exports = { Maintenance, TASK_NAMES, runTask, serializeError };
