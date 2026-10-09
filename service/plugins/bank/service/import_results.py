"""Bounded, immutable pages of committed import journals; no Collector reads."""

from __future__ import annotations

import base64
import binascii
import copy
import json
from typing import Any

from sqlalchemy import func, select

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbQuestionImport, QbQuestionImportBatch, QbSyncJob, QbSyncJobScope
from plugins.bank.service.import_dates import utc_datetime
from plugins.bank.service.incremental_import import _clock, import_binding_matches_scope, import_status
from plugins.bank.service.incremental_merge import MAX_MERGE_QUESTIONS
from plugins.bank.service.question_apply_service import _safe_external_id

ISSUE_BATCH_READ_LIMIT = 8
MAX_PAGE_SIZE = 50


def _page_size(value: int):
    if type(value) is not int or not 1 <= value <= MAX_PAGE_SIZE:
        raise ServiceException(message='入库结果每页数量必须为 1～50')


def _encode(value: dict[str, Any]):
    return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).decode().rstrip('=')


def _decode(value: str | None, row: Any, kind: str) -> dict[str, Any]:
    initial = {'v': 1, 'importId': row.import_id, 'kind': kind, 'watermark': row.batch_no}
    if not value:
        return {**initial, **({'after': 0} if kind == 'batch' else {'batch': 1, 'offset': 0})}
    try:
        if not isinstance(value, str) or len(value) > 512:
            raise ValueError
        parsed = json.loads(base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True))
        keys = set(initial) | ({'after'} if kind == 'batch' else {'batch', 'offset'})
        if (
            not isinstance(parsed, dict) or set(parsed) != keys
            or parsed['kind'] != kind or type(parsed['v']) is not int or parsed['v'] != 1
            or type(parsed['importId']) is not int or parsed['importId'] != row.import_id
            or type(parsed['watermark']) is not int or not 0 <= parsed['watermark'] <= row.batch_no
        ):
            raise ValueError
        if kind == 'batch':
            if type(parsed['after']) is not int or not 0 <= parsed['after'] <= parsed['watermark']:
                raise ValueError
        elif (
            type(parsed['batch']) is not int or not 1 <= parsed['batch'] <= parsed['watermark'] + 1
            or type(parsed['offset']) is not int or not 0 <= parsed['offset'] < MAX_MERGE_QUESTIONS
        ):
            raise ValueError
        return parsed
    except (ValueError, TypeError, UnicodeError, binascii.Error) as exc:
        raise ServiceException(message='入库结果分页位置无效，请刷新结果') from exc


async def _task(db: Any, task_id: int):
    task = await db.scalar(select(QbSyncJob).where(
        QbSyncJob.run_id == task_id, QbSyncJob.task_module == 'question', QbSyncJob.run_type == 'content',
    ))
    if task is None:
        raise ServiceException(message='同步题库任务不存在')
    return task


async def _import(db: Any, task_id: int, import_id: int):
    await _task(db, task_id)
    row = await db.scalar(select(QbQuestionImport).where(
        QbQuestionImport.import_id == import_id, QbQuestionImport.task_id == task_id,
    ))
    if row is None:
        raise ServiceException(message='当前任务没有此入库记录')
    return row


async def _projection(db: Any, row: Any, scopes: list[Any] | None = None):
    if scopes is None:
        scopes = list((await db.scalars(select(QbSyncJobScope).where(QbSyncJobScope.run_id == row.task_id))).all())
    current = len(scopes) == 1 and import_binding_matches_scope(row, scopes[0])
    return {
        **import_status(row), 'currentBinding': current, 'subjectId': row.subject_id,
        'sourceProvider': row.source_provider, 'externalTextbookId': row.external_textbook_id,
        'snapshotLockedAt': utc_datetime(row.snapshot_locked_at), 'createdAt': utc_datetime(row.create_time),
    }


async def list_import_history(db: Any, task_id: int, *, before_id: int | None = None, page_size: int = 20):
    _page_size(page_size)
    await _task(db, task_id)
    query = select(QbQuestionImport).where(QbQuestionImport.task_id == task_id)
    if before_id is not None:
        if type(before_id) is not int or before_id <= 0:
            raise ServiceException(message='入库历史分页位置无效')
        query = query.where(QbQuestionImport.import_id < before_id)
    rows = list((await db.scalars(query.order_by(QbQuestionImport.import_id.desc()).limit(page_size + 1))).all())
    scopes = list((await db.scalars(select(QbSyncJobScope).where(QbSyncJobScope.run_id == task_id))).all())
    items = [await _projection(db, row, scopes) for row in rows[:page_size]]
    has_next = len(rows) > page_size
    return {'items': items, 'hasNext': has_next, 'nextBeforeId': items[-1]['importId'] if has_next else None}


def _batch(row: Any):
    # No hashes, lease tokens, QC payloads or asset filesystem paths.
    return {
        'batchNo': row.batch_no, 'startCursor': row.start_cursor, 'nextCursor': row.next_cursor,
        'processedCount': row.next_cursor - row.start_cursor, 'acceptedCount': row.accepted_count,
        'quarantinedCount': row.quarantined_count, 'stats': copy.deepcopy(row.stats_json),
        'committedAt': utc_datetime(row.create_time),
    }


async def batch_results(db: Any, task_id: int, import_id: int, *, cursor: str | None = None, page_size: int = 20):
    _page_size(page_size)
    row = await _import(db, task_id, import_id)
    position = _decode(cursor, row, 'batch')
    # Select only the journal summary columns, never load issues_json here.
    rows = list((await db.execute(select(
        QbQuestionImportBatch.batch_no, QbQuestionImportBatch.start_cursor, QbQuestionImportBatch.next_cursor,
        QbQuestionImportBatch.accepted_count, QbQuestionImportBatch.quarantined_count,
        QbQuestionImportBatch.stats_json, QbQuestionImportBatch.create_time,
    ).where(
        QbQuestionImportBatch.import_id == import_id,
        QbQuestionImportBatch.batch_no > position['after'],
        QbQuestionImportBatch.batch_no <= position['watermark'],
    ).order_by(QbQuestionImportBatch.batch_no).limit(page_size + 1))).all())
    has_next = len(rows) > page_size
    items = [_batch(batch) for batch in rows[:page_size]]
    return {
        'import': await _projection(db, row), 'items': items,
        'page': {'total': position['watermark'], 'pageSize': page_size, 'hasNext': has_next,
                 'upToBatchNo': position['watermark'], 'asOf': utc_datetime(await _clock(db)),
                 'cursor': _encode(position),
                 'nextCursor': _encode({**position, 'after': items[-1]['batchNo']}) if has_next else None},
    }


def _issues(row: Any):
    issues = row.issues_json
    if (
        not isinstance(issues, list) or len(issues) != row.quarantined_count
        or not 1 <= len(issues) <= MAX_MERGE_QUESTIONS
        or any(not isinstance(issue, dict) or not _safe_external_id(issue.get('questionId'))
               or not isinstance(issue.get('reason'), str) or not issue['reason'] for issue in issues)
    ):
        raise ServiceException(message='已提交批次的问题记录不一致，请核对入库记录')
    return issues


async def issue_results(db: Any, task_id: int, import_id: int, *, cursor: str | None = None, page_size: int = 20):
    _page_size(page_size)
    row = await _import(db, task_id, import_id)
    position = _decode(cursor, row, 'issue')
    clauses = (QbQuestionImportBatch.import_id == import_id,
               QbQuestionImportBatch.batch_no <= position['watermark'],
               QbQuestionImportBatch.quarantined_count > 0)
    total = await db.scalar(select(func.coalesce(func.sum(QbQuestionImportBatch.quarantined_count), 0)).where(*clauses))
    # At most eight committed batches (each <=100 issues) per request.
    # Empty clean batches are skipped in SQL; no full journal flattening.
    batches = list((await db.execute(select(
        QbQuestionImportBatch.batch_no, QbQuestionImportBatch.quarantined_count,
        QbQuestionImportBatch.issues_json, QbQuestionImportBatch.create_time,
    ).where(*clauses, QbQuestionImportBatch.batch_no >= position['batch'])
        .order_by(QbQuestionImportBatch.batch_no).limit(ISSUE_BATCH_READ_LIMIT))).all())
    if position['offset'] and (not batches or batches[0].batch_no != position['batch']):
        raise ServiceException(message='入库问题分页位置无效，请刷新结果')
    items = []
    next_batch, next_offset = position['batch'], position['offset']
    for batch in batches:
        issues = _issues(batch)
        offset = position['offset'] if batch.batch_no == position['batch'] else 0
        if offset >= len(issues):
            raise ServiceException(message='入库问题分页位置无效，请刷新结果')
        for index in range(offset, len(issues)):
            issue = issues[index]
            items.append({'resultKey': f'{import_id}:{batch.batch_no}:{index}', 'batchNo': batch.batch_no,
                          'questionId': issue['questionId'], 'reason': issue['reason'][:2000],
                          'recordedAt': utc_datetime(batch.create_time)})
            next_batch, next_offset = batch.batch_no, index + 1
            if next_offset == len(issues):
                next_batch, next_offset = batch.batch_no + 1, 0
            if len(items) == page_size:
                break
        if len(items) == page_size:
            break
    has_next = bool(next_offset) or await db.scalar(select(QbQuestionImportBatch.batch_no).where(
        *clauses, QbQuestionImportBatch.batch_no >= next_batch,
    ).limit(1)) is not None
    return {
        'import': await _projection(db, row), 'items': items,
        'page': {'total': int(total), 'pageSize': page_size, 'hasNext': has_next,
                 'upToBatchNo': position['watermark'], 'asOf': utc_datetime(await _clock(db)),
                 'cursor': _encode(position),
                 'nextCursor': _encode({**position, 'batch': next_batch, 'offset': next_offset}) if has_next else None},
    }
