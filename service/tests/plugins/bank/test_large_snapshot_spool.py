"""The large snapshot staging cursor must survive an interrupted fetch."""

from __future__ import annotations

import asyncio
import hashlib
import sqlite3
from pathlib import Path

import pytest

from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service import large_asset_prepare as prepare_module
from plugins.bank.service.large_snapshot_reader import LargeSnapshotReader
from plugins.bank.service.large_snapshot_spool import spool_snapshot


def test_large_spool_resumes_at_committed_page(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.test:9110')
    client = CollectorClient()
    run = {
        'id': 17, 'provider': 'zujuan', 'status': 'completed', 'errorCount': 0,
        'finishedAt': '2026-09-08T10:30:37Z', 'snapshotLockedAt': '2026-09-08T10:30:37Z',
        'snapshotComplete': True, 'scope': {'textbookExternalId': 'tb-1'},
        'textbookExternalId': 'tb-1', 'textbookExternalIds': ['tb-1'],
    }
    counts = {'catalogItemCount': 2, 'questionItemCount': 1, 'questionCatalogCount': 1,
              'questionTagCount': 0, 'questionAssetCount': 1}
    totals = {'catalogs': 2, 'questions': 1, 'questionCatalogs': 1, 'tags': 0, 'assets': 1}
    rows = {
        'catalogs': [
            {'provider': 'zujuan', 'textbook_external_id': 'tb-1', 'catalog_external_id': catalog_id,
             'name': catalog_id, 'node_type': 'chapter', 'parent_external_id': None}
            for catalog_id in ('c-1', 'c-2')
        ],
        'questions': [{'provider': 'zujuan', 'textbook_external_id': 'tb-1',
                       'question_external_id': 'q-1', 'question_type': '选择题',
                       'content_html': '<p>题干</p>', 'detail_fetched': 1}],
        'questionCatalogs': [{'provider': 'zujuan', 'textbook_external_id': 'tb-1',
                              'question_external_id': 'q-1', 'catalog_external_id': 'c-1',
                              'evidence_type': 'query_membership'}],
        'tags': [],
        'assets': [{'provider': 'zujuan', 'textbook_external_id': 'tb-1',
                    'question_external_id': 'q-1', 'asset_key': 'img', 'asset_type': 'image',
                    'source_url': 'https://example.test/img.png',
                    'content_sha256': hashlib.sha256(b'asset').hexdigest(), 'byte_size': 5}],
    }
    summary = {'available': True, 'immutable': True, 'snapshotComplete': True,
               'run': run, 'counts': counts}
    monkeypatch.setattr(client, 'run_snapshot_summary', lambda *_args, **_kwargs: summary)
    requested = []
    fail_once = True

    def page(_run_id, collection, *, textbook_external_id, cursor, page_size):
        nonlocal fail_once
        assert textbook_external_id == 'tb-1'
        requested.append((collection, cursor))
        if collection == 'catalogs' and cursor == 1 and fail_once:
            fail_once = False
            raise RuntimeError('temporary collector disconnect')
        batch = rows[collection][cursor:cursor + page_size]
        next_cursor = cursor + len(batch) if cursor + len(batch) < totals[collection] else None
        return {'available': True, 'immutable': True, 'snapshotComplete': True,
                'run': run, 'counts': counts, 'collection': collection, 'cursor': cursor,
                'items': batch, 'total': totals[collection], 'nextCursor': next_cursor}

    monkeypatch.setattr(client, 'run_snapshot_page', page)
    spool = tmp_path / 'snapshot.sqlite3'
    with pytest.raises(RuntimeError, match='temporary collector disconnect'):
        spool_snapshot(client, 17, 'tb-1', spool, page_size=1)
    with sqlite3.connect(spool) as db:
        assert db.execute("SELECT cursor FROM progress WHERE collection='catalogs'").fetchone()[0] == 1

    assert spool_snapshot(client, 17, 'tb-1', spool, page_size=1) == totals
    with sqlite3.connect(spool) as db:
        assert db.execute("SELECT COUNT(*) FROM rows WHERE collection='catalogs'").fetchone()[0] == 2
        assert db.execute("SELECT value FROM metadata WHERE key='complete'").fetchone()[0] == b'1'
    assert requested.count(('catalogs', 0)) == 1
    with LargeSnapshotReader(spool, summary, 18, 'tb-1') as reader:
        result = reader.validate_all(size=1)
        normalized = list(reader.chunks(size=1))
    assert result['counts'] == totals
    assert len(result['normalizedHash']) == 64
    assert len(normalized) == 1
    assert normalized[0]['questions'][0]['external_id'] == 'q-1'
    assert normalized[0]['question_catalogs'][0]['catalog_external_id'] == 'c-1'

    async def fake_download(snapshot):
        for asset in snapshot['assets']:
            asset['storage_path'] = f"assets/{asset['file_hash'][:2]}/{asset['file_hash']}.png"
            asset['download_status'] = 'downloaded'

    monkeypatch.setattr(prepare_module, '_download_snapshot_assets', fake_download)
    with LargeSnapshotReader(spool, summary, 18, 'tb-1') as reader:
        prepared = asyncio.run(prepare_module.prepare_assets(reader, spool))
    assert prepared['assetReferences'] == 1
    assert prepared['distinctAssets'] == 1
    assert prepared['normalizedHash'] == result['normalizedHash']
