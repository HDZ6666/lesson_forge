"""确定性抽题引擎。

输入是内存中的候选题与规则，不访问数据库；同一份候选、同一规则、同一 seed 的输出完全一致。
放宽级别 0~3 单调：高级别的通过集合总是包含低级别的通过集合。
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field, replace

MAX_RELAX_LEVEL = 3
# 第 2 级起题型只比大类，且无易度数据的题目也允许通过。
MAJOR_TYPE_LEVEL = 2
JITTER_RANGE = 8.0
_EASE_BY_LABEL = {'容易': 0.85, '较易': 0.75, '适中': 0.65, '较难': 0.50, '困难': 0.40}
_EASE_WIDEN = {0: 0.0, 1: 0.05, 2: 0.10}
_EXTRA_POINT_WIDEN = {0: 0, 1: 1, 2: 2}
_REAL_EXAM_MARKERS = ('真题', '中考', '高考', '会考', '学业水平')
_FAMOUS_SCHOOL_MARKERS = ('名校',)


@dataclass(frozen=True)
class Candidate:
    question_id: int
    question_type: str | None = None
    difficulty: str | None = None
    ease: float | None = None
    year: int | None = None
    province: str | None = None
    city: str | None = None
    exam_type: str | None = None
    paper_name: str | None = None
    source_text: str | None = None
    subquestion_count: int | None = None
    assemble_count: int | None = None
    asset_count: int = 0
    has_table: bool = False
    point_ids: frozenset[int] = field(default_factory=frozenset)
    # 题目命中的目录 -> 证据类型；provider_asserted 优先于 query_membership。
    evidence_by_catalog: dict[int, str] = field(default_factory=dict, hash=False, compare=False)


@dataclass(frozen=True)
class RuleSpec:
    rule_key: str
    phase: str
    catalog_ids: tuple[int, ...]
    question_count: int
    question_types: tuple[str, ...] = ()
    ease_min: float | None = None
    ease_max: float | None = None
    max_extra_points: int = 1
    max_subquestion_count: int | None = None
    allow_image: bool = True
    allow_table: bool = True
    rule_name: str | None = None


@dataclass(frozen=True)
class Preference:
    current_year: int
    recent_years: int = 3
    province: str | None = None
    city: str | None = None
    exam_types: tuple[str, ...] = ()
    prefer_real_exam: bool = True


@dataclass(frozen=True)
class PickedItem:
    question_id: int
    score: float
    relax_level: int
    matched_catalog_ids: tuple[int, ...]
    evidence_type: str | None


@dataclass
class PickResult:
    rule_key: str
    needed: int
    items: list[PickedItem]
    max_relax_level: int

    @property
    def short(self) -> bool:
        return len(self.items) < self.needed

    @property
    def message(self) -> str:
        if self.short:
            return f'只能找到 {len(self.items)} 题，需要 {self.needed} 题'
        if self.max_relax_level > 0:
            return f'有题目按第 {self.max_relax_level} 级放宽选出'
        return ''


def major_type(question_type: str | None) -> str:
    return (question_type or '').split('-', 1)[0].strip()


def type_matches(question_type: str | None, allowed: tuple[str, ...], level: int) -> bool:
    if not allowed or level >= MAX_RELAX_LEVEL:
        return True
    actual = (question_type or '').strip()
    if not actual:
        return False
    if level >= MAJOR_TYPE_LEVEL:
        actual_major = major_type(actual)
        return any(actual_major == major_type(item) for item in allowed)
    return any(actual == item or actual.startswith(f'{item}-') for item in allowed)


def ease_value(candidate: Candidate) -> float | None:
    if candidate.ease is not None:
        return float(candidate.ease)
    return _EASE_BY_LABEL.get((candidate.difficulty or '').strip())


def ease_matches(candidate: Candidate, rule: RuleSpec, level: int) -> bool:
    if level >= MAX_RELAX_LEVEL or (rule.ease_min is None and rule.ease_max is None):
        return True
    value = ease_value(candidate)
    if value is None:
        return level >= MAJOR_TYPE_LEVEL
    widen = _EASE_WIDEN[level]
    lower = (rule.ease_min if rule.ease_min is not None else 0.0) - widen
    upper = (rule.ease_max if rule.ease_max is not None else 1.0) + widen
    return lower <= value <= upper


def matched_catalogs(candidate: Candidate, rule: RuleSpec) -> tuple[int, ...]:
    rule_ids = set(rule.catalog_ids)
    hits = [catalog_id for catalog_id in candidate.evidence_by_catalog if catalog_id in rule_ids]
    hits.extend(point for point in candidate.point_ids if point in rule_ids and point not in hits)
    return tuple(sorted(hits))


def passes(candidate: Candidate, rule: RuleSpec, level: int) -> bool:
    if not matched_catalogs(candidate, rule):
        return False
    if not rule.allow_image and candidate.asset_count > 0:
        return False
    if not rule.allow_table and candidate.has_table:
        return False
    if not type_matches(candidate.question_type, rule.question_types, level):
        return False
    if not ease_matches(candidate, rule, level):
        return False
    if level < MAX_RELAX_LEVEL:
        extra = len(candidate.point_ids - set(rule.catalog_ids))
        if extra > rule.max_extra_points + _EXTRA_POINT_WIDEN[level]:
            return False
        if (
            rule.max_subquestion_count is not None
            and candidate.subquestion_count is not None
            and candidate.subquestion_count > rule.max_subquestion_count
        ):
            return False
    return True


def _contains(text: str | None, needle: str | None) -> bool:
    if not text or not needle:
        return False
    text, needle = text.strip(), needle.strip()
    return bool(text and needle) and (needle in text or text in needle)


def _year_score(candidate: Candidate, preference: Preference) -> float:
    if not candidate.year:
        return 0.0
    if preference.recent_years <= 0:
        return 30.0
    age = max(0, preference.current_year - int(candidate.year))
    return 30.0 * max(0.0, 1.0 - age / preference.recent_years)


def _region_score(candidate: Candidate, preference: Preference) -> float:
    if not (preference.province or preference.city):
        return 15.0
    total = 20.0 if _contains(candidate.province, preference.province) else 0.0
    if _contains(candidate.city, preference.city):
        total += 10.0
    return total


def _exam_type_score(candidate: Candidate, preference: Preference) -> float:
    if not preference.exam_types:
        return 10.0
    return 20.0 if any(_contains(candidate.exam_type, item) for item in preference.exam_types) else 0.0


def _real_exam_score(candidate: Candidate, preference: Preference) -> float:
    if not preference.prefer_real_exam:
        return 10.0
    source = ' '.join(filter(None, (candidate.paper_name, candidate.source_text, candidate.exam_type)))
    total = 12.0 if any(marker in source for marker in _REAL_EXAM_MARKERS) else 0.0
    if any(marker in source for marker in _FAMOUS_SCHOOL_MARKERS):
        total += 8.0
    return total


def _tie_break_score(candidate: Candidate, evidence_type: str | None) -> float:
    total = 1.0 if evidence_type == 'provider_asserted' else 0.0
    if candidate.assemble_count:
        total += min(1.0, math.log10(1 + max(0, int(candidate.assemble_count))) / 4)
    return total


def score(candidate: Candidate, preference: Preference, evidence_type: str | None = None) -> float:
    """年份 30 / 地区 30 / 考试类型 20 / 真题名校 20，外加不超过 2 分的平手项。"""
    total = (
        _year_score(candidate, preference)
        + _region_score(candidate, preference)
        + _exam_type_score(candidate, preference)
        + _real_exam_score(candidate, preference)
        + _tie_break_score(candidate, evidence_type)
    )
    return round(total, 3)


def best_evidence(candidate: Candidate, matched: tuple[int, ...]) -> str | None:
    types = {candidate.evidence_by_catalog.get(catalog_id) for catalog_id in matched}
    if 'provider_asserted' in types:
        return 'provider_asserted'
    if 'query_membership' in types:
        return 'query_membership'
    return next((item for item in types if item), None)


def _jitter_table(candidates: list[Candidate], seed: int, rule_key: str) -> dict[int, float]:
    rng = random.Random(f'{seed}:{rule_key}')
    return {
        candidate.question_id: rng.uniform(0, JITTER_RANGE)
        for candidate in sorted(candidates, key=lambda item: item.question_id)
    }


def pick_for_rule(
    candidates: list[Candidate],
    rule: RuleSpec,
    preference: Preference,
    seed: int,
    used: set[int],
) -> PickResult:
    """逐级放宽地为一条规则选题；``used`` 会被就地更新以保证一次生成内题目唯一。"""
    jitter = _jitter_table(candidates, seed, rule.rule_key)
    picked: list[PickedItem] = []
    picked_ids: set[int] = set()
    max_level = 0
    for level in range(MAX_RELAX_LEVEL + 1):
        remaining = rule.question_count - len(picked)
        if remaining <= 0:
            break
        ranked: list[tuple[float, float, int, Candidate, tuple[int, ...], str | None]] = []
        for candidate in candidates:
            if candidate.question_id in used or candidate.question_id in picked_ids:
                continue
            if not passes(candidate, rule, level):
                continue
            matched = matched_catalogs(candidate, rule)
            evidence = best_evidence(candidate, matched)
            base = score(candidate, preference, evidence)
            ranked.append(
                (base + jitter[candidate.question_id], base, candidate.question_id, candidate, matched, evidence)
            )
        ranked.sort(key=lambda row: (-row[0], row[2]))
        for _, base, question_id, _candidate, matched, evidence in ranked[:remaining]:
            picked.append(PickedItem(question_id, base, level, matched, evidence))
            picked_ids.add(question_id)
            max_level = max(max_level, level)
    used.update(picked_ids)
    return PickResult(rule.rule_key, rule.question_count, picked, max_level)


def simulate_rule(candidates: list[Candidate], rule: RuleSpec, used: set[int] | None = None) -> list[int]:
    """返回 0~3 级放宽下的可用候选数（累计口径）。"""
    excluded = used or set()
    eligible = [candidate for candidate in candidates if candidate.question_id not in excluded]
    return [sum(1 for candidate in eligible if passes(candidate, rule, level)) for level in range(MAX_RELAX_LEVEL + 1)]


def satisfied_level(counts: list[int], needed: int) -> int | None:
    return next((level for level, count in enumerate(counts) if count >= needed), None)


def pick_replacement(
    candidates: list[Candidate],
    rule: RuleSpec,
    preference: Preference,
    seed: int,
    used: set[int],
    replacing: int,
) -> PickedItem | None:
    """为换题选出一道未使用的题；``used`` 包含本次生成的全部题目（含被换掉的题）。"""
    excluded = set(used) | {replacing}
    single = replace(rule, question_count=1, rule_key=f'{rule.rule_key}:replace:{replacing}')
    result = pick_for_rule(candidates, single, preference, seed, excluded)
    return result.items[0] if result.items else None
