'use strict';

/**
 * Worker thread body for ReaderPool: runs one read-only reader per message.
 * See reader_pool.cjs.
 */

const { parentPort } = require('node:worker_threads');

const readers = require('../storage/readers/index.cjs');
const { READER_NAMES, packResult, serializeError } = require('./reader_pool.cjs');

const ALLOWED = new Set(READER_NAMES);

parentPort.on('message', ({ id, name, args }) => {
  try {
    if (!ALLOWED.has(name)) throw new Error(`未知读取函数：${name}`);
    const result = readers[name](...(Array.isArray(args) ? args : []));
    parentPort.postMessage({ id, ok: true, result: packResult(name, result) });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: serializeError(error) });
  }
});
