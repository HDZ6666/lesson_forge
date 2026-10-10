"""Whole-round schedules, plan controls and queue order; retain old outcomes."""
from sqlalchemy import text

from plugins.bank.entity.do.bank_do import QbSyncCycle


async def add_columns(db, table, additions):
    columns = {r[0] for r in (await db.execute(text(f'SHOW COLUMNS FROM {table}'))).all()}
    for name, definition in additions.items():
        if name not in columns:
            await db.execute(text(f'ALTER TABLE {table} ADD COLUMN {name} {definition}'))


async def run(db):
    await add_columns(db, 'qb_sync_plan', {
        'auto_update':'SMALLINT NOT NULL DEFAULT 1', 'control_state':"VARCHAR(20) NOT NULL DEFAULT 'active'",
        'cycle_state':"VARCHAR(20) NOT NULL DEFAULT 'idle'", 'cycle_finished_at':'DATETIME NULL',
        'next_cycle_at':'DATETIME NULL', 'textbook_order':'JSON NULL',
    })
    await add_columns(db, 'qb_sync_job', {'dispatch_priority':'BIGINT NOT NULL DEFAULT 0', 'dispatch_rank':'INT NOT NULL DEFAULT 0'})
    await add_columns(db, 'qb_sync_book_state', {'last_manual_task_id':'BIGINT NULL'})
    await db.execute(text("UPDATE qb_sync_plan SET cycle_state='running' WHERE cycle_no>0 AND cycle_state='idle'"))
    await db.execute(text("UPDATE qb_sync_plan SET control_state='paused' WHERE enabled=0 AND control_state='active'"))
    connection=await db.connection()
    await connection.run_sync(lambda conn:QbSyncCycle.__table__.create(conn,checkfirst=True))
    await db.execute(text("""INSERT IGNORE INTO qb_sync_cycle(plan_id,cycle_no,cycle_name,status,targets,started_at)
        SELECT plan_id,cycle_no,COALESCE(cycle_name,CONCAT(plan_name,' · 第 ',cycle_no,' 轮')),
        'running',cycle_targets,COALESCE(cycle_started_at,update_time) FROM qb_sync_plan WHERE cycle_no>0"""))
    constraints={r[0] for r in (await db.execute(text("SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='qb_question_import' AND CONSTRAINT_TYPE='CHECK'"))).all()}
    if 'chk_qb_question_import_status' in constraints:
        await db.execute(text('ALTER TABLE qb_question_import DROP CHECK chk_qb_question_import_status'))
    await db.execute(text("ALTER TABLE qb_question_import ADD CONSTRAINT chk_qb_question_import_status CHECK(status IN ('queued','preparing','running','completed','partial','failed','paused','cancelled'))"))
