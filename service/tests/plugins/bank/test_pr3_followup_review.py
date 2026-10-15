from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from plugins.bank.controller.sync_plan_controller import BookOverride, PlanInput, SingleBook
from plugins.bank.entity.do.bank_do import QbSyncBookState, QbSyncJob, QbSyncPlan, QbSyncSupplement
from plugins.bank.service import manual_recovery, plan_control, sync_plans
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_subject_sync_workflow import tick
from tests.plugins.bank.test_sync_flow_acceptance import finish_book, setup


def now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


@pytest.mark.asyncio
@pytest.mark.parametrize('disabled', [True, False])
async def test_excluding_waiting_book_does_not_hold_round_forever(bank_db, monkeypatch, disabled):
    pid, jobs = await setup(bank_db, monkeypatch)
    task_id = jobs[0].run_id
    state = await bank_db.scalar(
        select(QbSyncBookState).where(QbSyncBookState.plan_id == pid, QbSyncBookState.textbook_id == 1)
    )
    with bank_db.no_autoflush:
        await sync_plans.save_book_override(
            bank_db,
            pid,
            1,
            BookOverride(
                expectedRevision=state.revision,
                enabled=not disabled,
                exceptionKind=None if disabled else 'inaccessible',
            ),
        )
    await finish_book(bank_db, jobs[1])
    for _ in range(3):
        await tick(bank_db, pid)
    job = await bank_db.get(QbSyncJob, task_id, populate_existing=True)
    reason = await sync_plans.automatic_task_reason(bank_db, job)
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.cycle_state == 'completed', (plan.cycle_state, job.status, reason)
    assert job.status == 'cancelled' and job.options_json['planSkipped']


@pytest.mark.asyncio
async def test_orphan_supplement_relinks_committed_execution_before_wake(bank_db, monkeypatch):
    pid, jobs = await setup(bank_db, monkeypatch)
    for job in jobs:
        await finish_book(bank_db, job)
    await tick(bank_db, pid)
    plan = await bank_db.get(QbSyncPlan, pid)
    result = await plan_control.sync_book_once(bank_db, pid, 1, SingleBook(expectedRevision=plan.revision), 'teacher')
    supplement = await bank_db.scalar(select(QbSyncSupplement))
    # Durable state if the process stops after create/retry commits its job,
    # before sync_book_once commits supplement.task_id.
    supplement.task_id = None
    supplement.started_at = now() - timedelta(minutes=11)
    state = await bank_db.scalar(
        select(QbSyncBookState).where(QbSyncBookState.plan_id == pid, QbSyncBookState.textbook_id == 1)
    )
    state.last_task_id = jobs[0].run_id
    state.last_manual_task_id = None
    await bank_db.commit()
    is_open = await sync_plans.settle_supplements(bank_db, pid, now())
    job = await bank_db.get(QbSyncJob, result['taskId'])
    assert state.last_task_id == state.last_manual_task_id == job.run_id
    assert is_open and supplement.status == 'running' and supplement.task_id == job.run_id, (
        is_open,
        supplement.status,
        job.status,
        job.options_json['supplementId'],
    )


@pytest.mark.asyncio
async def test_metadata_verify_before_scheduler_observed_failure_retries_promptly(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    result = await sync_plans.save_plan(bank_db, PlanInput(subjectId=1, planName='数学', enabled=True))
    pid = result['planId']
    await tick(bank_db, pid)
    plan = await bank_db.get(QbSyncPlan, pid)
    task = await bank_db.get(QbSyncJob, plan.discovery_task_id)
    task_id = task.run_id
    task.status = task.phase = 'blocked'
    task.active_slot = None
    task.error_message = '站点返回验证/防护页面，任务已熔断'
    await bank_db.commit()

    async def remote(*args, **kwargs):
        return {'ok': True}

    monkeypatch.setattr(manual_recovery, 'call', remote)
    await manual_recovery.finish_browser(
        bank_db, 'session', {'owner': '1', 'taskId': task_id, 'kind': 'discovery'}, 'teacher'
    )
    await tick(bank_db, pid)
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.discovery_task_id and plan.discovery_task_id != task_id, (
        plan.discovery_task_id,
        plan.discovery_error,
        plan.discovery_next_at,
    )


@pytest.mark.asyncio
async def test_history_current_count_follows_existing_issue_across_executions(bank_db, monkeypatch):
    from plugins.bank.entity.do.bank_do import QbSyncIssue
    from plugins.bank.service.sync_issues import observe

    pid, jobs = await setup(bank_db, monkeypatch)
    await observe(
        bank_db,
        subject_id=1,
        provider='zujuan',
        book_id=1,
        task_id=jobs[0].run_id,
        kind='question',
        key='q-1',
        error_type='missing_stem',
        reason='缺少题干',
        evidence={},
        now=now(),
    )
    for job in jobs:
        await finish_book(bank_db, job)
    await tick(bank_db, pid)
    before = await sync_plans.session_log(bank_db, pid, 1)
    assert before['rounds'][0]['openIssueCount'] == 1
    plan = await bank_db.get(QbSyncPlan, pid)
    result = await plan_control.sync_book_once(bank_db, pid, 1, SingleBook(expectedRevision=plan.revision), 'teacher')
    await observe(
        bank_db,
        subject_id=1,
        provider='zujuan',
        book_id=1,
        task_id=result['taskId'],
        kind='question',
        key='q-1',
        error_type='missing_stem',
        reason='缺少题干',
        evidence={},
        now=now(),
    )
    await bank_db.commit()
    after = await sync_plans.session_log(bank_db, pid, 1)
    issue = await bank_db.scalar(select(QbSyncIssue))
    assert after['rounds'][0]['openIssueCountNow'] == 1, (
        issue.status,
        after['rounds'][0]['openIssueCount'],
        after['rounds'][0]['openIssueCountNow'],
    )


@pytest.mark.asyncio
async def test_committed_supplement_is_returned_after_response_failure(bank_db, monkeypatch):
    from plugins.bank.service.task_service import SyncTaskService

    pid, jobs = await setup(bank_db, monkeypatch)
    for job in jobs:
        await finish_book(bank_db, job)
    await tick(bank_db, pid)
    original = SyncTaskService.retry_question

    async def interrupted(*args, **kwargs):
        await original(*args, **kwargs)
        raise RuntimeError('execution committed; response interrupted')

    monkeypatch.setattr(SyncTaskService, 'retry_question', interrupted)
    plan = await bank_db.get(QbSyncPlan, pid)
    result = await plan_control.sync_book_once(bank_db, pid, 1, SingleBook(expectedRevision=plan.revision), 'teacher')
    supplement = await bank_db.scalar(select(QbSyncSupplement))
    assert supplement.status == 'running' and supplement.task_id == result['taskId']
    assert (await bank_db.get(QbSyncJob, result['taskId'])).status == 'queued'
    assert await sync_plans.settle_supplements(bank_db, pid, now())


@pytest.mark.asyncio
async def test_exclusion_keeps_claimed_and_explicit_manual_executions(bank_db, monkeypatch):
    from plugins.bank.service import sync_dispatch

    pid, jobs = await setup(bank_db, monkeypatch)
    claim = await sync_dispatch.claim_next(bank_db)
    assert claim['taskId'] == jobs[0].run_id
    jobs[1].options_json = {**jobs[1].options_json, 'manualDispatchRequested': True}
    await bank_db.commit()
    for book_id in (1, 2):
        state = await bank_db.scalar(
            select(QbSyncBookState).where(QbSyncBookState.plan_id == pid, QbSyncBookState.textbook_id == book_id)
        )
        await sync_plans.save_book_override(
            bank_db, pid, book_id, BookOverride(expectedRevision=state.revision, enabled=False)
        )
    assert jobs[0].active_slot is not None and jobs[0].status != 'cancelled'
    assert jobs[1].status == 'queued' and jobs[1].dispatch_book_key


@pytest.mark.asyncio
async def test_existing_excluded_queue_is_reconciled_on_tick(bank_db, monkeypatch):
    pid, jobs = await setup(bank_db, monkeypatch)
    state = await bank_db.scalar(
        select(QbSyncBookState).where(QbSyncBookState.plan_id == pid, QbSyncBookState.textbook_id == 1)
    )
    state.enabled = 0
    await bank_db.commit()
    await finish_book(bank_db, jobs[1])
    await tick(bank_db, pid)
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.cycle_state == 'completed'
    assert jobs[0].status == 'cancelled' and jobs[0].options_json['planSkipped']


@pytest.mark.asyncio
async def test_finishing_old_discovery_does_not_replace_a_newer_one(bank_db, monkeypatch):
    pid, _jobs = await setup(bank_db, monkeypatch)
    plan = await bank_db.get(QbSyncPlan, pid)
    old_id = plan.discovery_processed_task_id
    plan.discovery_task_id = old_id + 1000
    retry_at = now() + timedelta(hours=2)
    plan.discovery_next_at = retry_at
    await bank_db.commit()

    async def remote(*args, **kwargs):
        return {'ok': True}

    monkeypatch.setattr(manual_recovery, 'call', remote)
    await manual_recovery.finish_browser(bank_db, 's', {'owner': '1', 'taskId': old_id, 'kind': 'discovery'}, 'teacher')
    assert plan.discovery_task_id == old_id + 1000 and plan.discovery_next_at == retry_at


@pytest.mark.asyncio
async def test_legacy_history_without_frozen_count_is_unknown_not_zero(bank_db, monkeypatch):
    from plugins.bank.entity.do.bank_do import QbSyncCycle

    pid, jobs = await setup(bank_db, monkeypatch)
    for job in jobs:
        await finish_book(bank_db, job)
    await tick(bank_db, pid)
    cycle = await bank_db.scalar(select(QbSyncCycle).where(QbSyncCycle.plan_id == pid))
    cycle.summary_json = {
        key: value for key, value in cycle.summary_json.items() if key not in ('openIssueCountAtEnd', 'openIssuesAtEnd')
    }
    await bank_db.commit()
    result = await sync_plans.session_log(bank_db, pid, 1)
    assert result['rounds'][0]['openIssueCount'] is None
    assert result['rounds'][0]['openIssueCountNow'] == 0
