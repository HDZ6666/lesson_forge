'use strict';

const diagnostics = require('../shared/diagnostics.cjs');

// One provider row, shared by discovery, content, assets and every manager.
// Connections are short-lived; no SQLite transaction spans network waits.
const { DatabaseSync } = require('node:sqlite');
const { StopCrawlError } = require('../shared/errors.cjs');
const { normalizeHeaders } = require('../sources/zujuan/request.cjs');

class SourcePausedError extends StopCrawlError {
  constructor(state) {
    super(
      state.reason || '来源已暂停，请等待冷却或人工核对',
      state.manualRequired ? 'source_verification' : 'source_cooldown',
    );
    this.name = 'SourcePausedError';
    this.statusCode = 423;
    this.blocked = true;
    this.sourceControl = state;
  }
}

class SourceControl {
  constructor(dbPath, { clock = Date.now } = {}) {
    this.dbPath = dbPath;
    this.clock = clock;
    this.withDb((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS collector_source_control (
        provider TEXT PRIMARY KEY,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        manual_required INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO collector_source_control(provider) VALUES ('zujuan');
    `),
    );
  }

  withDb(fn) {
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec('PRAGMA busy_timeout=1000');
      return fn(db);
    } finally {
      db.close();
    }
  }

  project(row) {
    const cooling = row.cooldown_until > this.clock();
    return {
      provider: 'zujuan',
      paused: Boolean(row.manual_required || cooling),
      manualRequired: Boolean(row.manual_required),
      notBefore: cooling ? new Date(row.cooldown_until).toISOString() : null,
      reason: row.manual_required || cooling ? row.reason : null,
      revision: row.revision,
    };
  }

  status() {
    return this.withDb((db) =>
      this.project(db.prepare("SELECT * FROM collector_source_control WHERE provider='zujuan'").get()),
    );
  }

  assertAllowed() {
    const state = this.status();
    if (state.paused) throw new SourcePausedError(state);
  }

  observe(status, headers = {}, { verification = true } = {}) {
    if (status === 429) {
      const raw = normalizeHeaders(headers)['retry-after'];
      const numeric = Number(raw);
      let delay = raw && Number.isFinite(numeric) ? numeric * 1000 : Date.parse(raw || '') - this.clock();
      // Retry-After may extend the pause; malformed or zero values never
      // make a throttled source immediately runnable.
      if (!Number.isFinite(delay)) delay = 60000;
      const until = Math.min(8640000000000000, this.clock() + Math.max(60000, delay));
      this.withDb((db) =>
        db
          .prepare(
            `UPDATE collector_source_control
        SET cooldown_until=MAX(cooldown_until,?),
            reason=CASE WHEN manual_required=1 THEN reason ELSE ? END,
            revision=revision+1 WHERE provider='zujuan'`,
          )
          .run(until, '来源返回 HTTP 429，等待公共冷却'),
      );
      diagnostics.write('source_cooldown_enter', { status, state: this.status() });
      this.assertAllowed();
    }
    if (verification && [401, 403, 405].includes(status))
      this.requireManual(`来源返回 HTTP ${status}，请人工核对访问状态`);
  }

  markManual(reason = '来源要求验证，请人工核对后恢复') {
    this.withDb((db) =>
      db
        .prepare(
          `UPDATE collector_source_control
      SET manual_required=1, reason=?, revision=revision+1 WHERE provider='zujuan'`,
        )
        .run(String(reason).slice(0, 500)),
    );
    const state = this.status();
    diagnostics.write('source_manual_enter', { state });
    return state;
  }

  requireManual(reason) {
    this.markManual(reason);
    this.assertAllowed();
  }

  resume(expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error('expectedRevision 必须是非负整数');
    return this.withDb((db) => {
      const result = db
        .prepare(
          `UPDATE collector_source_control SET manual_required=0, revision=revision+1,
        reason=CASE WHEN cooldown_until>? THEN '来源公共冷却尚未结束' ELSE NULL END
        WHERE provider='zujuan' AND revision=?`,
        )
        .run(this.clock(), expectedRevision);
      if (!result.changes) {
        const error = new Error('来源暂停状态已变化，请刷新后核对');
        error.statusCode = 409;
        error.code = 'source_control_conflict';
        throw error;
      }
      // Explicit operator resume cannot shorten a site's Retry-After.
      const state = this.project(db.prepare("SELECT * FROM collector_source_control WHERE provider='zujuan'").get());
      diagnostics.write('source_manual_resume', { state });
      return state;
    });
  }
}

module.exports = { SourceControl, SourcePausedError };
