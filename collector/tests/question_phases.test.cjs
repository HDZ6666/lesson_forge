'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { QuestionSyncError, StopCrawlError, VerificationRequiredError } = require('../src/shared/errors.cjs');
const { BrowserSession } = require('../src/jobs/question/browser_session.cjs');
const { failureStatus, sealCompleted, sealFailed } = require('../src/jobs/question/run_seal.cjs');

const quietGuard = { status: () => ({ pressure: 'ok' }), limits: { memoryGraceMs: 0 } };

function session(overrides = {}, dependencies = {}) {
  return new BrowserSession({
    opts: { browserRecyclePages: 0, browserRecycleMb: 0, ...overrides },
    dependencies,
    resourceGuard: quietGuard,
    browserMb: () => null,
    heartbeat: () => {},
    assertNotStopped: () => {},
  });
}

test('failure status keeps resumable interrupts, blocks and hard failures apart', () => {
  assert.equal(failureStatus(new QuestionSyncError('x', 'stop_requested')), 'interrupted');
  assert.equal(failureStatus(new QuestionSyncError('x', 'browser_recycle_failed')), 'interrupted');
  assert.equal(failureStatus(Object.assign(new Error('x'), { code: 'http_503' })), 'interrupted');
  assert.equal(failureStatus(Object.assign(new Error('x'), { code: 'http_429' })), 'interrupted');
  assert.equal(failureStatus(Object.assign(new Error('x'), { code: 'waiting_verification' })), 'blocked');
  assert.equal(failureStatus(new VerificationRequiredError('x')), 'blocked');
  assert.equal(failureStatus(new StopCrawlError('x', 'resource_pressure')), 'blocked');
  assert.equal(failureStatus(new QuestionSyncError('x', 'catalog_not_found')), 'failed');
  assert.equal(failureStatus(new Error('boom')), 'failed');
});

test('seal steps emit sealed / error events with the run counters', () => {
  const emitted = [];
  const events = { emit: (type, payload) => emitted.push({ type, ...payload }) };
  const finished = [];
  const store = {
    validateRunCompleteness: () => ({ complete: true, scanComplete: true, dataComplete: true, completionQuality: 'complete' }),
    finishRun: (...args) => finished.push(args),
    recordError: () => {},
  };
  const counters = { pagesOk: 3, questionsSeen: 30, errors: 0 };
  const done = sealCompleted({ store, events, runId: 7, scope: {}, selectedCatalogs: [], counters });
  assert.equal(done.status, 'success');
  assert.equal(emitted.at(-1).type, 'sealed');
  assert.equal(emitted.at(-1).snapshotComplete, true);

  let paused = null;
  const error = new QuestionSyncError('需要验证', 'http_403');
  const status = sealFailed(
    { store: { ...store, finishRun: () => { throw new Error('already sealed'); } }, events, runId: 7, scope: {},
      selectedCatalogs: [], counters, sourceControl: { markManual: (reason) => { paused = reason; } } },
    error,
  );
  assert.equal(status, 'failed');
  assert.equal(paused, '需要验证', 'source protection records the shared manual pause');
  assert.equal(counters.errors, 1);
  assert.equal(error.eventEmitted, true);
  assert.deepEqual(emitted.slice(-2).map((event) => event.type), ['error', 'sealed']);
  assert.equal(emitted.at(-1).snapshotComplete, false);
});

test('an injected context is never closed and never recycled without reopenBrowser', async () => {
  let closed = 0;
  const context = { close: async () => { closed += 1; }, pages: () => [] };
  const page = { close: async () => { closed += 1; } };
  const browser = session({}, { context, page });
  assert.equal(browser.canRecycle(), false);
  await browser.dispose();
  assert.equal(closed, 0);
  assert.equal(browser.context, context);
});

test('page trigger counts fetched pages and resets on recycle', async () => {
  const reopened = [];
  const browser = session({ browserRecyclePages: 10 }, {
    context: {},
    page: { goto: async () => {}, url: () => 'https://zujuan.xkw.com/' },
    reopenBrowser: async ({ reason }) => { reopened.push(reason); return {}; },
  });
  browser.notePagesFetched(8);
  assert.equal(browser.recycleReason(), null);
  browser.notePagesFetched(2);
  assert.match(browser.recycleReason(), /10 页/);
  await browser.recycleNow('test').catch(() => {});
  assert.equal(reopened.length, 1);
});

test('invalid recycle settings are rejected as invalid_option', () => {
  assert.throws(() => session({ browserRecyclePages: '-5' }), (error) => error.code === 'invalid_option');
  assert.throws(() => session({ browserRecycleMb: 'lots' }), (error) => error.code === 'invalid_option');
});
