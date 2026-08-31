'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SNAPSHOT_TABLES, SNAPSHOT_SCHEMA_VERSION, PACKAGE_FORMAT_VERSION } = require('./schema.cjs');
const { assetKey, checkHtml } = require('./normalize.cjs');
const {
  extractZip,
  isSafeZipEntry,
  listZipEntryDetails,
  listZipEntries,
  makeTempDir,
  parseJsonFile,
  removeQuietly,
  sha256File,
} = require('./util.cjs');

const REQUIRED_MEMBERS = Object.freeze([
  'manifest.json',
  'snapshot.sqlite3',
  'diff-report.json',
  'validation.json',
  'checksums.sha256',
]);

const ARCHIVE_LIMITS = Object.freeze({
  maxCompressedBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 100000,
  maxMemberBytes: 512 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxCompressionRatio: 250,
});

function validationReport() {
  return { blocking: [], warnings: [], checks: [], pass: false };
}

function blocking(report, code, message, details = undefined) {
  const item = { code, message };
  if (details !== undefined) item.details = details;
  report.blocking.push(item);
}

function warning(report, code, message, details = undefined) {
  const item = { code, message };
  if (details !== undefined) item.details = details;
  report.warnings.push(item);
}

function check(report, name, pass, details = undefined) {
  const item = { name, pass: Boolean(pass) };
  if (details !== undefined) item.details = details;
  report.checks.push(item);
}

function parseChecksumLines(text, report) {
  const records = [];
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim() !== '');
  for (const line of lines) {
    const match = line.match(/^([a-fA-F0-9]{64})  (.+)$/);
    if (!match) {
      blocking(report, 'checksum_format_invalid', `checksums.sha256 行格式非法：${line}`);
      continue;
    }
    records.push({ hash: match[1].toLowerCase(), name: match[2] });
  }
  const names = records.map((record) => record.name);
  if (names.some((name) => !isSafeZipEntry(name) || name === 'checksums.sha256')) {
    blocking(report, 'checksum_path_invalid', 'checksums.sha256 包含非法或自身路径');
  }
  if (names.some((name, index) => index > 0 && name <= names[index - 1])) {
    blocking(report, 'checksum_order_invalid', 'checksums.sha256 路径未严格排序');
  }
  if (new Set(names).size !== names.length) blocking(report, 'checksum_duplicate_path', 'checksums.sha256 存在重复路径');
  return records;
}

function assertRequiredEntries(entries, report) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry, (counts.get(entry) || 0) + 1);
  for (const required of REQUIRED_MEMBERS) {
    if (!counts.has(required)) blocking(report, 'required_member_missing', `缺少包成员：${required}`);
    else if (counts.get(required) !== 1) blocking(report, 'duplicate_member', `包成员重复：${required}`);
  }
  for (const entry of entries) {
    if (!isSafeZipEntry(entry)) blocking(report, 'zip_path_unsafe', `ZIP 路径不安全：${entry}`);
    if (entry.includes('/')) {
      if (!entry.startsWith('assets/')) blocking(report, 'zip_root_invalid', `包成员不在固定根路径或 assets 下：${entry}`);
    }
  }
  if (new Set(entries).size !== entries.length) blocking(report, 'duplicate_member', 'ZIP 存在重复成员路径');
}

function validateArchiveLimits(packagePath, details, report, limits = ARCHIVE_LIMITS) {
  const compressedFileSize = fs.statSync(packagePath).size;
  const totalBytes = details.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  const oversized = details.filter((entry) => entry.uncompressedSize > limits.maxMemberBytes);
  const suspiciousRatio = details.filter((entry) => (
    entry.uncompressedSize > 1024 * 1024
    && entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.maxCompressionRatio
  ));

  if (compressedFileSize > limits.maxCompressedBytes) blocking(report, 'archive_compressed_size_exceeded', 'qbpkg 压缩文件超过允许上限');
  if (details.length > limits.maxEntries) blocking(report, 'archive_entry_count_exceeded', 'qbpkg 成员数量超过允许上限');
  if (totalBytes > limits.maxTotalBytes) blocking(report, 'archive_total_size_exceeded', 'qbpkg 总解压大小超过允许上限');
  if (oversized.length > 0) blocking(report, 'archive_member_size_exceeded', 'qbpkg 单成员解压大小超过允许上限', oversized);
  if (suspiciousRatio.length > 0) blocking(report, 'archive_compression_ratio_exceeded', 'qbpkg 成员压缩比异常', suspiciousRatio);
}

function validateSnapshot(snapshotPath, manifest, report, packageRoot = null) {
  let db;
  try { db = new DatabaseSync(snapshotPath, { readOnly: true }); }
  catch (error) {
    blocking(report, 'snapshot_open_failed', `无法打开 snapshot.sqlite3：${error.message}`);
    return;
  }
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const integrityValue = integrity?.integrity_check ?? integrity?.[Object.keys(integrity || {})[0]];
    check(report, 'sqlite_integrity', integrityValue === 'ok', integrityValue);
    if (integrityValue !== 'ok') blocking(report, 'sqlite_integrity_failed', `SQLite integrity_check 失败：${integrityValue}`);
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    check(report, 'sqlite_foreign_key_integrity', foreignKeys.length === 0, foreignKeys);
    if (foreignKeys.length > 0) blocking(report, 'sqlite_foreign_key_failed', 'SQLite foreign_key_check 失败', foreignKeys);
    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const actualTables = tableRows.map((row) => row.name);
    const expected = [...SNAPSHOT_TABLES].sort();
    const exact = JSON.stringify(actualTables) === JSON.stringify(expected);
    check(report, 'snapshot_tables', exact, { expected, actual: actualTables });
    if (!exact) blocking(report, 'snapshot_tables_invalid', 'snapshot.sqlite3 表集合不符合七张正式业务表');
    const providerRows = db.prepare('SELECT DISTINCT provider FROM qb_textbook_version UNION SELECT DISTINCT provider FROM qb_textbook UNION SELECT DISTINCT provider FROM qb_catalog_node UNION SELECT DISTINCT provider FROM qb_question UNION SELECT DISTINCT provider FROM qb_question_catalog UNION SELECT DISTINCT provider FROM qb_question_tag UNION SELECT DISTINCT provider FROM qb_question_asset').all();
    const providerMismatch = manifest?.sourceProvider ? providerRows.filter((row) => row.provider !== manifest.sourceProvider) : [];
    check(report, 'snapshot_provider_consistency', providerMismatch.length === 0, providerMismatch);
    if (providerMismatch.length > 0) blocking(report, 'provider_mismatch', 'snapshot 表 provider 与 manifest sourceProvider 不一致', providerMismatch);
    const version = db.prepare('SELECT provider, external_id, version_name FROM qb_textbook_version LIMIT 1').get();
    const textbook = db.prepare('SELECT provider, external_id, version_external_id, textbook_name FROM qb_textbook LIMIT 1').get();
    if (manifest?.dataset && version) {
      const mismatch = [];
      if (String(version.external_id) !== String(manifest.dataset.versionExternalId || version.external_id)) mismatch.push({ field: 'versionExternalId', expected: manifest.dataset.versionExternalId, actual: version.external_id });
      if (String(version.version_name) !== String(manifest.dataset.versionName)) mismatch.push({ field: 'versionName', expected: manifest.dataset.versionName, actual: version.version_name });
      check(report, 'snapshot_version_metadata', mismatch.length === 0, mismatch);
      if (mismatch.length > 0) blocking(report, 'manifest_snapshot_mismatch', 'snapshot 版本元数据与 manifest 不一致', mismatch);
    }
    if (manifest?.dataset && textbook) {
      const mismatch = [];
      if (String(textbook.external_id) !== String(manifest.dataset.textbookExternalId || textbook.external_id)) mismatch.push({ field: 'textbookExternalId', expected: manifest.dataset.textbookExternalId, actual: textbook.external_id });
      if (String(textbook.textbook_name) !== String(manifest.dataset.textbookName)) mismatch.push({ field: 'textbookName', expected: manifest.dataset.textbookName, actual: textbook.textbook_name });
      check(report, 'snapshot_textbook_metadata', mismatch.length === 0, mismatch);
      if (mismatch.length > 0) blocking(report, 'manifest_snapshot_mismatch', 'snapshot 教材元数据与 manifest 不一致', mismatch);
    }
    for (const table of SNAPSHOT_TABLES) {
      if (!actualTables.includes(table)) continue;
      const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n);
      const expectedCount = Number(manifest?.counts?.[table]);
      check(report, `count_${table}`, Number.isFinite(expectedCount) && count === expectedCount, { expected: expectedCount, actual: count });
      if (!Number.isFinite(expectedCount) || count !== expectedCount) blocking(report, 'manifest_count_mismatch', `${table} 计数与 manifest 不一致`, { expected: expectedCount, actual: count });
    }
    const nullRefs = db.prepare(`SELECT COUNT(*) AS n FROM qb_question_catalog qc LEFT JOIN qb_question q ON q.provider=qc.provider AND q.external_id=qc.question_external_id LEFT JOIN qb_catalog_node c ON c.provider=qc.provider AND c.external_id=qc.catalog_external_id WHERE q.external_id IS NULL OR c.external_id IS NULL`).get().n;
    check(report, 'catalog_referential_integrity', Number(nullRefs) === 0, Number(nullRefs));
    if (Number(nullRefs) !== 0) blocking(report, 'orphan_relation', `snapshot 存在 ${nullRefs} 条孤儿目录关系`);
    const nullTagRefs = db.prepare(`SELECT COUNT(*) AS n FROM qb_question_tag qt LEFT JOIN qb_question q ON q.provider=qt.provider AND q.external_id=qt.question_external_id WHERE q.external_id IS NULL`).get().n;
    check(report, 'tag_referential_integrity', Number(nullTagRefs) === 0, Number(nullTagRefs));
    if (Number(nullTagRefs) !== 0) blocking(report, 'orphan_relation', `snapshot 存在 ${nullTagRefs} 条孤儿标签关系`);
    const nullAssetRefs = db.prepare(`SELECT COUNT(*) AS n FROM qb_question_asset qa LEFT JOIN qb_question q ON q.provider=qa.provider AND q.external_id=qa.question_external_id WHERE q.external_id IS NULL`).get().n;
    check(report, 'asset_referential_integrity', Number(nullAssetRefs) === 0, Number(nullAssetRefs));
    if (Number(nullAssetRefs) !== 0) blocking(report, 'orphan_relation', `snapshot 存在 ${nullAssetRefs} 条孤儿素材关系`);
    const referenceCount = db.prepare('SELECT COUNT(*) AS n FROM qb_question WHERE reference_count IS NOT NULL').get().n;
    check(report, 'reference_count_null', Number(referenceCount) === 0, Number(referenceCount));
    if (Number(referenceCount) !== 0) blocking(report, 'reference_count_not_null', 'reference_count 必须全部为 NULL');
    const badAnswerStatus = db.prepare(`SELECT COUNT(*) AS n FROM qb_question WHERE (answer_status = 'not_collected' AND (answer_html IS NOT NULL OR solution_html IS NOT NULL)) OR (answer_status = 'public_captured' AND answer_html IS NULL AND solution_html IS NULL)`).get().n;
    check(report, 'answer_status_consistency', Number(badAnswerStatus) === 0, Number(badAnswerStatus));
    if (Number(badAnswerStatus) !== 0) blocking(report, 'answer_status_invalid', 'answer_status 与答案/解析字段不一致');
    const assetRows = db.prepare('SELECT provider, question_external_id, asset_key, asset_type, source_url, content_sha256, storage_path FROM qb_question_asset').all();
    const badAssetFields = assetRows.filter((row) => !row.asset_type || !row.source_url);
    check(report, 'asset_fields_present', badAssetFields.length === 0, badAssetFields);
    if (badAssetFields.length > 0) blocking(report, 'asset_field_missing', '素材缺少 asset_type 或 source_url', badAssetFields);
    const badAssetHashes = assetRows.filter((row) => row.content_sha256 != null && !/^[a-f0-9]{64}$/i.test(String(row.content_sha256)));
    check(report, 'asset_content_hash_format', badAssetHashes.length === 0, badAssetHashes);
    if (badAssetHashes.length > 0) blocking(report, 'asset_content_hash_invalid', '素材 content_sha256 不是完整 SHA-256', badAssetHashes);
    const badAssetKeys = assetRows.filter((row) => !/^[A-Za-z0-9_.-]+-[0-9a-f]{16}$/.test(String(row.asset_key || '')));
    check(report, 'asset_keys_present', badAssetKeys.length === 0, badAssetKeys);
    if (badAssetKeys.length > 0) blocking(report, 'asset_key_missing', `存在 ${badAssetKeys.length} 个非法素材键`, badAssetKeys);
    const mismatchedAssetKeys = assetRows.filter((row) => row.asset_key !== assetKey(row.asset_type, row.source_url));
    check(report, 'asset_keys_derived', mismatchedAssetKeys.length === 0, mismatchedAssetKeys);
    if (mismatchedAssetKeys.length > 0) blocking(report, 'asset_key_conflict', `存在 ${mismatchedAssetKeys.length} 个素材键与 source URL 不一致`, mismatchedAssetKeys);
    const questionRows = db.prepare('SELECT provider, external_id, content_html FROM qb_question').all();
    const questionAssetKeys = new Map();
    for (const row of assetRows) {
      const key = `${row.provider}\0${row.question_external_id}`;
      const set = questionAssetKeys.get(key) || new Set();
      set.add(row.asset_key);
      questionAssetKeys.set(key, set);
    }
    const badHtml = [];
    const badJson = [];
    const badQuestionProviders = [];
    for (const row of questionRows) {
      const html = row.content_html;
      const htmlCheck = checkHtml(html);
      const missing = [];
      const keys = questionAssetKeys.get(`${row.provider}\0${row.external_id}`) || new Set();
      if (!htmlCheck.valid) badHtml.push({ id: row.external_id, errors: htmlCheck.errors });
      for (const tag of String(html || '').match(/<img\b[^>]*>/gi) || []) {
        if (/\bsrc\s*=/i.test(tag)) badHtml.push({ id: row.external_id, errors: ['HTML 仍包含未替换 img src'] });
        const keyMatch = tag.match(/\bdata-asset-key\s*=\s*(?:(["'])([^"']+)\1|([^\s>]+))/i);
        if (!keyMatch) badHtml.push({ id: row.external_id, errors: ['img 缺少 data-asset-key'] });
        else if (!keys.has(keyMatch[2] || keyMatch[3])) missing.push(keyMatch[2] || keyMatch[3]);
      }
      if (missing.length > 0) badHtml.push({ id: row.external_id, errors: [`缺少素材键：${missing.join(',')}`] });
    }
    for (const row of db.prepare('SELECT provider, external_id, source_original_json FROM qb_question').all()) {
      try {
        const parsed = JSON.parse(String(row.source_original_json));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象');
      } catch (error) { badJson.push({ id: row.external_id, error: error.message }); }
      if (manifest?.sourceProvider && row.provider !== manifest.sourceProvider) badQuestionProviders.push(row);
    }
    check(report, 'question_source_json', badJson.length === 0, badJson);
    if (badJson.length > 0) blocking(report, 'invalid_json', `存在 ${badJson.length} 条非法题目原始 JSON`, badJson);
    check(report, 'question_provider_consistency', badQuestionProviders.length === 0, badQuestionProviders);
    if (badQuestionProviders.length > 0) blocking(report, 'provider_mismatch', '题目 provider 与 manifest sourceProvider 不一致', badQuestionProviders);
    check(report, 'question_html_assets', badHtml.length === 0, badHtml);
    if (badHtml.length > 0) blocking(report, 'asset_key_missing', `存在 ${badHtml.length} 个题干 HTML 素材映射错误`, badHtml);
    const badStoragePaths = assetRows.filter((row) => row.storage_path && (!row.content_sha256 || !String(row.storage_path).startsWith(`assets/${row.content_sha256}`)));
    check(report, 'asset_storage_paths', badStoragePaths.length === 0, badStoragePaths);
    if (badStoragePaths.length > 0) blocking(report, 'asset_storage_path_invalid', '素材 storage_path 未按完整 SHA-256 寻址', badStoragePaths);
    if (packageRoot) {
      const missingStorage = assetRows.filter((row) => row.storage_path && !fs.existsSync(path.join(packageRoot, row.storage_path)));
      check(report, 'asset_storage_files', missingStorage.length === 0, missingStorage);
      if (missingStorage.length > 0) blocking(report, 'asset_storage_missing', 'snapshot 引用的素材文件不在包内', missingStorage);
      const badStorageHash = assetRows.filter((row) => row.storage_path && fs.existsSync(path.join(packageRoot, row.storage_path)) && row.content_sha256 && sha256File(path.join(packageRoot, row.storage_path)) !== row.content_sha256);
      check(report, 'asset_storage_hashes', badStorageHash.length === 0, badStorageHash);
      if (badStorageHash.length > 0) blocking(report, 'asset_content_hash_mismatch', '包内素材内容 SHA-256 不匹配', badStorageHash);
    }
    const duplicateCatalog = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT provider, question_external_id, catalog_external_id, relation_type, evidence_type, COALESCE(query_fingerprint, '') AS query_fingerprint, COUNT(*) AS c FROM qb_question_catalog GROUP BY provider, question_external_id, catalog_external_id, relation_type, evidence_type, COALESCE(query_fingerprint, '') HAVING c > 1)`).get().n;
    check(report, 'duplicate_catalog_relations', Number(duplicateCatalog) === 0, Number(duplicateCatalog));
    if (Number(duplicateCatalog) !== 0) blocking(report, 'duplicate_relation', `snapshot 存在 ${duplicateCatalog} 组重复目录关系`);
    const badCatalogEvidence = db.prepare(`SELECT COUNT(*) AS n FROM qb_question_catalog WHERE relation_type != 'query_catalog' OR evidence_type != 'query_membership'`).get().n;
    check(report, 'catalog_relation_semantics', Number(badCatalogEvidence) === 0, Number(badCatalogEvidence));
    if (Number(badCatalogEvidence) !== 0) blocking(report, 'relation_semantics_invalid', '目录关系 relation_type/evidence_type 非规范值');
    const duplicateTags = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT provider, question_external_id, dimension, COALESCE(tag_external_id, ''), tag_value, relation_type, evidence_type, COALESCE(query_fingerprint, ''), COUNT(*) AS c FROM qb_question_tag GROUP BY provider, question_external_id, dimension, COALESCE(tag_external_id, ''), tag_value, relation_type, evidence_type, COALESCE(query_fingerprint, '') HAVING c > 1)`).get().n;
    check(report, 'duplicate_tag_relations', Number(duplicateTags) === 0, Number(duplicateTags));
    if (Number(duplicateTags) !== 0) blocking(report, 'duplicate_relation', `snapshot 存在 ${duplicateTags} 组重复标签关系`);
    const badKnowledgeEvidence = db.prepare(`SELECT COUNT(*) AS n FROM qb_question_tag WHERE dimension = 'knowledge' AND (relation_type != 'knowledge' OR evidence_type != 'provider_asserted')`).get().n;
    check(report, 'knowledge_relation_semantics', Number(badKnowledgeEvidence) === 0, Number(badKnowledgeEvidence));
    if (Number(badKnowledgeEvidence) !== 0) blocking(report, 'relation_semantics_invalid', '知识点关系 relation_type/evidence_type 非规范值');
    const duplicateAssets = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT provider, question_external_id, asset_key, COUNT(*) AS c FROM qb_question_asset GROUP BY provider, question_external_id, asset_key HAVING c > 1)`).get().n;
    check(report, 'duplicate_asset_relations', Number(duplicateAssets) === 0, Number(duplicateAssets));
    if (Number(duplicateAssets) !== 0) blocking(report, 'duplicate_relation', `snapshot 存在 ${duplicateAssets} 组重复素材关系`);
    const conflictingAssets = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT asset_key, COUNT(DISTINCT source_url || char(0) || asset_type) AS c FROM qb_question_asset GROUP BY asset_key HAVING c > 1)`).get().n;
    check(report, 'asset_key_conflicts', Number(conflictingAssets) === 0, Number(conflictingAssets));
    if (Number(conflictingAssets) !== 0) blocking(report, 'asset_key_conflict', `snapshot 存在 ${conflictingAssets} 个素材键冲突`);
    const catalogs = db.prepare('SELECT external_id, parent_external_id FROM qb_catalog_node').all();
    const parents = new Map(catalogs.map((row) => [String(row.external_id), row.parent_external_id == null ? null : String(row.parent_external_id)]));
    const cycles = [];
    for (const id of parents.keys()) {
      const seen = new Set(); let current = id;
      while (current != null && parents.has(current)) {
        if (seen.has(current)) { cycles.push(id); break; }
        seen.add(current); current = parents.get(current);
      }
    }
    check(report, 'catalog_parent_cycles', cycles.length === 0, cycles);
    if (cycles.length > 0) blocking(report, 'catalog_cycle', '目录父链存在循环', cycles);
  } catch (error) {
    blocking(report, 'snapshot_query_failed', `snapshot 校验查询失败：${error.message}`);
  } finally { db.close(); }
}

function verifyPackage(packagePath, options = {}) {
  const report = validationReport();
  const input = path.resolve(packagePath);
  if (!fs.existsSync(input)) blocking(report, 'package_missing', `包不存在：${input}`);
  if (report.blocking.length > 0) return finish(report, options);
  let entries;
  try { entries = listZipEntries(input); }
  catch (error) {
    blocking(report, 'zip_read_failed', error.message);
    return finish(report, options);
  }
  assertRequiredEntries(entries, report);
  try {
    validateArchiveLimits(input, listZipEntryDetails(input), report);
  } catch (error) {
    blocking(report, 'archive_metadata_invalid', error.message);
  }
  if (report.blocking.length > 0) return finish(report, options);
  const tempDir = makeTempDir('.qbpkg-verify-');
  try {
    const checksumsPath = path.join(tempDir, 'checksums.sha256');
    extractZip(input, tempDir);
    for (const entry of entries) {
      const extracted = path.join(tempDir, entry);
      if (entry.endsWith('/')) continue;
      try {
        if (!fs.lstatSync(extracted).isFile()) blocking(report, 'zip_member_not_regular_file', `ZIP 成员不是普通文件：${entry}`);
      } catch (error) {
        blocking(report, 'zip_member_extract_missing', `ZIP 成员解压后缺失：${entry}：${error.message}`);
      }
    }
    const checksumRecords = parseChecksumLines(fs.readFileSync(checksumsPath, 'utf8'), report);
    const expectedNames = entries.filter((entry) => entry !== 'checksums.sha256').sort();
    const actualNames = checksumRecords.map((record) => record.name);
    check(report, 'checksum_member_coverage', JSON.stringify(expectedNames) === JSON.stringify(actualNames), { expected: expectedNames, actual: actualNames });
    if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) blocking(report, 'checksum_member_coverage_invalid', 'checksums.sha256 未覆盖全部且仅覆盖一次其他成员');
    for (const record of checksumRecords) {
      const target = path.join(tempDir, record.name);
      if (!fs.existsSync(target)) {
        blocking(report, 'checksum_target_missing', `校验和目标缺失：${record.name}`);
        continue;
      }
      const actual = sha256File(target);
      check(report, `checksum_${record.name}`, actual === record.hash, { expected: record.hash, actual });
      if (actual !== record.hash) blocking(report, 'checksum_mismatch', `成员校验和不匹配：${record.name}`);
    }
    let manifest;
    let validation;
    try { manifest = parseJsonFile(path.join(tempDir, 'manifest.json'), 'manifest.json'); }
    catch (error) { blocking(report, 'manifest_invalid', error.message); manifest = null; }
    try { validation = parseJsonFile(path.join(tempDir, 'validation.json'), 'validation.json'); }
    catch (error) { blocking(report, 'validation_invalid', error.message); validation = null; }
    try { parseJsonFile(path.join(tempDir, 'diff-report.json'), 'diff-report.json'); }
    catch (error) { blocking(report, 'diff_invalid', error.message); }
    if (manifest) {
      const requiredManifestFields = ['formatVersion', 'schemaVersion', 'batchNo', 'createdAt', 'sourceProvider', 'dataset', 'counts', 'snapshotSha256', 'fullSnapshot', 'rangeEvidence'];
      const missingManifestFields = requiredManifestFields.filter((field) => manifest[field] == null);
      check(report, 'manifest_required_fields', missingManifestFields.length === 0, missingManifestFields);
      if (missingManifestFields.length > 0) blocking(report, 'manifest_field_missing', 'manifest 缺少必填字段', missingManifestFields);
      check(report, 'manifest_format_version', String(manifest.formatVersion) === PACKAGE_FORMAT_VERSION, manifest.formatVersion);
      if (String(manifest.formatVersion) !== PACKAGE_FORMAT_VERSION) blocking(report, 'manifest_version_invalid', 'formatVersion 不支持');
      check(report, 'manifest_schema_version', String(manifest.schemaVersion) === SNAPSHOT_SCHEMA_VERSION, manifest.schemaVersion);
      if (String(manifest.schemaVersion) !== SNAPSHOT_SCHEMA_VERSION) blocking(report, 'manifest_version_invalid', 'schemaVersion 不支持');
      if (!manifest.sourceProvider || !manifest.dataset || !manifest.dataset.provider || !manifest.dataset.versionName || !manifest.dataset.textbookName) blocking(report, 'manifest_metadata_missing', 'manifest 缺少关键 dataset metadata');
      if (manifest.fullSnapshot !== true) blocking(report, 'full_snapshot_required', 'manifest 未声明 fullSnapshot');
      const manifestEvidence = manifest.rangeEvidence;
      const evidenceComplete = manifestEvidence && (manifestEvidence.completed === true || manifestEvidence.complete === true || manifestEvidence.finished === true || manifestEvidence.status === 'success' || manifestEvidence.status === 'completed');
      if (!evidenceComplete) blocking(report, 'range_completion_missing', 'manifest 范围证据未声明已完成');
      const scope = manifestEvidence && (manifestEvidence.scope ?? manifestEvidence.range ?? manifestEvidence.syncScope ?? manifestEvidence.expectedScope ?? manifestEvidence.coverage ?? manifestEvidence.catalogs ?? manifestEvidence.chapters);
      const emptyScope = scope == null || (typeof scope === 'string' && scope.trim() === '') || (Array.isArray(scope) && scope.length === 0) || (scope && typeof scope === 'object' && !Array.isArray(scope) && Object.keys(scope).length === 0);
      if (emptyScope) blocking(report, 'range_scope_missing', 'manifest 范围证据缺少明确同步范围');
      if (typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) blocking(report, 'manifest_created_at_invalid', 'manifest createdAt 不是合法 ISO 时间');
      if (typeof manifest.batchNo !== 'string' || manifest.batchNo.trim() === '') blocking(report, 'manifest_batch_no_missing', 'manifest batchNo 不能为空');
      const snapshotSha = sha256File(path.join(tempDir, 'snapshot.sqlite3'));
      const declaredSha = manifest.snapshotSha256 || manifest.snapshot_sha256;
      check(report, 'manifest_snapshot_sha256', snapshotSha === declaredSha, { expected: declaredSha, actual: snapshotSha });
      if (snapshotSha !== declaredSha) blocking(report, 'manifest_snapshot_mismatch', 'manifest 中 snapshot SHA-256 不匹配');
      if (manifest.dataset.provider && manifest.dataset.provider !== manifest.sourceProvider) blocking(report, 'manifest_metadata_mismatch', 'manifest dataset.provider 与 sourceProvider 不一致');
      validateSnapshot(path.join(tempDir, 'snapshot.sqlite3'), manifest, report, tempDir);
    }
    if (validation) {
      const validationFields = ['blocking', 'warnings', 'checks', 'pass'];
      const missingValidationFields = validationFields.filter((field) => validation[field] == null);
      if (missingValidationFields.length > 0) blocking(report, 'validation_field_missing', 'validation.json 缺少必填字段', missingValidationFields);
      if (!Array.isArray(validation.blocking) || !Array.isArray(validation.warnings) || !Array.isArray(validation.checks) || typeof validation.pass !== 'boolean') blocking(report, 'validation_shape_invalid', 'validation.json 字段类型非法');
      if (validation.pass !== true || (Array.isArray(validation.blocking) && validation.blocking.length > 0)) blocking(report, 'embedded_validation_failed', '包内 validation.json 已报告阻断');
    }
  } catch (error) {
    blocking(report, 'zip_extract_failed', error.message);
  } finally { removeQuietly(tempDir); }
  return finish(report, options);
}

function finish(report, options) {
  report.pass = report.blocking.length === 0;
  if (!report.pass && options.throwOnError !== false) {
    const error = new Error('qbpkg 验证失败');
    error.report = report;
    throw error;
  }
  return report;
}

module.exports = {
  REQUIRED_MEMBERS,
  parseChecksumLines,
  validateArchiveLimits,
  validateSnapshot,
  verifyPackage,
};
