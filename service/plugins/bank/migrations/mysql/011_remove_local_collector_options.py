"""Remove obsolete local collector launch options from persisted tasks.

The service now talks to an independently deployed collector over HTTP. Older
rows may still contain script/database/headful launch options from the local
worker implementation.  This migration removes only those exact top-level
keys and preserves every normal task/remote option, including collector URL
and bearer configuration fields if an operator stored them for diagnostics.

The migration reads JSON rows in Python instead of using ``JSON_REMOVE`` so it
works across MySQL JSON driver versions and is naturally idempotent: a row is
updated only when at least one legacy key is present.  The scope table was
introduced by a later additive migration and may not have ``options_json`` on
older installations, so its columns are inspected before it is queried.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

_TABLES = (
    ('qb_sync_job', 'run_id'),
    ('qb_sync_job_scope', 'scope_id'),
)
_LEGACY_OPTION_KEYS = frozenset(
    {
        'collectordb',
        'collectordatabase',
        'collectorpath',
        'collectorscript',
        'collectorheadful',
        'headful',
        'headless',
        'browserheadful',
        'browserheadless',
        'executionmode',
        'metadatascript',
        'questionscript',
        'nodecommand',
        'scriptpath',
        'dbpath',
    }
)
_MISSING_TABLE_CODE = 1146


def _row_value(row: Any, index: int, *names: str) -> Any:
    if isinstance(row, (tuple, list)):
        return row[index] if len(row) > index else None
    mapping = getattr(row, '_mapping', None)
    if mapping is not None:
        for name in names:
            if name in mapping:
                return mapping[name]
    if isinstance(row, Mapping):
        for name in names:
            if name in row:
                return row[name]
    return None


def _rows(result: Any) -> list[Any]:
    fetchall = getattr(result, 'fetchall', None)
    return list(fetchall()) if callable(fetchall) else []


def _missing_table(error: SQLAlchemyError) -> bool:
    original = getattr(error, 'orig', error)
    arguments = getattr(original, 'args', ())
    if arguments and arguments[0] == _MISSING_TABLE_CODE:
        return True
    message = str(original or error).lower()
    return 'doesn\'t exist' in message or 'does not exist' in message or 'no such table' in message


async def _columns(query_db: Any, table: str) -> set[str]:
    try:
        result = await query_db.execute(text(f'SHOW COLUMNS FROM `{table}`'))
    except SQLAlchemyError as exc:
        if _missing_table(exc):
            return set()
        raise
    return {
        str(_row_value(row, 0, 'Field', 'field') or '').lower()
        for row in _rows(result)
        if _row_value(row, 0, 'Field', 'field') is not None
    }


def _options(value: Any) -> dict[str, Any] | None:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, bytes):
        try:
            value = value.decode('utf-8')
        except UnicodeDecodeError:
            return None
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return None
        return dict(parsed) if isinstance(parsed, Mapping) else None
    return None


def _is_legacy_key(key: Any) -> bool:
    normalized = re.sub(r'[^a-z0-9]', '', str(key).strip().lower())
    return normalized in _LEGACY_OPTION_KEYS


def _remove_legacy_options(value: Any) -> tuple[dict[str, Any] | None, bool]:
    parsed = _options(value)
    if parsed is None:
        return None, False
    cleaned = {key: item for key, item in parsed.items() if not _is_legacy_key(key)}
    return cleaned, len(cleaned) != len(parsed)


async def _clean_table(query_db: Any, table: str, primary_key: str) -> None:
    columns = await _columns(query_db, table)
    if 'options_json' not in columns:
        return
    result = await query_db.execute(
        text(
            f'SELECT `{primary_key}`, `options_json` FROM `{table}` '
            'WHERE `options_json` IS NOT NULL'
        )
    )
    for row in _rows(result):
        row_id = _row_value(row, 0, primary_key)
        raw_options = _row_value(row, 1, 'options_json', 'optionsJson')
        cleaned, changed = _remove_legacy_options(raw_options)
        if not changed or cleaned is None:
            continue
        await query_db.execute(
            text(
                f'UPDATE `{table}` SET `options_json` = :options_json '
                f'WHERE `{primary_key}` = :row_id'
            ),
            {
                'options_json': json.dumps(cleaned, ensure_ascii=False, separators=(',', ':')),
                'row_id': row_id,
            },
        )


async def run(query_db: Any) -> None:
    """Clean legacy local collector keys from both task option columns."""

    for table, primary_key in _TABLES:
        await _clean_table(query_db, table, primary_key)


__all__ = ['run']
