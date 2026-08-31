from __future__ import annotations

import pytest

from exceptions.exception import ServiceException
from plugins.bank.service.sync_service import SyncService

RUN_ID = 9
CURRENT_VERSION_ID = 11
CURRENT_TEXTBOOK_ID = 101
EXPECTED_GROUP_COUNT = 2
EXPECTED_TEXTBOOK_COUNT = 2
ORPHAN_VERSION_ID = 99
ORPHAN_TEXTBOOK_ID = 11


class MappingResult:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows

    def mappings(self) -> MappingResult:
        return self

    def all(self) -> list[dict]:
        return self.rows


class CurrentTreeDb:
    def __init__(self, *results: list[dict]) -> None:
        self.results = list(results)

    async def execute(self, _statement: object) -> MappingResult:
        return MappingResult(self.results.pop(0))


@pytest.mark.asyncio
async def test_overview_matches_only_provider_and_external_id(monkeypatch: pytest.MonkeyPatch) -> None:
    async def source_rows(_cls: object, _run_id: int | None) -> tuple:
        return (
            True,
            True,
            '',
            '',
            [
                {
                    'provider': 'zujuan',
                    'external_version_id': 'v-1',
                    'version_name': '相同名称',
                    'sort_order': 2,
                },
                {
                    'provider': 'zujuan',
                    'external_version_id': 'v-new',
                    'version_name': '新版本',
                    'sort_order': 1,
                },
            ],
            [
                {
                    'provider': 'zujuan',
                    'external_textbook_id': 'tb-existing',
                    'version_external_id': 'v-1',
                    'textbook_name': '教材一',
                    'grade': '七年级',
                    'volume': '上册',
                    'sort_order': 2,
                },
                {
                    'provider': 'zujuan',
                    'external_textbook_id': 'tb-new',
                    'version_external_id': 'v-1',
                    # Same display name as the current row, but a different
                    # source ID must remain new.
                    'textbook_name': '教材手工同名',
                    'sort_order': 1,
                },
                {
                    'provider': 'zujuan',
                    'external_textbook_id': 'tb-vnew',
                    'version_external_id': 'v-new',
                    'textbook_name': '新教材',
                    'sort_order': 1,
                },
            ],
            {'id': RUN_ID, 'finished_at': '2026-08-27T10:00:00'},
            'collector SQLite 可用',
        )

    async def current_tree(_cls: object, _db: object) -> list[dict]:
        return [
            {
                'currentLocalId': 11,
                'sourceProvider': 'zujuan',
                'externalId': 'v-1',
                'versionName': '相同名称',
                'textbookCount': 1,
                'textbooks': [
                    {
                        'currentLocalId': 101,
                        'sourceProvider': 'zujuan',
                        'externalId': 'tb-existing',
                        'textbookName': '教材一',
                        'grade': '七年级',
                        'volume': '上册',
                    }
                ],
            },
            {
                'currentLocalId': 12,
                'sourceProvider': 'manual',
                'externalId': None,
                'versionName': '手工版本',
                'textbookCount': 2,
                'textbooks': [
                    {
                        'currentLocalId': 102,
                        'sourceProvider': 'manual',
                        'externalId': None,
                        'textbookName': '教材手工同名',
                        'grade': None,
                        'volume': None,
                    },
                    {
                        'currentLocalId': 103,
                        'sourceProvider': 'manual',
                        'externalId': None,
                        'textbookName': '另一本教材',
                        'grade': None,
                        'volume': None,
                    },
                ],
            },
        ]

    monkeypatch.setattr(SyncService, '_metadata_source_rows', classmethod(source_rows))
    monkeypatch.setattr(SyncService, '_load_current_textbook_overview', classmethod(current_tree))

    result = await SyncService.metadata_textbook_overview(object())

    assert result['metadataRunId'] == RUN_ID
    assert [item['externalId'] for item in result['fetchedVersions']] == ['v-new', 'v-1']
    assert [item['externalId'] for item in result['fetchedVersions'][1]['textbooks']] == [
        'tb-new',
        'tb-existing',
    ]
    assert result['summary'] == {
        'fetchedVersionCount': 2,
        'fetchedTextbookCount': 3,
        'newVersionCount': 1,
        'existingVersionCount': 1,
        'newTextbookCount': 2,
        'existingTextbookCount': 1,
        'currentVersionCount': 2,
        'currentTextbookCount': 3,
    }
    fetched = {item['externalId']: item for item in result['fetchedVersions']}
    assert fetched['v-1']['matchStatus'] == 'existing'
    assert fetched['v-1']['currentLocalId'] == CURRENT_VERSION_ID
    books = {item['externalId']: item for item in fetched['v-1']['textbooks']}
    assert books['tb-existing']['matchStatus'] == 'existing'
    assert books['tb-existing']['currentLocalId'] == CURRENT_TEXTBOOK_ID
    assert books['tb-new']['matchStatus'] == 'new'
    assert 'currentLocalId' not in books['tb-new']
    assert len(result['currentVersions'][1]['textbooks']) == EXPECTED_TEXTBOOK_COUNT


@pytest.mark.asyncio
async def test_overview_without_snapshot_still_returns_full_current_tree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = [
        {
            'currentLocalId': 1,
            'sourceProvider': 'manual',
            'externalId': None,
            'versionName': '手工版本',
            'textbookCount': 1,
            'textbooks': [
                {
                    'currentLocalId': 2,
                    'sourceProvider': 'manual',
                    'externalId': None,
                    'textbookName': '手工教材',
                    'grade': None,
                    'volume': None,
                }
            ],
        }
    ]

    async def source_rows(_cls: object, _run_id: int | None) -> tuple:
        return (False, False, '没有成功运行', '没有成功运行', [], [], None, 'collector SQLite 可用')

    async def current_tree(_cls: object, _db: object) -> list[dict]:
        return current

    monkeypatch.setattr(SyncService, '_metadata_source_rows', classmethod(source_rows))
    monkeypatch.setattr(SyncService, '_load_current_textbook_overview', classmethod(current_tree))

    result = await SyncService.metadata_textbook_overview(object())

    assert result['sourceAvailable'] is False
    assert result['metadataRunId'] is None
    assert result['fetchedVersions'] == []
    assert result['currentVersions'] == current
    assert result['summary']['currentVersionCount'] == 1
    assert result['summary']['currentTextbookCount'] == 1


@pytest.mark.asyncio
async def test_overview_keeps_current_tree_when_collector_request_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = [
        {
            'currentLocalId': 1,
            'sourceProvider': 'manual',
            'externalId': None,
            'versionName': '手工版本',
            'textbookCount': 0,
            'textbooks': [],
        }
    ]

    async def source_rows(_cls: object, _run_id: int | None) -> tuple:
        raise ServiceException(message='collector API 暂不可用')

    async def current_tree(_cls: object, _db: object) -> list[dict]:
        return current

    monkeypatch.setattr(SyncService, '_metadata_source_rows', classmethod(source_rows))
    monkeypatch.setattr(SyncService, '_load_current_textbook_overview', classmethod(current_tree))

    result = await SyncService.metadata_textbook_overview(object())

    assert result['sourceAvailable'] is False
    assert result['sourceMessage'] == 'collector API 暂不可用'
    assert result['currentVersions'] == current


@pytest.mark.asyncio
async def test_current_tree_keeps_orphan_and_null_external_id_textbooks() -> None:
    db = CurrentTreeDb(
        [
            {
                'version_id': 1,
                'source_provider': 'manual',
                'external_version_id': None,
                'version_name': '正式版本',
            }
        ],
        [
            {
                'textbook_id': 10,
                'version_id': 1,
                'source_provider': 'manual',
                'external_textbook_id': None,
                'textbook_name': '手工教材',
            },
            {
                'textbook_id': 11,
                'version_id': 99,
                'source_provider': 'manual',
                'external_textbook_id': None,
                'textbook_name': '孤儿教材',
            },
        ],
    )

    result = await SyncService._load_current_textbook_overview(db)

    assert len(result) == EXPECTED_GROUP_COUNT
    assert sum(item['textbookCount'] for item in result) == EXPECTED_TEXTBOOK_COUNT
    orphan = next(item for item in result if item['versionName'] == '未关联版本')
    assert orphan['currentLocalId'] == ORPHAN_VERSION_ID
    assert orphan['textbooks'][0]['currentLocalId'] == ORPHAN_TEXTBOOK_ID


@pytest.mark.asyncio
async def test_current_tree_orders_by_formal_sort_order_then_local_id() -> None:
    db = CurrentTreeDb(
        [
            {
                'version_id': 20,
                'source_provider': 'zujuan',
                'external_version_id': 'v-z',
                'version_name': '名称靠后',
                'sort_order': 1,
            },
            {
                'version_id': 10,
                'source_provider': 'zujuan',
                'external_version_id': 'v-a',
                'version_name': '名称靠前',
                'sort_order': 2,
            },
            {
                'version_id': 40,
                'source_provider': 'zujuan',
                'external_version_id': 'v-a-tie',
                'version_name': '同序名称靠前',
                'sort_order': 3,
            },
            {
                'version_id': 30,
                'source_provider': 'zujuan',
                'external_version_id': 'v-z-tie',
                'version_name': '同序名称靠后',
                'sort_order': 3,
            },
        ],
        [
            {
                'textbook_id': 202,
                'version_id': 20,
                'source_provider': 'zujuan',
                'external_textbook_id': 'tb-z',
                'textbook_name': '名称靠前',
                'sort_order': 2,
            },
            {
                'textbook_id': 101,
                'version_id': 20,
                'source_provider': 'zujuan',
                'external_textbook_id': 'tb-a',
                'textbook_name': '名称靠后',
                'sort_order': 1,
            },
            {
                'textbook_id': 303,
                'version_id': 20,
                'source_provider': 'zujuan',
                'external_textbook_id': 'tb-z-tie',
                'textbook_name': '同序名称靠前',
                'sort_order': 3,
            },
            {
                'textbook_id': 302,
                'version_id': 20,
                'source_provider': 'zujuan',
                'external_textbook_id': 'tb-a-tie',
                'textbook_name': '同序名称靠后',
                'sort_order': 3,
            },
        ],
    )

    result = await SyncService._load_current_textbook_overview(db)

    assert [item['currentLocalId'] for item in result] == [20, 10, 30, 40]
    assert [item['currentLocalId'] for item in result[0]['textbooks']] == [101, 202, 302, 303]
    assert all('sortOrder' not in item for item in result)
    assert all('sortOrder' not in item for item in result[0]['textbooks'])
