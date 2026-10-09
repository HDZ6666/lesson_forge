"""Persist optional sealed source/scan evidence; existing imports stay unknown."""

from sqlalchemy import text


async def run(query_db):
    columns = {row[0] for row in (await query_db.execute(text('SHOW COLUMNS FROM qb_question_import'))).all()}
    if 'run_coverage_json' not in columns:
        await query_db.execute(text('ALTER TABLE qb_question_import ADD COLUMN run_coverage_json JSON NULL'))


__all__ = ['run']
