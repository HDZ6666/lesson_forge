"""Add the terminal-task deletion lookup index.

Task deletion only removes rows from the service-owned ``qb_sync_job`` and
``qb_sync_job_scope`` tables.  The migration is additive and idempotent so an
already-installed bank plugin can upgrade without rewriting task history or
touching collector SQLite snapshots and formal question-bank data.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text


async def run(query_db: Any) -> None:
    """Ensure terminal task deletion can use the module/status index."""

    result = await query_db.execute(text('SHOW INDEX FROM qb_sync_job'))
    index_names = {str(row[2]) for row in result.fetchall()}
    if 'idx_qb_sync_job_delete' not in index_names:
        await query_db.execute(text('CREATE INDEX idx_qb_sync_job_delete ON qb_sync_job (task_module, status, run_id)'))
