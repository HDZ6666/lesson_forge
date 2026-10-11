"""Database queries for the bank plugin.

The read queries deliberately use ``EXISTS`` for relationship filters.  A
question can have more than one matching relationship, so joining tags or
catalog relations would otherwise make both the count and the page unstable.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, exists, func, or_, select, update
from sqlalchemy.exc import IntegrityError

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbQuestionAsset,
    QbQuestionCatalog,
    QbQuestionReadiness,
    QbQuestionTag,
    QbSubject,
    QbSyncBatch,
    QbTextbook,
    QbTextbookVersion,
)
from utils.page_util import PageUtil

MAX_CATALOG_DEPTH = 1000

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from common.vo import PageModel
    from plugins.bank.entity.vo.bank_vo import (
        BatchPageQueryModel,
        QuestionPageQueryModel,
        TextbookQueryModel,
        TextbookVersionQueryModel,
    )


class BankDao:
    """Async SQLAlchemy access for current bank data and batch metadata."""

    _QUESTION_SORTS = {
        'questionId': QbQuestion.question_id,
        'sourceQuestionNo': QbQuestion.source_question_no,
        'year': QbQuestion.year,
        'difficultyCoefficient': QbQuestion.difficulty_coefficient,
        'score': QbQuestion.score,
        'assembleCount': QbQuestion.assemble_count,
        'referenceCount': QbQuestion.reference_count,
        'createTime': QbQuestion.create_time,
        'updateTime': QbQuestion.update_time,
    }

    @staticmethod
    def _apply_status_filter(query: Any, column: Any, query_object: Any) -> Any:
        """Default reads are active-only; an explicit status always wins."""
        status = getattr(query_object, 'status', None)
        if status in {'0', '1'}:
            return query.where(column == status)
        if not getattr(query_object, 'include_disabled', False):
            return query.where(column == '0')
        return query

    @staticmethod
    def _include_disabled(query_object: Any) -> bool:
        return bool(getattr(query_object, 'include_disabled', False))

    @classmethod
    async def list_versions(
        cls, db: AsyncSession, query_object: TextbookVersionQueryModel
    ) -> PageModel | list[dict[str, Any]]:
        query = cls._apply_status_filter(select(QbTextbookVersion), QbTextbookVersion.status, query_object)
        if getattr(query_object, 'subject_id', None):
            query = query.where(QbTextbookVersion.subject_id == query_object.subject_id)
        if query_object.version_name:
            query = query.where(QbTextbookVersion.version_name.ilike(f'%{query_object.version_name}%'))
        if query_object.source_provider:
            query = query.where(QbTextbookVersion.source_provider == query_object.source_provider)
        query = query.order_by(QbTextbookVersion.sort_order, QbTextbookVersion.version_id)
        page = await PageUtil.paginate(db, query, query_object.page_num, query_object.page_size, True)
        rows = getattr(page, 'rows', [])
        if rows:
            version_ids = [row.get('versionId') if isinstance(row, dict) else row.version_id for row in rows]
            counts = await cls.version_textbook_counts(db, version_ids, cls._include_disabled(query_object))
            for row in rows:
                version_id = row.get('versionId') if isinstance(row, dict) else row.version_id
                if isinstance(row, dict):
                    row['textbook_count'] = counts.get(version_id, 0)
                else:
                    row.textbook_count = counts.get(version_id, 0)
        return page

    @classmethod
    async def list_textbooks(
        cls, db: AsyncSession, query_object: TextbookQueryModel, *, with_counts=True
    ) -> PageModel | list[dict[str, Any]]:
        query = cls._apply_status_filter(select(QbTextbook), QbTextbook.status, query_object)
        if getattr(query_object, 'subject_id', None):
            query = query.where(QbTextbook.subject_id == query_object.subject_id)
        if query_object.version_id:
            query = query.where(QbTextbook.version_id == query_object.version_id)
        if query_object.textbook_name:
            query = query.where(QbTextbook.textbook_name.ilike(f'%{query_object.textbook_name}%'))
        if query_object.grade:
            query = query.where(QbTextbook.grade == query_object.grade)
        if query_object.volume:
            query = query.where(QbTextbook.volume == query_object.volume)
        if query_object.source_provider:
            query = query.where(QbTextbook.source_provider == query_object.source_provider)
        query = query.order_by(QbTextbook.sort_order, QbTextbook.textbook_id)
        page = await PageUtil.paginate(db, query, query_object.page_num, query_object.page_size, True)
        rows = getattr(page, 'rows', [])
        if rows and with_counts:
            textbook_ids = [row.get('textbookId') if isinstance(row, dict) else row.textbook_id for row in rows]
            counts = await cls.textbook_stats(db, textbook_ids, cls._include_disabled(query_object))
            for row in rows:
                textbook_id = row.get('textbookId') if isinstance(row, dict) else row.textbook_id
                catalog_count, question_count = counts.get(textbook_id, (0, 0))
                if isinstance(row, dict):
                    row['catalog_count'] = catalog_count
                    row['question_count'] = question_count
                else:
                    row.catalog_count = catalog_count
                    row.question_count = question_count
        return page

    @classmethod
    async def version_textbook_counts(
        cls, db: AsyncSession, version_ids: list[int], include_disabled: bool = False
    ) -> dict[int, int]:
        if not version_ids:
            return {}
        query = select(QbTextbook.version_id, func.count(QbTextbook.textbook_id)).where(
            QbTextbook.version_id.in_(version_ids)
        )
        if not include_disabled:
            query = query.where(QbTextbook.status == '0')
        result = await db.execute(query.group_by(QbTextbook.version_id))
        return {int(version_id): int(count) for version_id, count in result.all()}

    @classmethod
    async def textbook_stats(
        cls, db: AsyncSession, textbook_ids: list[int], include_disabled: bool = False
    ) -> dict[int, tuple[int, int]]:
        if not textbook_ids:
            return {}
        catalog_on = (QbCatalogNode.textbook_id == QbTextbook.textbook_id) & (
            QbCatalogNode.subject_id == QbTextbook.subject_id
        )
        if not include_disabled:
            catalog_on = catalog_on & (QbCatalogNode.status == '0')
        catalogs = select(
            QbTextbook.textbook_id.label('book'), QbTextbook.subject_id.label('subject'),
            QbCatalogNode.catalog_id.label('catalog'),
        ).select_from(QbTextbook).join(QbCatalogNode, catalog_on).where(
            QbTextbook.textbook_id.in_(textbook_ids),
        ).distinct().subquery()
        catalog_counts = dict((await db.execute(select(
            catalogs.c.book, func.count(),
        ).group_by(catalogs.c.book))).all())
        # Deduplicate membership before touching the much wider question table.
        memberships = select(
            catalogs.c.book, catalogs.c.subject, QbQuestionCatalog.question_id.label('question'),
        ).select_from(catalogs).join(QbQuestionCatalog, (
            QbQuestionCatalog.catalog_id == catalogs.c.catalog
        ) & (QbQuestionCatalog.relation_type == 'query_catalog')).distinct().subquery()
        query = select(memberships.c.book, func.count()).select_from(memberships).join(
            QbQuestion, (QbQuestion.question_id == memberships.c.question)
            & (QbQuestion.subject_id == memberships.c.subject),
        )
        if not include_disabled:
            query = query.where(QbQuestion.status == '0')
        query = query.group_by(memberships.c.book).with_hint(
            QbQuestion, 'FORCE INDEX (idx_qb_question_coverage)', dialect_name='mysql',
        )
        question_counts = dict((await db.execute(query)).all())
        return {int(book): (int(catalog_counts.get(book, 0)), int(question_counts.get(book, 0)))
                for book in textbook_ids}

    @classmethod
    async def get_catalog_nodes(
        cls, db: AsyncSession, textbook_id: int, status: str | None = '0'
    ) -> list[QbCatalogNode]:
        query = select(QbCatalogNode).where(QbCatalogNode.textbook_id == textbook_id)
        if status is not None:
            query = query.where(QbCatalogNode.status == status)
        result = await db.execute(query.order_by(QbCatalogNode.sort_order, QbCatalogNode.catalog_id))
        return list(result.scalars().all())

    @classmethod
    async def list_catalogs(cls, db: AsyncSession, query_object: Any) -> PageModel:
        query = cls._apply_status_filter(select(QbCatalogNode), QbCatalogNode.status, query_object)
        if getattr(query_object, 'subject_id', None):
            query = query.where(QbCatalogNode.subject_id == query_object.subject_id)
        if query_object.textbook_id:
            query = query.where(QbCatalogNode.textbook_id == query_object.textbook_id)
        if query_object.node_name:
            query = query.where(QbCatalogNode.node_name.ilike(f'%{query_object.node_name}%'))
        if query_object.source_provider:
            query = query.where(QbCatalogNode.source_provider == query_object.source_provider)
        query = query.order_by(QbCatalogNode.sort_order, QbCatalogNode.catalog_id)
        page = await PageUtil.paginate(db, query, query_object.page_num, query_object.page_size, True)
        rows = getattr(page, 'rows', [])
        if rows:
            catalog_ids = [row.get('catalogId') if isinstance(row, dict) else row.catalog_id for row in rows]
            stats = await cls.catalog_question_counts(db, catalog_ids, cls._include_disabled(query_object))
            for row in rows:
                catalog_id = row.get('catalogId') if isinstance(row, dict) else row.catalog_id
                if isinstance(row, dict):
                    row['direct_question_count'] = stats.get(catalog_id, 0)
                else:
                    row.direct_question_count = stats.get(catalog_id, 0)
        return page

    @classmethod
    async def catalog_question_counts(
        cls, db: AsyncSession, catalog_ids: list[int], include_disabled: bool = False
    ) -> dict[int, int]:
        if not catalog_ids:
            return {}
        query = (
            select(QbQuestionCatalog.catalog_id, func.count(func.distinct(QbQuestionCatalog.question_id)))
            .join(QbQuestion, QbQuestion.question_id == QbQuestionCatalog.question_id)
            .where(
                QbQuestionCatalog.catalog_id.in_(catalog_ids),
                QbQuestionCatalog.relation_type == 'query_catalog',
            )
        )
        if not include_disabled:
            query = query.where(QbQuestion.status == '0')
        result = await db.execute(query.group_by(QbQuestionCatalog.catalog_id))
        return {int(catalog_id): int(count) for catalog_id, count in result.all()}

    @classmethod
    async def get_version(cls, db: AsyncSession, version_id: int) -> QbTextbookVersion | None:
        return (
            (await db.execute(select(QbTextbookVersion).where(QbTextbookVersion.version_id == version_id)))
            .scalars()
            .first()
        )

    @classmethod
    async def get_textbook(cls, db: AsyncSession, textbook_id: int) -> QbTextbook | None:
        return (await db.execute(select(QbTextbook).where(QbTextbook.textbook_id == textbook_id))).scalars().first()

    @classmethod
    async def get_catalog(cls, db: AsyncSession, catalog_id: int) -> QbCatalogNode | None:
        return (await db.execute(select(QbCatalogNode).where(QbCatalogNode.catalog_id == catalog_id))).scalars().first()

    @classmethod
    async def get_catalogs(cls, db: AsyncSession, catalog_ids: list[int]) -> list[QbCatalogNode]:
        """Load catalog rows for validating a manual question's scope."""
        if not catalog_ids:
            return []
        result = await db.execute(
            select(QbCatalogNode)
            .where(QbCatalogNode.catalog_id.in_(catalog_ids))
            .order_by(QbCatalogNode.sort_order, QbCatalogNode.catalog_id)
        )
        return list(result.scalars().all())

    @classmethod
    async def get_question(cls, db: AsyncSession, question_id: int) -> QbQuestion | None:
        return await cls.get_question_detail(db, question_id)

    @classmethod
    async def add_entity(cls, db: AsyncSession, entity: Any) -> Any:
        db.add(entity)
        await db.flush()
        return entity

    @classmethod
    async def update_entity(cls, db: AsyncSession, entity: Any, values: dict[str, Any]) -> Any:
        for key, value in values.items():
            setattr(entity, key, value)
        await db.flush()
        return entity

    @classmethod
    async def delete_versions(cls, db: AsyncSession, ids: list[int]) -> None:
        await db.execute(delete(QbTextbookVersion).where(QbTextbookVersion.version_id.in_(ids)))

    @classmethod
    async def delete_textbooks(cls, db: AsyncSession, ids: list[int]) -> None:
        await db.execute(delete(QbTextbook).where(QbTextbook.textbook_id.in_(ids)))

    @classmethod
    async def delete_catalogs(cls, db: AsyncSession, ids: list[int]) -> None:
        await db.execute(delete(QbCatalogNode).where(QbCatalogNode.catalog_id.in_(ids)))

    @classmethod
    async def delete_questions(cls, db: AsyncSession, ids: list[int]) -> None:
        await db.execute(delete(QbQuestionCatalog).where(QbQuestionCatalog.question_id.in_(ids)))
        await db.execute(delete(QbQuestionTag).where(QbQuestionTag.question_id.in_(ids)))
        await db.execute(delete(QbQuestionAsset).where(QbQuestionAsset.question_id.in_(ids)))
        await db.execute(delete(QbQuestionReadiness).where(QbQuestionReadiness.question_id.in_(ids)))
        await db.execute(delete(QbQuestion).where(QbQuestion.question_id.in_(ids)))

    @classmethod
    async def relation_counts(cls, db: AsyncSession, table: Any, column: Any, ids: list[int]) -> dict[int, int]:
        if not ids:
            return {}
        result = await db.execute(select(column, func.count('*')).where(column.in_(ids)).group_by(column))
        return {int(key): int(count) for key, count in result.all()}

    @classmethod
    async def textbook_catalog_counts(cls, db: AsyncSession, ids: list[int]) -> dict[int, int]:
        result = await db.execute(
            select(QbCatalogNode.textbook_id, func.count(QbCatalogNode.catalog_id))
            .where(QbCatalogNode.textbook_id.in_(ids))
            .group_by(QbCatalogNode.textbook_id)
        )
        return {int(key): int(count) for key, count in result.all()}

    @classmethod
    async def textbook_question_counts(cls, db: AsyncSession, ids: list[int]) -> dict[int, int]:
        result = await db.execute(
            select(QbCatalogNode.textbook_id, func.count(func.distinct(QbQuestionCatalog.question_id)))
            .join(QbQuestionCatalog, QbQuestionCatalog.catalog_id == QbCatalogNode.catalog_id)
            .join(QbQuestion, QbQuestion.question_id == QbQuestionCatalog.question_id)
            .where(
                QbCatalogNode.textbook_id.in_(ids),
            )
            .group_by(QbCatalogNode.textbook_id)
        )
        return {int(key): int(count) for key, count in result.all()}

    @classmethod
    async def catalog_child_counts(cls, db: AsyncSession, ids: list[int]) -> dict[int, int]:
        result = await db.execute(
            select(QbCatalogNode.parent_id, func.count(QbCatalogNode.catalog_id))
            .where(QbCatalogNode.parent_id.in_(ids))
            .group_by(QbCatalogNode.parent_id)
        )
        return {int(key): int(count) for key, count in result.all() if key is not None}

    @classmethod
    async def catalog_relation_counts(cls, db: AsyncSession, ids: list[int]) -> dict[int, int]:
        result = await db.execute(
            select(QbQuestionCatalog.catalog_id, func.count('*'))
            .where(QbQuestionCatalog.catalog_id.in_(ids))
            .group_by(QbQuestionCatalog.catalog_id)
        )
        return {int(key): int(count) for key, count in result.all()}

    @classmethod
    async def catalog_parent_chain(cls, db: AsyncSession, catalog_id: int) -> list[int]:
        chain: list[int] = []
        current = catalog_id
        for _ in range(MAX_CATALOG_DEPTH):
            row = await cls.get_catalog(db, current)
            if row is None or row.parent_id is None:
                break
            if row.parent_id in chain or row.parent_id == catalog_id:
                raise ServiceException(message='目录层级存在循环')
            chain.append(int(row.parent_id))
            current = int(row.parent_id)
        else:
            raise ServiceException(message='目录层级超过最大深度')
        return chain

    @classmethod
    async def get_question_detail(cls, db: AsyncSession, question_id: int) -> QbQuestion | None:
        return (await db.execute(select(QbQuestion).where(QbQuestion.question_id == question_id))).scalars().first()

    @classmethod
    async def get_question_catalogs(cls, db: AsyncSession, question_id: int) -> list[QbQuestionCatalog]:
        result = await db.execute(
            select(QbQuestionCatalog)
            .where(QbQuestionCatalog.question_id == question_id)
            .order_by(QbQuestionCatalog.sort_order, QbQuestionCatalog.relation_id)
        )
        return list(result.scalars().all())

    @classmethod
    async def get_question_tags(cls, db: AsyncSession, question_id: int) -> list[QbQuestionTag]:
        result = await db.execute(
            select(QbQuestionTag)
            .where(QbQuestionTag.question_id == question_id)
            .order_by(QbQuestionTag.sort_order, QbQuestionTag.tag_id)
        )
        return list(result.scalars().all())

    @classmethod
    async def replace_question_catalogs(
        cls, db: AsyncSession, question_id: int, catalog_ids: list[int], now: datetime | None = None
    ) -> None:
        """Replace only the manually maintained query-catalog relationships."""
        await db.execute(
            delete(QbQuestionCatalog).where(
                QbQuestionCatalog.question_id == question_id,
                QbQuestionCatalog.relation_type == 'query_catalog',
            )
        )
        timestamp = now or datetime.now()
        db.add_all(
            [
                QbQuestionCatalog(
                    question_id=question_id,
                    catalog_id=catalog_id,
                    relation_type='query_catalog',
                    evidence_type='provider_asserted',
                    sort_order=index,
                    create_time=timestamp,
                    update_time=timestamp,
                )
                for index, catalog_id in enumerate(catalog_ids)
            ]
        )
        await db.flush()

    @classmethod
    async def replace_question_tags(
        cls, db: AsyncSession, question_id: int, tags: list[dict[str, str]], now: datetime | None = None
    ) -> None:
        await db.execute(delete(QbQuestionTag).where(QbQuestionTag.question_id == question_id))
        timestamp = now or datetime.now()
        db.add_all(
            [
                QbQuestionTag(
                    question_id=question_id,
                    tag_type=tag['tag_type'],
                    tag_name=tag['tag_name'],
                    relation_type=tag.get('relation_type', 'provider_asserted'),
                    evidence_type='provider_asserted',
                    sort_order=index,
                    create_time=timestamp,
                    update_time=timestamp,
                )
                for index, tag in enumerate(tags)
            ]
        )
        await db.flush()

    @classmethod
    async def get_question_assets(cls, db: AsyncSession, question_id: int) -> list[QbQuestionAsset]:
        result = await db.execute(
            select(QbQuestionAsset)
            .where(QbQuestionAsset.question_id == question_id)
            .order_by(QbQuestionAsset.sort_order, QbQuestionAsset.asset_id)
        )
        return list(result.scalars().all())

    @classmethod
    async def get_asset_by_key(cls, db: AsyncSession, question_id: int, asset_key: str) -> QbQuestionAsset | None:
        return (
            (
                await db.execute(
                    select(QbQuestionAsset).where(
                        QbQuestionAsset.question_id == question_id,
                        QbQuestionAsset.asset_key == asset_key,
                    )
                )
            )
            .scalars()
            .first()
        )

    @classmethod
    async def list_assets(
        cls, db: AsyncSession, question_id: int | None = None, asset_type: str | None = None
    ) -> list[QbQuestionAsset]:
        query = select(QbQuestionAsset)
        if question_id is not None:
            query = query.where(QbQuestionAsset.question_id == question_id)
        if asset_type:
            query = query.where(QbQuestionAsset.asset_type == asset_type)
        result = await db.execute(query.order_by(QbQuestionAsset.sort_order, QbQuestionAsset.asset_id))
        return list(result.scalars().all())

    @classmethod
    async def list_questions(  # noqa: PLR0912
        cls, db: AsyncSession, query_object: QuestionPageQueryModel
    ) -> PageModel:
        query = cls._apply_status_filter(select(QbQuestion), QbQuestion.status, query_object)
        if query_object.usable_only:
            from plugins.bank.service.coverage_queries import usable_scope_predicate
            if query_object.textbook_id or query_object.catalog_id:
                from plugins.bank.service.question_readiness import usable_predicate
                query = query.where(usable_predicate())
            else:
                query = query.where(usable_scope_predicate())
        if getattr(query_object, 'subject_id', None):
            query = query.where(QbQuestion.subject_id == query_object.subject_id)
        if query_object.source_provider:
            query = query.where(QbQuestion.source_provider == query_object.source_provider)
        if query_object.keyword:
            value = f'%{query_object.keyword}%'
            query = query.where(
                or_(
                    QbQuestion.plain_text.ilike(value),
                    QbQuestion.source_text.ilike(value),
                    QbQuestion.content_html.ilike(value),
                    QbQuestion.paper_name.ilike(value),
                )
            )
        for field_name in ('year', 'grade', 'term', 'province', 'city', 'exam_type', 'difficulty'):
            value = getattr(query_object, field_name, None)
            if value is not None and value != '':
                query = query.where(getattr(QbQuestion, field_name) == value)
        if query_object.question_type:
            if query_object.question_type == '解答题':
                query = query.where(
                    or_(QbQuestion.question_type == '解答题', QbQuestion.question_type.like('解答题-%'))
                )
            else:
                query = query.where(QbQuestion.question_type == query_object.question_type)
        if query_object.difficulty_min is not None:
            query = query.where(QbQuestion.difficulty_coefficient >= query_object.difficulty_min)
        if query_object.difficulty_max is not None:
            query = query.where(QbQuestion.difficulty_coefficient <= query_object.difficulty_max)

        # Each dimension is an AND group; values in one dimension are ORed.
        for tag_type, names in (
            ('scene', query_object.scene),
            ('category', query_object.category),
            ('exam_method', query_object.exam_method),
        ):
            if names:
                query = query.where(
                    exists(
                        select(1).where(
                            QbQuestionTag.question_id == QbQuestion.question_id,
                            QbQuestionTag.tag_type == tag_type,
                            QbQuestionTag.tag_name.in_(names),
                        )
                    )
                )

        include_disabled = cls._include_disabled(query_object) and not query_object.usable_only
        catalog_status = None if include_disabled else '0'
        if query_object.usable_only and (query_object.textbook_id or query_object.catalog_id):
            from plugins.bank.service.coverage_queries import enabled_scope
            scope_query = (select(1).select_from(QbQuestionCatalog)
                           .join(QbCatalogNode, QbCatalogNode.catalog_id == QbQuestionCatalog.catalog_id)
                           .join(QbTextbook, QbTextbook.textbook_id == QbCatalogNode.textbook_id)
                           .join(QbTextbookVersion, QbTextbookVersion.version_id == QbTextbook.version_id)
                           .join(QbSubject, QbSubject.subject_id == QbTextbook.subject_id).where(
                               QbQuestionCatalog.question_id == QbQuestion.question_id,
                               QbQuestionCatalog.relation_type == 'query_catalog', enabled_scope(),
                           ))
            if query_object.textbook_id:
                scope_query = scope_query.where(QbTextbook.textbook_id == query_object.textbook_id)
            if query_object.catalog_id:
                requested = await cls.get_catalog(db, query_object.catalog_id)
                if requested is None:
                    query = query.where(False)
                else:
                    scope_query = scope_query.where(QbTextbook.textbook_id == requested.textbook_id,
                                                   requested.status == '0')
            query = query.where(exists(scope_query))
        if query_object.textbook_id and not query_object.usable_only:
            query = query.where(
                exists(
                    select(1)
                    .select_from(QbQuestionCatalog)
                    .join(QbCatalogNode, QbCatalogNode.catalog_id == QbQuestionCatalog.catalog_id)
                    .where(
                        QbQuestionCatalog.question_id == QbQuestion.question_id,
                        QbCatalogNode.textbook_id == query_object.textbook_id,
                        QbCatalogNode.subject_id == QbQuestion.subject_id,
                        QbQuestionCatalog.relation_type == 'query_catalog',
                        QbCatalogNode.status == catalog_status if catalog_status is not None else True,
                    )
                )
            )
        if query_object.catalog_id:
            ids = await cls._catalog_descendant_ids(
                db, query_object.catalog_id, query_object.textbook_id, catalog_status
            )
            if not ids:
                query = query.where(False)
            else:
                query = query.where(
                    exists(
                        select(1).select_from(QbQuestionCatalog)
                        .join(QbCatalogNode, QbCatalogNode.catalog_id == QbQuestionCatalog.catalog_id).where(
                            QbQuestionCatalog.question_id == QbQuestion.question_id,
                            QbCatalogNode.subject_id == QbQuestion.subject_id,
                            QbQuestionCatalog.catalog_id.in_(ids),
                            QbQuestionCatalog.relation_type == 'query_catalog',
                        )
                    )
                )

        sort_column = cls._QUESTION_SORTS.get(query_object.sort, QbQuestion.question_id)
        query = query.order_by(
            sort_column.asc() if query_object.order == 'asc' else sort_column.desc(),
            QbQuestion.question_id,
        )
        return await PageUtil.paginate(db, query, query_object.page_num, query_object.page_size, True)

    @classmethod
    def catalog_descendant_query(cls, root_id: int, textbook_id: int | None = None, status: str | None = '0') -> Any:
        """Build a MySQL 8 recursive CTE scoped to one textbook.

        The depth guard prevents malformed cyclic source data from running
        forever while still supporting the normal chapter/section hierarchy.
        """
        root = select(
            QbCatalogNode.catalog_id.label('catalog_id'),
            QbCatalogNode.parent_id.label('parent_id'),
            QbCatalogNode.textbook_id.label('textbook_id'),
            func.cast(0, type_=QbCatalogNode.sort_order.type).label('depth'),
        ).where(QbCatalogNode.catalog_id == root_id)
        if status is not None:
            root = root.where(QbCatalogNode.status == status)
        if textbook_id is not None:
            root = root.where(QbCatalogNode.textbook_id == textbook_id)
        descendants = root.cte('bank_catalog_descendants', recursive=True)
        child = (
            select(
                QbCatalogNode.catalog_id,
                QbCatalogNode.parent_id,
                QbCatalogNode.textbook_id,
                (descendants.c.depth + 1).label('depth'),
            )
            .join(descendants, QbCatalogNode.parent_id == descendants.c.catalog_id)
            .where(
                QbCatalogNode.textbook_id == descendants.c.textbook_id,
                descendants.c.depth < MAX_CATALOG_DEPTH,
            )
        )
        if status is not None:
            child = child.where(QbCatalogNode.status == status)
        descendants = descendants.union_all(child)
        return select(descendants.c.catalog_id).order_by(descendants.c.depth, descendants.c.catalog_id)

    @classmethod
    async def _catalog_descendant_ids(
        cls, db: AsyncSession, root_id: int, textbook_id: int | None = None, status: str | None = '0'
    ) -> list[int]:
        result = await db.execute(cls.catalog_descendant_query(root_id, textbook_id, status))
        return [int(row[0]) for row in result.all()]

    @classmethod
    async def list_batches(cls, db: AsyncSession, query_object: BatchPageQueryModel) -> PageModel:
        query = select(QbSyncBatch)
        for field_name in ('batch_no', 'batch_type', 'status', 'source_provider'):
            value = getattr(query_object, field_name, None)
            if value:
                query = query.where(getattr(QbSyncBatch, field_name) == value)
        query = query.order_by(QbSyncBatch.create_time.desc(), QbSyncBatch.batch_id.desc())
        return await PageUtil.paginate(db, query, query_object.page_num, query_object.page_size, True)

    @classmethod
    async def get_batch(cls, db: AsyncSession, batch_id: int) -> QbSyncBatch | None:
        return (await db.execute(select(QbSyncBatch).where(QbSyncBatch.batch_id == batch_id))).scalars().first()

    @classmethod
    async def approve_batch(cls, db: AsyncSession, batch_id: int, username: str) -> int:
        result = await db.execute(
            update(QbSyncBatch)
            .where(QbSyncBatch.batch_id == batch_id, QbSyncBatch.status == 'approval_pending')
            .values(status='approved', approved_by=username, approved_at=func.now(), update_time=func.now())
        )
        try:
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        return int(result.rowcount or 0)

    @classmethod
    async def request_publish(cls, db: AsyncSession, batch_id: int) -> int:
        result = await db.execute(
            update(QbSyncBatch)
            .where(QbSyncBatch.batch_id == batch_id, QbSyncBatch.status == 'approved')
            .values(status='publishing', started_at=func.now(), update_time=func.now())
        )
        try:
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        return int(result.rowcount or 0)

    @classmethod
    async def create_rollback_batch(cls, db: AsyncSession, target: QbSyncBatch) -> QbSyncBatch:
        current = (
            (
                await db.execute(
                    select(QbSyncBatch)
                    .where(QbSyncBatch.status == 'published')
                    .order_by(QbSyncBatch.published_at.desc())
                )
            )
            .scalars()
            .first()
        )
        now = datetime.now()
        rollback = QbSyncBatch(
            batch_no=f'rollback-{target.batch_id}-{now.strftime("%Y%m%d%H%M%S%f")}',
            batch_type='rollback',
            source_provider=target.source_provider,
            schema_version=target.schema_version,
            artifact_uri=target.artifact_uri,
            artifact_sha256=target.artifact_sha256,
            status='publishing',
            previous_batch_id=current.batch_id if current else None,
            restored_from_batch_id=target.batch_id,
            question_count=target.question_count,
            catalog_count=target.catalog_count,
            tag_count=target.tag_count,
            asset_count=target.asset_count,
            started_at=now,
            create_time=now,
            update_time=now,
        )
        db.add(rollback)
        try:
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            raise ServiceException(message='回退批次创建冲突，请刷新后重试') from exc
        except Exception:
            await db.rollback()
            raise
        await db.refresh(rollback)
        return rollback
