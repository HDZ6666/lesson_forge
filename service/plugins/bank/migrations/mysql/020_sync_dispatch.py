"""Separate durable single-book waiting tasks from the execution slot."""

from sqlalchemy import text


async def run(query_db):
    columns = {row[0] for row in (await query_db.execute(text('SHOW COLUMNS FROM qb_sync_job'))).all()}
    additions = {
        'dispatch_book_key': 'CHAR(64) NULL',
        'dispatch_job_id': 'CHAR(36) NULL',
        'dispatch_not_before': 'DATETIME(6) NULL',
        'dispatch_error': 'VARCHAR(500) NULL',
    }
    for name, definition in additions.items():
        if name not in columns:
            await query_db.execute(text(f'ALTER TABLE qb_sync_job ADD COLUMN {name} {definition}'))
    indexes = {row[2] for row in (await query_db.execute(text('SHOW INDEX FROM qb_sync_job'))).all()}
    if 'uk_qb_sync_job_dispatch_book' not in indexes:
        await query_db.execute(text(
            'CREATE UNIQUE INDEX uk_qb_sync_job_dispatch_book ON qb_sync_job (dispatch_book_key)',
        ))
    if 'idx_qb_sync_job_dispatch_due' not in indexes:
        await query_db.execute(text(
            'CREATE INDEX idx_qb_sync_job_dispatch_due '
            'ON qb_sync_job (status, active_slot, dispatch_not_before, run_id)',
        ))


__all__ = ['run']
