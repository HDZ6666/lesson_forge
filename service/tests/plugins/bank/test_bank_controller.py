from __future__ import annotations

from typing import get_type_hints

import pytest
from fastapi import FastAPI

from plugins.bank.controller.bank_controller import bank_controller, list_versions


def test_bank_router_openapi_and_runtime_annotations() -> None:
    app = FastAPI()
    app.include_router(bank_controller)
    schema = app.openapi()

    assert '/bank/version/list' in schema['paths']
    assert '/bank/question/{question_id}/asset/{asset_key}' in schema['paths']
    assert '/bank/question/{question_id}/asset/{asset_id}/file' not in schema['paths']
    assert schema['paths']['/bank/version/list']['get']['responses']['200']['content']
    get_type_hints(list_versions, include_extras=True)


def test_bank_mutation_routes_have_separate_permissions() -> None:
    expected = {
        '/bank/batch/{batch_id}/approve': 'bank:batch:approve',
        '/bank/batch/{batch_id}/publish': 'bank:batch:publish',
        '/bank/batch/{batch_id}/rollback': 'bank:batch:rollback',
    }
    for route in bank_controller.routes:
        if route.path not in expected:
            continue
        permissions = {
            getattr(dependency.call, 'perm', None)
            for dependency in route.dependant.dependencies
            if getattr(dependency.call, 'perm', None)
        }
        assert expected[route.path] in permissions


def test_sync_routes_use_entity_scoped_read_and_separate_review_permission() -> None:
    routes = {route.path: route for route in bank_controller.routes}
    compare_route = routes['/bank/sync/{entity_type}/compare']
    review_route = routes['/bank/sync/{entity_type}/review']

    assert any(
        dependency.call.__class__.__name__ == '_SyncListPermission'
        for dependency in compare_route.dependant.dependencies
    )
    review_permissions = {getattr(dependency.call, 'perm', None) for dependency in review_route.dependant.dependencies}
    assert 'bank:sync:review' in review_permissions


def test_sync_run_reads_allow_center_or_legacy_list_users_but_mutations_require_run_permission() -> None:
    routes = {route.path: route for route in bank_controller.routes}
    expected_read_permissions = {
        'bank:sync:run',
        'bank:sync:version:list',
        'bank:sync:textbook:list',
        'bank:sync:catalog:list',
        'bank:sync:question:list',
    }

    for path in (
        '/bank/sync/run/current',
        '/bank/sync/run/list',
        '/bank/sync/run/{run_id}',
        '/bank/sync/catalog-progress',
    ):
        permissions = [getattr(dependency.call, 'perm', None) for dependency in routes[path].dependant.dependencies]
        read_permission = next(
            permission
            for permission in permissions
            if isinstance(permission, list) and 'bank:sync:center:list' in permission
        )
        assert expected_read_permissions <= set(read_permission)

    for path in (
        '/bank/sync/run/metadata/start',
        '/bank/sync/run/content/start',
        '/bank/sync/run/{run_id}/cancel',
    ):
        permissions = [getattr(dependency.call, 'perm', None) for dependency in routes[path].dependant.dependencies]
        assert 'bank:sync:run' in permissions


def test_sync_center_exposes_metadata_and_content_start_routes() -> None:
    routes = {route.path: route for route in bank_controller.routes}
    assert '/bank/sync/metadata/snapshot' in routes
    assert '/bank/sync/metadata/textbook-overview' in routes
    assert '/bank/sync/run/start' not in routes
    assert '/bank/sync/run/metadata/start' in routes
    assert '/bank/sync/run/content/start' in routes
    snapshot_permissions = [
        getattr(dependency.call, 'perm', None)
        for dependency in routes['/bank/sync/metadata/snapshot'].dependant.dependencies
    ]
    assert any(
        isinstance(permission, list) and 'bank:sync:center:list' in permission for permission in snapshot_permissions
    )
    overview_permissions = [
        getattr(dependency.call, 'perm', None)
        for dependency in routes['/bank/sync/metadata/textbook-overview'].dependant.dependencies
    ]
    assert any(
        isinstance(permission, list) and {'bank:sync:center:list', 'bank:sync:textbook:list'} <= set(permission)
        for permission in overview_permissions
    )


@pytest.mark.asyncio
async def test_failure_page_uses_task_metadata_identity_and_releases_db(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from plugins.bank.controller import bank_controller as module

    task = SimpleNamespace(metadata_run_id=17)
    monkeypatch.setattr(module.SyncTaskDao, 'get', AsyncMock(return_value=task))
    db = SimpleNamespace(rollback=AsyncMock())
    calls = []

    class Client:
        def metadata_failure_page(self, run_id):
            calls.append(run_id)
            assert db.rollback.await_count == 1
            return {'available': True, 'runId': run_id, 'text': '阻断页面'}

    monkeypatch.setattr(module, 'CollectorClient', Client)
    response = await module.get_textbook_failure_page(5, db)
    import json

    assert json.loads(response.body)['data']['runId'] == 17
    assert calls == [17]
    module.SyncTaskDao.get.assert_awaited_once_with(db, 5, 'textbook')


@pytest.mark.asyncio
async def test_failure_page_does_not_read_collector_for_missing_task(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from exceptions.exception import ServiceException
    from plugins.bank.controller import bank_controller as module

    monkeypatch.setattr(module.SyncTaskDao, 'get', AsyncMock(return_value=None))
    monkeypatch.setattr(module, 'CollectorClient', lambda: pytest.fail('must not contact collector'))
    with pytest.raises(ServiceException, match='教材发现任务不存在'):
        await module.get_textbook_failure_page(5, SimpleNamespace(rollback=AsyncMock()))


def test_failure_page_requires_same_permission_as_task_detail():
    routes = {route.path: route for route in bank_controller.routes if 'GET' in route.methods}
    def permissions(path):
        return [getattr(dep.call, 'perm', None) for dep in routes[path].dependant.dependencies]
    assert permissions('/bank/sync/textbook/tasks/{task_id}/failure-page') == permissions('/bank/sync/textbook/tasks/{task_id}')
