"""Add the explicit metadata/content task contract to ``qb_sync_job``.

This migration is intentionally additive.  Existing task rows are metadata
tasks because that was the only task kind before this contract was introduced;
their ``metadata_run_id`` remains nullable until the collector can identify a
run.  The runner calls migrations in order and records the file checksum, so
this file must never be edited after it has run in a production database.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

_COLUMNS = {
    'run_type': (
        "ALTER TABLE qb_sync_job ADD COLUMN run_type VARCHAR(20) NOT NULL DEFAULT 'metadata' "
        "COMMENT '同步任务类型：metadata 或 content' AFTER run_id"
    ),
    'metadata_run_id': (
        "ALTER TABLE qb_sync_job ADD COLUMN metadata_run_id BIGINT DEFAULT NULL "
        "COMMENT '内容任务绑定的成功元数据运行 ID' AFTER acknowledge_source_policy"
    ),
}


async def run(query_db: Any) -> None:
    """Add missing columns without rewriting or deleting existing rows."""

    result = await query_db.execute(text('SHOW COLUMNS FROM qb_sync_job'))
    existing = {str(row[0]) for row in result.fetchall()}
    for name, statement in _COLUMNS.items():
        if name not in existing:
            await query_db.execute(text(statement))

    # The index is useful for snapshot/task audit queries.  MySQL has no
    # portable ``CREATE INDEX IF NOT EXISTS`` syntax, so inspect indexes first.
    indexes = await query_db.execute(text('SHOW INDEX FROM qb_sync_job'))
    index_names = {str(row[2]) for row in indexes.fetchall()}
    if 'idx_qb_sync_job_metadata_run' not in index_names:
        await query_db.execute(
            text('CREATE INDEX idx_qb_sync_job_metadata_run ON qb_sync_job (metadata_run_id)')
        )

    # ``003_sync_job.sql`` predates the two task kinds.  Add the database
    # guard as well as the ORM guard so direct SQL cannot create an unknown
    # run type.  Inspect the table definition because MySQL has no portable
    # ``ADD CONSTRAINT IF NOT EXISTS`` syntax.
    definition = await query_db.execute(text('SHOW CREATE TABLE qb_sync_job'))
    create_sql = str(definition.fetchone()[1])
    if 'chk_qb_sync_job_run_type' not in create_sql:
        await query_db.execute(
            text(
                "ALTER TABLE qb_sync_job ADD CONSTRAINT chk_qb_sync_job_run_type "
                "CHECK (run_type IN ('metadata', 'content'))"
            )
        )
