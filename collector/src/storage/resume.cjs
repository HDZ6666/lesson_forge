'use strict';

/**
 * Resume (断点续采) rules shared by the CLI collectors and the API manager.
 *
 * A resume never mutates the sealed source run: it validates that run, then
 * copies its immutable snapshot rows and run-scoped checkpoints into a new
 * run.  The mutable global `sync_checkpoints` table is never consulted.
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { RUN_CHECKPOINT_TABLE, SNAPSHOT_TABLES } = require('./run_snapshots.cjs');
const { QuestionSyncError } = require('../shared/errors.cjs');
const { nowIso, sha256 } = require('../shared/utils.cjs');
const { PROVIDER } = require('../sources/zujuan/constants.cjs');

const MAX_CHECKPOINT_PAGE = 1_000_000;

const RESUME_TRANSIENT_MARKERS = Object.freeze([
  'timeouterror',
  'timeout',
  '超时',
  'econnreset',
  'econnrefused',
  'enotfound',
  'connection reset',
  'connection closed',
  'connection timed out',
  'browser has been closed',
  'target page, context or browser has been closed',
  'target closed',
  'socket closed',
  '连接重置',
  '连接关闭',
  '连接超时',
  'socket hang up',
  'etimedout',
  'eai_again',
  'net::err_',
  'err_connection_reset',
  'err_connection_closed',
  'err_connection_timed_out',
  'err_network_changed',
  'network error',
  '网络错误',
  'http 408',
  'http_408',
  'http 429',
  'http_429',
  'http 500',
  'http_500',
  'http 502',
  'http_502',
  'http 503',
  'http_503',
  'http 504',
  'http_504',
]);

const RESUME_DETERMINISTIC_MARKERS = Object.freeze([
  'challenge',
  'captcha',
  '验证码',
  '安全验证',
  '异常访问',
  '访问过于频繁',
  'robots',
  'robot.txt',
  '授权',
  '未授权',
  '登录 required',
  'login required',
  'unauthorized',
  'authorization',
  'access denied',
  'forbidden',
  'blocked',
  'policy',
  'http 401',
  'http_401',
  'http 403',
  'http_403',
  '契约',
  'contract',
  '结构变化',
  '页面结构',
  'catalog_not_found',
  'host_not_allowed',
  'tree_timeout',
  'pager_contract',
  'detail_contract',
  'contract_empty',
  'pagination_loop',
  'structure changed',
  'structural change',
  'schema changed',
  '目录树未出现',
  '没有解析到教材目录',
]);

function parseScopeObject(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function canonicalScopeArray(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values
    .filter((item) => item != null && String(item).trim() !== '')
    .map((item) => String(item).trim()))].sort();
}

function canonicalScopeBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function canonicalScopeNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function canonicalScopeFacet(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'object' || Array.isArray(value)) return String(value);
  const id = value.id == null || value.id === '' ? null : String(value.id);
  const name = value.name == null || value.name === '' ? null : String(value.name);
  return { id, name };
}

/**
 * Keep only the range/meaning fields that must remain identical across a
 * resume.  Operational knobs (workers, delays, profile and raw-page output)
 * deliberately do not participate in this identity.
 */
function normalizeResumeScope(scope) {
  const raw = parseScopeObject(scope);
  const filters = raw.filters && typeof raw.filters === 'object' && !Array.isArray(raw.filters)
    ? raw.filters
    : {};
  const details = canonicalScopeBoolean(raw.details, true);
  const downloadAssets = canonicalScopeBoolean(raw.downloadAssets, false);
  const textbookArray = Array.isArray(raw.textbookIds)
    ? raw.textbookIds
    : (Array.isArray(raw.textbookExternalIds) ? raw.textbookExternalIds : []);
  const chapterArray = Array.isArray(raw.chapterIds)
    ? raw.chapterIds
    : (raw.chapterId == null ? [] : [raw.chapterId]);
  return {
    textbookId: String(raw.textbookId ?? raw.textbookExternalId
      ?? (textbookArray.length === 1 ? textbookArray[0] : '')).trim(),
    chapterIds: canonicalScopeArray(chapterArray),
    catalogLevels: canonicalScopeArray(raw.catalogLevels),
    catalogIds: canonicalScopeArray(raw.catalogIds),
    allCatalogs: canonicalScopeBoolean(raw.allCatalogs, false),
    withinChapterIds: canonicalScopeArray(raw.withinChapterIds),
    filters: {
      scene: canonicalScopeFacet(filters.scene),
      questionType: canonicalScopeFacet(filters.questionType),
      difficulty: canonicalScopeFacet(filters.difficulty),
      category: canonicalScopeFacet(filters.category),
      year: filters.year == null || filters.year === '' ? null : String(filters.year),
      fresh: canonicalScopeBoolean(filters.fresh, false),
      sort: canonicalScopeFacet(filters.sort, { id: '2', name: '最新' }),
    },
    startPage: canonicalScopeNumber(raw.startPage, 1),
    maxPages: canonicalScopeNumber(raw.maxPages, 1),
    // The per-task 1000-page policy is part of the immutable resume scope;
    // changing it mid-run could otherwise turn a bounded snapshot into an
    // unbounded continuation (or the reverse).
    limitTo1000Pages: canonicalScopeBoolean(raw.limitTo1000Pages, false),
    limit: canonicalScopeNumber(raw.limit, 0),
    details,
    detailFallback: canonicalScopeBoolean(raw.detailFallback, false),
    refreshDetails: canonicalScopeBoolean(raw.refreshDetails, false),
    downloadAssets,
    requireDetails: canonicalScopeBoolean(
      raw.requireDetails,
      details || canonicalScopeBoolean(raw.refreshDetails, false),
    ),
    requireAssets: canonicalScopeBoolean(raw.requireAssets, downloadAssets),
    includeVisibleSolutions: canonicalScopeBoolean(raw.includeVisibleSolutions, false),
  };
}

function resumeScopeDifferences(left, right) {
  const first = normalizeResumeScope(left);
  const second = normalizeResumeScope(right);
  const differences = [];
  for (const key of Object.keys(first)) {
    if (JSON.stringify(first[key]) !== JSON.stringify(second[key])) differences.push(key);
  }
  return differences;
}

function scopeTextbookIds(scope) {
  const raw = parseScopeObject(scope);
  const values = [raw.textbookId, raw.textbookExternalId];
  for (const key of ['textbookIds', 'textbookExternalIds']) {
    if (Array.isArray(raw[key])) values.push(...raw[key]);
  }
  return [...new Set(values
    .filter((value) => value != null && String(value).trim() !== '')
    .map((value) => String(value).trim()))];
}

function resumeErrorMarkerText(run, errors = []) {
  return [
    run?.message,
    ...errors.flatMap((error) => [error?.error_code, error?.stage, error?.message]),
  ].filter((value) => value != null && String(value).trim() !== '').join('\n').toLowerCase();
}

function isTransientResumeError(run, errors = []) {
  const text = resumeErrorMarkerText(run, errors);
  if (!text) return false;
  if (RESUME_DETERMINISTIC_MARKERS.some((marker) => text.includes(marker.toLowerCase()))) return false;
  return RESUME_TRANSIENT_MARKERS.some((marker) => text.includes(marker.toLowerCase()));
}

function hasDeterministicResumeError(run, errors = []) {
  const text = resumeErrorMarkerText(run, errors);
  return RESUME_DETERMINISTIC_MARKERS.some((marker) => text.includes(marker.toLowerCase()));
}

function sqlIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function snapshotTableCounts(db, runId, textbookExternalId) {
  const result = {};
  const fieldNames = [
    ['sync_run_catalog_items', 'catalogCount'],
    ['sync_run_question_items', 'questionCount'],
    ['sync_run_question_catalogs', 'questionCatalogCount'],
    ['sync_run_question_tags', 'questionTagCount'],
    ['sync_run_question_assets', 'questionAssetCount'],
  ];
  for (const [table, field] of fieldNames) {
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    ).get(table);
    result[field] = exists
      ? Number(db.prepare(`
        SELECT COUNT(*) AS n FROM ${sqlIdentifier(table)}
        WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
      `).get(Number(runId), PROVIDER, String(textbookExternalId)).n || 0)
      : 0;
  }
  return result;
}

function sourceRunErrors(db, runId) {
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_errors' LIMIT 1",
  ).get();
  if (!exists) return [];
  return db.prepare(`
    SELECT error_code, stage, message
    FROM sync_errors WHERE run_id = ? ORDER BY id ASC LIMIT 50
  `).all(Number(runId));
}

function resumeSourceError(message, code = 'resume_source_invalid') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Validate a sealed partial run before any of its rows are copied.  This is
 * intentionally usable by the API manager as well as the standalone CLI.
 */
function validateResumeSourceRunInDb(db, sourceRunId, targetScope, { sealedRefill = false } = {}) {
  const parsedRunId = Number(sourceRunId);
  if (!Number.isSafeInteger(parsedRunId) || parsedRunId < 1) {
    throw resumeSourceError('resume-run-id 必须是正整数');
  }
  const run = db.prepare(`
    SELECT id, provider, started_at, finished_at, status, scope_json,
           pages_ok, questions_seen, error_count, message,
           snapshot_locked_at, snapshot_complete
    FROM sync_runs WHERE id = ?
  `).get(parsedRunId);
  if (!run) throw resumeSourceError(`来源运行 ${parsedRunId} 不存在`);
  if (String(run.provider || '') !== PROVIDER) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 来源提供方不受支持`);
  }
  if (!run.snapshot_locked_at) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 尚未锁定，不能续采`);
  }
  if (Number(run.snapshot_complete || 0) === 1) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 已是完整快照，不能作为续采来源`);
  }

  const target = normalizeResumeScope(targetScope);
  if (!target.textbookId) throw resumeSourceError('续采范围缺少 textbookId');
  const sourceScope = parseScopeObject(run.scope_json);
  const sourceScopeIds = scopeTextbookIds(sourceScope);
  if (sourceScopeIds.length !== 1 || sourceScopeIds[0] !== target.textbookId) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 教材范围与续采教材不匹配`);
  }
  const rowScopeIds = new Set();
  for (const table of SNAPSHOT_TABLES) {
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    ).get(table);
    if (!exists) throw resumeSourceError(`来源运行 ${parsedRunId} 缺少 ${table} 快照表`);
    for (const row of db.prepare(`
      SELECT DISTINCT textbook_external_id
      FROM ${sqlIdentifier(table)} WHERE run_id = ? AND provider = ?
    `).all(parsedRunId, PROVIDER)) {
      if (row.textbook_external_id == null || String(row.textbook_external_id).trim() === '') {
        throw resumeSourceError(`来源运行 ${parsedRunId} 的 ${table} 含无教材归属的快照行`);
      }
      rowScopeIds.add(String(row.textbook_external_id));
    }
  }
  if ([...rowScopeIds].some((id) => id !== target.textbookId)) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 含有其他教材快照，不能续采`);
  }
  if (rowScopeIds.size > 0 && !rowScopeIds.has(target.textbookId)) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 没有教材 ${target.textbookId} 的快照`);
  }

  const differences = resumeScopeDifferences(sourceScope, targetScope);
  if (differences.length > 0) {
    throw resumeSourceError(
      `来源运行 ${parsedRunId} 的采集范围不匹配：${differences.join('、')}`,
    );
  }

  const errors = sourceRunErrors(db, parsedRunId);
  const status = String(run.status || '').trim().toLowerCase();
  // Refills discard old scan evidence and check observations again. They
  // may retain valid pages from a failed run; legacy in-place recovery only
  // accepts transient failures. Source/host pause gates still apply.
  if (!['interrupted', 'failed', 'blocked'].includes(status)) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 状态 ${status || 'unknown'} 不允许续采`);
  }
  if (!sealedRefill && status === 'failed' && !isTransientResumeError(run, errors)) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 不是可续采的瞬时错误`);
  }
  if (!sealedRefill && status === 'interrupted' && hasDeterministicResumeError(run, errors)) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 包含确定性失败，不能续采`);
  }

  const counts = snapshotTableCounts(db, parsedRunId, target.textbookId);
  const inheritedSource = Number(sourceScope.resumeFromRunId || 0) > 0;
  if ((status === 'failed' && Number(run.pages_ok || 0) < 1 && !inheritedSource)
    || counts.catalogCount < 1
    || counts.questionCount < 1
    || counts.questionCatalogCount < 1) {
    throw resumeSourceError(`来源运行 ${parsedRunId} 尚无可安全续采的完整页/部分快照`);
  }
  const orphanChecks = [
    [`${SNAPSHOT_TABLES[2]} 题目目录关系`, `
      SELECT 1 FROM sync_run_question_catalogs AS r
      WHERE r.run_id = ? AND r.provider = ? AND r.textbook_external_id = ?
        AND (NOT EXISTS (
          SELECT 1 FROM sync_run_question_items AS q
          WHERE q.run_id = r.run_id AND q.provider = r.provider
            AND q.textbook_external_id = r.textbook_external_id
            AND q.question_external_id = r.question_external_id
        ) OR NOT EXISTS (
          SELECT 1 FROM sync_run_catalog_items AS c
          WHERE c.run_id = r.run_id AND c.provider = r.provider
            AND c.textbook_external_id = r.textbook_external_id
            AND c.catalog_external_id = r.catalog_external_id
        )) LIMIT 1
    `],
    [`${SNAPSHOT_TABLES[3]} 题目标签`, `
      SELECT 1 FROM sync_run_question_tags AS r
      WHERE r.run_id = ? AND r.provider = ? AND r.textbook_external_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_run_question_items AS q
          WHERE q.run_id = r.run_id AND q.provider = r.provider
            AND q.textbook_external_id = r.textbook_external_id
            AND q.question_external_id = r.question_external_id
        ) LIMIT 1
    `],
    [`${SNAPSHOT_TABLES[4]} 题目素材`, `
      SELECT 1 FROM sync_run_question_assets AS r
      WHERE r.run_id = ? AND r.provider = ? AND r.textbook_external_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_run_question_items AS q
          WHERE q.run_id = r.run_id AND q.provider = r.provider
            AND q.textbook_external_id = r.textbook_external_id
            AND q.question_external_id = r.question_external_id
        ) LIMIT 1
    `],
  ];
  for (const [label, query] of orphanChecks) {
    if (db.prepare(query).get(parsedRunId, PROVIDER, target.textbookId)) {
      throw resumeSourceError(`来源运行 ${parsedRunId} 的 ${label} 包含孤儿行`);
    }
  }
  return {
    run,
    scope: sourceScope,
    errors,
    counts,
    textbookExternalId: target.textbookId,
    resumable: true,
  };
}

function validateResumeSourceRun(dbPath, sourceRunId, targetScope, options = {}) {
  let db;
  try {
    db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
    return validateResumeSourceRunInDb(db, sourceRunId, targetScope, options);
  } finally {
    try { db?.close(); } catch {}
  }
}

function copyResumeSnapshotRows(db, sourceRunId, targetRunId, textbookExternalId) {
  const sourceId = Number(sourceRunId);
  const targetId = Number(targetRunId);
  const textbookId = String(textbookExternalId);
  const copied = {};
  for (const table of SNAPSHOT_TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${sqlIdentifier(table)})`).all()
      .map((row) => String(row.name));
    const copyColumns = columns.filter((column) => column !== 'run_id');
    if (!columns.includes('run_id') || !columns.includes('provider')
      || !columns.includes('textbook_external_id')) {
      throw resumeSourceError(`来源运行快照表 ${table} 字段不完整`);
    }
    const insertColumns = ['run_id', ...copyColumns].map(sqlIdentifier).join(', ');
    const selectColumns = ['?', ...copyColumns.map(sqlIdentifier)].join(', ');
    const result = db.prepare(`
      INSERT INTO ${sqlIdentifier(table)} (${insertColumns})
      SELECT ${selectColumns}
      FROM ${sqlIdentifier(table)}
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
    `).run(targetId, sourceId, PROVIDER, textbookId);
    copied[table] = Number(result?.changes || 0);
  }
  return copied;
}

function normalizeCheckpointPage(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_CHECKPOINT_PAGE) {
    return fallback;
  }
  return parsed;
}

function checkpointFilterJson(scope) {
  const raw = parseScopeObject(scope);
  const filters = raw.filters && typeof raw.filters === 'object' && !Array.isArray(raw.filters)
    ? raw.filters
    : {};
  return JSON.stringify(filters);
}

function checkpointScopeKey(catalogExternalId, filterJson) {
  return sha256(`${PROVIDER}|catalog:${String(catalogExternalId)}|${filterJson}`);
}

function checkpointChapterId(scope, catalogExternalId) {
  const raw = parseScopeObject(scope);
  const chapterIds = Array.isArray(raw.chapterIds)
    ? raw.chapterIds
    : (raw.chapterId == null ? [] : [raw.chapterId]);
  const chapterId = chapterIds.find((value) => value != null && String(value).trim() !== '');
  return String(chapterId == null ? catalogExternalId : chapterId).trim();
}

function insertRunCheckpointRows(db, targetRunId, rows) {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(RUN_CHECKPOINT_TABLE);
  if (!tableExists) throw resumeSourceError(`缺少 ${RUN_CHECKPOINT_TABLE} 表`);
  const insert = db.prepare(`
    INSERT INTO ${sqlIdentifier(RUN_CHECKPOINT_TABLE)} (
      run_id, scope_key, provider, chapter_id, filter_json,
      last_completed_page, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, scope_key) DO UPDATE SET
      provider = excluded.provider,
      chapter_id = excluded.chapter_id,
      filter_json = excluded.filter_json,
      last_completed_page = MAX(
        ${sqlIdentifier(RUN_CHECKPOINT_TABLE)}.last_completed_page,
        excluded.last_completed_page
      ),
      updated_at = excluded.updated_at
  `);
  let inserted = 0;
  for (const row of rows || []) {
    const scopeKey = String(row?.scopeKey || row?.scope_key || '').trim();
    const chapterId = String(row?.chapterId || row?.chapter_id || '').trim();
    const filterJson = String(row?.filterJson || row?.filter_json || '{}');
    if (!scopeKey || !chapterId) continue;
    const page = normalizeCheckpointPage(
      row?.lastCompletedPage ?? row?.last_completed_page,
      null,
    );
    if (page == null) throw resumeSourceError(`checkpoint 页码超出安全范围：${page}`);
    insert.run(
      Number(targetRunId),
      scopeKey,
      PROVIDER,
      chapterId,
      filterJson,
      page,
      String(row?.updatedAt || row?.updated_at || nowIso()),
    );
    inserted += 1;
  }
  return inserted;
}

/**
 * Clone checkpoints owned by a sealed source run.  Runs created before
 * run-scoped checkpoints existed (notably task 12/run 19) are reconstructed
 * only from that run's own sync_progress rows.  The mutable global
 * sync_checkpoints table is intentionally never consulted here.
 */
function copyResumeRunCheckpoints(db, sourceRunId, targetRunId, sourceScope) {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(RUN_CHECKPOINT_TABLE);
  if (!tableExists) throw resumeSourceError(`缺少 ${RUN_CHECKPOINT_TABLE} 表`);

  const sourceRows = db.prepare(`
    SELECT scope_key, provider, chapter_id, filter_json,
           last_completed_page, updated_at
    FROM ${sqlIdentifier(RUN_CHECKPOINT_TABLE)}
    WHERE run_id = ? AND provider = ?
    ORDER BY scope_key ASC
  `).all(Number(sourceRunId), PROVIDER);
  if (sourceRows.length > 0) {
    const normalized = sourceRows.map((row) => {
      const scopeKey = String(row.scope_key || '').trim();
      const chapterId = String(row.chapter_id || '').trim();
      if (!scopeKey || !chapterId || !String(row.filter_json || '').trim()) {
        throw resumeSourceError(`来源运行 ${sourceRunId} 的 run checkpoint 字段不完整`);
      }
      const page = normalizeCheckpointPage(row.last_completed_page, null);
      if (page == null) {
        throw resumeSourceError(`来源运行 ${sourceRunId} 的 checkpoint 页码超出安全范围`);
      }
      return {
        scopeKey,
        chapterId,
        filterJson: String(row.filter_json),
        lastCompletedPage: page,
        updatedAt: row.updated_at,
      };
    });
    return {
      source: 'run',
      count: insertRunCheckpointRows(db, targetRunId, normalized),
    };
  }

  const progressExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_progress' LIMIT 1",
  ).get();
  if (!progressExists) return { source: 'none', count: 0 };

  const filterJson = checkpointFilterJson(sourceScope);
  const chapterId = checkpointChapterId(sourceScope, '');
  const byScopeKey = new Map();
  for (const row of db.prepare(`
    SELECT catalog_external_id, current_page, updated_at
    FROM sync_progress
    WHERE run_id = ? AND catalog_external_id IS NOT NULL
    ORDER BY worker_id ASC
  `).all(Number(sourceRunId))) {
    const catalogId = String(row.catalog_external_id || '').trim();
    if (!catalogId) continue;
    const page = normalizeCheckpointPage(row.current_page, null);
    // A malformed progress row is unknown progress, never permission to
    // skip pages.  The catalog will therefore replay from page 1.
    if (page == null) continue;
    const scopeKey = checkpointScopeKey(catalogId, filterJson);
    const previous = byScopeKey.get(scopeKey);
    if (previous && previous.lastCompletedPage >= page) continue;
    byScopeKey.set(scopeKey, {
      scopeKey,
      chapterId: chapterId || catalogId,
      filterJson,
      lastCompletedPage: page,
      updatedAt: row.updated_at || nowIso(),
    });
  }
  return {
    source: 'legacy-progress',
    count: insertRunCheckpointRows(db, targetRunId, [...byScopeKey.values()]),
  };
}

function isResumablePartialRun(summary) {
  const status = String(summary?.status || '').trim().toLowerCase();
  if (status !== 'interrupted') return false;
  const lockedAt = summary?.snapshotLockedAt ?? summary?.snapshot_locked_at;
  if (lockedAt == null || String(lockedAt).trim() === '') return false;
  if (summary?.snapshotComplete === true || Number(summary?.snapshot_complete || 0) === 1) {
    return false;
  }
  const coreCounts = [
    summary?.catalogCount ?? summary?.catalogItemCount ?? 0,
    summary?.questionCount ?? summary?.questionItemCount ?? 0,
    summary?.questionCatalogCount ?? 0,
  ].map((value) => Number(value));
  if (coreCounts.some((value) => !Number.isFinite(value) || value < 0)) return false;
  // A resumable clone must contain every core relation independently.
  // Summing the counters could incorrectly accept e.g. catalogs=3 while
  // questions/relations are empty, which cannot form a usable page snapshot.
  if (coreCounts.some((value) => value <= 0)) return false;
  const errors = Array.isArray(summary?.errors)
    ? summary.errors.map((error) => ({
      error_code: error.errorCode ?? error.error_code,
      stage: error.stage,
      message: error.message,
    }))
    : [];
  return !hasDeterministicResumeError({ message: summary.message }, errors);
}

/**
 * Validate an explicitly selected source run with the established Collector
 * contract while allowing the list collector to widen operational bounds.
 * A partial one-page probe may therefore continue as a full run, but cannot
 * change textbook, catalog selection, filters, or asset policy; it may widen
 * but never narrow the page/limit budget of its sealed source run.
 */
function validateQuestionListResumeSourceRun(dbPath, sourceRunId, targetScope) {
  let db;
  let sourceScope = {};
  try {
    db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
    const row = db.prepare('SELECT scope_json FROM sync_runs WHERE id = ?').get(Number(sourceRunId));
    if (row) {
      try { sourceScope = JSON.parse(row.scope_json || '{}'); } catch {}
    }
  } finally {
    try { db?.close(); } catch {}
  }
  const sourceMaxPages = Number(sourceScope.maxPages || 0);
  const targetMaxPages = Number(targetScope.maxPages || 0);
  if (sourceMaxPages > 0 && targetMaxPages > 0 && targetMaxPages < sourceMaxPages) {
    throw new QuestionSyncError('续采不能缩小 --max-pages。', 'resume_source_invalid');
  }
  const sourceLimit = Number(sourceScope.limit || 0);
  const targetLimit = Number(targetScope.limit || 0);
  if ((sourceLimit === 0 && targetLimit > 0)
    || (sourceLimit > 0 && targetLimit > 0 && targetLimit < sourceLimit)) {
    throw new QuestionSyncError('续采不能缩小 --limit。', 'resume_source_invalid');
  }
  return validateResumeSourceRun(dbPath, sourceRunId, {
    ...targetScope,
    maxPages: sourceScope.maxPages ?? targetScope.maxPages,
    limit: sourceScope.limit ?? targetScope.limit,
  }, { sealedRefill: true });
}

module.exports = {
  MAX_CHECKPOINT_PAGE,
  RESUME_DETERMINISTIC_MARKERS,
  RESUME_TRANSIENT_MARKERS,
  canonicalScopeArray,
  canonicalScopeBoolean,
  canonicalScopeFacet,
  canonicalScopeNumber,
  checkpointChapterId,
  checkpointFilterJson,
  checkpointScopeKey,
  copyResumeRunCheckpoints,
  copyResumeSnapshotRows,
  hasDeterministicResumeError,
  insertRunCheckpointRows,
  isResumablePartialRun,
  isTransientResumeError,
  normalizeCheckpointPage,
  normalizeResumeScope,
  parseScopeObject,
  resumeScopeDifferences,
  resumeSourceError,
  scopeTextbookIds,
  snapshotTableCounts,
  sourceRunErrors,
  sqlIdentifier,
  validateQuestionListResumeSourceRun,
  validateResumeSourceRun,
  validateResumeSourceRunInDb,
};
