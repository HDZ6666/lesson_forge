"""Whole-plan orchestration against real ORM rows, without source requests."""
from datetime import datetime, timedelta
from urllib.error import HTTPError

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from exceptions.exception import ServiceException
from plugins.bank.controller.sync_plan_controller import PlanInput
from plugins.bank.dao.sync_task_dao import SyncTaskDao
from plugins.bank.entity.do.bank_do import QbSyncJob, QbSyncJobScope, QbSyncPlan
from plugins.bank.entity.vo.bank_vo import SyncTaskPageQueryModel
from plugins.bank.service import sync_dispatch as dispatch
from plugins.bank.service import sync_plans as plans
from plugins.bank.service import sync_run_service as runs
from plugins.bank.service.task_service import SyncTaskService, task_payload
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db


async def tick(db, plan_id):
    plan = await db.get(QbSyncPlan, plan_id)
    plan.next_check_at = None
    await db.commit()
    await plans.tick_plan(db, plan_id, client=None)


async def registered_plan(db):
    result = await plans.save_plan(db, PlanInput(subjectId=1, planName='数学全教材', enabled=True, listConcurrency=1))
    plan_id = result['planId']
    await tick(db, plan_id)
    plan = await db.get(QbSyncPlan, plan_id)
    discovery = await db.get(QbSyncJob, plan.discovery_task_id)
    discovery.status = discovery.phase = 'completed'
    discovery.options_json = {**discovery.options_json, 'discoveryResult': {'action': 'discovery_merge'}}
    discovery.active_slot = None
    await db.commit()
    await dispatch.release_finished_books(db)
    await tick(db, plan_id)
    return plan_id, discovery.run_id


@pytest.mark.asyncio
async def test_discovery_must_register_before_full_queue_and_names_are_snapshots(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    result = await plans.save_plan(bank_db, PlanInput(subjectId=1, planName='数学全教材', enabled=True, listConcurrency=1))
    plan_id = result['planId']
    await tick(bank_db, plan_id)
    jobs = list((await bank_db.scalars(select(QbSyncJob))).all())
    assert len(jobs) == 1 and jobs[0].task_module == 'textbook'
    discovery = jobs[0]
    assert discovery.status == 'queued' and discovery.active_slot is None and discovery.dispatch_job_id
    name = discovery.options_json['autoCycleName']
    assert name.startswith('数学全教材 · ') and name.endswith('第 1 轮')
    discovery.status = discovery.phase = 'completed'
    await bank_db.commit()
    await tick(bank_db, plan_id)
    assert len(list((await bank_db.scalars(select(QbSyncJob))).all())) == 1
    discovery.options_json = {**discovery.options_json, 'discoveryResult': {'action': 'discovery_merge'}}
    await bank_db.commit()
    await dispatch.release_finished_books(bank_db)
    await tick(bank_db, plan_id)
    jobs = list((await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.task_module == 'question'))).all())
    assert len(jobs) == 2  # All books exist in the visible queue before the first starts.
    assert all(j.status == 'queued' and j.active_slot is None for j in jobs)
    assert all(task_payload(j)['autoCycleName'] == name for j in jobs)
    plan = await bank_db.get(QbSyncPlan, plan_id)
    assert plan.cycle_name == name
    await plans.save_plan(bank_db, PlanInput(subjectId=1, planName='改名后的计划', enabled=True, expectedRevision=plan.revision))
    await tick(bank_db, plan_id)
    assert len(list((await bank_db.scalars(select(QbSyncJob))).all())) == 3
    assert all(j.options_json['autoCycleName'] == name for j in jobs)
    page = await SyncTaskDao.list_page(bank_db, 'question', SyncTaskPageQueryModel(planId=plan_id, cycleNo=1, cycleName='数学全教材'))
    assert page.total == 2
    assert (await SyncTaskDao.list_page(bank_db, 'question', SyncTaskPageQueryModel(cycleName='不存在'))).total == 0
    first = await dispatch.claim_next(bank_db)
    assert first['taskModule'] == 'question'
    assert await dispatch.claim_next(bank_db) is None


@pytest.mark.asyncio
async def test_failed_book_does_not_fail_other_queued_books_and_next_round_is_fresh(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    plan_id, _ = await registered_plan(bank_db)
    claim = await dispatch.claim_next(bank_db)
    first = await bank_db.get(QbSyncJob, claim['taskId'])
    first.status = first.phase = 'failed'
    first.error_message = '当前教材解析失败'
    first.active_slot = None
    await bank_db.commit()
    await dispatch.release_finished_books(bank_db)
    second = await dispatch.claim_next(bank_db)
    assert second['taskId'] != first.run_id
    row = await bank_db.get(QbSyncJob, second['taskId'])
    row.status = row.phase = 'failed'; row.active_slot = None
    await bank_db.commit()
    await dispatch.release_finished_books(bank_db)
    await tick(bank_db, plan_id)
    books = await plans.list_books(bank_db, plan_id)
    assert all(b['taskStage'] == 'failed' and b['taskInCurrentCycle'] for b in books)
    plan=await bank_db.get(QbSyncPlan,plan_id)
    plan.next_cycle_at=datetime.utcnow()-timedelta(seconds=1)
    await bank_db.commit()
    monkeypatch.setattr(plans,'_discovery',_ready)
    await tick(bank_db, plan_id)
    next_jobs = list((await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.options_json['autoCycleNo'].as_integer() == 2))).all())
    assert len(next_jobs) == 2
    # A wake-up after sleep is the 2nd sync session; its rounds restart at 1.
    assert all('第 2 次同步' in j.options_json['autoCycleName'] and j.options_json['autoCycleName'].endswith('第 1 轮')
               for j in next_jobs)
    assert all(j.retry_of_run_id is None for j in next_jobs)
    scopes = list((await bank_db.scalars(select(QbSyncJobScope).where(QbSyncJobScope.run_id.in_([j.run_id for j in next_jobs])))).all())
    assert all(s.resume_from_collector_run_id is None for s in scopes)


@pytest.mark.asyncio
async def test_discovery_source_pause_keeps_waiting_and_can_cancel(bank_db):
    first = await SyncTaskService.create_textbook(bank_db, {'acknowledgeSourcePolicy': True}, 'teacher')
    again = await SyncTaskService.create_textbook(bank_db, {'acknowledgeSourcePolicy': True}, 'teacher')
    assert first['taskId'] == again['taskId']
    class Paused:
        def health(self):
            return {'sourceControl': {'paused': True, 'manualRequired': True, 'reason': '来源需要验证'}}
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    await bank_db.rollback()
    assert await dispatch.dispatch_once(session_factory=factory, client=Paused()) == 0
    row = await bank_db.get(QbSyncJob, first['taskId'], populate_existing=True)
    assert row.status == 'queued' and row.collector_job_id is None and row.active_slot is None
    assert row.dispatch_error == '来源需要验证'
    assert await dispatch.cancel_waiting(bank_db, row.run_id)
    assert row.status == 'cancelled'


@pytest.mark.asyncio
@pytest.mark.parametrize('reason', ['来源等待恢复', '采集器正在回收或整理数据库，请稍后再启动'])
async def test_explicit_pause_racing_dispatch_is_waiting_not_failed(bank_db, monkeypatch, reason):
    task = await SyncTaskService.create_textbook(bank_db, {'acknowledgeSourcePolicy': True}, 'teacher')
    claim = await dispatch.claim_next(bank_db)
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    monkeypatch.setattr(runs.DataSourceRegistry, 'session', factory)
    class Paused:
        def start_job(self, *args, **kwargs):
            raise ServiceException(message=reason) from HTTPError('http://collector/v1/jobs', 423, 'paused', {}, None)
    monkeypatch.setattr(runs, 'CollectorClient', Paused)
    await bank_db.rollback()
    await runs._execute(task['taskId'], runs._WorkerHandle(token=claim['token'], task_module='textbook', run_type='metadata', workflow_version=2))
    row = await bank_db.get(QbSyncJob, task['taskId'], populate_existing=True)
    assert row.status == 'queued' and row.active_slot is None and row.dispatch_error == reason
    assert row.error_message is None


@pytest.mark.asyncio
async def test_failed_discovery_retries_from_plan_without_losing_name(bank_db):
    result = await plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True))
    plan_id = result['planId']
    await tick(bank_db, plan_id)
    plan = await bank_db.get(QbSyncPlan, plan_id)
    first = await bank_db.get(QbSyncJob, plan.discovery_task_id)
    first_id = first.run_id
    first_name = first.options_json['autoCycleName']
    first.status = first.phase = 'failed'; first.error_message = '网络错误'
    await bank_db.commit()
    await dispatch.release_finished_books(bank_db)
    await plans.retry_plan_discovery(bank_db, plan_id, plan.revision)
    await tick(bank_db, plan_id)
    plan = await bank_db.get(QbSyncPlan, plan_id)
    assert plan.discovery_task_id != first_id and plan.cycle_no == 0
    second = await bank_db.get(QbSyncJob, plan.discovery_task_id)
    assert second.options_json['autoCycleName'] == first_name
    assert not list((await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.task_module == 'question'))).all())


@pytest.mark.asyncio
@pytest.mark.parametrize('status', ['completed', 'failed', 'blocked', 'cancelled'])
async def test_discovery_terminal_result_releases_execution_slot_and_preserves_logs(bank_db, monkeypatch, status):
    task = await SyncTaskService.create_textbook(bank_db, {'acknowledgeSourcePolicy': True}, 'teacher')
    claim = await dispatch.claim_next(bank_db)
    row = await bank_db.get(QbSyncJob, task['taskId'])
    row.status = 'running'
    row.log_tail = '发现26个版本，教材接口HTTP405'
    await bank_db.commit()
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    monkeypatch.setattr(runs.DataSourceRegistry, 'session', factory)
    from plugins.bank.service import import_intake_worker
    async def no_question_intake(*args, **kwargs):
        raise AssertionError('教材发现不应提交题目入库核验')
    monkeypatch.setattr(import_intake_worker, 'register_task_intake', no_question_intake)
    await bank_db.rollback()
    token = runs._QUEUE_OWNER.set((task['taskId'], claim['token']))
    try:
        await runs._finish(task['taskId'], runs._WorkerHandle(token=claim['token'], task_module='textbook', run_type='metadata'),
                           status, status, None if status == 'completed' else '教材列表接口返回 HTTP 405')
    finally:
        runs._QUEUE_OWNER.reset(token)
    row = await bank_db.get(QbSyncJob, task['taskId'], populate_existing=True)
    assert row.status == status and row.phase == status and row.active_slot is None
    assert row.finished_at is not None and row.log_tail == '发现26个版本，教材接口HTTP405'
    assert await dispatch.release_finished_books(bank_db) == 1


async def _ready(*args,**kwargs):
    return True
