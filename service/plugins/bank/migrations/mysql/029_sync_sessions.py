"""Group whole-subject rounds into sync sessions; legacy cycles become session N, round 1."""
from sqlalchemy import text


async def _add(db, table, definitions):
    columns = {r[0] for r in (await db.execute(text(f'SHOW COLUMNS FROM {table}'))).all()}
    for name, ddl in definitions.items():
        if name not in columns:
            await db.execute(text(f'ALTER TABLE {table} ADD COLUMN {name} {ddl}'))


async def run(db):
    await _add(db, 'qb_sync_plan', {
        'session_no': 'INT NOT NULL DEFAULT 0',
        'session_round': 'INT NOT NULL DEFAULT 0',
        'max_rounds': 'INT NULL',
        'session_started_at': 'DATETIME NULL',
        'session_end_reason': 'VARCHAR(30) NULL',
        'session_mode': 'VARCHAR(20) NULL',
    })
    await _add(db, 'qb_sync_cycle', {
        'session_no': 'INT NULL',
        'round_no': 'INT NULL',
        'legacy': 'SMALLINT NOT NULL DEFAULT 0',
        'end_reason': 'VARCHAR(30) NULL',
    })
    await _add(db, 'qb_sync_control', {'resource_wait_json': 'JSON NULL'})
    # Old cycles were single passes. Map each to its own historical session
    # with one round and mark it legacy; no multi-round history is inferred.
    await db.execute(text(
        'UPDATE qb_sync_cycle SET session_no=cycle_no, round_no=1, legacy=1 WHERE session_no IS NULL'
    ))
    await db.execute(text(
        'UPDATE qb_sync_plan SET session_no=cycle_no, session_round=LEAST(cycle_no,1), '
        'session_started_at=cycle_started_at WHERE session_no=0 AND cycle_no>0'
    ))
