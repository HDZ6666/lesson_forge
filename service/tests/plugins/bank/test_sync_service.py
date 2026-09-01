from __future__ import annotations

import json
from datetime import datetime

import pytest
from sqlalchemy.exc import SQLAlchemyError

from exceptions.exception import ServiceException
from plugins.bank.dao.sync_dao import SyncReviewDao
from plugins.bank.entity.vo.bank_vo import SyncCompareQueryModel, SyncReviewRequestModel
from plugins.bank.service.sync_service import (
    SyncService,
    _canonical_hash,
    _catalog_candidate,
    _formal_question,
    _question_candidate,
    _semantic,
)

SHA256_LENGTH = 64
BATCH_ITEM_COUNT = 2


class FakeDb:
    def __init__(self) -> None:
        self.commits = 0
        self.rollbacks = 0

    async def commit(self) -> None:
        self.commits += 1

    async def rollback(self) -> None:
        self.rollbacks += 1

    async def flush(self) -> None:
        return None

    def add(self, _row: object) -> None:
        return None


@pytest.mark.asyncio
async def test_remote_collector_candidates_do_not_require_shared_sqlite(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeCollectorClient:
        def candidates(self, entity_type: str, **kwargs: object) -> dict[str, object]:
            assert entity_type == 'version'
            assert kwargs == {
                'source_provider': 'zujuan',
                'metadata_run_id': None,
                'textbook_external_id': None,
            }
            return {
                'available': True,
                'message': 'collector API 可用',
                'rows': [
                    {
                        'provider': 'zujuan',
                        'external_version_id': 'v-remote',
                        'version_name': '远程版本',
                        'status': '0',
                    }
                ],
            }

    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.internal:9110')
    monkeypatch.setattr('plugins.bank.service.sync_service.CollectorClient', FakeCollectorClient)

    available, message, candidates = await SyncService._read_candidates(
        'version',
        source_provider='zujuan',
    )

    assert available is True
    assert message == 'collector API 可用'
    assert [candidate['externalId'] for candidate in candidates] == ['v-remote']


@pytest.mark.asyncio
async def test_version_mapping_preserves_year_filter_and_staged_hash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Client:
        def candidates(self, entity_type: str, **kwargs: object) -> dict[str, object]:
            assert entity_type == 'version'
            assert kwargs == {
                'source_provider': None,
                'metadata_run_id': None,
                'textbook_external_id': None,
            }
            return {
                'available': True,
                'message': 'collector API 可用',
                'rows': [
                    {
                        'provider': 'zujuan',
                        'external_version_id': 'v-2012',
                        'version_name': '北师大版（2012）',
                        'source_url': 'https://zujuan.xkw.com/v-2012',
                        'sort_order': 1,
                        'status': '0',
                    },
                    {
                        'provider': 'zujuan',
                        'external_version_id': 'v-other',
                        'version_name': '人教版',
                        'sort_order': 2,
                        'status': '0',
                    },
                ],
            }

    async def no_current(*_args: object, **_kwargs: object) -> dict:
        return {}

    async def no_reviews(*_args: object, **_kwargs: object) -> dict:
        return {}

    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.internal:9110')
    monkeypatch.setattr('plugins.bank.service.sync_service.CollectorClient', Client)
    monkeypatch.setattr(SyncService, '_load_current', classmethod(no_current))
    monkeypatch.setattr(SyncService, '_load_reviews', classmethod(no_reviews))

    result = await SyncService.compare(FakeDb(), 'version', SyncCompareQueryModel(keyword='2012'))

    assert result['sourceAvailable'] is True
    assert result['page']['total'] == 1
    assert result['rows'][0]['candidate']['versionName'] == '北师大版（2012）'
    assert len(result['rows'][0]['stagedHash']) == SHA256_LENGTH


@pytest.mark.asyncio
async def test_review_rejects_stale_hash_before_writing_with_http_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Client:
        def candidates(self, entity_type: str, **_kwargs: object) -> dict[str, object]:
            assert entity_type == 'version'
            return {
                'available': True,
                'rows': [
                    {
                        'provider': 'zujuan',
                        'external_version_id': 'v1',
                        'version_name': '版本A',
                        'status': '0',
                    }
                ],
            }

    async def no_current(*_args: object, **_kwargs: object) -> dict:
        return {}

    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.internal:9110')
    monkeypatch.setattr('plugins.bank.service.sync_service.CollectorClient', Client)
    monkeypatch.setattr(SyncService, '_load_current', classmethod(no_current))
    db = FakeDb()

    with pytest.raises(ServiceException, match='已变化'):
        await SyncService.review(
            db,
            'version',
            SyncReviewRequestModel(externalId='v1', stagedHash='0' * SHA256_LENGTH, action='approve'),
            'tester',
        )
    assert db.commits == 0


def test_question_staging_projection_drops_html_solution_and_raw_json() -> None:
    row = {
        'provider': 'zujuan',
        'external_id': 'q1',
        'source_title': '试卷',
        'source_short': '来源',
        'source_url': 'https://q',
        'content_hash': 'h',
        'plain_text': '题干',
        'content_html': '<p>long</p>',
        'solution_html': '<p>answer</p>',
        'raw_json': '{"secret":1}',
    }

    candidate = _question_candidate(row)

    assert candidate is not None
    assert 'contentHtml' not in candidate
    assert 'solutionHtml' not in candidate
    assert 'rawJson' not in candidate
    assert 'content_html' not in candidate
    assert 'solution_html' not in candidate
    assert 'raw_json' not in candidate


@pytest.mark.asyncio
async def test_collector_rows_are_stably_ordered_by_provider_and_external_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Client:
        def candidates(self, _entity_type: str, **_kwargs: object) -> dict[str, object]:
            return {
                'available': True,
                'rows': [
                    {'provider': 'z-provider', 'external_version_id': 'v2', 'version_name': 'Z'},
                    {'provider': 'a-provider', 'external_version_id': 'v9', 'version_name': 'A9'},
                    {'provider': 'a-provider', 'external_version_id': 'v1', 'version_name': 'A1'},
                ],
            }

    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.internal:9110')
    monkeypatch.setattr('plugins.bank.service.sync_service.CollectorClient', Client)

    available, _, candidates = await SyncService._read_candidates('version')

    assert available is True
    assert [(row['sourceProvider'], row['externalId']) for row in candidates] == [
        ('a-provider', 'v1'),
        ('a-provider', 'v9'),
        ('z-provider', 'v2'),
    ]


@pytest.mark.asyncio
async def test_empty_provider_is_skipped_and_reported_with_http_reader(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Client:
        def candidates(self, _entity_type: str, **_kwargs: object) -> dict[str, object]:
            return {
                'available': True,
                'rows': [
                    {'provider': '', 'external_version_id': 'v0', 'version_name': '无来源'},
                    {'provider': 'zujuan', 'external_version_id': 'v1', 'version_name': '有效'},
                ],
            }

    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.internal:9110')
    monkeypatch.setattr('plugins.bank.service.sync_service.CollectorClient', Client)

    available, message, candidates = await SyncService._read_candidates('version')

    assert available is True
    assert [candidate['externalId'] for candidate in candidates] == ['v1']
    assert '跳过 1 条' in message


def test_catalog_without_status_defaults_to_enabled() -> None:
    candidate = _catalog_candidate(
        {
            'provider': 'zujuan',
            'external_id': 'n1',
            'textbook_external_id': 'tb1',
            'node_level': 1,
            'node_type': 'chapter',
            'name': '第一章',
        }
    )
    assert candidate is not None
    assert candidate['status'] == '0'
    fallback = _catalog_candidate({'provider': 'zujuan', 'external_id': 'n2'})
    assert fallback is not None
    assert fallback['nodeType'] == 'other'


@pytest.mark.asyncio
async def test_scoped_question_read_requires_an_authoritative_catalog_relation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Client:
        def candidates(self, entity_type: str, **kwargs: object) -> dict[str, object]:
            assert entity_type == 'question'
            assert kwargs['textbook_external_id'] == 'tb1'
            return {
                'available': True,
                'rows': [
                    {
                        'provider': 'zujuan',
                        'external_id': 'q2',
                        'chapter_id': 'c2',
                        'plain_text': '错误教材的题目',
                        'textbookScopeMatched': False,
                    },
                    {
                        'provider': 'zujuan',
                        'external_id': 'q1',
                        'chapter_id': 'c1',
                        'plain_text': '教材一题目',
                        'textbookScopeMatched': True,
                    },
                ],
            }

    async def no_current(*_args: object, **_kwargs: object) -> dict:
        return {}

    async def no_reviews(*_args: object, **_kwargs: object) -> dict:
        return {}

    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.internal:9110')
    monkeypatch.setattr('plugins.bank.service.sync_service.CollectorClient', Client)
    monkeypatch.setattr(SyncService, '_load_current', classmethod(no_current))
    monkeypatch.setattr(SyncService, '_load_reviews', classmethod(no_reviews))

    result = await SyncService.compare(
        FakeDb(),
        'question',
        SyncCompareQueryModel(textbookExternalId='tb1'),
    )

    assert [row['externalId'] for row in result['rows']] == ['q1']


@pytest.mark.asyncio
async def test_content_compare_requires_textbook_scope(monkeypatch: pytest.MonkeyPatch) -> None:
    async def should_not_read(*_args: object, **_kwargs: object) -> tuple[bool, str, list[dict]]:
        raise AssertionError('content comparison must be scoped before reading candidates')

    monkeypatch.setattr(SyncService, '_read_candidates', should_not_read)
    for entity_type in ('catalog', 'question'):
        with pytest.raises(ServiceException) as error:
            await SyncService.compare(FakeDb(), entity_type, SyncCompareQueryModel())
        assert '教材范围' in (error.value.message or '')


@pytest.mark.asyncio
async def test_metadata_snapshot_orders_by_source_sort_order_with_external_id_tiebreaker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def source_rows(_cls: object, _run_id: int | None) -> tuple:
        return (
            True,
            True,
            '',
            '',
            [
                {
                    'provider': 'zujuan',
                    'external_version_id': 'version-z',
                    'version_name': '名称靠后',
                    'sort_order': 1,
                },
                {
                    'provider': 'zujuan',
                    'external_version_id': 'version-a',
                    'version_name': '名称靠前',
                    'sort_order': 2,
                },
                {
                    'provider': 'zujuan',
                    'external_version_id': 'version-b',
                    'version_name': '同序乙',
                    'sort_order': 3,
                },
                {
                    'provider': 'zujuan',
                    'external_version_id': 'version-a-tie',
                    'version_name': '同序甲',
                    'sort_order': 3,
                },
            ],
            [
                {
                    'provider': 'zujuan',
                    'external_textbook_id': '208075',
                    'version_external_id': 'version-z',
                    'textbook_name': '六年级下册',
                    'sort_order': 2,
                },
                {
                    'provider': 'zujuan',
                    'external_textbook_id': '212597',
                    'version_external_id': 'version-z',
                    'textbook_name': '七年级上册',
                    'sort_order': 1,
                },
                {
                    'provider': 'zujuan',
                    'external_textbook_id': 'textbook-b',
                    'version_external_id': 'version-z',
                    'textbook_name': '同序乙',
                    'sort_order': 3,
                },
                {
                    'provider': 'zujuan',
                    'external_textbook_id': 'textbook-a',
                    'version_external_id': 'version-z',
                    'textbook_name': '同序甲',
                    'sort_order': 3,
                },
            ],
            {'id': 5, 'finished_at': '2026-08-27T10:00:00'},
            'collector API 可用',
        )

    async def no_current(
        _cls: object, _db: object, _entity_type: str, _source_provider: str | None = None
    ) -> dict:
        return {}

    async def no_reviews(
        _cls: object, _db: object, _entity_type: str, _source_provider: str | None = None
    ) -> dict:
        return {}

    monkeypatch.setattr(SyncService, '_metadata_source_rows', classmethod(source_rows))
    monkeypatch.setattr(SyncService, '_load_current', classmethod(no_current))
    monkeypatch.setattr(SyncService, '_load_reviews', classmethod(no_reviews))

    result = await SyncService.metadata_snapshot(object())

    assert [item['externalId'] for item in result['versions']] == [
        'version-z',
        'version-a',
        'version-a-tie',
        'version-b',
    ]
    assert [item['externalId'] for item in result['versions'][0]['textbooks']] == [
        '212597',
        '208075',
        'textbook-a',
        'textbook-b',
    ]
    assert all('_sortOrder' not in item for item in result['versions'])
    assert all('_sortOrder' not in item for item in result['versions'][0]['textbooks'])


def test_candidate_hash_is_stable_and_does_not_include_raw_html() -> None:
    candidate = {
        'sourceProvider': 'zujuan',
        'externalId': 'q1',
        'contentHash': 'abc',
        'plainTextSnippet': '题干',
    }
    assert _canonical_hash(_semantic(candidate, 'question', for_hash=True)) == _canonical_hash(
        json.loads(json.dumps(_semantic(candidate, 'question', for_hash=True), ensure_ascii=False))
    )


class MappingResult:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows

    def mappings(self) -> MappingResult:
        return self

    def all(self) -> list[dict]:
        return self.rows


class RecordingDb(FakeDb):
    def __init__(self, rows: list[dict] | None = None) -> None:
        super().__init__()
        self.statements: list[object] = []
        self.rows = rows or []

    async def execute(self, statement: object) -> MappingResult:
        self.statements.append(statement)
        return MappingResult(self.rows)


@pytest.mark.asyncio
async def test_formal_question_query_is_projected_and_provider_scoped() -> None:
    db = RecordingDb()
    result = await SyncService._load_current(db, 'question', 'zujuan')
    assert result == {}
    assert len(db.statements) == 1
    statement = str(db.statements[0])
    assert 'content_html' not in statement
    assert 'analysis_html' not in statement
    assert 'raw_data_json' not in statement
    assert 'source_text' in statement
    assert 'plain_text' not in statement
    assert 'source_provider' in statement
    assert 'zujuan' not in statement  # provider is a bound SQL parameter, not interpolated


def test_formal_question_name_falls_back_to_short_source_text() -> None:
    current = _formal_question(
        {
            'question_id': 1,
            'source_provider': 'zujuan',
            'external_question_id': 'q1',
            'paper_name': None,
            'source_text': '来源简称',
        }
    )
    assert current['sourceName'] == '来源简称'


@pytest.mark.asyncio
async def test_formal_database_error_is_not_reported_as_all_new(monkeypatch: pytest.MonkeyPatch) -> None:
    class FailingDb:
        async def execute(self, _statement: object) -> object:
            raise SQLAlchemyError('formal db unavailable')

    with pytest.raises(ServiceException) as error:
        await SyncService._load_current(FailingDb(), 'version', 'zujuan')
    assert '正式题库查询失败' in (error.value.message or '')

    async def failing_reviews(*_args: object, **_kwargs: object) -> list:
        raise SQLAlchemyError('review table missing')

    monkeypatch.setattr(SyncReviewDao, 'list_for_entity', failing_reviews)
    with pytest.raises(ServiceException) as error:
        await SyncService._load_reviews(FakeDb(), 'version', 'zujuan')
    assert '同步审核表查询失败' in (error.value.message or '')


@pytest.mark.asyncio
async def test_batch_review_reads_collector_once_and_passes_envelope_comment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    candidates = [
        {
            'sourceProvider': 'zujuan',
            'externalId': 'v1',
            'versionName': 'A',
            'sourceUrl': None,
            'isNew': 'Y',
            'sortOrder': 0,
            'status': '0',
        },
        {
            'sourceProvider': 'zujuan',
            'externalId': 'v2',
            'versionName': 'B',
            'sourceUrl': None,
            'isNew': 'N',
            'sortOrder': 1,
            'status': '0',
        },
    ]
    read_count = 0

    async def read_once(
        cls: object, entity_type: str, source_provider: str | None = None
    ) -> tuple[bool, str, list[dict]]:
        nonlocal read_count
        read_count += 1
        return True, 'ok', candidates

    async def no_current(cls: object, db: object, entity_type: str, source_provider: str | None = None) -> dict:
        return {}

    upserted: list[dict] = []

    async def get_review(*_args: object, **_kwargs: object) -> None:
        return None

    async def upsert_review(_db: object, **values: object) -> object:
        upserted.append(values)
        return type(
            'Review',
            (),
            {
                'review_status': values['review_status'],
                'comparison_status': values['comparison_status'],
                'staged_hash': values['staged_hash'],
                'reviewed_by': values['reviewed_by'],
                'reviewed_at': values['reviewed_at'],
            },
        )()

    monkeypatch.setattr(SyncService, '_read_candidates', classmethod(read_once))
    monkeypatch.setattr(SyncService, '_load_current', classmethod(no_current))
    monkeypatch.setattr(SyncReviewDao, 'get', get_review)
    monkeypatch.setattr(SyncReviewDao, 'upsert', upsert_review)
    hashes = [_canonical_hash(_semantic(candidate, 'version', for_hash=True)) for candidate in candidates]
    result = await SyncService.review(
        FakeDb(),
        'version',
        SyncReviewRequestModel(
            action='approve',
            comment='批量确认',
            items=[
                {'externalId': 'v1', 'stagedHash': hashes[0]},
                {'externalId': 'v2', 'stagedHash': hashes[1], 'status': 'rejected'},
            ],
        ),
        'tester',
    )
    assert result['updated'] == BATCH_ITEM_COUNT
    assert read_count == 1
    assert all(item['review_comment'] == '批量确认' for item in upserted)
    assert [item['review_status'] for item in upserted] == ['approved', 'rejected']


@pytest.mark.asyncio
async def test_content_review_re_reads_candidates_with_textbook_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    candidate = {
        'sourceProvider': 'zujuan',
        'externalId': 'q-1',
        'chapterId': 'c-1',
        'sourceName': '教材一题目',
        'sourceUrl': None,
        'sourceQuestionNo': '1',
        'questionType': '单选题',
        'difficulty': '容易',
        'difficultyCoefficient': None,
        'contentHash': 'hash',
        'plainTextSnippet': '题干一',
        'detailFetched': 1,
    }
    read_args: list[dict[str, object]] = []
    upserted: list[dict[str, object]] = []

    async def read_scoped(
        cls: object,
        entity_type: str,
        source_provider: str | None = None,
        metadata_run_id: int | None = None,
        textbook_external_id: str | None = None,
    ) -> tuple[bool, str, list[dict[str, object]]]:
        read_args.append(
            {
                'entity_type': entity_type,
                'source_provider': source_provider,
                'metadata_run_id': metadata_run_id,
                'textbook_external_id': textbook_external_id,
            }
        )
        return True, 'ok', [candidate]

    async def no_current(cls: object, db: object, entity_type: str, source_provider: str | None = None) -> dict:
        return {}

    async def no_review(*_args: object, **_kwargs: object) -> None:
        return None

    async def upsert_review(_db: object, **values: object) -> object:
        upserted.append(values)
        return type(
            'Review',
            (),
            {
                'review_status': values['review_status'],
                'comparison_status': values['comparison_status'],
                'staged_hash': values['staged_hash'],
                'reviewed_by': values['reviewed_by'],
                'reviewed_at': values['reviewed_at'],
            },
        )()

    monkeypatch.setattr(SyncService, '_read_candidates', classmethod(read_scoped))
    monkeypatch.setattr(SyncService, '_load_current', classmethod(no_current))
    monkeypatch.setattr(SyncReviewDao, 'get', no_review)
    monkeypatch.setattr(SyncReviewDao, 'upsert', upsert_review)
    staged_hash = _canonical_hash(_semantic(candidate, 'question', for_hash=True))

    result = await SyncService.review(
        FakeDb(),
        'question',
        SyncReviewRequestModel(
            action='approve',
            textbookExternalId='tb-1',
            items=[{'externalId': 'q-1', 'stagedHash': staged_hash}],
        ),
        'tester',
    )

    assert result['updated'] == 1
    assert read_args == [
        {
            'entity_type': 'question',
            'source_provider': None,
            'metadata_run_id': None,
            'textbook_external_id': 'tb-1',
        }
    ]
    assert upserted[0]['external_id'] == 'q-1'


@pytest.mark.asyncio
async def test_content_review_rejects_candidate_from_another_textbook(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A content review must never approve an ID outside its selected book."""

    candidate = {
        'sourceProvider': 'zujuan',
        'externalId': 'q-2',
        'chapterId': 'c-2',
        'sourceName': '教材二题目',
        'contentHash': 'hash',
        'plainTextSnippet': '题干二',
        'detailFetched': 1,
    }

    async def read_scoped(
        cls: object,
        entity_type: str,
        source_provider: str | None = None,
        metadata_run_id: int | None = None,
        textbook_external_id: str | None = None,
    ) -> tuple[bool, str, list[dict[str, object]]]:
        assert entity_type == 'question'
        assert textbook_external_id == 'tb-1'
        return True, 'ok', []

    monkeypatch.setattr(SyncService, '_read_candidates', classmethod(read_scoped))

    async def no_current(cls: object, db: object, entity_type: str, source_provider: str | None = None) -> dict:
        return {}

    monkeypatch.setattr(SyncService, '_load_current', classmethod(no_current))
    staged_hash = _canonical_hash(_semantic(candidate, 'question', for_hash=True))

    with pytest.raises(ServiceException) as error:
        await SyncService.review(
            FakeDb(),
            'question',
            SyncReviewRequestModel(
                action='approve',
                textbookExternalId='tb-1',
                items=[{'externalId': 'q-2', 'stagedHash': staged_hash}],
            ),
            'tester',
        )

    assert '不存在' in (error.value.message or '')


@pytest.mark.asyncio
async def test_review_rejects_hierarchy_conflict_before_writing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    candidate = {
        'sourceProvider': 'zujuan',
        'externalId': 'c-1',
        'textbookExternalId': 'tb-1',
        'parentExternalId': 'parent-1',
        'nodeLevel': 2,
        'nodeType': 'section',
        'nodeName': '第二节',
        'sourceUrl': None,
        'sortOrder': 0,
        'status': '0',
    }

    async def read_scoped(
        cls: object,
        entity_type: str,
        source_provider: str | None = None,
        metadata_run_id: int | None = None,
        textbook_external_id: str | None = None,
    ) -> tuple[bool, str, list[dict[str, object]]]:
        assert entity_type == 'catalog'
        assert source_provider == 'zujuan'
        assert textbook_external_id == 'tb-1'
        return True, 'ok', [candidate]

    async def load_current(
        cls: object,
        db: object,
        entity_type: str,
        source_provider: str | None = None,
    ) -> dict[tuple[str, str], dict[str, object]]:
        return {
            ('zujuan', 'c-1'): {
                **candidate,
                'textbookExternalId': 'tb-2',
                'currentLocalId': 1,
            }
        }

    monkeypatch.setattr(SyncService, '_read_candidates', classmethod(read_scoped))
    monkeypatch.setattr(SyncService, '_load_current', classmethod(load_current))
    staged_hash = _canonical_hash(_semantic(candidate, 'catalog', for_hash=True))
    fake_db = FakeDb()

    with pytest.raises(ServiceException) as error:
        await SyncService.review(
            fake_db,
            'catalog',
            SyncReviewRequestModel(
                action='approve',
                textbookExternalId='tb-1',
                items=[{'sourceProvider': 'zujuan', 'externalId': 'c-1', 'stagedHash': staged_hash}],
            ),
            'tester',
        )

    assert '冲突' in (error.value.message or '')
    assert fake_db.commits == 0


@pytest.mark.asyncio
async def test_textbook_scope_is_rejected_for_metadata_review() -> None:
    with pytest.raises(ServiceException) as error:
        await SyncService.review(
            FakeDb(),
            'version',
            SyncReviewRequestModel(
                action='approve',
                textbookExternalId='tb-1',
                items=[{'externalId': 'v-1', 'stagedHash': '0' * 64}],
            ),
            'tester',
        )
    assert '只能用于目录或题目' in (error.value.message or '')


@pytest.mark.asyncio
async def test_batch_review_rejects_duplicate_provider_external_id_before_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def should_not_read(*_args: object, **_kwargs: object) -> tuple[bool, str, list[dict]]:
        raise AssertionError('duplicate request must be rejected before collector read')

    monkeypatch.setattr(SyncService, '_read_candidates', should_not_read)
    payload = SyncReviewRequestModel(
        action='approve',
        items=[
            {'sourceProvider': 'zujuan', 'externalId': 'v1', 'stagedHash': '0' * 64},
            {'sourceProvider': 'zujuan', 'externalId': 'v1', 'stagedHash': '1' * 64},
        ],
    )
    with pytest.raises(ServiceException) as error:
        await SyncService.review(FakeDb(), 'version', payload, 'tester')
    assert '重复' in (error.value.message or '')


@pytest.mark.asyncio
async def test_stale_compare_keeps_previous_review_comment(monkeypatch: pytest.MonkeyPatch) -> None:
    candidate = {
        'sourceProvider': 'zujuan',
        'externalId': 'v1',
        'versionName': '新版本',
        'sourceUrl': None,
        'isNew': 'Y',
        'sortOrder': 0,
        'status': '0',
        'lastSeenAt': '2026-08-26T10:00:00',
    }
    old_review = type(
        'Review',
        (),
        {
            'staged_hash': '0' * 64,
            'review_status': 'approved',
            'review_comment': '旧审核意见',
            'reviewed_by': 'old-user',
            'reviewed_at': datetime(2026, 8, 25, 10, 0),
        },
    )()

    async def read_candidates(
        cls: object, entity_type: str, source_provider: str | None = None
    ) -> tuple[bool, str, list[dict]]:
        return True, 'ok', [candidate]

    async def load_current(cls: object, db: object, entity_type: str, source_provider: str | None = None) -> dict:
        return {}

    async def load_reviews(cls: object, db: object, entity_type: str, source_provider: str | None = None) -> dict:
        return {('zujuan', 'v1'): old_review}

    monkeypatch.setattr(SyncService, '_read_candidates', classmethod(read_candidates))
    monkeypatch.setattr(SyncService, '_load_current', classmethod(load_current))
    monkeypatch.setattr(SyncService, '_load_reviews', classmethod(load_reviews))
    result = await SyncService.compare(FakeDb(), 'version', SyncCompareQueryModel())
    row = result['rows'][0]
    assert row['reviewStatus'] == 'stale'
    assert row['reviewComment'] == '旧审核意见'
    assert row['reviewedBy'] == 'old-user'
    assert row['collectedAt'] == '2026-08-26T10:00:00'


@pytest.mark.asyncio
async def test_duplicate_candidate_identity_remains_conflict_when_parent_matches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    candidate = {
        'sourceProvider': 'zujuan',
        'externalId': 'tb1',
        'versionExternalId': 'v1',
        'textbookName': '教材',
        'grade': '九年级',
        'volume': '上册',
        'sourceUrl': None,
        'sortOrder': 0,
        'status': '0',
    }

    async def read_candidates(
        cls: object,
        entity_type: str,
        source_provider: str | None = None,
    ) -> tuple[bool, str, list[dict]]:
        return True, 'ok', [candidate, dict(candidate)]

    async def load_current(
        cls: object,
        db: object,
        entity_type: str,
        source_provider: str | None = None,
    ) -> dict:
        return {
            ('zujuan', 'tb1'): {
                **candidate,
                'currentLocalId': 1,
            }
        }

    async def no_reviews(
        cls: object,
        db: object,
        entity_type: str,
        source_provider: str | None = None,
    ) -> dict:
        return {}

    monkeypatch.setattr(SyncService, '_read_candidates', classmethod(read_candidates))
    monkeypatch.setattr(SyncService, '_load_current', classmethod(load_current))
    monkeypatch.setattr(SyncService, '_load_reviews', classmethod(no_reviews))

    result = await SyncService.compare(FakeDb(), 'textbook', SyncCompareQueryModel())
    assert {row['comparisonStatus'] for row in result['rows']} == {'conflict'}
