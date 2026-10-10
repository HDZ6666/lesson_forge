"""Existing plans retain the production one-page default."""
from sqlalchemy import text


async def run(query_db):
    columns = {r[0] for r in (await query_db.execute(text('SHOW COLUMNS FROM qb_sync_plan'))).all()}
    if 'list_concurrency' not in columns:
        await query_db.execute(text('ALTER TABLE qb_sync_plan ADD COLUMN list_concurrency INT NOT NULL DEFAULT 1'))
