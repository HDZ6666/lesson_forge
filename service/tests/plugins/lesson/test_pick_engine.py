"""抽题引擎的确定性、放宽、唯一性与偏好排序测试（计划 4 验收 B1/B2/B3/B5）。"""

from __future__ import annotations

from plugins.lesson.service import templates
from plugins.lesson.service.pick_engine import (
    MAX_RELAX_LEVEL,
    Candidate,
    Preference,
    RuleSpec,
    pick_for_rule,
    pick_replacement,
    satisfied_level,
    score,
    simulate_rule,
    type_matches,
)

POINT_A = 101
POINT_B = 102
POINT_C = 103
CURRENT_YEAR = 2026
PREF = Preference(current_year=CURRENT_YEAR, recent_years=3)


def _candidate(question_id: int, **overrides: object) -> Candidate:
    values: dict[str, object] = {
        'question_type': '单选题',
        'ease': 0.85,
        'year': 2025,
        'province': '江苏',
        'city': '南京',
        'exam_type': '期末',
        'paper_name': '2025 江苏南京期末',
        'point_ids': frozenset({POINT_A}),
        'evidence_by_catalog': {POINT_A: 'query_membership'},
    }
    values.update(overrides)
    return Candidate(question_id=question_id, **values)  # type: ignore[arg-type]


def _rule(**overrides: object) -> RuleSpec:
    values: dict[str, object] = {
        'rule_key': 'r1',
        'phase': 'practice',
        'catalog_ids': (POINT_A,),
        'question_count': 3,
        'question_types': ('单选题',),
        'ease_min': 0.8,
        'ease_max': 1.0,
        'max_extra_points': 0,
    }
    values.update(overrides)
    return RuleSpec(**values)  # type: ignore[arg-type]


def _pool() -> list[Candidate]:
    return [_candidate(question_id, year=2020 + (question_id % 6)) for question_id in range(1, 21)]


def test_same_seed_is_reproducible_and_different_seed_varies() -> None:
    first = pick_for_rule(_pool(), _rule(question_count=5), PREF, seed=42, used=set())
    second = pick_for_rule(_pool(), _rule(question_count=5), PREF, seed=42, used=set())
    assert [item.question_id for item in first.items] == [item.question_id for item in second.items]

    seen = {tuple(item.question_id for item in first.items)}
    for seed in range(1, 40):
        result = pick_for_rule(_pool(), _rule(question_count=5), PREF, seed=seed, used=set())
        seen.add(tuple(item.question_id for item in result.items))
    assert len(seen) > 1, '不同 seed 至少应出现一次不同的抽题结果'


def test_relaxation_levels_rise_and_short_message() -> None:
    pool = [
        _candidate(1, ease=0.9),
        _candidate(2, ease=0.76),  # 只有放宽 0.05 才进入 [0.8, 1.0]
        _candidate(3, ease=0.9, question_type='解答题-应用题'),  # 题型不符，第 3 级才能用
        _candidate(4, ease=0.9, point_ids=frozenset({POINT_A, POINT_B, POINT_C})),  # 额外知识点 2 个，第 2 级才能用
    ]
    result = pick_for_rule(pool, _rule(question_count=5), PREF, seed=1, used=set())
    by_id = {item.question_id: item.relax_level for item in result.items}
    assert by_id[1] == 0
    assert by_id[2] == 1
    assert by_id[4] == 2
    assert by_id[3] == MAX_RELAX_LEVEL
    assert result.short is True
    assert result.max_relax_level == MAX_RELAX_LEVEL
    assert result.message == '只能找到 4 题，需要 5 题'

    counts = simulate_rule(pool, _rule(question_count=5))
    assert counts == [1, 2, 3, 4]
    assert satisfied_level(counts, 2) == 1
    assert satisfied_level(counts, 5) is None


def test_generation_never_repeats_questions_across_rules() -> None:
    pool = _pool()
    used: set[int] = set()
    first = pick_for_rule(pool, _rule(rule_key='a', question_count=8), PREF, seed=7, used=used)
    second = pick_for_rule(pool, _rule(rule_key='b', question_count=8), PREF, seed=7, used=used)
    third = pick_for_rule(pool, _rule(rule_key='c', question_count=8), PREF, seed=7, used=used)
    picked = [item.question_id for result in (first, second, third) for item in result.items]
    assert len(picked) == len(set(picked))
    assert len(picked) == 20
    assert third.short is True


def test_replacement_excludes_used_and_current_question() -> None:
    pool = _pool()
    used = {1, 2, 3}
    replacement = pick_replacement(pool, _rule(), PREF, seed=3, used=used, replacing=2)
    assert replacement is not None
    assert replacement.question_id not in {1, 2, 3}
    assert pick_replacement(pool[:3], _rule(), PREF, seed=3, used=used, replacing=2) is None


def test_preferences_rank_recent_local_real_exam_first() -> None:
    preference = Preference(
        current_year=CURRENT_YEAR,
        recent_years=3,
        province='江苏',
        city='南京',
        exam_types=('中考',),
        prefer_real_exam=True,
    )
    ideal = _candidate(1, year=2026, exam_type='中考', paper_name='2026 江苏南京中考真题 名校')
    stale_far = _candidate(2, year=2015, province='山东', city='济南', exam_type='期中', paper_name='2015 山东期中')
    assert score(ideal, preference) > score(stale_far, preference) + 60

    # 极端偏好差距应压过 8 分随机抖动：多种 seed 下理想题始终排第一。
    pool = [stale_far, ideal, _candidate(3, year=2019, province='浙江', city='杭州', exam_type='期末')]
    for seed in range(20):
        result = pick_for_rule(pool, _rule(question_count=1, ease_min=None, ease_max=None), preference, seed, set())
        assert result.items[0].question_id == 1


def test_type_matching_by_level() -> None:
    assert type_matches('解答题-应用题', ('解答题',), 0) is True
    assert type_matches('解答题', ('解答题-应用题',), 0) is False
    assert type_matches('解答题', ('解答题-应用题',), 2) is True
    assert type_matches('填空题', ('单选题',), 2) is False
    assert type_matches('填空题', ('单选题',), MAX_RELAX_LEVEL) is True
    assert type_matches(None, (), 0) is True


def test_default_rules_split_examples_per_point_and_merge_shared_phases() -> None:
    points = [{'catalogId': POINT_A, 'name': '一元二次方程的解'}, {'catalogId': POINT_B, 'name': '配方法'}]
    rules = templates.default_rules('new', points)
    phases = [rule['phase'] for rule in rules]
    assert phases.count('example') == 2
    assert phases.count('practice') == 2
    assert phases.count('intro') == 1
    assert phases.count('homework') == 1
    merged = next(rule for rule in rules if rule['phase'] == 'homework')
    assert merged['catalogIds'] == [POINT_A, POINT_B]
    assert [rule['sortNo'] for rule in rules] == list(range(len(rules)))

    single = templates.default_rules('review', points[:1])
    assert all(rule['catalogIds'] == [POINT_A] for rule in single)
    assert {rule['phase'] for rule in single} == {'intro', 'practice', 'extend', 'homework'}
