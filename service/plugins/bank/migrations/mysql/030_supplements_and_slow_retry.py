"""One-book supplements between sessions get their own record; intake keeps its slow-retry count."""
from sqlalchemy import text


async def run(db):
    columns = {r[0] for r in (await db.execute(text('SHOW COLUMNS FROM qb_question_import_intake'))).all()}
    if 'slow_retry_count' not in columns:
        await db.execute(text(
            'ALTER TABLE qb_question_import_intake ADD COLUMN slow_retry_count INT NOT NULL DEFAULT 0'))
    await db.execute(text(
        'CREATE TABLE IF NOT EXISTS qb_sync_supplement ('
        ' supplement_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,'
        ' plan_id BIGINT NOT NULL,'
        ' textbook_id BIGINT NOT NULL,'
        ' task_id BIGINT NULL,'
        ' sync_mode VARCHAR(20) NOT NULL DEFAULT \'incremental\','
        ' status VARCHAR(20) NOT NULL,'
        ' summary_json JSON NULL,'
        ' created_by VARCHAR(64) NULL,'
        ' started_at DATETIME NOT NULL,'
        ' finished_at DATETIME NULL,'
        ' KEY idx_qb_sync_supplement_plan (plan_id, status)'
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    ))
