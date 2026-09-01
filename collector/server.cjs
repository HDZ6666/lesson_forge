#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const {
  MAX_SELECTED_TEXTBOOKS,
  contentRunAfter,
  contentRunWatermark,
  metadataRunAfter,
  metadataWatermark,
  readCandidates,
  readCatalogProgress,
  readMetadataSnapshot,
  readRunAsset,
  readRunCatalogs,
  readRunQuestion,
  readRunQuestions,
  readRunSnapshot,
  readRunSnapshotPage,
  readRunSnapshotSummary,
  safeExternalId,
  validateMetadataSelection,
} = require('./lib/api_store.cjs');
const { ensureRunSnapshotSchema } = require('./lib/run_snapshots.cjs');
const { ensureMetadataSnapshotSchema } = require('./zujuan_metadata_sync.cjs');
const {
  isResumablePartialRun,
  isTransientResumeError,
  validateResumeSourceRun,
} = require('./zujuan_sync.cjs');

const COLLECTOR_ROOT = __dirname;
const METADATA_SCRIPT = path.join(COLLECTOR_ROOT, 'zujuan_metadata_sync.cjs');
const QUESTION_SCRIPT = path.join(COLLECTOR_ROOT, 'zujuan_sync.cjs');
const PROVIDER = 'zujuan';
const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancelling']);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_LINES = 160;
const MAX_LOG_CHARS = 24000;
const MAX_STORED_JOBS = 100;
const SITE_PAGE_LIMIT = 1000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SCOPE_NAME_LENGTH = 200;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'blocked', 'interrupted', 'cancelled']);

function deploymentBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new Error('COLLECTOR_HEADFUL 必须是 true/false');
}

function scopeErrorText(summary, fallback = null) {
  if (!summary) return fallback;
  const first = Array.isArray(summary.errors) && summary.errors.length > 0
    ? summary.errors[0].message
    : null;
  return String(summary.message || first || fallback || '').slice(0, 1000) || null;
}

function intInRange(value, name, min, max) {
  if (typeof value === 'boolean' || (typeof value !== 'string' && typeof value !== 'number')) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return parsed;
}

function normalizeScopeExternalId(value, name) {
  if (value == null || typeof value === 'boolean'
    || (typeof value !== 'string' && typeof value !== 'number')) {
    throw new Error(`${name} 格式不安全`);
  }
  const normalized = String(value).trim();
  if (!safeExternalId(normalized)) throw new Error(`${name} 格式不安全`);
  return normalized;
}

function normalizeScopeName(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SCOPE_NAME_LENGTH
    || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${name} 长度或格式不安全`);
  }
  return normalized;
}

function serverContentScope(scope, maxPages) {
  const textbookId = String(scope.externalTextbookId || '').trim();
  const chapterId = String(scope.bootstrapChapterExternalId || textbookId).trim();
  return {
    chapterIds: chapterId ? [chapterId] : [],
    textbookId,
    catalogLevels: [1, 2, 3],
    catalogIds: [],
    allCatalogs: true,
    withinChapterIds: [],
    filters: {
      scene: null,
      questionType: null,
      difficulty: null,
      category: null,
      year: null,
      fresh: false,
      sort: { id: 2, name: '最新' },
    },
    startPage: 1,
    maxPages: Number(maxPages),
    details: false,
    detailFallback: true,
    refreshDetails: false,
    includeVisibleSolutions: false,
    downloadAssets: true,
    requireDetails: false,
    requireAssets: true,
    limit: 0,
    truncated: false,
  };
}

function validateIndependentResumeScopes(dbPath, scopes, maxPages) {
  for (const scope of scopes || []) {
    if (scope.resumeFromCollectorRunId == null) continue;
    const expected = serverContentScope(scope, maxPages);
    try {
      validateResumeSourceRun(dbPath, scope.resumeFromCollectorRunId, expected);
    } catch (error) {
      const wrapped = new Error(
        `教材 ${scope.externalTextbookId} 的续采来源无效：${String(error.message || error)}`,
      );
      wrapped.code = error.code || 'resume_source_invalid';
      wrapped.statusCode = Number(error.statusCode || 400);
      throw wrapped;
    }
  }
}

function normalizeIndependentTextbookScopes(payload) {
  if (!Array.isArray(payload.textbookScopes)) {
    throw new Error('textbookScopes 必须是数组');
  }
  if (!payload.textbookScopes.length || payload.textbookScopes.length > MAX_SELECTED_TEXTBOOKS) {
    throw new Error(`教材范围数量必须在 1 到 ${MAX_SELECTED_TEXTBOOKS} 之间`);
  }
  if (!Array.isArray(payload.textbookExternalIds)) {
    throw new Error('使用 textbookScopes 时必须提供 textbookExternalIds 数组');
  }
  if (payload.textbookExternalIds.length !== payload.textbookScopes.length) {
    throw new Error('textbookExternalIds 与 textbookScopes 数量不一致');
  }

  const selectedIds = payload.textbookExternalIds.map((value) => (
    normalizeScopeExternalId(value, '教材来源 ID')
  ));
  const seenTextbooks = new Set();
  const scopes = payload.textbookScopes.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`textbookScopes[${index}] 必须是对象`);
    }
    const sourceProvider = raw.sourceProvider;
    if (sourceProvider !== PROVIDER) {
      throw new Error(`textbookScopes[${index}] 来源提供方不受支持`);
    }
    const externalVersionId = normalizeScopeExternalId(
      raw.externalVersionId,
      `textbookScopes[${index}].externalVersionId`,
    );
    const externalTextbookId = normalizeScopeExternalId(
      raw.externalTextbookId,
      `textbookScopes[${index}].externalTextbookId`,
    );
    const versionName = normalizeScopeName(raw.versionName, `textbookScopes[${index}].versionName`);
    const textbookName = normalizeScopeName(raw.textbookName, `textbookScopes[${index}].textbookName`);
    if (seenTextbooks.has(externalTextbookId)) {
      throw new Error('textbookScopes 不能包含重复教材来源 ID');
    }
    seenTextbooks.add(externalTextbookId);
    if (selectedIds[index] !== externalTextbookId) {
      throw new Error('textbookExternalIds 与 textbookScopes 的顺序或映射不一致');
    }
    const scope = {
      sourceProvider: PROVIDER,
      externalVersionId,
      externalTextbookId,
      versionName,
      textbookName,
    };
    if (raw.bootstrapChapterExternalId != null && raw.bootstrapChapterExternalId !== '') {
      scope.bootstrapChapterExternalId = normalizeScopeExternalId(
        raw.bootstrapChapterExternalId,
        `textbookScopes[${index}].bootstrapChapterExternalId`,
      );
    }
    if (raw.resumeFromCollectorRunId != null && raw.resumeFromCollectorRunId !== '') {
      scope.resumeFromCollectorRunId = intInRange(
        raw.resumeFromCollectorRunId,
        `textbookScopes[${index}].resumeFromCollectorRunId`,
        1,
        Number.MAX_SAFE_INTEGER,
      );
    }
    return scope;
  });
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error('教材选择列表不能包含重复 ID');
  }
  return { textbookExternalIds: selectedIds, scopes };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function looksBlocked(lines) {
  const text = lines.join('\n').toLowerCase();
  return [
    '验证码', '安全验证', '异常访问', '访问过于频繁', 'robots', '熔断', '契约',
    '授权范围', 'http 401', 'http 403', '收到 sig',
  ].some((marker) => text.includes(marker));
}

function lastError(lines, fallback) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = String(lines[index] || '').trim();
    if (line.includes('[错误]') || line.startsWith('Error:') || line.startsWith('[错误]')) return line.slice(0, 1000);
  }
  return fallback;
}

function sealOrphanContentRun(dbPath, runId, status, message = null) {
  const parsedRunId = Number(runId);
  if (!Number.isSafeInteger(parsedRunId) || parsedRunId < 1) return false;
  const terminalStatus = String(status || '').trim();
  if (!['failed', 'blocked', 'interrupted', 'cancelled'].includes(terminalStatus)) return false;
  let db;
  try {
    db = new DatabaseSync(path.resolve(dbPath));
    db.exec('PRAGMA busy_timeout = 5000;');
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE sync_runs
      SET finished_at = COALESCE(finished_at, ?),
          status = ?,
          message = COALESCE(message, ?),
          catalog_item_count = COALESCE((SELECT COUNT(*) FROM sync_run_catalog_items WHERE run_id = ?), 0),
          question_item_count = COALESCE((SELECT COUNT(*) FROM sync_run_question_items WHERE run_id = ?), 0),
          question_catalog_count = COALESCE((SELECT COUNT(*) FROM sync_run_question_catalogs WHERE run_id = ?), 0),
          question_tag_count = COALESCE((SELECT COUNT(*) FROM sync_run_question_tags WHERE run_id = ?), 0),
          question_asset_count = COALESCE((SELECT COUNT(*) FROM sync_run_question_assets WHERE run_id = ?), 0),
          snapshot_complete = 0,
          snapshot_locked_at = COALESCE(snapshot_locked_at, ?)
      WHERE id = ? AND status = 'running' AND snapshot_locked_at IS NULL
    `).run(
      now,
      terminalStatus,
      message ? String(message).slice(0, 4000) : null,
      parsedRunId,
      parsedRunId,
      parsedRunId,
      parsedRunId,
      parsedRunId,
      now,
      parsedRunId,
    );
    return Number(result?.changes || 0) > 0;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

function orphanHasResumablePartial(dbPath, runId, lines) {
  if (!isTransientResumeError({ message: (lines || []).join('\n') })) return false;
  try {
    const summary = readRunSnapshotSummary(dbPath, runId, { allowIncomplete: true });
    return isResumablePartialRun({
      ...summary,
      status: 'interrupted',
      snapshotLockedAt: new Date().toISOString(),
    });
  } catch {
    return false;
  }
}

function sealOrphanMetadataRun(dbPath, runId, status, message = null) {
  const parsedRunId = Number(runId);
  if (!Number.isSafeInteger(parsedRunId) || parsedRunId < 1) return false;
  const terminalStatus = String(status || '').trim();
  if (!['failed', 'blocked', 'cancelled'].includes(terminalStatus)) return false;
  let db;
  try {
    db = new DatabaseSync(path.resolve(dbPath));
    db.exec('PRAGMA busy_timeout = 5000;');
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE source_metadata_runs
      SET finished_at = COALESCE(finished_at, ?),
          status = ?,
          message = COALESCE(message, ?),
          snapshot_locked_at = COALESCE(snapshot_locked_at, ?)
      WHERE id = ? AND status = 'running' AND snapshot_locked_at IS NULL
    `).run(now, terminalStatus, message ? String(message).slice(0, 4000) : null, now, parsedRunId);
    return Number(result?.changes || 0) > 0;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

function publicJob(job) {
  const scopes = (job.scopeItems || []).map((scope) => ({
    sourceProvider: scope.sourceProvider || null,
    externalVersionId: scope.externalVersionId || null,
    externalTextbookId: scope.externalTextbookId,
    versionName: scope.versionName || null,
    textbookName: scope.textbookName,
    bootstrapChapterExternalId: scope.bootstrapChapterExternalId || null,
    resumeFromCollectorRunId: scope.resumeFromCollectorRunId == null
      ? null : Number(scope.resumeFromCollectorRunId),
    collectorRunId: scope.collectorRunId == null ? null : Number(scope.collectorRunId),
    status: scope.status,
    catalogCount: Number(scope.catalogCount || 0),
    questionCount: Number(scope.questionCount || 0),
    questionCatalogCount: Number(scope.questionCatalogCount || 0),
    questionTagCount: Number(scope.questionTagCount || 0),
    questionAssetCount: Number(scope.questionAssetCount || 0),
    snapshotLockedAt: scope.snapshotLockedAt || null,
    snapshotComplete: scope.snapshotComplete === true,
    pagesOk: Number(scope.pagesOk || 0),
    questionsSeen: Number(scope.questionsSeen || 0),
    questionsInserted: Number(scope.questionsInserted || 0),
    questionsUpdated: Number(scope.questionsUpdated || 0),
    detailsFetched: Number(scope.detailsFetched || 0),
    assetsDownloaded: Number(scope.assetsDownloaded || 0),
    errorCount: Number(scope.errorCount || 0),
    error: scope.error || null,
    resumable: scope.resumable === true,
    // Service consumes errorMessage while older integrations consume error;
    // expose both aliases from the same bounded value.
    errorMessage: scope.error || null,
    startedAt: scope.startedAt || null,
    finishedAt: scope.finishedAt || null,
  }));
  const collectorRunId = job.collectorRunId != null
    ? Number(job.collectorRunId)
    : (scopes.length === 1 && scopes[0].collectorRunId != null
      ? scopes[0].collectorRunId
      : null);
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
    catalogCount: job.catalogCount,
    questionCount: job.questionCount,
    questionCatalogCount: Number(job.questionCatalogCount || 0),
    questionTagCount: Number(job.questionTagCount || 0),
    questionAssetCount: Number(job.questionAssetCount || 0),
    snapshotLockedAt: job.snapshotLockedAt || null,
    snapshotComplete: job.snapshotComplete === true,
    currentTextbookId: job.currentTextbookId,
    currentTextbookName: job.currentTextbookName,
    progressPercent: job.progressPercent,
    logTail: job.lines.join('\n').slice(-MAX_LOG_CHARS),
    errorMessage: job.errorMessage,
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

class CollectorJobManager {
  constructor(options = {}) {
    this.dbPath = path.resolve(options.dbPath || path.join(COLLECTOR_ROOT, 'data', 'zujuan.sqlite3'));
    this.dataDir = path.resolve(options.dataDir || path.join(COLLECTOR_ROOT, 'data', 'zujuan'));
    this.profileDir = path.resolve(options.profileDir || path.join(COLLECTOR_ROOT, '.cache', 'zujuan-sync-profile'));
    this.nodeBin = options.nodeBin || process.execPath;
    this.spawnImpl = options.spawnImpl || spawn;
    // Headful is an operator/deployment setting only.  It is intentionally
    // read once here and never taken from a request payload.
    this.headful = deploymentBoolean(
      options.headful == null ? process.env.COLLECTOR_HEADFUL : options.headful,
      false,
    );
    // The API is often started independently of a crawl process.  Upgrade an
    // existing collector DB here so `/v1/runs/*` works immediately after a
    // deployment upgrade, including databases created by older collectors.
    // This is additive and preserves all existing candidate/run rows.
    ensureMetadataSnapshotSchema(this.dbPath);
    ensureRunSnapshotSchema(this.dbPath);
    this.jobs = new Map();
    this.activeJobId = null;
  }

  get activeJob() {
    return this.activeJobId ? this.jobs.get(this.activeJobId) || null : null;
  }

  get(id) {
    return this.jobs.get(String(id)) || null;
  }

  start(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('请求体必须是 JSON 对象');
    }
    if (this.activeJob && ACTIVE_STATUSES.has(this.activeJob.status)) {
      const error = new Error('采集器已有任务正在运行');
      error.statusCode = 409;
      throw error;
    }
    if (payload.acknowledgeSourcePolicy !== true) {
      throw new Error('开始同步前必须确认已核对来源站规则、授权范围和内容使用边界');
    }
    const runType = String(payload.runType || '');
    if (!['metadata', 'content'].includes(runType)) throw new Error('不支持的同步任务类型');
    const maxPages = intInRange(payload.maxPages ?? SITE_PAGE_LIMIT, 'maxPages', 1, SITE_PAGE_LIMIT);
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
        validateIndependentResumeScopes(this.dbPath, independentScopes, maxPages);
      } else {
        metadataRunId = intInRange(payload.metadataRunId, 'metadataRunId', 1, Number.MAX_SAFE_INTEGER);
        textbookExternalIds = (Array.isArray(payload.textbookExternalIds)
          ? payload.textbookExternalIds
          : [])
          .map((value) => String(value == null ? '' : value).trim());
        if (!textbookExternalIds.length || textbookExternalIds.length > MAX_SELECTED_TEXTBOOKS) {
          throw new Error(`教材选择数量必须在 1 到 ${MAX_SELECTED_TEXTBOOKS} 之间`);
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
    const job = {
      id: randomUUID(),
      runType,
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
            resumable: false,
            startedAt: null,
            finishedAt: null,
          };
        })
        : [],
      maxPages,
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
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      partialInterrupted: false,
      partialMessage: null,
      child: null,
      lines: [],
    };
    this.jobs.set(job.id, job);
    this.activeJobId = job.id;
    this.trimJobs();
    queueMicrotask(() => this.execute(job).catch((error) => this.failJob(job, error)));
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
      scope.status = ['success', 'completed'].includes(String(summary.status || ''))
        && scope.snapshotComplete && !result.cancelled
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

  record(job, rawLine, label = 'stdout') {
    const line = String(rawLine || '').trim();
    if (!line) return;
    const rendered = label === 'stderr' ? `[stderr] ${line}` : line;
    job.lines.push(rendered);
    if (job.lines.length > MAX_LOG_LINES) job.lines.splice(0, job.lines.length - MAX_LOG_LINES);
    const metadataMatch = line.match(/metadata-run=(\d+)/);
    if (metadataMatch) job.metadataRunId = Math.max(Number(job.metadataRunId || 0), Number(metadataMatch[1]));
    const versionMatch = line.match(/发现\s+(\d+)\s+个版本/);
    if (versionMatch) job.totalVersions = Math.max(job.totalVersions, Number(versionMatch[1]));
    const textbookMatch = line.match(/textbooksSeen:\s*(\d+)/);
    if (textbookMatch) job.totalTextbooks = Math.max(job.totalTextbooks, Number(textbookMatch[1]));
    const catalogMatch = line.match(/本次同步\s+(\d+)\s+个节点/);
    if (catalogMatch) job._scriptCatalogCount = Math.max(job._scriptCatalogCount || 0, Number(catalogMatch[1]));
    const questionMatch = line.match(/questionsSeen:\s*(\d+)/);
    if (questionMatch) job._scriptQuestionCount = Math.max(job._scriptQuestionCount || 0, Number(questionMatch[1]));
    const runMatch = line.match(/(?:^|\s)run=(\d+)(?:\s|$)/);
    if (runMatch) job._childRunId = Number(runMatch[1]);
  }

  async runChild(job, script, args, scope = null) {
    if (job.cancelRequested) return { returnCode: -1, cancelled: true };
    job._scriptCatalogCount = 0;
    job._scriptQuestionCount = 0;
    job._childRunId = null;
    const watermark = scope ? contentRunWatermark(this.dbPath) : null;
    if (scope) scope.status = 'running';
    let child;
    try {
      child = this.spawnImpl(this.nodeBin, [script, ...args], {
        cwd: COLLECTOR_ROOT,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      if (scope) {
        scope.status = 'failed';
        scope.error = String(error.message || error).slice(0, 1000);
      }
      throw error;
    }
    job.child = child;
    const consume = (stream, label) => {
      let buffered = '';
      stream?.setEncoding('utf8');
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
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (returnCode, signal) => resolve({ returnCode: Number(returnCode ?? -1), signal }));
      });
    } finally {
      job.child = null;
    }
    result.cancelled = job.cancelRequested;
    result.snapshot = this.captureChildSnapshot(job, scope, watermark, result);
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
    job.progressPercent = 5;
    if (job.runType === 'metadata') await this.executeMetadata(job);
    else await this.executeContent(job);
    if (job.cancelRequested) {
      this.finishJob(job, 'cancelled', '同步已停止');
      return;
    }
    if (job.partialInterrupted) {
      this.finishJob(job, 'interrupted', job.partialMessage || '同步暂时中断，可使用 partial collectorRunId 续采');
      return;
    }
    this.finishJob(job, 'completed', null);
  }

  async executeMetadata(job) {
    const watermark = metadataWatermark(this.dbPath);
    const result = await this.runChild(job, METADATA_SCRIPT, this.baseArgs());
    if (result.cancelled) {
      // A metadata child normally seals its own run in `finally`, but a
      // forced termination can happen before that block starts.  Resolve the
      // run created after this job's watermark before falling back to the
      // request's (usually null) metadataRunId.
      let run = null;
      try { run = metadataRunAfter(this.dbPath, watermark); } catch {}
      sealOrphanMetadataRun(
        this.dbPath,
        run?.status === 'running' ? run.id : job.metadataRunId,
        'cancelled',
        '同步已停止',
      );
      return;
    }
    if (result.returnCode !== 0) {
      let run = null;
      try { run = metadataRunAfter(this.dbPath, watermark); } catch {}
      sealOrphanMetadataRun(
        this.dbPath,
        run?.status === 'running' ? run.id : job.metadataRunId,
        looksBlocked(job.lines) ? 'blocked' : 'failed',
        lastError(job.lines, '版本和教材同步脚本执行失败'),
      );
      const error = new Error(lastError(job.lines, '版本和教材同步脚本执行失败'));
      error.blocked = looksBlocked(job.lines);
      throw error;
    }
    const run = metadataRunAfter(this.dbPath, watermark);
    if (!run || Number(run.id) <= watermark || String(run.status || '') !== 'success') {
      if (run && String(run.status || '') === 'running') {
        sealOrphanMetadataRun(this.dbPath, run.id, looksBlocked(job.lines) ? 'blocked' : 'failed', '无法确认本次元数据运行已完成');
      }
      throw new Error('无法确认本次元数据运行 ID');
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
      if (job.cancelRequested) return;
      const scope = this.scopeFor(job, textbook.externalTextbookId);
      job.currentTextbookId = textbook.externalTextbookId;
      job.currentTextbookName = textbook.textbookName;
      if (scope) {
        scope.textbookName = textbook.textbookName;
        scope.status = 'running';
        scope.error = null;
        scope.startedAt = scope.startedAt || new Date().toISOString();
        scope.finishedAt = null;
      }
      const childArgs = [
        ...this.baseArgs(),
        '--textbook-id', textbook.externalTextbookId,
        '--chapter-id', textbook.bootstrapChapterExternalId || textbook.externalTextbookId,
      ];
      // Keep the collector strategy owned by this manager.  The API's page
      // cap is an existing bounded contract; only a resume source changes the
      // checkpoint switch passed to the child.
      if (job.maxPages < SITE_PAGE_LIMIT) childArgs.push('--max-pages', String(job.maxPages));
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
      const snapshotStatus = String(result.snapshot?.status || '').trim();
      const snapshotComplete = result.snapshot?.snapshotComplete === true
        || Number(result.snapshot?.snapshot_complete || 0) === 1;
      const resumablePartial = isResumablePartialRun(result.snapshot);
      if (resumablePartial) {
        if (scope) {
          scope.status = 'interrupted';
          scope.resumable = true;
          scope.error = scope.error || scopeErrorText(
            result.snapshot,
            `教材 ${textbook.textbookName} 采集暂时中断，可使用 collectorRunId 续采`,
          );
        }
        job.partialInterrupted = true;
        job.partialMessage = scope?.error || `教材 ${textbook.textbookName} 采集暂时中断`;
        return 'interrupted';
      }
      const snapshotFailed = !result.snapshot
        || !['success', 'completed'].includes(snapshotStatus)
        || !snapshotComplete;
      if (result.returnCode !== 0 || snapshotFailed) {
        if (scope) {
          scope.status = snapshotStatus === 'blocked' ? 'blocked' : 'failed';
          scope.error = scope.error || scopeErrorText(
            result.snapshot,
            lastError(job.lines, `教材 ${textbook.textbookName} 同步失败或快照不完整`),
          );
        }
        const error = new Error(lastError(job.lines, `教材 ${textbook.textbookName} 同步失败或快照不完整`));
        error.blocked = snapshotStatus === 'blocked' || looksBlocked(job.lines);
        throw error;
      }
      if (scope) {
        scope.status = 'completed';
        scope.error = null;
      }
      job.completedTextbooks += 1;
      job.progressPercent = Math.min(99, Math.round((5 + (job.completedTextbooks / job.totalTextbooks) * 94) * 10) / 10);
    }
  }

  finishJob(job, status, message) {
    job.status = status;
    job.phase = status === 'completed' ? 'completed' : status;
    job.errorMessage = message;
    job.progressPercent = status === 'completed' ? 100 : job.progressPercent;
    job.currentTextbookId = null;
    job.currentTextbookName = null;
    job.finishedAt = new Date().toISOString();
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
    job.snapshotComplete = status === 'completed'
      && (job.scopeItems || []).length > 0
      && (job.scopeItems || []).every((scope) => scope.snapshotComplete === true);
    if (job.scopeItems.length === 1) {
      job.snapshotLockedAt = job.scopeItems[0].snapshotLockedAt || null;
    }
    if (this.activeJobId === job.id) this.activeJobId = null;
  }

  failJob(job, error) {
    if (job.cancelRequested) {
      this.finishJob(job, 'cancelled', '同步已停止');
      return;
    }
    const message = String(error?.message || error || '采集任务异常').slice(0, 1000);
    const current = this.scopeFor(job, job.currentTextbookId);
    if (current) {
      current.status = error?.blocked ? 'blocked' : 'failed';
      current.error = current.error || message;
      current.finishedAt = current.finishedAt || new Date().toISOString();
    }
    this.record(job, `[错误] ${message}`, 'stderr');
    this.finishJob(job, error?.blocked ? 'blocked' : 'failed', message);
  }

  cancel(id) {
    const job = this.get(id);
    if (!job) return null;
    if (!ACTIVE_STATUSES.has(job.status)) return publicJob(job);
    job.cancelRequested = true;
    job.status = 'cancelling';
    const current = this.scopeFor(job, job.currentTextbookId);
    if (current && !['completed', 'failed', 'blocked'].includes(current.status)) {
      current.status = 'cancelling';
      current.error = current.error || '正在停止';
    }
    const child = job.child;
    if (child?.pid) {
      try {
        if (process.platform === 'win32') child.kill('SIGTERM');
        else process.kill(-child.pid, 'SIGTERM');
      } catch {}
      const timer = setTimeout(() => {
        if (!job.child?.pid) return;
        try {
          if (process.platform === 'win32') job.child.kill('SIGKILL');
          else process.kill(-job.child.pid, 'SIGKILL');
        } catch {}
      }, 12000);
      timer.unref?.();
    }
    return publicJob(job);
  }

  async shutdown() {
    const active = this.activeJob;
    if (active) this.cancel(active.id);
  }
}

function sendJson(response, statusCode, payload) {
  let encoded;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    encoded = JSON.stringify({ error: { code: 'serialization_error', message: '响应无法序列化' } });
    statusCode = 500;
  }
  let body = Buffer.from(encoded || '{}');
  if (body.length > MAX_RESPONSE_BYTES) {
    statusCode = 413;
    body = Buffer.from(JSON.stringify({
      error: { code: 'response_too_large', message: '响应超过安全大小上限，请缩小分页范围' },
    }));
  }
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendAssetResponse(response, asset) {
  const contentLength = Number(asset?.contentLength);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    sendJson(response, 500, {
      error: { code: 'asset_unavailable', message: '素材响应长度无效' },
    });
    return;
  }
  const fileDescriptor = Number.isInteger(asset?.fileDescriptor)
    ? asset.fileDescriptor : null;
  let stream;
  if (contentLength === 0 && fileDescriptor != null) {
    try {
      response.writeHead(200, {
        'content-type': String(asset.contentType || 'application/octet-stream'),
        'content-length': 0,
        etag: String(asset.etag || ''),
        'cache-control': String(asset.cacheControl || 'public, max-age=31536000, immutable'),
      });
      response.end();
    } finally {
      try { fs.closeSync(fileDescriptor); } catch {}
    }
    return;
  }
  try {
    // `fileDescriptor` is a non-enumerable internal value produced only after
    // the collector has validated the run scope, root containment, and
    // digest.  Use a bounded descriptor stream when available so a path
    // replacement after validation cannot redirect the response.  The path
    // fallback preserves compatibility for direct callers using older asset
    // result objects.
    stream = fileDescriptor != null
      ? fs.createReadStream(null, {
        fd: fileDescriptor,
        autoClose: true,
        start: 0,
        end: contentLength - 1,
      })
      : fs.createReadStream(asset.filePath);
  } catch {
    if (fileDescriptor != null) {
      try { fs.closeSync(fileDescriptor); } catch {}
    }
    sendJson(response, 404, {
      error: { code: 'asset_not_found', message: '素材文件不存在或不可用' },
    });
    return;
  }
  stream.once('error', () => {
    // A filesystem race can still happen after the read-only validation.  Do
    // not emit a second JSON response after bytes have started flowing and
    // never let the stream error become an uncaught process exception.
    if (!response.destroyed && !response.headersSent && !response.writableEnded) {
      sendJson(response, 404, {
        error: { code: 'asset_not_found', message: '素材文件不存在或不可用' },
      });
    } else if (!response.destroyed) {
      response.destroy();
    }
  });
  response.once('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  const startStreaming = () => {
    if (response.destroyed || response.writableEnded) {
      stream.destroy();
      return;
    }
    try {
      response.writeHead(200, {
        'content-type': String(asset.contentType || 'application/octet-stream'),
        'content-length': contentLength,
        etag: String(asset.etag || ''),
        'cache-control': String(asset.cacheControl || 'public, max-age=31536000, immutable'),
      });
      stream.pipe(response);
    } catch {
      stream.destroy();
      if (!response.destroyed && !response.headersSent && !response.writableEnded) {
        sendJson(response, 500, {
          error: { code: 'asset_unavailable', message: '素材响应失败' },
        });
      } else if (!response.destroyed) {
        response.destroy();
      }
    }
  };
  // A stream created from an already-open fd does not emit `open`; a path
  // stream does.  Start the former immediately while retaining the latter's
  // open-time error boundary.
  if (fileDescriptor != null) startStreaming();
  else stream.once('open', startStreaming);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体必须是有效 JSON');
  }
}

function createCollectorServer(options = {}) {
  const token = String(options.token ?? process.env.COLLECTOR_API_TOKEN ?? '');
  const manager = options.manager || new CollectorJobManager(options);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://collector.local');
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true, service: 'lesson-bank-collector' });
        return;
      }
      if (token) {
        const authorization = String(request.headers.authorization || '');
        if (!authorization.startsWith('Bearer ') || !safeEqual(authorization.slice(7), token)) {
          sendJson(response, 401, { error: { code: 'unauthorized', message: '采集器 API 认证失败' } });
          return;
        }
      }
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(response, 200, {
          ok: true,
          service: 'lesson-bank-collector',
          activeJobId: manager.activeJobId,
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/jobs') {
        sendJson(response, 202, manager.start(await readJson(request)));
        return;
      }
      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)$/i);
      if (request.method === 'GET' && jobMatch) {
        const job = manager.get(jobMatch[1]);
        if (!job) {
          sendJson(response, 404, { error: { code: 'job_not_found', message: '采集任务不存在' } });
          return;
        }
        sendJson(response, 200, publicJob(job));
        return;
      }
      const runCatalogMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/catalogs\/?$/i);
      if (request.method === 'GET' && runCatalogMatch) {
        sendJson(response, 200, readRunCatalogs(manager.dbPath, decodeURIComponent(runCatalogMatch[1]), {
          textbookExternalId: url.searchParams.get('textbookExternalId'),
          page: url.searchParams.get('page'),
          pageSize: url.searchParams.get('pageSize'),
        }));
        return;
      }
      const runSnapshotPageMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/snapshot-page\/?$/i);
      if (request.method === 'GET' && runSnapshotPageMatch) {
        sendJson(response, 200, readRunSnapshotPage(
          manager.dbPath,
          decodeURIComponent(runSnapshotPageMatch[1]),
          {
            collection: url.searchParams.get('collection'),
            textbookExternalId: url.searchParams.get('textbookExternalId'),
            cursor: url.searchParams.get('cursor'),
            pageSize: url.searchParams.get('pageSize'),
          },
        ));
        return;
      }
      const runAssetMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/assets\/([^/]+)\/?$/i);
      if (request.method === 'GET' && runAssetMatch) {
        const asset = readRunAsset(
          manager.dbPath,
          decodeURIComponent(runAssetMatch[1]),
          decodeURIComponent(runAssetMatch[2]),
          {
            textbookExternalId: url.searchParams.get('textbookExternalId'),
            dataDir: manager.dataDir,
          },
        );
        sendAssetResponse(response, asset);
        return;
      }
      const runSnapshotMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/snapshot\/?$/i);
      if (request.method === 'GET' && runSnapshotMatch) {
        sendJson(response, 200, readRunSnapshot(
          manager.dbPath,
          decodeURIComponent(runSnapshotMatch[1]),
          { textbookExternalId: url.searchParams.get('textbookExternalId') },
        ));
        return;
      }
      const runSnapshotSummaryMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/snapshot-summary\/?$/i);
      if (request.method === 'GET' && runSnapshotSummaryMatch) {
        const rawAllowIncomplete = url.searchParams.get('allowIncomplete');
        if (rawAllowIncomplete != null && !['true', 'false'].includes(rawAllowIncomplete.toLowerCase())) {
          throw new Error('allowIncomplete 必须是 true 或 false');
        }
        const allowIncomplete = rawAllowIncomplete?.toLowerCase() === 'true';
        sendJson(response, 200, readRunSnapshotSummary(
          manager.dbPath,
          decodeURIComponent(runSnapshotSummaryMatch[1]),
          {
            textbookExternalId: url.searchParams.get('textbookExternalId'),
            allowIncomplete,
          },
        ));
        return;
      }
      const runQuestionDetailMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/questions\/([^/]+)\/?$/i);
      if (request.method === 'GET' && runQuestionDetailMatch) {
        sendJson(response, 200, readRunQuestion(
          manager.dbPath,
          decodeURIComponent(runQuestionDetailMatch[1]),
          decodeURIComponent(runQuestionDetailMatch[2]),
          { textbookExternalId: url.searchParams.get('textbookExternalId') },
        ));
        return;
      }
      const runQuestionsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/questions\/?$/i);
      if (request.method === 'GET' && runQuestionsMatch) {
        sendJson(response, 200, readRunQuestions(manager.dbPath, decodeURIComponent(runQuestionsMatch[1]), {
          textbookExternalId: url.searchParams.get('textbookExternalId'),
          page: url.searchParams.get('page'),
          pageSize: url.searchParams.get('pageSize'),
          catalogExternalId: url.searchParams.get('catalogExternalId'),
          questionType: url.searchParams.get('questionType'),
          keyword: url.searchParams.get('keyword'),
        }));
        return;
      }
      const cancelMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)\/cancel$/i);
      if (request.method === 'POST' && cancelMatch) {
        const job = manager.cancel(cancelMatch[1]);
        if (!job) {
          sendJson(response, 404, { error: { code: 'job_not_found', message: '采集任务不存在' } });
          return;
        }
        sendJson(response, 200, job);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/metadata/validate') {
        const body = await readJson(request);
        const runId = intInRange(body.metadataRunId, 'metadataRunId', 1, Number.MAX_SAFE_INTEGER);
        sendJson(response, 200, validateMetadataSelection(manager.dbPath, runId, body.textbookExternalIds));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/metadata/snapshot') {
        const rawRunId = url.searchParams.get('metadataRunId');
        const runId = rawRunId == null ? null : intInRange(rawRunId, 'metadataRunId', 1, Number.MAX_SAFE_INTEGER);
        sendJson(response, 200, readMetadataSnapshot(manager.dbPath, runId));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/candidates') {
        const entityType = url.searchParams.get('entityType') || '';
        const rawRunId = url.searchParams.get('metadataRunId');
        const metadataRunId = rawRunId == null ? null : intInRange(rawRunId, 'metadataRunId', 1, Number.MAX_SAFE_INTEGER);
        sendJson(response, 200, readCandidates(manager.dbPath, entityType, {
          provider: url.searchParams.get('provider'),
          textbookExternalId: url.searchParams.get('textbookExternalId'),
          metadataRunId,
        }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/catalog-progress') {
        sendJson(response, 200, readCatalogProgress(manager.dbPath));
        return;
      }
      sendJson(response, 404, { error: { code: 'not_found', message: 'API 路由不存在' } });
    } catch (error) {
      const statusCode = Number(error.statusCode || 400);
      const code = error.code
        || (statusCode === 401 ? 'unauthorized' : null)
        || (statusCode === 404 ? 'not_found' : null)
        || (statusCode === 409 ? 'job_conflict' : null)
        || (statusCode >= 500 ? 'internal_error' : 'bad_request');
      sendJson(response, statusCode, {
        error: { code, message: String(error.message || error).slice(0, 1000) },
      });
    }
  });
  server.collectorManager = manager;
  return server;
}

async function main() {
  const host = String(process.env.COLLECTOR_API_HOST || '127.0.0.1');
  const port = intInRange(process.env.COLLECTOR_API_PORT || 9110, 'COLLECTOR_API_PORT', 1, 65535);
  const token = String(process.env.COLLECTOR_API_TOKEN || '');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !token) {
    throw new Error('采集器绑定非本机地址时必须配置 COLLECTOR_API_TOKEN');
  }
  const server = createCollectorServer({
    token,
    dbPath: process.env.COLLECTOR_DB,
    dataDir: process.env.COLLECTOR_DATA_DIR,
    profileDir: process.env.COLLECTOR_PROFILE_DIR,
    nodeBin: process.env.COLLECTOR_NODE_BIN,
    headful: process.env.COLLECTOR_HEADFUL,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log(`collector API 已启动：http://${host}:${port}`);
  const shutdown = async () => {
    await server.collectorManager.shutdown();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = {
  CollectorJobManager,
  createCollectorServer,
  deploymentBoolean,
  publicJob,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[错误] ${error.message}`);
    process.exitCode = 1;
  });
}
