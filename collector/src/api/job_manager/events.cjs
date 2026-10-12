'use strict';

/**
 * CollectorJobManager mixin: consumption of structured child events and the
 * log-text fallbacks used when a child died without reporting.
 */

const { normalizeEvent, parseEventLine } = require('../../jobs/events.cjs');
const { lastError, looksBlocked } = require('../orphan_runs.cjs');
const { BLOCKED_ERROR_CODES, MAX_LOG_LINES, TERMINAL_STATUSES } = require('./constants.cjs');

class EventMethods {
  /**
   * Free-text child output is diagnostic only: it feeds logTail and counts as
   * liveness.  All state comes from structured events (`handleEvent`).
   */
  record(job, rawLine, label = 'stdout') {
    const line = String(rawLine || '').trim();
    if (!line) return;
    const event = label === 'stdout' ? parseEventLine(line) : null;
    if (event) {
      this.handleEvent(job, event);
      return;
    }
    const rendered = label === 'stderr' ? `[stderr] ${line}` : line;
    job.lines.push(rendered);
    if (job.lines.length > MAX_LOG_LINES) job.lines.splice(0, job.lines.length - MAX_LOG_LINES);
    job.lastActivityAt = Date.now();
  }

  handleEvent(job, rawEvent) {
    const event = normalizeEvent(rawEvent);
    if (!event || !job || TERMINAL_STATUSES.has(String(job.status))) return;
    job.lastActivityAt = Date.now();
    const scope = this.scopeFor(job, job.currentTextbookId);
    switch (event.type) {
      case 'run_created': {
        if (event.runType === 'metadata') {
          job.metadataRunId = Number(event.runId) || job.metadataRunId;
          break;
        }
        job._childRunId = Number(event.runId) || null;
        const target = scope || (event.textbookExternalId ? this.scopeFor(job, event.textbookExternalId) : null);
        if (target && job._childRunId) {
          target.collectorRunId = job._childRunId;
          if (job.scopeItems.length === 1) job.collectorRunId = job._childRunId;
        }
        job.waitingReason = null;
        job.waitingSince = null;
        this.persist(job, { force: true });
        return;
      }
      case 'metadata_run_created':
        job.metadataRunId = Number(event.runId) || job.metadataRunId;
        this.persist(job, { force: true });
        return;
      case 'metadata_summary':
        if (event.versionCount != null) job.totalVersions = Math.max(job.totalVersions || 0, event.versionCount);
        if (event.textbookCount != null) job.totalTextbooks = Math.max(job.totalTextbooks || 0, event.textbookCount);
        break;
      case 'progress': {
        if (scope) {
          if (event.catalogCount != null)
            job._scriptCatalogCount = Math.max(job._scriptCatalogCount || 0, event.catalogCount);
          if (event.questionsSeen != null)
            job._scriptQuestionCount = Math.max(job._scriptQuestionCount || 0, event.questionsSeen);
          if (event.pagesOk != null) scope.pagesOk = event.pagesOk;
          if (event.questionsSeen != null) scope.questionsSeen = event.questionsSeen;
          if (event.assetsDownloaded != null) scope.assetsDownloaded = event.assetsDownloaded;
          if (event.errors != null) scope.errorCount = event.errors;
          if (event.catalogCount != null)
            scope.catalogCount = Math.max(Number(scope.catalogCount || 0), event.catalogCount);
          if (event.runId && !scope.collectorRunId) {
            scope.collectorRunId = event.runId;
            if (job.scopeItems.length === 1) job.collectorRunId = event.runId;
          }
        }
        job.waitingReason = null;
        job.waitingSince = null;
        break;
      }
      case 'heartbeat':
        if (event.stage === 'browser_recycled') {
          job.browserRecycleCount = Number(job.browserRecycleCount || 0) + 1;
          if (this.metrics) this.metrics.browserRecycles += 1;
        }
        if (event.browserRssMb != null) {
          job.childBrowserRssMb = event.browserRssMb;
          job.childBrowserRssPeakMb = Math.max(Number(job.childBrowserRssPeakMb || 0), event.browserRssMb);
        }
        if (event.rssMb != null) {
          job.childRssMb = event.rssMb;
          job.childRssPeakMb = Math.max(Number(job.childRssPeakMb || 0), event.rssMb);
          if (this.childMaxRssMb > 0 && event.rssMb > this.childMaxRssMb) {
            this.abortJob(
              job,
              'memory_limit',
              `采集子进程内存 ${event.rssMb}MB 超过上限 ${this.childMaxRssMb}MB，已停止并封存为可续采`,
            );
            return;
          }
        }
        break;
      case 'verification_wait':
        job.waitingReason = event.reason || 'verification';
        job.waitingSince = job.waitingSince || event.at;
        if (scope) scope.waitingReason = job.waitingReason;
        break;
      case 'error':
        job.lastErrorEvent = {
          code: event.code,
          message: event.message,
          recoverable: event.recoverable === true,
          blocked: event.blocked === true || BLOCKED_ERROR_CODES.has(String(event.code || '')),
          stage: event.stage || null,
          runId: event.runId || null,
          failedPages: event.failedPages || [],
          at: event.at,
        };
        if (scope) {
          scope.errorCode = event.code;
          scope.error = scope.error || event.message;
        }
        this.persist(job, { force: true });
        return;
      case 'sealed':
        if (scope && event.runId && !scope.collectorRunId) scope.collectorRunId = event.runId;
        if (scope) {
          scope.sealedStatus = event.status || null;
          if (event.counts) {
            if (event.counts.pagesOk != null) scope.pagesOk = event.counts.pagesOk;
            if (event.counts.questionsSeen != null) scope.questionsSeen = event.counts.questionsSeen;
          }
        }
        this.persist(job, { force: true });
        return;
      default:
        return;
    }
    this.persist(job);
  }

  jobErrorMessage(job, fallback) {
    if (job?.lastErrorEvent?.message) return String(job.lastErrorEvent.message).slice(0, 1000);
    return lastError(job?.lines || [], fallback);
  }

  jobLooksBlocked(job) {
    if (job?.lastErrorEvent) return job.lastErrorEvent.blocked === true;
    return looksBlocked(job?.lines || []);
  }

  jobErrorCode(job, fallback = null) {
    return job?.lastErrorEvent?.code || fallback;
  }
}

module.exports = { EventMethods };
