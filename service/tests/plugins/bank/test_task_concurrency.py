
import pytest
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import async_sessionmaker

from exceptions.exception import ServiceException
from plugins.bank.controller.sync_plan_controller import PlanInput
from plugins.bank.entity.do.bank_do import QbSyncJob
from plugins.bank.entity.vo.bank_vo import TaskConcurrencyInput, TaskConcurrencyUpdate
from plugins.bank.service import sync_dispatch, sync_plans, sync_run_service, task_concurrency
from plugins.bank.service.task_service import SyncTaskService, task_payload
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db


def test_new_plan_and_server_default_are_eight(monkeypatch):
    monkeypatch.delenv('BANK_DEFAULT_LIST_CONCURRENCY',raising=False)
    assert PlanInput(subjectId=1).list_concurrency==8
    assert task_concurrency.server_default()==8


@pytest.mark.asyncio
async def test_precedence_snapshot_edit_and_dispatched_lock(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_DEFAULT_LIST_CONCURRENCY', '2')
    assert (await task_concurrency.resolve(bank_db, 1))['listConcurrency'] == 2
    plan = await sync_plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True, listConcurrency=4))
    a = await SyncTaskService.create_question(bank_db, {'versionId':1, 'textbookId':1})
    b = await SyncTaskService.create_question(bank_db, {'versionId':1, 'textbookId':2, 'listConcurrency':1})
    rowa, rowb = await bank_db.get(QbSyncJob,a['taskId']), await bank_db.get(QbSyncJob,b['taskId'])
    assert rowa.options_json['listConcurrency'] == 4 and rowa.options_json['concurrencySource'] == 'plan'
    assert rowb.options_json['listConcurrency'] == 1 and rowb.options_json['concurrencySource'] == 'task'
    await sync_plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True, expectedRevision=plan['revision'], listConcurrency=8))
    assert rowa.options_json['listConcurrency'] == 4
    old = task_payload(rowa)['concurrencyToken']
    await task_concurrency.update_waiting(bank_db,rowa.run_id,TaskConcurrencyUpdate(listConcurrency=2,expectedToken=old))
    with pytest.raises(ServiceException,match='已变化'):
        await task_concurrency.update_waiting(bank_db,rowa.run_id,TaskConcurrencyUpdate(listConcurrency=1,expectedToken=old))
    await bank_db.rollback()
    rowa=await bank_db.get(QbSyncJob,a['taskId'])
    assert rowa.options_json['listConcurrency']==2
    await task_concurrency.update_waiting(bank_db,rowa.run_id,TaskConcurrencyUpdate(listConcurrency=None,expectedToken=task_concurrency.token(rowa.options_json)))
    assert rowa.options_json['listConcurrency']==8 and rowa.options_json['concurrencySource']=='plan'
    await sync_dispatch.claim_next(bank_db,task_id=rowa.run_id)
    with pytest.raises(ServiceException,match='尚未派发'):
        await task_concurrency.update_waiting(bank_db,rowa.run_id,TaskConcurrencyUpdate(listConcurrency=1,expectedToken=task_concurrency.token(rowa.options_json)))


@pytest.mark.asyncio
async def test_worker_rehydrates_frozen_concurrency_for_collector(bank_db, monkeypatch):
    task=await SyncTaskService.create_question(bank_db,{'versionId':1,'textbookId':1,'listConcurrency':4})
    claim=await sync_dispatch.claim_next(bank_db)
    factory=async_sessionmaker(bank_db.bind,expire_on_commit=False)
    monkeypatch.setattr(sync_run_service.DataSourceRegistry,'session',factory)
    seen={}
    class Client:
        def start_job(self,*args,**kwargs):
            seen.update(kwargs)
            return {'id':'aaaaaaaa-1111-4444-aaaa-111111111111','status':'failed','errorMessage':'fixture stop'}
    monkeypatch.setattr(sync_run_service,'CollectorClient',Client)
    await bank_db.rollback()
    await sync_run_service._execute(task['taskId'],sync_run_service._WorkerHandle(token=claim['token'],task_module='question',run_type='content'))
    assert seen['list_concurrency']==4


@pytest.mark.asyncio
async def test_retry_new_override_and_original_unchanged(bank_db):
    task=await SyncTaskService.create_question(bank_db,{'versionId':1,'textbookId':1,'listConcurrency':4})
    row=await bank_db.get(QbSyncJob,task['taskId']);row.status=row.phase='failed';row.dispatch_book_key=None
    await bank_db.commit()
    new=await SyncTaskService.retry_question(bank_db,row.run_id,settings=TaskConcurrencyInput(listConcurrency=1))
    result=await bank_db.get(QbSyncJob,new['taskId'])
    assert result.retry_of_run_id==row.run_id and result.options_json['listConcurrency']==1
    assert row.options_json['listConcurrency']==4


@pytest.mark.parametrize('value',[0,9,1.5,True,'4'])
def test_invalid_ui_concurrency_rejected(value):
    with pytest.raises(ValidationError): TaskConcurrencyInput(listConcurrency=value)
    with pytest.raises(ValidationError): PlanInput(subjectId=1,listConcurrency=value)
