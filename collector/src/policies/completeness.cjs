'use strict';

/**
 * Completeness vocabulary for one run (see docs/进度/采集端进度.md §3.4):
 *
 *   scanComplete      the determined page range was processed once
 *   dataComplete      required questions / relations / assets are all present
 *   completionQuality completed | completed_with_issues | null (scan unfinished)
 *   snapshotComplete  the run may be applied as a full replacement snapshot
 *
 * Pure functions; the store supplies the reasons it collected from SQLite.
 */

function completionQualityFor(scanComplete, dataComplete) {
  if (!scanComplete) return null;
  return dataComplete ? 'completed' : 'completed_with_issues';
}

function summarizeCompleteness({ scanReasons = [], dataReasons = [], counts = {}, progress = [] } = {}) {
  const scanComplete = scanReasons.length === 0;
  const dataComplete = dataReasons.length === 0;
  return {
    complete: scanComplete && dataComplete,
    scanComplete,
    dataComplete,
    completionQuality: completionQualityFor(scanComplete, dataComplete),
    snapshotComplete: scanComplete && dataComplete,
    reasons: [...scanReasons, ...dataReasons],
    scanReasons,
    dataReasons,
    counts,
    progress,
  };
}

/**
 * Decide the terminal row values for `sync_runs` from the requested status
 * and the completeness verdict.  A requested success whose scan did not
 * finish is downgraded to `interrupted` so it stays resumable and can never
 * be applied as a complete snapshot.
 */
function resolveFinalRunState(status, completeness) {
  const wantsSuccess = ['success', 'completed'].includes(String(status));
  const scanComplete = Boolean(completeness?.scanComplete);
  const dataComplete = Boolean(completeness?.complete) || (scanComplete && completeness?.dataComplete === true);
  let effectiveStatus;
  if (!wantsSuccess) effectiveStatus = String(status);
  else if (scanComplete) effectiveStatus = String(status);
  else effectiveStatus = 'interrupted';
  return {
    wantsSuccess,
    scanComplete,
    dataComplete,
    snapshotComplete: wantsSuccess && scanComplete && dataComplete,
    effectiveStatus,
    completionQuality: completionQualityFor(scanComplete, dataComplete),
  };
}

module.exports = {
  completionQualityFor,
  resolveFinalRunState,
  summarizeCompleteness,
};
