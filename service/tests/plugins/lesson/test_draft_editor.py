import copy
from datetime import datetime
from types import SimpleNamespace
import pytest
import pytest_asyncio
from sqlalchemy import select
from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbCatalogNode, QbQuestion, QbQuestionCatalog, QbQuestionReadiness
from plugins.bank.service.question_readiness import check_question, question_payload, store_proofs
from plugins.lesson.entity.do.lesson_do import LpEditorOperation, LpGeneration, LpGenerationItem, LpPickRule, LpScheme
from plugins.lesson.entity.vo.editor_vo import CandidateQuery, Command, CreateDraft, Fill, Pick, QuestionFilter, Replace
from plugins.lesson.service import editor_service as editor
from plugins.lesson.service.editor_filter import allocate, filtered_ids
from plugins.lesson.service.word_export import build_question_docx
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db

USER = SimpleNamespace(user=SimpleNamespace(user_name='teacher', user_id=2))
OTHER = SimpleNamespace(user=SimpleNamespace(user_name='other', user_id=3))


@pytest_asyncio.fixture
async def lesson_db(bank_db, tmp_path, monkeypatch):
    monkeypatch.setenv('BANK_ASSET_ROOT', str(tmp_path))
    connection = await bank_db.connection()
    tables = [m.__table__ for m in (LpEditorOperation, LpGenerationItem, LpPickRule, LpGeneration, LpScheme)]
    await connection.run_sync(lambda conn: LpGeneration.metadata.drop_all(conn, tables=tables))
    await connection.run_sync(lambda conn: LpGeneration.metadata.create_all(conn, tables=tables))
    catalog = await bank_db.get(QbCatalogNode, 1)
    catalog.status = '0'
    timestamp = datetime.utcnow()
    q = await bank_db.get(QbQuestion, 1)
    q.status = '0'
    q.content_html = '<p>计算 x<sup>2</sup>＋1</p>'
    q.plain_text = '计算 x²＋1'
    q.year = 2025
    q.subquestion_count = 2
    await bank_db.flush()
    for key in (1,):
        proof = check_question(question_payload(q), [], tmp_path)
        await store_proofs(bank_db, [q], [], [proof])
    # Existing fixture relations include another book; selected drafts must
    # still use only their own enabled catalog membership.
    relation = await bank_db.scalar(
        select(QbQuestionCatalog).where(QbQuestionCatalog.question_id == 1, QbQuestionCatalog.catalog_id == 1)
    )
    if relation is None:
        bank_db.add(
            QbQuestionCatalog(
                question_id=1,
                catalog_id=1,
                relation_type='query_catalog',
                evidence_type='query_membership',
                create_time=timestamp,
                update_time=timestamp,
            )
        )
    await bank_db.commit()
    yield bank_db


def mutation(revision, request_id, **values):
    return Command(expectedRevision=revision, requestId=request_id, **values)


@pytest.mark.asyncio
async def test_draft_selection_snapshot_stems_only_replay_move_remove_undo(lesson_db):
    db = lesson_db
    created = await editor.create(db, CreateDraft(requestId='create-1', textbookId=1, title='测试教案'), USER)
    assert await editor.create(db, CreateDraft(requestId='create-1', textbookId=1, title='测试教案'), USER) == created
    draft_id = created['draftId']
    group = {'groupKey': 'group-a', 'name': '同号相加', 'catalogIds': [1], 'rules': []}
    await editor.command(db, draft_id, mutation(1, 'structure-1', type='set_structure', groups=[group]), USER)
    selected = mutation(2, 'select-1', type='select', questionIds=[1], groupKey='group-a')
    result = await editor.command(db, draft_id, selected, USER)
    assert result['added'] == [1]
    assert await editor.command(db, draft_id, selected, USER) == result
    view = await editor.detail(db, draft_id, USER)
    assert view['revision'] == 3 and len(view['items']) == 1
    assert not set(view['items'][0]['question']) & {'answerHtml', 'analysisHtml', 'answerStatus'}
    item_id = view['items'][0]['itemId']
    await editor.command(db, draft_id, mutation(3, 'delete-group', type='set_structure', groups=[]), USER)
    assert (await editor.detail(db, draft_id, USER))['unassignedCount'] == 1
    await editor.command(db, draft_id, mutation(4, 'remove-1', type='remove', itemIds=[item_id]), USER)
    assert not (await editor.detail(db, draft_id, USER))['items']
    await editor.command(db, draft_id, mutation(5, 'undo-1', type='undo', undoRequestId='remove-1'), USER)
    view = await editor.detail(db, draft_id, USER)
    assert view['items'][0]['question']['plainText'] == '计算 x²＋1'
    model, paths = await editor.export_model(db, draft_id, 6, USER)
    content = build_question_docx(model, lambda q, k: paths.get((q, k)))
    from io import BytesIO
    from docx import Document

    paragraphs = '\n'.join(p.text for p in Document(BytesIO(content)).paragraphs)
    assert '计算 x' in paragraphs and '可信答案' not in paragraphs and '教学目标' not in paragraphs
    with pytest.raises(ServiceException, match='权限'):
        await editor.detail(db, draft_id, OTHER)
    with pytest.raises(ServiceException, match='其他窗口修改'):
        await editor.command(db, draft_id, mutation(1, 'stale', type='set_title', title='覆盖'), USER)


@pytest.mark.asyncio
async def test_strict_unknown_filters_counts_and_rule_change_retains_selected(lesson_db):
    db = lesson_db
    made = await editor.create(db, CreateDraft(requestId='create-2', textbookId=1), USER)
    rule = {'ruleKey': 'rule-a', 'name': '基础题', 'targetCount': 1, 'filter': {'questionTypes': ['单选题']}}
    group = {'groupKey': 'group-a', 'name': '内容', 'catalogIds': [1], 'rules': [rule]}
    await editor.command(db, made['draftId'], mutation(1, 'rules-1', type='set_structure', groups=[group]), USER)
    filled = await editor.select_by_rules(db, made['draftId'], Fill(requestId='fill-1', expectedRevision=2), USER)
    assert filled['allocationResults'][0]['added'] == 1
    group['rules'][0]['filter'] = {'questionTypes': ['解答题']}
    await editor.command(db, made['draftId'], mutation(3, 'rules-2', type='set_structure', groups=[group]), USER)
    view = await editor.detail(db, made['draftId'], USER)
    assert len(view['items']) == 1 and view['items'][0]['needsReview'] is True
    query = await filtered_ids(db, 1, QuestionFilter(maxExtraPoints=0))
    assert not list((await db.scalars(query)).all())
    candidates = await editor.candidates(db, CandidateQuery(draftId=made['draftId']), USER)
    assert candidates['total'] == 1 and candidates['remainingCount'] == 0


def test_matching_reassigns_flexible_candidate_to_preserve_rare_rule():
    result = allocate({'a': [1, 2], 'b': [1]}, {'a': 1, 'b': 1})
    assert result == {'a': [2], 'b': [1]}


@pytest.mark.asyncio
async def test_snapshot_keeps_asserted_points_from_other_books(lesson_db):
    db = lesson_db
    current = await db.get(QbCatalogNode, 1)
    current.node_type = 'point'
    foreign = await db.get(QbCatalogNode, 2)
    foreign.node_type = 'point'
    for catalog_id in (1, 2):
        db.add(
            QbQuestionCatalog(
                question_id=1,
                catalog_id=catalog_id,
                relation_type='knowledge',
                evidence_type='provider_asserted',
                create_time=datetime.now(),
                update_time=datetime.now(),
            )
        )
    await db.commit()
    values = await editor.snapshots(db, 1, [1])
    assert set(values[1]['assertedKnowledgeIds']) == {1, 2}
    from plugins.lesson.service.editor_filter import matches_snapshot

    assert not matches_snapshot(values[1], QuestionFilter(catalogIds=[1], maxExtraPoints=0))
    assert matches_snapshot(values[1], QuestionFilter(catalogIds=[1], maxExtraPoints=1))
    query = await filtered_ids(db, 1, QuestionFilter(catalogIds=[1], maxExtraPoints=1))
    assert 1 in (await db.scalars(query)).all()


@pytest.mark.asyncio
async def test_draft_tracks_current_question_changes_without_changing_snapshot(lesson_db):
    made = await editor.create(
        lesson_db, CreateDraft(requestId='snapshot-current', textbookId=1, title='历史内容'), USER
    )
    key = made['draftId']
    await editor.command(lesson_db, key, mutation(1, 'select-snapshot-current', type='select', questionIds=[1]), USER)
    row = await lesson_db.get(QbQuestion, 1)
    row.content_html = '<p>新版题干</p>'
    row.plain_text = '新版题干'
    row.status = '1'
    row.readiness_revision = 'f' * 64
    await lesson_db.commit()
    detail = await editor.detail(lesson_db, key, USER)
    assert detail['items'][0]['currentStatus'] == 'disabled'
    assert detail['items'][0]['sourceChanged'] is True
    assert detail['items'][0]['question']['plainText'] == '计算 x²＋1'
    model, _ = await editor.export_model(lesson_db, key, 2, USER)
    assert '新版题干' not in str(model)


@pytest.mark.asyncio
async def test_retention_keeps_draft_and_valid_undo_assets_and_request_tombstones(lesson_db, tmp_path):
    import os
    from datetime import timedelta
    from plugins.lesson.service.snapshot_maintenance import cleanup

    made = await editor.create(
        lesson_db, CreateDraft(requestId='retained-create', textbookId=1, title='保留素材'), USER
    )
    key = made['draftId']
    await editor.command(lesson_db, key, mutation(1, 'retained-select', type='select', questionIds=[1]), USER)
    root = tmp_path
    paths = root / 'lesson' / 'snapshots' / 'aa'
    paths.mkdir(parents=True)
    for name in ('draft.png', 'undo.png', 'orphan.png'):
        file = paths / name
        file.write_bytes(b'file')
        os.utime(file, (0, 0))
    item = await lesson_db.scalar(select(LpGenerationItem).where(LpGenerationItem.generation_id == key))
    item.question_snapshot_json = dict(
        item.question_snapshot_json, assetPaths={'image': 'lesson/snapshots/aa/draft.png'}
    )
    stamp = editor.now()
    for request_id, expiry in [
        ('valid-undo', stamp + timedelta(minutes=10)),
        ('expired-undo', stamp - timedelta(minutes=10)),
    ]:
        lesson_db.add(
            LpEditorOperation(
                operator='admin',
                request_id=request_id,
                generation_id=key,
                request_hash='a' * 64,
                result_json={'done': True},
                undo_json=[{'snapshot': {'assetPaths': {'image': 'lesson/snapshots/aa/undo.png'}}}],
                undo_until=expiry,
                create_time=stamp,
            )
        )
    await lesson_db.commit()
    result = await cleanup(lesson_db, root, apply=False, clock=stamp)
    assert result['unreferencedFiles'] == 1 and (paths / 'orphan.png').exists()
    result = await cleanup(lesson_db, root, apply=True, clock=stamp)
    assert result['expiredUndoPayloads'] == 1 and not (paths / 'orphan.png').exists()
    assert (paths / 'draft.png').exists() and (paths / 'undo.png').exists()
    old = await lesson_db.scalar(select(LpEditorOperation).where(LpEditorOperation.request_id == 'expired-undo'))
    assert old.result_json == {'done': True} and old.undo_json is None
    assert (
        await editor.create(lesson_db, CreateDraft(requestId='retained-create', textbookId=1, title='保留素材'), USER)
        == made
    )
