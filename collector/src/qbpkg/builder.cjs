'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  PACKAGE_FORMAT_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_TABLES,
  createSnapshotSchema,
} = require('./schema.cjs');
const { assetKey, checkHtml, normalizeHtml } = require('./normalize.cjs');
const {
  ensureDir,
  extractZip,
  jsonText,
  makeTempDir,
  parseJsonFile,
  removeQuietly,
  sha256,
  sha256File,
  stableStringify,
  zipFiles,
} = require('./util.cjs');
const { verifyPackage } = require('./validator.cjs');

class QbPkgValidationError extends Error {
  constructor(message, report) {
    super(message);
    this.name = 'QbPkgValidationError';
    this.report = report;
  }
}

function reportTemplate() {
  return { blocking: [], warnings: [], checks: [], pass: false };
}

function block(report, code, message, details = undefined) {
  const item = { code, message };
  if (details !== undefined) item.details = details;
  report.blocking.push(item);
}

function warn(report, code, message, details = undefined) {
  const item = { code, message };
  if (details !== undefined) item.details = details;
  report.warnings.push(item);
}

function check(report, name, pass, details = undefined) {
  const item = { name, pass: Boolean(pass) };
  if (details !== undefined) item.details = details;
  report.checks.push(item);
  return pass;
}

function tableExists(db, table) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table));
}

function readRows(db, table, report, { required = true } = {}) {
  if (!tableExists(db, table)) {
    (required ? block : warn)(report, 'source_table_missing', `采集库缺少表 ${table}${required ? '' : '，按空表处理'}`);
    return [];
  }
  try {
    return db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all();
  } catch (error) {
    block(report, 'source_table_read_failed', `无法读取采集表 ${table}：${error.message}`);
    return [];
  }
}

function columnNames(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(
    db
      .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
      .all()
      .map((r) => r.name),
  );
}

function getColumn(row, columns, ...names) {
  for (const name of names) {
    if (columns.has(name) && row[name] != null) return row[name];
  }
  return null;
}

function nonEmpty(value) {
  return value != null && String(value).trim() !== '';
}

function parseRawJson(raw, report, questionId) {
  if (raw == null || String(raw).trim() === '') {
    block(report, 'invalid_json', `题目 ${questionId} 缺少 raw_json`);
    return {};
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象');
    return parsed;
  } catch (error) {
    block(report, 'invalid_json', `题目 ${questionId} 的 raw_json 非法：${error.message}`);
    return {};
  }
}

function duplicateValues(rows, keyFn) {
  const seen = new Map();
  const duplicate = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (seen.has(key)) duplicate.push(key);
    else seen.set(key, row);
  }
  return duplicate;
}

function getDatasetMetadata(options, report) {
  let metadata = options.metadata || options.datasetMetadata || options.dataset || {};
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch (error) {
      block(report, 'metadata_invalid', `dataset metadata 不是合法 JSON：${error.message}`);
      metadata = {};
    }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    block(report, 'metadata_invalid', 'dataset metadata 必须是 JSON 对象');
    metadata = {};
  }
  const provider = metadata.provider ?? options.provider;
  const versionName = metadata.versionName ?? metadata.version_name ?? options.versionName;
  const textbookName = metadata.textbookName ?? metadata.textbook_name ?? options.textbookName;
  if (!nonEmpty(provider)) block(report, 'metadata_missing_provider', 'dataset metadata 缺少 provider');
  if (!nonEmpty(versionName)) block(report, 'metadata_missing_version_name', 'dataset metadata 缺少 versionName');
  if (!nonEmpty(textbookName)) block(report, 'metadata_missing_textbook_name', 'dataset metadata 缺少 textbookName');
  const cleanProvider = nonEmpty(provider) ? String(provider) : '';
  const cleanVersion = nonEmpty(versionName) ? String(versionName) : '';
  const cleanTextbook = nonEmpty(textbookName) ? String(textbookName) : '';
  const versionExternalId = metadata.versionExternalId ?? metadata.version_external_id ?? metadata.versionId;
  const textbookExternalId = metadata.textbookExternalId ?? metadata.textbook_external_id ?? metadata.textbookId;
  if (!nonEmpty(versionExternalId))
    block(report, 'metadata_missing_version_external_id', 'dataset metadata 缺少 versionExternalId');
  if (!nonEmpty(textbookExternalId))
    block(report, 'metadata_missing_textbook_external_id', 'dataset metadata 缺少 textbookExternalId');
  return {
    ...metadata,
    provider: cleanProvider,
    versionName: cleanVersion,
    textbookName: cleanTextbook,
    versionExternalId: nonEmpty(versionExternalId) ? String(versionExternalId) : '',
    textbookExternalId: nonEmpty(textbookExternalId) ? String(textbookExternalId) : '',
  };
}

function normalizeEvidence(options, report) {
  let evidence = options.rangeEvidence ?? options.completionEvidence ?? options.scopeEvidence ?? options.syncRange;
  if (typeof evidence === 'string') {
    try {
      if (fs.existsSync(evidence)) evidence = parseJsonFile(evidence, 'range evidence');
      else evidence = JSON.parse(evidence);
    } catch (error) {
      block(report, 'range_evidence_invalid', `同步范围/完成证据无法解析：${error.message}`);
      evidence = null;
    }
  }
  if (!evidence || typeof evidence !== 'object') {
    block(report, 'range_evidence_missing', '构建必须提供同步范围/完成证据');
    return null;
  }
  const scope =
    evidence.scope ??
    evidence.range ??
    evidence.syncScope ??
    evidence.expectedScope ??
    evidence.coverage ??
    evidence.catalogs ??
    evidence.chapters;
  const complete =
    evidence.completed === true ||
    evidence.complete === true ||
    evidence.finished === true ||
    evidence.status === 'success' ||
    evidence.status === 'completed';
  const emptyScope =
    scope != null && typeof scope === 'object' && !Array.isArray(scope) && Object.keys(scope).length === 0;
  if (
    scope == null ||
    (typeof scope === 'string' && scope.trim() === '') ||
    (Array.isArray(scope) && scope.length === 0) ||
    emptyScope
  ) {
    block(report, 'range_scope_missing', '完成证据缺少明确同步范围');
  }
  if (!complete) block(report, 'range_completion_missing', '同步范围证据未声明已完成');
  return evidence;
}

function explicitPublicSolution(row, raw, columns, options = {}) {
  const loginRequired = raw.loginRequired ?? raw.login_required;
  if (loginRequired === true || ['1', 'true', 'yes', 'y', 'on'].includes(String(loginRequired).trim().toLowerCase()))
    return false;
  // Collector runs now persist a stable answer status.  A restrictive status
  // must win over a broad build option so an accidentally copied/private
  // answer can never enter a package.  Keep the old explicit evidence and
  // build-option paths for legacy databases that have no status column.
  const status = String(
    getColumn(row, columns, 'answer_status', 'answerStatus') ?? raw.answerStatus ?? raw.answer_status ?? '',
  )
    .trim()
    .toLowerCase();
  if (['not_collected', 'not_visible', 'login_required', 'restricted', 'not_provided'].includes(status)) {
    return false;
  }
  if (['public_captured', 'public-captured', 'public', 'available', 'published', 'visible', 'open'].includes(status))
    return true;
  const marker = getColumn(row, columns, 'solution_public', 'answer_public', 'public_solution');
  return (
    marker === 1 ||
    marker === true ||
    marker === '1' ||
    marker === 'true' ||
    raw.solutionPublic === true ||
    raw.solution_public === true ||
    raw.publicSolution === true ||
    raw.includeVisibleSolutions === true ||
    raw.solutionEvidence === 'public' ||
    raw.answerStatus === 'public' ||
    raw.answer_status === 'public' ||
    options.includeVisibleSolutions === true ||
    options.publicSolutions === true ||
    options.allowPublicSolutions === true
  );
}

function explicitField(row, raw, columns, columnNamesToTry, rawNames) {
  const fromColumn = getColumn(row, columns, ...columnNamesToTry);
  if (fromColumn != null && String(fromColumn).trim() !== '') return String(fromColumn);
  for (const name of rawNames) {
    if (raw[name] != null && String(raw[name]).trim() !== '') return String(raw[name]);
  }
  return null;
}

function resolveAssetFile(localPath, sourceDbPath, options) {
  if (!localPath) return null;
  const candidates = [];
  const raw = String(localPath);
  if (path.isAbsolute(raw)) candidates.push(raw);
  else {
    candidates.push(path.resolve(path.dirname(sourceDbPath), raw));
    candidates.push(path.resolve(process.cwd(), raw));
    if (options.projectRoot) candidates.push(path.resolve(options.projectRoot, raw));
  }
  return (
    candidates.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) || null
  );
}

function fileExtension(sourceUrl, localPath) {
  const candidate = localPath || sourceUrl;
  const ext = path.extname(String(candidate).split(/[?#]/)[0]).toLowerCase();
  return /^[.][a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

function buildSnapshot({ sourceDbPath, snapshotPath, metadata, options, report }) {
  let source;
  try {
    source = new DatabaseSync(sourceDbPath, { readOnly: true });
  } catch (error) {
    block(report, 'source_open_failed', `无法打开采集库：${error.message}`);
    return { counts: {}, assets: [], questions: [], catalogs: [], chapterCounts: {} };
  }

  const nodes = readRows(source, 'textbook_nodes', report, { required: false });
  const questionRows = readRows(source, 'questions', report);
  const knowledge = readRows(source, 'question_knowledge', report, { required: false });
  const memberships = readRows(source, 'question_catalog_memberships', report, { required: false });
  const facets = readRows(source, 'question_facets', report, { required: false });
  const assets = readRows(source, 'question_assets', report, { required: false });
  const questionColumns = columnNames(source, 'questions');
  const assetColumns = columnNames(source, 'question_assets');
  const nodeColumns = columnNames(source, 'textbook_nodes');
  const membershipColumns = columnNames(source, 'question_catalog_memberships');
  const knowledgeColumns = columnNames(source, 'question_knowledge');
  const facetColumns = columnNames(source, 'question_facets');

  const provider = metadata.provider;
  const nodeMap = new Map();
  const uniqueNodes = [];
  for (const row of nodes) {
    const id = row.external_id == null ? '' : String(row.external_id);
    const key = `${row.provider || provider}\0${id}`;
    if (!id) block(report, 'catalog_external_id_missing', '目录节点缺少 external_id');
    if (nodeMap.has(key)) block(report, 'duplicate_catalog_external_id', `目录 external_id 重复：${key}`);
    else {
      nodeMap.set(key, row);
      uniqueNodes.push(row);
    }
    if (row.provider != null && String(row.provider) !== provider)
      block(report, 'provider_mismatch', `目录 provider 与 metadata 不一致：${row.provider}`);
  }
  const qMap = new Map();
  const parsedRaw = new Map();
  const uniqueQuestionRows = [];
  for (const row of questionRows) {
    const id = row.external_id == null ? '' : String(row.external_id);
    const key = `${row.provider || provider}\0${id}`;
    if (!id) block(report, 'question_external_id_missing', '题目缺少 external_id');
    if (qMap.has(key)) block(report, 'duplicate_question_external_id', `题目 external_id 重复：${key}`);
    else {
      qMap.set(key, row);
      uniqueQuestionRows.push(row);
    }
    if (row.provider != null && String(row.provider) !== provider)
      block(report, 'provider_mismatch', `题目 provider 与 metadata 不一致：${row.provider}`);
    parsedRaw.set(key, parseRawJson(row.raw_json, report, id));
  }
  const qIds = new Set(
    [...qMap.keys()].filter((key) => key.startsWith(`${provider}\0`)).map((key) => key.slice(provider.length + 1)),
  );
  const nodeIds = new Set(
    [...nodeMap.keys()].filter((key) => key.startsWith(`${provider}\0`)).map((key) => key.slice(provider.length + 1)),
  );
  const duplicateMemberships = duplicateValues(memberships, (row) =>
    [row.provider, row.question_external_id, row.catalog_external_id, row.evidence_type, row.query_fingerprint].join(
      '\0',
    ),
  );
  for (const key of duplicateMemberships) block(report, 'duplicate_catalog_relation', `目录关系重复：${key}`);
  const duplicateKnowledge = duplicateValues(knowledge, (row) =>
    [row.provider, row.question_external_id, row.knowledge_external_id, row.knowledge_kind].join('\0'),
  );
  for (const key of duplicateKnowledge) block(report, 'duplicate_knowledge_relation', `知识点关系重复：${key}`);
  const duplicateFacets = duplicateValues(facets, (row) =>
    [row.provider, row.question_external_id, row.dimension, row.value, row.evidence_type, row.query_fingerprint].join(
      '\0',
    ),
  );
  for (const key of duplicateFacets) block(report, 'duplicate_facet_relation', `标签关系重复：${key}`);
  const duplicateAssets = duplicateValues(assets, (row) =>
    [row.provider, row.question_external_id, row.source_url].join('\0'),
  );
  for (const key of duplicateAssets) block(report, 'duplicate_asset_relation', `素材关系重复：${key}`);

  const sourceUrlTypes = new Map();
  const assetMap = new Map();
  const assetRows = [];
  const uniqueAssetKeys = new Set();
  for (const row of assets) {
    const qid = row.question_external_id == null ? '' : String(row.question_external_id);
    const url = row.source_url == null ? '' : String(row.source_url);
    const type = row.asset_type == null ? '' : String(row.asset_type);
    if (!qid || !url || !type) {
      block(report, 'asset_field_missing', '素材缺少题目 ID、source_url 或 asset_type');
      continue;
    }
    if (!qIds.has(qid)) block(report, 'orphan_asset', `素材引用不存在题目：${qid}`);
    const key = assetKey(type, url);
    const sourceTypes = sourceUrlTypes.get(url) || new Set();
    sourceTypes.add(type);
    sourceUrlTypes.set(url, sourceTypes);
    const existing = assetMap.get(key);
    if (existing && (existing.sourceUrl !== url || existing.assetType !== type)) {
      block(report, 'asset_key_conflict', `素材键冲突：${key}`);
    }
    const contentSha = row.sha256 == null ? null : String(row.sha256);
    const localPath = getColumn(row, assetColumns, 'local_path', 'storage_path');
    const filePath = resolveAssetFile(localPath, sourceDbPath, options);
    let actualSha = contentSha;
    if (filePath) actualSha = sha256File(filePath);
    if (contentSha && filePath && contentSha.toLowerCase() !== actualSha) {
      block(report, 'asset_content_hash_mismatch', `素材内容 SHA-256 不匹配：${url}`);
    }
    const item = {
      provider,
      questionId: qid,
      assetKey: key,
      assetType: type,
      sourceUrl: url,
      contentSha256: actualSha,
      sourcePath: filePath,
      localPath: localPath ? String(localPath) : null,
      mimeType: getColumn(row, assetColumns, 'mime_type', 'mimeType'),
      byteSize: getColumn(row, assetColumns, 'byte_size', 'byteSize'),
      observedAt: row.observed_at || null,
      extension: fileExtension(url, localPath),
    };
    if (!filePath) warn(report, 'asset_content_missing', `素材只有 URL，未找到本地内容：${url}`);
    if (existing && existing.contentSha256 && item.contentSha256 && existing.contentSha256 !== item.contentSha256) {
      block(report, 'asset_key_conflict', `相同素材键对应不同内容：${key}`);
    }
    if (!existing) assetMap.set(key, item);
    const rowKey = `${qid}\0${key}`;
    if (!uniqueAssetKeys.has(rowKey)) {
      uniqueAssetKeys.add(rowKey);
      assetRows.push(item);
    }
  }
  for (const [url, types] of sourceUrlTypes) {
    if (types.size > 1) block(report, 'asset_key_conflict', `同一 source URL 存在多个素材类型，无法精确映射：${url}`);
  }

  const catalogRows = [];
  for (const row of uniqueNodes) {
    const id = String(row.external_id);
    catalogRows.push({
      provider,
      externalId: id,
      textbookExternalId: metadata.textbookExternalId,
      parentExternalId: row.parent_external_id == null ? null : String(row.parent_external_id),
      nodeLevel: row.node_level == null ? null : Number(row.node_level),
      nodeType: row.node_type == null ? null : String(row.node_type),
      name: row.name == null ? '' : String(row.name),
      sourcePath: row.source_path == null ? null : String(row.source_path),
      metadataJson: String(row.source_json || JSON.stringify(row)),
      active: 1,
    });
    if (!nonEmpty(row.name)) block(report, 'catalog_name_missing', `目录 ${id} 缺少 name`);
    if (row.parent_external_id != null && !nodeIds.has(String(row.parent_external_id))) {
      block(report, 'orphan_catalog_parent', `目录 ${id} 的父节点不存在：${row.parent_external_id}`);
    }
  }
  const catalogParent = new Map(catalogRows.map((row) => [row.externalId, row.parentExternalId]));
  for (const id of catalogParent.keys()) {
    const seen = new Set();
    let current = id;
    while (current != null && catalogParent.has(current)) {
      if (seen.has(current)) {
        block(report, 'catalog_cycle', `目录父链存在循环：${id}`);
        break;
      }
      seen.add(current);
      current = catalogParent.get(current);
    }
  }

  const qOut = [];
  const questionById = new Map();
  for (const row of uniqueQuestionRows) {
    const qid = String(row.external_id);
    const key = `${row.provider || provider}\0${qid}`;
    const raw = parsedRaw.get(key) || {};
    const assetsForQuestion = assetRows.filter((item) => item.questionId === qid);
    const byUrl = new Map();
    for (const item of assetsForQuestion) {
      const previous = byUrl.get(item.sourceUrl);
      if (!previous || previous.assetType === item.assetType) byUrl.set(item.sourceUrl, item);
    }
    const sourceHtml = getColumn(row, questionColumns, 'content_html', 'contentHtml');
    const normalized = normalizeHtml(sourceHtml, byUrl);
    if (!normalized.valid) block(report, 'invalid_html', `题目 ${qid} 的 HTML 非法`, normalized.errors);
    if (normalized.missingAssets.length > 0)
      block(report, 'asset_key_missing', `题目 ${qid} 的 HTML 图片没有对应素材`, normalized.missingAssets);
    const publicSolution = explicitPublicSolution(row, raw, questionColumns, options);
    const sourceSolution = getColumn(row, questionColumns, 'solution_html', 'solutionHtml');
    const sourceAnalysis = getColumn(row, questionColumns, 'analysis_html', 'analysisHtml');
    const sourceAnswer = getColumn(row, questionColumns, 'answer_html', 'answerHtml');
    const rawSolution = raw.solutionHtml ?? raw.solution_html;
    const rawAnalysis = raw.analysisHtml ?? raw.analysis_html;
    const solution = publicSolution
      ? nonEmpty(sourceSolution)
        ? sourceSolution
        : nonEmpty(sourceAnalysis)
          ? sourceAnalysis
          : nonEmpty(rawSolution)
            ? rawSolution
            : rawAnalysis
      : null;
    const answer = publicSolution
      ? nonEmpty(sourceAnswer)
        ? sourceAnswer
        : nonEmpty(raw.answerHtml ?? raw.answer_html)
          ? (raw.answerHtml ?? raw.answer_html)
          : null
      : null;
    const normalizedSolution = solution == null ? null : normalizeHtml(String(solution), byUrl);
    const normalizedAnswer = answer == null ? null : normalizeHtml(String(answer), byUrl);
    for (const [label, normalizedValue] of [
      ['solution', normalizedSolution],
      ['answer', normalizedAnswer],
    ]) {
      if (normalizedValue && !normalizedValue.valid)
        block(report, 'invalid_html', `题目 ${qid} 的${label} HTML 非法`, normalizedValue.errors);
      if (normalizedValue && normalizedValue.missingAssets.length > 0)
        block(report, 'asset_key_missing', `题目 ${qid} 的${label}图片没有对应素材`, normalizedValue.missingAssets);
    }
    const answerStatus =
      publicSolution && (nonEmpty(solution) || nonEmpty(answer)) ? 'public_captured' : 'not_collected';
    const q = {
      provider,
      externalId: qid,
      textbookVersionExternalId: metadata.versionExternalId,
      textbookExternalId: metadata.textbookExternalId,
      detailUrl: getColumn(row, questionColumns, 'detail_url', 'detailUrl'),
      sourceShort: getColumn(row, questionColumns, 'source_short', 'sourceShort'),
      sourceTitle: getColumn(row, questionColumns, 'source_title', 'sourceTitle'),
      sourceUrl: getColumn(row, questionColumns, 'source_url', 'sourceUrl'),
      sourceOriginalJson: String(row.raw_json),
      questionType: getColumn(row, questionColumns, 'question_type', 'questionType'),
      questionTypeId: getColumn(row, questionColumns, 'question_type_id', 'questionTypeId'),
      difficultyLabel: getColumn(row, questionColumns, 'difficulty_label', 'difficultyLabel'),
      difficultyCode: getColumn(row, questionColumns, 'difficulty_code', 'difficultyCode'),
      easeCoefficient: getColumn(row, questionColumns, 'ease_coefficient', 'easeCoefficient'),
      contentHtml: normalized.html,
      plainText: getColumn(row, questionColumns, 'plain_text', 'plainText'),
      contentHash: normalized.html == null ? null : sha256(normalized.html),
      subquestionCount: getColumn(row, questionColumns, 'subquestion_count', 'subquestionCount') ?? 0,
      childCount: getColumn(row, questionColumns, 'child_count', 'childCount'),
      hasImage: getColumn(row, questionColumns, 'has_image', 'hasImage') ?? 0,
      hasFormula: getColumn(row, questionColumns, 'has_formula', 'hasFormula') ?? 0,
      hasTable: getColumn(row, questionColumns, 'has_table', 'hasTable') ?? 0,
      isNew: getColumn(row, questionColumns, 'is_new', 'isNew') ?? 0,
      assembleCount: getColumn(row, questionColumns, 'use_count', 'assemble_count', 'assembleCount'),
      referenceCount: null,
      year: explicitField(row, raw, questionColumns, ['year'], ['year']),
      region: explicitField(row, raw, questionColumns, ['region'], ['region']),
      examType: explicitField(row, raw, questionColumns, ['exam_type', 'examType'], ['examType', 'exam_type']),
      answerHtml: normalizedAnswer == null ? null : normalizedAnswer.html,
      solutionHtml: normalizedSolution == null ? null : normalizedSolution.html,
      answerStatus,
      firstSeenAt: getColumn(row, questionColumns, 'first_seen_at', 'firstSeenAt'),
      lastSeenAt: getColumn(row, questionColumns, 'last_seen_at', 'lastSeenAt'),
      active: 1,
    };
    if (!q.contentHtml && !q.plainText) warn(report, 'question_content_missing', `题目 ${qid} 缺少题干内容`);
    if ((sourceSolution != null || sourceAnalysis != null || sourceAnswer != null) && !publicSolution) {
      warn(report, 'solution_not_public', `题目 ${qid} 的答案/解析缺少公开抓取证据，已置空`);
    }
    qOut.push(q);
    questionById.set(qid, q);
  }

  const qCatalogOut = [];
  const uniqueMemberships = new Map();
  for (const row of memberships) {
    const qid = String(row.question_external_id ?? '');
    const cid = String(row.catalog_external_id ?? '');
    if (!qIds.has(qid)) block(report, 'orphan_catalog_relation', `目录关系引用不存在题目：${qid}`);
    if (!nodeIds.has(cid)) block(report, 'orphan_catalog_relation', `目录关系引用不存在目录：${cid}`);
    if (row.provider != null && String(row.provider) !== provider)
      block(report, 'provider_mismatch', `目录关系 provider 与 metadata 不一致：${row.provider}`);
    const mapped = {
      provider,
      questionExternalId: qid,
      catalogExternalId: cid,
      relationType: 'query_catalog',
      evidenceType: 'query_membership',
      queryFingerprint: getColumn(row, membershipColumns, 'query_fingerprint', 'queryFingerprint') || '',
      observedAt: getColumn(row, membershipColumns, 'observed_at', 'observedAt'),
    };
    const relationKey = [
      mapped.provider,
      mapped.questionExternalId,
      mapped.catalogExternalId,
      mapped.relationType,
      mapped.evidenceType,
      mapped.queryFingerprint,
    ].join('\0');
    if (!uniqueMemberships.has(relationKey)) {
      uniqueMemberships.set(relationKey, true);
      qCatalogOut.push(mapped);
    }
  }
  const tagOut = [];
  const uniqueTags = new Map();
  for (const row of knowledge) {
    const qid = String(row.question_external_id ?? '');
    if (!qIds.has(qid)) block(report, 'orphan_knowledge_relation', `知识点关系引用不存在题目：${qid}`);
    if (!nonEmpty(row.knowledge_external_id) || !nonEmpty(row.name))
      block(report, 'knowledge_field_missing', `题目 ${qid} 的知识点字段缺失`);
    const mapped = {
      provider,
      questionExternalId: qid,
      dimension: 'knowledge',
      tagExternalId: row.knowledge_external_id == null ? null : String(row.knowledge_external_id),
      tagValue: row.name == null ? '' : String(row.name),
      relationType: 'knowledge',
      evidenceType: 'provider_asserted',
      queryFingerprint: '',
      observedAt: row.observed_at || null,
    };
    const relationKey = [
      mapped.provider,
      mapped.questionExternalId,
      mapped.dimension,
      mapped.tagExternalId,
      mapped.tagValue,
      mapped.relationType,
      mapped.evidenceType,
      mapped.queryFingerprint,
    ].join('\0');
    if (!uniqueTags.has(relationKey)) {
      uniqueTags.set(relationKey, true);
      tagOut.push(mapped);
    }
  }
  for (const row of facets) {
    const qid = String(row.question_external_id ?? '');
    if (!qIds.has(qid)) block(report, 'orphan_facet_relation', `标签关系引用不存在题目：${qid}`);
    if (!nonEmpty(row.dimension) || !nonEmpty(row.value))
      block(report, 'facet_field_missing', `题目 ${qid} 的 facet 字段缺失`);
    const mapped = {
      provider,
      questionExternalId: qid,
      dimension: row.dimension == null ? '' : String(row.dimension),
      tagExternalId: null,
      tagValue: row.value == null ? '' : String(row.value),
      relationType: 'facet',
      evidenceType: row.evidence_type || 'query_membership',
      queryFingerprint: getColumn(row, facetColumns, 'query_fingerprint', 'queryFingerprint') || '',
      observedAt: row.observed_at || null,
    };
    const relationKey = [
      mapped.provider,
      mapped.questionExternalId,
      mapped.dimension,
      mapped.tagExternalId,
      mapped.tagValue,
      mapped.relationType,
      mapped.evidenceType,
      mapped.queryFingerprint,
    ].join('\0');
    if (!uniqueTags.has(relationKey)) {
      uniqueTags.set(relationKey, true);
      tagOut.push(mapped);
    }
  }

  const db = new DatabaseSync(snapshotPath);
  try {
    createSnapshotSchema(db);
    const insertVersion = db.prepare(
      `INSERT INTO qb_textbook_version (provider, external_id, version_name, subject, grade, edition, source_url, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTextbook = db.prepare(
      `INSERT INTO qb_textbook (provider, external_id, version_external_id, textbook_name, subject, grade, edition, volume, source_url, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCatalog = db.prepare(
      `INSERT INTO qb_catalog_node (provider, external_id, textbook_external_id, parent_external_id, node_level, node_type, name, source_path, active, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertQuestion = db.prepare(
      `INSERT INTO qb_question (provider, external_id, textbook_version_external_id, textbook_external_id, detail_url, source_short, source_title, source_url, source_original_json, question_type, question_type_id, difficulty_label, difficulty_code, ease_coefficient, content_html, plain_text, content_hash, subquestion_count, child_count, has_image, has_formula, has_table, is_new, assemble_count, reference_count, year, region, exam_type, answer_html, solution_html, answer_status, first_seen_at, last_seen_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertQCatalog = db.prepare(
      `INSERT INTO qb_question_catalog (provider, question_external_id, catalog_external_id, relation_type, evidence_type, query_fingerprint, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTag = db.prepare(
      `INSERT INTO qb_question_tag (provider, question_external_id, dimension, tag_external_id, tag_value, relation_type, evidence_type, query_fingerprint, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAsset = db.prepare(
      `INSERT INTO qb_question_asset (provider, question_external_id, asset_key, asset_type, source_url, content_sha256, storage_path, mime_type, byte_size, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN IMMEDIATE;');
    try {
      insertVersion.run(
        provider,
        metadata.versionExternalId,
        metadata.versionName,
        metadata.subject || null,
        metadata.grade || null,
        metadata.edition || null,
        metadata.versionSourceUrl || metadata.sourceUrl || null,
        stableStringify(metadata),
      );
      insertTextbook.run(
        provider,
        metadata.textbookExternalId,
        metadata.versionExternalId,
        metadata.textbookName,
        metadata.subject || null,
        metadata.grade || null,
        metadata.edition || null,
        metadata.volume || null,
        metadata.textbookSourceUrl || metadata.sourceUrl || null,
        stableStringify(metadata),
      );
      for (const row of [...catalogRows].sort((a, b) => a.externalId.localeCompare(b.externalId)))
        insertCatalog.run(
          provider,
          row.externalId,
          row.textbookExternalId,
          row.parentExternalId,
          row.nodeLevel,
          row.nodeType,
          row.name,
          row.sourcePath,
          row.active,
          row.metadataJson,
        );
      for (const q of [...qOut].sort((a, b) => a.externalId.localeCompare(b.externalId)))
        insertQuestion.run(
          q.provider,
          q.externalId,
          q.textbookVersionExternalId,
          q.textbookExternalId,
          q.detailUrl,
          q.sourceShort,
          q.sourceTitle,
          q.sourceUrl,
          q.sourceOriginalJson,
          q.questionType,
          q.questionTypeId,
          q.difficultyLabel,
          q.difficultyCode,
          q.easeCoefficient,
          q.contentHtml,
          q.plainText,
          q.contentHash,
          q.subquestionCount,
          q.childCount,
          q.hasImage,
          q.hasFormula,
          q.hasTable,
          q.isNew,
          q.assembleCount,
          null,
          q.year,
          q.region,
          q.examType,
          q.answerHtml,
          q.solutionHtml,
          q.answerStatus,
          q.firstSeenAt,
          q.lastSeenAt,
          q.active,
        );
      for (const row of [...qCatalogOut].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
        insertQCatalog.run(
          row.provider,
          row.questionExternalId,
          row.catalogExternalId,
          row.relationType,
          row.evidenceType,
          row.queryFingerprint,
          row.observedAt,
        );
      for (const row of [...tagOut].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
        insertTag.run(
          row.provider,
          row.questionExternalId,
          row.dimension,
          row.tagExternalId,
          row.tagValue,
          row.relationType,
          row.evidenceType,
          row.queryFingerprint,
          row.observedAt,
        );
      for (const row of [...assetRows].sort((a, b) =>
        `${a.questionId}\0${a.assetKey}`.localeCompare(`${b.questionId}\0${b.assetKey}`),
      )) {
        let storagePath = null;
        if (row.sourcePath && row.contentSha256) storagePath = `assets/${row.contentSha256}${row.extension}`;
        insertAsset.run(
          row.provider,
          row.questionId,
          row.assetKey,
          row.assetType,
          row.sourceUrl,
          row.contentSha256 || null,
          storagePath,
          row.mimeType || null,
          row.byteSize == null ? null : Number(row.byteSize),
          row.observedAt,
        );
      }
      db.exec('COMMIT;');
    } catch (error) {
      try {
        db.exec('ROLLBACK;');
      } catch {}
      throw error;
    }
    db.exec('VACUUM;');
  } finally {
    db.close();
    source.close();
  }
  const counts = {};
  const snapshotRead = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    for (const table of SNAPSHOT_TABLES)
      counts[table] = Number(snapshotRead.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n);
    const chapterRows = snapshotRead
      .prepare(
        `SELECT c.external_id, c.name, COUNT(DISTINCT qc.question_external_id) AS question_count FROM qb_catalog_node c LEFT JOIN qb_question_catalog qc ON qc.provider = c.provider AND qc.catalog_external_id = c.external_id WHERE c.node_level = 1 GROUP BY c.provider, c.external_id, c.name ORDER BY c.external_id`,
      )
      .all();
    const chapterCounts = Object.fromEntries(
      chapterRows.map((row) => [
        String(row.external_id),
        { name: row.name, questionCount: Number(row.question_count) },
      ]),
    );
    return { counts, assets: assetRows, questions: qOut, catalogs: catalogRows, chapterCounts };
  } finally {
    snapshotRead.close();
  }
}

function copyAssetFiles(assetRows, stageDir, report) {
  for (const row of assetRows) {
    if (!row.sourcePath || !row.contentSha256) continue;
    const target = path.join(stageDir, 'assets', `${row.contentSha256}${row.extension}`);
    ensureDir(path.dirname(target));
    if (!fs.existsSync(target)) fs.copyFileSync(row.sourcePath, target);
    else if (sha256File(target) !== row.contentSha256)
      block(report, 'asset_package_content_conflict', `包内素材冲突：${row.contentSha256}`);
  }
}

function readPreviousSnapshot(previousPath, workDir, report) {
  if (!previousPath) return null;
  let fromSqlite = /\.(?:sqlite3?|db)$/i.test(String(previousPath));
  if (!fromSqlite) {
    try {
      const header = fs.readFileSync(previousPath).subarray(0, 16).toString('utf8');
      fromSqlite = header === 'SQLite format 3\0';
    } catch {}
  }
  const snapshotPath = fromSqlite ? previousPath : path.join(workDir, 'snapshot.sqlite3');
  let cleanup = false;
  try {
    if (!fromSqlite) {
      const previousValidation = verifyPackage(previousPath, { throwOnError: false });
      if (!previousValidation.pass) {
        block(report, 'previous_invalid', '上一 qbpkg 未通过离线验证', previousValidation.blocking);
        return null;
      }
      extractZip(previousPath, workDir);
      cleanup = true;
    }
    const db = new DatabaseSync(snapshotPath, { readOnly: true });
    const rows = db
      .prepare(`SELECT provider, external_id, content_hash, active FROM qb_question ORDER BY provider, external_id`)
      .all();
    const chapters = db
      .prepare(
        `SELECT c.external_id, c.name, COUNT(DISTINCT qc.question_external_id) AS question_count FROM qb_catalog_node c LEFT JOIN qb_question_catalog qc ON qc.provider = c.provider AND qc.catalog_external_id = c.external_id WHERE c.node_level = 1 GROUP BY c.provider, c.external_id, c.name`,
      )
      .all();
    db.close();
    return {
      questions: rows,
      chapters: chapters.map((row) => ({
        id: String(row.external_id),
        name: row.name,
        questionCount: Number(row.question_count),
      })),
    };
  } catch (error) {
    block(report, 'previous_invalid', `上一包/快照无法读取：${error.message}`);
    return null;
  } finally {
    if (cleanup) removeQuietly(snapshotPath);
  }
}

function makeDiff(previous, current, report) {
  if (!previous) {
    warn(report, 'no_baseline', '未提供上一包，diff-report 为 baseline');
    return {
      baseline: true,
      added: current.questions.map((q) => q.externalId).sort(),
      modified: [],
      deactivated: [],
      counts: { added: current.questions.length, modified: 0, deactivated: 0 },
      questionCounts: { previous: 0, current: current.questions.length, delta: current.questions.length },
      chapterChanges: Object.entries(current.chapterCounts).map(([id, item]) => ({
        id,
        name: item.name,
        previous: 0,
        current: item.questionCount,
        delta: item.questionCount,
      })),
    };
  }
  const oldMap = new Map(previous.questions.map((q) => [`${q.provider}\0${q.external_id}`, q]));
  const currentMap = new Map(current.questions.map((q) => [`${q.provider}\0${q.externalId}`, q]));
  const added = [];
  const modified = [];
  for (const [key, q] of currentMap) {
    if (!oldMap.has(key)) added.push(q.externalId);
    else if (oldMap.get(key).content_hash !== q.contentHash) modified.push(q.externalId);
  }
  const deactivated = [];
  for (const [key, q] of oldMap) if (!currentMap.has(key) || q.active === 0) deactivated.push(q.external_id);
  const oldChapters = new Map(previous.chapters.map((c) => [c.id, c]));
  const chapterIds = new Set([...oldChapters.keys(), ...Object.keys(current.chapterCounts)]);
  const chapterChanges = [...chapterIds]
    .sort()
    .map((id) => {
      const old = oldChapters.get(id);
      const currentItem = current.chapterCounts[id];
      const previousCount = old?.questionCount || 0;
      const currentCount = currentItem?.questionCount || 0;
      return {
        id,
        name: currentItem?.name || old?.name || null,
        previous: previousCount,
        current: currentCount,
        delta: currentCount - previousCount,
      };
    })
    .filter((item) => item.delta !== 0);
  return {
    baseline: false,
    added: added.sort(),
    modified: modified.sort(),
    deactivated: deactivated.sort(),
    counts: { added: added.length, modified: modified.length, deactivated: deactivated.length },
    questionCounts: {
      previous: previous.questions.length,
      current: current.questions.length,
      delta: current.questions.length - previous.questions.length,
    },
    chapterChanges,
  };
}

function enforceDecreaseThreshold(diff, options, report) {
  const threshold = options.decreaseThreshold ?? options.maxDecrease;
  if (threshold == null || diff.baseline) return;
  const numeric = Number(threshold);
  if (!Number.isFinite(numeric) || numeric < 0) {
    block(report, 'decrease_threshold_invalid', '下降阈值必须是非负数字');
    return;
  }
  const current = options.currentQuestionCount ?? diff.questionCounts?.current ?? null;
  const previous = options.previousQuestionCount ?? diff.questionCounts?.previous ?? null;
  if (current != null && previous != null && Number(previous) - Number(current) > numeric) {
    block(report, 'decrease_threshold_exceeded', `总题目数量下降超过阈值：${previous} -> ${current}，阈值 ${numeric}`);
  }
  const chapterDrops = diff.chapterChanges.filter((item) => item.delta < -numeric);
  if (chapterDrops.length > 0) block(report, 'decrease_threshold_exceeded', '章节题目数量下降超过阈值', chapterDrops);
  if (options.blockOnDeactivation && diff.deactivated.length > 0)
    block(report, 'deactivated_questions', '发现停用题目且配置要求阻断', diff.deactivated);
}

function writeChecksums(stageDir, names) {
  const lines = names
    .filter((name) => name !== 'checksums.sha256')
    .sort()
    .map((name) => `${sha256File(path.join(stageDir, name))}  ${name}`);
  fs.writeFileSync(path.join(stageDir, 'checksums.sha256'), `${lines.join('\n')}\n`);
}

function buildManifest(metadata, options, snapshotInfo, snapshotSha) {
  const createdAt = options.createdAt || new Date().toISOString();
  return {
    formatVersion: PACKAGE_FORMAT_VERSION,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    batchNo: String(
      options.batchNo || `batch-${sha256(`${metadata.provider}\0${createdAt}\0${metadata.versionName}`).slice(0, 16)}`,
    ),
    createdAt,
    sourceProvider: metadata.provider,
    fullSnapshot: true,
    dataset: metadata,
    counts: snapshotInfo.counts,
    snapshotSha256: snapshotSha,
  };
}

function buildPackage(options = {}) {
  const outputPath = path.resolve(options.output || options.out || options.packagePath || 'qbpkg-output.qbpkg');
  const sourceDbPath = path.resolve(options.db || options.sourceDb || options.source || 'data/zujuan.sqlite3');
  const report = reportTemplate();
  if (options.fullSnapshot !== true && options.fullSnapshot !== 'true')
    block(report, 'full_snapshot_required', '构建必须显式声明 full-snapshot');
  const metadata = getDatasetMetadata(options, report);
  const evidence = normalizeEvidence(options, report);
  const parentDir = path.dirname(outputPath);
  ensureDir(parentDir);
  if (fs.existsSync(outputPath)) throw new Error(`目标包已存在，默认拒绝覆盖：${outputPath}`);
  const workDir = makeTempDir('.qbpkg-build-', parentDir);
  let zipPath;
  try {
    const snapshotPath = path.join(workDir, 'snapshot.sqlite3');
    let snapshotInfo;
    try {
      snapshotInfo = buildSnapshot({ sourceDbPath, snapshotPath, metadata, options, report });
    } catch (error) {
      if (report.blocking.length > 0) {
        block(report, 'snapshot_build_failed', `正式快照写入失败：${error.message}`);
        throw new QbPkgValidationError('qbpkg 构建验证阻断', report);
      }
      throw error;
    }
    const previousPath = options.previous || options.previousPackage || options.previousSnapshot;
    const previousWork = path.join(workDir, 'previous');
    ensureDir(previousWork);
    const previous = readPreviousSnapshot(previousPath, previousWork, report);
    const diff = makeDiff(previous, snapshotInfo, report);
    enforceDecreaseThreshold(diff, options, report);
    const snapshotSha = fs.existsSync(snapshotPath) ? sha256File(snapshotPath) : null;
    const manifest = buildManifest(metadata, options, snapshotInfo, snapshotSha);
    manifest.rangeEvidence = evidence;
    fs.writeFileSync(path.join(workDir, 'manifest.json'), stableStringify(manifest));
    fs.writeFileSync(path.join(workDir, 'diff-report.json'), stableStringify(diff));
    copyAssetFiles(snapshotInfo.assets, workDir, report);
    check(report, 'full_snapshot_declared', options.fullSnapshot === true || options.fullSnapshot === 'true');
    check(
      report,
      'range_evidence_complete',
      Boolean(
        evidence &&
        (evidence.completed === true ||
          evidence.complete === true ||
          evidence.finished === true ||
          evidence.status === 'success' ||
          evidence.status === 'completed'),
      ),
    );
    check(
      report,
      'snapshot_tables',
      snapshotInfo.counts && SNAPSHOT_TABLES.every((table) => table in snapshotInfo.counts),
    );
    report.pass = report.blocking.length === 0;
    fs.writeFileSync(path.join(workDir, 'validation.json'), stableStringify(report));
    if (!report.pass) throw new QbPkgValidationError('qbpkg 构建验证阻断', report);
    const packageNames = fs
      .readdirSync(workDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== 'checksums.sha256')
      .map((entry) => entry.name)
      .concat(fs.existsSync(path.join(workDir, 'assets')) ? [] : []);
    const assetNames = [];
    const collect = (relative) => {
      const full = path.join(workDir, relative);
      if (!fs.existsSync(full)) return;
      for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        const child = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) collect(child);
        else assetNames.push(child);
      }
    };
    collect('assets');
    const names = [...packageNames, ...assetNames].filter((name) => name !== 'previous').sort();
    writeChecksums(workDir, names);
    zipPath = path.join(parentDir, `.qbpkg-${process.pid}-${Date.now()}.tmp`);
    zipFiles(zipPath, [...names, 'checksums.sha256'].sort(), workDir);
    const verification = verifyPackage(zipPath, { throwOnError: false });
    if (!verification.pass) throw new QbPkgValidationError('生成的 qbpkg 自验证失败', verification);
    if (fs.existsSync(outputPath)) throw new Error(`目标包已存在，默认拒绝覆盖：${outputPath}`);
    fs.renameSync(zipPath, outputPath);
    zipPath = null;
    return { outputPath, manifest, diff, validation: report };
  } finally {
    if (zipPath) removeQuietly(zipPath);
    removeQuietly(workDir);
  }
}

module.exports = {
  QbPkgValidationError,
  buildPackage,
  buildSnapshot,
  enforceDecreaseThreshold,
  makeDiff,
  normalizeEvidence,
  reportTemplate,
};
