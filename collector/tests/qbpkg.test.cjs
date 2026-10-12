'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { buildPackage, QbPkgValidationError } = require('../src/qbpkg/builder.cjs');
const { validateArchiveLimits, verifyPackage } = require('../src/qbpkg/validator.cjs');
const { assetKey, checkHtmlSafety, normalizeHtml, sanitizeHtml } = require('../src/qbpkg/normalize.cjs');
const { sha256 } = require('../src/qbpkg/util.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qbpkg-test-'));
}

function sourceDb(dir, { orphan = false, duplicateQuestion = false, assetOrder = 'normal' } = {}) {
  const dbPath = path.join(dir, 'source.sqlite3');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE textbook_nodes (
      provider TEXT, external_id TEXT, textbook_external_id TEXT,
      parent_external_id TEXT, node_level INTEGER, node_type TEXT,
      name TEXT, source_path TEXT, first_seen_at TEXT, last_seen_at TEXT
    );
    CREATE TABLE questions (
      provider TEXT, external_id TEXT, bank_id INTEGER, chapter_id TEXT,
      detail_url TEXT, source_short TEXT, source_title TEXT, source_url TEXT,
      question_type TEXT, question_type_id TEXT, difficulty_label TEXT,
      difficulty_code TEXT, ease_coefficient REAL, content_html TEXT,
      plain_text TEXT, content_hash TEXT, list_content_hash TEXT,
      detail_content_hash TEXT, detail_fetched INTEGER, subquestion_count INTEGER,
      child_count INTEGER, has_image INTEGER, has_formula INTEGER, has_table INTEGER,
      is_new INTEGER, use_count INTEGER, provider_updated_at TEXT,
      solution_html TEXT, first_seen_at TEXT, last_seen_at TEXT, raw_json TEXT
    );
    CREATE TABLE question_knowledge (
      provider TEXT, question_external_id TEXT, knowledge_external_id TEXT,
      name TEXT, knowledge_kind TEXT, evidence_type TEXT, observed_at TEXT
    );
    CREATE TABLE question_catalog_memberships (
      provider TEXT, question_external_id TEXT, catalog_external_id TEXT,
      catalog_level INTEGER, catalog_name TEXT, catalog_path TEXT,
      evidence_type TEXT, query_fingerprint TEXT, observed_at TEXT
    );
    CREATE TABLE question_facets (
      provider TEXT, question_external_id TEXT, dimension TEXT, value TEXT,
      evidence_type TEXT, query_fingerprint TEXT, observed_at TEXT
    );
    CREATE TABLE question_assets (
      provider TEXT, question_external_id TEXT, source_url TEXT, asset_type TEXT,
      local_path TEXT, sha256 TEXT, mime_type TEXT, byte_size INTEGER, observed_at TEXT
    );
  `);
  const now = '2026-08-24T00:00:00.000Z';
  db.prepare('INSERT INTO textbook_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'test',
    'c1',
    'tb1',
    null,
    1,
    'chapter',
    'Chapter 1',
    '/c1',
    now,
    now,
  );
  db.prepare('INSERT INTO textbook_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'test',
    'c2',
    'tb1',
    'c1',
    2,
    'section',
    'Section 1',
    '/c1/s1',
    now,
    now,
  );
  const url = 'https://assets.example/image.png';
  const raw = { externalId: 'q1', useCount: 99, year: '2025', providerLabels: [] };
  const q = [
    'test',
    'q1',
    1,
    'c1',
    'https://example/q1',
    'source',
    'title',
    'https://example/source',
    '单选题',
    '1101',
    '适中',
    '2',
    0.5,
    `<p>Question <img src="${url}"></p>`,
    'Question',
    sha256('old'),
    sha256('list'),
    sha256('detail'),
    1,
    0,
    1,
    1,
    0,
    0,
    0,
    7,
    '2026-08-20',
    null,
    now,
    now,
    JSON.stringify(raw),
  ];
  const insertQuestion = db.prepare(
    'INSERT INTO questions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertQuestion.run(...q);
  if (duplicateQuestion) insertQuestion.run(...q);
  db.prepare('INSERT INTO question_knowledge VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'test',
    'q1',
    'k1',
    'Knowledge',
    'knowledge_point',
    'provider_asserted',
    now,
  );
  db.prepare('INSERT INTO question_catalog_memberships VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'test',
    'q1',
    orphan ? 'missing' : 'c2',
    2,
    'Section 1',
    '/c1/s1',
    'query_membership',
    'fp',
    now,
  );
  db.prepare('INSERT INTO question_facets VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'test',
    'q1',
    'scene',
    '作业',
    'query_membership',
    'fp',
    now,
  );
  const assets =
    assetOrder === 'reverse'
      ? [['test', 'q1', url, 'image', null, null, 'image/png', null, now]]
      : [['test', 'q1', url, 'image', null, null, 'image/png', null, now]];
  const insertAsset = db.prepare('INSERT INTO question_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of assets) insertAsset.run(...row);
  db.close();
  return dbPath;
}

function metadata() {
  return {
    provider: 'test',
    versionName: 'v1',
    textbookName: 'Textbook',
    versionExternalId: 'v1',
    textbookExternalId: 'tb1',
    volume: '上册',
  };
}

function evidence() {
  return { scope: { chapters: ['c1'] }, completed: true };
}

function build(dir, source, name = 'sample.qbpkg', extra = {}) {
  return buildPackage({
    sourceDb: source,
    output: path.join(dir, name),
    metadata: metadata(),
    rangeEvidence: evidence(),
    fullSnapshot: true,
    createdAt: '2026-08-24T00:00:00.000Z',
    batchNo: 'test-batch',
    ...extra,
  });
}

test('构建成功、验证通过，映射七张正式表与 use_count', () => {
  const dir = tempDir();
  const result = build(dir, sourceDb(dir));
  assert.equal(result.validation.pass, true);
  const report = verifyPackage(result.outputPath, { throwOnError: false });
  assert.equal(report.pass, true);
  const unpack = path.join(dir, 'unpack');
  fs.mkdirSync(unpack);
  const { spawnSync } = require('node:child_process');
  const unzip = spawnSync('/usr/bin/unzip', ['-q', result.outputPath, '-d', unpack], { encoding: 'utf8' });
  assert.equal(unzip.status, 0);
  const snapshot = new DatabaseSync(path.join(unpack, 'snapshot.sqlite3'), { readOnly: true });
  const q = snapshot
    .prepare(
      'SELECT assemble_count, reference_count, answer_html, solution_html, answer_status, year, region, exam_type, content_html, source_original_json FROM qb_question',
    )
    .get();
  assert.equal(q.assemble_count, 7);
  assert.equal(q.reference_count, null);
  assert.equal(q.answer_html, null);
  assert.equal(q.solution_html, null);
  assert.equal(q.answer_status, 'not_collected');
  assert.equal(q.year, '2025');
  assert.equal(q.region, null);
  assert.equal(q.exam_type, null);
  assert.match(q.content_html, /data-asset-key="image-[a-f0-9]{16}"/);
  assert.doesNotThrow(() => JSON.parse(q.source_original_json));
  snapshot.close();
});

test('篡改成员后验证失败', () => {
  const dir = tempDir();
  const result = build(dir, sourceDb(dir));
  const unpack = path.join(dir, 'tamper');
  fs.mkdirSync(unpack);
  const { spawnSync } = require('node:child_process');
  assert.equal(spawnSync('/usr/bin/unzip', ['-q', result.outputPath, '-d', unpack]).status, 0);
  fs.appendFileSync(path.join(unpack, 'diff-report.json'), '\n');
  const tampered = path.join(dir, 'tampered.qbpkg');
  assert.equal(
    spawnSync(
      '/usr/bin/zip',
      [
        '-X',
        '-q',
        tampered,
        'diff-report.json',
        'manifest.json',
        'snapshot.sqlite3',
        'validation.json',
        'checksums.sha256',
      ],
      { cwd: unpack },
    ).status,
    0,
  );
  const report = verifyPackage(tampered, { throwOnError: false });
  assert.equal(report.pass, false);
  assert.ok(report.blocking.some((item) => item.code === 'checksum_mismatch'));
});

test('孤儿关系、重复外部 ID 与缺失范围证据会阻断', () => {
  const orphanDir = tempDir();
  assert.throws(
    () => build(orphanDir, sourceDb(orphanDir, { orphan: true }), 'orphan.qbpkg'),
    (error) => {
      assert.ok(error instanceof QbPkgValidationError);
      assert.ok(error.report.blocking.some((item) => item.code === 'orphan_catalog_relation'));
      return true;
    },
  );
  const duplicateDir = tempDir();
  assert.throws(
    () => build(duplicateDir, sourceDb(duplicateDir, { duplicateQuestion: true }), 'duplicate.qbpkg'),
    (error) => {
      assert.ok(error.report.blocking.some((item) => item.code === 'duplicate_question_external_id'));
      return true;
    },
  );
  const missingDir = tempDir();
  const missingEvidenceDb = sourceDb(missingDir);
  assert.throws(
    () =>
      buildPackage({
        sourceDb: missingEvidenceDb,
        output: path.join(missingDir, 'missing.qbpkg'),
        metadata: metadata(),
        fullSnapshot: true,
      }),
    (error) => {
      assert.ok(error.report.blocking.some((item) => item.code === 'range_evidence_missing'));
      return true;
    },
  );
});

test('asset_key 与 HTML 映射不依赖素材顺序', () => {
  const urlA = 'https://assets.example/a.png';
  const urlB = 'https://assets.example/b.png';
  const keyA = assetKey('image', urlA);
  const keyB = assetKey('image', urlB);
  const first = new Map([
    [urlA, { assetKey: keyA }],
    [urlB, { assetKey: keyB }],
  ]);
  const second = new Map([
    [urlB, { assetKey: keyB }],
    [urlA, { assetKey: keyA }],
  ]);
  assert.equal(
    normalizeHtml(`<img src="${urlA}"><img src="${urlB}">`, first).html,
    normalizeHtml(`<img src="${urlA}"><img src="${urlB}">`, second).html,
  );
  assert.equal(keyA, `image-${crypto.createHash('sha256').update(urlA).digest('hex').slice(0, 16)}`);
  assert.notEqual(keyA, keyB);
});

test('危险 HTML 标签、事件属性和主动内容 URL 会被清洗', () => {
  for (const html of [
    '<script>alert(1)</script>',
    '<iframe src="https://example.com"></iframe>',
    '<p onclick="alert(1)">x</p>',
    '<a href="javascript:alert(1)">x</a>',
    '<img srcdoc="<script>x</script>">',
  ]) {
    assert.equal(checkHtmlSafety(html).valid, false, html);
    const cleaned = sanitizeHtml(html);
    assert.equal(normalizeHtml(html, new Map()).valid, true, html);
    assert.doesNotMatch(cleaned, /<\/?(?:script|iframe)|\son[a-z]+=|javascript:|srcdoc=/i);
  }
  assert.equal(checkHtmlSafety('<p><strong>安全内容</strong></p>').valid, true);
});

test('ZIP 解压资源上限在实际解压前阻断异常包', () => {
  const report = { blocking: [], warnings: [], checks: [], pass: false };
  const dir = tempDir();
  const packagePath = path.join(dir, 'fake.qbpkg');
  fs.writeFileSync(packagePath, 'zip');
  validateArchiveLimits(
    packagePath,
    [
      { name: 'snapshot.sqlite3', uncompressedSize: 1024, compressedSize: 1 },
      { name: 'asset.bin', uncompressedSize: 4096, compressedSize: 1 },
    ],
    report,
    {
      maxCompressedBytes: 100,
      maxEntries: 1,
      maxMemberBytes: 2048,
      maxTotalBytes: 4096,
      maxCompressionRatio: 2,
    },
  );
  const codes = new Set(report.blocking.map((item) => item.code));
  assert.ok(codes.has('archive_entry_count_exceeded'));
  assert.ok(codes.has('archive_total_size_exceeded'));
  assert.ok(codes.has('archive_member_size_exceeded'));
});

test('固定输入生成相同成员哈希且默认拒绝覆盖', () => {
  const firstDir = tempDir();
  const secondDir = tempDir();
  const first = build(firstDir, sourceDb(firstDir));
  const second = build(secondDir, sourceDb(secondDir));
  const { spawnSync } = require('node:child_process');
  const firstChecksums = spawnSync('/usr/bin/unzip', ['-p', first.outputPath, 'checksums.sha256'], {
    encoding: 'utf8',
  });
  const secondChecksums = spawnSync('/usr/bin/unzip', ['-p', second.outputPath, 'checksums.sha256'], {
    encoding: 'utf8',
  });
  assert.equal(firstChecksums.status, 0);
  assert.equal(secondChecksums.status, 0);
  assert.equal(firstChecksums.stdout, secondChecksums.stdout);
  assert.throws(() => build(firstDir, sourceDb(tempDir())), /目标包已存在/);
});

test('lib/ compatibility facades re-export the src/ implementations', () => {
  assert.equal(require('../lib/run_snapshots.cjs'), require('../src/storage/run_snapshots.cjs'));
  assert.equal(require('../lib/api_store.cjs'), require('../src/storage/readers/index.cjs'));
  for (const name of ['builder', 'index', 'normalize', 'schema', 'util', 'validator']) {
    assert.equal(require(`../lib/qbpkg/${name}.cjs`), require(`../src/qbpkg/${name}.cjs`));
  }
  assert.equal(require('../lib/qbpkg.js'), require('../src/qbpkg/index.cjs'));
});
