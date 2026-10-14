"""Sync sessions: several whole-subject rounds, settled on formal MySQL growth."""
from datetime import datetime

import pytest
from sqlalchemy import select

from plugins.bank.controller.sync_plan_controller import PlanInput
from plugins.bank.entity.do.bank_do import QbSyncCycle, QbSyncJob, QbSyncJobScope, QbSyncPlan
from plugins.bank.service import sync_plans as plans
from plugins.bank.service.incremental_import import _new_import
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_subject_sync_workflow import registered_plan, tick


def test_round_decisions_keep_end_reasons_apart():
    decide = plans.settle_round
    assert decide(eligible_count=155, problem_count=0, new_questions=0, new_relations=0, round_no=3, max_rounds=None) == 'no_new'
    assert decide(eligible_count=155, problem_count=2, new_questions=0, new_relations=0, round_no=1, max_rounds=None) == 'no_new_with_issues'
    assert decide(eligible_count=2, problem_count=2, new_questions=0, new_relations=0, round_no=1, max_rounds=None) == 'no_runnable_books'
    assert decide(eligible_count=0, problem_count=0, new_questions=0, new_relations=0, round_no=1, max_rounds=None) == 'no_runnable_books'
    # A relation to an already-known question is useful growth on its own.
    assert decide(eligible_count=5, problem_count=0, new_questions=0, new_relations=4, round_no=1, max_rounds=None) == 'continue'
    assert decide(eligible_count=5, problem_count=0, new_questions=200, new_relations=0, round_no=2, max_rounds=2) == 'round_limit'


def test_effective_page_limit_never_exceeds_window():
    assert plans.effective_page_limit(10000) == 1000
    assert plans.effective_page_limit(500) == 500
    assert plans.effective_page_limit(None) == 1000


async def _finish_round(db, plan_id, *, inserted, relations, import_status='completed'):
    plan = await db.get(QbSyncPlan, plan_id, populate_existing=True)
    jobs = (await db.scalars(select(QbSyncJob).where(
        QbSyncJob.task_module == 'question',
        QbSyncJob.options_json['autoCycleNo'].as_integer() == plan.cycle_no))).all()
    assert jobs
    now = datetime.utcnow().replace(microsecond=0)
    for offset, job in enumerate(jobs):
        scope = await db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == job.run_id))
        job.status = job.phase = 'completed'
        job.snapshot_complete = 1
        job.dispatch_book_key = None
        job.active_slot = None
        scope.status = 'completed'
        scope.collector_run_id = 1000 + job.run_id
        scope.snapshot_complete = 1
        scope.snapshot_locked_at = now
        row = _new_import(scope, now)
        row.status = import_status
        row.accepted_count = 3
        row.stats_json = {**row.stats_json,
                          'questions': {'inserted': inserted if offset == 0 else 0, 'updated': 0, 'unchanged': 3},
                          'questionCatalogs': {'inserted': relations if offset == 0 else 0, 'updated': 0, 'unchanged': 3}}
        db.add(row)
    await db.commit()
    await tick(db, plan_id)


@pytest.mark.asyncio
async def test_rounds_continue_while_growing_then_sleep_on_no_new(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    plan_id, discovery_id = await registered_plan(bank_db)
    plan = await bank_db.get(QbSyncPlan, plan_id)
    assert (plan.session_no, plan.session_round, plan.cycle_no) == (1, 1, 1)

    await _finish_round(bank_db, plan_id, inserted=5000, relations=5100)
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    # Same session, next round, no second discovery and no sleep.
    assert (plan.session_no, plan.session_round, plan.cycle_no) == (1, 2, 2)
    assert plan.cycle_state == 'running' and plan.next_cycle_at is None
    assert plan.discovery_processed_task_id == discovery_id and plan.discovery_task_id is None
    await tick(bank_db, plan_id)
    second = (await bank_db.scalars(select(QbSyncJob).where(
        QbSyncJob.options_json['autoCycleNo'].as_integer() == 2))).all()
    assert len(second) == 2 and all('第 1 次同步' in j.options_json['autoCycleName'] for j in second)

    await _finish_round(bank_db, plan_id, inserted=0, relations=0)
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    assert plan.cycle_state == 'completed' and plan.session_end_reason == 'no_new'
    assert (plan.next_cycle_at - plan.cycle_finished_at).days == plan.refresh_days
    history = (await plans.cycle_history(bank_db, plan_id))['rows']
    assert [(r['sessionNo'], r['roundNo'], r['endReason']) for r in history] == [(1, 2, 'no_new'), (1, 1, None)]
    assert history[1]['summary']['newQuestionCount'] == 5000 and history[1]['summary']['newRelationCount'] == 5100
    assert history[1]['summary']['decision'] == 'continue'


@pytest.mark.asyncio
async def test_unsettled_import_blocks_zero_new_settlement(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    plan_id, _ = await registered_plan(bank_db)
    await _finish_round(bank_db, plan_id, inserted=0, relations=0, import_status='queued')
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    assert plan.cycle_state == 'running' and plan.session_end_reason is None
    cycle = await bank_db.scalar(select(QbSyncCycle).where(QbSyncCycle.plan_id == plan_id))
    assert cycle.status == 'running' and cycle.summary_json['waitingImportTaskIds']


@pytest.mark.asyncio
async def test_round_limit_sleeps_even_with_growth(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    plan_id, _ = await registered_plan(bank_db)
    plan = await bank_db.get(QbSyncPlan, plan_id)
    await plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True, listConcurrency=1,
                                             expectedRevision=plan.revision, maxRounds=1))
    await _finish_round(bank_db, plan_id, inserted=10, relations=10)
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    assert plan.cycle_state == 'completed' and plan.session_end_reason == 'round_limit'
    assert plan.max_rounds == 1
    # Saving without the field keeps the configured limit.
    await plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True, listConcurrency=1, expectedRevision=plan.revision))
    assert (await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)).max_rounds == 1


@pytest.mark.asyncio
async def test_plan_dump_reports_session_and_effective_window(bank_db):
    result = await plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=False, catalogPageLimit=10000))
    assert result['catalogPageLimit'] == 10000 and result['effectiveCatalogPageLimit'] == 1000
    assert result['sessionNo'] == 0 and result['maxRounds'] is None


@pytest.mark.asyncio
async def test_discovery_failure_continues_known_list_marked_not_refreshed(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    plan_id, _ = await registered_plan(bank_db)
    await _finish_round(bank_db, plan_id, inserted=0, relations=0)
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    assert plan.session_end_reason == 'no_new'
    plan.next_cycle_at = datetime.utcnow().replace(microsecond=0)
    await bank_db.commit()
    await tick(bank_db, plan_id)
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    discovery = await bank_db.get(QbSyncJob, plan.discovery_task_id)
    discovery.status = discovery.phase = 'failed'
    discovery.error_message = '教材列表 HTTP 405'
    discovery.active_slot = None
    discovery.dispatch_book_key = None
    await bank_db.commit()
    await tick(bank_db, plan_id)
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    assert plan.cycle_state == 'running' and plan.session_no == 2 and plan.session_round == 1
    cycle = await bank_db.scalar(select(QbSyncCycle).where(QbSyncCycle.plan_id == plan_id, QbSyncCycle.cycle_no == plan.cycle_no))
    assert cycle.summary_json['discoveryFailed'] and cycle.summary_json['note'] == '发现失败，清单未刷新'


@pytest.mark.asyncio
async def test_discovery_protection_keeps_waiting_instead_of_using_old_list(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    plan_id, _ = await registered_plan(bank_db)
    await _finish_round(bank_db, plan_id, inserted=0, relations=0)
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    plan.next_cycle_at = datetime.utcnow().replace(microsecond=0)
    await bank_db.commit()
    await tick(bank_db, plan_id)
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    discovery = await bank_db.get(QbSyncJob, plan.discovery_task_id)
    discovery.status = discovery.phase = 'blocked'
    discovery.error_message = '站点返回验证/防护页面，任务已熔断。'
    discovery.active_slot = None
    discovery.dispatch_book_key = None
    await bank_db.commit()
    await tick(bank_db, plan_id)
    plan = await bank_db.get(QbSyncPlan, plan_id, populate_existing=True)
    assert plan.cycle_state == 'discovering' and plan.session_round == 0


@pytest.mark.asyncio
async def test_books_report_rounds_taken_part_in_current_session(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    plan_id, _ = await registered_plan(bank_db)
    await _finish_round(bank_db, plan_id, inserted=1, relations=0)
    await tick(bank_db, plan_id)
    books = await plans.list_books(bank_db, plan_id)
    assert all(b['sessionRounds'] == [1, 2] for b in books)


@pytest.mark.asyncio
async def test_session_log_lists_rounds_with_stage_counts(bank_db, monkeypatch):
    monkeypatch.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    plan_id, _ = await registered_plan(bank_db)
    await _finish_round(bank_db, plan_id, inserted=7, relations=9)
    await tick(bank_db, plan_id)
    log = await plans.session_log(bank_db, plan_id)
    assert log['sessionNo'] == 1 and [r['roundNo'] for r in log['rounds']] == [1, 2]
    first = log['rounds'][0]
    assert first['decision'] == 'continue' and first['newQuestionCount'] == 7 and first['newRelationCount'] == 9
    assert sum(first['collection'].values()) == 2 and first['imports']['count'] == 2
    assert log['newQuestionCount'] == 7 and log['rounds'][1]['status'] == 'running'
