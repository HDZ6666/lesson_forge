"""Plan page limits reach durable tasks without changing running requests."""
import importlib
from datetime import datetime

import pytest
from pydantic import ValidationError
from sqlalchemy import select, text

from plugins.bank.controller.sync_plan_controller import PlanInput
from plugins.bank.entity.do.bank_do import QbSyncJob, QbSyncPlan
from plugins.bank.service import sync_dispatch, sync_plans
from plugins.bank.service.task_service import SyncTaskService
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_subject_sync_workflow import registered_plan


def test_plan_page_limit_default_and_custom_value():
    assert PlanInput(subjectId=1).catalog_page_limit == 1000
    assert PlanInput(subjectId=1, catalogPageLimit=1500).catalog_page_limit == 1500


@pytest.mark.parametrize('value', [0, -1, 10001, 1.5, True, '1500', None])
def test_plan_rejects_invalid_page_limits(value):
    with pytest.raises(ValidationError):
        PlanInput(subjectId=1, catalogPageLimit=value)


@pytest.mark.asyncio
async def test_plan_save_updates_waiting_but_freezes_dispatched_tasks(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    plan_id, _ = await registered_plan(bank_db)
    jobs = list((await bank_db.scalars(select(QbSyncJob).where(
        QbSyncJob.task_module == 'question').order_by(QbSyncJob.run_id))).all())
    assert len(jobs) == 2
    assert all(j.options_json['catalogPageLimit'] == 1000 for j in jobs)
    claim = await sync_dispatch.claim_next(bank_db)
    running = await bank_db.get(QbSyncJob, claim['taskId'])
    running.status = 'running'
    running.started_at = datetime.now()
    await bank_db.commit()
    plan = await bank_db.get(QbSyncPlan, plan_id)
    result = await sync_plans.save_plan(bank_db, PlanInput(
        subjectId=1, expectedRevision=plan.revision, enabled=True, catalogPageLimit=1500))
    assert result['catalogPageLimit'] == 1500
    assert running.options_json['catalogPageLimit'] == 1000
    waiting = next(j for j in jobs if j.run_id != running.run_id)
    assert waiting.options_json['catalogPageLimit'] == 1500
    # An uncertain dispatch must retain its request even if it is queued.
    waiting.started_at = datetime.now()
    await bank_db.commit()
    await sync_plans.save_plan(bank_db, PlanInput(
        subjectId=1, expectedRevision=result['revision'], enabled=True, catalogPageLimit=2000))
    assert waiting.options_json['catalogPageLimit'] == 1500
    running.status = running.phase = 'failed'
    running.active_slot = running.dispatch_book_key = None
    await bank_db.commit()
    retried = await SyncTaskService.retry_question(bank_db, running.run_id)
    retry = await bank_db.get(QbSyncJob, retried.get('taskId') or retried['runId'])
    assert retry.options_json['catalogPageLimit'] == 2000


@pytest.mark.asyncio
async def test_old_waiting_queue_inherits_plan_limit_on_first_dispatch(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    plan_id, _ = await registered_plan(bank_db)
    jobs = list((await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.task_module == 'question'))).all())
    for job in jobs:
        job.options_json = {k:v for k,v in job.options_json.items() if k != 'catalogPageLimit'}
    plan = await bank_db.get(QbSyncPlan, plan_id)
    plan.catalog_page_limit = 1500
    await bank_db.commit()
    claim = await sync_dispatch.claim_next(bank_db)
    job = await bank_db.get(QbSyncJob, claim['taskId'])
    assert job.options_json['catalogPageLimit'] == 1500
    assert job.options_json['limitTo1000Pages'] is False


@pytest.mark.asyncio
async def test_page_limit_migration_is_idempotent_and_preserves_plan(bank_db):
    if bank_db.bind.dialect.name != 'mysql':
        pytest.skip('isolated MySQL migration check')
    plan_id, _ = await registered_plan(bank_db)
    await bank_db.commit()
    await bank_db.execute(text('ALTER TABLE qb_sync_plan DROP COLUMN catalog_page_limit'))
    await bank_db.commit()
    migration = importlib.import_module('plugins.bank.migrations.mysql.028_plan_page_limit')
    await migration.run(bank_db)
    await bank_db.commit()
    await migration.run(bank_db)
    await bank_db.commit()
    bank_db.expire_all()
    plan = await bank_db.get(QbSyncPlan, plan_id)
    assert plan.catalog_page_limit == 1000
    assert plan.cycle_no == 1 and plan.cycle_targets == [1, 2]
