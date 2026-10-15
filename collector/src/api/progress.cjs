'use strict';

/**
 * Public job projection: the bounded JSON the service polls, plus the
 * multi-textbook live progress aggregate.
 */

const { readLiveRunProgress } = require('../storage/readers/index.cjs');

const MAX_LOG_CHARS = 24000;
const MAX_LIVE_PROJECTION_SCOPES = 200;
const MAX_LIVE_PROJECTION_TREE_NODES = 3000;

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function clampPercent(value) {
  const number = finiteNonnegative(value);
  return number == null ? null : Math.min(100, number);
}

/**
 * Aggregate per-textbook live progress into one task-level scalar.
 *
 * A textbook total is the strongest denominator, so entries with a known
 * total are weighted by that total.  Older/partially initialized runs may
 * expose only a percentage; those entries contribute one stable unit weight.
 * Completed scopes without a readable live row still contribute 100% once at
 * least one live projection exists.  If no scope can contribute, callers keep
 * their existing phase progress unchanged.
 */
function aggregateLiveProgress(scopeRecords, liveScopeValues, fallback = null) {
  const scopes = Array.isArray(scopeRecords) ? scopeRecords : [];
  const values = liveScopeValues instanceof Map ? liveScopeValues : new Map();
  const entries = scopes.map((scope) => {
    const key = String(scope?.externalTextbookId || scope?.collectorRunId || '');
    const projection = key ? values.get(key) : null;
    return { scope, projection: projection && projection.available !== false ? projection : null };
  });
  const hasLiveProjection = entries.some((entry) => entry.projection);
  let weightedProgress = 0;
  let totalWeight = 0;
  let liveEntries = 0;
  const add = (progress, weight = 1) => {
    const normalizedProgress = clampPercent(progress);
    const normalizedWeight = finiteNonnegative(weight);
    if (normalizedProgress == null || normalizedWeight == null || normalizedWeight <= 0) return false;
    weightedProgress += normalizedProgress * normalizedWeight;
    totalWeight += normalizedWeight;
    return true;
  };
  for (const { scope, projection } of entries) {
    if (projection) {
      const scanProgress = clampPercent(projection.progressPercent ?? projection.progress);
      if (projection.scanComplete === true || scanProgress === 100) {
        add(100, 1);
        liveEntries += 1;
        continue;
      }
      if (scanProgress != null) {
        add(scanProgress, 1);
        liveEntries += 1;
        continue;
      }
      const total = finiteNonnegative(
        projection.totalQuestionCount ?? projection.expectedQuestionCount ?? projection.textbookExpectedTotal,
      );
      const collected = finiteNonnegative(
        projection.collectedQuestionCount ?? projection.uniqueQuestionCount ?? projection.listSeenCount,
      );
      if (total != null) {
        add(total > 0 ? (collected == null ? 0 : (collected / total) * 100) : 100, total > 0 ? total : 1);
        liveEntries += 1;
        continue;
      }
    }
    // Once there is at least one live scope, terminal scope state is useful
    // evidence for scopes whose projection has not been opened yet.
    if (hasLiveProjection) {
      const status = String(scope?.status || '').toLowerCase();
      if (status === 'completed') {
        const completedWeight = finiteNonnegative(scope?.questionCount);
        add(100, completedWeight > 0 ? completedWeight : 1);
      } else if (['queued', 'running', 'cancelling', 'starting'].includes(status)) {
        // An active scope without a readable projection is still unfinished.
        // Include it as zero progress instead of letting a completed sibling
        // make the whole multi-textbook task appear complete.
        add(0, 1);
      }
    }
  }
  if (totalWeight <= 0 || liveEntries <= 0) {
    return { available: false, progressPercent: fallback };
  }
  return {
    available: true,
    progressPercent: Math.round((weightedProgress / totalWeight) * 10) / 10,
  };
}

/**
 * The live-progress reads a job status response needs, one per scope with a
 * collector run.  Keep the aggregate multi-textbook response bounded while
 * allowing the UI to switch to any selected scope: typical one-to-four-
 * textbook tasks receive the full ~220-node tree per scope; unusually large
 * selections receive a clearly marked, smaller projection.
 */
function liveProjectionRequests(scopes) {
  const records = Array.isArray(scopes) ? scopes : [];
  const maxNodes = Math.max(
    1,
    Math.min(
      1000,
      Math.floor(MAX_LIVE_PROJECTION_TREE_NODES / Math.max(1, Math.min(MAX_LIVE_PROJECTION_SCOPES, records.length))),
    ),
  );
  const requests = [];
  for (const scope of records.slice(0, MAX_LIVE_PROJECTION_SCOPES)) {
    const collectorRunId = Number(scope.collectorRunId || 0);
    if (!Number.isSafeInteger(collectorRunId) || collectorRunId < 1) continue;
    requests.push({
      collectorRunId,
      textbookExternalId: scope.externalTextbookId,
      maxNodes,
      scopeKey: String(scope.externalTextbookId || scope.collectorRunId),
    });
  }
  return requests;
}

/**
 * Same projection as publicJob(job, { dbPath }), with the live-progress
 * reads done through `readLive(collectorRunId, options)` (normally the
 * off-thread ReaderPool) instead of on the calling thread.
 */
async function publicJobAsync(job, readLive) {
  const requests = liveProjectionRequests(job.scopeItems || []);
  const liveProjections = new Map();
  await Promise.all(
    requests.map(async (request) => {
      try {
        const projection = await readLive(request.collectorRunId, {
          textbookExternalId: request.textbookExternalId,
          maxNodes: request.maxNodes,
        });
        if (projection) liveProjections.set(request.collectorRunId, projection);
      } catch {
        // best effort, as in publicJob
      }
    }),
  );
  return publicJob(job, { liveProjections });
}

function publicJob(job, options = {}) {
  const scopeRecords = (job.scopeItems || []).map((scope) => ({
    sourceProvider: scope.sourceProvider || null,
    externalVersionId: scope.externalVersionId || null,
    externalTextbookId: scope.externalTextbookId,
    versionName: scope.versionName || null,
    textbookName: scope.textbookName,
    bootstrapChapterExternalId: scope.bootstrapChapterExternalId || null,
    resumeFromCollectorRunId: scope.resumeFromCollectorRunId == null ? null : Number(scope.resumeFromCollectorRunId),
    collectorRunId: scope.collectorRunId == null ? null : Number(scope.collectorRunId),
    status: scope.status,
    catalogCount: Number(scope.catalogCount || 0),
    questionCount: Number(scope.questionCount || 0),
    questionCatalogCount: Number(scope.questionCatalogCount || 0),
    questionTagCount: Number(scope.questionTagCount || 0),
    questionAssetCount: Number(scope.questionAssetCount || 0),
    snapshotLockedAt: scope.snapshotLockedAt || null,
    snapshotComplete: scope.snapshotComplete === true,
    scanComplete: scope.scanComplete === true || scope.snapshotComplete === true,
    dataComplete: scope.dataComplete === true || scope.snapshotComplete === true,
    completionQuality: scope.completionQuality || null,
    pagesOk: Number(scope.pagesOk || 0),
    questionsSeen: Number(scope.questionsSeen || 0),
    questionsInserted: Number(scope.questionsInserted || 0),
    questionsUpdated: Number(scope.questionsUpdated || 0),
    detailsFetched: Number(scope.detailsFetched || 0),
    assetsDownloaded: Number(scope.assetsDownloaded || 0),
    errorCount: Number(scope.errorCount || 0),
    error: scope.error || null,
    errorCode: scope.errorCode || null,
    resumable: scope.resumable === true,
    // Service consumes errorMessage while older integrations consume error;
    // expose both aliases from the same bounded value.
    errorMessage: scope.error || null,
    waitingReason: scope.waitingReason || null,
    startedAt: scope.startedAt || null,
    finishedAt: scope.finishedAt || null,
  }));
  const primaryScope =
    scopeRecords.find(
      (scope) => job.currentTextbookId != null && String(scope.externalTextbookId) === String(job.currentTextbookId),
    ) ||
    scopeRecords.find((scope) => ['running', 'cancelling'].includes(scope.status)) ||
    scopeRecords.find((scope) => scope.collectorRunId != null) ||
    scopeRecords[0] ||
    null;
  const liveByScope = {};
  const liveScopeValues = new Map();
  for (const request of liveProjectionRequests(scopeRecords)) {
    let projection = null;
    if (options.liveProjections) {
      projection = options.liveProjections.get(request.collectorRunId) || null;
    } else if (options.dbPath) {
      try {
        projection = readLiveRunProgress(options.dbPath, request.collectorRunId, {
          textbookExternalId: request.textbookExternalId,
          maxNodes: request.maxNodes,
        });
      } catch {
        // Live progress is best effort.  A locked/corrupt snapshot must not
        // turn a normal job status request into a failed collector task.
        projection = null;
      }
    }
    if (!projection?.available) continue;
    projection = { ...projection, treeAvailable: projection.treeTruncated !== true };
    liveByScope[request.scopeKey] = projection;
    liveScopeValues.set(request.scopeKey, projection);
  }
  // Keep the canonical scope rows compact. Live trees are exposed through
  // the top-level projection and liveProgressByScope map, avoiding one large
  // tree copy inside every scope item.
  const scopes = scopeRecords;
  const primaryLive = primaryScope
    ? liveScopeValues.get(String(primaryScope.externalTextbookId || primaryScope.collectorRunId)) || null
    : null;
  const liveAggregate = aggregateLiveProgress(scopeRecords, liveScopeValues, job.progressPercent);
  const progressPercent = liveAggregate.available ? liveAggregate.progressPercent : job.progressPercent;
  const collectorRunId =
    job.collectorRunId != null
      ? Number(job.collectorRunId)
      : scopes.length === 1 && scopes[0].collectorRunId != null
        ? scopes[0].collectorRunId
        : null;
  return {
    id: job.id,
    runType: job.runType,
    status: job.status,
    phase: job.phase,
    metadataRunId: job.metadataRunId,
    collectorRunId,
    totalVersions: job.totalVersions,
    completedVersions: job.completedVersions,
    totalTextbooks: job.totalTextbooks,
    completedTextbooks: job.completedTextbooks,
    maxPages: job.maxPages,
    listConcurrency: job.listConcurrency ?? null,
    limitTo1000Pages: job.limitTo1000Pages === true,
    catalogPageLimit: job.catalogPageLimit ?? null,
    syncMode: job.syncMode || 'incremental',
    catalogCount: job.catalogCount,
    questionCount: job.questionCount,
    questionCatalogCount: Number(job.questionCatalogCount || 0),
    questionTagCount: Number(job.questionTagCount || 0),
    questionAssetCount: Number(job.questionAssetCount || 0),
    snapshotLockedAt: job.snapshotLockedAt || null,
    snapshotComplete: job.snapshotComplete === true,
    currentTextbookId: job.currentTextbookId,
    currentTextbookName: job.currentTextbookName,
    progressPercent,
    liveProgress: primaryLive,
    liveProgressByScope: liveByScope,
    logTail: (job.lines || []).join('\n').slice(-MAX_LOG_CHARS),
    errorMessage: job.errorMessage,
    errorCode: job.errorCode || null,
    waitingReason: job.waitingReason || null,
    waitingSince: job.waitingSince || null,
    childRssMb: job.childRssMb == null ? null : Number(job.childRssMb),
    childRssPeakMb: job.childRssPeakMb == null ? null : Number(job.childRssPeakMb),
    childBrowserRssMb: job.childBrowserRssMb == null ? null : Number(job.childBrowserRssMb),
    childBrowserRssPeakMb: job.childBrowserRssPeakMb == null ? null : Number(job.childBrowserRssPeakMb),
    browserRecycleCount: Number(job.browserRecycleCount || 0),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
    // `scopeItems` is the canonical name consumed by the service/UI.  Keep
    // the short aliases for older integrations that called this field
    // `scopes` or `textbookScopes`.
    scopeItems: scopes,
    scopes,
    textbookScopes: scopes,
    perTextbookScopes: scopes,
  };
}

module.exports = {
  MAX_LOG_CHARS,
  aggregateLiveProgress,
  clampPercent,
  finiteNonnegative,
  liveProjectionRequests,
  publicJob,
  publicJobAsync,
};
