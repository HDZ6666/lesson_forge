"""Cross-layer contract checks for immutable collector question snapshots.

These tests deliberately keep the collector database in ``tmp_path``.  The
schema is created by the real Node collector migration, then populated with a
single sealed run.  The Python reader/normalizer and the Node API readers all
consume that same fixture; no service, network, or formal database is needed.
"""

from __future__ import annotations

import copy
import json
import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import Any

import pytest

from exceptions.exception import ServiceException
from plugins.bank.service import question_apply_service as apply_module
from plugins.bank.service.collector_client import CollectorClient

PROJECT_ROOT = Path(__file__).resolve().parents[4]
NODE = shutil.which('node')
TEXTBOOK_ID = 'tb-contract-1'
RUN_ID = 1


def _node_json(script: str, *arguments: object) -> Any:
    """Run a small, read-only/export-only Node probe in the temp fixture."""

    if NODE is None:
        pytest.skip('node is required to exercise the collector schema/API exports')
    result = subprocess.run(
        [NODE, '-e', script, *(str(argument) for argument in arguments)],
        cwd=PROJECT_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:  # pragma: no cover - useful probe failure
        raise AssertionError(f'Node probe did not return JSON: {result.stdout!r}') from exc


def _initialize_collector_schema(db_path: Path) -> None:
    _node_json(
        """
        const { ensureRunSnapshotSchema } = require('./collector/lib/run_snapshots.cjs');
        ensureRunSnapshotSchema(process.argv[1]);
        process.stdout.write(JSON.stringify({ ok: true }));
        """,
        db_path,
    )


def _seed_sealed_run(db_path: Path) -> None:
    """Populate the exact five-table collector schema with one valid run."""

    _initialize_collector_schema(db_path)
    connection = sqlite3.connect(db_path)
    try:
        now = '2026-08-29T08:00:00.000Z'
        scope = json.dumps({'textbookExternalIds': [TEXTBOOK_ID]}, ensure_ascii=False)
        connection.execute(
            """
            INSERT INTO sync_runs (
                id, provider, started_at, finished_at, status, scope_json,
                pages_ok, questions_seen, questions_inserted, questions_updated,
                details_fetched, assets_downloaded, error_count, message,
                snapshot_locked_at, snapshot_complete,
                catalog_item_count, question_item_count, question_catalog_count,
                question_tag_count, question_asset_count
            ) VALUES (?, 'zujuan', ?, NULL, 'running', ?, 3, 1, 1, 0, 1, 1, 0, NULL,
                      NULL, 0, 0, 0, 0, 0, 0)
            """,
            (RUN_ID, now, scope),
        )
        connection.execute(
            """
            INSERT INTO sync_run_catalog_items (
                run_id, provider, textbook_external_id, catalog_external_id,
                parent_external_id, node_level, node_type, name, source_path,
                catalog_path, sort_order, captured_at
            ) VALUES (?, 'zujuan', ?, 'cat-1', NULL, 1, 'chapter', '第一章',
                      '/cat-1', '/第一章', 1, ?)
            """,
            (RUN_ID, TEXTBOOK_ID, now),
        )
        connection.execute(
            """
            INSERT INTO sync_run_question_items (
                run_id, provider, textbook_external_id, question_external_id,
                chapter_id, detail_url, source_short, source_title, source_url,
                question_type, question_type_id, difficulty_label, difficulty_code,
                ease_coefficient, content_html, plain_text, content_hash,
                list_content_hash, detail_content_hash, content_version,
                question_version, snapshot_version, detail_fetched,
                subquestion_count, child_count, has_image, has_formula, has_table,
                is_new, use_count, provider_updated_at, answer_html, analysis_html,
                answer_status, solution_html, raw_json, captured_at
            ) VALUES (
                ?, 'zujuan', ?, 'q-1', 'cat-1', 'https://zujuan.xkw.com/q-1',
                '测试来源', '测试试题', 'https://zujuan.xkw.com/q-1', '单选题', '1101',
                '容易', 'easy', 0.2, '<p>题干</p>', '题干', 'hash-q-1',
                'list-q-1', 'detail-q-1', 'v1', 1, 1, 1, 0, 0, 0, 0, 0, 0, 3,
                '2026-08-28T00:00:00.000Z', '<p>A</p>', '<p>因为 A</p>',
                'public_captured', '<p>A 因为 A</p>', '{}', ?
            )
            """,
            (RUN_ID, TEXTBOOK_ID, now),
        )
        connection.execute(
            """
            INSERT INTO sync_run_question_catalogs (
                run_id, provider, textbook_external_id, question_external_id,
                catalog_external_id, catalog_level, catalog_name, catalog_path,
                evidence_type, captured_at
            ) VALUES (?, 'zujuan', ?, 'q-1', 'cat-1', 1, '第一章', '/第一章',
                      'query_membership', ?)
            """,
            (RUN_ID, TEXTBOOK_ID, now),
        )
        connection.execute(
            """
            INSERT INTO sync_run_question_tags (
                run_id, provider, textbook_external_id, question_external_id,
                dimension, tag_external_id, tag_value, relation_type,
                evidence_type, query_fingerprint, captured_at, observed_at
            ) VALUES (?, 'zujuan', ?, 'q-1', 'knowledge', 'k-1', '一次函数',
                      'provider_asserted', 'provider_asserted', 'fingerprint-1', ?, ?)
            """,
            (RUN_ID, TEXTBOOK_ID, now, now),
        )
        connection.execute(
            """
            INSERT INTO sync_run_question_assets (
                run_id, provider, textbook_external_id, question_external_id,
                asset_key, asset_type, source_url, content_sha256, storage_path,
                mime_type, byte_size, captured_at, observed_at
            ) VALUES (?, 'zujuan', ?, 'q-1', 'image-1', 'image',
                      'https://assets.example/q-1.png', ?, 'assets/aa/q-1.png',
                      'image/png', 3, ?, ?)
            """,
            (RUN_ID, TEXTBOOK_ID, 'a' * 64, now, now),
        )
        # The real migration trigger allows the one-way transition from a
        # mutable running run to a complete, locked terminal snapshot.
        connection.execute(
            """
            UPDATE sync_runs
            SET status = 'completed', finished_at = ?, snapshot_locked_at = ?,
                snapshot_complete = 1, catalog_item_count = 1,
                question_item_count = 1, question_catalog_count = 1,
                question_tag_count = 1, question_asset_count = 1
            WHERE id = ?
            """,
            (now, now, RUN_ID),
        )
        connection.commit()
    finally:
        connection.close()


@pytest.fixture()
def sealed_collector_db(tmp_path: Path) -> Path:
    db_path = tmp_path / 'collector.sqlite3'
    _seed_sealed_run(db_path)
    return db_path


def _full_snapshot(db_path: Path) -> dict[str, Any]:
    return _node_json(
        """
        const { readRunSnapshot } = require('./collector/lib/api_store.cjs');
        const value = readRunSnapshot(process.argv[1], Number(process.argv[2]), {
          textbookExternalId: process.argv[3],
        });
        process.stdout.write(JSON.stringify(value));
        """,
        db_path,
        RUN_ID,
        TEXTBOOK_ID,
    )


def _summary(db_path: Path) -> dict[str, Any]:
    return _node_json(
        """
        const { readRunSnapshotSummary } = require('./collector/lib/api_store.cjs');
        const value = readRunSnapshotSummary(process.argv[1], Number(process.argv[2]), process.argv[3]);
        process.stdout.write(JSON.stringify(value));
        """,
        db_path,
        RUN_ID,
        TEXTBOOK_ID,
    )


def test_real_collector_schema_full_api_and_python_normalizer_preserve_answer_fields(
    sealed_collector_db: Path,
) -> None:
    """One sealed run must cross Node full API -> Python reader/normalizer."""

    connection = sqlite3.connect(sealed_collector_db)
    try:
        table_names = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sync_run_%'"
            )
        }
        assert {
            'sync_run_catalog_items',
            'sync_run_question_items',
            'sync_run_question_catalogs',
            'sync_run_question_tags',
            'sync_run_question_assets',
        } <= table_names
        question_columns = {
            str(row[1]) for row in connection.execute('PRAGMA table_info(sync_run_question_items)')
        }
        assert {'answer_html', 'analysis_html', 'answer_status'} <= question_columns
    finally:
        connection.close()

    full = _full_snapshot(sealed_collector_db)
    assert full['available'] is True
    assert full['immutable'] is True
    assert full['run']['status'] in {'success', 'completed'}
    assert full['run']['snapshotComplete'] is True
    assert full['counts'] == {
        'catalogItemCount': 1,
        'questionItemCount': 1,
        'questionCatalogCount': 1,
        'questionTagCount': 1,
        'questionAssetCount': 1,
        'catalogCount': 1,
        'questionCount': 1,
        'tagCount': 1,
        'assetCount': 1,
    }
    assert full['questions'][0]['answerHtml'] == '<p>A</p>'
    assert full['questions'][0]['analysisHtml'] == '<p>因为 A</p>'
    assert full['questions'][0]['answerStatus'] == 'public_captured'

    normalized = apply_module._normalise_snapshot(full, 9001, TEXTBOOK_ID)
    assert normalized['counts'] == {
        'catalogs': 1,
        'questions': 1,
        'questionCatalogs': 1,
        'tags': 1,
        'assets': 1,
    }
    question = normalized['questions'][0]
    assert question['answer_html'] == '<p>A</p>'
    assert question['analysis_html'] == '<p>因为 A</p>'
    # Collector keeps its capture-state vocabulary in the immutable row;
    # the formal-bank normalizer maps it to the bank answer-status enum.
    assert question['answer_status'] == 'available'


@pytest.mark.parametrize('failure', ('missing_count', 'wrong_count', 'unlocked', 'incomplete'))
def test_snapshot_normalizer_rejects_untrusted_header_or_count(
    sealed_collector_db: Path,
    failure: str,
) -> None:
    payload = copy.deepcopy(_full_snapshot(sealed_collector_db))
    run = payload['run']
    if failure == 'missing_count':
        # Remove every spelling for one counter from both the summary and the
        # run projection; a row-derived fallback is not valid for a
        # remote/full API response.
        for name in apply_module.SNAPSHOT_COUNT_FIELDS['assets']:
            payload['counts'].pop(name, None)
            run.pop(name, None)
    elif failure == 'wrong_count':
        payload['counts']['questionItemCount'] = 2
        run['questionItemCount'] = 2
        run['question_item_count'] = 2
    elif failure == 'unlocked':
        run.pop('snapshot_locked_at', None)
        run.pop('snapshotLockedAt', None)
        run.pop('locked', None)
    elif failure == 'incomplete':
        payload['snapshotComplete'] = False
        run['snapshot_complete'] = 0
        run['snapshotComplete'] = False
    else:  # pragma: no cover - guarded by parametrization
        raise AssertionError(failure)

    with pytest.raises(ServiceException):
        apply_module._normalise_snapshot(payload, 9001, TEXTBOOK_ID)


def test_snapshot_summary_is_bounded_and_matches_all_five_counts(sealed_collector_db: Path) -> None:
    summary = _summary(sealed_collector_db)
    assert summary['immutable'] is True
    assert summary['run']['status'] in {'success', 'completed'}
    assert summary['run']['snapshotComplete'] is True
    assert summary['scoped']['textbookExternalId'] == TEXTBOOK_ID
    assert summary['counts'] == {
        'catalogItemCount': 1,
        'questionItemCount': 1,
        'questionCatalogCount': 1,
        'questionTagCount': 1,
        'questionAssetCount': 1,
        'catalogCount': 1,
        'questionCount': 1,
        'tagCount': 1,
        'assetCount': 1,
    }
    normalized = apply_module._normalise_snapshot_summary(summary, 9001, TEXTBOOK_ID)
    assert normalized['collector_run_id'] == RUN_ID
    assert normalized['counts']['assets'] == 1
    for array_name in ('catalogs', 'questions', 'questionCatalogs', 'tags', 'assets'):
        assert array_name not in summary


def test_summary_route_and_client_wrapper_are_wired_without_starting_server() -> None:
    server_source = (PROJECT_ROOT / 'collector' / 'server.cjs').read_text(encoding='utf-8')
    assert 'readRunSnapshotSummary' in server_source
    assert '/snapshot-summary' in server_source

    calls: list[tuple[str, str, dict[str, Any]]] = []
    client = CollectorClient.__new__(CollectorClient)

    def request(method: str, path: str, *, query: dict[str, Any] | None = None) -> dict[str, Any]:
        calls.append((method, path, query or {}))
        return {'ok': True}

    client._request = request  # type: ignore[method-assign]
    assert client.run_snapshot_summary(42, textbook_external_id=TEXTBOOK_ID) == {'ok': True}
    assert calls == [
        ('GET', '/v1/runs/42/snapshot-summary', {'textbookExternalId': TEXTBOOK_ID}),
    ]
