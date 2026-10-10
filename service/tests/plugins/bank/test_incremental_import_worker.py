"""Fast submission and actual staging/QC/short-transaction background flow."""

import asyncio
import fcntl
import importlib.util
import threading
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbQuestionImport, QbQuestionImportBatch, QbSyncJob, QbSyncJobScope
from plugins.bank.service import incremental_import_worker as worker
from plugins.bank.service import resource_guard as guard
from plugins.bank.service.incremental_import import (
    attach_incremental_quality,
    claim_pending_incremental_import,
    fail_incremental_import,
    pending_incremental_import_ids,
    renew_incremental_import,
    request_incremental_import,
    submit_incremental_import_batch,
)
from plugins.bank.service.source_write_lock import SourceWriteBusy
from plugins.bank.service.task_service import SyncTaskService
from tests.plugins.bank.test_incremental_import import import_db as import_db
from tests.plugins.bank.test_incremental_import import report, verdict
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_incremental_snapshot import fixture_client


def _client(monkeypatch):
    client, summary, rows, calls = fixture_client(monkeypatch)
    rows['catalogs'][0]['catalog_external_id'] = 'qc-root'
    rows['catalogs'][1].update(catalog_external_id='qc-leaf', parent_external_id='qc-root')
    for relation in rows['questionCatalogs']:
        relation['catalog_external_id'] = 'qc-leaf'
    return client, summary, calls


@pytest.mark.asyncio
async def test_submit_returns_id_before_any_remote_work_and_worker_reuses_id(import_db, monkeypatch, tmp_path):
    db = import_db
    client, _summary, calls = _client(monkeypatch)
    request = await request_incremental_import(db, 28)
    assert calls == []
    assert (request['status'], request['stage'], request['checkedCount'], request['questionCount']) == (
        'queued', 'queued', 0, 3,
    )
    assert 'workerToken' not in request and 'qualityHash' not in request
    assert (await request_incremental_import(db, 28))['importId'] == request['importId']
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    status = (await SyncTaskService.question_detail(db, 28))['incrementalImport']
    assert status['importId'] == request['importId']
    assert (status['status'], status['processedCount'], status['acceptedCount'], status['quarantinedCount']) == (
        'partial', 3, 2, 1,
    )
    assert status['stage'] == 'done' and status['batchCount'] == 1
    before = len(calls)
    await db.rollback()
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    assert len(calls) == before
    assert await db.scalar(select(func.count()).select_from(QbQuestionImportBatch)) == 1


@pytest.mark.asyncio
async def test_resource_pressure_before_staging_requeues_and_recovers_same_import(import_db, monkeypatch, tmp_path):
    db = import_db
    client, _summary, calls = _client(monkeypatch)
    request = await request_incremental_import(db, 28)
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    monkeypatch.setenv('BANK_MIN_DISK_FREE_MIB', '10')
    monkeypatch.setattr(guard, '_CACHE', None)
    monkeypatch.setattr(guard, 'available_disk', lambda _: 0)
    await db.rollback()
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    row = await db.get(QbQuestionImport, request['importId'], populate_existing=True)
    assert row.status == 'queued' and row.cursor == row.batch_no == 0 and '空间' in row.error_message
    assert row.worker_token is None and row.active_source_slot is None and row.lease_until is None
    assert calls == [] and not (tmp_path / f'import-{request["importId"]}.sqlite3').exists()
    monkeypatch.setattr(guard, 'available_disk', lambda _: 10 * guard.MIB)
    guard.resource_status(root=tmp_path, fresh=True)
    await db.rollback()
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    await db.refresh(row)
    assert (row.status, row.cursor, row.accepted_count, row.quarantined_count) == ('partial', 3, 2, 1)


@pytest.mark.asyncio
async def test_resource_pause_after_committed_batch_preserves_cursor_and_reuses_staging(
    import_db, monkeypatch, tmp_path,
):
    db = import_db
    client, _summary, calls = _client(monkeypatch)
    request = await request_incremental_import(db, 28)
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    original_read, original_submit = worker.read_checked_batch, worker.submit_incremental_import_batch
    free = [10 * guard.MIB]
    monkeypatch.setenv('BANK_MIN_DISK_FREE_MIB', '10')
    monkeypatch.setattr(guard, '_CACHE', None)
    monkeypatch.setattr(guard, 'available_disk', lambda _: free[0])
    monkeypatch.setattr(worker, 'read_checked_batch', lambda path, ticket: original_read(path, ticket, size=1))

    async def pressure_after_commit(session, ticket, verdicts, *, expected_cursor):
        result = await original_submit(session, ticket, verdicts, expected_cursor=expected_cursor)
        if expected_cursor == 0:
            free[0] = 0
            guard.resource_status(root=tmp_path, fresh=True)
        return result

    monkeypatch.setattr(worker, 'submit_incremental_import_batch', pressure_after_commit)
    await db.rollback()
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    row = await db.get(QbQuestionImport, request['importId'], populate_existing=True)
    assert (row.status, row.cursor, row.batch_no, row.accepted_count) == ('queued', 1, 1, 1)
    assert row.worker_token is None and row.active_source_slot is None and '空间' in row.error_message
    page_calls = len([route for route, _ in calls if route.endswith('/snapshot-page')])
    free[0] = 10 * guard.MIB
    guard.resource_status(root=tmp_path, fresh=True)
    monkeypatch.setattr(worker, 'submit_incremental_import_batch', original_submit)
    await db.rollback()
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    await db.refresh(row)
    assert (row.status, row.cursor, row.batch_no, row.accepted_count, row.quarantined_count) == ('partial', 3, 3, 2, 1)
    assert len([route for route, _ in calls if route.endswith('/snapshot-page')]) == page_calls


@pytest.mark.asyncio
async def test_queue_and_qc_leases_recover_and_old_owner_cannot_write(import_db):
    db = import_db
    request = await request_incremental_import(db, 28)
    old = await claim_pending_incremental_import(db, request['importId'])
    assert old['status'] == 'preparing' and old['qualityHash'] is None
    with pytest.raises(ServiceException, match='质量检查尚未完成'):
        await submit_incremental_import_batch(db, old, [verdict(0, 'q1')], expected_cursor=0)
    assert await claim_pending_incremental_import(db, request['importId']) is None
    row = await db.get(QbQuestionImport, request['importId'])
    row.lease_until -= timedelta(minutes=10)
    await db.commit()
    recovered = await claim_pending_incremental_import(db, request['importId'])
    assert recovered['workerToken'] != old['workerToken']
    with pytest.raises(ServiceException, match='执行权'):
        await attach_incremental_quality(db, old, report())
    ready = await attach_incremental_quality(db, recovered, report())
    # A heartbeat already started during the transition may still have the
    # preparation identity, but must retain the same token and scope binding.
    await renew_incremental_import(db, recovered)
    await submit_incremental_import_batch(db, ready, [verdict(0, 'q1')], expected_cursor=0)
    await fail_incremental_import(db, ready, '模拟异常')
    retry = await request_incremental_import(db, 28)
    assert retry['importId'] == request['importId'] and retry['processedCount'] == 1
    assert retry['checkedCount'] == 3 and retry['status'] == 'queued'


@pytest.mark.asyncio
async def test_remote_identity_change_fails_without_formal_writes(import_db, monkeypatch, tmp_path):
    db = import_db
    client, summary, _calls = _client(monkeypatch)
    request = await request_incremental_import(db, 28)
    summary['run']['snapshotLockedAt'] = '2026-10-01T01:00:02Z'
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    row = await db.get(QbQuestionImport, request['importId'], populate_existing=True)
    assert row.status == 'failed' and row.cursor == 0 and row.active_source_slot is None
    assert '封存' in row.error_message
    assert await db.scalar(select(func.count()).select_from(QbQuestionImportBatch)) == 0


@pytest.mark.asyncio
async def test_writer_contention_requeues_and_preserves_checkpoint(import_db, monkeypatch, tmp_path):
    db = import_db
    client, _summary, _calls = _client(monkeypatch)
    request = await request_incremental_import(db, 28)
    real_submit = worker.submit_incremental_import_batch

    async def busy(*_args, **_kwargs):
        raise SourceWriteBusy(message='题库正在入库或发布，请稍后重试')

    monkeypatch.setattr(worker, 'submit_incremental_import_batch', busy)
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    row = await db.get(QbQuestionImport, request['importId'], populate_existing=True)
    assert row.status == 'queued' and row.cursor == 0 and row.active_source_slot is None
    await db.rollback()
    monkeypatch.setattr(worker, 'submit_incremental_import_batch', real_submit)
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    assert (await db.get(QbQuestionImport, request['importId'], populate_existing=True)).cursor == 3


@pytest.mark.asyncio
async def test_queued_books_do_not_occupy_shared_source_execution_slot(import_db):
    db = import_db
    task = await db.get(QbSyncJob, 28)
    scope = await db.get(QbSyncJobScope, 30)
    db.add(QbSyncJob(
        run_id=29, subject_id=1, task_module='question', run_type='content', status='failed', phase='failed',
        options_json={'workflowVersion': 2}, acknowledge_source_policy='Y',
        create_time=task.create_time, update_time=task.update_time,
    ))
    db.add(QbSyncJobScope(
        scope_id=31, run_id=29, subject_id=1, local_textbook_id=2, local_version_id=1,
        source_provider='zujuan', external_version_id='v1', external_textbook_id='tb2',
        collector_run_id=28, status='failed', snapshot_complete=0,
        snapshot_locked_at=scope.snapshot_locked_at, question_count=3,
        create_time=task.create_time, update_time=task.update_time,
    ))
    await db.commit()
    first = await request_incremental_import(db, 28)
    second = await request_incremental_import(db, 29)
    assert first['status'] == second['status'] == 'queued'
    assert await db.scalar(select(func.count()).select_from(QbQuestionImport).where(
        QbQuestionImport.active_source_slot.is_not(None)
    )) == 0
    await db.rollback()
    owner = await claim_pending_incremental_import(db, first['importId'])
    assert await claim_pending_incremental_import(db, second['importId']) is None
    await fail_incremental_import(db, owner, '模拟失败释放来源槽')
    second_owner = await claim_pending_incremental_import(db, second['importId'])
    assert second_owner['status'] == 'preparing'
    if db.bind.dialect.name == 'mysql':
        await fail_incremental_import(db, second_owner, '并发验收前释放')
        await request_incremental_import(db, 28)
        await request_incremental_import(db, 29)
        factory = async_sessionmaker(db.bind, expire_on_commit=False)

        async def claim(import_id):
            async with factory() as session:
                return await claim_pending_incremental_import(session, import_id)

        owners = await asyncio.gather(claim(first['importId']), claim(second['importId']))
        assert sum(owner is not None for owner in owners) == 1


@pytest.mark.asyncio
async def test_shutdown_then_expired_recovery_reuses_spool_and_committed_cursor(import_db, monkeypatch, tmp_path):
    db = import_db
    client, _summary, calls = _client(monkeypatch)
    request = await request_incremental_import(db, 28)
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    original_read = worker.read_checked_batch
    original_submit = worker.submit_incremental_import_batch
    paused = asyncio.Event()

    def read_one(path, ticket):
        return original_read(path, ticket, size=1)

    async def pause_after_commit(session, ticket, verdicts, *, expected_cursor):
        result = await original_submit(session, ticket, verdicts, expected_cursor=expected_cursor)
        if expected_cursor == 0:
            paused.set()
            await asyncio.Event().wait()
        return result

    monkeypatch.setattr(worker, 'read_checked_batch', read_one)
    monkeypatch.setattr(worker, 'submit_incremental_import_batch', pause_after_commit)
    task = asyncio.create_task(worker.dispatch_incremental_imports_once(
        session_factory=factory, client=client, root=tmp_path,
    ))
    try:
        await asyncio.wait_for(paused.wait(), timeout=5)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    row = await db.get(QbQuestionImport, request['importId'], populate_existing=True)
    assert row.status == 'running' and row.cursor == row.batch_no == 1
    row.lease_until -= timedelta(minutes=10)
    await db.commit()
    page_calls = len([route for route, _query in calls if route.endswith('/snapshot-page')])
    monkeypatch.setattr(worker, 'submit_incremental_import_batch', original_submit)
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    row = await db.get(QbQuestionImport, request['importId'], populate_existing=True)
    assert (row.status, row.cursor, row.batch_no, row.accepted_count, row.quarantined_count) == ('partial', 3, 3, 2, 1)
    assert len([route for route, _query in calls if route.endswith('/snapshot-page')]) == page_calls


def test_old_staging_thread_cannot_share_sqlite_file(monkeypatch, tmp_path):
    client, _summary, _calls = _client(monkeypatch)
    path = tmp_path / 'import-1.sqlite3'
    with path.with_suffix('.lock').open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(worker.PreparationBusy):
            worker._prepare({'importId': 1}, client, path, threading.Event())
    assert not path.exists()


@pytest.mark.asyncio
async def test_heartbeat_loss_stops_one_owner_but_dispatcher_can_recover(import_db, monkeypatch, tmp_path):
    db = import_db
    client, _summary, _calls = _client(monkeypatch)
    request = await request_incremental_import(db, 28)
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    prepare = worker._prepare
    renew = worker.renew_incremental_import

    def wait_for_loss(_ticket, _client, _path, stop, paused=None):
        assert stop.wait(2)
        raise ServiceException(message='测试执行者已停止')

    async def lose_lease(*_args):
        raise ServiceException(message='测试心跳执行权丢失')

    monkeypatch.setattr(worker, '_prepare', wait_for_loss)
    monkeypatch.setattr(worker, 'renew_incremental_import', lose_lease)
    monkeypatch.setattr(worker, 'HEARTBEAT_SECONDS', 0.01)
    await asyncio.wait_for(worker.dispatch_incremental_imports_once(
        session_factory=factory, client=client, root=tmp_path,
    ), timeout=3)
    row = await db.get(QbQuestionImport, request['importId'], populate_existing=True)
    assert row.status == 'preparing' and row.cursor == 0
    row.lease_until -= timedelta(minutes=10)
    await db.commit()
    monkeypatch.setattr(worker, '_prepare', prepare)
    monkeypatch.setattr(worker, 'renew_incremental_import', renew)
    monkeypatch.setattr(worker, 'HEARTBEAT_SECONDS', 30)
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    assert (await db.get(QbQuestionImport, request['importId'], populate_existing=True)).status == 'partial'


@pytest.mark.asyncio
async def test_queued_work_cannot_delete_task_or_use_changed_binding(import_db):
    db = import_db
    request = await request_incremental_import(db, 28)
    with pytest.raises(ServiceException, match='未结束的分批入库'):
        await SyncTaskService.delete_question(db, 28)
    await db.rollback()
    scope = await db.get(QbSyncJobScope, 30)
    scope.collector_run_id = 29
    await db.commit()
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    await worker.dispatch_incremental_imports_once(session_factory=factory)
    row = await db.get(QbQuestionImport, request['importId'], populate_existing=True)
    assert row.status == 'failed' and '封存身份' in row.error_message
    assert await pending_incremental_import_ids(db) == []


@pytest.mark.asyncio
async def test_016_repeated_migration_keeps_committed_batch_and_preparation(import_db):
    db = import_db
    if db.bind.dialect.name != 'mysql':
        pytest.skip('requires isolated MySQL migration check')
    request = await request_incremental_import(db, 28)
    ticket = await claim_pending_incremental_import(db, request['importId'])
    ready = await attach_incremental_quality(db, ticket, report())
    await submit_incremental_import_batch(db, ready, [verdict(0, 'q1')], expected_cursor=0)
    path = Path('plugins/bank/migrations/mysql/016_import_preparation.py')
    spec = importlib.util.spec_from_file_location('import_preparation_migration', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for _ in range(2):
        await module.run(db)
        await db.commit()
    row = await db.get(QbQuestionImport, request['importId'], populate_existing=True)
    assert row.cursor == 1 and row.batch_no == 1 and row.active_source_slot == 'zujuan'
    assert row.quality_hash == report()['qualityHash']
    assert await db.scalar(select(func.count()).select_from(QbQuestionImportBatch)) == 1
