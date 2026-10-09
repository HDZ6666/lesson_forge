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
    assert state.last_cycle_no == 1 and state.next_due_at > datetime.utcnow()
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


def test_unattended_gate_requires_real_budget_and_host_settings(monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    assert '预算' in plans.unattended_reason({})
    for name in ('BANK_MIN_DISK_FREE_MIB', 'BANK_MIN_MEMORY_FREE_MIB', 'BANK_SYNC_MAX_PENDING_IMPORTS'):
        monkeypatch.setenv(name, '1')
    health = {'sourceBudget': {'allDailyLimitsConfigured': True}, 'resources': {'diskAndMemoryLimitsConfigured': True}}
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
    job = SimpleNamespace(run_id=91, subject_id=1)
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
async def test_automatic_plan_refills_latest_sealed_partial_book(bank_db, monkeypatch):
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
    assert latest.run_id != old['taskId'] and latest.retry_of_run_id == old['taskId']
    assert next_scope.resume_from_collector_run_id == 55
