"""Durable waiting and execution claims on the existing business task row."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import exists, func, or_, select
from sqlalchemy.exc import IntegrityError

from config.database import DataSourceRegistry
from exceptions.exception import ServiceException
from plugins.bank.dao.sync_task_dao import SyncTaskDao
from plugins.bank.entity.do.bank_do import (
    QbQuestionImport,
    QbQuestionImportIntake,
    QbSubject,
    QbSyncBookState,
    QbSyncJob,
    QbSyncJobScope,
    QbSyncPlan,
    QbTextbook,
    QbTextbookVersion,
)
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.import_dates import utc_datetime
from plugins.bank.service.incremental_import import _clock
from plugins.bank.service.plan_work import allowed_condition
from plugins.bank.service.resource_guard import configured_limit, resource_status

TERMINAL = ('completed', 'failed', 'blocked', 'cancelled', 'interrupted')
POLL_SECONDS = 3
_TASK: asyncio.Task | None = None


def book_key(subject_id: int, provider: str, external_id: str) -> str:
    value = json.dumps([subject_id, provider, external_id], separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(value.encode()).hexdigest()


def queue_fields(row) -> dict:
    if not getattr(row, 'dispatch_job_id', None):
        return {}
    state = 'closed'
    if row.dispatch_book_key:
        state = 'settling'
        if row.active_slot:
            state = 'dispatched'
        elif row.status == 'queued':
            state = 'waiting'
    expired = row.dispatch_not_before and utc_datetime(row.dispatch_not_before) <= datetime.now(timezone.utc)
    return {
        'queueState': state,
        'queueNotBefore': None if expired else utc_datetime(row.dispatch_not_before),
        'queueReason': None if expired else row.dispatch_error,
    }


def is_automatic_task(row) -> bool:
    options = row.options_json or {}
    return bool(options.get('autoPlanId') and not options.get('manualDispatchRequested'))


def dispatchable_plan_condition(*, manual_only=False):
    """Paused plans retain their queue entries without occupying the FIFO head."""
    plan_id = QbSyncJob.options_json['autoPlanId'].as_integer()
    manual = or_(plan_id.is_(None), plan_id == 0,
                 QbSyncJob.options_json['manualDispatchRequested'].as_boolean().is_(True))
    if manual_only or os.getenv('BANK_AUTOMATIC_SYNC_ENABLED') != '1':
        return manual & allowed_condition()
    enabled_plan = exists().where(QbSyncPlan.plan_id == plan_id, QbSyncPlan.enabled == 1)
    excluded_book = exists().where(
        QbSyncJobScope.run_id == QbSyncJob.run_id,
        QbSyncBookState.plan_id == plan_id,
        QbSyncBookState.textbook_id == QbSyncJobScope.local_textbook_id,
        or_(QbSyncBookState.enabled == 0, QbSyncBookState.exception_kind.is_not(None)),
    )
    return or_(manual, enabled_plan & ~excluded_book) & allowed_condition()


async def request_manual_dispatch(db, row, operator, *, allow_paused=False):
    if row.status!='queued' or row.active_slot:
        return
    await db.refresh(row,with_for_update=True)
    if row.status!='queued' or row.active_slot:
        return
    options=dict(row.options_json or {})
    if options.get('planWorkEnded'):
        raise ServiceException(message='本轮已结束，请重新创建单本任务')
    if options.get('planWorkPaused') and not allow_paused:
        raise ServiceException(message='计划已暂停，请确认仅执行这一次')
    if not is_automatic_task(row) and not options.get('planWorkPaused'):
        return
    from plugins.bank.service.sync_plans import automatic_task_reason
    previous_reason=await automatic_task_reason(db,row)
    options.update(manualDispatchRequested=True,manualDispatchRequestedBy=operator)
    if allow_paused:
        options.update(planWorkPaused=False,allowWhilePlanPaused=True)
    row.options_json=options
    if previous_reason and row.dispatch_error==previous_reason:
        row.dispatch_error=None;row.dispatch_not_before=None
    await db.commit()


async def existing_book_task(db, key: str, *, limit_to_1000_pages: bool):
    row = (await db.execute(select(QbSyncJob).where(QbSyncJob.dispatch_book_key == key))).scalars().first()
    if row is not None:
        options = row.options_json or {}
        if bool(options.get('limitTo1000Pages', False)) != limit_to_1000_pages:
            raise ServiceException(message='该教材已有待办或未结束任务，采集范围设置不同；请先处理原任务')
    return row


async def legacy_unsettled_book_task(db, subject_id, provider, external_id):
    """Older tasks have no book key; preserve their unfinished business work."""
    busy_import = exists().where(
        QbQuestionImport.task_id == QbSyncJob.run_id,
        QbQuestionImport.status.in_(('queued', 'preparing', 'running', 'paused')),
    )
    busy_intake = exists().where(
        QbQuestionImportIntake.scope_id == QbSyncJobScope.scope_id,
        QbQuestionImportIntake.collector_run_id == QbSyncJobScope.collector_run_id,
        QbQuestionImportIntake.status.in_(('pending', 'probing', 'retry')),
    )
    imported_run = exists().where(
        QbQuestionImport.scope_id == QbSyncJobScope.scope_id,
        QbQuestionImport.collector_run_id == QbSyncJobScope.collector_run_id,
    )
    missing_intake = QbSyncJobScope.collector_run_id.is_not(None) & ~imported_run & ~exists().where(
        QbQuestionImportIntake.scope_id == QbSyncJobScope.scope_id,
        QbQuestionImportIntake.collector_run_id == QbSyncJobScope.collector_run_id,
    )
    return (await db.execute(select(QbSyncJob)
        .join(QbSyncJobScope, QbSyncJobScope.run_id == QbSyncJob.run_id).where(
            QbSyncJob.dispatch_job_id.is_(None), QbSyncJob.task_module == 'question',
            QbSyncJobScope.subject_id == subject_id, QbSyncJobScope.source_provider == provider,
            QbSyncJobScope.external_textbook_id == external_id,
            or_(
                QbSyncJob.status.in_(('queued', 'starting', 'running', 'cancelling')),
                (QbSyncJob.options_json['workflowVersion'].as_integer() >= 2) & or_(
                    busy_import, busy_intake, missing_intake,
                    QbSyncJob.options_json['autoResumePending'].as_boolean().is_(True),
                ),
            ),
        ).order_by(QbSyncJob.run_id.desc()).limit(1))).scalars().first()


async def release_finished_books(db) -> int:
    """Retain book reservation until intake/import and bounded resume settle."""
    busy_import = exists().where(
        QbQuestionImport.task_id == QbSyncJob.run_id,
        QbQuestionImport.status.in_(('queued', 'preparing', 'running', 'paused')),
    )
    busy_scope = exists().where(
        QbSyncJobScope.run_id == QbSyncJob.run_id,
        QbSyncJobScope.collector_run_id.is_not(None),
        or_(
            ~exists().where(
                QbQuestionImportIntake.scope_id == QbSyncJobScope.scope_id,
                QbQuestionImportIntake.collector_run_id == QbSyncJobScope.collector_run_id,
            ) & ~exists().where(
                QbQuestionImport.scope_id == QbSyncJobScope.scope_id,
                QbQuestionImport.collector_run_id == QbSyncJobScope.collector_run_id,
            ),
            exists().where(
                QbQuestionImportIntake.scope_id == QbSyncJobScope.scope_id,
                QbQuestionImportIntake.collector_run_id == QbSyncJobScope.collector_run_id,
                QbQuestionImportIntake.status.in_(('pending', 'probing', 'retry')),
            ),
        ),
    )
    rows = (await db.execute(select(QbSyncJob).where(
        QbSyncJob.dispatch_book_key.is_not(None), QbSyncJob.status.in_(TERMINAL),
        QbSyncJob.active_slot.is_(None), ~busy_import, ~busy_scope,
        func.coalesce(QbSyncJob.options_json['autoResumePending'].as_boolean(), False).is_(False),
        func.coalesce(QbSyncJob.options_json['planResumePending'].as_boolean(), False).is_(False),
    ).order_by(QbSyncJob.dispatch_priority.desc(),QbSyncJob.dispatch_rank,QbSyncJob.run_id).limit(100).with_for_update()
        .execution_options(populate_existing=True))).scalars().all()
    released = 0
    for row in rows:
        options = row.options_json or {}
        if options.get('autoResumePending'):
            continue
        if (options.get('autoPlanId') and row.status in ('blocked', 'interrupted')
                and row.error_message):
            from plugins.bank.service.issue_diagnostics import classify_issue
            if classify_issue('scope_failure', row.error_message)['owner'] == 'source_manual':
                row.options_json = {**options, 'planSourceResumePending': True}
        if row.status in ('failed', 'blocked') and row.error_message:
            # Scope-level conflicts remain for human inspection. Budget,
            # rate and host pauses are shared operating conditions instead.
            reason = row.error_message
            if not any(word in reason.lower() for word in ('预算', '水位', '429', '验证', '冷却', 'resource_pressure', 'source_budget')):
                from plugins.bank.service.sync_issues import isolate_scope_failure
                scope = await db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == row.run_id))
                if scope:
                    await isolate_scope_failure(db, row, scope, reason, await _clock(db))
        if row.status == 'completed':
            from plugins.bank.service.sync_issues import resolve_scope_issues
            for scope in await SyncTaskDao.scopes(db, row.run_id):
                await resolve_scope_issues(db, row, scope, await _clock(db))
        row.dispatch_book_key = None
        row.worker_token = None
        released += 1
    await db.commit()
    return released


async def _validate_waiting_scope(db, row, *, lock=True):
    if row.task_module == 'textbook':
        from plugins.bank.service.subject_service import SubjectService
        await SubjectService.require(db, row.subject_id, sync=True)
        return []
    scopes = await SyncTaskDao.scopes(db, row.run_id)
    if len(scopes) != 1:
        raise ServiceException(message='待办任务的单本教材范围无效')
    scope = scopes[0]
    # Creation and import submission lock this same formal book. A dispatch
    # cannot race a retry of an older import for the same source identity.
    if lock:
        await db.get(QbTextbook, scope.local_textbook_id, with_for_update=True, populate_existing=True)
    valid = await db.scalar(select(QbTextbook.textbook_id)
        .join(QbTextbookVersion, QbTextbookVersion.version_id == QbTextbook.version_id)
        .join(QbSubject, QbSubject.subject_id == QbTextbook.subject_id)
        .where(
            QbTextbook.textbook_id == scope.local_textbook_id,
            QbTextbook.version_id == scope.local_version_id,
            QbTextbook.subject_id == row.subject_id,
            QbTextbookVersion.subject_id == row.subject_id,
            QbTextbook.external_textbook_id == scope.external_textbook_id,
            QbTextbook.source_provider == scope.source_provider,
            QbTextbookVersion.source_provider == scope.source_provider,
            QbTextbookVersion.external_version_id == scope.external_version_id,
            QbSubject.source_profile == 'zujuan_czsx',
            QbSubject.status == '0', QbTextbook.status == '0', QbTextbookVersion.status == '0',
        ))
    if not valid or scope.subject_id != row.subject_id:
        raise ServiceException(message='待办教材已停用或来源/学科身份发生变化，请人工核对后重新同步')
    return scopes


async def settling_book_task(db):
    """The normal queue finishes one book's saved result before the next.

    Isolated local faults may leave durable results behind; shared/pending
    work must still finish, independently of the optional backlog limit.
    """
    imported = exists().where(
        QbQuestionImport.scope_id == QbSyncJobScope.scope_id,
        QbQuestionImport.collector_run_id == QbSyncJobScope.collector_run_id,
    )
    intake = exists().where(
        QbQuestionImportIntake.scope_id == QbSyncJobScope.scope_id,
        QbQuestionImportIntake.collector_run_id == QbSyncJobScope.collector_run_id,
    )
    pending = or_(
        QbSyncJob.options_json['planSourceResumePending'].as_boolean().is_(True) & exists().where(
            QbSyncBookState.last_task_id == QbSyncJob.run_id,
            QbSyncBookState.plan_id == QbSyncJob.options_json['autoPlanId'].as_integer()),
        exists().where(QbQuestionImport.task_id == QbSyncJob.run_id,
            QbQuestionImport.status.in_(('queued', 'preparing', 'running', 'paused'))),
        ~imported & exists().where(
            QbQuestionImportIntake.scope_id == QbSyncJobScope.scope_id,
            QbQuestionImportIntake.collector_run_id == QbSyncJobScope.collector_run_id,
            QbQuestionImportIntake.status.in_(('pending', 'probing', 'retry'))),
        QbSyncJobScope.collector_run_id.is_not(None) & ~imported & ~intake,
    )
    isolated = exists().where(
        QbSyncBookState.plan_id == QbSyncJob.options_json['autoPlanId'].as_integer(),
        QbSyncBookState.textbook_id == QbSyncJobScope.local_textbook_id,
        QbSyncBookState.exception_kind.is_not(None),
    )
    from plugins.bank.service.plan_work import results_allowed_condition
    return await db.scalar(select(QbSyncJob.run_id).join(QbSyncJobScope,
        QbSyncJobScope.run_id == QbSyncJob.run_id).where(
        QbSyncJob.task_module == 'question', QbSyncJob.status.in_(TERMINAL),
        QbSyncJob.options_json['workflowVersion'].as_integer() >= 2,
        results_allowed_condition(), ~isolated, pending,
    ).order_by(QbSyncJob.run_id).limit(1))


async def claim_next(db, *, task_id=None) -> dict | None:
    """Only a successful slot INSERT/UPDATE grants execution across processes."""
    now = datetime.now()
    due_now = await _clock(db)
    if await db.scalar(select(QbSyncJob.run_id).where(QbSyncJob.active_slot.is_not(None)).limit(1)):
        return None
    row = (await db.execute(select(QbSyncJob).where(
        QbSyncJob.dispatch_book_key.is_not(None), QbSyncJob.dispatch_job_id.is_not(None),
        QbSyncJob.status == 'queued', QbSyncJob.active_slot.is_(None),
        dispatchable_plan_condition(),
        QbSyncJob.run_id == task_id if task_id is not None else True,
        or_(QbSyncJob.dispatch_not_before.is_(None), QbSyncJob.dispatch_not_before <= due_now),
    ).order_by(QbSyncJob.dispatch_priority.desc(),QbSyncJob.dispatch_rank,QbSyncJob.run_id).limit(1).with_for_update(skip_locked=True)
        .execution_options(populate_existing=True))).scalars().first()
    if row is None:
        return None
    from plugins.bank.service.sync_plans import automatic_task_reason, control_status
    control = await control_status(db)
    reason = (control['reason'] or '同步已紧急暂停') if control['paused'] else await automatic_task_reason(db, row)
    if not reason and row.task_module == 'question':
        settling = await settling_book_task(db)
        if settling is not None:
            reason = f'等待教材任务 #{settling} 的已保存成果完成核验和入库'
    if not reason and row.task_module == 'question':
        # Check host resources before starting a heavy collection, so a
        # shortage waits instead of piling up new results (spec 7.2).
        from plugins.bank.service.resource_guard import resource_status
        try:
            host = resource_status()
        except ServiceException as exc:
            host = {'paused': True, 'reason': exc.message}
        if host.get('paused'):
            # Back off 60 s, 120 s, ... up to 10 min instead of a fixed
            # retry, and log the wait once rather than on every attempt.
            options = row.options_json or {}
            streak = int(options.get('resourceWaitStreak') or 0)
            if streak == 0:
                from plugins.bank.service import diagnostics
                diagnostics.event('collection_resource_wait_entered', taskId=row.run_id, reason=host.get('reason'))
            row.options_json = {**options, 'resourceWaitStreak': streak + 1}
            row.dispatch_error = host.get('reason') or '主机资源不足，等待恢复'
            row.dispatch_not_before = due_now + timedelta(seconds=min(600, 60 * 2 ** min(streak, 4)))
            await db.commit()
            return None
    if reason:
        row.dispatch_error = reason
        row.dispatch_not_before = due_now + timedelta(seconds=30)
        await db.commit()
        return None
    try:
        scopes = await _validate_waiting_scope(db, row)
    except ServiceException as exc:
        row.status = row.phase = 'blocked'
        row.error_message = exc.message
        row.dispatch_error = exc.message
        row.finished_at = row.update_time = now
        for scope in await SyncTaskDao.scopes_for_update(db, row.run_id):
            scope.status = 'blocked'
            scope.error_message = exc.message
            scope.finished_at = scope.update_time = now
        await db.commit()
        return None
    if scopes:
        scope = scopes[0]
        busy_import = await db.scalar(select(QbQuestionImport.import_id).where(
            QbQuestionImport.subject_id == row.subject_id,
            QbQuestionImport.source_provider == scope.source_provider,
            QbQuestionImport.external_textbook_id == scope.external_textbook_id,
            QbQuestionImport.status.in_(('queued', 'preparing', 'running', 'paused')),
        ).limit(1))
        if busy_import is not None:
            row.dispatch_error = '该教材仍有未结束的分批入库，等待完成后派发'
            row.dispatch_not_before = due_now + timedelta(seconds=30)
            await db.commit()
            return None
    # Existing queues also inherit the migrated default at their first claim.
    # Never alter a previously dispatched request or its replay identity.
    options = row.options_json or {}
    plan_id = options.get('autoPlanId') or options.get('manualPlanId')
    if row.task_module == 'question' and plan_id and row.started_at is None and not row.collector_job_id:
        plan = await db.get(QbSyncPlan, plan_id, populate_existing=True)
        if plan is not None:
            row.options_json = {**options, 'catalogPageLimit': plan.catalog_page_limit, 'limitTo1000Pages': False}
    if (row.options_json or {}).get('resourceWaitStreak'):
        row.options_json = {k: v for k, v in (row.options_json or {}).items() if k != 'resourceWaitStreak'}
    token = secrets.token_hex(32)
    row.active_slot = '1'
    row.worker_token = token
    row.dispatch_error = None
    row.dispatch_not_before = None
    row.update_time = now
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        return None
    from plugins.bank.service import diagnostics
    claimed = row.options_json or {}
    diagnostics.event('queue_claimed', stage='queue', taskId=row.run_id, taskModule=row.task_module,
                      planId=claimed.get('autoPlanId') or claimed.get('manualPlanId'),
                      cycleNo=claimed.get('autoCycleNo'), priority=row.dispatch_priority, rank=row.dispatch_rank)
    return {'taskId': row.run_id, 'token': token, 'jobId': row.dispatch_job_id,
            'taskModule': row.task_module, 'runType': row.run_type}


async def cancel_waiting(db, task_id: int) -> bool:
    row = (await db.execute(select(QbSyncJob).where(
        QbSyncJob.run_id == task_id, QbSyncJob.task_module.in_(('question', 'textbook')),
    ).with_for_update().execution_options(populate_existing=True))).scalars().first()
    if row is None or row.status != 'queued' or row.active_slot or not row.dispatch_job_id:
        return False
    now = datetime.now()
    row.status = row.phase = 'cancelled'
    row.dispatch_book_key = None
    row.dispatch_not_before = None
    row.dispatch_error = None
    row.finished_at = row.update_time = now
    for scope in await SyncTaskDao.scopes_for_update(db, task_id):
        scope.status = 'cancelled'
        scope.finished_at = scope.update_time = now
    await db.commit()
    return True


async def dispatch_once(*, session_factory=None, client=None) -> int:
    session_factory = session_factory or DataSourceRegistry.session
    async with session_factory() as db:
        await release_finished_books(db)
        from plugins.bank.service.sync_plans import control_status
        if (await control_status(db))['paused']:
            return 0
        if await db.scalar(select(QbSyncJob.run_id).where(QbSyncJob.active_slot.is_not(None)).limit(1)):
            return 0
        due = await db.scalar(select(QbSyncJob.run_id).where(
            QbSyncJob.dispatch_book_key.is_not(None), QbSyncJob.status == 'queued',
            QbSyncJob.active_slot.is_(None), dispatchable_plan_condition(),
            or_(QbSyncJob.dispatch_not_before.is_(None), QbSyncJob.dispatch_not_before <= await _clock(db)),
        ).order_by(QbSyncJob.dispatch_priority.desc(),QbSyncJob.dispatch_rank,QbSyncJob.run_id).limit(1))
        backlog_reason = None
        if due is not None:
            try:
                limit = configured_limit('BANK_SYNC_MAX_PENDING_IMPORTS')
                if limit:
                    runnable_tasks=select(QbSyncJob.run_id).where(allowed_condition())
                    imports = await db.scalar(select(func.count()).select_from(QbQuestionImport).where(
                        QbQuestionImport.status.in_(('queued', 'preparing', 'running', 'paused')),
                        QbQuestionImport.task_id.in_(runnable_tasks),
                    ))
                    intakes = await db.scalar(select(func.count()).select_from(QbQuestionImportIntake).where(
                        QbQuestionImportIntake.status.in_(('pending', 'probing', 'retry')),
                        QbQuestionImportIntake.task_id.in_(runnable_tasks),
                    ))
                    if imports + intakes >= limit:
                        backlog_reason = '封存核验或分批入库积压已达上限，等待处理后派发'
            except ServiceException as exc:
                backlog_reason = exc.message
    if due is None:
        return 0
    try:
        local = resource_status()
        local_reason = local.get('reason')
        start_memory = configured_limit('BANK_COLLECTION_START_MEMORY_MIB')
        if not local_reason and start_memory and local.get('availableMemoryMiB') is not None and local['availableMemoryMiB'] < start_memory:
            local_reason = f"等待采集启动内存：当前可用 {local['availableMemoryMiB']} MiB，需要 {start_memory} MiB；入库继续处理已有成果"
    except ServiceException as exc:
        local_reason = exc.message
    if backlog_reason or local_reason:
        async with session_factory() as db:
            row = await db.get(QbSyncJob, due, with_for_update=True, populate_existing=True)
            if row and row.status == 'queued' and row.active_slot is None:
                row.dispatch_error = str(backlog_reason or local_reason)[:500]
                row.dispatch_not_before = await _clock(db) + timedelta(seconds=30)
                await db.commit()
        return 0
    # Reclaim one eligible old result between books, while the collector is idle.
    from plugins.bank.service.result_cleanup import cleanup_once
    try:
        await cleanup_once(session_factory=session_factory, client=client)
    except Exception:
        from utils.log_util import logger
        logger.warning('旧成果回收延后，继续派发采集')
    # No database session/transaction is held during the Collector call.
    try:
        health = await asyncio.to_thread((client or CollectorClient()).health)
    except ServiceException as exc:
        async with session_factory() as db:
            row = await db.get(QbSyncJob, due, with_for_update=True, populate_existing=True)
            if row and row.status == 'queued' and row.active_slot is None:
                row.dispatch_error = str(exc.message or '采集器暂不可用，等待恢复')[:500]
                row.dispatch_not_before = await _clock(db) + timedelta(seconds=30)
                await db.commit()
        return 0
    async with session_factory() as db:
        due_row = await db.get(QbSyncJob, due)
        automatic = bool(due_row and is_automatic_task(due_row))
    if automatic:
        from plugins.bank.service.sync_plans import unattended_reason
        reason = unattended_reason(health)
        if reason:
            async with session_factory() as db:
                row = await db.get(QbSyncJob, due, with_for_update=True, populate_existing=True)
                if row and row.status == 'queued' and row.active_slot is None:
                    row.dispatch_error = reason
                    row.dispatch_not_before = await _clock(db) + timedelta(seconds=30)
                    await db.commit()
                # Automatic-only prerequisites must not block a manual book.
                due = await db.scalar(select(QbSyncJob.run_id).where(
                    QbSyncJob.dispatch_book_key.is_not(None), QbSyncJob.status == 'queued',
                    QbSyncJob.active_slot.is_(None), dispatchable_plan_condition(manual_only=True),
                    or_(QbSyncJob.dispatch_not_before.is_(None), QbSyncJob.dispatch_not_before <= await _clock(db)),
                ).order_by(QbSyncJob.dispatch_priority.desc(),QbSyncJob.dispatch_rank,QbSyncJob.run_id).limit(1))
            if due is None:
                return 0
    for key in ('sourceBudget', 'resources'):
        state = health.get(key) or {}
        if state.get('paused'):
            async with session_factory() as db:
                row = await db.get(QbSyncJob, due, with_for_update=True, populate_existing=True)
                if row and row.status == 'queued' and row.active_slot is None:
                    row.dispatch_error = state.get('reason') or '采集条件暂不可用，等待恢复'
                    row.dispatch_not_before = await _clock(db) + timedelta(seconds=30)
                    await db.commit()
            return 0
    control = health.get('sourceControl') if isinstance(health, dict) else None
    if isinstance(control, dict) and control.get('paused') is True:
        deadline = None
        try:
            deadline = datetime.fromisoformat(str(control.get('notBefore') or '').replace('Z', '+00:00'))
            if deadline.tzinfo:
                deadline = deadline.astimezone(timezone.utc).replace(tzinfo=None)
            else:
                deadline = None
        except (ValueError, OverflowError):
            pass
        async with session_factory() as db:
            row = await db.get(QbSyncJob, due, with_for_update=True, populate_existing=True)
            if row and row.status == 'queued' and row.active_slot is None:
                not_before = await _clock(db) + timedelta(seconds=300 if control.get('manualRequired') else 30)
                row.dispatch_error = str(control.get('reason') or '来源公共暂停，等待恢复')[:500]
                row.dispatch_not_before = max(not_before, deadline) if deadline else not_before
                await db.commit()
        return 0
    async with session_factory() as db:
        ticket = await claim_next(db, task_id=due)
    if ticket is None:
        return 0
    from plugins.bank.service.sync_run_service import _WORKERS, _execute, _WorkerHandle

    handle = _WorkerHandle(token=ticket['token'], task_module=ticket['taskModule'],
                           run_type=ticket['runType'], workflow_version=2)
    _WORKERS[ticket['taskId']] = handle
    handle.task = asyncio.create_task(_execute(ticket['taskId'], handle))
    return 1


async def _loop():
    while True:
        try:
            from plugins.bank.service.plan_control import reconcile_controls
            await reconcile_controls(DataSourceRegistry.session)
            from plugins.bank.service.metadata_discovery import merge_completed_discoveries
            await merge_completed_discoveries(session_factory=DataSourceRegistry.session)
            from plugins.bank.service.sync_plans import schedule_once
            try:
                await schedule_once(session_factory=DataSourceRegistry.session, client=CollectorClient())
            except Exception:
                from utils.log_util import logger
                logger.exception('自动计划暂不可用，继续处理已有同步待办')
            await dispatch_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            # Temporary DB/Collector errors leave durable pending rows intact.
            from utils.log_util import logger
            logger.exception('同步待办派发失败，将自动重试')
        await asyncio.sleep(POLL_SECONDS)


def start_sync_dispatch_worker():
    global _TASK
    if _TASK is None or _TASK.done():
        _TASK = asyncio.create_task(_loop(), name='bank-sync-dispatch')


async def stop_sync_dispatch_worker():
    global _TASK
    task, _TASK = _TASK, None
    if task:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
