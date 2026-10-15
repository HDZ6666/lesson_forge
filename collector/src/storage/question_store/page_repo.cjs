'use strict';

/**
 * Page transactions: checkpoints, page signatures, per-page attempts and the
 * question/tag/asset/membership rows written together with each page.
 *
 * Methods are mixed into QuestionSyncStore.prototype (see index.cjs); `this`
 * is the store instance (`this.db`, `this.dataDir`).
 */

const { QuestionSyncError } = require('../../shared/errors.cjs');
const { jsonStringify, normalizeId, nowIso, sha256, sqliteValue } = require('../../shared/utils.cjs');
const {
  DEFAULT_PAGE_CAPACITY,
  PAGE_RESULT,
  PROVIDER,
  SCAN_ISSUE_RESULTS,
} = require('../../sources/zujuan/constants.cjs');
const { finalizeQuestion, normalizeAssetType } = require('../../sources/zujuan/question_parser.cjs');
const { assetKey: canonicalAssetKey } = require('../../qbpkg/normalize.cjs');
const { growTargetPages } = require('../../policies/pagination.cjs');

class PageRepoMethods {
  getQuestion(externalId) {
    return (
      this.db
        .prepare('SELECT * FROM questions WHERE provider = ? AND external_id = ?')
        .get(PROVIDER, String(externalId)) || null
    );
  }

  getRunCheckpoint(runId, scopeKey) {
    const row = this.db
      .prepare(
        `
      SELECT last_completed_page FROM sync_run_checkpoints
      WHERE run_id = ? AND provider = ? AND scope_key = ?
    `,
      )
      .get(Number(runId), PROVIDER, String(scopeKey));
    return Number(row?.last_completed_page || 0);
  }

  getCheckpoint(scopeKey) {
    const row = this.db
      .prepare('SELECT last_completed_page FROM sync_checkpoints WHERE scope_key = ?')
      .get(String(scopeKey));
    return Number(row?.last_completed_page || 0);
  }

  getRunPageSignatures(runId, catalogId) {
    return this.db
      .prepare(
        `
      SELECT page_number, page_signature, question_count, question_ids_json,
        result_type, attempt_count, error_code
      FROM sync_run_catalog_pages
      WHERE run_id = ? AND provider = ? AND catalog_external_id = ?
      ORDER BY page_number ASC
    `,
      )
      .all(Number(runId), PROVIDER, String(catalogId))
      .map((row) => ({
        pageNumber: Number(row.page_number),
        signature: String(row.page_signature || ''),
        questionCount: Number(row.question_count || 0),
        resultType: String(row.result_type || PAGE_RESULT.SUCCESS),
        attemptCount: Number(row.attempt_count || 1),
        errorCode: row.error_code || null,
        questionIds: (() => {
          try {
            return JSON.parse(row.question_ids_json || '[]').map(String);
          } catch {
            return [];
          }
        })(),
      }));
  }

  lastContiguousSuccessfulPage(runId, textbookId, catalogId) {
    const rows = this.db
      .prepare(
        `
      SELECT page_number, result_type, question_count
      FROM sync_run_catalog_pages
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        AND catalog_external_id = ?
      ORDER BY page_number ASC
    `,
      )
      .all(Number(runId), PROVIDER, String(textbookId), String(catalogId));
    const success = new Set(
      rows
        .filter(
          (row) =>
            String(row.result_type || PAGE_RESULT.SUCCESS) === PAGE_RESULT.SUCCESS &&
            Number(row.question_count || 0) > 0,
        )
        .map((row) => Number(row.page_number)),
    );
    let last = 0;
    while (success.has(last + 1)) last += 1;
    return last;
  }

  catalogPageIssueCounts(runId, textbookId, catalogId) {
    const rows = this.db
      .prepare(
        `
      SELECT result_type, COUNT(*) AS n
      FROM sync_run_catalog_pages
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        AND catalog_external_id = ?
      GROUP BY result_type
    `,
      )
      .all(Number(runId), PROVIDER, String(textbookId), String(catalogId));
    const counts = {
      failedPageCount: 0,
      duplicatePageCount: 0,
      emptyPageCount: 0,
      parseErrorCount: 0,
      attemptedPageCount: 0,
    };
    for (const row of rows) {
      const type = String(row.result_type || PAGE_RESULT.SUCCESS);
      const n = Number(row.n || 0);
      counts.attemptedPageCount += n;
      if (type === PAGE_RESULT.DUPLICATE_PAGE) counts.duplicatePageCount += n;
      else if (type === PAGE_RESULT.EMPTY_PAGE) counts.emptyPageCount += n;
      else if (type === PAGE_RESULT.PARSE_FAILED || type === PAGE_RESULT.PAGE_DUPLICATE_QUESTIONS) {
        counts.parseErrorCount += n;
      } else if (SCAN_ISSUE_RESULTS.has(type)) counts.failedPageCount += n;
    }
    return counts;
  }

  uniqueCatalogQuestionCount(runId, textbookId, catalogId) {
    return Number(
      this.db
        .prepare(
          `
      SELECT COUNT(DISTINCT question_external_id) AS n
      FROM sync_run_question_catalogs
      WHERE run_id = ? AND textbook_external_id = ? AND catalog_external_id = ?
    `,
        )
        .get(Number(runId), String(textbookId), String(catalogId))?.n || 0,
    );
  }

  recordPageAttempt({
    runId,
    textbookExternalId,
    catalog,
    pageNumber,
    resultType,
    errorCode = null,
    questionIds = [],
    newQuestionCount = 0,
    queryFingerprint,
    filterJson = '{}',
    expectedTotal = null,
    pageCapacity = DEFAULT_PAGE_CAPACITY,
    targetPages = null,
    targetPageLimit = null,
    rawSnapshot = null,
    assetErrorDelta = 0,
  }) {
    const observedAt = nowIso();
    const catalogId = String(catalog?.externalId || '');
    if (!catalogId) throw new QuestionSyncError('页面缺少目录 ID。', 'checkpoint_contract');
    const ids = (Array.isArray(questionIds) ? questionIds : []).map((value) => String(value));
    const signature = ids.length ? sha256(ids.join(',')) : sha256(`${resultType}:${pageNumber}`);
    const questionCount = resultType === PAGE_RESULT.SUCCESS ? ids.length : 0;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.db
        .prepare(
          `
        SELECT attempt_count, first_seen_at FROM sync_run_catalog_pages
        WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
          AND catalog_external_id = ? AND page_number = ?
      `,
        )
        .get(Number(runId), PROVIDER, String(textbookExternalId), catalogId, Number(pageNumber));
      this.db
        .prepare(
          `
        INSERT INTO sync_run_catalog_pages (
          run_id, provider, textbook_external_id, catalog_external_id,
          page_number, page_signature, question_count, question_ids_json, observed_at,
          attempt_status, attempt_count, result_type, error_code, raw_snapshot_path,
          first_seen_at, finished_at, new_question_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, provider, textbook_external_id, catalog_external_id, page_number)
        DO UPDATE SET page_signature = excluded.page_signature,
          question_count = excluded.question_count,
          question_ids_json = excluded.question_ids_json,
          observed_at = excluded.observed_at,
          attempt_status = excluded.attempt_status,
          attempt_count = excluded.attempt_count,
          result_type = excluded.result_type,
          error_code = excluded.error_code,
          raw_snapshot_path = COALESCE(excluded.raw_snapshot_path, sync_run_catalog_pages.raw_snapshot_path),
          finished_at = excluded.finished_at,
          new_question_count = excluded.new_question_count
      `,
        )
        .run(
          Number(runId),
          PROVIDER,
          String(textbookExternalId),
          catalogId,
          Number(pageNumber),
          signature,
          questionCount,
          jsonStringify(ids, '[]'),
          observedAt,
          'resolved',
          Number(existing?.attempt_count || 0) + 1,
          String(resultType),
          errorCode,
          rawSnapshot?.filePath || null,
          existing?.first_seen_at || observedAt,
          observedAt,
          Number(newQuestionCount) || 0,
        );
      const occurrenceCount = Number(
        this.db
          .prepare(
            `
        SELECT COALESCE(SUM(question_count), 0) AS n
        FROM sync_run_catalog_pages
        WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
          AND catalog_external_id = ?
      `,
          )
          .get(Number(runId), PROVIDER, String(textbookExternalId), catalogId)?.n || 0,
      );
      const lastCompletedPage = this.lastContiguousSuccessfulPage(runId, textbookExternalId, catalogId);
      this._upsertCatalogProgressRow({
        runId,
        textbookId: textbookExternalId,
        catalogId,
        expectedTotal,
        pageCapacity,
        targetPages,
        targetPageLimit,
        lastCompletedPage,
        occurrenceCount,
        status: 'running',
        assetErrorDelta,
        observedAt,
      });
      const scopeKey = String(queryFingerprint || '').trim();
      if (scopeKey) {
        this.db
          .prepare(
            `
          INSERT INTO sync_checkpoints (
            scope_key, provider, chapter_id, filter_json, last_completed_page, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope_key) DO UPDATE SET last_completed_page = excluded.last_completed_page,
            updated_at = excluded.updated_at
        `,
          )
          .run(
            scopeKey,
            PROVIDER,
            String(catalog.chapterExternalId || catalog.externalId),
            String(filterJson || '{}'),
            lastCompletedPage,
            observedAt,
          );
        this.db
          .prepare(
            `
          INSERT INTO sync_run_checkpoints (
            run_id, scope_key, provider, chapter_id, filter_json,
            last_completed_page, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, scope_key) DO UPDATE SET
            last_completed_page = excluded.last_completed_page,
            updated_at = excluded.updated_at
        `,
          )
          .run(
            Number(runId),
            scopeKey,
            PROVIDER,
            String(catalog.chapterExternalId || catalog.externalId),
            String(filterJson || '{}'),
            lastCompletedPage,
            observedAt,
          );
      }
      if (rawSnapshot?.filePath && rawSnapshot?.sourceUrl) {
        this.db
          .prepare(
            `
          INSERT INTO source_snapshots (
            run_id, snapshot_type, source_url, content_hash, file_path, captured_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            Number(runId),
            'question_list_api',
            String(rawSnapshot.sourceUrl),
            String(rawSnapshot.contentHash || ''),
            String(rawSnapshot.filePath),
            observedAt,
          );
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      throw error;
    }
    return { resultType, lastCompletedPage: this.lastContiguousSuccessfulPage(runId, textbookExternalId, catalogId) };
  }

  _saveGlobalQuestion(item, chapterId, observedAt) {
    const rawJson = jsonStringify(item);
    const externalId = String(item.externalId);
    const before = this.getQuestion(externalId);
    this.db
      .prepare(
        `
      INSERT INTO questions (
        provider, external_id, bank_id, chapter_id, detail_url,
        source_short, source_title, source_url, question_type, question_type_id,
        difficulty_label, difficulty_code, difficulty_qdid, ease_coefficient,
        content_html, plain_text, content_hash, list_content_hash,
        detail_content_hash, detail_fetched, content_source, content_complete,
        subquestion_count, child_count, has_image, has_formula, has_table,
        is_new, use_count, provider_updated_at, website_time_text,
        category_external_id, category_name, title_abbreviation,
        reference_count, reference_papers_json, answer_html, analysis_html,
        answer_status, solution_html, first_seen_at, last_seen_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, external_id) DO UPDATE SET
        bank_id = COALESCE(excluded.bank_id, questions.bank_id),
        chapter_id = COALESCE(excluded.chapter_id, questions.chapter_id),
        detail_url = COALESCE(excluded.detail_url, questions.detail_url),
        source_short = COALESCE(excluded.source_short, questions.source_short),
        source_title = COALESCE(excluded.source_title, questions.source_title),
        source_url = COALESCE(excluded.source_url, questions.source_url),
        question_type = COALESCE(excluded.question_type, questions.question_type),
        question_type_id = COALESCE(excluded.question_type_id, questions.question_type_id),
        difficulty_label = COALESCE(excluded.difficulty_label, questions.difficulty_label),
        difficulty_code = COALESCE(excluded.difficulty_code, questions.difficulty_code),
        difficulty_qdid = COALESCE(excluded.difficulty_qdid, questions.difficulty_qdid),
        ease_coefficient = COALESCE(excluded.ease_coefficient, questions.ease_coefficient),
        content_html = CASE WHEN questions.detail_fetched = 0 THEN excluded.content_html ELSE questions.content_html END,
        plain_text = CASE WHEN questions.detail_fetched = 0 THEN excluded.plain_text ELSE questions.plain_text END,
        content_hash = CASE WHEN questions.detail_fetched = 0 THEN excluded.content_hash ELSE questions.content_hash END,
        list_content_hash = excluded.list_content_hash,
        content_source = excluded.content_source,
        content_complete = MAX(questions.content_complete, excluded.content_complete),
        subquestion_count = CASE WHEN questions.detail_fetched = 0 THEN excluded.subquestion_count ELSE questions.subquestion_count END,
        child_count = COALESCE(excluded.child_count, questions.child_count),
        has_image = CASE WHEN questions.detail_fetched = 0 THEN excluded.has_image ELSE questions.has_image END,
        has_formula = CASE WHEN questions.detail_fetched = 0 THEN excluded.has_formula ELSE questions.has_formula END,
        has_table = CASE WHEN questions.detail_fetched = 0 THEN excluded.has_table ELSE questions.has_table END,
        is_new = excluded.is_new,
        use_count = COALESCE(excluded.use_count, questions.use_count),
        provider_updated_at = COALESCE(excluded.provider_updated_at, questions.provider_updated_at),
        website_time_text = COALESCE(excluded.website_time_text, questions.website_time_text),
        category_external_id = COALESCE(excluded.category_external_id, questions.category_external_id),
        category_name = COALESCE(excluded.category_name, questions.category_name),
        title_abbreviation = COALESCE(excluded.title_abbreviation, questions.title_abbreviation),
        reference_count = COALESCE(excluded.reference_count, questions.reference_count),
        reference_papers_json = COALESCE(excluded.reference_papers_json, questions.reference_papers_json),
        last_seen_at = excluded.last_seen_at,
        raw_json = CASE WHEN questions.detail_fetched = 0 THEN excluded.raw_json ELSE questions.raw_json END
    `,
      )
      .run(
        PROVIDER,
        externalId,
        sqliteValue(item.bankId),
        sqliteValue(chapterId),
        sqliteValue(item.detailUrl),
        sqliteValue(item.sourceShort),
        sqliteValue(item.sourceTitle),
        sqliteValue(item.sourceUrl),
        sqliteValue(item.questionType),
        sqliteValue(item.questionTypeId),
        sqliteValue(item.difficultyLabel),
        sqliteValue(item.difficultyCode),
        sqliteValue(item.difficultyQdid),
        sqliteValue(item.easeCoefficient),
        sqliteValue(item.contentHtml),
        sqliteValue(item.plainText),
        sqliteValue(item.contentHash),
        sqliteValue(item.listContentHash),
        sqliteValue(item.detailContentHash),
        0,
        sqliteValue(item.contentSource, 'list_api'),
        item.contentComplete ? 1 : 0,
        Number(item.subquestionCount) || 0,
        sqliteValue(item.childCount),
        item.hasImage ? 1 : 0,
        item.hasFormula ? 1 : 0,
        item.hasTable ? 1 : 0,
        item.isNew ? 1 : 0,
        sqliteValue(item.useCount),
        sqliteValue(item.providerUpdatedAt),
        sqliteValue(item.websiteTimeText),
        sqliteValue(item.providerCategoryId),
        sqliteValue(item.providerCategoryName),
        sqliteValue(item.titleAbbreviation),
        sqliteValue(item.referenceCount),
        jsonStringify(item.referencePapers || [], '[]'),
        null,
        null,
        'not_collected',
        null,
        observedAt,
        observedAt,
        rawJson,
      );
    if (item.contentHash) {
      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO question_revisions
          (provider, question_external_id, content_hash, captured_at, data_json)
        VALUES (?, ?, ?, ?, ?)
      `,
        )
        .run(PROVIDER, externalId, item.contentHash, observedAt, rawJson);
    }
    return before;
  }

  _saveRunQuestion(runId, textbookId, item, chapterId, observedAt) {
    this.db
      .prepare(
        `
      INSERT INTO sync_run_question_items (
        run_id, provider, textbook_external_id, question_external_id,
        chapter_id, detail_url, source_short, source_title, source_url,
        question_type, question_type_id, difficulty_label, difficulty_code,
        difficulty_qdid, ease_coefficient, content_html, plain_text,
        content_hash, list_content_hash, detail_content_hash, content_version,
        question_version, snapshot_version, detail_fetched, content_source,
        content_complete, subquestion_count, child_count, has_image,
        has_formula, has_table, is_new, use_count, provider_updated_at,
        website_time_text, category_external_id, category_name,
        title_abbreviation, reference_count, reference_papers_json,
        answer_html, analysis_html, answer_status, solution_html, raw_json,
        captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider, textbook_external_id, question_external_id)
      DO UPDATE SET
        chapter_id = COALESCE(excluded.chapter_id, sync_run_question_items.chapter_id),
        detail_url = COALESCE(excluded.detail_url, sync_run_question_items.detail_url),
        source_short = COALESCE(excluded.source_short, sync_run_question_items.source_short),
        source_title = COALESCE(excluded.source_title, sync_run_question_items.source_title),
        source_url = COALESCE(excluded.source_url, sync_run_question_items.source_url),
        question_type = COALESCE(excluded.question_type, sync_run_question_items.question_type),
        question_type_id = COALESCE(excluded.question_type_id, sync_run_question_items.question_type_id),
        difficulty_label = COALESCE(excluded.difficulty_label, sync_run_question_items.difficulty_label),
        difficulty_code = COALESCE(excluded.difficulty_code, sync_run_question_items.difficulty_code),
        difficulty_qdid = COALESCE(excluded.difficulty_qdid, sync_run_question_items.difficulty_qdid),
        ease_coefficient = COALESCE(excluded.ease_coefficient, sync_run_question_items.ease_coefficient),
        content_html = COALESCE(excluded.content_html, sync_run_question_items.content_html),
        plain_text = COALESCE(excluded.plain_text, sync_run_question_items.plain_text),
        content_hash = COALESCE(excluded.content_hash, sync_run_question_items.content_hash),
        list_content_hash = COALESCE(excluded.list_content_hash, sync_run_question_items.list_content_hash),
        content_source = COALESCE(excluded.content_source, sync_run_question_items.content_source),
        content_complete = MAX(sync_run_question_items.content_complete, excluded.content_complete),
        subquestion_count = excluded.subquestion_count,
        child_count = COALESCE(excluded.child_count, sync_run_question_items.child_count),
        has_image = excluded.has_image,
        has_formula = excluded.has_formula,
        has_table = excluded.has_table,
        is_new = excluded.is_new,
        use_count = COALESCE(excluded.use_count, sync_run_question_items.use_count),
        provider_updated_at = COALESCE(excluded.provider_updated_at, sync_run_question_items.provider_updated_at),
        website_time_text = COALESCE(excluded.website_time_text, sync_run_question_items.website_time_text),
        category_external_id = COALESCE(excluded.category_external_id, sync_run_question_items.category_external_id),
        category_name = COALESCE(excluded.category_name, sync_run_question_items.category_name),
        title_abbreviation = COALESCE(excluded.title_abbreviation, sync_run_question_items.title_abbreviation),
        reference_count = COALESCE(excluded.reference_count, sync_run_question_items.reference_count),
        reference_papers_json = COALESCE(excluded.reference_papers_json, sync_run_question_items.reference_papers_json),
        raw_json = excluded.raw_json,
        captured_at = excluded.captured_at
    `,
      )
      .run(
        Number(runId),
        PROVIDER,
        String(textbookId),
        String(item.externalId),
        sqliteValue(chapterId),
        sqliteValue(item.detailUrl),
        sqliteValue(item.sourceShort),
        sqliteValue(item.sourceTitle),
        sqliteValue(item.sourceUrl),
        sqliteValue(item.questionType),
        sqliteValue(item.questionTypeId),
        sqliteValue(item.difficultyLabel),
        sqliteValue(item.difficultyCode),
        sqliteValue(item.difficultyQdid),
        sqliteValue(item.easeCoefficient),
        sqliteValue(item.contentHtml),
        sqliteValue(item.plainText),
        sqliteValue(item.contentHash),
        sqliteValue(item.listContentHash),
        sqliteValue(item.detailContentHash),
        sqliteValue(item.contentHash || item.listContentHash),
        sqliteValue(item.contentSource, 'list_api'),
        item.contentComplete ? 1 : 0,
        Number(item.subquestionCount) || 0,
        sqliteValue(item.childCount),
        item.hasImage ? 1 : 0,
        item.hasFormula ? 1 : 0,
        item.hasTable ? 1 : 0,
        item.isNew ? 1 : 0,
        sqliteValue(item.useCount),
        sqliteValue(item.providerUpdatedAt),
        sqliteValue(item.websiteTimeText),
        sqliteValue(item.providerCategoryId),
        sqliteValue(item.providerCategoryName),
        sqliteValue(item.titleAbbreviation),
        sqliteValue(item.referenceCount),
        jsonStringify(item.referencePapers || [], '[]'),
        null,
        null,
        'not_collected',
        null,
        jsonStringify(item),
        observedAt,
      );
  }

  _saveTag(runId, textbookId, questionId, tag, queryFingerprint, observedAt) {
    const dimension = String(tag.dimension || tag.kind || 'provider_tag');
    const value = String(tag.tagValue ?? tag.value ?? tag.name ?? '').trim();
    if (!value) return;
    const externalId = String(tag.tagExternalId ?? tag.externalId ?? '').trim();
    const relationType = String(tag.relationType || 'provider_asserted');
    const evidenceType = String(tag.evidenceType || 'provider_asserted');
    if (dimension === 'knowledge' || dimension === 'ability') {
      this.db
        .prepare(
          `
        INSERT INTO question_knowledge (
          provider, question_external_id, knowledge_external_id, name,
          knowledge_kind, evidence_type, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, question_external_id, knowledge_external_id, knowledge_kind)
        DO UPDATE SET name = excluded.name,
          evidence_type = excluded.evidence_type,
          observed_at = excluded.observed_at
      `,
        )
        .run(
          PROVIDER,
          String(questionId),
          externalId || value,
          value,
          dimension === 'ability' ? 'ability' : 'knowledge_point',
          evidenceType,
          observedAt,
        );
    }
    this.db
      .prepare(
        `
      INSERT INTO question_facets (
        provider, question_external_id, dimension, value,
        evidence_type, query_fingerprint, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, question_external_id, dimension, value, evidence_type, query_fingerprint)
      DO UPDATE SET observed_at = excluded.observed_at
    `,
      )
      .run(PROVIDER, String(questionId), dimension, value, evidenceType, queryFingerprint, observedAt);
    this.db
      .prepare(
        `
      INSERT INTO sync_run_question_tags (
        run_id, provider, textbook_external_id, question_external_id,
        dimension, tag_external_id, tag_value, relation_type,
        evidence_type, query_fingerprint, captured_at, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(
        run_id, provider, textbook_external_id, question_external_id,
        dimension, tag_external_id, tag_value, relation_type,
        evidence_type, query_fingerprint
      ) DO UPDATE SET observed_at = excluded.observed_at
    `,
      )
      .run(
        Number(runId),
        PROVIDER,
        String(textbookId),
        String(questionId),
        dimension,
        externalId,
        value,
        relationType,
        evidenceType,
        queryFingerprint,
        observedAt,
        observedAt,
      );
  }

  _saveAsset(runId, textbookId, questionId, asset, observedAt) {
    if (asset?.skipped || asset?.ignored) return;
    const sourceUrl = String(asset.sourceUrl || asset.url || '').trim();
    if (!sourceUrl) return;
    const assetType = normalizeAssetType(sourceUrl, asset.assetType || asset.type);
    const key = canonicalAssetKey(assetType, sourceUrl);
    const storagePath = asset.storagePath || asset.localPath || null;
    this.db
      .prepare(
        `
      INSERT INTO question_assets (
        provider, question_external_id, source_url, asset_type,
        local_path, sha256, mime_type, byte_size, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, question_external_id, source_url) DO UPDATE SET
        asset_type = excluded.asset_type,
        local_path = COALESCE(excluded.local_path, question_assets.local_path),
        sha256 = COALESCE(excluded.sha256, question_assets.sha256),
        mime_type = COALESCE(excluded.mime_type, question_assets.mime_type),
        byte_size = COALESCE(excluded.byte_size, question_assets.byte_size),
        observed_at = excluded.observed_at
    `,
      )
      .run(
        PROVIDER,
        String(questionId),
        sourceUrl,
        assetType,
        storagePath,
        sqliteValue(asset.contentSha256 || asset.sha256),
        sqliteValue(asset.mimeType),
        sqliteValue(asset.byteSize),
        observedAt,
      );
    this.db
      .prepare(
        `
      INSERT INTO sync_run_question_assets (
        run_id, provider, textbook_external_id, question_external_id,
        asset_key, asset_type, source_url, content_sha256, storage_path,
        mime_type, byte_size, captured_at, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider, textbook_external_id, question_external_id, asset_key)
      DO UPDATE SET
        asset_type = excluded.asset_type,
        source_url = excluded.source_url,
        content_sha256 = COALESCE(excluded.content_sha256, sync_run_question_assets.content_sha256),
        storage_path = COALESCE(excluded.storage_path, sync_run_question_assets.storage_path),
        mime_type = COALESCE(excluded.mime_type, sync_run_question_assets.mime_type),
        byte_size = COALESCE(excluded.byte_size, sync_run_question_assets.byte_size),
        observed_at = excluded.observed_at
    `,
      )
      .run(
        Number(runId),
        PROVIDER,
        String(textbookId),
        String(questionId),
        key,
        assetType,
        sourceUrl,
        sqliteValue(asset.contentSha256 || asset.sha256),
        sqliteValue(storagePath),
        sqliteValue(asset.mimeType),
        sqliteValue(asset.byteSize),
        observedAt,
        observedAt,
      );
  }

  _saveMembership(runId, textbookId, questionId, membership, queryFingerprint, observedAt) {
    const catalogId = normalizeId(membership.externalId);
    if (!catalogId) return;
    this.db
      .prepare(
        `
      INSERT INTO question_catalog_memberships (
        provider, question_external_id, catalog_external_id,
        catalog_level, catalog_name, catalog_path,
        evidence_type, query_fingerprint, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, question_external_id, catalog_external_id, evidence_type, query_fingerprint)
      DO UPDATE SET catalog_level = excluded.catalog_level,
        catalog_name = excluded.catalog_name,
        catalog_path = excluded.catalog_path,
        observed_at = excluded.observed_at
    `,
      )
      .run(
        PROVIDER,
        String(questionId),
        catalogId,
        sqliteValue(membership.level),
        sqliteValue(membership.name),
        sqliteValue(membership.path || membership.name),
        'query_membership',
        queryFingerprint,
        observedAt,
      );
    this.db
      .prepare(
        `
      INSERT INTO sync_run_question_catalogs (
        run_id, provider, textbook_external_id, question_external_id,
        catalog_external_id, catalog_level, catalog_name, catalog_path,
        evidence_type, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider, textbook_external_id, question_external_id, catalog_external_id)
      DO UPDATE SET catalog_level = excluded.catalog_level,
        catalog_name = excluded.catalog_name,
        catalog_path = excluded.catalog_path,
        captured_at = excluded.captured_at
    `,
      )
      .run(
        Number(runId),
        PROVIDER,
        String(textbookId),
        String(questionId),
        catalogId,
        sqliteValue(membership.level),
        sqliteValue(membership.name),
        sqliteValue(membership.path || membership.name),
        'query_membership',
        observedAt,
      );
  }

  savePage({
    runId,
    textbookExternalId,
    catalog,
    nodes = [],
    pageNumber,
    expectedTotal,
    pageCapacity = 10,
    expectedPages,
    questions = [],
    queryFingerprint,
    filterJson = '{}',
    rawSnapshot = null,
    targetPageLimit = null,
  }) {
    const observedAt = nowIso();
    const normalizedCatalog = catalog || {};
    const normalizedScopeKey = String(queryFingerprint || '').trim();
    if (!normalizedScopeKey) throw new QuestionSyncError('页面缺少 queryFingerprint。', 'checkpoint_contract');
    const normalizedQuestions = questions.map(finalizeQuestion).filter((item) => item.externalId);
    const nodeById = new Map((nodes || []).map((node) => [String(node.externalId), node]));
    const memberships = [];
    const chain = Array.isArray(normalizedCatalog.ancestorIds)
      ? normalizedCatalog.ancestorIds
      : [normalizedCatalog.externalId];
    for (const id of chain) {
      const node =
        nodeById.get(String(id)) || (String(id) === String(normalizedCatalog.externalId) ? normalizedCatalog : null);
      if (node?.externalId) memberships.push(node);
    }
    let inserted = 0;
    let updated = 0;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      // Tests/direct callers may provide nodes only to savePage; normal runs
      // save the tree once before paging, so this is idempotent.
      for (const node of nodes || []) {
        if (node?.externalId && node?.name) {
          this._insertCatalogNode(node, observedAt);
          this.db
            .prepare(
              `
            INSERT INTO sync_run_catalog_items (
              run_id, provider, textbook_external_id, catalog_external_id,
              parent_external_id, node_level, node_type, name, source_path,
              catalog_path, sort_order, captured_at, raw_json, category_id,
              catelog_tokpoint_id, is_knowledge
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, provider, textbook_external_id, catalog_external_id)
            DO NOTHING
          `,
            )
            .run(
              Number(runId),
              PROVIDER,
              String(textbookExternalId),
              String(node.externalId),
              sqliteValue(node.parentExternalId),
              sqliteValue(node.level),
              sqliteValue(node.type || node.nodeType),
              String(node.name),
              sqliteValue(node.sourcePath),
              sqliteValue(node.path || node.name),
              sqliteValue(node.sortOrder),
              observedAt,
              jsonStringify(node.raw || node),
              sqliteValue(node.categoryId),
              sqliteValue(node.catelogTokpointId),
              node.isKnowledge ? 1 : 0,
            );
        }
      }
      for (const question of normalizedQuestions) {
        const before = this._saveGlobalQuestion(
          question,
          normalizedCatalog.chapterExternalId || normalizedCatalog.externalId,
          observedAt,
        );
        if (!before) inserted += 1;
        else if (before.list_content_hash !== question.listContentHash) updated += 1;
        this._saveRunQuestion(
          runId,
          textbookExternalId,
          question,
          normalizedCatalog.chapterExternalId || normalizedCatalog.externalId,
          observedAt,
        );
        for (const membership of memberships) {
          this._saveMembership(
            runId,
            textbookExternalId,
            question.externalId,
            membership,
            normalizedScopeKey,
            observedAt,
          );
        }
        const tags = [
          ...(question.providerLabels || []),
          ...(question.knowledge || []).map((entry) => ({
            dimension: entry.kind === 'ability' ? 'ability' : 'knowledge',
            tagExternalId: entry.externalId,
            tagValue: entry.name,
            relationType: entry.kind,
            evidenceType: entry.evidenceType || 'provider_asserted',
          })),
        ];
        if (question.providerCategoryId || question.providerCategoryName) {
          tags.push({
            dimension: 'provider_category',
            tagExternalId: question.providerCategoryId,
            tagValue: question.providerCategoryName || question.providerCategoryId,
            relationType: 'provider_category',
            evidenceType: 'provider_asserted',
          });
        }
        for (const tag of tags)
          this._saveTag(runId, textbookExternalId, question.externalId, tag, normalizedScopeKey, observedAt);
        for (const asset of question.assets || [])
          this._saveAsset(runId, textbookExternalId, question.externalId, asset, observedAt);
        void before;
      }

      const ids = normalizedQuestions.map((question) => String(question.externalId));
      const pageSignature = sha256(ids.join(','));
      const existingPage = this.db
        .prepare(
          `
        SELECT attempt_count, first_seen_at FROM sync_run_catalog_pages
        WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
          AND catalog_external_id = ? AND page_number = ?
      `,
        )
        .get(
          Number(runId),
          PROVIDER,
          String(textbookExternalId),
          String(normalizedCatalog.externalId),
          Number(pageNumber),
        );
      const assetErrors = normalizedQuestions.reduce(
        (sum, question) => sum + (question.assets || []).filter((asset) => asset?.downloadFailed).length,
        0,
      );
      this.db
        .prepare(
          `
        INSERT INTO sync_run_catalog_pages (
          run_id, provider, textbook_external_id, catalog_external_id,
          page_number, page_signature, question_count, question_ids_json, observed_at,
          attempt_status, attempt_count, result_type, error_code, raw_snapshot_path,
          first_seen_at, finished_at, new_question_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, provider, textbook_external_id, catalog_external_id, page_number)
        DO UPDATE SET page_signature = excluded.page_signature,
          question_count = excluded.question_count,
          question_ids_json = excluded.question_ids_json,
          observed_at = excluded.observed_at,
          attempt_status = excluded.attempt_status,
          attempt_count = excluded.attempt_count,
          result_type = excluded.result_type,
          error_code = excluded.error_code,
          raw_snapshot_path = COALESCE(excluded.raw_snapshot_path, sync_run_catalog_pages.raw_snapshot_path),
          finished_at = excluded.finished_at,
          new_question_count = excluded.new_question_count
      `,
        )
        .run(
          Number(runId),
          PROVIDER,
          String(textbookExternalId),
          String(normalizedCatalog.externalId),
          Number(pageNumber),
          pageSignature,
          ids.length,
          jsonStringify(ids, '[]'),
          observedAt,
          'resolved',
          Number(existingPage?.attempt_count || 0) + 1,
          PAGE_RESULT.SUCCESS,
          null,
          rawSnapshot?.filePath || null,
          existingPage?.first_seen_at || observedAt,
          observedAt,
          ids.length,
        );
      // Recompute the occurrence count from the idempotent page snapshot.
      // Retrying a page, or cloning a completed page during resume, must not
      // add the same page to list_seen_count a second time.
      const occurrenceCount = Number(
        this.db
          .prepare(
            `
        SELECT COALESCE(SUM(question_count), 0) AS n
        FROM sync_run_catalog_pages
        WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
          AND catalog_external_id = ?
      `,
          )
          .get(Number(runId), PROVIDER, String(textbookExternalId), String(normalizedCatalog.externalId))?.n || 0,
      );
      const lastCompletedPage = this.lastContiguousSuccessfulPage(
        runId,
        textbookExternalId,
        normalizedCatalog.externalId,
      );
      let grownTarget = growTargetPages(expectedPages, expectedTotal, pageCapacity);
      const boundedTargetPageLimit = Number(targetPageLimit);
      if (Number.isFinite(boundedTargetPageLimit) && boundedTargetPageLimit > 0) {
        grownTarget = Math.min(grownTarget, boundedTargetPageLimit);
      }
      this._upsertCatalogProgressRow({
        runId,
        textbookId: textbookExternalId,
        catalogId: normalizedCatalog.externalId,
        expectedTotal,
        pageCapacity,
        targetPages: grownTarget,
        targetPageLimit,
        lastCompletedPage,
        occurrenceCount,
        status: 'running',
        assetErrorDelta: assetErrors,
        observedAt,
      });
      this.db
        .prepare(
          `
        INSERT INTO sync_checkpoints (
          scope_key, provider, chapter_id, filter_json, last_completed_page, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET last_completed_page = excluded.last_completed_page,
          updated_at = excluded.updated_at
      `,
        )
        .run(
          normalizedScopeKey,
          PROVIDER,
          String(normalizedCatalog.chapterExternalId || normalizedCatalog.externalId),
          String(filterJson || '{}'),
          lastCompletedPage,
          observedAt,
        );
      this.db
        .prepare(
          `
        INSERT INTO sync_run_checkpoints (
          run_id, scope_key, provider, chapter_id, filter_json,
          last_completed_page, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, scope_key) DO UPDATE SET
          last_completed_page = excluded.last_completed_page,
          updated_at = excluded.updated_at
      `,
        )
        .run(
          Number(runId),
          normalizedScopeKey,
          PROVIDER,
          String(normalizedCatalog.chapterExternalId || normalizedCatalog.externalId),
          String(filterJson || '{}'),
          lastCompletedPage,
          observedAt,
        );
      this.db
        .prepare(
          `
        INSERT INTO catalog_list_stats (
          scope_key, provider, catalog_external_id, chapter_id, filter_json,
          expected_total, page_capacity, expected_pages, list_seen_count,
          last_completed_page, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET
          expected_total = COALESCE(excluded.expected_total, catalog_list_stats.expected_total),
          page_capacity = COALESCE(excluded.page_capacity, catalog_list_stats.page_capacity),
          expected_pages = MAX(
            COALESCE(catalog_list_stats.expected_pages, 0),
            COALESCE(excluded.expected_pages, 0)
          ),
          last_completed_page = excluded.last_completed_page,
          list_seen_count = excluded.list_seen_count,
          updated_at = excluded.updated_at
      `,
        )
        .run(
          normalizedScopeKey,
          PROVIDER,
          String(normalizedCatalog.externalId),
          String(normalizedCatalog.chapterExternalId || normalizedCatalog.externalId),
          String(filterJson || '{}'),
          expectedTotal == null ? null : Number(expectedTotal),
          Number(pageCapacity) || DEFAULT_PAGE_CAPACITY,
          grownTarget || null,
          occurrenceCount,
          lastCompletedPage,
          observedAt,
        );
      if (rawSnapshot?.filePath && rawSnapshot?.sourceUrl) {
        this.db
          .prepare(
            `
          INSERT INTO source_snapshots (
            run_id, snapshot_type, source_url, content_hash, file_path, captured_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            Number(runId),
            'question_list_api',
            String(rawSnapshot.sourceUrl),
            String(rawSnapshot.contentHash || ''),
            String(rawSnapshot.filePath),
            observedAt,
          );
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      throw error;
    }
    return {
      questionCount: normalizedQuestions.length,
      inserted,
      updated,
      pageSignature: sha256(normalizedQuestions.map((question) => String(question.externalId)).join(',')),
    };
  }

  reopenCatalogProgress(runId, textbookId, catalogId) {
    this.db
      .prepare(
        `
      UPDATE sync_run_catalog_progress
      SET status = 'running', scan_complete = 0, observed_at = ?
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        AND catalog_external_id = ? AND status IN ('completed', 'stalled')
    `,
      )
      .run(nowIso(), Number(runId), PROVIDER, String(textbookId), String(catalogId));
  }

  catalogHasDataIssues(runId, textbookId, catalogId) {
    const issueCounts = this.catalogPageIssueCounts(runId, textbookId, catalogId);
    const highestSuccess = Number(
      this.db
        .prepare(
          `
      SELECT COALESCE(MAX(page_number), 0) AS n FROM sync_run_catalog_pages
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        AND catalog_external_id = ? AND result_type = ?
        AND question_count > 0
    `,
        )
        .get(Number(runId), PROVIDER, String(textbookId), String(catalogId), PAGE_RESULT.SUCCESS)?.n || 0,
    );
    const holeEmpties = Number(
      this.db
        .prepare(
          `
      SELECT COUNT(*) AS n FROM sync_run_catalog_pages
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        AND catalog_external_id = ? AND result_type = ?
        AND page_number < ?
    `,
        )
        .get(Number(runId), PROVIDER, String(textbookId), String(catalogId), PAGE_RESULT.EMPTY_PAGE, highestSuccess)
        ?.n || 0,
    );
    const assets = Number(
      this.db
        .prepare(
          `
      SELECT COALESCE(asset_error_count, 0) AS n FROM sync_run_catalog_progress
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        AND catalog_external_id = ?
    `,
        )
        .get(Number(runId), PROVIDER, String(textbookId), String(catalogId))?.n || 0,
    );
    return (
      issueCounts.failedPageCount > 0 ||
      issueCounts.duplicatePageCount > 0 ||
      issueCounts.parseErrorCount > 0 ||
      holeEmpties > 0 ||
      assets > 0
    );
  }

  completeCatalog({
    runId,
    textbookExternalId,
    catalog,
    expectedTotal,
    pageCapacity = DEFAULT_PAGE_CAPACITY,
    expectedPages,
    queryFingerprint,
    filterJson = '{}',
    rawSnapshot = null,
    stalled = false,
    stallReason = null,
    pageLimitReached = false,
    targetPageLimit = null,
  }) {
    const observedAt = nowIso();
    const normalizedCatalog = catalog || {};
    const catalogId = String(normalizedCatalog.externalId || '');
    if (!catalogId) throw new QuestionSyncError('空页完成缺少目录 ID。', 'checkpoint_contract');
    const normalizedScopeKey = String(queryFingerprint || '').trim();
    if (!normalizedScopeKey) throw new QuestionSyncError('页面缺少 queryFingerprint。', 'checkpoint_contract');
    let lastCompletedPage = 0;
    let dataComplete = true;
    let completionQuality = 'completed';
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const occurrenceCount = Number(
        this.db
          .prepare(
            `
        SELECT COALESCE(SUM(question_count), 0) AS n
        FROM sync_run_catalog_pages
        WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
          AND catalog_external_id = ?
      `,
          )
          .get(Number(runId), PROVIDER, String(textbookExternalId), catalogId)?.n || 0,
      );
      lastCompletedPage = this.lastContiguousSuccessfulPage(runId, textbookExternalId, catalogId);
      dataComplete = !stalled && !this.catalogHasDataIssues(runId, textbookExternalId, catalogId);
      completionQuality = dataComplete ? 'completed' : 'completed_with_issues';
      const status = stalled ? 'stalled' : 'completed';
      this._upsertCatalogProgressRow({
        runId,
        textbookId: textbookExternalId,
        catalogId,
        expectedTotal,
        pageCapacity,
        targetPages: expectedPages,
        targetPageLimit,
        lastCompletedPage,
        occurrenceCount,
        status,
        scanComplete: true,
        dataComplete,
        completionQuality,
        // A policy-limited catalog is still a completed scan and must not be
        // treated as a data error. Keep the reason in the progress row so the
        // UI can say explicitly that the catalog stopped at the configured
        // 1000-page boundary.
        stallReason: stallReason || (pageLimitReached ? 'page_limit_1000' : stalled ? 'pagination_safety_limit' : null),
        observedAt,
      });
      let statsExpectedPages = growTargetPages(expectedPages, expectedTotal, pageCapacity);
      const boundedTargetPageLimit = Number(targetPageLimit);
      if (Number.isFinite(boundedTargetPageLimit) && boundedTargetPageLimit > 0) {
        statsExpectedPages = Math.min(statsExpectedPages, boundedTargetPageLimit);
      }
      this.db
        .prepare(
          `
        INSERT INTO catalog_list_stats (
          scope_key, provider, catalog_external_id, chapter_id, filter_json,
          expected_total, page_capacity, expected_pages, list_seen_count,
          last_completed_page, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET
          expected_total = COALESCE(excluded.expected_total, catalog_list_stats.expected_total),
          page_capacity = COALESCE(excluded.page_capacity, catalog_list_stats.page_capacity),
          expected_pages = MAX(
            COALESCE(catalog_list_stats.expected_pages, 0),
            COALESCE(excluded.expected_pages, 0)
          ),
          list_seen_count = excluded.list_seen_count,
          last_completed_page = excluded.last_completed_page,
          updated_at = excluded.updated_at
      `,
        )
        .run(
          normalizedScopeKey,
          PROVIDER,
          catalogId,
          String(normalizedCatalog.chapterExternalId || normalizedCatalog.externalId),
          String(filterJson || '{}'),
          expectedTotal == null ? null : Number(expectedTotal),
          Number(pageCapacity) || DEFAULT_PAGE_CAPACITY,
          statsExpectedPages || null,
          occurrenceCount,
          lastCompletedPage,
          observedAt,
        );
      if (rawSnapshot?.filePath && rawSnapshot?.sourceUrl) {
        this.db
          .prepare(
            `
          INSERT INTO source_snapshots (
            run_id, snapshot_type, source_url, content_hash, file_path, captured_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            Number(runId),
            'question_list_api',
            String(rawSnapshot.sourceUrl),
            String(rawSnapshot.contentHash || ''),
            String(rawSnapshot.filePath),
            observedAt,
          );
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      throw error;
    }
    return {
      empty: true,
      lastCompletedPage,
      scanComplete: true,
      dataComplete,
      completionQuality,
      stalled,
      pageLimitReached,
    };
  }
}

module.exports = { PageRepoMethods };
