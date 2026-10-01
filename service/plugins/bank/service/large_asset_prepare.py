"""Materialize large snapshot assets before a formal-bank transaction starts."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import sqlite3
from pathlib import Path
from typing import Any

from exceptions.exception import ServiceException
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.large_snapshot_reader import LargeSnapshotReader
from plugins.bank.service.question_apply_service import _asset_root, _canonical_hash, _download_snapshot_assets


async def prepare_assets(
    reader: LargeSnapshotReader,
    path: Path,
    *,
    on_progress: Any = None,
) -> dict[str, Any]:
    """Download/verify content-addressed files with bounded concurrency."""
    reader.validate_links()
    digest = hashlib.sha256()
    asset_references = 0
    db = sqlite3.connect(path)
    try:
        db.execute('''CREATE TABLE IF NOT EXISTS asset_paths (
            file_hash TEXT PRIMARY KEY,
            storage_path TEXT NOT NULL
        )''')
        for index, snapshot in enumerate(reader.chunks(), start=1):
            digest.update(_canonical_hash(snapshot['business']).encode('ascii'))
            await _download_snapshot_assets(snapshot)
            with db:
                for asset in snapshot['assets']:
                    file_hash = asset['file_hash']
                    storage_path = asset.get('storage_path')
                    if not storage_path or asset.get('download_status') != 'downloaded':
                        raise ServiceException(message=f'素材 {file_hash} 未完成下载与校验')
                    db.execute('INSERT INTO asset_paths (file_hash,storage_path) VALUES (?,?) '
                               'ON CONFLICT(file_hash) DO UPDATE SET storage_path=excluded.storage_path',
                               (file_hash, storage_path))
            asset_references += len(snapshot['assets'])
            if on_progress is not None:
                on_progress(index, snapshot['chunk_start'] + len(snapshot['questions']), reader.counts['questions'],
                            asset_references)
        if asset_references != reader.counts['assets']:
            raise ServiceException(message='素材准备引用数量与快照不一致')
        distinct_assets = db.execute('SELECT COUNT(*) FROM asset_paths').fetchone()[0]
        with db:
            db.execute("INSERT OR REPLACE INTO metadata (key,value) VALUES ('asset_preparation_hash',?)",
                       (digest.hexdigest().encode('ascii'),))
            db.execute("INSERT OR REPLACE INTO metadata (key,value) VALUES ('asset_reference_count',?)",
                       (str(asset_references).encode('ascii'),))
        return {'normalizedHash': digest.hexdigest(), 'assetReferences': asset_references,
                'distinctAssets': distinct_assets}
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description='Prepare large snapshot assets before formal apply')
    parser.add_argument('task_id', type=int)
    parser.add_argument('run_id', type=int)
    parser.add_argument('textbook_id')
    parser.add_argument('--path', type=Path)
    args = parser.parse_args()
    path = args.path or _asset_root() / 'imports' / f'run-{args.run_id}-{args.textbook_id}.sqlite3'
    summary = CollectorClient().run_snapshot_summary(args.run_id, textbook_external_id=args.textbook_id)

    def progress(index: int, questions: int, total: int, references: int) -> None:
        if index % 10 == 0 or questions == total:
            print(f'asset_preparation: questions={questions}/{total} references={references}', flush=True)

    with LargeSnapshotReader(path, summary, args.task_id, args.textbook_id) as reader:
        result = asyncio.run(prepare_assets(reader, path, on_progress=progress))
    print(f'asset preparation complete: {result}', flush=True)


if __name__ == '__main__':
    main()
