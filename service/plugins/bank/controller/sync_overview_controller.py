from typing import Annotated

from fastapi import Query, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from common.aspect.db_session import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import PreAuthDependency
from common.router import APIRouterPro
from plugins.bank.entity.do.bank_do import QbSyncJob, QbTextbook
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
    books = select(QbTextbook.textbook_id).where(QbTextbook.status == '0')
    jobs = select(QbSyncJob)
    if subject_id is not None:
        books = books.where(QbTextbook.subject_id == subject_id)
        jobs = jobs.where(QbSyncJob.subject_id == subject_id)
    from plugins.bank.entity.do.bank_do import QbSyncIssue
    from plugins.bank.service.coverage_queries import book_stem_counts
    from plugins.bank.service.sync_plans import control_status, list_plans

    ids = list((await db.scalars(books)).all())
    stem_counts = {}
    for offset in range(0, len(ids), 500):
        stem_counts.update(await book_stem_counts(db, ids[offset : offset + 500]))
    total = len(ids)
    populated = sum(value['usableQuestionCount'] > 0 for value in stem_counts.values())
    issue_query = select(QbSyncIssue.status, func.count()).group_by(QbSyncIssue.status)
    if subject_id is not None:
        issue_query = issue_query.where(QbSyncIssue.subject_id == subject_id)
    issue_counts = dict((await db.execute(issue_query)).all())
    plans = await list_plans(db, subject_id)
    control = await control_status(db)
    current = await db.scalar(jobs.where(QbSyncJob.active_slot.is_not(None)).order_by(QbSyncJob.run_id).limit(1))
    next_task = await db.scalar(jobs.where(QbSyncJob.status == 'queued').order_by(QbSyncJob.run_id).limit(1))

    def brief(row):
        return (
            {
                'taskId': row.run_id,
                'taskModule': row.task_module,
                'reason': row.dispatch_error,
                'notBefore': row.dispatch_not_before,
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
            'nextTask': brief(next_task),
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
