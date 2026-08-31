"""Bring pre-0.4.0 sync-job tables up to the current model contract.

The first version of the task table could already exist in a development
database without the version counters.  This migration is intentionally
schema-aware so it is safe for both that table and a fresh table created by
003_sync_job.sql.  It only adds missing columns and never removes or rewrites
existing task data.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text


_COLUMNS = {
    'total_versions': (
        "ALTER TABLE qb_sync_job ADD COLUMN total_versions INT NOT NULL DEFAULT 0 "
        "COMMENT '本次发现版本数量' AFTER options_json"
    ),
    'completed_versions': (
        "ALTER TABLE qb_sync_job ADD COLUMN completed_versions INT NOT NULL DEFAULT 0 "
        "COMMENT '已处理版本数量' AFTER total_versions"
    ),
}


async def run(query_db: Any) -> None:
    """Add only the task columns absent from the target MySQL table."""

    result = await query_db.execute(text('SHOW COLUMNS FROM qb_sync_job'))
    existing = {str(row[0]) for row in result.fetchall()}
    for name, statement in _COLUMNS.items():
        if name not in existing:
            await query_db.execute(text(statement))
