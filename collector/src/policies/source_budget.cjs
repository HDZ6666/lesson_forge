'use strict';

const { DatabaseSync } = require('node:sqlite');
const { StopCrawlError } = require('../shared/errors.cjs');

function nonnegativeLimit(value, name) {
  if (value == null || value === '') return 0;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${name} 必须是非负整数，0 表示未配置保护上限`);
  return Number(value);
}

function scaledLimit(value, name, scale) {
  const limit = nonnegativeLimit(value, name) * scale;
  if (!Number.isSafeInteger(limit)) throw new Error(`${name} 超过可安全计数的上限`);
  return limit;
}

class SourceBudgetError extends StopCrawlError {
  constructor(state) {
    super(state.reason || '来源当日预算已用完，等待下一窗口', 'source_budget');
    this.name = 'SourceBudgetError';
    this.statusCode = 423;
    this.blocked = true;
    this.budget = state;
  }
}

class SourceBudget {
  constructor(dbPath, { clock = Date.now, requestLimit, bookLimit, activeSeconds, downloadMiB } = {}) {
    this.dbPath = dbPath;
    this.clock = clock;
    this.defaults = {
      requests: nonnegativeLimit(
        requestLimit ?? process.env.COLLECTOR_SOURCE_DAILY_REQUEST_LIMIT,
        'COLLECTOR_SOURCE_DAILY_REQUEST_LIMIT',
      ),
      books: nonnegativeLimit(
        bookLimit ?? process.env.COLLECTOR_SOURCE_DAILY_BOOK_LIMIT,
        'COLLECTOR_SOURCE_DAILY_BOOK_LIMIT',
      ),
      activeMilliseconds: scaledLimit(
        activeSeconds ?? process.env.COLLECTOR_SOURCE_DAILY_ACTIVE_SECONDS,
        'COLLECTOR_SOURCE_DAILY_ACTIVE_SECONDS',
        1000,
      ),
      downloadBytes: scaledLimit(
        downloadMiB ?? process.env.COLLECTOR_SOURCE_DAILY_DOWNLOAD_MIB,
        'COLLECTOR_SOURCE_DAILY_DOWNLOAD_MIB',
        1024 * 1024,
      ),
    };
    this.limits = { ...this.defaults };
    this.revision = 0;
    this.initialized = false;
    this.timing = null;
    this.timer = null;
    this.withDb((db) => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS collector_budget_settings (
        provider TEXT PRIMARY KEY, revision INTEGER NOT NULL, limits_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collector_source_usage (
        provider TEXT NOT NULL, day TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0, book_starts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(provider, day)
      );
      CREATE TABLE IF NOT EXISTS collector_budget_starts (
        run_key TEXT PRIMARY KEY, run_type TEXT NOT NULL, day TEXT NOT NULL
      );
      `);
      const columns = new Set(
        db
          .prepare('PRAGMA table_info(collector_source_usage)')
          .all()
          .map((row) => row.name),
      );
      for (const name of ['active_ms', 'download_bytes']) {
        if (!columns.has(name))
          db.exec(`ALTER TABLE collector_source_usage ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
      }
    }, true);
    this.initialized = true;
  }

  withDb(fn, transaction = false) {
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec('PRAGMA busy_timeout=1000');
      if (transaction) db.exec('BEGIN IMMEDIATE');
      if (this.initialized) {
        const settings = db.prepare("SELECT * FROM collector_budget_settings WHERE provider='zujuan'").get();
        this.limits = settings ? JSON.parse(settings.limits_json) : { ...this.defaults };
        this.revision = settings?.revision || 0;
      }
      const result = fn(db);
      if (transaction) db.exec('COMMIT');
      return result;
    } catch (error) {
      if (transaction) {
        try {
          db.exec('ROLLBACK');
        } catch {}
      }
      throw error;
    } finally {
      db.close();
    }
  }

  day() {
    return new Date(this.clock()).toISOString().slice(0, 10);
  }

  usage(db, day = this.day()) {
    return (
      db.prepare("SELECT * FROM collector_source_usage WHERE provider='zujuan' AND day=?").get(day) || {
        day,
        requests: 0,
        book_starts: 0,
        active_ms: 0,
        download_bytes: 0,
      }
    );
  }

  project(row, runType = 'content', { reservedTime = false } = {}) {
    const reasons = [];
    if (this.limits.requests > 0 && row.requests >= this.limits.requests)
      reasons.push('来源当日主动采集请求预算已用完');
    if (runType === 'content' && this.limits.books > 0 && row.book_starts >= this.limits.books)
      reasons.push('来源当日教材启动预算已用完');
    if (!reservedTime && this.limits.activeMilliseconds > 0 && row.active_ms >= this.limits.activeMilliseconds)
      reasons.push('来源当日采集占用时长预算已用完');
    if (this.limits.downloadBytes > 0 && row.download_bytes >= this.limits.downloadBytes)
      reasons.push('来源当日素材下载预算已用完');
    const next = new Date(`${row.day}T00:00:00Z`).getTime() + 86400000;
    return {
      provider: 'zujuan',
      day: row.day,
      limits: { ...this.limits },
      revision: this.revision,
      resetAt: new Date(next).toISOString(),
      settings: {
        requests: this.limits.requests,
        books: this.limits.books,
        activeSeconds: this.limits.activeMilliseconds / 1000,
        downloadMiB: this.limits.downloadBytes / 1048576,
      },
      usage: {
        requests: row.requests,
        bookStarts: row.book_starts,
        activeMilliseconds: row.active_ms,
        downloadBytes: row.download_bytes,
      },
      paused: reasons.length > 0,
      manualRequired: false,
      reason: reasons.join('；') || null,
      notBefore: reasons.length ? new Date(next).toISOString() : null,
      requestAndBookLimitsConfigured: this.limits.requests > 0 && this.limits.books > 0,
      allDailyLimitsConfigured: Object.values(this.limits).every((limit) => limit > 0),
    };
  }

  status(runType = 'content') {
    return this.withDb((db) => this.project(this.usage(db), runType));
  }

  updateSettings(input) {
    for (const key of ['expectedRevision', 'requests', 'books', 'activeSeconds', 'downloadMiB']) {
      if (!Number.isSafeInteger(input?.[key]) || input[key] < 0) throw new Error(`${key} 必须是非负整数`);
    }
    const limits = {
      requests: input.requests,
      books: input.books,
      activeMilliseconds: scaledLimit(input.activeSeconds, 'activeSeconds', 1000),
      downloadBytes: scaledLimit(input.downloadMiB, 'downloadMiB', 1048576),
    };
    return this.withDb((db) => {
      if (input.expectedRevision !== this.revision) {
        const error = new Error('额度配置已被修改，请刷新后重试');
        error.statusCode = 409;
        throw error;
      }
      this.revision += 1;
      db.prepare(
        "INSERT INTO collector_budget_settings(provider,revision,limits_json) VALUES('zujuan',?,?) ON CONFLICT(provider) DO UPDATE SET revision=excluded.revision,limits_json=excluded.limits_json",
      ).run(this.revision, JSON.stringify(limits));
      this.limits = limits;
      return this.project(this.usage(db));
    }, true);
  }

  assertCanStart(runType = 'content') {
    const state = this.status(runType);
    if (state.paused) throw new SourceBudgetError(state);
  }

  ensureDay(db, day = this.day()) {
    db.prepare("INSERT OR IGNORE INTO collector_source_usage(provider,day) VALUES('zujuan',?)").run(day);
    return this.usage(db, day);
  }

  startRun(runKey, runType) {
    if (
      !['content', 'metadata'].includes(runType) ||
      !/^(content|metadata):[1-9]\d*$/.test(String(runKey)) ||
      !String(runKey).startsWith(`${runType}:`)
    )
      throw new Error('预算只接受确定的来源运行身份');
    return this.withDb((db) => {
      if (db.prepare('SELECT run_key FROM collector_budget_starts WHERE run_key=?').get(runKey)) return false;
      const row = this.ensureDay(db);
      const state = this.project(row, runType);
      if (state.paused) throw new SourceBudgetError(state);
      db.prepare('INSERT INTO collector_budget_starts(run_key,run_type,day) VALUES(?,?,?)').run(
        runKey,
        runType,
        row.day,
      );
      if (runType === 'content')
        db.prepare("UPDATE collector_source_usage SET book_starts=book_starts+1 WHERE provider='zujuan' AND day=?").run(
          row.day,
        );
      return true;
    }, true);
  }

  request() {
    this.assertRunning();
    return this.withDb((db) => {
      const row = this.ensureDay(db);
      // Book-start allowance never stops a book already running.
      const state = this.project(row, 'metadata', {
        reservedTime: Boolean(this.timing && this.timing.until > this.clock()),
      });
      if (state.paused) throw new SourceBudgetError(state);
      db.prepare("UPDATE collector_source_usage SET requests=requests+1 WHERE provider='zujuan' AND day=?").run(
        row.day,
      );
      return row.requests + 1;
    }, true);
  }

  startTiming() {
    if (this.timing) throw new Error('采集时长计数已经启动');
    this.timing = { until: this.clock(), error: null };
    try {
      this.meterTime();
    } catch (error) {
      this.timing = null;
      throw error;
    }
    // Precharge at most one future second so a process crash cannot erase
    // elapsed use. Unused credit is deliberately not refunded on shutdown.
    this.timer = setInterval(() => {
      try {
        this.meterTime();
      } catch (error) {
        this.timing.error = error;
      }
    }, 500);
    this.timer.unref?.();
  }

  meterTime() {
    if (!this.timing) return;
    if (this.timing.error) throw this.timing.error;
    const now = this.clock();
    if (now < this.timing.until) return;
    const end = now + 1000;
    let denied = null;
    let until = this.timing.until;
    this.withDb((db) => {
      while (until < end) {
        const day = new Date(until).toISOString().slice(0, 10);
        const midnight = Date.parse(`${day}T00:00:00Z`) + 86400000;
        const needed = Math.min(end, midnight) - until;
        const row = this.ensureDay(db, day);
        const available =
          this.limits.activeMilliseconds > 0 ? Math.max(0, this.limits.activeMilliseconds - row.active_ms) : needed;
        const granted = Math.min(available, needed);
        db.prepare("UPDATE collector_source_usage SET active_ms=active_ms+? WHERE provider='zujuan' AND day=?").run(
          granted,
          day,
        );
        until += granted;
        if (granted < needed) {
          denied = new SourceBudgetError(this.project(this.usage(db, day), 'metadata'));
          break;
        }
      }
    }, true);
    this.timing.until = until;
    if (denied) {
      this.timing.error = denied;
      throw denied;
    }
  }

  assertRunning() {
    this.meterTime();
  }

  stopTiming() {
    clearInterval(this.timer);
    this.timer = null;
    this.timing = null;
  }

  downloadReceived(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('素材字节计数必须是非负安全整数');
    const state = this.withDb((db) => {
      const row = this.ensureDay(db);
      const total = row.download_bytes + bytes;
      if (!Number.isSafeInteger(total)) throw new Error('素材字节计数超过安全上限');
      // Count bytes already received even when this chunk crosses the cap;
      // committing first prevents retries/restarts from hiding failed bodies.
      db.prepare("UPDATE collector_source_usage SET download_bytes=? WHERE provider='zujuan' AND day=?").run(
        total,
        row.day,
      );
      return this.project(this.usage(db, row.day), 'metadata', { reservedTime: true });
    }, true);
    if (this.limits.downloadBytes > 0 && state.usage.downloadBytes > this.limits.downloadBytes)
      throw new SourceBudgetError(state);
    this.assertRunning();
    return state.usage.downloadBytes;
  }
}

module.exports = { SourceBudget, SourceBudgetError, nonnegativeLimit };
