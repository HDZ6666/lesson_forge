"""HTTP collector contract and service-owned asset-cache tests."""

from __future__ import annotations

import hashlib
import threading
import time
from typing import TYPE_CHECKING, Any

import pytest

from exceptions.exception import ServiceException
from plugins.bank.service import collector_client as collector_module
from plugins.bank.service import question_apply_service as question_module

if TYPE_CHECKING:
    from pathlib import Path


RUN_ID = 17
TEXTBOOK_ID = 'tb-1'


def _run() -> dict[str, Any]:
    return {
        'id': RUN_ID,
        'provider': 'zujuan',
        'status': 'completed',
        'finishedAt': '2026-08-31T10:00:00Z',
        'snapshotLockedAt': '2026-08-31T10:00:01Z',
        'snapshotComplete': True,
        'textbookExternalId': TEXTBOOK_ID,
        'textbookExternalIds': [TEXTBOOK_ID],
    }


def _counts(**overrides: int) -> dict[str, int]:
    result = {
        'catalogs': 0,
        'questions': 0,
        'questionCatalogs': 0,
        'tags': 0,
        'assets': 0,
    }
    result.update(overrides)
    return result


def _summary(counts: dict[str, int]) -> dict[str, Any]:
    return {
        'available': True,
        'immutable': True,
        'snapshotComplete': True,
        'run': {**_run(), 'scope': {'textbookExternalId': TEXTBOOK_ID}},
        'counts': counts,
    }


def _page(
    collection: str,
    counts: dict[str, int],
    items: list[dict[str, Any]],
    cursor: int,
    next_cursor: int | None,
) -> dict[str, Any]:
    return {
        'available': True,
        'immutable': True,
        'snapshotComplete': True,
        'run': _run(),
        'counts': counts,
        'collection': collection,
        'cursor': cursor,
        'items': items,
        'total': counts[collection],
        'nextCursor': next_cursor,
    }


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.test:9110')


def test_run_snapshot_aggregates_all_bounded_pages_from_one_run(
    monkeypatch: pytest.MonkeyPatch,
    configured: None,
) -> None:
    client = collector_module.CollectorClient()
    expected = _counts(catalogs=2, questions=1, questionCatalogs=1)
    calls: list[tuple[str, int]] = []

    def read_summary(_run_id: int, *, textbook_external_id: str | None = None) -> dict[str, Any]:
        assert textbook_external_id == TEXTBOOK_ID
        return _summary(expected)

    def read_page(
        _run_id: int,
        collection: str,
        *,
        textbook_external_id: str | None,
        cursor: int,
        page_size: int,
    ) -> dict[str, Any]:
        assert textbook_external_id == TEXTBOOK_ID
        assert page_size == collector_module.DEFAULT_SNAPSHOT_PAGE_SIZE
        calls.append((collection, cursor))
        rows = {
            'catalogs': [
                {'externalId': 'c-1'},
                {'externalId': 'c-2'},
            ],
            'questions': [{'externalId': 'q-1'}],
            'questionCatalogs': [{'questionExternalId': 'q-1', 'catalogExternalId': 'c-1'}],
            'tags': [],
            'assets': [],
        }[collection]
        if collection == 'catalogs' and cursor == 0:
            return _page(collection, expected, rows[:1], 0, 1)
        if collection == 'catalogs' and cursor == 1:
            return _page(collection, expected, rows[1:], 1, None)
        return _page(collection, expected, rows, cursor, None)

    monkeypatch.setattr(client, 'run_snapshot_summary', read_summary)
    monkeypatch.setattr(client, 'run_snapshot_page', read_page)

    result = client.run_snapshot(RUN_ID, textbook_external_id=TEXTBOOK_ID)

    assert [item['externalId'] for item in result['catalogs']] == ['c-1', 'c-2']
    assert [item['externalId'] for item in result['questions']] == ['q-1']
    assert result['counts'] == {
        'catalogItemCount': 2,
        'questionItemCount': 1,
        'questionCatalogCount': 1,
        'questionTagCount': 0,
        'questionAssetCount': 0,
    }
    assert calls == [
        ('catalogs', 0),
        ('catalogs', 1),
        ('questions', 0),
        ('questionCatalogs', 0),
        ('tags', 0),
        ('assets', 0),
    ]


def test_run_snapshot_rejects_a_cursor_that_does_not_advance(
    monkeypatch: pytest.MonkeyPatch,
    configured: None,
) -> None:
    client = collector_module.CollectorClient()
    expected = _counts(catalogs=1)
    monkeypatch.setattr(client, 'run_snapshot_summary', lambda *_args, **_kwargs: _summary(expected))
    monkeypatch.setattr(
        client,
        'run_snapshot_page',
        lambda *_args, **kwargs: _page('catalogs', expected, [{'externalId': 'c-1'}], kwargs['cursor'], 0),
    )

    with pytest.raises(ServiceException, match='游标未前进'):
        client.run_snapshot(RUN_ID, textbook_external_id=TEXTBOOK_ID)


def test_run_snapshot_rejects_page_count_mismatch(
    monkeypatch: pytest.MonkeyPatch,
    configured: None,
) -> None:
    client = collector_module.CollectorClient()
    expected = _counts(catalogs=1)
    monkeypatch.setattr(client, 'run_snapshot_summary', lambda *_args, **_kwargs: _summary(expected))
    bad_counts = _counts(catalogs=2)
    monkeypatch.setattr(
        client,
        'run_snapshot_page',
        lambda *_args, **kwargs: _page('catalogs', bad_counts, [], kwargs['cursor'], None),
    )

    with pytest.raises(ServiceException, match='计数与摘要不一致'):
        client.run_snapshot(RUN_ID, textbook_external_id=TEXTBOOK_ID)


def test_bounded_page_accepts_large_total_without_enabling_full_aggregation(
    monkeypatch: pytest.MonkeyPatch,
    configured: None,
) -> None:
    client = collector_module.CollectorClient()
    counts = _counts(questionCatalogs=150_000)
    monkeypatch.setattr(client, '_request', lambda *_args, **_kwargs: _page(
        'questionCatalogs', counts,
        [{'questionExternalId': 'q-1', 'catalogExternalId': 'c-1'}], 0, 1,
    ))
    page = client.run_snapshot_page(RUN_ID, 'questionCatalogs', textbook_external_id=TEXTBOOK_ID,
                                    page_size=1)
    assert page['total'] == 150_000
    monkeypatch.setattr(client, 'run_snapshot_summary', lambda *_args, **_kwargs: _summary(counts))
    with pytest.raises(ServiceException, match='计数超过安全上限'):
        client.run_snapshot(RUN_ID, textbook_external_id=TEXTBOOK_ID)


def test_numeric_textbook_id_remains_a_scope_after_json_parsing() -> None:
    assert collector_module.CollectorClient._scope_ids(['260617']) == {'260617'}
    assert collector_module.CollectorClient._scope_ids({'textbookExternalIds': ['260617']}) == {'260617'}


def test_asset_client_validates_digest_and_uses_scoped_route(
    monkeypatch: pytest.MonkeyPatch,
    configured: None,
) -> None:
    client = collector_module.CollectorClient()
    digest = hashlib.sha256(b'asset').hexdigest().upper()
    calls: list[tuple[str, str, dict[str, Any]]] = []

    def request_bytes(method: str, route: str, *, query: dict[str, Any], max_bytes: int | None = None) -> bytes:
        calls.append((method, route, query))
        assert max_bytes is None
        return b'asset'

    monkeypatch.setattr(client, '_request_bytes', request_bytes)
    assert client.run_asset_bytes(RUN_ID, digest, textbook_external_id=TEXTBOOK_ID) == b'asset'
    assert calls == [
        (
            'GET',
            f'/v1/runs/{RUN_ID}/assets/{digest.lower()}',
            {'textbookExternalId': TEXTBOOK_ID},
        )
    ]
    with pytest.raises(ServiceException, match='64 位'):
        client.run_asset_bytes(RUN_ID, 'not-a-sha', textbook_external_id=TEXTBOOK_ID)


@pytest.mark.asyncio
async def test_question_snapshot_reads_through_collector_client_double(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[int, str]] = []
    snapshot = {
        'available': True,
        'immutable': True,
        'snapshotComplete': True,
        'run': {
            'id': RUN_ID,
            'provider': 'zujuan',
            'status': 'completed',
            'errorCount': 0,
            'finishedAt': '2026-08-31T10:00:00Z',
            'snapshotLockedAt': '2026-08-31T10:00:01Z',
            'scope': {'textbookExternalId': TEXTBOOK_ID},
        },
        'counts': {
            'catalogItemCount': 0,
            'questionItemCount': 0,
            'questionCatalogCount': 0,
            'questionTagCount': 0,
            'questionAssetCount': 0,
        },
        'catalogs': [],
        'questions': [],
        'questionCatalogs': [],
        'tags': [],
        'assets': [],
    }

    class Client:
        def run_snapshot(self, run_id: int, *, textbook_external_id: str) -> dict[str, Any]:
            calls.append((run_id, textbook_external_id))
            return snapshot

    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.test:9110')
    monkeypatch.setattr(question_module, 'CollectorClient', Client)

    result = await question_module._read_snapshot(RUN_ID, TEXTBOOK_ID)

    assert result == snapshot
    assert calls == [(RUN_ID, TEXTBOOK_ID)]


@pytest.mark.asyncio
async def test_asset_download_is_service_owned_hash_checked_and_cache_reused(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    data = b'asset-content'
    digest = hashlib.sha256(data).hexdigest()
    calls = 0

    class Client:
        def run_asset_bytes(self, run_id: int, content_sha256: str, *, textbook_external_id: str) -> bytes:
            nonlocal calls
            assert (run_id, content_sha256, textbook_external_id) == (RUN_ID, digest, TEXTBOOK_ID)
            calls += 1
            return data

    monkeypatch.setenv('BANK_ASSET_ROOT', str(tmp_path / 'owned-assets'))
    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.test:9110')
    monkeypatch.setattr(question_module, 'CollectorClient', Client)
    snapshot = {
        'collector_run_id': RUN_ID,
        'textbook_external_id': TEXTBOOK_ID,
        'assets': [
            {
                'file_hash': digest,
                'byte_size': len(data),
                'file_name': '../../collector-private/diagram.PNG',
                'source_url': 'https://collector.example/diagram.PNG',
                'storage_path': '/collector/private/absolute/path',
            }
        ],
    }

    await question_module._download_snapshot_assets(snapshot)
    first_path = snapshot['assets'][0]['storage_path']
    assert first_path == f'assets/{digest[:2]}/{digest}.png'
    target = tmp_path / 'owned-assets' / first_path
    assert target.read_bytes() == data
    assert not first_path.startswith('/')
    assert 'collector-private' not in first_path
    assert calls == 1

    second = {
        'collector_run_id': RUN_ID,
        'textbook_external_id': TEXTBOOK_ID,
        'assets': [dict(snapshot['assets'][0])],
    }
    await question_module._download_snapshot_assets(second)
    assert second['assets'][0]['storage_path'] == first_path
    assert calls == 1


@pytest.mark.asyncio
async def test_asset_download_rejects_hash_mismatch_without_persisting(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    expected = hashlib.sha256(b'expected').hexdigest()

    class Client:
        def run_asset_bytes(self, *_args: Any, **_kwargs: Any) -> bytes:
            return b'tampered'

    monkeypatch.setenv('BANK_ASSET_ROOT', str(tmp_path / 'owned-assets'))
    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.test:9110')
    monkeypatch.setattr(question_module, 'CollectorClient', Client)
    snapshot = {
        'collector_run_id': RUN_ID,
        'textbook_external_id': TEXTBOOK_ID,
        'assets': [{'file_hash': expected, 'file_name': 'diagram.png'}],
    }

    with pytest.raises(ServiceException, match='哈希校验失败'):
        await question_module._download_snapshot_assets(snapshot)
    assert not list((tmp_path / 'owned-assets').rglob('*'))


@pytest.mark.asyncio
async def test_asset_download_groups_duplicate_hashes_and_bounds_sync_client_threads(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    blobs = {f'asset-{index}': f'asset-content-{index}'.encode() for index in range(12)}
    digests = {name: hashlib.sha256(data).hexdigest() for name, data in blobs.items()}
    calls: list[tuple[str, int]] = []
    lock = threading.Lock()
    active = 0
    maximum_active = 0
    main_thread = threading.get_ident()

    class Client:
        def run_asset_bytes(self, _run_id: int, content_sha256: str, *, textbook_external_id: str) -> bytes:
            nonlocal active, maximum_active
            name = next(name for name, digest in digests.items() if digest == content_sha256)
            with lock:
                calls.append((content_sha256, threading.get_ident()))
                active += 1
                maximum_active = max(maximum_active, active)
            time.sleep(0.02)
            with lock:
                active -= 1
            assert textbook_external_id == TEXTBOOK_ID
            return blobs[name]

    assets = [
        {
            'file_hash': digest,
            'byte_size': len(blobs[name]),
            'file_name': f'{name}.png',
        }
        for name, digest in digests.items()
    ]
    assets.append(dict(assets[0]))
    snapshot = {
        'collector_run_id': RUN_ID,
        'textbook_external_id': TEXTBOOK_ID,
        'assets': assets,
    }
    monkeypatch.setenv('BANK_ASSET_ROOT', str(tmp_path / 'owned-assets'))
    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.test:9110')
    monkeypatch.setattr(question_module, 'CollectorClient', Client)

    await question_module._download_snapshot_assets(snapshot)

    assert len(calls) == len(blobs)
    assert all(thread_id != main_thread for _digest, thread_id in calls)
    assert 1 < maximum_active <= question_module.ASSET_DOWNLOAD_CONCURRENCY
    assert snapshot['assets'][0]['storage_path'] == snapshot['assets'][-1]['storage_path']


@pytest.mark.asyncio
async def test_asset_download_accepts_async_client_double(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    data = b'async-asset'
    digest = hashlib.sha256(data).hexdigest()

    class Client:
        async def run_asset_bytes(self, _run_id: int, _content_sha256: str, *, textbook_external_id: str) -> bytes:
            assert textbook_external_id == TEXTBOOK_ID
            return data

    monkeypatch.setenv('BANK_ASSET_ROOT', str(tmp_path / 'owned-assets'))
    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.test:9110')
    monkeypatch.setattr(question_module, 'CollectorClient', Client)
    snapshot = {
        'collector_run_id': RUN_ID,
        'textbook_external_id': TEXTBOOK_ID,
        'assets': [{'file_hash': digest, 'byte_size': len(data), 'file_name': 'async.bin'}],
    }

    await question_module._download_snapshot_assets(snapshot)

    assert snapshot['assets'][0]['storage_path'] == f'assets/{digest[:2]}/{digest}.bin'


def test_asset_paths_are_relative_and_cannot_escape_service_root() -> None:
    digest = hashlib.sha256(b'asset').hexdigest()
    assert question_module._safe_storage_path('/collector/file') is None
    assert question_module._safe_storage_path('../collector/file') is None
    assert question_module._asset_relative_path(
        digest,
        {'file_name': '../../../outside.txt'},
    ) == f'assets/{digest[:2]}/{digest}.txt'
