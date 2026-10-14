"""Queue view, one-off pin, explicit full mode, resource wait and latest-result reclaim."""
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from exceptions.exception import ServiceException
from plugins.bank.controller.sync_plan_controller import PlanAction, SingleBook
from plugins.bank.entity.do.bank_do import QbSyncControl, QbSyncJob, QbSyncPlan
from plugins.bank.service import plan_control, sync_dispatch, sync_plans
from plugins.bank.service.resource_guard import ResourcePressure
from plugins.bank.service.resource_wait import ResourceWait
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_subject_sync_workflow import registered_plan, tick


@pytest.mark.asyncio
async def test_queue_shows_actual_order_and_pin_is_one_off(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    plan_id, _ = await registered_plan(bank_db)
    queue = await plan_control.plan_queue(bank_db, plan_id)
    assert queue['current'] is None and [i['textbookId'] for i in queue['queue']] == [1, 2]
    first = await sync_dispatch.claim_next(bank_db)
    plan = await bank_db.get(QbSyncPlan, plan_id)
    order_before = list(plan.textbook_order)
    await plan_control.pin_book(bank_db, plan_id, 2, plan.revision)
    queue = await plan_control.plan_queue(bank_db, plan_id)
    # The running book is not interrupted; the pinned one is next.
    assert queue['current']['taskId'] == first['taskId'] and queue['next']['textbookId'] == 2
    assert queue['next']['pinned'] is True
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    assert plan.textbook_order == order_before, 'a pin never rewrites the saved plan order'
    with pytest.raises(ServiceException, match='没有待执行任务'):
        await plan_control.pin_book(bank_db, plan_id, 1, plan.revision)


@pytest.mark.asyncio
async def test_explicit_full_start_applies_to_first_round_only(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    plan_id, _ = await registered_plan(bank_db)
    jobs = (await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.task_module == 'question'))).all()
    assert all(j.options_json['syncMode'] == 'incremental' for j in jobs)
    plan = await bank_db.get(QbSyncPlan, plan_id)
    await plan_control.action(bank_db, plan_id, PlanAction(action='end', expectedRevision=plan.revision), 'teacher')
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    await bank_db.rollback()
    await plan_control.reconcile_controls(factory)
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    assert plan.session_end_reason == 'user_end'
    await plan_control.action(bank_db, plan_id, PlanAction(action='start', expectedRevision=plan.revision, full=True), 'teacher')
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    assert plan.session_no == 2 and plan.session_mode == 'full' and plan.session_end_reason is None
    assert sync_plans.plan_dump(plan)['sessionMode'] == 'full'


@pytest.mark.asyncio
async def test_single_book_full_rerun_and_supplement_between_sessions(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    plan_id, _ = await registered_plan(bank_db)
    for job in (await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.task_module == 'question'))).all():
        job.status = job.phase = 'failed'; job.dispatch_book_key = None; job.active_slot = None
    await bank_db.commit()
    await tick(bank_db, plan_id)
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    assert plan.cycle_state == 'completed'
    deadline = plan.next_cycle_at
    result = await plan_control.sync_book_once(bank_db, plan_id, 1, SingleBook(expectedRevision=plan.revision, full=True), 'teacher')
    job = await bank_db.get(QbSyncJob, result['taskId'])
    assert job.options_json['syncMode'] == 'full' and job.options_json['supplementRun'] is True
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    assert plan.next_cycle_at == deadline and plan.cycle_state == 'completed'


@pytest.mark.asyncio
async def test_resource_wait_is_one_persisted_wait_with_backoff_and_stable_recovery(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_RESOURCE_WAIT_MIN_SECONDS', '3')
    monkeypatch.setenv('BANK_RESOURCE_WAIT_MAX_SECONDS', '20')
    monkeypatch.setenv('BANK_RESOURCE_RECOVERY_STABLE_SECONDS', '30')
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    clock = {'now': 0.0}
    short = {'value': True}
    checks = []

    def check():
        checks.append(clock['now'])
        if short['value']:
            raise ResourcePressure(message='后端主机可用内存低于保留水位，等待内存恢复')

    gate = ResourceWait()
    allow = lambda: gate.allow(factory, check=check, clock=lambda: clock['now'])  # noqa: E731
    assert await allow() is False
    control = await bank_db.get(QbSyncControl, 1, populate_existing=True)
    assert control.resource_wait_json['active'] and '内存' in control.resource_wait_json['reason']
    since = control.resource_wait_json['since']
    for step in range(1, 60):
        clock['now'] = float(step)
        assert await allow() is False
    # Backoff: far fewer real checks than polls.
    assert len(checks) < 10
    short['value'] = False
    clock['now'] = 100.0
    assert await allow() is False, 'one good sample is not a lasting recovery'
    clock['now'] = 140.0
    assert await allow() is True
    control = await bank_db.get(QbSyncControl, 1, populate_existing=True)
    assert control.resource_wait_json['active'] is False and control.resource_wait_json['since'] == since
