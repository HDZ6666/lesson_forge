from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from exceptions.exception import ServiceException
from plugins.bank.controller.sync_plan_controller import SingleBook
from plugins.bank.entity.do.bank_do import QbSyncJob, QbSyncJobScope, QbSyncPlan, QbSyncSupplement, QbQuestionImport
from plugins.bank.service import sync_plans, sync_dispatch, plan_control, sync_run_service
from plugins.bank.service.task_service import SyncTaskService
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_sync_flow_acceptance import setup, finish_book
from tests.plugins.bank.test_subject_sync_workflow import tick


@pytest.mark.asyncio
async def test_source_resume_preserves_original_execution(bank_db, monkeypatch):
    pid, jobs = await setup(bank_db, monkeypatch)
    await finish_book(bank_db, jobs[0], status='blocked', complete=False, error='题目列表返回验证/防护')
    await finish_book(bank_db, jobs[1])
    previous_started = jobs[0].started_at
    scope = await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id==jobs[0].run_id))
    previous_collector = scope.collector_run_id
    async def summary(*args, **kwargs):
        return {'counts':{'catalogItemCount':1,'questionItemCount':3,'questionCatalogCount':3},
                'run':{'snapshotLockedAt':datetime.now(timezone.utc).isoformat()}}
    monkeypatch.setattr(sync_run_service, '_resume_partial_summary', summary)
    class Verified:
        def health(self):
            return {'ok':True,'sourceControl':{'paused':False}}
    plan = await bank_db.get(QbSyncPlan,pid)
    plan.next_check_at=None
    await bank_db.commit()
    await sync_plans.tick_plan(bank_db,pid,client=Verified())
    old = await bank_db.get(QbSyncJob,jobs[0].run_id,populate_existing=True)
    old_scope = await bank_db.get(QbSyncJobScope,scope.scope_id,populate_existing=True)
    assert (old.status,old.started_at,old_scope.collector_run_id)==('blocked',previous_started,previous_collector)


@pytest.mark.asyncio
async def test_manual_retry_of_isolated_book_keeps_round_open(bank_db, monkeypatch):
    pid,jobs=await setup(bank_db,monkeypatch)
    reservation=jobs[0].dispatch_book_key
    await finish_book(bank_db,jobs[0],status='failed',complete=False,error='目录 ID 重复：4712')
    jobs[0].dispatch_book_key=reservation
    await bank_db.commit()
    await sync_dispatch.release_finished_books(bank_db)
    await finish_book(bank_db,jobs[1])
    plan=await bank_db.get(QbSyncPlan,pid)
    result=await plan_control.sync_book_once(bank_db,pid,1,SingleBook(expectedRevision=plan.revision),'teacher')
    new_job=await bank_db.get(QbSyncJob,result['taskId'])
    assert new_job.status=='queued' and new_job.options_json['manualDispatchRequested']
    await tick(bank_db,pid)
    plan=await bank_db.get(QbSyncPlan,pid,populate_existing=True)
    assert plan.cycle_state=='running', (plan.cycle_state,plan.session_end_reason,new_job.status)


@pytest.mark.asyncio
async def test_failed_supplement_creation_does_not_leave_permanent_running_row(bank_db, monkeypatch):
    pid,jobs=await setup(bank_db,monkeypatch)
    for job in jobs:
        await finish_book(bank_db,job)
    await tick(bank_db,pid)
    async def fail(*args,**kwargs):
        raise ServiceException(message='创建教材执行失败')
    monkeypatch.setattr(SyncTaskService,'retry_question',fail)
    plan=await bank_db.get(QbSyncPlan,pid)
    with pytest.raises(ServiceException):
        await plan_control.sync_book_once(bank_db,pid,1,SingleBook(expectedRevision=plan.revision),'teacher')
    await bank_db.rollback()
    orphan=await bank_db.scalar(select(QbSyncSupplement).where(QbSyncSupplement.plan_id==pid,
        QbSyncSupplement.status=='running',QbSyncSupplement.task_id.is_(None)))
    assert orphan is None, f'committed supplement {orphan.supplement_id} has no execution and blocks all future wake-ups'


@pytest.mark.asyncio
async def test_import_recovery_reaches_due_row_after_twenty_exhausted_rows(bank_db,monkeypatch):
    from plugins.bank.service.incremental_import import _new_import
    pid,jobs=await setup(bank_db,monkeypatch)
    await finish_book(bank_db,jobs[0],import_status='failed')
    await finish_book(bank_db,jobs[1],import_status='failed')
    jobs[0].options_json={**jobs[0].options_json,'planImportRetryCount':3}
    imports=list((await bank_db.scalars(select(QbQuestionImport).order_by(QbQuestionImport.import_id))).all())
    old=imports[0]
    due=imports[1]
    old.import_id=1
    due.import_id=21
    now=datetime.now(timezone.utc).replace(tzinfo=None)
    old.update_time=due.update_time=now-timedelta(days=2)
    scope=await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id==jobs[0].run_id))
    for number in range(2,21):
        row=_new_import(scope,now-timedelta(days=2))
        row.import_id=number
        row.collector_run_id=2000+number
        row.status='failed'
        bank_db.add(row)
    await bank_db.commit()
    calls=[]
    async def retry(db,scope_id,now,**kwargs):
        calls.append(kwargs['import_id'])
        return True
    monkeypatch.setattr(sync_plans,'_retry_saved_scope_results',retry)
    await sync_plans.recover_failed_results(bank_db,now)
    assert calls==[21], calls

@pytest.mark.asyncio
async def test_healthy_book_manual_rerun_keeps_round_open(bank_db, monkeypatch):
    pid,jobs=await setup(bank_db,monkeypatch)
    await finish_book(bank_db,jobs[0])
    second_id=jobs[1].run_id
    await tick(bank_db,pid)  # Book 1 has been accounted for; book 2 still queued.
    second=await bank_db.get(QbSyncJob,second_id,populate_existing=True)
    await finish_book(bank_db,second)
    plan=await bank_db.get(QbSyncPlan,pid)
    result=await plan_control.sync_book_once(bank_db,pid,1,SingleBook(expectedRevision=plan.revision),'teacher')
    await tick(bank_db,pid)
    plan=await bank_db.get(QbSyncPlan,pid,populate_existing=True)
    job=await bank_db.get(QbSyncJob,result['taskId'])
    assert plan.cycle_state=='running', (plan.cycle_state,plan.session_end_reason,job.status)

@pytest.mark.asyncio
async def test_resource_wait_reconciles_after_worker_restart(bank_db, monkeypatch):
    from sqlalchemy.ext.asyncio import async_sessionmaker
    from plugins.bank.entity.do.bank_do import QbSyncControl
    from plugins.bank.service.resource_guard import ResourcePressure
    from plugins.bank.service.resource_wait import ResourceWait
    factory=async_sessionmaker(bank_db.bind,expire_on_commit=False)
    def shortage(): raise ResourcePressure(message='内存不足')
    first=ResourceWait()
    assert not await first.allow(factory,check=shortage,clock=lambda:1.0)
    restarted=ResourceWait()
    for second in (10.0,50.0,100.0):
        await restarted.allow(factory,check=lambda:None,clock=lambda:second)
    control=await bank_db.get(QbSyncControl,1,populate_existing=True)
    assert control.resource_wait_json['active'] is False, control.resource_wait_json

@pytest.mark.asyncio
async def test_reorder_event_records_actual_movement(bank_db,monkeypatch):
    from plugins.bank.controller.sync_plan_controller import PlanOrder
    from plugins.bank.service import diagnostics
    pid,jobs=await setup(bank_db,monkeypatch)
    plan=await bank_db.get(QbSyncPlan,pid)
    events=[]
    monkeypatch.setattr(diagnostics,'event',lambda name,**fields:events.append((name,fields)))
    await plan_control.set_order(bank_db,pid,PlanOrder(expectedRevision=plan.revision,textbookIds=[2,1]))
    fields=next(fields for name,fields in events if name=='queue_reordered')
    assert fields['movedCount']==2,fields

@pytest.mark.asyncio
async def test_manual_browser_recovery_keeps_full_scan_mode(bank_db,monkeypatch):
    from plugins.bank.service import manual_recovery
    pid,jobs=await setup(bank_db,monkeypatch)
    await finish_book(bank_db,jobs[0],status='blocked',complete=False,error='题目列表返回验证/防护：目录 5289 第 25 页')
    jobs[0].options_json={**jobs[0].options_json,'syncMode':'full'}
    scope=await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id==jobs[0].run_id))
    scope.catalog_count=1
    scope.question_catalog_count=3
    task_id=jobs[0].run_id
    await bank_db.commit()
    async def verified(action,payload): return {'ok':True}
    monkeypatch.setattr(manual_recovery,'call',verified)
    result=await manual_recovery.finish_browser(bank_db,'session',{'owner':'1','taskId':task_id},'teacher')
    resumed=await bank_db.get(QbSyncJob,result['taskId'],populate_existing=True)
    assert resumed.options_json.get('syncMode')=='full', resumed.options_json.get('syncMode')

@pytest.mark.asyncio
async def test_settled_history_retains_end_time_problem_snapshot(bank_db,monkeypatch):
    from plugins.bank.entity.do.bank_do import QbSyncIssue
    pid,jobs=await setup(bank_db,monkeypatch)
    reservation=jobs[0].dispatch_book_key
    await finish_book(bank_db,jobs[0],status='failed',complete=False,error='目录 ID 重复：4712')
    jobs[0].dispatch_book_key=reservation
    await bank_db.commit()
    await sync_dispatch.release_finished_books(bank_db)
    await finish_book(bank_db,jobs[1])
    await tick(bank_db,pid)
    before=await sync_plans.session_log(bank_db,pid,1)
    assert before['rounds'][0]['openIssueCount']>0
    issues=list((await bank_db.scalars(select(QbSyncIssue))).all())
    for issue in issues: issue.status='resolved'
    await bank_db.commit()
    after=await sync_plans.session_log(bank_db,pid,1)
    assert after['rounds'][0]['openIssueCount']==before['rounds'][0]['openIssueCount'], (before['rounds'][0],after['rounds'][0])

@pytest.mark.asyncio
async def test_metadata_protection_can_open_manual_browser(bank_db,monkeypatch):
    from plugins.bank.service import manual_recovery
    pid,jobs=await setup(bank_db,monkeypatch)
    plan=await bank_db.get(QbSyncPlan,pid)
    metadata=await bank_db.get(QbSyncJob,plan.discovery_processed_task_id)
    metadata.collector_job_id='metadata-blocked'
    metadata.status='blocked'
    metadata.error_message='站点返回验证/防护页面，任务已熔断'
    await bank_db.commit()
    class Source:
        def source_control(self): return {'manualRequired':True,'reason':'站点返回验证/防护页面，任务已熔断'}
    monkeypatch.setattr(manual_recovery,'CollectorClient',Source)
    opened=[]
    async def open_remote(action,payload):
        opened.append(action)
        return {'taskId':metadata.run_id}
    monkeypatch.setattr(manual_recovery,'call',open_remote)
    await manual_recovery.open_browser(bank_db,1,'teacher')
    assert opened==['open']

@pytest.mark.asyncio
async def test_collection_resource_wait_records_event_through_real_dispatch(bank_db,monkeypatch):
    from sqlalchemy.ext.asyncio import async_sessionmaker
    from plugins.bank.service import diagnostics, resource_guard
    pid,jobs=await setup(bank_db,monkeypatch)
    events=[]
    monkeypatch.setattr(diagnostics,'event',lambda name,**fields:events.append(name))
    shortage=lambda:{'paused':True,'reason':'后端主机可用内存低于保留水位','availableMemoryMiB':20}
    monkeypatch.setattr(sync_dispatch,'resource_status',shortage)
    monkeypatch.setattr(resource_guard,'resource_status',shortage)
    await bank_db.rollback()
    factory=async_sessionmaker(bank_db.bind,expire_on_commit=False)
    assert await sync_dispatch.dispatch_once(session_factory=factory)==0
    assert 'collection_resource_wait_entered' in events,events
