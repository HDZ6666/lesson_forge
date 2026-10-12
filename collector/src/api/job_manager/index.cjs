'use strict';

/**
 * CollectorJobManager: validates job requests, spawns the two allow-listed
 * collector scripts, consumes their structured events, persists job state to
 * SQLite (collector_jobs) and enforces cancel / timeout / stall handling.
 *
 * The class body holds construction, persistence and job creation; execution,
 * event handling and lifecycle live in sibling mixins.
 */

const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const {
  MAX_SELECTED_TEXTBOOKS,
  safeExternalId,
  validateMetadataSelection,
} = require('../../storage/readers/index.cjs');
const { ensureRunSnapshotSchema } = require('../../../lib/run_snapshots.cjs');
const { ensureMetadataSnapshotSchema } = require('../../storage/metadata_schema.cjs');
const { publicJob } = require('../progress.cjs');
const { JobStore, ownerIsLive, pidAlive, registerOwner } = require('../job_store.cjs');
const {
  PROVIDER,
  deploymentBoolean,
  intInRange,
  normalizeIndependentTextbookScopes,
  requestBoolean,
  validateIndependentResumeScopes,
} = require('../request_validation.cjs');
const { orphanRunIsResumable, sealOrphanContentRun, sealOrphanMetadataRun } = require('../orphan_runs.cjs');
const {
  ACTIVE_STATUSES,
  COLLECTOR_ROOT,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  MAX_STORED_JOBS,
  ORPHAN_HEARTBEAT_MS,
  PERSIST_INTERVAL_MS,
  SITE_PAGE_LIMIT,
} = require('./constants.cjs');
const { MAX_ASSET_CONCURRENCY, MAX_LIST_CONCURRENCY } = require('../../sources/zujuan/constants.cjs');
const { ExecutionMethods } = require('./execution.cjs');
const { EventMethods } = require('./events.cjs');
const { LifecycleMethods } = require('./lifecycle.cjs');
const { SourceControl } = require('../../policies/source_control.cjs');
const { SourceBudget } = require('../../policies/source_budget.cjs');
const { ResourceGuard } = require('../../policies/resource_guard.cjs');

function positiveDuration(value, fallback, name) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} 必须是大于 0 的毫秒数`);
  }
  return Math.floor(number);
}

/**
 * Optional crawl pacing overrides for the question script.  Each value is
 * validated here (bounds match the CLI) and passed through as the matching
 * CLI flag; `null` means "leave the CLI default".
 */
function resolveCrawlTuning(raw = {}) {
  const optional = (value, name, min, max) => (
    value == null || value === '' ? null : intInRange(value, name, min, max)
  );
  const tuning = {
    listConcurrency: optional(raw.listConcurrency, 'COLLECTOR_LIST_CONCURRENCY', 1, MAX_LIST_CONCURRENCY),
    assetConcurrency: optional(raw.assetConcurrency, 'COLLECTOR_ASSET_CONCURRENCY', 1, MAX_ASSET_CONCURRENCY),
    delayMinMs: optional(raw.delayMinMs, 'COLLECTOR_DELAY_MIN_MS', 0, 600000),
    delayMaxMs: optional(raw.delayMaxMs, 'COLLECTOR_DELAY_MAX_MS', 0, 600000),
  };
  if (tuning.delayMinMs != null && tuning.delayMaxMs != null && tuning.delayMaxMs < tuning.delayMinMs) {
    throw new Error('COLLECTOR_DELAY_MAX_MS 不能小于 COLLECTOR_DELAY_MIN_MS');
  }
  return tuning;
}

class CollectorJobManager {
  constructor(options = {}) {
    this.dbPath = path.resolve(options.dbPath || path.join(COLLECTOR_ROOT, 'data', 'zujuan.sqlite3'));
    this.dataDir = path.resolve(options.dataDir || path.join(COLLECTOR_ROOT, 'data', 'zujuan'));
    this.profileDir = path.resolve(options.profileDir || path.join(COLLECTOR_ROOT, '.cache', 'zujuan-sync-profile'));
    this.nodeBin = options.nodeBin || process.execPath;
    this.spawnImpl = options.spawnImpl || spawn;
    this.killGraceMs = positiveDuration(options.killGraceMs, 60000, 'killGraceMs');
    this.persistIntervalMs = positiveDuration(
      options.persistIntervalMs ?? process.env.COLLECTOR_PERSIST_INTERVAL_MS,
      PERSIST_INTERVAL_MS,
      'persistIntervalMs',
    );
    this.persistStats = { writes: 0, failures: 0 };
    // Headful is an operator/deployment setting only.  It is intentionally
    // read once here and never taken from a request payload.
    this.headful = deploymentBoolean(
      options.headful == null ? process.env.COLLECTOR_HEADFUL : options.headful,
      true,
    );
    // The API is often started independently of a crawl process.  Upgrade an
    // existing collector DB here so `/v1/runs/*` works immediately after a
    // deployment upgrade, including databases created by older collectors.
    // This is additive and preserves all existing candidate/run rows.
    ensureMetadataSnapshotSchema(this.dbPath);
    ensureRunSnapshotSchema(this.dbPath);
    this.sourceControl = new SourceControl(this.dbPath);
    this.sourceBudget = new SourceBudget(this.dbPath, options.sourceBudgetOptions);
    this.resourceGuard = new ResourceGuard({ ...options.resourceGuardOptions, paths: {
      database: path.dirname(this.dbPath), data: this.dataDir, profile: this.profileDir,
    } });
    this.jobTimeoutMs = positiveDuration(
      options.jobTimeoutMs ?? process.env.COLLECTOR_JOB_TIMEOUT_MS,
      DEFAULT_JOB_TIMEOUT_MS,
      'COLLECTOR_JOB_TIMEOUT_MS',
    );
    this.stallTimeoutMs = positiveDuration(
      options.stallTimeoutMs ?? process.env.COLLECTOR_STALL_TIMEOUT_MS,
      DEFAULT_STALL_TIMEOUT_MS,
      'COLLECTOR_STALL_TIMEOUT_MS',
    );
    // Crawl pacing is an operator setting (deployment env), never a request
    // field.  Unset values keep the child's own defaults so the CLI contract
    // stays the single source of truth.
    this.crawlTuning = resolveCrawlTuning({
      listConcurrency: options.listConcurrency ?? process.env.COLLECTOR_LIST_CONCURRENCY,
      assetConcurrency: options.assetConcurrency ?? process.env.COLLECTOR_ASSET_CONCURRENCY,
      delayMinMs: options.delayMinMs ?? process.env.COLLECTOR_DELAY_MIN_MS,
      delayMaxMs: options.delayMaxMs ?? process.env.COLLECTOR_DELAY_MAX_MS,
    });
    // Memory guard for the crawler child (reported via heartbeat events).
    // 0 disables it.  A leak that reaches this limit stops the crawl as a
    // resumable interrupt instead of swapping the whole host.
    const maxRss = options.childMaxRssMb ?? process.env.COLLECTOR_CHILD_MAX_RSS_MB;
    this.childMaxRssMb = maxRss == null || maxRss === '' ? 0 : intInRange(maxRss, 'COLLECTOR_CHILD_MAX_RSS_MB', 0, 65536);
    this.ownerToken = randomUUID();
    this.owner = { pid: process.pid, token: this.ownerToken };
    registerOwner(this.ownerToken);
    this.store = options.store === null ? null : (options.store || new JobStore(this.dbPath));
    this.jobs = new Map();
    this.activeJobId = null;
    this.disposed = false;
    this.recoverOrphanJobs();
    this.loadRecentJobs();
  }

  get activeJob() {
    return this.activeJobId ? this.jobs.get(this.activeJobId) || null : null;
  }

  get(id) {
    const key = String(id);
    const inMemory = this.jobs.get(key);
    if (inMemory) return inMemory;
    if (!this.store) return null;
    try {
      const persisted = this.store.load(key);
      if (persisted) this.jobs.set(key, persisted);
      return persisted;
    } catch {
      return null;
    }
  }

  /**
   * Persist the current job state.  Progress events arrive many times per
   * second while paging; throttle those writes and always write on demand.
   */
  persist(job, { force = false } = {}) {
    if (!this.store || !job) return;
    const now = Date.now();
    const interval = this.persistIntervalMs;
    if (!force && job._persistedAt && now - job._persistedAt < interval) {
      job._persistDirty = true;
      // Trailing write so the last progress before a quiet spell still
      // reaches SQLite within one interval instead of waiting for the next
      // event or the watchdog heartbeat.
      if (!job._persistTimer) {
        job._persistTimer = setTimeout(() => {
          job._persistTimer = null;
          if (job._persistDirty) this.persist(job, { force: true });
        }, interval - (now - job._persistedAt));
        job._persistTimer.unref?.();
      }
      return;
    }
    if (job._persistTimer) {
      clearTimeout(job._persistTimer);
      job._persistTimer = null;
    }
    try {
      this.store.save(job, this.owner);
      job._persistedAt = now;
      job._persistDirty = false;
      this.persistStats.writes += 1;
    } catch (error) {
      // Persistence is a durability layer over the in-memory job.  A locked
      // SQLite must never turn a running crawl into a failed API request.
      job._persistDirty = true;
      job._persistError = String(error?.message || error);
      this.persistStats.failures += 1;
    }
  }

  loadRecentJobs() {
    if (!this.store) return;
    try {
      for (const job of this.store.loadRecent(MAX_STORED_JOBS)) {
        if (!this.jobs.has(job.id)) this.jobs.set(job.id, job);
      }
    } catch {}
  }

  /**
   * Startup recovery: jobs left active by a previous process (or a disposed
   * manager) become terminal so the mutex slot is free and the service reads
   * a durable answer instead of a 404.  Jobs owned by a live manager are left
   * untouched so the unique slot still yields 409 for concurrent starts.
   */
  recoverOrphanJobs() {
    if (!this.store) return [];
    let rows = [];
    try { rows = this.store.findActive(); } catch { return []; }
    const recovered = [];
    for (const job of rows) {
      if (job.ownerToken && ownerIsLive(job.ownerToken)) continue;
      const heartbeatMs = Date.parse(job.heartbeatAt || '') || 0;
      const heartbeatFresh = heartbeatMs > 0 && Date.now() - heartbeatMs < ORPHAN_HEARTBEAT_MS;
      if (job.ownerPid && job.ownerPid !== process.pid && pidAlive(job.ownerPid) && heartbeatFresh) continue;
      const message = '采集服务重启，任务未能继续执行';
      let resumable = false;
      // The previous API process is gone but its detached crawler may still be
      // running and writing into a run we are about to seal.  Stop that
      // process group; only when the recorded owner is dead, so a reused pid
      // in a live deployment is never signalled by mistake.
      const ownerDead = !job.ownerPid || job.ownerPid === process.pid || !pidAlive(job.ownerPid);
      if (ownerDead && job.childPid && job.childPid !== process.pid && pidAlive(job.childPid)) {
        try {
          if (process.platform === 'win32') process.kill(job.childPid, 'SIGTERM');
          else process.kill(-job.childPid, 'SIGTERM');
          job.lines = job.lines || [];
          job.lines.push(`[stderr] [恢复] 已向遗留采集子进程组 ${job.childPid} 发送 SIGTERM`);
        } catch {
          try { process.kill(job.childPid, 'SIGTERM'); } catch {}
        }
      }
      for (const scope of job.scopeItems || []) {
        if (!['running', 'cancelling', 'queued'].includes(String(scope.status || ''))) continue;
        const runId = Number(scope.collectorRunId || 0);
        let scopeResumable = false;
        if (runId > 0) {
          scopeResumable = orphanRunIsResumable(this.dbPath, runId);
          sealOrphanContentRun(this.dbPath, runId, scopeResumable ? 'interrupted' : 'failed', message);
        }
        scope.status = runId > 0 ? (scopeResumable ? 'interrupted' : 'failed') : 'cancelled';
        scope.resumable = scopeResumable;
        scope.error = scope.error || message;
        scope.errorCode = 'collector_restarted';
        scope.finishedAt = scope.finishedAt || new Date().toISOString();
        resumable = resumable || scopeResumable;
      }
      if (job.runType === 'metadata' && job.metadataRunId) {
        sealOrphanMetadataRun(this.dbPath, job.metadataRunId, 'failed', message);
      }
      job.child = null;
      job.lines = job.lines || [];
      job.lines.push(`[stderr] [错误] ${message}`);
      this.finishJob(job, resumable ? 'interrupted' : 'failed', message, 'collector_restarted');
      this.jobs.set(job.id, job);
      recovered.push(job);
    }
    return recovered;
  }

  start(payload = {}) {
    if(this.manualRecovery?.active) {const error=new Error('管理员正在处理来源验证，等待浏览器交回');error.statusCode=409;throw error;}
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('请求体必须是 JSON 对象');
    }
    if (this.disposed || this.stopping) {
      const error = new Error('采集器任务管理器已关闭');
      error.statusCode = 503;
      throw error;
    }
    if (payload.acknowledgeSourcePolicy !== true) {
      throw new Error('开始同步前必须确认已核对来源站规则、授权范围和内容使用边界');
    }
    const runType = String(payload.runType || '');
    if (!['metadata', 'content'].includes(runType)) throw new Error('不支持的同步任务类型');
    const maxPages = intInRange(payload.maxPages ?? SITE_PAGE_LIMIT, 'maxPages', 1, SITE_PAGE_LIMIT);
    const workflowVersion = intInRange(payload.workflowVersion ?? 2, 'workflowVersion', 1, 2);
    const requestedId = payload.jobId == null ? null : String(payload.jobId).toLowerCase();
    if (requestedId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestedId)) {
      throw new Error('jobId 必须是 UUID');
    }
    if (payload.sourceNamespace != null && payload.sourceNamespace !== 'zujuan:junior:math') {
      throw new Error('该来源学段学科的采集适配尚未验证');
    }
    const listConcurrency = payload.listConcurrency == null ? null : payload.listConcurrency;
    if (listConcurrency !== null && (runType !== 'content' || !Number.isInteger(listConcurrency) || listConcurrency < 1 || listConcurrency > MAX_LIST_CONCURRENCY)) {
      throw new Error('listConcurrency 仅接受题目任务的 1 到 16 整数');
    }
    const limitTo1000Pages = requestBoolean(payload.limitTo1000Pages, 'limitTo1000Pages', false);
    const hasIndependentScopes = runType === 'content'
      && Object.prototype.hasOwnProperty.call(payload, 'textbookScopes');
    if (runType === 'content'
      && Object.prototype.hasOwnProperty.call(payload, 'resumeFromCollectorRunId')) {
      throw new Error('resumeFromCollectorRunId 必须随 textbookScopes[ ] 按教材提供');
    }
    let metadataRunId = null;
    let textbookExternalIds = [];
    let validatedTextbooks = [];
    let independentScopes = [];
    if (runType === 'content') {
      if (hasIndependentScopes) {
        const normalized = normalizeIndependentTextbookScopes(payload);
        textbookExternalIds = normalized.textbookExternalIds;
        independentScopes = normalized.scopes;
      } else {
        metadataRunId = intInRange(payload.metadataRunId, 'metadataRunId', 1, Number.MAX_SAFE_INTEGER);
        textbookExternalIds = (Array.isArray(payload.textbookExternalIds)
          ? payload.textbookExternalIds
          : [])
          .map((value) => String(value == null ? '' : value).trim());
        if (!textbookExternalIds.length || textbookExternalIds.length > MAX_SELECTED_TEXTBOOKS) {
          throw new Error(`教材选择数量必须在 1 到 ${MAX_SELECTED_TEXTBOOKS} 之间`);
        }
        if (workflowVersion === 2 && textbookExternalIds.length !== 1) {
          throw new Error('新同步任务必须且只能选择一本教材');
        }
        if (new Set(textbookExternalIds).size !== textbookExternalIds.length) throw new Error('教材选择列表不能包含重复 ID');
        if (textbookExternalIds.some((value) => !safeExternalId(value))) throw new Error('教材来源 ID 不安全');
        validatedTextbooks = validateMetadataSelection(
          this.dbPath,
          metadataRunId,
          textbookExternalIds,
        ).textbooks;
      }
    }
    const requestDigest = createHash('sha256').update(JSON.stringify({
      runType, workflowVersion, maxPages, limitTo1000Pages, metadataRunId,
      textbookExternalIds, independentScopes, sourceNamespace: 'zujuan:junior:math',
      ...(listConcurrency == null ? {} : { listConcurrency }),
    })).digest('hex');
    const replay = () => {
      if (!requestedId) return null;
      // Read the store first: another manager may have advanced the job.
      const previous = this.store?.load(requestedId) || this.jobs.get(requestedId);
      const digest = this.store?.requestDigest(requestedId) || previous?.requestDigest;
      if (!previous && !digest) return null;
      if (digest !== requestDigest || !previous) {
        const error = new Error(previous ? 'jobId 已绑定不同采集范围' : '派发记录已归档，请核对原任务，不能重复启动');
        error.statusCode = 409;
        error.code = previous ? 'job_identity_conflict' : 'job_request_expired';
        throw error;
      }
      return publicJob(previous);
    };
    const existing = replay();
    if (existing) return existing;
    this.sourceControl.assertAllowed();
    this.sourceBudget.assertCanStart(runType);
    this.resourceGuard.assertAllowed();
    if (this.activeJob && ACTIVE_STATUSES.has(this.activeJob.status)) {
      const error = new Error('采集器已有任务正在运行');
      error.statusCode = 409;
      error.code = 'job_conflict';
      throw error;
    }
    if (hasIndependentScopes) {
      validateIndependentResumeScopes(this.dbPath, independentScopes, maxPages, limitTo1000Pages);
    }
    const job = {
      id: requestedId || randomUUID(),
      requestDigest: requestedId ? requestDigest : null,
      listConcurrency: runType === 'content' ? listConcurrency ?? this.crawlTuning.listConcurrency : null,
      runType,
      workflowVersion,
      sourceNamespace: 'zujuan:junior:math',
      status: 'queued',
      phase: runType === 'metadata' ? 'metadata' : 'catalogs_questions',
      metadataRunId,
      collectorRunId: null,
      textbookExternalIds,
      scopeItems: runType === 'content'
        ? textbookExternalIds.map((externalTextbookId, index) => {
          const independent = independentScopes[index];
          const textbook = validatedTextbooks.find(
            (item) => item.externalTextbookId === externalTextbookId,
          );
          return {
            sourceProvider: independent?.sourceProvider || PROVIDER,
            externalVersionId: independent?.externalVersionId || textbook?.versionExternalId || null,
            versionName: independent?.versionName || null,
            externalTextbookId,
            textbookName: independent?.textbookName || textbook?.textbookName || externalTextbookId,
            bootstrapChapterExternalId: independent?.bootstrapChapterExternalId
              || textbook?.bootstrapChapterExternalId || null,
            resumeFromCollectorRunId: independent?.resumeFromCollectorRunId == null
              ? null : Number(independent.resumeFromCollectorRunId),
            collectorRunId: null,
            status: 'queued',
            catalogCount: 0,
            questionCount: 0,
            questionCatalogCount: 0,
            questionTagCount: 0,
            questionAssetCount: 0,
            snapshotLockedAt: null,
            snapshotComplete: false,
            pagesOk: 0,
            questionsSeen: 0,
            questionsInserted: 0,
            questionsUpdated: 0,
            detailsFetched: 0,
            assetsDownloaded: 0,
            errorCount: 0,
            error: null,
            errorCode: null,
            resumable: false,
            startedAt: null,
            finishedAt: null,
          };
        })
        : [],
      maxPages,
      limitTo1000Pages,
      totalVersions: 0,
      completedVersions: 0,
      totalTextbooks: textbookExternalIds.length,
      completedTextbooks: 0,
      catalogCount: 0,
      questionCount: 0,
      questionCatalogCount: 0,
      questionTagCount: 0,
      questionAssetCount: 0,
      snapshotLockedAt: null,
      snapshotComplete: false,
      currentTextbookId: null,
      currentTextbookName: null,
      progressPercent: 0,
      errorMessage: null,
      errorCode: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      partialInterrupted: false,
      partialMessage: null,
      abortCode: null,
      abortMessage: null,
      lastErrorEvent: null,
      waitingReason: null,
      waitingSince: null,
      child: null,
      lines: [],
    };
    // Durable mutex: the unique active_slot rejects a second active job even
    // when it belongs to another manager or process.
    if (this.store) {
      try {
        this.store.insertActive(job, this.owner);
      } catch (error) {
        // Concurrent insert of the same UUID returns its durable result.
        const concurrent = replay();
        if (concurrent) return concurrent;
        throw error;
      }
    }
    this.jobs.set(job.id, job);
    this.activeJobId = job.id;
    this.trimJobs();
    job.execution = Promise.resolve().then(() => this.execute(job)).catch((error) => this.failJob(job, error));
    return publicJob(job);
  }

  trimJobs() {
    if (this.jobs.size <= MAX_STORED_JOBS) return;
    for (const [id, job] of this.jobs) {
      if (id === this.activeJobId || ACTIVE_STATUSES.has(job.status)) continue;
      this.jobs.delete(id);
      if (this.jobs.size <= MAX_STORED_JOBS) break;
    }
  }

  scopeFor(job, externalTextbookId) {
    return (job.scopeItems || []).find(
      (scope) => String(scope.externalTextbookId) === String(externalTextbookId),
    ) || null;
  }
}

function mixin(Target, Source) {
  for (const name of Object.getOwnPropertyNames(Source.prototype)) {
    if (name === 'constructor') continue;
    Object.defineProperty(Target.prototype, name, Object.getOwnPropertyDescriptor(Source.prototype, name));
  }
}

mixin(CollectorJobManager, ExecutionMethods);
mixin(CollectorJobManager, EventMethods);
mixin(CollectorJobManager, LifecycleMethods);

module.exports = { CollectorJobManager };
