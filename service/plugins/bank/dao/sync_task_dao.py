"""Persistence helpers for the independent textbook/question task modules.

The original synchronization centre stores its durable state in
``qb_sync_job``.  This DAO deliberately builds on that table instead of
introducing a second task identity, and keeps the immutable per-textbook
scope rows in ``qb_sync_job_scope``.  No method in this module writes any of
the formal question-bank tables.
"""

from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import String, cast, delete, desc, exists, or_, select, update

from plugins.bank.entity.do.bank_do import QbSyncJob, QbSyncJobScope
from utils.page_util import PageUtil

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from plugins.bank.entity.vo.bank_vo import SyncTaskPageQueryModel


_ACTIVE_STATUSES = ('queued', 'starting', 'running', 'cancelling')
_TERMINAL_STATUSES = ('completed', 'failed', 'blocked', 'cancelled', 'interrupted')
_DATE_ONLY = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def _date_only_end_boundary(value: str | datetime | date) -> datetime | str:
    """Turn a date-only end filter into an exclusive next-day boundary.

    Full timestamps retain the existing inclusive ``<=`` semantics. Invalid
    date-only strings are returned unchanged so Pydantic/DB validation keeps
    owning the existing error behavior.
    """

    if isinstance(value, str):
        candidate = value.strip()
        if _DATE_ONLY.fullmatch(candidate):
            try:
                return datetime.combine(date.fromisoformat(candidate) + timedelta(days=1), time.min)
            except (ValueError, OverflowError):
                pass
    return value


def _result_scalars(result: Any) -> list[Any]:
    """Read SQLAlchemy results and small test doubles uniformly."""

    scalars = getattr(result, 'scalars', None)
    if callable(scalars):
        return list(scalars().all())
    all_rows = getattr(result, 'all', None)
    if callable(all_rows):
        return list(all_rows())
    return []


class SyncTaskDao:
    """Async access to module-scoped synchronization jobs and scopes."""

    @staticmethod
    async def get(db: AsyncSession, task_id: int, task_module: str | None = None) -> QbSyncJob | None:
        query = select(QbSyncJob).where(QbSyncJob.run_id == task_id)
        if task_module:
            query = query.where(QbSyncJob.task_module == task_module)
        result = await db.execute(query)
        return next(iter(_result_scalars(result)), None)

    get_by_id = get

    @staticmethod
    async def get_for_update(
        db: AsyncSession,
        task_id: int,
        task_module: str | None = None,
    ) -> QbSyncJob | None:
        """Lock one task row before coordinating it with apply-state rows."""

        query = select(QbSyncJob).where(QbSyncJob.run_id == task_id)
        if task_module:
            query = query.where(QbSyncJob.task_module == task_module)
        result = await db.execute(query.with_for_update())
        return next(iter(_result_scalars(result)), None)

    @staticmethod
    async def list_rows(
        db: AsyncSession,
        task_module: str,
        *,
        status: str | None = None,
    ) -> list[QbSyncJob]:
        query = select(QbSyncJob).where(QbSyncJob.task_module == task_module)
        if status:
            query = query.where(QbSyncJob.status == status)
        result = await db.execute(query.order_by(desc(QbSyncJob.run_id)))
        return [row for row in _result_scalars(result) if row is not None]

    @staticmethod
    async def list_page(db: AsyncSession, task_module: str, query_object: SyncTaskPageQueryModel) -> Any:
        """Return a normal ``PageModel`` while keeping filters SQL-safe.

        ``versionName`` and ``taskNo`` are represented in the server-owned
        JSON/options snapshot and are therefore applied by the service after
        loading the bounded task history.  Status and date predicates are
        applied in SQL where possible.
        """

        query = select(QbSyncJob).where(QbSyncJob.task_module == task_module)
        if query_object.plan_id:
            query = query.where(QbSyncJob.options_json['autoPlanId'].as_integer() == query_object.plan_id)
        if query_object.cycle_no:
            query = query.where(QbSyncJob.options_json['autoCycleNo'].as_integer() == query_object.cycle_no)
        if query_object.cycle_name:
            query = query.where(QbSyncJob.options_json['autoCycleName'].as_string().contains(query_object.cycle_name, autoescape=True))
        if query_object.status:
            query = query.where(QbSyncJob.status == query_object.status)
        if query_object.subject_id:
            query = query.where(QbSyncJob.subject_id == query_object.subject_id)
        if query_object.create_time_start:
            query = query.where(QbSyncJob.create_time >= query_object.create_time_start)
        if query_object.create_time_end:
            end_boundary = _date_only_end_boundary(query_object.create_time_end)
            if (
                isinstance(end_boundary, datetime)
                and isinstance(query_object.create_time_end, str)
                and _DATE_ONLY.fullmatch(query_object.create_time_end.strip())
            ):
                query = query.where(QbSyncJob.create_time < end_boundary)
            else:
                query = query.where(QbSyncJob.create_time <= end_boundary)
        if query_object.task_no:
            query = query.where(cast(QbSyncJob.run_id, String).ilike(f'%{query_object.task_no}%'))
        if query_object.version_name:
            # Options are a server-owned JSON snapshot.  JSON_EXTRACT is
            # supported by MySQL and SQLite's JSON1 extension, while keeping
            # the filter in SQL instead of loading the complete task history.
            # Completed textbook tasks keep the discovered version names in
            # scope snapshots (the task options are created before metadata
            # discovery), so include that immutable source as well.
            version_like = f'%{query_object.version_name}%'
            query = query.where(
                or_(
                    cast(QbSyncJob.options_json, String).ilike(version_like),
                    exists(
                        select(1).where(
                            QbSyncJobScope.run_id == QbSyncJob.run_id,
                            cast(QbSyncJobScope.version_name_snapshot, String).ilike(version_like),
                        )
                    ),
                )
            )
        query = query.order_by(desc(QbSyncJob.run_id))
        return await PageUtil.paginate(db, query, query_object.page_num, query_object.page_size, True)

    @staticmethod
    async def scopes(db: AsyncSession, run_id: int) -> list[QbSyncJobScope]:
        result = await db.execute(
            select(QbSyncJobScope).where(QbSyncJobScope.run_id == run_id).order_by(QbSyncJobScope.scope_id)
        )
        return [row for row in _result_scalars(result) if row is not None]

    @staticmethod
    async def scopes_for_update(db: AsyncSession, run_id: int) -> list[QbSyncJobScope]:
        """Load all scopes while holding row locks for a lifecycle mutation."""

        result = await db.execute(
            select(QbSyncJobScope)
            .where(QbSyncJobScope.run_id == run_id)
            .order_by(QbSyncJobScope.scope_id)
            .with_for_update()
        )
        return [row for row in _result_scalars(result) if row is not None]

    locked_scopes = scopes_for_update
    get_scopes_for_update = scopes_for_update

    list_scopes = scopes
    get_scopes = scopes

    @staticmethod
    async def get_scope(db: AsyncSession, scope_id: int) -> QbSyncJobScope | None:
        result = await db.execute(select(QbSyncJobScope).where(QbSyncJobScope.scope_id == scope_id))
        return next(iter(_result_scalars(result)), None)

    @staticmethod
    async def add_scope(db: AsyncSession, row: QbSyncJobScope) -> QbSyncJobScope:
        db.add(row)
        await db.flush()
        return row

    @staticmethod
    async def add_scopes(db: AsyncSession, rows: list[QbSyncJobScope]) -> list[QbSyncJobScope]:
        if rows:
            db.add_all(rows)
            await db.flush()
        return rows

    @staticmethod
    async def delete_task(db: AsyncSession, task_id: int, task_module: str) -> int:
        """Delete one terminal task and its scope rows in the required order.

        The caller owns the surrounding transaction.  Scope rows are removed
        first so the operation remains valid on installations where the
        optional foreign-key relationship is present; the job row is then
        deleted with a terminal-status predicate as a final race guard.
        Collector SQLite snapshots and formal question-bank tables are outside
        this DAO and are deliberately untouched.
        """

        # Lock and re-check the row in this transaction.  Besides closing the
        # status-change race between the service check and the delete, this
        # avoids a MySQL self-referencing DELETE subquery.  Scope rows are
        # then removed first, as required by the optional installed-schema
        # foreign-key relationship.
        result = await db.execute(
            select(QbSyncJob)
            .where(
                QbSyncJob.run_id == task_id,
                QbSyncJob.task_module == task_module,
                QbSyncJob.status.in_(_TERMINAL_STATUSES),
            )
            .with_for_update()
        )
        if not _result_scalars(result):
            return 0
        await db.execute(delete(QbSyncJobScope).where(QbSyncJobScope.run_id == task_id))
        result = await db.execute(
            delete(QbSyncJob).where(
                QbSyncJob.run_id == task_id,
                QbSyncJob.task_module == task_module,
                QbSyncJob.status.in_(_TERMINAL_STATUSES),
            )
        )
        return int(result.rowcount or 0)

    delete_terminal_task = delete_task

    @staticmethod
    async def update_scope(
        db: AsyncSession,
        scope_id: int,
        values: dict[str, Any],
        *,
        expected_statuses: tuple[str, ...] | None = None,
    ) -> int:
        if not values:
            return 0
        values = dict(values)
        values.setdefault('update_time', datetime.now())
        statement = update(QbSyncJobScope).where(QbSyncJobScope.scope_id == scope_id)
        if expected_statuses:
            statement = statement.where(QbSyncJobScope.status.in_(expected_statuses))
        result = await db.execute(statement.values(**values))
        return int(result.rowcount or 0)

    @staticmethod
    async def update_scopes_for_run(
        db: AsyncSession,
        run_id: int,
        values: dict[str, Any],
        *,
        expected_statuses: tuple[str, ...] | None = None,
    ) -> int:
        if not values:
            return 0
        values.setdefault('update_time', datetime.now())
        statement = update(QbSyncJobScope).where(QbSyncJobScope.run_id == run_id)
        if expected_statuses:
            statement = statement.where(QbSyncJobScope.status.in_(expected_statuses))
        result = await db.execute(statement.values(**values))
        return int(result.rowcount or 0)

    @staticmethod
    async def latest_successful_textbook_task(
        db: AsyncSession,
        local_textbook_ids: list[int],
        *,
        source_provider: str | None = None,
    ) -> tuple[QbSyncJob, list[QbSyncJobScope]] | None:
        """Find the newest completed textbook task containing every ID.

        Matching is performed against immutable scope rows, never against a
        mutable current textbook name.  This prevents a later metadata run
        from silently changing a question task's source snapshot.
        """

        wanted = {int(value) for value in local_textbook_ids}
        if not wanted:
            return None
        result = await db.execute(
            select(QbSyncJob)
            .where(
                QbSyncJob.task_module == 'textbook',
                QbSyncJob.status == 'completed',
                QbSyncJob.metadata_run_id.is_not(None),
            )
            .order_by(desc(QbSyncJob.run_id))
        )
        for job in _result_scalars(result):
            scopes = await SyncTaskDao.scopes(db, int(job.run_id))
            matched = {
                int(scope.local_textbook_id)
                for scope in scopes
                if scope.local_textbook_id is not None
                and (not source_provider or str(scope.source_provider or '') == source_provider)
            }
            if wanted.issubset(matched):
                return job, scopes
        return None

    find_latest_successful_textbook_task = latest_successful_textbook_task
    find_latest_textbook_snapshot = latest_successful_textbook_task

    @staticmethod
    async def active(db: AsyncSession, task_module: str | None = None) -> QbSyncJob | None:
        query = select(QbSyncJob).where(QbSyncJob.status.in_(_ACTIVE_STATUSES), QbSyncJob.active_slot.is_not(None))
        if task_module:
            query = query.where(QbSyncJob.task_module == task_module)
        result = await db.execute(query.order_by(desc(QbSyncJob.run_id)).limit(1))
        return next(iter(_result_scalars(result)), None)


# Names used by older callers and by integrations that call the table a job.
TaskScopeDao = SyncTaskDao
SyncJobScopeDao = SyncTaskDao
SyncTaskScopeDao = SyncTaskDao

__all__ = [
    'SyncJobScopeDao',
    'SyncTaskDao',
    'SyncTaskScopeDao',
    'TaskScopeDao',
]
