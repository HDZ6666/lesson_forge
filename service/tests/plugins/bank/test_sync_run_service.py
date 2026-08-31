from __future__ import annotations

import asyncio
import sqlite3
import sys
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import TYPE_CHECKING

import pytest

from exceptions.exception import ServiceException
from plugins.bank.service import sync_run_service as module

if TYPE_CHECKING:
    from pathlib import Path


CHILD_FAILURE_EXIT_CODE = 7
CONTENT_SCRIPT_COUNT = 2
EXEC_METADATA_RUN_ID = 10
SELECTED_TEXTBOOK_COUNT = 2
CURRENT_METADATA_RUN_ID = 5
PARSED_METADATA_RUN_ID = 18
TOTAL_CATALOG_COUNT = 10
TOTAL_QUESTION_COUNT = 35
RACE_CATALOG_COUNT = 3
RACE_QUESTION_COUNT = 7
REMOTE_CATALOG_COUNT = 7
WAL_METADATA_RUN_ID = 7
REAL_METADATA_RUN_ID = 4
AUTO_RESUME_SOURCE_RUN_ID = 20


@pytest.mark.asyncio
async def test_run_script_preserves_non_zero_child_exit_code(monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed collector process must be visible to the orchestration layer."""

    async def no_update(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr(module, '_update_row', no_update)
    monkeypatch.setattr(module, '_current_status', lambda _run_id: _running())

    async def _no_persist(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr(module, '_persist_output', _no_persist)
    result = module._ScriptResult(returncode=0, lines=[])
    handle = module._WorkerHandle(token='test-token')

    await module._run_script(
        1,
        handle,
        [
            sys.executable,
            '-c',
            f"import sys; print('collector failed'); sys.exit({CHILD_FAILURE_EXIT_CODE})",
        ],
        result,
    )

    assert result.returncode == CHILD_FAILURE_EXIT_CODE
    assert result.lines == ['collector failed']


async def _running() -> str:
    return 'running'


def test_exception_message_reads_service_exception_message() -> None:
    error = ServiceException(message='采集库已锁定')

    assert str(error) == '采集库已锁定'
    assert module._exception_message(error, '同步任务执行失败') == '采集库已锁定'


def test_safe_partial_progress_requires_all_core_snapshot_tables() -> None:
    complete_page = {
        'counts': {
            'catalogItemCount': 2,
            'questionItemCount': 10,
            'questionCatalogCount': 10,
            'questionTagCount': 0,
            'questionAssetCount': 0,
        }
    }
    assert module._has_safe_partial_progress(complete_page) is True
    assert module._has_safe_partial_progress(
        {'counts': {**complete_page['counts'], 'questionCatalogCount': 0, 'questionTagCount': 5}}
    ) is False
    assert module._has_safe_partial_progress({'counts': {'questionAssetCount': 50}}) is False


def test_auto_resume_policy_is_bounded_and_can_be_disabled() -> None:
    assert module._auto_resume_enabled({}) is True
    assert module._auto_resume_enabled({'autoResume': 'false'}) is False
    assert module._bounded_auto_resume_attempts({}) == module.AUTO_RESUME_MAX_ATTEMPTS
    assert (
        module._bounded_auto_resume_attempts({'autoResumeMaxAttempts': 99})
        == module.AUTO_RESUME_HARD_MAX_ATTEMPTS
    )
    assert module._bounded_auto_resume_attempts({'autoResumeMaxAttempts': -1}) == 0


@pytest.mark.asyncio
async def test_mark_auto_resume_pending_persists_backoff_state(monkeypatch: pytest.MonkeyPatch) -> None:
    row = SimpleNamespace(task_module='question', options_json={})
    writes: list[tuple[int, dict[str, object], tuple[str, ...] | None]] = []

    async def load_row(_run_id: int) -> object:
        return row

    async def update_row(
        run_id: int,
        values: dict[str, object],
        *,
        expected_statuses: tuple[str, ...] | None = None,
    ) -> bool:
        writes.append((run_id, values, expected_statuses))
        return True

    monkeypatch.setattr(module, '_load_row', load_row)
    monkeypatch.setattr(module, '_update_row', update_row)

    assert await module._mark_auto_resume_pending(12, AUTO_RESUME_SOURCE_RUN_ID) is True
    options = writes[0][1]['options_json']
    assert isinstance(options, dict)
    assert options['autoResumeAttempt'] == 1
    assert options['autoResumePending'] is True
    assert options['autoResumeSourceRunId'] == AUTO_RESUME_SOURCE_RUN_ID
    assert options['autoResumeNextAt']
    assert writes[0][2] == ('starting', 'running')


def test_headful_defaults_true_and_rejects_invalid_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('BANK_COLLECTOR_HEADFUL', raising=False)
    assert module._headful() is True
    assert module._with_headful(['node', 'script.cjs']) == ['node', 'script.cjs', '--headful']

    monkeypatch.setenv('BANK_COLLECTOR_HEADFUL', 'false')
    assert module._headful() is False
    assert module._with_headful(['node', 'script.cjs']) == ['node', 'script.cjs']

    monkeypatch.setenv('BANK_COLLECTOR_HEADFUL', 'maybe')
    with pytest.raises(ServiceException) as exc_info:
        module._headful()
    assert 'BANK_COLLECTOR_HEADFUL' in module._exception_message(exc_info.value, '')


def test_metadata_watermark_reads_wal_database_under_non_ascii_path(tmp_path: Path) -> None:
    collector_dir = tmp_path / '中文采集库'
    collector_dir.mkdir()
    db_path = collector_dir / '教材.sqlite3'
    writer = sqlite3.connect(db_path)
    try:
        assert writer.execute('PRAGMA journal_mode = WAL').fetchone()[0] == 'wal'
        writer.execute('CREATE TABLE source_metadata_runs (id INTEGER PRIMARY KEY)')
        writer.execute('INSERT INTO source_metadata_runs (id) VALUES (?)', (WAL_METADATA_RUN_ID,))
        writer.commit()

        assert module._metadata_run_watermark_sync(db_path) == WAL_METADATA_RUN_ID
    finally:
        writer.close()


@pytest.mark.asyncio
async def test_execute_metadata_task_only_runs_versions_and_textbooks(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    commands: list[list[str]] = []
    updates: list[dict[str, object]] = []
    finished: list[dict[str, object]] = []
    metadata_result = module._ScriptResult(
        returncode=0,
        lines=['[启动] metadata-run=10', '[版本] 发现 2 个版本'],
        metadata_run_id=10,
        versions_count=2,
        textbooks_count=2,
    )

    async def fake_run_script(_run_id: int, _handle: object, command: list[str], _result: object) -> object:
        commands.append(command)
        return metadata_result

    async def fake_update(
        _run_id: int,
        values: dict[str, object],
        **_kwargs: object,
    ) -> bool:
        updates.append(values)
        return True

    async def fake_status(_run_id: int) -> str:
        return 'running'

    async def fake_finish(
        _run_id: int, _handle: object, status: str, phase: str, error_message: str | None, **kwargs: object
    ) -> None:
        finished.append({'status': status, 'phase': phase, 'errorMessage': error_message, **kwargs})

    async def fake_materialize(_run_id: int, _metadata_run_id: int) -> None:
        return None

    monkeypatch.setattr(module, '_run_script', fake_run_script)
    monkeypatch.setattr(module, '_update_row', fake_update)
    monkeypatch.setattr(module, '_current_status', fake_status)
    monkeypatch.setattr(module, '_finish', fake_finish)
    monkeypatch.setattr(module, '_materialize_textbook_scopes', fake_materialize)
    monkeypatch.setattr(module, '_node_command', lambda: '/usr/local/bin/node')
    monkeypatch.setattr(module, '_collector_path', lambda: tmp_path / 'collector.sqlite3')
    monkeypatch.delenv('BANK_COLLECTOR_HEADFUL', raising=False)
    monkeypatch.setattr(module, '_metadata_run_watermark_sync', lambda _path: 9)
    monkeypatch.setattr(
        module,
        '_read_metadata_run_sync',
        lambda _path, run_id: {
            'id': run_id,
            'version_count': 2,
            'textbook_count': 2,
        },
    )

    await module._execute(1, module._WorkerHandle(token='test-token'))

    assert len(commands) == 1
    assert commands[0][1:] == [
        str(module.METADATA_SCRIPT),
        '--acknowledge-source-policy',
        '--db',
        str(tmp_path / 'collector.sqlite3'),
        '--headful',
    ]
    assert finished == [
        {
            'status': 'completed',
            'phase': 'completed',
            'errorMessage': None,
            'total_textbooks': 2,
            'completed_textbooks': 2,
        }
    ]
    assert any(update.get('metadata_run_id') == EXEC_METADATA_RUN_ID for update in updates)
    assert not any(update.get('phase') == 'catalogs_questions' for update in updates)


@pytest.mark.asyncio
async def test_execute_content_task_runs_all_selected_textbooks_in_one_task(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    commands: list[list[str]] = []
    updates: list[dict[str, object]] = []
    finished: list[dict[str, object]] = []
    results = iter(
        [
            module._ScriptResult(
                returncode=0,
                lines=['[目录] 本次同步 3 个节点', 'questionsSeen: 11'],
                catalog_count=3,
                question_count=11,
            ),
            module._ScriptResult(
                returncode=0,
                lines=['[目录] 本次同步 4 个节点', 'questionsSeen: 13'],
                catalog_count=4,
                question_count=13,
            ),
        ]
    )

    async def fake_run_script(_run_id: int, _handle: object, command: list[str], _result: object) -> object:
        commands.append(command)
        return next(results)

    async def fake_update(
        _run_id: int,
        values: dict[str, object],
        **_kwargs: object,
    ) -> bool:
        updates.append(values)
        return True

    async def fake_status(_run_id: int) -> str:
        return 'running'

    async def fake_finish(
        _run_id: int, _handle: object, status: str, phase: str, error_message: str | None, **kwargs: object
    ) -> None:
        finished.append({'status': status, 'phase': phase, 'errorMessage': error_message, **kwargs})

    monkeypatch.setattr(module, '_run_script', fake_run_script)
    monkeypatch.setattr(module, '_update_row', fake_update)
    monkeypatch.setattr(module, '_current_status', fake_status)
    monkeypatch.setattr(module, '_finish', fake_finish)
    monkeypatch.setattr(module, '_node_command', lambda: '/usr/local/bin/node')
    monkeypatch.setattr(module, '_collector_path', lambda: tmp_path / 'collector.sqlite3')
    monkeypatch.delenv('BANK_COLLECTOR_HEADFUL', raising=False)

    async def fake_load_row(_run_id: int) -> None:
        raise RuntimeError('unit test has no durable row')

    monkeypatch.setattr(module, '_load_row', fake_load_row)
    monkeypatch.setattr(
        module,
        '_read_metadata_batch_sync',
        lambda _path, run_id, selected_ids: module._MetadataBatch(
            run_id=run_id,
            versions_count=2,
            textbooks=[
                {
                    'external_textbook_id': 'tb-1',
                    'textbook_name': '教材一',
                    'version_external_id': 'v-1',
                    'bootstrap_chapter_external_id': 'c-1',
                },
                {
                    'external_textbook_id': 'tb-2',
                    'textbook_name': '教材二',
                    'version_external_id': 'v-2',
                    'bootstrap_chapter_external_id': 'c-2',
                },
            ],
        ),
    )
    monkeypatch.setenv('BANK_SYNC_MAX_PAGES', '4')

    await module._execute(
        1,
        module._WorkerHandle(
            token='test-token',
            run_type='content',
            metadata_run_id=10,
            textbook_external_ids=['tb-1', 'tb-2'],
        ),
    )

    assert len(commands) == CONTENT_SCRIPT_COUNT
    assert all(command[1] == str(module.QUESTION_SCRIPT) for command in commands)
    assert [command[command.index('--textbook-id') + 1] for command in commands] == ['tb-1', 'tb-2']
    assert all('--chapter-id' not in command for command in commands)
    assert all('--all-catalogs' not in command for command in commands)
    assert all('--refresh-details' not in command for command in commands)
    assert all('--download-assets' not in command for command in commands)
    assert all('--include-visible-solutions' not in command for command in commands)
    assert all('--no-resume' in command for command in commands)
    assert all('--headful' in command for command in commands)
    assert finished == [
        {
            'status': 'completed',
            'phase': 'completed',
            'errorMessage': None,
            'catalog_count': 7,
            'question_count': 24,
            'total_textbooks': 2,
            'completed_textbooks': 2,
        }
    ]
    assert any(update.get('metadata_run_id') == EXEC_METADATA_RUN_ID for update in updates)
    assert any(update.get('total_textbooks') == SELECTED_TEXTBOOK_COUNT for update in updates)


@pytest.mark.asyncio
async def test_local_question_scope_write_failure_prevents_parent_completion(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    commands: list[list[str]] = []
    finished: list[dict[str, object]] = []

    async def fake_run_script(_run_id: int, _handle: object, command: list[str], _result: object) -> object:
        commands.append(command)
        return module._ScriptResult(returncode=0, lines=[])

    async def fake_update_row(*_args: object, **_kwargs: object) -> bool:
        return True

    async def fail_scope_write(*_args: object, **_kwargs: object) -> bool:
        return False

    async def fake_status(_run_id: int) -> str:
        return 'running'

    async def fake_finish(
        _run_id: int,
        _handle: object,
        status: str,
        phase: str,
        error_message: str | None,
        **_kwargs: object,
    ) -> None:
        finished.append({'status': status, 'phase': phase, 'errorMessage': error_message})

    monkeypatch.setattr(module, '_run_script', fake_run_script)
    monkeypatch.setattr(module, '_update_row', fake_update_row)
    monkeypatch.setattr(module, '_update_scope_values', fail_scope_write)
    monkeypatch.setattr(module, '_current_status', fake_status)
    monkeypatch.setattr(module, '_finish', fake_finish)
    monkeypatch.setattr(module, '_load_row', lambda _run_id: None)
    monkeypatch.setattr(module, '_node_command', lambda: '/usr/local/bin/node')
    monkeypatch.setattr(module, '_collector_path', lambda: tmp_path / 'collector.sqlite3')
    monkeypatch.setattr(
        module,
        '_read_metadata_batch_sync',
        lambda _path, run_id, _selected_ids: module._MetadataBatch(
            run_id=run_id,
            versions_count=1,
            textbooks=[
                {
                    'external_textbook_id': 'tb-1',
                    'textbook_name': '教材一',
                    'version_external_id': 'v-1',
                    'bootstrap_chapter_external_id': 'c-1',
                }
            ],
        ),
    )

    await module._execute(
        1,
        module._WorkerHandle(
            token='test-token',
            run_type='content',
            task_module='question',
            metadata_run_id=None,
            textbook_external_ids=['tb-1'],
            textbook_scopes=[
                {
                    'sourceProvider': 'zujuan',
                    'externalVersionId': 'v-1',
                    'externalTextbookId': 'tb-1',
                    'versionName': '版本一',
                    'textbookName': '教材一',
                }
            ],
        ),
    )

    assert commands == []
    assert finished and finished[0]['status'] == 'failed'
    assert '无法进入运行状态' in str(finished[0]['errorMessage'])


@pytest.mark.asyncio
async def test_execute_remote_maps_terminal_collector_status(monkeypatch: pytest.MonkeyPatch) -> None:
    updates: list[dict[str, object]] = []
    finished: list[dict[str, object]] = []
    remote_job_id = '00000000-0000-0000-0000-000000000001'

    class FakeCollectorClient:
        def start_job(self, run_type: str, **kwargs: object) -> dict[str, object]:
            assert run_type == 'content'
            assert kwargs == {
                'max_pages': 4,
                'metadata_run_id': 10,
                'textbook_external_ids': ['tb-1'],
            }
            return {
                'id': remote_job_id,
                'status': 'completed',
                'metadataRunId': 10,
                'totalTextbooks': 1,
                'completedTextbooks': 1,
                'catalogCount': 7,
                'questionCount': 24,
                'progressPercent': 100,
                'logTail': '远程采集完成',
            }

    async def fake_update(
        _run_id: int,
        values: dict[str, object],
        **_kwargs: object,
    ) -> bool:
        updates.append(values)
        return True

    async def fake_status(_run_id: int) -> str:
        return 'running'

    async def fake_finish(
        _run_id: int,
        _handle: object,
        status: str,
        phase: str,
        error_message: str | None,
        **kwargs: object,
    ) -> None:
        finished.append({'status': status, 'phase': phase, 'errorMessage': error_message, **kwargs})

    monkeypatch.setattr(module, 'CollectorClient', FakeCollectorClient)
    monkeypatch.setattr(module, '_update_row', fake_update)
    monkeypatch.setattr(module, '_current_status', fake_status)
    monkeypatch.setattr(module, '_finish', fake_finish)

    handle = module._WorkerHandle(
        token='test-token',
        run_type='content',
        metadata_run_id=10,
        textbook_external_ids=['tb-1'],
    )
    await module._execute_remote(1, handle, 4)

    assert handle.remote_job_id == remote_job_id
    assert updates[-1]['metadata_run_id'] == EXEC_METADATA_RUN_ID
    assert updates[-1]['catalog_count'] == REMOTE_CATALOG_COUNT
    assert finished == [
        {
            'status': 'completed',
            'phase': 'completed',
            'errorMessage': None,
            'catalog_count': 7,
            'question_count': 24,
            'total_textbooks': 1,
            'completed_textbooks': 1,
        }
    ]


@pytest.mark.asyncio
async def test_remote_question_parent_requires_every_scope_run_id_before_completion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    remote_job_id = '00000000-0000-0000-0000-000000000010'

    class FakeCollectorClient:
        def start_job(self, _run_type: str, **_kwargs: object) -> dict[str, object]:
            return {
                'id': remote_job_id,
                'status': 'completed',
                'totalTextbooks': 1,
                'completedTextbooks': 1,
                'progressPercent': 100,
                'scopeItems': [
                    {
                        'externalTextbookId': 'tb-1',
                        'status': 'completed',
                        # A terminal scope without a collector run is not a
                        # readable immutable snapshot.
                        'collectorRunId': None,
                    }
                ],
            }

    async def fake_update(*_args: object, **_kwargs: object) -> bool:
        return True

    async def fake_status(_run_id: int) -> str:
        return 'running'

    async def fake_scopes(_run_id: int) -> list[object]:
        return [SimpleNamespace(external_textbook_id='tb-1', status='completed', collector_run_id=None)]

    monkeypatch.setattr(module, 'CollectorClient', FakeCollectorClient)
    monkeypatch.setattr(module, '_update_row', fake_update)
    monkeypatch.setattr(module, '_update_scope_values', fake_update)
    monkeypatch.setattr(module, '_current_status', fake_status)
    monkeypatch.setattr(module, '_load_scopes', fake_scopes)

    with pytest.raises(ServiceException) as error:
        await module._execute_remote(
            1,
            module._WorkerHandle(
                token='test-token',
                run_type='content',
                task_module='question',
                metadata_run_id=10,
                textbook_external_ids=['tb-1'],
            ),
            4,
        )

    assert 'collectorRunId' in error.value.message


@pytest.mark.asyncio
async def test_remote_scope_write_failure_fails_parent_instead_of_completing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    remote_job_id = '00000000-0000-0000-0000-000000000011'

    class FakeCollectorClient:
        def start_job(self, _run_type: str, **_kwargs: object) -> dict[str, object]:
            return {
                'id': remote_job_id,
                'status': 'running',
                'scopeItems': [
                    {'externalTextbookId': 'tb-1', 'status': 'running', 'collectorRunId': 12},
                ],
            }

    async def fake_update_row(*_args: object, **_kwargs: object) -> bool:
        return True

    async def fake_update_scope(*_args: object, **_kwargs: object) -> bool:
        return False

    async def fake_status(_run_id: int) -> str:
        return 'running'

    async def no_scopes(_run_id: int) -> list[object]:
        return []

    monkeypatch.setattr(module, 'CollectorClient', FakeCollectorClient)
    monkeypatch.setattr(module, '_update_row', fake_update_row)
    monkeypatch.setattr(module, '_update_scope_values', fake_update_scope)
    monkeypatch.setattr(module, '_current_status', fake_status)
    monkeypatch.setattr(module, '_load_scopes', no_scopes)

    with pytest.raises(ServiceException) as error:
        await module._execute_remote(
            1,
            module._WorkerHandle(
                token='test-token',
                run_type='content',
                task_module='question',
                metadata_run_id=10,
                textbook_external_ids=['tb-1'],
            ),
            4,
        )

    assert '写入失败' in error.value.message


@pytest.mark.asyncio
async def test_remote_question_parent_completes_only_after_all_scopes_are_verified(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    remote_job_id = '00000000-0000-0000-0000-000000000012'
    run_ids = {'tb-1': 21, 'tb-2': 22}
    snapshot_counts = {
        'tb-1': (3, 10, 12, 4, 2),
        'tb-2': (5, 20, 25, 6, 3),
    }
    finished: list[dict[str, object]] = []

    class FakeCollectorClient:
        def start_job(self, _run_type: str, **_kwargs: object) -> dict[str, object]:
            return {
                'id': remote_job_id,
                'status': 'completed',
                'totalTextbooks': 2,
                'completedTextbooks': 2,
                'progressPercent': 100,
                'scopeItems': [
                    {'externalTextbookId': external_id, 'status': 'completed', 'collectorRunId': collector_id}
                    for external_id, collector_id in run_ids.items()
                ],
            }

        def run_snapshot_summary(self, run_id: int, **kwargs: object) -> dict[str, object]:
            external_id = str(kwargs['textbook_external_id'])
            catalog_count, question_count, relation_count, tag_count, asset_count = snapshot_counts[external_id]
            return {
                'available': True,
                'immutable': True,
                'snapshotComplete': True,
                'run': {
                    'id': run_id,
                    'provider': 'zujuan',
                    'status': 'success',
                    'errorCount': 0,
                    'finishedAt': '2026-08-29T10:00:00',
                    'snapshotLockedAt': '2026-08-29T10:00:01',
                    'snapshotComplete': True,
                    'textbookExternalIds': [external_id],
                },
                'counts': {
                    'catalogItemCount': catalog_count,
                    'questionItemCount': question_count,
                    'questionCatalogCount': relation_count,
                    'questionTagCount': tag_count,
                    'questionAssetCount': asset_count,
                },
            }

    async def fake_update(*_args: object, **_kwargs: object) -> bool:
        return True

    async def fake_status(_run_id: int) -> str:
        return 'running'

    async def fake_scopes(_run_id: int) -> list[object]:
        return [
            SimpleNamespace(
                external_textbook_id=external_id,
                status='completed',
                collector_run_id=collector_id,
            )
            for external_id, collector_id in run_ids.items()
        ]

    async def fake_finish(
        _run_id: int,
        _handle: object,
        status: str,
        phase: str,
        error_message: str | None,
        **kwargs: object,
    ) -> None:
        finished.append({'status': status, 'phase': phase, 'errorMessage': error_message, **kwargs})

    monkeypatch.setattr(module, 'CollectorClient', FakeCollectorClient)
    monkeypatch.setattr(module, '_update_row', fake_update)
    monkeypatch.setattr(module, '_update_scope_values', fake_update)
    monkeypatch.setattr(module, '_current_status', fake_status)
    monkeypatch.setattr(module, '_load_scopes', fake_scopes)
    monkeypatch.setattr(module, '_finish', fake_finish)

    await module._execute_remote(
        1,
        module._WorkerHandle(
            token='test-token',
            run_type='content',
            task_module='question',
            metadata_run_id=10,
            textbook_external_ids=list(run_ids),
        ),
        4,
    )

    assert finished == [
        {
            'status': 'completed',
            'phase': 'completed',
            'errorMessage': None,
            'catalog_count': 8,
            'question_count': 30,
            'total_textbooks': 2,
            'completed_textbooks': 2,
            'question_catalog_count': 37,
            'question_tag_count': 10,
            'question_asset_count': 5,
            'snapshot_complete': True,
            'snapshot_locked_at': datetime(2026, 8, 29, 10, 0, 1),
        }
    ]


@pytest.mark.asyncio
async def test_remote_question_parent_rejects_failed_terminal_scope_projection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    remote_job_id = '00000000-0000-0000-0000-000000000013'
    collector_run_id = 31

    class FakeCollectorClient:
        def start_job(self, _run_type: str, **_kwargs: object) -> dict[str, object]:
            return {
                'id': remote_job_id,
                'status': 'completed',
                'totalTextbooks': 1,
                'completedTextbooks': 1,
                'scopeItems': [
                    {
                        'externalTextbookId': 'tb-1',
                        'status': 'completed',
                        'collectorRunId': collector_run_id,
                    }
                ],
            }

        def run_snapshot_summary(self, run_id: int, **kwargs: object) -> dict[str, object]:
            assert run_id == collector_run_id and kwargs['textbook_external_id'] == 'tb-1'
            return {
                'available': True,
                'immutable': True,
                'snapshotComplete': True,
                'run': {
                    'id': collector_run_id,
                    'provider': 'zujuan',
                    'status': 'success',
                    'errorCount': 0,
                    'finishedAt': '2026-08-29T10:00:00',
                    'snapshotLockedAt': '2026-08-29T10:00:01',
                    'snapshotComplete': True,
                    'textbookExternalIds': ['tb-1'],
                },
                'counts': {
                    'catalogItemCount': 3,
                    'questionItemCount': 10,
                    'questionCatalogCount': 12,
                    'questionTagCount': 4,
                    'questionAssetCount': 2,
                },
            }

    async def fake_update_row(*_args: object, **_kwargs: object) -> bool:
        return True

    async def fake_update_scope(
        _run_id: int,
        values: dict[str, object],
        **_kwargs: object,
    ) -> bool:
        # Initial job projection succeeds; the authoritative summary write
        # fails and the durable scope remains stale.
        return 'question_catalog_count' not in values

    async def fake_status(_run_id: int) -> str:
        return 'running'

    async def stale_scope(_run_id: int) -> list[object]:
        return [
            SimpleNamespace(
                external_textbook_id='tb-1',
                status='completed',
                collector_run_id=collector_run_id,
            )
        ]

    monkeypatch.setattr(module, 'CollectorClient', FakeCollectorClient)
    monkeypatch.setattr(module, '_update_row', fake_update_row)
    monkeypatch.setattr(module, '_update_scope_values', fake_update_scope)
    monkeypatch.setattr(module, '_current_status', fake_status)
    monkeypatch.setattr(module, '_load_scopes', stale_scope)

    with pytest.raises(ServiceException, match='最终状态写入失败'):
        await module._execute_remote(
            1,
            module._WorkerHandle(
                token='test-token',
                run_type='content',
                task_module='question',
                metadata_run_id=10,
                textbook_external_ids=['tb-1'],
            ),
            4,
        )


@pytest.mark.asyncio
async def test_recovery_retries_recent_rows_and_terminalizes_after_heartbeat_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSession:
        async def __aenter__(self) -> FakeSession:
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def commit(self) -> None:
            return None

    row = SimpleNamespace(
        run_id=77,
        status='cancelling',
        update_time=datetime.now(),
        collector_job_id=None,
        run_type='content',
        task_module='question',
        metadata_run_id=None,
        options_json={
            'textbookExternalIds': ['tb-1'],
            'textbookScopes': [
                {
                    'sourceProvider': 'zujuan',
                    'externalVersionId': 'version-1',
                    'externalTextbookId': 'tb-1',
                    'versionName': '版本 1',
                    'textbookName': '教材 1',
                }
            ],
        },
    )
    updates: list[dict[str, object]] = []

    async def list_active(_db: object) -> list[object]:
        return [row]

    async def update_fields(_db: object, _run_id: int, values: dict[str, object], **_kwargs: object) -> int:
        updates.append(values)
        return 1

    async def scopes(_db: object, _run_id: int) -> list[object]:
        return [
            SimpleNamespace(
                source_provider='zujuan',
                external_version_id='version-1',
                external_textbook_id='tb-1',
                version_name_snapshot='版本 1',
                textbook_name_snapshot='教材 1',
            )
        ]

    async def no_finalize(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr(module.DataSourceRegistry, 'session', FakeSession)
    monkeypatch.setattr(module.SyncJobDao, 'list_active', list_active)
    monkeypatch.setattr(module.SyncJobDao, 'update_fields', update_fields)
    monkeypatch.setattr(module.SyncTaskDao, 'scopes', scopes)
    monkeypatch.setattr(module, '_finalize_scopes', no_finalize)
    monkeypatch.setattr(module, 'remote_collector_enabled', lambda: False)

    await module.SyncRunService._recover_orphans_once()
    assert updates == []

    row.update_time = datetime.now() - timedelta(seconds=module.WORKER_HEARTBEAT_TIMEOUT_SECONDS + 1)
    await module.SyncRunService._recover_orphans_once()

    assert updates
    assert updates[-1]['status'] == 'cancelled'
    assert updates[-1]['phase'] == 'cancelled'


@pytest.mark.asyncio
async def test_recovery_monitor_runs_delayed_pass_and_can_be_stopped(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    async def recover() -> int:
        nonlocal calls
        calls += 1
        return 0

    monkeypatch.setattr(module.SyncRunService, 'recover_orphans', recover)
    monkeypatch.setattr(module, 'RECOVERY_MONITOR_INTERVAL_SECONDS', 0.001)
    module.SyncRunService.start_recovery_monitor()
    await asyncio.sleep(0.01)
    await module.SyncRunService.shutdown()

    assert calls > 0


@pytest.mark.asyncio
async def test_mark_interrupted_terminalizes_unfinished_scopes_with_parent() -> None:
    class Result:
        def __init__(self, rows: list[object]) -> None:
            self.rows = rows

        def scalars(self) -> Result:
            return self

        def all(self) -> list[object]:
            return self.rows

    class FakeDb:
        def __init__(self, jobs: list[object], scopes: list[object]) -> None:
            self.results = [Result(jobs), Result(scopes)]
            self.flush_count = 0

        async def execute(self, _statement: object) -> Result:
            return self.results.pop(0)

        async def flush(self) -> None:
            self.flush_count += 1

    now = datetime.now()
    job = SimpleNamespace(
        run_id=88,
        status='cancelling',
        phase='catalogs_questions',
        error_message=None,
        active_slot='1',
        process_id=123,
        worker_token='token',
        finished_at=None,
        update_time=now - timedelta(minutes=2),
    )
    scope = SimpleNamespace(
        run_id=88,
        status='running',
        error_message=None,
        finished_at=None,
        update_time=now - timedelta(minutes=2),
    )
    db = FakeDb([job], [scope])

    count = await module.SyncJobDao.mark_interrupted(db, 'worker lost', now - timedelta(minutes=1))

    assert count == 1
    assert job.status == 'cancelled'
    assert scope.status == 'cancelled'
    assert scope.error_message == '同步已停止'
    assert db.flush_count == SELECTED_TEXTBOOK_COUNT


@pytest.mark.asyncio
async def test_execute_treats_terminated_script_as_cancelled_when_cancel_requested(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    async def fake_run_script(_run_id: int, _handle: object, _command: list[str], _result: object) -> object:
        return module._ScriptResult(returncode=-15, lines=['[stderr] terminated'])

    statuses = iter(['cancelling'])

    async def fake_status(_run_id: int) -> str:
        return next(statuses, 'cancelling')

    finished: list[tuple[str, str, str | None]] = []

    async def fake_finish(
        _run_id: int, _handle: object, status: str, phase: str, error_message: str | None, **_kwargs: object
    ) -> None:
        finished.append((status, phase, error_message))

    async def no_update(*_args: object, **_kwargs: object) -> bool:
        return True

    monkeypatch.setattr(module, '_run_script', fake_run_script)
    monkeypatch.setattr(module, '_current_status', fake_status)
    monkeypatch.setattr(module, '_finish', fake_finish)
    monkeypatch.setattr(module, '_update_row', no_update)
    monkeypatch.setattr(module, '_node_command', lambda: '/usr/local/bin/node')
    monkeypatch.setattr(module, '_collector_path', lambda: tmp_path / 'collector.sqlite3')

    await module._execute(1, module._WorkerHandle(token='test-token'))

    assert finished == [('cancelled', 'cancelled', '同步已停止')]


@pytest.mark.asyncio
async def test_finish_preserves_cancellation_that_wins_terminal_state_race(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = 'cancelling'
    updates: list[tuple[dict[str, object], tuple[str, ...] | None]] = []

    async def fake_update(
        _run_id: int,
        values: dict[str, object],
        *,
        expected_statuses: tuple[str, ...] | None = None,
    ) -> bool:
        nonlocal state
        updates.append((values, expected_statuses))
        if expected_statuses is not None and state not in expected_statuses:
            return False
        state = str(values['status'])
        return True

    monkeypatch.setattr(module, '_update_row', fake_update)

    await module._finish(
        1,
        module._WorkerHandle(token='test-token'),
        'completed',
        'completed',
        None,
        catalog_count=RACE_CATALOG_COUNT,
        question_count=RACE_QUESTION_COUNT,
    )

    assert updates[0][1] == ('queued', 'starting', 'running')
    assert updates[1][1] == ('cancelling',)
    assert updates[1][0]['status'] == 'cancelled'
    assert updates[1][0]['phase'] == 'cancelled'
    assert updates[1][0]['error_message'] == '同步已停止'
    assert updates[1][0]['catalog_count'] == RACE_CATALOG_COUNT
    assert updates[1][0]['question_count'] == RACE_QUESTION_COUNT
    assert 'progress_percent' not in updates[1][0]
    assert state == 'cancelled'


def test_metadata_batch_only_returns_textbooks_seen_by_current_run(tmp_path: Path) -> None:
    db_path = tmp_path / 'collector.sqlite3'
    connection = sqlite3.connect(db_path)
    connection.executescript(
        """
        CREATE TABLE source_metadata_runs (
          id INTEGER PRIMARY KEY,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL,
          version_count INTEGER NOT NULL,
          textbook_count INTEGER NOT NULL
        );
        CREATE TABLE source_textbooks (
          provider TEXT NOT NULL,
          external_textbook_id TEXT NOT NULL,
          version_external_id TEXT NOT NULL,
          textbook_name TEXT NOT NULL,
          bootstrap_chapter_external_id TEXT,
          last_seen_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT '0',
          sort_order INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO source_metadata_runs VALUES
          (4, '2026-08-26T09:00:00.000Z', '2026-08-26T09:05:00.000Z', 'success', 1, 1),
          (5, '2026-08-26T10:00:00.000Z', '2026-08-26T10:05:00.000Z', 'success', 1, 1);
        INSERT INTO source_textbooks VALUES
          ('zujuan', 'old-book', 'old-version', '历史教材', 'old-chapter', '2026-08-26T09:02:00.000Z', '0', 1),
          ('zujuan', 'new-book', 'new-version', '本次教材', 'new-chapter', '2026-08-26T10:02:00.000Z', '0', 1);
        """
    )
    connection.commit()
    connection.close()

    batch = module._read_metadata_batch_sync(db_path, CURRENT_METADATA_RUN_ID)

    assert batch.run_id == CURRENT_METADATA_RUN_ID
    assert batch.versions_count == 1
    assert [row['external_textbook_id'] for row in batch.textbooks] == ['new-book']


def test_metadata_batch_prefers_immutable_snapshot_across_consecutive_runs(tmp_path: Path) -> None:
    """A later mutable current row must not change either run's snapshot."""

    db_path = tmp_path / 'collector.sqlite3'
    connection = sqlite3.connect(db_path)
    connection.executescript(
        """
        CREATE TABLE source_metadata_runs (
          id INTEGER PRIMARY KEY,
          provider TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL,
          version_count INTEGER NOT NULL,
          textbook_count INTEGER NOT NULL
        );
        CREATE TABLE source_textbooks (
          provider TEXT NOT NULL,
          external_textbook_id TEXT NOT NULL,
          version_external_id TEXT NOT NULL,
          textbook_name TEXT NOT NULL,
          bootstrap_chapter_external_id TEXT,
          last_seen_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT '0',
          sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE source_metadata_run_textbooks (
          run_id INTEGER NOT NULL,
          provider TEXT NOT NULL,
          external_textbook_id TEXT NOT NULL,
          version_external_id TEXT NOT NULL,
          textbook_name TEXT NOT NULL,
          grade TEXT,
          volume TEXT,
          source_url TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT '0',
          bootstrap_chapter_external_id TEXT,
          raw_json TEXT NOT NULL DEFAULT '{}',
          captured_at TEXT NOT NULL,
          PRIMARY KEY (run_id, provider, external_textbook_id)
        );
        INSERT INTO source_metadata_runs VALUES
          (6, 'zujuan', '2026-08-28T09:00:00.000Z', '2026-08-28T09:05:00.000Z', 'success', 1, 1),
          (7, 'zujuan', '2026-08-28T10:00:00.000Z', '2026-08-28T10:05:00.000Z', 'success', 1, 1);
        INSERT INTO source_textbooks VALUES
          ('zujuan', 'stable-book', 'stable-version', '当前表已刷新名称', 'stable-chapter',
           '2026-08-28T10:02:00.000Z', '0', 1);
        INSERT INTO source_metadata_run_textbooks VALUES
          (6, 'zujuan', 'stable-book', 'stable-version', '稳定快照教材', '七年级', '上册',
           'https://zujuan.xkw.com/czsx/zjstable-book/', 1, '0', 'stable-chapter', '{}', '2026-08-28T09:02:00.000Z'),
          (7, 'zujuan', 'stable-book', 'stable-version', '稳定快照教材', '七年级', '上册',
           'https://zujuan.xkw.com/czsx/zjstable-book/', 1, '0', 'stable-chapter', '{}', '2026-08-28T10:02:00.000Z');
        """
    )
    connection.commit()
    connection.close()

    first = module._read_metadata_batch_sync(db_path, 6)
    second = module._read_metadata_batch_sync(db_path, 7)

    assert first.textbooks[0]['textbook_name'] == '稳定快照教材'
    assert second.textbooks[0]['textbook_name'] == '稳定快照教材'
    assert first.textbooks[0]['textbook_name'] != '当前表已刷新名称'


def _metadata_textbook_snapshot_db(
    tmp_path: Path,
    *,
    textbook_id: str = '195860',
    source_url: str | None = 'https://zujuan.xkw.com/czsx/zj195860/',
    raw_json: str = '{"externalTextbookId":"195860","raw":{"href":"/czsx/zj195860/"}}',
    bootstrap: str | None = None,
) -> Path:
    db_path = tmp_path / 'metadata-snapshot.sqlite3'
    connection = sqlite3.connect(db_path)
    connection.executescript(
        """
        CREATE TABLE source_metadata_runs (
          id INTEGER PRIMARY KEY,
          provider TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL,
          version_count INTEGER NOT NULL,
          textbook_count INTEGER NOT NULL
        );
        CREATE TABLE source_metadata_run_textbooks (
          run_id INTEGER NOT NULL,
          provider TEXT NOT NULL,
          external_textbook_id TEXT NOT NULL,
          version_external_id TEXT NOT NULL,
          textbook_name TEXT NOT NULL,
          grade TEXT,
          volume TEXT,
          source_url TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT '0',
          bootstrap_chapter_external_id TEXT,
          raw_json TEXT NOT NULL DEFAULT '{}',
          captured_at TEXT NOT NULL,
          PRIMARY KEY (run_id, provider, external_textbook_id)
        );
        """
    )
    connection.execute(
        'INSERT INTO source_metadata_runs VALUES (?, ?, ?, ?, ?, ?, ?)',
        (
            REAL_METADATA_RUN_ID,
            'zujuan',
            '2026-08-28T15:06:50.423Z',
            '2026-08-28T15:08:13.012Z',
            'success',
            1,
            1,
        ),
    )
    connection.execute(
        """
        INSERT INTO source_metadata_run_textbooks (
          run_id, provider, external_textbook_id, version_external_id,
          textbook_name, source_url, sort_order, status,
          bootstrap_chapter_external_id, raw_json, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            REAL_METADATA_RUN_ID,
            'zujuan',
            textbook_id,
            '195846',
            '七年级上册',
            source_url,
            0,
            '0',
            bootstrap,
            raw_json,
            '2026-08-28T15:07:00.000Z',
        ),
    )
    connection.commit()
    connection.close()
    return db_path


def test_metadata_batch_accepts_empty_bootstrap_from_real_source_locators(tmp_path: Path) -> None:
    db_path = _metadata_textbook_snapshot_db(tmp_path)

    batch = module._read_metadata_batch_sync(db_path, REAL_METADATA_RUN_ID)

    assert batch.run_id == REAL_METADATA_RUN_ID
    assert batch.textbooks == [
        {
            'external_textbook_id': '195860',
            'textbook_name': '七年级上册',
            'version_external_id': '195846',
            'bootstrap_chapter_external_id': None,
        }
    ]


@pytest.mark.parametrize(
    'source_url,raw_json,expected_message',
    [
        (
            'https://evil.example/czsx/zj195860/',
            '{"externalTextbookId":"195860","raw":{"href":"/czsx/zj195860/"}}',
            '来源不受支持',
        ),
        (
            'https://zujuan.xkw.com/czsx/zj195861/',
            '{"externalTextbookId":"195860","raw":{"href":"/czsx/zj195860/"}}',
            '不匹配',
        ),
        (
            'https://zujuan.xkw.com/czsx/zj195860/',
            '{"externalTextbookId":"195860","raw":{"href":"/czsx/zj195861/"}}',
            '不匹配',
        ),
    ],
)
def test_metadata_batch_rejects_source_locator_mismatch(
    tmp_path: Path,
    source_url: str,
    raw_json: str,
    expected_message: str,
) -> None:
    db_path = _metadata_textbook_snapshot_db(tmp_path, source_url=source_url, raw_json=raw_json)

    with pytest.raises(ServiceException) as error:
        module._read_metadata_batch_sync(db_path, REAL_METADATA_RUN_ID)

    assert '教材 195860' in (error.value.message or '')
    assert expected_message in (error.value.message or '')


@pytest.mark.parametrize(
    'raw_json',
    [
        '{',
        '[]',
        '{"raw":[]}',
        '{"raw":{"attributes":[]}}',
    ],
)
def test_metadata_batch_rejects_invalid_or_malformed_raw_json(tmp_path: Path, raw_json: str) -> None:
    db_path = _metadata_textbook_snapshot_db(tmp_path, raw_json=raw_json)

    with pytest.raises(ServiceException) as error:
        module._read_metadata_batch_sync(db_path, REAL_METADATA_RUN_ID)

    assert 'raw_json' in (error.value.message or '')


@pytest.mark.asyncio
async def test_metadata_textbook_scope_materialization_failure_cannot_complete(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    finished: list[dict[str, object]] = []

    async def fake_run_script(_run_id: int, _handle: object, _command: list[str], _result: object) -> object:
        return module._ScriptResult(returncode=0, lines=[], metadata_run_id=10)

    async def fake_update(_run_id: int, _values: dict[str, object], **_kwargs: object) -> bool:
        return True

    async def fake_status(_run_id: int) -> str:
        return 'running'

    async def fake_finish(
        _run_id: int,
        _handle: object,
        status: str,
        phase: str,
        error_message: str | None,
        **_kwargs: object,
    ) -> None:
        finished.append({'status': status, 'phase': phase, 'errorMessage': error_message})

    async def fail_materialization(_run_id: int, _metadata_run_id: int) -> None:
        raise ServiceException(message='scope 表写入失败')

    monkeypatch.setattr(module, '_run_script', fake_run_script)
    monkeypatch.setattr(module, '_update_row', fake_update)
    monkeypatch.setattr(module, '_current_status', fake_status)
    monkeypatch.setattr(module, '_finish', fake_finish)
    monkeypatch.setattr(module, '_materialize_textbook_scopes', fail_materialization)
    monkeypatch.setattr(module, '_node_command', lambda: '/usr/local/bin/node')
    monkeypatch.setattr(module, '_collector_path', lambda: tmp_path / 'collector.sqlite3')
    monkeypatch.setattr(module, '_metadata_run_watermark_sync', lambda _path: 9)
    monkeypatch.setattr(
        module,
        '_read_metadata_run_sync',
        lambda _path, run_id: {'id': run_id, 'version_count': 1, 'textbook_count': 1},
    )

    await module._execute(
        1,
        module._WorkerHandle(token='test-token', task_module='textbook'),
    )

    assert len(finished) == 1
    assert finished[0]['status'] == 'failed'
    assert '物化失败' in str(finished[0]['errorMessage'])
    assert 'scope 表写入失败' in str(finished[0]['errorMessage'])


@pytest.mark.asyncio
async def test_existing_textbook_scope_updates_are_committed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Result:
        def __init__(self, rows: list[object]) -> None:
            self.rows = rows

        def scalars(self) -> Result:
            return self

        def all(self) -> list[object]:
            return self.rows

    class FakeDb:
        def __init__(self) -> None:
            self.results = [
                Result(
                    [
                        SimpleNamespace(
                            scope_id=31,
                            source_provider='zujuan',
                            external_textbook_id='stable-book',
                            metadata_run_id=None,
                            status='queued',
                            finished_at=None,
                        )
                    ]
                ),
                Result([]),
                Result([]),
            ]
            self.commit_count = 0
            self.added = False

        async def execute(self, _statement: object) -> Result:
            return self.results.pop(0)

        def add_all(self, _rows: list[object]) -> None:
            self.added = True

        async def commit(self) -> None:
            self.commit_count += 1

    class SessionContext:
        def __init__(self, db: FakeDb) -> None:
            self.db = db

        async def __aenter__(self) -> FakeDb:
            return self.db

        async def __aexit__(self, *_args: object) -> None:
            return None

    db = FakeDb()
    updates: list[dict[str, object]] = []

    async def fake_update_scope(
        _db: object,
        _scope_id: int,
        values: dict[str, object],
        **_kwargs: object,
    ) -> int:
        updates.append(values)
        return 1

    monkeypatch.setattr(module, 'DataSourceRegistry', SimpleNamespace(session=lambda: SessionContext(db)))
    monkeypatch.setattr(module, 'remote_collector_enabled', lambda: False)
    monkeypatch.setattr(
        module,
        '_read_metadata_batch_sync',
        lambda _path, _run_id, _selected: module._MetadataBatch(
            run_id=10,
            versions_count=1,
            textbooks_count=1,
            textbooks=[
                {
                    'external_textbook_id': 'stable-book',
                    'textbook_name': '稳定教材',
                    'version_external_id': 'stable-version',
                    'bootstrap_chapter_external_id': 'stable-chapter',
                }
            ],
        ),
    )
    monkeypatch.setattr(module.SyncTaskDao, 'update_scope', fake_update_scope)

    await module._materialize_textbook_scopes(1, 10)

    assert db.added is False
    assert db.commit_count == 1
    assert updates and updates[0]['metadata_run_id'] == EXEC_METADATA_RUN_ID
    assert updates[0]['status'] == 'completed'


@pytest.mark.asyncio
async def test_startup_recovery_only_runs_in_writer_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    async def recover() -> int:
        nonlocal calls
        calls += 1
        return 0

    monkeypatch.setattr(module.SyncRunService, 'recover_orphans', recover)

    await module.on_startup(SimpleNamespace(startup_write_enabled=False))
    await module.on_startup(SimpleNamespace(startup_write_enabled=True))

    assert calls == 1


def test_script_line_parser_binds_metadata_run_and_keeps_count_offsets() -> None:
    result = module._ScriptResult(
        returncode=0,
        lines=[],
        catalog_count_base=7,
        question_count_base=24,
    )

    module._parse_script_line('[启动] metadata-run=18，数据库：collector.sqlite3', result)
    module._parse_script_line('[目录] 发现 9 个节点，本次同步 3 个节点', result)
    module._parse_script_line('questionsSeen: 11', result)

    assert result.metadata_run_id == PARSED_METADATA_RUN_ID
    assert result.catalog_count_base + result.catalog_count == TOTAL_CATALOG_COUNT
    assert result.question_count_base + result.question_count == TOTAL_QUESTION_COUNT


def test_script_diagnostics_are_bounded_in_memory() -> None:
    handle = module._WorkerHandle(token='test-token')
    result = module._ScriptResult(returncode=0, lines=[])

    for index in range(module.MAX_LOG_LINES + 20):
        module._record_script_line(handle, result, f'line-{index}')

    assert len(result.lines) == module.MAX_LOG_LINES
    assert len(handle.log_lines) == module.MAX_LOG_LINES
    assert result.lines[-1] == f'line-{module.MAX_LOG_LINES + 19}'


@pytest.mark.asyncio
async def test_shutdown_cancels_worker_that_has_not_started_a_process() -> None:
    entered = asyncio.Event()

    async def pending_worker() -> None:
        entered.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(pending_worker())
    handle = module._WorkerHandle(token='test-token', task=task)
    module._WORKERS[999] = handle
    await entered.wait()

    try:
        await module.SyncRunService.shutdown()
        assert task.cancelled()
    finally:
        module._WORKERS.pop(999, None)


@pytest.mark.asyncio
async def test_create_job_uses_database_activity_slot_for_concurrent_starts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Two requests racing to start a task must leave only one active row."""

    class FakeRow:
        run_id = 1
        run_type = 'metadata'
        status = 'queued'
        phase = 'metadata'
        acknowledge_source_policy = 'Y'
        metadata_run_id = None
        total_versions = 0
        completed_versions = 0
        total_textbooks = 0
        completed_textbooks = 0
        catalog_count = 0
        question_count = 0
        current_textbook_id = None
        current_textbook_name = None
        progress_percent = 0
        log_tail = None
        error_message = None
        created_by = 'tester'
        started_at = None
        finished_at = None
        create_time = None
        update_time = None

    class FakeDb:
        def __init__(self) -> None:
            self.committed = False
            self.rolled_back = False
            self.refreshed: list[object] = []

        async def commit(self) -> None:
            self.committed = True

        async def rollback(self) -> None:
            self.rolled_back = True

        async def refresh(self, row: object) -> None:
            self.refreshed.append(row)

    add_calls = 0
    gate = asyncio.Event()

    async def mark_interrupted(*_args: object, **_kwargs: object) -> int:
        return 0

    async def add(db: FakeDb, row: object) -> object:
        nonlocal add_calls
        add_calls += 1
        if add_calls == 1:
            FakeRow.run_id = 1
            row.run_id = 1
            gate.set()
            await asyncio.sleep(0)
        else:
            raise module.IntegrityError('insert', {}, Exception('duplicate active slot'))
        return row

    async def no_execute(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr(module, '_node_command', lambda: '/usr/local/bin/node')
    monkeypatch.setattr(module, '_max_pages', lambda: 1)
    monkeypatch.setattr(module, '_metadata_run_watermark_sync', lambda _path: 0)
    metadata_script = tmp_path / 'metadata.cjs'
    metadata_script.touch()
    monkeypatch.setattr(module, 'METADATA_SCRIPT', metadata_script)
    monkeypatch.setattr(module.SyncJobDao, 'mark_interrupted', mark_interrupted)
    monkeypatch.setattr(module.SyncJobDao, 'add', add)
    monkeypatch.setattr(module, '_execute', no_execute)
    monkeypatch.setattr(module, '_status_from_row', lambda row: {'runId': row.run_id, 'status': row.status})

    first_db = FakeDb()
    second_db = FakeDb()
    payload = module.SyncRunStartRequestModel(acknowledgeSourcePolicy=True)

    first = asyncio.create_task(module.SyncRunService.start_metadata(first_db, payload, 'tester'))
    await gate.wait()
    second = asyncio.create_task(module.SyncRunService.start_metadata(second_db, payload, 'tester'))
    first_result = await first
    with pytest.raises(ServiceException) as error:
        await second

    assert first_result['runId'] == 1
    assert first_db.committed is True
    assert len(first_db.refreshed) == 1
    assert second_db.rolled_back is True
    assert error.value.message == '已有同步任务正在运行，请等待当前任务完成'


@pytest.mark.asyncio
async def test_create_job_refreshes_defaults_and_projects_response_before_worker_start(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    events: list[str] = []

    class FakeDb:
        def add_all(self, rows: list[object]) -> None:
            events.append(f'add-scopes:{len(rows)}')

        async def flush(self) -> None:
            events.append('flush-scopes')

        async def commit(self) -> None:
            events.append('commit')

        async def rollback(self) -> None:
            raise AssertionError('successful task creation must not roll back')

        async def refresh(self, row: object) -> None:
            if isinstance(row, module.QbSyncJob):
                events.append('refresh-job')
                row.progress_percent = 0
                row.total_versions = 0
                row.completed_versions = 0
            else:
                events.append('refresh-scope')
                row.status = 'queued'
                row.catalog_count = 0
                row.question_count = 0

    async def mark_interrupted(*_args: object, **_kwargs: object) -> int:
        return 0

    async def add(_db: object, row: object) -> object:
        row.run_id = 41
        return row

    async def no_execute(*_args: object, **_kwargs: object) -> None:
        events.append('worker')

    def project(row: object, scopes: list[object]) -> dict[str, object]:
        assert events[-2:] == ['refresh-job', 'refresh-scope']
        assert row.progress_percent == 0
        assert scopes[0].status == 'queued'
        events.append('project')
        return {'runId': row.run_id, 'status': row.status}

    monkeypatch.setattr(module, '_node_command', lambda: '/usr/local/bin/node')
    monkeypatch.setattr(module, '_max_pages', lambda: 1)
    question_script = tmp_path / 'questions.cjs'
    question_script.touch()
    monkeypatch.setattr(module, 'QUESTION_SCRIPT', question_script)
    monkeypatch.setattr(module.SyncJobDao, 'mark_interrupted', mark_interrupted)
    monkeypatch.setattr(module.SyncJobDao, 'add', add)
    monkeypatch.setattr(module, '_status_from_row', project)
    monkeypatch.setattr(module, '_execute', no_execute)

    result = await module.SyncRunService._create_job(
        FakeDb(),
        run_type='content',
        task_module='question',
        acknowledge_source_policy=True,
        operator='tester',
        metadata_run_id=None,
        textbook_external_ids=['book-1'],
        scope_rows=[
            {
                'sourceProvider': 'zujuan',
                'externalVersionId': 'version-1',
                'externalTextbookId': 'book-1',
                'versionName': '版本 1',
                'textbookName': '教材 1',
            }
        ],
    )
    await asyncio.sleep(0)

    try:
        assert result == {'runId': 41, 'status': 'queued'}
        assert events.index('commit') < events.index('refresh-job')
        assert events.index('refresh-scope') < events.index('project')
        assert events.index('project') < events.index('worker')
    finally:
        module._WORKERS.pop(41, None)


@pytest.mark.asyncio
async def test_create_job_rejects_unsupported_run_type_before_side_effects() -> None:
    class FakeDb:
        async def rollback(self) -> None:
            raise AssertionError('unsupported run type must be rejected before database access')

    with pytest.raises(ServiceException) as error:
        await module.SyncRunService._create_job(
            FakeDb(),
            run_type='full',
            acknowledge_source_policy=True,
            operator='tester',
        )
    assert error.value.message == '不支持的同步任务类型'
