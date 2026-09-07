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

function resolveMetadataRun(db, metadataRunId = null) {
  const tables = tableNames(db);
  if (!tables.has('source_metadata_runs')) return null;
  const columns = tableColumns(db, 'source_metadata_runs');
  const hasProvider = columns.has('provider');
  const lock = columns.has('snapshot_locked_at')
    ? ', snapshot_locked_at AS snapshotLockedAt'
    : '';
  const selected = hasProvider
    ? `id, provider, started_at, finished_at, status, version_count, textbook_count${lock}`
    : `id, started_at, finished_at, status, version_count, textbook_count${lock}`;
  let run;
  if (metadataRunId == null) {
    run = hasProvider
      ? db.prepare(`
          SELECT ${selected} FROM source_metadata_runs
          WHERE provider = ? AND status = 'success' AND finished_at IS NOT NULL
          ORDER BY id DESC LIMIT 1
        `).get(PROVIDER)
      : db.prepare(`
          SELECT ${selected} FROM source_metadata_runs
          WHERE status = 'success' AND finished_at IS NOT NULL
          ORDER BY id DESC LIMIT 1
        `).get();
  } else {
    run = db.prepare(`SELECT ${selected} FROM source_metadata_runs WHERE id = ?`).get(Number(metadataRunId));
  }
  if (!run) {
    if (metadataRunId == null) return null;
    throw new Error(`元数据运行 ${metadataRunId} 不存在`);
  }
  if (hasProvider && String(run.provider || '') !== PROVIDER) {
    throw new Error(`元数据运行 ${run.id} 来源不受支持`);
  }
  if (String(run.status || '') !== 'success' || !run.finished_at) {
    throw new Error(`元数据运行 ${run.id} 未成功完成`);
  }
  if (!run.started_at) throw new Error(`元数据运行 ${run.id} 缺少有效时间窗口`);
  return { ...run, id: Number(run.id) };
}

function readCandidateRowsFromDb(db, entityType, {
  provider = null,
  textbookExternalId = null,
  timeWindow = null,
} = {}) {
  const entity = ENTITIES[entityType];
  if (!entity) throw new Error('不支持的同步实体类型');
  const tables = tableNames(db);
  if (!tables.has(entity.table)) {
    return { available: false, message: `collector SQLite 缺少表：${entity.table}`, rows: [] };
  }
  const columns = tableColumns(db, entity.table);
  const missing = ['provider', entity.idColumn].filter((column) => !columns.has(column));
  if (missing.length) {
    return {
      available: false,
      message: `collector 表 ${entity.table} 缺少字段：${missing.join(', ')}`,
      rows: [],
    };
  }
  const selected = entity.columns
    .filter((column) => columns.has(column))
    .map((column) => (
      entityType === 'question' && column === 'plain_text'
        ? 'substr("plain_text", 1, 360) AS "plain_text"'
        : `"${column}"`
    ));
  const predicates = [];
  const parameters = [];
  if (provider) {
    predicates.push('"provider" = ?');
    parameters.push(String(provider));
  }
  if (timeWindow) {
    if (!columns.has('last_seen_at')) {
      return {
        available: false,
        message: `collector 表 ${entity.table} 缺少 last_seen_at，无法绑定元数据运行`,
        rows: [],
      };
    }
    predicates.push('"last_seen_at" >= ? AND "last_seen_at" <= ?');
    parameters.push(String(timeWindow[0]), String(timeWindow[1]));
  }
  if (entityType === 'catalog' && textbookExternalId) {
    predicates.push('"textbook_external_id" = ?');
    parameters.push(String(textbookExternalId));
  }
  if (entityType === 'question' && textbookExternalId) {
    if (!tables.has('question_catalog_memberships') || !tables.has('textbook_nodes')) {
      return {
        available: false,
        message: 'collector SQLite 缺少题目目录关系表，无法按教材过滤题目',
        rows: [],
      };
    }
    predicates.push(`EXISTS (
      SELECT 1 FROM "question_catalog_memberships" AS qcm
      JOIN "textbook_nodes" AS tn
        ON tn."provider" = qcm."provider"
       AND tn."external_id" = qcm."catalog_external_id"
      WHERE qcm."provider" = "${entity.table}"."provider"
        AND qcm."question_external_id" = "${entity.table}"."external_id"
        AND tn."textbook_external_id" = ?
    )`);
    parameters.push(String(textbookExternalId));
  }
  let sql = `SELECT ${selected.join(', ')} FROM "${entity.table}"`;
  if (predicates.length) sql += ` WHERE ${predicates.join(' AND ')}`;
  sql += ` ORDER BY "provider" ASC, "${entity.idColumn}" ASC LIMIT ${MAX_CANDIDATE_ROWS}`;
  return {
    available: true,
    message: 'collector SQLite 可用',
    rows: db.prepare(sql).all(...parameters),
  };
}

function readMetadataRunRowsFromDb(db, entityType, run, { provider = PROVIDER } = {}) {
  const definition = {
    version: {
      table: 'source_metadata_run_versions',
      idColumn: 'external_version_id',
      columns: [
        'provider', 'external_version_id', 'version_name', 'source_url', 'is_new',
        'sort_order', 'status', 'raw_json', 'captured_at',
      ],
      expectedCount: Number(run?.version_count || 0),
    },
    textbook: {
      table: 'source_metadata_run_textbooks',
      idColumn: 'external_textbook_id',
      columns: [
        'provider', 'external_textbook_id', 'version_external_id', 'textbook_name',
        'grade', 'volume', 'source_url', 'sort_order', 'status',
        'bootstrap_chapter_external_id', 'raw_json', 'captured_at',
      ],
      expectedCount: Number(run?.textbook_count || 0),
    },
  }[entityType];
  if (!definition || !tableNames(db).has(definition.table)) return null;
  const columns = tableColumns(db, definition.table);
  const required = ['run_id', 'provider', definition.idColumn];
  if (required.some((column) => !columns.has(column))) return null;
  const selected = definition.columns
    .filter((column) => columns.has(column))
    .map((column) => `"${column}"`);
  if (columns.has('captured_at')) {
    selected.push('"captured_at" AS "first_seen_at"', '"captured_at" AS "last_seen_at"');
  }
  const rows = db.prepare(`
    SELECT ${selected.join(', ')}
    FROM "${definition.table}"
    WHERE run_id = ? AND provider = ?
    ORDER BY sort_order ASC, "${definition.idColumn}" ASC
    LIMIT ${MAX_CANDIDATE_ROWS}
  `).all(Number(run.id), String(provider || PROVIDER));
  // Databases created before immutable metadata snapshots existed are
  // backfilled on collector startup.  If a caller opens such a database
  // directly and the backfill has not run yet, fall back to the legacy time
  // window below instead of returning a false empty snapshot.
  if (!rows.length && definition.expectedCount > 0) return null;
  return {
    available: true,
    message: 'collector 元数据运行快照可用',
    rows,
    immutable: true,
  };
}

function readCandidates(dbPath, entityType, options = {}) {
  const db = openReadOnly(dbPath);
  if (!db) return { available: false, message: 'collector SQLite 不存在', rows: [], run: null };
  try {
    if (entityType === 'version' || entityType === 'textbook') {
      const tables = tableNames(db);
      if (!tables.has('source_metadata_runs')) {
        if (options.metadataRunId != null) throw new Error('采集库缺少 source_metadata_runs 表，不能验证 metadataRunId');
        return { ...readCandidateRowsFromDb(db, entityType, options), run: null };
      }
      const run = resolveMetadataRun(db, options.metadataRunId ?? null);
      if (!run) return { available: false, message: 'collector SQLite 没有成功的元数据运行', rows: [], run: null };
      const snapshot = readMetadataRunRowsFromDb(db, entityType, run, {
        provider: options.provider || PROVIDER,
      });
      if (snapshot) return { ...snapshot, run };
      return {
        ...readCandidateRowsFromDb(db, entityType, {
          ...options,
          provider: options.provider || PROVIDER,
          timeWindow: [run.started_at, run.finished_at],
        }),
        run,
      };
    }
    return { ...readCandidateRowsFromDb(db, entityType, options), run: null };
  } finally {
    db.close();
  }
}

function readMetadataSnapshot(dbPath, metadataRunId = null) {
  const db = openReadOnly(dbPath);
  if (!db) {
    return {
      available: false,
      message: 'collector SQLite 不存在',
      run: null,
      versions: [],
      textbooks: [],
    };
  }
  try {
    const run = resolveMetadataRun(db, metadataRunId);
    if (!run) {
      return {
        available: false,
        message: 'collector SQLite 没有成功的元数据运行',
        run: null,
        versions: [],
        textbooks: [],
      };
    }
    const options = { provider: PROVIDER, timeWindow: [run.started_at, run.finished_at] };
    const versions = readMetadataRunRowsFromDb(db, 'version', run, options)
      || readCandidateRowsFromDb(db, 'version', options);
    const textbooks = readMetadataRunRowsFromDb(db, 'textbook', run, options)
      || readCandidateRowsFromDb(db, 'textbook', options);
    return {
      available: versions.available && textbooks.available,
      message: [versions.message, textbooks.message].filter(Boolean).join('；'),
      run,
      versions: versions.rows,
      textbooks: textbooks.rows,
      immutable: versions.immutable === true && textbooks.immutable === true,
    };
  } finally {
    db.close();
  }
}

function validateMetadataSelection(dbPath, metadataRunId, selectedIds) {
  if (!Array.isArray(selectedIds)) throw new Error('教材选择列表必须是数组');
  const requested = selectedIds.map((value) => String(value || '').trim());
  if (!requested.length || requested.length > MAX_SELECTED_TEXTBOOKS) {
    throw new Error(`教材选择数量必须在 1 到 ${MAX_SELECTED_TEXTBOOKS} 之间`);
  }
  if (new Set(requested).size !== requested.length) throw new Error('教材选择列表不能包含重复 ID');
  if (requested.some((value) => !safeExternalId(value))) throw new Error('教材来源 ID 不安全');
  const db = openReadOnly(dbPath);
  if (!db) throw new Error('collector SQLite 不存在，请先完成版本和教材同步');
  try {
    const run = resolveMetadataRun(db, metadataRunId);
    if (!run) throw new Error(`元数据运行 ${metadataRunId} 不存在`);
    const snapshot = readMetadataRunRowsFromDb(db, 'textbook', run, { provider: PROVIDER });
    const tables = tableNames(db);
    let rows;
    if (snapshot) {
      rows = snapshot.rows.filter((row) => String(row.status ?? '0') !== '1');
    } else {
      if (!tables.has('source_textbooks')) throw new Error('collector SQLite 缺少 source_textbooks 表');
      rows = db.prepare(`
        SELECT provider, external_textbook_id, textbook_name,
               version_external_id, bootstrap_chapter_external_id
        FROM source_textbooks
        WHERE provider = ?
          AND COALESCE(status, '0') <> '1'
          AND last_seen_at >= ? AND last_seen_at <= ?
        ORDER BY version_external_id ASC, sort_order ASC, external_textbook_id ASC
      `).all(PROVIDER, run.started_at, run.finished_at);
    }
    const byId = new Map(rows.map((row) => [String(row.external_textbook_id || '').trim(), row]));
    const unknown = requested.filter((value) => !byId.has(value));
    if (unknown.length) throw new Error(`教材不属于元数据运行 ${metadataRunId} 的快照：${unknown.slice(0, 5).join(', ')}`);
    const textbooks = requested.map((value) => {
      const row = byId.get(value);
      const bootstrap = String(row.bootstrap_chapter_external_id || '').trim();
      if (!safeExternalId(bootstrap)) throw new Error(`教材 ${value} 缺少真实入口章节，不能同步题库`);
      return {
        externalTextbookId: value,
        textbookName: String(row.textbook_name || '').trim() || value,
        versionExternalId: String(row.version_external_id || '').trim() || null,
        bootstrapChapterExternalId: bootstrap,
      };
    });
    return { run, textbooks };
  } finally {
    db.close();
  }
}

module.exports = {
  resolveMetadataRun,
  readCandidateRowsFromDb,
  readMetadataRunRowsFromDb,
  readCandidates,
  readMetadataSnapshot,
  validateMetadataSelection,
};
