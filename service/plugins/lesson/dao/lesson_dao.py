"""教案插件数据访问：只读 qb_*，读写 lp_*。"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import case, delete, func, select, update

from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbQuestionAsset,
    QbQuestionCatalog,
    QbTextbook,
)
from plugins.lesson.entity.do.lesson_do import LpGeneration, LpGenerationItem, LpPickRule, LpScheme
from plugins.lesson.service.pick_engine import Candidate
from utils.page_util import PageUtil

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from common.vo import PageModel
    from plugins.lesson.entity.vo.lesson_vo import GenerationPageQueryModel

_QUESTION_DETAIL_COLUMNS = (
    QbQuestion.question_id,
    QbQuestion.question_type,
    QbQuestion.difficulty,
    QbQuestion.difficulty_coefficient,
    QbQuestion.year,
    QbQuestion.province,
    QbQuestion.city,
    QbQuestion.exam_type,
    QbQuestion.paper_name,
    QbQuestion.source_text,
    QbQuestion.subquestion_count,
    QbQuestion.answer_status,
    QbQuestion.content_html,
    QbQuestion.plain_text,
    QbQuestion.answer_html,
    QbQuestion.analysis_html,
)


def _to_float(value: Any) -> float | None:
    return None if value is None else float(value)


class LessonDao:
    # ---------- 题库只读 ----------

    @classmethod
    async def get_textbook(cls, db: AsyncSession, textbook_id: int) -> QbTextbook | None:
        return (await db.execute(select(QbTextbook).where(QbTextbook.textbook_id == textbook_id))).scalars().first()

    @classmethod
    async def get_catalog_nodes(cls, db: AsyncSession, textbook_id: int) -> list[QbCatalogNode]:
        result = await db.execute(
            select(QbCatalogNode)
            .where(QbCatalogNode.textbook_id == textbook_id, QbCatalogNode.status == '0')
            .order_by(QbCatalogNode.sort_order, QbCatalogNode.catalog_id)
        )
        return list(result.scalars().all())

    @classmethod
    async def load_candidates(cls, db: AsyncSession, textbook_id: int, catalog_ids: list[int]) -> list[Candidate]:
        """一次性加载命中任一目录的启用题目，附带教材内知识点、素材与表格信息。"""
        if not catalog_ids:
            return []
        matched_ids = (
            select(QbQuestionCatalog.question_id)
            .where(QbQuestionCatalog.catalog_id.in_(catalog_ids))
            .distinct()
            .scalar_subquery()
        )
        has_table = case((QbQuestion.content_html.like('%<table%'), 1), else_=0)
        question_rows = (
            await db.execute(
                select(
                    QbQuestion.question_id,
                    QbQuestion.question_type,
                    QbQuestion.difficulty,
                    QbQuestion.difficulty_coefficient,
                    QbQuestion.year,
                    QbQuestion.province,
                    QbQuestion.city,
                    QbQuestion.exam_type,
                    QbQuestion.paper_name,
                    QbQuestion.source_text,
                    QbQuestion.subquestion_count,
                    QbQuestion.assemble_count,
                    has_table.label('has_table'),
                )
                .where(QbQuestion.question_id.in_(matched_ids), QbQuestion.status == '0')
                .order_by(QbQuestion.question_id)
            )
        ).all()
        if not question_rows:
            return []

        relation_rows = (
            await db.execute(
                select(
                    QbQuestionCatalog.question_id,
                    QbQuestionCatalog.catalog_id,
                    QbQuestionCatalog.evidence_type,
                    QbCatalogNode.node_type,
                )
                .join(QbCatalogNode, QbCatalogNode.catalog_id == QbQuestionCatalog.catalog_id)
                .where(
                    QbQuestionCatalog.question_id.in_(matched_ids),
                    QbCatalogNode.textbook_id == textbook_id,
                    QbCatalogNode.status == '0',
                )
            )
        ).all()
        asset_rows = (
            await db.execute(
                select(QbQuestionAsset.question_id, func.count(QbQuestionAsset.asset_id))
                .where(QbQuestionAsset.question_id.in_(matched_ids))
                .group_by(QbQuestionAsset.question_id)
            )
        ).all()

        wanted = {int(item) for item in catalog_ids}
        points: dict[int, set[int]] = {}
        evidence: dict[int, dict[int, str]] = {}
        for raw_question_id, raw_catalog_id, evidence_type, node_type in relation_rows:
            question_id, catalog_id = int(raw_question_id), int(raw_catalog_id)
            if node_type == 'point':
                points.setdefault(question_id, set()).add(catalog_id)
            if catalog_id in wanted:
                current = evidence.setdefault(question_id, {})
                if current.get(catalog_id) != 'provider_asserted':
                    current[catalog_id] = str(evidence_type or 'query_membership')
        asset_counts = {int(question_id): int(count) for question_id, count in asset_rows}

        candidates: list[Candidate] = []
        for row in question_rows:
            question_id = int(row.question_id)
            candidates.append(
                Candidate(
                    question_id=question_id,
                    question_type=row.question_type,
                    difficulty=row.difficulty,
                    ease=_to_float(row.difficulty_coefficient),
                    year=int(row.year) if row.year is not None else None,
                    province=row.province,
                    city=row.city,
                    exam_type=row.exam_type,
                    paper_name=row.paper_name,
                    source_text=row.source_text,
                    subquestion_count=int(row.subquestion_count) if row.subquestion_count is not None else None,
                    assemble_count=int(row.assemble_count) if row.assemble_count is not None else None,
                    asset_count=asset_counts.get(question_id, 0),
                    has_table=bool(row.has_table),
                    point_ids=frozenset(points.get(question_id, set())),
                    evidence_by_catalog=evidence.get(question_id, {}),
                )
            )
        return candidates

    @classmethod
    async def get_question_details(cls, db: AsyncSession, question_ids: list[int]) -> dict[int, dict[str, Any]]:
        if not question_ids:
            return {}
        rows = (
            await db.execute(select(*_QUESTION_DETAIL_COLUMNS).where(QbQuestion.question_id.in_(question_ids)))
        ).all()
        details: dict[int, dict[str, Any]] = {}
        for row in rows:
            data = dict(row._mapping)
            data['difficulty_coefficient'] = _to_float(data.get('difficulty_coefficient'))
            details[int(row.question_id)] = data
        return details

    @classmethod
    async def get_question_assets(cls, db: AsyncSession, question_ids: list[int]) -> dict[int, list[QbQuestionAsset]]:
        if not question_ids:
            return {}
        rows = (
            await db.execute(
                select(QbQuestionAsset)
                .where(QbQuestionAsset.question_id.in_(question_ids))
                .order_by(QbQuestionAsset.question_id, QbQuestionAsset.sort_order, QbQuestionAsset.asset_id)
            )
        ).scalars()
        grouped: dict[int, list[QbQuestionAsset]] = {}
        for asset in rows:
            grouped.setdefault(int(asset.question_id), []).append(asset)
        return grouped

    @classmethod
    async def get_asset_by_key(cls, db: AsyncSession, question_id: int, asset_key: str) -> QbQuestionAsset | None:
        result = await db.execute(
            select(QbQuestionAsset).where(
                QbQuestionAsset.question_id == question_id, QbQuestionAsset.asset_key == asset_key
            )
        )
        return result.scalars().first()

    # ---------- lp_* 读写 ----------

    @classmethod
    async def insert_scheme(cls, db: AsyncSession, values: dict[str, Any]) -> LpScheme:
        now = datetime.now()
        scheme = LpScheme(**values, create_time=now, update_time=now)
        db.add(scheme)
        await db.flush()
        return scheme

    @classmethod
    async def insert_rules(cls, db: AsyncSession, scheme_id: int, rules: list[dict[str, Any]]) -> list[LpPickRule]:
        now = datetime.now()
        rows = [LpPickRule(**rule, scheme_id=scheme_id, create_time=now) for rule in rules]
        db.add_all(rows)
        await db.flush()
        return rows

    @classmethod
    async def get_scheme(cls, db: AsyncSession, scheme_id: int) -> LpScheme | None:
        return (await db.execute(select(LpScheme).where(LpScheme.scheme_id == scheme_id))).scalars().first()

    @classmethod
    async def get_rules(cls, db: AsyncSession, scheme_id: int) -> list[LpPickRule]:
        result = await db.execute(
            select(LpPickRule).where(LpPickRule.scheme_id == scheme_id).order_by(LpPickRule.sort_no, LpPickRule.rule_id)
        )
        return list(result.scalars().all())

    @classmethod
    async def insert_generation(cls, db: AsyncSession, values: dict[str, Any]) -> LpGeneration:
        now = datetime.now()
        generation = LpGeneration(**values, create_time=now, update_time=now)
        db.add(generation)
        await db.flush()
        return generation

    @classmethod
    async def insert_items(cls, db: AsyncSession, generation_id: int, items: list[dict[str, Any]]) -> None:
        now = datetime.now()
        db.add_all(
            [LpGenerationItem(**item, generation_id=generation_id, create_time=now, update_time=now) for item in items]
        )
        await db.flush()

    @classmethod
    async def get_generation(cls, db: AsyncSession, generation_id: int) -> LpGeneration | None:
        result = await db.execute(select(LpGeneration).where(LpGeneration.generation_id == generation_id))
        return result.scalars().first()

    @classmethod
    async def get_items(cls, db: AsyncSession, generation_id: int) -> list[LpGenerationItem]:
        result = await db.execute(
            select(LpGenerationItem)
            .where(LpGenerationItem.generation_id == generation_id)
            .order_by(LpGenerationItem.rule_id, LpGenerationItem.sort_no, LpGenerationItem.item_id)
        )
        return list(result.scalars().all())

    @classmethod
    async def get_item(cls, db: AsyncSession, generation_id: int, item_id: int) -> LpGenerationItem | None:
        result = await db.execute(
            select(LpGenerationItem).where(
                LpGenerationItem.generation_id == generation_id, LpGenerationItem.item_id == item_id
            )
        )
        return result.scalars().first()

    @classmethod
    async def update_item_question(
        cls,
        db: AsyncSession,
        item_id: int,
        *,
        question_id: int,
        score: float | None,
        relax_level: int,
        matched_catalog_ids: list[int],
        evidence_type: str | None,
        replaced_from_question_id: int,
        question_snapshot_json: dict[str, Any],
    ) -> None:
        await db.execute(
            update(LpGenerationItem)
            .where(LpGenerationItem.item_id == item_id)
            .values(
                question_id=question_id,
                score=score,
                relax_level=relax_level,
                matched_catalog_ids=matched_catalog_ids,
                evidence_type=evidence_type,
                replaced_from_question_id=replaced_from_question_id,
                question_snapshot_json=question_snapshot_json,
                update_time=datetime.now(),
            )
        )

    @classmethod
    async def update_generation(cls, db: AsyncSession, generation_id: int, values: dict[str, Any]) -> None:
        await db.execute(
            update(LpGeneration)
            .where(LpGeneration.generation_id == generation_id)
            .values(**values, update_time=datetime.now())
        )

    @classmethod
    async def list_generations(cls, db: AsyncSession, query: GenerationPageQueryModel) -> PageModel:
        item_count = (
            select(func.count(LpGenerationItem.item_id))
            .where(LpGenerationItem.generation_id == LpGeneration.generation_id)
            .scalar_subquery()
        )
        statement = (
            select(
                LpGeneration.generation_id,
                LpGeneration.scheme_id,
                LpScheme.scheme_name,
                LpScheme.textbook_id,
                QbTextbook.textbook_name,
                LpScheme.lesson_type,
                LpGeneration.seed,
                LpGeneration.status,
                LpGeneration.lesson_json,
                item_count.label('item_count'),
                LpGeneration.create_by,
                LpGeneration.create_time,
            )
            .join(LpScheme, LpScheme.scheme_id == LpGeneration.scheme_id)
            .outerjoin(QbTextbook, QbTextbook.textbook_id == LpScheme.textbook_id)
            .where(LpGeneration.editor_schema_version == 1)
            .order_by(LpGeneration.generation_id.desc())
        )
        if query.textbook_id:
            statement = statement.where(LpScheme.textbook_id == query.textbook_id)
        if query.keyword:
            statement = statement.where(LpScheme.scheme_name.like(f'%{query.keyword.strip()}%'))
        return await PageUtil.paginate(db, statement, query.page_num, query.page_size, True)

    @classmethod
    async def delete_generations(cls, db: AsyncSession, generation_ids: list[int]) -> int:
        await db.execute(delete(LpGenerationItem).where(LpGenerationItem.generation_id.in_(generation_ids)))
        result = await db.execute(delete(LpGeneration).where(LpGeneration.generation_id.in_(generation_ids)))
        return int(result.rowcount or 0)
