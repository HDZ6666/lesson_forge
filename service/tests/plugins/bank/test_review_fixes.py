"""Call-chain checks for the 2026-10-14 review items beyond the reproduction cases."""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from plugins.bank.controller.sync_plan_controller import PlanAction, SingleBook
from plugins.bank.entity.do.bank_do import (
    QbSyncBookState,
    QbSyncCycle,
    QbSyncIssue,
    QbSyncJob,
    QbSyncJobScope,
    QbSyncPlan,
    QbSyncSupplement,
)
from plugins.bank.service import plan_control, sync_dispatch, sync_plans, sync_run_service
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_subject_sync_workflow import tick
from tests.plugins.bank.test_sync_flow_acceptance import finish_book, setup


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


@pytest.mark.asyncio
async def test_discovery_scopes_never_replace_question_execution_links(bank_db, monkeypatch):
    pid, jobs = await setup(bank_db, monkeypatch)
    plan = await bank_db.get(QbSyncPlan, pid)
    discovery = await bank_db.get(QbSyncJob, plan.discovery_processed_task_id)
    bank_db.add(QbSyncJobScope(run_id=discovery.run_id, subject_id=1, local_version_id=1,
        local_textbook_id=2, source_provider='zujuan', external_version_id='v1',
        external_textbook_id='tb2', status='completed', create_time=_now(), update_time=_now()))
    state = await bank_db.scalar(select(QbSyncBookState).where(
        QbSyncBookState.plan_id == pid, QbSyncBookState.textbook_id == 2))
    state_id, expected_id = state.state_id, jobs[1].run_id
    state.last_task_id = discovery.run_id  # Exact production corruption.
    await bank_db.commit()
    books = await sync_plans.list_books(bank_db, pid, display=True)
    assert next(b for b in books if b['textbookId'] == 2)['lastTaskId'] is None
    await tick(bank_db, pid)
    await tick(bank_db, pid)
    state = await bank_db.get(QbSyncBookState, state_id, populate_existing=True)
    assert state.last_task_id == expected_id
    books = await sync_plans.list_books(bank_db, pid, display=True)
    assert all(b['latestExecutionId'] == b['lastTaskId'] and b['executionCount'] == 0 for b in books)
    queue = await plan_control.plan_queue(bank_db, pid)
    assert len(queue['queue']) == 2
    assert all(row['versionName'] == '版本' and row['externalTextbookId'] in ('tb1', 'tb2') for row in queue['queue'])


@pytest.mark.asyncio
async def test_discovery_only_link_is_repaired_and_missing_book_is_queued(bank_db, monkeypatch):
    from sqlalchemy import delete

    from plugins.bank.entity.do.bank_do import QbQuestionTaskReview
    pid, jobs = await setup(bank_db, monkeypatch)
    plan = await bank_db.get(QbSyncPlan, pid)
    discovery = await bank_db.get(QbSyncJob, plan.discovery_processed_task_id)
    bank_db.add(QbSyncJobScope(run_id=discovery.run_id, subject_id=1, local_version_id=1,
        local_textbook_id=2, source_provider='zujuan', external_version_id='v1',
        external_textbook_id='tb2', status='completed', create_time=_now(), update_time=_now()))
    await bank_db.execute(delete(QbSyncJobScope).where(QbSyncJobScope.run_id == jobs[1].run_id))
    await bank_db.execute(delete(QbQuestionTaskReview).where(QbQuestionTaskReview.task_id == jobs[1].run_id))
    await bank_db.execute(delete(QbSyncJob).where(QbSyncJob.run_id == jobs[1].run_id))
    state = await bank_db.scalar(select(QbSyncBookState).where(
        QbSyncBookState.plan_id == pid, QbSyncBookState.textbook_id == 2))
    state_id, discovery_id = state.state_id, discovery.run_id
    state.last_task_id = discovery_id
    # An unreleased discovery key must not make its textbook scopes "busy".
    discovery.dispatch_book_key = 'discovery-only'
    await bank_db.commit()
    await tick(bank_db, pid)
    state = await bank_db.get(QbSyncBookState, state_id, populate_existing=True)
    linked = await bank_db.get(QbSyncJob, state.last_task_id)
    assert linked.task_module == 'question' and linked.status == 'queued'
    assert linked.run_id != discovery_id


@pytest.mark.asyncio
async def test_source_resume_is_a_new_linked_execution_in_the_same_round(bank_db, monkeypatch):
    """R01: a new ID, same session and round, counted only once it starts."""
    pid, jobs = await setup(bank_db, monkeypatch)
    await finish_book(bank_db, jobs[0], status='blocked', complete=False, error='题目列表返回验证/防护')
    await finish_book(bank_db, jobs[1])
    old_id = jobs[0].run_id
    cycle_no = jobs[0].options_json['autoCycleNo']

    async def summary(*args, **kwargs):
        return {'counts': {'catalogItemCount': 1, 'questionItemCount': 3, 'questionCatalogCount': 3},
                'run': {'snapshotLockedAt': _now().isoformat()}}
    monkeypatch.setattr(sync_run_service, '_resume_partial_summary', summary)

    class Verified:
        def health(self):
            return {'ok': True, 'sourceControl': {'paused': False}}
    plan = await bank_db.get(QbSyncPlan, pid)
    plan.next_check_at = None
    await bank_db.commit()
    await sync_plans.tick_plan(bank_db, pid, client=Verified())
    resumed = (await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.run_id > jobs[1].run_id,
                                                             QbSyncJob.task_module == 'question'))).all()
    assert len(resumed) == 1
    new = resumed[0]
    assert new.run_id != old_id and new.status == 'queued' and new.started_at is None
    assert new.options_json['autoCycleNo'] == cycle_no and new.options_json['planSourceResumeOf'] == old_id
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.cycle_state == 'running', 'the queued resume keeps the round open'
    from plugins.bank.service import task_executions
    payload = [{'logicalTaskId': new.logical_task_id or new.run_id}]
    await task_executions.attach_summary(bank_db, payload)
    assert payload[0]['executionCount'] == 1 and payload[0]['executionRecordCount'] == 2, 'queued linked execution is not counted until it starts'
    old = await bank_db.get(QbSyncJob, old_id, populate_existing=True)
    old_scope = await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == old_id))
    assert (old.status, old.started_at is not None, old_scope.collector_run_id) == ('blocked', True, 1000 + old_id)


@pytest.mark.asyncio
async def test_source_block_before_any_saved_page_retries_as_linked_execution(bank_db, monkeypatch):
    """R01: nothing saved to continue, so a linked retry, never an in-place rewrite or a stuck round."""
    pid, jobs = await setup(bank_db, monkeypatch)
    old_id = jobs[0].run_id
    await finish_book(bank_db, jobs[0], status='blocked', complete=False, error='题目列表返回验证/防护')
    scope = await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == old_id))
    scope.snapshot_locked_at = None
    jobs[0].options_json = {**jobs[0].options_json, 'planSourceResumePending': True}
    await finish_book(bank_db, jobs[1])

    class Verified:
        def health(self):
            return {'ok': True, 'sourceControl': {'paused': False}}
    plan = await bank_db.get(QbSyncPlan, pid)
    plan.next_check_at = None
    await bank_db.commit()
    await sync_plans.tick_plan(bank_db, pid, client=Verified())
    rows = (await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.task_module == 'question')
                                  .execution_options(populate_existing=True))).all()
    linked = [r for r in rows if (r.options_json or {}).get('planSourceResumeOf') == old_id]
    assert len(linked) == 1 and linked[0].status == 'queued'
    assert (linked[0].logical_task_id or linked[0].run_id) == (rows[0].logical_task_id or old_id)
    old = await bank_db.get(QbSyncJob, old_id, populate_existing=True)
    assert old.status == 'blocked' and not old.options_json.get('planSourceResumePending')


@pytest.mark.asyncio
async def test_manual_rerun_settles_the_round_exactly_once_after_it_finishes(bank_db, monkeypatch):
    """R02: open while queued and importing; settled once afterwards."""
    pid, jobs = await setup(bank_db, monkeypatch)
    second_id = jobs[1].run_id
    await finish_book(bank_db, jobs[0])
    await tick(bank_db, pid)
    second = await bank_db.get(QbSyncJob, second_id, populate_existing=True)
    await finish_book(bank_db, second)
    plan = await bank_db.get(QbSyncPlan, pid)
    result = await plan_control.sync_book_once(bank_db, pid, 1, SingleBook(expectedRevision=plan.revision), 'teacher')
    rerun = await bank_db.get(QbSyncJob, result['taskId'])
    await tick(bank_db, pid)
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.cycle_state == 'running', 'manual execution still queued'
    rerun = await bank_db.get(QbSyncJob, result['taskId'], populate_existing=True)
    await finish_book(bank_db, rerun, import_status='running')
    await tick(bank_db, pid)
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.cycle_state == 'running', 'import of the manual execution still running'
    from plugins.bank.entity.do.bank_do import QbQuestionImport
    imported = await bank_db.scalar(select(QbQuestionImport).where(QbQuestionImport.task_id == result['taskId']))
    imported.status = 'completed'
    await bank_db.commit()
    events = []
    from plugins.bank.service import diagnostics
    monkeypatch.setattr(diagnostics, 'event', lambda name, **fields: events.append(name))
    await tick(bank_db, pid)
    await tick(bank_db, pid)
    assert events.count('sync_round_settled') == 1


@pytest.mark.asyncio
async def test_existing_orphan_supplement_is_closed_and_wake_up_proceeds(bank_db, monkeypatch):
    """R03: an old running supplement with no execution no longer blocks the subject."""
    pid, jobs = await setup(bank_db, monkeypatch)
    for job in jobs:
        await finish_book(bank_db, job)
    await tick(bank_db, pid)
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.cycle_state == 'completed'
    bank_db.add(QbSyncSupplement(plan_id=pid, textbook_id=1, status='running', sync_mode='incremental',
                                 started_at=_now() - timedelta(hours=1)))
    plan.next_cycle_at = _now() - timedelta(seconds=1)
    session = plan.session_no
    await bank_db.commit()
    await tick(bank_db, pid)
    orphan = await bank_db.scalar(select(QbSyncSupplement))
    assert orphan.status == 'failed' and orphan.finished_at is not None
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.session_no == session + 1


@pytest.mark.asyncio
async def test_discovery_browser_finish_reruns_discovery_without_unpausing_plan(bank_db, monkeypatch):
    """R07: finishing a discovery check lets discovery run again; a user pause stays."""
    from plugins.bank.service import manual_recovery
    pid, _jobs = await setup(bank_db, monkeypatch)
    plan = await bank_db.get(QbSyncPlan, pid)
    metadata_id = plan.discovery_processed_task_id
    plan.discovery_next_at = _now() + timedelta(hours=6)
    plan.enabled = 0
    plan.control_state = 'paused'
    await bank_db.commit()
    calls = []

    async def remote(action, payload):
        calls.append((action, payload.get('kind')))
        return {'ok': True}
    monkeypatch.setattr(manual_recovery, 'call', remote)
    result = await manual_recovery.finish_browser(
        bank_db, 's1', {'owner': '1', 'taskId': metadata_id, 'kind': 'discovery'}, 'teacher')
    assert result['taskId'] == metadata_id
    assert [c[0] for c in calls] == ['validate', 'finish']
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.discovery_next_at <= _now() and plan.control_state == 'paused' and not plan.enabled


@pytest.mark.asyncio
async def test_still_short_after_restart_continues_the_same_wait(bank_db):
    """R09: a restarted worker that still sees shortage keeps the original wait."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from plugins.bank.entity.do.bank_do import QbSyncControl
    from plugins.bank.service.resource_guard import ResourcePressure
    from plugins.bank.service.resource_wait import ResourceWait
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)

    def shortage():
        raise ResourcePressure(message='内存不足')
    assert not await ResourceWait().allow(factory, check=shortage, clock=lambda: 1.0)
    since = (await bank_db.get(QbSyncControl, 1, populate_existing=True)).resource_wait_json['since']
    restarted = ResourceWait()
    assert not await restarted.allow(factory, check=shortage, clock=lambda: 5.0)
    state = (await bank_db.get(QbSyncControl, 1, populate_existing=True)).resource_wait_json
    assert state['active'] and state['since'] == since and state['checks'] >= 2


@pytest.mark.asyncio
async def test_real_dispatch_resource_wait_backs_off_and_records_recovery(bank_db, monkeypatch):
    """R10: dispatch_once uses the growing backoff and logs entry and recovery once."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from plugins.bank.service import diagnostics, resource_guard
    pid, jobs = await setup(bank_db, monkeypatch)
    events = []
    monkeypatch.setattr(diagnostics, 'event', lambda name, **fields: events.append(name))
    shortage = lambda: {'paused': True, 'reason': '后端主机可用内存低于保留水位', 'availableMemoryMiB': 20}  # noqa: E731
    monkeypatch.setattr(sync_dispatch, 'resource_status', shortage)
    monkeypatch.setattr(resource_guard, 'resource_status', shortage)
    await bank_db.rollback()
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    delays = []
    for _ in range(3):
        assert await sync_dispatch.dispatch_once(session_factory=factory) == 0
        async with factory() as db:
            row = (await db.scalars(select(QbSyncJob).where(QbSyncJob.task_module == 'question',
                QbSyncJob.dispatch_not_before.is_not(None)).order_by(QbSyncJob.dispatch_not_before.desc()))).first()
            now = await sync_dispatch._clock(db)
            delays.append((row.dispatch_not_before - now).total_seconds())
            row.dispatch_not_before = now - timedelta(seconds=1)
            await db.commit()
    assert delays[0] < delays[1] < delays[2], delays
    assert events.count('collection_resource_wait_entered') == 1
    job = await bank_db.scalar(select(QbSyncJob).where(QbSyncJob.task_module == 'question',
        QbSyncJob.options_json['resourceWaitStreak'].as_integer() > 0))
    sync_dispatch.collection_resource_recovered(job)
    assert 'collection_resource_wait_recovered' in events and 'resourceWaitStreak' not in job.options_json


@pytest.mark.asyncio
async def test_user_end_freezes_the_open_problem_snapshot(bank_db, monkeypatch):
    """R11: ending a round by hand freezes its open problems too."""
    pid, jobs = await setup(bank_db, monkeypatch)
    reservation = jobs[0].dispatch_book_key
    await finish_book(bank_db, jobs[0], status='failed', complete=False, error='目录 ID 重复：4712')
    jobs[0].dispatch_book_key = reservation
    await bank_db.commit()
    await sync_dispatch.release_finished_books(bank_db)
    from sqlalchemy.ext.asyncio import async_sessionmaker
    plan = await bank_db.get(QbSyncPlan, pid)
    await plan_control.action(bank_db, pid, PlanAction(action='end', expectedRevision=plan.revision), 'teacher')
    await plan_control.reconcile_controls(async_sessionmaker(bank_db.bind, expire_on_commit=False))
    cycle = await bank_db.scalar(select(QbSyncCycle).where(QbSyncCycle.plan_id == pid)
                                 .execution_options(populate_existing=True))
    assert cycle.status == 'stopped', cycle.status
    frozen = cycle.summary_json['openIssueCountAtEnd']
    assert frozen >= 1 and cycle.summary_json['openIssuesAtEnd'][0]['errorType']
    for issue in (await bank_db.scalars(select(QbSyncIssue))).all():
        issue.status = 'resolved'
    await bank_db.commit()
    log = await sync_plans.session_log(bank_db, pid, cycle.session_no or 1) if hasattr(cycle, 'session_no') \
        else await sync_plans.session_log(bank_db, pid, 1)
    assert log['rounds'][0]['openIssueCount'] == frozen and log['rounds'][0]['openIssueCountNow'] == 0


@pytest.mark.asyncio
async def test_discovery_failure_kind_matches_scheduler_branch(bank_db, monkeypatch):
    """R13: the page is told which of the three discovery failures applies."""
    pid, _jobs = await setup(bank_db, monkeypatch)
    plan = await bank_db.get(QbSyncPlan, pid)
    plan.discovery_error = '教材列表接口超时'
    assert sync_plans.discovery_failure(plan) == 'stale_list'
    plan.discovery_error = '站点返回验证/防护页面，任务已熔断'
    assert sync_plans.discovery_failure(plan) == 'source_protection'
    plan.discovery_error = '教材列表接口超时'
    plan.textbook_order = []
    assert sync_plans.discovery_failure(plan) == 'no_list'
    plan.discovery_error = None
    assert sync_plans.discovery_failure(plan) is None
    await bank_db.rollback()
    _ = QbSyncJobScope
