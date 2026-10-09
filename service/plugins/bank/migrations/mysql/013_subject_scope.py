"""Add subject scope without rewriting historical migrations or task options.

Existing records belong to the verified junior-math adapter (subject 1).
DDL is checked individually so an interrupted MySQL migration can be retried.
"""
from sqlalchemy import text


async def run(query_db):
    await query_db.execute(text('''
        CREATE TABLE IF NOT EXISTS qb_subject (
            subject_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            stage_code VARCHAR(30) NOT NULL,
            subject_code VARCHAR(30) NOT NULL,
            subject_name VARCHAR(50) NOT NULL,
            source_profile VARCHAR(64) NULL,
            sort_order INT NOT NULL DEFAULT 0,
            status CHAR(1) NOT NULL DEFAULT '0',
            create_time DATETIME NOT NULL,
            update_time DATETIME NOT NULL,
            UNIQUE KEY uk_qb_subject_stage_code (stage_code, subject_code),
            UNIQUE KEY uk_qb_subject_source_profile (source_profile)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    '''))
    await query_db.execute(text('''
        INSERT IGNORE INTO qb_subject
        (subject_id, stage_code, subject_code, subject_name, source_profile, create_time, update_time)
        VALUES (1, 'junior', 'math', '数学', 'zujuan_czsx', NOW(), NOW())
    '''))
    for table, short, external in (
        ('qb_textbook_version', 'version', 'external_version_id'),
        ('qb_textbook', 'textbook', 'external_textbook_id'),
        ('qb_catalog_node', 'catalog', 'external_node_id'),
        ('qb_question', 'question', 'external_question_id'),
    ):
        columns = (await query_db.execute(text(f'SHOW COLUMNS FROM `{table}`'))).all()
        if 'subject_id' not in {row[0] for row in columns}:
            await query_db.execute(text(
                f'ALTER TABLE `{table}` ADD COLUMN subject_id BIGINT NOT NULL DEFAULT 1'
            ))
        rows = (await query_db.execute(text(f'SHOW INDEX FROM `{table}`'))).all()
        indexes = {}
        for row in rows:
            indexes.setdefault(row[2], []).append((row[3], row[4]))
        unique = f'uk_qb_{short}_provider_external'
        if unique in indexes and 'subject_id' not in {col for _, col in indexes[unique]}:
            # Replace atomically. Never leave the source identity unprotected.
            await query_db.execute(text(
                f'ALTER TABLE `{table}` DROP INDEX `{unique}`, '
                f'ADD UNIQUE KEY `{unique}` (source_provider, subject_id, `{external}`)'
            ))
        elif unique not in indexes:
            await query_db.execute(text(
                f'ALTER TABLE `{table}` ADD UNIQUE KEY `{unique}` '
                f'(source_provider, subject_id, `{external}`)'
            ))
        index = f'idx_qb_{short}_subject'
        if index not in indexes:
            await query_db.execute(text(
                f'ALTER TABLE `{table}` ADD INDEX `{index}` (subject_id, status)'
            ))
    for table in ('qb_sync_job', 'qb_sync_job_scope'):
        columns = (await query_db.execute(text(f'SHOW COLUMNS FROM `{table}`'))).all()
        if 'subject_id' not in {row[0] for row in columns}:
            await query_db.execute(text(
                f'ALTER TABLE `{table}` ADD COLUMN subject_id BIGINT NOT NULL DEFAULT 1'
            ))


__all__ = ['run']
