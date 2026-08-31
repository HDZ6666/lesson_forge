"""Add safe checkpoint-resume state to question synchronization tasks.

The migration is intentionally additive and idempotent.  ``interrupted`` is
an ordinary terminal state from the service's point of view: it does not own
the activity slot, cannot be applied, and keeps the collector run identity so
an explicit resume request can validate and continue from that immutable
partial snapshot.
"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import text

SHOW_INDEX_KEY_NAME = 2

_SCOPE_COLUMNS = {
    'resume_from_collector_run_id': (
        'ALTER TABLE qb_sync_job_scope ADD COLUMN resume_from_collector_run_id BIGINT DEFAULT NULL '
        "COMMENT '安全续采使用的上一次 interrupted collector run ID' AFTER collector_run_id"
    ),
}

_JOB_STATUS_CONSTRAINT = (
    'ALTER TABLE qb_sync_job ADD CONSTRAINT chk_qb_sync_job_status '
    "CHECK (status IN ('queued', 'starting', 'running', 'cancelling', 'completed', 'failed', 'blocked', 'cancelled', 'interrupted'))"
)
_JOB_PHASE_CONSTRAINT = (
    'ALTER TABLE qb_sync_job ADD CONSTRAINT chk_qb_sync_job_phase '
    "CHECK (phase IN ('metadata', 'catalogs_questions', 'completed', 'failed', 'blocked', 'cancelled', 'interrupted'))"
)
_SCOPE_STATUS_CONSTRAINT = (
    'ALTER TABLE qb_sync_job_scope ADD CONSTRAINT chk_qb_sync_scope_status '
    "CHECK (status IN ('queued', 'starting', 'running', 'completed', 'failed', 'blocked', 'cancelled', 'interrupted'))"
)


def _rows(result: Any) -> list[Any]:
    fetchall = getattr(result, 'fetchall', None)
    return list(fetchall()) if callable(fetchall) else []


def _row_value(row: Any, index: int, *names: str) -> Any:
    if isinstance(row, (list, tuple)):
        return row[index] if len(row) > index else None
    mapping = getattr(row, '_mapping', None)
    if mapping is not None:
        for name in names:
            if name in mapping:
                return mapping[name]
    if isinstance(row, dict):
        for name in names:
            if name in row:
                return row[name]
    return None


def _table_definition(result: Any) -> str:
    fetchone = getattr(result, 'fetchone', None)
    row = fetchone() if callable(fetchone) else None
    if isinstance(row, (list, tuple)) and len(row) > 1:
        return str(row[1] or '')
    value = _row_value(row, 1, 'Create Table', 'create_table')
    if value is not None:
        return str(value)
    return str(row or '')


def _constraint_check_body(create_sql: str, constraint: str) -> str | None:
    """Return one named CHECK expression from ``SHOW CREATE TABLE``.

    A table definition can contain several checks.  Looking for the state
    marker in the whole definition is unsafe: after the job-status check has
    been upgraded, that marker would make an old phase check look upgraded as
    well.  MySQL emits the named check as ``CONSTRAINT `name` CHECK (...)``;
    this small scanner extracts only that balanced parenthesized expression,
    while tolerating nested expressions and quoted SQL literals.
    """

    constraint_match = re.search(
        rf'\bCONSTRAINT\s+`?{re.escape(constraint)}`?\s+CHECK\s*',
        create_sql,
        flags=re.IGNORECASE,
    )
    if constraint_match is None:
        return None
    opening = create_sql.find('(', constraint_match.end())
    if opening < 0:
        return ''

    depth = 0
    quote: str | None = None
    index = opening
    while index < len(create_sql):
        character = create_sql[index]
        if quote is not None:
            if character == '\\' and quote != '`':
                index += 2
                continue
            if character == quote:
                # SQL escapes a quote by doubling it.  Skip the escaped copy
                # rather than ending the literal early.
                if index + 1 < len(create_sql) and create_sql[index + 1] == quote:
                    index += 2
                    continue
                quote = None
            index += 1
            continue
        if character in {'\'', '"', '`'}:
            quote = character
        elif character == '(':
            depth += 1
        elif character == ')':
            depth -= 1
            if depth == 0:
                return create_sql[opening : index + 1]
        index += 1
    return create_sql[opening:]


async def _replace_check(query_db: Any, table: str, constraint: str, statement: str, create_sql: str) -> str:
    """Replace one named CHECK only when its own body lacks the new state."""

    body = _constraint_check_body(create_sql, constraint)
    if body is not None and 'interrupted' in body.lower():
        return create_sql
    if body is not None or re.search(
        rf'\bCONSTRAINT\s+`?{re.escape(constraint)}`?',
        create_sql,
        flags=re.IGNORECASE,
    ):
        await query_db.execute(text(f'ALTER TABLE {table} DROP CHECK {constraint}'))
    await query_db.execute(text(statement))
    return create_sql


async def run(query_db: Any) -> None:
    """Extend status checks and add the durable per-scope resume source."""

    scope_columns_result = await query_db.execute(text('SHOW COLUMNS FROM qb_sync_job_scope'))
    scope_columns = {
        str(_row_value(row, 0, 'Field', 'field') or '')
        for row in _rows(scope_columns_result)
        if _row_value(row, 0, 'Field', 'field') is not None
    }
    for name, statement in _SCOPE_COLUMNS.items():
        if name not in scope_columns:
            await query_db.execute(text(statement))

    indexes_result = await query_db.execute(text('SHOW INDEX FROM qb_sync_job_scope'))
    index_names = {
        str(_row_value(row, SHOW_INDEX_KEY_NAME, 'Key_name', 'key_name') or '')
        for row in _rows(indexes_result)
        if _row_value(row, SHOW_INDEX_KEY_NAME, 'Key_name', 'key_name') is not None
    }
    if 'idx_qb_sync_scope_resume_run' not in index_names:
        await query_db.execute(
            text(
                'CREATE INDEX idx_qb_sync_scope_resume_run '
                'ON qb_sync_job_scope (resume_from_collector_run_id, source_provider, external_textbook_id)'
            )
        )

    job_definition = _table_definition(await query_db.execute(text('SHOW CREATE TABLE qb_sync_job')))
    await _replace_check(
        query_db,
        'qb_sync_job',
        'chk_qb_sync_job_status',
        _JOB_STATUS_CONSTRAINT,
        job_definition,
    )
    # SHOW CREATE is fetched again because the status replacement above may
    # have been the first statement against an old table and the phase check
    # has its own constraint body.
    job_definition = _table_definition(await query_db.execute(text('SHOW CREATE TABLE qb_sync_job')))
    await _replace_check(
        query_db,
        'qb_sync_job',
        'chk_qb_sync_job_phase',
        _JOB_PHASE_CONSTRAINT,
        job_definition,
    )
    scope_definition = _table_definition(await query_db.execute(text('SHOW CREATE TABLE qb_sync_job_scope')))
    await _replace_check(
        query_db,
        'qb_sync_job_scope',
        'chk_qb_sync_scope_status',
        _SCOPE_STATUS_CONSTRAINT,
        scope_definition,
    )
