'use strict';

/**
 * The seal phase of one question run: completeness verdict, the terminal
 * run row, and the structured `sealed` / `error` events the API manager
 * consumes.
 */

const { StopCrawlError, VerificationRequiredError } = require('../../shared/errors.cjs');

const MANUAL_PAUSE_CODES = new Set(['waiting_verification', 'challenge', 'http_401', 'http_403', 'http_405']);
const INTERRUPTED_CODES = new Set([
  'network_error',
  'navigation_error',
  'tree_network_error',
  'stop_requested',
  'browser_recycle_failed',
]);

/**
 * Terminal status of a run that threw.  `interrupted` and `blocked` are
 * resumable; `failed` is not.
 */
function failureStatus(error) {
  const code = String(error?.code || '');
  if (error instanceof VerificationRequiredError || code === 'waiting_verification') return 'blocked';
  if (INTERRUPTED_CODES.has(code) || /^http_(408|429|5\d\d)$/.test(code)) return 'interrupted';
  return error instanceof StopCrawlError ? 'blocked' : 'failed';
}

/** Seal a run whose crawl phase returned normally. */
function sealCompleted({ store, events, runId, scope, selectedCatalogs, counters, message = null }) {
  const completeness = store.validateRunCompleteness(runId, scope, selectedCatalogs, counters);
  let status = 'success';
  if (completeness.scanComplete) status = 'success';
  else if (!completeness.complete) status = 'interrupted';
  store.finishRun(runId, status, counters, message, { ...completeness, scope });
  events.emit('sealed', {
    runId,
    status,
    snapshotComplete: ['success', 'completed'].includes(status) && completeness.complete === true,
    scanComplete: completeness.scanComplete === true,
    dataComplete: completeness.dataComplete === true,
    completionQuality: completeness.completionQuality,
    message,
    counts: { ...counters },
  });
  return { runId, status, counters, completeness };
}

/**
 * Seal a run that threw.  Records the shared manual pause for source
 * protection, the run error, the terminal row (tolerating a run the API
 * manager already sealed), and emits `error` then `sealed`.  Marks the error
 * `eventEmitted` so the CLI does not report it twice; the caller rethrows.
 */
function sealFailed({ store, events, runId, scope, selectedCatalogs, counters, sourceControl }, error) {
  if (MANUAL_PAUSE_CODES.has(error.code)) {
    try {
      sourceControl.markManual(error.message);
    } catch (pauseError) {
      console.warn(`[暂停记录失败] ${pauseError.message}`);
    }
  }
  counters.errors += 1;
  const message = String(error.message || error);
  if (runId) {
    // Error persistence is diagnostic only. A damaged/old database must
    // never replace the original crawl failure with a secondary SQLite
    // error (for example, a missing sync_errors table).
    try {
      store.recordError(runId, 'run', error);
    } catch (recordErrorFailure) {
      console.error(`[错误记录失败] ${recordErrorFailure.message}`);
    }
  }
  const status = failureStatus(error);
  let completeness = null;
  if (runId) {
    completeness = store.validateRunCompleteness(runId, scope, selectedCatalogs, counters);
    try {
      store.finishRun(runId, status, counters, message, { ...completeness, scope });
    } catch (sealError) {
      // The API manager may already have sealed this run (shutdown/abort)
      // before the child reached its safe point; the immutable trigger then
      // rejects a second terminal write.  Keep the original error.
      console.warn(`[封存] 运行 ${runId} 已被封存，跳过重复写入：${sealError.message}`);
    }
  }
  events.emit('error', {
    runId,
    code: error.code || error.name || 'run_failed',
    message,
    recoverable: status === 'interrupted' || status === 'blocked',
    blocked: status === 'blocked',
    stage: 'run',
  });
  error.eventEmitted = true;
  if (runId) {
    events.emit('sealed', {
      runId,
      status,
      snapshotComplete: false,
      scanComplete: completeness?.scanComplete === true,
      dataComplete: completeness?.dataComplete === true,
      completionQuality: completeness?.completionQuality,
      message,
      counts: { ...counters },
    });
  }
  return status;
}

module.exports = {
  failureStatus,
  sealCompleted,
  sealFailed,
};
