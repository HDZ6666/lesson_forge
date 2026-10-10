"""Plan controls and whole-round timing against actual database transactions."""
import asyncio
import importlib
import threading
from datetime import datetime, timedelta

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from exceptions.exception import ServiceException
from plugins.bank.controller.sync_plan_controller import PlanAction, PlanInput, PlanOrder, SingleBook
from plugins.bank.entity.do.bank_do import (
    QbQuestion,
    QbQuestionImport,
    QbQuestionImportIntake,
    QbSyncCycle,
    QbSyncJob,
    QbSyncJobScope,
    QbSyncPlan,
    QbTextbook,
)
from plugins.bank.service import (
    import_intake,
    incremental_import,
    plan_control,
    sync_dispatch,
    sync_plans,
    sync_run_service,
)
from plugins.bank.service.incremental_import_worker import _prepare
from plugins.bank.service.plan_work import PlanWorkPaused
from tests.plugins.bank.test_incremental_import import import_db as import_db
from tests.plugins.bank.test_incremental_import import report, verdict
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_subject_sync_workflow import registered_plan, tick


@pytest.mark.asyncio
async def test_pause_blocks_queue_stops_current_and_resume_prioritizes_same_book(bank_db,monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED','1')
    plan_id,_=await registered_plan(bank_db)
    claimed=await sync_dispatch.claim_next(bank_db)
    old=await bank_db.get(QbSyncJob,claimed['taskId']);old.status='running';await bank_db.commit()
    old_id=old.run_id
    async def cancel(db,task_id):
        row=await db.get(QbSyncJob,task_id);row.status=row.phase='cancelled';row.active_slot=None
        for s in (await db.scalars(select(QbSyncJobScope).where(QbSyncJobScope.run_id==task_id))).all():s.status='cancelled'
        await db.commit()
    monkeypatch.setattr(sync_run_service.SyncRunService,'cancel',cancel)
    plan=await bank_db.get(QbSyncPlan,plan_id)
    await plan_control.action(bank_db,plan_id,PlanAction(action='pause',expectedRevision=plan.revision),'teacher')
    assert await sync_dispatch.claim_next(bank_db) is None
    factory=async_sessionmaker(bank_db.bind,expire_on_commit=False)
    await bank_db.rollback();await plan_control.reconcile_controls(factory)
    plan=await bank_db.get(QbSyncPlan,plan_id,populate_existing=True)
    assert plan.control_state=='paused' and not plan.enabled
    await sync_plans.save_plan(bank_db,PlanInput(subjectId=1,expectedRevision=plan.revision,enabled=False,listConcurrency=8))
    plan=await bank_db.get(QbSyncPlan,plan_id,populate_existing=True)
    await plan_control.action(bank_db,plan_id,PlanAction(action='resume',expectedRevision=plan.revision),'teacher')
    await bank_db.rollback();await plan_control.reconcile_controls(factory)
    new=(await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.retry_of_run_id==old_id))).one()
    assert new.options_json['autoPlanId']==plan_id and new.dispatch_priority>0
    assert new.options_json['listConcurrency']==8
    assert (await bank_db.get(QbSyncJob,old_id)).options_json['listConcurrency']==1
    claim=await sync_dispatch.claim_next(bank_db)
    assert claim['taskId']==new.run_id


@pytest.mark.asyncio
async def test_pause_discovery_discards_partial_run_and_resume_starts_new_discovery(bank_db):
    result=await sync_plans.save_plan(bank_db,PlanInput(subjectId=1,enabled=True))
    plan_id=result['planId'];await tick(bank_db,plan_id)
    plan=await bank_db.get(QbSyncPlan,plan_id);old_id=plan.discovery_task_id
    await plan_control.action(bank_db,plan_id,PlanAction(action='pause',expectedRevision=plan.revision),'teacher')
    old=await bank_db.get(QbSyncJob,old_id)
    assert old.status=='cancelled' and old.options_json['planWorkPaused']
    factory=async_sessionmaker(bank_db.bind,expire_on_commit=False)
    await bank_db.rollback();await plan_control.reconcile_controls(factory)
    plan=await bank_db.get(QbSyncPlan,plan_id,populate_existing=True)
    await plan_control.action(bank_db,plan_id,PlanAction(action='resume',expectedRevision=plan.revision),'teacher')
    await tick(bank_db,plan_id)
    plan=await bank_db.get(QbSyncPlan,plan_id)
    assert plan.discovery_task_id!=old_id and plan.cycle_no==0
    assert not (await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.task_module=='question'))).all()


@pytest.mark.asyncio
async def test_resume_waits_for_stopped_book_recovery_before_other_plan_books(bank_db,monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED','1')
    await registered_plan(bank_db)
    first=await sync_dispatch.claim_next(bank_db)
    row=await bank_db.get(QbSyncJob,first['taskId'])
    row.status='cancelled';row.active_slot=None
    row.options_json={**row.options_json,'planResumePending':True,'planWorkPaused':False}
    await bank_db.commit()
    assert await sync_dispatch.claim_next(bank_db) is None
    row.options_json={**row.options_json,'planResumePending':False}
    await bank_db.commit()
    next_task=await sync_dispatch.claim_next(bank_db)
    assert next_task and next_task['taskId']!=first['taskId']


@pytest.mark.asyncio
async def test_persisted_order_changes_queue_and_new_books_append(bank_db,monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED','1')
    plan_id,_=await registered_plan(bank_db);plan=await bank_db.get(QbSyncPlan,plan_id)
    await plan_control.set_order(bank_db,plan_id,PlanOrder(expectedRevision=plan.revision,textbookIds=[2,1]))
    claim=await sync_dispatch.claim_next(bank_db)
    scope=await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id==claim['taskId']))
    assert scope.local_textbook_id==2
    now=datetime.now()
    bank_db.add(QbTextbook(textbook_id=3,version_id=1,subject_id=1,source_provider='zujuan',external_textbook_id='tb3',textbook_name='新增教材',status='0',create_time=now,update_time=now))
    await bank_db.commit()
    books=await sync_plans.list_books(bank_db,plan_id)
    assert [b['textbookId'] for b in books]==[2,1,3]
    plan=await bank_db.get(QbSyncPlan,plan_id)
    await plan_control.set_order(bank_db,plan_id,PlanOrder(expectedRevision=plan.revision,textbookIds=[3,1,2]))
    assert (await bank_db.get(QbSyncJob,claim['taskId'])).active_slot is not None


async def finish_round(db,plan_id):
    jobs=(await db.scalars(select(QbSyncJob).where(QbSyncJob.task_module=='question',QbSyncJob.options_json['autoPlanId'].as_integer()==plan_id))).all()
    for j in jobs:j.status=j.phase='failed';j.dispatch_book_key=None;j.active_slot=None
    await db.commit();await tick(db,plan_id)


@pytest.mark.asyncio
async def test_full_round_deadline_and_manual_single_does_not_reset_it(bank_db,monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED','1')
    plan_id,_=await registered_plan(bank_db);await finish_round(bank_db,plan_id)
    plan=await bank_db.get(QbSyncPlan,plan_id)
    assert plan.cycle_state=='completed' and plan.next_cycle_at==plan.cycle_finished_at+timedelta(days=7)
    deadline=plan.next_cycle_at
    result=await plan_control.sync_book_once(bank_db,plan_id,1,SingleBook(expectedRevision=plan.revision,listConcurrency=2),'teacher')
    job=await bank_db.get(QbSyncJob,result['taskId'])
    assert job.options_json['manualSingle'] and job.options_json['manualPlanId']==plan_id
    assert job.options_json['listConcurrency']==2
    await tick(bank_db,plan_id)
    plan=await bank_db.get(QbSyncPlan,plan_id)
    assert plan.next_cycle_at==deadline and plan.cycle_no==1
    history=await sync_plans.cycle_history(bank_db,plan_id)
    assert history['rows'][0]['status']=='completed' and history['rows'][0]['targetCount']==2
    plan.next_cycle_at=datetime.utcnow()-timedelta(seconds=1);await bank_db.commit()
    await tick(bank_db,plan_id)
    plan=await bank_db.get(QbSyncPlan,plan_id)
    assert plan.cycle_state=='discovering' and plan.discovery_task_id


@pytest.mark.asyncio
async def test_manual_advance_reuses_queue_and_only_one_book_bypasses_pause(bank_db,monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED','1')
    plan_id,_=await registered_plan(bank_db);plan=await bank_db.get(QbSyncPlan,plan_id)
    count=await bank_db.scalar(select(func.count()).select_from(QbSyncJob))
    task=await plan_control.sync_book_once(bank_db,plan_id,2,SingleBook(expectedRevision=plan.revision),'teacher')
    assert task['existing'] and await bank_db.scalar(select(func.count()).select_from(QbSyncJob))==count
    task=await plan_control.sync_book_once(bank_db,plan_id,2,SingleBook(expectedRevision=plan.revision,listConcurrency=4),'teacher')
    assert (await bank_db.get(QbSyncJob,task['taskId'])).options_json['listConcurrency']==4
    task=await plan_control.sync_book_once(bank_db,plan_id,2,SingleBook(expectedRevision=plan.revision),'teacher')
    assert (await bank_db.get(QbSyncJob,task['taskId'])).options_json['concurrencySource']=='plan'
    assert (await sync_dispatch.claim_next(bank_db))['taskId']==task['taskId']
    row=await bank_db.get(QbSyncJob,task['taskId']);row.active_slot=None;row.status='queued';await bank_db.commit()
    plan=await bank_db.get(QbSyncPlan,plan_id)
    await plan_control.action(bank_db,plan_id,PlanAction(action='pause',expectedRevision=plan.revision),'teacher')
    factory=async_sessionmaker(bank_db.bind,expire_on_commit=False)
    await bank_db.rollback();await plan_control.reconcile_controls(factory)
    plan=await bank_db.get(QbSyncPlan,plan_id,populate_existing=True)
    with pytest.raises(ServiceException,match='确认'):
        await plan_control.sync_book_once(bank_db,plan_id,1,SingleBook(expectedRevision=plan.revision),'teacher')
    await bank_db.rollback();plan=await bank_db.get(QbSyncPlan,plan_id)
    one=await plan_control.sync_book_once(bank_db,plan_id,1,SingleBook(expectedRevision=plan.revision,allowPaused=True),'teacher')
    assert (await sync_dispatch.claim_next(bank_db))['taskId']==one['taskId']
    plan=await bank_db.get(QbSyncPlan,plan_id)
    assert not plan.enabled and plan.control_state=='paused'


@pytest.mark.asyncio
async def test_end_round_cancels_queue_and_optional_auto_update(bank_db):
    plan_id,_=await registered_plan(bank_db);plan=await bank_db.get(QbSyncPlan,plan_id)
    await plan_control.action(bank_db,plan_id,PlanAction(action='end',expectedRevision=plan.revision,keepUpdates=False),'teacher')
    factory=async_sessionmaker(bank_db.bind,expire_on_commit=False)
    await bank_db.rollback();await plan_control.reconcile_controls(factory)
    plan=await bank_db.get(QbSyncPlan,plan_id,populate_existing=True)
    assert plan.cycle_state=='stopped' and plan.next_cycle_at is None and not plan.auto_update
    rows=(await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.task_module=='question'))).all()
    assert all(j.status=='cancelled' for j in rows)
    await tick(bank_db,plan_id)
    assert (await bank_db.get(QbSyncPlan,plan_id)).cycle_no==1


@pytest.mark.asyncio
async def test_import_pause_retains_batch_then_resume_and_end(import_db):
    db=import_db
    plan=await sync_plans.save_plan(db,PlanInput(subjectId=1,enabled=True))
    job=await db.get(QbSyncJob,28);job.options_json={**job.options_json,'manualPlanId':plan['planId']};await db.commit()
    ticket=await incremental_import.claim_incremental_import(db,30,report())
    await incremental_import.submit_incremental_import_batch(db,ticket,[verdict(0,'q3')],expected_cursor=0)
    p=await db.get(QbSyncPlan,plan['planId'])
    await plan_control.action(db,p.plan_id,PlanAction(action='pause',expectedRevision=p.revision),'teacher')
    with pytest.raises(PlanWorkPaused):
        await incremental_import.submit_incremental_import_batch(db,ticket,[verdict(1,'q4')],expected_cursor=1)
    await incremental_import.defer_incremental_import(db,ticket,'暂停')
    row=await db.get(QbQuestionImport,ticket['importId'])
    assert row.status=='paused' and row.cursor==1 and row.accepted_count==1
    assert row.import_id not in await incremental_import.pending_incremental_import_ids(db)
    factory=async_sessionmaker(db.bind,expire_on_commit=False)
    await db.rollback();await plan_control.reconcile_controls(factory)
    p=await db.get(QbSyncPlan,plan['planId'],populate_existing=True)
    await plan_control.action(db,p.plan_id,PlanAction(action='resume',expectedRevision=p.revision),'teacher')
    assert ticket['importId'] in await incremental_import.pending_incremental_import_ids(db)
    await db.rollback();p=await db.get(QbSyncPlan,plan['planId'])
    await plan_control.action(db,p.plan_id,PlanAction(action='end',expectedRevision=p.revision),'teacher')
    await db.rollback();await plan_control.reconcile_controls(factory)
    row=await db.get(QbQuestionImport,ticket['importId'],populate_existing=True)
    assert row.status=='cancelled' and row.cursor==1
    assert await db.scalar(select(QbQuestion.question_id).where(QbQuestion.external_question_id=='q3'))


@pytest.mark.asyncio
async def test_intake_pause_releases_probe_without_using_retry_budget(import_db):
    db=import_db;plan=await sync_plans.save_plan(db,PlanInput(subjectId=1,enabled=True))
    job=await db.get(QbSyncJob,28);job.options_json={**job.options_json,'manualPlanId':plan['planId']};await db.commit()
    intake=await import_intake.register_import_intake(db,30)
    ticket=await import_intake.claim_import_intake(db,intake['intakeId'])
    p=await db.get(QbSyncPlan,plan['planId'])
    await plan_control.action(db,p.plan_id,PlanAction(action='pause',expectedRevision=p.revision),'teacher')
    with pytest.raises(PlanWorkPaused):await import_intake.complete_import_intake(db,ticket,{})
    await import_intake.defer_plan_intake(db,ticket)
    row=await db.get(QbQuestionImportIntake,intake['intakeId'])
    assert row.status=='pending' and row.attempt_count==0 and row.worker_token is None
    assert row.intake_id not in await import_intake.due_import_intake_ids(db)


def test_preparation_stops_on_pause_before_source_read(tmp_path):
    event=threading.Event();event.set()
    with pytest.raises(PlanWorkPaused):_prepare({},None,tmp_path/'spool.sqlite3',threading.Event(),event)


@pytest.mark.asyncio
async def test_disable_updates_finishes_current_round_without_starting_next(bank_db):
    plan_id,_=await registered_plan(bank_db)
    plan=await bank_db.get(QbSyncPlan,plan_id)
    await sync_plans.save_plan(bank_db,PlanInput(subjectId=1,expectedRevision=plan.revision,enabled=True,autoUpdate=False))
    assert (await bank_db.get(QbSyncPlan,plan_id)).cycle_state=='running'
    await finish_round(bank_db,plan_id)
    plan=await bank_db.get(QbSyncPlan,plan_id)
    assert plan.cycle_state=='completed' and plan.next_cycle_at is None
    await tick(bank_db,plan_id)
    assert (await bank_db.get(QbSyncPlan,plan_id)).cycle_no==1


@pytest.mark.asyncio
async def test_paused_import_does_not_starve_explicit_single_book(import_db,monkeypatch):
    db=import_db
    result=await sync_plans.save_plan(db,PlanInput(subjectId=1,enabled=True))
    job=await db.get(QbSyncJob,28)
    job.options_json={**job.options_json,'manualPlanId':result['planId']}
    await db.commit()
    ticket=await incremental_import.claim_incremental_import(db,30,report())
    p=await db.get(QbSyncPlan,result['planId'])
    await plan_control.action(db,p.plan_id,PlanAction(action='pause',expectedRevision=p.revision),'teacher')
    await incremental_import.defer_incremental_import(db,ticket,'暂停')
    factory=async_sessionmaker(db.bind,expire_on_commit=False)
    await db.rollback();await plan_control.reconcile_controls(factory)
    p=await db.get(QbSyncPlan,result['planId'],populate_existing=True)
    one=await plan_control.sync_book_once(db,p.plan_id,2,SingleBook(expectedRevision=p.revision,allowPaused=True),'teacher')
    monkeypatch.setenv('BANK_SYNC_MAX_PENDING_IMPORTS','1')
    executed=[]
    async def execute(task_id,handle):executed.append(task_id)
    monkeypatch.setattr(sync_run_service,'_execute',execute)
    class Healthy:
        def health(self):return {'ok':True}
    await db.rollback()
    try:
        assert await sync_dispatch.dispatch_once(session_factory=factory,client=Healthy())==1
        await asyncio.sleep(0)
        assert executed==[one['taskId']]
        p=await db.get(QbSyncPlan,result['planId'],populate_existing=True)
        assert p.control_state=='paused' and not p.enabled
        row=await db.get(QbQuestionImport,ticket['importId'],populate_existing=True)
        assert row.status=='paused'
    finally:
        sync_run_service._WORKERS.pop(one['taskId'],None)


@pytest.mark.asyncio
async def test_mysql_upgrade_024_retains_plan_queue_and_is_repeatable(bank_db):
    if bank_db.bind.dialect.name!='mysql':
        pytest.skip('isolated MySQL upgrade check')
    plan_id,_=await registered_plan(bank_db)
    plan=await bank_db.get(QbSyncPlan,plan_id)
    plan.enabled=0
    old_ids=list((await bank_db.scalars(select(QbSyncJob.run_id))).all())
    await bank_db.commit()
    await bank_db.execute(text('DROP TABLE qb_sync_cycle'))
    additions={
        'qb_sync_plan':('auto_update','control_state','cycle_state','cycle_finished_at','next_cycle_at','textbook_order'),
        'qb_sync_job':('dispatch_priority','dispatch_rank'),
        'qb_sync_book_state':('last_manual_task_id',),
    }
    for table,columns in additions.items():
        for column in columns:
            await bank_db.execute(text(f'ALTER TABLE {table} DROP COLUMN {column}'))
    await bank_db.execute(text('ALTER TABLE qb_question_import DROP CHECK chk_qb_question_import_status'))
    await bank_db.execute(text("ALTER TABLE qb_question_import ADD CONSTRAINT chk_qb_question_import_status CHECK(status IN ('queued','preparing','running','completed','partial','failed'))"))
    await bank_db.commit()
    migration=importlib.import_module('plugins.bank.migrations.mysql.024_plan_workflow')
    await migration.run(bank_db);await bank_db.commit()
    await migration.run(bank_db);await bank_db.commit()
    bank_db.expire_all()
    plan=await bank_db.get(QbSyncPlan,plan_id)
    assert plan.control_state=='paused' and plan.cycle_state=='running' and plan.cycle_no==1
    assert plan.plan_name=='数学全教材' and plan.list_concurrency==1 and plan.cycle_targets==[1,2]
    assert list((await bank_db.scalars(select(QbSyncJob.run_id))).all())==old_ids
    history=(await bank_db.scalars(select(QbSyncCycle))).all()
    assert len(history)==1 and history[0].targets==[1,2]
    ddl=(await bank_db.execute(text('SHOW CREATE TABLE qb_question_import'))).one()[1]
    assert "'paused'" in ddl and "'cancelled'" in ddl
