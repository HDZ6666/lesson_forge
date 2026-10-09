"""Durable terminal-run verification and atomic automatic import submission."""

from __future__ import annotations

import secrets
from datetime import timedelta
from typing import Any

from sqlalchemy import exists, func, or_, select

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbQuestionImport,
    QbQuestionImportIntake,
    QbSubject,
    QbSyncJob,
    QbSyncJobScope,
    QbTextbook,
)
from plugins.bank.service.import_dates import utc_datetime
from plugins.bank.service.incremental_import import (
    TERMINAL,
    _binding,
    _clock,
    _digest,
    _fresh_transaction,
    _queue_verified_scope,
    _source_lock,
    attach_coverage_evidence,
    import_status,
)
from plugins.bank.service.question_apply_service import _coerce_datetime

INTAKE_LEASE_SECONDS = 60
INTAKE_MAX_ATTEMPTS = 3
INTAKE_RETRY_DELAYS = (30, 90, 300)
COUNT_FIELDS = {
    'catalogs': 'catalog_count', 'questions': 'question_count',
    'questionCatalogs': 'question_catalog_count', 'tags': 'question_tag_count', 'assets': 'question_asset_count',
}


def _descriptor(task: Any, scope: Any) -> dict[str, Any]:
    return {
        'taskId': task.run_id, 'scopeId': scope.scope_id, 'subjectId': scope.subject_id,
        'provider': scope.source_provider, 'textbookId': scope.local_textbook_id,
        'versionId': scope.local_version_id, 'textbookExternalId': scope.external_textbook_id,
        'versionExternalId': scope.external_version_id, 'collectorRunId': scope.collector_run_id,
        'collectorJobId': scope.collector_job_id,
    }


def intake_status(row: QbQuestionImportIntake) -> dict[str, Any]:
    return {
        'intakeId': row.intake_id, 'taskId': row.task_id, 'collectorRunId': row.collector_run_id,
        'status': row.status, 'attemptCount': row.attempt_count, 'attemptLimit': row.attempt_limit,
        'nextAttemptAt': utc_datetime(row.next_attempt_at), 'errorKind': row.error_kind,
        'errorMessage': row.error_message, 'importId': row.import_id,
    }


async def current_task_intake_status(db: Any, task_id: int, scopes: list[Any]):
    if len(scopes) != 1 or not scopes[0].collector_run_id:
        return None
    row = await db.scalar(select(QbQuestionImportIntake).where(
        QbQuestionImportIntake.task_id == task_id,
        QbQuestionImportIntake.scope_id == scopes[0].scope_id,
        QbQuestionImportIntake.collector_run_id == scopes[0].collector_run_id,
    ))
    return intake_status(row) if row is not None else None


async def register_import_intake(db: Any, scope_id: int) -> dict[str, Any] | None:
    """Persist only local identities; never fetch a snapshot while holding locks."""
    _fresh_transaction(db)
    try:
        await _source_lock(db)
        task, scope = await _binding(db, scope_id, require_seal=False, validate_book=False)
        existing_import = await db.scalar(select(QbQuestionImport.import_id).where(
            QbQuestionImport.scope_id == scope_id, QbQuestionImport.collector_run_id == scope.collector_run_id,
        ))
        if existing_import is not None:
            await db.rollback()
            return None
        row = await db.scalar(select(QbQuestionImportIntake).where(
            QbQuestionImportIntake.scope_id == scope_id,
            QbQuestionImportIntake.collector_run_id == scope.collector_run_id,
        ).with_for_update().execution_options(populate_existing=True))
        if row is None:
            now = await _clock(db)
            row = QbQuestionImportIntake(
                task_id=task.run_id, scope_id=scope_id, collector_run_id=scope.collector_run_id,
                binding_hash=_digest(_descriptor(task, scope)), status='pending',
                attempt_count=0, attempt_limit=INTAKE_MAX_ATTEMPTS, create_time=now, update_time=now,
            )
            db.add(row)
            await db.flush()
        result = intake_status(row)
        await db.commit()
        return result
    except BaseException:
        await db.rollback()
        raise


async def unregistered_terminal_scope_ids(db: Any, *, limit: int = 25) -> list[int]:
    """Recover the crash window between finishing collection and registration."""
    return list((await db.scalars(select(QbSyncJobScope.scope_id).join(
        QbSyncJob, QbSyncJob.run_id == QbSyncJobScope.run_id,
    ).join(QbSubject, QbSubject.subject_id == QbSyncJobScope.subject_id).where(
        QbSyncJob.task_module == 'question', QbSyncJob.run_type == 'content',
        QbSyncJob.subject_id == 1, QbSyncJob.options_json['workflowVersion'].as_integer() == 2,
        QbSyncJob.status.in_(TERMINAL), QbSyncJobScope.status.in_(TERMINAL),
        QbSubject.status == '0', QbSubject.source_profile == 'zujuan_czsx',
        QbSyncJobScope.source_provider == 'zujuan', QbSyncJobScope.collector_run_id > 0,
        QbSyncJob.run_id.in_(select(QbSyncJobScope.run_id).group_by(
            QbSyncJobScope.run_id,
        ).having(func.count() == 1)),
        ~exists().where(
            QbQuestionImport.scope_id == QbSyncJobScope.scope_id,
            QbQuestionImport.collector_run_id == QbSyncJobScope.collector_run_id,
        ),
        ~exists().where(
            QbQuestionImportIntake.scope_id == QbSyncJobScope.scope_id,
            QbQuestionImportIntake.collector_run_id == QbSyncJobScope.collector_run_id,
        ),
    ).order_by(QbSyncJobScope.scope_id).limit(limit))).all())


async def due_import_intake_ids(db: Any, *, limit: int = 10) -> list[int]:
    now = await _clock(db)
    return list((await db.scalars(select(QbQuestionImportIntake.intake_id).join(
        QbSubject, QbSubject.subject_id == 1,
    ).where(QbSubject.status == '0', QbSubject.source_profile == 'zujuan_czsx', or_(
        QbQuestionImportIntake.status == 'pending',
        (QbQuestionImportIntake.status == 'retry') & (QbQuestionImportIntake.next_attempt_at <= now),
        (QbQuestionImportIntake.status == 'probing') & (QbQuestionImportIntake.lease_until <= now),
    )).order_by(QbQuestionImportIntake.intake_id).limit(limit))).all())


def _release(row: Any):
    row.worker_token = None
    row.lease_until = None


def _block(row: Any, now: Any, kind: str, message: str):
    row.status = 'blocked'
    row.error_kind = kind
    row.error_message = str(message)[:2000]
    row.next_attempt_at = None
    row.update_time = now
    _release(row)


async def claim_import_intake(db: Any, intake_id: int) -> dict[str, Any] | None:
    _fresh_transaction(db)
    try:
        await _source_lock(db)
        row = await db.get(QbQuestionImportIntake, intake_id, with_for_update=True, populate_existing=True)
        now = await _clock(db)
        if row is None or row.status not in {'pending', 'retry', 'probing'}:
            await db.rollback()
            return None
        if (row.status == 'retry' and row.next_attempt_at and row.next_attempt_at > now) or (
            row.worker_token and row.lease_until and row.lease_until > now
        ):
            await db.rollback()
            return None
        try:
            task, scope = await _binding(db, row.scope_id, require_seal=False, validate_book=False)
            descriptor = _descriptor(task, scope)
            if _digest(descriptor) != row.binding_hash:
                raise ServiceException(message='采集运行绑定已变化，停止旧成果自动提交')
        except ServiceException as exc:
            _block(row, now, 'binding', exc.message)
            row.status = 'discarded'
            await db.commit()
            return None
        book = await db.get(QbTextbook, scope.local_textbook_id, with_for_update=True, populate_existing=True)
        if (
            book is None or book.subject_id != 1 or book.status != '0'
            or book.source_provider != 'zujuan' or book.external_textbook_id != scope.external_textbook_id
            or book.version_id != scope.local_version_id
        ):
            _block(row, now, 'book_binding', '入库任务与当前教材归属不一致或教材已停用')
            await db.commit()
            return None
        if row.attempt_count >= row.attempt_limit:
            _block(row, now, 'retry_budget', '封存核验重试次数已用完，请检查采集服务后重试核验')
            await db.commit()
            return None
        row.status = 'probing'
        row.worker_token = secrets.token_hex(32)
        row.lease_until = now + timedelta(seconds=INTAKE_LEASE_SECONDS)
        row.attempt_count += 1
        row.update_time = now
        ticket = {
            **descriptor, 'intakeId': intake_id, 'bindingHash': row.binding_hash, 'workerToken': row.worker_token,
        }
        await db.commit()
        return ticket
    except BaseException:
        await db.rollback()
        raise


def _owned(row: Any, ticket: dict[str, Any], now: Any):
    if (
        row is None or row.status != 'probing' or not row.worker_token
        or row.worker_token != ticket.get('workerToken') or row.binding_hash != ticket.get('bindingHash')
        or row.lease_until is None or row.lease_until <= now
        or row.collector_run_id != ticket.get('collectorRunId') or row.task_id != ticket.get('taskId')
    ):
        raise ServiceException(message='封存核验执行权已过期或被接管')


async def complete_import_intake(db: Any, ticket: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
    """Verified seal, all five counts, task totals and import ID share a commit."""
    _fresh_transaction(db)
    try:
        await _source_lock(db)
        row = await db.get(QbQuestionImportIntake, ticket['intakeId'], with_for_update=True, populate_existing=True)
        now = await _clock(db)
        _owned(row, ticket, now)
        task, scope = await _binding(db, row.scope_id, require_seal=False)
        if _digest(_descriptor(task, scope)) != row.binding_hash:
            raise ServiceException(message='采集运行绑定在核验期间发生变化，不能提交旧成果')
        lock = summary.get('snapshot_locked_at') or _coerce_datetime(
            summary['run'].get('snapshotLockedAt', summary['run'].get('snapshot_locked_at')),
        )
        if (
            summary['collector_run_id'] != row.collector_run_id or lock is None
            or summary.get('textbook_external_id') != scope.external_textbook_id
            or summary.get('immutable') is not True or type(summary.get('snapshot_complete')) is not bool
            or any(type(summary['counts'].get(key)) is not int or summary['counts'][key] < 0 for key in COUNT_FIELDS)
        ):
            raise ServiceException(message='封存摘要与运行身份不一致')
        if scope.snapshot_locked_at is not None and scope.snapshot_locked_at != lock:
            raise ServiceException(message='封存时刻与已保存的运行证据冲突')
        existing = await db.scalar(select(QbQuestionImport).where(
            QbQuestionImport.scope_id == scope.scope_id,
            QbQuestionImport.collector_run_id == row.collector_run_id,
        ).with_for_update().execution_options(populate_existing=True))
        if existing is not None and (
            existing.snapshot_locked_at != lock
            or bool(existing.snapshot_complete) != summary['snapshot_complete']
            or existing.question_count != summary['counts']['questions']
        ):
            raise ServiceException(message='封存摘要与现有入库断点冲突，需人工判断')
        for collection, field in COUNT_FIELDS.items():
            setattr(scope, field, summary['counts'][collection])
            setattr(task, field, summary['counts'][collection])
        scope.snapshot_locked_at = lock
        scope.snapshot_complete = int(summary['snapshot_complete'])
        task.snapshot_locked_at = lock
        task.snapshot_complete = int(summary['snapshot_complete'])
        scope.update_time = now
        task.update_time = now
        queued = await _queue_verified_scope(db, scope, now, retry_failed=False)
        attach_coverage_evidence(queued, summary.get('run_coverage'))
        row.status = 'ready'
        row.import_id = queued.import_id
        row.error_kind = None
        row.error_message = None
        row.next_attempt_at = None
        row.update_time = now
        _release(row)
        result = import_status(queued)
        await db.commit()
        return result
    except BaseException:
        await db.rollback()
        raise


async def ensure_import_intake_finished(db: Any, task_id: int, *, automatic: bool = False):
    """Called under the task lock; nonlocking reads avoid an intake/task cycle."""
    scopes = list((await db.scalars(select(QbSyncJobScope).where(QbSyncJobScope.run_id == task_id))).all())
    for scope in scopes:
        if not scope.collector_run_id:
            continue
        intake = await db.scalar(select(QbQuestionImportIntake).where(
            QbQuestionImportIntake.scope_id == scope.scope_id,
            QbQuestionImportIntake.collector_run_id == scope.collector_run_id,
        ))
        if intake is not None and intake.status in {'pending', 'probing', 'retry'}:
            raise ServiceException(message='任务正在封存核验，请等待核验和分批入库结束后再续采或删除')
        if automatic and intake is not None and intake.status in {'blocked', 'discarded'}:
            raise ServiceException(message='当前运行封存核验需要人工判断，暂停自动续采')
        if intake is None:
            imported = await db.scalar(select(QbQuestionImport.import_id).where(
                QbQuestionImport.scope_id == scope.scope_id,
                QbQuestionImport.collector_run_id == scope.collector_run_id,
            ))
            if imported is None:
                raise ServiceException(message='任务等待封存核验登记，请稍后再续采或删除')


async def fail_import_intake(db: Any, ticket: dict[str, Any], kind: str, message: str, *, retryable: bool):
    _fresh_transaction(db)
    try:
        row = await db.get(QbQuestionImportIntake, ticket['intakeId'], with_for_update=True, populate_existing=True)
        now = await _clock(db)
        _owned(row, ticket, now)
        _block(row, now, kind, message)
        if retryable and row.attempt_count < row.attempt_limit:
            row.status = 'retry'
            delay = INTAKE_RETRY_DELAYS[min(row.attempt_count - 1, len(INTAKE_RETRY_DELAYS) - 1)]
            row.next_attempt_at = now + timedelta(seconds=delay)
        await db.commit()
    except BaseException:
        await db.rollback()
        raise


async def retry_import_intake(db: Any, task_id: int) -> dict[str, Any]:
    _fresh_transaction(db)
    try:
        await _source_lock(db)
        scopes = list((await db.scalars(select(QbSyncJobScope.scope_id).where(
            QbSyncJobScope.run_id == task_id,
        ))).all())
        if len(scopes) != 1:
            raise ServiceException(message='封存核验任务必须只绑定一本教材')
        task, scope = await _binding(db, scopes[0], require_seal=False)
        row = await db.scalar(select(QbQuestionImportIntake).where(
            QbQuestionImportIntake.scope_id == scope.scope_id,
            QbQuestionImportIntake.collector_run_id == scope.collector_run_id,
        ).with_for_update().execution_options(populate_existing=True))
        if row is None or row.binding_hash != _digest(_descriptor(task, scope)):
            raise ServiceException(message='当前任务没有可重试的封存核验，请刷新任务')
        if row.status not in {'retry', 'blocked'}:
            result = intake_status(row)
        else:
            row.status = 'pending'
            row.attempt_limit = row.attempt_count + INTAKE_MAX_ATTEMPTS
            row.next_attempt_at = None
            row.error_kind = None
            row.error_message = None
            row.update_time = await _clock(db)
            result = intake_status(row)
        await db.commit()
        return result
    except BaseException:
        await db.rollback()
        raise
