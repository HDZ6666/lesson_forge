"""Initial, transactional projection of a validated large question snapshot.

The CLI is deliberately limited to a previously empty provider bank. Existing
formal data must continue through the normal scope-aware reconcile algorithm.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import secrets
import sqlite3
from contextlib import AsyncExitStack
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, insert, select, update

from config.database import DataSourceRegistry
from exceptions.exception import ServiceException
from plugins.bank.dao.question_apply_dao import QuestionApplyDao
from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbQuestionApplyHistory,
    QbQuestionAsset,
    QbQuestionCatalog,
    QbQuestionTag,
    QbQuestionTaskReview,
    QbTextbook,
)
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.large_snapshot_reader import LargeSnapshotReader
from plugins.bank.service.question_apply_service import (
    PROVIDER,
    _asset_root,
    _canonical_hash,
    _empty_stats,
    _load_task_and_scopes,
    _rollback_read_transaction,
    _task_scope_signature,
    _uses_incremental_workflow,
)
from plugins.bank.service.source_write_lock import source_write_lock

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

QUESTION_FIELDS = (
    'source_url', 'source_question_no', 'source_text', 'paper_name', 'academic_year',
    'year', 'grade', 'term', 'province', 'city', 'district', 'school_name',
    'exam_type', 'question_type', 'difficulty', 'difficulty_coefficient', 'score',
    'content_html', 'plain_text', 'answer_html', 'analysis_html', 'answer_status',
    'subquestion_count', 'website_time_text', 'external_updated_at',
    'assemble_count', 'reference_count', 'reference_papers_json', 'is_fresh',
    'content_hash', 'raw_data_json', 'last_seen_at',
)


def _prepared_assets(path: Path, expected_hash: str, expected_count: int) -> dict[str, str]:
    """Read the completed asset manifest before starting a MySQL transaction."""
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
        values = dict(db.execute(
            "SELECT key, value FROM metadata WHERE key IN ('asset_preparation_hash','asset_reference_count')"
        ))
        if (
            values.get('asset_preparation_hash') != expected_hash.encode('ascii')
            or values.get('asset_reference_count') != str(expected_count).encode('ascii')
        ):
            raise ServiceException(message='大快照素材尚未完整准备，禁止写入正式题库')
        paths = dict(db.execute('SELECT file_hash,storage_path FROM asset_paths'))
    if expected_count and not paths:
        raise ServiceException(message='素材清单为空，禁止写入正式题库')
    return paths


async def _capture_task(db: AsyncSession, task_id: int, run_id: int, textbook_id: str) -> tuple[Any, int, set[str]]:
    task, scopes = await _load_task_and_scopes(db, task_id)
    if _uses_incremental_workflow(task):
        raise ServiceException(message='新版任务不能使用旧版首次整批入库，请使用分批增量流程')
    if str(task.status) != 'completed' or len(scopes) != 1:
        raise ServiceException(message='大快照首批入库只支持一个已完成的教材任务')
    scope = scopes[0]
    if (
        str(scope.source_provider) != PROVIDER
        or str(scope.external_textbook_id) != textbook_id
        or int(scope.collector_run_id or 0) != run_id
        or str(scope.status) != 'completed'
        or not scope.snapshot_complete
        or not scope.snapshot_locked_at
    ):
        raise ServiceException(message='任务教材范围与已锁定的 Collector 快照不一致')
    review = await db.get(QbQuestionTaskReview, task_id)
    excluded = set(review.excluded_json or []) if review else set()
    if not all(isinstance(value, str) for value in excluded):
        raise ServiceException(message='审核排除题目 ID 无效')
    signature = _task_scope_signature(task, scopes)
    revision = int(review.revision) if review else 0
    await _rollback_read_transaction(db)
    return signature, revision, excluded


async def _empty_provider(db: AsyncSession) -> None:
    for model in (QbQuestion, QbCatalogNode):
        existing = await db.scalar(select(func.count()).select_from(model).where(model.source_provider == PROVIDER))
        if int(existing or 0):
            raise ServiceException(message='正式题库已有来源数据；首批入库程序拒绝覆盖或混合写入')


async def apply_initial_large(  # noqa: PLR0912, PLR0915
    db: AsyncSession,
    reader: LargeSnapshotReader,
    path: Path,
    *,
    operator: str | None = None,
    on_progress: Any = None,
) -> dict[str, Any]:
    """Validate outside the DB transaction; stream every formal row in one commit."""
    task_id = reader.task_id
    run_id = int(reader.summary['collector_run_id'])
    textbook_id = reader.textbook_id
    signature, revision, excluded = await _capture_task(db, task_id, run_id, textbook_id)
    validation = reader.validate_all()
    paths = _prepared_assets(path, validation['normalizedHash'], reader.counts['assets'])
    snapshot_hash = _canonical_hash({
        'format': 'large-paged-v1', 'normalizedHash': validation['normalizedHash'],
        'excludedQuestionIds': sorted(excluded),
    })
    stats = _empty_stats()
    now = datetime.now()
    write_stack = AsyncExitStack()
    try:
        await write_stack.enter_async_context(source_write_lock(db))
        task, scopes = await _load_task_and_scopes(db, task_id, for_update=True)
        if _task_scope_signature(task, scopes) != signature:
            raise ServiceException(message='任务或教材范围已变化，请重新校验快照')
        review = await db.get(QbQuestionTaskReview, task_id, with_for_update=True, populate_existing=True)
        if (int(review.revision) if review else 0) != revision:
            raise ServiceException(message='审核选择已变化，请重新准备入库')
        state = await QuestionApplyDao.get_state(db, PROVIDER, textbook_id, for_update=True)
        if state is not None and state.current_task_id is not None:
            if (int(state.current_task_id) == task_id
                    and int(state.current_collector_run_id or 0) == run_id
                    and state.snapshot_hash == snapshot_hash):
                result = {'taskId': task_id, 'collectorRunId': run_id,
                          'textbookExternalId': textbook_id, 'snapshotHash': snapshot_hash,
                          'stateToken': state.state_token, 'alreadyApplied': True}
                await db.rollback()
                return result
            raise ServiceException(message='此教材已有正式题库应用记录，首批入库程序拒绝覆盖')
        await _empty_provider(db)
        scope = scopes[0]
        textbook = await db.scalar(select(QbTextbook).where(
            QbTextbook.subject_id == 1, QbTextbook.source_provider == PROVIDER,
            QbTextbook.external_textbook_id == textbook_id,
        ))
        if textbook is None or int(textbook.textbook_id) != int(scope.local_textbook_id or 0):
            raise ServiceException(message='正式教材与任务教材范围不匹配')
        catalogs = next(reader.chunks())['catalogs']
        await db.execute(insert(QbCatalogNode.__table__), [
            {
                'textbook_id': int(textbook.textbook_id),
                'parent_id': None,
                'source_provider': PROVIDER,
                'external_node_id': item['external_id'],
                'node_name': item['node_name'],
                'node_type': item['node_type'],
                'source_url': item['source_url'],
                'sort_order': item['sort_order'],
                'status': '0',
                'last_sync_batch_id': task_id,
                'last_seen_at': item['last_seen_at'],
                'create_time': now, 'update_time': now,
            }
            for item in catalogs
        ])
        catalog_map = dict((await db.execute(select(
            QbCatalogNode.external_node_id, QbCatalogNode.catalog_id,
        ).where(
            QbCatalogNode.subject_id == 1, QbCatalogNode.source_provider == PROVIDER,
            QbCatalogNode.textbook_id == textbook.textbook_id,
        ))).all())
        if len(catalog_map) != reader.counts['catalogs']:
            raise ServiceException(message='正式目录写入数量不一致')
        for item in catalogs:
            parent = item['parent_external_id']
            if parent:
                await db.execute(update(QbCatalogNode.__table__).where(
                    QbCatalogNode.catalog_id == catalog_map[item['external_id']],
                ).values(parent_id=catalog_map[parent]))
        stats['catalogs']['inserted'] = len(catalogs)

        digest = hashlib.sha256()
        source_counts = {'questions': 0, 'questionCatalogs': 0, 'tags': 0, 'assets': 0}
        for index, snapshot in enumerate(reader.chunks(), start=1):
            digest.update(_canonical_hash(snapshot['business']).encode('ascii'))
            for key in source_counts:
                source_counts[key] += snapshot['counts'][key]
            questions = [item for item in snapshot['questions'] if item['external_id'] not in excluded]
            if questions:
                await db.execute(insert(QbQuestion.__table__), [
                    {
                        'source_provider': PROVIDER,
                        'external_question_id': item['external_id'],
                        **{field: item[field] for field in QUESTION_FIELDS},
                        'status': '0', 'last_sync_batch_id': task_id,
                        'create_time': now, 'update_time': now,
                    }
                    for item in questions
                ])
                external_ids = [item['external_id'] for item in questions]
                question_map = dict((await db.execute(select(
                    QbQuestion.external_question_id, QbQuestion.question_id,
                ).where(
                    QbQuestion.subject_id == 1, QbQuestion.source_provider == PROVIDER,
                    QbQuestion.external_question_id.in_(external_ids),
                ))).all())
                if len(question_map) != len(questions):
                    raise ServiceException(message='正式题目写入数量不一致')
            else:
                question_map = {}
            stats['questions']['inserted'] += len(questions)

            relations = [
                {
                    'question_id': question_map[item['question_external_id']],
                    'catalog_id': catalog_map[item['catalog_external_id']],
                    'relation_type': 'query_catalog',
                    'evidence_type': item['evidence_type'],
                    'sort_order': item['sort_order'],
                    'last_seen_at': item['last_seen_at'],
                    'last_sync_batch_id': task_id,
                    'create_time': now, 'update_time': now,
                }
                for item in snapshot['question_catalogs']
                if item['question_external_id'] in question_map
            ]
            tags = [
                {
                    'question_id': question_map[item['question_external_id']],
                    'tag_type': item['tag_type'], 'tag_name': item['tag_name'],
                    'relation_type': item['relation_type'], 'evidence_type': item['evidence_type'],
                    'sort_order': item['sort_order'], 'last_seen_at': item['last_seen_at'],
                    'last_sync_batch_id': task_id,
                    'create_time': now, 'update_time': now,
                }
                for item in snapshot['tags']
                if item['question_external_id'] in question_map
            ]
            assets = []
            for item in snapshot['assets']:
                if item['question_external_id'] not in question_map:
                    continue
                storage_path = paths.get(item['file_hash'])
                if not storage_path:
                    raise ServiceException(message=f"素材 {item['file_hash']} 缺少已校验的本地路径")
                assets.append({
                    'question_id': question_map[item['question_external_id']],
                    'source_provider': PROVIDER,
                    'asset_key': item['asset_key'], 'asset_type': item['asset_type'],
                    'source_url': item['source_url'], 'storage_path': storage_path,
                    'mime_type': item['mime_type'], 'file_name': item['file_name'],
                    'file_hash': item['file_hash'], 'width': item['width'],
                    'height': item['height'], 'sort_order': item['sort_order'],
                    'download_status': 'downloaded', 'error_message': None,
                    'last_seen_at': item['last_seen_at'], 'last_sync_batch_id': task_id,
                    'create_time': now, 'update_time': now,
                })
            for model, values, name in (
                (QbQuestionCatalog, relations, 'questionCatalogs'),
                (QbQuestionTag, tags, 'tags'),
                (QbQuestionAsset, assets, 'assets'),
            ):
                if values:
                    await db.execute(insert(model.__table__), values)
                stats[name]['inserted'] += len(values)
            if on_progress is not None and (index % 10 == 0 or source_counts['questions'] == reader.counts['questions']):
                on_progress(source_counts['questions'], reader.counts['questions'], stats)
        if digest.hexdigest() != validation['normalizedHash']:
            raise ServiceException(message='正式入库期间暂存快照发生变化')
        if any(source_counts[name] != reader.counts[name] for name in source_counts):
            raise ServiceException(message='正式入库期间暂存快照计数发生变化')
        if state is None:
            state = await QuestionApplyDao.add_state(db, PROVIDER, textbook_id)
        token = secrets.token_hex(32)
        state.current_task_id = task_id
        state.current_collector_run_id = run_id
        state.snapshot_hash = snapshot_hash
        state.state_token = token
        state.applied_by = operator
        state.applied_at = now
        state.update_time = now
        await QuestionApplyDao.add_history(db, QbQuestionApplyHistory(
            source_provider=PROVIDER, external_textbook_id=textbook_id,
            task_id=task_id, collector_run_id=run_id, snapshot_hash=snapshot_hash,
            state_token=token, action='apply', previous_task_id=None,
            previous_collector_run_id=None, previous_snapshot_hash=None,
            change_stats_json=stats, applied_by=operator, applied_at=now,
            create_time=now, update_time=now,
        ))
        await db.commit()
    except BaseException:
        await db.rollback()
        raise
    finally:
        await write_stack.aclose()
    return {'taskId': task_id, 'collectorRunId': run_id, 'textbookExternalId': textbook_id,
            'snapshotHash': snapshot_hash, 'stateToken': token, 'stats': stats, 'alreadyApplied': False}


async def _main(args: argparse.Namespace) -> None:
    path = args.path or _asset_root() / 'imports' / f'run-{args.run_id}-{args.textbook_id}.sqlite3'
    summary = await asyncio.to_thread(
        CollectorClient().run_snapshot_summary, args.run_id, textbook_external_id=args.textbook_id,
    )
    with LargeSnapshotReader(path, summary, args.task_id, args.textbook_id) as reader:
        async with DataSourceRegistry.session() as db:
            def progress(done: int, total: int, stats: dict[str, Any]) -> None:
                print(f"formal_apply: questions={done}/{total} assets={stats['assets']['inserted']}", flush=True)

            result = await apply_initial_large(db, reader, path, operator=args.operator, on_progress=progress)
    print(f'formal apply complete: {result}', flush=True)
    await DataSourceRegistry.dispose_all()


def main() -> None:
    parser = argparse.ArgumentParser(description='First import of a completed large question snapshot')
    parser.add_argument('task_id', type=int)
    parser.add_argument('run_id', type=int)
    parser.add_argument('textbook_id')
    parser.add_argument('--operator', default='system')
    parser.add_argument('--path', type=Path)
    args = parser.parse_args()
    asyncio.run(_main(args))


if __name__ == '__main__':
    main()
