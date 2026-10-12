'use strict';

/**
 * CollectorJobManager mixin: terminal transitions, cancel and disposal.
 */

const { publicJob } = require('../progress.cjs');
const { unregisterOwner } = require('../job_store.cjs');
const { ACTIVE_STATUSES } = require('./constants.cjs');

class LifecycleMethods {
  finishJob(job, status, message, errorCode = null) {
    job.status = status;
    job.phase = status === 'completed' ? 'completed' : status;
    job.errorMessage = message;
    job.errorCode =
      status === 'completed'
        ? null
        : errorCode || job.errorCode || this.jobErrorCode(job, status === 'cancelled' ? 'cancelled' : status);
    job.progressPercent = status === 'completed' ? 100 : job.progressPercent;
    job.currentTextbookId = null;
    job.currentTextbookName = null;
    job.finishedAt = new Date().toISOString();
    if (this.metrics) {
      this.metrics.jobsFinished[status] = (this.metrics.jobsFinished[status] || 0) + 1;
      if (job.errorCode) this.metrics.jobErrors[job.errorCode] = (this.metrics.jobErrors[job.errorCode] || 0) + 1;
    }
    for (const scope of job.scopeItems || []) {
      if (status === 'cancelled') {
        if (!['completed', 'failed', 'blocked', 'interrupted'].includes(scope.status)) scope.status = 'cancelled';
        scope.error = scope.error || (scope.status === 'cancelled' ? '同步已停止' : null);
        scope.finishedAt = scope.finishedAt || new Date().toISOString();
      } else if (['failed', 'blocked'].includes(status)) {
        if (scope.status === 'running' || scope.status === 'cancelling') {
          scope.status = status;
          scope.error = scope.error || message;
          scope.finishedAt = scope.finishedAt || new Date().toISOString();
        } else if (scope.status === 'queued') {
          scope.status = 'cancelled';
          scope.error = scope.error || '因任务失败未执行';
          scope.finishedAt = scope.finishedAt || new Date().toISOString();
        }
      } else if (status === 'interrupted') {
        if (scope.status === 'running' || scope.status === 'cancelling') {
          scope.status = scope.resumable ? 'interrupted' : 'failed';
          scope.error = scope.error || message;
          scope.finishedAt = scope.finishedAt || new Date().toISOString();
        } else if (scope.status === 'queued') {
          scope.status = 'cancelled';
          scope.error = scope.error || '因其他教材采集暂时中断未执行';
          scope.finishedAt = scope.finishedAt || new Date().toISOString();
        }
      } else if (scope.status === 'completed') {
        scope.finishedAt = scope.finishedAt || new Date().toISOString();
      }
    }
    const completedRuns = (job.scopeItems || [])
      .map((scope) => scope.collectorRunId)
      .filter((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0);
    job.collectorRunId = completedRuns.length === 1 ? Number(completedRuns[0]) : null;
    job.snapshotComplete =
      status === 'completed' &&
      (job.scopeItems || []).length > 0 &&
      (job.scopeItems || []).every((scope) => scope.snapshotComplete === true);
    if (job.scopeItems.length === 1) {
      job.snapshotLockedAt = job.scopeItems[0].snapshotLockedAt || null;
    }
    for (const scope of job.scopeItems || []) {
      if (['failed', 'blocked', 'interrupted', 'cancelled'].includes(String(scope.status)) && !scope.errorCode) {
        scope.errorCode = scope.status === 'cancelled' ? 'cancelled' : job.errorCode;
      }
    }
    this.stopWatchdog(job);
    if (this.activeJobId === job.id) this.activeJobId = null;
    this.persist(job, { force: true });
    this.scheduleIdleCheckpoint();
    if (this.store) {
      try {
        this.store.release(job.id);
      } catch {}
    }
  }

  failJob(job, error) {
    if (job.cancelRequested) {
      this.finishJob(job, 'cancelled', '同步已停止');
      return;
    }
    if (job.abortCode) {
      const resumable = (job.scopeItems || []).some((scope) => scope.resumable === true);
      this.finishJob(job, resumable ? 'interrupted' : 'failed', job.abortMessage, job.abortCode);
      return;
    }
    const message = String(error?.message || error || '采集任务异常').slice(0, 1000);
    const blocked = error?.blocked === true || this.jobLooksBlocked(job);
    const code = error?.code || this.jobErrorCode(job, blocked ? 'blocked' : 'failed');
    const current = this.scopeFor(job, job.currentTextbookId);
    if (current) {
      current.status = blocked ? 'blocked' : 'failed';
      current.error = current.error || message;
      current.errorCode = current.errorCode || code;
      current.finishedAt = current.finishedAt || new Date().toISOString();
    }
    this.record(job, `[错误] ${message}`, 'stderr');
    this.finishJob(job, blocked ? 'blocked' : 'failed', message, code);
  }

  cancel(id, { reserveDispatch = false } = {}) {
    let job = this.get(id);
    if (!job && reserveDispatch) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id)) || !this.store) {
        throw new Error('停止派发需要持久存储及合法 UUID');
      }
      job = this.store.reserveCancelledRequest(String(id).toLowerCase());
      if (!job) return { id: String(id).toLowerCase(), status: 'cancelled' };
    }
    if (!job) return null;
    if (!ACTIVE_STATUSES.has(job.status)) return publicJob(job);
    if (job.persisted && job.ownerToken && job.ownerToken !== this.ownerToken) {
      // A job owned by another process cannot be signalled from here.
      const error = new Error('该任务由其他采集进程持有，无法从当前进程停止');
      error.statusCode = 409;
      error.code = 'job_not_owned';
      throw error;
    }
    job.cancelRequested = true;
    job.status = 'cancelling';
    const current = this.scopeFor(job, job.currentTextbookId);
    if (current && !['completed', 'failed', 'blocked'].includes(current.status)) {
      current.status = 'cancelling';
      current.error = current.error || '正在停止';
    }
    this.persist(job, { force: true });
    this.terminateChild(job);
    return publicJob(job);
  }

  /**
   * Forget this manager without touching its child processes.  Used by tests
   * to simulate a crash and by `shutdown` after cancelling.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.idleCheckpointTimer);
    unregisterOwner(this.ownerToken);
    for (const job of this.jobs.values()) this.stopWatchdog(job);
    if (this.store) {
      try {
        this.store.close();
      } catch {}
    }
  }

  // Request a cooperative stop, but do not seal a snapshot while its writer
  // is still alive. runChild/execute finalize after the real close event.
  interruptForShutdown(job) {
    if (!job || !ACTIVE_STATUSES.has(String(job.status))) return;
    if (!job.cancelRequested) {
      job.abortCode = 'collector_shutdown';
      job.abortMessage = '采集服务停止（部署或重启），正在保存进度';
    }
    this.persist(job, { force: true });
    this.terminateChild(job);
  }

  /**
   * Truncates the WAL shortly after a job ends. The delay lets the child
   * close its connection first. Skipped when a new job has started by then.
   */
  scheduleIdleCheckpoint(delayMs = 2000) {
    if (!this.maintenance || !this.dbPath) return;
    clearTimeout(this.idleCheckpointTimer);
    this.idleCheckpointTimer = setTimeout(() => void this.maintenance.checkpoint(this.dbPath), delayMs);
    this.idleCheckpointTimer.unref?.();
  }

  shutdown() {
    if (this._shutdownPromise) return this._shutdownPromise;
    this.stopping = true;
    this._shutdownPromise = (async () => {
      const active = this.activeJob;
      if (active && ACTIVE_STATUSES.has(String(active.status))) {
        this.interruptForShutdown(active);
      }
      // This includes runChild's exit, snapshot reconciliation and mutex
      // release. The SQLite store stays open throughout those callbacks.
      await Promise.all([...this.jobs.values()].map((job) => job.execution).filter(Boolean));
      this.dispose();
    })();
    return this._shutdownPromise;
  }
}

module.exports = { LifecycleMethods };
