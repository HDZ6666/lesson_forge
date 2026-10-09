"""Bounded quality checks for sealed full or partial collection results.

This module produces resumable verdicts; it never writes formal bank tables
or changes the legacy complete-snapshot apply state.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import zlib
from collections import defaultdict
from contextlib import closing
from pathlib import Path
from typing import Any, Iterator

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbCatalogNode
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.large_snapshot_reader import (
    MAX_CHUNK_QUESTIONS,
    LargeSnapshotReader,
    _check_formal_column_lengths,
    _check_formal_rows,
    _unpack,
)
from plugins.bank.service.large_snapshot_spool import _json_bytes, spool_snapshot
from plugins.bank.service.question_apply_service import (
    _asset_root,
    _jsonable,
    _normalise_catalog_rows,
    _normalise_snapshot,
    _pick,
    _safe_external_id,
)
from plugins.bank.service.question_readiness import probe_stem

QC_FORMAT = 'sealed-question-qc-v2'
MAX_CATALOG_ROWS = 10_000
MAX_QC_BATCH = 100
MAX_QUESTION_DEPENDENT_ROWS = 500


def _source_question_id(row: dict[str, Any]) -> str:
    return str(
        _pick(row, 'question_external_id', 'questionExternalId', 'externalQuestionId', 'externalId', default='') or ''
    ).strip()


def _source_catalog_id(row: dict[str, Any]) -> str:
    return str(
        _pick(
            row,
            'catalog_external_id',
            'catalogExternalId',
            'externalCatalogId',
            'externalNodeId',
            'externalId',
            default='',
        )
        or ''
    ).strip()


class SealedSnapshotReader(LargeSnapshotReader):
    def __init__(self, path: Path, summary: dict[str, Any], task_id: int, textbook_id: str) -> None:
        super().__init__(path, summary, task_id, textbook_id, sealed_for_import=True)

    def quality_batches(self, *, size: int = 100, start: int = 0) -> Iterator[dict[str, Any]]:
        """Block damaged identities/trees; isolate row-level content failures.

        A whole tree is checked once. Each question is then normalized with
        only its referenced nodes and ancestors, avoiding tree × question work.
        """
        if isinstance(size, bool) or not 1 <= size <= min(MAX_QC_BATCH, MAX_CHUNK_QUESTIONS):
            raise ValueError('quality-check batch size must be 1..100')
        if isinstance(start, bool) or not 0 <= start <= self.counts['questions']:
            raise ValueError('invalid quality-check cursor')
        if self.counts['catalogs'] > MAX_CATALOG_ROWS:
            raise ServiceException(message='教材目录数超过检查预算，需先核对目录结构')
        self.validate_links()
        catalogs = self._rows('catalogs')
        normalized_catalogs = _normalise_catalog_rows(catalogs, self.task_id, self.textbook_id)
        for row in normalized_catalogs:
            _check_formal_column_lengths(
                QbCatalogNode,
                {
                    'external_node_id': row['external_id'],
                    'node_name': row['node_name'],
                    'node_type': row['node_type'],
                    'source_url': row['source_url'],
                },
                label=f'目录 {row["external_id"]}',
            )
        raw_catalogs = {_source_catalog_id(row): row for row in catalogs}
        parents = {row['external_id']: row['parent_external_id'] for row in normalized_catalogs}

        # Identity/scope damage is not an ordinary bad question. Validate every
        # row before emitting any accepted result, using a streaming cursor.
        for collection, payload in self.db.execute('SELECT collection,payload FROM rows ORDER BY collection,ordinal'):
            row = _unpack(payload)
            provider = _pick(row, 'provider', 'sourceProvider', 'source_provider', default='')
            textbook = _pick(row, 'textbook_external_id', 'textbookExternalId', 'externalTextbookId', default='')
            if provider != 'zujuan' or str(textbook) != self.textbook_id:
                raise ServiceException(message=f'{collection} 快照行的来源或教材身份不一致')
            if collection != 'catalogs' and not _safe_external_id(_source_question_id(row)):
                raise ServiceException(message=f'{collection} 快照行缺少稳定题目 ID')
            if collection == 'questionCatalogs' and _source_catalog_id(row) not in raw_catalogs:
                raise ServiceException(message='目录关系引用了本教材快照之外的目录')

        cursor = start
        while cursor < self.counts['questions']:
            entries = [
                (ordinal, _unpack(payload))
                for ordinal, payload in self.db.execute(
                    "SELECT ordinal,payload FROM rows WHERE collection='questions' AND ordinal>=? "
                    'ORDER BY ordinal LIMIT ?',
                    (cursor, size),
                )
            ]
            if not entries or [ordinal for ordinal, _ in entries] != list(range(cursor, cursor + len(entries))):
                raise ServiceException(message='题目暂存游标不连续')
            ids = [_source_question_id(row) for _, row in entries]
            placeholders = ','.join('?' for _ in ids)
            oversized = {
                question_id
                for question_id, count in self.db.execute(
                    'SELECT question_external_id,COUNT(*) FROM rows '
                    "WHERE collection IN ('questionCatalogs','tags','assets') "
                    f'AND question_external_id IN ({placeholders}) GROUP BY question_external_id',
                    ids,
                )
                if count > MAX_QUESTION_DEPENDENT_ROWS
            }
            readable_ids = [question_id for question_id in ids if question_id not in oversized]
            children: dict[str, dict[str, list[dict[str, Any]]]] = {}
            for collection in ('questionCatalogs', 'tags', 'assets'):
                grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
                for row in self._rows(collection, readable_ids):
                    grouped[_source_question_id(row)].append(row)
                children[collection] = grouped
            verdicts = []
            for ordinal, question in entries:
                question_id = _source_question_id(question)
                if question_id in oversized:
                    verdicts.append(
                        {
                            'ordinal': ordinal,
                            'questionId': question_id,
                            'status': 'quarantined',
                            'normalized': None,
                            'reason': '单题关系/素材数量超过检查预算，需人工核对',
                        }
                    )
                    continue
                related = children['questionCatalogs'][question_id]
                catalog_ids = {_source_catalog_id(row) for row in related}
                for node in list(catalog_ids):
                    while parents.get(node):
                        node = str(parents[node])
                        catalog_ids.add(node)
                selected_catalogs = [raw_catalogs[node] for node in sorted(catalog_ids)]
                owned = {name: children[name][question_id] for name in children}
                stem_keys = set(probe_stem({'content_html': _pick(question, 'content_html', 'contentHtml'),
                                            'plain_text': _pick(question, 'plain_text', 'plainText')})['keys'])
                optional_failures = []
                readable_assets = []
                for asset in owned['assets']:
                    key = str(_pick(asset, 'asset_key', 'assetKey', default='') or '').strip()
                    digest = str(_pick(asset, 'content_sha256', 'contentSha256', 'sha256',
                                       'file_hash', 'fileHash', default='') or '').strip().lower()
                    status = str(_pick(asset, 'download_status', 'downloadStatus', default='downloaded') or '')
                    if key not in stem_keys and (status != 'downloaded' or not re.fullmatch(r'[0-9a-f]{64}', digest)):
                        optional_failures.append(key)
                    else:
                        readable_assets.append(asset)
                if optional_failures:
                    # The immutable staging rows still retain the failed
                    # answer assets. A stem import must neither reject this
                    # question nor overwrite earlier trusted answers with an
                    # incomplete new answer/analysis observation.
                    question = {**question, 'answer_status': 'not_collected', 'answer_html': None, 'analysis_html': None}
                    owned['assets'] = readable_assets
                raw = {
                    'available': True,
                    'immutable': True,
                    'snapshotComplete': self.summary['snapshot_complete'],
                    'run': self.run,
                    'counts': {
                        'catalogItemCount': len(selected_catalogs),
                        'questionItemCount': 1,
                        'questionCatalogCount': len(related),
                        'questionTagCount': len(owned['tags']),
                        'questionAssetCount': len(owned['assets']),
                    },
                    'catalogs': selected_catalogs,
                    'questions': [question],
                    **owned,
                }
                try:
                    normalized = _normalise_snapshot(raw, self.task_id, self.textbook_id, sealed_for_import=True)
                    _check_formal_rows(normalized)
                    normalized['task_id'] = self.task_id
                    verdict = {
                        'ordinal': ordinal,
                        'questionId': question_id,
                        'status': 'accepted',
                        'normalized': normalized,
                        'reason': None,
                    }
                except ServiceException as exc:
                    verdict = {
                        'ordinal': ordinal,
                        'questionId': question_id,
                        'status': 'quarantined',
                        'normalized': None,
                        'reason': str(exc.message),
                    }
                verdicts.append(verdict)
            yield {
                'start': cursor,
                'nextCursor': cursor + len(entries),
                'verdicts': verdicts,
                'snapshotComplete': self.summary['snapshot_complete'],
            }
            cursor += len(entries)


def check_sealed_snapshot(
    reader: SealedSnapshotReader, path: Path, *, size: int = 100, on_progress: Any = None
) -> dict[str, Any]:
    """Commit verdicts and cursor together; resume without duplicating results."""
    identity = _json_bytes(
        {
            'format': QC_FORMAT,
            'taskId': reader.task_id,
            'runId': reader.summary['collector_run_id'],
            'textbookId': reader.textbook_id,
            'counts': reader.counts,
            'snapshotComplete': reader.summary['snapshot_complete'],
            'snapshotLockedAt': reader.run.get('snapshotLockedAt', reader.run.get('snapshot_locked_at')),
        }
    )
    with closing(sqlite3.connect(path)) as db:
        # Fail before creating a second spool at an unrelated path.
        spool_identity = db.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()
        if (
            not spool_identity
            or spool_identity[0] != reader.db.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()[0]
        ):
            raise ServiceException(message='检查结果路径与已验证暂存不一致')
        db.execute('PRAGMA synchronous=FULL')
        db.execute("""CREATE TABLE IF NOT EXISTS qc_questions (
            ordinal INTEGER PRIMARY KEY, question_id TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL, reason TEXT, normalized BLOB)""")
        previous = db.execute("SELECT value FROM metadata WHERE key='qc_identity'").fetchone()
        if previous and previous[0] != identity:
            raise ServiceException(message='检查协议或任务身份已变化，不能混用原检查断点')
        cursor_row = db.execute("SELECT value FROM metadata WHERE key='qc_cursor'").fetchone()
        cursor = int(cursor_row[0]) if cursor_row else 0
        bounds = db.execute('SELECT COUNT(*),MIN(ordinal),MAX(ordinal) FROM qc_questions').fetchone()
        expected_bounds = (cursor, 0 if cursor else None, cursor - 1 if cursor else None)
        if not 0 <= cursor <= reader.counts['questions'] or bounds != expected_bounds:
            raise ServiceException(message='检查结果与断点计数不一致')
        for batch in reader.quality_batches(size=size, start=cursor):
            with db:
                db.executemany(
                    'INSERT INTO qc_questions VALUES (?,?,?,?,?)',
                    [
                        (
                            item['ordinal'],
                            item['questionId'],
                            item['status'],
                            item['reason'],
                            zlib.compress(_json_bytes(_jsonable(item['normalized'])), level=1)
                            if item['normalized']
                            else None,
                        )
                        for item in batch['verdicts']
                    ],
                )
                db.execute("INSERT OR REPLACE INTO metadata VALUES ('qc_identity',?)", (identity,))
                db.execute(
                    "INSERT OR REPLACE INTO metadata VALUES ('qc_cursor',?)", (str(batch['nextCursor']).encode(),)
                )
            if on_progress:
                on_progress(batch['nextCursor'], reader.counts['questions'])
        counts = dict(db.execute('SELECT status,COUNT(*) FROM qc_questions GROUP BY status'))
        digest = hashlib.sha256()
        digest.update(identity)
        for ordinal, question_id, status, reason, normalized in db.execute(
            'SELECT * FROM qc_questions ORDER BY ordinal'
        ):
            digest.update(
                _json_bytes([ordinal, question_id, status, reason, hashlib.sha256(normalized or b'').hexdigest()])
            )
        report = {
            'checked': reader.counts['questions'],
            'accepted': counts.get('accepted', 0),
            'quarantined': counts.get('quarantined', 0),
            'snapshotComplete': reader.summary['snapshot_complete'],
            'qualityHash': digest.hexdigest(),
            'format': QC_FORMAT,
            'taskId': reader.task_id,
            'collectorRunId': reader.summary['collector_run_id'],
            'textbookExternalId': reader.textbook_id,
            'snapshotLockedAt': reader.run.get('snapshotLockedAt', reader.run.get('snapshot_locked_at')),
        }
        with db:
            db.execute("INSERT OR REPLACE INTO metadata VALUES ('qc_report',?)", (_json_bytes(report),))
        return report


def read_checked_batch(path: Path, ticket: dict[str, Any], *, size: int = 100) -> list[dict[str, Any]]:
    """Read persisted QC verdicts from the durable import cursor, with no recheck."""
    cursor = ticket.get('cursor')
    if type(size) is not int or not 1 <= size <= MAX_QC_BATCH or type(cursor) is not int or cursor < 0:
        raise ServiceException(message='质量检查读取断点或批次大小无效')
    with closing(sqlite3.connect(f'file:{path}?mode=ro', uri=True)) as db:
        report_row = db.execute("SELECT value FROM metadata WHERE key='qc_report'").fetchone()
        cursor_row = db.execute("SELECT value FROM metadata WHERE key='qc_cursor'").fetchone()
        if not report_row or not cursor_row:
            raise ServiceException(message='质量检查尚未完成，不能开始入库')
        report = json.loads(report_row[0])
        if (
            report.get('format') != QC_FORMAT
            or report.get('qualityHash') != ticket.get('qualityHash')
            or report.get('taskId') != ticket.get('taskId')
            or report.get('collectorRunId') != ticket.get('collectorRunId')
            or report.get('textbookExternalId') != ticket.get('textbookExternalId')
            or report.get('snapshotComplete') != ticket.get('snapshotComplete')
            or report.get('checked') != ticket.get('checkedCount')
            or int(cursor_row[0]) != report['checked']
            or cursor > report['checked']
        ):
            raise ServiceException(message='已存检查结果与入库租约身份不一致')
        rows = db.execute(
            'SELECT ordinal,question_id,status,reason,normalized FROM qc_questions WHERE ordinal>=? '
            'ORDER BY ordinal LIMIT ?',
            (cursor, size),
        ).fetchall()
        if [row[0] for row in rows] != list(range(cursor, min(cursor + size, report['checked']))):
            raise ServiceException(message='已存检查结果不连续，停止入库')
        return [
            {
                'ordinal': ordinal,
                'questionId': question_id,
                'status': status,
                'reason': reason,
                'normalized': _unpack(normalized) if normalized else None,
            }
            for ordinal, question_id, status, reason, normalized in rows
        ]


def main() -> None:
    parser = argparse.ArgumentParser(description='Check sealed full/partial results without formal writes')
    parser.add_argument('run_id', type=int)
    parser.add_argument('textbook_id')
    parser.add_argument('--task-id', type=int, required=True)
    parser.add_argument('--path', type=Path)
    args = parser.parse_args()
    client = CollectorClient()
    path = args.path or _asset_root() / 'imports' / f'incremental-{args.run_id}-{args.textbook_id}.sqlite3'
    spool_snapshot(client, args.run_id, args.textbook_id, path, sealed_for_import=True)
    summary = client.run_snapshot_summary(args.run_id, textbook_external_id=args.textbook_id, sealed_for_import=True)
    with SealedSnapshotReader(path, summary, args.task_id, args.textbook_id) as reader:
        report = check_sealed_snapshot(reader, path)
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
