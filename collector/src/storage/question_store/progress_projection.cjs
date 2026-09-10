'use strict';

/**
 * Live progress projection consumed by the HTTP API: per-catalog progress rows
 * and the concurrent fetch window slots.  Diagnostic/UI data only.
 *
 * Methods are mixed into QuestionSyncStore.prototype (see index.cjs); `this`
 * is the store instance (`this.db`, `this.dataDir`).
 */

const { nowIso } = require('../../shared/utils.cjs');
const { DEFAULT_PAGE_CAPACITY, PROVIDER } = require('../../sources/zujuan/constants.cjs');
const { growTargetPages } = require('../../policies/pagination.cjs');

class ProgressProjectionMethods {
  getRunCatalogProgress(runId, textbookId, catalogId) {
    const row = this.db.prepare(`
      SELECT expected_total, page_capacity, expected_pages, last_completed_page,
        list_seen_count, status, target_pages, max_observed_total,
        highest_attempted_page, scan_complete, data_complete, completion_quality,
        failed_page_count, duplicate_page_count, empty_page_count,
        parse_error_count, asset_error_count, stall_reason, scan_percent_high_water
      FROM sync_run_catalog_progress
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        AND catalog_external_id = ?
    `).get(Number(runId), PROVIDER, String(textbookId), String(catalogId));
    if (!row) return null;
    return {
      expectedTotal: row.expected_total == null ? null : Number(row.expected_total),
      pageCapacity: row.page_capacity == null ? null : Number(row.page_capacity),
      expectedPages: row.expected_pages == null ? null : Number(row.expected_pages),
      lastCompletedPage: Number(row.last_completed_page || 0),
      lastContiguousSuccessfulPage: Number(row.last_completed_page || 0),
      listSeenCount: Number(row.list_seen_count || 0),
      status: String(row.status || ''),
      targetPages: row.target_pages == null ? null : Number(row.target_pages),
      maxObservedTotal: row.max_observed_total == null ? null : Number(row.max_observed_total),
      highestAttemptedPage: Number(row.highest_attempted_page || 0),
      scanComplete: Number(row.scan_complete || 0) === 1,
      dataComplete: Number(row.data_complete || 0) === 1,
      completionQuality: row.completion_quality || null,
      failedPageCount: Number(row.failed_page_count || 0),
      duplicatePageCount: Number(row.duplicate_page_count || 0),
      emptyPageCount: Number(row.empty_page_count || 0),
      parseErrorCount: Number(row.parse_error_count || 0),
      assetErrorCount: Number(row.asset_error_count || 0),
      stallReason: row.stall_reason || null,
      pageLimitReached: row.stall_reason === 'page_limit_1000',
      scanPercentHighWater: row.scan_percent_high_water == null ? null : Number(row.scan_percent_high_water),
    };
  }

  _upsertCatalogProgressRow({
    runId,
    textbookId,
    catalogId,
    expectedTotal = null,
    pageCapacity = DEFAULT_PAGE_CAPACITY,
    targetPages = null,
    lastCompletedPage = 0,
    occurrenceCount = 0,
    status = 'running',
    scanComplete = false,
    dataComplete = false,
    completionQuality = null,
    stallReason = null,
    assetErrorDelta = 0,
    targetPageLimit = null,
    observedAt = nowIso(),
  }) {
    const issueCounts = this.catalogPageIssueCounts(runId, textbookId, catalogId);
    const highestAttempted = Number(this.db.prepare(`
      SELECT COALESCE(MAX(page_number), 0) AS n FROM sync_run_catalog_pages
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        AND catalog_external_id = ?
    `).get(Number(runId), PROVIDER, String(textbookId), String(catalogId))?.n || 0);
    const existing = this.db.prepare(`
      SELECT max_observed_total, target_pages, asset_error_count, scan_percent_high_water
      FROM sync_run_catalog_progress
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        AND catalog_external_id = ?
    `).get(Number(runId), PROVIDER, String(textbookId), String(catalogId));
    const maxObserved = Math.max(
      Number(existing?.max_observed_total) || 0,
      expectedTotal == null ? 0 : Number(expectedTotal) || 0,
    );
    let grownTarget = growTargetPages(
      Math.max(Number(existing?.target_pages) || 0, targetPages == null ? 0 : Number(targetPages) || 0),
      maxObserved || null,
      pageCapacity,
    );
    const boundedTargetPageLimit = Number(targetPageLimit);
    if (Number.isFinite(boundedTargetPageLimit) && boundedTargetPageLimit > 0) {
      grownTarget = Math.min(grownTarget, boundedTargetPageLimit);
    }
    const latestTotal = expectedTotal == null
      ? (existing?.max_observed_total == null ? null : Number(existing.max_observed_total))
      : Number(expectedTotal);
    const assets = Number(existing?.asset_error_count || 0) + Math.max(0, Number(assetErrorDelta) || 0);
    const attemptedTarget = grownTarget > 0
      ? Number(this.db.prepare(`
          SELECT COUNT(*) AS n FROM sync_run_catalog_pages
          WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
            AND catalog_external_id = ? AND page_number BETWEEN 1 AND ?
        `).get(Number(runId), PROVIDER, String(textbookId), String(catalogId), grownTarget)?.n || 0)
      : issueCounts.attemptedPageCount;
    const rawPercent = scanComplete
      ? 100
      : (grownTarget > 0 ? Math.min(100, (attemptedTarget / grownTarget) * 100) : null);
    const highWater = Math.max(
      Number(existing?.scan_percent_high_water) || 0,
      rawPercent == null ? 0 : rawPercent,
    );
    this.db.prepare(`
      INSERT INTO sync_run_catalog_progress (
        run_id, provider, textbook_external_id, catalog_external_id,
        expected_total, page_capacity, expected_pages, last_completed_page,
        list_seen_count, status, observed_at, target_pages, max_observed_total,
        highest_attempted_page, scan_complete, data_complete, completion_quality,
        failed_page_count, duplicate_page_count, empty_page_count,
        parse_error_count, asset_error_count, stall_reason, scan_percent_high_water
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider, textbook_external_id, catalog_external_id)
      DO UPDATE SET
        expected_total = COALESCE(excluded.expected_total, sync_run_catalog_progress.expected_total),
        page_capacity = COALESCE(excluded.page_capacity, sync_run_catalog_progress.page_capacity),
        expected_pages = MAX(
          COALESCE(sync_run_catalog_progress.expected_pages, 0),
          COALESCE(excluded.expected_pages, 0)
        ),
        last_completed_page = excluded.last_completed_page,
        list_seen_count = excluded.list_seen_count,
        status = excluded.status,
        observed_at = excluded.observed_at,
        target_pages = MAX(
          COALESCE(sync_run_catalog_progress.target_pages, 0),
          COALESCE(excluded.target_pages, 0)
        ),
        max_observed_total = MAX(
          COALESCE(sync_run_catalog_progress.max_observed_total, 0),
          COALESCE(excluded.max_observed_total, 0)
        ),
        highest_attempted_page = MAX(
          sync_run_catalog_progress.highest_attempted_page,
          excluded.highest_attempted_page
        ),
        scan_complete = excluded.scan_complete,
        data_complete = excluded.data_complete,
        completion_quality = COALESCE(excluded.completion_quality, sync_run_catalog_progress.completion_quality),
        failed_page_count = excluded.failed_page_count,
        duplicate_page_count = excluded.duplicate_page_count,
        empty_page_count = excluded.empty_page_count,
        parse_error_count = excluded.parse_error_count,
        asset_error_count = excluded.asset_error_count,
        stall_reason = COALESCE(excluded.stall_reason, sync_run_catalog_progress.stall_reason),
        scan_percent_high_water = MAX(
          COALESCE(sync_run_catalog_progress.scan_percent_high_water, 0),
          COALESCE(excluded.scan_percent_high_water, 0)
        )
    `).run(
      Number(runId), PROVIDER, String(textbookId), String(catalogId),
      latestTotal, Number(pageCapacity) || DEFAULT_PAGE_CAPACITY,
      grownTarget || null, Number(lastCompletedPage) || 0, Number(occurrenceCount) || 0,
      String(status || 'running'), observedAt, grownTarget || null,
      maxObserved || null, highestAttempted, scanComplete ? 1 : 0, dataComplete ? 1 : 0,
      completionQuality, issueCounts.failedPageCount, issueCounts.duplicatePageCount,
      issueCounts.emptyPageCount, issueCounts.parseErrorCount, assets, stallReason,
      rawPercent == null ? (existing?.scan_percent_high_water ?? null) : highWater,
    );
  }


  upsertFetchWindow({
    runId,
    catalog,
    expectedPages = null,
    expectedTotal = null,
    slots = [],
  }) {
    const observedAt = nowIso();
    const catalogId = String(catalog?.externalId || '');
    const catalogName = String(catalog?.name || catalogId);
    const catalogPath = String(catalog?.path || catalog?.name || catalogId);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare('DELETE FROM sync_progress WHERE run_id = ?').run(Number(runId));
      const insert = this.db.prepare(`
        INSERT INTO sync_progress (
          run_id, worker_id, catalog_external_id, catalog_name, catalog_path,
          current_page, expected_pages, expected_total, updated_at,
          slot_status, question_count, result_type, message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      (Array.isArray(slots) ? slots : []).forEach((slot, index) => {
        const slotNumber = Number(slot.slot) > 0 ? Number(slot.slot) : index + 1;
        insert.run(
          Number(runId),
          slotNumber,
          catalogId || null,
          catalogName,
          catalogPath,
          slot.pageNumber == null ? null : Number(slot.pageNumber),
          expectedPages == null ? null : Number(expectedPages),
          expectedTotal == null ? null : Number(expectedTotal),
          observedAt,
          String(slot.status || 'fetching'),
          slot.questionCount == null ? null : Number(slot.questionCount),
          slot.resultType || null,
          slot.line || slot.message || null,
        );
      });
      this.db.exec('COMMIT;');
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  }

  updateFetchSlot(runId, pageNumber, patch = {}) {
    const observedAt = nowIso();
    const existing = this.db.prepare(`
      SELECT worker_id FROM sync_progress
      WHERE run_id = ? AND current_page = ?
      ORDER BY worker_id ASC LIMIT 1
    `).get(Number(runId), Number(pageNumber));
    if (!existing) return false;
    this.db.prepare(`
      UPDATE sync_progress
      SET slot_status = COALESCE(?, slot_status),
          question_count = COALESCE(?, question_count),
          result_type = COALESCE(?, result_type),
          message = COALESCE(?, message),
          expected_total = COALESCE(?, expected_total),
          expected_pages = COALESCE(?, expected_pages),
          updated_at = ?
      WHERE run_id = ? AND worker_id = ?
    `).run(
      patch.status || null,
      patch.questionCount == null ? null : Number(patch.questionCount),
      patch.resultType || null,
      patch.line || patch.message || null,
      patch.sourceTotal == null ? null : Number(patch.sourceTotal),
      patch.targetPages == null ? null : Number(patch.targetPages),
      observedAt,
      Number(runId),
      Number(existing.worker_id),
    );
    return true;
  }

  clearFetchWindow(runId) {
    this.db.prepare('DELETE FROM sync_progress WHERE run_id = ?').run(Number(runId));
  }


}

module.exports = { ProgressProjectionMethods };
