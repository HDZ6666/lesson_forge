'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCollectorServer } = require('../server.cjs');
const {
  MAX_SNAPSHOT_FETCH_BATCH_SIZE,
  MAX_SNAPSHOT_PAGE_BYTES,
  readRunAsset,
  readRunSnapshotPage,
} = require('../lib/api_store.cjs');
const { SyncStore } = require('../zujuan_sync.cjs');

function temporary(prefix = 'collector-page-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory,
    dbPath: path.join(directory, 'collector.sqlite3'),
    dataDir: path.join(directory, 'data'),
  };
}

function seedRun({
  prefix = 'collector-page-',
  textbookIds = ['tb1'],
  questionCount = 4,
  questionText = null,
  asset = null,
  status = 'success',
  errors = 0,
} = {}) {
  const paths = temporary(prefix);
  fs.mkdirSync(path.join(paths.dataDir, 'assets'), { recursive: true });
  const store = new SyncStore(paths.dbPath, { dataDir: paths.dataDir });
  const runId = store.beginRun({ textbookIds, details: false, downloadAssets: false });
  for (const textbookId of textbookIds) {
    const catalogId = `${textbookId}-c1`;
    store.saveRunCatalogTree(runId, textbookId, [{
      externalId: catalogId,
      level: 1,
      name: `${textbookId} 第一章`,
      path: `/${catalogId}`,
      sortOrder: 1,
    }]);
    for (let index = 1; index <= questionCount; index += 1) {
      const questionId = `${textbookId}-q${String(index).padStart(3, '0')}`;
      const text = questionText ? questionText(index, textbookId) : `${textbookId} 题目 ${index}`;
      store.saveRunQuestion(runId, textbookId, {
        externalId: questionId,
        questionType: '单选题',
        contentHtml: `<p>${text}</p>`,
        plainText: text,
        detailFetched: true,
      }, catalogId);
      store.saveRunQuestionCatalogs(runId, textbookId, questionId, [{
        externalId: catalogId,
        level: 1,
        name: `${textbookId} 第一章`,
        path: `/${catalogId}`,
      }]);
      if (asset && index === 1) {
        store.saveRunQuestionAssets(runId, textbookId, questionId, [asset]);
      }
    }
  }
  store.finishRun(runId, status, {
    pagesOk: 1,
    questionsSeen: textbookIds.length * questionCount,
    questionsInserted: textbookIds.length * questionCount,
    detailsFetched: textbookIds.length * questionCount,
    assetsDownloaded: asset ? 1 : 0,
    errors,
  }, status === 'success' ? null : '测试运行失败');
  store.close();
  return { ...paths, runId };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function authHeaders(token = 'snapshot-page-token') {
  return { authorization: `Bearer ${token}` };
}

test('snapshot-page requires authentication and rejects strict input boundaries', async () => {
  const fixture = seedRun({ questionCount: 2 });
  const server = createCollectorServer({ dbPath: fixture.dbPath, dataDir: fixture.dataDir, token: 'snapshot-page-token' });
  const baseUrl = await listen(server);
  try {
    const unauthorized = await fetch(
      `${baseUrl}/v1/runs/${fixture.runId}/snapshot-page?collection=questions&textbookExternalId=tb1`,
    );
    assert.equal(unauthorized.status, 401);
    for (const query of [
      'collection=bad',
      'collection=questions&cursor=-1',
      'collection=questions&cursor=1.5',
      'collection=questions&cursor=99',
      'collection=questions&pageSize=0',
      'collection=questions&pageSize=5001',
    ]) {
      const response = await fetch(
        `${baseUrl}/v1/runs/${fixture.runId}/snapshot-page?textbookExternalId=tb1&${query}`,
        { headers: authHeaders() },
      );
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).error.code, 'bad_request', query);
    }
  } finally {
    await close(server);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('snapshot-page is deterministic, scoped, and advances by actual returned rows', () => {
  const fixture = seedRun({ textbookIds: ['tb1', 'tb2'], questionCount: 3 });
  try {
    const first = readRunSnapshotPage(fixture.dbPath, fixture.runId, {
      collection: 'questions',
      textbookExternalId: 'tb1',
      cursor: 0,
      pageSize: 2,
    });
    const repeated = readRunSnapshotPage(fixture.dbPath, fixture.runId, {
      collection: 'questions',
      textbookExternalId: 'tb1',
      cursor: 0,
      pageSize: 2,
    });
    assert.equal(first.available, true);
    assert.equal(first.immutable, true);
    assert.equal(first.run.snapshotComplete, true);
    assert.equal(first.run.snapshotLockedAt != null, true);
    assert.equal(first.total, 3);
    assert.deepEqual(first.items.map((row) => row.question_external_id), ['tb1-q001', 'tb1-q002']);
    assert.equal(first.nextCursor, 2);
    assert.deepEqual(first.items, repeated.items);
    const last = readRunSnapshotPage(fixture.dbPath, fixture.runId, {
      collection: 'questions',
      textbookExternalId: 'tb1',
      cursor: first.nextCursor,
      pageSize: 2,
    });
    assert.deepEqual(last.items.map((row) => row.question_external_id), ['tb1-q003']);
    assert.equal(last.nextCursor, null);
    const otherScope = readRunSnapshotPage(fixture.dbPath, fixture.runId, {
      collection: 'questions', textbookExternalId: 'tb2', cursor: 0, pageSize: 2,
    });
    assert.deepEqual(otherScope.items.map((row) => row.textbook_external_id), ['tb2', 'tb2']);
    assert.throws(
      () => readRunSnapshotPage(fixture.dbPath, fixture.runId, {
        collection: 'questions', textbookExternalId: 'other', cursor: 0, pageSize: 2,
      }),
      (error) => error.statusCode === 404 && error.code === 'run_scope_not_found',
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('snapshot-page rejects an unfinished run before returning any collection rows', () => {
  const fixture = seedRun({ status: 'failed', errors: 1 });
  try {
    assert.throws(
      () => readRunSnapshotPage(fixture.dbPath, fixture.runId, {
        collection: 'catalogs', textbookExternalId: 'tb1', cursor: 0, pageSize: 1,
      }),
      (error) => error.statusCode === 409 && ['snapshot_unavailable', 'snapshot_incomplete'].includes(error.code),
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('snapshot-page rechecks the sealed run header on its own connection', () => {
  const fixture = seedRun({ prefix: 'collector-page-header-drift-' });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(fixture.dbPath);
  // Simulate a replaced/hand-edited database after the caller obtained a
  // previously valid summary.  The production schema prevents this update;
  // dropping only the guard here verifies the API still fails closed.
  db.exec('DROP TRIGGER trg_sync_runs_no_reopen');
  db.prepare('UPDATE sync_runs SET status = ?, finished_at = NULL WHERE id = ?')
    .run('running', fixture.runId);
  db.close();
  try {
    assert.throws(
      () => readRunSnapshotPage(fixture.dbPath, fixture.runId, {
        collection: 'questions', textbookExternalId: 'tb1', cursor: 0, pageSize: 1,
      }),
      (error) => error.statusCode === 409 && error.code === 'snapshot_unavailable',
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('snapshot-page shrinks a large requested page by actual JSON byte size', async () => {
  // The requested page may be 5000, but SQLite materialisation stays bounded
  // by the implementation batch size while large rows exercise the byte cap.
  assert.ok(MAX_SNAPSHOT_FETCH_BATCH_SIZE > 0);
  assert.ok(MAX_SNAPSHOT_FETCH_BATCH_SIZE < 5000);
  const fixture = seedRun({
    questionCount: 32,
    questionText: () => '大'.repeat(250000),
    prefix: 'collector-page-large-',
  });
  const server = createCollectorServer({ dbPath: fixture.dbPath, dataDir: fixture.dataDir });
  const baseUrl = await listen(server);
  try {
    let cursor = 0;
    const seen = [];
    let pageCount = 0;
    while (cursor !== null) {
      const response = await fetch(
        `${baseUrl}/v1/runs/${fixture.runId}/snapshot-page?collection=questions&textbookExternalId=tb1&cursor=${cursor}&pageSize=5000`,
      );
      assert.equal(response.status, 200);
      const raw = Buffer.from(await response.arrayBuffer());
      const body = JSON.parse(raw.toString('utf8'));
      assert.ok(raw.length <= MAX_SNAPSHOT_PAGE_BYTES);
      assert.ok(body.items.length > 0);
      assert.equal(body.cursor, cursor);
      assert.equal(body.total, 32);
      assert.equal(body.nextCursor, cursor + body.items.length < body.total
        ? cursor + body.items.length
        : null);
      seen.push(...body.items.map((row) => row.question_external_id));
      cursor = body.nextCursor;
      pageCount += 1;
      assert.ok(pageCount < 32, 'pagination must make progress');
    }
    assert.ok(pageCount > 1, 'byte budget should split the requested page');
    assert.equal(seen.length, 32);
    assert.equal(new Set(seen).size, 32);
    assert.deepEqual(seen, Array.from({ length: 32 }, (_, index) =>
      `tb1-q${String(index + 1).padStart(3, '0')}`));
  } finally {
    await close(server);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function seedAssetRun({
  storagePath,
  fileBytes = Buffer.from('asset-ok'),
  contentHash,
  prefix = 'collector-asset-',
} = {}) {
  const fixture = temporary(prefix);
  fs.mkdirSync(path.join(fixture.dataDir, 'assets'), { recursive: true });
  const bytes = Buffer.from(fileBytes);
  const hash = contentHash || crypto.createHash('sha256').update(bytes).digest('hex');
  const absoluteStorage = path.join(fixture.dataDir, storagePath || `assets/${hash}.bin`);
  if (!storagePath?.startsWith('../')) {
    fs.mkdirSync(path.dirname(absoluteStorage), { recursive: true });
    fs.writeFileSync(absoluteStorage, bytes);
  }
  const store = new SyncStore(fixture.dbPath, { dataDir: fixture.dataDir });
  const runId = store.beginRun({ textbookId: 'tb1', details: false, downloadAssets: false });
  store.saveRunCatalogTree(runId, 'tb1', [{ externalId: 'c1', level: 1, name: '第一章', path: '/c1' }]);
  store.saveRunQuestion(runId, 'tb1', {
    externalId: 'q1', contentHtml: '<p>题干</p>', plainText: '题干', detailFetched: true,
  }, 'c1');
  store.saveRunQuestionCatalogs(runId, 'tb1', 'q1', [{ externalId: 'c1', level: 1, name: '第一章', path: '/c1' }]);
  store.saveRunQuestionAssets(runId, 'tb1', 'q1', [{
    assetKey: 'asset-1', assetType: 'image', url: 'https://assets.example/asset',
    localPath: storagePath || `assets/${hash}.bin`, sha256: hash, mimeType: 'image/png', byteSize: bytes.length,
  }]);
  store.finishRun(runId, 'success', { pagesOk: 1, questionsSeen: 1, questionsInserted: 1, errors: 0 });
  store.close();
  return { ...fixture, runId, hash };
}

test('asset endpoint streams verified bytes, rejects unknown hashes, and keeps host paths private', async () => {
  const fixture = seedAssetRun({ prefix: 'collector-asset-http-' });
  const server = createCollectorServer({ dbPath: fixture.dbPath, dataDir: fixture.dataDir, token: 'asset-token' });
  const baseUrl = await listen(server);
  try {
    const unauthorized = await fetch(`${baseUrl}/v1/runs/${fixture.runId}/assets/${fixture.hash}?textbookExternalId=tb1`);
    assert.equal(unauthorized.status, 401);
    const response = await fetch(
      `${baseUrl}/v1/runs/${fixture.runId}/assets/${fixture.hash}?textbookExternalId=tb1`,
      { headers: authHeaders('asset-token') },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('content-length'), '8');
    assert.equal(response.headers.get('etag'), `"${fixture.hash}"`);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from('asset-ok'));

    const unknownHash = 'f'.repeat(64);
    const unknown = await fetch(
      `${baseUrl}/v1/runs/${fixture.runId}/assets/${unknownHash}?textbookExternalId=tb1`,
      { headers: authHeaders('asset-token') },
    );
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'asset_not_found');

    const malformed = await fetch(
      `${baseUrl}/v1/runs/${fixture.runId}/assets/not-a-sha?textbookExternalId=tb1`,
      { headers: authHeaders('asset-token') },
    );
    assert.equal(malformed.status, 400);
    const malformedBody = await malformed.json();
    assert.equal(malformedBody.error.code, 'bad_request');
    assert.equal(JSON.stringify(malformedBody).includes(fixture.dataDir), false);
  } finally {
    await close(server);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('asset lookup uses the scoped hash index and accepts uppercase legacy hashes', () => {
  const fixture = seedAssetRun({ prefix: 'collector-asset-index-' });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(fixture.dbPath);
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT question_external_id FROM sync_run_question_assets
      INDEXED BY idx_sync_run_question_assets_scope_hash
    WHERE run_id = ? AND provider = ? AND textbook_external_id = ?
      AND content_sha256 IN (?, ?)
  `).all(fixture.runId, 'zujuan', 'tb1', fixture.hash, fixture.hash.toUpperCase());
  assert.ok(plan.some((row) => String(row.detail).includes(
    'idx_sync_run_question_assets_scope_hash',
  )));
  db.exec('DROP TRIGGER trg_snapshot_question_assets_no_update');
  db.prepare('UPDATE sync_run_question_assets SET content_sha256 = ? WHERE run_id = ?')
    .run(fixture.hash.toUpperCase(), fixture.runId);
  db.close();
  try {
    const asset = readRunAsset(fixture.dbPath, fixture.runId, fixture.hash, {
      textbookExternalId: 'tb1', dataDir: fixture.dataDir,
    });
    assert.equal(asset.asset.contentSha256, fixture.hash);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('asset lookup independently rejects a drifted sealed run header', () => {
  const fixture = seedAssetRun({ prefix: 'collector-asset-header-drift-' });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(fixture.dbPath);
  db.exec('DROP TRIGGER trg_sync_runs_no_reopen');
  db.prepare('UPDATE sync_runs SET status = ? WHERE id = ?').run('running', fixture.runId);
  db.close();
  try {
    assert.throws(
      () => readRunAsset(fixture.dbPath, fixture.runId, fixture.hash, {
        textbookExternalId: 'tb1', dataDir: fixture.dataDir,
      }),
      (error) => error.statusCode === 409 && error.code === 'snapshot_unavailable',
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('asset endpoint rejects traversal, escaping symlinks, and disk hash mismatches', () => {
  const traversal = seedAssetRun({
    storagePath: '../outside.bin',
    prefix: 'collector-asset-traversal-',
  });
  const outside = path.join(path.dirname(traversal.dataDir), 'outside.bin');
  fs.writeFileSync(outside, 'secret');
  try {
    assert.throws(
      () => readRunAsset(traversal.dbPath, traversal.runId, traversal.hash, {
        textbookExternalId: 'tb1', dataDir: traversal.dataDir,
      }),
      (error) => error.statusCode === 404 && error.code === 'asset_not_found',
    );
  } finally {
    fs.rmSync(outside, { force: true });
    fs.rmSync(traversal.directory, { recursive: true, force: true });
  }

  const symlink = seedAssetRun({ prefix: 'collector-asset-symlink-' });
  const linkPath = path.join(symlink.dataDir, 'assets', 'link.bin');
  const escapePath = path.join(path.dirname(symlink.dataDir), 'escape.bin');
  fs.writeFileSync(escapePath, 'outside');
  fs.unlinkSync(path.join(symlink.dataDir, 'assets', `${symlink.hash}.bin`));
  fs.symlinkSync(escapePath, linkPath);
  // The row was written against the regular path; replace it while the
  // database is still otherwise sealed only by dropping the row guard.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(symlink.dbPath);
  db.exec('DROP TRIGGER trg_snapshot_question_assets_no_update');
  db.prepare('UPDATE sync_run_question_assets SET storage_path = ? WHERE run_id = ?').run('assets/link.bin', symlink.runId);
  db.close();
  try {
    assert.throws(
      () => readRunAsset(symlink.dbPath, symlink.runId, symlink.hash, {
        textbookExternalId: 'tb1', dataDir: symlink.dataDir,
      }),
      (error) => error.statusCode === 404 && error.code === 'asset_not_found',
    );
  } finally {
    fs.rmSync(escapePath, { force: true });
    fs.rmSync(symlink.directory, { recursive: true, force: true });
  }

  const mismatchBytes = Buffer.from('different');
  const mismatch = seedAssetRun({
    fileBytes: mismatchBytes,
    contentHash: 'a'.repeat(64),
    prefix: 'collector-asset-mismatch-',
  });
  try {
    assert.throws(
      () => readRunAsset(mismatch.dbPath, mismatch.runId, mismatch.hash, {
        textbookExternalId: 'tb1', dataDir: mismatch.dataDir,
      }),
      (error) => error.statusCode === 409 && error.code === 'asset_integrity_error',
    );
  } finally {
    fs.rmSync(mismatch.directory, { recursive: true, force: true });
  }
});
