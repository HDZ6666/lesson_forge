"""Resume-safe, disk-bounded staging for a large immutable question snapshot.

This stage is read-only with respect to the formal bank. It deliberately does
not mark a snapshot applied: row validation, asset preparation, and a formal
database transaction must follow before an apply-state token can be issued.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import time
import zlib
from pathlib import Path
from typing import Any

from exceptions.exception import ServiceException
from plugins.bank.service.collector_client import (
    DEFAULT_SNAPSHOT_PAGE_SIZE,
    MAX_STREAM_SNAPSHOT_ROWS,
    SNAPSHOT_COLLECTIONS,
    CollectorClient,
)
from plugins.bank.service.question_apply_service import _asset_root, _normalise_snapshot_summary


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def _open_spool(path: Path, identity: dict[str, Any]) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    db.executescript('''
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS rows (
            collection TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            question_external_id TEXT,
            payload BLOB NOT NULL,
            PRIMARY KEY (collection, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_spool_question ON rows (collection, question_external_id);
        CREATE TABLE IF NOT EXISTS progress (collection TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
    ''')
    previous = db.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()
    encoded = _json_bytes(identity)
    if previous and previous[0] != encoded:
        db.close()
        raise ServiceException(message='本地快照暂存与运行信息不一致，请检查暂存目录')
    if not previous:
        db.execute("INSERT INTO metadata (key,value) VALUES ('identity',?)", (encoded,))
        db.commit()
    return db


def _question_id(row: dict[str, Any]) -> str | None:
    for key in ('question_external_id', 'questionExternalId', 'externalQuestionId', 'externalId'):
        value = row.get(key)
        if value not in (None, ''):
            return str(value)
    return None


def spool_snapshot(
    client: CollectorClient,
    run_id: int,
    textbook_id: str,
    path: Path,
    *,
    page_size: int = DEFAULT_SNAPSHOT_PAGE_SIZE,
    on_progress: Any = None,
) -> dict[str, int]:
    """Copy validated immutable pages to local SQLite with resumable cursors."""
    raw = client.run_snapshot_summary(run_id, textbook_external_id=textbook_id)
    summary = _normalise_snapshot_summary(raw, 0, textbook_id)
    if int(summary['collector_run_id']) != run_id:
        raise ServiceException(message='collector 运行 ID 与暂存任务不一致')
    counts = summary['counts']
    for name, count in counts.items():
        if count > MAX_STREAM_SNAPSHOT_ROWS:
            raise ServiceException(message=f'{name} 行数超过分页暂存上限')
    run = raw.get('run')
    if not isinstance(run, dict):
        raise ServiceException(message='collector 快照缺少运行信息')
    identity = {
        'runId': run_id,
        'textbookExternalId': textbook_id,
        'snapshotLockedAt': str(run.get('snapshotLockedAt') or run.get('snapshot_locked_at')),
        'counts': counts,
    }
    db = _open_spool(path, identity)
    started = time.monotonic()
    try:
        for collection in SNAPSHOT_COLLECTIONS:
            expected = counts[collection]
            row = db.execute('SELECT cursor FROM progress WHERE collection=?', (collection,)).fetchone()
            cursor = int(row[0]) if row else 0
            if cursor < 0 or cursor > expected:
                raise ServiceException(message=f'{collection} 暂存游标无效')
            while cursor < expected:
                page = client.run_snapshot_page(
                    run_id, collection, textbook_external_id=textbook_id,
                    cursor=cursor, page_size=page_size,
                )
                client._validate_snapshot_page(
                    page, run_id, textbook_id, collection, counts, run, cursor,
                    page_size=page_size,
                )
                items = page['items']
                if not items:
                    raise ServiceException(message=f'{collection} 快照分页提前结束')
                with db:
                    db.executemany(
                        'INSERT INTO rows (collection,ordinal,question_external_id,payload) VALUES (?,?,?,?)',
                        (
                            (collection, cursor + index, _question_id(item),
                             zlib.compress(_json_bytes(item), level=1))
                            for index, item in enumerate(items)
                        ),
                    )
                    cursor += len(items)
                    db.execute('INSERT INTO progress (collection,cursor) VALUES (?,?) '
                               'ON CONFLICT(collection) DO UPDATE SET cursor=excluded.cursor',
                               (collection, cursor))
                if on_progress is not None:
                    on_progress(collection, cursor, expected, time.monotonic() - started)
            actual = db.execute('SELECT COUNT(*) FROM rows WHERE collection=?', (collection,)).fetchone()[0]
            if actual != expected:
                raise ServiceException(message=f'{collection} 暂存行数不一致：{actual}/{expected}')
        # Recheck the immutable run header after the last page. A changed
        # source cannot silently produce a mixed spool across a resume.
        final = _normalise_snapshot_summary(
            client.run_snapshot_summary(run_id, textbook_external_id=textbook_id), 0, textbook_id,
        )
        final_run = final['run']
        if final['counts'] != counts or str(
            final_run.get('snapshotLockedAt') or final_run.get('snapshot_locked_at')
        ) != identity['snapshotLockedAt']:
            raise ServiceException(message='collector 快照在暂存期间发生变化')
        with db:
            db.execute("INSERT OR REPLACE INTO metadata (key,value) VALUES ('complete',?)", (b'1',))
        return counts
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description='Stage one immutable large question snapshot without formal writes')
    parser.add_argument('run_id', type=int)
    parser.add_argument('textbook_id')
    parser.add_argument('--path', type=Path)
    args = parser.parse_args()
    path = args.path or _asset_root() / 'imports' / f'run-{args.run_id}-{args.textbook_id}.sqlite3'
    last_update = 0.0

    def progress(collection: str, cursor: int, expected: int, elapsed: float) -> None:
        nonlocal last_update
        if elapsed - last_update >= 10 or cursor == expected:
            print(f'{collection}: {cursor}/{expected} elapsed={elapsed:.1f}s', flush=True)
            last_update = elapsed

    counts = spool_snapshot(CollectorClient(), args.run_id, args.textbook_id, path, on_progress=progress)
    print(f'spool complete: {path} counts={counts}', flush=True)


if __name__ == '__main__':
    main()
