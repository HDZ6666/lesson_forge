"""课型模板：环节定义、默认抽题规则与文字初稿。

模板是纯数据与纯函数，不访问数据库，便于前端选项接口和测试直接复用。
"""

from __future__ import annotations

from typing import Any

PHASES: list[dict[str, str]] = [
    {'phase': 'intro', 'name': '导入', 'purpose': '唤起旧知、引出课题'},
    {'phase': 'example', 'name': '例题', 'purpose': '新授示范、讲解方法'},
    {'phase': 'practice', 'name': '巩固练习', 'purpose': '当堂训练、及时反馈'},
    {'phase': 'extend', 'name': '拓展提升', 'purpose': '综合运用、分层挑战'},
    {'phase': 'homework', 'name': '课后作业', 'purpose': '巩固与延伸'},
]
PHASE_ORDER = {item['phase']: index for index, item in enumerate(PHASES)}
PHASE_NAMES = {item['phase']: item['name'] for item in PHASES}

LESSON_TYPES: list[dict[str, str]] = [
    {'lessonType': 'new', 'name': '新授课'},
    {'lessonType': 'practice', 'name': '习题课'},
    {'lessonType': 'review', 'name': '复习课'},
]
LESSON_TYPE_NAMES = {item['lessonType']: item['name'] for item in LESSON_TYPES}

# 常见题型大类；题库实际值可能带后缀（如“解答题-应用题”），匹配时按前缀处理。
QUESTION_TYPE_OPTIONS = ['单选题', '多选题', '填空题', '判断题', '解答题', '其他']

# 每课型的环节模板：题数与易度区间；per_point 表示按知识点各生成一条规则。
_PHASE_TEMPLATES: dict[str, list[dict[str, Any]]] = {
    'new': [
        {'phase': 'intro', 'count': 1, 'ease': (0.80, 1.00), 'types': ['单选题', '填空题'], 'per_point': False},
        {'phase': 'example', 'count': 2, 'ease': (0.55, 0.85), 'types': [], 'per_point': True},
        {'phase': 'practice', 'count': 3, 'ease': (0.55, 0.90), 'types': [], 'per_point': True},
        {'phase': 'extend', 'count': 1, 'ease': (0.00, 0.55), 'types': ['解答题'], 'per_point': False},
        {'phase': 'homework', 'count': 4, 'ease': (0.40, 1.00), 'types': [], 'per_point': False},
    ],
    'practice': [
        {'phase': 'example', 'count': 2, 'ease': (0.55, 0.85), 'types': [], 'per_point': True},
        {'phase': 'practice', 'count': 4, 'ease': (0.50, 0.90), 'types': [], 'per_point': True},
        {'phase': 'extend', 'count': 2, 'ease': (0.00, 0.55), 'types': ['解答题'], 'per_point': False},
        {'phase': 'homework', 'count': 4, 'ease': (0.40, 1.00), 'types': [], 'per_point': False},
    ],
    'review': [
        {'phase': 'intro', 'count': 1, 'ease': (0.80, 1.00), 'types': ['单选题', '填空题'], 'per_point': False},
        {'phase': 'practice', 'count': 4, 'ease': (0.50, 0.90), 'types': [], 'per_point': True},
        {'phase': 'extend', 'count': 2, 'ease': (0.00, 0.55), 'types': ['解答题'], 'per_point': False},
        {'phase': 'homework', 'count': 5, 'ease': (0.40, 1.00), 'types': [], 'per_point': False},
    ],
}


def default_rules(lesson_type: str, points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按课型和知识点生成默认规则列表。

    ``points`` 的每项至少包含 ``catalogId`` 与 ``name``。多知识点时例题、练习环节按知识点
    各出一条规则；导入、拓展、作业环节合并成一条覆盖全部知识点的规则。
    """
    templates = _PHASE_TEMPLATES.get(lesson_type) or _PHASE_TEMPLATES['new']
    all_ids = [int(point['catalogId']) for point in points]
    all_names = '、'.join(str(point.get('name') or '') for point in points)
    rules: list[dict[str, Any]] = []
    for template in templates:
        phase_name = PHASE_NAMES[template['phase']]
        ease_min, ease_max = template['ease']
        base = {
            'phase': template['phase'],
            'questionTypes': list(template['types']),
            'easeMin': ease_min,
            'easeMax': ease_max,
            'maxExtraPoints': 1,
            'maxSubquestionCount': None,
            'allowImage': True,
            'allowTable': True,
        }
        if template['per_point'] and len(points) > 1:
            rules.extend(
                {
                    **base,
                    'ruleName': f'{phase_name}·{point.get("name") or point["catalogId"]}',
                    'catalogIds': [int(point['catalogId'])],
                    'questionCount': template['count'],
                }
                for point in points
            )
        else:
            rules.append(
                {
                    **base,
                    'ruleName': f'{phase_name}·{all_names}' if len(points) == 1 else f'{phase_name}·综合',
                    'catalogIds': all_ids,
                    'questionCount': template['count'],
                    'maxExtraPoints': 1 if len(points) == 1 else max(1, len(points) - 1),
                }
            )
    for index, rule in enumerate(rules):
        rule['sortNo'] = index
    return rules


def default_text(lesson_type: str, point_names: list[str], textbook_name: str | None = None) -> dict[str, str]:
    """按课型生成文字部分初稿，教师可在页面上修改。"""
    names = '、'.join(name for name in point_names if name) or '本节知识点'
    book = f'（{textbook_name}）' if textbook_name else ''
    if lesson_type == 'practice':
        return {
            'objectives': (
                f'1. 巩固{names}的基本概念与解题方法，能独立完成典型题。\n'
                f'2. 通过变式训练归纳常见题型的解题思路，提高运算与推理的准确性。\n'
                f'3. 在纠错与交流中养成规范表达、反思总结的习惯。'
            ),
            'keyPoints': f'{names}的典型题型与通性通法。',
            'difficultPoints': f'{names}在综合情境中的灵活运用与易错点辨析。',
            'process': (
                '例题环节由教师示范并板书规范步骤；巩固练习限时独立完成后同伴互评；'
                '拓展提升分层选做，教师巡视点拨；课堂小结由学生归纳方法与易错点。'
            ),
            'boardNotes': f'课题：{names}习题课{book}\n一、知识回顾\n二、典型例题与方法\n三、易错点提醒',
            'homeworkNote': '完成课后作业中的全部题目，选做拓展题；整理本节错题并标注错误原因。',
        }
    if lesson_type == 'review':
        return {
            'objectives': (
                f'1. 系统梳理{names}的知识结构，形成知识网络。\n'
                f'2. 综合运用相关知识解决问题，提升分析与转化能力。\n'
                f'3. 通过限时训练与讲评查漏补缺，增强应试信心。'
            ),
            'keyPoints': f'{names}的知识联系与综合运用。',
            'difficultPoints': f'涉及{names}的综合题的信息提取与思路转化。',
            'process': (
                '导入环节以基础题唤起记忆并引出知识框图；巩固练习以中档题为主，限时完成并集体讲评；'
                '拓展提升选取综合题分组讨论，展示多种思路；小结环节完善知识网络。'
            ),
            'boardNotes': f'课题：{names}复习{book}\n一、知识网络\n二、典型问题与思路\n三、方法归纳',
            'homeworkNote': '完成课后作业；对照知识网络自查薄弱点，下节课前提交疑问清单。',
        }
    return {
        'objectives': (
            f'1. 理解{names}的相关概念，掌握基本方法并能规范表达。\n'
            f'2. 经历观察、归纳与应用的过程，体会知识的形成与应用。\n'
            f'3. 在解决问题中养成严谨思考、合作交流的学习习惯。'
        ),
        'keyPoints': f'{names}的概念理解与基本方法。',
        'difficultPoints': f'{names}的方法选择与在具体问题中的应用。',
        'process': (
            '导入环节用易题唤起旧知并引出课题；例题环节教师示范并归纳方法要点；'
            '巩固练习学生独立完成、教师即时反馈；拓展提升面向学有余力的学生；'
            '课堂小结师生共同回顾方法与注意事项。'
        ),
        'boardNotes': f'课题：{names}{book}\n一、概念与要点\n二、例题方法\n三、注意事项',
        'homeworkNote': '完成课后作业全部题目，拓展题选做；预习下一节内容。',
    }


def options_payload() -> dict[str, Any]:
    """前端选项接口的静态部分。"""
    return {
        'lessonTypes': LESSON_TYPES,
        'phases': PHASES,
        'questionTypes': QUESTION_TYPE_OPTIONS,
        'relaxLevels': [
            {'level': 0, 'name': '严格', 'description': '完全按规则'},
            {'level': 1, 'name': '轻度放宽', 'description': '易度 ±0.05，额外知识点 +1'},
            {'level': 2, 'name': '中度放宽', 'description': '题型放宽到大类，易度 ±0.10，额外知识点 +2'},
            {'level': 3, 'name': '兜底', 'description': '忽略题型与易度，只保留知识点、素材与唯一性限制'},
        ],
    }
