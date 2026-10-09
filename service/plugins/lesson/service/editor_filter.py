"""A single strict SQL filter, descendant catalog scope and bounded matching."""

from sqlalchemy import exists, func, select

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbQuestionCatalog,
    QbQuestionReadiness,
    QbSubject,
    QbTextbook,
    QbTextbookVersion,
)
from plugins.bank.service.question_readiness import current_facts_predicate, usable_predicate
from plugins.lesson.entity.vo.editor_vo import QuestionFilter


async def book_scope(db, textbook_id):
    book = await db.scalar(
        select(QbTextbook)
        .join(QbTextbookVersion, QbTextbookVersion.version_id == QbTextbook.version_id)
        .join(QbSubject, QbSubject.subject_id == QbTextbook.subject_id)
        .where(
            QbTextbook.textbook_id == textbook_id,
            QbTextbook.status == '0',
            QbTextbookVersion.status == '0',
            QbSubject.status == '0',
            QbTextbook.subject_id == QbTextbookVersion.subject_id,
        )
    )
    if book is None:
        raise ServiceException(message='教材或所属版本、学科不存在或已停用')
    return book


async def expanded_catalogs(db, book, ids):
    nodes = (
        await db.scalars(
            select(QbCatalogNode).where(
                QbCatalogNode.textbook_id == book.textbook_id,
                QbCatalogNode.subject_id == book.subject_id,
                QbCatalogNode.status == '0',
            )
        )
    ).all()
    valid = {node.catalog_id for node in nodes}
    if set(ids) - valid:
        raise ServiceException(message='目录不存在、已停用或不属于当前教材')
    if not ids:
        return sorted(valid)
    children = {}
    for node in nodes:
        children.setdefault(node.parent_id, []).append(node.catalog_id)
    result, stack = set(ids), list(ids)
    while stack:
        for child in children.get(stack.pop(), []):
            if child not in result:
                result.add(child)
                stack.append(child)
    return sorted(result)


async def filtered_ids(db, textbook_id, filter):
    book = await book_scope(db, textbook_id)
    catalogs = await expanded_catalogs(db, book, filter.catalog_ids)
    membership = exists(
        select(1).where(
            QbQuestionCatalog.question_id == QbQuestion.question_id,
            QbQuestionCatalog.catalog_id.in_(catalogs),
            QbQuestionCatalog.relation_type == 'query_catalog',
        )
    )
    query = select(QbQuestion.question_id).where(
        QbQuestion.subject_id == book.subject_id, usable_predicate(), membership
    )
    for field, values in (
        ('question_type', filter.question_types),
        ('difficulty', filter.difficulties),
        ('province', filter.provinces),
        ('city', filter.cities),
        ('exam_type', filter.exam_types),
    ):
        if values:
            query = query.where(getattr(QbQuestion, field).in_(values))
    for field, low, high in (
        ('difficulty_coefficient', filter.ease_min, filter.ease_max),
        ('year', filter.year_min, filter.year_max),
    ):
        if low is not None:
            query = query.where(getattr(QbQuestion, field) >= low)
        if high is not None:
            query = query.where(getattr(QbQuestion, field) <= high)
    if filter.max_subquestion_count is not None:
        query = query.where(QbQuestion.subquestion_count <= filter.max_subquestion_count)
    if not filter.allow_image:
        query = query.where(exists(select(1).where(current_facts_predicate(), QbQuestionReadiness.has_image == 0)))
    if not filter.allow_table:
        query = query.where(exists(select(1).where(current_facts_predicate(), QbQuestionReadiness.has_table == 0)))
    if filter.max_extra_points is not None:
        asserted = (
            select(QbQuestionCatalog.catalog_id)
            .join(QbCatalogNode, QbCatalogNode.catalog_id == QbQuestionCatalog.catalog_id)
            .where(
                QbQuestionCatalog.question_id == QbQuestion.question_id,
                QbQuestionCatalog.evidence_type == 'provider_asserted',
                QbQuestionCatalog.relation_type == 'knowledge',
                QbCatalogNode.node_type == 'point',
            )
        )
        # Missing asserted knowledge is unknown, never "zero extra points".
        query = query.where(exists(asserted))
        extras = (
            select(func.count(func.distinct(QbQuestionCatalog.catalog_id)))
            .join(QbCatalogNode, QbCatalogNode.catalog_id == QbQuestionCatalog.catalog_id)
            .where(
                QbQuestionCatalog.question_id == QbQuestion.question_id,
                QbQuestionCatalog.evidence_type == 'provider_asserted',
                QbQuestionCatalog.relation_type == 'knowledge',
                QbCatalogNode.node_type == 'point',
                ~QbQuestionCatalog.catalog_id.in_(catalogs),
            )
            .scalar_subquery()
        )
        query = query.where(extras <= filter.max_extra_points)
    return query


def rule_filters(editor):
    return {
        rule['ruleKey']: (
            group['groupKey'],
            rule['targetCount'],
            QuestionFilter.model_validate({**rule['filter'], 'catalogIds': group['catalogIds']}),
        )
        for group in editor['groups']
        for rule in group['rules']
    }


def matches_snapshot(snapshot, filter):
    q = snapshot['question']
    if filter.catalog_ids and not set(filter.catalog_ids).intersection(snapshot.get('catalogIds') or []):
        return False
    for name, values in (
        ('questionType', filter.question_types),
        ('difficulty', filter.difficulties),
        ('province', filter.provinces),
        ('city', filter.cities),
        ('examType', filter.exam_types),
    ):
        if values and q.get(name) not in values:
            return False
    for name, low, high in (
        ('difficultyCoefficient', filter.ease_min, filter.ease_max),
        ('year', filter.year_min, filter.year_max),
    ):
        value = q.get(name)
        if (low is not None or high is not None) and (
            value is None or low is not None and value < low or high is not None and value > high
        ):
            return False
    if filter.max_subquestion_count is not None and (
        q.get('subquestionCount') is None or q['subquestionCount'] > filter.max_subquestion_count
    ):
        return False
    if (
        not filter.allow_image
        and snapshot.get('hasImage', True)
        or not filter.allow_table
        and snapshot.get('hasTable', True)
    ):
        return False
    if filter.max_extra_points is not None:
        points = snapshot.get('assertedKnowledgeIds')
        if (
            not points
            or sum(
                not set((snapshot.get('assertedKnowledgePaths') or {}).get(str(point), [point])).intersection(
                    filter.catalog_ids or snapshot.get('catalogIds') or []
                )
                for point in points
            )
            > filter.max_extra_points
        ):
            return False
    return True


def allocate(pools, deficits):
    """Maximum cardinality slot matching; no relaxation or saved-item moves."""
    slots = [(key, n) for key in pools for n in range(deficits[key])]
    slots.sort(key=lambda slot: (len(pools[slot[0]]), list(pools).index(slot[0]), slot[1]))
    owner = {}

    def assign(slot, seen):
        for question_id in pools[slot[0]]:
            if question_id in seen:
                continue
            seen.add(question_id)
            if question_id not in owner or assign(owner[question_id], seen):
                owner[question_id] = slot
                return True
        return False

    for slot in slots:
        assign(slot, set())
    result = {key: [] for key in pools}
    for question_id, slot in owner.items():
        result[slot[0]].append(question_id)
    return result
