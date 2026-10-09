"""One-book cycles reuse existing jobs and dispatch; no second collection pipeline."""

import asyncio
import os
import secrets
from datetime import timedelta

from sqlalchemy import or_, select, update

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbQuestionImport,
    QbQuestionImportIntake,
    QbSyncBookState,
    QbSyncControl,
    QbSyncJob,
    QbSyncJobScope,
    QbSyncPlan,
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


async def control_status(db):
    row = await db.get(QbSyncControl, 1)
    return {
        'paused': bool(row and row.paused),
        'reason': row.reason if row else None,
        'revision': row.revision if row else 1,
        'updateTime': utc_datetime(row.update_time) if row else None,
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
    budget, resources = health.get('sourceBudget') or {}, health.get('resources') or {}
    if not budget.get('allDailyLimitsConfigured') or not resources.get('diskAndMemoryLimitsConfigured'):
        return '请先配置来源请求、教材启动、时长、下载预算及采集主机资源水位'
    if not all(
        configured_limit(name) > 0
        for name in (
            'BANK_MIN_DISK_FREE_MIB',
            'BANK_MIN_MEMORY_FREE_MIB',
            'BANK_SYNC_MAX_PENDING_IMPORTS',
        )
    ):
        return '请先配置入库主机资源水位及积压上限'
    local = resource_status().get('reason')
    control = health.get('sourceControl') or {}
    return local or (control.get('reason') or '来源公共暂停' if control.get('paused') else None)


def plan_dump(row):
    return {
        'planId': row.plan_id,
        'subjectId': row.subject_id,
        'enabled': bool(row.enabled),
        'refreshDays': row.refresh_days,
        'refillHours': row.refill_hours,
        'discoveryDays': row.discovery_days,
        'cycleNo': row.cycle_no,
        'cycleTargetCount': len(row.cycle_targets or []),
        'cycleStartedAt': utc_datetime(row.cycle_started_at),
        'nextCheckAt': utc_datetime(row.next_check_at),
        'discoveryTaskId': row.discovery_task_id,
        'discoveryNextAt': utc_datetime(row.discovery_next_at),
        'discoveryError': row.discovery_error,
        'revision': row.revision,
    }


async def list_plans(db, subject_id=None):
    query = select(QbSyncPlan).order_by(QbSyncPlan.plan_id)
    if subject_id is not None:
        query = query.where(QbSyncPlan.subject_id == subject_id)
    rows = (await db.scalars(query)).all()
    return [plan_dump(row) for row in rows]


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
            update_time=await _clock(db),
        )
        db.add(row)
    else:
        if row.revision != payload.expected_revision:
            raise ServiceException(message='计划已被修改，请刷新后重试')
        row.revision += 1
    row.enabled = int(payload.enabled)
    row.refresh_days, row.refill_hours, row.discovery_days = (
        payload.refresh_days,
        payload.refill_hours,
        payload.discovery_days,
    )
    row.next_check_at = None
    row.update_time = await _clock(db)
    await db.commit()
    await db.refresh(row)
    return plan_dump(row)


async def list_books(db, plan_id):
    plan = await db.get(QbSyncPlan, plan_id)
    if plan is None:
        raise ServiceException(message='计划不存在')
    books = (
        await db.execute(
            select(QbTextbook, QbTextbookVersion.is_new)
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
        counts.update(await book_stem_counts(db, [book.textbook_id for book, _ in books[offset : offset + 500]]))
    targets = set(plan.cycle_targets or [])
    return [
        {
            'textbookId': book.textbook_id,
            'textbookName': book.textbook_name,
            'versionId': book.version_id,
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
        }
        for book, is_new in books
    ]


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
    plan_id = (job.options_json or {}).get('autoPlanId')
    if not plan_id:
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
    token = await _claim_plan(db, plan_id)
    if token is None:
        return
    plan = await db.get(QbSyncPlan, plan_id, populate_existing=True)
    try:
        await SubjectService.require(db, plan.subject_id, sync=True)
        now = await _clock(db)
        books = await list_books(db, plan_id)
        # Adopt any task committed before a crash in plan bookkeeping. Its
        # plan/cycle identity was written in the same transaction as the job.
        states = {
            row.textbook_id: row
            for row in (await db.scalars(select(QbSyncBookState).where(QbSyncBookState.plan_id == plan_id))).all()
        }
        for book in books:
            if book['textbookId'] not in states:
                row = QbSyncBookState(
                    plan_id=plan_id, textbook_id=book['textbookId'], enabled=1, last_cycle_no=0, revision=1
                )
                db.add(row)
                states[book['textbookId']] = row
        jobs = (
            (
                await db.scalars(
                    select(QbSyncJob)
                    .where(
                        QbSyncJob.options_json['autoPlanId'].as_integer() == plan_id,
                        or_(QbSyncJob.options_json['autoCycleNo'].as_integer() == plan.cycle_no,
                            QbSyncJob.run_id.in_([state.last_task_id for state in states.values() if state.last_task_id])),
                    )
                    .order_by(QbSyncJob.run_id)
                )
            ).all()
            if plan.cycle_no
            else []
        )
        scopes = (
            {
                scope.run_id: scope
                for scope in (
                    await db.scalars(
                        select(QbSyncJobScope).where(QbSyncJobScope.run_id.in_([job.run_id for job in jobs]))
                    )
                ).all()
            }
            if jobs
            else {}
        )
        for job in jobs:
            scope = scopes.get(job.run_id)
            if scope is None or scope.local_textbook_id not in states:
                continue
            state = states[scope.local_textbook_id]
            if state.last_task_id and state.last_task_id > job.run_id:
                continue
            state.last_task_id = job.run_id
            if (
                job.status in TERMINAL
                and job.active_slot is None
                and job.dispatch_book_key is None
            ):
                imported = await db.scalar(select(QbQuestionImport).where(
                    QbQuestionImport.task_id == job.run_id,
                    QbQuestionImport.collector_run_id == scope.collector_run_id,
                ).order_by(QbQuestionImport.import_id.desc()).limit(1))
                usable = next((b['usableQuestionCount'] for b in books if b['textbookId'] == scope.local_textbook_id), 0)
                complete = bool(job.snapshot_complete and job.status == 'completed' and imported
                                and imported.status == 'completed' and imported.accepted_count > 0 and usable > 0)
                outcome = {'scanComplete': bool(job.snapshot_complete),
                           'importStatus': imported.status if imported else 'missing',
                           'acceptedCount': imported.accepted_count if imported else 0, 'usableQuestionCount': usable,
                           'needsRefill': not complete}
                task_cycle = int((job.options_json or {}).get('autoCycleNo', 0))
                new_attempt = state.last_cycle_no < task_cycle
                if new_attempt or (job.options_json or {}).get('planOutcome') != outcome:
                    state.last_cycle_no = max(state.last_cycle_no, task_cycle)
                    state.last_finished_at = now
                    job.options_json = {**(job.options_json or {}), 'planOutcome': outcome}
                    state.next_due_at = now + (timedelta(days=plan.refresh_days) if complete else timedelta(hours=plan.refill_hours))
        eligible = [
            book
            for book in books
            if states[book['textbookId']].enabled and not states[book['textbookId']].exception_kind
        ]
        targets = plan.cycle_targets or []
        pending = [
            book
            for book in eligible
            if book['textbookId'] in targets and states[book['textbookId']].last_cycle_no < plan.cycle_no
        ]
        if not pending:
            due = [
                book
                for book in eligible
                if states[book['textbookId']].next_due_at is None or states[book['textbookId']].next_due_at <= now
            ]
            if due:
                plan.cycle_no += 1
                plan.cycle_targets = [book['textbookId'] for book in due]
                plan.cycle_started_at = now
                pending = due
                targets = plan.cycle_targets
        cycle_no = plan.cycle_no
        refill_hours = plan.refill_hours
        await db.commit()
        # Existing manual/automatic work on one book must not keep the
        # planner from queuing other targets. The original cycle stays fixed.
        busy_books = set(
            (
                await db.scalars(
                    select(QbSyncJobScope.local_textbook_id)
                    .join(QbSyncJob, QbSyncJob.run_id == QbSyncJobScope.run_id)
                    .where(or_(QbSyncJob.dispatch_book_key.is_not(None), QbSyncJob.status.not_in(TERMINAL)))
                )
            ).all()
        )
        dispatched = len(targets) - len(pending)
        pending = [book for book in pending if book['textbookId'] not in busy_books]
        if pending:
            # Every fourth selection reserves a place for old editions.
            # A finite cycle gives each target one attempt before any refill.
            old_turn = dispatched % 4 == 3
            pending.sort(
                key=lambda book: (
                    book['usableQuestionCount'] > 0,
                    book['isNew'] if old_turn else not book['isNew'],
                    book['lastCycleNo'],
                    book['textbookId'],
                )
            )
            book = None
            for candidate in pending:
                held = await retry_saved_book_results(db, candidate['textbookId'], now)
                if held:
                    state = await db.scalar(select(QbSyncBookState).where(QbSyncBookState.plan_id == plan_id, QbSyncBookState.textbook_id == candidate['textbookId']))
                    state.last_cycle_no = cycle_no
                    state.next_due_at = now + timedelta(hours=refill_hours)
                    await db.commit()
                    continue
                book = candidate
                break
            if book is None:
                await _discovery(db, plan_id, client)
                return
            from plugins.bank.service.task_service import SyncTaskService

            previous = await db.scalar(
                select(QbSyncJobScope)
                .join(QbSyncJob, QbSyncJob.run_id == QbSyncJobScope.run_id)
                .where(
                    QbSyncJobScope.local_textbook_id == book['textbookId'],
                    QbSyncJob.status.in_(TERMINAL),
                    QbSyncJob.dispatch_book_key.is_(None),
                )
                .order_by(QbSyncJob.run_id.desc())
                .limit(1)
            )
            refill_task = (
                previous.run_id
                if previous
                and previous.collector_run_id
                and previous.snapshot_locked_at
                and not previous.snapshot_complete
                else None
            )
            await SyncTaskService.create_question(
                db,
                {'versionId': book['versionId'], 'textbookId': book['textbookId']},
                operator='automatic',
                automatic_options={'autoPlanId': plan_id, 'autoCycleNo': cycle_no},
                resume_task_id=refill_task,
            )
        # Discovery coalesces missed intervals into one new task; failed or
        # truncated discovery never changes the existing formal book set.
        await _discovery(db, plan_id, client)
    finally:
        await db.rollback()
        now = await _clock(db)
        await db.execute(
            update(QbSyncPlan)
            .where(QbSyncPlan.plan_id == plan_id, QbSyncPlan.worker_token == token)
            .values(worker_token=None, lease_until=None, next_check_at=now + timedelta(seconds=30), update_time=now)
        )
        await db.commit()


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
            return
        if task and task.status == 'completed' and (task.options_json or {}).get('discoveryMode') == 'merge':
            options = task.options_json or {}
            if not options.get('discoveryResult') and options.get('discoveryAttempts', 0) < 3:
                return  # The shared discovery worker owns merge and retry timing.
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
        plan.discovery_next_at = now + timedelta(days=plan.discovery_days)
        await db.commit()
    if plan.discovery_next_at and plan.discovery_next_at > now:
        return
    if await db.scalar(select(QbSyncJob.run_id).where(QbSyncJob.active_slot.is_not(None)).limit(1)):
        return
    await db.rollback()
    from plugins.bank.service.sync_run_service import SyncRunService

    result = await SyncRunService._create_job(
        db,
        run_type='metadata',
        task_module='textbook',
        acknowledge_source_policy=True,
        operator='automatic',
        extra_options={'autoDiscoveryPlanId': plan_id, 'discoveryMode': 'merge'},
    )
    plan = await db.get(QbSyncPlan, plan_id)
    plan.discovery_task_id = result.get('taskId') or result.get('runId')
    plan.discovery_error = None
    await db.commit()


async def schedule_once(*, session_factory, client):
    if os.getenv('BANK_AUTOMATIC_SYNC_ENABLED') != '1':
        return
    async with session_factory() as db:
        if (await control_status(db))['paused']:
            return
        ids = list((await db.scalars(select(QbSyncPlan.plan_id).where(QbSyncPlan.enabled == 1))).all())
    if not ids:
        return
    health = await asyncio.to_thread(client.health)
    if unattended_reason(health):
        return
    for plan_id in ids:
        async with session_factory() as db:
            try:
                await tick_plan(db, plan_id, client=client)
            except Exception:
                from utils.log_util import logger

                logger.exception('自动同步计划 %s 处理失败，其他教材任务继续', plan_id)


async def retry_saved_book_results(db, textbook_id, now):
    """Do not scrape again while the latest sealed result needs database repair."""
    scope = await db.scalar(select(QbSyncJobScope).join(QbSyncJob, QbSyncJob.run_id == QbSyncJobScope.run_id)
        .where(QbSyncJobScope.local_textbook_id == textbook_id, QbSyncJob.status.in_(TERMINAL))
        .order_by(QbSyncJob.run_id.desc()).limit(1))
    if not scope or not scope.collector_run_id:
        return False
    imported = await db.scalar(select(QbQuestionImport).where(QbQuestionImport.scope_id == scope.scope_id,
        QbQuestionImport.collector_run_id == scope.collector_run_id))
    intake = await db.scalar(select(QbQuestionImportIntake).where(QbQuestionImportIntake.scope_id == scope.scope_id,
        QbQuestionImportIntake.collector_run_id == scope.collector_run_id))
    if imported and imported.status in ('queued', 'preparing', 'running'):
        return True
    if intake and intake.status in ('pending', 'probing', 'retry', 'discarded'):
        return True
    if not (imported and imported.status == 'failed' or intake and intake.status == 'blocked'):
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
