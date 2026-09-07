'use strict';

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const { ensureDir, nowIso } = require('./utils.cjs');

const LOCK_SUFFIX = '.lock';

function lockPathFor(dbPath) {
  return `${dbPath}${LOCK_SUFFIX}`;
}

function readLockPid(lockPath) {
  let content;
  try {
    content = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  const trimmed = String(content || '').trim();
  if (!trimmed) return null;
  // Current collectors write `{"pid":...,"startedAt":...}`; older question
  // collectors wrote a bare `pid` line.  Both formats are recognized so a lock
  // left behind by either generation can be classified.
  try {
    const state = JSON.parse(trimmed);
    const pid = Number(state?.pid);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    const pid = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  }
}

function lockIsStale(lockPath) {
  const pid = readLockPid(lockPath);
  if (pid == null || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (probeError) {
    return probeError?.code === 'ESRCH';
  }
}

/**
 * Take the exclusive `${db}.lock` shared by every collector process.
 *
 * A lock left behind by a killed process is reused only after the recorded
 * PID is confirmed dead; malformed locks and live PIDs remain hard failures so
 * two collectors can never overlap on the same SQLite/profile.
 *
 * `options.conflictError(lockPath, cause)` and `options.openError(lockPath,
 * cause)` let callers keep their historical error classes.
 */
function acquireLock(lockPath, options = {}) {
  ensureDir(path.dirname(lockPath));
  const conflictError = options.conflictError
    || ((target) => new Error(`已有同步任务持有锁：${target}。`));
  const openError = options.openError || ((target, cause) => cause);
  const open = () => {
    const descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: nowIso() }));
    return descriptor;
  };
  let fd;
  try {
    fd = open();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw openError(lockPath, error);
    if (!lockIsStale(lockPath)) throw conflictError(lockPath, error);
    try { fs.unlinkSync(lockPath); } catch (unlinkError) {
      throw conflictError(lockPath, unlinkError);
    }
    try {
      fd = open();
    } catch (retryError) {
      throw conflictError(lockPath, retryError);
    }
  }
  return () => {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  };
}

module.exports = {
  LOCK_SUFFIX,
  acquireLock,
  lockPathFor,
  readLockPid,
};
