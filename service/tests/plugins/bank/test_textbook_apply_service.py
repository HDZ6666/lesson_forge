"""Focused coverage for applying textbook-task snapshots to formal tables."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from sqlalchemy import BigInteger, func, select
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles

from exceptions.exception import ServiceException
from plugins.bank.dao.textbook_apply_dao import TextbookApplyDao
from plugins.bank.entity.do.bank_do import (
    QbSyncJob,
    QbSyncJobScope,
    QbTextbook,
    QbTextbookApplyHistory,
    QbTextbookApplyState,
    QbTextbookVersion,
)
from plugins.bank.service import textbook_apply_service
from plugins.bank.service.task_service import SyncTaskService
from plugins.bank.service.textbook_apply_service import TextbookApplyService

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Mapping
    from pathlib import Path


CURRENT_TASK_ID = 9
APPLY_ROLLBACK_RESTORE_HISTORY_COUNT = 3


@compiles(BigInteger, 'sqlite')
def _compile_sqlite_big_integer(_type: BigInteger, _compiler: object, **_kwargs: object) -> str:
    """Let SQLite exercise the MySQL BIGINT auto-increment primary keys."""

    return 'INTEGER'


@compiles(LONGTEXT, 'sqlite')
def _compile_sqlite_long_text(_type: LONGTEXT, _compiler: object, **_kwargs: object) -> str:
    return 'TEXT'


FORMAL_TABLES = [
    QbSyncJob.__table__,
    QbSyncJobScope.__table__,
    QbTextbookVersion.__table__,
    QbTextbook.__table__,
    QbTextbookApplyState.__table__,
    QbTextbookApplyHistory.__table__,
]


@pytest_asyncio.fixture
async def db() -> AsyncIterator[AsyncSession]:
    engine = create_async_engine('sqlite+aiosqlite:///:memory:')
    async with engine.begin() as connection:
        await connection.run_sync(
            lambda sync_connection: QbSyncJob.metadata.create_all(sync_connection, tables=FORMAL_TABLES)
        )
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    await engine.dispose()


def _snapshot(run_id: int, *, older: bool = False) -> dict[str, Any]:
    captured_at = f'2026-08-{run_id:02d}T08:00:00'
    versions = [
        {
            'provider': 'zujuan',
            'external_version_id': 'version-a',
            'version_name': '旧任务版本 A' if older else '新任务版本 A',
            'source_url': f'https://example.test/{run_id}/version-a',
            'is_new': '0',
            'sort_order': 0 if older else 20,
            'status': '0',
            'captured_at': captured_at,
        }
    ]
    textbooks = [
        {
            'provider': 'zujuan',
            'external_textbook_id': 'textbook-a',
            'version_external_id': 'version-a',
            'textbook_name': '旧任务教材 A' if older else '新任务教材 A',
            'grade': '七年级',
            'volume': '上册',
            'source_url': f'https://example.test/{run_id}/textbook-a',
            'sort_order': 0 if older else 20,
            'status': '0',
            'captured_at': captured_at,
        }
    ]
    if not older:
        versions.append(
            {
                'provider': 'zujuan',
                'external_version_id': 'version-b',
                'version_name': '新任务版本 B',
                'source_url': f'https://example.test/{run_id}/version-b',
                'is_new': '1',
                'sort_order': 10,
                'status': '0',
                'captured_at': captured_at,
            }
        )
        textbooks.append(
            {
                'provider': 'zujuan',
                'external_textbook_id': 'textbook-b',
                'version_external_id': 'version-b',
                'textbook_name': '新任务教材 B',
                'grade': '八年级',
                'volume': '下册',
                'source_url': f'https://example.test/{run_id}/textbook-b',
                'sort_order': 10,
                'status': '0',
                'captured_at': captured_at,
            }
        )
    return {
        'run': {
            'id': run_id,
            'provider': 'zujuan',
            'status': 'completed',
            'snapshot_locked_at': captured_at,
        },
        'versions': versions,
        'textbooks': textbooks,
        'immutable': True,
    }


def _job(task_id: int, metadata_run_id: int, *, status: str = 'completed') -> QbSyncJob:
    now = datetime(2026, 8, 29, 8, 0, 0)
    return QbSyncJob(
        run_id=task_id,
        run_type='metadata',
        task_module='textbook',
        status=status,
        phase='completed' if status == 'completed' else 'failed',
        acknowledge_source_policy='Y',
        metadata_run_id=metadata_run_id,
        options_json={},
        create_time=now,
        update_time=now,
    )


def _scope(scope_id: int, task_id: int, metadata_run_id: int, textbook_id: str) -> QbSyncJobScope:
    now = datetime(2026, 8, 29, 8, 0, 0)
    return QbSyncJobScope(
        scope_id=scope_id,
        run_id=task_id,
        source_provider='zujuan',
        external_version_id='version-a' if textbook_id == 'textbook-a' else 'version-b',
        external_textbook_id=textbook_id,
        metadata_run_id=metadata_run_id,
        status='completed',
        create_time=now,
        update_time=now,
    )


async def _seed_tasks_and_other_provider(db: AsyncSession) -> None:
    now = datetime(2026, 8, 29, 8, 0, 0)
    db.add_all(
        [
            _job(8, 8),
            _job(9, 9),
            _scope(81, 8, 8, 'textbook-a'),
            _scope(91, 9, 9, 'textbook-a'),
            _scope(92, 9, 9, 'textbook-b'),
            QbTextbookVersion(
                version_id=700,
                source_provider='other',
                external_version_id='other-version',
                version_name='其他来源版本',
                sort_order=3,
                status='0',
                create_time=now,
                update_time=now,
            ),
            QbTextbook(
                textbook_id=800,
                version_id=700,
                source_provider='other',
                external_textbook_id='other-textbook',
                textbook_name='其他来源教材',
                sort_order=4,
                status='0',
                create_time=now,
                update_time=now,
            ),
        ]
    )
    await db.commit()


@pytest.fixture
def snapshot_reader(monkeypatch: pytest.MonkeyPatch) -> Mapping[int, dict[str, Any]]:
    snapshots = {8: _snapshot(8, older=True), 9: _snapshot(9)}

    async def read_snapshot(metadata_run_id: int) -> dict[str, Any]:
        return snapshots[metadata_run_id]

    monkeypatch.setattr(textbook_apply_service, '_read_snapshot', read_snapshot)
    monkeypatch.setattr(textbook_apply_service, 'remote_collector_enabled', lambda: False)
    return snapshots


async def _apply_task9(db: AsyncSession) -> dict[str, Any]:
    return await TextbookApplyService.apply(db, 9, expected_current_task_id=None, operator='tester')


def _create_collector_snapshot_db(path: Path, *, version_count: int = 1, textbook_count: int = 1) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE source_metadata_runs (
            id INTEGER PRIMARY KEY, provider TEXT, started_at TEXT, finished_at TEXT, status TEXT,
            version_count INTEGER, textbook_count INTEGER, snapshot_locked_at TEXT
        );
        CREATE TABLE source_metadata_run_versions (
            run_id INTEGER, provider TEXT, external_version_id TEXT, version_name TEXT, source_url TEXT,
            is_new TEXT, sort_order INTEGER, status TEXT, captured_at TEXT
        );
        CREATE TABLE source_metadata_run_textbooks (
            run_id INTEGER, provider TEXT, external_textbook_id TEXT, version_external_id TEXT,
            textbook_name TEXT, grade TEXT, volume TEXT, source_url TEXT, sort_order INTEGER,
            status TEXT, captured_at TEXT
        );
        """
    )
    connection.execute(
        'INSERT INTO source_metadata_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        (1, 'zujuan', '2026-08-29 07:00:00', '2026-08-29 08:00:00', 'completed', version_count, textbook_count, '2026-08-29 08:00:01'),
    )
    connection.execute(
        'INSERT INTO source_metadata_run_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (1, 'zujuan', 'version-a', '版本 A', None, '0', 0, '0', '2026-08-29 08:00:00'),
    )
    connection.execute(
        'INSERT INTO source_metadata_run_textbooks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (1, 'zujuan', 'textbook-a', 'version-a', '教材 A', '七年级', '上册', None, 0, '0', '2026-08-29 08:00:00'),
    )
    connection.commit()
    connection.close()


def test_local_snapshot_rejects_missing_database_and_tables(tmp_path: Path) -> None:
    with pytest.raises(ServiceException, match='采集库不存在'):
        textbook_apply_service._read_local_snapshot_sync(tmp_path / 'missing.sqlite3', 1)

    empty = tmp_path / 'empty.sqlite3'
    sqlite3.connect(empty).close()
    with pytest.raises(ServiceException, match='缺少不可变元数据快照表'):
        textbook_apply_service._read_local_snapshot_sync(empty, 1)


def test_local_snapshot_rejects_incomplete_row_counts(tmp_path: Path) -> None:
    path = tmp_path / 'incomplete.sqlite3'
    _create_collector_snapshot_db(path, textbook_count=2)

    with pytest.raises(ServiceException, match=r'快照不完整.*教材 1/2'):
        textbook_apply_service._read_local_snapshot_sync(path, 1)


@pytest.mark.asyncio
async def test_non_completed_task_is_not_eligible() -> None:
    task = SimpleNamespace(run_id=7, status='failed', metadata_run_id=7)

    with pytest.raises(ServiceException, match='只有已成功完成'):
        await textbook_apply_service._validate_task_snapshot(SimpleNamespace(), task, [])


@pytest.mark.asyncio
async def test_task_apply_status_marks_valid_completed_snapshot_eligible(
    db: AsyncSession,
    snapshot_reader: Mapping[int, dict[str, Any]],
) -> None:
    task = _job(9, 9)
    scopes = [_scope(91, 9, 9, 'textbook-a'), _scope(92, 9, 9, 'textbook-b')]

    result = await TextbookApplyService.task_apply_status(db, task, scopes)

    assert result['eligible'] is True
    assert result['eligibilityMessage'] is None
    assert result['suggestedAction'] == 'apply'


@pytest.mark.parametrize(
    ('mutate', 'message'),
    [
        (lambda raw: raw['run'].__setitem__('provider', 'other'), '来源与教材任务不一致'),
        (lambda raw: raw['versions'][0].__setitem__('provider', 'other'), '无效或重复版本 ID'),
        (lambda raw: raw['versions'][0].__setitem__('external_version_id', 'bad/id'), '无效或重复版本 ID'),
        (lambda raw: raw['textbooks'][0].__setitem__('external_textbook_id', 'bad/id'), '无效或重复教材 ID'),
        (lambda raw: raw['textbooks'][0].__setitem__('version_external_id', 'missing-version'), '引用了不在同一快照中的版本'),
    ],
)
def test_snapshot_normalization_validates_provider_ids_and_version_reference(
    mutate: Any,
    message: str,
) -> None:
    raw = _snapshot(9)
    mutate(raw)

    with pytest.raises(ServiceException, match=message):
        textbook_apply_service._normalise_snapshot(raw, 9, 9)


@pytest.mark.asyncio
async def test_apply_rollback_restore_preserves_keys_order_provider_and_history(
    db: AsyncSession,
    snapshot_reader: Mapping[int, dict[str, Any]],
) -> None:
    await _seed_tasks_and_other_provider(db)

    applied = await _apply_task9(db)
    assert applied['action'] == 'apply'
    assert applied['versions'] == {'inserted': 2, 'updated': 0, 'unchanged': 0, 'disabled': 0}
    assert applied['textbooks'] == {'inserted': 2, 'updated': 0, 'unchanged': 0, 'disabled': 0}

    versions = list(
        (
            await db.execute(
                select(QbTextbookVersion)
                .where(QbTextbookVersion.source_provider == 'zujuan')
                .order_by(QbTextbookVersion.sort_order, QbTextbookVersion.external_version_id)
            )
        )
        .scalars()
        .all()
    )
    textbooks = list(
        (
            await db.execute(
                select(QbTextbook)
                .where(QbTextbook.source_provider == 'zujuan')
                .order_by(QbTextbook.sort_order, QbTextbook.external_textbook_id)
            )
        )
        .scalars()
        .all()
    )
    assert [(row.external_version_id, row.sort_order) for row in versions] == [('version-b', 10), ('version-a', 20)]
    assert [(row.external_textbook_id, row.sort_order) for row in textbooks] == [('textbook-b', 10), ('textbook-a', 20)]
    original_version_keys = {row.external_version_id: row.version_id for row in versions}
    original_textbook_keys = {row.external_textbook_id: row.textbook_id for row in textbooks}
    assert {row.external_textbook_id: row.version_id for row in textbooks} == {
        'textbook-a': original_version_keys['version-a'],
        'textbook-b': original_version_keys['version-b'],
    }

    rolled_back = await TextbookApplyService.apply(db, 8, expected_current_task_id=9, operator='tester')
    assert rolled_back['action'] == 'rollback'
    assert rolled_back['versions'] == {'inserted': 0, 'updated': 1, 'unchanged': 0, 'disabled': 1}
    assert rolled_back['textbooks'] == {'inserted': 0, 'updated': 1, 'unchanged': 0, 'disabled': 1}
    disabled_version = await db.scalar(
        select(QbTextbookVersion).where(QbTextbookVersion.external_version_id == 'version-b')
    )
    disabled_textbook = await db.scalar(
        select(QbTextbook).where(QbTextbook.external_textbook_id == 'textbook-b')
    )
    assert disabled_version is not None and disabled_version.status == '1'
    assert disabled_textbook is not None and disabled_textbook.status == '1'

    restored = await TextbookApplyService.apply(db, 9, expected_current_task_id=8, operator='tester')
    assert restored['action'] == 'restore'
    assert restored['versions']['inserted'] == 0
    assert restored['textbooks']['inserted'] == 0
    current_versions = list(
        (await db.execute(select(QbTextbookVersion).where(QbTextbookVersion.source_provider == 'zujuan')))
        .scalars()
        .all()
    )
    current_textbooks = list(
        (await db.execute(select(QbTextbook).where(QbTextbook.source_provider == 'zujuan'))).scalars().all()
    )
    assert {row.external_version_id: row.version_id for row in current_versions} == original_version_keys
    assert {row.external_textbook_id: row.textbook_id for row in current_textbooks} == original_textbook_keys
    assert {row.status for row in current_versions} == {'0'}
    assert {row.status for row in current_textbooks} == {'0'}

    other_version = await db.get(QbTextbookVersion, 700)
    other_textbook = await db.get(QbTextbook, 800)
    assert other_version is not None and (other_version.version_name, other_version.status) == ('其他来源版本', '0')
    assert other_textbook is not None and (other_textbook.textbook_name, other_textbook.status) == ('其他来源教材', '0')

    history = list(
        (await db.execute(select(QbTextbookApplyHistory).order_by(QbTextbookApplyHistory.history_id)))
        .scalars()
        .all()
    )
    assert [(row.task_id, row.previous_task_id, row.action) for row in history] == [
        (9, None, 'apply'),
        (8, 9, 'rollback'),
        (9, 8, 'restore'),
    ]

    idempotent = await TextbookApplyService.apply(db, 9, expected_current_task_id=9, operator='tester')
    assert idempotent['alreadyApplied'] is True
    assert idempotent['stats'] == TextbookApplyService._empty_stats()
    assert (
        await db.scalar(select(func.count()).select_from(QbTextbookApplyHistory))
        == APPLY_ROLLBACK_RESTORE_HISTORY_COUNT
    )


@pytest.mark.asyncio
async def test_expected_current_task_conflict_changes_nothing(
    db: AsyncSession,
    snapshot_reader: Mapping[int, dict[str, Any]],
) -> None:
    await _seed_tasks_and_other_provider(db)
    await _apply_task9(db)

    with pytest.raises(ServiceException, match='正式教材版本已变化'):
        await TextbookApplyService.apply(db, 8, expected_current_task_id=123, operator='tester')

    state = await db.get(QbTextbookApplyState, 'zujuan')
    assert state is not None and state.current_task_id == CURRENT_TASK_ID
    assert await db.scalar(select(func.count()).select_from(QbTextbookApplyHistory)) == 1


@pytest.mark.asyncio
async def test_apply_exception_rolls_back_formal_rows_state_and_history(
    db: AsyncSession,
    snapshot_reader: Mapping[int, dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _seed_tasks_and_other_provider(db)
    await _apply_task9(db)
    before = {
        row.external_version_id: (row.version_name, row.status, row.sort_order)
        for row in (
            await db.execute(select(QbTextbookVersion).where(QbTextbookVersion.source_provider == 'zujuan'))
        )
        .scalars()
        .all()
    }

    async def fail_history(_db: AsyncSession, _row: QbTextbookApplyHistory) -> QbTextbookApplyHistory:
        raise RuntimeError('history insert failed')

    monkeypatch.setattr(TextbookApplyDao, 'add_history', fail_history)
    with pytest.raises(RuntimeError, match='history insert failed'):
        await TextbookApplyService.apply(db, 8, expected_current_task_id=9, operator='tester')

    state = await db.get(QbTextbookApplyState, 'zujuan')
    after = {
        row.external_version_id: (row.version_name, row.status, row.sort_order)
        for row in (
            await db.execute(select(QbTextbookVersion).where(QbTextbookVersion.source_provider == 'zujuan'))
        )
        .scalars()
        .all()
    }
    assert state is not None and state.current_task_id == CURRENT_TASK_ID
    assert after == before
    assert await db.scalar(select(func.count()).select_from(QbTextbookApplyHistory)) == 1


@pytest.mark.asyncio
async def test_delete_current_formal_task_is_rejected(
    db: AsyncSession,
    snapshot_reader: Mapping[int, dict[str, Any]],
) -> None:
    await _seed_tasks_and_other_provider(db)
    await _apply_task9(db)

    with pytest.raises(ServiceException, match='任务当前对应正式教材版本，不能删除'):
        await SyncTaskService.delete_textbook(db, 9)

    assert await db.get(QbSyncJob, 9) is not None


@pytest.mark.asyncio
async def test_state_missing_table_compatibility_preserves_loaded_transaction(monkeypatch: pytest.MonkeyPatch) -> None:
    db = SimpleNamespace(rollback=AsyncMock())
    missing = SQLAlchemyError('(1146, "Table qb_textbook_apply_state doesn\'t exist")')
    monkeypatch.setattr(TextbookApplyDao, 'get_state', AsyncMock(side_effect=missing))

    assert await TextbookApplyService._state(db) is None
    db.rollback.assert_not_awaited()

    unrelated = SQLAlchemyError('connection lost')
    monkeypatch.setattr(TextbookApplyDao, 'get_state', AsyncMock(side_effect=unrelated))
    with pytest.raises(SQLAlchemyError, match='connection lost'):
        await TextbookApplyService._state(db)
    db.rollback.assert_not_awaited()


@pytest.mark.asyncio
async def test_add_state_recovers_from_concurrent_provider_insert(monkeypatch: pytest.MonkeyPatch) -> None:
    winner = QbTextbookApplyState(source_provider='zujuan')

    class Savepoint:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(self, *_args: object) -> None:
            return None

    db = SimpleNamespace(
        begin_nested=Savepoint,
        add=lambda _row: None,
        flush=AsyncMock(side_effect=IntegrityError('insert state', {}, Exception('duplicate key'))),
    )
    get_state = AsyncMock(return_value=winner)
    monkeypatch.setattr(TextbookApplyDao, 'get_state', get_state)

    assert await TextbookApplyDao.add_state(db, 'zujuan') is winner
    get_state.assert_awaited_once_with(db, 'zujuan', for_update=True)


@pytest.mark.asyncio
async def test_remote_snapshot_requires_immutable_lock_marker(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = _snapshot(9)
    payload['run']['versionCount'] = len(payload['versions'])
    payload['run']['textbookCount'] = len(payload['textbooks'])
    payload['run']['snapshotLockedAt'] = payload['run'].pop('snapshot_locked_at')

    class Client:
        def metadata_snapshot(self, _metadata_run_id: int) -> dict[str, Any]:
            return payload

    monkeypatch.setattr(textbook_apply_service, 'remote_collector_enabled', lambda: True)
    monkeypatch.setattr(textbook_apply_service, 'CollectorClient', Client)

    snapshot = await textbook_apply_service._read_snapshot(9)
    assert snapshot['run']['snapshotLockedAt']

    payload['run'].pop('snapshotLockedAt')
    with pytest.raises(ServiceException, match='缺少锁定标记'):
        await textbook_apply_service._read_snapshot(9)
