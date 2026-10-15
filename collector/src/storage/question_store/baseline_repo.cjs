'use strict';

/**
 * Durable incremental-location evidence per textbook + catalog + query.
 *
 * Kept outside run snapshots: reclaiming an imported snapshot must not lose
 * the head ID groups, reliable range and gaps the next increment needs.
 */

function ensureBaselineSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_baselines (
      scope_key TEXT PRIMARY KEY,
      textbook_external_id TEXT NOT NULL,
      catalog_external_id TEXT NOT NULL,
      confirmed_json TEXT,
      candidate_json TEXT,
      confirmed_run_id INTEGER,
      candidate_run_id INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_baselines_textbook
      ON catalog_baselines(textbook_external_id, catalog_external_id);
  `);
}

const parse = (text) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

class BaselineMethods {
  getCatalogBaseline(scopeKey) {
    ensureBaselineSchema(this.db);
    const row = this.db.prepare('SELECT * FROM catalog_baselines WHERE scope_key=?').get(String(scopeKey));
    if (!row) return { confirmed: null, candidate: null };
    return {
      confirmed: parse(row.confirmed_json),
      candidate: parse(row.candidate_json),
      confirmedRunId: row.confirmed_run_id,
      candidateRunId: row.candidate_run_id,
      updatedAt: row.updated_at,
    };
  }

  /** Replace the confirmed baseline only when given; a candidate never overwrites it. */
  saveCatalogBaseline({ scopeKey, textbookExternalId, catalogExternalId, runId, confirmed, candidate }) {
    ensureBaselineSchema(this.db);
    const now = new Date().toISOString();
    const current = this.db.prepare('SELECT * FROM catalog_baselines WHERE scope_key=?').get(String(scopeKey));
    const confirmedJson = confirmed === undefined ? (current?.confirmed_json ?? null) : JSON.stringify(confirmed);
    const confirmedRun = confirmed === undefined ? (current?.confirmed_run_id ?? null) : runId;
    const candidateJson = candidate ? JSON.stringify(candidate) : null;
    this.db
      .prepare(
        `INSERT INTO catalog_baselines(scope_key,textbook_external_id,catalog_external_id,confirmed_json,candidate_json,
           confirmed_run_id,candidate_run_id,updated_at) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(scope_key) DO UPDATE SET confirmed_json=excluded.confirmed_json,
           candidate_json=excluded.candidate_json, confirmed_run_id=excluded.confirmed_run_id,
           candidate_run_id=excluded.candidate_run_id, updated_at=excluded.updated_at`,
      )
      .run(
        String(scopeKey),
        String(textbookExternalId),
        String(catalogExternalId),
        confirmedJson,
        candidateJson,
        confirmedRun,
        candidate ? runId : null,
        now,
      );
  }
}

module.exports = { BaselineMethods, ensureBaselineSchema };
