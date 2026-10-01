"""Keep generated lessons stable when the formal question bank changes."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text


async def _has_column(query_db: Any, table: str, column: str) -> bool:
    result = await query_db.execute(
        text(
            'SELECT COUNT(*) FROM information_schema.COLUMNS '
            'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column'
        ),
        {'table': table, 'column': column},
    )
    return bool(result.scalar())


async def run(query_db: Any) -> None:
    if not await _has_column(query_db, 'lp_generation', 'scheme_snapshot_json'):
        await query_db.execute(text('ALTER TABLE lp_generation ADD COLUMN scheme_snapshot_json JSON DEFAULT NULL'))
    if not await _has_column(query_db, 'lp_generation_item', 'question_snapshot_json'):
        await query_db.execute(text('ALTER TABLE lp_generation_item ADD COLUMN question_snapshot_json JSON DEFAULT NULL'))
