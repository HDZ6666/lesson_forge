from typing import Annotated

from fastapi import Query, Response
from sqlalchemy import case, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from common.aspect.db_session import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import PreAuthDependency
from common.router import APIRouterPro
from plugins.bank.entity.do.bank_do import QbSubject, QbSyncJob, QbSyncPlan, QbTextbook, QbTextbookVersion
from plugins.bank.service.sync_issues import needs_person_condition
from utils.response_util import ResponseUtil

sync_overview_controller = APIRouterPro(
    prefix='/bank/sync/overview',
    order_num=21,
    tags=['同步中心'],
    dependencies=[
        PreAuthDependency(),
        UserInterfaceAuthDependency(['bank:sync:center:list', 'bank:sync:overview:list']),
    ],
)


@sync_overview_controller.get('')
async def overview(
    db: Annotated[AsyncSession, DBSessionDependency()],
    subject_id: Annotated[int | None, Query(alias='subjectId', gt=0)] = None,
) -> Response:
    books = select(QbTextbook.textbook_id).join(QbTextbookVersion, QbTextbookVersion.version_id == QbTextbook.version_id).join(QbSubject, QbSubject.subject_id == QbTextbook.subject_id).where(QbTextbook.status == '0', QbTextbookVersion.status == '0', QbSubject.status == '0', QbTextbookVersion.subject_id == QbTextbook.subject_id)
    jobs = select(QbSyncJob)
    if subject_id is not None:
        books = books.where(QbTextbook.subject_id == subject_id)
        jobs = jobs.where(QbSyncJob.subject_id == subject_id)
    from plugins.bank.entity.do.bank_do import QbSyncIssue
    from plugins.bank.service.coverage_queries import books_with_usable_questions
    from plugins.bank.service.sync_plans import control_status, list_plans

    ids = list((await db.scalars(books)).all())
    populated_books = await books_with_usable_questions(db, ids)
    total = len(ids)
    populated = len(populated_books)
    issue_query = select(QbSyncIssue.status, func.count()).group_by(QbSyncIssue.status)
    if subject_id is not None:
        issue_query = issue_query.where(QbSyncIssue.subject_id == subject_id)
    issue_counts = dict((await db.execute(issue_query)).all())
    manual_query = select(func.count()).select_from(QbSyncIssue).where(QbSyncIssue.status == 'open', needs_person_condition())
    if subject_id is not None:
        manual_query = manual_query.where(QbSyncIssue.subject_id == subject_id)
    manual_issues = await db.scalar(manual_query)
    plans = await list_plans(db, subject_id)
    control = await control_status(db)
    current = await db.scalar(jobs.where(QbSyncJob.active_slot.is_not(None)).order_by(QbSyncJob.run_id).limit(1))
    from plugins.bank.service.incremental_import import _clock
    from plugins.bank.service.sync_plans import automatic_task_reason
    waiting = list((await db.scalars(jobs.where(QbSyncJob.status == 'queued').order_by(QbSyncJob.run_id))).all())
    now = await _clock(db)
    next_task = None
    deferred = None
    for pending in waiting:
        reason = control['reason'] or '同步已紧急暂停' if control['paused'] else await automatic_task_reason(db, pending)
        if not reason and pending.task_module == 'question':
            from exceptions.exception import ServiceException
            from plugins.bank.service.sync_dispatch import _validate_waiting_scope
            try:
                await _validate_waiting_scope(db, pending, lock=False)
            except ServiceException as exc:
                reason = exc.message
        if not reason and pending.dispatch_not_before and pending.dispatch_not_before > now:
            reason = pending.dispatch_error or '等待最早派发时间'
        if not reason:
            next_task = pending
            break
        if deferred is None:
            deferred = (pending, reason)
    from plugins.bank.entity.do.bank_do import QbQuestionImport, QbSyncBookState
    states = list((await db.scalars(select(QbSyncBookState).where(QbSyncBookState.plan_id.in_([p['planId'] for p in plans])))).all()) if plans else []
    cycle_targets = {(p['planId'], b): p['cycleNo'] for p in plans for b in (await db.get(QbSyncPlan, p['planId'])).cycle_targets or []}
    cycle_attempted = sum(s.last_cycle_no >= cycle_targets.get((s.plan_id, s.textbook_id), 10**10) for s in states)
    ranked = select(QbQuestionImport.local_textbook_id.label('book'), QbQuestionImport.status, QbQuestionImport.snapshot_complete, func.row_number().over(partition_by=QbQuestionImport.local_textbook_id, order_by=QbQuestionImport.import_id.desc()).label('pos')).where(QbQuestionImport.local_textbook_id.in_(ids)).subquery()
    incomplete = set((await db.scalars(select(ranked.c.book).where(ranked.c.pos == 1, (ranked.c.status != 'completed') | (ranked.c.snapshot_complete == 0)))).all())
    need_refill = (set(ids) - populated_books) | incomplete
    storage = await _storage_stats(db)

    from plugins.bank.entity.do.bank_do import QbSyncJobScope
    visible_task_ids = [row.run_id for row in (current, next_task, deferred[0] if deferred else None) if row is not None]
    book_labels = dict((await db.execute(select(QbSyncJobScope.run_id, QbTextbook.textbook_name)
        .join(QbTextbook, QbTextbook.textbook_id == QbSyncJobScope.local_textbook_id)
        .where(QbSyncJobScope.run_id.in_(visible_task_ids)))).all()) if visible_task_ids else {}

    from plugins.bank.service.incremental_import import import_status
    from plugins.bank.service.sync_dispatch import queue_fields
    importing_query = select(QbQuestionImport).where(QbQuestionImport.status.in_(('queued','preparing','running','paused')))
    if subject_id is not None:
        importing_query = importing_query.where(QbQuestionImport.subject_id == subject_id)
    import_rows = list((await db.scalars(importing_query.order_by(case((QbQuestionImport.status.in_(('preparing','running')),0),else_=1),QbQuestionImport.import_id))).all())
    current_import = import_status(import_rows[0]) if import_rows else None
    if current_import:
        book = await db.get(QbTextbook, import_rows[0].local_textbook_id)
        current_import['textbookName'] = book.textbook_name if book else None
    reclaimed_spools = await db.scalar(select(func.count()).select_from(QbQuestionImport).where(QbQuestionImport.stats_json['spoolReclaimed'].as_boolean().is_(True)))
    reclaimed_runs = await db.scalar(select(func.count()).select_from(QbSyncJob).where(QbSyncJob.options_json['snapshotReclaimed'].as_boolean().is_(True)))

    def brief(row):
        return (
            {
                'taskId': row.run_id,
                'taskModule': row.task_module,
                'textbookName': book_labels.get(row.run_id),
                'reason': queue_fields(row).get('queueReason'),
                'notBefore': queue_fields(row).get('queueNotBefore'),
            }
            if row
            else None
        )

    job_rows = jobs.subquery()
    counts = (await db.execute(select(job_rows.c.status, func.count()).group_by(job_rows.c.status))).all()
    recent = (await db.execute(jobs.order_by(QbSyncJob.run_id.desc()).limit(10))).scalars().all()
    return ResponseUtil.success(
        data={
            'textbooks': total,
            'issueCounts': issue_counts,
            'plans': plans,
            'control': control,
            'currentTask': brief(current),
            'currentImport': current_import, 'pendingImportCount': len(import_rows),
            'cleanup': {'spools': reclaimed_spools, 'runs': reclaimed_runs},
            'nextTask': brief(next_task),
            'deferredTask': dict(brief(deferred[0]), reason=deferred[1]) if deferred else None,
            'cycleTargetCount': len(cycle_targets), 'cycleAttemptedCount': cycle_attempted,
            'textbooksNeedingRefill': len(need_refill), 'openIssueCount': manual_issues, 'retryIssueCount': issue_counts.get('open', 0) - manual_issues,
            'storage': storage,
            'textbooksWithQuestions': populated,
            'textbooksWithoutQuestions': total - populated,
            'taskCounts': dict(counts),
            'recentTasks': [
                {
                    'taskId': row.run_id,
                    'taskModule': row.task_module,
                    'status': row.status,
                    'createTime': row.create_time,
                    'error': row.error_message,
                }
                for row in recent
            ],
        }
    )


async def _storage_stats(db):
    """Global storage totals are display statistics, refreshed once a minute."""
    from plugins.bank.entity.do.bank_do import QbQuestionAsset

    async def read(session):
        query = select(func.count(func.distinct(QbQuestionAsset.file_hash))).where(
            QbQuestionAsset.download_status == 'downloaded')
        database_bytes = None
        if session.bind.dialect.name == 'mysql':
            query = query.with_hint(QbQuestionAsset, 'FORCE INDEX (idx_qb_question_asset_download_hash)',
                                   dialect_name='mysql')
            database_bytes = await session.scalar(text(
                'SELECT COALESCE(SUM(data_length + index_length),0) '
                'FROM information_schema.tables WHERE table_schema = DATABASE()'))
        return {'databaseBytes': int(database_bytes) if database_bytes is not None else None,
                'uniqueAssetCount': await session.scalar(query)}

    if db.bind.dialect.name != 'mysql':
        return await read(db)
    import hashlib

    from plugins.bank.service.live_progress_cache import get_or_load

    engine = db.bind
    key = 'bank:overview-storage:v1:' + hashlib.sha256(str(engine.url).encode()).hexdigest()

    async def load():
        async with AsyncSession(bind=engine) as snapshot:
            return await read(snapshot)

    return await get_or_load(key, load, ttl=60)
