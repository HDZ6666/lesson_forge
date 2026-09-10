'use strict';

const path = require('node:path');

const COLLECTOR_ROOT = path.resolve(__dirname, '..', '..', '..');
const METADATA_SCRIPT = path.join(COLLECTOR_ROOT, 'zujuan_metadata_sync.cjs');
const QUESTION_SCRIPT = path.join(COLLECTOR_ROOT, 'zujuan_question_sync.cjs');
const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancelling']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'blocked', 'interrupted', 'cancelled']);
const MAX_LOG_LINES = 160;
const MAX_STORED_JOBS = 100;
const SITE_PAGE_LIMIT = 1000;
const DEFAULT_JOB_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALL_TIMEOUT_MS = 20 * 60 * 1000;
const KILL_GRACE_MS = 60000;
const WATCHDOG_MAX_TICK_MS = 5000;
const HEARTBEAT_WRITE_MS = 10000;
const PERSIST_INTERVAL_MS = 1000;
// A row whose owner process is alive but has not written a heartbeat for this
// long is treated as abandoned (hung API process or reused pid).
const ORPHAN_HEARTBEAT_MS = 3 * 60 * 1000;
// Structured error codes the child reports for real source protection.  They
// map to the `blocked` terminal status without scanning log text.
const BLOCKED_ERROR_CODES = new Set([
  'verification_required', 'waiting_verification', 'json_html', 'http_401', 'http_403',
  'robots_disallowed', 'protection_block', 'blocked',
]);

module.exports = {
  ACTIVE_STATUSES,
  BLOCKED_ERROR_CODES,
  COLLECTOR_ROOT,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  HEARTBEAT_WRITE_MS,
  KILL_GRACE_MS,
  MAX_LOG_LINES,
  MAX_STORED_JOBS,
  METADATA_SCRIPT,
  ORPHAN_HEARTBEAT_MS,
  PERSIST_INTERVAL_MS,
  QUESTION_SCRIPT,
  SITE_PAGE_LIMIT,
  TERMINAL_STATUSES,
  WATCHDOG_MAX_TICK_MS,
};
