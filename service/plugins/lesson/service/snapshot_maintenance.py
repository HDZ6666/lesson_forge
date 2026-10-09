"""Offline collection of expired undo payloads and unreferenced lesson files.

Service and Collector must be stopped for --apply. Draft/history snapshots and
request tombstones are retained; this command never removes source evidence.
"""

import argparse
import asyncio
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import select

from plugins.lesson.entity.do.lesson_do import LpEditorOperation, LpGenerationItem


async def cleanup(db, root: Path, *, grace_days=7, apply=False, clock=None):
    timestamp = clock or datetime.now(timezone.utc).replace(tzinfo=None)
    expired = select(LpEditorOperation).where(
        LpEditorOperation.undo_until < timestamp, LpEditorOperation.undo_json.is_not(None)
    )
    count = 0
    async for operation in await db.stream_scalars(expired):
        if operation.undo_json:
            count += 1
            if apply:
                operation.undo_json = None
    if apply:
        await db.commit()
    references = set()
    root = root.resolve()

    def retain(snapshot):
        for value in (snapshot or {}).get('assetPaths', {}).values():
            path = Path(value)
            references.add((path if path.is_absolute() else root / path).resolve())

    async for snapshot in await db.stream_scalars(select(LpGenerationItem.question_snapshot_json)):
        retain(snapshot)
    async for operation in await db.stream_scalars(
        select(LpEditorOperation).where(LpEditorOperation.undo_json.is_not(None))
    ):
        if operation.undo_until and operation.undo_until >= timestamp and not operation.undone:
            for item in operation.undo_json or []:
                retain(item.get('snapshot'))
    cutoff = (timestamp.replace(tzinfo=timezone.utc) - timedelta(days=grace_days)).timestamp()
    removed = 0
    bytes_removed = 0
    for path in (root / 'lesson' / 'snapshots').rglob('*'):
        if path.is_symlink() or not path.is_file():
            continue
        if path.resolve() in references or path.stat().st_mtime >= cutoff:
            continue
        removed += 1
        bytes_removed += path.stat().st_size
        if apply:
            path.unlink()
    return {'apply': apply, 'expiredUndoPayloads': count, 'unreferencedFiles': removed, 'bytes': bytes_removed}


async def main(args):
    from config.database import DataSourceRegistry

    async with DataSourceRegistry.session() as db:
        result = await cleanup(
            db, Path(os.environ.get('BANK_ASSET_ROOT', 'data/bank')), grace_days=args.grace_days, apply=args.apply
        )
        print(result)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--quiesced', action='store_true')
    parser.add_argument('--grace-days', type=int, default=7)
    args = parser.parse_args()
    if args.apply and not args.quiesced:
        parser.error('--apply requires --quiesced after stopping Service and Collector')
    if args.grace_days < 1:
        parser.error('--grace-days must be positive')
    asyncio.run(main(args))
