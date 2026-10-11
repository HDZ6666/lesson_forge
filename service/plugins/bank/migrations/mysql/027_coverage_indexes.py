"""Cover frequent UI counts without reading question bodies or asset metadata."""
from sqlalchemy import text

INDEXES = (
    ('qb_question', 'idx_qb_question_coverage',
     'question_id,subject_id,status,readiness_revision,source_provider,external_question_id,content_hash'),
    ('qb_question_catalog', 'idx_qb_question_catalog_lookup', 'catalog_id,relation_type,question_id'),
    ('qb_question_asset', 'idx_qb_question_asset_download_hash', 'download_status,file_hash'),
)


async def run(db):
    for table, name, columns in INDEXES:
        indexes = {row[2] for row in (await db.execute(text(f'SHOW INDEX FROM {table}'))).all()}
        if name not in indexes:
            await db.execute(text(f'ALTER TABLE {table} ADD INDEX {name} ({columns}), ALGORITHM=INPLACE, LOCK=NONE'))
