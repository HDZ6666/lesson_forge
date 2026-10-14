'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { downloadAsset, prefetchAssets } = require('../src/assets/download.cjs');
const { isClosedContextError, isTextbookFatalError } = require('../src/sources/zujuan/response_classifier.cjs');
const { failureStatus } = require('../src/jobs/question/run_seal.cjs');

const closedContext = (calls) => ({
  request: {
    get: async () => {
      calls.push(1);
      throw new Error('apiRequestContext.get: Target page, context or browser has been closed');
    },
  },
});

test('E10: a closed browser context stops asset requests without retries', async () => {
  const calls = [];
  await assert.rejects(
    downloadAsset(
      closedContext(calls),
      { sleepFn: async () => {}, timeout: 10 },
      {
        sourceUrl: 'https://img.xkw.com/dksih/QBM/2026/1/1/a.png',
        assetType: 'image',
      },
    ),
    (error) => error.code === 'browser_context_closed' && error.contextClosed === true,
  );
  assert.equal(calls.length, 1, 'no retry on a closed context');
});

test('E10: prefetch stops the whole pool once the context is closed', async () => {
  let started = 0;
  const assets = Array.from({ length: 20 }, (_, index) => ({ sourceUrl: `https://img.xkw.com/${index}.png` }));
  await assert.rejects(
    prefetchAssets(assets, {
      concurrency: 2,
      cache: new Map(),
      download: async () => {
        started += 1;
        const error = new Error('closed');
        error.contextClosed = true;
        throw error;
      },
    }),
    (error) => error.contextClosed === true,
  );
  assert.ok(started <= 2, `started ${started} downloads after close`);
});

test('E10: closed context ends the run as resumable interruption, not a catalog stall', () => {
  const error = new Error('page.evaluate: Target page, context or browser has been closed');
  assert.equal(isClosedContextError(error), true);
  assert.equal(isTextbookFatalError(error), true);
  assert.equal(failureStatus(Object.assign(new Error('x'), { code: 'browser_context_closed' })), 'interrupted');
});

test('E10: a stop request never reopens the browser', async () => {
  const { BrowserSession } = require('../src/jobs/question/browser_session.cjs');
  let reopened = 0;
  const session = new BrowserSession({
    opts: {},
    dependencies: { context: {}, page: {}, reopenBrowser: async () => (reopened += 1) },
    resourceGuard: { status: () => ({}), limits: {} },
    browserMb: () => null,
    heartbeat: () => {},
    assertNotStopped: () => {
      throw Object.assign(new Error('stop requested'), { code: 'stop_requested' });
    },
  });
  await assert.rejects(session.recoverClosedContext(new Error('closed')), /stop requested/);
  assert.equal(reopened, 0);
});
