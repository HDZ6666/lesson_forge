'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const {
  ensureRunSnapshotSchema,
  TERMINAL_RUN_STATUSES,
} = require('../lib/run_snapshots.cjs');
const { resolveContentRun, snapshotScopeIds } = require('../src/storage/readers/common.cjs');
const {
  readRunCatalogs,
  readMetadataSnapshot,
  readRunSnapshot,
  readRunQuestion,
  readRunQuestions,
  readRunSnapshotSummary,
  validateMetadataSelection,
} = require('../lib/api_store.cjs');
const { CollectorJobManager, createCollectorServer } = require('../server.cjs');
const { MetadataStore } = require('../zujuan_metadata_sync.cjs');
const { SyncStore } = require('../legacy/zujuan_sync.cjs');

function temporaryDb(prefix = 'collector-snapshot-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory,
    dbPath: path.join(directory, 'collector.sqlite3'),
  };
}

function seedRun(dbPath, {
  status = 'success',
  scope = { textbookId: 'tb1' },
  textbookIds = ['tb1'],
  duplicateQuestion = false,
} = {}) {
  const store = new SyncStore(dbPath);
  const runId = store.beginRun(scope);
  for (const textbookId of textbookIds) {
    const catalogId = `${textbookId}-c1`;
    const questionId = duplicateQuestion ? 'q-shared' : `${textbookId}-q1`;
    store.saveRunCatalogTree(runId, textbookId, [{
      externalId: catalogId,
      parentExternalId: null,
      level: 1,
      type: 'chapter',
      name: `${textbookId} 第一章`,
      path: `/${catalogId}`,
      sortOrder: 1,
    }]);
    store.saveRunQuestion(runId, textbookId, {
      externalId: questionId,
      detailUrl: `https://zujuan.xkw.com/${questionId}`,
      sourceTitle: `${textbookId} 试题`,
      questionType: '单选题',
      questionTypeId: '1101',
      contentHtml: `<p>${textbookId} 题干</p>`,
      plainText: `${textbookId} 题干`,
      detailFetched: true,
      solutionHtml: '<p>解析</p>',
      rawData: { externalId: questionId },
      contentHash: `hash-${textbookId}`,
      listContentHash: `list-${textbookId}`,
      detailContentHash: `detail-${textbookId}`,
    }, catalogId);
    store.saveRunQuestionCatalogs(runId, textbookId, questionId, [{
      externalId: catalogId,
      level: 1,
      name: `${textbookId} 第一章`,
      path: `/${catalogId}`,
    }]);
  }
  store.finishRun(runId, status, {
    pagesOk: 3,
    questionsSeen: textbookIds.length,
    questionsInserted: textbookIds.length,
    questionsUpdated: 0,
    detailsFetched: textbookIds.length,
    assetsDownloaded: 0,
    errors: status === 'success' ? 0 : 1,
  }, status === 'success' ? null : '采集失败');
  store.close();
  return runId;
}

test('summary scope check finds row scopes omitted from the run declaration', () => {
  const { directory, dbPath } = temporaryDb('collector-scope-edges-');
  try {
    const runId = seedRun(dbPath, {
      scope: { textbookId: 'tb1' },
      textbookIds: ['tb1', 'tb2'],
    });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const run = resolveContentRun(db, runId);
      assert.deepEqual([...snapshotScopeIds(db, run)].sort(), ['tb1', 'tb2']);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function seedMetadata(dbPath, textbookIds = ['tb1', 'tb2']) {
  const store = new MetadataStore(dbPath);
  const runId = store.beginRun('https://zujuan.xkw.com/');
  const observedAt = new Date().toISOString();
  store.saveVersionGroup({
    externalVersionId: 'v1',
    versionName: '测试版',
    sourceUrl: 'https://zujuan.xkw.com/v1',
    isNew: 'N',
    sortOrder: 1,
    raw: {},
  }, textbookIds.map((externalTextbookId, index) => ({
    externalTextbookId,
    versionExternalId: 'v1',
    textbookName: `教材 ${externalTextbookId}`,
    grade: '九年级',
    volume: '上册',
    sourceUrl: `https://zujuan.xkw.com/${externalTextbookId}`,
    sortOrder: index + 1,
    bootstrapChapterExternalId: `${externalTextbookId}-c1`,
    raw: {},
  })), observedAt, runId);
  store.finishRun(runId, 'success', {
    versionsSeen: 1,
    textbooksSeen: textbookIds.length,
    inserted: textbookIds.length + 1,
    updated: 0,
    unchanged: 0,
    errors: 0,
  }, null, null);
  store.close();
  return runId;
}

test('连续元数据运行保留各自不可变的版本和教材快照', () => {
  const { directory, dbPath } = temporaryDb('collector-metadata-snapshot-');
  const store = new MetadataStore(dbPath);
  const save = (runId, versionName, textbookName, observedAt) => {
    store.saveVersionGroup({
      externalVersionId: 'v1',
      versionName,
      sourceUrl: 'https://zujuan.xkw.com/v1',
      isNew: 'N',
      sortOrder: 1,
      raw: { versionName },
    }, [{
      externalTextbookId: 'tb1',
      versionExternalId: 'v1',
      textbookName,
      grade: '九年级',
      volume: '上册',
      sourceUrl: 'https://zujuan.xkw.com/tb1',
      sortOrder: 1,
      bootstrapChapterExternalId: 'c1',
      raw: { textbookName },
    }], observedAt, runId);
  };
  const counters = {
    versionsSeen: 1,
    textbooksSeen: 1,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
  };
  try {
    const firstRunId = store.beginRun('https://zujuan.xkw.com/first');
    save(firstRunId, '旧版本名', '旧教材名', '2026-08-27T01:00:00.000Z');
    store.finishRun(firstRunId, 'success', counters, null, null);

    const secondRunId = store.beginRun('https://zujuan.xkw.com/second');
    save(secondRunId, '新版本名', '新教材名', '2026-08-28T01:00:00.000Z');
    store.finishRun(secondRunId, 'success', counters, null, null);

    const first = readMetadataSnapshot(dbPath, firstRunId);
    const second = readMetadataSnapshot(dbPath, secondRunId);
    assert.equal(first.versions[0].version_name, '旧版本名');
    assert.equal(first.textbooks[0].textbook_name, '旧教材名');
    assert.equal(second.versions[0].version_name, '新版本名');
    assert.equal(second.textbooks[0].textbook_name, '新教材名');
    assert.equal(first.immutable, true);
    assert.equal(validateMetadataSelection(dbPath, firstRunId, ['tb1']).textbooks[0].textbookName, '旧教材名');

    assert.throws(
      () => store.db.prepare(`
        UPDATE source_metadata_run_textbooks SET textbook_name = '篡改'
        WHERE run_id = ? AND external_textbook_id = 'tb1'
      `).run(firstRunId),
      /immutable/i,
    );
    assert.throws(
      () => store.db.prepare("UPDATE source_metadata_runs SET status = 'running' WHERE id = ?").run(firstRunId),
      /immutable/i,
    );
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function seedChildRun(dbPath, textbookId, status = 'success', { finish = true } = {}) {
  const store = new SyncStore(dbPath);
  const runId = store.beginRun({ textbookId });
  const catalogId = `${textbookId}-c1`;
  const questionId = `${textbookId}-q1`;
  store.saveRunCatalogTree(runId, textbookId, [{
    externalId: catalogId,
    level: 1,
    name: `目录 ${textbookId}`,
    path: `/${catalogId}`,
  }]);
  store.saveRunQuestion(runId, textbookId, {
    externalId: questionId,
    questionType: '单选题',
    contentHtml: `<p>${textbookId}</p>`,
    plainText: textbookId,
  }, catalogId);
  store.saveRunQuestionCatalogs(runId, textbookId, questionId, [{
    externalId: catalogId,
    level: 1,
    name: `目录 ${textbookId}`,
    path: `/${catalogId}`,
  }]);
  if (finish) {
    store.finishRun(runId, status, {
      pagesOk: 2,
      questionsSeen: 1,
      questionsInserted: 1,
      errors: status === 'success' ? 0 : 1,
    }, status === 'success' ? null : `教材 ${textbookId} 采集失败`);
  }
  store.close();
  return runId;
}

function fakeChild(runId, exitCode = 0, { autoClose = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  // Use a non-existent process-group ID.  The manager's cancellation signal
  // path is exercised without ever touching this test runner's process group.
  child.pid = 2147483647;
  child.kill = () => true;
  if (autoClose) {
    queueMicrotask(() => {
      child.stdout.end(`[启动] run=${runId}\n`);
      child.stderr.end();
      child.emit('close', exitCode, null);
    });
  }
  return child;
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('等待采集任务状态超时');
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('运行快照 schema 可从旧库增量升级，重复升级安全且终态旧行会被锁定', () => {
  const { directory, dbPath } = temporaryDb('collector-snapshot-migration-');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT,
        finished_at TEXT,
        status TEXT,
        scope_json TEXT
      );
      CREATE TABLE sync_run_catalog_items (
        run_id INTEGER,
        provider TEXT,
        textbook_external_id TEXT,
        catalog_external_id TEXT,
        name TEXT
      );
      CREATE TABLE sync_run_question_items (
        run_id INTEGER,
        provider TEXT,
        textbook_external_id TEXT,
        question_external_id TEXT,
        content_html TEXT,
        plain_text TEXT,
        question_type TEXT
      );
      CREATE TABLE sync_run_question_catalogs (
        run_id INTEGER,
        provider TEXT,
        textbook_external_id TEXT,
        question_external_id TEXT,
        catalog_external_id TEXT
      );
      INSERT INTO sync_runs (started_at, status, scope_json)
      VALUES ('2026-08-28T00:00:00Z', 'completed', '{"textbookId":"tb-old"}');
      INSERT INTO sync_run_catalog_items
        (run_id, provider, textbook_external_id, catalog_external_id, name)
      VALUES (1, 'zujuan', 'tb-old', 'c-old', '旧目录');
      INSERT INTO sync_runs (started_at, status, scope_json)
      VALUES ('2026-08-28T00:01:00Z', 'running', '{"textbookId":"tb-live"}');
    `);
    db.close();

    ensureRunSnapshotSchema(dbPath);
    ensureRunSnapshotSchema(dbPath);

    const upgraded = new DatabaseSync(dbPath);
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version & 6, 6);
    assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_sync_run_question_items_preview_types'").get());
    const run = upgraded.prepare(
      'SELECT status, snapshot_locked_at FROM sync_runs WHERE id = 1',
    ).get();
    assert.equal(run.status, 'completed');
    assert.ok(run.snapshot_locked_at, '旧终态即使没有 finished_at 也应有锁标记');
    const columns = new Set(upgraded.prepare(
      'PRAGMA table_info(sync_run_question_items)',
    ).all().map((row) => row.name));
    assert.ok(columns.has('answer_html'));
    assert.ok(columns.has('analysis_html'));
    assert.ok(columns.has('answer_status'));
    assert.ok(columns.has('solution_html'));
    assert.ok(columns.has('raw_json'));
    assert.deepEqual(
      upgraded.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_sync_run_%' ORDER BY name",
      ).all().map((row) => row.name).length,
      10,
    );
    assert.deepEqual(TERMINAL_RUN_STATUSES, [
      'success', 'completed', 'failed', 'blocked', 'interrupted', 'cancelled',
    ]);
    assert.throws(
      () => upgraded.exec("UPDATE sync_runs SET status = 'running' WHERE id = 1"),
      /immutable/,
    );
    assert.throws(
      () => upgraded.exec("UPDATE sync_runs SET message = '篡改统计' WHERE id = 1"),
      /immutable/,
      '终态运行的统计/消息字段也不能绕过锁保护',
    );
    assert.throws(
      () => upgraded.exec(
        "UPDATE sync_run_catalog_items SET name = '篡改' WHERE run_id = 1",
      ),
      /immutable/,
    );
    assert.throws(
      () => upgraded.exec(
        "UPDATE sync_run_catalog_items SET run_id = 2 WHERE run_id = 1",
      ),
      /immutable/,
      '不能通过把终态行改挂到运行中 run 来绕过写保护',
    );
    assert.throws(
      () => upgraded.exec(`
        INSERT INTO sync_run_question_items (
          run_id, provider, textbook_external_id, question_external_id,
          content_html, plain_text, question_type
        ) VALUES (1, 'zujuan', 'tb-old', 'q-new', 'h', 'p', '单选题')
      `),
      /immutable/,
    );
    upgraded.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('interrupted 是不可变不完整终态，但明确 allowIncomplete 时只返回有界摘要', () => {
  const { directory, dbPath } = temporaryDb('collector-interrupted-summary-');
  try {
    const runId = seedRun(dbPath, {
      status: 'interrupted',
      scope: { textbookId: 'tb-interrupted' },
      textbookIds: ['tb-interrupted'],
    });
    const store = new SyncStore(dbPath);
    assert.throws(
      () => store.db.prepare("UPDATE sync_runs SET message = '篡改' WHERE id = ?").run(runId),
      /immutable/,
    );
    store.close();
    assert.throws(
      () => readRunSnapshotSummary(dbPath, runId, 'tb-interrupted'),
      (error) => error.code === 'snapshot_unavailable',
    );
    const partial = readRunSnapshotSummary(
      dbPath,
      runId,
      { textbookExternalId: 'tb-interrupted', allowIncomplete: true },
    );
    assert.equal(partial.status, 'interrupted');
    assert.equal(partial.snapshotComplete, false);
    assert.ok(partial.counts.questionItemCount > 0);
    for (const arrayName of ['catalogs', 'questions', 'questionCatalogs', 'tags', 'assets']) {
      assert.equal(Object.hasOwn(partial, arrayName), false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('采集中题目预览使用实时行数，不能复用尚未更新的运行汇总或缓存', () => {
  const { directory, dbPath } = temporaryDb();
  try {
    const runId = seedChildRun(dbPath, 'tb1', 'success', { finish: false });
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE sync_runs SET question_item_count = 1 WHERE id = ?').run(runId);
    db.close();
    const options = { textbookExternalId: 'tb1', selection: 'included' };
    assert.equal(readRunQuestions(dbPath, runId, options).total, 1);
    const store = new SyncStore(dbPath);
    store.saveRunQuestion(runId, 'tb1', {
      externalId: 'q-new', questionType: '填空题', plainText: '新题', contentHtml: '<p>新题</p>',
    }, 'tb1-c1');
    store.close();
    const result = readRunQuestions(dbPath, runId, options);
    assert.equal(result.total, 2);
    assert.equal(result.summary.captured, 2);
    assert.equal(result.rows.length, 2);
    assert.equal(result.questionTypes.length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('完整快照缓存区分筛选和排除列表，删除与恢复后统计保持准确', () => {
  const { directory, dbPath } = temporaryDb();
  try {
    const runId = seedRun(dbPath);
    const options = { textbookExternalId: 'tb1', selection: 'included' };
    assert.equal(readRunQuestions(dbPath, runId, options).total, 1);
    const excluded = { ...options, excludedIds: ['tb1-q1'] };
    assert.equal(readRunQuestions(dbPath, runId, excluded).total, 0);
    assert.equal(readRunQuestions(dbPath, runId, { ...excluded, selection: 'excluded' }).total, 1);
    assert.equal(readRunQuestions(dbPath, runId, { ...options, keyword: '不存在的题目' }).total, 0);
    assert.equal(readRunQuestions(dbPath, runId, { ...options, questionType: '填空题' }).total, 0);
    assert.equal(readRunQuestions(dbPath, runId, options).total, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('运行目录/题目快照服务端分页、筛选和题目详情保持教材范围', () => {
  const { directory, dbPath } = temporaryDb('collector-snapshot-read-');
  try {
    const runId = seedRun(dbPath, {
      scope: { textbookIds: ['tb1', 'tb2'] },
      textbookIds: ['tb1', 'tb2'],
      duplicateQuestion: true,
    });
    const catalogs = readRunCatalogs(dbPath, runId, { page: 1, pageSize: 1 });
    assert.equal(catalogs.total, 2);
    assert.equal(catalogs.rows.length, 1);
    assert.equal(catalogs.rows[0].externalTextbookId, 'tb1');
    assert.equal(catalogs.page, 1);
    assert.equal(catalogs.pageSize, 1);

    const filtered = readRunQuestions(dbPath, runId, {
      textbookExternalId: 'tb2',
      keyword: 'tb2',
      page: 1,
      pageSize: 10,
    });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.rows[0].externalTextbookId, 'tb2');
    assert.equal(filtered.rows[0].externalQuestionId, 'q-shared');
    const selection = readRunQuestions(dbPath, runId, { textbookExternalId: 'tb2', excludedIds: ['q-shared'], selection: 'included' });
    assert.equal(selection.total, 0);
    assert.equal(selection.summary.excluded, 1);
    assert.equal(readRunQuestions(dbPath, runId, { textbookExternalId: 'tb2', excludedIds: ['q-shared'], selection: 'excluded' }).total, 1);
    assert.equal(readRunCatalogs(dbPath, runId, { textbookExternalId: 'tb2', excludedIds: ['q-shared'] }).rows[0].excludedQuestionCount, 1);

    assert.throws(
      () => readRunQuestion(dbPath, runId, 'q-shared'),
      (error) => error.statusCode === 409 && error.code === 'question_ambiguous',
    );
    const detail = readRunQuestion(dbPath, runId, 'q-shared', {
      textbookExternalId: 'tb1',
    });
    assert.equal(detail.item.externalTextbookId, 'tb1');
    assert.equal(detail.item.solutionHtml, '<p>解析</p>');
    assert.equal(Object.hasOwn(detail.item, 'answerHtml'), false);
    assert.equal(Object.hasOwn(detail.item, 'analysisHtml'), false);
    assert.equal(detail.item.catalogs.length, 1);

    assert.throws(
      () => readRunQuestion(dbPath, runId, '9'.repeat(65)),
      /格式不安全/,
    );
    assert.throws(
      () => readRunQuestions(dbPath, runId, { questionType: 'x'.repeat(81) }),
      /格式不安全/,
    );
    assert.throws(
      () => readRunQuestions(dbPath, runId, { keyword: 'x'.repeat(121) }),
      /格式不安全/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('完整题库快照 API 返回五类不可变数据且计数与教材 scope 精确一致', async () => {
  const { directory, dbPath } = temporaryDb('collector-complete-question-snapshot-');
  const store = new SyncStore(dbPath);
  const runId = store.beginRun({
    textbookIds: ['tb1'],
    details: true,
    downloadAssets: true,
    scopeComplete: true,
  });
  const catalogId = 'tb1-c1';
  const questionId = 'tb1-q1';
  store.saveRunCatalogTree(runId, 'tb1', [{
    externalId: catalogId,
    level: 1,
    type: 'chapter',
    name: '第一章',
    path: '/第一章',
  }]);
  store.saveRunQuestion(runId, 'tb1', {
    externalId: questionId,
    questionType: '单选题',
    contentHtml: '<p>题干</p>',
    plainText: '题干',
    detailFetched: true,
    assets: [{
      url: 'https://assets.example/tb1-q1.png',
      type: 'image',
      assetKey: 'image-1',
      localPath: 'assets/tb1-q1.png',
      sha256: 'a'.repeat(64),
      mimeType: 'image/png',
      byteSize: 10,
    }],
    providerLabels: [{ dimension: 'provider_tag', value: '同步题' }],
  }, catalogId);
  store.saveRunQuestionCatalogs(runId, 'tb1', questionId, [{
    externalId: catalogId,
    level: 1,
    name: '第一章',
    path: '/第一章',
  }]);
  store.saveRunQuestionTags(runId, 'tb1', questionId, [{
    dimension: 'knowledge',
    tagExternalId: 'k-1',
    tagValue: '知识点',
    relationType: 'knowledge',
    evidenceType: 'provider_asserted',
    queryFingerprint: 'provider',
  }]);
  store.saveRunQuestionAssets(runId, 'tb1', questionId, [{
    assetKey: 'image-1',
    assetType: 'image',
    url: 'https://assets.example/tb1-q1.png',
    localPath: 'assets/tb1-q1.png',
    sha256: 'a'.repeat(64),
    mimeType: 'image/png',
    byteSize: 10,
  }]);
  store.finishRun(runId, 'success', {
    pagesOk: 1,
    questionsSeen: 1,
    questionsInserted: 1,
    detailsFetched: 1,
    assetsDownloaded: 1,
    errors: 0,
  });
  store.close();
  try {
    const snapshot = readRunSnapshot(dbPath, runId, { textbookExternalId: 'tb1' });
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.immutable, true);
    assert.equal(snapshot.run.snapshotComplete, true);
    assert.deepEqual(snapshot.counts, {
      catalogItemCount: 1,
      questionItemCount: 1,
      questionCatalogCount: 1,
      questionTagCount: 2,
      questionAssetCount: 1,
      catalogCount: 1,
      questionCount: 1,
      tagCount: 2,
      assetCount: 1,
    });
    assert.equal(snapshot.catalogs.length, 1);
    assert.equal(snapshot.questions.length, 1);
    assert.equal(snapshot.questionCatalogs.length, 1);
    assert.equal(snapshot.tags.length, 2);
    assert.equal(snapshot.assets.length, 1);

    const server = createCollectorServer({ dbPath });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/v1/runs/${runId}/snapshot?textbookExternalId=tb1`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.counts.questionTagCount, 2);
      assert.equal(body.counts.questionAssetCount, 1);
      assert.ok(body.tags.some((tag) => tag.tagValue === '知识点'));
      assert.equal(body.assets[0].assetKey, 'image-1');

      const summaryResponse = await fetch(
        `${baseUrl}/v1/runs/${runId}/snapshot-summary?textbookExternalId=tb1`,
      );
      assert.equal(summaryResponse.status, 200);
      const summaryBody = await summaryResponse.json();
      assert.equal(summaryBody.snapshotComplete, true);
      assert.deepEqual(summaryBody.counts, {
        catalogItemCount: 1,
        questionItemCount: 1,
        questionCatalogCount: 1,
        questionTagCount: 2,
        questionAssetCount: 1,
        catalogCount: 1,
        questionCount: 1,
        tagCount: 2,
        assetCount: 1,
      });
      for (const arrayName of ['catalogs', 'questions', 'questionCatalogs', 'tags', 'assets']) {
        assert.equal(Object.hasOwn(summaryBody, arrayName), false);
      }
    } finally {
      await closeServer(server);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('完整题库快照 API 拒绝与 sync_runs 声明计数不一致的快照', () => {
  const { directory, dbPath } = temporaryDb('collector-complete-question-count-mismatch-');
  try {
    const runId = seedRun(dbPath, {
      scope: { textbookId: 'tb-count-mismatch' },
      textbookIds: ['tb-count-mismatch'],
    });
    // The immutable-run trigger is deliberately bypassed only inside this
    // temporary tamper fixture so the API's declaration-vs-row check is
    // exercised independently of SQLite's write guard.
    const db = new DatabaseSync(dbPath);
    db.exec('DROP TRIGGER trg_sync_runs_no_reopen');
    db.prepare(`
      UPDATE sync_runs SET question_item_count = question_item_count + 1
      WHERE id = ?
    `).run(runId);
    db.close();

    assert.throws(
      () => readRunSnapshot(dbPath, runId, { textbookExternalId: 'tb-count-mismatch' }),
      (error) => error.statusCode === 409 && error.code === 'snapshot_incomplete',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('快照摘要只返回锁定头部、严格校验教材范围和五类计数', () => {
  const { directory, dbPath } = temporaryDb('collector-snapshot-summary-');
  try {
    const runId = seedRun(dbPath, {
      scope: { textbookId: 'tb-summary' },
      textbookIds: ['tb-summary'],
    });
    const summary = readRunSnapshotSummary(dbPath, runId, 'tb-summary');
    assert.equal(summary.available, true);
    assert.equal(summary.immutable, true);
    assert.equal(summary.snapshotComplete, true);
    assert.equal(summary.run.status, 'success');
    assert.deepEqual(summary.scoped, {
      textbookExternalId: 'tb-summary',
      catalogItemCount: 1,
      questionItemCount: 1,
      questionCatalogCount: 1,
      questionTagCount: 0,
      questionAssetCount: 0,
      catalogCount: 1,
      questionCount: 1,
      tagCount: 0,
      assetCount: 0,
    });
    for (const arrayName of ['catalogs', 'questions', 'questionCatalogs', 'tags', 'assets']) {
      assert.equal(Object.hasOwn(summary, arrayName), false);
    }
    assert.throws(
      () => readRunSnapshotSummary(dbPath, runId, 'other-textbook'),
      (error) => error.statusCode === 404 && error.code === 'run_scope_not_found',
    );

    const incompleteDir = temporaryDb('collector-snapshot-summary-incomplete-');
    try {
      const incompleteRunId = seedRun(incompleteDir.dbPath, {
        status: 'failed',
        scope: { textbookId: 'tb-summary' },
        textbookIds: ['tb-summary'],
      });
      assert.throws(
        () => readRunSnapshotSummary(incompleteDir.dbPath, incompleteRunId, 'tb-summary'),
        (error) => error.statusCode === 409 && error.code === 'snapshot_unavailable',
      );
    } finally {
      fs.rmSync(incompleteDir.directory, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('运行快照 API 认证、分页边界、404/409 错误契约稳定', async () => {
  const { directory, dbPath } = temporaryDb('collector-snapshot-api-');
  const runId = seedRun(dbPath, {
    scope: { textbookIds: ['tb1', 'tb2'] },
    textbookIds: ['tb1', 'tb2'],
    duplicateQuestion: true,
  });
  const server = createCollectorServer({ dbPath, token: 'snapshot-token' });
  const baseUrl = await listen(server);
  try {
    const unauthorized = await fetch(`${baseUrl}/v1/runs/${runId}/catalogs`);
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: 'Bearer snapshot-token' };
    const pageResponse = await fetch(
      `${baseUrl}/v1/runs/${runId}/catalogs?page=2&pageSize=1`,
      { headers },
    );
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json();
    assert.equal(page.total, 2);
    assert.equal(page.page, 2);
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].externalTextbookId, 'tb2');

    const invalidPage = await fetch(
      `${baseUrl}/v1/runs/${runId}/questions?page=0`,
      { headers },
    );
    assert.equal(invalidPage.status, 400);
    assert.equal((await invalidPage.json()).error.code, 'bad_request');

    const missingRun = await fetch(`${baseUrl}/v1/runs/999999/questions`, { headers });
    assert.equal(missingRun.status, 404);
    assert.equal((await missingRun.json()).error.code, 'run_not_found');

    const ambiguous = await fetch(
      `${baseUrl}/v1/runs/${runId}/questions/q-shared`,
      { headers },
    );
    assert.equal(ambiguous.status, 409);
    assert.equal((await ambiguous.json()).error.code, 'question_ambiguous');
  } finally {
    await closeServer(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('多教材 content job 为每本教材绑定独立 run、统计、时间和终态', async () => {
  const { directory, dbPath } = temporaryDb('collector-job-scopes-');
  seedMetadata(dbPath);
  let sawVisibleSolutionsFlag = false;
  let sawNoResumeFlag = false;
  const manager = new CollectorJobManager({
    dbPath,
    spawnImpl(_node, args) {
      sawVisibleSolutionsFlag ||= args.includes('--include-visible-solutions');
      sawNoResumeFlag ||= args.includes('--no-resume');
      const textbookId = args[args.indexOf('--textbook-id') + 1];
      const runId = seedChildRun(dbPath, textbookId, 'success');
      return fakeChild(runId);
    },
  });
  try {
    const started = manager.start({
      runType: 'content',
      acknowledgeSourcePolicy: true,
      metadataRunId: 1,
      textbookExternalIds: ['tb1', 'tb2'],
      maxPages: 1,
    });
    await waitFor(() => ['completed', 'failed', 'blocked', 'cancelled'].includes(
      manager.get(started.id)?.status,
    ));
    const job = manager.get(started.id);
    assert.equal(job.status, 'completed');
    assert.equal(job.completedTextbooks, 2);
    assert.equal(job.catalogCount, 2);
    assert.equal(job.questionCount, 2);
    assert.equal(job.scopeItems.length, 2);
    assert.deepEqual(job.scopeItems.map((scope) => scope.status), ['completed', 'completed']);
    assert.deepEqual(job.scopeItems.map((scope) => scope.collectorRunId).length, 2);
    assert.notEqual(job.scopeItems[0].collectorRunId, job.scopeItems[1].collectorRunId);
    assert.equal(sawVisibleSolutionsFlag, false);
    assert.equal(sawNoResumeFlag, true);
    for (const scope of job.scopeItems) {
      assert.equal(scope.catalogCount, 1);
      assert.equal(scope.questionCount, 1);
      assert.ok(scope.startedAt);
      assert.ok(scope.finishedAt);
      assert.equal(scope.error, null);
    }
    const publicPayload = require('../server.cjs').publicJob(job);
    assert.equal(publicPayload.scopeItems[0].errorMessage, null);
    assert.ok(publicPayload.scopeItems[0].startedAt);
    assert.equal(publicPayload.collectorRunId, null, '多教材任务不应伪造单一 job-level run ID');
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('多教材 content job 在单本失败时保留已完成 scope 并标记失败 scope', async () => {
  const { directory, dbPath } = temporaryDb('collector-job-failed-');
  seedMetadata(dbPath);
  let invocation = 0;
  const manager = new CollectorJobManager({
    dbPath,
    spawnImpl(_node, args) {
      const textbookId = args[args.indexOf('--textbook-id') + 1];
      invocation += 1;
      const runId = seedChildRun(dbPath, textbookId, invocation === 1 ? 'success' : 'failed');
      return fakeChild(runId, invocation === 1 ? 0 : 1);
    },
  });
  try {
    const started = manager.start({
      runType: 'content',
      acknowledgeSourcePolicy: true,
      metadataRunId: 1,
      textbookExternalIds: ['tb1', 'tb2'],
      maxPages: 1,
    });
    await waitFor(() => ['completed', 'failed', 'blocked', 'cancelled'].includes(
      manager.get(started.id)?.status,
    ));
    const job = manager.get(started.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.completedTextbooks, 1);
    assert.equal(job.scopeItems[0].status, 'completed');
    assert.equal(job.scopeItems[1].status, 'failed');
    assert.equal(job.scopeItems[1].error, '教材 tb2 采集失败');
    assert.ok(job.scopeItems[1].finishedAt);
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('子进程异常退出时会封存仍为 running 的底层 content run', async () => {
  const { directory, dbPath } = temporaryDb('collector-job-orphan-');
  seedMetadata(dbPath, ['tb1']);
  let orphanRunId;
  const manager = new CollectorJobManager({
    dbPath,
    spawnImpl(_node, args) {
      const textbookId = args[args.indexOf('--textbook-id') + 1];
      orphanRunId = seedChildRun(dbPath, textbookId, 'running', { finish: false });
      return fakeChild(orphanRunId, 1);
    },
  });
  try {
    const started = manager.start({
      runType: 'content',
      acknowledgeSourcePolicy: true,
      metadataRunId: 1,
      textbookExternalIds: ['tb1'],
      maxPages: 1,
    });
    await waitFor(() => manager.get(started.id)?.status === 'failed');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const run = db.prepare(
      'SELECT status, finished_at, snapshot_locked_at FROM sync_runs WHERE id = ?',
    ).get(orphanRunId);
    db.close();
    assert.equal(run.status, 'failed');
    assert.ok(run.finished_at);
    assert.ok(run.snapshot_locked_at);
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('运行中的 content job 取消后任务和当前教材 scope 均进入 cancelled', async () => {
  const { directory, dbPath } = temporaryDb('collector-job-cancel-');
  seedMetadata(dbPath, ['tb1']);
  let child;
  const manager = new CollectorJobManager({
    dbPath,
    spawnImpl(_node, args) {
      const textbookId = args[args.indexOf('--textbook-id') + 1];
      const runId = seedChildRun(dbPath, textbookId, 'cancelled');
      child = fakeChild(runId, -15, { autoClose: false });
      return child;
    },
  });
  try {
    const started = manager.start({
      runType: 'content',
      acknowledgeSourcePolicy: true,
      metadataRunId: 1,
      textbookExternalIds: ['tb1'],
      maxPages: 1,
    });
    await waitFor(() => manager.get(started.id)?.status === 'running');
    const cancelling = manager.cancel(started.id);
    assert.equal(cancelling.status, 'cancelling');
    child.stdout.end();
    child.stderr.end();
    child.emit('close', -15, 'SIGTERM');
    await waitFor(() => manager.get(started.id)?.status === 'cancelled');
    const job = manager.get(started.id);
    assert.equal(job.scopeItems[0].status, 'cancelled');
    assert.ok(job.scopeItems[0].finishedAt);
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('COLLECTOR_HEADFUL 只由部署配置读取，不接受任务请求覆盖', async () => {
  const { directory, dbPath } = temporaryDb('collector-headful-');
  const previous = process.env.COLLECTOR_HEADFUL;
  try {
    process.env.COLLECTOR_HEADFUL = 'true';
    const manager = new CollectorJobManager({ dbPath });
    assert.equal(manager.headful, true);
    assert.ok(manager.baseArgs().includes('--headful'));
    manager.cancel('missing');
    await manager.shutdown();
  } finally {
    if (previous == null) delete process.env.COLLECTOR_HEADFUL;
    else process.env.COLLECTOR_HEADFUL = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.throws(
    () => new CollectorJobManager({ dbPath, headful: 'maybe' }),
    /COLLECTOR_HEADFUL 必须是 true\/false/,
  );
});
