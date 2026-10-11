"""Group linked executions without changing snapshot/import/log identities."""
from sqlalchemy import text


async def run(db):
    columns = {r[0] for r in (await db.execute(text('SHOW COLUMNS FROM qb_sync_job'))).all()}
    if 'logical_task_id' not in columns:
        await db.execute(text('ALTER TABLE qb_sync_job ADD COLUMN logical_task_id BIGINT NULL'))
    indexes = {r[2] for r in (await db.execute(text('SHOW INDEX FROM qb_sync_job'))).all()}
    if 'idx_qb_sync_job_logical_task' not in indexes:
        await db.execute(text('CREATE INDEX idx_qb_sync_job_logical_task ON qb_sync_job(logical_task_id,run_id)'))
    rows = (await db.execute(text("SELECT run_id,retry_of_run_id,logical_task_id FROM qb_sync_job WHERE task_module='question' ORDER BY run_id"))).all()
    roots = {}
    for run_id, parent, existing in rows:
        root = existing or roots.get(parent, run_id)
        roots[run_id] = root
        if existing is None:
            await db.execute(text('UPDATE qb_sync_job SET logical_task_id=:root WHERE run_id=:id'), {'root': root, 'id': run_id})
