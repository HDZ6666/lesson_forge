"""Create durable import IDs before QC; separate backlog from source leases."""

from sqlalchemy import text


async def run(query_db):
    rows = (await query_db.execute(text('SHOW COLUMNS FROM qb_question_import'))).all()
    columns = {row[0]: row for row in rows}
    if columns['quality_hash'][2] != 'YES':
        await query_db.execute(text('ALTER TABLE qb_question_import MODIFY quality_hash CHAR(64) NULL'))
    if 'stage' not in columns:
        await query_db.execute(text(
            "ALTER TABLE qb_question_import ADD COLUMN stage VARCHAR(20) NOT NULL DEFAULT 'importing'"
        ))
    if 'active_source_slot' not in columns:
        await query_db.execute(text('ALTER TABLE qb_question_import ADD COLUMN active_source_slot VARCHAR(64) NULL'))
    indexes = (await query_db.execute(text('SHOW INDEX FROM qb_question_import'))).all()
    if not any(row[2] == 'uk_qb_question_import_source_slot' for row in indexes):
        await query_db.execute(text(
            'ALTER TABLE qb_question_import ADD UNIQUE KEY uk_qb_question_import_source_slot (active_source_slot)'
        ))
    clause = await query_db.scalar(text(
        "SELECT cc.CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS cc "
        "JOIN information_schema.TABLE_CONSTRAINTS tc "
        "ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME "
        "WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.TABLE_NAME='qb_question_import' "
        "AND tc.CONSTRAINT_NAME='chk_qb_question_import_status'"
    ))
    if clause and 'preparing' not in clause:
        await query_db.execute(text('ALTER TABLE qb_question_import DROP CHECK chk_qb_question_import_status'))
        clause = None
    if not clause:
        await query_db.execute(text(
            'ALTER TABLE qb_question_import ADD CONSTRAINT chk_qb_question_import_status '
            "CHECK (status IN ('queued','preparing','running','completed','partial','failed'))"
        ))
    await query_db.execute(text(
        "UPDATE qb_question_import SET stage='done' WHERE status IN ('completed','partial') AND stage<>'done'"
    ))


__all__ = ['run']
