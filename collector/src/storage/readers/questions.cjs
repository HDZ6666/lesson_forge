'use strict';

const {
  PROVIDER,
  MAX_CANDIDATE_ROWS,
  MAX_SELECTED_TEXTBOOKS,
  DEFAULT_RUN_PAGE_SIZE,
  MAX_RUN_PAGE_SIZE,
  DEFAULT_CATALOG_PAGE_SIZE,
  MAX_CATALOG_PAGE_SIZE,
  MAX_RUN_PAGE_NUMBER,
  MAX_RUN_OFFSET,
  MAX_RUN_TEXT_LENGTH,
  MAX_RUN_RAW_JSON_LENGTH,
  MAX_RUN_ERRORS,
  MAX_LIVE_TREE_NODES,
  MAX_SNAPSHOT_PAGE_BYTES,
  MAX_SNAPSHOT_PAGE_SIZE,
  MAX_SNAPSHOT_FETCH_BATCH_SIZE,
  MAX_ASSET_BYTES,
  ASSET_SHA256,
  STRICT_SNAPSHOT_RUN_COLUMNS,
  SNAPSHOT_COLLECTIONS,
  ENTITIES,
  safeExternalId,
  httpError,
  snapshotLockPresent,
  boundedText,
  positiveInt,
  nonNegativeInt,
  requiredRunId,
  optionalExternalId,
  parseJsonObject,
  boundedString,
  pageBounds,
  boundedScope,
  scopeTextbookIds,
  escapeLike,
  openReadOnly,
  tableNames,
  tableColumns,
  optionalSelect,
  resolveContentRun,
  assertSnapshotTables,
  assertApplyableSnapshotRun,
  snapshotScopeIds,
  resolveSnapshotTextbook,
  assertRunTextbook,
  assertRunCatalog,
} = require('./common.cjs');

function readRunQuestions(dbPath, runId, options = {}) {
  const textbookExternalId = optionalExternalId(
    options.textbookExternalId,
    'textbookExternalId',
  );
  const catalogExternalId = optionalExternalId(
    options.catalogExternalId,
    'catalogExternalId',
  );
  const questionType = boundedText(options.questionType, 'questionType', 80);
  const keyword = boundedText(options.keyword, 'keyword', 120);
  const page = positiveInt(options.page, 'page', 1, MAX_RUN_PAGE_NUMBER);
  const pageSize = positiveInt(
    options.pageSize,
    'pageSize',
    DEFAULT_RUN_PAGE_SIZE,
    MAX_RUN_PAGE_SIZE,
  );
  const db = openReadOnly(dbPath);
  if (!db) throw httpError('collector SQLite 不存在', 503, 'snapshot_unavailable');
  try {
    const run = resolveContentRun(db, runId);
    assertSnapshotTables(db);
    assertRunTextbook(db, run, textbookExternalId);
    assertRunCatalog(db, run, catalogExternalId, textbookExternalId);
    const itemColumns = tableColumns(db, 'sync_run_question_items');
    const predicates = ['item.run_id = ?', 'item.provider = ?'];
    const parameters = [run.id, PROVIDER];
    if (textbookExternalId) {
      predicates.push('item.textbook_external_id = ?');
      parameters.push(textbookExternalId);
    }
    if (catalogExternalId) {
      predicates.push(`EXISTS (
        SELECT 1 FROM sync_run_question_catalogs AS link
        WHERE link.run_id = item.run_id
          AND link.provider = item.provider
          AND link.textbook_external_id = item.textbook_external_id
          AND link.question_external_id = item.question_external_id
          AND link.catalog_external_id = ?
      )`);
      parameters.push(catalogExternalId);
    }
    if (questionType) {
      if (itemColumns.has('question_type_id')) {
        predicates.push('(item.question_type = ? OR item.question_type_id = ?)');
        parameters.push(questionType, questionType);
      } else {
        predicates.push('item.question_type = ?');
        parameters.push(questionType);
      }
    }
    if (keyword) {
      const like = `%${escapeLike(keyword)}%`;
      const keywordPredicates = [
        'item.question_external_id LIKE ? ESCAPE \'\\\'',
        'COALESCE(item.plain_text, \'\') LIKE ? ESCAPE \'\\\'',
        'COALESCE(item.content_html, \'\') LIKE ? ESCAPE \'\\\'',
      ];
      const keywordParameters = [like, like, like];
      if (itemColumns.has('source_title')) {
        keywordPredicates.splice(2, 0, 'COALESCE(item.source_title, \'\') LIKE ? ESCAPE \'\\\'');
        keywordParameters.splice(2, 0, like);
      }
      predicates.push(`(${keywordPredicates.join('\n        OR ')})`);
      parameters.push(...keywordParameters);
    }
    const where = predicates.join(' AND ');
    const total = Number(db.prepare(`
      SELECT COUNT(*) AS total FROM sync_run_question_items AS item WHERE ${where}
    `).get(...parameters).total || 0);
    const offset = pageBounds(page, pageSize);
    const rows = db.prepare(`
      SELECT item.textbook_external_id, item.question_external_id,
             ${optionalSelect(itemColumns, 'item', 'chapter_id')},
             ${optionalSelect(itemColumns, 'item', 'detail_url')},
             ${optionalSelect(itemColumns, 'item', 'source_short')},
             ${optionalSelect(itemColumns, 'item', 'source_title')},
             ${optionalSelect(itemColumns, 'item', 'source_url')},
             item.question_type,
             ${optionalSelect(itemColumns, 'item', 'question_type_id')},
             ${optionalSelect(itemColumns, 'item', 'difficulty_label')},
             ${optionalSelect(itemColumns, 'item', 'difficulty_code')},
             ${optionalSelect(itemColumns, 'item', 'ease_coefficient')},
             ${optionalSelect(itemColumns, 'item', 'content_hash')},
             ${optionalSelect(itemColumns, 'item', 'list_content_hash')},
             ${optionalSelect(itemColumns, 'item', 'detail_content_hash')},
             ${optionalSelect(itemColumns, 'item', 'content_version')},
             ${optionalSelect(itemColumns, 'item', 'question_version')},
             ${optionalSelect(itemColumns, 'item', 'snapshot_version')},
             ${optionalSelect(itemColumns, 'item', 'detail_fetched')},
             ${optionalSelect(itemColumns, 'item', 'subquestion_count')},
             ${optionalSelect(itemColumns, 'item', 'child_count')},
             ${optionalSelect(itemColumns, 'item', 'has_image')},
             ${optionalSelect(itemColumns, 'item', 'has_formula')},
             ${optionalSelect(itemColumns, 'item', 'has_table')},
             ${optionalSelect(itemColumns, 'item', 'is_new')},
             ${optionalSelect(itemColumns, 'item', 'use_count')},
             ${optionalSelect(itemColumns, 'item', 'provider_updated_at')},
             substr(item.plain_text, 1, 500) AS plain_text,
             substr(item.content_html, 1, 4000) AS content_html,
             ${optionalSelect(itemColumns, 'item', 'answer_html')},
             ${optionalSelect(itemColumns, 'item', 'analysis_html')},
             ${optionalSelect(itemColumns, 'item', 'answer_status')},
             ${optionalSelect(itemColumns, 'item', 'solution_html')},
             ${optionalSelect(itemColumns, 'item', 'captured_at')},
             (
               SELECT COUNT(*) FROM sync_run_question_catalogs AS link
               WHERE link.run_id = item.run_id
                 AND link.provider = item.provider
                 AND link.textbook_external_id = item.textbook_external_id
                 AND link.question_external_id = item.question_external_id
             ) AS catalog_count
      FROM sync_run_question_items AS item
      WHERE ${where}
      ORDER BY item.question_external_id ASC
      LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, offset).map((row) => ({
      sourceProvider: PROVIDER,
      externalTextbookId: String(row.textbook_external_id),
      externalQuestionId: String(row.question_external_id),
      chapterId: row.chapter_id == null ? null : String(row.chapter_id),
      detailUrl: boundedString(row.detail_url, 4000),
      sourceShort: boundedString(row.source_short, 1000),
      sourceTitle: boundedString(row.source_title, 4000),
      sourceUrl: boundedString(row.source_url, 4000),
      questionType: boundedString(row.question_type, 200),
      questionTypeId: boundedString(row.question_type_id, 200),
      difficultyLabel: boundedString(row.difficulty_label, 200),
      difficultyCode: boundedString(row.difficulty_code, 200),
      easeCoefficient: row.ease_coefficient == null ? null : Number(row.ease_coefficient),
      contentHtml: boundedString(row.content_html, 4000),
      plainText: boundedString(row.plain_text, 1000) || '',
      answerHtml: boundedString(row.answer_html, 4000),
      analysisHtml: boundedString(row.analysis_html, 4000),
      answerStatus: boundedString(row.answer_status, 80) || 'not_collected',
      solutionHtml: boundedString(row.solution_html, 4000),
      contentHash: boundedString(row.content_hash, 200),
      listContentHash: boundedString(row.list_content_hash, 200),
      detailContentHash: boundedString(row.detail_content_hash, 200),
      contentVersion: boundedString(row.content_version, 200),
      questionVersion: Number(row.question_version || 1),
      snapshotVersion: Number(row.snapshot_version || 1),
      detailFetched: Boolean(row.detail_fetched),
      subquestionCount: Number(row.subquestion_count || 0),
      childCount: row.child_count == null ? null : Number(row.child_count),
      hasImage: Boolean(row.has_image),
      hasFormula: Boolean(row.has_formula),
      hasTable: Boolean(row.has_table),
      isNew: Boolean(row.is_new),
      useCount: row.use_count == null ? null : Number(row.use_count),
      providerUpdatedAt: row.provider_updated_at || null,
      catalogCount: Number(row.catalog_count || 0),
      capturedAt: row.captured_at,
    }));
    return {
      available: true,
      message: 'collector 运行题目快照可用',
      run,
      total,
      page,
      pageSize,
      rows,
    };
  } finally {
    db.close();
  }
}

function mapRunQuestionRow(row, { detail = false } = {}) {
  const item = {
    sourceProvider: PROVIDER,
    externalTextbookId: String(row.textbook_external_id),
    externalQuestionId: String(row.question_external_id),
    chapterId: row.chapter_id == null ? null : String(row.chapter_id),
    detailUrl: boundedString(row.detail_url, 4000),
    sourceShort: boundedString(row.source_short, 1000),
    sourceTitle: boundedString(row.source_title, 4000),
    sourceUrl: boundedString(row.source_url, 4000),
    questionType: boundedString(row.question_type, 200),
    questionTypeId: boundedString(row.question_type_id, 200),
    difficultyLabel: boundedString(row.difficulty_label, 200),
    difficultyCode: boundedString(row.difficulty_code, 200),
    easeCoefficient: row.ease_coefficient == null ? null : Number(row.ease_coefficient),
    contentHtml: boundedString(row.content_html, detail ? MAX_RUN_TEXT_LENGTH : 4000),
    plainText: boundedString(row.plain_text, detail ? MAX_RUN_TEXT_LENGTH : 1000) || '',
    // `solutionHtml` is the historical combined answer/analysis block.  New
    // runs may additionally expose independently captured public fields; do
    // not infer either field from the combined compatibility value.
    answerStatus: boundedString(row.answer_status, 80) || 'not_collected',
    solutionHtml: detail ? boundedString(row.solution_html, MAX_RUN_TEXT_LENGTH) : undefined,
    contentHash: boundedString(row.content_hash, 200),
    listContentHash: boundedString(row.list_content_hash, 200),
    detailContentHash: boundedString(row.detail_content_hash, 200),
    contentVersion: boundedString(row.content_version, 200),
    questionVersion: Number(row.question_version || 1),
    snapshotVersion: Number(row.snapshot_version || 1),
    detailFetched: Boolean(row.detail_fetched),
    subquestionCount: Number(row.subquestion_count || 0),
    childCount: row.child_count == null ? null : Number(row.child_count),
    hasImage: Boolean(row.has_image),
    hasFormula: Boolean(row.has_formula),
    hasTable: Boolean(row.has_table),
    isNew: Boolean(row.is_new),
    useCount: row.use_count == null ? null : Number(row.use_count),
    providerUpdatedAt: boundedString(row.provider_updated_at, 4000),
    capturedAt: row.captured_at || null,
  };
  if (detail && (
    row.answer_html != null
    || row.analysis_html != null
    || ['public_captured', 'not_visible', 'login_required'].includes(item.answerStatus)
  )) {
    item.answerHtml = boundedString(row.answer_html, MAX_RUN_TEXT_LENGTH);
    item.analysisHtml = boundedString(row.analysis_html, MAX_RUN_TEXT_LENGTH);
  }
  if (detail) item.rawData = parseJsonObject(row.raw_json);
  if (!detail) {
    item.catalogCount = Number(row.catalog_count || 0);
    delete item.solutionHtml;
  }
  return item;
}

function readRunQuestion(dbPath, runId, externalId, options = {}) {
  if (typeof options === 'string') options = { textbookExternalId: options };
  const questionExternalId = optionalExternalId(externalId, 'externalId');
  if (!questionExternalId) throw httpError('externalId 不能为空');
  const textbookExternalId = optionalExternalId(
    options?.textbookExternalId,
    'textbookExternalId',
  );
  const db = openReadOnly(dbPath);
  if (!db) throw httpError('collector SQLite 不存在', 503, 'snapshot_unavailable');
  try {
    const run = resolveContentRun(db, runId);
    assertSnapshotTables(db);
    assertRunTextbook(db, run, textbookExternalId);
    const predicates = [
      'run_id = ?',
      'provider = ?',
      'question_external_id = ?',
    ];
    const parameters = [run.id, PROVIDER, questionExternalId];
    if (textbookExternalId) {
      predicates.push('textbook_external_id = ?');
      parameters.push(textbookExternalId);
    }
    const rows = db.prepare(`
      SELECT * FROM sync_run_question_items
      WHERE ${predicates.join(' AND ')}
      ORDER BY textbook_external_id ASC LIMIT 2
    `).all(...parameters);
    if (!rows.length) {
      throw httpError(
        `内容运行 ${run.id} 中不存在题目 ${questionExternalId}`,
        404,
        'question_not_found',
      );
    }
    if (rows.length > 1) {
      throw httpError('题目来源 ID 在该运行中不唯一', 409, 'question_ambiguous');
    }
    const row = rows[0];
    const catalogColumns = tableColumns(db, 'sync_run_question_catalogs');
    const catalogs = db.prepare(`
      SELECT textbook_external_id, catalog_external_id,
             ${optionalSelect(catalogColumns, '', 'catalog_level')},
             ${optionalSelect(catalogColumns, '', 'catalog_name')},
             ${optionalSelect(catalogColumns, '', 'catalog_path')},
             ${optionalSelect(catalogColumns, '', 'evidence_type')}
      FROM sync_run_question_catalogs
      WHERE run_id = ? AND provider = ?
        AND textbook_external_id = ? AND question_external_id = ?
      ORDER BY ${catalogColumns.has('catalog_level') ? 'COALESCE(catalog_level, 2147483647)' : 'CAST(2147483647 AS INTEGER)'}, catalog_external_id
    `).all(run.id, PROVIDER, row.textbook_external_id, questionExternalId).map((item) => ({
      externalTextbookId: String(item.textbook_external_id),
      externalCatalogId: String(item.catalog_external_id),
      catalogLevel: item.catalog_level == null ? null : Number(item.catalog_level),
      catalogName: boundedString(item.catalog_name, 4000),
      catalogPath: boundedString(item.catalog_path, 8000),
      evidenceType: boundedString(item.evidence_type, 200),
    }));
    const item = mapRunQuestionRow(row, { detail: true });
    item.catalogs = catalogs;
    return {
      available: true,
      message: 'collector 运行题目详情快照可用',
      run,
      item,
      // `question` is a friendly alias used by older consumers; `item` is
      // the canonical field for the run snapshot API.
      question: item,
    };
  } finally {
    db.close();
  }
}

module.exports = {
  readRunQuestions,
  readRunQuestion,
  mapRunQuestionRow,
};
