from datetime import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from exceptions.exception import ServiceException
from plugins.bank.controller.sync_plan_controller import BookOverride, PlanInput
from plugins.bank.entity.do.bank_do import QbSyncBookState, QbSyncIssue, QbSyncJob, QbSyncPlan
from plugins.bank.service import sync_plans as plans
from plugins.bank.service.sync_issues import list_issues, observe, record_import_batch, update_issue
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db


@pytest.mark.asyncio
async def test_plan_defaults_paused_and_book_exclusion_survives_next_cycle(bank_db):
    result = await plans.save_plan(bank_db, PlanInput(subjectId=1))
    assert result['enabled'] is False
    assert result['cycleTargetCount'] == 0
    override = BookOverride(expectedRevision=0, enabled=False, exceptionKind='inaccessible', operatorNote='人工确认')
    await plans.save_book_override(bank_db, result['planId'], 2, override)
    books = await plans.list_books(bank_db, result['planId'])
    book = next(b for b in books if b['textbookId'] == 2)
    assert book['exceptionKind'] == 'inaccessible' and book['enabled'] is False
    assert book['versionName'] == '版本'
    with pytest.raises(ServiceException, match='已变化'):
        await plans.save_book_override(bank_db, result['planId'], 2, override)


@pytest.mark.asyncio
async def test_cycle_targets_fixed_and_partial_refill_does_not_starve_other_book(bank_db, monkeypatch):
    result = await plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True))
    monkeypatch.setattr(plans, '_discovery', _noop)
    await plans.tick_plan(bank_db, result['planId'], client=None)
    plan = await bank_db.get(QbSyncPlan, result['planId'])
    assert set(plan.cycle_targets) == {1, 2}
    job = await bank_db.scalar(select(QbSyncJob).where(QbSyncJob.task_module == 'question'))
    assert job.active_slot is None and job.options_json['autoPlanId'] == result['planId']
    first_id = job.run_id
    job.status = job.phase = 'failed'
    job.dispatch_book_key = None
    plan.next_check_at = None
    plan.lease_until = None
    await bank_db.commit()
    await plans.tick_plan(bank_db, result['planId'], client=None)
    state = await bank_db.scalar(select(QbSyncBookState).where(QbSyncBookState.last_task_id == first_id))
    assert state.last_cycle_no == 1 and state.next_due_at is None
    jobs = list((await bank_db.scalars(select(QbSyncJob).order_by(QbSyncJob.run_id))).all())
    assert len(jobs) == 2 and jobs[-1].options_json['textbookIds'] != jobs[0].options_json['textbookIds']


async def _noop(*args, **kwargs):
    pass


@pytest.mark.asyncio
async def test_issues_dedupe_keep_middle_task_after_archive_and_close_only_same_question(bank_db):
    timestamp = datetime.utcnow()
    for task in (10, 11, 12):
        await observe(
            bank_db,
            subject_id=1,
            provider='zujuan',
            book_id=1,
            task_id=task,
            kind='question',
            key='bad',
            error_type='question_quality',
            reason='题干缺失',
            evidence={'task': task},
            now=timestamp,
        )
        await bank_db.commit()
    issue = await bank_db.scalar(select(QbSyncIssue))
    assert issue.attempts == 3 and issue.first_task_id == 10 and issue.latest_task_id == 12
    assert (await list_issues(bank_db, task_id=11))['total'] == 1
    await update_issue(bank_db, issue.issue_id, issue.revision, 'ignored', '等待下一轮')
    incoming = SimpleNamespace(
        subject_id=1,
        source_provider='zujuan',
        local_textbook_id=1,
        task_id=13,
        import_id=4,
        batch_no=0,
        collector_run_id=99,
    )
    await record_import_batch(bank_db, incoming, [], ['other'], timestamp)
    await bank_db.commit()
    assert issue.status == 'ignored'
    await record_import_batch(bank_db, incoming, [], ['bad'], timestamp)
    await bank_db.commit()
    assert issue.status == 'resolved' and issue.resolved_task_id == 13
    assert (await list_issues(bank_db, task_id=11))['rows'][0]['status'] == 'resolved'


def test_unattended_gate_allows_unlimited_budget_and_requires_host_settings(monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    assert '资源水位' in plans.unattended_reason({})
    for name in ('BANK_MIN_DISK_FREE_MIB', 'BANK_MIN_MEMORY_FREE_MIB', 'BANK_SYNC_MAX_PENDING_IMPORTS'):
        monkeypatch.setenv(name, '1')
    health = {'sourceBudget': {'allDailyLimitsConfigured': False}, 'resources': {'diskAndMemoryLimitsConfigured': True}}
    monkeypatch.setattr(plans, 'resource_status', lambda: {'reason': None})
    assert plans.unattended_reason(health) is None
    health['sourceControl'] = {'paused': True, 'reason': '验证码'}
    assert plans.unattended_reason(health) == '验证码'


@pytest.mark.asyncio
async def test_plan_queues_other_books_while_manual_task_is_unsettled(bank_db, monkeypatch):
    from plugins.bank.service.task_service import SyncTaskService

    manual = await SyncTaskService.create_question(bank_db, {'versionId': 1, 'textbookId': 1}, 'teacher')
    manual_id = manual.get('taskId') or manual['runId']
    result = await plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True))
    monkeypatch.setattr(plans, '_discovery', _noop)
    await plans.tick_plan(bank_db, result['planId'], client=None)
    jobs = list((await bank_db.scalars(select(QbSyncJob).order_by(QbSyncJob.run_id))).all())
    assert len(jobs) == 2
    assert jobs[0].run_id == manual_id and 'autoPlanId' not in jobs[0].options_json
    assert jobs[1].options_json['textbookIds'] == [2]
    plan = await bank_db.get(QbSyncPlan, result['planId'])
    assert plan.cycle_targets == [1, 2]
    # Queued automatic work is also skipped; repeated ticks add no duplicate.
    plan.next_check_at = None
    await bank_db.commit()
    await plans.tick_plan(bank_db, plan.plan_id, client=None)
    assert len(list((await bank_db.scalars(select(QbSyncJob))).all())) == 2


@pytest.mark.asyncio
async def test_scope_repair_requires_matching_complete_scan_and_keeps_question_issues(bank_db):
    from plugins.bank.entity.do.bank_do import QbQuestionImport
    from plugins.bank.service.sync_issues import resolve_scope_issues

    # Issue timestamps use second precision in MySQL; test exact filter boundaries.
    timestamp = datetime.utcnow().replace(microsecond=0)
    for book, kind, key, error in [
        (1, 'scope', 'tb1', 'scope_failure'),
        (2, 'scope', 'tb2', 'scope_failure'),
        (1, 'question', 'q1', 'question_quality'),
    ]:
        await observe(
            bank_db,
            subject_id=1,
            provider='zujuan',
            book_id=book,
            task_id=90,
            kind=kind,
            key=key,
            error_type=error,
            reason='坏数据',
            evidence={},
            now=timestamp,
        )
    incoming = QbQuestionImport(
        task_id=91,
        scope_id=1,
        subject_id=1,
        source_provider='zujuan',
        local_textbook_id=1,
        external_textbook_id='tb1',
        collector_run_id=92,
        snapshot_locked_at=timestamp,
        snapshot_complete=0,
        identity_hash='b' * 64,
        question_count=0,
        stats_json={},
        status='partial',
        create_time=timestamp,
        update_time=timestamp,
        run_coverage_json={
            'scan': {
                'targetsKnown': True,
                'selectedCatalogCount': 2,
                'scanCompletedCatalogCount': 1,
                'unscannedCatalogCount': 1,
                'catalogSelectionTruncated': False,
                'failedPageCount': 0,
                'duplicatePageCount': 0,
                'parseErrorCount': 0,
            }
        },
    )
    bank_db.add(incoming)
    await bank_db.commit()
    job = SimpleNamespace(run_id=91, subject_id=1, options_json={})
    scope = SimpleNamespace(
        collector_run_id=92, source_provider='zujuan', local_textbook_id=1, external_textbook_id='tb1'
    )
    await resolve_scope_issues(bank_db, job, scope, timestamp)
    assert all(r.status == 'open' for r in (await bank_db.scalars(select(QbSyncIssue))).all())
    scan = dict(incoming.run_coverage_json['scan'], scanCompletedCatalogCount=2, unscannedCatalogCount=0)
    incoming.run_coverage_json = {'scan': scan}
    await bank_db.commit()
    await resolve_scope_issues(bank_db, job, scope, timestamp)
    await bank_db.commit()
    rows = (await bank_db.scalars(select(QbSyncIssue))).all()
    assert [(r.textbook_id, r.object_kind) for r in rows if r.status == 'resolved'] == [(1, 'scope')]
    assert (await list_issues(bank_db, task_id=90))['total'] == 3
    assert (await list_issues(bank_db, task_id=91))['total'] == 1
    filtered = await list_issues(bank_db, textbook_id=1, error_type='scope_failure', since=timestamp)
    assert filtered['total'] == 1 and not filtered['rows'][0]['latestTaskAvailable']
    assert (await list_issues(bank_db, until=timestamp))['total'] == 0


@pytest.mark.asyncio
async def test_new_cycle_rescans_book_instead_of_inheriting_old_page_cursor(bank_db, monkeypatch):
    from plugins.bank.entity.do.bank_do import QbSyncJobScope
    from plugins.bank.service.task_service import SyncTaskService

    old = await SyncTaskService.create_question(bank_db, {'versionId': 1, 'textbookId': 1}, 'teacher')
    row = await bank_db.get(QbSyncJob, old['taskId'])
    row.status = row.phase = 'completed'
    row.dispatch_book_key = None
    scope = await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == row.run_id))
    scope.catalog_count = scope.question_count = scope.question_catalog_count = 1
    scope.collector_run_id = 55
    scope.snapshot_locked_at = datetime.utcnow()
    scope.snapshot_complete = 0
    await bank_db.commit()
    plan = await plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True))
    await plans.save_book_override(bank_db, plan['planId'], 2, BookOverride(expectedRevision=0, enabled=False))
    monkeypatch.setattr(plans, '_discovery', _noop)
    await plans.tick_plan(bank_db, plan['planId'], client=None)
    latest = await bank_db.scalar(select(QbSyncJob).order_by(QbSyncJob.run_id.desc()))
    next_scope = await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == latest.run_id))
    assert latest.run_id != old['taskId'] and latest.retry_of_run_id is None
    assert next_scope.resume_from_collector_run_id is None


@pytest.mark.asyncio
@pytest.mark.parametrize('import_state,accepted,expected_days', [('failed',0,7), ('partial',0,7), ('partial',2,7), ('completed',3,7)])
async def test_cycle_cadence_uses_import_and_usable_outcome(bank_db, monkeypatch, import_state, accepted, expected_days):
    from plugins.bank.entity.do.bank_do import QbSyncJobScope
    from plugins.bank.service.incremental_import import _new_import

    result = await plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True))
    monkeypatch.setattr(plans, '_discovery', _noop)
    await plans.tick_plan(bank_db, result['planId'], client=None)
    job = await bank_db.scalar(select(QbSyncJob).where(QbSyncJob.task_module == 'question'))
    scope = await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == job.run_id))
    timestamp = datetime.utcnow().replace(microsecond=0)
    job.status = job.phase = 'completed'
    job.snapshot_complete = 1
    job.question_count = 3
    job.dispatch_book_key = None
    scope.status = 'completed'
    scope.collector_run_id = 99
    scope.question_count = 3
    scope.snapshot_complete = 1
    scope.snapshot_locked_at = timestamp
    incoming = _new_import(scope, timestamp)
    incoming.status, incoming.accepted_count = import_state, accepted
    incoming.cursor = 3 if import_state != 'failed' else 0
    bank_db.add(incoming)
    plan = await bank_db.get(QbSyncPlan, result['planId'])
    plan.next_check_at = None
    await bank_db.commit()
    # Formal usable counts are separate from collected/accepted counts.
    original = plans.list_books
    async def books(*args):
        rows = await original(*args)
        for row in rows:
            row['usableQuestionCount'] = 3 if import_state == 'completed' else 0
        return rows
    monkeypatch.setattr(plans, 'list_books', books)
    plan_id, job_id = plan.plan_id, job.run_id
    for other in (await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.task_module=='question',QbSyncJob.run_id!=job_id))).all():
        other.status=other.phase='failed';other.dispatch_book_key=None;other.active_slot=None
    await bank_db.commit()
    await plans.tick_plan(bank_db, plan_id, client=None)
    await bank_db.refresh(job)
    state = await bank_db.scalar(select(QbSyncBookState).where(QbSyncBookState.last_task_id == job_id))
    assert expected_days*86400-3 <= (state.next_due_at-timestamp).total_seconds() <= expected_days*86400+3
    assert job.options_json['planOutcome']['importStatus'] == import_state
    if import_state == 'failed':
        await bank_db.rollback()
        assert await plans.retry_saved_book_results(bank_db, 1, timestamp)
        await bank_db.refresh(incoming)
        assert incoming.status == 'queued' and incoming.cursor == 0
        assert len((await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.options_json['textbookIds'][0].as_integer() == 1))).all()) == 1


@pytest.mark.asyncio
async def test_manual_saved_import_retry_preserves_whole_round_deadline(bank_db, monkeypatch):

    from plugins.bank.entity.do.bank_do import QbQuestionImport, QbSyncJobScope
    from plugins.bank.service.incremental_import import _new_import
    result = await plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True))
    await plans.save_book_override(bank_db,result['planId'],2,BookOverride(expectedRevision=0,enabled=False))
    monkeypatch.setattr(plans,'_discovery',_noop)
    await plans.tick_plan(bank_db,result['planId'],client=None)
    job=await bank_db.scalar(select(QbSyncJob).where(QbSyncJob.task_module=='question'))
    scope=await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id==job.run_id))
    now=datetime.utcnow()
    job.status=job.phase=scope.status='completed'
    job.snapshot_complete=1;job.question_count=3
    job.dispatch_book_key=None
    scope.collector_run_id=77;scope.snapshot_locked_at=now;scope.question_count=3;scope.snapshot_complete=1
    incoming=_new_import(scope,now);incoming.status='failed';incoming.cursor=1
    bank_db.add(incoming)
    plan=await bank_db.get(QbSyncPlan,result['planId']);plan.next_check_at=None
    await bank_db.commit()
    await plans.tick_plan(bank_db,result['planId'],client=None)
    state=await bank_db.scalar(select(QbSyncBookState).where(QbSyncBookState.textbook_id==1))
    deadline=(await bank_db.get(QbSyncPlan,result['planId'])).next_cycle_at
    assert await plans.retry_saved_book_results(bank_db,1,now)
    plan=await bank_db.get(QbSyncPlan,result['planId']);plan.next_check_at=None
    await bank_db.commit()
    await plans.tick_plan(bank_db,result['planId'],client=None)
    incoming=await bank_db.scalar(select(QbQuestionImport))
    assert incoming.status=='queued' and incoming.cursor==1
    jobs=list((await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.task_module=='question'))).all())
    assert len(jobs)==1 and jobs[0].options_json['planImportRetryCount']==1
    incoming.status='completed';incoming.cursor=incoming.accepted_count=3
    plan=await bank_db.get(QbSyncPlan,result['planId']);plan.next_check_at=None
    await bank_db.commit()
    original=plans.list_books
    async def populated(*args):
        rows=await original(*args)
        for row in rows: row['usableQuestionCount']=3
        return rows
    monkeypatch.setattr(plans,'list_books',populated)
    await plans.tick_plan(bank_db,result['planId'],client=None)
    state=await bank_db.scalar(select(QbSyncBookState).where(QbSyncBookState.textbook_id==1))
    job=await bank_db.scalar(select(QbSyncJob).where(QbSyncJob.task_module=='question'))
    assert (await bank_db.get(QbSyncPlan,result['planId'])).next_cycle_at==deadline
    assert (await bank_db.get(QbSyncPlan,result['planId'])).cycle_no==1
    assert 7*86400-5 <= (state.next_due_at-now).total_seconds() <= 7*86400+5


@pytest.mark.asyncio
async def test_overview_skips_deferred_queue_and_uses_enabled_scope(bank_db):
    import json
    from datetime import timedelta

    from plugins.bank.controller.sync_overview_controller import overview
    from plugins.bank.service.incremental_import import _clock
    from plugins.bank.service.task_service import SyncTaskService
    first=await SyncTaskService.create_question(bank_db,{'versionId':1,'textbookId':1},'teacher')
    second=await SyncTaskService.create_question(bank_db,{'versionId':1,'textbookId':2},'teacher')
    job=await bank_db.get(QbSyncJob,first['taskId'])
    job.dispatch_not_before=await _clock(bank_db)+timedelta(minutes=30)
    await bank_db.commit()
    payload=json.loads((await overview(bank_db,subject_id=1)).body)['data']
    assert payload['nextTask']['taskId']==second['taskId']
    assert payload['deferredTask']['taskId']==first['taskId'] and payload['deferredTask']['notBefore']
    assert payload['cycleTargetCount']==0 and payload['storage']['uniqueAssetCount']==0


@pytest.mark.asyncio
@pytest.mark.parametrize('registered', [True,False])
async def test_plan_discovery_waits_for_shared_worker_then_records_result(bank_db, registered):
    from datetime import timedelta
    result=await plans.save_plan(bank_db,PlanInput(subjectId=1,enabled=True))
    plan=await bank_db.get(QbSyncPlan,result['planId'])
    now=datetime.utcnow()
    task=QbSyncJob(subject_id=1,task_module='textbook',run_type='metadata',status='completed',phase='completed',
        options_json={'discoveryMode':'merge'},acknowledge_source_policy='Y',create_time=now,update_time=now)
    bank_db.add(task);await bank_db.flush()
    task_id=task.run_id
    plan.discovery_task_id=task_id;plan.discovery_next_at=now+timedelta(days=7)
    await bank_db.commit()
    await plans._discovery(bank_db,result['planId'],None)
    assert plan.discovery_task_id==task_id  # No Collector call or second merge path.
    task.options_json={'discoveryMode':'merge','discoveryAttempts':3,
        'discoveryResult':{'action':'discovery_merge'} if registered else None,
        'discoveryError':None if registered else '封存不完整'}
    await bank_db.commit()
    await plans._discovery(bank_db,result['planId'],None)
    assert plan.discovery_task_id is None and plan.discovery_processed_task_id==task_id
    assert plan.discovery_error==(None if registered else '封存不完整')


def test_budget_input_validates_and_serializes_collector_contract():
    from pydantic import ValidationError

    from plugins.bank.controller.sync_plan_controller import BudgetInput

    payload = dict(expectedRevision=0, requests=0, books=0, activeSeconds=3600, downloadMiB=1024)
    assert BudgetInput(**payload).model_dump(by_alias=True) == payload
    for key, value in [('books', -1), ('requests', True), ('activeSeconds', 0.5), ('downloadMiB', 8589934592)]:
        with pytest.raises(ValidationError):
            BudgetInput(**{**payload, key: value})
