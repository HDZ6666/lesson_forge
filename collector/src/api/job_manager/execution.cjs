'use strict';

/**
 * CollectorJobManager mixin: child process execution, watchdog and per-run
 * snapshot capture.
 */

const {
  contentRunAfter,
  contentRunWatermark,
  metadataRunAfter,
  metadataWatermark,
  readRunSnapshotSummary,
} = require('../../storage/readers/index.cjs');
const { isResumablePartialRun } = require('../../storage/resume.cjs');
const { scopeErrorText } = require('../request_validation.cjs');
const {
  lastError,
  looksBlocked,
  orphanHasResumablePartial,
  sealOrphanContentRun,
  sealOrphanMetadataRun,
} = require('../orphan_runs.cjs');
const {
  COLLECTOR_ROOT,
  HEARTBEAT_WRITE_MS,
  KILL_GRACE_MS,
  METADATA_SCRIPT,
  QUESTION_SCRIPT,
  SITE_PAGE_LIMIT,
  TERMINAL_STATUSES,
  WATCHDOG_MAX_TICK_MS,
} = require('./constants.cjs');

function crawlTuningArgs(tuning = {}) {
  const args = [];
  if (tuning.listConcurrency != null) args.push('--concurrency', String(tuning.listConcurrency));
  if (tuning.assetConcurrency != null) args.push('--asset-concurrency', String(tuning.assetConcurrency));
  if (tuning.delayMinMs != null) args.push('--delay-min', String(tuning.delayMinMs));
  if (tuning.delayMaxMs != null) args.push('--delay-max', String(tuning.delayMaxMs));
  return args;
}

class ExecutionMethods {
  captureChildSnapshot(job, scope, watermark, result) {
    if (!scope) return null;
    let summary = null;
    try {
      if (watermark != null) {
        summary = contentRunAfter(this.dbPath, watermark, scope.externalTextbookId);
      }
    } catch (error) {
      this.record(job, `[提醒] 无法读取教材 ${scope.externalTextbookId} 的运行快照：${error.message}`, 'stderr');
    }
    const parsedRunId = Number(job._childRunId || 0);
    if (summary?.id) {
      const summaryStatus = String(summary.status || '').trim();
      // If a child exits before its `finally` block runs, its run can be left
      // in `running`.  Seal that orphan run here so a terminal HTTP job
      // cannot leave a mutable snapshot behind.
      if (summaryStatus === 'running') {
        const orphanStatus = result.cancelled
          ? 'cancelled'
          : (looksBlocked(job.lines)
            ? 'blocked'
            : (orphanHasResumablePartial(this.dbPath, summary.id, job.lines)
              ? 'interrupted'
              : 'failed'));
        sealOrphanContentRun(this.dbPath, summary.id, orphanStatus, result.cancelled ? '同步已停止' : lastError(job.lines, '子进程异常退出'));
        try {
          summary = readRunSnapshotSummary(
            this.dbPath,
            summary.id,
            scope.externalTextbookId,
            { allowIncomplete: true },
          ) || summary;
        } catch {}
      }
      scope.collectorRunId = Number(summary.id);
      scope.catalogCount = Number(summary.catalogCount || 0);
      scope.questionCount = Number(summary.questionCount || 0);
      scope.questionCatalogCount = Number(summary.questionCatalogCount || 0);
      scope.questionTagCount = Number(summary.questionTagCount || 0);
      scope.questionAssetCount = Number(summary.questionAssetCount || 0);
      scope.snapshotLockedAt = summary.snapshotLockedAt || summary.snapshot_locked_at || null;
      scope.snapshotComplete = summary.snapshotComplete === true
        || Number(summary.snapshot_complete || 0) === 1;
      scope.scanComplete = summary.scanComplete === true
        || Number(summary.scan_complete || 0) === 1;
      scope.dataComplete = summary.dataComplete === true
        || Number(summary.data_complete || 0) === 1;
      scope.completionQuality = summary.completionQuality || summary.completion_quality || null;
      if (job.scopeItems.length === 1) {
        job.snapshotLockedAt = scope.snapshotLockedAt;
        job.snapshotComplete = scope.snapshotComplete;
      }
      scope.pagesOk = Number(summary.pagesOk || 0);
      scope.questionsSeen = Number(summary.questionsSeen || 0);
      scope.questionsInserted = Number(summary.questionsInserted || 0);
      scope.questionsUpdated = Number(summary.questionsUpdated || 0);
      scope.detailsFetched = Number(summary.detailsFetched || 0);
      scope.assetsDownloaded = Number(summary.assetsDownloaded || 0);
      scope.errorCount = Number(summary.errorCount || 0);
      scope.error = scopeErrorText(summary, null);
      scope.startedAt = summary.startedAt || scope.startedAt || null;
      scope.finishedAt = summary.finishedAt || new Date().toISOString();
      const resumablePartial = isResumablePartialRun(summary);
      scope.resumable = resumablePartial;
      const scanComplete = scope.scanComplete === true || scope.snapshotComplete === true;
      scope.status = ['success', 'completed'].includes(String(summary.status || ''))
        && scanComplete && !result.cancelled
        ? 'completed'
        : (result.cancelled
          ? 'cancelled'
          : (resumablePartial
            ? 'interrupted'
            : (['blocked', 'failed'].includes(String(summary.status || ''))
            ? String(summary.status)
            : 'failed')));
      job.collectorRunId = job.scopeItems.length === 1 ? scope.collectorRunId : null;
      return summary;
    }
    if (parsedRunId > 0) scope.collectorRunId = parsedRunId;
    scope.catalogCount = Number(job._scriptCatalogCount || scope.catalogCount || 0);
    scope.questionCount = Number(job._scriptQuestionCount || scope.questionCount || 0);
    scope.finishedAt = scope.finishedAt || new Date().toISOString();
    if (result.cancelled) scope.status = 'cancelled';
    return null;
  }

  /**
   * Terminate the child the same way `cancel` does, but attribute the outcome
   * to a timeout/stall code instead of a user request.
   */
  abortJob(job, code, message) {
    if (!job || job.abortCode || job.cancelRequested || TERMINAL_STATUSES.has(String(job.status))) return;
    job.abortCode = code;
    job.abortMessage = message;
    job.lines.push(`[stderr] [错误] ${message}`);
    this.persist(job, { force: true });
    this.terminateChild(job);
  }

  terminateChild(job) {
    const child = job.child;
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      try { child.kill?.('SIGTERM'); } catch {}
    }
    const timer = setTimeout(() => {
      if (!job.child?.pid) return;
      try {
        if (process.platform === 'win32') job.child.kill('SIGKILL');
        else process.kill(-job.child.pid, 'SIGKILL');
      } catch {
        try { job.child.kill?.('SIGKILL'); } catch {}
      }
    }, KILL_GRACE_MS);
    timer.unref?.();
  }

  startWatchdog(job) {
    this.stopWatchdog(job);
    const interval = Math.max(20, Math.min(
      WATCHDOG_MAX_TICK_MS,
      Math.floor(this.stallTimeoutMs / 4),
      Math.floor(this.jobTimeoutMs / 4),
    ));
    let lastHeartbeatWrite = 0;
    job._watchdog = setInterval(() => {
      if (!job.child || TERMINAL_STATUSES.has(String(job.status))) return;
      const now = Date.now();
      if (job._startedAtMs && now - job._startedAtMs > this.jobTimeoutMs) {
        this.abortJob(job, 'job_timeout', `采集任务超过总时限 ${Math.round(this.jobTimeoutMs / 1000)} 秒，已终止子进程`);
        return;
      }
      if (job.lastActivityAt && now - job.lastActivityAt > this.stallTimeoutMs) {
        this.abortJob(job, 'stalled', `采集子进程 ${Math.round(this.stallTimeoutMs / 1000)} 秒内没有任何进度或心跳，已终止`);
        return;
      }
      if (now - lastHeartbeatWrite >= HEARTBEAT_WRITE_MS) {
        lastHeartbeatWrite = now;
        try { this.store?.heartbeat(job.id); } catch {}
        if (job._persistDirty) this.persist(job, { force: true });
      }
    }, interval);
    job._watchdog.unref?.();
  }

  stopWatchdog(job) {
    if (job?._watchdog) {
      clearInterval(job._watchdog);
      job._watchdog = null;
    }
  }

  async runChild(job, script, args, scope = null) {
    if (job.cancelRequested || job.abortCode) return { returnCode: -1, cancelled: job.cancelRequested === true };
    job._scriptCatalogCount = 0;
    job._scriptQuestionCount = 0;
    job._childRunId = null;
    job.lastErrorEvent = null;
    job.waitingReason = null;
    job.waitingSince = null;
    const watermark = scope ? contentRunWatermark(this.dbPath) : null;
    if (scope) scope.status = 'running';
    let child;
    try {
      child = this.spawnImpl(this.nodeBin, [script, ...args], {
        cwd: COLLECTOR_ROOT,
        detached: process.platform !== 'win32',
        // The fourth fd is the structured event channel (process.send in the
        // child).  Free-text stdout/stderr remain diagnostic logTail only.
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: process.env,
      });
    } catch (error) {
      if (scope) {
        scope.status = 'failed';
        scope.error = String(error.message || error).slice(0, 1000);
        scope.errorCode = 'spawn_failed';
      }
      throw error;
    }
    job.child = child;
    job.lastActivityAt = Date.now();
    this.persist(job, { force: true });
    const onMessage = (message) => this.handleEvent(job, message);
    if (typeof child.on === 'function') child.on('message', onMessage);
    const consume = (stream, label) => {
      let buffered = '';
      stream?.setEncoding?.('utf8');
      stream?.on('data', (chunk) => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() || '';
        for (const line of lines) this.record(job, line, label);
      });
      stream?.on('end', () => {
        if (buffered) this.record(job, buffered, label);
      });
    };
    consume(child.stdout, 'stdout');
    consume(child.stderr, 'stderr');
    this.startWatchdog(job);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (returnCode, signal) => resolve({ returnCode: Number(returnCode ?? -1), signal }));
      });
    } finally {
      this.stopWatchdog(job);
      if (typeof child.off === 'function') child.off('message', onMessage);
      else if (typeof child.removeListener === 'function') child.removeListener('message', onMessage);
      job.child = null;
    }
    result.cancelled = job.cancelRequested;
    result.aborted = job.abortCode || null;
    result.snapshot = this.captureChildSnapshot(job, scope, watermark, result);
    this.persist(job, { force: true });
    return result;
  }

  baseArgs() {
    const args = [
      '--acknowledge-source-policy',
      '--db', this.dbPath,
      '--data-dir', this.dataDir,
      '--profile-dir', this.profileDir,
    ];
    if (this.headful) args.push('--headful');
    return args;
  }

  async execute(job) {
    if (job.cancelRequested) {
      this.finishJob(job, 'cancelled', '同步在启动前被停止');
      return;
    }
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job._startedAtMs = Date.now();
    job.lastActivityAt = Date.now();
    job.progressPercent = 5;
    this.persist(job, { force: true });
    if (job.runType === 'metadata') await this.executeMetadata(job);
    else await this.executeContent(job);
    if (job.cancelRequested) {
      this.finishJob(job, 'cancelled', '同步已停止');
      return;
    }
    if (job.abortCode) {
      const resumable = (job.scopeItems || []).some((scope) => scope.resumable === true);
      this.finishJob(job, resumable ? 'interrupted' : 'failed', job.abortMessage, job.abortCode);
      return;
    }
    if (job.partialInterrupted) {
      this.finishJob(
        job,
        'interrupted',
        job.partialMessage || '同步暂时中断，可使用 partial collectorRunId 续采',
        this.jobErrorCode(job, 'interrupted'),
      );
      return;
    }
    this.finishJob(job, 'completed', null);
  }

  async executeMetadata(job) {
    const watermark = metadataWatermark(this.dbPath);
    const result = await this.runChild(job, METADATA_SCRIPT, this.baseArgs());
    if (result.cancelled || result.aborted) {
      // A metadata child normally seals its own run in `finally`, but a
      // forced termination can happen before that block starts.  Resolve the
      // run created after this job's watermark before falling back to the
      // request's (usually null) metadataRunId.
      let run = null;
      try { run = metadataRunAfter(this.dbPath, watermark); } catch {}
      sealOrphanMetadataRun(
        this.dbPath,
        run?.status === 'running' ? run.id : job.metadataRunId,
        result.cancelled ? 'cancelled' : 'failed',
        result.cancelled ? '同步已停止' : job.abortMessage,
      );
      return;
    }
    if (result.returnCode !== 0) {
      let run = null;
      try { run = metadataRunAfter(this.dbPath, watermark); } catch {}
      const blocked = this.jobLooksBlocked(job);
      const message = this.jobErrorMessage(job, '版本和教材同步脚本执行失败');
      sealOrphanMetadataRun(
        this.dbPath,
        run?.status === 'running' ? run.id : job.metadataRunId,
        blocked ? 'blocked' : 'failed',
        message,
      );
      const error = new Error(message);
      error.blocked = blocked;
      error.code = this.jobErrorCode(job, 'metadata_script_failed');
      throw error;
    }
    const run = metadataRunAfter(this.dbPath, watermark);
    if (!run || Number(run.id) <= watermark || String(run.status || '') !== 'success') {
      if (run && String(run.status || '') === 'running') {
        sealOrphanMetadataRun(this.dbPath, run.id, this.jobLooksBlocked(job) ? 'blocked' : 'failed', '无法确认本次元数据运行已完成');
      }
      const error = new Error('无法确认本次元数据运行 ID');
      error.code = this.jobErrorCode(job, 'metadata_run_unconfirmed');
      throw error;
    }
    job.metadataRunId = Number(run.id);
    job.totalVersions = Number(run.version_count || 0);
    job.completedVersions = job.totalVersions;
    job.totalTextbooks = Number(run.textbook_count || 0);
    job.completedTextbooks = job.totalTextbooks;
  }

  async executeContent(job) {
    // The job scope is captured at creation time.  Independent question jobs
    // must never be revalidated against the mutable metadata tables here.
    const textbooks = (job.scopeItems || []).map((scope) => ({
      externalTextbookId: String(scope.externalTextbookId || '').trim(),
      textbookName: String(scope.textbookName || scope.externalTextbookId || '').trim(),
      versionExternalId: scope.externalVersionId || null,
      bootstrapChapterExternalId: scope.bootstrapChapterExternalId || null,
    }));
    if (!textbooks.length) throw new Error('内容任务缺少固化教材范围');
    job.totalTextbooks = textbooks.length;
    for (const textbook of textbooks) {
      if (job.cancelRequested || job.abortCode) return;
      const scope = this.scopeFor(job, textbook.externalTextbookId);
      job.currentTextbookId = textbook.externalTextbookId;
      job.currentTextbookName = textbook.textbookName;
      if (scope) {
        scope.textbookName = textbook.textbookName;
        scope.status = 'running';
        scope.error = null;
        scope.errorCode = null;
        scope.startedAt = scope.startedAt || new Date().toISOString();
        scope.finishedAt = null;
      }
      this.persist(job, { force: true });
      const childArgs = [
        ...this.baseArgs(),
        '--textbook-id', textbook.externalTextbookId,
        '--chapter-id', textbook.bootstrapChapterExternalId || textbook.externalTextbookId,
      ];
      // Keep the collector strategy owned by this manager.  The API's page
      // cap is an existing bounded contract; only a resume source changes the
      // checkpoint switch passed to the child.
      if (job.maxPages < SITE_PAGE_LIMIT) childArgs.push('--max-pages', String(job.maxPages));
      childArgs.push(...crawlTuningArgs(this.crawlTuning));
      if (scope?.resumeFromCollectorRunId != null) {
        childArgs.push('--resume-run-id', String(scope.resumeFromCollectorRunId));
      } else {
        childArgs.push('--no-resume');
      }
      const result = await this.runChild(job, QUESTION_SCRIPT, childArgs, scope);
      if (result.snapshot) {
        job.catalogCount += Number(result.snapshot.catalogCount || 0);
        job.questionCount += Number(result.snapshot.questionCount || 0);
        job.questionCatalogCount += Number(result.snapshot.questionCatalogCount || 0);
        job.questionTagCount += Number(result.snapshot.questionTagCount || 0);
        job.questionAssetCount += Number(result.snapshot.questionAssetCount || 0);
      } else {
        job.catalogCount += Number(job._scriptCatalogCount || 0);
        job.questionCount += Number(job._scriptQuestionCount || 0);
      }
      if (result.cancelled) {
        if (scope) {
          scope.status = 'cancelled';
          scope.error = scope.error || '同步已停止';
        }
        return;
      }
      if (result.aborted) {
        if (scope) {
          const resumable = isResumablePartialRun(result.snapshot);
          scope.status = resumable ? 'interrupted' : 'failed';
          scope.resumable = resumable;
          scope.error = job.abortMessage;
          scope.errorCode = job.abortCode;
          scope.finishedAt = scope.finishedAt || new Date().toISOString();
        }
        return 'aborted';
      }
      const snapshotStatus = String(result.snapshot?.status || '').trim();
      const snapshotComplete = result.snapshot?.snapshotComplete === true
        || Number(result.snapshot?.snapshot_complete || 0) === 1;
      const scanComplete = result.snapshot?.scanComplete === true
        || Number(result.snapshot?.scan_complete || 0) === 1
        || snapshotComplete;
      const resumablePartial = isResumablePartialRun(result.snapshot);
      if (resumablePartial) {
        if (scope) {
          scope.status = 'interrupted';
          scope.resumable = true;
          scope.error = scope.error || scopeErrorText(
            result.snapshot,
            this.jobErrorMessage(job, `教材 ${textbook.textbookName} 采集暂时中断，可使用 collectorRunId 续采`),
          );
          scope.errorCode = scope.errorCode || this.jobErrorCode(job, 'interrupted');
        }
        job.partialInterrupted = true;
        job.partialMessage = scope?.error || `教材 ${textbook.textbookName} 采集暂时中断`;
        return 'interrupted';
      }
      const snapshotFailed = !result.snapshot
        || !['success', 'completed'].includes(snapshotStatus)
        || (!snapshotComplete && !scanComplete);
      if (result.returnCode !== 0 || snapshotFailed) {
        const blocked = snapshotStatus === 'blocked' || this.jobLooksBlocked(job);
        const fallback = `教材 ${textbook.textbookName} 同步失败或快照不完整`;
        // The child's structured error is authoritative; the run summary
        // message and log tail are fallbacks only (COL-004).
        const message = job.lastErrorEvent?.message
          ? this.jobErrorMessage(job, fallback)
          : scopeErrorText(result.snapshot, lastError(job.lines, fallback));
        if (scope) {
          scope.status = blocked ? 'blocked' : 'failed';
          scope.error = scope.error || message;
          scope.errorCode = scope.errorCode || this.jobErrorCode(job, blocked ? 'blocked' : 'snapshot_incomplete');
        }
        const error = new Error(message);
        error.blocked = blocked;
        error.code = scope?.errorCode || this.jobErrorCode(job, blocked ? 'blocked' : 'snapshot_incomplete');
        throw error;
      }
      if (scope) {
        scope.status = 'completed';
        scope.error = null;
        scope.errorCode = null;
      }
      job.completedTextbooks += 1;
      job.progressPercent = Math.min(99, Math.round((5 + (job.completedTextbooks / job.totalTextbooks) * 94) * 10) / 10);
      this.persist(job, { force: true });
    }
  }
}

module.exports = { ExecutionMethods };

