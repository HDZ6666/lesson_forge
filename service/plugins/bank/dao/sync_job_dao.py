"""Persistence helpers for long-running source synchronization jobs."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import desc, select, update
from sqlalchemy.exc import SQLAlchemyError

from plugins.bank.entity.do.bank_do import QbSyncJob, QbSyncJobScope
from utils.page_util import PageUtil

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from plugins.bank.entity.vo.bank_vo import SyncRunPageQueryModel


_ACTIVE_STATUSES = ('queued', 'starting', 'running', 'cancelling')


class SyncJobDao:
    """Async access to the persistent one-at-a-time crawler task table."""

    @staticmethod
    async def get(db: AsyncSession, run_id: int) -> QbSyncJob | None:
        result = await db.execute(select(QbSyncJob).where(QbSyncJob.run_id == run_id))
        return result.scalars().first()

    @staticmethod
    async def get_current(db: AsyncSession) -> QbSyncJob | None:
        result = await db.execute(
            select(QbSyncJob).where(QbSyncJob.status.in_(_ACTIVE_STATUSES)).order_by(desc(QbSyncJob.run_id)).limit(1)
        )
        return result.scalars().first()

    @staticmethod
    async def list_active(db: AsyncSession) -> list[QbSyncJob]:
        """Return all non-terminal jobs for startup recovery."""

        result = await db.execute(
            select(QbSyncJob).where(QbSyncJob.status.in_(_ACTIVE_STATUSES)).order_by(QbSyncJob.run_id)
        )
        return list(result.scalars().all())

    @staticmethod
    async def list_page(db: AsyncSession, query: SyncRunPageQueryModel) -> Any:
        statement = select(QbSyncJob)
        if query.status:
            statement = statement.where(QbSyncJob.status == query.status)
        if query.run_type:
            statement = statement.where(QbSyncJob.run_type == query.run_type)
        statement = statement.order_by(desc(QbSyncJob.run_id))
        return await PageUtil.paginate(db, statement, query.page_num, query.page_size, True)

    @staticmethod
    async def add(db: AsyncSession, row: QbSyncJob) -> QbSyncJob:
        db.add(row)
        await db.flush()
        return row

    @staticmethod
    async def update_fields(
        db: AsyncSession,
        run_id: int,
        values: dict[str, Any],
        *,
        expected_statuses: tuple[str, ...] | None = None,
    ) -> int:
        if not values:
            return 0
        values.setdefault('update_time', datetime.now())
        statement = update(QbSyncJob).where(QbSyncJob.run_id == run_id)
        if expected_statuses:
            statement = statement.where(QbSyncJob.status.in_(expected_statuses))
        result = await db.execute(statement.values(**values))
        return int(result.rowcount or 0)

    @staticmethod
    async def mark_interrupted(db: AsyncSession, message: str, stale_before: datetime) -> int:
        """Terminalize stale jobs and all of their unfinished scopes.

        This method is used during task creation and as the compatibility
        fallback for startup recovery.  Keeping the scope transition here is
        important: a bulk job update must never leave a queued/running scope
        looking live after its parent has been marked interrupted.  Missing
        migration 006 is tolerated for legacy installations, but the parent
        update still succeeds in that case.
        """

        stale_result = await db.execute(
            select(QbSyncJob).where(
                QbSyncJob.status.in_(_ACTIVE_STATUSES),
                QbSyncJob.update_time < stale_before,
            )
        )
        jobs = list(stale_result.scalars().all())
        if not jobs:
            return 0

        now = datetime.now()
        cancelled_run_ids = {int(job.run_id) for job in jobs if str(job.status or '') == 'cancelling'}
        for job in jobs:
            was_cancelling = str(job.status or '') == 'cancelling'
            job.status = 'cancelled' if was_cancelling else 'failed'
            job.phase = 'cancelled' if was_cancelling else 'failed'
            job.error_message = '同步已停止' if was_cancelling else message
            job.active_slot = None
            job.process_id = None
            job.worker_token = None
            job.finished_at = now
            job.update_time = now
        await db.flush()

        # 006 is additive and old installations may not have the scope table.
        # Do this after the parent mutation so a missing table cannot prevent
        # the legacy sync-center job from being interrupted.
        try:
            scope_result = await db.execute(
                select(QbSyncJobScope).where(
                    QbSyncJobScope.run_id.in_([int(job.run_id) for job in jobs]),
                    QbSyncJobScope.status.in_(('queued', 'starting', 'running')),
                )
            )
            scopes = list(scope_result.scalars().all())
            for scope in scopes:
                parent = next((job for job in jobs if int(job.run_id) == int(scope.run_id)), None)
                was_cancelling = parent is not None and int(parent.run_id) in cancelled_run_ids
                scope.status = 'cancelled' if was_cancelling or str(scope.status or '') == 'queued' else 'failed'
                scope.error_message = '同步已停止' if was_cancelling else message
                scope.finished_at = now
                scope.update_time = now
            if scopes:
                await db.flush()
        except SQLAlchemyError:
            # A pre-006 database has no scope table.  The job update above is
            # still valid and preserves the original sync-center contract.
            pass
        return len(jobs)

    @staticmethod
    async def request_cancel(db: AsyncSession, run_id: int) -> QbSyncJob | None:
        await db.execute(
            update(QbSyncJob)
            .where(QbSyncJob.run_id == run_id, QbSyncJob.status.in_(_ACTIVE_STATUSES))
            .values(status='cancelling', update_time=datetime.now())
        )
        return await SyncJobDao.get(db, run_id)
