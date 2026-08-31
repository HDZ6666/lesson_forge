from __future__ import annotations

from types import SimpleNamespace
from typing import get_args
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.dialects import mysql

from common.vo import PageModel
from exceptions.exception import ServiceException
from plugins.bank.controller.bank_controller import bank_controller
from plugins.bank.dao.bank_dao import BankDao
from plugins.bank.entity.vo.bank_vo import (
    BatchStatus,
    CatalogPageQueryModel,
    QuestionWriteModel,
    TextbookQueryModel,
    TextbookVersionQueryModel,
)
from plugins.bank.publisher.worker import DATASET_TABLES, MySQLPublisher
from plugins.bank.service.bank_service import BankService
from utils.page_util import PageUtil

CATALOG_QUESTION_COUNT = 4
IDENTITY_TABLE_COUNT = 4
RELATION_TABLE_COUNT = 3


class _Db:
    def __init__(self) -> None:
        self.commit = AsyncMock()
        self.rollback = AsyncMock()


def _catalog(catalog_id: int, textbook_id: int, *, status: str = '0') -> SimpleNamespace:
    return SimpleNamespace(catalog_id=catalog_id, textbook_id=textbook_id, parent_id=None, status=status)


@pytest.mark.asyncio
async def test_manual_question_requires_same_textbook_catalogs_and_writes_relations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _Db()
    added: list[object] = []
    catalog_replace = AsyncMock()
    tag_replace = AsyncMock()

    async def add_entity(_db: object, entity: object) -> object:
        entity.question_id = 41
        added.append(entity)
        return entity

    monkeypatch.setattr(BankDao, 'get_catalogs', AsyncMock(return_value=[_catalog(7, 3), _catalog(8, 3)]))
    monkeypatch.setattr(BankDao, 'add_entity', add_entity)
    monkeypatch.setattr(BankDao, 'replace_question_catalogs', catalog_replace)
    monkeypatch.setattr(BankDao, 'replace_question_tags', tag_replace)
    monkeypatch.setattr(BankService, 'question_detail', AsyncMock(return_value={'questionId': 41}))

    payload = QuestionWriteModel(
        contentHtml='<p>人工题</p>',
        catalogIds=[7, 8],
        tags=[{'tagType': 'scene', 'tagName': '预习'}],
    )
    result = await BankService.add_question(db, payload)

    assert result == {'questionId': 41}
    assert len(added) == 1
    catalog_replace.assert_awaited_once_with(db, 41, [7, 8])
    tag_replace.assert_awaited_once_with(db, 41, [{'tag_type': 'scene', 'tag_name': '预习'}])
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_manual_question_rejects_cross_textbook_or_empty_catalogs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _Db()
    monkeypatch.setattr(BankDao, 'get_catalogs', AsyncMock(return_value=[_catalog(7, 3), _catalog(9, 4)]))
    with pytest.raises(ServiceException) as error:
        await BankService.add_question(db, QuestionWriteModel(contentHtml='题', catalogIds=[7, 9]))
    assert '同一教材' in (error.value.message or '')

    with pytest.raises(ServiceException) as error:
        await BankService.add_question(db, QuestionWriteModel(contentHtml='题', catalogIds=[]))
    assert '至少需要一个目录' in (error.value.message or '')


@pytest.mark.asyncio
async def test_manual_question_edit_replaces_only_explicit_relations(monkeypatch: pytest.MonkeyPatch) -> None:
    db = _Db()
    row = SimpleNamespace(
        question_id=41,
        source_provider='manual',
        content_html='<p>old</p>',
        plain_text=None,
        create_time=None,
        external_question_id=None,
        last_sync_batch_id=None,
        last_seen_at=None,
    )
    update = AsyncMock()
    catalog_replace = AsyncMock()
    tag_replace = AsyncMock()
    monkeypatch.setattr(BankDao, 'get_question', AsyncMock(return_value=row))
    monkeypatch.setattr(BankDao, 'update_entity', update)
    monkeypatch.setattr(BankDao, 'replace_question_catalogs', catalog_replace)
    monkeypatch.setattr(BankDao, 'replace_question_tags', tag_replace)
    monkeypatch.setattr(BankService, 'question_detail', AsyncMock(return_value={}))

    # An omitted relation field is preserved.
    await BankService.update_question(db, QuestionWriteModel(questionId=41, contentHtml='<p>new</p>'))
    catalog_replace.assert_not_awaited()
    tag_replace.assert_not_awaited()

    # A manual question must remain attached to at least one catalog.
    with pytest.raises(ServiceException) as error:
        await BankService.update_question(db, QuestionWriteModel(questionId=41, catalogIds=[], tags=[]))
    assert '至少需要一个目录' in (error.value.message or '')
    catalog_replace.assert_not_awaited()
    tag_replace.assert_not_awaited()


@pytest.mark.asyncio
async def test_synchronized_question_only_accepts_status(monkeypatch: pytest.MonkeyPatch) -> None:
    db = _Db()
    row = SimpleNamespace(
        question_id=9,
        source_provider='zujuan',
        content_html='<p>source</p>',
        plain_text='source',
        create_time=None,
        external_question_id='q9',
        last_sync_batch_id=2,
        last_seen_at=None,
    )
    monkeypatch.setattr(BankDao, 'get_question', AsyncMock(return_value=row))
    update = AsyncMock()
    monkeypatch.setattr(BankDao, 'update_entity', update)
    monkeypatch.setattr(BankService, 'question_detail', AsyncMock(return_value={}))

    await BankService.update_question(db, QuestionWriteModel(questionId=9, status='1'))
    assert update.await_args.args[2]['status'] == '1'
    with pytest.raises(ServiceException) as error:
        await BankService.update_question(db, QuestionWriteModel(questionId=9, status='0', catalogIds=[]))
    assert '只允许修改启停状态' in (error.value.message or '')


@pytest.mark.asyncio
async def test_question_detail_returns_catalog_ids_and_sync_tags(monkeypatch: pytest.MonkeyPatch) -> None:
    db = _Db()
    row = SimpleNamespace(question_id=9, source_provider='zujuan', content_html='<p>source</p>')
    relation = SimpleNamespace(catalog_id=7, relation_type='query_catalog')
    tag = SimpleNamespace(
        question_id=9,
        tag_type='scene',
        tag_name='预习',
        evidence_type='query_membership',
    )
    monkeypatch.setattr(BankDao, 'get_question_detail', AsyncMock(return_value=row))
    monkeypatch.setattr(BankDao, 'get_question_catalogs', AsyncMock(return_value=[relation]))
    monkeypatch.setattr(BankDao, 'get_question_tags', AsyncMock(return_value=[tag]))

    result = await BankService.question_detail(db, 9)
    assert result['catalogIds'] == [7]
    assert result['tags'][0]['evidenceType'] == 'query_membership'


@pytest.mark.parametrize(
    'html',
    [
        '<script>alert(1)</script>',
        '<iframe src="/x"></iframe>',
        '<object data="/x"></object>',
        '<embed src="/x">',
        '<style>body{display:none}</style>',
        '<form action="/x"></form>',
        '<img onerror="alert(1)">',
        '<a href="javascript:alert(1)">x</a>',
        '<a href="vbscript:msgbox(1)">x</a>',
        '<img src="data:text/html,evil">',
        '<div srcdoc="<script>alert(1)</script>">x</div>',
    ],
)
def test_question_html_rejects_all_active_markup(html: str) -> None:
    with pytest.raises(ServiceException):
        BankService._question_values(QuestionWriteModel(contentHtml=html))


@pytest.mark.asyncio
async def test_batch_delete_preflight_checks_dependencies(monkeypatch: pytest.MonkeyPatch) -> None:
    db = _Db()
    row = SimpleNamespace(source_provider='manual')
    monkeypatch.setattr(BankDao, 'get_version', AsyncMock(return_value=row))
    monkeypatch.setattr(BankDao, 'relation_counts', AsyncMock(return_value={12: 1}))
    delete = AsyncMock()
    monkeypatch.setattr(BankDao, 'delete_versions', delete)

    with pytest.raises(ServiceException) as error:
        await BankService.delete_versions(db, [12])
    assert '存在教材' in (error.value.message or '')
    delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_catalog_cycle_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    db = _Db()
    monkeypatch.setattr(BankDao, 'get_catalog', AsyncMock(return_value=_catalog(2, 3)))
    monkeypatch.setattr(BankDao, 'catalog_parent_chain', AsyncMock(return_value=[1, 2]))
    with pytest.raises(ServiceException) as error:
        await BankService._validate_catalog_parent(db, 3, 2, 1)
    assert '后代' in (error.value.message or '')


@pytest.mark.asyncio
async def test_catalog_list_injects_direct_and_descendant_counts(monkeypatch: pytest.MonkeyPatch) -> None:
    db = _Db()
    page = PageModel(
        rows=[
            {'catalogId': 1, 'textbookId': 3, 'nodeName': '章'},
            {'catalogId': 2, 'textbookId': 3, 'parentId': 1, 'nodeName': '节'},
        ],
        pageNum=1,
        pageSize=10,
        total=2,
        hasNext=False,
    )
    monkeypatch.setattr(BankDao, 'list_catalogs', AsyncMock(return_value=page))
    nodes = [_catalog(1, 3), SimpleNamespace(catalog_id=2, textbook_id=3, parent_id=1)]
    monkeypatch.setattr(BankDao, 'get_catalog_nodes', AsyncMock(return_value=nodes))
    monkeypatch.setattr(BankDao, 'catalog_question_counts', AsyncMock(return_value={2: 4}))

    result = await BankService.list_catalogs(db, CatalogPageQueryModel(textbookId=3))
    assert result.rows[0]['descendantQuestionCount'] == CATALOG_QUESTION_COUNT
    assert result.rows[1]['directQuestionCount'] == CATALOG_QUESTION_COUNT


@pytest.mark.asyncio
async def test_include_disabled_is_explicit_and_textbook_stats_count_active_questions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _Db()
    captured: list[object] = []

    async def paginate(_db: object, query: object, *_args: object, **_kwargs: object) -> SimpleNamespace:
        captured.append(query)
        return SimpleNamespace(rows=[])

    monkeypatch.setattr(PageUtil, 'paginate', paginate)
    await BankDao.list_versions(db, TextbookVersionQueryModel(includeDisabled=True))
    first_sql = str(captured[0].compile(dialect=mysql.dialect(), compile_kwargs={'literal_binds': True})).upper()
    assert 'WHERE QB_TEXTBOOK_VERSION.STATUS' not in first_sql

    await BankDao.list_versions(db, TextbookVersionQueryModel(status='1'))
    second_sql = str(captured[1].compile(dialect=mysql.dialect(), compile_kwargs={'literal_binds': True})).upper()
    assert "QB_TEXTBOOK_VERSION.STATUS = '1'" in second_sql

    result = SimpleNamespace(all=list)
    db.execute = AsyncMock(return_value=result)
    await BankDao.textbook_stats(db, [3])
    sql = str(db.execute.await_args.args[0].compile(dialect=mysql.dialect())).upper()
    assert 'COUNT(DISTINCT(QB_QUESTION.QUESTION_ID))' in sql
    assert 'COUNT(DISTINCT(QB_QUESTION_CATALOG.QUESTION_ID))' not in sql


@pytest.mark.asyncio
async def test_textbook_filters_grade_volume_and_management_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _Db()
    captured: list[object] = []

    async def paginate(_db: object, query: object, *_args: object, **_kwargs: object) -> SimpleNamespace:
        captured.append(query)
        return SimpleNamespace(rows=[])

    monkeypatch.setattr(PageUtil, 'paginate', paginate)
    await BankDao.list_textbooks(
        db,
        TextbookQueryModel(grade='九年级', volume='上册', status='1', includeDisabled=True),
    )
    sql = str(captured[0].compile(dialect=mysql.dialect(), compile_kwargs={'literal_binds': True})).upper()
    assert "QB_TEXTBOOK.GRADE = '九年级'" in sql
    assert "QB_TEXTBOOK.VOLUME = '上册'" in sql
    assert "QB_TEXTBOOK.STATUS = '1'" in sql
    assert BankDao._include_disabled(TextbookQueryModel(status='1', includeDisabled=True)) is True


@pytest.mark.asyncio
async def test_catalog_tree_defaults_to_active_and_management_can_include_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _Db()
    nodes = [_catalog(1, 3)]
    calls: list[object] = []

    async def get_nodes(_db: object, _textbook_id: int, status: str | None = '0') -> list[object]:
        calls.append(status)
        return nodes

    monkeypatch.setattr(BankDao, 'get_catalog_nodes', get_nodes)
    monkeypatch.setattr(BankDao, 'catalog_question_counts', AsyncMock(return_value={}))
    await BankService.catalog_tree(db, 3)
    await BankService.catalog_tree(db, 3, include_disabled=True)
    assert calls == ['0', None]


def test_management_routes_and_question_contract_are_exposed() -> None:
    paths = {route.path for route in bank_controller.routes}
    assert '/bank/version/list' in paths
    assert '/bank/textbook/list' in paths
    assert '/bank/catalog/list' in paths
    assert '/bank/question/list' in paths
    assert 'catalogIds' in QuestionWriteModel.model_json_schema()['properties']
    assert 'tags' in QuestionWriteModel.model_json_schema()['properties']
    assert get_args(BatchStatus).count('approval_pending') == 1


def test_publisher_deactivates_only_current_provider_and_copies_other_relations() -> None:
    class CapturePublisher(MySQLPublisher):
        def __init__(self) -> None:
            super().__init__(object())
            self.sql: list[tuple[str, object]] = []

        def _execute(self, sql: str, _args: object = ()) -> None:
            self.sql.append((sql, _args))

    publisher = CapturePublisher()
    names = {table: f'{table}_next_9' for table in DATASET_TABLES}
    publisher._deactivate_provider_rows(names, 'zujuan')
    publisher._copy_non_current_provider_relations(names, 'zujuan')

    deactivation = [(sql, args) for sql, args in publisher.sql if sql.startswith('UPDATE')]
    assert len(deactivation) == IDENTITY_TABLE_COUNT
    assert all("SET status='1' WHERE source_provider=%s" in sql for sql, _ in deactivation)
    assert all(args == ('zujuan',) for _, args in deactivation)
    relation_copies = [(sql, args) for sql, args in publisher.sql if sql.startswith('INSERT')]
    assert len(relation_copies) == RELATION_TABLE_COUNT
    assert all('WHERE q.source_provider<>%s' in sql for sql, _ in relation_copies)
    assert all(args == ('zujuan',) for _, args in relation_copies)
