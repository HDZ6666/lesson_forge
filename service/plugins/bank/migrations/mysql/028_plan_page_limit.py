"""Give existing and new plans a bounded per-catalog page policy."""
from sqlalchemy import text


async def run(query_db):
    columns = {r[0] for r in (await query_db.execute(text('SHOW COLUMNS FROM qb_sync_plan'))).all()}
    if 'catalog_page_limit' not in columns:
        await query_db.execute(text(
            'ALTER TABLE qb_sync_plan ADD COLUMN catalog_page_limit INT NOT NULL DEFAULT 1000'
        ))
