from __future__ import annotations

import hashlib
import json
import sqlite3
import zipfile
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

import pytest

from plugins.bank.publisher import DATASET_TABLES, PackageError, build_rename_sql, verify_package
from plugins.bank.publisher.worker import MySQLPublisher

TABLES = (
    'qb_textbook_version',
    'qb_textbook',
    'qb_catalog_node',
    'qb_question',
    'qb_question_catalog',
    'qb_question_tag',
    'qb_question_asset',
)
RENAME_PAIR_COUNT = 16
ASSEMBLE_COUNT = 3
STALE_BATCH_ID = 10


def _package(tmp_path: Path, *, tamper: str | None = None) -> Path:
    snapshot = tmp_path / 'snapshot.sqlite3'
    db = sqlite3.connect(snapshot)
    db.executescript(
        """
        CREATE TABLE qb_textbook_version (provider TEXT NOT NULL, external_id TEXT NOT NULL, version_name TEXT NOT NULL, subject TEXT, grade TEXT, edition TEXT, source_url TEXT, metadata_json TEXT NOT NULL, PRIMARY KEY(provider, external_id));
        CREATE TABLE qb_textbook (provider TEXT NOT NULL, external_id TEXT NOT NULL, version_external_id TEXT NOT NULL, textbook_name TEXT NOT NULL, subject TEXT, grade TEXT, edition TEXT, volume TEXT, source_url TEXT, metadata_json TEXT NOT NULL, PRIMARY KEY(provider, external_id));
        CREATE TABLE qb_catalog_node (provider TEXT NOT NULL, external_id TEXT NOT NULL, textbook_external_id TEXT, parent_external_id TEXT, node_level INTEGER, node_type TEXT, name TEXT NOT NULL, source_path TEXT, active INTEGER NOT NULL DEFAULT 1, metadata_json TEXT NOT NULL, PRIMARY KEY(provider, external_id));
        CREATE TABLE qb_question (provider TEXT NOT NULL, external_id TEXT NOT NULL, textbook_version_external_id TEXT, textbook_external_id TEXT, detail_url TEXT, source_short TEXT, source_title TEXT, source_url TEXT, source_original_json TEXT NOT NULL, question_type TEXT, question_type_id TEXT, difficulty_label TEXT, difficulty_code TEXT, ease_coefficient REAL, content_html TEXT, plain_text TEXT, content_hash TEXT, subquestion_count INTEGER NOT NULL DEFAULT 0, child_count INTEGER, has_image INTEGER NOT NULL DEFAULT 0, has_formula INTEGER NOT NULL DEFAULT 0, has_table INTEGER NOT NULL DEFAULT 0, is_new INTEGER NOT NULL DEFAULT 0, assemble_count INTEGER, reference_count INTEGER, year TEXT, region TEXT, exam_type TEXT, answer_html TEXT, solution_html TEXT, answer_status TEXT NOT NULL, first_seen_at TEXT, last_seen_at TEXT, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(provider, external_id));
        CREATE TABLE qb_question_catalog (provider TEXT NOT NULL, question_external_id TEXT NOT NULL, catalog_external_id TEXT NOT NULL, relation_type TEXT NOT NULL, evidence_type TEXT NOT NULL, query_fingerprint TEXT, observed_at TEXT, PRIMARY KEY(provider, question_external_id, catalog_external_id, relation_type, evidence_type, query_fingerprint));
        CREATE TABLE qb_question_tag (provider TEXT NOT NULL, question_external_id TEXT NOT NULL, dimension TEXT NOT NULL, tag_external_id TEXT, tag_value TEXT NOT NULL, relation_type TEXT NOT NULL, evidence_type TEXT NOT NULL, query_fingerprint TEXT, observed_at TEXT, PRIMARY KEY(provider, question_external_id, dimension, tag_external_id, tag_value, relation_type, evidence_type, query_fingerprint));
        CREATE TABLE qb_question_asset (provider TEXT NOT NULL, question_external_id TEXT NOT NULL, asset_key TEXT NOT NULL, asset_type TEXT NOT NULL, source_url TEXT NOT NULL, content_sha256 TEXT, storage_path TEXT, mime_type TEXT, byte_size INTEGER, observed_at TEXT, PRIMARY KEY(provider, question_external_id, asset_key));
        """
    )
    db.execute(
        'INSERT INTO qb_textbook_version VALUES (?,?,?,?,?,?,?,?)',
        ('test', 'v1', 'Version 1', None, None, None, None, '{}'),
    )
    db.execute(
        'INSERT INTO qb_textbook VALUES (?,?,?,?,?,?,?,?,?,?)',
        ('test', 'tb1', 'v1', 'Textbook', None, None, None, '上册', None, '{}'),
    )
    db.execute(
        'INSERT INTO qb_catalog_node VALUES (?,?,?,?,?,?,?,?,?,?)',
        ('test', 'c1', 'tb1', None, 1, 'chapter', 'Chapter', '/c1', 1, '{}'),
    )
    db.execute(
        'INSERT INTO qb_question VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        (
            'test',
            'q1',
            'v1',
            'tb1',
            'https://example/q',
            'short',
            'paper',
            None,
            '{}',
            'single',
            '1',
            'easy',
            None,
            0.5,
            '<p>Q</p>',
            'Q',
            'a' * 64,
            0,
            0,
            0,
            0,
            0,
            0,
            7,
            None,
            '2025',
            None,
            None,
            None,
            None,
            'not_collected',
            None,
            None,
            1,
        ),
    )
    db.execute(
        'INSERT INTO qb_question_catalog VALUES (?,?,?,?,?,?,?)',
        ('test', 'q1', 'c1', 'query_catalog', 'query_membership', 'fp', '2026-01-01T00:00:00Z'),
    )
    db.commit()
    db.close()
    manifest = {
        'formatVersion': '1',
        'schemaVersion': '2',
        'batchNo': 'b1',
        'createdAt': '2026-01-01T00:00:00Z',
        'sourceProvider': 'test',
        'fullSnapshot': True,
        'dataset': {
            'provider': 'test',
            'versionName': 'Version 1',
            'textbookName': 'Textbook',
            'versionExternalId': 'v1',
            'textbookExternalId': 'tb1',
        },
        'counts': {table: int(db_count) for table, db_count in zip(TABLES, (1, 1, 1, 1, 1, 0, 0), strict=True)},
        'snapshotSha256': hashlib.sha256(snapshot.read_bytes()).hexdigest(),
        'rangeEvidence': {'scope': {'chapters': ['c1']}, 'completed': True},
    }
    files = {
        'manifest.json': json.dumps(manifest, separators=(',', ':')).encode(),
        'snapshot.sqlite3': snapshot.read_bytes(),
        'diff-report.json': b'{}',
        'validation.json': json.dumps({'blocking': [], 'warnings': [], 'checks': [], 'pass': True}).encode(),
    }
    if tamper == 'snapshot':
        files['snapshot.sqlite3'] += b'tampered'
    if tamper == 'path':
        files['../evil.txt'] = b'x'
    checksum = '\n'.join(f'{hashlib.sha256(files[name]).hexdigest()}  {name}' for name in sorted(files)) + '\n'
    files['checksums.sha256'] = checksum.encode()
    package = tmp_path / 'sample.qbpkg'
    with zipfile.ZipFile(package, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return package


def test_verify_real_qbpkg_and_reject_tampered_checksum(tmp_path: Path) -> None:
    package = _package(tmp_path)
    verified = verify_package(package)
    assert verified.manifest['batchNo'] == 'b1'
    assert verified.snapshot.is_file()
    (tmp_path / 'bad').mkdir()
    with pytest.raises(PackageError, match='不匹配'):
        verify_package(_package(tmp_path / 'bad', tamper='snapshot'))


def test_zip_slip_is_rejected_before_extraction(tmp_path: Path) -> None:
    bad = tmp_path / 'bad'
    bad.mkdir()
    package = _package(bad, tamper='path')
    with pytest.raises(PackageError, match=r'白名单|路径不安全'):
        verify_package(package)
    assert not (tmp_path / 'evil.txt').exists()


def test_rename_is_one_eight_table_statement_and_supports_first_publish() -> None:
    sql = build_rename_sql(0, 12)
    assert sql.startswith('RENAME TABLE ')
    assert sql.count('RENAME TABLE') == 1
    assert sql.count(' TO ') == RENAME_PAIR_COUNT
    assert '`qb_dataset_meta` TO `qb_dataset_meta_old_0`' in sql
    assert '`qb_dataset_meta_next_12` TO `qb_dataset_meta`' in sql


def test_question_mapping_matches_contract() -> None:
    row = {
        'year': '2025',
        'detail_url': 'u',
        'source_short': 'short',
        'source_title': 'paper',
        'region': 'region',
        'exam_type': 'exam',
        'question_type': 'single',
        'difficulty_label': 'easy',
        'ease_coefficient': 0.5,
        'content_html': 'h',
        'plain_text': 'p',
        'answer_html': None,
        'solution_html': None,
        'answer_status': 'not_collected',
        'subquestion_count': 0,
        'assemble_count': ASSEMBLE_COUNT,
        'is_new': 1,
        'content_hash': 'h' * 64,
        'source_original_json': '{}',
        'last_seen_at': None,
        'active': 1,
    }
    values = MySQLPublisher._question_values(row, 9, '2026-01-01 00:00:00')
    assert values[0] == 'u'  # source_url
    assert values[1] is None  # source_question_no is absent from snapshot
    assert values[2] == 'short'  # source_text
    assert values[3] == 'paper'  # paper_name
    assert values[20] == ASSEMBLE_COUNT  # assemble_count
    assert values[21] is None  # reference_count
    assert values[17] == 'unknown'  # snapshot not_collected -> MySQL qb_answer_status


class RecordingPublisher(MySQLPublisher):
    def __init__(self) -> None:
        super().__init__(object())
        self.executed: list[str] = []
        self.statuses: list[tuple[int, str]] = []

    def _table_exists(self, name: str) -> bool:
        return False

    def acquire_lock(self) -> None:
        return None

    def release_lock(self) -> None:
        return None

    def _execute(self, sql: str, args: Any = ()) -> None:
        self.executed.append(sql)

    def _commit(self) -> None:
        return None

    def _rollback(self) -> None:
        return None

    def _set_batch(self, bid: int, status: str, **_: Any) -> None:
        self.statuses.append((bid, status))


def test_process_failure_marks_failed_without_rename(tmp_path: Path) -> None:
    publisher = RecordingPublisher()
    publisher._build_candidate = lambda *_args: {'pass': False, 'blocking': ['test']}  # type: ignore[method-assign]
    publisher._drop_exact_group = lambda *_args: None  # type: ignore[method-assign]
    package = _package(tmp_path)
    with pytest.raises(PackageError, match='候选数据二次校验失败'):
        publisher.process(9, package)
    assert (9, 'validating') in publisher.statuses
    assert (9, 'failed') in publisher.statuses
    assert not any(sql.startswith('RENAME TABLE') for sql in publisher.executed)


def test_process_success_finishes_at_approval_pending(tmp_path: Path) -> None:
    publisher = RecordingPublisher()
    publisher._build_candidate = lambda *_args: {'pass': True, 'blocking': []}  # type: ignore[method-assign]
    package = _package(tmp_path)
    result = publisher.process(9, package)
    assert result['pass'] is True
    assert publisher.statuses[-2:] == [(9, 'validated'), (9, 'approval_pending')]


def test_validated_batch_cannot_publish() -> None:
    publisher = RecordingPublisher()
    publisher._fetchone = lambda *_args: {'status': 'validated'}  # type: ignore[method-assign]
    with pytest.raises(PackageError, match='状态不允许发布'):
        publisher.publish(9)


def test_get_lock_failure_is_a_hard_error() -> None:
    class Cursor:
        description = (('acquired',),)

        def execute(self, _sql: str, _args: Any) -> None:
            return None

        def fetchone(self) -> dict[str, int]:
            return {'acquired': 0}

    class Connection:
        def cursor(self) -> Cursor:
            return Cursor()

    with pytest.raises(PackageError, match='发布锁'):
        MySQLPublisher(Connection()).acquire_lock()


def test_recover_repairs_switched_batch_and_reports_stale_next() -> None:
    publisher = RecordingPublisher()
    publisher._current_meta = lambda: {'current_batch_id': 9}  # type: ignore[method-assign]
    publisher._fetchall = lambda *_args: [{'batch_id': 9}, {'batch_id': 10}]  # type: ignore[method-assign]
    publisher._fetchone = lambda *_args: {'batch_type': 'full', 'status': 'publishing'}  # type: ignore[method-assign]
    publisher._existing_group = lambda kind, bid: (
        [  # type: ignore[method-assign]
            f'{base}_{kind}_{bid}' for base in DATASET_TABLES
        ]
        if bid == STALE_BATCH_ID
        else []
    )
    result = publisher.recover()
    assert result == {'current_batch_id': 9, 'repaired': [9], 'stale_next': [STALE_BATCH_ID]}
    assert publisher.statuses == [(9, 'published')]


def test_recover_rollback_finishes_as_rolled_back() -> None:
    publisher = RecordingPublisher()
    publisher._current_meta = lambda: {'current_batch_id': 10}  # type: ignore[method-assign]
    publisher._fetchall = lambda *_args: [{'batch_id': STALE_BATCH_ID}]  # type: ignore[method-assign]
    publisher._fetchone = lambda *_args: {'batch_type': 'rollback', 'status': 'publishing'}  # type: ignore[method-assign]
    result = publisher.recover()
    assert result['repaired'] == [STALE_BATCH_ID]
    assert publisher.statuses == [(STALE_BATCH_ID, 'rolled_back')]


def test_rollback_uses_request_id_and_does_not_modify_target_batch() -> None:
    publisher = RecordingPublisher()
    metas = iter(({'current_batch_id': 2}, {'current_batch_id': 9}))
    publisher._current_meta = lambda: next(metas)  # type: ignore[method-assign]
    publisher._fetchone = lambda _sql, args=(): (  # type: ignore[method-assign]
        {'batch_type': 'rollback', 'status': 'publishing', 'restored_from_batch_id': 1} if tuple(args) == (9,) else None
    )
    publisher._existing_group = lambda _kind, _bid: [  # type: ignore[method-assign]
        f'{base}_old_1' for base in DATASET_TABLES
    ]
    publisher._table_exists = lambda _name: True
    publisher._fetchall = lambda _sql: [{'Field': 'question_id'}]
    result = publisher.rollback(9)
    reset = 'UPDATE `qb_question_old_1` SET readiness_revision=NULL'
    rename_position = next(i for i, sql in enumerate(publisher.executed) if sql.startswith('RENAME TABLE'))
    assert publisher.executed.index(reset) < rename_position
    rename_statements = [sql for sql in publisher.executed if sql.startswith('RENAME TABLE')]
    assert result == {
        'pass': True,
        'request_batch_id': 9,
        'target_batch_id': 1,
        'current_batch_id': 9,
        'previous_batch_id': 2,
    }
    assert len(rename_statements) == 1
    assert rename_statements[0].count(' TO ') == RENAME_PAIR_COUNT
    assert 'qb_sync_batch' not in rename_statements[0]
    assert publisher.statuses == [(9, 'rolled_back')]


def test_cleanup_stops_on_incomplete_group_without_drop() -> None:
    publisher = RecordingPublisher()
    publisher._current_meta = lambda: {'current_batch_id': 2, 'previous_batch_id': 1}  # type: ignore[method-assign]
    publisher._fetchall = lambda *_args: [{'Tables_in_ruoyi': 'qb_question_old_7'}]  # type: ignore[method-assign]
    result = publisher.cleanup(now=10_000, retain_seconds=0)
    assert result['stopped'] is True
    assert result['reported'] == ['incomplete:old:7']
    assert not any(sql.startswith('DROP TABLE') for sql in publisher.executed)


def test_run_pending_routes_full_and_rollback_requests() -> None:
    publisher = RecordingPublisher()
    publisher._fetchall = lambda *_args: [  # type: ignore[method-assign]
        {'batch_id': 7, 'batch_type': 'full'},
        {'batch_id': 8, 'batch_type': 'rollback'},
    ]
    published: list[int] = []
    rolled_back: list[int] = []
    publisher.publish = published.append  # type: ignore[method-assign]
    publisher.rollback = rolled_back.append  # type: ignore[method-assign]

    assert publisher.run_pending(limit=2) == {'completed': [7, 8], 'failed': []}
    assert published == [7]
    assert rolled_back == [8]


def test_candidate_readiness_reset_repairs_old_schema_before_swap(monkeypatch):
    publisher = RecordingPublisher()
    monkeypatch.setattr(publisher, '_table_exists', lambda _name: True)
    monkeypatch.setattr(publisher, '_fetchall', lambda _sql: [{'Field': 'question_id'}])
    publisher._reset_candidate_readiness('qb_question_old_1')
    assert publisher.executed == [
        'ALTER TABLE `qb_question_old_1` ADD COLUMN readiness_revision CHAR(32) NULL',
        'UPDATE `qb_question_old_1` SET readiness_revision=NULL',
    ]
    monkeypatch.setattr(publisher, '_fetchall', lambda _sql: [{'Field': 'readiness_revision'}])
    publisher.executed.clear()
    publisher._reset_candidate_readiness('qb_question_next_2')
    assert publisher.executed == ['UPDATE `qb_question_next_2` SET readiness_revision=NULL']
    with pytest.raises(PackageError, match='候选表'):
        publisher._reset_candidate_readiness('qb_question')
