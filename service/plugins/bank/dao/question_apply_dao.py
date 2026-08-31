"""Persistence helpers for the scope-aware question snapshot apply flow."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from plugins.bank.entity.do.bank_do import QbQuestionApplyHistory, QbQuestionApplyState

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class QuestionApplyDao:
    """Keep scope locks and append-only audit writes in a small DAO."""

    @staticmethod
    async def get_state(
        db: AsyncSession,
        source_provider: str,
        external_textbook_id: str,
        *,
        for_update: bool = False,
    ) -> QbQuestionApplyState | None:
        query = select(QbQuestionApplyState).where(
            QbQuestionApplyState.source_provider == source_provider,
            QbQuestionApplyState.external_textbook_id == external_textbook_id,
        )
        if for_update:
            query = query.with_for_update()
        result = await db.execute(query)
        scalars = getattr(result, 'scalars', None)
        rows = list(scalars().all()) if callable(scalars) else []
        return rows[0] if rows else None

    @staticmethod
    async def get_states(
        db: AsyncSession,
        keys: list[tuple[str, str]],
        *,
        for_update: bool = False,
    ) -> list[QbQuestionApplyState]:
        if not keys:
            return []
        # Scope keys are locked one-by-one by the service in lexical order.
        # Keeping this query for reads avoids a large OR expression and makes
        # test doubles straightforward.
        rows: list[QbQuestionApplyState] = []
        seen: set[tuple[str, str]] = set()
        for provider, textbook in sorted(keys):
            key = (str(provider), str(textbook))
            if key in seen:
                continue
            seen.add(key)
            row = await QuestionApplyDao.get_state(db, provider, textbook, for_update=for_update)
            if row is not None:
                rows.append(row)
        return rows

    @staticmethod
    async def add_state(
        db: AsyncSession,
        source_provider: str,
        external_textbook_id: str,
    ) -> QbQuestionApplyState:
        state = QbQuestionApplyState(
            source_provider=source_provider,
            external_textbook_id=external_textbook_id,
            create_time=datetime.now(),
            update_time=datetime.now(),
        )
        # aiosqlite's legacy transaction mode releases a SAVEPOINT as a
        # top-level commit when no explicit BEGIN preceded it.  That makes a
        # first-apply state row survive the service's outer rollback.  SQLite
        # is used by the local/test evidence path, so insert directly there;
        # the normal MySQL path retains the nested savepoint needed for a
        # concurrent first insert.
        bind = getattr(db, 'bind', None)
        if bind is None and callable(getattr(db, 'get_bind', None)):
            try:
                bind = db.get_bind()
            except Exception:
                bind = None
        dialect = getattr(bind, 'dialect', None)
        dialect_name = str(getattr(dialect, 'name', '') or '').lower()
        if dialect_name == 'sqlite':
            try:
                db.add(state)
                await db.flush()
            except IntegrityError:
                # The insert happens before formal-table mutation.  Rolling
                # back the current transaction clears SQLite's failed state;
                # the subsequent locked read obtains the winner row.
                await db.rollback()
            locked = await QuestionApplyDao.get_state(db, source_provider, external_textbook_id, for_update=True)
            if locked is None:
                raise RuntimeError(f'题库应用状态行创建失败：{source_provider}/{external_textbook_id}')
            return locked
        try:
            # A savepoint keeps a concurrent first apply from poisoning the
            # outer transaction when both requests create the same scope row.
            async with db.begin_nested():
                db.add(state)
                await db.flush()
        except IntegrityError:
            pass
        locked = await QuestionApplyDao.get_state(db, source_provider, external_textbook_id, for_update=True)
        if locked is None:
            raise RuntimeError(f'题库应用状态行创建失败：{source_provider}/{external_textbook_id}')
        return locked

    @staticmethod
    async def add_history(db: AsyncSession, row: QbQuestionApplyHistory) -> QbQuestionApplyHistory:
        db.add(row)
        await db.flush()
        return row


__all__ = ['QuestionApplyDao']
