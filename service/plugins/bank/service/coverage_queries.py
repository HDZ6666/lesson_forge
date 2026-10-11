"""Current usable counts and directory rollups share the list predicate."""

from sqlalchemy import and_, case, exists, func, select

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


def enabled_scope(*, include_question=True):
    return and_(
        QbCatalogNode.status == '0',
        QbTextbook.status == '0',
        QbTextbookVersion.status == '0',
        QbSubject.status == '0',
        QbCatalogNode.subject_id == QbTextbook.subject_id,
        QbTextbookVersion.subject_id == QbTextbook.subject_id,
        QbQuestion.subject_id == QbTextbook.subject_id if include_question else True,
        QbTextbookVersion.source_provider == QbTextbook.source_provider,
    )


def usable_scope_predicate():
    return and_(
        usable_predicate(),
        exists(
            select(1)
            .select_from(QbQuestionCatalog)
            .join(QbCatalogNode, QbCatalogNode.catalog_id == QbQuestionCatalog.catalog_id)
            .join(QbTextbook, QbTextbook.textbook_id == QbCatalogNode.textbook_id)
            .join(QbTextbookVersion, QbTextbookVersion.version_id == QbTextbook.version_id)
            .join(QbSubject, QbSubject.subject_id == QbTextbook.subject_id)
            .where(
                QbQuestionCatalog.question_id == QbQuestion.question_id,
                QbQuestionCatalog.relation_type == 'query_catalog',
                enabled_scope(),
            )
        ),
    )


def _scope_joins(query):
    return (
        query.join(QbTextbook, QbTextbook.textbook_id == QbCatalogNode.textbook_id)
        .join(QbTextbookVersion, QbTextbookVersion.version_id == QbTextbook.version_id)
        .join(QbSubject, QbSubject.subject_id == QbTextbook.subject_id)
    )


async def book_stem_counts(db, textbook_ids):
    if not textbook_ids:
        return {}
    # Collapse repeated directory/evidence memberships before reading question
    # and readiness rows. A question counts once per book, even if it appears
    # in several enabled and disabled directories.
    scopes = _scope_joins(select(
        QbCatalogNode.catalog_id.label('catalog'),
        QbTextbook.textbook_id.label('book'),
        QbTextbook.subject_id.label('subject'),
        case((enabled_scope(include_question=False), 1), else_=0).label('active'),
    ).select_from(QbCatalogNode)).where(QbTextbook.textbook_id.in_(textbook_ids)).distinct().subquery()
    memberships = select(
        scopes.c.book, scopes.c.subject, QbQuestionCatalog.question_id.label('question'),
        func.max(scopes.c.active).label('active'),
    ).select_from(scopes).join(QbQuestionCatalog, and_(
        QbQuestionCatalog.catalog_id == scopes.c.catalog,
        QbQuestionCatalog.relation_type == 'query_catalog',
    )).group_by(scopes.c.book, scopes.c.subject, QbQuestionCatalog.question_id).subquery()
    active = and_(
        memberships.c.active == 1,
        QbQuestion.status == '0',
        QbQuestion.subject_id == memberships.c.subject,
    )
    ready = and_(
        QbQuestionReadiness.status == 'ready',
        QbQuestionReadiness.stem_valid == 1,
        QbQuestionReadiness.assets_ready == 1,
    )
    query = (
        select(
            memberships.c.book,
            func.sum(case((and_(active, ready), 1), else_=0)),
            func.sum(case((and_(active, QbQuestionReadiness.question_id.is_(None)), 1), else_=0)),
            func.sum(case((and_(active, QbQuestionReadiness.status == 'invalid'), 1), else_=0)),
        )
        .select_from(memberships)
        .join(QbQuestion, QbQuestion.question_id == memberships.c.question)
        .outerjoin(QbQuestionReadiness, current_facts_predicate())
        .group_by(memberships.c.book)
        .with_hint(QbQuestion, 'FORCE INDEX (idx_qb_question_coverage)', dialect_name='mysql')
    )
    return {
        int(book): {
            'usableQuestionCount': int(ready),
            'uncheckedQuestionCount': int(unknown),
            'unusableQuestionCount': int(bad),
        }
        for book, ready, unknown, bad in (await db.execute(query)).all()
    }


async def catalog_coverage(db, textbook_ids, *, include_disabled=False):
    """Count distinct IDs in each subtree, never sum overlapping child counts.

    UNION (distinct) also bounds malformed cycles; the tree renderer rejects
    cyclic structure rather than silently inventing roots.
    """
    ids = [textbook_ids] if type(textbook_ids) is int else textbook_ids
    if not ids:
        return {}
    if len(ids) > 500 or any(type(value) is not int or value <= 0 for value in ids):
        raise ServiceException(message='目录覆盖查询范围无效')
    base = select(
        QbCatalogNode.catalog_id.label('ancestor'),
        QbCatalogNode.catalog_id.label('descendant'),
        QbCatalogNode.textbook_id.label('textbook_id'),
        QbCatalogNode.subject_id.label('subject_id'),
    )
    base = base.join(QbTextbook, QbTextbook.textbook_id == QbCatalogNode.textbook_id).where(
        QbCatalogNode.textbook_id.in_(ids),
        QbCatalogNode.subject_id == QbTextbook.subject_id,
    )
    if not include_disabled:
        base = base.where(QbCatalogNode.status == '0')
    closure = base.cte('bank_catalog_coverage', recursive=True)
    child = (
        select(closure.c.ancestor, QbCatalogNode.catalog_id, QbCatalogNode.textbook_id, QbCatalogNode.subject_id)
        .join(
            closure,
            and_(
                QbCatalogNode.parent_id == closure.c.descendant,
                QbCatalogNode.textbook_id == closure.c.textbook_id,
                QbCatalogNode.subject_id == closure.c.subject_id,
            ),
        )
        .join(QbTextbook, QbTextbook.textbook_id == QbCatalogNode.textbook_id)
        .where(QbCatalogNode.textbook_id.in_(ids), QbCatalogNode.subject_id == QbTextbook.subject_id)
    )
    if not include_disabled:
        child = child.where(QbCatalogNode.status == '0')
    closure = closure.union(child)
    active_question = True if include_disabled else QbQuestion.status == '0'
    ready = and_(enabled_scope(), usable_predicate())
    query = (
        select(
            closure.c.ancestor,
            func.count(func.distinct(case((closure.c.ancestor == closure.c.descendant, QbQuestion.question_id)))),
            func.count(func.distinct(QbQuestion.question_id)),
            func.count(
                func.distinct(case((and_(closure.c.ancestor == closure.c.descendant, ready), QbQuestion.question_id)))
            ),
            func.count(func.distinct(case((ready, QbQuestion.question_id)))),
        )
        .select_from(closure)
        .join(QbCatalogNode, QbCatalogNode.catalog_id == closure.c.descendant)
    )
    query = (
        _scope_joins(query)
        .outerjoin(
            QbQuestionCatalog,
            and_(
                QbQuestionCatalog.catalog_id == closure.c.descendant,
                QbQuestionCatalog.relation_type == 'query_catalog',
            ),
        )
        .outerjoin(
            QbQuestion,
            and_(
                QbQuestion.question_id == QbQuestionCatalog.question_id,
                QbQuestion.subject_id == QbTextbook.subject_id,
                active_question,
            ),
        )
    )
    result = await db.execute(query.group_by(closure.c.ancestor))
    return {
        int(node): {
            'directQuestionCount': int(direct),
            'descendantQuestionCount': int(total),
            'directUsableQuestionCount': int(direct_ready),
            'descendantUsableQuestionCount': int(total_ready),
        }
        for node, direct, total, direct_ready, total_ready in result.all()
    }
