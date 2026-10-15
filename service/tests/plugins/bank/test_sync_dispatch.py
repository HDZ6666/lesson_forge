"""Real ORM waiting/claim/recovery behavior; opt-in scratch MySQL races."""

import asyncio
import importlib.util
import os
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from exceptions.exception import ServiceException
from plugins.bank.dao.sync_job_dao import SyncJobDao
from plugins.bank.entity.do.bank_do import (
    QbQuestionImport,
    QbQuestionImportIntake,
    QbSyncJob,
    QbSyncJobScope,
    QbTextbook,
)
from plugins.bank.service import sync_dispatch as dispatch
from plugins.bank.service import sync_run_service as runs
from plugins.bank.service.incremental_import import request_incremental_import
from plugins.bank.service.task_service import SyncTaskService
from tests.plugins.bank.test_incremental_import import import_db as import_db
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db


async def enqueue(db, book=1, **options):
    return await SyncTaskService.create_question(db, {'versionId': 1, 'textbookId': book, **options}, 'tester')


@pytest.mark.asyncio
async def test_manual_queue_is_durable_without_collector_or_activity_slot(bank_db, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('enqueue must not call Collector')

    monkeypatch.setattr(runs.CollectorClient, 'health', forbidden)
    first, second = await enqueue(bank_db), await enqueue(bank_db, 2)
    repeated = await enqueue(bank_db)
    assert repeated['taskId'] == first['taskId'] != second['taskId']
    assert first['queueState'] == second['queueState'] == 'waiting'
    assert await bank_db.scalar(select(func.count()).select_from(QbSyncJob)) == 2
    assert await SyncJobDao.list_active(bank_db) == []
    assert await SyncJobDao.get_current(bank_db) is None
    assert await SyncJobDao.mark_interrupted(bank_db, 'stale', datetime.now() + timedelta(days=1)) == 0
    row = await bank_db.get(QbSyncJob, first['taskId'])
    assert row.active_slot is None and row.worker_token is None and row.dispatch_job_id
    assert first['collectorJobId'] is None
    assert 'dispatchJobId' not in first and 'workerToken' not in first
    with pytest.raises(ServiceException, match='设置不同'):
        await enqueue(bank_db, limitTo1000Pages=True)


@pytest.mark.asyncio
async def test_claim_fifo_and_only_one_execution_slot(bank_db):
    first, second = await enqueue(bank_db), await enqueue(bank_db, 2)
    claim = await dispatch.claim_next(bank_db)
    assert claim['taskId'] == first['taskId']
    assert await dispatch.claim_next(bank_db) is None
    row = await bank_db.get(QbSyncJob, first['taskId'])
    row.status = row.phase = 'failed'
    row.active_slot = None
    await bank_db.commit()
    assert await dispatch.release_finished_books(bank_db) == 1
    assert (await dispatch.claim_next(bank_db))['taskId'] == second['taskId']
    assert (await enqueue(bank_db))['taskId'] != first['taskId']


@pytest.mark.asyncio
async def test_due_time_uses_database_utc_even_when_local_business_clock_differs(bank_db, monkeypatch):
    first = await enqueue(bank_db)
    row = await bank_db.get(QbSyncJob, first['taskId'])
    row.dispatch_not_before = await dispatch._clock(bank_db) + timedelta(minutes=1)
    await bank_db.commit()

    class LocalTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.now() + timedelta(hours=8)

    monkeypatch.setattr(dispatch, 'datetime', LocalTime)
    assert await dispatch.claim_next(bank_db) is None
    row.dispatch_not_before = await dispatch._clock(bank_db) - timedelta(seconds=1)
    await bank_db.commit()
    assert (await dispatch.claim_next(bank_db))['taskId'] == first['taskId']


@pytest.mark.asyncio
async def test_reservation_retained_through_intake_registration_retry_and_auto_resume(bank_db):
    first = await enqueue(bank_db)
    row = await bank_db.get(QbSyncJob, first['taskId'])
    row.status = row.phase = 'interrupted'
    scope = (await bank_db.execute(select(QbSyncJobScope).where(QbSyncJobScope.run_id == row.run_id))).scalar_one()
    scope.status = 'interrupted'
    scope.collector_run_id = 40
    await bank_db.commit()
    assert await dispatch.release_finished_books(bank_db) == 0
    intake = QbQuestionImportIntake(
        task_id=row.run_id,
        scope_id=scope.scope_id,
        collector_run_id=40,
        binding_hash='a' * 64,
        status='retry',
        create_time=datetime.now(),
        update_time=datetime.now(),
    )
    bank_db.add(intake)
    await bank_db.commit()
    assert await dispatch.release_finished_books(bank_db) == 0
    intake.status = 'blocked'
    row.options_json = {**row.options_json, 'autoResumePending': True}
    await bank_db.commit()
    assert await dispatch.release_finished_books(bank_db) == 0
    row.options_json = {**row.options_json, 'autoResumePending': False}
    await bank_db.commit()
    assert await dispatch.release_finished_books(bank_db) == 1


@pytest.mark.asyncio
async def test_waiting_cancel_is_final_without_collector_and_releases_book(bank_db, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('waiting cancellation must not call Collector')

    monkeypatch.setattr(runs.CollectorClient, 'cancel_job', forbidden)
    first = await enqueue(bank_db)
    cancelled = await SyncTaskService.cancel_question(bank_db, first['taskId'])
    assert cancelled['status'] == 'cancelled' and cancelled['queueState'] == 'closed'
    assert await dispatch.claim_next(bank_db) is None
    assert (await enqueue(bank_db))['taskId'] != first['taskId']


@pytest.mark.asyncio
async def test_disabled_waiting_book_is_local_block_and_next_book_can_run(bank_db):
    first, second = await enqueue(bank_db), await enqueue(bank_db, 2)
    book = await bank_db.get(QbTextbook, 1)
    book.status = '1'
    await bank_db.commit()
    assert await dispatch.claim_next(bank_db) is None
    blocked = await bank_db.get(QbSyncJob, first['taskId'])
    assert blocked.status == 'blocked' and '已停用' in blocked.error_message
    assert (await dispatch.claim_next(bank_db))['taskId'] == second['taskId']


@pytest.mark.asyncio
async def test_collector_outage_keeps_waiting_and_persists_retry(bank_db):
    first = await enqueue(bank_db)

    class Offline:
        def health(self):
            raise ServiceException(message='Collector 暂不可用')

    await bank_db.rollback()
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    assert await dispatch.dispatch_once(session_factory=factory, client=Offline()) == 0
    row = await bank_db.get(QbSyncJob, first['taskId'])
    await bank_db.refresh(row)
    assert row.status == 'queued' and row.active_slot is None
    assert row.dispatch_not_before > await dispatch._clock(bank_db) and row.dispatch_error == 'Collector 暂不可用'
    assert await dispatch.claim_next(bank_db) is None


@pytest.mark.asyncio
async def test_source_pause_keeps_book_waiting_without_consuming_execution_slot(bank_db):
    first = await enqueue(bank_db)

    class Paused:
        def health(self):
            return {
                'ok': True,
                'sourceControl': {
                    'paused': True,
                    'manualRequired': False,
                    'notBefore': '2099-01-01T00:00:00Z',
                    'reason': '来源 429 公共冷却',
                },
            }

    await bank_db.rollback()
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    assert await dispatch.dispatch_once(session_factory=factory, client=Paused()) == 0
    row = await bank_db.get(QbSyncJob, first['taskId'])
    await bank_db.refresh(row)
    assert row.status == 'queued' and row.active_slot is None
    assert row.dispatch_not_before.year == 2099 and row.dispatch_error == '来源 429 公共冷却'
    assert dispatch.queue_fields(row)['queueNotBefore'].utcoffset() == timedelta(0)
    assert await dispatch.claim_next(bank_db) is None


@pytest.mark.asyncio
@pytest.mark.parametrize('backlog_kind', ['import', 'intake'])
async def test_backlog_waits_without_remote_call_then_dispatches_when_settled(import_db, monkeypatch, backlog_kind):
    db = import_db
    first = await enqueue(db, 2)
    if backlog_kind == 'import':
        await db.rollback()
        request = await request_incremental_import(db, 28)
        backlog = await db.get(QbQuestionImport, request['importId'])
    else:
        scope = (await db.execute(select(QbSyncJobScope).where(QbSyncJobScope.run_id == 28))).scalar_one()
        backlog = QbQuestionImportIntake(
            task_id=28,
            scope_id=scope.scope_id,
            collector_run_id=scope.collector_run_id,
            binding_hash='b' * 64,
            status='retry',
            create_time=datetime.now(),
            update_time=datetime.now(),
        )
        db.add(backlog)
        await db.commit()
    backlog_id = backlog.import_id if backlog_kind == 'import' else backlog.intake_id
    backlog_type = type(backlog)
    monkeypatch.setenv('BANK_SYNC_MAX_PENDING_IMPORTS', '1')
    calls, executed = [], []

    class Healthy:
        def health(self):
            calls.append('health')
            return {'ok': True}

    async def execute(task_id, handle):
        executed.append(task_id)

    monkeypatch.setattr(runs, '_execute', execute)
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    await db.rollback()
    assert await dispatch.dispatch_once(session_factory=factory, client=Healthy()) == 0
    row = await db.get(QbSyncJob, first['taskId'], populate_existing=True)
    assert calls == [] and row.active_slot is None and row.status == 'queued'
    assert '积压' in row.dispatch_error and row.dispatch_not_before > await dispatch._clock(db)
    backlog = await db.get(backlog_type, backlog_id, populate_existing=True)
    backlog.status = 'failed' if backlog_kind == 'import' else 'ready'
    row.dispatch_not_before = None
    await db.commit()
    try:
        assert await dispatch.dispatch_once(session_factory=factory, client=Healthy()) == 1
        await asyncio.sleep(0)
        assert calls == ['health'] and executed == [first['taskId']]
        await db.refresh(row)
        assert row.active_slot == '1' and row.dispatch_error is None
    finally:
        runs._WORKERS.pop(first['taskId'], None)


@pytest.mark.asyncio
async def test_host_pressure_waits_and_recovery_checks_collector_without_losing_task(bank_db, monkeypatch, tmp_path):
    from plugins.bank.service import resource_guard as guard

    first = await enqueue(bank_db)
    free = [0]
    monkeypatch.setenv('BANK_MIN_DISK_FREE_MIB', '1')
    monkeypatch.setattr(guard, '_CACHE', None)
    monkeypatch.setattr(guard, 'available_disk', lambda _: free[0])
    calls = []

    class Offline:
        def health(self):
            calls.append('health')
            raise ServiceException(message='Collector 离线')

    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    await bank_db.rollback()
    assert await dispatch.dispatch_once(session_factory=factory, client=Offline()) == 0
    row = await bank_db.get(QbSyncJob, first['taskId'], populate_existing=True)
    assert calls == [] and row.status == 'queued' and row.active_slot is None
    assert '空间' in row.dispatch_error and row.collector_job_id is None
    free[0] = guard.MIB
    guard.resource_status(root=tmp_path, fresh=True)
    row.dispatch_not_before = None
    await bank_db.commit()
    assert await dispatch.dispatch_once(session_factory=factory, client=Offline()) == 0
    await bank_db.refresh(row)
    assert calls == ['health'] and row.dispatch_error == 'Collector 离线'
    assert row.status == 'queued' and row.active_slot is None


@pytest.mark.asyncio
async def test_cached_ready_reader_starts_actual_dispatch_loop(bank_db, monkeypatch):
    from plugins.bank.service import incremental_import_worker, question_readiness_worker

    # on_startup validates the collector configuration; do not depend on
    # the developer's shell having BANK_COLLECTOR_URL set.
    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.test:8080')
    monkeypatch.setenv('BANK_COLLECTOR_TOKEN', 'test-token')
    first = await enqueue(bank_db)
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    monkeypatch.setattr(runs.DataSourceRegistry, 'session', factory)
    monkeypatch.setattr(incremental_import_worker, 'start_incremental_import_worker', lambda: None)
    monkeypatch.setattr(question_readiness_worker, 'start_question_readiness_worker', lambda: None)
    checked = asyncio.Event()
    loop = asyncio.get_running_loop()

    def health(_self):
        loop.call_soon_threadsafe(checked.set)
        return {'ok': True, 'sourceControl': {'paused': True, 'reason': 'reader 后台循环正常执行'}}

    async def forbidden():
        raise AssertionError('reader must not perform immediate startup-wide recovery')

    monkeypatch.setattr(dispatch.CollectorClient, 'health', health)
    monkeypatch.setattr(runs.SyncRunService, 'recover_orphans', forbidden)
    monkeypatch.setattr(runs.SyncRunService, 'resume_pending_question_tasks', forbidden)
    await bank_db.rollback()
    try:
        await runs.on_startup(SimpleNamespace(startup_write_enabled=False))
        await asyncio.wait_for(checked.wait(), timeout=3)
        for _ in range(100):
            row = await bank_db.get(QbSyncJob, first['taskId'], populate_existing=True)
            if row.dispatch_error:
                break
            await bank_db.rollback()
            await asyncio.sleep(0.01)
        assert row.status == 'queued' and row.active_slot is None
        assert row.dispatch_error == 'reader 后台循环正常执行' and row.dispatch_not_before is not None
    finally:
        await dispatch.stop_sync_dispatch_worker()
        await runs.SyncRunService.shutdown()


@pytest.mark.asyncio
async def test_expired_claim_recovered_once_same_remote_uuid_and_old_token_cannot_write(bank_db, monkeypatch):
    first = await enqueue(bank_db)
    claim = await dispatch.claim_next(bank_db)
    row = await bank_db.get(QbSyncJob, first['taskId'])
    row.status = 'running'  # Crash after POST, before persisting Collector acknowledgement.
    row.update_time = datetime.now() - timedelta(minutes=2)
    await bank_db.commit()
    job_id = row.dispatch_job_id
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    monkeypatch.setattr(runs.DataSourceRegistry, 'session', factory)
    handles = []

    async def recovered(task_id, handle):
        handles.append((task_id, handle))

    monkeypatch.setattr(runs, '_execute', recovered)
    try:
        await runs.SyncRunService.recover_orphans()
        await asyncio.sleep(0)
        assert len(handles) == 1 and handles[0][0] == first['taskId']
        assert handles[0][1].token != claim['token']
        await bank_db.refresh(row)
        assert row.status == 'queued' and row.dispatch_job_id == job_id
        owner = runs._QUEUE_OWNER.set((first['taskId'], claim['token']))
        try:
            assert not await runs._update_row(first['taskId'], {'error_message': 'stale'})
            with pytest.raises(runs.WorkerOwnershipLost):
                await runs._update_scope_values(first['taskId'], {'status': 'failed'})
        finally:
            runs._QUEUE_OWNER.reset(owner)
        await runs.SyncRunService.recover_orphans()
        await asyncio.sleep(0)
        assert len(handles) == 1
        assert row.error_message is None
    finally:
        runs._WORKERS.pop(first['taskId'], None)


@pytest.mark.asyncio
async def test_unacknowledged_start_retains_slot_for_reconciliation(bank_db, monkeypatch):
    first = await enqueue(bank_db)
    claim = await dispatch.claim_next(bank_db)
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    monkeypatch.setattr(runs.DataSourceRegistry, 'session', factory)

    async def uncertain(task_id, handle, _max_pages):
        assert handle.dispatch_job_id == claim['jobId']
        raise runs.DispatchAckPending(message='等待核对派发')

    monkeypatch.setattr(runs, '_execute_remote', uncertain)
    await runs._execute(first['taskId'], runs._WorkerHandle(token=claim['token']))
    row = await bank_db.get(QbSyncJob, first['taskId'])
    await bank_db.refresh(row)
    assert row.status == 'queued' and row.active_slot == '1'
    assert row.dispatch_error == '等待核对派发' and row.dispatch_job_id == claim['jobId']
    assert await dispatch.claim_next(bank_db) is None


@pytest.mark.asyncio
async def test_v2_retry_keeps_v2_and_returns_queued_task(bank_db):
    first = await enqueue(bank_db)
    await SyncTaskService.cancel_question(bank_db, first['taskId'])
    retry = await SyncTaskService.retry_question(bank_db, first['taskId'], 'tester')
    assert retry['taskId'] != first['taskId'] and retry['retryOfTaskId'] == first['taskId']
    assert retry['queueState'] == 'waiting' and retry['workflowVersion'] == 2
    assert (await SyncTaskService.retry_question(bank_db, first['taskId'], 'tester'))['taskId'] == retry['taskId']


@pytest.mark.asyncio
async def test_v2_internal_recovery_keeps_task_number_and_fresh_dispatch_uuid(bank_db, monkeypatch):
    first = await enqueue(bank_db)
    row = await bank_db.get(QbSyncJob, first['taskId'])
    old_uuid = row.dispatch_job_id
    row.status = row.phase = 'interrupted'
    scope = (await bank_db.execute(select(QbSyncJobScope).where(QbSyncJobScope.run_id == row.run_id))).scalar_one()
    scope.status = 'interrupted'
    await bank_db.commit()
    # This run never reached Collector: no intake/import recovery is pending.
    result = await runs.SyncRunService.resume_question(bank_db, row.run_id, 'tester')
    assert result['taskId'] == row.run_id and result['queueState'] == 'waiting'
    assert row.dispatch_job_id != old_uuid and row.active_slot is None
    assert (await runs.SyncRunService.resume_question(bank_db, row.run_id, 'tester'))['taskId'] == row.run_id


@pytest.mark.asyncio
async def test_older_intake_import_retains_task_and_new_reservation_blocks_old_retry(import_db):
    db = import_db
    # This pre-queue v2 task has a sealed run awaiting registration.
    assert (await enqueue(db))['taskId'] == 28
    await db.rollback()
    queued_import = await request_incremental_import(db, 28)
    assert (await enqueue(db))['taskId'] == 28
    assert (await enqueue(db, 2))['taskId'] != 28
    intake = QbQuestionImportIntake(
        task_id=28,
        scope_id=30,
        collector_run_id=27,
        binding_hash='a' * 64,
        status='blocked',
        create_time=datetime.now(),
        update_time=datetime.now(),
    )
    db.add(intake)
    old_import = await db.get(QbQuestionImport, queued_import['importId'])
    old_import.status = 'failed'
    await db.commit()
    current = await enqueue(db)
    assert current['taskId'] != 28 and current['queueState'] == 'waiting'
    await db.rollback()
    with pytest.raises(ServiceException, match='新的待办'):
        await request_incremental_import(db, 28)


@pytest.mark.asyncio
@pytest.mark.parametrize('queued', [False, True])
async def test_imported_run_without_later_intake_record_allows_next_task(import_db, queued):
    db = import_db
    old = await db.get(QbSyncJob, 28)
    scope = await db.get(QbSyncJobScope, 30)
    if queued:
        old.dispatch_book_key = dispatch.book_key(1, 'zujuan', 'tb1')
        old.dispatch_job_id = '876dc4e6-e5e7-4e2f-8361-5335a5447b04'
    await db.commit()
    imported = await request_incremental_import(db, 28)
    assert (await enqueue(db))['taskId'] == 28
    row = await db.get(QbQuestionImport, imported['importId'])
    row.status = 'partial'
    # An import from a prior run cannot settle the newly sealed run.
    scope.collector_run_id = 29
    await db.commit()
    assert await dispatch.release_finished_books(db) == 0
    assert (await enqueue(db))['taskId'] == 28
    scope.collector_run_id = 27
    await db.commit()
    assert await dispatch.release_finished_books(db) == int(queued)
    assert (await enqueue(db))['taskId'] != 28


@pytest.mark.asyncio
@pytest.mark.skipif(os.getenv('LESSON_REFACTOR_MYSQL_MERGE_CHECK') != '1', reason='isolated MySQL required')
async def test_waiting_cancel_refreshes_cached_row_after_another_session_claim(bank_db):
    first = await enqueue(bank_db)
    stale = await bank_db.get(QbSyncJob, first['taskId'])
    assert stale.active_slot is None
    await bank_db.rollback()
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    async with factory() as session:
        assert (await dispatch.claim_next(session))['taskId'] == first['taskId']
    assert await dispatch.cancel_waiting(bank_db, first['taskId']) is False
    await bank_db.refresh(stale)
    assert stale.active_slot == '1' and stale.dispatch_book_key and stale.status == 'queued'


@pytest.mark.asyncio
@pytest.mark.skipif(os.getenv('LESSON_REFACTOR_MYSQL_MERGE_CHECK') != '1', reason='isolated MySQL required')
async def test_concurrent_book_enqueue_and_dispatch_have_one_winner(bank_db):
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    await bank_db.rollback()

    async def create():
        async with factory() as session:
            return await enqueue(session)

    same = await asyncio.gather(create(), create())
    assert same[0]['taskId'] == same[1]['taskId']
    async with factory() as session:
        await enqueue(session, 2)

    async def claim():
        async with factory() as session:
            return await dispatch.claim_next(session)

    winners = [item for item in await asyncio.gather(claim(), claim()) if item]
    assert len(winners) == 1
    assert await bank_db.scalar(select(func.count()).select_from(QbSyncJob).where(QbSyncJob.active_slot == '1')) == 1


@pytest.mark.asyncio
@pytest.mark.skipif(os.getenv('LESSON_REFACTOR_MYSQL_MERGE_CHECK') != '1', reason='isolated MySQL required')
async def test_dispatch_migration_additive_repeat_preserves_waiting(bank_db):
    await bank_db.execute(text('DROP INDEX uk_qb_sync_job_dispatch_book ON qb_sync_job'))
    await bank_db.execute(text('DROP INDEX idx_qb_sync_job_dispatch_due ON qb_sync_job'))
    for column in ('dispatch_book_key', 'dispatch_job_id', 'dispatch_not_before', 'dispatch_error'):
        await bank_db.execute(text(f'ALTER TABLE qb_sync_job DROP COLUMN {column}'))
    path = Path(__file__).parents[3] / 'plugins/bank/migrations/mysql/020_sync_dispatch.py'
    spec = importlib.util.spec_from_file_location('dispatch_migration', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    await module.run(bank_db)
    await bank_db.commit()
    first = await enqueue(bank_db)
    job_id = (await bank_db.get(QbSyncJob, first['taskId'])).dispatch_job_id
    await module.run(bank_db)
    await module.run(bank_db)
    await bank_db.commit()
    assert (await enqueue(bank_db))['taskId'] == first['taskId']
    assert (await bank_db.get(QbSyncJob, first['taskId'])).dispatch_job_id == job_id


@pytest.mark.asyncio
async def test_v2_public_refill_creates_linked_task_and_preserves_old_logs(bank_db):
    first = await enqueue(bank_db)
    task = await bank_db.get(QbSyncJob, first['taskId'])
    task.status = task.phase = 'completed'
    task.dispatch_book_key = None
    task.log_tail = 'old partial collection log'
    scope = await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == task.run_id))
    scope.status = 'completed'
    scope.catalog_count = scope.question_count = scope.question_catalog_count = 1
    scope.collector_run_id = 91
    scope.snapshot_locked_at = datetime.utcnow()
    scope.snapshot_complete = 0
    await bank_db.commit()
    prior_id = task.run_id
    shown = await SyncTaskService.question_detail(bank_db, prior_id)
    assert shown['resumeAvailable'] is True
    new = await SyncTaskService.resume_question(bank_db, prior_id, 'tester')
    assert new['taskId'] != prior_id and new['status'] == 'queued'
    newer = await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == new['taskId']))
    assert newer.resume_from_collector_run_id == 91
    old = await bank_db.get(QbSyncJob, prior_id)
    assert old.status == 'completed' and old.log_tail == 'old partial collection log'
    assert (await SyncTaskService.resume_question(bank_db, prior_id, 'tester'))['taskId'] == new['taskId']


@pytest.mark.asyncio
async def test_empty_sealed_refill_uses_fresh_scan_instead_of_invalid_clone(bank_db):
    first = await enqueue(bank_db)
    row = await bank_db.get(QbSyncJob, first['taskId'])
    row.status = row.phase = 'interrupted'
    row.dispatch_book_key = None
    scope = await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == row.run_id))
    scope.collector_run_id = 95
    scope.snapshot_locked_at = datetime.utcnow()
    scope.snapshot_complete = 0
    await bank_db.commit()
    new = await SyncTaskService.resume_question(bank_db, first['taskId'], 'tester')
    new_scope = await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == new['taskId']))
    assert new['taskId'] != first['taskId'] and new['retryOfTaskId'] == first['taskId']
    assert new_scope.resume_from_collector_run_id is None


@pytest.mark.asyncio
async def test_manual_request_reuses_but_releases_automatic_pause(bank_db, monkeypatch):
    from plugins.bank.controller.sync_plan_controller import PlanInput
    from plugins.bank.entity.do.bank_do import QbSyncPlan
    from plugins.bank.service import sync_plans as plans

    plan = await plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True))
    automatic = await SyncTaskService.create_question(
        bank_db, {'versionId': 1, 'textbookId': 1}, 'automatic',
        automatic_options={'autoPlanId': plan['planId'], 'autoCycleNo': 1},
    )
    row = await bank_db.get(QbSyncJob, automatic['taskId'])
    row.dispatch_not_before = await dispatch._clock(bank_db) + timedelta(seconds=30)
    row.dispatch_error = '自动计划已暂停，待办保留'
    await bank_db.commit()
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '0')
    await plans.save_plan(bank_db,PlanInput(subjectId=1,enabled=False,expectedRevision=plan['revision']))
    manual = await enqueue(bank_db, allowPaused=True)
    assert manual['taskId'] == automatic['taskId']
    row = await bank_db.get(QbSyncJob, manual['taskId'], populate_existing=True)
    assert await plans.automatic_task_reason(bank_db, row) is None
    assert (await dispatch.claim_next(bank_db))['taskId'] == manual['taskId']
    assert (await bank_db.get(QbSyncPlan, plan['planId'])).enabled == 0


@pytest.mark.asyncio
async def test_paused_automatic_queue_does_not_starve_later_manual_book(bank_db, monkeypatch):
    from plugins.bank.controller.sync_plan_controller import PlanInput
    from plugins.bank.service import sync_plans as plans

    plan = await plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True))
    now = datetime(2026, 10, 10, 0, 0, 0)
    for book_id in range(3, 15):
        bank_db.add(QbTextbook(textbook_id=book_id, subject_id=1, version_id=1,
            source_provider='zujuan', external_textbook_id=f'tb{book_id}',
            textbook_name=f'教材{book_id}', status='0', create_time=now, update_time=now))
    await bank_db.commit()
    for book_id in range(3, 15):
        await SyncTaskService.create_question(bank_db, {'versionId': 1, 'textbookId': book_id},
            'automatic', automatic_options={'autoPlanId': plan['planId'], 'autoCycleNo': 1})
    await plans.save_plan(bank_db,PlanInput(subjectId=1,enabled=False,expectedRevision=plan['revision']))
    manual = await enqueue(bank_db, allowPaused=True)
    clock = [now]
    async def current(_db):
        return clock[0]
    monkeypatch.setattr(dispatch, '_clock', current)
    claim = None
    for _ in range(30):
        claim = await dispatch.claim_next(bank_db)
        if claim:
            break
        clock[0] += timedelta(seconds=3)
    assert claim and claim['taskId'] == manual['taskId'], 'paused queue starved manual work for 90 seconds'


@pytest.mark.asyncio
@pytest.mark.parametrize('gate', ['disabled', 'book_pause', 'incomplete_config'])
async def test_dispatch_checks_actual_manual_candidate_after_skipping_auto(bank_db, monkeypatch, gate):
    from plugins.bank.controller.sync_plan_controller import BookOverride, PlanInput
    from plugins.bank.service import sync_plans as plans

    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '0' if gate == 'disabled' else '1')
    plan = await plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True))
    auto = await SyncTaskService.create_question(bank_db, {'versionId': 1, 'textbookId': 1},
        'automatic', automatic_options={'autoPlanId': plan['planId'], 'autoCycleNo': 1})
    if gate == 'book_pause':
        await plans.save_book_override(bank_db, plan['planId'], 1, BookOverride(enabled=False, expectedRevision=0))
    manual = await enqueue(bank_db, 2)
    executed = []
    class Healthy:
        def health(self):
            return {'ok': True}
    async def execute(task_id, handle):
        executed.append(task_id)
    monkeypatch.setattr(runs, '_execute', execute)
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    await bank_db.rollback()
    try:
        assert await dispatch.dispatch_once(session_factory=factory, client=Healthy()) == 1
        await asyncio.sleep(0)
        assert executed == [manual['taskId']]
        row = await bank_db.get(QbSyncJob, auto['taskId'], populate_existing=True)
        if gate == 'book_pause':
            assert row.status == 'cancelled' and row.options_json['planSkipped'] and row.dispatch_book_key is None
        else:
            assert row.status == 'queued'
        assert row.active_slot is None
    finally:
        runs._WORKERS.pop(manual['taskId'], None)


@pytest.mark.asyncio
async def test_manual_promotion_keeps_source_delay_and_emergency_pause(bank_db, monkeypatch):
    from plugins.bank.controller.sync_plan_controller import PlanInput
    from plugins.bank.entity.do.bank_do import QbSyncControl
    from plugins.bank.service import sync_plans as plans

    plan = await plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True))
    auto = await SyncTaskService.create_question(bank_db, {'versionId': 1, 'textbookId': 1},
        'automatic', automatic_options={'autoPlanId': plan['planId'], 'autoCycleNo': 1})
    row = await bank_db.get(QbSyncJob, auto['taskId'])
    delay = await dispatch._clock(bank_db) + timedelta(minutes=5)
    row.dispatch_not_before, row.dispatch_error = delay, '来源冷却'
    await bank_db.commit()
    await enqueue(bank_db, allowPaused=True)
    assert row.dispatch_not_before == delay and row.dispatch_error == '来源冷却'
    assert await dispatch.claim_next(bank_db) is None
    row.dispatch_not_before = None
    bank_db.add(QbSyncControl(control_id=1, paused=1, reason='人工紧急暂停',
        revision=1, update_time=await dispatch._clock(bank_db)))
    await bank_db.commit()
    assert await dispatch.claim_next(bank_db) is None
    assert row.active_slot is None


def test_expired_queue_reason_is_not_presented_as_current():
    from types import SimpleNamespace
    row=SimpleNamespace(dispatch_job_id='job',dispatch_book_key='book',active_slot=None,status='queued',
        dispatch_not_before=datetime(2000,1,1),dispatch_error='来源当日教材启动预算已用完')
    assert dispatch.queue_fields(row)['queueReason'] is None
    row.dispatch_not_before=datetime(2099,1,1)
    assert dispatch.queue_fields(row)['queueReason']=='来源当日教材启动预算已用完'


@pytest.mark.asyncio
async def test_host_shortage_backs_off_collection_dispatch_and_clears_on_claim(bank_db, monkeypatch):
    from plugins.bank.service import resource_guard

    first = await enqueue(bank_db)
    state = {'paused': True, 'reason': '后端主机可用内存低于保留水位，等待内存恢复'}
    monkeypatch.setattr(resource_guard, 'resource_status', lambda **_: dict(state))
    delays = []
    for _ in range(3):
        assert await dispatch.claim_next(bank_db) is None
        row = await bank_db.get(QbSyncJob, first['taskId'], populate_existing=True)
        delays.append((row.dispatch_not_before - datetime.utcnow()).total_seconds())
        row.dispatch_not_before = None
        await bank_db.commit()
    assert delays[0] < delays[1] < delays[2] <= 600
    assert '内存' in row.dispatch_error
    state['paused'] = False
    claim = await dispatch.claim_next(bank_db)
    row = await bank_db.get(QbSyncJob, first['taskId'], populate_existing=True)
    assert claim['taskId'] == first['taskId'] and 'resourceWaitStreak' not in row.options_json
