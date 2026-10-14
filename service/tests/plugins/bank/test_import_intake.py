"""Automatic terminal-run intake: real commits, bounded retries and takeover."""

import asyncio
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import event, func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from config.database import DataSourceRegistry
from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbQuestionImport,
    QbQuestionImportBatch,
    QbQuestionImportIntake,
    QbSubject,
    QbSyncJob,
    QbSyncJobScope,
    QbTextbook,
)
from plugins.bank.service import import_intake
from plugins.bank.service import import_intake_worker as intake_worker
from plugins.bank.service import incremental_import_worker as worker
from plugins.bank.service import sync_run_service as runs
from plugins.bank.service.import_intake import (
    claim_import_intake,
    complete_import_intake,
    due_import_intake_ids,
    ensure_import_intake_finished,
    fail_import_intake,
    register_import_intake,
    retry_import_intake,
    unregistered_terminal_scope_ids,
)
from plugins.bank.service.incremental_import import request_incremental_import
from plugins.bank.service.question_apply_service import _normalise_snapshot_summary
from plugins.bank.service.task_service import SyncTaskService
from tests.plugins.bank.test_incremental_import import import_db as import_db
from tests.plugins.bank.test_incremental_import_worker import _client
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db


def normalized(summary):
    return _normalise_snapshot_summary(summary, 28, 'tb1', sealed_for_import=True)


async def stale_progress(db):
    scope = await db.get(QbSyncJobScope, 30)
    scope.question_count = 0
    scope.snapshot_locked_at = None
    await db.commit()


@pytest.mark.asyncio
@pytest.mark.parametrize('complete', [False, True])
async def test_terminal_run_without_manual_request_automatically_imports(import_db, monkeypatch, tmp_path, complete):
    db = import_db
    client, summary, calls = _client(monkeypatch)
    summary['snapshotComplete'] = summary['run']['snapshotComplete'] = complete
    if complete:
        summary['run'].update(status='completed', errorCount=0)
    await stale_progress(db)
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    # Recovery alone closes the crash window; no POST /import is involved.
    await intake_worker.dispatch_import_intakes_once(session_factory=factory, client=client)
    assert calls and all(route.endswith('/snapshot-summary') for route, _ in calls)
    scope = await db.get(QbSyncJobScope, 30, populate_existing=True)
    task = await db.get(QbSyncJob, 28, populate_existing=True)
    assert (scope.catalog_count, scope.question_count, scope.question_catalog_count) == (2, 3, 3)
    assert (task.catalog_count, task.question_count, task.question_catalog_count) == (2, 3, 3)
    assert bool(scope.snapshot_complete) is complete and scope.snapshot_locked_at is not None
    assert scope.question_tag_count == task.question_tag_count == 0
    assert scope.question_asset_count == task.question_asset_count == 0
    intake = await db.scalar(select(QbQuestionImportIntake))
    assert intake.status == 'ready' and intake.import_id
    await db.rollback()
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    detail = await SyncTaskService.question_detail(db, 28)
    state = detail['incrementalImport']
    assert (state['status'], state['processedCount'], state['acceptedCount'], state['quarantinedCount']) == (
        'partial', 3, 2, 1,
    )
    assert state['snapshotComplete'] is complete and detail['importIntake']['status'] == 'ready'
    assert 'workerToken' not in detail['importIntake'] and 'bindingHash' not in detail['importIntake']
    await db.rollback()
    count = len(calls)
    await intake_worker.dispatch_import_intakes_once(session_factory=factory, client=client)
    await worker.dispatch_incremental_imports_once(session_factory=factory, client=client, root=tmp_path)
    assert len(calls) == count
    assert await db.scalar(select(func.count()).select_from(QbQuestionImport)) == 1
    assert await db.scalar(select(func.count()).select_from(QbQuestionImportBatch)) == 1


@pytest.mark.asyncio
async def test_finish_registers_before_any_remote_fetch(import_db, monkeypatch):
    db = import_db
    task = await db.get(QbSyncJob, 28)
    scope = await db.get(QbSyncJobScope, 30)
    task.status = scope.status = 'running'
    task.log_tail = '保留的采集日志'
    await db.commit()
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    monkeypatch.setattr(DataSourceRegistry, 'session', factory)
    client, _summary, calls = _client(monkeypatch)
    monkeypatch.setattr(runs, 'CollectorClient', lambda: client)
    await runs._finish(28, runs._WorkerHandle(token='local', task_module='question', workflow_version=2),
                       'failed', 'failed', '采集页错误')
    intake = await db.scalar(select(QbQuestionImportIntake))
    assert intake is not None and intake.status == 'pending' and calls == []
    assert (await db.get(QbSyncJob, 28, populate_existing=True)).log_tail == '保留的采集日志'


@pytest.mark.asyncio
async def test_transport_retry_budget_is_durable_and_manual_retry_extends_it(import_db, monkeypatch):
    # Quick budget only here; the slow retries after it have their own test.
    monkeypatch.setattr(import_intake, 'INTAKE_SLOW_RETRY_DELAYS', ())
    db = import_db
    client, _summary, _calls = _client(monkeypatch)

    def unavailable(*_args, **_kwargs):
        raise ServiceException(message='collector API 无法连接')

    monkeypatch.setattr(client, 'run_snapshot_summary', unavailable)
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    for attempt in (1, 2, 3):
        await intake_worker.dispatch_import_intakes_once(session_factory=factory, client=client)
        row = await db.scalar(select(QbQuestionImportIntake).execution_options(populate_existing=True))
        assert row.attempt_count == attempt and row.error_kind == 'collector'
        assert row.status == ('retry' if attempt < 3 else 'blocked')
        if attempt < 3:
            assert row.next_attempt_at is not None
            assert await due_import_intake_ids(db) == []
            row.next_attempt_at = datetime(2000, 1, 1)
        await db.commit()
    await intake_worker.dispatch_import_intakes_once(session_factory=factory, client=client)
    assert (await db.get(QbQuestionImportIntake, row.intake_id, populate_existing=True)).attempt_count == 3
    await db.rollback()
    retry = await retry_import_intake(db, 28)
    assert (retry['status'], retry['attemptCount'], retry['attemptLimit']) == ('pending', 3, 6)
    assert await db.scalar(select(func.count()).select_from(QbQuestionImport)) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize('damage', ['run', 'book', 'namespace', 'seal'])
async def test_bad_identity_blocks_without_modifying_counts_or_formal_data(import_db, monkeypatch, damage):
    db = import_db
    client, summary, _calls = _client(monkeypatch)
    if damage == 'run':
        summary['run']['id'] = 99
    elif damage == 'book':
        summary['run']['scope']['textbookId'] = 'tb2'
    elif damage == 'namespace':
        summary['run']['scope']['sourceNamespace'] = 'zujuan:junior:physics'
    else:
        summary['run']['snapshotLockedAt'] = '2026-10-01T01:00:02Z'
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    await intake_worker.dispatch_import_intakes_once(session_factory=factory, client=client)
    row = await db.scalar(select(QbQuestionImportIntake))
    assert row.status == 'blocked' and row.attempt_count == 1 and row.next_attempt_at is None
    assert await db.scalar(select(func.count()).select_from(QbQuestionImport)) == 0
    assert (await db.get(QbSyncJobScope, 30, populate_existing=True)).catalog_count == 0


@pytest.mark.asyncio
async def test_queue_failure_rolls_back_counts_seal_and_ready_state(import_db, monkeypatch):
    db = import_db
    _client_obj, summary, _calls = _client(monkeypatch)
    await stale_progress(db)
    registered = await register_import_intake(db, 30)
    ticket = await claim_import_intake(db, registered['intakeId'])

    def reject(_conn, _cursor, statement, _parameters, _context, _many):
        if statement.startswith('INSERT INTO qb_question_import ('):
            raise RuntimeError('injected import queue write failure')

    event.listen(db.bind.sync_engine, 'before_cursor_execute', reject)
    try:
        with pytest.raises(RuntimeError, match='queue write failure'):
            await complete_import_intake(db, ticket, normalized(summary))
    finally:
        event.remove(db.bind.sync_engine, 'before_cursor_execute', reject)
    scope = await db.get(QbSyncJobScope, 30, populate_existing=True)
    assert scope.question_count == 0 and scope.snapshot_locked_at is None
    assert (await db.get(QbQuestionImportIntake, ticket['intakeId'], populate_existing=True)).status == 'probing'
    await db.rollback()
    result = await complete_import_intake(db, ticket, normalized(summary))
    assert result['questionCount'] == 3 and result['status'] == 'queued'


@pytest.mark.asyncio
async def test_sparse_summary_header_uses_the_validated_canonical_seal(import_db, monkeypatch):
    db = import_db
    _client_obj, summary, _calls = _client(monkeypatch)
    summary['snapshotLockedAt'] = summary['run'].pop('snapshotLockedAt')
    registered = await register_import_intake(db, 30)
    ticket = await claim_import_intake(db, registered['intakeId'])
    state = await complete_import_intake(db, ticket, normalized(summary))
    assert state['status'] == 'queued' and state['questionCount'] == 3


@pytest.mark.asyncio
async def test_expired_owner_and_changed_binding_cannot_commit(import_db, monkeypatch):
    db = import_db
    _client_obj, summary, _calls = _client(monkeypatch)
    registered = await register_import_intake(db, 30)
    assert (await register_import_intake(db, 30))['intakeId'] == registered['intakeId']
    old = await claim_import_intake(db, registered['intakeId'])
    assert await claim_import_intake(db, registered['intakeId']) is None
    row = await db.get(QbQuestionImportIntake, registered['intakeId'])
    row.lease_until -= timedelta(minutes=5)
    await db.commit()
    current = await claim_import_intake(db, registered['intakeId'])
    assert current['workerToken'] != old['workerToken']
    with pytest.raises(ServiceException, match='执行权'):
        await complete_import_intake(db, old, normalized(summary))
    with pytest.raises(ServiceException, match='执行权'):
        await fail_import_intake(db, old, 'collector', 'old owner', retryable=True)
    scope = await db.get(QbSyncJobScope, 30)
    scope.collector_run_id = 29
    await db.commit()
    with pytest.raises(ServiceException, match='绑定'):
        await complete_import_intake(db, current, normalized(summary))
    assert await db.scalar(select(func.count()).select_from(QbQuestionImport)) == 0


@pytest.mark.asyncio
async def test_resume_and_delete_wait_for_intake_even_before_registration(import_db):
    db = import_db
    with pytest.raises(ServiceException, match='登记'):
        await ensure_import_intake_finished(db, 28)
    await db.rollback()
    registered = await register_import_intake(db, 30)
    with pytest.raises(ServiceException, match='封存核验'):
        await SyncTaskService.delete_question(db, 28)
    await db.rollback()
    with pytest.raises(ServiceException, match='封存核验'):
        await ensure_import_intake_finished(db, 28)
    await db.rollback()
    ticket = await claim_import_intake(db, registered['intakeId'])
    await fail_import_intake(db, ticket, 'snapshot', '人工判断', retryable=False)
    from plugins.bank.entity.do.bank_do import QbSyncIssue
    issue = await db.scalar(select(QbSyncIssue).where(QbSyncIssue.error_type == 'intake_failure'))
    assert issue.status == 'open' and issue.textbook_id == 1 and issue.latest_task_id == 28
    # A non-retryable snapshot failure with no protection evidence is maintenance, not a teacher check.
    assert issue.evidence_json['handling'] == 'maintenance' and issue.evidence_json['owner'] == 'maintenance'
    assert issue.evidence_json['stage'] == 'intake'
    await db.rollback()
    with pytest.raises(ServiceException, match='人工判断'):
        await ensure_import_intake_finished(db, 28, automatic=True)
    await db.rollback()
    await ensure_import_intake_finished(db, 28, automatic=False)


@pytest.mark.asyncio
async def test_recovery_skips_old_multibook_manual_imports_and_paused_source(import_db):
    db = import_db
    assert await unregistered_terminal_scope_ids(db) == [30]
    task = await db.get(QbSyncJob, 28)
    task.options_json = {'workflowVersion': 1}
    await db.commit()
    assert await unregistered_terminal_scope_ids(db) == []
    task.options_json = {'workflowVersion': 2}
    await db.commit()
    db.add(QbSyncJobScope(scope_id=31, run_id=28, subject_id=1, local_textbook_id=2,
                         source_provider='zujuan', external_textbook_id='tb2', collector_run_id=28,
                         status='failed', create_time=task.create_time, update_time=task.update_time))
    await db.commit()
    assert await unregistered_terminal_scope_ids(db) == []
    await db.delete(await db.get(QbSyncJobScope, 31))
    await db.commit()
    await register_import_intake(db, 30)
    source = await db.get(QbSubject, 1)
    source.status = '1'
    await db.commit()
    assert await due_import_intake_ids(db) == []
    source.status = '0'
    await db.commit()
    assert len(await due_import_intake_ids(db)) == 1
    await db.rollback()
    manual = await request_incremental_import(db, 28)
    assert manual['status'] == 'queued'
    assert await unregistered_terminal_scope_ids(db) == []


@pytest.mark.asyncio
async def test_disabled_book_records_issue_without_discarding_retriable_identity(import_db):
    db = import_db
    registered = await register_import_intake(db, 30)
    book = await db.get(QbTextbook, 1)
    book.status = '1'
    await db.commit()
    assert await claim_import_intake(db, registered['intakeId']) is None
    row = await db.get(QbQuestionImportIntake, registered['intakeId'], populate_existing=True)
    assert row.status == 'blocked' and row.error_kind == 'book_binding'


@pytest.mark.asyncio
async def test_one_book_waiting_for_import_does_not_starve_other_due_resumes(import_db, monkeypatch):
    db = import_db
    task = await db.get(QbSyncJob, 28)
    options = {'workflowVersion': 2, 'autoResumePending': True, 'autoResumeNextAt': '2000-01-01T00:00:00'}
    task.status = 'interrupted'
    task.options_json = options
    db.add(QbSyncJob(run_id=29, subject_id=1, task_module='question', run_type='content',
                     status='interrupted', phase='interrupted', options_json=options,
                     create_time=task.create_time, update_time=task.update_time))
    await db.commit()
    await register_import_intake(db, 30)
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    monkeypatch.setattr(DataSourceRegistry, 'session', factory)
    tried = []

    async def resume(session, task_id, operator=None):
        tried.append(task_id)
        if task_id == 28:
            await ensure_import_intake_finished(session, task_id, automatic=True)

    monkeypatch.setattr(runs.SyncRunService, 'resume_question', resume)
    assert await runs.SyncRunService.resume_pending_question_tasks() == 1
    assert tried == [28, 29]


@pytest.mark.asyncio
async def test_mysql_competing_registrations_and_claims_have_one_owner(import_db):
    db = import_db
    if db.bind.dialect.name != 'mysql':
        pytest.skip('requires isolated MySQL row locks')
    factory = async_sessionmaker(db.bind, expire_on_commit=False)

    async def register():
        async with factory() as session:
            return await register_import_intake(session, 30)

    rows = await asyncio.gather(register(), register())
    assert rows[0]['intakeId'] == rows[1]['intakeId']

    async def claim():
        async with factory() as session:
            return await claim_import_intake(session, rows[0]['intakeId'])

    claims = await asyncio.gather(claim(), claim())
    assert sum(ticket is not None for ticket in claims) == 1
    migration = Path(__file__).resolve().parents[3] / 'plugins/bank/migrations/mysql/017_import_intake.sql'
    for _ in range(2):
        await db.execute(text(migration.read_text()))
        await db.commit()
    assert await db.scalar(select(func.count()).select_from(QbQuestionImportIntake)) == 1


@pytest.mark.asyncio
async def test_intake_success_does_not_resolve_another_sealed_run(import_db, monkeypatch):
    from plugins.bank.entity.do.bank_do import QbSyncIssue
    from plugins.bank.service.sync_issues import observe
    db=import_db
    _,summary,_=_client(monkeypatch)
    registered=await register_import_intake(db,30)
    ticket=await claim_import_intake(db,registered['intakeId'])
    await observe(db,subject_id=1,provider='zujuan',book_id=1,task_id=28,kind='scope',key='tb1:intake',
        error_type='intake_failure',reason='另一个封存身份冲突',evidence={'scopeId':31,'collectorRunId':99},now=datetime.utcnow())
    await db.commit()
    await complete_import_intake(db,ticket,normalized(summary))
    issue=await db.scalar(select(QbSyncIssue).where(QbSyncIssue.error_type=='intake_failure'))
    assert issue.status=='open' and issue.evidence_json['collectorRunId']==99
