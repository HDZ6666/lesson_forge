"""One short, additive formal-bank transaction for prepared QC results.

This is the merge component, not a task runner. Durable import ownership,
checkpoint journals and public task endpoints must wrap it before rollout.
"""

from __future__ import annotations

import asyncio
import secrets
from contextlib import AsyncExitStack
from datetime import datetime
from typing import Any

from sqlalchemy import select, tuple_

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbQuestionApplyState,
    QbQuestionAsset,
    QbQuestionCatalog,
    QbQuestionTag,
    QbSubject,
    QbTextbook,
    QbTextbookVersion,
)
from plugins.bank.service.large_initial_apply import QUESTION_FIELDS
from plugins.bank.service.large_snapshot_reader import _check_formal_rows
from plugins.bank.service.question_apply_service import (
    _answer_is_public,
    _asset_root,
    _coerce_datetime,
    _download_snapshot_assets,
    _empty_stats,
    _same,
)
from plugins.bank.service.question_readiness import (
    check_question,
    fetch_required_assets,
    probe_stem,
    question_payload,
    store_proofs,
)
from plugins.bank.service.source_write_lock import source_write_lock

MAX_MERGE_QUESTIONS = 100


async def prepare_incremental_verdicts(verdicts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep asset failures local to a question, with no DB lock or network in merge."""
    if len(verdicts) > MAX_MERGE_QUESTIONS:
        raise ServiceException(message='入库素材准备超过单批题数上限')
    result = []
    for verdict in verdicts:
        item = dict(verdict)
        if item['status'] == 'accepted':
            try:
                snapshot = item['normalized']
                probe = probe_stem(snapshot['questions'][0])
                if not probe['stem_valid']:
                    raise ServiceException(message='题干为空、格式无效或超过检查预算')
                required = [a for a in snapshot['assets'] if a['asset_key'] in probe['keys']]
                optional = [a for a in snapshot['assets'] if a['asset_key'] not in probe['keys']]
                await _download_snapshot_assets({**snapshot, 'assets': required}, sealed_for_import=True)
                # Answers/analysis do not determine stem usability. Keep their
                # download failure explicit while retaining the complete stem.
                if optional:
                    try:
                        await _download_snapshot_assets({**snapshot, 'assets': optional}, sealed_for_import=True)
                    except ServiceException:
                        snapshot['questions'][0].update(answer_status='not_collected', answer_html=None, analysis_html=None)
                        for asset in optional:
                            asset.update(storage_path=None, download_status='failed', error_message='非题干素材未就绪')
            except ServiceException as exc:
                item.update(status='quarantined', normalized=None, reason=str(exc.message))
        result.append(item)
    return result


def _prepared_proofs(snapshots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    proofs = []
    root = _asset_root()
    for snapshot in snapshots:
        item = snapshot['questions'][0]
        question = {**item, 'question_id': None, 'subject_id': 1, 'source_provider': 'zujuan',
                    'external_question_id': item['external_id'], 'readiness_revision': None}
        proof = check_question(question, [{**a, 'source_provider': 'zujuan'} for a in snapshot['assets']], root)
        if proof['status'] != 'ready':
            raise ServiceException(message=proof['reason'])
        proofs.append(proof)
    return proofs


def _observed_values(values: dict[str, Any]) -> dict[str, Any]:
    # QC serialization intentionally uses JSON dates. Convert only known
    # model date fields rather than guessing from arbitrary content strings.
    return {
        key: _coerce_datetime(value) if key in {'last_seen_at', 'external_updated_at'} else value
        for key, value in values.items()
    }


def _update(row: Any, values: dict[str, Any], now: datetime) -> bool:
    changed = {key: value for key, value in values.items() if not _same(getattr(row, key), value)}
    for key, value in changed.items():
        setattr(row, key, value)
    if changed:
        row.update_time = now
    return bool(changed)


async def merge_prepared_incremental_batch(
    db: Any,
    snapshots: list[dict[str, Any]],
    *,
    local_textbook_id: int,
    task_id: int,
    before_merge: Any = None,
    persist_checkpoint: Any = None,
) -> dict[str, Any]:
    """Upsert only observed identities; never reconcile missing rows or enable old ones.

    Caller provides normalized, asset-prepared QC results for one textbook.
    This internal component commits exactly one batch; no whole-run atomicity
    or public apply eligibility is implied by its return value.
    """
    if db.in_transaction():
        raise ServiceException(message='分批合并需要独立短事务，不能在已有事务中准备素材')
    if not snapshots or len(snapshots) > MAX_MERGE_QUESTIONS or task_id <= 0:
        raise ServiceException(message='分批合并题数或任务身份无效')
    seen = set()
    for snapshot in snapshots:
        if len(snapshot['questions']) != 1 or snapshot['textbook_external_id'] != snapshots[0]['textbook_external_id']:
            raise ServiceException(message='单批合并必须是同一本教材的逐题检查结果')
        _check_formal_rows(snapshot)
        key = snapshot['questions'][0]['external_id']
        if key in seen:
            raise ServiceException(message='同一批次包含重复题目')
        seen.add(key)
    if sum(len(snapshot[key]) for snapshot in snapshots for key in ('question_catalogs', 'tags', 'assets')) > 5_000:
        raise ServiceException(message='单批关系与素材数超过入库预算')
    proofs = await asyncio.to_thread(_prepared_proofs, snapshots)
    stats = _empty_stats()
    now = datetime.now()
    write_stack = AsyncExitStack()
    try:
        await write_stack.enter_async_context(source_write_lock(db))
        subject = await db.get(QbSubject, 1, with_for_update=True, populate_existing=True)
        if subject is None or subject.status != '0' or subject.source_profile != 'zujuan_czsx':
            raise ServiceException(message='教材所属学科来源不可用')
        if before_merge is not None:
            # Ownership, scope binding and cursor are checked under locks
            # before any formal write, after assets have been prepared.
            await before_merge(db)
        book = await db.get(QbTextbook, local_textbook_id, with_for_update=True, populate_existing=True)
        if (
            book is None
            or book.subject_id != 1
            or book.source_provider != 'zujuan'
            or book.status != '0'
            or book.external_textbook_id != snapshots[0]['textbook_external_id']
        ):
            raise ServiceException(message='检查结果与正式教材身份不一致或教材已停用')
        version = await db.get(QbTextbookVersion, book.version_id)
        if version is None or version.subject_id != 1 or version.source_provider != 'zujuan' or version.status != '0':
            raise ServiceException(message='正式教材版本归属不一致或已停用')
        # A manual asset with the same key must not be overwritten or used
        # with a newly scraped stem. Quarantine only that question; keep the
        # rest of this batch and its durable checkpoint moving forward.
        incoming = [(snap['questions'][0]['external_id'], key)
                    for snap in snapshots for key in probe_stem(snap['questions'][0])['keys']]
        protected = set((await db.scalars(select(QbQuestion.external_question_id)
                     .join(QbQuestionAsset, QbQuestionAsset.question_id == QbQuestion.question_id).where(
                         QbQuestion.subject_id == 1, QbQuestion.source_provider == 'zujuan',
                         QbQuestionAsset.source_provider != 'zujuan',
                         tuple_(QbQuestion.external_question_id, QbQuestionAsset.asset_key).in_(incoming),
                     ).with_for_update())).all()) if incoming else set()
        write_issues = [{'questionId': key, 'reason': '题干素材与已有人工或其他来源素材同名，保留原题待人工判断'}
                        for key in sorted(protected)]
        snapshots = [snap for snap in snapshots if snap['questions'][0]['external_id'] not in protected]
        proofs = [proof for proof in proofs if proof['external_question_id'] not in protected]
        seen.difference_update(protected)
        source_catalogs = {}
        for snapshot in snapshots:
            for item in snapshot['catalogs']:
                previous = source_catalogs.setdefault(item['external_id'], item)
                if previous != item:
                    raise ServiceException(message='单批题目引用的同一目录观察不一致')
        if len(source_catalogs) > 10_000:
            raise ServiceException(message='单批目录数超过入库预算')
        catalog_map = {
            row.external_node_id: row
            for row in (
                await db.execute(
                    select(QbCatalogNode)
                    .where(
                        QbCatalogNode.subject_id == 1,
                        QbCatalogNode.source_provider == 'zujuan',
                        QbCatalogNode.external_node_id.in_(source_catalogs),
                    )
                    .with_for_update()
                )
            ).scalars()
        }
        catalog_outcomes = {}
        for key, item in source_catalogs.items():
            row = catalog_map.get(key)
            if row is not None and row.textbook_id != local_textbook_id:
                raise ServiceException(message=f'目录 {key} 已属于其他教材，需人工判断')
            values = _observed_values(
                {field: item[field] for field in ('node_name', 'node_type', 'source_url', 'sort_order', 'last_seen_at')}
            )
            if row is None:
                row = QbCatalogNode(
                    subject_id=1,
                    source_provider='zujuan',
                    external_node_id=key,
                    textbook_id=local_textbook_id,
                    status='0',
                    create_time=now,
                    update_time=now,
                    **values,
                )
                db.add(row)
                catalog_map[key] = row
                stats['catalogs']['inserted'] += 1
                catalog_outcomes[key] = 'inserted'
            elif _update(row, values, now):
                stats['catalogs']['updated'] += 1
                catalog_outcomes[key] = 'updated'
            else:
                stats['catalogs']['unchanged'] += 1
                catalog_outcomes[key] = 'unchanged'
        await db.flush()
        for key, item in source_catalogs.items():
            parent = catalog_map[item['parent_external_id']].catalog_id if item['parent_external_id'] else None
            row = catalog_map[key]
            if row.parent_id != parent:
                row.parent_id = parent
                row.update_time = now
                if catalog_outcomes[key] == 'unchanged':
                    stats['catalogs']['unchanged'] -= 1
                    stats['catalogs']['updated'] += 1
                    catalog_outcomes[key] = 'updated'

        questions = {
            row.external_question_id: row
            for row in (
                await db.execute(
                    select(QbQuestion)
                    .where(
                        QbQuestion.subject_id == 1,
                        QbQuestion.source_provider == 'zujuan',
                        QbQuestion.external_question_id.in_(seen),
                    )
                    .with_for_update()
                )
            ).scalars()
        }
        changed_questions = []
        for snapshot in snapshots:
            item = snapshot['questions'][0]
            key = item['external_id']
            row = questions.get(key)
            values = _observed_values({field: item[field] for field in QUESTION_FIELDS})
            if row is not None:
                # Source absence/restriction/empty strings are not evidence
                # that an earlier trusted answer should be erased.
                if not _answer_is_public(values['answer_status']):
                    for field in ('answer_html', 'analysis_html', 'answer_status'):
                        values.pop(field)
                else:
                    if not str(values['answer_html'] or '').strip() and not str(values['analysis_html'] or '').strip():
                        values.pop('answer_status')
                    for field in ('answer_html', 'analysis_html'):
                        if not str(values[field] or '').strip():
                            values.pop(field)
                if _update(row, values, now):
                    stats['questions']['updated'] += 1
                    changed_questions.append(row.question_id)
                else:
                    stats['questions']['unchanged'] += 1
            else:
                row = QbQuestion(
                    subject_id=1,
                    source_provider='zujuan',
                    external_question_id=key,
                    status='0',
                    create_time=now,
                    update_time=now,
                    **values,
                )
                db.add(row)
                questions[key] = row
                stats['questions']['inserted'] += 1
        await db.flush()
        expected_relations = [
            (
                questions[item['question_external_id']].question_id,
                catalog_map[item['catalog_external_id']].catalog_id,
                item['relation_type'],
                item['evidence_type'],
            )
            for snapshot in snapshots
            for item in snapshot['question_catalogs']
        ]
        expected_tags = [
            (
                questions[item['question_external_id']].question_id,
                item['tag_type'],
                item['tag_name'],
                item['relation_type'],
                item['evidence_type'],
            )
            for snapshot in snapshots
            for item in snapshot['tags']
        ]
        expected_assets = [
            (questions[item['question_external_id']].question_id, item['asset_key'])
            for snapshot in snapshots
            for item in snapshot['assets']
        ]
        relation_map = {
            (row.question_id, row.catalog_id, row.relation_type, row.evidence_type): row
            for row in (
                await db.execute(
                    select(QbQuestionCatalog).where(
                        tuple_(
                            QbQuestionCatalog.question_id,
                            QbQuestionCatalog.catalog_id,
                            QbQuestionCatalog.relation_type,
                            QbQuestionCatalog.evidence_type,
                        ).in_(expected_relations)
                    )
                )
            ).scalars()
        }
        tag_map = {
            (row.question_id, row.tag_type, row.tag_name, row.relation_type, row.evidence_type): row
            for row in (
                await db.execute(
                    select(QbQuestionTag).where(
                        tuple_(
                            QbQuestionTag.question_id,
                            QbQuestionTag.tag_type,
                            QbQuestionTag.tag_name,
                            QbQuestionTag.relation_type,
                            QbQuestionTag.evidence_type,
                        ).in_(expected_tags)
                    )
                )
            ).scalars()
        }
        asset_map = {
            (row.question_id, row.asset_key): row
            for row in (
                await db.execute(
                    select(QbQuestionAsset).where(
                        tuple_(QbQuestionAsset.question_id, QbQuestionAsset.asset_key).in_(expected_assets)
                    )
                )
            ).scalars()
        }
        for snapshot in snapshots:
            question_id = questions[snapshot['questions'][0]['external_id']].question_id
            for collection, model, current, fields, identity_fields in (
                (
                    'question_catalogs',
                    QbQuestionCatalog,
                    relation_map,
                    ('relation_type', 'evidence_type', 'sort_order', 'last_seen_at'),
                    ('catalog_id', 'relation_type', 'evidence_type'),
                ),
                (
                    'tags',
                    QbQuestionTag,
                    tag_map,
                    ('tag_type', 'tag_name', 'relation_type', 'evidence_type', 'sort_order', 'last_seen_at'),
                    ('tag_type', 'tag_name', 'relation_type', 'evidence_type'),
                ),
                (
                    'assets',
                    QbQuestionAsset,
                    asset_map,
                    (
                        'asset_key',
                        'asset_type',
                        'source_url',
                        'storage_path',
                        'mime_type',
                        'file_name',
                        'file_hash',
                        'width',
                        'height',
                        'sort_order',
                        'download_status',
                        'error_message',
                        'last_seen_at',
                    ),
                    ('asset_key',),
                ),
            ):
                stat_key = 'questionCatalogs' if collection == 'question_catalogs' else collection
                for item in snapshot[collection]:
                    values = _observed_values({field: item[field] for field in fields})
                    if collection == 'question_catalogs':
                        values['catalog_id'] = catalog_map[item['catalog_external_id']].catalog_id
                    elif collection == 'assets':
                        values['source_provider'] = 'zujuan'
                    identity = (question_id, *(values[field] for field in identity_fields))
                    row = current.get(identity)
                    if row is None:
                        row = model(question_id=question_id, create_time=now, update_time=now, **values)
                        db.add(row)
                        current[identity] = row
                        stats[stat_key]['inserted'] += 1
                    elif collection == 'assets' and row.source_provider != 'zujuan':
                        # Manual/other-provider ownership survives source refresh.
                        stats[stat_key]['unchanged'] += 1
                    elif _update(row, values, now):
                        stats[stat_key]['updated'] += 1
                    else:
                        stats[stat_key]['unchanged'] += 1
        # Asset ORM flush invalidates the question revision. Cache proofs only
        # after that flush and only for the actual formal body/asset metadata.
        await db.flush()
        merged_rows = list(questions.values())
        actual_assets = await fetch_required_assets(db, [question_payload(row) for row in merged_rows], lock=True)
        await store_proofs(db, merged_rows, actual_assets, proofs, compare_revision=False)
        # Complete-snapshot state must stop claiming exact currentness after
        # incremental changes, including a shared question used by other books.
        affected = {book.external_textbook_id}
        if changed_questions:
            affected.update(
                (
                    await db.execute(
                        select(QbTextbook.external_textbook_id)
                        .distinct()
                        .join(QbCatalogNode, QbCatalogNode.textbook_id == QbTextbook.textbook_id)
                        .join(QbQuestionCatalog, QbQuestionCatalog.catalog_id == QbCatalogNode.catalog_id)
                        .where(
                            QbQuestionCatalog.question_id.in_(changed_questions),
                            QbTextbook.subject_id == 1,
                            QbTextbook.source_provider == 'zujuan',
                        )
                    )
                ).scalars()
            )
        if any(bucket['inserted'] or bucket['updated'] for bucket in stats.values()):
            for state in (
                await db.execute(
                    select(QbQuestionApplyState)
                    .where(
                        QbQuestionApplyState.source_provider == 'zujuan',
                        QbQuestionApplyState.external_textbook_id.in_(affected),
                    )
                    .with_for_update()
                )
            ).scalars():
                state.current_task_id = None
                state.current_collector_run_id = None
                state.snapshot_hash = None
                state.state_token = secrets.token_hex(32)
                state.update_time = now
        result = {'taskId': task_id, 'textbookId': local_textbook_id, 'stats': stats, 'isCurrent': False,
                  'writeIssues': write_issues}
        if persist_checkpoint is not None:
            # The future runner must persist its ownership-checked cursor and
            # batch journal with these same writes, never in a second commit.
            await persist_checkpoint(db, result)
        await db.commit()
        return result
    except BaseException:
        await db.rollback()
        raise
    finally:
        await write_stack.aclose()
