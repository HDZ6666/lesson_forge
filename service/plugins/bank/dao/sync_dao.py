"""Persistence helpers for synchronization review decisions.

The DAO intentionally knows nothing about the collector SQLite file and never
writes any of the seven current bank tables.  It only reads/updates
``qb_sync_review`` records.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import select

from plugins.bank.entity.do.bank_do import QbSyncReview

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class SyncReviewDao:
    """Async SQLAlchemy access for the review work table."""

    @staticmethod
    async def get(
        db: AsyncSession,
        entity_type: str,
        source_provider: str,
        external_id: str,
    ) -> QbSyncReview | None:
        result = await db.execute(
            select(QbSyncReview).where(
                QbSyncReview.entity_type == entity_type,
                QbSyncReview.source_provider == source_provider,
                QbSyncReview.external_id == external_id,
            )
        )
        return result.scalars().first()

    @staticmethod
    async def list_for_entity(
        db: AsyncSession,
        entity_type: str,
        source_provider: str | None = None,
    ) -> list[QbSyncReview]:
        query = select(QbSyncReview).where(QbSyncReview.entity_type == entity_type)
        if source_provider:
            query = query.where(QbSyncReview.source_provider == source_provider)
        result = await db.execute(query)
        return list(result.scalars().all())

    @staticmethod
    async def upsert(  # noqa: PLR0913
        db: AsyncSession,
        *,
        entity_type: str,
        source_provider: str,
        external_id: str,
        staged_hash: str,
        staged_data: dict,
        current_local_id: int | None,
        comparison_status: str,
        review_status: str,
        review_comment: str | None,
        reviewed_by: str | None,
        reviewed_at: object | None,
        create_time: object,
        update_time: object,
    ) -> QbSyncReview:
        row = await SyncReviewDao.get(db, entity_type, source_provider, external_id)
        values = {
            'staged_hash': staged_hash,
            'staged_data_json': staged_data,
            'current_local_id': current_local_id,
            'comparison_status': comparison_status,
            'review_status': review_status,
            'review_comment': review_comment,
            'reviewed_by': reviewed_by,
            'reviewed_at': reviewed_at,
            'update_time': update_time,
        }
        if row is None:
            row = QbSyncReview(
                entity_type=entity_type,
                source_provider=source_provider,
                external_id=external_id,
                create_time=create_time,
                **values,
            )
            db.add(row)
        else:
            for key, value in values.items():
                setattr(row, key, value)
        await db.flush()
        return row

    get_by_identity = get
    upsert_review = upsert
