'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pruneRetention } = require('../src/storage/retention.cjs');

test('raw pages of clean or reclaimed runs expire; failed runs and recent days keep evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sync_runs(id INTEGER PRIMARY KEY, status TEXT, snapshot_locked_at TEXT);
    CREATE TABLE sync_result_cleanup(run_id INTEGER PRIMARY KEY);
    INSERT INTO sync_runs VALUES(1,'success','x'),(2,'failed','x'),(3,'interrupted',NULL);
    INSERT INTO sync_result_cleanup VALUES(3);`);
  const now = Date.parse('2026-10-14T00:00:00Z');
  for (const [day, run] of [
    ['2026-10-01', 1],
    ['2026-10-01', 2],
    ['2026-10-01', 3],
    ['2026-10-13', 1],
  ]) {
    const target = path.join(dir, 'raw', day, `run-${run}`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'p.json.gz'), 'x');
  }
  fs.mkdirSync(path.join(dir, 'diagnostics'));
  const old = path.join(dir, 'diagnostics', 'events-2026-09-01-1.jsonl.gz');
  fs.writeFileSync(old, 'x');
  fs.utimesSync(old, new Date('2026-09-01'), new Date('2026-09-01'));
  fs.writeFileSync(path.join(dir, 'diagnostics', 'job-new.jsonl.gz'), 'x');
  try {
    const result = pruneRetention(dir, db, { now });
    assert.equal(result.rawRuns, 2);
    assert.equal(result.keptRawRuns, 1);
    assert.ok(fs.existsSync(path.join(dir, 'raw', '2026-10-01', 'run-2')));
    assert.ok(fs.existsSync(path.join(dir, 'raw', '2026-10-13', 'run-1')));
    assert.equal(result.diagnosticsFiles, 1);
    assert.ok(fs.existsSync(path.join(dir, 'diagnostics', 'job-new.jsonl.gz')));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
