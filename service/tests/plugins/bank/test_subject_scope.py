"""Subject boundaries exercised through the real ORM and existing bank services."""

from datetime import datetime

import pytest
import pytest_asyncio
from pydantic import ValidationError
from sqlalchemy import BigInteger, select
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles

from exceptions.exception import ServiceException
from plugins.bank.dao.bank_dao import BankDao
from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbQuestionAsset,
    QbQuestionCatalog,
    QbQuestionImport,
    QbQuestionReadiness,
    QbQuestionTag,
    QbSubject,
    QbSyncBookState,
    QbSyncIssue,
    QbSyncJob,
    QbSyncJobScope,
    QbSyncPlan,
    QbTextbook,
    QbTextbookVersion,
)
from plugins.bank.entity.vo.bank_vo import (
    CatalogNodeModel,
    QuestionPageQueryModel,
    QuestionTaskCreateModel,
    QuestionWriteModel,
    SubjectModel,
    TextbookModel,
    TextbookVersionModel,
)
from plugins.bank.service.bank_service import BankService
from plugins.bank.service.subject_service import SubjectService
from plugins.bank.service.task_service import SyncTaskService


@compiles(BigInteger, 'sqlite')
def bigint(_type, _compiler, **_kwargs):
    return 'INTEGER'


@compiles(LONGTEXT, 'sqlite')
def longtext(_type, _compiler, **_kwargs):
    return 'TEXT'


@pytest_asyncio.fixture
async def db():
    engine = create_async_engine('sqlite+aiosqlite:///:memory:')
    tables = [
        model.__table__
        for model in (
            QbSyncJob,
            QbSyncJobScope,
            QbSyncIssue,
            QbSyncBookState,
            QbSyncPlan,
            QbSubject,
            QbTextbookVersion,
            QbTextbook,
            QbCatalogNode,
            QbQuestion,
            QbQuestionCatalog,
            QbQuestionTag,
            QbQuestionAsset,
            QbQuestionImport,
            QbQuestionReadiness,
        )
    ]
    async with engine.begin() as connection:
        await connection.run_sync(lambda conn: QbSubject.metadata.create_all(conn, tables=tables))
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        await SubjectService.save(
            session,
            SubjectModel(
                stageCode='junior',
                subjectCode='math',
                subjectName='数学',
                sourceProfile='zujuan_czsx',
            ),
        )
        await SubjectService.save(session, SubjectModel(stageCode='junior', subjectCode='chinese', subjectName='语文'))
        yield session
    await engine.dispose()


@pytest.mark.asyncio
async def test_subject_identity_is_immutable_and_adapter_is_fail_closed(db):
    with pytest.raises(ServiceException, match='尚未验证'):
        await SubjectService.require(db, 2, sync=True)
    with pytest.raises(ServiceException, match='一致的已验证'):
        await SubjectService.save(
            db,
            SubjectModel(
                stageCode='senior',
                subjectCode='math',
                subjectName='数学',
                sourceProfile='zujuan_czsx',
            ),
        )
    with pytest.raises(ServiceException, match='不能修改'):
        await SubjectService.save(
            db,
            SubjectModel(
                subjectId=1,
                stageCode='junior',
                subjectCode='other',
                subjectName='其他',
            ),
            editing=True,
        )
    with pytest.raises(ServiceException, match='已经存在'):
        await SubjectService.save(db, SubjectModel(stageCode='junior', subjectCode='math', subjectName='重复'))
    subjects = await SubjectService.list(db)
    assert len(subjects) == 2
    assert subjects[0]['syncSupported'] is True
    assert subjects[1]['syncSupported'] is False


@pytest.mark.asyncio
async def test_manual_tree_inherits_subject_and_rejects_cross_subject_moves(db):
    math = await BankService.add_version(db, TextbookVersionModel(subjectId=1, versionName='数学版本'))
    chinese = await BankService.add_version(db, TextbookVersionModel(subjectId=2, versionName='语文版本'))
    book = await BankService.add_textbook(db, TextbookModel(versionId=chinese['versionId'], textbookName='七上'))
    assert book['subjectId'] == 2
    catalog = await BankService.add_catalog(
        db, CatalogNodeModel(textbookId=book['textbookId'], nodeName='第一课', nodeType='chapter')
    )
    question = await BankService.add_question(
        db, QuestionWriteModel(catalogIds=[catalog['catalogId']], plainText='这是什么？')
    )
    assert catalog['subjectId'] == question['subjectId'] == 2
    with pytest.raises(ServiceException, match='其他学科'):
        await BankService.update_textbook(db, TextbookModel(textbookId=book['textbookId'], versionId=math['versionId']))
    with pytest.raises(ServiceException, match='学科归属'):
        await BankService.update_version(db, TextbookVersionModel(versionId=chinese['versionId'], subjectId=1))
    persisted = await db.get(QbTextbook, book['textbookId'])
    assert persisted.version_id == chinese['versionId']


@pytest.mark.asyncio
async def test_equal_source_ids_in_two_subjects_do_not_collide_or_leak(db):
    now = datetime.now()
    for subject_id in (1, 2):
        db.add(
            QbQuestion(
                subject_id=subject_id,
                source_provider='zujuan',
                external_question_id='same-id',
                plain_text=f'学科{subject_id}',
                create_time=now,
                update_time=now,
            )
        )
    await db.commit()
    rows = (await db.execute(select(QbQuestion).order_by(QbQuestion.subject_id))).scalars().all()
    assert rows[0].question_id != rows[1].question_id
    page = await BankDao.list_questions(db, QuestionPageQueryModel(subjectId=2))
    assert page.total == 1
    assert page.rows[0]['subjectId'] == 2


@pytest.mark.asyncio
async def test_disabled_subject_blocks_new_sync_before_collector_access(db):
    row = await db.get(QbSubject, 1)
    row.status = '1'
    now = datetime.now()
    db.add(
        QbTextbookVersion(
            subject_id=1,
            source_provider='zujuan',
            external_version_id='v1',
            version_name='版本',
            create_time=now,
            update_time=now,
        )
    )
    await db.commit()
    with pytest.raises(ServiceException, match='停用'):
        await SyncTaskService.create_question(db, {'versionId': 1, 'textbookId': 1})


def test_new_task_contract_is_single_book_but_accepts_old_single_payload():
    assert QuestionTaskCreateModel(versionId=1, textbookId=3).textbook_ids == [3]
    assert QuestionTaskCreateModel(versionId=1, textbookIds=[3]).textbook_ids == [3]
    for payload in (
        {'textbookIds': [3, 4]},
        {'textbookIds': []},
        {'textbookId': 3, 'textbookIds': [3]},
        {'textbookId': 3, 'collectorRunId': 9},
    ):
        with pytest.raises(ValidationError):
            QuestionTaskCreateModel(versionId=1, **payload)
