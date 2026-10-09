"""Durable preparation leases and atomic journals for incremental imports."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import secrets
from datetime import timedelta
from typing import Any

from sqlalchemy import DateTime, case, func, or_, select

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbQuestionImport,
    QbQuestionImportBatch,
    QbSubject,
    QbSyncJob,
    QbSyncJobScope,
    QbTextbook,
)
from plugins.bank.service.import_dates import utc_datetime
from plugins.bank.service.incremental_merge import MAX_MERGE_QUESTIONS, merge_prepared_incremental_batch
from plugins.bank.service.incremental_snapshot import QC_FORMAT
from plugins.bank.service.question_apply_service import (
    _coerce_datetime,
    _empty_stats,
    _jsonable,
    _merge_stats,
    _safe_external_id,
    _uses_incremental_workflow,
)
from plugins.bank.service.run_coverage import normalise_run_coverage, run_coverage_status

LEASE_SECONDS = 300
TERMINAL = {'completed', 'failed', 'blocked', 'interrupted', 'cancelled'}


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(_jsonable(value), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _fresh_transaction(db: Any) -> None:
    if db.in_transaction():
        raise ServiceException(message='入库断点操作需要独立短事务')


async def _clock(db: Any):
    # Use the database clock for cross-process expiry, not a worker's clock.
    timestamp = func.utc_timestamp if db.bind.dialect.name == 'mysql' else func.current_timestamp
    return await db.scalar(select(timestamp(type_=DateTime)))


async def _source_lock(db: Any) -> None:
    subject = await db.get(QbSubject, 1, with_for_update=True, populate_existing=True)
    if subject is None or subject.status != '0' or subject.source_profile != 'zujuan_czsx':
        raise ServiceException(message='入库学科来源不可用')


async def _binding(db: Any, scope_id: int, *, require_seal: bool = True, validate_book: bool = True):
    # Peek only to establish task -> scope lock order. Re-read under locks.
    task_id = await db.scalar(select(QbSyncJobScope.run_id).where(QbSyncJobScope.scope_id == scope_id))
    task = await db.get(QbSyncJob, task_id, with_for_update=True, populate_existing=True) if task_id else None
    scope = await db.get(QbSyncJobScope, scope_id, with_for_update=True, populate_existing=True)
    if (
        task is None
        or scope is None
        or scope.run_id != task.run_id
        or task.task_module != 'question'
        or task.run_type != 'content'
        or not _uses_incremental_workflow(task)
        or task.subject_id != 1
        or scope.subject_id != 1
        or task.status not in TERMINAL
        or scope.status not in TERMINAL
        or scope.source_provider != 'zujuan'
        or not scope.collector_run_id
        or (require_seal and not scope.snapshot_locked_at)
    ):
        raise ServiceException(message='任务尚未封存或不属于单本增量入库流程')
    count = await db.scalar(
        select(func.count()).select_from(QbSyncJobScope).where(QbSyncJobScope.run_id == task.run_id)
    )
    if count != 1:
        raise ServiceException(message='增量入库任务必须只绑定一本教材')
    if not validate_book:
        return task, scope
    book = await db.get(QbTextbook, scope.local_textbook_id, with_for_update=True, populate_existing=True)
    if (
        book is None
        or book.subject_id != 1
        or book.status != '0'
        or book.source_provider != 'zujuan'
        or book.external_textbook_id != scope.external_textbook_id
        or book.version_id != scope.local_version_id
    ):
        raise ServiceException(message='入库任务与当前教材归属不一致或教材已停用')
    return task, scope


def _identity(scope: QbSyncJobScope, report: dict[str, Any]) -> str:
    return _digest(
        {
            'scopeId': scope.scope_id,
            'taskId': scope.run_id,
            'subjectId': scope.subject_id,
            'provider': scope.source_provider,
            'localTextbookId': scope.local_textbook_id,
            'textbookExternalId': scope.external_textbook_id,
            'collectorRunId': scope.collector_run_id,
            'snapshotLockedAt': scope.snapshot_locked_at,
            'questionCount': scope.question_count,
            'snapshotComplete': bool(scope.snapshot_complete),
            'qualityHash': report['qualityHash'],
            'format': QC_FORMAT,
        }
    )


def _check_report(scope: QbSyncJobScope, report: dict[str, Any]) -> None:
    if (
        report.get('format') != QC_FORMAT
        or not re.fullmatch('[0-9a-f]{64}', str(report.get('qualityHash', '')))
        or any(type(report.get(key)) is not int or report[key] < 0 for key in ('checked', 'accepted', 'quarantined'))
        or report['checked'] != report['accepted'] + report['quarantined']
        or report['checked'] != scope.question_count
        or type(report.get('snapshotComplete')) is not bool
        or report['snapshotComplete'] != bool(scope.snapshot_complete)
        or report.get('taskId') != scope.run_id
        or report.get('collectorRunId') != scope.collector_run_id
        or report.get('textbookExternalId') != scope.external_textbook_id
        or _coerce_datetime(report.get('snapshotLockedAt')) != scope.snapshot_locked_at
    ):
        raise ServiceException(message='质量检查结果与任务封存身份或数量不一致')


def import_status(row: QbQuestionImport) -> dict[str, Any]:
    """Lightweight public-safe projection; no lease token, path or QC payload."""
    return {
        'importId': row.import_id,
        'taskId': row.task_id,
        'scopeId': row.scope_id,
        'collectorRunId': row.collector_run_id,
        'textbookId': row.local_textbook_id,
        'status': row.status,
        'stage': row.stage,
        'questionCount': row.question_count,
        'checkedCount': row.question_count if row.quality_hash else 0,
        'processedCount': row.cursor,
        'acceptedCount': row.accepted_count,
        'quarantinedCount': row.quarantined_count,
        'batchCount': row.batch_no,
        'snapshotComplete': bool(row.snapshot_complete),
        'stats': copy.deepcopy(row.stats_json),
        'errorMessage': row.error_message,
        'finishedAt': utc_datetime(row.finished_at),
        'isCurrent': False,
        'runCoverage': run_coverage_status(row.run_coverage_json, row.question_count),
    }


def import_binding_matches_scope(row: QbQuestionImport, scope: QbSyncJobScope) -> bool:
    return (
        row.task_id == scope.run_id and row.scope_id == scope.scope_id
        and row.collector_run_id == scope.collector_run_id
        and row.local_textbook_id == scope.local_textbook_id
        and row.external_textbook_id == scope.external_textbook_id
        and row.subject_id == scope.subject_id and row.source_provider == scope.source_provider
        and row.snapshot_locked_at == scope.snapshot_locked_at
        and bool(row.snapshot_complete) == bool(scope.snapshot_complete)
    )


async def current_task_import_status(db: Any, task_id: int, scopes: list[Any]) -> dict[str, Any] | None:
    """Read only the current single-book binding; older resume runs are history."""
    if len(scopes) != 1 or not scopes[0].collector_run_id:
        return None
    scope = scopes[0]
    row = await db.scalar(
        select(QbQuestionImport)
        .where(
            QbQuestionImport.task_id == task_id,
            QbQuestionImport.scope_id == scope.scope_id,
            QbQuestionImport.collector_run_id == scope.collector_run_id,
        )
        .limit(1)
    )
    return import_status(row) if row is not None and import_binding_matches_scope(row, scope) else None


def _ticket(row: QbQuestionImport) -> dict[str, Any]:
    return {
        **import_status(row),
        'workerToken': row.worker_token,
        'identityHash': row.identity_hash,
        'qualityHash': row.quality_hash,
        'coverageEvidence': copy.deepcopy(row.run_coverage_json),
        'textbookExternalId': row.external_textbook_id,
        'snapshotLockedAt': row.snapshot_locked_at,
        'cursor': row.cursor,
        'done': row.status in {'completed', 'partial'},
    }


def _new_import(scope: QbSyncJobScope, now: Any, *, quality_hash: str | None = None) -> QbQuestionImport:
    return QbQuestionImport(
        task_id=scope.run_id, scope_id=scope.scope_id, subject_id=scope.subject_id,
        source_provider=scope.source_provider, local_textbook_id=scope.local_textbook_id,
        external_textbook_id=scope.external_textbook_id, collector_run_id=scope.collector_run_id,
        snapshot_locked_at=scope.snapshot_locked_at, snapshot_complete=scope.snapshot_complete,
        quality_hash=quality_hash, identity_hash=_identity(scope, {'qualityHash': quality_hash}),
        question_count=scope.question_count, cursor=0, batch_no=0, accepted_count=0,
        quarantined_count=0, stats_json=_empty_stats(), status='queued', stage='queued',
        create_time=now, update_time=now,
    )


async def _queue_verified_scope(db: Any, scope: QbSyncJobScope, now: Any, *, retry_failed: bool):
    """Caller holds source/task/scope locks and commits seal and queue together."""
    row = await db.scalar(select(QbQuestionImport).where(
        QbQuestionImport.scope_id == scope.scope_id,
        QbQuestionImport.collector_run_id == scope.collector_run_id,
    ).with_for_update().execution_options(populate_existing=True))
    if row is None:
        row = _new_import(scope, now)
        db.add(row)
        await db.flush()
    elif row.identity_hash != _identity(scope, {'qualityHash': row.quality_hash}):
        raise ServiceException(message='任务封存身份已变化，不能复用入库断点')
    elif row.status == 'failed' and retry_failed:
        row.status = 'queued'
        row.stage = 'queued'
        row.error_message = None
        row.worker_token = None
        row.lease_until = None
        row.active_source_slot = None
        row.finished_at = None
        row.update_time = now
    return row


def attach_coverage_evidence(row: QbQuestionImport, value: Any) -> None:
    evidence = normalise_run_coverage(value, row.collector_run_id, row.external_textbook_id, row.snapshot_locked_at)
    if row.run_coverage_json is not None and row.run_coverage_json != evidence:
        raise ServiceException(message='封存的来源观察或扫描证据已变化，不能继续原入库断点')
    row.run_coverage_json = evidence


async def request_incremental_import(db: Any, task_id: int) -> dict[str, Any]:
    """Return a durable ID using local binding reads only; never read Collector."""
    _fresh_transaction(db)
    try:
        await _source_lock(db)
        scope_ids = list((await db.scalars(
            select(QbSyncJobScope.scope_id).where(QbSyncJobScope.run_id == task_id)
        )).all())
        if len(scope_ids) != 1:
            raise ServiceException(message='增量入库任务必须只绑定一本教材')
        _, scope = await _binding(db, scope_ids[0])
        from plugins.bank.service.sync_dispatch import book_key
        current_task = await db.scalar(select(QbSyncJob.run_id).where(
            QbSyncJob.dispatch_book_key == book_key(scope.subject_id, scope.source_provider, scope.external_textbook_id),
            QbSyncJob.run_id != task_id,
        ).limit(1))
        if current_task is not None:
            raise ServiceException(message='该教材已有新的待办或未结束任务，请先处理当前任务再重试旧入库')
        now = await _clock(db)
        row = await _queue_verified_scope(db, scope, now, retry_failed=True)
        result = import_status(row)
        await db.commit()
        return result
    except BaseException:
        await db.rollback()
        raise


async def _claim_source_slot(db: Any, row: QbQuestionImport, now: Any) -> bool:
    other = await db.scalar(select(QbQuestionImport.import_id).where(
        QbQuestionImport.import_id != row.import_id,
        QbQuestionImport.source_provider == row.source_provider,
        or_(
            QbQuestionImport.active_source_slot == row.source_provider,
            (QbQuestionImport.status.in_(['preparing', 'running']))
            & (QbQuestionImport.worker_token.is_not(None)) & (QbQuestionImport.lease_until > now),
        ),
    ).limit(1))
    if other is not None:
        return False
    row.active_source_slot = row.source_provider
    return True


async def pending_incremental_import_ids(db: Any, *, limit: int = 10) -> list[int]:
    """Expired owners come first so their source slot can be recovered."""
    now = await _clock(db)
    return list((await db.scalars(select(QbQuestionImport.import_id).where(or_(
        QbQuestionImport.status == 'queued',
        QbQuestionImport.status.in_(['preparing', 'running']) & (QbQuestionImport.lease_until <= now),
    )).order_by(
        case((QbQuestionImport.active_source_slot.is_not(None), 0), else_=1),
        QbQuestionImport.import_id,
    ).limit(limit))).all())


async def claim_pending_incremental_import(db: Any, import_id: int) -> dict[str, Any] | None:
    _fresh_transaction(db)
    try:
        await _source_lock(db)
        row = await db.get(QbQuestionImport, import_id, with_for_update=True, populate_existing=True)
        now = await _clock(db)
        if row is None or row.status not in {'queued', 'preparing', 'running'}:
            await db.rollback()
            return None
        if row.worker_token and row.lease_until and row.lease_until > now:
            await db.rollback()
            return None
        _, scope = await _binding(db, row.scope_id)
        if row.identity_hash != _identity(scope, {'qualityHash': row.quality_hash}):
            raise ServiceException(message='任务封存身份已变化，停止后台入库')
        if not await _claim_source_slot(db, row, now):
            await db.rollback()
            return None
        row.worker_token = secrets.token_hex(32)
        row.lease_until = now + timedelta(seconds=LEASE_SECONDS)
        row.status = 'preparing'
        row.stage = 'staging'
        row.error_message = None
        row.update_time = now
        ticket = _ticket(row)
        await db.commit()
        return ticket
    except BaseException:
        await db.rollback()
        raise


async def reject_pending_incremental_import(db: Any, import_id: int, message: str) -> None:
    """Invalid queued/expired bindings must not starve other books."""
    _fresh_transaction(db)
    try:
        row = await db.get(QbQuestionImport, import_id, with_for_update=True, populate_existing=True)
        now = await _clock(db)
        if row is not None and (
            row.status == 'queued'
            or (row.status in {'preparing', 'running'} and row.lease_until and row.lease_until <= now)
        ):
            row.status = 'failed'
            row.error_message = str(message)[:2000]
            row.worker_token = None
            row.lease_until = None
            row.active_source_slot = None
            row.update_time = now
        await db.commit()
    except BaseException:
        await db.rollback()
        raise


async def advance_incremental_preparation(db: Any, ticket: dict[str, Any], stage: str) -> None:
    if stage not in {'staging', 'checking', 'assets', 'importing'}:
        raise ValueError('invalid import stage')
    _fresh_transaction(db)
    try:
        await _source_lock(db)
        row = await db.get(QbQuestionImport, ticket['importId'], with_for_update=True, populate_existing=True)
        now = await _clock(db)
        _owned(row, ticket, now)
        _, scope = await _binding(db, row.scope_id)
        if row.identity_hash != _identity(scope, {'qualityHash': row.quality_hash}):
            raise ServiceException(message='任务封存身份已变化，停止入库准备')
        row.stage = stage
        row.lease_until = now + timedelta(seconds=LEASE_SECONDS)
        row.update_time = now
        await db.commit()
    except BaseException:
        await db.rollback()
        raise


async def attach_incremental_quality(db: Any, ticket: dict[str, Any], report: dict[str, Any]) -> dict[str, Any]:
    _fresh_transaction(db)
    try:
        await _source_lock(db)
        row = await db.get(QbQuestionImport, ticket['importId'], with_for_update=True, populate_existing=True)
        now = await _clock(db)
        _owned(row, ticket, now)
        _, scope = await _binding(db, row.scope_id)
        if row.identity_hash != _identity(scope, {'qualityHash': row.quality_hash}):
            raise ServiceException(message='任务封存身份已变化，停止入库检查')
        _check_report(scope, report)
        if 'coverageEvidence' in report:
            attach_coverage_evidence(row, report['coverageEvidence'])
        if row.quality_hash is not None and row.quality_hash != report['qualityHash']:
            raise ServiceException(message='重新检查的结论已变化，不能继续原入库断点')
        row.quality_hash = report['qualityHash']
        row.identity_hash = _identity(scope, report)
        row.status = 'running'
        row.stage = 'assets'
        row.lease_until = now + timedelta(seconds=LEASE_SECONDS)
        row.update_time = now
        if row.question_count == 0:
            _finish(row, now)
        result = _ticket(row)
        await db.commit()
        return result
    except BaseException:
        await db.rollback()
        raise


async def claim_incremental_import(db: Any, scope_id: int, report: dict[str, Any]) -> dict[str, Any]:
    """Deduplicate claims and take over only an expired or released lease."""
    _fresh_transaction(db)
    try:
        await _source_lock(db)
        _, scope = await _binding(db, scope_id)
        _check_report(scope, report)
        identity = _identity(scope, report)
        row = await db.scalar(
            select(QbQuestionImport)
            .where(
                QbQuestionImport.scope_id == scope_id,
                QbQuestionImport.collector_run_id == scope.collector_run_id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        now = await _clock(db)
        if row is None:
            row = _new_import(scope, now, quality_hash=report['qualityHash'])
            db.add(row)
            await db.flush()
        elif row.identity_hash != identity:
            raise ServiceException(message='封存检查身份已变化，不能复用原入库断点')
        elif row.status in {'completed', 'partial'}:
            ticket = _ticket(row)
            await db.commit()
            return ticket
        elif row.worker_token and row.lease_until and row.lease_until > now:
            raise ServiceException(message='此入库工作仍由其他执行者处理')
        if not await _claim_source_slot(db, row, now):
            raise ServiceException(message='同来源仍有入库准备或执行工作')
        row.worker_token = secrets.token_hex(32)
        row.lease_until = now + timedelta(seconds=LEASE_SECONDS)
        row.status = 'running'
        row.stage = 'assets'
        row.error_message = None
        row.finished_at = None
        row.update_time = now
        if row.question_count == 0:
            _finish(row, now)
        ticket = _ticket(row)
        await db.commit()
        return ticket
    except BaseException:
        await db.rollback()
        raise


def _owned(row: QbQuestionImport | None, ticket: dict[str, Any], now: Any, *, quality_transition: bool = False) -> None:
    if (
        row is None
        or row.status not in {'preparing', 'running'}
        or not row.worker_token
        or row.worker_token != ticket.get('workerToken')
        or (not quality_transition and row.identity_hash != ticket.get('identityHash'))
        or row.lease_until is None
        or row.lease_until <= now
        or any(
            ticket.get(key) != getattr(row, field)
            for key, field in (
                ('taskId', 'task_id'),
                ('scopeId', 'scope_id'),
                ('collectorRunId', 'collector_run_id'),
                ('textbookId', 'local_textbook_id'),
            )
        )
    ):
        raise ServiceException(message='入库执行权已过期或被接管，停止本次提交')


def _finish(row: QbQuestionImport, now: Any) -> None:
    row.status = 'completed' if row.snapshot_complete and row.quarantined_count == 0 else 'partial'
    row.finished_at = now
    row.worker_token = None
    row.lease_until = None
    row.active_source_slot = None
    row.stage = 'done'


async def renew_incremental_import(db: Any, ticket: dict[str, Any]) -> None:
    _fresh_transaction(db)
    try:
        await _source_lock(db)
        row = await db.get(QbQuestionImport, ticket['importId'], with_for_update=True, populate_existing=True)
        now = await _clock(db)
        _owned(row, ticket, now, quality_transition=True)
        _, scope = await _binding(db, row.scope_id)
        if _identity(scope, {'qualityHash': row.quality_hash}) != row.identity_hash:
            raise ServiceException(message='任务绑定已变化，停止入库续租')
        row.lease_until = now + timedelta(seconds=LEASE_SECONDS)
        row.update_time = now
        await db.commit()
    except BaseException:
        await db.rollback()
        raise


async def fail_incremental_import(db: Any, ticket: dict[str, Any], message: str) -> None:
    """Release only a live owned lease; committed rows/counters remain intact."""
    _fresh_transaction(db)
    try:
        row = await db.get(QbQuestionImport, ticket['importId'], with_for_update=True, populate_existing=True)
        now = await _clock(db)
        _owned(row, ticket, now)
        row.status = 'failed'
        row.error_message = str(message)[:2000]
        row.worker_token = None
        row.lease_until = None
        row.active_source_slot = None
        row.update_time = now
        await db.commit()
    except BaseException:
        await db.rollback()
        raise


async def defer_incremental_import(db: Any, ticket: dict[str, Any], message: str) -> None:
    """Temporary file/writer contention releases its slot for a later retry."""
    _fresh_transaction(db)
    try:
        row = await db.get(QbQuestionImport, ticket['importId'], with_for_update=True, populate_existing=True)
        now = await _clock(db)
        _owned(row, ticket, now)
        row.status = 'queued'
        row.stage = 'queued'
        row.error_message = str(message)[:2000]
        row.worker_token = None
        row.lease_until = None
        row.active_source_slot = None
        row.update_time = now
        await db.commit()
    except BaseException:
        await db.rollback()
        raise


async def ensure_no_active_incremental_import(db: Any, task_id: int) -> None:
    active = await db.scalar(select(QbQuestionImport.import_id).where(
        QbQuestionImport.task_id == task_id,
        QbQuestionImport.status.in_(['queued', 'preparing', 'running']),
    ).limit(1))
    if active is not None:
        raise ServiceException(message='任务仍有未结束的分批入库，请完成入库后再续采或删除')


async def submit_incremental_import_batch(
    db: Any,
    ticket: dict[str, Any],
    verdicts: list[dict[str, Any]],
    *,
    expected_cursor: int,
) -> dict[str, Any]:
    """Formal writes, counters, issue records and checkpoint share one commit."""
    _fresh_transaction(db)
    if (
        type(expected_cursor) is not int
        or expected_cursor < 0
        or not 1 <= len(verdicts) <= MAX_MERGE_QUESTIONS
        or [v.get('ordinal') for v in verdicts] != list(range(expected_cursor, expected_cursor + len(verdicts)))
        or len({v.get('questionId') for v in verdicts}) != len(verdicts)
        or any(type(v.get('ordinal')) is not int or not _safe_external_id(v.get('questionId')) for v in verdicts)
    ):
        raise ServiceException(message='入库批次序号、题数或题目身份无效')
    accepted = []
    issues = []
    for verdict in verdicts:
        if verdict.get('status') == 'accepted' and isinstance(verdict.get('normalized'), dict):
            value = verdict['normalized']
            if (
                value.get('task_id') != ticket['taskId']
                or value.get('collector_run_id') != ticket['collectorRunId']
                or len(value.get('questions', [])) != 1
                or value['questions'][0]['external_id'] != verdict['questionId']
            ):
                raise ServiceException(message='入库批次与质量检查的题目身份不一致')
            accepted.append(value)
        elif verdict.get('status') == 'quarantined' and verdict.get('normalized') is None and verdict.get('reason'):
            issues.append({'questionId': verdict['questionId'], 'reason': str(verdict['reason'])[:2000]})
        else:
            raise ServiceException(message='入库批次包含无效检查结论')
    locked = None

    async def guard(session):
        nonlocal locked
        locked = await session.get(QbQuestionImport, ticket['importId'], with_for_update=True, populate_existing=True)
        _owned(locked, ticket, await _clock(session))
        if locked.status != 'running' or not locked.quality_hash:
            raise ServiceException(message='质量检查尚未完成，不能提交正式入库批次')
        _, scope = await _binding(session, locked.scope_id)
        if _identity(scope, {'qualityHash': locked.quality_hash}) != locked.identity_hash:
            raise ServiceException(message='任务绑定在素材准备期间发生变化，停止本批入库')
        if locked.cursor != expected_cursor or expected_cursor + len(verdicts) > locked.question_count:
            raise ServiceException(message='入库批次断点已变化，请从已提交断点恢复')
        for value in accepted:
            if value['textbook_external_id'] != locked.external_textbook_id or bool(value['snapshot_complete']) != bool(
                locked.snapshot_complete
            ):
                raise ServiceException(message='入库题目范围或封存标记不一致')

    async def checkpoint(session, result):
        now = await _clock(session)
        _owned(locked, ticket, now)
        write_issues = result.get("writeIssues", [])
        accepted_count = len(accepted) - len(write_issues)
        all_issues = issues + write_issues
        from plugins.bank.service.sync_issues import record_import_batch
        blocked_keys = {issue['questionId'] for issue in all_issues}
        await record_import_batch(session, locked, all_issues,
            [value['questions'][0]['external_id'] for value in accepted
             if value['questions'][0]['external_id'] not in blocked_keys], now)
        total = copy.deepcopy(locked.stats_json)
        _merge_stats(total, result['stats'])
        session.add(
            QbQuestionImportBatch(
                import_id=locked.import_id,
                batch_no=locked.batch_no + 1,
                start_cursor=expected_cursor,
                next_cursor=expected_cursor + len(verdicts),
                batch_hash=_digest(verdicts),
                accepted_count=accepted_count,
                quarantined_count=len(all_issues),
                stats_json=result['stats'],
                issues_json=all_issues,
                create_time=now,
            )
        )
        locked.cursor += len(verdicts)
        locked.batch_no += 1
        locked.accepted_count += accepted_count
        locked.quarantined_count += len(all_issues)
        locked.stats_json = total
        locked.update_time = now
        locked.stage = 'importing'
        locked.lease_until = now + timedelta(seconds=LEASE_SECONDS)
        if locked.cursor == locked.question_count:
            _finish(locked, now)
        result['incrementalImport'] = import_status(locked)

    if accepted:
        return await merge_prepared_incremental_batch(
            db,
            accepted,
            local_textbook_id=ticket['textbookId'],
            task_id=ticket['taskId'],
            before_merge=guard,
            persist_checkpoint=checkpoint,
        )
    try:
        await _source_lock(db)
        await guard(db)
        result = {'stats': _empty_stats(), 'isCurrent': False}
        await checkpoint(db, result)
        await db.commit()
        return result
    except BaseException:
        await db.rollback()
        raise
