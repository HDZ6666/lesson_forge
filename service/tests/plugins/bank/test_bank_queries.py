from __future__ import annotations

from pathlib import Path  # noqa: TC003
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.dialects import mysql

from exceptions.exception import ServiceException
from plugins.bank.dao.bank_dao import BankDao
from plugins.bank.dao.sync_task_dao import SyncTaskDao
from plugins.bank.entity.do.bank_do import QbSyncBatch
from plugins.bank.entity.vo.bank_vo import (
    QuestionPageQueryModel,
    SyncTaskPageQueryModel,
    TaskComparisonQueryModel,
)
from plugins.bank.service.bank_service import BankService
from utils.page_util import PageUtil

EXPECTED_FILTER_EXISTS = 4
EXTERNAL_ID_LIMIT = 64
QUESTION_TYPE_LIMIT = 80
KEYWORD_LIMIT = 120


class _Result:
    def __init__(self, rows: list[tuple] = ()) -> None:
        self._rows = rows

    def all(self) -> list[tuple]:
        return self._rows


class _Db:
    def __init__(self, rows: list[tuple] = ()) -> None:
        self.execute = AsyncMock(return_value=_Result(rows))
        self.commit = AsyncMock()
        self.rollback = AsyncMock()


def _mysql_sql(statement: object) -> str:
    return str(statement.compile(dialect=mysql.dialect(), compile_kwargs={'literal_binds': True})).upper()


@pytest.mark.asyncio
async def test_question_filters_use_independent_exists_and_same_dimension_in(monkeypatch: pytest.MonkeyPatch) -> None:
    db = _Db([(10,), (11,)])
    captured: list[object] = []

    async def paginate(_db: object, query: object, *_args: object, **_kwargs: object) -> SimpleNamespace:
        captured.append(query)
        return SimpleNamespace(rows=[], page_num=1, page_size=10, total=0, has_next=False)

    monkeypatch.setattr(PageUtil, 'paginate', paginate)
    query = QuestionPageQueryModel(
        catalogId=10,
        scene=['预习', '复习'],
        category=['运算化简', '方程'],
        examMethod=['直接法'],
    )
    await BankDao.list_questions(db, query)

    sql = _mysql_sql(captured[0])
    assert sql.count('EXISTS') == EXPECTED_FILTER_EXISTS
    assert "QB_QUESTION_TAG.TAG_NAME IN ('预习', '复习')" in sql
    assert "QB_QUESTION_TAG.TAG_NAME IN ('运算化简', '方程')" in sql
    assert "QB_QUESTION_TAG.TAG_NAME IN ('直接法')" in sql
    assert 'QB_QUESTION_CATALOG.CATALOG_ID IN (10, 11)' in sql


def test_question_sort_is_a_pydantic_whitelist() -> None:
    with pytest.raises(ValidationError):
        QuestionPageQueryModel(sort='question_id desc; drop table qb_question')

    assert QuestionPageQueryModel(sort='year').sort == 'year'


def test_task_comparison_filters_match_collector_limits() -> None:
    query = TaskComparisonQueryModel(
        externalTextbookId='t' * EXTERNAL_ID_LIMIT,
        catalogId='c' * EXTERNAL_ID_LIMIT,
        questionType='题' * QUESTION_TYPE_LIMIT,
        keyword='词' * KEYWORD_LIMIT,
    )
    assert len(query.external_textbook_id) == EXTERNAL_ID_LIMIT
    assert len(query.catalog_id) == EXTERNAL_ID_LIMIT
    assert len(query.question_type) == QUESTION_TYPE_LIMIT
    assert len(query.keyword) == KEYWORD_LIMIT

    for field, value in (
        ('externalTextbookId', 't' * (EXTERNAL_ID_LIMIT + 1)),
        ('catalogId', 'c' * (EXTERNAL_ID_LIMIT + 1)),
        ('questionType', '题' * (QUESTION_TYPE_LIMIT + 1)),
        ('keyword', '词' * (KEYWORD_LIMIT + 1)),
    ):
        with pytest.raises(ValidationError):
            TaskComparisonQueryModel(**{field: value})


@pytest.mark.asyncio
async def test_sync_task_date_only_end_covers_the_selected_day(monkeypatch: pytest.MonkeyPatch) -> None:
    db = _Db()
    captured: list[object] = []

    async def paginate(_db: object, query: object, *_args: object, **_kwargs: object) -> SimpleNamespace:
        captured.append(query)
        return SimpleNamespace(rows=[], page_num=1, page_size=10, total=0, has_next=False)

    monkeypatch.setattr(PageUtil, 'paginate', paginate)
    await SyncTaskDao.list_page(
        db,
        'question',
        SyncTaskPageQueryModel(createTimeEnd='2026-08-28'),
    )
    date_only_sql = _mysql_sql(captured[-1])
    assert 'CREATE_TIME <' in date_only_sql
    assert '2026-08-29' in date_only_sql

    await SyncTaskDao.list_page(
        db,
        'question',
        SyncTaskPageQueryModel(createTimeEnd='2026-08-28T23:59:59'),
    )
    full_timestamp_sql = _mysql_sql(captured[-1])
    assert 'CREATE_TIME <=' in full_timestamp_sql
    assert '2026-08-28T23:59:59' in full_timestamp_sql


def test_catalog_descendants_compile_to_scoped_recursive_cte() -> None:
    sql = _mysql_sql(BankDao.catalog_descendant_query(10, 7))
    assert sql.startswith('WITH RECURSIVE')
    assert 'BANK_CATALOG_DESCENDANTS' in sql
    assert 'QB_CATALOG_NODE.TEXTBOOK_ID = 7' in sql
    assert 'BANK_CATALOG_DESCENDANTS.TEXTBOOK_ID' in sql


@pytest.mark.asyncio
async def test_catalog_descendants_include_root_and_children_and_empty_result() -> None:
    db = _Db([(10,), (11,), (12,)])
    assert await BankDao._catalog_descendant_ids(db, 10, 7) == [10, 11, 12]

    db.execute.return_value = _Result([])
    assert await BankDao._catalog_descendant_ids(db, 999, 7) == []


@pytest.mark.asyncio
async def test_condition_updates_have_expected_status_and_rollback_on_commit_error() -> None:
    db = _Db()
    db.execute.return_value = SimpleNamespace(rowcount=1)
    assert await BankDao.approve_batch(db, 5, 'admin') == 1
    approve_sql = _mysql_sql(db.execute.await_args.args[0])
    assert "STATUS = 'APPROVAL_PENDING'" in approve_sql
    assert db.commit.await_count == 1

    db.commit.side_effect = RuntimeError('db unavailable')
    with pytest.raises(RuntimeError):
        await BankDao.request_publish(db, 5)
    assert db.rollback.await_count == 1


@pytest.mark.asyncio
async def test_rollback_rejects_non_published_target(monkeypatch: pytest.MonkeyPatch) -> None:
    target = QbSyncBatch(batch_id=5, status='approved')
    monkeypatch.setattr(BankDao, 'get_batch', AsyncMock(return_value=target))
    with pytest.raises(ServiceException) as error:
        await BankService.rollback_batch(_Db(), 5)
    assert '已发布或已归档' in (error.value.message or '')


def test_asset_path_rejects_traversal_and_symlink_escape(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / 'assets'
    root.mkdir()
    (root / 'ok.bin').write_bytes(b'ok')
    outside = tmp_path / 'outside.bin'
    outside.write_bytes(b'outside')
    (root / 'link.bin').symlink_to(outside)
    monkeypatch.setenv('BANK_ASSET_ROOT', str(root))

    assert BankService.resolve_asset_path('ok.bin') == (root / 'ok.bin').resolve()
    for path in ('../outside.bin', 'link.bin'):
        with pytest.raises(HTTPException):
            BankService.resolve_asset_path(path)
