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
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function isAbsoluteStoragePath(value) {
  const text = String(value || '');
  return (
    path.isAbsolute(text) ||
    path.posix.isAbsolute(text) ||
    path.win32.isAbsolute(text) ||
    // Reject drive-relative spellings (`C:foo`) too; they are not absolute
    // on Windows but can escape the intended drive when resolved there.
    /^[A-Za-z]:/.test(text) ||
    /^\\\\/.test(text)
  );
}

function resolveAssetFile(dataDir, storagePath) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw httpError('collector 素材目录未配置', 503, 'asset_unavailable');
  }
  if (
    typeof storagePath !== 'string' ||
    !storagePath.trim() ||
    /[\u0000-\u001f\u007f]/.test(storagePath) ||
    isAbsoluteStoragePath(storagePath)
  ) {
    throw httpError('素材存储路径不安全', 404, 'asset_not_found');
  }
  // Collector paths are persisted as POSIX-style relative paths.  Treat a
  // backslash as a separator too, otherwise a Windows traversal can become
  // a harmless-looking filename when served on Linux (and vice versa).
  const normalizedStoragePath = storagePath.replace(/\\/g, '/');
  const parts = normalizedStoragePath.split('/');
  if (parts.some((part) => part === '..')) {
    throw httpError('素材存储路径不安全', 404, 'asset_not_found');
  }
  const root = path.resolve(dataDir);
  const candidate = path.resolve(root, normalizedStoragePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw httpError('素材存储路径不安全', 404, 'asset_not_found');
  }
  let rootReal;
  let candidateReal;
  let stat;
  try {
    rootReal = fs.realpathSync.native(root);
    candidateReal = fs.realpathSync.native(candidate);
    stat = fs.statSync(candidateReal);
    const realRelative = path.relative(rootReal, candidateReal);
    if (
      !realRelative ||
      realRelative === '..' ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative) ||
      !stat.isFile()
    ) {
      throw new Error('asset path outside root');
    }
  } catch (error) {
    if (error?.statusCode) throw error;
    throw httpError('素材文件不存在或不可用', 404, 'asset_not_found');
  }
  return { path: candidateReal, stat };
}

function sha256File(filePath, { keepOpen = false } = {}) {
  let descriptor;
  let retained = false;
  const hash = createHash('sha256');
  let total = 0;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!read) break;
      total += read;
      if (total > MAX_ASSET_BYTES) {
        throw httpError('素材文件超过安全大小上限', 413, 'asset_too_large');
      }
      hash.update(buffer.subarray(0, read));
    }
    const result = { digest: hash.digest('hex'), bytes: total };
    if (keepOpen) {
      result.descriptor = descriptor;
      retained = true;
    }
    return result;
  } finally {
    if (!retained) {
      try {
        if (descriptor != null) fs.closeSync(descriptor);
      } catch {}
    }
  }
}

function safeAssetMimeType(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) {
    return 'application/octet-stream';
  }
  // Keep the value suitable for a Node response header.  Unknown but
  // syntactically harmless media types are still useful to clients.
  if (
    !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+*-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+*-]*(?:\s*;\s*[A-Za-z0-9_-]+=[^\r\n;]+)*$/.test(
      text,
    )
  ) {
    return 'application/octet-stream';
  }
  return text;
}

/**
 * Resolve and integrity-check one immutable run asset without returning the
 * host path in the serialisable result.  The non-enumerable file descriptor
 * is an internal hand-off for server.cjs to stream after this read-only DB
 * scope is closed.  Keeping the descriptor opened during verification also
 * prevents a path replacement between hashing and HTTP streaming.
 */
function readRunAsset(dbPath, runId, contentSha256, options = {}) {
  const suppliedHash = typeof contentSha256 === 'string' ? contentSha256.trim() : String(contentSha256 ?? '').trim();
  if (!ASSET_SHA256.test(suppliedHash)) {
    throw httpError('contentSha256 必须是 64 位十六进制 SHA-256');
  }
  const digest = suppliedHash.toLowerCase();
  const requestedTextbookId = optionalExternalId(options?.textbookExternalId, 'textbookExternalId');
  const dataDir = options?.dataDir;

  const db = openReadOnly(dbPath);
  if (!db) throw httpError('collector SQLite 不存在', 503, 'snapshot_unavailable');
  try {
    const run = resolveContentRun(db, runId);
    assertSnapshotTables(db, { all: true });
    assertApplyableSnapshotRun(db, run, { sealedForImport: options.sealedForImport === true });
    const { textbookExternalId } = resolveSnapshotTextbook(db, run, requestedTextbookId);
    const hashValues = digest === digest.toUpperCase() ? [digest] : [digest, digest.toUpperCase()];
    const assetIndexes = new Set(
      db
        .prepare(`PRAGMA index_list("sync_run_question_assets")`)
        .all()
        .map((index) => String(index.name)),
    );
    // The composite index is installed by ensureRunSnapshotSchema.  Keep the
    // fallback for callers reading a legacy DB directly, while making the
    // production path deterministic even when SQLite's cost estimates prefer
    // the asset identity index because of the ORDER BY clause.
    const assetIndexHint = assetIndexes.has('idx_sync_run_question_assets_scope_hash')
      ? ' INDEXED BY idx_sync_run_question_assets_scope_hash'
      : '';
    const row = db
      .prepare(
        `
      SELECT question_external_id, asset_key, asset_type, source_url,
             content_sha256, storage_path, mime_type, byte_size,
             ${tableColumns(db, 'sync_run_question_assets').has('observed_at') ? 'observed_at' : 'NULL'} AS observed_at
      FROM sync_run_question_assets${assetIndexHint}
      WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
        AND content_sha256 IN (${hashValues.map(() => '?').join(', ')})
      ORDER BY question_external_id ASC, asset_key ASC, storage_path ASC
      LIMIT 1
    `,
      )
      .get(run.id, PROVIDER, textbookExternalId, ...hashValues);
    if (!row) {
      throw httpError('指定素材不存在', 404, 'asset_not_found');
    }

    const declaredSize = row.byte_size == null || row.byte_size === '' ? null : Number(row.byte_size);
    if (declaredSize != null && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) {
      throw httpError('素材大小元数据无效', 409, 'asset_unavailable');
    }
    if (declaredSize != null && declaredSize > MAX_ASSET_BYTES) {
      throw httpError('素材文件超过安全大小上限', 413, 'asset_too_large');
    }
    const resolved = resolveAssetFile(dataDir, row.storage_path);
    if (resolved.stat.size > MAX_ASSET_BYTES) {
      throw httpError('素材文件超过安全大小上限', 413, 'asset_too_large');
    }
    const beforeSize = resolved.stat.size;
    let checked;
    let verifiedDescriptor = null;
    try {
      checked = sha256File(resolved.path, { keepOpen: true });
      verifiedDescriptor = checked.descriptor;
      const after = fs.fstatSync(verifiedDescriptor);
      if (after.size !== beforeSize || checked.bytes !== beforeSize) {
        throw httpError('素材文件在读取期间发生变化', 409, 'asset_integrity_error');
      }
      if (checked.digest.toLowerCase() !== digest) {
        throw httpError('素材文件内容摘要不匹配', 409, 'asset_integrity_error');
      }
    } catch (error) {
      try {
        if (verifiedDescriptor != null) fs.closeSync(verifiedDescriptor);
      } catch {}
      if (error?.statusCode) throw error;
      throw httpError('素材文件不可用', 404, 'asset_not_found');
    }

    const result = {
      available: true,
      immutable: true,
      run: {
        ...run,
        id: run.id,
        runId: run.id,
        collectorRunId: run.id,
        provider: PROVIDER,
        textbookExternalId,
        textbookExternalIds: [textbookExternalId],
        snapshotComplete: run.snapshotComplete,
        snapshot_complete: run.snapshotComplete ? 1 : 0,
        snapshotLockedAt: run.snapshotLockedAt,
        snapshot_locked_at: run.snapshotLockedAt,
      },
      asset: {
        sourceProvider: PROVIDER,
        externalTextbookId: textbookExternalId,
        externalQuestionId: String(row.question_external_id || ''),
        assetKey: String(row.asset_key || ''),
        assetType: row.asset_type == null ? null : String(row.asset_type),
        sourceUrl: row.source_url == null ? null : boundedString(row.source_url, 10000),
        contentSha256: digest,
        mimeType: safeAssetMimeType(row.mime_type),
        byteSize: beforeSize,
        observedAt: row.observed_at == null ? null : boundedString(row.observed_at, 80),
      },
      contentType: safeAssetMimeType(row.mime_type),
      contentLength: beforeSize,
      etag: `"${digest}"`,
      cacheControl: 'public, max-age=31536000, immutable',
    };
    Object.defineProperty(result, 'filePath', {
      value: resolved.path,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(result, 'fileDescriptor', {
      value: verifiedDescriptor,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return result;
  } finally {
    db.close();
  }
}

/**
 * Read one complete, immutable content-run scope.  Every returned array is
 * selected solely from its run-id/textbook-id rows; no global mutable table is
 * consulted, so later crawls cannot change an already sealed apply payload.
 */
module.exports = {
  isAbsoluteStoragePath,
  resolveAssetFile,
  sha256File,
  safeAssetMimeType,
  readRunAsset,
};
