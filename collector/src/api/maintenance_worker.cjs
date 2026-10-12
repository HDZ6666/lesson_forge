'use strict';

/** Worker thread body for Maintenance: runs exactly one task, then exits. */

const { parentPort, workerData } = require('node:worker_threads');
const { runTask, serializeError } = require('./maintenance.cjs');

try {
  const result = runTask(workerData.name, Array.isArray(workerData.args) ? workerData.args : []);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: serializeError(error) });
}
