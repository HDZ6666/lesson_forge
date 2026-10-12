'use strict';

/**
 * MetadataStore: SQLite persistence for version / textbook discovery, plus
 * the read helpers and report formatting used by the CLI and API.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { ensureDir, isStableExternalId, normalizeWhitespace, nowIso, writeFileAtomic } = require('../shared/utils.cjs');
const { PROVIDER } = require('../sources/zujuan/constants.cjs');
const { classifyChange, emptyValidation, textbookRawJson } = require('../sources/zujuan/metadata_parser.cjs');
const { migrateMetadataSnapshotSchema } = require('./metadata_schema.cjs');

class MetadataStore {
  constructor(dbPath) {
    ensureDir(path.dirname(dbPath));
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.prepare();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_textbook_versions (
        provider TEXT NOT NULL,
        external_version_id TEXT NOT NULL,
        version_name TEXT NOT NULL,
        source_url TEXT,
        is_new TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '0',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (provider, external_version_id)
      );

      CREATE TABLE IF NOT EXISTS source_textbooks (
        provider TEXT NOT NULL,
        external_textbook_id TEXT NOT NULL,
        version_external_id TEXT NOT NULL,
        textbook_name TEXT NOT NULL,
        grade TEXT,
        volume TEXT,
        source_url TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '0',
        bootstrap_chapter_external_id TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (provider, external_textbook_id),
        FOREIGN KEY (provider, version_external_id)
          REFERENCES source_textbook_versions (provider, external_version_id)
      );

      CREATE TABLE IF NOT EXISTS source_metadata_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        seed_url TEXT,
        version_count INTEGER NOT NULL DEFAULT 0,
        textbook_count INTEGER NOT NULL DEFAULT 0,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        message TEXT,
        report_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_source_textbooks_version
        ON source_textbooks (provider, version_external_id);
    `);
    migrateMetadataSnapshotSchema(this.db);
  }

  prepare() {
    this.stmt = {
      insertRun: this.db.prepare(`
        INSERT INTO source_metadata_runs (provider, started_at, status, seed_url)
        VALUES (?, ?, 'running', ?)
      `),
      finishRun: this.db.prepare(`
        UPDATE source_metadata_runs
        SET finished_at = ?, status = ?, version_count = ?, textbook_count = ?,
            inserted_count = ?, updated_count = ?, unchanged_count = ?,
            error_count = ?, message = ?, report_json = ?, snapshot_locked_at = ?
        WHERE id = ? AND status = 'running' AND snapshot_locked_at IS NULL
      `),
      getVersion: this.db.prepare(`
        SELECT * FROM source_textbook_versions
        WHERE provider = ? AND external_version_id = ?
      `),
      getTextbook: this.db.prepare(`
        SELECT * FROM source_textbooks
        WHERE provider = ? AND external_textbook_id = ?
      `),
      upsertVersion: this.db.prepare(`
        INSERT INTO source_textbook_versions (
          provider, external_version_id, version_name, source_url, is_new,
          sort_order, status, first_seen_at, last_seen_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, '0', ?, ?, ?)
        ON CONFLICT (provider, external_version_id) DO UPDATE SET
          version_name = excluded.version_name,
          source_url = excluded.source_url,
          is_new = excluded.is_new,
          sort_order = excluded.sort_order,
          last_seen_at = excluded.last_seen_at,
          raw_json = excluded.raw_json
      `),
      upsertTextbook: this.db.prepare(`
        INSERT INTO source_textbooks (
          provider, external_textbook_id, version_external_id, textbook_name,
          grade, volume, source_url, sort_order, status,
          bootstrap_chapter_external_id, first_seen_at, last_seen_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?, ?, ?)
        ON CONFLICT (provider, external_textbook_id) DO UPDATE SET
          version_external_id = excluded.version_external_id,
          textbook_name = excluded.textbook_name,
          grade = excluded.grade,
          volume = excluded.volume,
          source_url = excluded.source_url,
          sort_order = excluded.sort_order,
          bootstrap_chapter_external_id = COALESCE(
            excluded.bootstrap_chapter_external_id,
            source_textbooks.bootstrap_chapter_external_id
          ),
          last_seen_at = excluded.last_seen_at,
          raw_json = excluded.raw_json
      `),
      insertRunVersion: this.db.prepare(`
        INSERT INTO source_metadata_run_versions (
          run_id, provider, external_version_id, version_name, source_url,
          is_new, sort_order, status, raw_json, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, ?)
      `),
      insertRunTextbook: this.db.prepare(`
        INSERT INTO source_metadata_run_textbooks (
          run_id, provider, external_textbook_id, version_external_id,
          textbook_name, grade, volume, source_url, sort_order, status,
          bootstrap_chapter_external_id, raw_json, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?, ?)
      `),
      listVersions: this.db.prepare(`
        SELECT * FROM source_textbook_versions
        WHERE provider = ?
        ORDER BY sort_order ASC, external_version_id ASC
      `),
      listTextbooks: this.db.prepare(`
        SELECT * FROM source_textbooks
        WHERE provider = ?
        ORDER BY version_external_id ASC, sort_order ASC, external_textbook_id ASC
      `),
      recentRuns: this.db.prepare(`
        SELECT id, started_at, finished_at, status, seed_url, version_count,
               textbook_count, inserted_count, updated_count, unchanged_count,
               error_count, message
        FROM source_metadata_runs
        ORDER BY id DESC
        LIMIT 20
      `),
    };
  }

  beginRun(seedUrl) {
    const result = this.stmt.insertRun.run(PROVIDER, nowIso(), seedUrl || null);
    return Number(result.lastInsertRowid);
  }

  finishRun(runId, status, counters, message, report) {
    const finishedAt = nowIso();
    const result = this.stmt.finishRun.run(
      finishedAt,
      status,
      counters.versionsSeen || 0,
      counters.textbooksSeen || 0,
      counters.inserted || 0,
      counters.updated || 0,
      counters.unchanged || 0,
      counters.errors || 0,
      message || null,
      report ? JSON.stringify(report) : null,
      finishedAt,
      runId,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error(`metadata run ${runId} 已终止或不存在，不能重新写入终态。`);
    }
  }

  getVersion(externalVersionId) {
    return this.stmt.getVersion.get(PROVIDER, String(externalVersionId)) || null;
  }

  getTextbook(externalTextbookId) {
    return this.stmt.getTextbook.get(PROVIDER, String(externalTextbookId)) || null;
  }

  listVersions() {
    return this.stmt.listVersions.all(PROVIDER);
  }

  listTextbooks() {
    return this.stmt.listTextbooks.all(PROVIDER);
  }

  saveVersionGroup(version, textbooks, observedAt, runId = null) {
    const counts = { inserted: 0, updated: 0, unchanged: 0 };
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existingVersion = this.getVersion(version.externalVersionId);
      const versionKind = classifyChange(
        existingVersion,
        {
          version_name: version.versionName,
          source_url: version.sourceUrl,
          is_new: version.isNew,
          sort_order: version.sortOrder,
        },
        ['version_name', 'source_url', 'is_new', 'sort_order'],
      );
      this.stmt.upsertVersion.run(
        PROVIDER,
        String(version.externalVersionId),
        version.versionName,
        version.sourceUrl || null,
        version.isNew,
        version.sortOrder,
        observedAt,
        observedAt,
        JSON.stringify(version.raw || version),
      );
      if (runId != null) {
        this.stmt.insertRunVersion.run(
          Number(runId),
          PROVIDER,
          String(version.externalVersionId),
          version.versionName,
          version.sourceUrl || null,
          version.isNew,
          version.sortOrder,
          JSON.stringify(version.raw || version),
          observedAt,
        );
      }
      counts[versionKind] += 1;

      for (const textbook of textbooks) {
        const existingTextbook = this.getTextbook(textbook.externalTextbookId);
        if (!isStableExternalId(textbook.bootstrapChapterExternalId) && existingTextbook) {
          textbook.bootstrapChapterExternalId = existingTextbook.bootstrap_chapter_external_id || null;
        }
        const textbookKind = classifyChange(
          existingTextbook,
          {
            version_external_id: textbook.versionExternalId,
            textbook_name: textbook.textbookName,
            grade: textbook.grade,
            volume: textbook.volume,
            source_url: textbook.sourceUrl,
            sort_order: textbook.sortOrder,
            bootstrap_chapter_external_id: textbook.bootstrapChapterExternalId,
          },
          [
            'version_external_id',
            'textbook_name',
            'grade',
            'volume',
            'source_url',
            'sort_order',
            'bootstrap_chapter_external_id',
          ],
        );
        this.stmt.upsertTextbook.run(
          PROVIDER,
          String(textbook.externalTextbookId),
          String(textbook.versionExternalId),
          textbook.textbookName,
          textbook.grade,
          textbook.volume,
          textbook.sourceUrl || null,
          textbook.sortOrder,
          textbook.bootstrapChapterExternalId || null,
          observedAt,
          observedAt,
          textbookRawJson(textbook),
        );
        if (runId != null) {
          this.stmt.insertRunTextbook.run(
            Number(runId),
            PROVIDER,
            String(textbook.externalTextbookId),
            String(textbook.versionExternalId),
            textbook.textbookName,
            textbook.grade,
            textbook.volume,
            textbook.sourceUrl || null,
            textbook.sortOrder,
            textbook.bootstrapChapterExternalId || null,
            textbookRawJson(textbook),
            observedAt,
          );
        }
        counts[textbookKind] += 1;
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      throw error;
    }
    return counts;
  }

  unseenCandidates(seenVersionIds, seenTextbookIds) {
    const versions = this.listVersions()
      .filter((row) => !seenVersionIds.has(String(row.external_version_id)))
      .map((row) => ({
        externalVersionId: row.external_version_id,
        versionName: row.version_name,
      }));
    const textbooks = this.listTextbooks()
      .filter((row) => !seenTextbookIds.has(String(row.external_textbook_id)))
      .map((row) => ({
        externalTextbookId: row.external_textbook_id,
        textbookName: row.textbook_name,
        versionExternalId: row.version_external_id,
      }));
    return { versions, textbooks };
  }

  status() {
    return {
      versions: this.listVersions(),
      textbooks: this.listTextbooks(),
      recentRuns: this.stmt.recentRuns.all(),
    };
  }

  close() {
    this.db.close();
  }
}

function pickExactByName(items, name, { nameKey, label }) {
  const wanted = normalizeWhitespace(name);
  const matched = (items || []).filter((item) => normalizeWhitespace(item[nameKey] || '') === wanted);
  if (matched.length === 1) return matched[0];
  if (matched.length > 1) {
    throw new Error(`${label}「${wanted}」匹配到 ${matched.length} 条，拒绝合并。`);
  }
  const available = [...new Set((items || []).map((item) => item[nameKey]).filter(Boolean))];
  throw new Error(`未找到${label}「${wanted}」。当前可见：${available.join('、') || '（空）'}`);
}

function lookupTextbookByNames(dbPath, versionName, textbookName, { provider = PROVIDER } = {}) {
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const table = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_textbooks'`).get();
    if (!table) return null;
    const row = db
      .prepare(
        `
      SELECT t.external_textbook_id, t.textbook_name, t.bootstrap_chapter_external_id, t.source_url,
             v.external_version_id, v.version_name
      FROM source_textbooks t
      JOIN source_textbook_versions v
        ON v.provider = t.provider AND v.external_version_id = t.version_external_id
      WHERE t.provider = ? AND v.version_name = ? AND t.textbook_name = ?
    `,
      )
      .get(provider, normalizeWhitespace(versionName), normalizeWhitespace(textbookName));
    if (!row) return null;
    const bootstrap = row.bootstrap_chapter_external_id == null ? '' : String(row.bootstrap_chapter_external_id).trim();
    if (!isStableExternalId(bootstrap) || !isStableExternalId(row.external_textbook_id)) return null;
    return {
      externalTextbookId: String(row.external_textbook_id),
      textbookName: row.textbook_name,
      bootstrapChapterExternalId: bootstrap,
      sourceUrl: row.source_url,
      externalVersionId: String(row.external_version_id),
      versionName: row.version_name,
    };
  } finally {
    db.close();
  }
}

function lookupBootstrapChapter(dbPath, textbookId, { provider = PROVIDER, allowMissing = false } = {}) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`采集库不存在：${dbPath}。请先运行 npm run sync:zujuan:metadata`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_textbooks'`).get();
    if (!table) {
      if (allowMissing) return null;
      throw new Error('采集库缺少 source_textbooks 表。请先运行 npm run sync:zujuan:metadata');
    }
    const row = db
      .prepare(
        `SELECT textbook_name, bootstrap_chapter_external_id
       FROM source_textbooks
       WHERE provider = ? AND external_textbook_id = ?`,
      )
      .get(provider, String(textbookId));
    if (!row) {
      if (allowMissing) return null;
      throw new Error(`采集库中没有教材 ${textbookId} 的元数据。请先运行 npm run sync:zujuan:metadata`);
    }
    const bootstrap = row.bootstrap_chapter_external_id == null ? '' : String(row.bootstrap_chapter_external_id).trim();
    if (!isStableExternalId(bootstrap)) {
      if (allowMissing) return null;
      throw new Error(
        `教材 ${textbookId}（${row.textbook_name || '未命名'}）缺少可用的入口章节 ID，无法构造同步入口。`,
      );
    }
    return String(bootstrap);
  } finally {
    db.close();
  }
}

function buildReport(store, extras = {}) {
  const versions = store.listVersions();
  const textbooks = store.listTextbooks();
  const countByVersion = new Map();
  for (const textbook of textbooks) {
    const key = String(textbook.version_external_id);
    countByVersion.set(key, (countByVersion.get(key) || 0) + 1);
  }
  return {
    provider: PROVIDER,
    versionCount: versions.length,
    textbookCount: textbooks.length,
    versions: versions.map((version) => ({
      externalVersionId: version.external_version_id,
      versionName: version.version_name,
      isNew: version.is_new,
      textbookCount: countByVersion.get(String(version.external_version_id)) || 0,
    })),
    validation: extras.validation || emptyValidation(),
    counts: extras.counts || null,
    unseen: extras.unseen || null,
  };
}

function formatReport(report) {
  const lines = [`版本总数：${report.versionCount}`, `教材总数：${report.textbookCount}`, '按版本：'];
  if (report.versions.length === 0) {
    lines.push('  （无）');
  } else {
    for (const version of report.versions) {
      lines.push(
        `  ${version.versionName} (${version.externalVersionId})  is_new=${version.isNew ?? 'NULL'}  教材数=${version.textbookCount}`,
      );
    }
  }
  const validation = report.validation || emptyValidation();
  lines.push('校验：');
  lines.push(`  缺失来源 ID：${validation.missingIds.length}`);
  lines.push(`  重复来源 ID：${validation.duplicateIds.length}`);
  lines.push(`  缺少入口章节 ID 的教材：${validation.missingBootstrapChapters.length}`);
  if (report.counts) {
    lines.push(
      `本次：新增 ${report.counts.inserted} / 更新 ${report.counts.updated} / 未变化 ${report.counts.unchanged}`,
    );
  }
  if (report.unseen) {
    lines.push(`本次未发现候选：版本 ${report.unseen.versions.length}，教材 ${report.unseen.textbooks.length}`);
  }
  return lines.join('\n');
}

function writeJsonOutput(filePath, report) {
  if (!filePath) return;
  writeFileAtomic(filePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[输出] JSON 已写入 ${filePath}`);
}

module.exports = {
  MetadataStore,
  buildReport,
  formatReport,
  lookupBootstrapChapter,
  lookupTextbookByNames,
  pickExactByName,
  writeJsonOutput,
};
