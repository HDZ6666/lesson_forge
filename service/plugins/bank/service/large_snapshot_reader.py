"""Bounded validation and normalization of a staged collector snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import zlib
from pathlib import Path
from typing import TYPE_CHECKING, Any

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbCatalogNode, QbQuestion, QbQuestionAsset, QbQuestionTag
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.question_apply_service import (
    SNAPSHOT_COUNT_FIELDS,
    _asset_root,
    _canonical_hash,
    _normalise_snapshot,
    _normalise_snapshot_summary,
)

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping

MAX_CHUNK_QUESTIONS = 500


def _check_formal_column_lengths(model: Any, values: dict[str, Any], *, label: str) -> None:
    """Reject rows that MySQL would truncate only after a long asset download."""
    for field, value in values.items():
        if value is None:
            continue
        column = model.__table__.columns.get(field)
        if column is None:
            continue
        limit = getattr(column.type, 'length', None)
        if limit is not None and isinstance(value, str) and len(value) > limit:
            raise ServiceException(message=f'{label} 的 {field} 长度 {len(value)} 超过正式表上限 {limit}')


def _check_formal_rows(snapshot: dict[str, Any]) -> None:
    for item in snapshot['catalogs']:
        _check_formal_column_lengths(QbCatalogNode, {
            'external_node_id': item['external_id'], 'node_name': item['node_name'],
            'node_type': item['node_type'], 'source_url': item['source_url'],
        }, label=f"目录 {item['external_id']}")
    for item in snapshot['questions']:
        _check_formal_column_lengths(QbQuestion, {
            **item, 'external_question_id': item['external_id'],
        }, label=f"题目 {item['external_id']}")
    for item in snapshot['tags']:
        _check_formal_column_lengths(QbQuestionTag, item, label=f"题目 {item['question_external_id']} 的标签")
    for item in snapshot['assets']:
        _check_formal_column_lengths(QbQuestionAsset, item, label=f"题目 {item['question_external_id']} 的素材")


def _unpack(payload: bytes) -> dict[str, Any]:
    value = json.loads(zlib.decompress(payload))
    if not isinstance(value, dict):
        raise ServiceException(message='暂存快照包含非对象行')
    return value


class LargeSnapshotReader:
    """Read at most one question batch and its dependent rows into memory."""

    def __init__(
        self,
        path: Path,
        summary: Mapping[str, Any],
        task_id: int,
        textbook_id: str,
        *,
        sealed_for_import: bool = False,
    ) -> None:
        self.task_id = task_id
        self.textbook_id = textbook_id
        self.sealed_for_import = sealed_for_import
        self.summary = _normalise_snapshot_summary(summary, task_id, textbook_id, sealed_for_import=sealed_for_import)
        self.counts = self.summary['counts']
        self.db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
        self.db.row_factory = sqlite3.Row
        identity_row = self.db.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()
        complete_row = self.db.execute("SELECT value FROM metadata WHERE key='complete'").fetchone()
        if not identity_row or not complete_row or complete_row[0] != b'1':
            self.close()
            raise ServiceException(message='题库快照暂存尚未完成')
        identity = json.loads(identity_row[0])
        run = self.summary['run']
        locked_at = str(run.get('snapshotLockedAt') or run.get('snapshot_locked_at'))
        if (
            identity.get('runId') != self.summary['collector_run_id']
            or identity.get('textbookExternalId') != textbook_id
            or identity.get('snapshotLockedAt') != locked_at
            or identity.get('counts') != self.counts
            or (sealed_for_import and (identity.get('policy') != 'sealed-incremental-v2' or identity.get('snapshotComplete') != self.summary['snapshot_complete']))
        ):
            self.close()
            raise ServiceException(message='题库快照暂存与当前 Collector 运行信息不一致')
        self.run = dict(run)
        for aliases in SNAPSHOT_COUNT_FIELDS.values():
            for name in aliases:
                self.run.pop(name, None)

    def close(self) -> None:
        self.db.close()

    def __enter__(self) -> LargeSnapshotReader:
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()

    def validate_links(self) -> None:
        """Check global identities and foreign references before any formal write."""
        # The staging transport guarantees ordinal uniqueness. Source IDs
        # must also be unique across pages, not merely within a batch.
        duplicate = self.db.execute('''
            SELECT question_external_id FROM rows
            WHERE collection='questions'
            GROUP BY question_external_id HAVING COUNT(*) > 1 LIMIT 1
        ''').fetchone()
        if duplicate:
            raise ServiceException(message='暂存快照包含重复题目 ID')
        catalogs = self._rows('catalogs')
        ids = [str(row.get('catalog_external_id') or row.get('externalCatalogId') or row.get('externalId') or '')
               for row in catalogs]
        if len(ids) != len(set(ids)):
            raise ServiceException(message='暂存快照包含重复目录 ID')
        for collection in ('questionCatalogs', 'tags', 'assets'):
            orphan = self.db.execute('''
                SELECT source.question_external_id FROM rows AS source
                WHERE source.collection=? AND NOT EXISTS (
                    SELECT 1 FROM rows AS target
                    WHERE target.collection='questions'
                      AND target.question_external_id=source.question_external_id
                ) LIMIT 1
            ''', (collection,)).fetchone()
            if orphan:
                raise ServiceException(message=f'{collection} 暂存行引用了不存在的题目')

    def _rows(self, collection: str, question_ids: list[str] | None = None) -> list[dict[str, Any]]:
        if question_ids is None:
            cursor = self.db.execute('SELECT payload FROM rows WHERE collection=? ORDER BY ordinal', (collection,))
        elif not question_ids:
            return []
        else:
            placeholders = ','.join('?' for _ in question_ids)
            cursor = self.db.execute(
                f'SELECT payload FROM rows INDEXED BY idx_spool_question '
                f'WHERE collection=? AND question_external_id IN ({placeholders}) ORDER BY ordinal',
                (collection, *question_ids),
            )
        return [_unpack(row[0]) for row in cursor]

    def chunks(self, size: int = 100) -> Iterator[dict[str, Any]]:
        if size < 1 or size > MAX_CHUNK_QUESTIONS:
            raise ValueError('question batch size must be 1..500')
        catalogs = self._rows('catalogs')
        cursor = 0
        while cursor < self.counts['questions']:
            questions = [
                _unpack(row[0]) for row in self.db.execute(
                    "SELECT payload FROM rows WHERE collection='questions' AND ordinal>=? ORDER BY ordinal LIMIT ?",
                    (cursor, size),
                )
            ]
            if not questions:
                raise ServiceException(message='暂存题目分页提前结束')
            ids = [str(row.get('question_external_id') or row.get('externalQuestionId') or row.get('externalId') or '')
                   for row in questions]
            children = {name: self._rows(name, ids) for name in ('questionCatalogs', 'tags', 'assets')}
            counts = {
                'catalogItemCount': len(catalogs),
                'questionItemCount': len(questions),
                'questionCatalogCount': len(children['questionCatalogs']),
                'questionTagCount': len(children['tags']),
                'questionAssetCount': len(children['assets']),
            }
            raw = {
                'available': True, 'immutable': True, 'snapshotComplete': self.summary['snapshot_complete'],
                'run': self.run, 'counts': counts, 'catalogs': catalogs, 'questions': questions,
                **children,
            }
            normalized = _normalise_snapshot(raw, self.task_id, self.textbook_id, sealed_for_import=self.sealed_for_import)
            normalized['chunk_start'] = cursor
            yield normalized
            cursor += len(questions)

    def validate_all(self, *, size: int = 100, on_progress: Any = None) -> dict[str, Any]:
        """Validate every row and cross-reference without formal writes."""
        self.validate_links()
        totals = {'catalogs': self.counts['catalogs'], 'questions': 0,
                  'questionCatalogs': 0, 'tags': 0, 'assets': 0}
        digest = hashlib.sha256()
        projected = dict(totals)
        for index, snapshot in enumerate(self.chunks(size=size), start=1):
            _check_formal_rows(snapshot)
            for key, normalized_key in (
                ('questions', 'questions'), ('questionCatalogs', 'question_catalogs'),
                ('tags', 'tags'), ('assets', 'assets'),
            ):
                totals[key] += snapshot['counts'][key]
                projected[key] += len(snapshot[normalized_key])
            digest.update(_canonical_hash(snapshot['business']).encode('ascii'))
            if on_progress is not None:
                on_progress(index, totals['questions'], self.counts['questions'])
        if totals != self.counts:
            raise ServiceException(message=f'暂存快照规范化计数不一致：{totals}/{self.counts}')
        return {'counts': totals, 'projectedCounts': projected,
                'collapsedTagObservations': totals['tags'] - projected['tags'],
                'normalizedHash': digest.hexdigest()}


def main() -> None:
    parser = argparse.ArgumentParser(description='Validate staged question rows without formal writes')
    parser.add_argument('task_id', type=int)
    parser.add_argument('run_id', type=int)
    parser.add_argument('textbook_id')
    parser.add_argument('--path', type=Path)
    args = parser.parse_args()
    path = args.path or _asset_root() / 'imports' / f'run-{args.run_id}-{args.textbook_id}.sqlite3'
    summary = CollectorClient().run_snapshot_summary(args.run_id, textbook_external_id=args.textbook_id)

    def progress(index: int, count: int, total: int) -> None:
        if index % 25 == 0 or count == total:
            print(f'validated_questions: {count}/{total}', flush=True)

    with LargeSnapshotReader(path, summary, args.task_id, args.textbook_id) as reader:
        result = reader.validate_all(on_progress=progress)
    print(f'validation complete: {result}', flush=True)


if __name__ == '__main__':
    main()
