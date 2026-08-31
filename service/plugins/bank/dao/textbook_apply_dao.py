"""Persistence helpers for the explicit textbook snapshot application flow."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from plugins.bank.entity.do.bank_do import QbTextbookApplyHistory, QbTextbookApplyState

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class TextbookApplyDao:
    """Keep provider-state locking and audit writes in one small DAO."""

    @staticmethod
    async def get_state(
        db: AsyncSession,
        source_provider: str,
        *,
        for_update: bool = False,
    ) -> QbTextbookApplyState | None:
        query = select(QbTextbookApplyState).where(QbTextbookApplyState.source_provider == source_provider)
        if for_update:
            query = query.with_for_update()
        result = await db.execute(query)
        scalars = getattr(result, 'scalars', None)
        rows = list(scalars().all()) if callable(scalars) else []
        return rows[0] if rows else None

    @staticmethod
    async def add_state(db: AsyncSession, source_provider: str) -> QbTextbookApplyState:
        from datetime import datetime  # noqa: PLC0415

        state = QbTextbookApplyState(
            source_provider=source_provider,
            create_time=datetime.now(),
            update_time=datetime.now(),
        )
        try:
            # Migration 008 normally seeds this row. A savepoint also makes
            # lazy creation safe when two upgraded instances see it missing.
            async with db.begin_nested():
                db.add(state)
                await db.flush()
        except IntegrityError:
            # A concurrent transaction inserted the provider row first. The
            # savepoint rollback leaves the outer apply transaction usable.
            pass
        locked = await TextbookApplyDao.get_state(db, source_provider, for_update=True)
        if locked is None:
            raise RuntimeError(f'教材应用状态行创建失败：{source_provider}')
        return locked

    @staticmethod
    async def add_history(db: AsyncSession, row: QbTextbookApplyHistory) -> QbTextbookApplyHistory:
        db.add(row)
        await db.flush()
        return row
