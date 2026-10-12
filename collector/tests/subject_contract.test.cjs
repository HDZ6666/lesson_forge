'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeIndependentTextbookScopes } = require('../src/api/request_validation.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs: questionArgs } = require('../src/cli/question_sync_cli.cjs');
const { parseArgs: metadataArgs } = require('../src/cli/metadata_sync_cli.cjs');
const { QuestionSyncStore } = require('../src/storage/question_store/index.cjs');
const { runSync } = require('../src/jobs/question_run.cjs');
const { runDiscovery } = require('../src/jobs/metadata_run.cjs');
const { JobStore } = require('../src/api/job_store.cjs');

function payload(ids) {
  return {
    textbookExternalIds: ids,
    textbookScopes: ids.map((id) => ({
      sourceProvider: 'zujuan',
      externalVersionId: 'v1',
      externalTextbookId: id,
      versionName: '版本',
      textbookName: id,
    })),
  };
}

test('new tasks are single-book; historical scope contract stays readable', () => {
  assert.equal(normalizeIndependentTextbookScopes(payload(['t1'])).scopes.length, 1);
  assert.throws(() => normalizeIndependentTextbookScopes(payload(['t1', 't2'])), /只能选择一本/);
  const historical = { ...payload(['t1', 't2']), workflowVersion: 1 };
  assert.equal(normalizeIndependentTextbookScopes(historical).scopes.length, 2);
});

test('unverified source namespaces cannot run through the math adapter', () => {
  assert.throws(
    () => normalizeIndependentTextbookScopes({ ...payload(['t1']), sourceNamespace: 'zujuan:junior:chinese' }),
    /尚未验证/,
  );
  assert.equal(
    normalizeIndependentTextbookScopes({ ...payload(['t1']), sourceNamespace: 'zujuan:junior:math' }).scopes.length,
    1,
  );
});

test('CLI and direct runners reject unverified subjects before filesystem or browser work', async () => {
  assert.throws(() => questionArgs(['--bank-path', 'czwl']), /尚未验证/);
  assert.throws(() => questionArgs(['--bank-id', '3']), /尚未验证/);
  assert.throws(() => metadataArgs(['--seed-url', 'https://zujuan.xkw.com/czwl/']), /尚未验证/);
  assert.equal(questionArgs([]).sourceNamespace, 'zujuan:junior:math');
  assert.equal(metadataArgs([]).sourceNamespace, 'zujuan:junior:math');
  await assert.rejects(runSync({ bankPath: 'czwl' }), /尚未验证/);
  await assert.rejects(runDiscovery({ bankPath: 'czwl' }), /尚未验证/);
  await assert.rejects(runDiscovery({ bankPath: 'czsx', seedUrl: 'https://zujuan.xkw.com/czwl/' }), /已验证/);
});

test('run namespace is durable and historical math scopes retain the same resume identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-subject-'));
  const store = new QuestionSyncStore(path.join(dir, 'collector.sqlite3'));
  try {
    assert.throws(() => store.beginRun({ textbookId: '1', bankPath: 'czwl' }), /尚未验证/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get().n, 0);
    const runId = store.beginRun({ textbookId: '1' });
    assert.equal(JSON.parse(store.getRun(runId).scope_json).sourceNamespace, 'zujuan:junior:math');
    assert.equal(
      store._scopeIdentity({ textbookId: '1' }),
      store._scopeIdentity({ textbookId: '1', sourceNamespace: 'zujuan:junior:math' }),
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('job restart preserves workflow and source namespace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-job-contract-'));
  const dbPath = path.join(dir, 'collector.sqlite3');
  const store = new JobStore(dbPath);
  store.insertActive({
    id: 'contract',
    runType: 'content',
    status: 'queued',
    workflowVersion: 1,
    sourceNamespace: 'zujuan:junior:math',
  });
  store.close();
  const reopened = new JobStore(dbPath);
  try {
    const job = reopened.load('contract');
    assert.equal(job.workflowVersion, 1);
    assert.equal(job.sourceNamespace, 'zujuan:junior:math');
  } finally {
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
