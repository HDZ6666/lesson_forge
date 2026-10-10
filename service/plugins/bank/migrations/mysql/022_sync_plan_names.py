"""Names identify persistent plans and their dated execution rounds."""
from sqlalchemy import text


async def run(query_db):
    columns = {row[0] for row in (await query_db.execute(text('SHOW COLUMNS FROM qb_sync_plan'))).all()}
    for name, definition in {
        'plan_name': "VARCHAR(100) NOT NULL DEFAULT ''",
        'cycle_name': 'VARCHAR(180) NULL',
    }.items():
        if name not in columns:
            await query_db.execute(text(f'ALTER TABLE qb_sync_plan ADD COLUMN {name} {definition}'))
    await query_db.execute(text(
        "UPDATE qb_sync_plan p JOIN qb_subject s ON s.subject_id=p.subject_id "
        "SET p.plan_name=CONCAT(s.subject_name,'同步') WHERE p.plan_name=''"
    ))
