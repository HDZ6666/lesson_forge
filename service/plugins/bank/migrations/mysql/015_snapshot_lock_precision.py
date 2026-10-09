"""Preserve the Collector seal timestamp instead of losing milliseconds.

The immutable QC identity compares the actual seal, so both the task binding
and import record must retain its precision. Repeated execution is safe.
"""

from sqlalchemy import text


async def run(query_db):
    for table, nullable in (('qb_sync_job_scope', True), ('qb_question_import', False)):
        column = (await query_db.execute(text(
            f"SHOW COLUMNS FROM `{table}` WHERE Field='snapshot_locked_at'"
        ))).one()
        if column[1].lower() != 'datetime(6)':
            null_clause = 'NULL' if nullable else 'NOT NULL'
            await query_db.execute(text(
                f'ALTER TABLE `{table}` MODIFY COLUMN snapshot_locked_at DATETIME(6) {null_clause}'
            ))


__all__ = ['run']
