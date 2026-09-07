'use strict';

/**
 * Run-level progress must be computed over the whole selected catalog set.
 * Before 2026-09-07 it divided by the target pages of catalogs that had
 * already started and took the max with the best single catalog, so the bar
 * hit 99% during the first chapter and stayed there (COL-009 follow-up).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { QuestionSyncStore } = require('../src/storage/question_store/index.cjs');
const { parseQuestionListPayload } = require('../src/sources/zujuan/question_parser.cjs');
const { readLiveRunProgress } = require('../lib/api_store.cjs');

const LIST_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'zujuan', 'list-261285-p470-q26996136.card.html'), 'utf8');
const question = (id) => parseQuestionListPayload({ code: '0', data: { total: 1, html: LIST_HTML.replaceAll('26996136', String(id)) } }).questions[0];

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-progress-'));
  const dbPath = path.join(directory, 'collector.sqlite3');
  const store = new QuestionSyncStore(dbPath, { dataDir: directory });
  const runId = store.beginRun({ textbookId: '260617', bankId: 2, bankPath: 'czsx', catalogLevels: [1] });
  // Root probe: 300 questions => 30 pages across the selected level.
  store.updateRunScope(runId, { textbookId: '260617', catalogLevels: [1], textbookExpectedTotal: 300, summaryStrategy: 'textbook_root_probe' });
  const nodes = ['A', 'B', 'C'].map((name, index) => ({
    externalId: `cat-${name}`, name: `第${index + 1}章`, level: 1, type: 'chapter', ancestorIds: [`cat-${name}`], categoryId: `cat-${name}`, catelogTokpointId: '0', sortOrder: index + 1,
  }));
  store.saveCatalogTree(runId, '260617', nodes);
  return { directory, dbPath, store, runId, nodes };
}

function savePages(store, runId, nodes, catalogIndex, pages, expectedTotal, expectedPages) {
  const catalog = { ...nodes[catalogIndex], chapterExternalId: nodes[catalogIndex].externalId };
  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    store.savePage({
      runId, textbookExternalId: '260617', catalog, nodes, pageNumber,
      expectedTotal, expectedPages, questions: [question(`${catalogIndex + 1}000${pageNumber}`)], queryFingerprint: `fp-${catalogIndex}`,
    });
  }
  return catalog;
}

test('进度分母覆盖全部选中目录：第一个目录跑一半时约 17%，而不是 50% 或 99%', () => {
  const { directory, dbPath, store, runId, nodes } = setup();
  try {
    savePages(store, runId, nodes, 0, 5, 100, 10);
    store.close();
    const live = readLiveRunProgress(dbPath, runId, { textbookExternalId: '260617' });
    assert.equal(live.available, true);
    assert.equal(live.selectedCatalogCount, 3);
    assert.equal(live.startedCatalogCount, 1);
    assert.equal(live.completedCatalogCount, 0);
    assert.equal(live.attemptedPages, 5);
    // Started A: target 10.  Unstarted B, C: estimated from A's average (10 each).
    assert.equal(live.estimatedTotalPages, 30);
    assert.equal(live.estimateComplete, true);
    assert.ok(Math.abs(live.progressPercent - 16.7) < 0.2, `expected ≈16.7, got ${live.progressPercent}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('第一个目录完成后进度约 33%，不再被钉在 99%；全部完成为 100', () => {
  const { directory, dbPath, store, runId, nodes } = setup();
  try {
    const catalogA = savePages(store, runId, nodes, 0, 10, 100, 10);
    store.completeCatalog({ runId, textbookExternalId: '260617', catalog: catalogA, expectedTotal: 100, expectedPages: 10, queryFingerprint: 'fp-0' });
    store.close();
    const afterFirst = readLiveRunProgress(dbPath, runId, { textbookExternalId: '260617' });
    assert.equal(afterFirst.completedCatalogCount, 1);
    assert.ok(Math.abs(afterFirst.progressPercent - 33.3) < 0.2, `expected ≈33.3, got ${afterFirst.progressPercent}`);
    assert.ok(afterFirst.progressPercent < 99);

    const store2 = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      // B turns out much smaller than estimated (2 pages): the estimate for C
      // now uses the average of started catalogs ((10 + 2) / 2 = 6).
      const catalogB = savePages(store2, runId, nodes, 1, 2, 20, 2);
      store2.completeCatalog({ runId, textbookExternalId: '260617', catalog: catalogB, expectedTotal: 20, expectedPages: 2, queryFingerprint: 'fp-1' });
    } finally {
      store2.close();
    }
    const afterSecond = readLiveRunProgress(dbPath, runId, { textbookExternalId: '260617' });
    assert.equal(afterSecond.attemptedPages, 12);
    assert.equal(afterSecond.estimatedTotalPages, 18);
    assert.ok(Math.abs(afterSecond.progressPercent - 66.7) < 0.2, `expected ≈66.7, got ${afterSecond.progressPercent}`);

    const store3 = new QuestionSyncStore(dbPath, { dataDir: directory });
    try {
      const catalogC = savePages(store3, runId, nodes, 2, 3, 30, 3);
      store3.completeCatalog({ runId, textbookExternalId: '260617', catalog: catalogC, expectedTotal: 30, expectedPages: 3, queryFingerprint: 'fp-2' });
      const completeness = store3.validateRunCompleteness(runId, { textbookId: '260617', catalogLevels: [1] }, nodes, {});
      store3.finishRun(runId, 'success', {}, null, { ...completeness, scope: { textbookId: '260617' } });
    } finally {
      store3.close();
    }
    const done = readLiveRunProgress(dbPath, runId, { textbookExternalId: '260617' });
    assert.equal(done.progressPercent, 100);
    assert.equal(done.scanComplete, true);
    assert.equal(done.completedCatalogCount, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('没有根总数、也没有同层已开始目录时，进度为未知而不是伪造数字', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-progress-unknown-'));
  const dbPath = path.join(directory, 'collector.sqlite3');
  const store = new QuestionSyncStore(dbPath, { dataDir: directory });
  try {
    const runId = store.beginRun({ textbookId: '260617', bankId: 2, bankPath: 'czsx', catalogLevels: [1, 2] });
    store.updateRunScope(runId, { textbookId: '260617', catalogLevels: [1, 2] });
    const nodes = [
      { externalId: 'ch1', name: '章', level: 1, type: 'chapter', ancestorIds: ['ch1'], categoryId: 'ch1', catelogTokpointId: '0', sortOrder: 1 },
      { externalId: 'sec1', name: '节', level: 2, type: 'section', parentExternalId: 'ch1', ancestorIds: ['ch1', 'sec1'], categoryId: 'sec1', catelogTokpointId: '0', sortOrder: 1 },
    ];
    store.saveCatalogTree(runId, '260617', nodes);
    const catalog = { ...nodes[0], chapterExternalId: 'ch1' };
    store.savePage({ runId, textbookExternalId: '260617', catalog, nodes, pageNumber: 1, expectedTotal: 50, expectedPages: 5, questions: [question('777001')], queryFingerprint: 'fp' });
    store.close();
    const live = readLiveRunProgress(dbPath, runId, { textbookExternalId: '260617' });
    // Level 2 has no started catalog and there is no textbook total: the
    // estimate is incomplete and the percentage only covers what is known.
    assert.equal(live.estimateComplete, false);
    assert.equal(live.knownTargetPages, 5);
    assert.ok(live.progressPercent == null || live.progressPercent <= 20);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
