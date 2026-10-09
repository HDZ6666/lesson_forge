"""Durable waiting and execution claims on the existing business task row."""

from __future__ import annotations

import asyncio
import hashlib
import json
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
    QbSyncJob,
    QbSyncJobScope,
    QbTextbook,
    QbTextbookVersion,
)
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.import_dates import utc_datetime
from plugins.bank.service.incremental_import import _clock
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
    return {
        'queueState': state,
        'queueNotBefore': utc_datetime(row.dispatch_not_before),
        'queueReason': row.dispatch_error,
    }


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
        QbQuestionImport.status.in_(('queued', 'preparing', 'running')),
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
        QbQuestionImport.status.in_(('queued', 'preparing', 'running')),
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
    ).order_by(QbSyncJob.run_id).limit(100).with_for_update()
        .execution_options(populate_existing=True))).scalars().all()
    released = 0
    for row in rows:
        options = row.options_json or {}
        if options.get('autoResumePending'):
            continue
        if row.status in ('failed', 'blocked') and row.error_message:
            # Scope-level conflicts remain for human inspection. Budget,
            # rate and host pauses are shared operating conditions instead.
            reason = row.error_message
            if not any(word in reason.lower() for word in ('预算', '水位', '429', '验证', '冷却', 'resource_pressure', 'source_budget')):
                from plugins.bank.service.sync_issues import observe
                scope = await db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == row.run_id))
                if scope:
                    await observe(db, subject_id=row.subject_id, provider=scope.source_provider,
                        book_id=scope.local_textbook_id, task_id=row.run_id, kind='scope',
                        key=scope.external_textbook_id, error_type='scope_failure', reason=reason,
                        evidence={'collectorRunId': scope.collector_run_id, 'status': row.status}, now=await _clock(db))
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


async def claim_next(db) -> dict | None:
    """Only a successful slot INSERT/UPDATE grants execution across processes."""
    now = datetime.now()
    due_now = await _clock(db)
    if await db.scalar(select(QbSyncJob.run_id).where(QbSyncJob.active_slot.is_not(None)).limit(1)):
        return None
    row = (await db.execute(select(QbSyncJob).where(
        QbSyncJob.dispatch_book_key.is_not(None), QbSyncJob.dispatch_job_id.is_not(None),
        QbSyncJob.status == 'queued', QbSyncJob.active_slot.is_(None),
        or_(QbSyncJob.dispatch_not_before.is_(None), QbSyncJob.dispatch_not_before <= due_now),
    ).order_by(QbSyncJob.run_id).limit(1).with_for_update(skip_locked=True)
        .execution_options(populate_existing=True))).scalars().first()
    if row is None:
        return None
    from plugins.bank.service.sync_plans import automatic_task_reason, control_status
    control = await control_status(db)
    reason = (control['reason'] or '同步已紧急暂停') if control['paused'] else await automatic_task_reason(db, row)
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
    scope = scopes[0]
    busy_import = await db.scalar(select(QbQuestionImport.import_id).where(
        QbQuestionImport.subject_id == row.subject_id,
        QbQuestionImport.source_provider == scope.source_provider,
        QbQuestionImport.external_textbook_id == scope.external_textbook_id,
        QbQuestionImport.status.in_(('queued', 'preparing', 'running')),
    ).limit(1))
    if busy_import is not None:
        row.dispatch_error = '该教材仍有未结束的分批入库，等待完成后派发'
        row.dispatch_not_before = due_now + timedelta(seconds=30)
        await db.commit()
        return None
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
    return {'taskId': row.run_id, 'token': token, 'jobId': row.dispatch_job_id}


async def cancel_waiting(db, task_id: int) -> bool:
    row = (await db.execute(select(QbSyncJob).where(
        QbSyncJob.run_id == task_id, QbSyncJob.task_module == 'question',
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
            QbSyncJob.active_slot.is_(None),
            or_(QbSyncJob.dispatch_not_before.is_(None), QbSyncJob.dispatch_not_before <= await _clock(db)),
        ).order_by(QbSyncJob.run_id).limit(1))
        backlog_reason = None
        if due is not None:
            try:
                limit = configured_limit('BANK_SYNC_MAX_PENDING_IMPORTS')
                if limit:
                    imports = await db.scalar(select(func.count()).select_from(QbQuestionImport).where(
                        QbQuestionImport.status.in_(('queued', 'preparing', 'running')),
                    ))
                    intakes = await db.scalar(select(func.count()).select_from(QbQuestionImportIntake).where(
                        QbQuestionImportIntake.status.in_(('pending', 'probing', 'retry')),
                    ))
                    if imports + intakes >= limit:
                        backlog_reason = '封存核验或分批入库积压已达上限，等待处理后派发'
            except ServiceException as exc:
                backlog_reason = exc.message
    if due is None:
        return 0
    try:
        local_reason = resource_status().get('reason')
    except ServiceException as exc:
        local_reason = exc.message
    if backlog_reason or local_reason:
        async with session_factory() as db:
            row = await SyncTaskDao.get_for_update(db, due, 'question')
            if row and row.status == 'queued' and row.active_slot is None:
                row.dispatch_error = str(backlog_reason or local_reason)[:500]
                row.dispatch_not_before = await _clock(db) + timedelta(seconds=30)
                await db.commit()
        return 0
    # No database session/transaction is held during the Collector call.
    try:
        health = await asyncio.to_thread((client or CollectorClient()).health)
    except ServiceException as exc:
        async with session_factory() as db:
            row = await SyncTaskDao.get_for_update(db, due, 'question')
            if row and row.status == 'queued' and row.active_slot is None:
                row.dispatch_error = str(exc.message or '采集器暂不可用，等待恢复')[:500]
                row.dispatch_not_before = await _clock(db) + timedelta(seconds=30)
                await db.commit()
        return 0
    async with session_factory() as db:
        due_row = await db.get(QbSyncJob, due)
        automatic = bool(due_row and (due_row.options_json or {}).get('autoPlanId'))
    if automatic:
        from plugins.bank.service.sync_plans import unattended_reason
        reason = unattended_reason(health)
        if reason:
            async with session_factory() as db:
                row = await SyncTaskDao.get_for_update(db, due, 'question')
                if row and row.status == 'queued' and row.active_slot is None:
                    row.dispatch_error = reason
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
            row = await SyncTaskDao.get_for_update(db, due, 'question')
            if row and row.status == 'queued' and row.active_slot is None:
                not_before = await _clock(db) + timedelta(seconds=300 if control.get('manualRequired') else 30)
                row.dispatch_error = str(control.get('reason') or '来源公共暂停，等待恢复')[:500]
                row.dispatch_not_before = max(not_before, deadline) if deadline else not_before
                await db.commit()
        return 0
    async with session_factory() as db:
        ticket = await claim_next(db)
    if ticket is None:
        return 0
    from plugins.bank.service.sync_run_service import _WORKERS, _execute, _WorkerHandle

    handle = _WorkerHandle(token=ticket['token'], task_module='question', run_type='content', workflow_version=2)
    _WORKERS[ticket['taskId']] = handle
    handle.task = asyncio.create_task(_execute(ticket['taskId'], handle))
    return 1


async def _loop():
    while True:
        try:
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
