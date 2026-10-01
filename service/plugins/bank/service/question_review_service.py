"""Task-local directory baseline and reversible question selection."""
from __future__ import annotations

import asyncio
from datetime import datetime

from sqlalchemy import func, select

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbCatalogNode, QbQuestion, QbQuestionCatalog, QbQuestionTaskReview, QbSyncJob
from plugins.bank.service.collector_client import CollectorClient

PREVIEW_HTML_LIMIT = 4000


def _question_diff_fields(fetched: dict, current: dict) -> list[str]:
    # The list preview truncates HTML and plain text. The complete content
    # digest is authoritative when both sides have one; comparing truncated
    # text with the full formal row would mark a long unchanged question as
    # modified forever.
    if fetched.get('contentHash') and current.get('contentHash'):
        changed = ['contentHash'] if fetched['contentHash'] != current['contentHash'] else []
    else:
        changed = [name for name in ('contentHtml', 'plainText')
                   if (fetched.get(name) or '') != (current.get(name) or '')]
    changed.extend(name for name in ('questionType', 'difficulty', 'sourceUrl')
                   if (fetched.get(name) or '') != (current.get(name) or ''))
    # An uncollected answer is not evidence that a known formal answer should
    # be erased. The apply path preserves that answer too.
    if fetched.get('answerStatus') not in ('unknown', 'not_collected'):
        changed.extend(name for name in ('answerStatus', 'answerHtml', 'analysisHtml')
                       if name in fetched and fetched.get(name) != current.get(name)
                       and (name == 'answerStatus' or len(str(fetched.get(name) or '')) < PREVIEW_HTML_LIMIT))
    if current.get('status') != '0':
        changed.append('status')
    return changed


async def capture_review(db, task_id, scopes, *, origin='task_start'):
    local_ids = [int(scope.local_textbook_id) for scope in scopes if scope.local_textbook_id]
    books = {int(scope.local_textbook_id): str(scope.external_textbook_id) for scope in scopes if scope.local_textbook_id}
    catalogs = list((await db.execute(select(QbCatalogNode).where(QbCatalogNode.textbook_id.in_(local_ids)))).scalars().all()) if local_ids else []
    ids = [node.catalog_id for node in catalogs]
    counts = dict((await db.execute(select(QbQuestionCatalog.catalog_id, func.count(func.distinct(QbQuestionCatalog.question_id)))
        .join(QbQuestion, QbQuestion.question_id == QbQuestionCatalog.question_id)
        .where(QbQuestionCatalog.catalog_id.in_(ids), QbQuestionCatalog.relation_type == 'query_catalog',
               QbQuestion.source_provider == 'zujuan', QbQuestion.status == '0')
        .group_by(QbQuestionCatalog.catalog_id))).all()) if ids else {}
    parents = {node.catalog_id: node.external_node_id for node in catalogs}
    baseline = [{
        'sourceProvider': node.source_provider, 'externalTextbookId': books[node.textbook_id],
        'externalCatalogId': node.external_node_id, 'nodeName': node.node_name,
        'parentExternalId': parents.get(node.parent_id), 'nodeType': node.node_type,
        'sortOrder': node.sort_order, 'questionCount': counts.get(node.catalog_id, 0),
    } for node in catalogs if node.external_node_id]
    review = QbQuestionTaskReview(task_id=task_id, baseline_json={'origin': origin, 'rows': baseline},
                                  excluded_json=[], revision=0, captured_at=datetime.now())
    db.add(review)
    await db.flush()
    return review


async def get_review(db, task_id, scopes):
    review = await db.get(QbQuestionTaskReview, task_id)
    if review is None:
        # Serialize first access for historical tasks without a start baseline.
        await db.execute(select(QbSyncJob).where(QbSyncJob.run_id == task_id).with_for_update())
        review = (await db.execute(select(QbQuestionTaskReview).where(QbQuestionTaskReview.task_id == task_id).with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
        if review is None:
            review = await capture_review(db, task_id, scopes, origin='first_review')
        await db.commit()
        await db.refresh(review)
    return review


def validate_preview(payload, run_id, textbook_id):
    from plugins.bank.service.task_service import _collector_scope_ids
    run = payload.get('run') or {}
    if payload.get('available') is not True or str(run.get('id')) != str(run_id) or run.get('provider') != 'zujuan':
        raise ServiceException(message='采集预览运行信息不一致')
    if str(textbook_id) not in _collector_scope_ids(run):
        raise ServiceException(message='采集预览教材范围不一致')


async def _current_catalogs(db, scope):
    """Read the formal catalog at comparison time, not the task-start baseline."""
    if scope.local_textbook_id is None:
        return []
    nodes = list((await db.execute(select(QbCatalogNode).where(
        QbCatalogNode.textbook_id == int(scope.local_textbook_id),
        QbCatalogNode.source_provider == 'zujuan',
    ))).scalars().all())
    if not nodes:
        return []
    ids = [node.catalog_id for node in nodes]
    counts = dict((await db.execute(
        select(QbQuestionCatalog.catalog_id, func.count(func.distinct(QbQuestionCatalog.question_id)))
        .join(QbQuestion, QbQuestion.question_id == QbQuestionCatalog.question_id)
        .where(QbQuestionCatalog.catalog_id.in_(ids),
               QbQuestionCatalog.relation_type == 'query_catalog',
               QbQuestion.source_provider == 'zujuan', QbQuestion.status == '0')
        .group_by(QbQuestionCatalog.catalog_id)
    )).all())
    external_by_id = {node.catalog_id: node.external_node_id for node in nodes}
    return [{
        'sourceProvider': node.source_provider,
        'externalTextbookId': str(scope.external_textbook_id),
        'externalCatalogId': str(node.external_node_id),
        'nodeName': node.node_name,
        'parentExternalId': external_by_id.get(node.parent_id),
        'nodeType': node.node_type,
        'sourceUrl': node.source_url,
        'sortOrder': node.sort_order,
        'status': node.status,
        'questionCount': counts.get(node.catalog_id, 0),
    } for node in nodes if node.external_node_id]


class QuestionReviewService:
    @staticmethod
    async def context(db, task_id, query):
        from plugins.bank.service.task_service import SyncTaskService
        job, scopes = await SyncTaskService._scope_selection(db, task_id, query, allow_running=True)
        if len(scopes) != 1:
            raise ServiceException(message='请选择一本任务教材')
        from plugins.bank.dao.sync_task_dao import SyncTaskDao
        review = await get_review(db, task_id, await SyncTaskDao.scopes(db, task_id))
        return job, scopes[0], review

    @classmethod
    async def catalogs(cls, db, task_id, query):
        from plugins.bank.service.task_service import _catalog_tree, _normalise_catalog
        job, scope, review = await cls.context(db, task_id, query)
        textbook = str(scope.external_textbook_id)
        current_rows = await _current_catalogs(db, scope)
        current = {row['externalCatalogId']: row for row in current_rows}
        fetched = []
        client = CollectorClient()
        if scope.collector_run_id:
            page = 1
            while True:
                payload = await asyncio.to_thread(client.run_catalogs_preview, scope.collector_run_id, textbookExternalId=textbook, page=page, pageSize=500, excludedIds=review.excluded_json)
                validate_preview(payload, scope.collector_run_id, textbook)
                fetched.extend(filter(None, (_normalise_catalog(row) for row in payload['rows'])))
                if not payload['rows'] or page * 500 >= payload['total']:
                    break
                page += 1
        # Unique relation counts are supplied by the live projection, including completed runs.
        progress = {}
        def visit(nodes):
            for node in nodes:
                progress[str(node.get('externalId') or node.get('externalCatalogId'))] = node
                visit(node.get('children') or [])
        options = job.options_json or {}
        live = options.get('liveProgress') or {}
        visit(live.get('tree') or []) if str(live.get('textbookExternalId') or '') == textbook else None
        for item in (options.get('scopeItems') or []):
            if str(item.get('externalTextbookId')) == textbook:
                visit((item.get('liveProgress') or {}).get('tree') or [])
        rows, seen = [], set()
        for node in fetched:
            key = node['externalCatalogId']
            seen.add(key)
            previous = current.get(key)
            live_node = progress.get(key, {})
            complete = bool(node.get('scanComplete') or live_node.get('scanComplete')) or scope.status == 'completed'
            count = node.get('uniqueQuestionCount', live_node.get('uniqueQuestionCount', node['questionCount']))
            tags = []
            if previous is None:
                tags.append('new')
            elif str(previous.get('status') or '0') != '0' or any(
                str(node.get(field) or '') != str(previous.get(field) or '')
                for field in ('nodeName', 'parentExternalId', 'nodeType', 'sortOrder')
            ):
                tags.append('structure')
            if not complete:
                tags.append('running' if scope.status in ('running', 'starting', 'queued') else 'incomplete')
            elif previous is not None:
                tags.append('increased' if count > previous['questionCount'] else 'decreased' if count < previous['questionCount'] else 'existing')
            rows.append({**node, 'questionCount': count, 'oldQuestionCount': previous['questionCount'] if previous else None,
                         'reviewTags': tags, 'comparisonStatus': tags[0], 'scanComplete': complete})
        rows.extend({**node, 'oldQuestionCount': node['questionCount'], 'questionCount': None,
                     'reviewTags': ['missing' if scope.status == 'completed' else 'pending'], 'comparisonStatus': 'missing'}
                    for node in current_rows if node['externalCatalogId'] not in seen)
        return {'fetchedTree': _catalog_tree(rows, 'fetched'), 'currentTree': _catalog_tree(current_rows, 'current'), 'rows': rows,
                'baselineOrigin': review.baseline_json['origin'], 'baselineCapturedAt': review.captured_at.isoformat(),
                'currentComparedAt': datetime.now().isoformat(), 'sourceAvailable': True}

    @classmethod
    async def questions(cls, db, task_id, query):
        from plugins.bank.service.task_service import _formal_question_value, _normalise_question
        _, scope, review = await cls.context(db, task_id, query)
        if not scope.collector_run_id:
            return {'rows': [], 'total': 0, 'summary': {'captured': 0, 'excluded': 0, 'included': 0}}
        payload = await asyncio.to_thread(CollectorClient().run_questions_preview, scope.collector_run_id,
            textbookExternalId=str(scope.external_textbook_id), catalogExternalId=query.catalog_id,
            questionType=query.question_type, keyword=query.keyword, page=query.page_num, pageSize=query.page_size,
            excludedIds=review.excluded_json, selection=query.selection)
        validate_preview(payload, scope.collector_run_id, scope.external_textbook_id)
        excluded = set(review.excluded_json)
        fetched = [(value, row) for row in payload['rows'] if (value := _normalise_question(row))]
        ids = [value['externalQuestionId'] for value, _row in fetched]
        formal_rows = (
            (await db.execute(select(QbQuestion).where(
                QbQuestion.source_provider == 'zujuan', QbQuestion.external_question_id.in_(ids)
            ))).scalars().all() if ids else []
        )
        formal = {str(row.external_question_id): row for row in formal_rows}
        rows = []
        for value, row in fetched:
            current_row = formal.get(value['externalQuestionId'])
            current = _formal_question_value(current_row) if current_row else None
            if current is not None:
                current['status'] = str(current_row.status or '0')
            changed = _question_diff_fields(value, current) if current is not None else []
            rows.append({
                **value, 'catalogName': row.get('catalogName'),
                'excluded': value['externalQuestionId'] in excluded,
                'current': current,
                'comparisonStatus': 'new' if current is None else 'modified' if changed else 'unchanged',
                'diffFields': changed,
            })
        return {**payload, 'rows': rows, 'revision': review.revision}

    @classmethod
    async def detail(cls, db, task_id, external_id, query):
        from plugins.bank.service.task_service import _formal_question_value, _normalise_question
        _, scope, _ = await cls.context(db, task_id, query)
        if not scope.collector_run_id:
            raise ServiceException(message='该教材尚未开始抓取')
        payload = await asyncio.to_thread(CollectorClient().run_question_detail, scope.collector_run_id, external_id,
                                          textbook_external_id=str(scope.external_textbook_id))
        validate_preview(payload, scope.collector_run_id, scope.external_textbook_id)
        item = _normalise_question(payload['item'])
        if not item or item['externalQuestionId'] != external_id:
            raise ServiceException(message='题目预览 ID 不一致')
        current_row = (await db.execute(select(QbQuestion).where(
            QbQuestion.source_provider == 'zujuan', QbQuestion.external_question_id == external_id
        ))).scalars().first()
        current = _formal_question_value(current_row) if current_row else None
        if current is not None:
            current['status'] = str(current_row.status or '0')
        changed = _question_diff_fields(item, current) if current is not None else []
        return {
            **item, 'fetched': item, 'current': current,
            'comparisonStatus': 'new' if current is None else 'modified' if changed else 'unchanged',
            'diffFields': changed,
        }

    @classmethod
    async def select_questions(cls, db, task_id, request, query):
        from plugins.bank.service.task_service import SAFE_EXTERNAL_ID
        _, scope, review = await cls.context(db, task_id, query)
        ids = set(request.external_question_ids)
        if any(not SAFE_EXTERNAL_ID.fullmatch(value) for value in ids):
            raise ServiceException(message='题目 ID 无效')
        if not scope.collector_run_id:
            raise ServiceException(message='该教材尚未开始抓取')
        check = await asyncio.to_thread(CollectorClient().run_questions_preview, scope.collector_run_id,
            textbookExternalId=str(scope.external_textbook_id), excludedIds=sorted(ids), selection='excluded', page=1, pageSize=1)
        validate_preview(check, scope.collector_run_id, scope.external_textbook_id)
        if check['total'] != len(ids):
            raise ServiceException(message='所选题目不属于本任务的当前教材')
        # The same task row serializes selection edits with formal application.
        await db.execute(select(QbSyncJob).where(QbSyncJob.run_id == task_id).with_for_update())
        await db.refresh(review, with_for_update=True)
        from plugins.bank.entity.do.bank_do import QbQuestionApplyState
        applied = (await db.execute(select(QbQuestionApplyState).where(QbQuestionApplyState.current_task_id == task_id).with_for_update())).scalars().first()
        if applied:
            raise ServiceException(message='本任务已同步入库，不能再修改题目选择')
        existing = set(review.excluded_json)
        selected = existing | ids if request.excluded else existing - ids
        if len(selected) > 100000:
            raise ServiceException(message='单个任务最多排除 100000 道题')
        review.excluded_json = sorted(selected)
        review.revision += 1
        await db.commit()
        return {'excludedCount': len(review.excluded_json), 'revision': review.revision}
