"""Current formal counts and the latest dated source observation are separate."""

from typing import Any

from sqlalchemy import func, select

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbQuestionImport,
    QbSyncBookState,
    QbSyncIssue,
    QbSyncJob,
    QbSyncJobScope,
    QbSyncPlan,
    QbTextbook,
)
from plugins.bank.service.import_dates import utc_datetime
from plugins.bank.service.run_coverage import FORMAT
from plugins.bank.service.sync_issues import needs_person_condition


async def book_coverage(db: Any, textbook_ids: list[int], *, formal_counts: dict[int, int] | None = None, active_counts: dict[int, int] | None = None, display=False):
    if not textbook_ids:
        return {}
    if len(textbook_ids) > 500 or any(type(value) is not int or value <= 0 for value in textbook_ids):
        raise ServiceException(message='教材覆盖查询范围无效')
    from plugins.bank.service.coverage_queries import book_metrics

    stems = await book_metrics(db, textbook_ids, display=display)
    if active_counts is None:
        active_counts = {key: row['activeQuestionCount'] for key, row in stems.items()}
    if formal_counts is None:
        formal_counts = {key: row['formalQuestionCount'] for key, row in stems.items()}
    latest = (
        select(
            QbSyncJobScope.local_textbook_id.label('book'),
            QbSyncJob.run_id.label('task'),
            func.row_number()
            .over(partition_by=QbSyncJobScope.local_textbook_id, order_by=QbSyncJob.run_id.desc())
            .label('position'),
        )
        .join(QbSyncJob, QbSyncJob.run_id == QbSyncJobScope.run_id)
        .where(QbSyncJobScope.local_textbook_id.in_(textbook_ids))
        .subquery()
    )
    task_rows = (
        await db.execute(
            select(latest.c.book, QbSyncJob)
            .join(QbSyncJob, QbSyncJob.run_id == latest.c.task)
            .where(latest.c.position == 1)
        )
    ).all()
    task_info = {
        book: {
            'latestTaskId': job.run_id,
            'latestTaskStatus': job.status,
            'latestTaskOutcome': (job.options_json or {}).get('planOutcome'),
            'savedImportRetries': (job.options_json or {}).get('planImportRetryCount', 0),
            'latestTaskTime': job.finished_at or job.create_time,
        }
        for book, job in task_rows
    }
    pending = dict(
        (
            await db.execute(
                select(QbSyncIssue.textbook_id, func.count())
                .where(QbSyncIssue.textbook_id.in_(textbook_ids), QbSyncIssue.status == 'open', needs_person_condition())
                .group_by(QbSyncIssue.textbook_id)
            )
        ).all()
    )
    schedules = (
        await db.execute(
            select(QbSyncBookState, QbSyncPlan.enabled)
            .join(QbSyncPlan, QbSyncPlan.plan_id == QbSyncBookState.plan_id)
            .where(QbSyncBookState.textbook_id.in_(textbook_ids))
        )
    ).all()
    schedule_info = {
        state.textbook_id: {
            'nextDueAt': utc_datetime(state.next_due_at),
            'automaticEnabled': bool(enabled and state.enabled and not state.exception_kind),
            'exceptionKind': state.exception_kind,
        }
        for state, enabled in schedules
    }
    evidence = QbQuestionImport.run_coverage_json
    observed = evidence['sourceReport']['observedAt'].as_string()
    # Prefer known observation times over legacy undated values. A newer
    # limited run with no probe must not erase an older genuine observation.
    ranked = (
        select(
            QbQuestionImport.import_id,
            func.row_number()
            .over(
                partition_by=QbQuestionImport.local_textbook_id,
                order_by=(
                    observed.desc(),
                    QbQuestionImport.snapshot_locked_at.desc(),
                    QbQuestionImport.import_id.desc(),
                ),
            )
            .label('position'),
        )
        .join(
            QbTextbook,
            (QbTextbook.textbook_id == QbQuestionImport.local_textbook_id)
            & (QbTextbook.subject_id == QbQuestionImport.subject_id)
            & (QbTextbook.source_provider == QbQuestionImport.source_provider)
            & (QbTextbook.external_textbook_id == QbQuestionImport.external_textbook_id),
        )
        .where(
            QbQuestionImport.local_textbook_id.in_(textbook_ids),
            evidence['format'].as_string() == FORMAT,
            evidence['sourceReport']['count'].as_integer().is_not(None),
        )
        .subquery()
    )
    rows = (
        await db.scalars(
            select(QbQuestionImport)
            .join(
                ranked,
                ranked.c.import_id == QbQuestionImport.import_id,
            )
            .where(ranked.c.position == 1)
        )
    ).all()
    observations = {}
    for row in rows:
        report = row.run_coverage_json['sourceReport']
        observations[row.local_textbook_id] = {
            'count': report['count'],
            'observedAt': report['observedAt'],
            'basis': report['basis'],
            'taskId': row.task_id,
            'importId': row.import_id,
            'collectorRunId': row.collector_run_id,
            'snapshotLockedAt': utc_datetime(row.snapshot_locked_at),
        }
    return {
        value: {
            'formalQuestionCount': formal_counts.get(value, 0),
            'activeQuestionCount': active_counts.get(value, 0),
            'latestSourceObservation': observations.get(value),
            'unresolvedIssueCount': pending.get(value, 0),
            **task_info.get(value, {}),
            **schedule_info.get(value, {}),
            **{key: stems.get(value, {}).get(key, 0) for key in (
                'usableQuestionCount', 'uncheckedQuestionCount', 'unusableQuestionCount',
                'catalogCount', 'activeCatalogCount',
            )},
        }
        for value in textbook_ids
    }
