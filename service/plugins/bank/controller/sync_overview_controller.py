from typing import Annotated

from fastapi import Query, Response
from sqlalchemy import and_, case, exists, false, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from common.aspect.db_session import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import PreAuthDependency
from common.router import APIRouterPro
from plugins.bank.entity.do.bank_do import (
    QbQuestionImport,
    QbSyncBookState,
    QbSyncCycle,
    QbSyncIssue,
    QbSyncIssueTask,
    QbSyncJob,
    QbSyncJobScope,
    QbSyncPlan,
    QbSyncSupplement,
    QbTextbook,
)
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
    from plugins.bank.service.sync_plans import control_status, list_plans

    plan_query = select(QbSyncPlan)
    if subject_id is not None:
        plan_query = plan_query.where(QbSyncPlan.subject_id == subject_id)
    plan_rows = list((await db.scalars(plan_query)).all())
    jobs, cycles = await _current_work(db, plan_rows, subject_id)
    task_ids = jobs.with_only_columns(QbSyncJob.run_id)
    question_ids = task_ids.where(QbSyncJob.task_module == 'question')
    scopes = list((await db.scalars(select(QbSyncJobScope).where(
        QbSyncJobScope.run_id.in_(question_ids)))).all())
    # Count only the current sessions' targets and actual task scopes.
    # Formal textbook/question tables supply names only, never totals.
    book_ids = {book for cycle in cycles for book in cycle.targets or []}
    for plan in plan_rows:
        if not plan.session_no and plan.cycle_no:
            book_ids.update(plan.cycle_targets or [])
    book_ids.update(scope.local_textbook_id for scope in scopes if scope.local_textbook_id)
    linked_issues = select(QbSyncIssueTask.issue_id).where(QbSyncIssueTask.task_id.in_(task_ids))
    issue_scope = or_(QbSyncIssue.issue_id.in_(linked_issues), QbSyncIssue.latest_task_id.in_(task_ids))
    issue_query = select(QbSyncIssue.status, func.count()).where(issue_scope).group_by(QbSyncIssue.status)
    issue_counts = dict((await db.execute(issue_query)).all())
    manual_issues = await db.scalar(select(func.count()).select_from(QbSyncIssue).where(
        issue_scope, QbSyncIssue.status == 'open', needs_person_condition()))
    plans = await list_plans(db, subject_id)
    control = await control_status(db)
    current = await db.scalar(jobs.where(QbSyncJob.active_slot.is_not(None)).order_by(QbSyncJob.run_id).limit(1))
    from plugins.bank.service.incremental_import import _clock
    from plugins.bank.service.sync_plans import automatic_task_reason
    waiting = list((await db.scalars(jobs.where(QbSyncJob.status == 'queued').order_by(QbSyncJob.dispatch_priority.desc(), QbSyncJob.dispatch_rank, QbSyncJob.run_id))).all())
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
    current_cycles = {(p.plan_id, p.cycle_no) for p in plan_rows}
    cycle_targets = {(cycle.plan_id, book): cycle.cycle_no for cycle in cycles
                     if (cycle.plan_id, cycle.cycle_no) in current_cycles for book in cycle.targets or []}
    for plan in plan_rows:
        if not plan.session_no and plan.cycle_no:
            cycle_targets.update({(plan.plan_id, book): plan.cycle_no for book in plan.cycle_targets or []})
    states = list((await db.scalars(select(QbSyncBookState).where(
        QbSyncBookState.plan_id.in_([p.plan_id for p in plan_rows])))).all()) if plan_rows else []
    cycle_attempted = sum(s.last_cycle_no >= cycle_targets.get((s.plan_id, s.textbook_id), 10**10)
                          for s in states)
    visible_task_ids = [row.run_id for row in (current, next_task, deferred[0] if deferred else None) if row is not None]
    book_labels = dict((await db.execute(select(QbSyncJobScope.run_id, QbTextbook.textbook_name)
        .join(QbTextbook, QbTextbook.textbook_id == QbSyncJobScope.local_textbook_id)
        .where(QbSyncJobScope.run_id.in_(visible_task_ids)))).all()) if visible_task_ids else {}

    from plugins.bank.service.incremental_import import import_status
    from plugins.bank.service.sync_dispatch import queue_fields
    import_query = select(QbQuestionImport).where(QbQuestionImport.task_id.in_(task_ids))
    all_imports = list((await db.scalars(import_query)).all())
    importing_query = import_query.where(QbQuestionImport.status.in_(('queued','preparing','running','paused')))
    import_rows = list((await db.scalars(importing_query.order_by(case((QbQuestionImport.status.in_(('preparing','running')),0),else_=1),QbQuestionImport.import_id))).all())
    current_import = import_status(import_rows[0]) if import_rows else None
    if current_import:
        book = await db.get(QbTextbook, import_rows[0].local_textbook_id)
        current_import['textbookName'] = book.textbook_name if book else None
    reclaimed_spools = sum(bool((row.stats_json or {}).get('spoolReclaimed')) for row in all_imports)
    reclaimed_runs = await db.scalar(select(func.count()).select_from(jobs.where(
        QbSyncJob.options_json['snapshotReclaimed'].as_boolean().is_(True))
        .with_only_columns(QbSyncJob.run_id).subquery()))
    from plugins.bank.service.sync_plans import import_stat

    saved_count = sum(int(scope.question_count or 0) for scope in scopes)
    accepted_count = sum(int(row.accepted_count or 0) for row in all_imports)
    new_questions = sum(import_stat(row.stats_json, 'questions') for row in all_imports)
    new_relations = sum(import_stat(row.stats_json, 'questionCatalogs') for row in all_imports)

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

    job_rows = jobs.with_only_columns(QbSyncJob.run_id, QbSyncJob.status).subquery()
    counts = (await db.execute(select(job_rows.c.status, func.count()).group_by(job_rows.c.status))).all()
    recent = (await db.execute(jobs.order_by(QbSyncJob.run_id.desc()).limit(10))).scalars().all()
    return ResponseUtil.success(
        data={
            'textbooks': len(book_ids),
            'savedQuestionCount': saved_count, 'acceptedQuestionCount': accepted_count,
            'newQuestionCount': new_questions, 'newRelationCount': new_relations,
            'scope': 'current_sessions',
            'issueCounts': issue_counts,
            'plans': plans,
            'control': control,
            'currentTask': brief(current),
            'currentImport': current_import, 'pendingImportCount': len(import_rows),
            'cleanup': {'spools': reclaimed_spools, 'runs': reclaimed_runs},
            'nextTask': brief(next_task),
            'deferredTask': dict(brief(deferred[0]), reason=deferred[1]) if deferred else None,
            'cycleTargetCount': len(cycle_targets), 'cycleAttemptedCount': cycle_attempted,
            'openIssueCount': manual_issues, 'retryIssueCount': issue_counts.get('open', 0) - manual_issues,
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


async def _current_work(db, plans, subject_id):
    """Each plan's current session only; older sessions remain in history."""
    session_scope = [and_(QbSyncCycle.plan_id == p.plan_id, QbSyncCycle.session_no == p.session_no)
                     for p in plans if p.session_no]
    cycles = list((await db.scalars(select(QbSyncCycle).where(
        or_(*session_scope) if session_scope else false()))).all())
    conditions = []
    for plan in plans:
        owned = or_(QbSyncJob.options_json['autoPlanId'].as_integer() == plan.plan_id,
                    QbSyncJob.options_json['manualPlanId'].as_integer() == plan.plan_id)
        numbers = [cycle.cycle_no for cycle in cycles if cycle.plan_id == plan.plan_id]
        if not plan.session_no and plan.cycle_no:
            numbers.append(plan.cycle_no)
        if numbers:
            conditions.append(and_(owned, QbSyncJob.options_json['autoCycleNo'].as_integer().in_(numbers),
                                   QbSyncJob.options_json['supplementId'].as_integer().is_(None)))
        if plan.discovery_task_id:
            conditions.append(QbSyncJob.run_id == plan.discovery_task_id)
        # A running standalone supplement is current work, not an earlier session.
        conditions.append(and_(owned, exists(select(1).where(
            QbSyncSupplement.plan_id == plan.plan_id, QbSyncSupplement.status == 'running',
            QbSyncSupplement.task_id == QbSyncJob.run_id))))
    # Keep explicit standalone work visible while it is collecting/importing.
    # Its completed history must not leak into a newly created subject plan.
    conditions.append(and_(
        QbSyncJob.options_json['autoPlanId'].as_integer().is_(None),
        QbSyncJob.options_json['manualPlanId'].as_integer().is_(None),
        or_(QbSyncJob.status.in_(('queued', 'starting', 'running', 'cancelling')),
            exists(select(1).where(QbQuestionImport.task_id == QbSyncJob.run_id,
                   QbQuestionImport.status.in_(('queued', 'preparing', 'running', 'paused'))))),
    ))
    jobs = select(QbSyncJob).where(or_(*conditions))
    if subject_id is not None:
        jobs = jobs.where(QbSyncJob.subject_id == subject_id)
    return jobs, cycles
