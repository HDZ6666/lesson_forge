"""Saved free-form lesson drafts: strict selection, snapshots and short CAS edits."""

import asyncio
import copy
import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbCatalogNode, QbQuestion, QbQuestionAsset, QbQuestionCatalog
from plugins.bank.service.question_readiness import (
    asset_payload,
    check_question,
    probe_stem,
    question_payload,
    store_proofs,
)
from plugins.lesson.entity.do.lesson_do import LpEditorOperation, LpGeneration, LpGenerationItem, LpScheme
from plugins.lesson.entity.vo.editor_vo import Group, QuestionFilter
from plugins.lesson.service.editor_filter import (
    allocate,
    book_scope,
    expanded_catalogs,
    filtered_ids,
    matches_snapshot,
    rule_filters,
)
from plugins.lesson.service.lesson_service import LessonService

MAX_ITEMS = 200
UNDO_MINUTES = max(1, int(os.environ.get('LESSON_UNDO_MINUTES', '30')))
QUESTION_FIELDS = (
    'question_type',
    'difficulty',
    'difficulty_coefficient',
    'year',
    'province',
    'city',
    'exam_type',
    'paper_name',
    'source_text',
    'subquestion_count',
    'content_html',
    'plain_text',
)


def now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    ).hexdigest()


def operator(user):
    return user.user.user_name


def admin(user):
    return user.user.user_id == 1


async def require_draft(db, draft_id, user, *, lock=False, allow_legacy=False):
    row = await db.get(LpGeneration, draft_id, with_for_update=lock, populate_existing=True)
    if row is None or row.status == 'deleted':
        raise ServiceException(message='教案不存在或已删除')
    if row.editor_schema_version == 2:
        if row.create_by != operator(user) and not admin(user):
            raise ServiceException(message='没有访问该教案的权限')
    elif not allow_legacy:
        raise ServiceException(message='历史教案只读，请复制为可编辑教案')
    return row


async def replay(db, user, request_id, request_hash):
    row = await db.scalar(
        select(LpEditorOperation).where(
            LpEditorOperation.operator == operator(user), LpEditorOperation.request_id == request_id
        )
    )
    if row:
        if row.request_hash != request_hash:
            raise ServiceException(message='请求编号已用于不同操作，请使用新的请求编号')
        return copy.deepcopy(row.result_json)
    return None


async def items(db, draft_id):
    return list(
        (
            await db.scalars(
                select(LpGenerationItem)
                .where(LpGenerationItem.generation_id == draft_id)
                .order_by(LpGenerationItem.sort_no, LpGenerationItem.item_id)
            )
        ).all()
    )


def public_item(row, editor):
    snapshot = row.question_snapshot_json or {}
    rules = rule_filters(editor)
    match = row.rule_key in rules and matches_snapshot(snapshot, rules[row.rule_key][2])
    return {
        'itemId': row.item_id,
        'questionId': row.question_id,
        'groupKey': row.group_key,
        'ruleKey': row.rule_key,
        'sortNo': row.sort_no,
        'question': copy.deepcopy(snapshot.get('question')),
        'matchesRule': bool(match),
        'needsReview': bool(row.rule_key and not match),
        'snapshotMissing': not bool(snapshot),
        'copiedFromCurrent': bool(snapshot.get('copiedFromCurrent')),
    }


async def detail(db, draft_id, user):
    row = await require_draft(db, draft_id, user, allow_legacy=True)
    if row.editor_schema_version == 1:
        # Retain historical snapshots, strip answers and old teaching text.
        old = await LessonService.detail(db, draft_id)
        groups, output = [], []
        for phase in old.get('phases') or []:
            key = f'legacy-{phase["phase"]}'
            groups.append({'groupKey': key, 'name': phase['name'], 'catalogIds': [], 'rules': []})
            for item in phase['items']:
                question = item.get('question') or {}
                probe = probe_stem(
                    {'content_html': question.get('contentHtml'), 'plain_text': question.get('plainText')}
                )
                question['assets'] = [a for a in question.get('assets') or [] if a['assetKey'] in probe['keys']]
                output.append(
                    {
                        'itemId': item['itemId'],
                        'questionId': item['questionId'],
                        'groupKey': key,
                        'ruleKey': None,
                        'sortNo': item['sortNo'],
                        'question': {
                            k: v for k, v in question.items() if k not in ('answerHtml', 'analysisHtml', 'answerStatus')
                        },
                        'snapshotMissing': not bool(
                            (await db.get(LpGenerationItem, item['itemId'])).question_snapshot_json
                        ),
                    }
                )
        return {
            'draftId': draft_id,
            'editorSchemaVersion': 1,
            'readOnly': True,
            'revision': 1,
            'title': old['lesson'].get('title') or '历史教案',
            'textbookId': old['scheme']['textbookId'],
            'textbookName': old['lesson'].get('textbookName') or f"教材 {old['scheme']['textbookId']}",
            'manualCount': len(output),
            'groups': groups,
            'printSettings': {'showGroupTitles': True, 'blankLines': 2},
            'items': output,
        }
    scheme = await db.get(LpScheme, row.scheme_id)
    editor = row.editor_json
    from plugins.bank.entity.do.bank_do import QbTextbook
    book = await db.get(QbTextbook, scheme.textbook_id)
    displayed_book_name = editor.get('textbookName') or (book.textbook_name if book else f'教材 {scheme.textbook_id}')
    saved_items = await items(db, draft_id)
    output = [public_item(item, editor) for item in saved_items]
    current = (
        {
            q.question_id: q
            for q in (
                await db.scalars(
                    select(QbQuestion).where(QbQuestion.question_id.in_([item['questionId'] for item in output]))
                )
            ).all()
        }
        if output
        else {}
    )
    for item in output:
        question = current.get(item['questionId'])
        snapshot = next((saved.question_snapshot_json for saved in saved_items if saved.item_id == item['itemId']), {})
        item['currentStatus'] = 'missing' if question is None else 'disabled' if question.status != '0' else 'enabled'
        item['sourceChanged'] = bool(question and snapshot.get('questionRevision') != question.readiness_revision)

    rules = rule_filters(editor)
    summaries = []
    for key, (_, target, _) in rules.items():
        assigned = [item for item in output if item['ruleKey'] == key]
        matched = sum(item['matchesRule'] for item in assigned)
        summaries.append(
            {
                'ruleKey': key,
                'targetCount': target,
                'matchedCount': matched,
                'needsReviewCount': len(assigned) - matched,
                'excessCount': max(0, matched - target),
                'deficit': max(0, target - matched),
            }
        )
    return {
        'draftId': draft_id,
        'editorSchemaVersion': 2,
        'readOnly': False,
        'revision': row.revision,
        'textbookId': scheme.textbook_id,
        'textbookName': displayed_book_name,
        'manualCount': sum(not item['ruleKey'] for item in output),
        'groupSummaries': [{'groupKey': g['groupKey'], 'selectedCount': sum(i['groupKey'] == g['groupKey'] for i in output), 'manualCount': sum(i['groupKey'] == g['groupKey'] and not i['ruleKey'] for i in output)} for g in editor['groups']],
        **copy.deepcopy(editor),
        'items': output,
        'rules': summaries,
        'unassignedCount': sum(not item['groupKey'] for item in output),
        'sourceGenerationId': row.source_generation_id,
    }


async def create(db, payload, user, *, source_id=None, copied_items=None, editor=None, request_hash_override=None):
    request_hash = request_hash_override or digest(
        {
            'action': 'create' if source_id is None else 'copy',
            'sourceId': source_id,
            'request': payload.model_dump(by_alias=True),
        }
    )
    old = await replay(db, user, payload.request_id, request_hash)
    if old:
        return old
    book = await book_scope(db, payload.textbook_id)
    book_id = book.textbook_id
    book_name = book.textbook_name
    await db.rollback()
    if editor is not None:
        editor = {**editor, 'textbookName': book_name}
    timestamp = now()
    scheme = LpScheme(
        scheme_name=payload.title,
        textbook_id=book_id,
        create_by=operator(user),
        create_time=timestamp,
        update_time=timestamp,
    )
    db.add(scheme)
    try:
        await db.flush()
        row = LpGeneration(
            scheme_id=scheme.scheme_id,
            seed=0,
            status='draft',
            editor_schema_version=2,
            revision=1,
            source_generation_id=source_id,
            editor_json=editor
            or {'title': payload.title, 'textbookName': book_name, 'groups': [], 'printSettings': {'showGroupTitles': True, 'blankLines': 2}},
            create_by=operator(user),
            create_time=timestamp,
            update_time=timestamp,
        )
        db.add(row)
        await db.flush()
        for original in copied_items or []:
            db.add(
                LpGenerationItem(
                    generation_id=row.generation_id,
                    question_id=original['questionId'],
                    group_key=original['groupKey'],
                    rule_key=original.get('ruleKey'),
                    sort_no=original['sortNo'],
                    question_snapshot_json=original['snapshot'],
                    create_time=timestamp,
                    update_time=timestamp,
                )
            )
        result = {'draftId': row.generation_id, 'revision': 1}
        db.add(
            LpEditorOperation(
                operator=operator(user),
                request_id=payload.request_id,
                generation_id=row.generation_id,
                request_hash=request_hash,
                result_json=result,
                create_time=timestamp,
            )
        )
        await db.commit()
        return result
    except IntegrityError:
        await db.rollback()
        result = await replay(db, user, payload.request_id, request_hash)
        if result:
            return result
        raise


async def candidates(db, payload, user):
    row = await require_draft(db, payload.draft_id, user)
    scheme = await db.get(LpScheme, row.scheme_id)
    filter = payload.filter
    if payload.rule_key:
        rule = rule_filters(row.editor_json).get(payload.rule_key)
        if rule is None:
            raise ServiceException(message='条件组不存在')
        filter = rule[2]
    query = await filtered_ids(db, scheme.textbook_id, filter)
    saved = await items(db, row.generation_id)
    selected = [item.question_id for item in saved]
    locations = {item.question_id: item.group_key for item in saved}
    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    remaining = await db.scalar(
        select(func.count()).select_from(query.where(~QbQuestion.question_id.in_(selected)).subquery())
    )
    ids = list(
        (
            await db.scalars(
                query.order_by(QbQuestion.question_id.desc())
                .offset((payload.page_num - 1) * payload.page_size)
                .limit(payload.page_size)
            )
        ).all()
    )
    questions = (await db.scalars(select(QbQuestion).where(QbQuestion.question_id.in_(ids)))).all() if ids else []
    assets = (
        (await db.scalars(select(QbQuestionAsset).where(QbQuestionAsset.question_id.in_(ids)))).all() if ids else []
    )
    rows = {q.question_id: question_dto(q, [a for a in assets if a.question_id == q.question_id]) for q in questions}
    return {
        'rows': [dict(rows[key], selected=key in selected, selectedGroupKey=locations.get(key)) for key in ids],
        'total': total,
        'remainingCount': remaining,
        'filter': filter.model_dump(by_alias=True),
        'revision': row.revision,
        'queriedAt': datetime.now(timezone.utc),
    }


def question_dto(row, assets):
    from pydantic.alias_generators import to_camel

    probe = probe_stem(question_payload(row))
    question = {
        to_camel(name): (
            float(getattr(row, name))
            if name == 'difficulty_coefficient' and getattr(row, name) is not None
            else getattr(row, name)
        )
        for name in QUESTION_FIELDS
    }
    question.update(
        questionId=row.question_id,
        assets=[
            {
                'assetKey': a.asset_key,
                'mimeType': a.mime_type,
                'available': bool(a.storage_path) and a.download_status not in ('failed', 'pending'),
            }
            for a in assets
            if a.asset_key in probe['keys']
        ],
    )
    return question


def retain_asset(asset):
    source = LessonService.resolve_asset_path(asset.storage_path)
    body = source.read_bytes()
    if len(body) > 64 * 1024 * 1024:
        raise ServiceException(message='教案素材超过64MiB')
    content_hash = hashlib.sha256(body).hexdigest()
    suffix = source.suffix.lower()
    relative = Path('lesson') / 'snapshots' / content_hash[:2] / f'{content_hash}{suffix}'
    target = Path(os.environ.get('BANK_ASSET_ROOT', 'data/bank')).resolve() / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if hashlib.sha256(target.read_bytes()).hexdigest() != content_hash:
            raise ServiceException(message='已有教案素材摘要不一致')
    else:
        temporary = target.with_name(f'{target.name}.{uuid4().hex}.tmp')
        try:
            temporary.write_bytes(body)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    return relative.as_posix(), content_hash


async def snapshots(db, textbook_id, ids):
    book = await book_scope(db, textbook_id)
    rows = (await db.scalars(select(QbQuestion).where(QbQuestion.question_id.in_(ids)))).all() if ids else []
    assets = (
        (await db.scalars(select(QbQuestionAsset).where(QbQuestionAsset.question_id.in_(ids)))).all() if ids else []
    )
    nodes = (
        await db.scalars(
            select(QbCatalogNode).where(
                QbCatalogNode.textbook_id == textbook_id, QbCatalogNode.subject_id == book.subject_id
            )
        )
    ).all()
    parents = {node.catalog_id: node.parent_id for node in nodes}
    relations = (
        (
            await db.scalars(
                select(QbQuestionCatalog)
                .join(QbCatalogNode, QbCatalogNode.catalog_id == QbQuestionCatalog.catalog_id)
                .where(
                    QbQuestionCatalog.question_id.in_(ids),
                    or_(
                        and_(
                            QbQuestionCatalog.relation_type == 'query_catalog',
                            QbQuestionCatalog.catalog_id.in_(parents),
                        ),
                        and_(
                            QbQuestionCatalog.relation_type == 'knowledge',
                            QbQuestionCatalog.evidence_type == 'provider_asserted',
                            QbCatalogNode.node_type == 'point',
                        ),
                    ),
                )
            )
        ).all()
        if ids
        else []
    )
    from types import SimpleNamespace

    rows = [
        SimpleNamespace(
            **{
                name: getattr(row, name)
                for name in (
                    *QUESTION_FIELDS,
                    'question_id',
                    'subject_id',
                    'source_provider',
                    'external_question_id',
                    'readiness_revision',
                    'content_hash',
                )
            }
        )
        for row in rows
    ]
    assets = [
        SimpleNamespace(
            **{
                name: getattr(a, name)
                for name in (
                    'question_id',
                    'asset_key',
                    'asset_type',
                    'source_provider',
                    'storage_path',
                    'file_hash',
                    'download_status',
                    'mime_type',
                    'width',
                    'height',
                )
            }
        )
        for a in assets
    ]
    relations = [
        SimpleNamespace(
            question_id=r.question_id,
            catalog_id=r.catalog_id,
            relation_type=r.relation_type,
            evidence_type=r.evidence_type,
        )
        for r in relations
    ]
    payloads = [question_payload(row) for row in rows]
    asset_values = [asset_payload(a) for a in assets]
    await db.rollback()
    proofs = await asyncio.to_thread(
        lambda: [
            check_question(
                q,
                [a for a in asset_values if a['question_id'] == q['question_id']],
                Path(os.environ.get('BANK_ASSET_ROOT', 'data/bank')).resolve(),
            )
            for q in payloads
        ]
    )
    # Lost files become invalid facts even if no draft mutation is committed.
    current = (
        (
            await db.scalars(
                select(QbQuestion)
                .where(QbQuestion.question_id.in_(ids))
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).all()
        if ids
        else []
    )
    current_assets = (
        (await db.scalars(select(QbQuestionAsset).where(QbQuestionAsset.question_id.in_(ids)).with_for_update())).all()
        if ids
        else []
    )
    stored = await store_proofs(db, current, current_assets, proofs)
    await db.commit()
    accepted = {p['question_id']: p for p in proofs if p['status'] == 'ready' and p['question_id'] in stored}
    result = {}
    for row in rows:
        if row.question_id not in accepted:
            continue
        own = [
            a
            for a in assets
            if a.question_id == row.question_id and a.asset_key in probe_stem(question_payload(row))['keys']
        ]
        kept = await asyncio.to_thread(lambda: {a.asset_key: retain_asset(a) for a in own})
        catalog_ids, asserted, paths = set(), [], {}
        for relation in relations:
            if relation.question_id != row.question_id:
                continue
            ancestors, node = set(), relation.catalog_id
            while node in parents and node not in ancestors:
                ancestors.add(node)
                node = parents[node]
            if relation.relation_type == 'query_catalog':
                catalog_ids.update(ancestors)
            if relation.relation_type == 'knowledge' and relation.evidence_type == 'provider_asserted':
                asserted.append(relation.catalog_id)
                paths[str(relation.catalog_id)] = sorted(ancestors or {relation.catalog_id})
        result[row.question_id] = {
            'question': question_dto(row, own),
            'catalogIds': sorted(catalog_ids),
            'assertedKnowledgeIds': asserted or None,
            'assertedKnowledgePaths': paths,
            'hasImage': accepted[row.question_id]['has_image'],
            'hasTable': accepted[row.question_id]['has_table'],
            'contentHash': row.content_hash,
            'questionRevision': row.readiness_revision,
            'externalQuestionId': row.external_question_id,
            'assetPaths': {key: value[0] for key, value in kept.items()},
            'assetHashes': {key: value[1] for key, value in kept.items()},
            'assetMimeTypes': {a.asset_key: a.mime_type for a in own},
        }
    return result


async def validate_structure(db, textbook_id, groups):
    book = await book_scope(db, textbook_id)
    keys, rule_keys, target_count = set(), set(), 0
    normalized = []
    for raw in groups:
        group = Group.model_validate(raw)
        if group.group_key in keys:
            raise ServiceException(message='内容编号重复')
        keys.add(group.group_key)
        await expanded_catalogs(db, book, group.catalog_ids)
        if group.rules and not group.catalog_ids:
            raise ServiceException(message='保存可执行条件组前请选择该内容的目录范围')
        for rule in group.rules:
            if rule.rule_key in rule_keys:
                raise ServiceException(message='条件组编号重复')
            rule_keys.add(rule.rule_key)
            rule.filter.catalog_ids = []
            target_count += rule.target_count
        normalized.append(group.model_dump(by_alias=True))
    if len(rule_keys) > 40 or target_count > MAX_ITEMS:
        raise ServiceException(message='最多40个条件组，目标题数总计最多200道')
    return normalized


async def mutate(db, draft_id, payload, user, action, prepare, apply):
    request_hash = digest({'action': action, 'draftId': draft_id, 'payload': payload.model_dump(by_alias=True)})
    existing = await replay(db, user, payload.request_id, request_hash)
    if existing:
        return existing
    row = await require_draft(db, draft_id, user)
    if row.revision != payload.expected_revision:
        raise ServiceException(message='教案已被其他窗口修改，请刷新后重试；本次未保存')
    scheme = await db.get(LpScheme, row.scheme_id)
    editor, saved = copy.deepcopy(row.editor_json), await items(db, draft_id)
    try:
        async with asyncio.timeout(5):
            prepared = await prepare(editor, saved, scheme.textbook_id) if prepare else None
    except TimeoutError as exc:
        raise ServiceException(message='本次选题计算未完成，请缩小范围后重试；本次未修改教案') from exc
    await db.rollback()
    row = await require_draft(db, draft_id, user, lock=True)
    # Replay after the lock covers two concurrent retries of the same request.
    existing = await replay(db, user, payload.request_id, request_hash)
    if existing:
        await db.rollback()
        return existing
    if row.revision != payload.expected_revision:
        raise ServiceException(message='教案版本已变化，请刷新后重试；本次未保存')
    saved = await items(db, draft_id)
    result, undo = await apply(row, saved, prepared)
    row.revision += 1
    row.update_time = now()
    row.update_by = operator(user)
    response = {'draftId': draft_id, 'revision': row.revision, **result}
    db.add(
        LpEditorOperation(
            operator=operator(user),
            request_id=payload.request_id,
            generation_id=draft_id,
            request_hash=request_hash,
            result_json=response,
            undo_json=undo,
            undo_until=now() + timedelta(minutes=UNDO_MINUTES) if undo else None,
            create_time=now(),
        )
    )
    await db.commit()
    return response


def target_rule(editor, group_key, rule_key):
    if group_key and group_key not in {group['groupKey'] for group in editor['groups']}:
        raise ServiceException(message='目标内容不存在')
    rules = rule_filters(editor)
    if rule_key and (rule_key not in rules or rules[rule_key][0] != group_key):
        raise ServiceException(message='条件组不属于目标内容')
    return rules.get(rule_key)


def append_item(db, draft_id, question_id, snapshot, group_key, rule_key, saved):
    sort_no = max((item.sort_no for item in saved if item.group_key == group_key), default=-1) + 1
    row = LpGenerationItem(
        generation_id=draft_id,
        question_id=question_id,
        group_key=group_key,
        rule_key=rule_key,
        sort_no=sort_no,
        question_snapshot_json=snapshot,
        create_time=now(),
        update_time=now(),
    )
    db.add(row)
    saved.append(row)
    return row


async def verify_selected(db, textbook_id, values, query):
    ids = list(values)
    valid = (
        set((await db.scalars(query.where(QbQuestion.question_id.in_(ids)).with_for_update())).all()) if ids else set()
    )
    current = (
        {
            row.question_id: row
            for row in (
                await db.scalars(
                    select(QbQuestion)
                    .where(QbQuestion.question_id.in_(ids))
                    .with_for_update()
                    .execution_options(populate_existing=True)
                )
            ).all()
        }
        if ids
        else {}
    )
    return {
        key: snapshot
        for key, snapshot in values.items()
        if key in valid
        and key in current
        and current[key].readiness_revision == snapshot['questionRevision']
        and current[key].content_hash == snapshot['contentHash']
    }


async def command(db, draft_id, payload, user):
    async def prepare(editor, saved, textbook_id):
        if payload.type == 'set_structure':
            if payload.groups is None:
                raise ServiceException(message='缺少内容结构')
            return await validate_structure(db, textbook_id, payload.groups)
        if payload.type == 'select':
            target = target_rule(editor, payload.group_key, payload.rule_key)
            filter = target[2] if target else payload.filter or QuestionFilter()
            query = await filtered_ids(db, textbook_id, filter)
            values = await snapshots(db, textbook_id, list(dict.fromkeys(payload.question_ids)))
            return {'snapshots': values, 'query': query, 'textbookId': textbook_id}
        return None

    async def apply(row, saved, prepared):
        editor = copy.deepcopy(row.editor_json)
        undo, result = None, {}
        if payload.type == 'set_title':
            if not payload.title:
                raise ServiceException(message='标题不能为空')
            editor['title'] = payload.title
        elif payload.type == 'set_print':
            if payload.print_settings is None:
                raise ServiceException(message='缺少打印设置')
            editor['printSettings'] = payload.print_settings.model_dump(by_alias=True)
        elif payload.type == 'set_structure':
            editor['groups'] = prepared
            groups = {group['groupKey'] for group in prepared}
            rules = rule_filters(editor)
            for item in saved:
                if item.group_key not in groups:
                    item.group_key, item.rule_key = None, None
                elif item.rule_key and (item.rule_key not in rules or rules[item.rule_key][0] != item.group_key):
                    item.rule_key = None
        elif payload.type == 'select':
            target_rule(editor, payload.group_key, payload.rule_key)
            values = await verify_selected(db, prepared['textbookId'], prepared['snapshots'], prepared['query'])
            selected = {item.question_id for item in saved}
            incoming = [key for key in dict.fromkeys(payload.question_ids) if key not in selected and key in values]
            if len(saved) + len(incoming) > MAX_ITEMS:
                raise ServiceException(message='一份教案最多200道题，请先整理已选题')
            for key in incoming:
                append_item(db, draft_id, key, values[key], payload.group_key, payload.rule_key, saved)
            result = {
                'added': incoming,
                'alreadySelected': [key for key in payload.question_ids if key in selected],
                'rejected': [key for key in payload.question_ids if key not in selected and key not in values],
            }
        elif payload.type in ('move', 'remove', 'reorder'):
            selected_items = {item.item_id: item for item in saved}
            if (
                not payload.item_ids
                or len(set(payload.item_ids)) != len(payload.item_ids)
                or set(payload.item_ids) - set(selected_items)
            ):
                raise ServiceException(message='题目条目不存在、重复或不属于当前教案')
            chosen = [selected_items[key] for key in payload.item_ids]
            if payload.type == 'remove':
                undo = [
                    {
                        'questionId': item.question_id,
                        'groupKey': item.group_key,
                        'ruleKey': item.rule_key,
                        'sortNo': item.sort_no,
                        'snapshot': item.question_snapshot_json,
                    }
                    for item in chosen
                ]
                for item in chosen:
                    await db.delete(item)
                result['undoRequestId'] = payload.request_id
            elif payload.type == 'move':
                target = target_rule(editor, payload.group_key, payload.rule_key)
                if target and any(not matches_snapshot(item.question_snapshot_json, target[2]) for item in chosen):
                    raise ServiceException(message='所选题不符合目标条件组，可先作为无规则手选题移动')
                tail = max((item.sort_no for item in saved if item.group_key == payload.group_key), default=-1) + 1
                for offset, item in enumerate(chosen):
                    item.group_key, item.rule_key, item.sort_no = payload.group_key, payload.rule_key, tail + offset
            else:
                current_ids = {item.item_id for item in saved if item.group_key == payload.group_key}
                if set(payload.item_ids) != current_ids:
                    raise ServiceException(message='排序必须包含该内容的所有条目')
                for offset, item in enumerate(chosen):
                    item.sort_no = offset
        elif payload.type == 'undo':
            op = await db.scalar(
                select(LpEditorOperation)
                .where(
                    LpEditorOperation.operator == operator(user),
                    LpEditorOperation.generation_id == draft_id,
                    LpEditorOperation.request_id == payload.undo_request_id,
                )
                .with_for_update()
            )
            if not op or not op.undo_json or op.undone or not op.undo_until or op.undo_until < now():
                raise ServiceException(message='该移出操作已撤销或超过30分钟，不能再次恢复')
            restore = [item for item in op.undo_json if item['questionId'] not in {x.question_id for x in saved}]
            if len(saved) + len(restore) > MAX_ITEMS:
                raise ServiceException(message='恢复后超过200道题，请先整理')
            for item in restore:
                group_key = item['groupKey'] if item['groupKey'] in {g['groupKey'] for g in editor['groups']} else None
                rule_key = (
                    item['ruleKey']
                    if item['ruleKey'] in rule_filters(editor) and rule_filters(editor)[item['ruleKey']][0] == group_key
                    else None
                )
                added = append_item(db, draft_id, item['questionId'], item['snapshot'], group_key, rule_key, saved)
                added.sort_no = item['sortNo']
            op.undone = 1
            result['restoredCount'] = len(restore)
        row.editor_json = editor
        return result, undo

    return await mutate(db, draft_id, payload, user, f'command:{payload.type}', prepare, apply)


async def select_by_rules(db, draft_id, payload, user, *, direct=False, replace_item_id=None):
    async def prepare(editor, saved, textbook_id):
        all_rules = rule_filters(editor)
        replacing = next((item for item in saved if item.item_id == replace_item_id), None) if replace_item_id else None
        if replace_item_id and replacing is None:
            raise ServiceException(message='替换条目不属于该教案')
        if replacing:
            if replacing.rule_key:
                if replacing.rule_key not in all_rules:
                    raise ServiceException(message='条件组不存在')
                rules = {replacing.rule_key: (replacing.group_key, 1, all_rules[replacing.rule_key][2])}
            else:
                if payload.filter is None:
                    raise ServiceException(message='手选题换题需要明确筛选条件')
                rules = {'direct': (replacing.group_key, 1, payload.filter)}
        elif direct:
            target_rule(editor, payload.group_key, None)
            rules = {'direct': (payload.group_key, payload.count, payload.filter)}
        else:
            rules = {
                key: value
                for key, value in all_rules.items()
                if (payload.group_key is None or value[0] == payload.group_key)
                and (payload.rule_key is None or key == payload.rule_key)
            }
            if payload.rule_key and payload.rule_key not in rules:
                raise ServiceException(message='条件组不存在')
        deficits = {
            key: target
            if direct or replacing
            else max(
                0,
                target
                - sum(item.rule_key == key and matches_snapshot(item.question_snapshot_json, filter) for item in saved),
            )
            for key, (_, target, filter) in rules.items()
        }
        count = sum(deficits.values())
        if len(saved) + count - bool(replacing) > MAX_ITEMS:
            raise ServiceException(message='本次补齐会超过200道题，请整理已选题或缩小范围')
        excluded = [item.question_id for item in saved]
        while True:
            pools, queries = {}, {}
            for key, (_, _, filter) in rules.items():
                query = await filtered_ids(db, textbook_id, filter)
                queries[key] = query
                pools[key] = (
                    list(
                        (
                            await db.scalars(
                                query.where(~QbQuestion.question_id.in_(excluded))
                                .order_by(QbQuestion.question_id.desc())
                                .limit(count)
                            )
                        ).all()
                    )
                    if deficits[key]
                    else []
                )
            allocations = allocate(pools, deficits)
            chosen = {key for pool in allocations.values() for key in pool}
            values = await snapshots(db, textbook_id, list(chosen))
            failed = chosen - set(values)
            if not failed:
                break
            excluded.extend(failed)
        return {
            'rules': rules,
            'deficits': deficits,
            'allocations': allocations,
            'snapshots': values,
            'queries': queries,
            'textbookId': textbook_id,
            'replaceItemId': replace_item_id,
        }

    async def apply(row, saved, prepared):
        result = []
        for key, selected in prepared['allocations'].items():
            values = await verify_selected(
                db, prepared['textbookId'], {q: prepared['snapshots'][q] for q in selected}, prepared['queries'][key]
            )
            if len(values) != len(selected):
                raise ServiceException(message='候选在选题期间变化，本次未修改教案，请重试')
            group_key = prepared['rules'][key][0]
            if replace_item_id:
                if not selected:
                    return {'replaced': False, 'reason': '没有符合条件的未选题，原题保留'}, None
                item = next(item for item in saved if item.item_id == replace_item_id)
                item.replaced_from_question_id = item.question_id
                item.question_id = selected[0]
                item.question_snapshot_json = values[selected[0]]
                item.update_time = now()
            else:
                for q in selected:
                    append_item(db, draft_id, q, values[q], group_key, None if direct else key, saved)
            result.append(
                {
                    'ruleKey': None if direct else key,
                    'requested': prepared['deficits'][key],
                    'added': len(selected),
                    'shortfall': prepared['deficits'][key] - len(selected),
                }
            )
        return {'allocationResults': result, 'replaced': bool(replace_item_id)}, None

    return await mutate(
        db, draft_id, payload, user, 'replace' if replace_item_id else 'pick' if direct else 'fill', prepare, apply
    )


async def delete_draft(db, draft_id, payload, user):
    async def apply(row, saved, prepared):
        # Keep snapshots and request tombstones for exports and retry safety.
        row.status = 'deleted'
        return {'deleted': True}, None

    return await mutate(db, draft_id, payload, user, 'delete', None, apply)


async def copy_as_draft(db, generation_id, payload, user):
    source = await require_draft(db, generation_id, user, allow_legacy=True)
    request_hash = digest({'action': 'copy', 'sourceId': generation_id, 'request': payload.model_dump(by_alias=True)})
    existing = await replay(db, user, payload.request_id, request_hash)
    if existing:
        return existing
    shown = await detail(db, generation_id, user)
    original = await items(db, generation_id)
    from types import SimpleNamespace

    source_schema = source.editor_schema_version
    original = [
        SimpleNamespace(
            item_id=i.item_id,
            question_id=i.question_id,
            rule_key=i.rule_key,
            sort_no=i.sort_no,
            question_snapshot_json=copy.deepcopy(i.question_snapshot_json),
        )
        for i in original
    ]
    copied = []
    missing = [item.question_id for item in original if not item.question_snapshot_json]
    current = await snapshots(db, shown['textbookId'], missing) if missing else {}
    by_id = {item['itemId']: item for item in shown['items']}
    for item in original:
        snapshot = copy.deepcopy(item.question_snapshot_json)
        if not snapshot:
            snapshot = current.get(item.question_id)
            if snapshot is None:
                raise ServiceException(message=f'历史题目 {item.question_id} 快照缺失，当前题干或素材也不可用')
            snapshot['copiedFromCurrent'] = True
        else:
            q = snapshot.get('question') or {}
            snapshot['question'] = {
                key: value for key, value in q.items() if key not in ('answerHtml', 'analysisHtml', 'answerStatus')
            }
            probe = probe_stem({'content_html': q.get('contentHtml'), 'plain_text': q.get('plainText')})
            kept = {}
            from types import SimpleNamespace

            for key in probe['keys']:
                path = (snapshot.get('assetPaths') or {}).get(key)
                if not path:
                    raise ServiceException(message=f'历史题目 {item.question_id} 缺少素材 {key}')
                kept[key] = await asyncio.to_thread(retain_asset, SimpleNamespace(storage_path=path))
            snapshot['question']['assets'] = [
                a for a in snapshot['question'].get('assets') or [] if a['assetKey'] in probe['keys']
            ]
            snapshot['assetPaths'] = {key: value[0] for key, value in kept.items()}
            snapshot['assetHashes'] = {key: value[1] for key, value in kept.items()}
        shown_item = by_id[item.item_id]
        copied.append(
            {
                'questionId': item.question_id,
                'groupKey': shown_item['groupKey'],
                'ruleKey': item.rule_key if source_schema == 2 else None,
                'sortNo': item.sort_no,
                'snapshot': snapshot,
            }
        )
    if len(copied) > MAX_ITEMS:
        raise ServiceException(message='历史记录超过新草稿200题上限，仍可只读查看与导出')
    from plugins.lesson.entity.vo.editor_vo import CreateDraft

    title = payload.title or f'{shown["title"]}（副本）'
    return await create(
        db,
        CreateDraft(request_id=payload.request_id, textbook_id=shown['textbookId'], title=title[:200]),
        user,
        source_id=generation_id,
        copied_items=copied,
        editor={'title': title[:200], 'groups': shown['groups'], 'printSettings': shown['printSettings']},
        request_hash_override=request_hash,
    )


async def list_drafts(db, user, *, page_num=1, page_size=20):
    query = select(LpGeneration).where(LpGeneration.editor_schema_version == 2, LpGeneration.status != 'deleted')
    if not admin(user):
        query = query.where(LpGeneration.create_by == operator(user))
    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    rows = (
        await db.scalars(
            query.order_by(LpGeneration.generation_id.desc()).offset((page_num - 1) * page_size).limit(page_size)
        )
    ).all()
    return {
        'rows': [
            {
                'draftId': row.generation_id,
                'title': row.editor_json['title'],
                'revision': row.revision,
                'createTime': row.create_time.replace(tzinfo=timezone.utc),
            }
            for row in rows
        ],
        'total': total,
    }


async def snapshot_asset(db, draft_id, question_id, key, user):
    await require_draft(db, draft_id, user, allow_legacy=True)
    item = await db.scalar(
        select(LpGenerationItem).where(
            LpGenerationItem.generation_id == draft_id, LpGenerationItem.question_id == question_id
        )
    )
    snapshot = item.question_snapshot_json if item else None
    if not snapshot or key not in (snapshot.get('assetPaths') or {}):
        raise ServiceException(message='素材不属于当前教案快照')
    path = LessonService.resolve_asset_path(snapshot['assetPaths'][key])
    expected = (snapshot.get('assetHashes') or {}).get(key)
    if expected and await asyncio.to_thread(lambda: hashlib.sha256(path.read_bytes()).hexdigest()) != expected:
        raise ServiceException(message='教案快照素材已损坏')
    return path, (snapshot.get('assetMimeTypes') or {}).get(key) or 'application/octet-stream'


async def export_model(db, draft_id, revision, user):
    row = await require_draft(db, draft_id, user, allow_legacy=True)
    if row.editor_schema_version == 2 and row.revision != revision:
        raise ServiceException(message='教案版本已变化，请刷新预览后导出')
    shown = await detail(db, draft_id, user)
    saved = await items(db, draft_id)
    snapshots_by_id = {item.question_id: copy.deepcopy(item.question_snapshot_json) for item in saved}
    # Material references are retained when deleted; this export can continue
    # after the short consistent database read has ended.
    await db.rollback()
    paths = {}
    for item in shown['items']:
        if item.get('snapshotMissing'):
            raise ServiceException(message=f'历史题目 {item["questionId"]} 快照缺失，请复制并核对后导出')
        snapshot = snapshots_by_id[item['questionId']]
        question = item.get('question') or {}
        probe = probe_stem({'content_html': question.get('contentHtml'), 'plain_text': question.get('plainText')})
        if not probe['stem_valid']:
            raise ServiceException(message=f'题目 {item["questionId"]} 的题干无法完整导出')
        for key in probe['keys']:
            value = (snapshot.get('assetPaths') or {}).get(key)
            try:
                path = LessonService.resolve_asset_path(value)
                expected = (snapshot.get('assetHashes') or {}).get(key)
                if (
                    expected
                    and await asyncio.to_thread(lambda: hashlib.sha256(path.read_bytes()).hexdigest()) != expected
                ):
                    raise ValueError('hash mismatch')
            except Exception as exc:
                raise ServiceException(message=f'题目 {item["questionId"]} 缺少或损坏素材 {key}') from exc
            paths[(item['questionId'], key)] = path
    model = {
        'title': shown['title'],
        'revision': shown['revision'],
        'printSettings': shown['printSettings'],
        'groups': [],
    }
    for group in shown['groups'] + [{'groupKey': None, 'name': '补充题'}]:
        own = sorted(
            [item for item in shown['items'] if item['groupKey'] == group['groupKey']],
            key=lambda x: (x['sortNo'], x['itemId']),
        )
        if own:
            model['groups'].append({'name': group['name'], 'items': own})
    return model, paths
