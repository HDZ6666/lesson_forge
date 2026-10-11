"""Real-ORM additive writes protect teachers and shared book relationships."""

import json
import os
from datetime import datetime

import pytest
import pytest_asyncio
from sqlalchemy import URL, BigInteger, select
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbQuestionApplyState,
    QbQuestionAsset,
    QbQuestionCatalog,
    QbQuestionImport,
    QbQuestionImportBatch,
    QbQuestionImportIntake,
    QbQuestionReadiness,
    QbQuestionReadinessSweep,
    QbQuestionTag,
    QbQuestionTaskReview,
    QbSubject,
    QbSyncBookState,
    QbSyncControl,
    QbSyncCycle,
    QbSyncIssue,
    QbSyncIssueTask,
    QbSyncJob,
    QbSyncJobScope,
    QbSyncPlan,
    QbTextbook,
    QbTextbookVersion,
)
from plugins.bank.service.incremental_merge import merge_prepared_incremental_batch, prepare_incremental_verdicts
from plugins.bank.service.question_apply_service import _normalise_snapshot


@compiles(BigInteger, 'sqlite')
def bigint(_type, _compiler, **_kwargs):
    return 'INTEGER'


@compiles(LONGTEXT, 'sqlite')
def longtext(_type, _compiler, **_kwargs):
    return 'TEXT'


@pytest_asyncio.fixture
async def bank_db():
    mysql_check = os.environ.get('LESSON_REFACTOR_MYSQL_MERGE_CHECK') == '1'
    if mysql_check:
        source = json.loads(os.environ['DB_SOURCES'])['primary']
        assert source['db_host'] == '127.0.0.1' and int(source['db_port']) == 13316
        assert source['db_database'] == 'lesson_refactor'
        engine = create_async_engine(
            URL.create(
                'mysql+asyncmy',
                host=source['db_host'],
                port=13316,
                username=source['db_username'],
                password=source['db_password'],
                database='lesson_refactor_merge',
            )
        )
    else:
        engine = create_async_engine('sqlite+aiosqlite:///:memory:')
    models = (
        QbSyncControl, QbSyncPlan, QbSyncCycle, QbSyncBookState, QbSyncIssue, QbSyncIssueTask,
        QbSubject,
        QbTextbookVersion,
        QbTextbook,
        QbCatalogNode,
        QbQuestion,
        QbQuestionCatalog,
        QbQuestionTag,
        QbQuestionAsset,
        QbQuestionApplyState,
        QbSyncJob,
        QbSyncJobScope,
        QbQuestionImport,
        QbQuestionImportBatch,
        QbQuestionImportIntake,
        QbQuestionReadiness,
        QbQuestionReadinessSweep,
        QbQuestionTaskReview,
    )
    async with engine.begin() as connection:
        if mysql_check:
            await connection.run_sync(
                lambda conn: QbSubject.metadata.drop_all(conn, tables=[m.__table__ for m in models])
            )
        await connection.run_sync(
            lambda conn: QbSubject.metadata.create_all(conn, tables=[m.__table__ for m in models])
        )
    now = datetime.now()
    timestamps = {'create_time': now, 'update_time': now}
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        db.add(
            QbSubject(
                subject_id=1,
                stage_code='junior',
                subject_code='math',
                subject_name='数学',
                source_profile='zujuan_czsx',
                status='0',
                **timestamps,
            )
        )
        db.add(
            QbTextbookVersion(
                version_id=1,
                subject_id=1,
                source_provider='zujuan',
                external_version_id='v1',
                version_name='版本',
                status='0',
                **timestamps,
            )
        )
        for i in (1, 2):
            db.add(
                QbTextbook(
                    textbook_id=i,
                    subject_id=1,
                    version_id=1,
                    source_provider='zujuan',
                    external_textbook_id=f'tb{i}',
                    textbook_name=f'教材{i}',
                    status='0',
                    **timestamps,
                )
            )
            db.add(
                QbCatalogNode(
                    catalog_id=i,
                    textbook_id=i,
                    subject_id=1,
                    source_provider='zujuan',
                    external_node_id=f'c{i}',
                    node_name='原目录',
                    node_type='other',
                    status='1' if i == 1 else '0',
                    sort_order=0,
                    **timestamps,
                )
            )
            db.add(
                QbQuestionApplyState(
                    source_provider='zujuan',
                    external_textbook_id=f'tb{i}',
                    current_task_id=100 + i,
                    current_collector_run_id=200 + i,
                    snapshot_hash='a' * 64,
                    state_token='b' * 64,
                    **timestamps,
                )
            )
        db.add(
            QbQuestion(
                question_id=1,
                subject_id=1,
                source_provider='zujuan',
                external_question_id='q1',
                content_html='<p>旧题干</p>',
                plain_text='旧题干',
                question_type='单选题',
                answer_html='<p>可信答案</p>',
                analysis_html='可信解析',
                answer_status='available',
                status='1',
                **timestamps,
            )
        )
        db.add(
            QbQuestion(
                question_id=2,
                subject_id=1,
                source_provider='manual',
                external_question_id='q1',
                plain_text='老师人工题',
                status='0',
                **timestamps,
            )
        )
        db.add(
            QbQuestion(
                question_id=3,
                subject_id=1,
                source_provider='zujuan',
                external_question_id='missing',
                plain_text='本轮没抓到的题',
                status='0',
                **timestamps,
            )
        )
        db.add(
            QbQuestionCatalog(
                question_id=1,
                catalog_id=2,
                relation_type='query_catalog',
                evidence_type='query_membership',
                sort_order=0,
                **timestamps,
            )
        )
        db.add(
            QbQuestionTag(
                question_id=1,
                tag_type='knowledge',
                tag_name='另一本教材仍使用的标签',
                relation_type='provider_asserted',
                evidence_type='provider_asserted',
                sort_order=0,
                **timestamps,
            )
        )
        await db.commit()
        yield db
    await engine.dispose()


def snapshot(question='q1', catalog='c1', *, answer_status='not_collected', answer=None, asset=False):
    common = {'provider': 'zujuan', 'textbook_external_id': 'tb1'}
    assets = (
        [
            {
                **common,
                'question_external_id': question,
                'asset_key': 'img',
                'asset_type': 'image',
                'source_url': 'https://static.zxxk.com/test.png',
                'content_sha256': 'a' * 64,
                'byte_size': 5,
                'download_status': 'downloaded',
            }
        ]
        if asset
        else []
    )
    raw = {
        'available': True,
        'immutable': True,
        'snapshotComplete': False,
        'run': {
            'id': 27,
            'provider': 'zujuan',
            'status': 'failed',
            'errorCount': 1,
            'finishedAt': '2026-10-01T01:00:00Z',
            'snapshotLockedAt': '2026-10-01T01:00:00Z',
            'snapshotComplete': False,
            'scope': {'textbookExternalId': 'tb1'},
        },
        'counts': {
            'catalogItemCount': 1,
            'questionItemCount': 1,
            'questionCatalogCount': 1,
            'questionTagCount': 0,
            'questionAssetCount': len(assets),
        },
        'catalogs': [{**common, 'catalog_external_id': catalog, 'name': '更新后的目录', 'parent_external_id': None}],
        'questions': [
            {
                **common,
                'question_external_id': question,
                'question_type': '单选题',
                'detail_fetched': 1,
                'content_html': '<p>新题干</p>',
                'answer_status': answer_status,
                'answer_html': answer,
            }
        ],
        'questionCatalogs': [{**common, 'question_external_id': question, 'catalog_external_id': catalog}],
        'tags': [],
        'assets': assets,
    }
    return _normalise_snapshot(raw, 28, 'tb1', sealed_for_import=True)


@pytest.mark.asyncio
@pytest.mark.parametrize('answer_status', ['not_collected', 'public_captured', 'login_required'])
async def test_repeated_partial_merge_protects_disabled_answers_manual_and_other_books(bank_db, answer_status):
    db = bank_db
    value = snapshot(answer_status=answer_status, answer='')
    result = await merge_prepared_incremental_batch(db, [value], local_textbook_id=1, task_id=28)
    assert result['isCurrent'] is False
    assert result['stats']['questions']['updated'] == 1
    rows = (await db.execute(select(QbQuestion).order_by(QbQuestion.question_id))).scalars().all()
    assert len(rows) == 3
    assert rows[0].content_html == '<p>新题干</p>'
    assert rows[0].status == '1'
    assert rows[0].answer_html == '<p>可信答案</p>'
    assert rows[0].analysis_html == '可信解析'
    assert rows[0].answer_status == 'available'
    assert rows[1].plain_text == '老师人工题'
    assert rows[2].plain_text == '本轮没抓到的题' and rows[2].status == '0'
    relations = (await db.execute(select(QbQuestionCatalog))).scalars().all()
    assert {row.catalog_id for row in relations} == {1, 2}
    assert len((await db.execute(select(QbQuestionTag))).scalars().all()) == 1
    assert (await db.get(QbCatalogNode, 1)).status == '1'
    assert (await db.get(QbCatalogNode, 2)).node_name == '原目录'
    assert all(state.current_task_id is None for state in (await db.execute(select(QbQuestionApplyState))).scalars())
    await db.commit()
    repeated = await merge_prepared_incremental_batch(db, [value], local_textbook_id=1, task_id=28)
    assert repeated['stats']['questions']['inserted'] == 0
    assert repeated['stats']['questions']['unchanged'] == 1
    assert repeated['stats']['questionCatalogs']['unchanged'] == 1


@pytest.mark.asyncio
async def test_batch_failure_keeps_previous_commit_and_retry_does_not_duplicate(bank_db):
    db = bank_db
    await merge_prepared_incremental_batch(db, [snapshot('q3')], local_textbook_id=1, task_id=28)

    async def interrupted_checkpoint(_db, _result):
        raise RuntimeError('checkpoint failed')

    with pytest.raises(RuntimeError, match='checkpoint failed'):
        await merge_prepared_incremental_batch(
            db, [snapshot('q4')], local_textbook_id=1, task_id=28, persist_checkpoint=interrupted_checkpoint
        )
    rows = (await db.execute(select(QbQuestion.external_question_id))).scalars().all()
    assert rows.count('q3') == 1
    assert 'q4' not in rows
    await db.commit()
    await merge_prepared_incremental_batch(db, [snapshot('q4')], local_textbook_id=1, task_id=28)
    await merge_prepared_incremental_batch(db, [snapshot('q4')], local_textbook_id=1, task_id=28)
    assert (
        len((await db.execute(select(QbQuestion).where(QbQuestion.external_question_id == 'q4'))).scalars().all()) == 1
    )


@pytest.mark.asyncio
async def test_shared_point_creates_book_membership_without_moving_existing_catalog(bank_db):
    db = bank_db
    value = snapshot('q1', 'c2')
    value['questions'][0]['subquestion_count'] = 2
    value['questions'][0]['content_html'] = '<p>同一大题：(1)计算；(2)证明。</p>'
    await merge_prepared_incremental_batch(db, [value], local_textbook_id=1, task_id=28)
    original = await db.get(QbCatalogNode, 2)
    assert original.textbook_id == 2 and original.node_name == '原目录'
    catalogs = (await db.scalars(select(QbCatalogNode).where(QbCatalogNode.external_node_id == 'c2'))).all()
    assert {c.textbook_id for c in catalogs} == {1, 2}
    questions = (await db.scalars(select(QbQuestion).where(QbQuestion.source_provider == 'zujuan', QbQuestion.external_question_id == 'q1'))).all()
    assert len(questions) == 1 and questions[0].subquestion_count == 2
    links = (await db.scalars(select(QbQuestionCatalog.catalog_id).where(QbQuestionCatalog.question_id == questions[0].question_id))).all()
    assert set(links) == {c.catalog_id for c in catalogs}
    before = questions[0].update_time
    await db.commit()
    value['questions'][0]['last_seen_at'] = datetime(2099, 1, 1)
    value['questions'][0]['raw_data_json'] = {'observation': 'different textbook request'}
    repeated = await merge_prepared_incremental_batch(db, [value], local_textbook_id=1, task_id=29)
    assert repeated['stats']['questions']['unchanged'] == 1
    assert repeated['stats']['questions']['inserted'] == repeated['stats']['questions']['updated'] == 0
    assert repeated['stats']['questionCatalogs']['inserted'] == 0
    question = await db.get(QbQuestion, questions[0].question_id, populate_existing=True)
    assert question.update_time == before and question.subquestion_count == 2


@pytest.mark.asyncio
async def test_catalog_identity_migration_repeats_without_rewriting_existing_rows(bank_db):
    import importlib

    from sqlalchemy import text
    if bank_db.bind.dialect.name != 'mysql':
        pytest.skip('requires isolated MySQL')
    await bank_db.execute(text('ALTER TABLE qb_catalog_node DROP INDEX uk_qb_catalog_provider_external, ADD UNIQUE KEY uk_qb_catalog_provider_external(source_provider,subject_id,external_node_id)'))
    migration = importlib.import_module('plugins.bank.migrations.mysql.025_catalog_book_identity')
    await migration.run(bank_db)
    await migration.run(bank_db)
    await bank_db.commit()
    assert (await bank_db.get(QbCatalogNode, 2)).textbook_id == 2
    await bank_db.rollback()
    await merge_prepared_incremental_batch(bank_db, [snapshot('q3', 'c2')], local_textbook_id=1, task_id=28)
    rows = (await bank_db.scalars(select(QbCatalogNode).where(QbCatalogNode.external_node_id == 'c2'))).all()
    assert {row.textbook_id for row in rows} == {1, 2}


@pytest.mark.asyncio
async def test_missing_assets_fail_before_a_formal_transaction(bank_db, monkeypatch, tmp_path):
    monkeypatch.setenv('BANK_ASSET_ROOT', str(tmp_path))
    value = snapshot(asset=True)
    value['questions'][0]['content_html'] += '<img data-asset-key="img">'
    with pytest.raises(ServiceException, match='素材缺失'):
        await merge_prepared_incremental_batch(bank_db, [value], local_textbook_id=1, task_id=28)
    assert not bank_db.in_transaction()
    assert (await bank_db.get(QbQuestion, 1)).content_html == '<p>旧题干</p>'


@pytest.mark.asyncio
async def test_asset_failures_quarantine_one_question_and_continue(monkeypatch):
    from plugins.bank.service import incremental_merge as module

    async def download(value, *, sealed_for_import=False):
        assert sealed_for_import is True
        if value['questions'][0]['external_id'] == 'q1':
            raise ServiceException(message='素材下载失败')

    monkeypatch.setattr(module, '_download_snapshot_assets', download)
    result = await prepare_incremental_verdicts(
        [{'questionId': key, 'status': 'accepted', 'normalized': snapshot(key), 'reason': None} for key in ('q1', 'q3')]
    )
    assert [item['status'] for item in result] == ['quarantined', 'accepted']
    assert '素材下载失败' in result[0]['reason']
