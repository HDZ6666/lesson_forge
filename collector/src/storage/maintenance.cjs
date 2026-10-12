'use strict';

const { DatabaseSync } = require('node:sqlite');

/**
 * Folds the WAL into the main database and truncates it to zero bytes.
 *
 * WAL mode lets the -wal file grow to the largest write burst it has seen
 * and keeps it at that size. A long crawl or a reclaim can leave hundreds of
 * MB behind. Run only while no crawl is active. If a reader holds an old
 * snapshot, SQLite reports busy=1 and the file is left alone.
 *
 * Freed pages inside the database are deliberately not VACUUMed: new crawls
 * reuse them, and VACUUM needs a second database-sized copy on disk.
 */
function checkpointDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout=2000');
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() || {};
    const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
    return {
      busy: Number(row.busy) === 1,
      walPages: Number(row.log),
      checkpointedPages: Number(row.checkpointed),
      reusableDatabaseBytes: Number(db.prepare('PRAGMA freelist_count').get().freelist_count) * pageSize,
    };
  } finally {
    db.close();
  }
}

module.exports = { checkpointDatabase };
