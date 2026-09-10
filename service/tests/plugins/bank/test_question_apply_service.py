"""Focused coverage for the scope-aware question snapshot apply flow."""

# Assertions intentionally use small fixture literals; keeping this file
# readable is more useful than introducing a constant for every expected row.
# ruff: noqa: PLR2004

from __future__ import annotations

import copy
import hashlib
from datetime import datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy import BigInteger, func, select
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles

from exceptions.exception import ServiceException
from plugins.bank.controller.bank_controller import bank_controller
from plugins.bank.dao.question_apply_dao import QuestionApplyDao
from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbQuestionApplyHistory,
    QbQuestionApplyState,
    QbQuestionAsset,
    QbQuestionCatalog,
    QbQuestionTag,
    QbQuestionTaskReview,
    QbSyncJob,
    QbSyncJobScope,
    QbTextbook,
    QbTextbookVersion,
)
from plugins.bank.entity.vo.bank_vo import QuestionApplyRequestModel
from plugins.bank.service import question_apply_service as module
from plugins.bank.service.question_apply_service import QuestionApplyService
from plugins.bank.service.task_service import SyncTaskService


@compiles(BigInteger, 'sqlite')
def _compile_bigint(_type: BigInteger, _compiler: object, **_kwargs: object) -> str:
    return 'INTEGER'


@compiles(LONGTEXT, 'sqlite')
def _compile_longtext(_type: LONGTEXT, _compiler: object, **_kwargs: object) -> str:
    return 'TEXT'


FORMAL_TABLES = [
    QbQuestionTaskReview.__table__,
    QbSyncJob.__table__,
    QbSyncJobScope.__table__,
    QbTextbookVersion.__table__,
    QbTextbook.__table__,
    QbCatalogNode.__table__,
    QbQuestion.__table__,
    QbQuestionCatalog.__table__,
    QbQuestionTag.__table__,
    QbQuestionAsset.__table__,
    QbQuestionApplyState.__table__,
    QbQuestionApplyHistory.__table__,
]


@pytest_asyncio.fixture
async def db() -> Any:
    engine = create_async_engine('sqlite+aiosqlite:///:memory:')
    async with engine.begin() as connection:
        await connection.run_sync(lambda sync: QbSyncJob.metadata.create_all(sync, tables=FORMAL_TABLES))
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


def _raw(run_id: int, textbook: str, question: str = 'q-1', catalog: str = 'c-1', *, tag: str | None = None, asset: bool = False) -> dict[str, Any]:
    tags = [] if tag is None else [{
        'provider': 'zujuan',
        'textbook_external_id': textbook,
        'question_external_id': question,
        'dimension': 'knowledge',
        'tag_value': tag,
        'evidence_type': 'provider_asserted',
    }]
    assets = [] if not asset else [{
        'provider': 'zujuan',
        'textbook_external_id': textbook,
        'question_external_id': question,
        'asset_key': 'image-1',
        'asset_type': 'image',
        'source_url': 'https://assets.example/q.png',
        'content_sha256': hashlib.sha256(b'asset-bytes').hexdigest(),
        'storage_path': 'assets/aa/q.png',
    }]
    return {
        'available': True,
        'immutable': True,
        'snapshotComplete': True,
        'run': {
            'id': run_id,
            'provider': 'zujuan',
            'status': 'completed',
            'errorCount': 0,
            'finished_at': '2026-08-29T08:00:00Z',
            'snapshot_locked_at': '2026-08-29T08:00:01Z',
            'snapshot_complete': 1,
            'scope': {'textbookExternalId': textbook},
        },
        'counts': {
            'catalogItemCount': 1,
            'questionItemCount': 1,
            'questionCatalogCount': 1,
            'questionTagCount': len(tags),
            'questionAssetCount': len(assets),
        },
        'catalogs': [{
            'provider': 'zujuan', 'textbook_external_id': textbook,
            'catalog_external_id': catalog, 'name': f'目录 {catalog}',
        }],
        'questions': [{
            'provider': 'zujuan', 'textbook_external_id': textbook,
            'question_external_id': question, 'content_html': f'<p>{question}</p>',
            'plain_text': question, 'question_type': '单选题',
            'detail_fetched': 1, 'detail_content_hash': f'detail-{question}',
            'solution_html': '<p>未分类解答</p>', 'is_new': 0, 'use_count': 3,
        }],
        'questionCatalogs': [{
            'provider': 'zujuan', 'textbook_external_id': textbook,
            'question_external_id': question, 'catalog_external_id': catalog,
            'evidence_type': 'query_membership',
        }],
        'tags': tags,
        'assets': assets,
    }


def _job(task_id: int, scopes: list[tuple[str, int, int]]) -> list[QbSyncJobScope]:
    now = datetime(2026, 8, 29, 8, 0, 0)
    return [
        QbSyncJobScope(
            scope_id=task_id * 10 + index,
            run_id=task_id,
            source_provider='zujuan',
            external_textbook_id=textbook,
            local_textbook_id=local_id,
            collector_run_id=run_id,
            status='completed',
            create_time=now,
            update_time=now,
        )
        for index, (textbook, local_id, run_id) in enumerate(scopes, 1)
    ]


async def _seed(db: AsyncSession, tasks: dict[int, list[tuple[str, int, int]]]) -> None:
    now = datetime(2026, 8, 29, 8, 0, 0)
    rows: list[Any] = []
    rows.extend(
        QbSyncJob(
            run_id=task_id,
            run_type='content',
            task_module='question',
            status='completed',
            phase='completed',
            options_json={},
            create_time=now,
            update_time=now,
        )
        for task_id in tasks
    )
    for task_id, scopes in tasks.items():
        rows.extend(_job(task_id, scopes))
    rows.append(QbTextbookVersion(
        version_id=1, source_provider='zujuan', external_version_id='v-1',
        version_name='版本', create_time=now, update_time=now,
    ))
    textbook_ids = {item[1]: item[0] for scopes in tasks.values() for item in scopes}
    rows.extend(
        QbTextbook(
            textbook_id=local_id,
            version_id=1,
            source_provider='zujuan',
            external_textbook_id=external_id,
            textbook_name=external_id,
            create_time=now,
            update_time=now,
        )
        for local_id, external_id in textbook_ids.items()
    )
    db.add_all(rows)
    await db.commit()


@pytest.fixture
def snapshot_reader(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> dict[int, dict[str, Any]]:
    snapshots = {
        101: _raw(101, 'tb-a', tag='A', asset=True),
        102: _raw(102, 'tb-b', tag='B'),
        201: _raw(201, 'tb-a', question='q-old', catalog='c-old', tag='old'),
        202: _raw(202, 'tb-a', question='q-new', catalog='c-new', tag='new'),
    }

    async def read(run_id: int, _textbook: str) -> dict[str, Any]:
        return copy.deepcopy(snapshots[run_id])

    monkeypatch.setattr(module, '_read_snapshot', read)
    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.test')
    monkeypatch.setenv('BANK_ASSET_ROOT', str(tmp_path / 'assets'))
    monkeypatch.setattr(module.CollectorClient, 'run_asset_bytes', lambda *_args, **_kwargs: b'asset-bytes')
    return snapshots


def test_snapshot_normalization_rejects_incomplete_detail_and_material() -> None:
    raw = _raw(1, 'tb-a', tag='x', asset=True)
    raw['snapshotComplete'] = False
    with pytest.raises(ServiceException, match='未完成'):
        module._normalise_snapshot(raw, 9, 'tb-a')

    raw = _raw(1, 'tb-a')
    raw['questions'][0]['detail_fetched'] = 0
    with pytest.raises(ServiceException, match='详情未完整'):
        module._normalise_snapshot(raw, 9, 'tb-a')

    normalized = module._normalise_snapshot(_raw(1, 'tb-a', tag='x', asset=True), 9, 'tb-a')
    assert normalized['questions'][0].get('answer_html') is None
    assert normalized['questions'][0].get('analysis_html') is None
    assert normalized['tags'][0]['tag_type'] == 'knowledge'
    assert normalized['assets'][0]['file_hash'] == hashlib.sha256(b'asset-bytes').hexdigest()


@pytest.mark.asyncio
async def test_first_apply_is_idempotent_and_records_scope_state(db: AsyncSession, snapshot_reader: dict[int, dict[str, Any]]) -> None:
    await _seed(db, {9: [('tb-a', 1, 101)]})
    result = await QuestionApplyService.apply(db, 9)
    assert result['action'] == 'apply'
    assert result['scopes'][0]['externalTextbookId'] == 'tb-a'
    assert result['stateToken']
    question = await db.scalar(select(QbQuestion).where(QbQuestion.external_question_id == 'q-1'))
    assert (
        question is not None
        and question.assemble_count == 3
        and question.answer_html is None
        and question.analysis_html is None
        and question.answer_status == 'unknown'
    )
    assert await db.scalar(select(func.count()).select_from(QbQuestionTag)) == 1
    assert await db.scalar(select(func.count()).select_from(QbQuestionAsset)) == 1
    state = await db.get(QbQuestionApplyState, ('zujuan', 'tb-a'))
    assert state is not None and state.current_task_id == 9

    again = await QuestionApplyService.apply(db, 9, expected_state_token=state.state_token)
    assert again['alreadyApplied'] is True
    assert await db.scalar(select(func.count()).select_from(QbQuestionApplyHistory)) == 1


@pytest.mark.asyncio
async def test_excluded_question_skips_all_scope_relations_and_assets(db, snapshot_reader):
    await _seed(db, {9: [('tb-a', 1, 101), ('tb-b', 2, 102)]})
    snapshot_reader[102] = _raw(102, 'tb-b', catalog='c-b', tag='B')
    db.add(QbQuestionTaskReview(task_id=9, baseline_json={}, excluded_json=['q-1'], revision=1, captured_at=datetime.now()))
    await db.commit()
    await QuestionApplyService.apply(db, 9)
    for model in (QbQuestion, QbQuestionCatalog, QbQuestionTag, QbQuestionAsset):
        assert await db.scalar(select(func.count()).select_from(model)) == 0


@pytest.mark.asyncio
async def test_exclusion_preserves_existing_formal_question_and_material(db, snapshot_reader):
    await _seed(db, {9: [('tb-a', 1, 101)], 10: [('tb-a', 1, 101)]})
    await QuestionApplyService.apply(db, 9)
    state = await db.get(QbQuestionApplyState, ('zujuan', 'tb-a'))
    token = state.state_token
    db.add(QbQuestionTaskReview(task_id=10, baseline_json={}, excluded_json=['q-1'], revision=1, captured_at=datetime.now()))
    await db.commit()
    await QuestionApplyService.apply(db, 10, expected_state_token=token)
    for model in (QbQuestion, QbQuestionCatalog, QbQuestionTag, QbQuestionAsset):
        assert await db.scalar(select(func.count()).select_from(model)) == 1
    assert (await db.scalar(select(QbQuestion))).status == '0'


@pytest.mark.asyncio
async def test_unknown_answer_keeps_existing_solution_and_stats_reflect_final_values(
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _seed(db, {9: [('tb-a', 1, 101)]})
    raw = _raw(101, 'tb-a')
    normalized = module._normalise_snapshot(raw, 9, 'tb-a')
    item = normalized['questions'][0]
    now = datetime(2026, 8, 29, 8, 0, 0)
    question_fields = (
        'source_url', 'source_question_no', 'source_text', 'paper_name', 'academic_year', 'year', 'grade', 'term',
        'province', 'city', 'district', 'school_name', 'exam_type', 'question_type', 'difficulty',
        'difficulty_coefficient', 'score', 'content_html', 'plain_text', 'answer_html', 'analysis_html',
        'answer_status', 'subquestion_count', 'website_time_text', 'external_updated_at', 'assemble_count',
        'reference_count', 'reference_papers_json', 'is_fresh', 'content_hash', 'raw_data_json', 'last_seen_at',
    )
    existing_values = {field: item[field] for field in question_fields}
    existing_values.update(
        {
            'answer_html': '<p>A</p>',
            'analysis_html': '<p>解析 A</p>',
            'answer_status': 'available',
            'last_sync_batch_id': 9,
            'status': '0',
            'create_time': now,
            'update_time': now,
        }
    )
    existing = QbQuestion(source_provider='zujuan', external_question_id='q-1', **existing_values)
    db.add(existing)
    await db.commit()

    async def read(_run_id: int, _textbook: str) -> dict[str, Any]:
        return copy.deepcopy(raw)

    monkeypatch.setattr(module, '_read_snapshot', read)
    result = await QuestionApplyService.apply(db, 9)

    question = await db.scalar(select(QbQuestion).where(QbQuestion.external_question_id == 'q-1'))
    assert question is not None
    assert question.answer_html == '<p>A</p>'
    assert question.analysis_html == '<p>解析 A</p>'
    assert question.answer_status == 'available'
    assert result['stats']['questions']['updated'] == 0
    assert result['stats']['questions']['unchanged'] == 1


@pytest.mark.asyncio
async def test_public_answer_status_replaces_existing_solution(
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _seed(db, {9: [('tb-a', 1, 101)]})
    now = datetime(2026, 8, 29, 8, 0, 0)
    existing = QbQuestion(
        source_provider='zujuan',
        external_question_id='q-1',
        question_type='单选题',
        answer_html='<p>旧答案</p>',
        analysis_html='<p>旧解析</p>',
        answer_status='available',
        status='0',
        create_time=now,
        update_time=now,
    )
    db.add(existing)
    await db.commit()
    raw = _raw(101, 'tb-a')
    raw['questions'][0].update(
        {
            'answer_status': 'public_captured',
            'answer_html': '<p>新答案</p>',
            'analysis_html': '<p>新解析</p>',
        }
    )

    async def read(_run_id: int, _textbook: str) -> dict[str, Any]:
        return copy.deepcopy(raw)

    monkeypatch.setattr(module, '_read_snapshot', read)
    result = await QuestionApplyService.apply(db, 9)

    question = await db.scalar(select(QbQuestion).where(QbQuestion.external_question_id == 'q-1'))
    assert question is not None
    assert question.answer_html == '<p>新答案</p>'
    assert question.analysis_html == '<p>新解析</p>'
    assert question.answer_status == 'available'
    assert result['stats']['questions']['updated'] >= 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('answer_status', 'formal_status'),
    [('login_required', 'restricted'), ('not_visible', 'not_provided')],
)
async def test_restricted_answer_status_clears_existing_solution(
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    answer_status: str,
    formal_status: str,
) -> None:
    await _seed(db, {9: [('tb-a', 1, 101)]})
    now = datetime(2026, 8, 29, 8, 0, 0)
    existing = QbQuestion(
        source_provider='zujuan',
        external_question_id='q-1',
        question_type='单选题',
        answer_html='<p>旧答案</p>',
        analysis_html='<p>旧解析</p>',
        answer_status='available',
        status='0',
        create_time=now,
        update_time=now,
    )
    db.add(existing)
    await db.commit()
    raw = _raw(101, 'tb-a')
    raw['questions'][0].update(
        {
            'answer_status': answer_status,
            'answer_html': '<p>不可信答案</p>',
            'analysis_html': '<p>不可信解析</p>',
        }
    )

    async def read(_run_id: int, _textbook: str) -> dict[str, Any]:
        return copy.deepcopy(raw)

    monkeypatch.setattr(module, '_read_snapshot', read)
    result = await QuestionApplyService.apply(db, 9)

    question = await db.scalar(select(QbQuestion).where(QbQuestion.external_question_id == 'q-1'))
    assert question is not None
    assert question.answer_html is None
    assert question.analysis_html is None
    assert question.answer_status == formal_status
    assert result['stats']['questions']['updated'] >= 1


@pytest.mark.asyncio
async def test_rollback_restore_preserves_question_primary_keys(db: AsyncSession, snapshot_reader: dict[int, dict[str, Any]]) -> None:
    await _seed(db, {
        10: [('tb-a', 1, 201)],
        20: [('tb-a', 1, 202)],
    })
    await QuestionApplyService.apply(db, 20)
    new = await db.scalar(select(QbQuestion).where(QbQuestion.external_question_id == 'q-new'))
    assert new is not None
    state = await db.get(QbQuestionApplyState, ('zujuan', 'tb-a'))
    rolled = await QuestionApplyService.apply(db, 10, expected_state_token=state.state_token)
    assert rolled['action'] == 'rollback'
    old = await db.scalar(select(QbQuestion).where(QbQuestion.external_question_id == 'q-old'))
    assert old is not None
    restored_state = await db.get(QbQuestionApplyState, ('zujuan', 'tb-a'))
    restored = await QuestionApplyService.apply(db, 20, expected_state_token=restored_state.state_token)
    assert restored['action'] == 'restore'
    restored_new = await db.scalar(select(QbQuestion).where(QbQuestion.external_question_id == 'q-new'))
    assert restored_new is not None and restored_new.question_id == new.question_id and restored_new.status == '0'
    assert old.status == '1'
    assert [(row.action) for row in (await db.execute(select(QbQuestionApplyHistory).order_by(QbQuestionApplyHistory.history_id))).scalars()] == ['apply', 'rollback', 'restore']


@pytest.mark.asyncio
async def test_parent_only_catalog_change_reports_the_changed_row(
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _seed(db, {30: [('tb-a', 1, 301)]})

    def hierarchy(run_id: int, parent: str | None) -> dict[str, Any]:
        raw = _raw(run_id, 'tb-a', catalog='c-child')
        raw['counts']['catalogItemCount'] = 2
        raw['catalogs'] = [
            {
                'provider': 'zujuan',
                'textbook_external_id': 'tb-a',
                'catalog_external_id': 'c-root',
                'name': '根目录',
            },
            {
                'provider': 'zujuan',
                'textbook_external_id': 'tb-a',
                'catalog_external_id': 'c-child',
                'parent_external_id': parent,
                'name': '子目录',
            },
        ]
        return raw

    snapshots = {301: hierarchy(301, None)}

    async def read(run_id: int, _textbook: str) -> dict[str, Any]:
        return copy.deepcopy(snapshots[run_id])

    monkeypatch.setattr(module, '_read_snapshot', read)
    await QuestionApplyService.apply(db, 30)
    scope = await db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == 30))
    snapshot = module._normalise_snapshot(hierarchy(302, 'c-root'), 30, 'tb-a')
    snapshot['scope'] = scope
    snapshot['task_id'] = 30
    stats = await QuestionApplyService._apply_scope(db, snapshot, datetime.now())

    assert stats['catalogs']['updated'] == 1
    assert stats['catalogs']['unchanged'] == 1


@pytest.mark.asyncio
async def test_multi_scope_tokens_and_shared_question_are_isolated(db: AsyncSession, monkeypatch: pytest.MonkeyPatch) -> None:
    await _seed(db, {9: [('tb-a', 1, 101), ('tb-b', 2, 102)]})
    raw_a = _raw(101, 'tb-a', question='shared-q', catalog='a-c', tag='A')
    raw_b = _raw(102, 'tb-b', question='shared-q', catalog='b-c', tag='B')

    async def read(run_id: int, _textbook: str) -> dict[str, Any]:
        return copy.deepcopy({101: raw_a, 102: raw_b}[run_id])

    monkeypatch.setattr(module, '_read_snapshot', read)
    first = await QuestionApplyService.apply(db, 9, expected_state_token={'tb-a': None, 'tb-b': None})
    assert isinstance(first['stateToken'], dict) and set(first['stateToken']) == {'tb-a', 'tb-b'}
    assert await db.scalar(select(func.count()).select_from(QbQuestion)) == 1
    assert await db.scalar(select(func.count()).select_from(QbQuestionCatalog)) == 2
    assert await db.scalar(select(func.count()).select_from(QbQuestionTag)) == 2
    detail = await QuestionApplyService.task_apply_status(
        db,
        await db.get(QbSyncJob, 9),
        list((await db.execute(select(QbSyncJobScope).where(QbSyncJobScope.run_id == 9))).scalars()),
    )
    assert set(detail['currentStateToken']) == {'tb-a', 'tb-b'}
    assert len(detail['affectedTextbooks']) == 2


@pytest.mark.asyncio
async def test_atomic_failure_rolls_back_all_scopes_and_history(
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    snapshot_reader: dict[int, dict[str, Any]],
) -> None:
    await _seed(db, {9: [('tb-a', 1, 101), ('tb-b', 2, 102)]})
    original = module.QuestionApplyService._apply_scope
    calls = 0

    async def fail_second(cls: Any, session: AsyncSession, snapshot: Any, now: datetime) -> Any:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError('scope failed')
        return await original(session, snapshot, now)

    monkeypatch.setattr(module.QuestionApplyService, '_apply_scope', classmethod(fail_second))
    with pytest.raises(RuntimeError, match='scope failed'):
        await QuestionApplyService.apply(db, 9)
    assert await db.scalar(select(func.count()).select_from(QbCatalogNode)) == 0
    assert await db.scalar(select(func.count()).select_from(QbQuestion)) == 0
    assert await db.scalar(select(func.count()).select_from(QbQuestionApplyState)) == 0
    assert await db.scalar(select(func.count()).select_from(QbQuestionApplyHistory)) == 0


@pytest.mark.asyncio
async def test_expected_token_conflict_and_delete_protection(db: AsyncSession, snapshot_reader: dict[int, dict[str, Any]]) -> None:
    await _seed(db, {9: [('tb-a', 1, 101)]})
    applied = await QuestionApplyService.apply(db, 9)
    with pytest.raises(ServiceException, match='状态 token'):
        await QuestionApplyService.apply(db, 9, expected_state_token='stale-token')
    with pytest.raises(ServiceException, match='不能删除'):
        await SyncTaskService.delete_question(db, 9)
    assert await db.get(QbSyncJob, 9) is not None
    assert applied['stateToken']


@pytest.mark.asyncio
async def test_task_detail_injects_apply_status(db: AsyncSession, snapshot_reader: dict[int, dict[str, Any]]) -> None:
    await _seed(db, {9: [('tb-a', 1, 101)]})
    detail = await SyncTaskService.question_detail(db, 9)
    assert 'applyStatus' in detail
    assert detail['applyStatus']['scopes'][0]['externalTextbookId'] == 'tb-a'
    assert detail['currentStateToken'] is None


@pytest.mark.asyncio
async def test_interrupted_apply_status_requires_positive_resume_run_id(db: AsyncSession) -> None:
    await _seed(db, {9: [('tb-a', 1, 101)]})
    task = await db.get(QbSyncJob, 9)
    task.status = 'interrupted'
    scopes = list(
        (await db.execute(select(QbSyncJobScope).where(QbSyncJobScope.run_id == 9))).scalars()
    )
    scopes[0].status = 'interrupted'
    scopes[0].resume_from_collector_run_id = None
    status = await QuestionApplyService.task_apply_status(db, task, scopes)
    assert status['scopes'][0]['resumeAvailable'] is False

    scopes[0].resume_from_collector_run_id = 101
    status = await QuestionApplyService.task_apply_status(db, task, scopes)
    assert status['scopes'][0]['resumeAvailable'] is True


@pytest.mark.asyncio
async def test_task_apply_status_projects_internal_summary_counts(
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _seed(db, {9: [('tb-a', 1, 101)]})

    async def summary(_run_id: int, _textbook_id: str) -> dict[str, Any]:
        return {
            'collector_run_id': 101,
            'counts': {
                'catalogs': 2,
                'questions': 11,
                'questionCatalogs': 13,
                'tags': 7,
                'assets': 5,
            },
            'run': {'snapshot_locked_at': '2026-08-29T08:00:01Z'},
        }

    monkeypatch.setattr(module, '_read_snapshot_summary', summary)
    task = await db.get(QbSyncJob, 9)
    scopes = list(
        (
            await db.execute(select(QbSyncJobScope).where(QbSyncJobScope.run_id == 9))
        ).scalars()
    )
    status = await QuestionApplyService.task_apply_status(db, task, scopes)
    scope = status['scopes'][0]

    assert (
        scope['catalogCount'],
        scope['questionCount'],
        scope['questionCatalogCount'],
        scope['questionTagCount'],
        scope['questionAssetCount'],
    ) == (2, 11, 13, 7, 5)


@pytest.mark.asyncio
async def test_apply_task_loader_can_read_without_lock_then_lock_task_and_scopes() -> None:
    statements: list[Any] = []

    class Result:
        def __init__(self, rows: list[Any]) -> None:
            self.rows = rows

        def scalars(self) -> Result:
            return self

        def all(self) -> list[Any]:
            return self.rows

    class Db:
        async def execute(self, statement: Any) -> Result:
            statements.append(statement)
            return Result([SimpleNamespace(run_id=9)]) if len(statements) == 1 else Result([])

    db = Db()
    task, scopes = await module._load_task_and_scopes(db, 9)

    assert task.run_id == 9 and scopes == []
    assert statements[0]._for_update_arg is None
    assert statements[1]._for_update_arg is None

    statements.clear()
    task, scopes = await module._load_task_and_scopes(db, 9, for_update=True)

    assert task.run_id == 9 and scopes == []
    assert statements[0]._for_update_arg is not None
    assert statements[1]._for_update_arg is not None


@pytest.mark.asyncio
@pytest.mark.parametrize('mutation', ['task', 'scope'])
async def test_question_apply_rechecks_task_scope_signature_after_remote_reads(
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
) -> None:
    initial_task = SimpleNamespace(
        run_id=9,
        task_module='question',
        run_type='content',
        status='completed',
        phase='completed',
        options_json={},
    )
    initial_scope = SimpleNamespace(
        scope_id=91,
        run_id=9,
        source_provider='zujuan',
        external_textbook_id='tb-a',
        collector_run_id=101,
        status='completed',
    )
    locked_task = SimpleNamespace(**vars(initial_task))
    locked_scope = SimpleNamespace(**vars(initial_scope))
    if mutation == 'task':
        locked_task.status = 'failed'
    else:
        locked_scope.collector_run_id = 102

    class Result:
        def __init__(self, rows: list[Any]) -> None:
            self.rows = rows

        def scalars(self) -> Result:
            return self

        def all(self) -> list[Any]:
            return self.rows

    class Db:
        def __init__(self) -> None:
            self.statements: list[Any] = []
            self.rollbacks = 0

        async def execute(self, statement: Any) -> Result:
            self.statements.append(statement)
            if len(self.statements) == 1:
                return Result([initial_task])
            if len(self.statements) == 2:
                return Result([initial_scope])
            if len(self.statements) == 3:
                return Result([locked_task])
            return Result([locked_scope])

        async def rollback(self) -> None:
            self.rollbacks += 1

        async def get(self, *_args, **_kwargs):
            return None

    async def read_snapshot(_run_id: int, _textbook_id: str) -> dict[str, Any]:
        return _raw(101, 'tb-a')

    monkeypatch.setattr(module, '_read_snapshot', read_snapshot)
    monkeypatch.setattr(module, '_download_snapshot_assets', AsyncMock())
    db = Db()

    with pytest.raises(ServiceException, match='在快照读取期间发生变化'):
        await module._validate_task_snapshots(db, 9)

    assert db.rollbacks == 1
    assert len(db.statements) == 4
    assert db.statements[0]._for_update_arg is None
    assert db.statements[1]._for_update_arg is None
    assert db.statements[2]._for_update_arg is not None
    assert db.statements[3]._for_update_arg is not None


def test_question_apply_route_and_request_vo_are_registered() -> None:
    app = FastAPI()
    app.include_router(bank_controller)
    schema = app.openapi()
    assert '/bank/sync/question/tasks/{task_id}/apply' in schema['paths']
    request = QuestionApplyRequestModel.model_validate({'expectedCurrentTaskId': None, 'expectedStateToken': {'tb-a': None}})
    assert request.expected_state_token == {'tb-a': None}


@pytest.mark.asyncio
async def test_dao_missing_state_table_does_not_rollback_loaded_transaction(monkeypatch: pytest.MonkeyPatch) -> None:
    db = type('Db', (), {})()
    error = Exception('Table qb_question_apply_state doesn\'t exist')
    monkeypatch.setattr(QuestionApplyDao, 'get_state', AsyncMock(side_effect=error))
    # The service intentionally only treats SQLAlchemyError as a missing-table
    # compatibility case; a raw exception must remain visible to callers.
    with pytest.raises(Exception, match='doesn\'t exist'):
        await QuestionApplyService._state(db, 'zujuan', 'tb-a')
