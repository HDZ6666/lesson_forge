'use strict';

/**
 * Run lifecycle: begin/finish a run, scope updates, snapshot counts and the
 * completeness verdict that decides whether a run may be sealed as complete.
 *
 * Methods are mixed into QuestionSyncStore.prototype (see index.cjs); `this`
 * is the store instance (`this.db`, `this.dataDir`).
 */

const { QuestionSyncError } = require('../../shared/errors.cjs');
const { jsonStringify, nowIso, quoteIdentifier } = require('../../shared/utils.cjs');
const { PROVIDER } = require('../../sources/zujuan/constants.cjs');
const { completionQualityFor, resolveFinalRunState } = require('../../policies/completeness.cjs');
const { captureRunCoverage } = require('../readers/run_coverage.cjs');
const { scopeTextbookIds, snapshotScopeIds } = require('../readers/common.cjs');

class RunLifecycleMethods {
  beginRun(scope, { resume = true, resumeRunId = null } = {}) {
    const normalized = this._scopeObject(scope);
    const explicitResumeRunId = resumeRunId == null ? null : Number(resumeRunId);
    if (explicitResumeRunId != null) {
      if (this.db.prepare('SELECT 1 FROM sync_result_cleanup WHERE run_id=?').get(explicitResumeRunId)) throw new QuestionSyncError('原始成果已回收，请重新同步教材。', 'resume_source_invalid');
      const source = this.getRun(explicitResumeRunId);
      if (!source) throw new QuestionSyncError(`续采来源 run=${explicitResumeRunId} 不存在。`, 'resume_source_invalid');
      if (!source.snapshot_locked_at || Number(source.snapshot_complete || 0) === 1) {
        throw new QuestionSyncError(`续采来源 run=${explicitResumeRunId} 不是已封存的不完整运行。`, 'resume_source_invalid');
      }
      let sourceScope = {};
      try { sourceScope = JSON.parse(source.scope_json || '{}'); } catch {}
      if (this._scopeIdentity(sourceScope) !== this._scopeIdentity(normalized)) {
        throw new QuestionSyncError(`续采来源 run=${explicitResumeRunId} 与当前教材范围不匹配。`, 'resume_source_invalid');
      }
    }
    if (resume && explicitResumeRunId == null) {
      const running = this._latestRun(normalized, ['running']);
      if (running) {
        this.lastBeginMeta = { runId: Number(running.id), reused: true, clonedFrom: null };
        return Number(running.id);
      }
    }
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = this.db.prepare(`
        INSERT INTO sync_runs (provider, started_at, status, scope_json)
        VALUES (?, ?, 'running', ?)
      `).run(PROVIDER, nowIso(), jsonStringify(normalized));
      const runId = Number(result.lastInsertRowid);
      let clonedFrom = null;
      if (resume) {
        const source = explicitResumeRunId == null
          ? this._latestRun(normalized, ['interrupted', 'blocked', 'failed'])
          : this.getRun(explicitResumeRunId);
        if (source && Number(source.snapshot_complete || 0) !== 1) {
          const sourceId = Number(source.id);
          for (const table of [
            'sync_run_catalog_items',
            'sync_run_question_items',
            'sync_run_question_catalogs',
            'sync_run_question_tags',
            'sync_run_question_assets',
            'sync_run_checkpoints',
            'sync_run_catalog_progress',
            'sync_run_catalog_pages',
          ]) this._copyTableRows(table, sourceId, runId);
          clonedFrom = sourceId;
          const priorScope = JSON.parse(source.scope_json || '{}');
          this.db.prepare('UPDATE sync_runs SET scope_json=? WHERE id=?').run(jsonStringify({
            ...normalized, resumeScanHints: priorScope.resumeScanHints || {},
            scanCatalogIds: priorScope.scanCatalogIds || [],
          }), runId);
          this.db.prepare('UPDATE sync_runs SET message = ? WHERE id = ?')
            .run(`续采来源 run=${sourceId}`, runId);
        }
      }
      this.db.exec('COMMIT;');
      this.lastBeginMeta = { runId, reused: false, clonedFrom };
      return runId;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  }

  getRun(runId) {
    return this.db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(Number(runId)) || null;
  }

  resetRunScan(runId) {
    const run = this.getRun(runId);
    if (!run || run.status !== 'running' || run.snapshot_locked_at) {
      throw new QuestionSyncError('只能重置当前未封存运行的扫描证据', 'resume_source_invalid');
    }
    // Latest-first pagination has no provider change cursor. Retain cloned
    // question observations, but do not treat old page numbers as current
    // scan coverage. A fresh scan is the supported fallback.
    const oldScope = JSON.parse(run.scope_json || '{}');
    const hints = { ...(oldScope.resumeScanHints || {}) };
    const rows = this.db.prepare(`SELECT catalog_external_id, MAX(page_number) AS last_page
      FROM sync_run_catalog_pages WHERE run_id=? AND result_type='success' AND question_count>0
      GROUP BY catalog_external_id`).all(Number(runId));
    for (const row of rows) {
      const id = String(row.catalog_external_id);
      const last = this.db.prepare(`SELECT question_ids_json FROM sync_run_catalog_pages
        WHERE run_id=? AND catalog_external_id=? AND page_number=?`).get(Number(runId), id, row.last_page);
      const progress = this.getRunCatalogProgress(runId, oldScope.textbookId, id);
      // A head refresh must not move an inherited deeper frontier backwards.
      if (Number(row.last_page) >= Number(hints[id]?.lastPage || 0)) {
        const ids = JSON.parse(last.question_ids_json || '[]').map(String);
        hints[id] = { lastPage: Number(row.last_page), anchorId: ids.at(-1),
          total: progress?.expectedTotal ?? null, finished: Boolean(hints[id]?.finished || progress?.scanComplete) };
      }
    }
    // Once a refill pass reaches every observed tail, the next pass starts a
    // fresh audit. Hints never turn inherited pages into current scan proof.
    const values = Object.values(hints);
    const targets = oldScope.scanCatalogIds || [];
    const result = values.length && targets.length && targets.every(id => hints[String(id)]?.finished) ? {} : hints;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['sync_run_checkpoints', 'sync_run_catalog_progress', 'sync_run_catalog_pages']) {
        this.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(Number(runId));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return result;
  }

  updateRunScope(runId, scope) {
    this.db.prepare('UPDATE sync_runs SET scope_json = ? WHERE id = ? AND status = \'running\'')
      .run(jsonStringify(this._scopeObject(scope)), Number(runId));
  }


  runSnapshotCounts(runId, textbookId = null) {
    const id = Number(runId);
    const filter = textbookId == null ? '' : ' AND textbook_external_id = ?';
    const args = textbookId == null ? [id] : [id, String(textbookId)];
    const count = (table) => Number(this.db.prepare(
      `SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)} WHERE run_id = ?${filter}`,
    ).get(...args).n || 0);
    return {
      catalogCount: count('sync_run_catalog_items'),
      questionCount: count('sync_run_question_items'),
      questionCatalogCount: count('sync_run_question_catalogs'),
      questionTagCount: count('sync_run_question_tags'),
      questionAssetCount: count('sync_run_question_assets'),
    };
  }

  validateRunCompleteness(runId, scope, catalogs = [], counters = {}) {
    const value = scope && typeof scope === 'object' ? scope : {};
    const textbookId = String(value.textbookId || '');
    const counts = this.runSnapshotCounts(runId, textbookId);
    const scanReasons = [];
    if ((value.resumeCoverageGaps || []).length) scanReasons.push('补采已复核断点并继续尾段，中间旧页尚未在本轮连续核对');
    const dataReasons = [];
    const availableCount = Number(value.availableCatalogCount || catalogs.length);
    const selectedCount = Number(value.selectedCatalogCount || catalogs.length);
    if (value.catalogSelectionTruncated || (value.allCatalogs && selectedCount < availableCount)) {
      scanReasons.push('目录被 max-catalogs 截断');
    }
    if (Number(value.limit || 0) > 0) scanReasons.push('题目被 limit 截断');
    if (Number(counters?.errors || 0) > 0) dataReasons.push('运行存在错误，禁止封存为完整快照');
    const progress = this.db.prepare(`
      SELECT catalog_external_id, last_completed_page, status,
        scan_complete, data_complete, completion_quality,
        failed_page_count, duplicate_page_count, parse_error_count, asset_error_count,
        stall_reason
      FROM sync_run_catalog_progress
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
    `).all(Number(runId), PROVIDER, textbookId);
    const byCatalog = new Map(progress.map((row) => [String(row.catalog_external_id), row]));
    for (const catalog of catalogs) {
      const id = String(catalog.externalId);
      const row = byCatalog.get(id);
      if (!row) {
        scanReasons.push(`目录 ${id} 没有分页进度`);
        continue;
      }
      const status = String(row.status || '');
      const scanned = Number(row.scan_complete || 0) === 1
        || ['completed', 'stalled'].includes(status);
      if (!scanned) scanReasons.push(`目录 ${id} 尚未扫描完成`);
      if (this.catalogHasDataIssues(runId, textbookId, id)
        || Number(row.data_complete || 0) === 0
        || status === 'stalled'
        || String(row.completion_quality || '') === 'completed_with_issues') {
        dataReasons.push(`目录 ${id} 存在扫描或素材异常`);
      }
    }
    if (counts.catalogCount <= 0) scanReasons.push('运行快照缺少目录');
    const incompleteContent = this.db.prepare(`
      SELECT COUNT(*) AS n FROM sync_run_question_items
      WHERE run_id = ? AND textbook_external_id = ?
        AND content_source = 'list_api' AND COALESCE(content_complete, 0) <> 1
    `).get(Number(runId), textbookId);
    if (Number(incompleteContent?.n || 0) > 0) dataReasons.push('列表题干不完整');
    if (counts.questionCount > 0 && counts.questionCatalogCount <= 0) {
      dataReasons.push('运行快照缺少题目目录关系');
    }
    if (value.downloadAssets) {
      const missingAssets = this.db.prepare(`
        SELECT COUNT(*) AS n FROM sync_run_question_assets
        WHERE run_id = ? AND textbook_external_id = ?
          AND (source_url IS NULL OR source_url = ''
            OR content_sha256 IS NULL OR content_sha256 = ''
            OR storage_path IS NULL OR storage_path = '')
      `).get(Number(runId), textbookId);
      if (Number(missingAssets?.n || 0) > 0) dataReasons.push('题目素材未完整下载');
      const flagged = this.db.prepare(`
        SELECT COUNT(*) AS n FROM sync_run_question_items AS q
        WHERE q.run_id = ? AND q.textbook_external_id = ?
          AND (COALESCE(q.has_image, 0) = 1 OR COALESCE(q.has_formula, 0) = 1)
          AND NOT EXISTS (
            SELECT 1 FROM sync_run_question_assets AS a
            WHERE a.run_id = q.run_id AND a.provider = q.provider
              AND a.textbook_external_id = q.textbook_external_id
              AND a.question_external_id = q.question_external_id
          )
      `).get(Number(runId), textbookId);
      if (Number(flagged?.n || 0) > 0) dataReasons.push('题目标记的素材未写入快照');
    }
    const scanComplete = scanReasons.length === 0;
    const dataComplete = dataReasons.length === 0;
    const reasons = [...scanReasons, ...dataReasons];
    return {
      complete: scanComplete && dataComplete,
      scanComplete,
      dataComplete,
      completionQuality: !scanComplete
        ? null
        : (dataComplete ? 'completed' : 'completed_with_issues'),
      snapshotComplete: scanComplete && dataComplete,
      reasons,
      scanReasons,
      dataReasons,
      counts,
      progress,
    };
  }

  finishRun(runId, status, counters = {}, message = null, completeness = null) {
    const current = this.getRun(runId);
    if (!current || String(current.status) !== 'running' || current.snapshot_locked_at) return false;
    const wantsSuccess = ['success', 'completed'].includes(String(status));
    const scanComplete = Boolean(completeness?.scanComplete);
    const dataComplete = Boolean(completeness?.complete) || (
      scanComplete && completeness?.dataComplete === true
    );
    const snapshotComplete = wantsSuccess && scanComplete && dataComplete;
    let effectiveStatus;
    if (!wantsSuccess) effectiveStatus = String(status);
    else if (scanComplete) effectiveStatus = String(status);
    else effectiveStatus = 'interrupted';
    const completionQuality = scanComplete
      ? (dataComplete ? 'completed' : 'completed_with_issues')
      : null;
    const counts = this.runSnapshotCounts(runId, completeness?.scope?.textbookId || null);
    const finishedAt = nowIso();
    const scope = JSON.parse(current.scope_json || '{}');
    // Freeze actual scan metrics in the same terminal row update. Progress
    // projections are mutable and must never be read as sealed evidence.
    const declaredIds = scopeTextbookIds(scope);
    if (scope.coverageFormat === 'run-coverage-v1' && declaredIds.length === 1) {
      const run = { id: Number(runId), scope, textbookExternalIds: declaredIds };
      scope.sealedCoverageEvidence = captureRunCoverage(
        this.db, run, declaredIds[0], snapshotScopeIds(this.db, run),
      );
    }
    this.db.prepare(`
      UPDATE sync_runs SET finished_at = ?, status = ?, pages_ok = ?,
        questions_seen = ?, questions_inserted = ?, questions_updated = ?,
        details_fetched = 0, assets_downloaded = ?, error_count = ?,
        message = ?, catalog_item_count = ?, question_item_count = ?,
        question_catalog_count = ?, question_tag_count = ?, question_asset_count = ?,
        snapshot_complete = ?, snapshot_locked_at = ?,
        scan_complete = ?, data_complete = ?, completion_quality = ?, scope_json = ?
      WHERE id = ? AND status = 'running' AND snapshot_locked_at IS NULL
    `).run(
      finishedAt, effectiveStatus, Number(counters.pagesOk || 0), Number(counters.questionsSeen || 0),
      Number(counters.questionsInserted || 0), Number(counters.questionsUpdated || 0),
      Number(counters.assetsDownloaded || 0), Number(counters.errors || 0),
      message || (snapshotComplete
        ? null
        : (completeness?.reasons || []).join('；') || null),
      counts.catalogCount, counts.questionCount, counts.questionCatalogCount,
      counts.questionTagCount, counts.questionAssetCount, snapshotComplete ? 1 : 0, finishedAt,
      scanComplete ? 1 : 0, dataComplete ? 1 : 0, completionQuality, jsonStringify(scope),
      Number(runId),
    );
    return effectiveStatus;
  }

}

module.exports = { RunLifecycleMethods };
