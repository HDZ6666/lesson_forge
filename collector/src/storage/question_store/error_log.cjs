'use strict';

/**
 * Bounded error log rows for one run.
 *
 * Methods are mixed into QuestionSyncStore.prototype (see index.cjs); `this`
 * is the store instance (`this.db`, `this.dataDir`).
 */

const { nowIso } = require('../../shared/utils.cjs');

class ErrorLogMethods {
  recordError(runId, stage, error, sourceUrl = null) {
    this.db.prepare(`
      INSERT INTO sync_errors (run_id, source_url, stage, error_code, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      Number(runId), sourceUrl, String(stage), String(error?.code || error?.name || 'error'),
      String(error?.message || error), nowIso(),
    );
  }


}

module.exports = { ErrorLogMethods };
