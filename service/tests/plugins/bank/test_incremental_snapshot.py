"""Partial results stay partial; content failures do not discard other rows."""

import copy
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from exceptions.exception import ServiceException
from plugins.bank.service import question_apply_service as legacy
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.incremental_snapshot import SealedSnapshotReader, check_sealed_snapshot
from plugins.bank.service.large_snapshot_spool import spool_snapshot


def fixture_client(monkeypatch):
    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.test:9110')
    client = CollectorClient()
    run = {
        'id': 27,
        'provider': 'zujuan',
        'status': 'failed',
        'errorCount': 1,
        'textbookExternalId': 'tb1',
        'finishedAt': '2026-10-01T01:00:00Z',
        'snapshotLockedAt': '2026-10-01T01:00:00Z',
        'snapshotComplete': False,
        'scope': {'textbookId': 'tb1', 'sourceNamespace': 'zujuan:junior:math'},
    }
    common = {'provider': 'zujuan', 'textbook_external_id': 'tb1'}
    rows = {
        'catalogs': [
            {**common, 'catalog_external_id': 'c1', 'name': '章', 'parent_external_id': None},
            {**common, 'catalog_external_id': 'c2', 'name': '节', 'parent_external_id': 'c1'},
        ],
        'questions': [
            {
                **common,
                'question_external_id': f'q{i}',
                'question_type': '单选题',
                'content_html': '<p>测试题干</p>' if i != 2 else '',
                'detail_fetched': 1,
                'captured_at': '2026-10-01T00:00:00Z',
            }
            for i in (1, 2, 3)
        ],
        'questionCatalogs': [
            {**common, 'question_external_id': f'q{i}', 'catalog_external_id': 'c2'} for i in (1, 2, 3)
        ],
        'tags': [],
        'assets': [],
    }
    counts = {key: len(value) for key, value in rows.items()}
    summary_counts = {
        'catalogItemCount': counts['catalogs'],
        'questionItemCount': counts['questions'],
        'questionCatalogCount': counts['questionCatalogs'],
        'questionTagCount': counts['tags'],
        'questionAssetCount': counts['assets'],
    }
    summary = {'available': True, 'immutable': True, 'snapshotComplete': False, 'run': run, 'counts': summary_counts}
    calls = []

    def request(_method, route, *, query):
        calls.append((route, dict(query)))
        if route.endswith('/snapshot-summary'):
            return copy.deepcopy(summary)
        collection = query['collection']
        cursor = query['cursor']
        items = copy.deepcopy(rows[collection][cursor : cursor + query['pageSize']])
        next_cursor = cursor + len(items)
        return {
            **copy.deepcopy(summary),
            'collection': collection,
            'cursor': cursor,
            'items': items,
            'total': counts[collection],
            'nextCursor': next_cursor if next_cursor < counts[collection] else None,
        }

    monkeypatch.setattr(client, '_request', request)
    return client, summary, rows, calls


def test_partial_qc_is_resumable_and_never_claims_complete(monkeypatch, tmp_path: Path):
    client, summary, _rows, calls = fixture_client(monkeypatch)
    path = tmp_path / 'sealed.sqlite3'
    with pytest.raises(ServiceException, match='未完成'):
        spool_snapshot(client, 27, 'tb1', path)
    spool_snapshot(client, 27, 'tb1', path, page_size=1, sealed_for_import=True)
    assert all(query.get('sealedForImport') == 'true' for _, query in calls[1:])
    with SealedSnapshotReader(path, summary, 28, 'tb1') as reader:

        def interrupt(cursor, total):
            if cursor == 2:
                raise RuntimeError('worker stopped')

        with pytest.raises(RuntimeError, match='worker stopped'):
            check_sealed_snapshot(reader, path, size=1, on_progress=interrupt)
        with sqlite3.connect(path) as db:
            assert db.execute("SELECT value FROM metadata WHERE key='qc_cursor'").fetchone()[0] == b'2'
            assert db.execute('SELECT COUNT(*) FROM qc_questions').fetchone()[0] == 2
        report = check_sealed_snapshot(reader, path, size=1)
        assert report['checked'] == 3
        assert report['accepted'] == 2
        assert report['quarantined'] == 1
        assert report['snapshotComplete'] is False
        assert check_sealed_snapshot(reader, path, size=1) == report
        batches = list(reader.quality_batches(size=1))
        assert batches[0]['verdicts'][0]['normalized']['snapshot_complete'] is False
        assert batches[1]['verdicts'][0]['questionId'] == 'q2'
        assert '题干' in batches[1]['verdicts'][0]['reason']
    assert summary['run']['status'] == 'failed'
    assert summary['snapshotComplete'] is False


@pytest.mark.parametrize('damage', ['foreign_question', 'catalog_cycle', 'foreign_relation', 'duplicate_question'])
def test_identity_and_tree_damage_block_the_scope_before_any_verdict(monkeypatch, tmp_path, damage):
    client, summary, rows, _calls = fixture_client(monkeypatch)
    if damage == 'foreign_question':
        rows['questions'][2]['provider'] = 'other'
    elif damage == 'catalog_cycle':
        rows['catalogs'][0]['parent_external_id'] = 'c2'
    elif damage == 'foreign_relation':
        rows['questionCatalogs'][2]['catalog_external_id'] = 'foreign'
    else:
        rows['questions'][2]['question_external_id'] = 'q1'
    path = tmp_path / 'damaged.sqlite3'
    spool_snapshot(client, 27, 'tb1', path, sealed_for_import=True)
    with SealedSnapshotReader(path, summary, 28, 'tb1') as reader:
        with pytest.raises(ServiceException):
            check_sealed_snapshot(reader, path)
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT COUNT(*) FROM qc_questions').fetchone()[0] == 0
        assert not db.execute("SELECT value FROM metadata WHERE key='qc_report'").fetchone()


@pytest.mark.parametrize('damage', ['running', 'unlocked', 'foreign_subject', 'conflicting_complete'])
def test_sealed_import_policy_cannot_accept_mutable_or_foreign_results(monkeypatch, tmp_path, damage):
    client, summary, _rows, _calls = fixture_client(monkeypatch)
    if damage == 'running':
        summary['run']['status'] = 'running'
    elif damage == 'unlocked':
        summary['run']['snapshotLockedAt'] = None
    elif damage == 'foreign_subject':
        summary['run']['scope']['sourceNamespace'] = 'zujuan:junior:chinese'
    else:
        summary['run']['snapshotComplete'] = True
    with pytest.raises(ServiceException):
        spool_snapshot(client, 27, 'tb1', tmp_path / 'blocked.sqlite3', sealed_for_import=True)
    assert not (tmp_path / 'blocked.sqlite3').exists()


@pytest.mark.asyncio
async def test_new_tasks_cannot_enter_legacy_full_apply(monkeypatch):
    async def load(_db, _id):
        return SimpleNamespace(run_id=28, status='completed', options_json={'workflowVersion': 2}), []

    monkeypatch.setattr(legacy, '_load_task_and_scopes', load)
    with pytest.raises(ServiceException, match='分批增量'):
        await legacy._validate_task_snapshots(object(), 28)
    assert legacy._uses_incremental_workflow(SimpleNamespace(options_json=None)) is False
    assert legacy._uses_incremental_workflow(SimpleNamespace()) is False


def test_failed_answer_asset_metadata_does_not_quarantine_complete_stem(monkeypatch, tmp_path):
    client, summary, rows, _calls = fixture_client(monkeypatch)
    rows['questions'][0].update(answer_status='public_captured', answer_html='<img data-asset-key="answer">')
    rows['questions'][2]['content_html'] += '<img data-asset-key="required">'
    common = {'provider': 'zujuan', 'textbook_external_id': 'tb1', 'asset_type': 'image',
              'download_status': 'failed', 'source_url': 'https://static.zxxk.com/missing.png'}
    rows['assets'] = [{**common, 'question_external_id': 'q1', 'asset_key': 'answer'},
                      {**common, 'question_external_id': 'q3', 'asset_key': 'required'}]
    summary['counts']['questionAssetCount'] = 2
    original = client._request

    def request(method, route, *, query):
        response = original(method, route, query=query)
        if query.get('collection') == 'assets':
            response['total'] = 2
            cursor = query['cursor'] + len(response['items'])
            response['nextCursor'] = cursor if cursor < 2 else None
        return response

    monkeypatch.setattr(client, '_request', request)
    path = tmp_path / 'failed-answer.sqlite3'
    spool_snapshot(client, 27, 'tb1', path, sealed_for_import=True)
    with SealedSnapshotReader(path, summary, 28, 'tb1') as reader:
        results = list(reader.quality_batches())[0]['verdicts']
    assert [row['status'] for row in results] == ['accepted', 'quarantined', 'quarantined']
    first = results[0]['normalized']
    assert first['assets'] == []
    assert first['questions'][0]['answer_status'] == 'unknown'
    assert first['questions'][0]['answer_html'] is None
    # Original failed assets remain in staging evidence; only the derived
    # import projection excludes an unusable optional answer asset.
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT COUNT(*) FROM rows WHERE collection='assets'").fetchone()[0] == 2
