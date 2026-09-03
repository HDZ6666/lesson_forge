'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');

const { aggregateLiveProgress, CollectorJobManager, createCollectorServer } = require('../server.cjs');
const { SyncStore } = require('../zujuan_sync.cjs');

function fixtureDb(directory) {
  const dbPath = path.join(directory, 'collector.sqlite3');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE source_metadata_runs (
      id INTEGER PRIMARY KEY, provider TEXT, started_at TEXT, finished_at TEXT,
      status TEXT, version_count INTEGER, textbook_count INTEGER
    );
    CREATE TABLE source_textbook_versions (
      provider TEXT, external_version_id TEXT, version_name TEXT, source_url TEXT,
      is_new TEXT, sort_order INTEGER, status TEXT, first_seen_at TEXT, last_seen_at TEXT
    );
    CREATE TABLE source_textbooks (
      provider TEXT, external_textbook_id TEXT, version_external_id TEXT, textbook_name TEXT,
      grade TEXT, volume TEXT, source_url TEXT, sort_order INTEGER, status TEXT,
      bootstrap_chapter_external_id TEXT, first_seen_at TEXT, last_seen_at TEXT
    );
    CREATE TABLE textbook_nodes (
      provider TEXT, external_id TEXT, textbook_external_id TEXT, parent_external_id TEXT,
      node_level INTEGER, node_type TEXT, name TEXT, source_path TEXT, source_url TEXT,
      sort_order INTEGER, status TEXT, first_seen_at TEXT, last_seen_at TEXT
    );
    CREATE TABLE questions (
      provider TEXT, external_id TEXT, chapter_id TEXT, source_title TEXT, source_url TEXT,
      plain_text TEXT, content_hash TEXT, first_seen_at TEXT, last_seen_at TEXT
    );
    CREATE TABLE question_catalog_memberships (
      provider TEXT, question_external_id TEXT, catalog_external_id TEXT
    );
    INSERT INTO source_metadata_runs VALUES
      (1, 'zujuan', '2026-08-27T00:00:00Z', '2026-08-27T00:10:00Z', 'success', 1, 1);
    INSERT INTO source_textbook_versions VALUES
      ('zujuan', 'v1', '北师大版', 'https://example/v1', 'N', 1, '0',
       '2026-08-27T00:01:00Z', '2026-08-27T00:05:00Z');
    INSERT INTO source_textbooks VALUES
      ('zujuan', 'tb1', 'v1', '九年级上册', '9', '上册', 'https://example/tb1', 1, '0', 'c1',
       '2026-08-27T00:01:00Z', '2026-08-27T00:05:00Z');
    INSERT INTO textbook_nodes VALUES
      ('zujuan', 'c1', 'tb1', NULL, 1, 'chapter', '第一章', '/c1', 'https://example/c1', 1, '0',
       '2026-08-27T00:01:00Z', '2026-08-27T00:05:00Z');
    INSERT INTO questions VALUES
      ('zujuan', 'q1', 'c1', '试卷', 'https://example/q1', '题干', 'hash',
       '2026-08-27T00:01:00Z', '2026-08-27T00:05:00Z');
    INSERT INTO question_catalog_memberships VALUES ('zujuan', 'q1', 'c1');
  `);
  db.close();
  return dbPath;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function fakeChild(exitCode = 1) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 2147483647;
  child.kill = () => true;
  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode, null);
  });
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

test('collector API exposes authenticated bounded snapshots and scoped candidates', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-api-'));
  const server = createCollectorServer({ dbPath: fixtureDb(directory), token: 'test-token' });
  const baseUrl = await listen(server);
  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);

    const unauthorized = await fetch(`${baseUrl}/v1/metadata/snapshot`);
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: 'Bearer test-token' };
    const snapshotResponse = await fetch(`${baseUrl}/v1/metadata/snapshot?metadataRunId=1`, { headers });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.run.id, 1);
    assert.equal(snapshot.versions[0].external_version_id, 'v1');
    assert.equal(snapshot.textbooks[0].external_textbook_id, 'tb1');

    const validateResponse = await fetch(`${baseUrl}/v1/metadata/validate`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ metadataRunId: 1, textbookExternalIds: ['tb1'] }),
    });
    assert.equal(validateResponse.status, 200);
    const validated = await validateResponse.json();
    assert.equal(validated.textbooks[0].bootstrapChapterExternalId, 'c1');

    const candidatesResponse = await fetch(
      `${baseUrl}/v1/candidates?entityType=question&provider=zujuan&textbookExternalId=tb1`,
      { headers },
    );
    assert.equal(candidatesResponse.status, 200);
    const candidates = await candidatesResponse.json();
    assert.deepEqual(candidates.rows.map((row) => row.external_id), ['q1']);

    const progressResponse = await fetch(`${baseUrl}/v1/catalog-progress`, { headers });
    assert.equal(progressResponse.status, 200);
    const progress = await progressResponse.json();
    assert.equal(progress.available, true);
    assert.equal(progress.catalogCount, 1);
    assert.equal(progress.questionUnique, 1);
  } finally {
    await close(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('多教材实时进度按已知总题数加权，完成教材以最终题数计入', () => {
  const scopes = [
    { externalTextbookId: 'tb1', status: 'running' },
    { externalTextbookId: 'tb2', status: 'completed', questionCount: 20 },
  ];
  const live = new Map([
    ['tb1', { available: true, totalQuestionCount: 100, collectedQuestionCount: 25 }],
  ]);
  assert.deepEqual(aggregateLiveProgress(scopes, live, 7), {
    available: true,
    progressPercent: 37.5,
  });
});

test('单教材实时百分比和无实时投影时的旧阶段进度保持稳定', () => {
  const scope = [{ externalTextbookId: 'tb1', status: 'running' }];
  assert.deepEqual(
    aggregateLiveProgress(scope, new Map([['tb1', { available: true, progressPercent: 37.25 }]]), 5),
    { available: true, progressPercent: 37.3 },
  );
  assert.deepEqual(aggregateLiveProgress(scope, new Map(), 12), {
    available: false,
    progressPercent: 12,
  });
});

test('a queued collector job cancelled before execution never starts a child process', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-api-cancel-'));
  let spawnCount = 0;
  const managerOptions = {
    dbPath: fixtureDb(directory),
    spawnImpl() {
      spawnCount += 1;
      throw new Error('cancelled job must not spawn');
    },
  };
  const server = createCollectorServer(managerOptions);
  try {
    const job = server.collectorManager.start({
      runType: 'metadata',
      acknowledgeSourcePolicy: true,
      maxPages: 1,
    });
    const cancelling = server.collectorManager.cancel(job.id);
    assert.equal(cancelling.status, 'cancelling');
    await new Promise((resolve) => setImmediate(resolve));
    const cancelled = server.collectorManager.get(job.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(spawnCount, 0);
  } finally {
    await server.collectorManager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('独立 textbookScopes 创建题库任务不依赖 metadataRunId 或元数据表', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-independent-scope-'));
  const dbPath = path.join(directory, 'collector.sqlite3');
  let childArgs;
  const manager = new CollectorJobManager({
    dbPath,
    spawnImpl(_node, args) {
      childArgs = args;
      return fakeChild();
    },
  });
  try {
    const started = manager.start({
      runType: 'content',
      acknowledgeSourcePolicy: true,
      metadataRunId: null,
      textbookExternalIds: ['260617'],
      textbookScopes: [{
        sourceProvider: 'zujuan',
        externalVersionId: '199373',
        externalTextbookId: '260617',
        versionName: '浙教版',
        textbookName: '九年级上册',
      }],
      maxPages: 1,
    });
    assert.equal(started.metadataRunId, null);
    assert.deepEqual(started.scopeItems.map((scope) => ({
      sourceProvider: scope.sourceProvider,
      externalVersionId: scope.externalVersionId,
      externalTextbookId: scope.externalTextbookId,
      versionName: scope.versionName,
      textbookName: scope.textbookName,
    })), [{
      sourceProvider: 'zujuan',
      externalVersionId: '199373',
      externalTextbookId: '260617',
      versionName: '浙教版',
      textbookName: '九年级上册',
    }]);
    await waitFor(() => ['completed', 'failed', 'blocked', 'cancelled'].includes(
      manager.get(started.id)?.status,
    ));
    assert.ok(childArgs, '独立 scope 应启动题库脚本');
    assert.match(childArgs[0], /zujuan_question_sync\.cjs$/);
    assert.equal(childArgs[childArgs.indexOf('--textbook-id') + 1], '260617');
    assert.equal(childArgs[childArgs.indexOf('--chapter-id') + 1], '260617');
    assert.equal(childArgs.includes('--refresh-details'), false);
    assert.equal(childArgs.includes('--all-catalogs'), false);
    assert.equal(childArgs.includes('--include-visible-solutions'), false);
    assert.equal(childArgs.includes('--no-resume'), true);
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('独立 textbookScopes 严格拒绝来源、重复项、映射和名称输入', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-independent-invalid-'));
  const dbPath = path.join(directory, 'collector.sqlite3');
  const manager = new CollectorJobManager({ dbPath, spawnImpl() {
    throw new Error('非法请求不应启动子进程');
  } });
  const base = {
    runType: 'content',
    acknowledgeSourcePolicy: true,
    metadataRunId: null,
    textbookExternalIds: ['tb1'],
    textbookScopes: [{
      sourceProvider: 'zujuan',
      externalVersionId: 'v1',
      externalTextbookId: 'tb1',
      versionName: '版本',
      textbookName: '教材',
    }],
    maxPages: 1,
  };
  try {
    assert.throws(
      () => manager.start({ ...base, textbookScopes: [{ ...base.textbookScopes[0], sourceProvider: 'other' }] }),
      /来源提供方不受支持/,
    );
    assert.throws(
      () => manager.start({
        ...base,
        textbookExternalIds: ['tb1', 'tb2'],
        textbookScopes: [base.textbookScopes[0]],
      }),
      /数量不一致/,
    );
    assert.throws(
      () => manager.start({ ...base, textbookExternalIds: ['tb2'] }),
      /顺序或映射不一致/,
    );
    assert.throws(
      () => manager.start({
        ...base,
        textbookScopes: [{ ...base.textbookScopes[0], textbookName: 'x'.repeat(201) }],
      }),
      /长度或格式不安全/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('独立 textbookScopes 续采严格绑定 source run，并只切换为 --resume-run-id', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-independent-resume-'));
  const dbPath = path.join(directory, 'collector.sqlite3');
  const scope = {
    chapterIds: ['c1'],
    textbookId: 'tb1',
    catalogLevels: [1, 2, 3],
    catalogIds: [],
    allCatalogs: true,
    withinChapterIds: [],
    filters: {
      scene: null,
      questionType: null,
      difficulty: null,
      category: null,
      year: null,
      fresh: false,
      sort: { id: 2, name: '最新' },
    },
    startPage: 1,
    maxPages: 1,
    details: false,
    detailFallback: true,
    refreshDetails: false,
    includeVisibleSolutions: false,
    downloadAssets: true,
    requireDetails: false,
    requireAssets: true,
    limit: 0,
    truncated: false,
  };
  const store = new SyncStore(dbPath);
  const sourceRunId = store.beginRun(scope);
  store.saveRunCatalogTree(sourceRunId, 'tb1', [{ externalId: 'c1', level: 1, name: '第一章' }]);
  store.saveRunQuestion(sourceRunId, 'tb1', {
    externalId: 'q1', contentHtml: '题干', plainText: '题干',
  }, 'c1');
  store.saveRunQuestionCatalogs(sourceRunId, 'tb1', 'q1', [{
    externalId: 'c1', level: 1, name: '第一章',
  }]);
  store.finishRun(sourceRunId, 'interrupted', { pagesOk: 1, errors: 1 }, 'ECONNRESET');
  store.close();

  let childArgs;
  const manager = new CollectorJobManager({
    dbPath,
    spawnImpl(_node, args) {
      childArgs = args;
      return fakeChild(1);
    },
  });
  try {
    const started = manager.start({
      runType: 'content',
      acknowledgeSourcePolicy: true,
      maxPages: 1,
      textbookExternalIds: ['tb1'],
      textbookScopes: [{
        sourceProvider: 'zujuan',
        externalVersionId: 'v1',
        externalTextbookId: 'tb1',
        versionName: '版本',
        textbookName: '教材',
        bootstrapChapterExternalId: 'c1',
        resumeFromCollectorRunId: sourceRunId,
      }],
    });
    assert.equal(started.scopeItems[0].resumeFromCollectorRunId, sourceRunId);
    await waitFor(() => ['completed', 'failed', 'blocked', 'interrupted', 'cancelled'].includes(
      manager.get(started.id)?.status,
    ));
    assert.ok(childArgs);
    assert.equal(childArgs[childArgs.indexOf('--resume-run-id') + 1], String(sourceRunId));
    assert.equal(childArgs.includes('--no-resume'), false);
  } finally {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
