"""Background preparation and bounded writes, recovered from durable IDs."""

from __future__ import annotations

import asyncio
import fcntl
import threading
from pathlib import Path
from typing import Any

from config.database import DataSourceRegistry
from exceptions.exception import ServiceException
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.incremental_import import (
    advance_incremental_preparation,
    attach_incremental_quality,
    claim_pending_incremental_import,
    defer_incremental_import,
    fail_incremental_import,
    pending_incremental_import_ids,
    reject_pending_incremental_import,
    renew_incremental_import,
    submit_incremental_import_batch,
)
from plugins.bank.service.incremental_merge import prepare_incremental_verdicts
from plugins.bank.service.incremental_snapshot import SealedSnapshotReader, check_sealed_snapshot, read_checked_batch
from plugins.bank.service.large_snapshot_spool import spool_snapshot
from plugins.bank.service.question_apply_service import _asset_root, _normalise_snapshot_summary
from plugins.bank.service.resource_guard import ResourcePressure, assert_resources
from plugins.bank.service.source_write_lock import SourceWriteBusy
from utils.log_util import logger

POLL_SECONDS = 3
HEARTBEAT_SECONDS = 30
_WORKER_TASK: asyncio.Task | None = None


class PreparationBusy(ServiceException):
    """An expired owner's staging thread has not released its file yet."""


def _prepare(ticket: dict[str, Any], client: Any, path: Path, stop: threading.Event) -> dict[str, Any]:
    def progress(*_args):
        if stop.is_set():
            raise ServiceException(message='入库准备执行权已失效，停止暂存写入')
        assert_resources(root=path.parent)

    path.parent.mkdir(parents=True, exist_ok=True)
    # Keep the same durable spool across owners. A DB lease alone cannot
    # cancel an old thread blocked in HTTP; flock prevents overlapping SQLite
    # writes during takeover. Progress callbacks stop it after its HTTP wait.
    with path.with_suffix('.lock').open('a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise PreparationBusy(message='正在等待上次暂存释放，稍后自动继续') from exc
        progress()
        summary = client.run_snapshot_summary(
            ticket['collectorRunId'], textbook_external_id=ticket['textbookExternalId'], sealed_for_import=True,
        )
        normalized = _normalise_snapshot_summary(
            summary, ticket['taskId'], ticket['textbookExternalId'], sealed_for_import=True,
        )
        if (
            normalized['collector_run_id'] != ticket['collectorRunId']
            or normalized['counts']['questions'] != ticket['questionCount']
            or normalized['snapshot_complete'] != ticket['snapshotComplete']
            or normalized['snapshot_locked_at'] != ticket['snapshotLockedAt']
            or ticket.get('coverageEvidence') is not None
            and ticket['coverageEvidence'] != normalized['run_coverage']
        ):
            raise ServiceException(message='远端封存与提交入库时的任务身份不一致')
        spool_snapshot(
            client, ticket['collectorRunId'], ticket['textbookExternalId'], path,
            sealed_for_import=True, on_progress=progress,
        )
        progress()
        with SealedSnapshotReader(path, summary, ticket['taskId'], ticket['textbookExternalId']) as reader:
            report = check_sealed_snapshot(reader, path, on_progress=progress)
            return {**report, 'coverageEvidence': normalized['run_coverage']}


async def execute_incremental_import(
    ticket: dict[str, Any], *, session_factory: Any = None, client: Any = None, root: Path | None = None,
) -> None:
    """Execute one claimed ID; every DB session ends before remote/disk work."""
    session_factory = session_factory or DataSourceRegistry.session
    client = client or CollectorClient()
    path = (root or _asset_root() / 'imports' / 'incremental') / f'import-{ticket["importId"]}.sqlite3'
    stop = threading.Event()
    owner = dict(ticket)
    current = asyncio.current_task()

    async def heartbeat():
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_SECONDS)
                async with session_factory() as db:
                    await renew_incremental_import(db, owner)
        except asyncio.CancelledError:
            raise
        except Exception:
            stop.set()
            if current is not None:
                current.cancel()

    pulse = asyncio.create_task(heartbeat(), name=f'bank-import-heartbeat-{owner["importId"]}')
    try:
        assert_resources(root=path.parent)
        async with session_factory() as db:
            await advance_incremental_preparation(db, owner, 'checking')
        report = await asyncio.to_thread(_prepare, owner, client, path, stop)
        async with session_factory() as db:
            owner.update(await attach_incremental_quality(db, owner, report))
        while not owner['done']:
            assert_resources(root=path.parent)
            async with session_factory() as db:
                await advance_incremental_preparation(db, owner, 'assets')
            verdicts = await asyncio.to_thread(read_checked_batch, path, owner)
            prepared = await prepare_incremental_verdicts(verdicts)
            assert_resources(root=path.parent)
            async with session_factory() as db:
                result = await submit_incremental_import_batch(db, owner, prepared, expected_cursor=owner['cursor'])
            state = result['incrementalImport']
            owner['cursor'] = state['processedCount']
            owner['done'] = state['status'] in {'completed', 'partial'}
    except asyncio.CancelledError:
        # Shutdown or heartbeat loss leaves the last committed checkpoint.
        # Expiry recovery will claim a new token; do not turn shutdown into
        # a permanent failure requiring manual retry.
        raise
    except (SourceWriteBusy, PreparationBusy, ResourcePressure) as exc:
        async with session_factory() as db:
            await defer_incremental_import(db, owner, exc.message)
    except Exception as exc:
        message = exc.message if isinstance(exc, ServiceException) else '后台入库发生异常，请重试入库'
        try:
            async with session_factory() as db:
                await fail_incremental_import(db, owner, message)
        except ServiceException:
            pass  # An expired owner cannot change its successor's result.
        logger.warning(f'题库入库 {owner["importId"]} 未完成，类型 {type(exc).__name__}')
    finally:
        stop.set()
        pulse.cancel()
        await asyncio.gather(pulse, return_exceptions=True)


async def dispatch_incremental_imports_once(
    *, session_factory: Any = None, client: Any = None, root: Path | None = None,
):
    session_factory = session_factory or DataSourceRegistry.session
    async with session_factory() as db:
        ids = await pending_incremental_import_ids(db)
    for import_id in ids:
        try:
            async with session_factory() as db:
                ticket = await claim_pending_incremental_import(db, import_id)
        except ServiceException as exc:
            async with session_factory() as db:
                await reject_pending_incremental_import(db, import_id, exc.message)
            continue
        if ticket is not None:
            work = asyncio.create_task(execute_incremental_import(
                ticket, session_factory=session_factory, client=client, root=root,
            ), name=f'bank-import-{import_id}')
            try:
                await work
            except asyncio.CancelledError:
                if asyncio.current_task().cancelling():
                    raise
                # A single expired lease must not stop the process-wide
                # dispatcher or prevent other books from being processed.


async def _run():
    while True:
        try:
            await dispatch_incremental_imports_once()
            from plugins.bank.service.import_intake_worker import dispatch_import_intakes_once
            await dispatch_import_intakes_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(f'题库入库恢复暂不可用，类型 {type(exc).__name__}')
        await asyncio.sleep(POLL_SECONDS)


def start_incremental_import_worker():
    global _WORKER_TASK
    if _WORKER_TASK is None or _WORKER_TASK.done():
        _WORKER_TASK = asyncio.create_task(_run(), name='bank-incremental-import-worker')


async def stop_incremental_import_worker():
    global _WORKER_TASK
    if _WORKER_TASK is not None:
        _WORKER_TASK.cancel()
        await asyncio.gather(_WORKER_TASK, return_exceptions=True)
        _WORKER_TASK = None
