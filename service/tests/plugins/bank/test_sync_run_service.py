"""Regression tests for HTTP-only sync-run orchestration.

The collector is an independently deployed service. These tests deliberately
use a small HTTP-client double and never create or inspect a collector SQLite
database or launch a crawler process.
"""

# Assertions intentionally use concrete values to make the remote projection
# contract obvious in this focused regression module.
# ruff: noqa: PLR2004

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest

from exceptions.exception import ServiceException
from plugins.bank.entity.vo.bank_vo import SyncContentRunStartRequestModel
from plugins.bank.service import sync_run_service as module

COLLECTOR_JOB_ID = '00000000-0000-0000-0000-000000000001'
AUTO_RESUME_SOURCE_RUN_ID = 20
SELECTED_TEXTBOOK_COUNT = 2
RACE_CATALOG_COUNT = 3
RACE_QUESTION_COUNT = 7


def _configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.test:9110')


def _completed_remote(**extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        'id': COLLECTOR_JOB_ID,
        'status': 'completed',
        'metadataRunId': 18,
        'catalogCount': 2,
        'questionCount': 4,
        'snapshotComplete': True,
        'snapshotLockedAt': '2026-08-31T10:00:00Z',
        'finishedAt': '2026-08-31T10:00:01Z',
    }
    payload.update(extra)
    return payload


def test_collector_url_is_required_before_any_sync_call(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('BANK_COLLECTOR_URL', raising=False)

    with pytest.raises(ServiceException, match='BANK_COLLECTOR_URL'):
        module.CollectorClient()


def test_exception_message_reads_service_exception_message() -> None:
    error = ServiceException(message='采集服务已锁定')

    assert str(error) == '采集服务已锁定'
    assert module._exception_message(error, '同步任务执行失败') == '采集服务已锁定'


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
async def test_start_content_fails_closed_without_collector_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('BANK_COLLECTOR_URL', raising=False)
    payload = SyncContentRunStartRequestModel.model_validate(
        {
            'acknowledgeSourcePolicy': True,
            'metadataRunId': 18,
            'textbookExternalIds': ['tb-1'],
        }
    )

    with pytest.raises(ServiceException, match='BANK_COLLECTOR_URL'):
        await module.SyncRunService.start_content(object(), payload, 'tester')


@pytest.mark.asyncio
async def test_plugin_startup_fails_closed_without_collector_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('BANK_COLLECTOR_URL', raising=False)

    with pytest.raises(ServiceException, match='BANK_COLLECTOR_URL'):
        await module.on_startup()


def test_safe_partial_progress_requires_all_core_snapshot_counts() -> None:
    complete = {
        'counts': {
            'catalogItemCount': 2,
            'questionItemCount': 10,
            'questionCatalogCount': 10,
            'questionTagCount': 0,
            'questionAssetCount': 0,
        }
    }
    assert module._has_safe_partial_progress(complete) is True
    assert module._has_safe_partial_progress(
        {'counts': {**complete['counts'], 'questionCatalogCount': 0, 'questionTagCount': 5}}
    ) is False


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


def test_remote_status_projection_is_bounded_and_keeps_job_identity() -> None:
    values = module._remote_status_values(
        {
            'id': COLLECTOR_JOB_ID,
            'status': 'running',
            'logTail': 'x' * (module.MAX_LOG_CHARS + 20),
            'progressPercent': 150,
            'catalogCount': 3,
            'questionCatalogCount': 5,
        }
    )

    assert values['collector_job_id'] == COLLECTOR_JOB_ID
    assert values['catalog_count'] == 3
    assert values['question_catalog_count'] == 5
    assert values['progress_percent'] == 100
    assert len(values['log_tail']) == module.MAX_LOG_CHARS


@pytest.mark.asyncio
async def test_execute_remote_uses_collector_client_and_finishes_from_remote_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configured(monkeypatch)
    calls: list[tuple[str, Any]] = []
    updates: list[dict[str, Any]] = []
    finished: list[tuple[str, str, str | None]] = []

    class Client:
        def __init__(self) -> None:
            calls.append(('init', None))

        def start_job(self, run_type: str, **kwargs: Any) -> dict[str, Any]:
            calls.append(('start', (run_type, kwargs)))
            return _completed_remote()

    async def update(_run_id: int, values: dict[str, Any], **_kwargs: Any) -> bool:
        updates.append(values)
        return True

    async def current(_run_id: int) -> str:
        return 'running'

    async def finish(
        _run_id: int,
        _handle: object,
        status: str,
        phase: str,
        error: str | None,
        **_kwargs: Any,
    ) -> None:
        finished.append((status, phase, error))

    monkeypatch.setattr(module, 'CollectorClient', Client)
    monkeypatch.setattr(module, '_update_row', update)
    monkeypatch.setattr(module, '_current_status', current)
    monkeypatch.setattr(module, '_finish', finish)

    handle = module._WorkerHandle(token='token', run_type='metadata', task_module='center')
    await module._execute_remote(7, handle, 4)

    assert calls == [
        ('init', None),
        (
            'start',
            (
                'metadata',
                {
                    'max_pages': 4,
                    'metadata_run_id': None,
                    'textbook_external_ids': [],
                },
            ),
        ),
    ]
    assert updates[0]['collector_job_id'] == COLLECTOR_JOB_ID
    assert finished == [('completed', 'completed', None)]


@pytest.mark.asyncio
async def test_execute_remote_maps_terminal_collector_status(monkeypatch: pytest.MonkeyPatch) -> None:
    """A terminal HTTP projection is translated into the durable task state."""

    updates: list[dict[str, object]] = []
    finished: list[dict[str, object]] = []

    class Client:
        def start_job(self, run_type: str, **kwargs: object) -> dict[str, object]:
            assert run_type == 'content'
            assert kwargs == {
                'max_pages': 4,
                'metadata_run_id': 10,
                'textbook_external_ids': ['tb-1'],
            }
            return {
                'id': COLLECTOR_JOB_ID,
                'status': 'completed',
                'metadataRunId': 10,
                'totalTextbooks': 1,
                'completedTextbooks': 1,
                'catalogCount': 7,
                'questionCount': 24,
                'progressPercent': 100,
                'logTail': '远程采集完成',
            }

    async def update(_run_id: int, values: dict[str, object], **_kwargs: object) -> bool:
        updates.append(values)
        return True

    async def current(_run_id: int) -> str:
        return 'running'

    async def finish(
        _run_id: int,
        _handle: object,
        status: str,
        phase: str,
        error_message: str | None,
        **kwargs: object,
    ) -> None:
        finished.append({'status': status, 'phase': phase, 'errorMessage': error_message, **kwargs})

    monkeypatch.setattr(module, 'CollectorClient', Client)
    monkeypatch.setattr(module, '_update_row', update)
    monkeypatch.setattr(module, '_current_status', current)
    monkeypatch.setattr(module, '_finish', finish)

    await module._execute_remote(
        1,
        module._WorkerHandle(
            token='token',
            run_type='content',
            metadata_run_id=10,
            textbook_external_ids=['tb-1'],
        ),
        4,
    )

    assert updates[-1]['metadata_run_id'] == 10
    assert updates[-1]['catalog_count'] == 7
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
    class Client:
        def start_job(self, _run_type: str, **_kwargs: object) -> dict[str, object]:
            return {
                'id': COLLECTOR_JOB_ID,
                'status': 'completed',
                'totalTextbooks': 1,
                'completedTextbooks': 1,
                'progressPercent': 100,
                'scopeItems': [
                    {
                        'externalTextbookId': 'tb-1',
                        'status': 'completed',
                        # A terminal scope without a run cannot identify an
                        # immutable snapshot for the question task.
                        'collectorRunId': None,
                    }
                ],
            }

    async def update(*_args: object, **_kwargs: object) -> bool:
        return True

    async def current(_run_id: int) -> str:
        return 'running'

    async def scopes(_run_id: int) -> list[object]:
        return [SimpleNamespace(external_textbook_id='tb-1', status='completed', collector_run_id=None)]

    monkeypatch.setattr(module, 'CollectorClient', Client)
    monkeypatch.setattr(module, '_update_row', update)
    monkeypatch.setattr(module, '_update_scope_values', update)
    monkeypatch.setattr(module, '_current_status', current)
    monkeypatch.setattr(module, '_load_scopes', scopes)

    with pytest.raises(ServiceException, match='collectorRunId'):
        await module._execute_remote(
            1,
            module._WorkerHandle(
                token='token',
                run_type='content',
                task_module='question',
                textbook_external_ids=['tb-1'],
            ),
            4,
        )


@pytest.mark.asyncio
async def test_remote_scope_write_failure_fails_parent_instead_of_completing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Client:
        def start_job(self, _run_type: str, **_kwargs: object) -> dict[str, object]:
            return {
                'id': COLLECTOR_JOB_ID,
                'status': 'running',
                'scopeItems': [
                    {'externalTextbookId': 'tb-1', 'status': 'running', 'collectorRunId': 12},
                ],
            }

    async def update_row(*_args: object, **_kwargs: object) -> bool:
        return True

    async def fail_scope(*_args: object, **_kwargs: object) -> bool:
        return False

    async def current(_run_id: int) -> str:
        return 'running'

    async def no_scopes(_run_id: int) -> list[object]:
        return []

    monkeypatch.setattr(module, 'CollectorClient', Client)
    monkeypatch.setattr(module, '_update_row', update_row)
    monkeypatch.setattr(module, '_update_scope_values', fail_scope)
    monkeypatch.setattr(module, '_current_status', current)
    monkeypatch.setattr(module, '_load_scopes', no_scopes)

    with pytest.raises(ServiceException, match='写入失败'):
        await module._execute_remote(
            1,
            module._WorkerHandle(
                token='token',
                run_type='content',
                task_module='question',
                textbook_external_ids=['tb-1'],
            ),
            4,
        )


def _snapshot_summary(run_id: int, textbook_external_id: str, counts: tuple[int, int, int, int, int]) -> dict[str, object]:
    catalog_count, question_count, relation_count, tag_count, asset_count = counts
    return {
        'available': True,
        'immutable': True,
        'snapshotComplete': True,
        'run': {
            'id': run_id,
            'provider': 'zujuan',
            'status': 'success',
            'errorCount': 0,
            'finishedAt': '2026-08-29T10:00:00Z',
            'snapshotLockedAt': '2026-08-29T10:00:01Z',
            'snapshotComplete': True,
            'textbookExternalIds': [textbook_external_id],
        },
        'counts': {
            'catalogItemCount': catalog_count,
            'questionItemCount': question_count,
            'questionCatalogCount': relation_count,
            'questionTagCount': tag_count,
            'questionAssetCount': asset_count,
        },
    }


@pytest.mark.asyncio
async def test_remote_question_parent_completes_only_after_all_scopes_are_verified(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_ids = {'tb-1': 21, 'tb-2': 22}
    snapshot_counts = {
        'tb-1': (3, 10, 12, 4, 2),
        'tb-2': (5, 20, 25, 6, 3),
    }
    finished: list[dict[str, object]] = []

    class Client:
        def start_job(self, _run_type: str, **_kwargs: object) -> dict[str, object]:
            return {
                'id': COLLECTOR_JOB_ID,
                'status': 'completed',
                'totalTextbooks': 2,
                'completedTextbooks': 2,
                'progressPercent': 100,
                'scopeItems': [
                    {
                        'externalTextbookId': external_id,
                        'status': 'completed',
                        'collectorRunId': collector_id,
                    }
                    for external_id, collector_id in run_ids.items()
                ],
            }

        def run_snapshot_summary(self, run_id: int, **kwargs: object) -> dict[str, object]:
            external_id = str(kwargs['textbook_external_id'])
            return _snapshot_summary(run_id, external_id, snapshot_counts[external_id])

    async def update(*_args: object, **_kwargs: object) -> bool:
        return True

    async def current(_run_id: int) -> str:
        return 'running'

    async def scopes(_run_id: int) -> list[object]:
        return [
            SimpleNamespace(
                external_textbook_id=external_id,
                status='completed',
                collector_run_id=collector_id,
            )
            for external_id, collector_id in run_ids.items()
        ]

    async def finish(
        _run_id: int,
        _handle: object,
        status: str,
        phase: str,
        error_message: str | None,
        **kwargs: object,
    ) -> None:
        finished.append({'status': status, 'phase': phase, 'errorMessage': error_message, **kwargs})

    monkeypatch.setattr(module, 'CollectorClient', Client)
    monkeypatch.setattr(module, '_update_row', update)
    monkeypatch.setattr(module, '_update_scope_values', update)
    monkeypatch.setattr(module, '_current_status', current)
    monkeypatch.setattr(module, '_load_scopes', scopes)
    monkeypatch.setattr(module, '_finish', finish)

    await module._execute_remote(
        1,
        module._WorkerHandle(
            token='token',
            run_type='content',
            task_module='question',
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
    collector_run_id = 31

    class Client:
        def start_job(self, _run_type: str, **_kwargs: object) -> dict[str, object]:
            return {
                'id': COLLECTOR_JOB_ID,
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
            assert run_id == collector_run_id
            assert kwargs['textbook_external_id'] == 'tb-1'
            return _snapshot_summary(run_id, 'tb-1', (3, 10, 12, 4, 2))

    async def update_row(*_args: object, **_kwargs: object) -> bool:
        return True

    async def update_scope(
        _run_id: int,
        values: dict[str, object],
        **_kwargs: object,
    ) -> bool:
        # The initial projection can be written, but the authoritative summary
        # projection fails and the durable scope remains stale.
        return 'question_catalog_count' not in values

    async def current(_run_id: int) -> str:
        return 'running'

    async def stale_scope(_run_id: int) -> list[object]:
        return [
            SimpleNamespace(
                external_textbook_id='tb-1',
                status='completed',
                collector_run_id=collector_run_id,
            )
        ]

    monkeypatch.setattr(module, 'CollectorClient', Client)
    monkeypatch.setattr(module, '_update_row', update_row)
    monkeypatch.setattr(module, '_update_scope_values', update_scope)
    monkeypatch.setattr(module, '_current_status', current)
    monkeypatch.setattr(module, '_load_scopes', stale_scope)

    with pytest.raises(ServiceException, match='最终状态写入失败'):
        await module._execute_remote(
            1,
            module._WorkerHandle(
                token='token',
                run_type='content',
                task_module='question',
                textbook_external_ids=['tb-1'],
            ),
            4,
        )


@pytest.mark.asyncio
async def test_recovery_retries_recent_rows_and_terminalizes_after_heartbeat_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Session:
        async def __aenter__(self) -> Session:
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

    async def update_fields(
        _db: object,
        _run_id: int,
        values: dict[str, object],
        **_kwargs: object,
    ) -> int:
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

    monkeypatch.setattr(module.DataSourceRegistry, 'session', Session)
    monkeypatch.setattr(module.SyncJobDao, 'list_active', list_active)
    monkeypatch.setattr(module.SyncJobDao, 'update_fields', update_fields)
    monkeypatch.setattr(module.SyncTaskDao, 'scopes', scopes)
    monkeypatch.setattr(module, '_finalize_scopes', no_finalize)

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

    async def resume() -> int:
        return 0

    monkeypatch.setattr(module.SyncRunService, 'recover_orphans', recover)
    monkeypatch.setattr(module.SyncRunService, 'resume_pending_question_tasks', resume)
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

    class Db:
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
    db = Db([job], [scope])

    count = await module.SyncJobDao.mark_interrupted(db, 'worker lost', now - timedelta(minutes=1))

    assert count == 1
    assert job.status == 'cancelled'
    assert scope.status == 'cancelled'
    assert scope.error_message == '同步已停止'
    assert db.flush_count == SELECTED_TEXTBOOK_COUNT


@pytest.mark.asyncio
async def test_finish_preserves_cancellation_that_wins_terminal_state_race(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = 'cancelling'
    updates: list[tuple[dict[str, object], tuple[str, ...] | None]] = []

    async def update(
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

    async def no_finalize(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr(module, '_update_row', update)
    monkeypatch.setattr(module, '_finalize_scopes', no_finalize)

    await module._finish(
        1,
        module._WorkerHandle(token='token'),
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


@pytest.mark.asyncio
async def test_resume_partial_summary_uses_summary_endpoint_only(monkeypatch: pytest.MonkeyPatch) -> None:
    _configured(monkeypatch)
    calls: list[tuple[int, str, bool]] = []

    class Client:
        def run_snapshot_summary(
            self,
            run_id: int,
            *,
            textbook_external_id: str,
            allow_incomplete: bool = False,
        ) -> dict[str, Any]:
            calls.append((run_id, textbook_external_id, allow_incomplete))
            return {
                'available': True,
                'immutable': True,
                'snapshotComplete': False,
                'run': {
                    'id': run_id,
                    'provider': 'zujuan',
                    'status': 'interrupted',
                    'errorCount': 0,
                    'finishedAt': '2026-08-31T10:00:00Z',
                    'snapshotLockedAt': '2026-08-31T10:00:01Z',
                    'scope': {'textbookExternalId': textbook_external_id},
                },
                'counts': {
                    'catalogItemCount': 2,
                    'questionItemCount': 3,
                    'questionCatalogCount': 3,
                    'questionTagCount': 0,
                    'questionAssetCount': 0,
                },
            }

    monkeypatch.setattr(module, 'CollectorClient', Client)
    result = await module._resume_partial_summary(12, 'tb-1')

    assert calls == [(12, 'tb-1', True)]
    assert result['collector_run_id'] == 12
    assert result['partial'] is True


@pytest.mark.asyncio
async def test_create_job_drops_collector_runtime_options(monkeypatch: pytest.MonkeyPatch) -> None:
    _configured(monkeypatch)
    health_calls = 0

    class Client:
        def health(self) -> dict[str, Any]:
            nonlocal health_calls
            health_calls += 1
            return {'ok': True}

    class Db:
        def __init__(self) -> None:
            self.added: list[Any] = []
            self.refreshed: list[Any] = []
            self.committed = False

        def add(self, row: Any) -> None:
            self.added.append(row)

        async def flush(self) -> None:
            return None

        async def commit(self) -> None:
            self.committed = True

        async def refresh(self, row: Any) -> None:
            self.refreshed.append(row)

    async def mark_interrupted(*_args: Any, **_kwargs: Any) -> int:
        return 0

    async def add_job(db: Db, row: Any) -> Any:
        db.add(row)
        row.run_id = 41
        return row

    def create_task(coroutine: Any) -> None:
        coroutine.close()

    monkeypatch.setattr(module, 'CollectorClient', Client)
    monkeypatch.setattr(module.SyncJobDao, 'mark_interrupted', mark_interrupted)
    monkeypatch.setattr(module.SyncJobDao, 'add', add_job)
    monkeypatch.setattr(module.asyncio, 'create_task', create_task)

    db = Db()
    result = await module.SyncRunService._create_job(
        db,
        run_type='metadata',
        acknowledge_source_policy=True,
        operator='tester',
        extra_options={
            'collectorDb': '/collector/secret.sqlite3',
            'metadataScript': '/collector/metadata.cjs',
            'questionScript': '/collector/question.cjs',
            'headful': True,
            'visibleLabel': 'remote-only',
        },
    )

    assert health_calls == 1
    assert result['runId'] == 41
    options = db.added[0].options_json
    assert options['visibleLabel'] == 'remote-only'
    assert not any(key in options for key in ('collectorDb', 'metadataScript', 'questionScript', 'headful'))


def test_metadata_locator_validation_remains_source_scoped() -> None:
    assert module._validate_metadata_textbook_entry(
        {
            'source_url': 'https://zujuan.xkw.com/czsx/zj123/',
            'raw_json': {'externalTextbookId': '123', 'href': '/czsx/zj123/'},
        },
        '123',
    ) is None
    with pytest.raises(ServiceException, match='不匹配'):
        module._validate_metadata_textbook_entry(
            {'source_url': 'https://zujuan.xkw.com/czsx/zj123/'},
            '124',
        )


@pytest.mark.asyncio
async def test_startup_recovery_only_runs_in_writer_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    _configured(monkeypatch)
    calls = 0

    async def recover() -> int:
        nonlocal calls
        calls += 1
        return 0

    async def resume() -> int:
        return 0

    monkeypatch.setattr(module.SyncRunService, 'recover_orphans', recover)
    monkeypatch.setattr(module.SyncRunService, 'resume_pending_question_tasks', resume)

    await module.on_startup(SimpleNamespace(startup_write_enabled=False))
    await module.on_startup(SimpleNamespace(startup_write_enabled=True))
    await module.SyncRunService.shutdown()

    assert calls == 1


@pytest.mark.asyncio
async def test_shutdown_cancels_worker_that_has_not_started_a_process() -> None:
    entered = asyncio.Event()

    async def pending_worker() -> None:
        entered.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(pending_worker())
    handle = module._WorkerHandle(token='token', task=task)
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
) -> None:
    """Two HTTP-only requests racing to start a task leave one active row."""

    _configured(monkeypatch)

    class Client:
        def health(self) -> dict[str, object]:
            return {'ok': True}

    class Db:
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

    async def add(_db: Db, row: object) -> object:
        nonlocal add_calls
        add_calls += 1
        if add_calls == 1:
            row.run_id = 1
            gate.set()
            await asyncio.sleep(0)
            return row
        raise module.IntegrityError('insert', {}, Exception('duplicate active slot'))

    async def no_execute(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr(module, 'CollectorClient', Client)
    monkeypatch.setattr(module.SyncJobDao, 'mark_interrupted', mark_interrupted)
    monkeypatch.setattr(module.SyncJobDao, 'add', add)
    monkeypatch.setattr(module, '_execute', no_execute)

    first_db = Db()
    second_db = Db()
    payload = module.SyncRunStartRequestModel(acknowledgeSourcePolicy=True)

    first = asyncio.create_task(module.SyncRunService.start_metadata(first_db, payload, 'tester'))
    await gate.wait()
    second = asyncio.create_task(module.SyncRunService.start_metadata(second_db, payload, 'tester'))
    first_result = await first
    with pytest.raises(ServiceException, match='已有同步任务正在运行'):
        await second

    assert first_result['runId'] == 1
    assert first_db.committed is True
    assert len(first_db.refreshed) == 1
    assert second_db.rolled_back is True
    module._WORKERS.pop(1, None)


@pytest.mark.asyncio
async def test_create_job_refreshes_defaults_and_projects_response_before_worker_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configured(monkeypatch)
    events: list[str] = []

    class Client:
        def health(self) -> dict[str, object]:
            return {'ok': True}

    class Db:
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

    monkeypatch.setattr(module, 'CollectorClient', Client)
    monkeypatch.setattr(module.SyncJobDao, 'mark_interrupted', mark_interrupted)
    monkeypatch.setattr(module.SyncJobDao, 'add', add)
    monkeypatch.setattr(module, '_status_from_row', project)
    monkeypatch.setattr(module, '_execute', no_execute)

    result = await module.SyncRunService._create_job(
        Db(),
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
    class Db:
        async def rollback(self) -> None:
            raise AssertionError('unsupported run type must be rejected before database access')

    with pytest.raises(ServiceException, match='不支持的同步任务类型'):
        await module.SyncRunService._create_job(
            Db(),
            run_type='full',
            acknowledge_source_policy=True,
            operator='tester',
        )


@pytest.mark.asyncio
async def test_existing_textbook_scope_updates_are_committed_from_http_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configured(monkeypatch)

    class Client:
        def metadata_snapshot(self, metadata_run_id: int) -> dict[str, object]:
            assert metadata_run_id == 10
            return {
                'available': True,
                'immutable': True,
                'run': {
                    'id': 10,
                    'status': 'success',
                    'snapshotLockedAt': '2026-08-31T10:00:00Z',
                    'textbookCount': 1,
                },
                'versions': [
                    {
                        'provider': 'zujuan',
                        'externalVersionId': 'stable-version',
                        'versionName': '稳定版本',
                    }
                ],
                'textbooks': [
                    {
                        'provider': 'zujuan',
                        'externalTextbookId': 'stable-book',
                        'versionExternalId': 'stable-version',
                        'textbookName': '稳定教材',
                    }
                ],
            }

    class Result:
        def __init__(self, rows: list[object]) -> None:
            self.rows = rows

        def scalars(self) -> Result:
            return self

        def all(self) -> list[object]:
            return self.rows

    class Db:
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

        async def execute(self, _statement: object) -> Result:
            return self.results.pop(0)

        async def commit(self) -> None:
            self.commit_count += 1

    class Session:
        def __init__(self, db: Db) -> None:
            self.db = db

        async def __aenter__(self) -> Db:
            return self.db

        async def __aexit__(self, *_args: object) -> None:
            return None

    db = Db()
    updates: list[dict[str, object]] = []

    async def update_scope(
        _db: object,
        _scope_id: int,
        values: dict[str, object],
        **_kwargs: object,
    ) -> int:
        updates.append(values)
        return 1

    monkeypatch.setattr(module, 'CollectorClient', Client)
    monkeypatch.setattr(module, 'DataSourceRegistry', SimpleNamespace(session=lambda: Session(db)))
    monkeypatch.setattr(module.SyncTaskDao, 'update_scope', update_scope)

    await module._materialize_textbook_scopes(1, 10)

    assert db.commit_count == 1
    assert updates and updates[0]['metadata_run_id'] == 10
    assert updates[0]['status'] == 'completed'


def test_bound_live_projection_keeps_fetch_windows() -> None:
    bounded = module._bound_live_projection(
        {
            'available': True,
            'runId': 11,
            'fetchWindows': [
                {
                    'catalogExternalId': '261285',
                    'catalogName': '1.2 探索规律',
                    'latestSourceTotal': 10028,
                    'slots': [
                        {
                            'slot': 1,
                            'pageNumber': 47,
                            'status': 'fetching',
                            'questionCount': 10,
                            'sourceTotal': 10028,
                            'line': 'catalog=261285 page=47 questions=10 total=10028',
                        },
                    ],
                },
            ],
            'currentCatalogIds': ['261285'],
            'tree': [{'externalId': '261285', 'label': '1.2 探索规律', 'children': []}],
        }
    )

    assert bounded is not None
    assert bounded['fetchWindows'][0]['catalogExternalId'] == '261285'
    assert bounded['fetchWindows'][0]['slots'][0]['pageNumber'] == 47
    assert bounded['fetchWindows'][0]['slots'][0]['line'].startswith('catalog=261285 page=47')
    assert bounded['currentCatalogIds'] == ['261285']
