'use strict';

// Test double for src/api/reader_worker.cjs: same message protocol, fake readers.
const fs = require('node:fs');
const { parentPort } = require('node:worker_threads');
const { packResult, serializeError } = require('../../../src/api/reader_pool.cjs');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const fake = {
  readCandidates(ms) {
    sleep(Number(ms) || 0);
    return { slept: Number(ms) || 0, threadId: require('node:worker_threads').threadId };
  },
  readCatalogProgress() {
    throw Object.assign(new Error('运行不存在'), { statusCode: 404, code: 'run_not_found' });
  },
  readRunAsset(filePath) {
    const result = { contentLength: fs.statSync(filePath).size, contentType: 'text/plain' };
    Object.defineProperty(result, 'fileDescriptor', { value: fs.openSync(filePath, 'r'), enumerable: false });
    return result;
  },
};

parentPort.on('message', ({ id, name, args }) => {
  try {
    parentPort.postMessage({ id, ok: true, result: packResult(name, fake[name](...args)) });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: serializeError(error) });
  }
});
