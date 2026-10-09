"""Add derived stem facts; old rows remain unchecked until bounded backfill."""

from sqlalchemy import text


async def run(query_db):
    columns = {row[0] for row in (await query_db.execute(text('SHOW COLUMNS FROM qb_question'))).all()}
    if 'readiness_revision' not in columns:
        await query_db.execute(text('ALTER TABLE qb_question ADD COLUMN readiness_revision CHAR(32) NULL'))
    await query_db.execute(text('''
        CREATE TABLE IF NOT EXISTS qb_question_readiness (
            question_id BIGINT NOT NULL PRIMARY KEY,
            subject_id BIGINT NOT NULL,
            source_provider VARCHAR(64) NOT NULL,
            external_question_id VARCHAR(64) NULL,
            question_revision CHAR(32) NOT NULL,
            content_hash CHAR(64) NULL,
            stem_hash CHAR(64) NOT NULL,
            asset_signature CHAR(64) NOT NULL,
            has_image SMALLINT NOT NULL,
            has_table SMALLINT NOT NULL,
            stem_valid SMALLINT NOT NULL,
            assets_ready SMALLINT NOT NULL,
            status VARCHAR(20) NOT NULL,
            reason VARCHAR(500) NULL,
            checked_at DATETIME(6) NOT NULL,
            KEY idx_qb_readiness_status (status, question_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    '''))
    await query_db.execute(text('''
        CREATE TABLE IF NOT EXISTS qb_question_readiness_sweep (
            sweep_id INT NOT NULL PRIMARY KEY,
            last_question_id BIGINT NOT NULL DEFAULT 0,
            worker_token CHAR(32) NULL,
            lease_until DATETIME(6) NULL,
            next_check_at DATETIME(6) NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    '''))
    await query_db.execute(text('INSERT IGNORE INTO qb_question_readiness_sweep (sweep_id) VALUES (1)'))


__all__ = ['run']
