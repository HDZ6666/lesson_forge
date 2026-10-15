"""Emergency pause needs real work; an existing idle pause can still be cleared."""

from datetime import datetime
from unittest.mock import AsyncMock

import pytest

from exceptions.exception import ServiceException
from plugins.bank.controller.sync_plan_controller import PlanInput
from plugins.bank.entity.do.bank_do import QbQuestionImport, QbQuestionImportIntake, QbSyncControl, QbSyncJob
from plugins.bank.service import sync_plans
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db


async def control(db, paused=0):
    row = QbSyncControl(control_id=1, paused=paused, revision=1, reason='人工紧急暂停' if paused else None,
                        update_time=datetime.now())
    db.add(row)
    await db.commit()
    return row


@pytest.mark.asyncio
async def test_empty_paused_plan_cannot_create_emergency_pause(bank_db):
    row = await control(bank_db)
    await sync_plans.save_plan(bank_db, PlanInput(subjectId=1))
    before = await sync_plans.control_status(bank_db)
    assert not before['hasPendingWork'] and not before['canEmergencyPause']
    with pytest.raises(ServiceException, match='当前没有需要暂停'):
        await sync_plans.set_control(bank_db, True, 1, '人工紧急暂停', 'teacher')
    assert row.paused == 0 and row.revision == 1 and row.reason is None


@pytest.mark.asyncio
async def test_idle_existing_pause_can_be_cleared_without_starting_plan(bank_db):
    row = await control(bank_db, paused=1)
    plan = await sync_plans.save_plan(bank_db, PlanInput(subjectId=1))
    result = await sync_plans.set_control(bank_db, False, row.revision, '人工紧急暂停', 'teacher')
    assert not result['paused'] and not result['hasPendingWork'] and not result['canEmergencyPause']
    stored = (await sync_plans.list_plans(bank_db))[0]
    assert stored['planId'] == plan['planId'] and not stored['enabled']
    assert stored['controlState'] == 'paused' and stored['cycleNo'] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize('stage', ['queued', 'running', 'checking', 'importing', 'planning'])
async def test_emergency_pause_keeps_all_real_work_stages_supported(bank_db, monkeypatch, stage):
    await control(bank_db)
    now = datetime.now()
    cancel = AsyncMock()
    from plugins.bank.service.sync_run_service import SyncRunService

    monkeypatch.setattr(SyncRunService, 'cancel', cancel)
    if stage in ('queued', 'running'):
        bank_db.add(QbSyncJob(run_id=10, subject_id=1, task_module='textbook', run_type='metadata',
            status=stage, phase='metadata', acknowledge_source_policy='Y', options_json={},
            active_slot='1' if stage == 'running' else None, create_time=now, update_time=now))
    elif stage == 'checking':
        bank_db.add(QbQuestionImportIntake(task_id=10, scope_id=10, collector_run_id=10,
            binding_hash='a' * 64, status='retry', create_time=now, update_time=now))
    elif stage == 'importing':
        bank_db.add(QbQuestionImport(task_id=10, scope_id=10, subject_id=1, source_provider='zujuan',
            local_textbook_id=1, external_textbook_id='tb1', collector_run_id=10,
            snapshot_locked_at=now, snapshot_complete=0, identity_hash='a' * 64, question_count=10,
            status='running', stage='running', stats_json={}, create_time=now, update_time=now))
    else:
        saved = await sync_plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True))
        from plugins.bank.entity.do.bank_do import QbSyncPlan
        row = await bank_db.get(QbSyncPlan, saved['planId'])
        row.cycle_state = 'discovering'
    await bank_db.commit()
    assert (await sync_plans.control_status(bank_db))['canEmergencyPause']
    result = await sync_plans.set_control(bank_db, True, 1, '人工紧急暂停', 'teacher')
    assert result['paused'] and not result['canEmergencyPause']
    if stage == 'running':
        cancel.assert_awaited_once_with(bank_db, 10)
    else:
        cancel.assert_not_awaited()
