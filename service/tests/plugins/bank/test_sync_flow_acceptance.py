from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from plugins.bank.entity.do.bank_do import QbSyncJob, QbSyncJobScope, QbSyncPlan
from plugins.bank.service import sync_dispatch, sync_plans
from plugins.bank.service.incremental_import import _new_import
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_subject_sync_workflow import registered_plan, tick


async def finish_book(
    db, job, *, status='completed', new=0, import_status='completed', complete=True, error=None, failed_pages=0
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    job.status = job.phase = status
    job.started_at = now
    job.finished_at = now
    job.active_slot = None
    job.dispatch_book_key = None
    job.error_message = error
    job.snapshot_complete = int(complete)
    scope = await db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == job.run_id))
    scope.status = status
    scope.collector_run_id = 1000 + job.run_id
    scope.snapshot_locked_at = now
    scope.snapshot_complete = int(complete)
    scope.question_count = 3
    scope.error_message = error
    imp = _new_import(scope, now)
    imp.status = import_status
    imp.accepted_count = 3
    imp.cursor = 3
    imp.stats_json = {**imp.stats_json, 'questions': {'inserted': new}, 'questionCatalogs': {'inserted': 0}}
    imp.run_coverage_json = {
        'scan': {'failedPageCount': failed_pages, 'parseErrorCount': 0, 'catalogSelectionTruncated': False}
    }
    db.add(imp)
    await db.commit()


async def setup(db, mp):
    mp.setenv('BANK_AUTOMATIC_SYNC_ENABLED', '1')
    pid, _ = await registered_plan(db)
    jobs = list(
        (
            await db.scalars(select(QbSyncJob).where(QbSyncJob.task_module == 'question').order_by(QbSyncJob.run_id))
        ).all()
    )
    return pid, jobs


@pytest.mark.asyncio
async def test_doc_local_parse_failure_is_not_automatically_requeued_next_round(bank_db, monkeypatch):
    pid, jobs = await setup(bank_db, monkeypatch)
    failed_id = jobs[0].run_id
    reservation = jobs[0].dispatch_book_key
    await finish_book(bank_db, jobs[0], status='failed', complete=False, error='目录 ID 重复：4712')
    jobs[0].dispatch_book_key = reservation
    await bank_db.commit()
    assert await sync_dispatch.release_finished_books(bank_db) >= 1
    await finish_book(bank_db, jobs[1], new=1)
    await tick(bank_db, pid)
    await tick(bank_db, pid)
    next_jobs = list(
        (
            await bank_db.scalars(
                select(QbSyncJob).where(
                    QbSyncJob.task_module == 'question', QbSyncJob.options_json['autoCycleNo'].as_integer() == 2
                )
            )
        ).all()
    )
    old_scope = await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == failed_id))
    new_books = list(
        (
            await bank_db.scalars(
                select(QbSyncJobScope.local_textbook_id).where(QbSyncJobScope.run_id.in_([j.run_id for j in next_jobs]))
            )
        ).all()
    )
    assert old_scope.local_textbook_id not in new_books, f'failed book still scheduled: {new_books}'


@pytest.mark.asyncio
async def test_doc_last_book_source_challenge_keeps_session_waiting(bank_db, monkeypatch):
    pid, jobs = await setup(bank_db, monkeypatch)
    await finish_book(bank_db, jobs[0])
    await finish_book(
        bank_db, jobs[1], status='blocked', complete=False, error='题目列表返回验证/防护：目录 5289 第 25 页'
    )

    class Paused:
        def health(self):
            return {'ok': True, 'sourceControl': {'paused': True, 'manualRequired': True, 'reason': '来源需要验证'}}

    plan = await bank_db.get(QbSyncPlan, pid)
    plan.next_check_at = None
    await bank_db.commit()
    await sync_plans.tick_plan(bank_db, pid, client=Paused())
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.cycle_state == 'running' and plan.session_end_reason is None, (
        plan.cycle_state,
        plan.session_end_reason,
    )


@pytest.mark.asyncio
async def test_doc_zero_new_but_recoverable_page_gap_does_not_sleep(bank_db, monkeypatch):
    pid, jobs = await setup(bank_db, monkeypatch)
    for job in jobs:
        await finish_book(
            bank_db,
            job,
            complete=False,
            import_status='partial',
            error='第 301 页请求超时，302～308 页已保存',
            failed_pages=1,
        )
    await tick(bank_db, pid)
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.cycle_state == 'running', (plan.cycle_state, plan.session_end_reason)
    assert plan.session_round == 1
    retries = list((await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.retry_of_run_id.is_not(None)))).all())
    assert len(retries) == 1 and retries[0].options_json['planGapRetryCount'] == 1


@pytest.mark.asyncio
async def test_doc_wait_for_current_book_import_before_claiming_next(bank_db, monkeypatch):
    pid, jobs = await setup(bank_db, monkeypatch)
    await finish_book(bank_db, jobs[0], import_status='queued')
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from plugins.bank.service import sync_run_service

    monkeypatch.setenv('BANK_MIN_MEMORY_FREE_MIB', '1')
    monkeypatch.setenv('BANK_MIN_DISK_FREE_MIB', '1')
    monkeypatch.setenv('BANK_SYNC_MAX_PENDING_IMPORTS', '2')

    class Healthy:
        def health(self):
            return {
                'ok': True,
                'resources': {'diskAndMemoryLimitsConfigured': True},
                'sourceControl': {'paused': False},
            }

    started = []

    async def execute(task_id, handle):
        started.append(task_id)

    monkeypatch.setattr(sync_run_service, '_execute', execute)
    await bank_db.rollback()
    result = await sync_dispatch.dispatch_once(
        session_factory=async_sessionmaker(bank_db.bind, expire_on_commit=False), client=Healthy()
    )
    import asyncio

    await asyncio.sleep(0)
    assert result == 0, f'next book started while previous import is queued: {started}'


@pytest.mark.asyncio
async def test_doc_explicit_start_waits_for_running_supplement(bank_db, monkeypatch):
    from plugins.bank.controller.sync_plan_controller import PlanAction, SingleBook
    from plugins.bank.service import plan_control

    pid, jobs = await setup(bank_db, monkeypatch)
    for job in jobs:
        await finish_book(bank_db, job)
    await tick(bank_db, pid)
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    previous_session = plan.session_no
    await plan_control.sync_book_once(bank_db, pid, 1, SingleBook(expectedRevision=plan.revision), 'teacher')
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    from exceptions.exception import ServiceException

    with pytest.raises(ServiceException, match='单本补采尚未完成'):
        await plan_control.action(bank_db, pid, PlanAction(action='start', expectedRevision=plan.revision), 'teacher')
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.session_no == previous_session, 'whole-subject session started before supplement settlement'


@pytest.mark.asyncio
@pytest.mark.parametrize('sampled_pause', [True, False])
async def test_verified_source_resumes_same_session_after_saved_import(bank_db, monkeypatch, sampled_pause):
    from plugins.bank.service.sync_run_service import SyncRunService

    pid, jobs = await setup(bank_db, monkeypatch)
    await finish_book(bank_db, jobs[0])
    await finish_book(bank_db, jobs[1], status='blocked', complete=False, error='来源防护')

    class Source:
        paused = True

        def health(self):
            return {'ok': True, 'sourceControl': {'paused': self.paused, 'reason': '来源防护'}}

    source = Source()
    calls = []

    async def resume(db, task_id):
        calls.append(task_id)
        job = await db.get(QbSyncJob, task_id)
        job.status = 'queued'

    monkeypatch.setattr(SyncRunService, 'resume_question', resume)
    for _ in range(2 if sampled_pause else 0):
        plan = await bank_db.get(QbSyncPlan, pid)
        plan.next_check_at = None
        await bank_db.commit()
        await sync_plans.tick_plan(bank_db, pid, client=source)
    assert calls == []
    source.paused = False  # Represents the explicit source verification/resume action.
    plan = await bank_db.get(QbSyncPlan, pid)
    plan.next_check_at = None
    await bank_db.commit()
    await sync_plans.tick_plan(bank_db, pid, client=source)
    assert calls == [jobs[1].run_id]
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert (plan.session_no, plan.session_round, plan.cycle_state) == (1, 1, 'running')


@pytest.mark.asyncio
async def test_page_gap_retry_exhaustion_isolates_without_endless_rounds(bank_db, monkeypatch):
    from plugins.bank.entity.do.bank_do import QbSyncBookState, QbSyncCycle

    pid, jobs = await setup(bank_db, monkeypatch)
    await finish_book(bank_db, jobs[0], complete=False, import_status='partial', failed_pages=1)
    jobs[0].options_json = {**jobs[0].options_json, 'planGapRetryCount': 3}
    await bank_db.commit()
    await finish_book(bank_db, jobs[1])
    await tick(bank_db, pid)
    await tick(bank_db, pid)
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    state = await bank_db.scalar(
        select(QbSyncBookState).where(QbSyncBookState.plan_id == pid, QbSyncBookState.textbook_id == 1)
    )
    assert state.exception_kind == 'scope_failure'
    assert plan.session_end_reason == 'no_new_with_issues'
    cycle = await bank_db.scalar(select(QbSyncCycle).where(QbSyncCycle.plan_id == pid))
    assert cycle.summary_json['checkedCount'] == 1
    assert cycle.summary_json['problemTextbookIds'] == [1]


@pytest.mark.asyncio
async def test_partial_quality_result_without_page_gaps_can_sleep(bank_db, monkeypatch):
    pid, jobs = await setup(bank_db, monkeypatch)
    for job in jobs:
        await finish_book(bank_db, job, complete=False, import_status='partial')
    await tick(bank_db, pid)
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.session_end_reason == 'no_new'
    assert not list((await bank_db.scalars(select(QbSyncJob).where(QbSyncJob.retry_of_run_id.is_not(None)))).all())


@pytest.mark.asyncio
async def test_next_book_dispatches_after_import_settles(bank_db, monkeypatch):
    from plugins.bank.entity.do.bank_do import QbQuestionImport

    pid, jobs = await setup(bank_db, monkeypatch)
    await finish_book(bank_db, jobs[0], import_status='queued')
    assert await sync_dispatch.claim_next(bank_db) is None
    from plugins.bank.service.plan_control import plan_queue

    queue = await plan_queue(bank_db, pid)
    assert queue['current']['taskId'] == jobs[0].run_id and queue['current']['settling']
    assert queue['next']['taskId'] == jobs[1].run_id
    imported = await bank_db.scalar(select(QbQuestionImport).where(QbQuestionImport.task_id == jobs[0].run_id))
    imported.status = 'completed'
    await bank_db.commit()
    await sync_dispatch.release_finished_books(bank_db)
    jobs[1].dispatch_not_before = None
    await bank_db.commit()
    assert (await sync_dispatch.claim_next(bank_db))['taskId'] == jobs[1].run_id


@pytest.mark.asyncio
async def test_matching_repaired_scan_removes_automatic_isolation(bank_db, monkeypatch):
    from plugins.bank.entity.do.bank_do import QbQuestionImport, QbSyncBookState
    from plugins.bank.service.sync_issues import isolate_scope_failure, resolve_scope_issues

    pid, jobs = await setup(bank_db, monkeypatch)
    await finish_book(bank_db, jobs[0], status='failed', error='目录 ID 重复：4712')
    scope = await bank_db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == jobs[0].run_id))
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    await isolate_scope_failure(bank_db, jobs[0], scope, jobs[0].error_message, now)
    state = await bank_db.scalar(
        select(QbSyncBookState).where(QbSyncBookState.plan_id == pid, QbSyncBookState.textbook_id == 1)
    )
    assert state.exception_kind == 'scope_failure'
    imported = await bank_db.scalar(select(QbQuestionImport).where(QbQuestionImport.task_id == jobs[0].run_id))
    imported.run_coverage_json = {
        'scan': {
            'targetsKnown': True,
            'selectedCatalogCount': 1,
            'scanCompletedCatalogCount': 1,
            'unscannedCatalogCount': 0,
            'catalogSelectionTruncated': False,
            'failedPageCount': 0,
            'duplicatePageCount': 0,
            'parseErrorCount': 0,
        }
    }
    jobs[0].status = 'completed'
    await bank_db.commit()
    await resolve_scope_issues(bank_db, jobs[0], scope, now)
    assert state.exception_kind is None


@pytest.mark.asyncio
@pytest.mark.parametrize('blocker', ['resource', 'service'])
async def test_shared_failure_does_not_settle_round(bank_db, monkeypatch, blocker):
    from exceptions.exception import ServiceException

    pid, jobs = await setup(bank_db, monkeypatch)
    for job in jobs:
        await finish_book(bank_db, job)

    class Collector:
        def health(self):
            if blocker == 'service':
                raise ServiceException(message='采集器暂不可用')
            return {'ok': True, 'resources': {'paused': True, 'reason': '采集主机可用内存低于保留水位'}}

    plan = await bank_db.get(QbSyncPlan, pid)
    plan.next_check_at = None
    await bank_db.commit()
    await sync_plans.tick_plan(bank_db, pid, client=Collector())
    plan = await bank_db.get(QbSyncPlan, pid, populate_existing=True)
    assert plan.cycle_state == 'running' and plan.session_end_reason is None


@pytest.mark.asyncio
async def test_source_block_in_middle_resumes_before_next_book(bank_db, monkeypatch):
    from plugins.bank.service.sync_run_service import SyncRunService

    pid, jobs = await setup(bank_db, monkeypatch)
    key = jobs[0].dispatch_book_key
    await finish_book(bank_db, jobs[0], status='blocked', complete=False, error='题目列表返回验证/防护')
    jobs[0].dispatch_book_key = key
    await bank_db.commit()
    await sync_dispatch.release_finished_books(bank_db)
    assert jobs[0].options_json['planSourceResumePending']
    assert await sync_dispatch.claim_next(bank_db) is None
    calls = []

    async def resume(db, task_id):
        calls.append(task_id)
        job = await db.get(QbSyncJob, task_id)
        job.status = 'queued'
        job.dispatch_book_key = key

    monkeypatch.setattr(SyncRunService, 'resume_question', resume)

    class Verified:
        def health(self):
            return {'ok': True, 'sourceControl': {'paused': False}}

    plan = await bank_db.get(QbSyncPlan, pid)
    plan.next_check_at = None
    await bank_db.commit()
    await sync_plans.tick_plan(bank_db, pid, client=Verified())
    assert calls == [jobs[0].run_id]
    assert (await sync_dispatch.claim_next(bank_db))['taskId'] == jobs[0].run_id
