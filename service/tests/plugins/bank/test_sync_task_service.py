from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from exceptions.exception import ServiceException
from plugins.bank.controller.bank_controller import bank_controller
from plugins.bank.service import sync_run_service, task_service

TASK_ID = 11
COLLECTOR_RUN_ID = 44
SOURCE_TASK_ID = 7
RETRY_TASK_ID = 22
BLOCKED_COLLECTOR_RUN_ID = 20
BLOCKED_CATALOG_COUNT = 220
BLOCKED_QUESTION_COUNT = 4685
METADATA_RUN_ID = 15


def _route_permissions(path: str) -> list[Any]:
    route = next(route for route in bank_controller.routes if route.path == path)
    return [
        getattr(dependency.call, 'perm', None)
        for dependency in route.dependant.dependencies
        if getattr(dependency.call, 'perm', None) is not None
    ]


def test_independent_task_routes_keep_module_permissions_and_frozen_paths() -> None:
    expected = {
        '/bank/sync/textbook/tasks': {'bank:sync:textbook:add', 'bank:sync:run'},
        '/bank/sync/textbook/tasks/{task_id}': {
            'bank:sync:textbook:query',
            'bank:sync:textbook:list',
            'bank:sync:center:list',
        },
        '/bank/sync/textbook/tasks/{task_id}/comparison': {
            'bank:sync:textbook:query',
            'bank:sync:textbook:list',
            'bank:sync:center:list',
        },
        '/bank/sync/textbook/tasks/{task_id}/cancel': {'bank:sync:textbook:cancel', 'bank:sync:run'},
        '/bank/sync/textbook/tasks/{task_id}/retry': {'bank:sync:textbook:retry', 'bank:sync:run'},
        'DELETE /bank/sync/textbook/tasks/{task_id}': {'bank:sync:textbook:remove', 'bank:sync:run'},
        '/bank/sync/question/tasks': {'bank:sync:question:add', 'bank:sync:run'},
        '/bank/sync/question/tasks/{task_id}': {
            'bank:sync:question:query',
            'bank:sync:question:list',
            'bank:sync:center:list',
        },
        '/bank/sync/question/tasks/{task_id}/catalog-comparison': {
            'bank:sync:question:query',
            'bank:sync:question:list',
            'bank:sync:center:list',
        },
        '/bank/sync/question/tasks/{task_id}/question-comparison': {
            'bank:sync:question:query',
            'bank:sync:question:list',
            'bank:sync:center:list',
        },
        '/bank/sync/question/tasks/{task_id}/questions/{external_id}': {
            'bank:sync:question:query',
            'bank:sync:question:list',
            'bank:sync:center:list',
        },
        '/bank/sync/question/tasks/{task_id}/cancel': {'bank:sync:question:cancel', 'bank:sync:run'},
        '/bank/sync/question/tasks/{task_id}/retry': {'bank:sync:question:retry', 'bank:sync:run'},
        'DELETE /bank/sync/question/tasks/{task_id}': {'bank:sync:question:remove', 'bank:sync:run'},
    }

    route_paths = {route.path for route in bank_controller.routes}
    assert {key.removeprefix('DELETE ') for key in expected} <= route_paths
    for route_key, wanted in expected.items():
        method, _, path = route_key.partition(' ')
        if not path:
            path = method
            method = ''
        if method:
            route = next(route for route in bank_controller.routes if route.path == path and method in route.methods)
            permissions = [
                getattr(dependency.call, 'perm', None)
                for dependency in route.dependant.dependencies
                if getattr(dependency.call, 'perm', None) is not None
            ]
        else:
            permissions = _route_permissions(path)
        flattened = {
            value
            for permission in permissions
            for value in (permission if isinstance(permission, list) else [permission])
        }
        assert wanted <= flattened


@pytest.mark.asyncio
async def test_delete_terminal_task_commits_service_owned_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[int, str]] = []

    class Db:
        committed = False
        rolled_back = False

        async def commit(self) -> None:
            self.committed = True

        async def rollback(self) -> None:
            self.rolled_back = True

    async def get(_db: object, task_id: int, module: str) -> object:
        assert task_id == TASK_ID
        assert module == 'textbook'
        return SimpleNamespace(status='completed')

    async def delete_task(_db: object, task_id: int, module: str) -> int:
        calls.append((task_id, module))
        return 1

    async def no_current_state(*_args: object, **_kwargs: object) -> None:
        return None

    db = Db()
    monkeypatch.setattr(task_service.SyncTaskDao, 'get', get)
    monkeypatch.setattr(task_service.SyncTaskDao, 'delete_task', delete_task)
    monkeypatch.setattr(
        'plugins.bank.service.textbook_apply_service.TextbookApplyService._state',
        no_current_state,
    )

    await task_service.SyncTaskService.delete_textbook(db, TASK_ID)

    assert calls == [(TASK_ID, 'textbook')]
    assert db.committed is True
    assert db.rolled_back is False


@pytest.mark.asyncio
async def test_delete_active_task_is_rejected_without_mutation(monkeypatch: pytest.MonkeyPatch) -> None:
    async def get_for_update(_db: object, _task_id: int, _module: str) -> object:
        return SimpleNamespace(status='running')

    async def delete_task(*_args: object) -> int:
        raise AssertionError('active task must not be deleted')

    monkeypatch.setattr(task_service.SyncTaskDao, 'get_for_update', get_for_update)
    monkeypatch.setattr(task_service.SyncTaskDao, 'delete_task', delete_task)

    with pytest.raises(ServiceException) as error:
        await task_service.SyncTaskService.delete_question(object(), TASK_ID)

    assert '只有终态同步任务' in error.value.message


@pytest.mark.asyncio
async def test_question_delete_uses_task_then_state_lock_order(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[str] = []

    class Db:
        async def commit(self) -> None:
            events.append('commit')

        async def rollback(self) -> None:
            events.append('rollback')

    async def get_for_update(_db: object, _task_id: int, module: str) -> object:
        assert module == 'question'
        events.append('task-lock')
        return SimpleNamespace(status='completed')

    async def ensure_not_current(*_args: object, **_kwargs: object) -> None:
        events.append('state-lock')

    async def delete_task(_db: object, _task_id: int, module: str) -> int:
        assert module == 'question'
        events.append('delete')
        return 1

    monkeypatch.setattr(task_service.SyncTaskDao, 'get_for_update', get_for_update)
    monkeypatch.setattr(task_service.SyncTaskDao, 'delete_task', delete_task)
    monkeypatch.setattr(
        'plugins.bank.service.question_apply_service.QuestionApplyService.ensure_task_not_current',
        ensure_not_current,
    )

    await task_service.SyncTaskService.delete_question(Db(), TASK_ID)

    assert events == ['task-lock', 'state-lock', 'delete', 'commit']


def test_task_payload_reads_camel_case_acknowledgement_without_defaulting_to_true() -> None:
    payload = task_service.task_payload(
        {
            'runId': TASK_ID,
            'taskModule': 'question',
            'runType': 'content',
            'status': 'queued',
            'phase': 'catalogs_questions',
            'acknowledgeSourcePolicy': 'N',
            'optionsJson': {'versionId': 3, 'textbookIds': [8]},
        }
    )

    assert payload['taskId'] == TASK_ID
    assert payload['acknowledgeSourcePolicy'] is False


def test_task_payload_keeps_fetch_windows_in_live_progress() -> None:
    payload = task_service.task_payload(
        {
            'runId': TASK_ID,
            'taskModule': 'question',
            'runType': 'content',
            'status': 'running',
            'optionsJson': {
                'liveProgressByScope': {
                    '260617': {
                        'available': True,
                        'fetchWindows': [
                            {
                                'catalogExternalId': '261285',
                                'catalogName': '1.2 探索规律',
                                'slots': [
                                    {
                                        'slot': 1,
                                        'pageNumber': 47,
                                        'status': 'saved',
                                        'line': 'catalog=261285 page=47 questions=10 total=10028',
                                    },
                                ],
                            },
                        ],
                        'tree': [],
                    },
                },
            },
        }
    )

    windows = payload['liveProgressByScope']['260617']['fetchWindows']
    assert windows[0]['catalogExternalId'] == '261285'
    assert windows[0]['slots'][0]['pageNumber'] == 47


def test_blocked_question_task_projects_safe_resume_and_scope_counts() -> None:
    row = SimpleNamespace(
        run_id=12,
        task_module='question',
        run_type='content',
        status='blocked',
        phase='blocked',
        catalog_count=0,
        question_count=0,
        question_catalog_count=0,
        question_tag_count=0,
        question_asset_count=0,
        options_json={
            'autoResume': True,
            'autoResumeAttempt': 1,
            'autoResumeMaxAttempts': 3,
            'autoResumePending': False,
        },
    )
    scope = SimpleNamespace(
        status='blocked',
        external_textbook_id='260617',
        resume_from_collector_run_id=BLOCKED_COLLECTOR_RUN_ID,
        catalog_count=BLOCKED_CATALOG_COUNT,
        question_count=BLOCKED_QUESTION_COUNT,
        question_catalog_count=BLOCKED_QUESTION_COUNT,
        question_tag_count=20405,
        question_asset_count=56649,
    )

    payload = task_service.task_payload(row, [scope])

    assert payload['resumeAvailable'] is True
    assert payload['resumeFromCollectorRunId'] == BLOCKED_COLLECTOR_RUN_ID
    assert payload['catalogCount'] == BLOCKED_CATALOG_COUNT
    assert payload['questionCount'] == BLOCKED_QUESTION_COUNT
    assert payload['autoResumeEnabled'] is True
    assert payload['autoResumeAttempt'] == 1


@pytest.mark.asyncio
async def test_retry_question_creates_fresh_queued_scope_state(monkeypatch: pytest.MonkeyPatch) -> None:
    row = SimpleNamespace(
        run_id=RETRY_TASK_ID,
        status='failed',
        options_json={'versionId': 3, 'textbookIds': [8], 'limitTo1000Pages': True},
        source_task_id=SOURCE_TASK_ID,
        metadata_run_id=METADATA_RUN_ID,
    )
    old_scope = SimpleNamespace(
        scope_id=9,
        run_id=22,
        local_version_id=3,
        local_textbook_id=8,
        version_name_snapshot='版本',
        textbook_name_snapshot='教材',
        source_provider='zujuan',
        external_version_id='v-3',
        external_textbook_id='tb-8',
        metadata_run_id=METADATA_RUN_ID,
        collector_job_id='old-job',
        collector_run_id=99,
        status='failed',
        catalog_count=4,
        question_count=5,
        new_catalog_count=1,
        changed_catalog_count=2,
        new_question_count=3,
        changed_question_count=4,
        error_message='旧错误',
        started_at='old-start',
        finished_at='old-finish',
    )
    captured: dict[str, Any] = {}

    async def get(_db: object, _task_id: int, _module: str) -> object:
        return row

    async def scopes(_db: object, _task_id: int) -> list[object]:
        return [old_scope]

    async def create_job(_db: object, **kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return {'taskId': 23}

    monkeypatch.setattr(task_service.SyncTaskDao, 'get', get)
    monkeypatch.setattr(task_service.SyncTaskDao, 'scopes', scopes)
    monkeypatch.setattr(sync_run_service.SyncRunService, '_create_job', create_job)

    result = await task_service.SyncTaskService.retry_question(object(), RETRY_TASK_ID, 'tester')

    assert result == {'taskId': 23}
    retry_scope = captured['scope_rows'][0]
    assert retry_scope['status'] == 'queued'
    assert retry_scope['collectorJobId'] is None
    assert retry_scope['collectorRunId'] is None
    assert retry_scope['catalogCount'] == 0
    assert retry_scope['questionCount'] == 0
    assert retry_scope['errorMessage'] is None
    assert retry_scope['metadataRunId'] is None
    assert captured['source_task_id'] is None
    assert captured['retry_of_run_id'] == RETRY_TASK_ID
    assert captured['metadata_run_id'] is None
    assert captured['extra_options']['limitTo1000Pages'] is True


@pytest.mark.asyncio
async def test_create_question_carries_page_policy_into_task_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    version = SimpleNamespace(
        status='0',
        source_provider='zujuan',
        external_version_id='v-3',
        version_name='版本 3',
    )
    textbook = SimpleNamespace(
        textbook_id=8,
        version_id=3,
        status='0',
        source_provider='zujuan',
        external_textbook_id='tb-8',
        textbook_name='教材 8',
    )
    captured: list[dict[str, Any]] = []

    async def get_version(_db: object, version_id: int) -> object:
        assert version_id == 3
        return version

    async def get_textbook(_db: object, textbook_id: int) -> object:
        assert textbook_id == 8
        return textbook

    async def create_job(_db: object, **kwargs: Any) -> dict[str, Any]:
        captured.append(kwargs)
        return {'runId': len(captured)}

    from plugins.bank.service.subject_service import SubjectService
    from unittest.mock import AsyncMock
    monkeypatch.setattr(SubjectService, 'require', AsyncMock(return_value=SimpleNamespace(source_profile='zujuan_czsx')))
    monkeypatch.setattr(task_service.BankDao, 'get_version', get_version)
    monkeypatch.setattr(task_service.BankDao, 'get_textbook', get_textbook)
    monkeypatch.setattr(sync_run_service.SyncRunService, '_create_job', create_job)

    await task_service.SyncTaskService.create_question(
        object(),
        {'versionId': 3, 'textbookIds': [8], 'limitTo1000Pages': True},
        'tester',
    )
    await task_service.SyncTaskService.create_question(
        object(),
        {'versionId': 3, 'textbookIds': [8]},
        'tester',
    )

    assert captured[0]['extra_options']['limitTo1000Pages'] is True
    assert captured[1]['extra_options']['limitTo1000Pages'] is False


def test_catalog_tree_breaks_parent_cycles_without_recursion() -> None:
    rows = [
        {
            'sourceProvider': 'zujuan',
            'externalTextbookId': 'tb-8',
            'externalCatalogId': 'a',
            'parentExternalId': 'b',
            'nodeName': 'A',
        },
        {
            'sourceProvider': 'zujuan',
            'externalTextbookId': 'tb-8',
            'externalCatalogId': 'b',
            'parentExternalId': 'a',
            'nodeName': 'B',
        },
    ]

    tree = task_service._catalog_tree(rows, 'fetched')

    assert {item['externalNodeId'] for item in tree} == {'a', 'b'}
    assert all(item['children'] == [] for item in tree)


def test_question_without_nested_catalog_links_uses_chapter_for_filtering() -> None:
    item = task_service._normalise_question(
        {
            'provider': 'zujuan',
            'external_id': 'q-1',
            'chapter_id': 'chapter-8',
            'content_html': '<p>题干</p>',
        }
    )

    assert item is not None
    assert item['chapterId'] == 'chapter-8'


def test_unclassified_solution_is_not_projected_as_answer_or_analysis() -> None:
    item = task_service._normalise_question(
        {
            'provider': 'zujuan',
            'external_id': 'q-1',
            'content_html': '<p>题干</p>',
            'solution_html': '<p>来源答案/解析</p>',
        }
    )

    assert item is not None
    assert item['solutionHtml'] == '<p>来源答案/解析</p>'
    assert 'answerHtml' not in item
    assert 'analysisHtml' not in item

    independent = task_service._normalise_question(
        {
            'provider': 'zujuan',
            'external_id': 'q-2',
            'answer_html': '<p>B</p>',
            'analysis_html': '<p>因为……</p>',
        }
    )
    assert independent is not None
    assert independent['answerHtml'] == '<p>B</p>'
    assert independent['analysisHtml'] == '<p>因为……</p>'


@pytest.mark.asyncio
async def test_question_detail_keeps_collector_solution_as_one_unclassified_block(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scope = SimpleNamespace(
        scope_id=1,
        run_id=11,
        local_textbook_id=8,
        local_version_id=3,
        textbook_name_snapshot='教材',
        version_name_snapshot='版本',
        source_provider='zujuan',
        external_textbook_id='tb-8',
        collector_run_id=44,
        status='completed',
    )

    async def select_scope(cls: object, db: object, task_id: int, query: object) -> tuple[object, list[object]]:
        return SimpleNamespace(status='completed'), [scope]

    async def read_detail(run_id: int, external_id: str, textbook_external_id: str | None) -> dict[str, object]:
        return {
            'provider': 'zujuan',
            'external_id': external_id,
            'content_html': '<p>题干</p>',
            'solution_html': '<p>来源答案/解析</p>',
        }

    async def no_formal(cls: object, db: object, textbook_ids: list[int]) -> list[object]:
        return []

    monkeypatch.setattr(task_service.SyncTaskService, '_scope_selection', classmethod(select_scope))
    monkeypatch.setattr(task_service, '_collector_question_detail', read_detail)
    monkeypatch.setattr(task_service.SyncTaskService, '_formal_questions', classmethod(no_formal))

    result = await task_service.SyncTaskService.question_detail_comparison(object(), 11, 'q-1')

    fetched = result['fetched']
    assert fetched['solutionHtml'] == '<p>来源答案/解析</p>'
    assert 'answerHtml' not in fetched
    assert 'analysisHtml' not in fetched


def test_remote_projection_does_not_erase_durable_job_id_when_omitted() -> None:
    values = sync_run_service._remote_status_values({'status': 'running', 'progressPercent': 10})

    assert 'collector_job_id' not in values


def _collector_summary(run_id: int, textbook_id: str, *, catalogs: int = 0, questions: int = 0) -> dict[str, Any]:
    return {
        'available': True,
        'immutable': True,
        'snapshotComplete': True,
        'run': {
            'id': run_id,
            'provider': 'zujuan',
            'status': 'completed',
            'snapshotComplete': True,
            'snapshotLockedAt': '2026-08-31T10:00:00Z',
            'finishedAt': '2026-08-31T10:00:01Z',
            'scope': {'textbookExternalId': textbook_id},
        },
        'textbookExternalId': textbook_id,
        'counts': {
            'catalogItemCount': catalogs,
            'questionItemCount': questions,
            'questionCatalogCount': 0,
            'questionTagCount': 0,
            'questionAssetCount': 0,
        },
    }


@pytest.mark.asyncio
async def test_collector_rows_use_summary_and_specialized_bounded_pages_without_full_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[tuple[str, int]] = []

    class Client:
        def run_snapshot(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
            raise AssertionError('comparison must not materialize all five snapshot collections')

        def run_snapshot_summary(self, run_id: int, *, textbook_external_id: str) -> dict[str, Any]:
            events.append(('summary', run_id))
            return _collector_summary(run_id, textbook_external_id, catalogs=2)

        def run_catalogs(
            self,
            run_id: int,
            *,
            textbook_external_id: str,
            page: int,
            page_size: int,
        ) -> dict[str, Any]:
            events.append((f'catalogs:{page}', page_size))
            return {
                'available': True,
                'run': _collector_summary(run_id, textbook_external_id, catalogs=2)['run'],
                'total': 2,
                'page': page,
                'pageSize': page_size,
                'rows': [
                    {
                        'sourceProvider': 'zujuan',
                        'externalCatalogId': f'c-{page}',
                        'externalTextbookId': textbook_external_id,
                        'name': f'目录 {page}',
                    }
                ],
            }

    monkeypatch.setattr(task_service, 'CollectorClient', Client)

    run, rows = await task_service._collector_rows(COLLECTOR_RUN_ID, 'catalog', 'tb-8')

    assert run['id'] == COLLECTOR_RUN_ID
    assert [item['externalCatalogId'] for item in rows] == ['c-1', 'c-2']
    assert events == [('summary', COLLECTOR_RUN_ID), ('catalogs:1', 500), ('catalogs:2', 500)]


@pytest.mark.asyncio
async def test_collector_question_detail_uses_summary_and_detail_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []

    class Client:
        def run_snapshot(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
            raise AssertionError('detail must not fetch the full snapshot')

        def run_snapshot_summary(self, run_id: int, *, textbook_external_id: str) -> dict[str, Any]:
            events.append(f'summary:{run_id}:{textbook_external_id}')
            return _collector_summary(run_id, textbook_external_id, questions=1)

        def run_question_detail(
            self,
            run_id: int,
            external_id: str,
            *,
            textbook_external_id: str,
        ) -> dict[str, Any]:
            events.append(f'detail:{run_id}:{external_id}:{textbook_external_id}')
            return {
                'available': True,
                'run': _collector_summary(run_id, textbook_external_id, questions=1)['run'],
                'item': {
                    'sourceProvider': 'zujuan',
                    'externalTextbookId': textbook_external_id,
                    'externalQuestionId': external_id,
                    'contentHtml': '<p>题干</p>',
                },
            }

    monkeypatch.setattr(task_service, 'CollectorClient', Client)

    result = await task_service._collector_question_detail(44, 'q-1', 'tb-8')

    assert result['externalQuestionId'] == 'q-1'
    assert events == ['summary:44:tb-8', 'detail:44:q-1:tb-8']


@pytest.mark.asyncio
async def test_collector_rows_reject_page_count_larger_than_summary(monkeypatch: pytest.MonkeyPatch) -> None:
    class Client:
        def run_snapshot_summary(self, run_id: int, *, textbook_external_id: str) -> dict[str, Any]:
            return _collector_summary(run_id, textbook_external_id, catalogs=1)

        def run_catalogs(self, run_id: int, *, textbook_external_id: str, page: int, page_size: int) -> dict[str, Any]:
            return {
                'available': True,
                'run': _collector_summary(run_id, textbook_external_id, catalogs=1)['run'],
                'total': 2,
                'page': page,
                'pageSize': page_size,
                'rows': [],
            }

    monkeypatch.setattr(task_service, 'CollectorClient', Client)

    with pytest.raises(ServiceException, match='计数与摘要不一致'):
        await task_service._collector_rows(44, 'catalog', 'tb-8')
