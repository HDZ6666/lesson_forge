"""Reclaim settled import spools and superseded, fully accepted collection runs."""

from __future__ import annotations

import asyncio
import fcntl
from datetime import timedelta
from pathlib import Path

from sqlalchemy import exists, func, select
from sqlalchemy.orm import aliased

from config.database import DataSourceRegistry
from plugins.bank.entity.do.bank_do import QbQuestionImport, QbSyncIssue, QbSyncJob, QbSyncJobScope
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.incremental_import import _clock
from plugins.bank.service.question_apply_service import _asset_root
from plugins.bank.service.resource_guard import configured_limit
from utils.log_util import logger


def remove_spool(path: Path) -> int:
    """Take the same file lock as preparation; never touch formal asset files."""
    if not path.parent.exists():
        return 0
    with path.with_suffix('.lock').open('a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return -1
        size = 0
        for candidate in (path, Path(str(path) + '-wal'), Path(str(path) + '-shm')):
            if candidate.exists():
                size += candidate.stat().st_size
                candidate.unlink()
        # Keep the tiny lock inode; unlinking it would break cross-process flock.
        return size


async def cleanup_once(*, session_factory=None, client=None, root=None):
    factory = session_factory or DataSourceRegistry.session
    root = root or _asset_root() / 'imports' / 'incremental'
    async with factory() as db:
        settled = list(
            (
                await db.scalars(
                    select(QbQuestionImport)
                    .where(
                        QbQuestionImport.status.in_(('completed', 'partial')),
                        QbQuestionImport.cursor == QbQuestionImport.question_count,
                        QbQuestionImport.quarantined_count == 0,
                        func.coalesce(QbQuestionImport.stats_json['spoolReclaimed'].as_boolean(), False).is_(False),
                    )
                    .order_by(QbQuestionImport.import_id)
                    .limit(10)
                    .with_for_update(skip_locked=True)
                )
            ).all()
        )
        for item in settled:
            reclaimed = await asyncio.to_thread(remove_spool, root / f'import-{item.import_id}.sqlite3')
            if reclaimed >= 0:
                item.stats_json = {**(item.stats_json or {}), 'spoolReclaimed': True, 'spoolReclaimedBytes': reclaimed}
        await db.commit()

    # One remote run per pass bounds work. Newest results and every unresolved
    # question remain available; ignored issues are still unresolved.
    async with factory() as db:
        if await db.scalar(select(QbSyncJob.run_id).where(QbSyncJob.active_slot.is_not(None)).limit(1)):
            return
        now = await _clock(db)
        newer = aliased(QbSyncJobScope)
        dependent_scope = aliased(QbSyncJobScope)
        dependent_task = aliased(QbSyncJob)
        hours = configured_limit('BANK_RESULT_RETENTION_HOURS')
        query = (
            select(QbSyncJob.run_id)
            .join(QbQuestionImport, QbQuestionImport.task_id == QbSyncJob.run_id)
            .join(QbSyncJobScope, QbSyncJobScope.scope_id == QbQuestionImport.scope_id)
            .where(
                QbQuestionImport.status.in_(('completed', 'partial')),
                QbQuestionImport.cursor == QbQuestionImport.question_count,
                QbQuestionImport.quarantined_count == 0,
                QbQuestionImport.finished_at <= now - timedelta(hours=hours),
                QbSyncJob.active_slot.is_(None),
                QbSyncJob.dispatch_book_key.is_(None),
                func.coalesce(QbSyncJob.options_json['snapshotReclaimed'].as_boolean(), False).is_(False),
                func.coalesce(QbSyncJob.options_json['planResumePending'].as_boolean(), False).is_(False),
                func.coalesce(QbSyncJob.options_json['autoResumePending'].as_boolean(), False).is_(False),
                ~exists().where(
                    dependent_scope.run_id == dependent_task.run_id,
                    dependent_scope.resume_from_collector_run_id == QbSyncJobScope.collector_run_id,
                    dependent_task.status.in_(('queued', 'starting', 'running', 'cancelling')),
                ),
                exists().where(
                    newer.local_textbook_id == QbSyncJobScope.local_textbook_id,
                    newer.collector_run_id > QbSyncJobScope.collector_run_id,
                    newer.question_count > 0,
                    newer.snapshot_locked_at.is_not(None),
                ),
                ~exists().where(QbSyncIssue.latest_task_id == QbSyncJob.run_id, QbSyncIssue.status != 'resolved'),
            )
            .order_by(QbSyncJob.run_id)
            .limit(1)
        )
        task_id = await db.scalar(query)
        if not task_id:
            return
        task = await db.get(QbSyncJob, task_id, with_for_update=True, populate_existing=True)
        scope = await db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == task_id))
        options = task.options_json or {}
        if (
            task.dispatch_book_key
            or task.active_slot
            or options.get('planResumePending')
            or options.get('autoResumePending')
            or options.get('snapshotReclaimed')
        ):
            return
        dependency = await db.scalar(
            select(QbSyncJobScope.scope_id)
            .join(QbSyncJob, QbSyncJob.run_id == QbSyncJobScope.run_id)
            .where(
                QbSyncJobScope.resume_from_collector_run_id == scope.collector_run_id,
                QbSyncJob.status.in_(('queued', 'starting', 'running', 'cancelling')),
            )
            .limit(1)
        )
        if dependency:
            return
        task.options_json = {**options, 'snapshotCleanupPending': True}
        ticket = {
            'runId': scope.collector_run_id,
            'textbookExternalId': scope.external_textbook_id,
            'snapshotLockedAt': scope.snapshot_locked_at.isoformat(timespec='milliseconds') + 'Z',
        }
        await db.commit()
    try:
        result = await asyncio.to_thread((client or CollectorClient()).reclaim_run, **ticket)
    except Exception as exc:
        # Keep the reservation across an uncertain network result. Repeating
        # the endpoint is idempotent and manual resume rejects this reservation.
        logger.info(f'采集成果 {ticket["runId"]} 回收延后：{str(exc)[:160]}')
        return
    async with factory() as db:
        task = await db.get(QbSyncJob, task_id, with_for_update=True, populate_existing=True)
        task.options_json = {
            **(task.options_json or {}),
            'snapshotCleanupPending': False,
            'snapshotReclaimed': True,
            'snapshotCleanupResult': result,
        }
        await db.commit()
