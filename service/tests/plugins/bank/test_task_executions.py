"""Execution history changes presentation while retaining immutable job identities."""
from datetime import datetime

import pytest
from sqlalchemy import select

from exceptions.exception import ServiceException
from plugins.bank.dao.sync_task_dao import SyncTaskDao
from plugins.bank.entity.do.bank_do import QbSyncJob, QbSyncPlan
from plugins.bank.entity.vo.bank_vo import SyncTaskPageQueryModel
from plugins.bank.service import plan_control, task_executions
from plugins.bank.service.task_service import SyncTaskService
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_subject_sync_workflow import registered_plan


async def finish(db, task_id, *, started=True):
    row = await db.get(QbSyncJob, task_id)
    row.status = row.phase = 'failed'
    row.dispatch_book_key = None
    row.started_at = datetime.now() if started else None
    row.finished_at = datetime.now()
    row.error_message = f'失败记录 {task_id}'
    row.log_tail = f'执行 {task_id} 日志'
    await db.commit()


@pytest.mark.asyncio
async def test_retry_keeps_one_row_counts_starts_and_retains_history(bank_db):
    db = bank_db
    first = await SyncTaskService.create_question(db, {'versionId':1,'textbookId':1}, 'test')
    a = first['taskId']
    await finish(db, a)
    second = await SyncTaskService.retry_question(db, a, 'test')
    b = second['taskId']
    assert a != b
    assert (await db.get(QbSyncJob,b)).logical_task_id == a
    assert (await SyncTaskService.retry_question(db,a,'test'))['taskId'] == b
    page = await SyncTaskService.list_question(db,SyncTaskPageQueryModel())
    assert page.total == 1
    assert page.rows[0]['taskId'] == b and page.rows[0]['taskNo'] == str(a)
    assert page.rows[0]['executionCount'] == 1 and page.rows[0]['executionRecordCount'] == 2
    assert (await SyncTaskDao.list_page(db,'question',SyncTaskPageQueryModel(status='failed'))).total == 0
    assert (await SyncTaskDao.list_page(db,'question',SyncTaskPageQueryModel(taskNo=str(a)))).total == 1
    history = await task_executions.history(db,b)
    assert history['executionCount'] == 1
    assert history['rows'][1]['errorMessage'] == f'失败记录 {a}'
    assert history['rows'][1]['logTail'] == f'执行 {a} 日志'
    # Queued/cancelled is retained in history, not counted as collection.
    await finish(db,b,started=False)
    c = (await SyncTaskService.retry_question(db,b,'test'))['taskId']
    await finish(db,c)
    history = await task_executions.history(db,c)
    assert history['executionCount'] == 2
    assert [r['executionNumber'] for r in history['rows']] == [2,None,1]
    # Any execution address deletes the group, never exposes an old row again.
    await SyncTaskService.delete_question(db,a)
    assert (await SyncTaskDao.list_page(db,'question',SyncTaskPageQueryModel())).total == 0


@pytest.mark.asyncio
async def test_group_delete_rolls_back_if_an_execution_is_active(bank_db):
    a = (await SyncTaskService.create_question(bank_db, {'versionId':1,'textbookId':1}, 'test'))['taskId']
    await finish(bank_db,a)
    await SyncTaskService.retry_question(bank_db,a,'test')
    with pytest.raises(ServiceException, match='终态'):
        await SyncTaskService.delete_question(bank_db,a)
    assert len(list((await bank_db.scalars(select(QbSyncJob))).all())) == 2


@pytest.mark.asyncio
async def test_plan_manual_rerun_joins_current_cycle_next_cycle_is_separate(bank_db, monkeypatch):
    from plugins.bank.controller.sync_plan_controller import SingleBook
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED','1')
    plan_id, _ = await registered_plan(bank_db)
    plan = await bank_db.get(QbSyncPlan,plan_id)
    original = await bank_db.scalar(select(QbSyncJob).where(QbSyncJob.task_module=='question').order_by(QbSyncJob.run_id))
    root = original.run_id
    await finish(bank_db,root)
    result = await plan_control.sync_book_once(bank_db,plan_id,1,SingleBook(expectedRevision=plan.revision),'test')
    assert (await bank_db.get(QbSyncJob,result['taskId'])).logical_task_id == root
    await finish(bank_db,result['taskId'])
    next_cycle = await SyncTaskService.create_question(bank_db,{'versionId':1,'textbookId':1}, 'automatic',
        automatic_options={'autoPlanId':plan_id,'autoCycleNo':2,'autoCycleName':'下一轮'})
    new = await bank_db.get(QbSyncJob,next_cycle['taskId'])
    assert new.logical_task_id == new.run_id != root


@pytest.mark.asyncio
async def test_execution_migration_backfills_existing_retry_chain_once(bank_db):
    import importlib
    if bank_db.bind.dialect.name != 'mysql':
        pytest.skip('MySQL migration integration')
    a = (await SyncTaskService.create_question(bank_db,{'versionId':1,'textbookId':1},'test'))['taskId']
    await finish(bank_db,a)
    b = (await SyncTaskService.retry_question(bank_db,a,'test'))['taskId']
    for id in (a,b):
        (await bank_db.get(QbSyncJob,id)).logical_task_id = None
    await bank_db.commit()
    migration = importlib.import_module('plugins.bank.migrations.mysql.026_task_executions')
    await migration.run(bank_db)
    await migration.run(bank_db)
    await bank_db.commit()
    bank_db.expire_all()
    assert (await bank_db.get(QbSyncJob,b)).logical_task_id == a
