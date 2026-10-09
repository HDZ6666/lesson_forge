"""教案生成编排：规则准备、模拟、生成、换题、文字保存与详情装配。"""

from __future__ import annotations

import os
import secrets
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException

from exceptions.exception import ServiceException
from plugins.bank.dao.bank_dao import BankDao
from plugins.lesson.dao.lesson_dao import LessonDao
from plugins.lesson.entity.vo.lesson_vo import (
    DefaultRulesRequestModel,
    GenerationDetailModel,
    GenerationItemModel,
    GenerationPageQueryModel,
    GenerationPhaseModel,
    GenerationQuestionModel,
    GenerationSummaryRowModel,
    QuestionAssetRefModel,
    RuleInputModel,
    RuleSimulationModel,
    RuleSummaryModel,
    SchemeInputModel,
    SimulateRequestModel,
    TextUpdateModel,
)
from plugins.lesson.service import templates
from plugins.lesson.service.pick_engine import (
    Candidate,
    PickResult,
    Preference,
    RuleSpec,
    pick_for_rule,
    pick_replacement,
    satisfied_level,
    simulate_rule,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from common.vo import PageModel
    from plugins.bank.entity.do.bank_do import QbCatalogNode, QbQuestionAsset
    from plugins.lesson.entity.do.lesson_do import LpGeneration, LpPickRule, LpScheme

MAX_SEED = 2**53
_AVAILABLE_ASSET_STATUS = {'ready', 'downloaded'}


def _dump(model: object) -> dict:
    return model.model_dump(by_alias=True, exclude_none=False)  # type: ignore[union-attr]


def _yn(value: bool) -> str:
    return 'Y' if value else 'N'


class _Context:
    """一次教材内的目录索引与候选缓存。"""

    def __init__(self, textbook: Any, nodes: list[QbCatalogNode]) -> None:
        self.textbook = textbook
        self.nodes = {int(node.catalog_id): node for node in nodes}
        self.children: dict[int | None, list[int]] = {}
        for node in nodes:
            parent = int(node.parent_id) if node.parent_id is not None else None
            self.children.setdefault(parent, []).append(int(node.catalog_id))

    def descendant_points(self, catalog_id: int) -> list[int]:
        node = self.nodes.get(catalog_id)
        if node is None:
            return []
        if node.node_type == 'point' or not self.children.get(catalog_id):
            return [catalog_id]
        result: list[int] = []
        stack = list(self.children.get(catalog_id, []))
        while stack:
            current = stack.pop()
            current_node = self.nodes[current]
            if current_node.node_type == 'point' or not self.children.get(current):
                result.append(current)
            else:
                stack.extend(self.children.get(current, []))
        return sorted(set(result))

    def expand(self, catalog_ids: list[int]) -> list[int]:
        expanded: list[int] = []
        for catalog_id in catalog_ids:
            if int(catalog_id) not in self.nodes:
                raise ServiceException(message=f'目录 {catalog_id} 不属于所选教材')
            for point in self.descendant_points(int(catalog_id)):
                if point not in expanded:
                    expanded.append(point)
        return expanded

    def path_name(self, catalog_id: int) -> str:
        parts: list[str] = []
        current: int | None = catalog_id
        seen: set[int] = set()
        while current is not None and current in self.nodes and current not in seen:
            seen.add(current)
            node = self.nodes[current]
            parts.append(str(node.node_name))
            current = int(node.parent_id) if node.parent_id is not None else None
        return ' › '.join(reversed(parts))

    def node_name(self, catalog_id: int) -> str:
        node = self.nodes.get(catalog_id)
        return str(node.node_name) if node is not None else str(catalog_id)


def _rule_spec(rule: RuleInputModel, catalog_ids: list[int], key: str) -> RuleSpec:
    return RuleSpec(
        rule_key=key,
        phase=rule.phase,
        catalog_ids=tuple(catalog_ids),
        question_count=rule.question_count,
        question_types=tuple(rule.question_types),
        ease_min=rule.ease_min,
        ease_max=rule.ease_max,
        max_extra_points=rule.max_extra_points,
        max_subquestion_count=rule.max_subquestion_count,
        allow_image=rule.allow_image,
        allow_table=rule.allow_table,
        rule_name=rule.rule_name,
    )


def _rule_input_from_row(row: LpPickRule) -> RuleInputModel:
    return RuleInputModel(
        rule_id=int(row.rule_id),
        phase=row.phase,
        rule_name=row.rule_name,
        catalog_ids=[int(item) for item in (row.catalog_ids or [])],
        question_count=int(row.question_count),
        question_types=list(row.question_types or []),
        ease_min=float(row.ease_min) if row.ease_min is not None else None,
        ease_max=float(row.ease_max) if row.ease_max is not None else None,
        max_extra_points=int(row.max_extra_points),
        max_subquestion_count=int(row.max_subquestion_count) if row.max_subquestion_count is not None else None,
        allow_image=row.allow_image == 'Y',
        allow_table=row.allow_table == 'Y',
        sort_no=int(row.sort_no),
    )


def _preference_from_scheme(scheme: LpScheme) -> Preference:
    return Preference(
        current_year=datetime.now().year,
        recent_years=int(scheme.recent_years or 0),
        province=scheme.preferred_province or None,
        city=scheme.preferred_city or None,
        exam_types=tuple(scheme.preferred_exam_types or []),
        prefer_real_exam=scheme.prefer_real_exam == 'Y',
    )


def _sorted_rules(rules: list[RuleInputModel]) -> list[RuleInputModel]:
    return sorted(
        rules,
        key=lambda rule: (
            rule.sort_no if rule.sort_no is not None else 10**6,
            templates.PHASE_ORDER.get(rule.phase, 99),
        ),
    )


class LessonService:
    # ---------- 选项与默认规则 ----------

    @classmethod
    def options(cls) -> dict[str, Any]:
        return templates.options_payload()

    @classmethod
    async def default_rules(cls, db: AsyncSession, payload: DefaultRulesRequestModel) -> list[dict[str, Any]]:
        context = await cls._load_context_for_catalogs(db, payload.catalog_ids)
        points = [
            {'catalogId': catalog_id, 'name': context.node_name(catalog_id)}
            for catalog_id in context.expand(payload.catalog_ids)
        ]
        return templates.default_rules(payload.lesson_type, points)

    @classmethod
    async def _load_context_for_catalogs(cls, db: AsyncSession, catalog_ids: list[int]) -> _Context:
        # 目录必须属于同一教材；用第一个目录定位教材再整体校验。
        first = await BankDao.get_catalog(db, int(catalog_ids[0]))
        if first is None:
            raise ServiceException(message='知识点目录不存在')
        return await cls._load_context(db, int(first.textbook_id))

    @classmethod
    async def _load_context(cls, db: AsyncSession, textbook_id: int) -> _Context:
        textbook = await LessonDao.get_textbook(db, textbook_id)
        if textbook is None:
            raise ServiceException(message='教材不存在')
        nodes = await LessonDao.get_catalog_nodes(db, textbook_id)
        return _Context(textbook, nodes)

    # ---------- 模拟 ----------

    @classmethod
    async def simulate(cls, db: AsyncSession, payload: SimulateRequestModel) -> list[dict[str, Any]]:
        context = await cls._load_context(db, payload.textbook_id)
        specs = [
            _rule_spec(rule, context.expand(rule.catalog_ids), f'sim:{index}')
            for index, rule in enumerate(payload.rules)
        ]
        candidates = await cls._load_candidates(db, payload.textbook_id, specs)
        rows: list[dict[str, Any]] = []
        for index, (rule, spec) in enumerate(zip(payload.rules, specs, strict=True)):
            counts = simulate_rule(cls._candidates_for(candidates, spec), spec)
            level = satisfied_level(counts, spec.question_count)
            if level is None:
                message = f'即使兜底放宽也只有 {counts[-1]} 题，需要 {spec.question_count} 题'
            elif level == 0:
                message = '题量充足'
            else:
                message = f'需放宽到第 {level} 级才够 {spec.question_count} 题'
            rows.append(
                _dump(
                    RuleSimulationModel(
                        rule_index=index,
                        phase=rule.phase,
                        rule_name=rule.rule_name,
                        question_count=rule.question_count,
                        candidate_counts=counts,
                        satisfied_level=level,
                        message=message,
                    )
                )
            )
        return rows

    @classmethod
    async def _load_candidates(cls, db: AsyncSession, textbook_id: int, specs: list[RuleSpec]) -> list[Candidate]:
        union: list[int] = []
        for spec in specs:
            for catalog_id in spec.catalog_ids:
                if catalog_id not in union:
                    union.append(catalog_id)
        return await LessonDao.load_candidates(db, textbook_id, union)

    @staticmethod
    def _candidates_for(candidates: list[Candidate], spec: RuleSpec) -> list[Candidate]:
        wanted = set(spec.catalog_ids)
        return [
            candidate for candidate in candidates if wanted & (set(candidate.evidence_by_catalog) | candidate.point_ids)
        ]

    # ---------- 生成 ----------

    @classmethod
    async def generate(cls, db: AsyncSession, payload: SchemeInputModel, operator: str | None) -> dict[str, Any]:
        context = await cls._load_context(db, payload.textbook_id)
        rules = _sorted_rules(payload.rules)
        point_ids = cls._all_points(context, rules)
        title = (payload.title or '').strip() or '、'.join(context.node_name(point) for point in point_ids)
        text = (
            _dump(payload.text)
            if payload.text
            else templates.default_text(
                payload.lesson_type, [context.node_name(point) for point in point_ids], context.textbook.textbook_name
            )
        )
        try:
            scheme = await LessonDao.insert_scheme(
                db,
                {
                    'scheme_name': (payload.scheme_name or '').strip() or title[:200],
                    'textbook_id': payload.textbook_id,
                    'lesson_type': payload.lesson_type,
                    'duration_minutes': payload.duration_minutes,
                    'recent_years': payload.recent_years,
                    'preferred_province': payload.preferred_province or None,
                    'preferred_city': payload.preferred_city or None,
                    'preferred_exam_types': payload.preferred_exam_types,
                    'prefer_real_exam': _yn(payload.prefer_real_exam),
                    'remark': payload.remark,
                    'create_by': operator,
                    'update_by': operator,
                },
            )
            rule_rows = await LessonDao.insert_rules(
                db,
                int(scheme.scheme_id),
                [
                    {
                        'sort_no': index,
                        'phase': rule.phase,
                        'rule_name': rule.rule_name,
                        'catalog_ids': context.expand(rule.catalog_ids),
                        'question_count': rule.question_count,
                        'question_types': rule.question_types,
                        'ease_min': rule.ease_min,
                        'ease_max': rule.ease_max,
                        'max_extra_points': rule.max_extra_points,
                        'max_subquestion_count': rule.max_subquestion_count,
                        'allow_image': _yn(rule.allow_image),
                        'allow_table': _yn(rule.allow_table),
                    }
                    for index, rule in enumerate(rules)
                ],
            )
            seed = payload.seed if payload.seed is not None else secrets.randbelow(MAX_SEED)
            lesson = cls._lesson_payload(context, scheme, point_ids, title, text, {rule.phase for rule in rules})
            generation = await cls._run_generation(db, context, scheme, rule_rows, seed, lesson, operator)
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        return await cls.detail(db, int(generation.generation_id))

    @classmethod
    async def regenerate(
        cls, db: AsyncSession, generation_id: int, operator: str | None, seed: int | None = None
    ) -> dict[str, Any]:
        previous = await cls._require_generation(db, generation_id)
        scheme = await LessonDao.get_scheme(db, int(previous.scheme_id))
        if scheme is None:
            raise ServiceException(message='抽题方案不存在')
        context = await cls._load_context(db, int(scheme.textbook_id))
        rule_rows = await LessonDao.get_rules(db, int(scheme.scheme_id))
        new_seed = seed if seed is not None else secrets.randbelow(MAX_SEED)
        if new_seed == int(previous.seed):
            new_seed = (new_seed + 1) % MAX_SEED
        lesson = dict(previous.lesson_json or {})
        lesson['regeneratedFrom'] = int(previous.generation_id)
        try:
            generation = await cls._run_generation(db, context, scheme, rule_rows, new_seed, lesson, operator)
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        return await cls.detail(db, int(generation.generation_id))

    @classmethod
    async def _run_generation(
        cls,
        db: AsyncSession,
        context: _Context,
        scheme: LpScheme,
        rule_rows: list[LpPickRule],
        seed: int,
        lesson: dict[str, Any],
        operator: str | None,
    ) -> LpGeneration:
        # 抖动按规则在方案中的位置播种，而不是数据库主键，保证同 seed 同规则可复现。
        specs = [
            _rule_spec(_rule_input_from_row(row), [int(item) for item in row.catalog_ids], f'rule:{index}')
            for index, row in enumerate(rule_rows)
        ]
        candidates = await cls._load_candidates(db, int(scheme.textbook_id), specs)
        preference = _preference_from_scheme(scheme)
        used: set[int] = set()
        results: list[tuple[LpPickRule, PickResult]] = []
        for row, spec in zip(rule_rows, specs, strict=True):
            results.append((row, pick_for_rule(cls._candidates_for(candidates, spec), spec, preference, seed, used)))
        summary = [
            _dump(
                RuleSummaryModel(
                    rule_id=int(row.rule_id),
                    phase=row.phase,
                    rule_name=row.rule_name,
                    needed=result.needed,
                    picked=len(result.items),
                    max_relax_level=result.max_relax_level,
                    short=result.short,
                    message=result.message,
                )
            )
            for row, result in results
        ]
        generation = await LessonDao.insert_generation(
            db,
            {
                'scheme_id': int(scheme.scheme_id),
                'seed': seed,
                'status': 'partial' if any(result.short for _, result in results) else 'ready',
                'rule_snapshot_json': [_dump(_rule_input_from_row(row)) for row in rule_rows],
                'scheme_snapshot_json': cls._scheme_snapshot(scheme),
                'summary_json': summary,
                'lesson_json': lesson,
                'create_by': operator,
                'update_by': operator,
            },
        )
        items: list[dict[str, Any]] = []
        for row, result in results:
            for index, item in enumerate(result.items):
                items.append(
                    {
                        'rule_id': int(row.rule_id),
                        'phase': row.phase,
                        'sort_no': index,
                        'question_id': item.question_id,
                        'score': item.score,
                        'relax_level': item.relax_level,
                        'matched_catalog_ids': list(item.matched_catalog_ids),
                        'evidence_type': item.evidence_type,
                    }
                )
        picked_ids = [int(item['question_id']) for item in items]
        details = await LessonDao.get_question_details(db, picked_ids)
        assets = await LessonDao.get_question_assets(db, picked_ids)
        for item in items:
            question_id = int(item['question_id'])
            item['question_snapshot_json'] = cls._question_snapshot(
                details.get(question_id), assets.get(question_id, [])
            )
        await LessonDao.insert_items(db, int(generation.generation_id), items)
        return generation

    @staticmethod
    def _all_points(context: _Context, rules: list[RuleInputModel]) -> list[int]:
        points: list[int] = []
        for rule in rules:
            for point in context.expand(rule.catalog_ids):
                if point not in points:
                    points.append(point)
        return points

    @staticmethod
    def _lesson_payload(
        context: _Context,
        scheme: LpScheme,
        point_ids: list[int],
        title: str,
        text: dict[str, Any],
        phases_present: set[str],
    ) -> dict[str, Any]:
        return {
            'title': title,
            'lessonType': scheme.lesson_type,
            'lessonTypeName': templates.LESSON_TYPE_NAMES.get(scheme.lesson_type, scheme.lesson_type),
            'durationMinutes': int(scheme.duration_minutes),
            'textbookId': int(scheme.textbook_id),
            'textbookName': context.textbook.textbook_name,
            'knowledgePoints': [
                {'catalogId': point, 'name': context.node_name(point), 'path': context.path_name(point)}
                for point in point_ids
            ],
            'text': text,
            'phases': [item for item in templates.PHASES if item['phase'] in phases_present],
        }

    # ---------- 换题与文字 ----------

    @classmethod
    async def replace_item(
        cls, db: AsyncSession, generation_id: int, item_id: int, operator: str | None
    ) -> dict[str, Any]:
        generation = await cls._require_generation(db, generation_id)
        item = await LessonDao.get_item(db, generation_id, item_id)
        if item is None:
            raise ServiceException(message='题目条目不存在')
        scheme_payload, rules = await cls._generation_rules(db, generation)
        rule_payload = next((row for row in rules if row.get('ruleId') == int(item.rule_id)), None)
        if rule_payload is None:
            raise ServiceException(message='抽题规则不存在')
        rule = RuleInputModel.model_validate(rule_payload)
        spec = _rule_spec(rule, list(rule.catalog_ids), str(int(item.rule_id)))
        preference = Preference(
            current_year=int(scheme_payload.get('preferenceYear') or generation.create_time.year),
            recent_years=int(scheme_payload.get('recentYears') or 0),
            province=scheme_payload.get('preferredProvince') or None,
            city=scheme_payload.get('preferredCity') or None,
            exam_types=tuple(scheme_payload.get('preferredExamTypes') or []),
            prefer_real_exam=bool(scheme_payload.get('preferRealExam')),
        )
        candidates = cls._candidates_for(
            await LessonDao.load_candidates(db, int(scheme_payload['textbookId']), list(spec.catalog_ids)), spec
        )
        used = {int(row.question_id) for row in await LessonDao.get_items(db, generation_id)}
        replacement_seed = (int(generation.seed) + int(item.item_id) * 7919 + int(item.question_id)) % MAX_SEED
        picked = pick_replacement(
            candidates, spec, preference, replacement_seed, used, int(item.question_id)
        )
        if picked is None:
            raise ServiceException(message='该规则下已没有可换的题目')
        replacement_details = await LessonDao.get_question_details(db, [picked.question_id])
        replacement_assets = await LessonDao.get_question_assets(db, [picked.question_id])
        question_snapshot = cls._question_snapshot(
            replacement_details.get(picked.question_id), replacement_assets.get(picked.question_id, [])
        )
        try:
            await LessonDao.update_item_question(
                db,
                int(item.item_id),
                question_id=picked.question_id,
                score=picked.score,
                relax_level=picked.relax_level,
                matched_catalog_ids=list(picked.matched_catalog_ids),
                evidence_type=picked.evidence_type,
                replaced_from_question_id=int(item.question_id),
                question_snapshot_json=question_snapshot,
            )
            await LessonDao.update_generation(db, generation_id, {'update_by': operator})
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        return await cls.detail(db, generation_id)

    @classmethod
    async def update_text(
        cls, db: AsyncSession, generation_id: int, payload: TextUpdateModel, operator: str | None
    ) -> dict[str, Any]:
        generation = await cls._require_generation(db, generation_id)
        lesson = dict(generation.lesson_json or {})
        lesson['title'] = payload.title.strip()
        lesson['text'] = _dump(payload.text)
        try:
            await LessonDao.update_generation(db, generation_id, {'lesson_json': lesson, 'update_by': operator})
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        return await cls.detail(db, generation_id)

    # ---------- 查询 ----------

    @classmethod
    async def _require_generation(cls, db: AsyncSession, generation_id: int) -> LpGeneration:
        generation = await LessonDao.get_generation(db, generation_id)
        if generation is None:
            raise ServiceException(message='生成记录不存在')
        if getattr(generation, 'editor_schema_version', 1) == 2:
            raise ServiceException(message='新版教案请使用草稿编辑接口')
        return generation

    @classmethod
    async def detail(cls, db: AsyncSession, generation_id: int) -> dict[str, Any]:
        generation = await cls._require_generation(db, generation_id)
        scheme_payload, rules = await cls._generation_rules(db, generation)
        items = await LessonDao.get_items(db, generation_id)
        question_ids = [int(item.question_id) for item in items if not item.question_snapshot_json]
        details = await LessonDao.get_question_details(db, question_ids)
        assets = await LessonDao.get_question_assets(db, question_ids)
        rule_order = {int(rule['ruleId']): index for index, rule in enumerate(rules) if rule.get('ruleId') is not None}
        phase_items: dict[str, list[GenerationItemModel]] = {}
        for item in sorted(
            items, key=lambda row: (rule_order.get(int(row.rule_id), 999), int(row.sort_no), int(row.item_id))
        ):
            phase_items.setdefault(str(item.phase), []).append(
                GenerationItemModel(
                    item_id=int(item.item_id),
                    rule_id=int(item.rule_id),
                    phase=str(item.phase),
                    sort_no=int(item.sort_no),
                    question_id=int(item.question_id),
                    score=float(item.score) if item.score is not None else None,
                    relax_level=int(item.relax_level or 0),
                    matched_catalog_ids=[int(value) for value in (item.matched_catalog_ids or [])],
                    evidence_type=item.evidence_type,
                    replaced_from_question_id=int(item.replaced_from_question_id)
                    if item.replaced_from_question_id
                    else None,
                    question=(
                        GenerationQuestionModel.model_validate(item.question_snapshot_json['question'])
                        if item.question_snapshot_json
                        else cls._question_model(details.get(int(item.question_id)), assets.get(int(item.question_id), []))
                    ),
                )
            )
        phases = [
            GenerationPhaseModel(phase=phase['phase'], name=phase['name'], items=phase_items.get(phase['phase'], []))
            for phase in templates.PHASES
            if phase['phase'] in phase_items
        ]
        model = GenerationDetailModel(
            generation_id=int(generation.generation_id),
            scheme_id=int(generation.scheme_id),
            seed=int(generation.seed),
            status=str(generation.status),
            scheme=scheme_payload,
            rules=rules,
            summary=[RuleSummaryModel.model_validate(row) for row in (generation.summary_json or [])],
            lesson=dict(generation.lesson_json or {}),
            phases=phases,
            create_by=generation.create_by,
            create_time=generation.create_time,
            update_time=generation.update_time,
        )
        return _dump(model)

    @staticmethod
    def _scheme_snapshot(scheme: LpScheme) -> dict[str, Any]:
        return {
            'schemeId': int(scheme.scheme_id),
            'schemeName': scheme.scheme_name,
            'textbookId': int(scheme.textbook_id),
            'lessonType': scheme.lesson_type,
            'durationMinutes': int(scheme.duration_minutes),
            'recentYears': int(scheme.recent_years),
            'preferredProvince': scheme.preferred_province,
            'preferredCity': scheme.preferred_city,
            'preferredExamTypes': list(scheme.preferred_exam_types or []),
            'preferRealExam': scheme.prefer_real_exam == 'Y',
            'remark': scheme.remark,
            'preferenceYear': datetime.now().year,
        }

    @classmethod
    async def _generation_rules(cls, db: AsyncSession, generation: LpGeneration) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Historical generations use their saved rules and preferences even after edits/deletion."""
        scheme_payload = generation.scheme_snapshot_json
        if not scheme_payload:
            scheme = await LessonDao.get_scheme(db, int(generation.scheme_id))
            if scheme is None:
                raise ServiceException(message='旧教案没有方案快照，原抽题方案已不存在')
            scheme_payload = cls._scheme_snapshot(scheme)
            scheme_payload['preferenceYear'] = generation.create_time.year
        rules = generation.rule_snapshot_json
        if rules is None:
            rule_rows = await LessonDao.get_rules(db, int(generation.scheme_id))
            rules = [_dump(_rule_input_from_row(row)) for row in rule_rows]
        return scheme_payload, rules

    @classmethod
    def _question_snapshot(cls, detail: dict[str, Any] | None, assets: list[QbQuestionAsset]) -> dict[str, Any]:
        model = cls._question_model(detail, assets)
        if model is None:
            raise ServiceException(message='所选题目已从正式题库中移除，请重新生成')
        return {
            'question': _dump(model),
            'assetPaths': {str(asset.asset_key): asset.storage_path for asset in assets if asset.storage_path},
            'assetMimeTypes': {str(asset.asset_key): asset.mime_type for asset in assets if asset.storage_path},
        }

    @staticmethod
    def _question_model(detail: dict[str, Any] | None, assets: list[QbQuestionAsset]) -> GenerationQuestionModel | None:
        if detail is None:
            return None
        return GenerationQuestionModel(
            **{key: value for key, value in detail.items() if key in GenerationQuestionModel.model_fields},
            assets=[
                QuestionAssetRefModel(
                    asset_key=str(asset.asset_key),
                    asset_type=asset.asset_type,
                    mime_type=asset.mime_type,
                    download_status=asset.download_status,
                    available=bool(asset.storage_path)
                    and str(asset.download_status or '').lower() in _AVAILABLE_ASSET_STATUS,
                )
                for asset in assets
            ],
        )

    @classmethod
    async def list_generations(cls, db: AsyncSession, query: GenerationPageQueryModel) -> PageModel:
        page = await LessonDao.list_generations(db, query)
        rows: list[dict[str, Any]] = []
        for row in page.rows:
            data = dict(row._mapping) if hasattr(row, '_mapping') else dict(row)
            lesson = data.pop('lesson_json', None) or {}
            rows.append(_dump(GenerationSummaryRowModel(**data, title=lesson.get('title'))))
        page.rows = rows
        return page

    @classmethod
    async def delete_generations(cls, db: AsyncSession, generation_ids: list[int]) -> int:
        for generation_id in generation_ids:
            await cls._require_generation(db, generation_id)
        try:
            deleted = await LessonDao.delete_generations(db, generation_ids)
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        return deleted

    # ---------- 素材 ----------

    @classmethod
    async def asset_row(cls, db: AsyncSession, question_id: int, asset_key: str) -> QbQuestionAsset | None:
        return await LessonDao.get_asset_by_key(db, question_id, asset_key)

    @classmethod
    async def snapshot_asset_paths(cls, db: AsyncSession, generation_id: int) -> dict[tuple[int, str], str]:
        await cls._require_generation(db, generation_id)
        paths: dict[tuple[int, str], str] = {}
        for item in await LessonDao.get_items(db, generation_id):
            snapshot = item.question_snapshot_json or {}
            for key, path in (snapshot.get('assetPaths') or {}).items():
                if path:
                    paths[(int(item.question_id), str(key))] = str(path)
        return paths

    @classmethod
    async def asset_file(
        cls, db: AsyncSession, question_id: int, asset_key: str, generation_id: int | None = None
    ) -> tuple[Path, str]:
        if generation_id is not None:
            await cls._require_generation(db, generation_id)
            for item in await LessonDao.get_items(db, generation_id):
                if int(item.question_id) != question_id:
                    continue
                snapshot = item.question_snapshot_json
                if snapshot:
                    path = (snapshot.get('assetPaths') or {}).get(asset_key)
                    if not path:
                        raise ServiceException(message='教案快照中不存在该素材')
                    media_type = (snapshot.get('assetMimeTypes') or {}).get(asset_key)
                    return cls.resolve_asset_path(path), media_type or 'application/octet-stream'
                break
            else:
                raise ServiceException(message='题目不属于该教案')
        asset = await cls.asset_row(db, question_id, asset_key)
        if asset is None:
            raise ServiceException(message='素材不存在')
        return cls.resolve_asset_path(asset.storage_path), asset.mime_type or 'application/octet-stream'

    @staticmethod
    def resolve_asset_path(storage_path: str | None) -> Path:
        """与 bank 插件同一套素材根目录与越界校验。"""
        if not storage_path:
            raise HTTPException(status_code=404, detail='素材文件不存在')
        root = Path(os.environ.get('BANK_ASSET_ROOT', 'data/bank')).expanduser().resolve()
        raw = Path(storage_path).expanduser()
        candidate = (raw if raw.is_absolute() else root / raw).resolve(strict=False)
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail='素材路径不合法') from exc
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail='素材文件不存在')
        return candidate
