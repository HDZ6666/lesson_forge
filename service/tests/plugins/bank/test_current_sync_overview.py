"""The sync dashboard reports the current execution, never formal-bank stock."""

import json
from datetime import datetime

import pytest
from sqlalchemy import select

from plugins.bank.controller.sync_overview_controller import overview
from plugins.bank.controller.sync_plan_controller import PlanInput
from plugins.bank.entity.do.bank_do import QbQuestionImport, QbSyncCycle, QbSyncJob, QbSyncJobScope, QbSyncPlan
from plugins.bank.service import sync_plans
from plugins.bank.service.sync_issues import observe
from plugins.bank.service.task_service import SyncTaskService
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db


@pytest.mark.asyncio
async def test_current_session_does_not_inherit_old_results_issues_or_targets(bank_db):
    saved = await sync_plans.save_plan(bank_db, PlanInput(subjectId=1, enabled=True))
    plan_id = saved['planId']
    plan = await bank_db.get(QbSyncPlan, plan_id)
    now = datetime.utcnow()
    plan.session_no = 2
    plan.session_round = 1
    plan.cycle_no = 2
    plan.cycle_targets = [1]
    plan.cycle_state = 'completed'
    for number, targets in ((1, [1, 2]), (2, [1])):
        bank_db.add(QbSyncCycle(plan_id=plan_id, cycle_no=number, cycle_name=f'cycle-{number}',
                               session_no=number, round_no=1, status='completed', targets=targets,
                               summary_json={}, started_at=now, finished_at=now))
    await bank_db.commit()
    task_ids = []
    for number, book, count, accepted, inserted in ((1, 2, 10000, 9000, 8000), (2, 1, 10, 7, 3)):
        created = await SyncTaskService.create_question(bank_db, {'versionId': 1, 'textbookId': book}, 'teacher')
        task_id = created['taskId']
        task_ids.append(task_id)
        job = await bank_db.get(QbSyncJob, task_id)
        job.options_json = {**job.options_json, 'autoPlanId': plan_id, 'autoCycleNo': number,
                            'snapshotReclaimed': number == 1}
        job.status = job.phase = 'completed'
        job.active_slot = job.dispatch_book_key = None
        scope = await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == task_id))
        scope.question_count = count
        bank_db.add(QbQuestionImport(task_id=task_id, scope_id=scope.scope_id, subject_id=1,
            source_provider='zujuan', local_textbook_id=book, external_textbook_id=f'tb{book}',
            collector_run_id=number, snapshot_locked_at=now, snapshot_complete=0,
            identity_hash=str(number) * 64, question_count=count, cursor=accepted,
            accepted_count=accepted, status='queued' if number == 1 else 'partial', stage='completed',
            stats_json={'questions': {'inserted': inserted}, 'questionCatalogs': {'inserted': inserted + 1},
                        'spoolReclaimed': number == 1}, create_time=now, update_time=now))
        await bank_db.commit()
    for task_id, book, key in ((task_ids[0], 2, 'old'), (task_ids[1], 1, 'current'),
                               (task_ids[0], 1, 'shared'), (task_ids[1], 1, 'shared'),
                               (task_ids[0], 1, 'shared')):
        await observe(bank_db, subject_id=1, provider='zujuan', book_id=book, task_id=task_id,
                      kind='scope', key=key, error_type='scope_failure', reason='目录缺失', evidence={}, now=now)
        await bank_db.commit()
    value = json.loads((await overview(bank_db, subject_id=1)).body)['data']
    assert value['textbooks'] == 1
    assert value['savedQuestionCount'] == 10 and value['acceptedQuestionCount'] == 7
    assert value['newQuestionCount'] == 3 and value['newRelationCount'] == 4
    assert value['openIssueCount'] == 2 and value['issueCounts'] == {'open': 2}
    assert value['taskCounts'] == {'completed': 1}
    assert [row['taskId'] for row in value['recentTasks']] == [task_ids[1]]
    assert value['pendingImportCount'] == 0 and value['currentImport'] is None
    assert value['cleanup'] == {'runs': 0, 'spools': 0}
    assert value['cycleTargetCount'] == 1
    assert 'storage' not in value and 'textbooksWithQuestions' not in value

    # A new session can start discovery before it has any cycle row. The
    # old plan fields are still stored, but are not new-session statistics.
    plan = await bank_db.get(QbSyncPlan, plan_id)
    plan.session_no = 3
    plan.cycle_state = 'discovering'
    await bank_db.commit()
    value = json.loads((await overview(bank_db, subject_id=1)).body)['data']
    assert value['textbooks'] == value['cycleTargetCount'] == 0
    assert value['savedQuestionCount'] == value['acceptedQuestionCount'] == 0
    assert value['openIssueCount'] == 0 and value['recentTasks'] == []
    assert value['taskCounts'] == {} and value['currentImport'] is None


@pytest.mark.asyncio
async def test_discovery_is_visible_before_round_without_counting_library(bank_db):
    saved = await sync_plans.save_plan(bank_db, PlanInput(subjectId=1))
    plan = await bank_db.get(QbSyncPlan, saved['planId'])
    now = datetime.utcnow()
    job = QbSyncJob(subject_id=1, task_module='textbook', run_type='metadata', status='running', phase='metadata',
                    acknowledge_source_policy='Y', active_slot='zujuan',
                    options_json={'autoDiscoveryPlanId': plan.plan_id, 'autoPlanId': plan.plan_id, 'autoCycleNo': 1},
                    create_time=now, update_time=now)
    bank_db.add(job)
    await bank_db.flush()
    task_id = job.run_id
    plan.discovery_task_id = task_id
    plan.session_no = 1
    plan.cycle_state = 'discovering'
    await bank_db.commit()
    value = json.loads((await overview(bank_db, subject_id=1)).body)['data']
    assert value['textbooks'] == value['savedQuestionCount'] == value['acceptedQuestionCount'] == 0
    assert value['currentTask']['taskId'] == task_id
    assert value['taskCounts'] == {'running': 1}
