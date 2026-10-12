'use strict';
// Test double for maintenance_worker.cjs: sleeps args[0] ms, then echoes.
const { parentPort, workerData } = require('node:worker_threads');
const ms = Number(workerData.args?.[0] || 0);
setTimeout(() => {
  if (workerData.args?.[1] === 'fail') {
    parentPort.postMessage({ ok: false, error: { message: '失败', statusCode: 409, code: 'cleanup_latest' } });
  } else parentPort.postMessage({ ok: true, result: { name: workerData.name, ms } });
}, ms);
