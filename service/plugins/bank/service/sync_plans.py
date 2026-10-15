"""One-book cycles reuse existing jobs and dispatch; no second collection pipeline."""

import asyncio
import collections
import os
import re
import secrets
from datetime import timedelta, timezone

from sqlalchemy import func, or_, select, update

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbQuestionImport,
    QbQuestionImportIntake,
    QbSyncBookState,
    QbSyncControl,
    QbSyncCycle,
    QbSyncIssue,
    QbSyncIssueTask,
    QbSyncJob,
    QbSyncJobScope,
    QbSyncPlan,
    QbSyncSupplement,
    QbTextbook,
    QbTextbookApplyState,
    QbTextbookVersion,
)
from plugins.bank.service.coverage_queries import book_stem_counts
from plugins.bank.service.import_dates import utc_datetime
from plugins.bank.service.incremental_import import _clock
from plugins.bank.service.resource_guard import configured_limit, resource_status
from plugins.bank.service.subject_service import SubjectService

TERMINAL = ('completed', 'failed', 'blocked', 'cancelled', 'interrupted')
# Each catalog only reads the provider's currently reachable first 1000 pages.
CATALOG_WINDOW_PAGES = 1000
# Why a sync session ended. Kept separate from plan control and blockers.
END_REASONS = ('no_new', 'no_new_with_issues', 'no_runnable_books', 'round_limit', 'user_end')
UNSETTLED_IMPORT = ('queued', 'preparing', 'running', 'paused')
UNSETTLED_INTAKE = ('pending', 'probing', 'retry')
_SOURCE_PROTECTION = re.compile(r'验证|防护|滑块|captcha|challenge', re.I)


def effective_page_limit(limit):
    """Legacy limits above the window stay stored but never request page 1001."""
    return min(int(limit or CATALOG_WINDOW_PAGES), CATALOG_WINDOW_PAGES)


def _event(kind, plan, **fields):
    from plugins.bank.service import diagnostics
    diagnostics.event(kind, stage='plan', planId=plan.plan_id, sessionNo=plan.session_no,
                      roundNo=plan.session_round, cycleNo=plan.cycle_no, **fields)


def begin_session(plan, now):
    """Open a new sync session; rounds inside it restart from 1."""
    plan.session_no = (plan.session_no or 0) + 1
    plan.session_round = 0
    plan.session_started_at = now
    plan.session_end_reason = None
    plan.session_mode = None
    _event('sync_session_started', plan)


def import_stat(stats, bucket):
    return int(((stats or {}).get(bucket) or {}).get('inserted') or 0)


def settle_round(*, eligible_count, problem_count, new_questions, new_relations, round_no, max_rounds):
    """Decide what follows a fully settled round.

    Effective growth is formal MySQL inserts only: new questions plus new
    question-catalog relations. Updates, re-accepted rows and request counts
    never extend a session.
    """
    if max_rounds and round_no >= max_rounds:
        return 'round_limit'
    if new_questions + new_relations > 0:
        return 'continue'
    if eligible_count == 0 or problem_count >= eligible_count:
        return 'no_runnable_books'
    if problem_count:
        return 'no_new_with_issues'
    return 'no_new'


async def control_status(db):
    row = await db.get(QbSyncControl, 1)
    return {
        'paused': bool(row and row.paused),
        'reason': row.reason if row else None,
        'revision': row.revision if row else 1,
        'updateTime': utc_datetime(row.update_time) if row else None,
        # The one public host-resource wait; shown instead of per-book errors.
        'resourceWait': (row.resource_wait_json or None) if row else None,
    }


async def set_control(db, paused, revision, reason, operator):
    row = await db.get(QbSyncControl, 1, with_for_update=True, populate_existing=True)
    if row is None or row.revision != revision:
        raise ServiceException(message='公共暂停状态已变化，请刷新')
    row.paused = int(paused)
    row.reason = reason if paused else None
    row.revision += 1
    row.updated_by = operator
    row.update_time = await _clock(db)
    active = (
        list((await db.scalars(select(QbSyncJob.run_id).where(QbSyncJob.active_slot.is_not(None)))).all())
        if paused
        else []
    )
    await db.commit()
    # Persist pause before signalling a running collector. If cancellation
    # fails, the pause remains visible and a retry can stop the same task.
    if active:
        from plugins.bank.service.sync_run_service import SyncRunService

        for task_id in active:
            await SyncRunService.cancel(db, task_id)
    return await control_status(db)


def unattended_reason(health):
    if os.getenv('BANK_AUTOMATIC_SYNC_ENABLED') != '1':
        return '全教材自动运行尚未启用'
    resources = health.get('resources') or {}
    if not resources.get('diskAndMemoryLimitsConfigured'):
        return '请先配置采集主机资源水位'
    if not all(
        configured_limit(name) > 0
        for name in (
            'BANK_MIN_DISK_FREE_MIB',
            'BANK_MIN_MEMORY_FREE_MIB',
        )
    ):
        return '请先配置入库主机资源水位'
    local = resource_status().get('reason')
    control = health.get('sourceControl') or {}
    return local or (control.get('reason') or '来源公共暂停' if control.get('paused') else None)


def plan_dump(row):
    return {
        'planId': row.plan_id,
        'subjectId': row.subject_id,
        'planName': row.plan_name,
        'listConcurrency': row.list_concurrency,
        'catalogPageLimit': row.catalog_page_limit,
        'effectiveCatalogPageLimit': effective_page_limit(row.catalog_page_limit),
        'sessionNo': row.session_no or 0,
        'sessionRound': row.session_round or 0,
        'maxRounds': row.max_rounds,
        'sessionStartedAt': utc_datetime(row.session_started_at),
        'sessionEndReason': row.session_end_reason,
        'sessionMode': row.session_mode or 'incremental',
        'cycleName': row.cycle_name,
        'enabled': bool(row.enabled),
        'autoUpdate': bool(row.auto_update),
        'controlState': row.control_state,
        'cycleState': row.cycle_state,
        'cycleFinishedAt': utc_datetime(row.cycle_finished_at),
        'nextCycleAt': utc_datetime(row.next_cycle_at),
        'refreshDays': row.refresh_days,
        'refillHours': row.refill_hours,
        'discoveryDays': row.discovery_days,
        'cycleNo': row.cycle_no,
        'cycleTargetCount': len(row.cycle_targets or []),
        'cycleStartedAt': utc_datetime(row.cycle_started_at),
        'nextCheckAt': utc_datetime(row.next_check_at),
        'discoveryTaskId': row.discovery_task_id,
        'lastDiscoveryTaskId': row.discovery_task_id or row.discovery_processed_task_id or None,
        'discoveryNextAt': utc_datetime(row.discovery_next_at),
        'discoveryError': row.discovery_error,
        # What a discovery failure means now (R13): no list yet, source
        # protection (public wait), or an ordinary failure that continues the
        # known list unrefreshed.
        'discoveryFailure': discovery_failure(row),
        'revision': row.revision,
    }


def discovery_failure(row):
    if not row.discovery_error:
        return None
    if _SOURCE_PROTECTION.search(row.discovery_error):
        return 'source_protection'
    if not row.textbook_order:
        return 'no_list'
    return 'stale_list'


async def list_plans(db, subject_id=None):
    query = select(QbSyncPlan).order_by(QbSyncPlan.plan_id)
    if subject_id is not None:
        query = query.where(QbSyncPlan.subject_id == subject_id)
    rows = (await db.scalars(query)).all()
    result = []
    for row in rows:
        value = plan_dump(row)
        task_id = row.discovery_task_id or row.discovery_processed_task_id
        task = await db.get(QbSyncJob, task_id) if task_id else None
        if task:
            from plugins.bank.service.sync_dispatch import queue_fields
            options = task.options_json or {}
            value.update(discoveryStatus=task.status, discoveryRegistered=bool(options.get('discoveryResult')),
                         discoveryQueueReason=queue_fields(task).get('queueReason'),
                         discoveryError=value['discoveryError'] or options.get('discoveryError'))
        result.append(value)
    return result


async def save_plan(db, payload):
    subject = await SubjectService.require(db, payload.subject_id, sync=True)
    row = await db.scalar(select(QbSyncPlan).where(QbSyncPlan.subject_id == subject.subject_id).with_for_update())
    if row is None:
        if payload.expected_revision is not None:
            raise ServiceException(message='计划不存在，请刷新')
        row = QbSyncPlan(
            subject_id=subject.subject_id,
            cycle_targets=[],
            cycle_no=0,
            revision=1,
            enabled=0,
            auto_update=1,control_state='active' if payload.enabled else 'paused',cycle_state='idle',textbook_order=[],
            update_time=await _clock(db),
        )
        db.add(row)
    else:
        if row.revision != payload.expected_revision:
            raise ServiceException(message='计划已被修改，请刷新后重试')
        row.revision += 1
    name = payload.plan_name.strip() if payload.plan_name is not None else row.plan_name or f'{subject.subject_name}同步'
    if not name:
        raise ServiceException(message='计划名称不能为空')
    row.auto_update=int(payload.auto_update)
    if row.cycle_state in ('completed','stopped') and row.cycle_finished_at:
        row.next_cycle_at=row.cycle_finished_at+timedelta(days=payload.refresh_days) if row.auto_update else None
    row.list_concurrency = payload.list_concurrency
    if 'max_rounds' in payload.model_fields_set:
        row.max_rounds = payload.max_rounds  # None means unlimited rounds.
    row.catalog_page_limit = payload.catalog_page_limit
    row.plan_name = name
    row.enabled = int(payload.enabled)
    row.refresh_days, row.refill_hours, row.discovery_days = (
        payload.refresh_days,
        payload.refill_hours,
        payload.discovery_days,
    )
    row.next_check_at = None
    row.update_time = await _clock(db)
    await db.flush()
    # Only rewrite requests which have never been sent. A dispatched UUID
    # must retain its original settings even if its acknowledgement was lost.
    waiting = (await db.scalars(select(QbSyncJob).where(
        QbSyncJob.task_module == 'question', QbSyncJob.status == 'queued',
        QbSyncJob.active_slot.is_(None), QbSyncJob.worker_token.is_(None),
        QbSyncJob.collector_job_id.is_(None), QbSyncJob.started_at.is_(None),
        (QbSyncJob.options_json['autoPlanId'].as_integer() == row.plan_id)
        | (QbSyncJob.options_json['manualPlanId'].as_integer() == row.plan_id),
    ).with_for_update())).all()
    for task in waiting:
        task.options_json = {**(task.options_json or {}),
                             'catalogPageLimit': row.catalog_page_limit, 'limitTo1000Pages': False}
    await db.commit()
    await db.refresh(row)
    return plan_dump(row)


async def list_books(db, plan_id, *, display=False):
    plan = await db.get(QbSyncPlan, plan_id)
    if plan is None:
        raise ServiceException(message='计划不存在')
    books = (
        await db.execute(
            select(QbTextbook, QbTextbookVersion.is_new, QbTextbookVersion.version_name)
            .join(QbTextbookVersion, QbTextbookVersion.version_id == QbTextbook.version_id)
            .where(QbTextbook.subject_id == plan.subject_id, QbTextbook.status == '0', QbTextbookVersion.status == '0')
            .order_by(QbTextbook.textbook_id)
        )
    ).all()
    states = {
        row.textbook_id: row
        for row in (await db.scalars(select(QbSyncBookState).where(QbSyncBookState.plan_id == plan_id))).all()
    }
    counts = {}
    for offset in range(0, len(books), 500):
        counts.update(await book_stem_counts(db, [book.textbook_id for book, _, _ in books[offset : offset + 500]], display=display))
    targets = set(plan.cycle_targets or [])
    task_progress = await _book_task_progress(db, states.values(), plan.cycle_no)
    ordered=list(plan.textbook_order or [])
    fallback=sorted(books,key=lambda item:(item[1]!='Y',item[0].textbook_id))
    ordered += [book.textbook_id for book,_,_ in fallback if book.textbook_id not in ordered]
    ranks={id:i for i,id in enumerate(ordered)}
    books.sort(key=lambda item:ranks[item[0].textbook_id])
    rounds=await _session_rounds(db,plan)
    manual_ids=[state.last_manual_task_id for state in states.values() if state.last_manual_task_id]
    manual={r.run_id:r for r in (await db.scalars(select(QbSyncJob).where(QbSyncJob.run_id.in_(manual_ids)))).all()} if manual_ids else {}
    return [
        {
            'textbookId': book.textbook_id,
            'order': ranks[book.textbook_id]+1,
            'lastFinishedAt': utc_datetime(states[book.textbook_id].last_finished_at) if book.textbook_id in states else None,
            'manualTaskId': states[book.textbook_id].last_manual_task_id if book.textbook_id in states else None,
            'manualTaskStatus': manual[states[book.textbook_id].last_manual_task_id].status if book.textbook_id in states and states[book.textbook_id].last_manual_task_id in manual else None,
            'textbookName': book.textbook_name,
            'versionId': book.version_id,
            'versionName': version_name,
            'isNew': is_new == 'Y',
            'inCurrentCycle': book.textbook_id in targets,
            'enabled': bool(states[book.textbook_id].enabled) if book.textbook_id in states else True,
            'exceptionKind': states[book.textbook_id].exception_kind if book.textbook_id in states else None,
            'operatorNote': states[book.textbook_id].operator_note if book.textbook_id in states else None,
            'lastTaskId': states[book.textbook_id].last_task_id if book.textbook_id in states else None,
            'lastCycleNo': states[book.textbook_id].last_cycle_no if book.textbook_id in states else 0,
            'nextDueAt': utc_datetime(states[book.textbook_id].next_due_at) if book.textbook_id in states else None,
            'revision': states[book.textbook_id].revision if book.textbook_id in states else 0,
            **counts.get(book.textbook_id, {'usableQuestionCount': 0}),
            **task_progress.get(book.textbook_id, {}),
            # Rounds of the current sync session this book took part in,
            # counted by round, never inferred from execution counts (A07).
            'sessionRounds': rounds.get(book.textbook_id, []),
        }
        for book, is_new, version_name in books
    ]


async def _session_rounds(db, plan):
    if not plan.session_no:
        return {}
    cycles=dict((await db.execute(select(QbSyncCycle.cycle_no,QbSyncCycle.round_no).where(
        QbSyncCycle.plan_id==plan.plan_id,QbSyncCycle.session_no==plan.session_no))).all())
    if not cycles:
        return {}
    rows=(await db.execute(select(QbSyncJobScope.local_textbook_id,QbSyncJob.options_json)
        .join(QbSyncJob,QbSyncJob.run_id==QbSyncJobScope.run_id)
        .where(QbSyncJob.task_module=='question',
               QbSyncJob.options_json['autoPlanId'].as_integer()==plan.plan_id,
               QbSyncJob.options_json['autoCycleNo'].as_integer().in_(list(cycles)),
               # Only executions that actually started take part in a round;
               # a queued or never-started cancelled task does not (spec 2).
               QbSyncJob.started_at.is_not(None)))).all()
    result={}
    for book,options in rows:
        round_no=cycles.get((options or {}).get('autoCycleNo'))
        if round_no is not None:
            result.setdefault(book,set()).add(round_no)
    return {book:sorted(values) for book,values in result.items()}


async def _book_task_progress(db, states, cycle_no):
    ids = [state.last_task_id for state in states if state.last_task_id]
    if not ids:
        return {}
    from plugins.bank.service.task_executions import attach_summary, root_id
    known = list((await db.scalars(select(QbSyncJob).where(QbSyncJob.run_id.in_(ids)))).all())
    summaries = [{'taskId': j.run_id, 'logicalTaskId': root_id(j)} for j in known]
    await attach_summary(db, summaries)
    summary_by_latest = {p['latestExecutionId']: p for p in summaries}
    ids = list(summary_by_latest)
    rows = (await db.execute(select(QbSyncJob, QbSyncJobScope, QbQuestionImport, QbQuestionImportIntake)
        .join(QbSyncJobScope, QbSyncJobScope.run_id == QbSyncJob.run_id)
        .outerjoin(QbQuestionImport, (QbQuestionImport.scope_id == QbSyncJobScope.scope_id)
                   & (QbQuestionImport.collector_run_id == QbSyncJobScope.collector_run_id))
        .outerjoin(QbQuestionImportIntake, (QbQuestionImportIntake.scope_id == QbSyncJobScope.scope_id)
                   & (QbQuestionImportIntake.collector_run_id == QbSyncJobScope.collector_run_id))
        .where(QbSyncJob.run_id.in_(ids)))).all()
    result = {}
    for job, scope, imported, intake in rows:
        stage = job.status
        from plugins.bank.service.sync_dispatch import queue_fields
        reason = queue_fields(job).get('queueReason') or job.error_message
        if imported:
            stage = {'queued': 'checking', 'preparing': 'checking', 'running': 'importing'}.get(imported.status, imported.status)
            reason = imported.error_message or reason
        elif intake:
            stage = 'failed' if intake.status in ('blocked', 'discarded') else 'checking'
            reason = intake.error_message or reason
        elif job.status in TERMINAL and scope.collector_run_id and job.dispatch_book_key:
            stage = 'checking'
        elif job.status == 'completed':
            stage = 'failed'  # A collected task without import evidence is not finished.
            reason = reason or '采集结束，尚无入库结果'
        if (job.options_json or {}).get('planWorkPaused') and (job.status not in TERMINAL or (job.options_json or {}).get('planResumePending') or stage in ('checking','importing','paused')):
            stage='paused'
            reason='学科计划已暂停，已有成果和断点保留'
        if stage in ('starting', 'running', 'cancelling'):
            stage = 'collecting'
        if stage in ('blocked', 'interrupted'):
            stage = 'failed'
        if stage == 'completed' and imported and not imported.accepted_count:
            stage = 'partial'
        result[scope.local_textbook_id] = {
            **summary_by_latest.get(job.run_id, {}),
            'lastTaskId': job.run_id,
            'taskStage': stage, 'taskReason': reason,
            'taskInCurrentCycle': (job.options_json or {}).get('autoCycleNo') == cycle_no,
            'acceptedCount': imported.accepted_count if imported else 0,
            'quarantinedCount': imported.quarantined_count if imported else 0,
            # Saved, accepted and deduplicated-new are different numbers (spec 9).
            'savedQuestionCount': int(scope.question_count or 0),
            'newQuestionCount': import_stat(imported.stats_json, 'questions') if imported else None,
            'newRelationCount': import_stat(imported.stats_json, 'questionCatalogs') if imported else None,
        }
    return result


async def retry_plan_discovery(db, plan_id, revision):
    plan = await db.get(QbSyncPlan, plan_id, with_for_update=True, populate_existing=True)
    if plan is None or plan.revision != revision:
        raise ServiceException(message='计划已变化，请刷新')
    task_id = plan.discovery_task_id or plan.discovery_processed_task_id
    task = await db.get(QbSyncJob, task_id) if task_id else None
    if task and task.status not in TERMINAL:
        return plan_dump(plan)
    if task and task.status == 'completed' and not (task.options_json or {}).get('discoveryResult'):
        options = dict(task.options_json or {})
        options.update(discoveryAttempts=0, discoveryError=None, discoveryRetryAt=None)
        task.options_json = options
        plan.discovery_task_id = task.run_id
    elif task:
        plan.discovery_processed_task_id = task.run_id
        plan.discovery_task_id = None
    plan.discovery_error = None
    plan.discovery_next_at = None
    plan.next_check_at = None
    plan.revision += 1
    await db.commit()
    return plan_dump(plan)


async def save_book_override(db, plan_id, textbook_id, payload):
    plan = await db.get(QbSyncPlan, plan_id, with_for_update=True)
    book = await db.get(QbTextbook, textbook_id)
    if plan is None or book is None or book.subject_id != plan.subject_id:
        raise ServiceException(message='教材不属于当前计划')
    row = await db.scalar(
        select(QbSyncBookState)
        .where(QbSyncBookState.plan_id == plan_id, QbSyncBookState.textbook_id == textbook_id)
        .with_for_update()
    )
    if (row.revision if row else 0) != payload.expected_revision:
        raise ServiceException(message='教材调度设置已变化，请刷新')
    if row is None:
        row = QbSyncBookState(plan_id=plan_id, textbook_id=textbook_id, last_cycle_no=0, revision=0)
        db.add(row)
    row.enabled = int(payload.enabled)
    row.exception_kind, row.operator_note = payload.exception_kind, payload.operator_note
    row.revision += 1
    await db.commit()
    return {'revision': row.revision}


async def automatic_task_reason(db, job):
    options=job.options_json or {}
    if options.get('planWorkPaused') or options.get('planWorkEnded'):
        return '学科计划已暂停' if options.get('planWorkPaused') else '本轮已结束'
    plan_id = options.get('autoPlanId')
    if not plan_id or (job.options_json or {}).get('manualDispatchRequested'):
        return None
    plan = await db.get(QbSyncPlan, plan_id)
    if plan is None or not plan.enabled:
        return '自动计划已暂停，待办保留'
    scope = await db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == job.run_id))
    if scope:
        state = await db.scalar(
            select(QbSyncBookState).where(
                QbSyncBookState.plan_id == plan_id, QbSyncBookState.textbook_id == scope.local_textbook_id
            )
        )
        if state and (not state.enabled or state.exception_kind):
            return '该教材自动同步已暂停或人工排除，待办保留'
    if os.getenv('BANK_AUTOMATIC_SYNC_ENABLED') != '1':
        return '全教材自动运行尚未启用'
    return None


async def _claim_plan(db, plan_id):
    now = await _clock(db)
    token = secrets.token_hex(16)
    claimed = await db.execute(
        update(QbSyncPlan)
        .where(
            QbSyncPlan.plan_id == plan_id,
            QbSyncPlan.enabled == 1,
            or_(QbSyncPlan.lease_until.is_(None), QbSyncPlan.lease_until <= now),
            or_(QbSyncPlan.next_check_at.is_(None), QbSyncPlan.next_check_at <= now),
        )
        .values(worker_token=token, lease_until=now + timedelta(seconds=120))
    )
    await db.commit()
    return token if claimed.rowcount else None


async def tick_plan(db, plan_id, *, client):
    token=await _claim_plan(db,plan_id)
    if token is None:
        return
    try:
        plan=await db.get(QbSyncPlan,plan_id,with_for_update=True,populate_existing=True)
        now=await _clock(db)
        supplement_open=await settle_supplements(db,plan_id,now)
        await db.commit()
        plan=await db.get(QbSyncPlan,plan_id,with_for_update=True,populate_existing=True)
        if plan.control_state!='active':
            return
        await SubjectService.require(db,plan.subject_id,sync=True)
        if plan.cycle_state in ('idle','completed','stopped'):
            if plan.cycle_no and (not plan.auto_update or not plan.next_cycle_at or plan.next_cycle_at>now):
                return
            if supplement_open:
                # The scheduled wake-up waits for a running one-book supplement.
                return
            begin_session(plan,now)
            plan.cycle_state='discovering';plan.discovery_next_at=None;plan.discovery_error=None
            await db.commit()
        if plan.cycle_state=='discovering':
            discovery_failed=None
            if await _discovery(db,plan_id,client) is False:
                plan=await db.get(QbSyncPlan,plan_id,with_for_update=True,populate_existing=True)
                # An ordinary discovery failure may continue the known list,
                # marked as not refreshed. No list yet, a discovery still
                # running, or source protection all keep waiting (spec 3.1).
                if not (plan.discovery_error and plan.discovery_task_id is None and plan.textbook_order
                        and not _SOURCE_PROTECTION.search(plan.discovery_error)):
                    return
                discovery_failed=plan.discovery_error
            plan=await db.get(QbSyncPlan,plan_id,with_for_update=True,populate_existing=True)
            if not plan.enabled or plan.control_state!='active':
                return
            discovery=await db.get(QbSyncJob,plan.discovery_processed_task_id) if plan.discovery_processed_task_id else None
            await _start_round(db,plan,now,(discovery.options_json or {}) if discovery else {},
                               discovery_failed=discovery_failed)
            await db.commit()
        plan=await db.get(QbSyncPlan,plan_id,with_for_update=True,populate_existing=True)
        if not plan.enabled or plan.control_state!='active' or plan.cycle_state!='running':
            return
        cycle_no,cycle_name,plan_name=plan.cycle_no,plan.cycle_name,plan.plan_name
        plan_mode,plan_round=plan.session_mode,plan.session_round or 1
        books=await list_books(db,plan_id)
        states={r.textbook_id:r for r in (await db.scalars(select(QbSyncBookState).where(QbSyncBookState.plan_id==plan_id))).all()}
        jobs=list((await db.scalars(select(QbSyncJob).where(
            QbSyncJob.options_json['autoPlanId'].as_integer()==plan_id,
            QbSyncJob.options_json['autoCycleNo'].as_integer()==cycle_no).order_by(QbSyncJob.run_id))).all())
        scopes={r.run_id:r for r in (await db.scalars(select(QbSyncJobScope).where(QbSyncJobScope.run_id.in_([j.run_id for j in jobs])))).all()} if jobs else {}
        for job in jobs:
            scope=scopes.get(job.run_id)
            if scope is None or scope.local_textbook_id not in states:
                continue
            state=states[scope.local_textbook_id]
            if state.last_task_id and state.last_task_id>job.run_id:
                continue
            state.last_task_id=job.run_id
            if job.status in TERMINAL and job.active_slot is None and job.dispatch_book_key is None and not (job.options_json or {}).get('planResumePending'):
                imported=await db.scalar(select(QbQuestionImport).where(QbQuestionImport.task_id==job.run_id,
                    QbQuestionImport.collector_run_id==scope.collector_run_id).limit(1))
                usable=next((b['usableQuestionCount'] for b in books if b['textbookId']==scope.local_textbook_id),0)
                complete=bool(job.snapshot_complete and job.status=='completed' and imported
                              and imported.status=='completed' and imported.accepted_count>0 and usable>0)
                outcome={'scanComplete':bool(job.snapshot_complete),'importStatus':imported.status if imported else 'missing',
                         'acceptedCount':imported.accepted_count if imported else 0,'usableQuestionCount':usable,'needsRefill':not complete}
                if state.last_cycle_no<cycle_no or (job.options_json or {}).get('planOutcome')!=outcome:
                    state.last_cycle_no=cycle_no;state.last_finished_at=now
                    job.options_json={**(job.options_json or {}),'planOutcome':outcome}
        targets=set(plan.cycle_targets or [])
        eligible=[b for b in books if b['textbookId'] in targets and b['enabled'] and not b['exceptionKind']]
        pending=[b for b in eligible if states[b['textbookId']].last_cycle_no<cycle_no]
        source_stopped = any((job.options_json or {}).get('planSourceResumePending')
            or (job.status in ('blocked', 'interrupted') and _SOURCE_PROTECTION.search(job.error_message or ''))
            for job in jobs if job.run_id in {state.last_task_id for state in states.values()})
        if not pending or source_stopped:
            # Health calls run outside the plan transaction. Shared blockers
            # cannot turn the last blocked book into a zero-growth sleep.
            await db.commit()
            wait_reason = await _round_public_wait(db, client)
            plan = await db.get(QbSyncPlan, plan_id, with_for_update=True, populate_existing=True)
            if not plan.enabled or plan.control_state != 'active':
                return
            # Verification may be completed before the next plan heartbeat;
            # remember the stopped task even if the pause was not sampled.
            for job in jobs:
                if client is not None and job.status in ('blocked', 'interrupted') and _SOURCE_PROTECTION.search(job.error_message or ''):
                    job.options_json = {**(job.options_json or {}), 'planSourceResumePending': True}
            if wait_reason:
                cycle = await db.scalar(select(QbSyncCycle).where(
                    QbSyncCycle.plan_id == plan_id, QbSyncCycle.cycle_no == cycle_no))
                if cycle:
                    previous = cycle.summary_json or {}
                    cycle.summary_json = {**previous, 'waitReason': wait_reason,
                        'waitingSince': previous.get('waitingSince') or now.isoformat()}
                await db.commit()
                return
            if await _recover_round_collection(db, plan, states, jobs, scopes, eligible, now,
                                               recover_gaps=not pending):
                await db.commit()
                return
        if not pending and await _round_work_open(db, jobs):
            # A manual execution of this round (an isolated book retried, or a
            # book re-run after it was accounted for) keeps the round open
            # until it is collected, verified and imported (R02).
            await db.commit()
            return
        if not pending:
            if await _settle_round(db,plan,books,states,jobs,scopes,eligible,targets,now) is False:
                await db.commit()
                return
            await db.commit()
            return
        await db.commit()
        busy=set((await db.scalars(select(QbSyncJobScope.local_textbook_id).join(QbSyncJob,QbSyncJob.run_id==QbSyncJobScope.run_id)
                  .where(or_(QbSyncJob.dispatch_book_key.is_not(None),QbSyncJob.status.not_in(TERMINAL))))).all())
        from plugins.bank.service.task_service import SyncTaskService
        for book in pending:
            if book['textbookId'] in busy:
                continue
            mode='full' if plan_mode=='full' and plan_round==1 else 'incremental'
            result=await SyncTaskService.create_question(db,{'versionId':book['versionId'],'textbookId':book['textbookId']},
                operator='automatic',automatic_options={'autoPlanId':plan_id,'autoCycleNo':cycle_no,
                'autoCycleName':cycle_name,'autoPlanName':plan_name,'syncMode':mode})
            state=await db.scalar(select(QbSyncBookState).where(QbSyncBookState.plan_id==plan_id,QbSyncBookState.textbook_id==book['textbookId']))
            state.last_task_id=result.get('taskId') or result['runId']
            await db.commit()
    finally:
        await db.rollback()
        now=await _clock(db)
        await db.execute(update(QbSyncPlan).where(QbSyncPlan.plan_id==plan_id,QbSyncPlan.worker_token==token)
                         .values(worker_token=None,lease_until=None,next_check_at=now+timedelta(seconds=30),update_time=now))
        await db.commit()


async def open_issue_snapshot(db, task_ids):
    """Unresolved problems of a round frozen when it ends (R11).

    Later repairs, recurrences or relinking change the live issue rows, never
    this summary; only ids, kinds and short reasons are kept, no logs or stems.
    """
    if not task_ids:
        return {'openIssueCountAtEnd': 0, 'openIssuesAtEnd': []}
    linked = select(QbSyncIssueTask.issue_id).where(QbSyncIssueTask.task_id.in_(task_ids))
    rows = (await db.scalars(select(QbSyncIssue).where(
        or_(QbSyncIssue.issue_id.in_(linked), QbSyncIssue.latest_task_id.in_(task_ids)),
        QbSyncIssue.status != 'resolved').order_by(QbSyncIssue.issue_id))).all()
    return {'openIssueCountAtEnd': len(rows),
            'openIssuesAtEnd': [{'issueId': r.issue_id, 'textbookId': r.textbook_id, 'errorType': r.error_type,
                                 'status': r.status, 'reason': (r.reason or '')[:120]} for r in rows[:50]]}


async def _round_work_open(db, jobs):
    """True while any execution of this round is queued, running or held.

    Saved results still waiting for verification or import are checked by
    ``_settle_round`` itself, which also records what the round waits on.
    """
    for job in jobs:
        if job.task_module != 'question':
            continue
        if (job.status not in TERMINAL or job.active_slot is not None or job.dispatch_book_key is not None
                or (job.options_json or {}).get('planResumePending')):
            return True
    return False


async def _round_public_wait(db, client):
    control = await control_status(db)
    if control['paused']:
        return control['reason'] or '同步已紧急暂停'
    await db.commit()
    if client is None:
        return None
    try:
        local = resource_status()
        if local.get('paused'):
            return local.get('reason') or '主机资源不足，等待恢复'
        health = await asyncio.to_thread(client.health)
    except ServiceException as exc:
        return exc.message or '采集器暂不可用，等待恢复'
    if health.get('ok') is False:
        return '采集器暂不可用，等待恢复'
    source = health.get('sourceControl') or {}
    if source.get('paused'):
        return source.get('reason') or '来源公共暂停，等待恢复'
    resources = health.get('resources') or {}
    if resources.get('paused'):
        return resources.get('reason') or '采集主机资源不足，等待恢复'
    return None


async def _recover_round_collection(db, plan, states, jobs, scopes, eligible, now, *, recover_gaps=True):
    """Resume explicitly cleared source blocks and bound retries of saved gaps."""
    from plugins.bank.service.sync_run_service import SyncRunService, _bounded_auto_resume_attempts
    from plugins.bank.service.task_service import SyncTaskService
    by_id = {job.run_id: job for job in jobs}
    for book in eligible:
        state = states[book['textbookId']]
        job = by_id.get(state.last_task_id)
        if job is None:
            continue
        scope = scopes.get(job.run_id)
        options = job.options_json or {}
        if options.get('planSourceResumePending'):
            # Clearing the source pause is a user action. The plan only
            # resumes collection after that explicit verification succeeds.
            try:
                if scope is not None and int(options.get('workflowVersion', 1)) >= 2:
                    # A linked execution continues the saved result; the
                    # blocked execution keeps its status, times and Collector
                    # run, so history and the original import stay intact (R01).
                    inherited = {k: v for k, v in options.items() if k in (
                        'autoPlanId', 'autoPlanName', 'autoCycleNo', 'autoCycleName', 'manualPlanId',
                        'manualSingle', 'supplementId', 'allowWhilePlanPaused')}
                    inherited.update(resumeFirst=True, planSourceResumeOf=job.run_id,
                                     syncMode=options.get('syncMode') or 'incremental')
                    job_id, state_id = job.run_id, state.state_id
                    if scope.collector_run_id and scope.snapshot_locked_at and not scope.snapshot_complete:
                        resumed = await SyncTaskService.create_question(db, {
                            'versionId': scope.local_version_id, 'textbookId': scope.local_textbook_id,
                            'listConcurrency': options.get('listConcurrency', 8),
                            'limitTo1000Pages': bool(options.get('limitTo1000Pages'))},
                            'automatic', automatic_options=inherited, resume_task_id=job_id)
                    else:
                        # Blocked before anything was saved: nothing to continue,
                        # so a linked retry of the same task starts the book again.
                        resumed = await SyncTaskService.retry_question(
                            db, job_id, 'automatic', execution_options=inherited)
                    job = await db.get(QbSyncJob, job_id, populate_existing=True)
                    state = await db.get(QbSyncBookState, state_id, populate_existing=True)
                    state.last_task_id = resumed.get('taskId') or resumed['runId']
                else:
                    await SyncRunService.resume_question(db, job.run_id)
            except ServiceException as exc:
                cycle = await db.scalar(select(QbSyncCycle).where(
                    QbSyncCycle.plan_id == plan.plan_id, QbSyncCycle.cycle_no == plan.cycle_no))
                if cycle:
                    cycle.summary_json = {**(cycle.summary_json or {}),
                        'waitReason': f'等待任务 #{job.run_id} 恢复续采：{exc.message}'}
                return True  # Saved results may still need intake/import first.
            job.options_json = {**(job.options_json or {}), 'planSourceResumePending': False}
            state.last_cycle_no = plan.cycle_no - 1
            return True
        if scope is None or not recover_gaps:
            continue
        imported = await db.scalar(select(QbQuestionImport).where(
            QbQuestionImport.task_id == job.run_id,
            QbQuestionImport.collector_run_id == scope.collector_run_id).limit(1))
        scan = ((imported.run_coverage_json or {}).get('scan') or {}) if imported else {}
        # Source total minus collected count is NOT a gap. Only a persisted
        # failed page in the configured window is recoverable here.
        if not scan.get('failedPageCount') or scan.get('parseErrorCount') or scan.get('catalogSelectionTruncated'):
            continue
        if imported.status not in ('completed', 'partial'):
            continue
        attempted = int(options.get('planGapRetryCount') or 0)
        maximum = _bounded_auto_resume_attempts(options)
        if attempted >= maximum:
            from plugins.bank.service.sync_issues import isolate_scope_failure
            await isolate_scope_failure(db, job, scope,
                f'当前窗口分页缺口经 {attempted} 次补采仍未修复，需要维护检查', now)
            return True  # Reload the isolated book list before settlement.
        result = await SyncTaskService.retry_question(db, job.run_id, 'automatic',
            execution_options={'planGapRetryCount': attempted + 1,
                'autoResumeMaxAttempts': maximum, 'autoResume': options.get('autoResume', True)})
        state.last_task_id = result.get('taskId') or result['runId']
        state.last_cycle_no = plan.cycle_no - 1
        _event('sync_window_gap_retry', plan, taskId=job.run_id,
               retryTaskId=state.last_task_id, attempt=attempted + 1,
               failedPageCount=scan['failedPageCount'])
        return True
    return False


async def _start_round(db, plan, now, snapshot=None, *, discovery_failed=None):
    """Freeze the next round's target list inside the current session."""
    books=await list_books(db,plan.plan_id)
    states={r.textbook_id:r for r in (await db.scalars(select(QbSyncBookState).where(QbSyncBookState.plan_id==plan.plan_id))).all()}
    targets=[b['textbookId'] for b in books if b['enabled'] and not b['exceptionKind']]
    plan.textbook_order=[b['textbookId'] for b in books]
    if not plan.session_no:
        begin_session(plan,now)
    plan.cycle_no+=1
    plan.session_round=(plan.session_round or 0)+1
    snapshot=snapshot or {}
    plan.cycle_name=(snapshot.get('autoCycleName') if snapshot.get('autoCycleNo')==plan.cycle_no
                     else _cycle_name(plan,now,plan.session_round))
    plan.cycle_targets=targets;plan.cycle_started_at=now;plan.cycle_finished_at=None;plan.next_cycle_at=None
    plan.cycle_state='running'
    db.add(QbSyncCycle(plan_id=plan.plan_id,cycle_no=plan.cycle_no,cycle_name=plan.cycle_name,status='running',
                       targets=targets,started_at=now,session_no=plan.session_no,round_no=plan.session_round,legacy=0,
                       summary_json={'discoveryFailed':True,'discoveryError':str(discovery_failed)[:500],
                                     'note':'发现失败，清单未刷新'} if discovery_failed else None))
    for book in books:
        if book['textbookId'] not in states:
            db.add(QbSyncBookState(plan_id=plan.plan_id,textbook_id=book['textbookId'],enabled=1,last_cycle_no=0,revision=1))
    _event('sync_round_started', plan, targetCount=len(targets),
           newBooks=sum(1 for b in books if b['textbookId'] not in states))


async def _settle_round(db, plan, books, states, jobs, scopes, eligible, targets, now):
    """Settle a round only after every collected result has a settled import.

    Returns False while saved results still wait for verification or import:
    an unknown new count is never treated as zero.
    """
    plan_id,cycle_no=plan.plan_id,plan.cycle_no
    job_ids=[j.run_id for j in jobs]
    imports=list((await db.scalars(select(QbQuestionImport).where(QbQuestionImport.task_id.in_(job_ids)))).all()) if job_ids else []
    intakes=list((await db.scalars(select(QbQuestionImportIntake).where(QbQuestionImportIntake.task_id.in_(job_ids)))).all()) if job_ids else []
    unsettled=[i.task_id for i in imports if i.status in UNSETTLED_IMPORT]
    unsettled+=[i.task_id for i in intakes if i.status in UNSETTLED_INTAKE
                and not any(m.scope_id==i.scope_id and m.collector_run_id==i.collector_run_id for m in imports)]
    cycle=await db.scalar(select(QbSyncCycle).where(QbSyncCycle.plan_id==plan_id,QbSyncCycle.cycle_no==cycle_no))
    if unsettled:
        if cycle:
            cycle.summary_json={**(cycle.summary_json or {}),'waitingImportTaskIds':sorted(set(unsettled))[:50],
                                'waitReason':'等待已保存成果完成核验和入库'}
        return False
    # Imports commit their stats with each batch, so summing per-import
    # totals is idempotent across retries of the same batch.
    new_questions=sum(import_stat(i.stats_json,'questions') for i in imports)
    new_relations=sum(import_stat(i.stats_json,'questionCatalogs') for i in imports)
    latest={states[b['textbookId']].last_task_id for b in eligible}
    by_id={j.run_id:j for j in jobs}
    problems=[]
    for book in eligible:
        job=by_id.get(states[book['textbookId']].last_task_id)
        outcome=((job.options_json or {}).get('planOutcome') or {}) if job else {}
        if job is None or job.status!='completed' or outcome.get('importStatus') in ('missing','failed','blocked','cancelled'):
            problems.append(book['textbookId'])
    isolated = [b['textbookId'] for b in books if b['enabled'] and b['exceptionKind'] == 'scope_failure']
    problems = list(dict.fromkeys(problems + isolated))
    decision=settle_round(eligible_count=len(eligible) + len(set(isolated) - {b['textbookId'] for b in eligible}),problem_count=len(problems),new_questions=new_questions,
                          new_relations=new_relations,round_no=plan.session_round or 1,max_rounds=plan.max_rounds)
    summary={'targetCount':len(targets),'handledCount':len(eligible),
             # Targets not run this round: disabled or isolated by a problem.
             'skippedCount':len(targets)-len(eligible),
             'checkedCount':len(eligible)-sum(b['textbookId'] in problems for b in eligible),
             'completeCount':sum(1 for j in jobs if j.run_id in latest and not (j.options_json or {}).get('planOutcome',{}).get('needsRefill',True)),
             'newQuestionCount':new_questions,'newRelationCount':new_relations,
             'problemCount':len(problems),'problemTextbookIds':problems[:50],
             'decision':decision,'sessionNo':plan.session_no,'roundNo':plan.session_round,
             **await open_issue_snapshot(db,[j.run_id for j in jobs])}
    if cycle:
        cycle.status='completed';cycle.finished_at=now
        cycle.summary_json={**{k:v for k,v in (cycle.summary_json or {}).items() if k.startswith('discovery') or k=='note'},**summary}
        cycle.end_reason=None if decision=='continue' else decision
    _event('sync_round_settled', plan, decision=decision, newQuestionCount=new_questions,
           newRelationCount=new_relations, problemCount=len(problems), handledCount=len(eligible))
    if decision=='continue':
        await db.flush()
        await _start_round(db,plan,now)
        return True
    plan.cycle_state='completed';plan.cycle_finished_at=now;plan.session_end_reason=decision
    plan.next_cycle_at=now+timedelta(days=plan.refresh_days) if plan.auto_update else None
    _event('sync_session_sleeping', plan, endReason=decision,
           nextWakeAt=utc_datetime(plan.next_cycle_at).isoformat() if plan.next_cycle_at else None)
    for state in states.values():
        if state.textbook_id in targets:
            state.next_due_at=plan.next_cycle_at
    return True


async def cycle_history(db,plan_id,before=None):
    query=select(QbSyncCycle).where(QbSyncCycle.plan_id==plan_id)
    if before:query=query.where(QbSyncCycle.cycle_no<before)
    rows=(await db.scalars(query.order_by(QbSyncCycle.cycle_no.desc()).limit(21))).all()
    return {'rows':[{'cycleNo':r.cycle_no,'cycleName':r.cycle_name,'status':r.status,
                    'sessionNo':r.session_no,'roundNo':r.round_no,'legacy':bool(r.legacy),'endReason':r.end_reason,
                    'targetCount':len(r.targets or []),'summary':r.summary_json or {},
                    'startedAt':utc_datetime(r.started_at),'finishedAt':utc_datetime(r.finished_at)} for r in rows[:20]],
            'nextCursor':rows[19].cycle_no if len(rows)>20 else None}


async def session_log(db, plan_id, session_no=None):
    """One sync session as a log: each round with its stage counts and outcome.

    Stage counts come from the round's executions (collection), intake and
    import rows (verification and import) and open problems, so the page can
    say where a round spent its work without reading diagnostics files.
    """
    plan=await db.get(QbSyncPlan,plan_id)
    if plan is None:
        raise ServiceException(message='计划不存在')
    session_no=session_no or plan.session_no
    cycles=(await db.scalars(select(QbSyncCycle).where(QbSyncCycle.plan_id==plan_id,QbSyncCycle.session_no==session_no)
                             .order_by(QbSyncCycle.cycle_no))).all()
    sessions=[n for n in (await db.scalars(select(QbSyncCycle.session_no).where(
        QbSyncCycle.plan_id==plan_id,QbSyncCycle.session_no.is_not(None)).distinct())).all()]
    rounds=[]
    for cycle in cycles:
        jobs=(await db.execute(select(QbSyncJob.run_id,QbSyncJob.status).where(
            QbSyncJob.task_module=='question',
            QbSyncJob.options_json['autoPlanId'].as_integer()==plan_id,
            QbSyncJob.options_json['autoCycleNo'].as_integer()==cycle.cycle_no))).all()
        ids=[job.run_id for job in jobs]
        collection=collections.Counter(job.status for job in jobs)
        intake=collections.Counter((await db.scalars(select(QbQuestionImportIntake.status).where(
            QbQuestionImportIntake.task_id.in_(ids)))).all()) if ids else collections.Counter()
        imports=(await db.execute(select(QbQuestionImport.status,QbQuestionImport.accepted_count,
            QbQuestionImport.quarantined_count).where(QbQuestionImport.task_id.in_(ids)))).all() if ids else []
        live=await db.scalar(select(func.count()).select_from(QbSyncIssue).where(
            QbSyncIssue.latest_task_id.in_(ids),QbSyncIssue.status!='resolved')) if ids else 0
        summary=cycle.summary_json or {}
        # A finished round reports what was open when it ended; the live count is separate.
        issues=summary['openIssueCountAtEnd'] if 'openIssueCountAtEnd' in summary else live
        rounds.append({'cycleNo':cycle.cycle_no,'roundNo':cycle.round_no,'legacy':bool(cycle.legacy),
                       'status':cycle.status,'endReason':cycle.end_reason,'targetCount':len(cycle.targets or []),
                       'skippedCount':summary.get('skippedCount'),'problemCount':summary.get('problemCount'),
                       'startedAt':utc_datetime(cycle.started_at),'finishedAt':utc_datetime(cycle.finished_at),
                       'collection':dict(collection),'verification':dict(intake),
                       'imports':{'count':len(imports),'completed':sum(1 for r in imports if r.status=='completed'),
                                  'accepted':sum(int(r.accepted_count or 0) for r in imports),
                                  'quarantined':sum(int(r.quarantined_count or 0) for r in imports)},
                       'openIssueCount':int(issues or 0),'openIssueCountNow':int(live or 0),
                       'openIssuesAtEnd':summary.get('openIssuesAtEnd'),
                       'newQuestionCount':summary.get('newQuestionCount'),'newRelationCount':summary.get('newRelationCount'),
                       'decision':summary.get('decision'),'note':summary.get('note')})
    supplements=(await db.scalars(select(QbSyncSupplement).where(QbSyncSupplement.plan_id==plan_id)
                                  .order_by(QbSyncSupplement.supplement_id.desc()).limit(20))).all()
    return {'sessionNo':session_no,'sessions':sorted(sessions,reverse=True),'rounds':rounds,
            'supplements':[supplement_dump(r) for r in supplements],
            'endReason':next((r['endReason'] for r in reversed(rounds) if r['endReason']),None),
            'newQuestionCount':sum(int(r['newQuestionCount'] or 0) for r in rounds),
            'newRelationCount':sum(int(r['newRelationCount'] or 0) for r in rounds)}


def supplement_dump(row):
    summary=row.summary_json or {}
    return {'supplementId':row.supplement_id,'textbookId':row.textbook_id,'taskId':row.task_id,
            'syncMode':row.sync_mode,'status':row.status,'startedAt':utc_datetime(row.started_at),
            'finishedAt':utc_datetime(row.finished_at),'createdBy':row.created_by,**summary}


async def settle_supplements(db, plan_id, now):
    """Close one-book supplements once collection, verification and import are done.

    Returns True while one is still open: the subject's own wake-up waits for
    it, so the two never run side by side (spec 4.1, A09).
    """
    rows=(await db.scalars(select(QbSyncSupplement).where(QbSyncSupplement.plan_id==plan_id,
        QbSyncSupplement.status=='running').with_for_update())).all()
    still_open=False
    for row in rows:
        job=await db.get(QbSyncJob,row.task_id) if row.task_id else None
        if job is None:
            # A supplement whose execution was never created (an old failed
            # create) is closed after a grace period instead of blocking the
            # subject forever (R03).
            if row.task_id is None and row.started_at and now-row.started_at>timedelta(minutes=10):
                row.status='failed'
                row.finished_at=now
                row.summary_json={**(row.summary_json or {}),'error':'补采执行未能创建'}
                continue
            still_open=True
            continue
        # Follow resumes and retries of the same supplement to the latest execution.
        latest=await db.scalar(select(QbSyncJob).where(QbSyncJob.task_module=='question',
            QbSyncJob.options_json['supplementId'].as_integer()==row.supplement_id).order_by(QbSyncJob.run_id.desc()).limit(1))
        job=latest or job
        if (job.status not in TERMINAL or job.active_slot is not None
                or (job.options_json or {}).get('planResumePending')
                or (job.options_json or {}).get('autoResumePending')):
            still_open=True
            continue
        imports=list((await db.scalars(select(QbQuestionImport).where(QbQuestionImport.task_id==job.run_id))).all())
        intakes=list((await db.scalars(select(QbQuestionImportIntake).where(QbQuestionImportIntake.task_id==job.run_id))).all())
        if any(i.status in UNSETTLED_IMPORT for i in imports) or any(
                i.status in UNSETTLED_INTAKE and not i.import_id for i in intakes):
            still_open=True
            continue
        scope=await db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id==job.run_id))
        imported=imports[-1] if imports else None
        row.status='completed' if job.status=='completed' and imported and imported.status=='completed' else (
            'cancelled' if job.status=='cancelled' else 'finished_with_issues')
        row.task_id=job.run_id
        row.finished_at=now
        row.summary_json={'jobStatus':job.status,'importStatus':imported.status if imported else 'missing',
                          'savedQuestionCount':int(scope.question_count or 0) if scope else 0,
                          'acceptedCount':sum(int(i.accepted_count or 0) for i in imports),
                          'newQuestionCount':sum(import_stat(i.stats_json,'questions') for i in imports),
                          'newRelationCount':sum(import_stat(i.stats_json,'questionCatalogs') for i in imports)}
        from plugins.bank.service import diagnostics
        diagnostics.event('supplement_finished', stage='plan', planId=plan_id, supplementId=row.supplement_id,
                          taskId=job.run_id, status=row.status, **row.summary_json)
    return still_open


def _cycle_name(plan, now, round_no):
    local = now.replace(tzinfo=timezone.utc).astimezone(timezone(timedelta(hours=8)))
    session = plan.session_no or 1
    return f"{plan.plan_name or '学科同步'} · 第 {session} 次同步 · {local:%Y-%m-%d %H:%M} · 第 {round_no} 轮"


async def _discovery(db, plan_id, client):
    plan = await db.get(QbSyncPlan, plan_id, populate_existing=True)
    now = await _clock(db)
    if not plan.discovery_task_id:
        orphan = await db.scalar(
            select(QbSyncJob)
            .where(
                QbSyncJob.options_json['autoDiscoveryPlanId'].as_integer() == plan_id,
                QbSyncJob.run_id > plan.discovery_processed_task_id,
            )
            .order_by(QbSyncJob.run_id)
            .limit(1)
        )
        if orphan:
            plan.discovery_task_id = orphan.run_id
            await db.commit()
    if plan.discovery_task_id:
        task = await db.get(QbSyncJob, plan.discovery_task_id)
        if task and task.status not in TERMINAL:
            return False
        if task and task.status == 'completed' and (task.options_json or {}).get('discoveryMode') == 'merge':
            options = task.options_json or {}
            if not options.get('discoveryResult') and options.get('discoveryAttempts', 0) < 3:
                return False  # The shared discovery worker owns merge and retry timing.
            plan.discovery_error = None if options.get('discoveryResult') else options.get('discoveryError')
        elif task and task.status == 'completed' and task.snapshot_complete:
            task_id = task.run_id
            state = await db.get(QbTextbookApplyState, 'zujuan')
            # Never roll back a newer human discovery when an old automatic
            # discovery finishes late.
            current = state.current_task_id if state else None
            await db.rollback()
            if current is None or current <= task_id:
                from plugins.bank.service.textbook_apply_service import TextbookApplyService

                try:
                    await TextbookApplyService.apply(db, task_id, current, 'automatic', discovery=True)
                except ServiceException as exc:
                    plan = await db.get(QbSyncPlan, plan_id)
                    plan.discovery_error = str(exc.message)[:500]
        else:
            plan.discovery_error = str(task.error_message if task else '教材发现任务记录不存在')[:500]
        plan = await db.get(QbSyncPlan, plan_id)
        plan.discovery_processed_task_id = plan.discovery_task_id
        plan.discovery_task_id = None
        plan.discovery_next_at = now + (timedelta(hours=plan.refill_hours) if plan.discovery_error
                                        else timedelta(days=plan.discovery_days))
        await db.commit()
    if plan.discovery_next_at and plan.discovery_next_at > now:
        return not bool(plan.discovery_error)
    previous = await db.get(QbSyncJob, plan.discovery_processed_task_id) if plan.discovery_processed_task_id else None
    previous_options = (previous.options_json or {}) if previous else {}
    cycle_name = (previous_options.get('autoCycleName')
                  if previous_options.get('autoCycleNo') == plan.cycle_no + 1 else None)
    discovery_options = {'autoDiscoveryPlanId': plan_id, 'autoPlanId': plan_id, 'discoveryMode': 'merge',
                         'autoPlanName': plan.plan_name, 'autoCycleNo': plan.cycle_no + 1,
                         'autoCycleName': cycle_name or _cycle_name(plan, now, (plan.session_round or 0) + 1)}
    await db.rollback()
    from plugins.bank.service.sync_run_service import SyncRunService

    result = await SyncRunService._create_job(
        db,
        run_type='metadata',
        task_module='textbook',
        acknowledge_source_policy=True,
        operator='automatic',
        extra_options=discovery_options,
    )
    plan = await db.get(QbSyncPlan, plan_id)
    plan.discovery_task_id = result.get('taskId') or result.get('runId')
    plan.discovery_error = None
    await db.commit()

    return False


async def schedule_once(*, session_factory, client):
    if os.getenv('BANK_AUTOMATIC_SYNC_ENABLED') != '1':
        return
    async with session_factory() as db:
        if (await control_status(db))['paused']:
            return
        ids = list((await db.scalars(select(QbSyncPlan.plan_id).where(QbSyncPlan.enabled == 1))).all())
        # Supplements of a paused plan (run with explicit permission) still close.
        open_ids = set((await db.scalars(select(QbSyncSupplement.plan_id).where(
            QbSyncSupplement.status == 'running'))).all()) - set(ids)
        for plan_id in open_ids:
            await settle_supplements(db, plan_id, await _clock(db))
            await db.commit()
    if not ids:
        return
    for plan_id in ids:
        async with session_factory() as db:
            try:
                await tick_plan(db, plan_id, client=client)
            except Exception:
                from utils.log_util import logger

                logger.exception('自动同步计划 %s 处理失败，其他教材任务继续', plan_id)
    async with session_factory() as db:
        try:
            await recover_failed_results(db)
        except Exception:
            from utils.log_util import logger

            logger.exception('已保存成果的延迟恢复失败，下次调度再试')


async def recover_failed_results(db, now=None):
    """Run the delayed import recovery that failure records promise (spec E04).

    A failed import of a plan's saved result is retried on the same snapshot
    once ``refill_hours`` have passed, at most three times; after that its
    issue is maintenance (no further recovery is scheduled).
    """
    now = now or await _clock(db)
    # Exhausted and paused rows are filtered before the limit, and the scan
    # pages forward, so old exhausted failures never starve later due ones (R04).
    due, cursor = [], 0
    for _page in range(50):
        rows = (await db.execute(select(QbQuestionImport, QbSyncJob, QbSyncPlan)
            .join(QbSyncJob, QbSyncJob.run_id == QbQuestionImport.task_id)
            .join(QbSyncJobScope, QbSyncJobScope.scope_id == QbQuestionImport.scope_id)
            .join(QbSyncPlan, QbSyncPlan.plan_id == QbSyncJob.options_json['autoPlanId'].as_integer())
            .where(QbQuestionImport.status == 'failed', QbQuestionImport.import_id > cursor,
                   QbSyncPlan.enabled == 1, QbSyncPlan.control_state == 'active',
                   func.coalesce(QbSyncJob.options_json['planImportRetryCount'].as_integer(), 0) < 3)
            .order_by(QbQuestionImport.import_id).limit(100))).all()
        for imported, job, plan in rows:
            cursor = imported.import_id
            options = job.options_json or {}
            if options.get('planWorkPaused') or int(options.get('planImportRetryCount') or 0) >= 3:
                continue
            if imported.update_time and imported.update_time + timedelta(hours=plan.refill_hours) > now:
                continue
            due.append((imported.scope_id, imported.collector_run_id, imported.import_id))
        if len(rows) < 100 or len(due) >= 20:
            break
    due = due[:20]
    await db.rollback()
    for scope_id, collector_run_id, import_id in due:
        await _retry_saved_scope_results(db, scope_id, now,
                                        collector_run_id=collector_run_id, import_id=import_id)
    return len(due)


async def retry_saved_book_results(db, textbook_id, now):
    """Do not scrape again while the latest sealed result needs database repair."""
    scope = await db.scalar(select(QbSyncJobScope).join(QbSyncJob, QbSyncJob.run_id == QbSyncJobScope.run_id)
        .where(QbSyncJobScope.local_textbook_id == textbook_id, QbSyncJob.status.in_(TERMINAL))
        .order_by(QbSyncJob.run_id.desc()).limit(1))
    if not scope:
        return False
    return await _retry_saved_scope_results(db, scope.scope_id, now)


async def _retry_saved_scope_results(db, scope_id, now, *, collector_run_id=None, import_id=None):
    """Retry one sealed observation; newer executions cannot replace its identity."""
    scope = await db.get(QbSyncJobScope, scope_id, populate_existing=True)
    if not scope or not scope.collector_run_id:
        return False
    if collector_run_id is not None and scope.collector_run_id != collector_run_id:
        return False
    imported = await db.scalar(select(QbQuestionImport).where(QbQuestionImport.scope_id == scope.scope_id,
        QbQuestionImport.collector_run_id == scope.collector_run_id))
    if import_id is not None and (imported is None or imported.import_id != import_id):
        return False
    intake = await db.scalar(select(QbQuestionImportIntake).where(QbQuestionImportIntake.scope_id == scope.scope_id,
        QbQuestionImportIntake.collector_run_id == scope.collector_run_id))
    if imported and imported.status in ('queued', 'preparing', 'running'):
        return True
    if intake and intake.status in ('pending', 'probing', 'retry', 'discarded'):
        return True
    if not (imported and imported.status == 'failed' or intake and intake.status == 'blocked'):
        return False
    if not imported and scope.snapshot_locked_at and not (scope.catalog_count or scope.question_count
                                                          or scope.question_catalog_count):
        # Re-verifying an empty result can never produce questions; the book
        # needs a new collection once its root cause is fixed (spec E08).
        return False
    task_id = scope.run_id
    has_import = imported is not None
    job = await db.get(QbSyncJob, task_id)
    options = dict(job.options_json or {})
    if options.get('planImportRetryCount', 0) >= 3:
        return True
    await db.rollback()
    from plugins.bank.service.import_intake import retry_import_intake
    from plugins.bank.service.incremental_import import request_incremental_import
    try:
        if has_import:
            await request_incremental_import(db, task_id)
        else:
            await retry_import_intake(db, task_id)
    except ServiceException:
        await db.rollback()
        return True
    job = await db.get(QbSyncJob, task_id, with_for_update=True, populate_existing=True)
    job.options_json = {**(job.options_json or {}), 'planImportRetryCount': options.get('planImportRetryCount', 0) + 1,
                        'planImportRetryAt': now.isoformat()}
    await db.commit()
    return True
