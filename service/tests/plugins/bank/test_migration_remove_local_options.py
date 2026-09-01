"""Tests for the idempotent cleanup of pre-HTTP collector task options."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest

MIGRATION_PATH = (
    Path(__file__).resolve().parents[3]
    / 'plugins'
    / 'bank'
    / 'migrations'
    / 'mysql'
    / '011_remove_local_collector_options.py'
)


def _migration() -> Any:
    spec = importlib.util.spec_from_file_location('bank_migration_011', MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Result:
    def __init__(self, rows: list[Any]) -> None:
        self.rows = rows

    def fetchall(self) -> list[Any]:
        return list(self.rows)


class _Db:
    def __init__(self, *, scope_has_options: bool = True) -> None:
        self.scope_has_options = scope_has_options
        self.tables: dict[str, dict[int, dict[str, Any]]] = {
            'qb_sync_job': {
                1: {
                    'metadataScript': 'collector/zujuan_metadata_sync.cjs',
                    'collectorDb': '/collector/data.sqlite',
                    'collectorHeadful': True,
                    'executionMode': 'headful',
                    'headful': False,
                    'collectorUrl': 'http://collector:9110',
                    'metadataRunId': 18,
                },
                2: {'versionId': 3, 'textbookIds': [8]},
            },
            'qb_sync_job_scope': {
                10: {
                    'question_script': 'collector/zujuan_sync.cjs',
                    'collector_path': '/collector',
                    'headful': True,
                    'externalTextbookId': 'tb-8',
                },
            },
        }
        self.updates: list[tuple[str, int, dict[str, Any]]] = []

    async def execute(self, statement: Any, params: dict[str, Any] | None = None) -> _Result:
        sql = str(statement)
        if sql.startswith('SHOW COLUMNS FROM `'):
            table = sql.split('`')[1]
            columns = ['run_id', 'options_json'] if table == 'qb_sync_job' else ['scope_id']
            if table == 'qb_sync_job_scope' and self.scope_has_options:
                columns.append('options_json')
            return _Result([(column,) for column in columns])
        if sql.startswith('SELECT `'):
            table = 'qb_sync_job' if 'qb_sync_job`' in sql else 'qb_sync_job_scope'
            return _Result(
                [
                    (row_id, json.dumps(options, ensure_ascii=False))
                    for row_id, options in self.tables[table].items()
                ]
            )
        if sql.startswith('UPDATE `'):
            table = sql.split('`')[1]
            assert params is not None
            row_id = int(params['row_id'])
            options = json.loads(str(params['options_json']))
            self.tables[table][row_id] = options
            self.updates.append((table, row_id, options))
            return _Result([])
        raise AssertionError(f'unexpected SQL: {sql}')


@pytest.mark.asyncio
async def test_migration_removes_only_local_collector_keys_and_is_idempotent() -> None:
    db = _Db()
    migration = _migration()

    await migration.run(db)

    assert db.tables['qb_sync_job'][1] == {
        'collectorUrl': 'http://collector:9110',
        'metadataRunId': 18,
    }
    assert db.tables['qb_sync_job'][2] == {'versionId': 3, 'textbookIds': [8]}
    assert db.tables['qb_sync_job_scope'][10] == {
        'externalTextbookId': 'tb-8',
    }
    first_update_count = len(db.updates)

    await migration.run(db)

    assert len(db.updates) == first_update_count


@pytest.mark.asyncio
async def test_migration_skips_scope_table_without_options_json() -> None:
    db = _Db(scope_has_options=False)
    migration = _migration()

    await migration.run(db)

    assert db.tables['qb_sync_job'][1]['collectorUrl'] == 'http://collector:9110'
    assert db.updates == [('qb_sync_job', 1, {'collectorUrl': 'http://collector:9110', 'metadataRunId': 18})]
