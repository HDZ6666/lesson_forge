"""Issues outlive task deletion; only the corresponding accepted observation closes QC issues."""

import hashlib
import json

from sqlalchemy import exists, func, select

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbSyncIssue, QbSyncIssueTask, QbSyncJob, QbTextbook
from plugins.bank.service.import_dates import utc_datetime


def identity(subject, provider, book, kind, key, error):
    return hashlib.sha256(
        json.dumps([subject, provider, book, kind, key, error], separators=(',', ':')).encode()
    ).hexdigest()


async def observe(db, *, subject_id, provider, book_id, task_id, kind, key, error_type, reason, evidence, now):
    digest = identity(subject_id, provider, book_id, kind, key, error_type)
    row = await db.scalar(select(QbSyncIssue).where(QbSyncIssue.identity_key == digest).with_for_update())
    if row is None:
        row = QbSyncIssue(
            identity_key=digest,
            subject_id=subject_id,
            source_provider=provider,
            textbook_id=book_id,
            object_kind=kind,
            object_key=key,
            error_type=error_type,
            first_task_id=task_id,
            latest_task_id=task_id,
            reason=str(reason)[:2000],
            evidence_json=evidence,
            first_seen_at=now,
            last_seen_at=now,
            status='open',
            attempts=1,
            revision=1,
        )
        db.add(row)
    else:
        row.attempts += 1
        row.latest_task_id = task_id
        row.reason = str(reason)[:2000]
        row.evidence_json = evidence
        row.last_seen_at = now
        row.revision += 1
        # Explicit ignore stays ignored across failed retries; a real repair
        # remains eligible for automatic resolution.
        if row.status != 'ignored':
            row.status = 'open'
            row.resolved_at = row.resolved_task_id = None
    await db.flush()
    occurrence = await db.get(QbSyncIssueTask, (row.issue_id, task_id))
    if occurrence is None:
        db.add(QbSyncIssueTask(issue_id=row.issue_id, task_id=task_id, evidence_json=evidence, observed_at=now))
    else:
        occurrence.evidence_json = evidence
        occurrence.observed_at = now
    return row


async def record_import_batch(db, row, issues, accepted_keys, now):
    for issue in issues:
        await observe(
            db,
            subject_id=row.subject_id,
            provider=row.source_provider,
            book_id=row.local_textbook_id,
            task_id=row.task_id,
            kind='question',
            key=str(issue['questionId']),
            error_type='question_quality',
            reason=issue['reason'],
            evidence={'importId': row.import_id, 'batchNo': row.batch_no + 1, 'collectorRunId': row.collector_run_id},
            now=now,
        )
    if accepted_keys:
        repaired = (
            await db.scalars(
                select(QbSyncIssue)
                .where(
                    QbSyncIssue.subject_id == row.subject_id,
                    QbSyncIssue.source_provider == row.source_provider,
                    QbSyncIssue.textbook_id == row.local_textbook_id,
                    QbSyncIssue.object_kind == 'question',
                    QbSyncIssue.error_type == 'question_quality',
                    QbSyncIssue.object_key.in_(accepted_keys),
                    QbSyncIssue.status != 'resolved',
                )
                .with_for_update()
            )
        ).all()
        for issue in repaired:
            issue.status = 'resolved'
            issue.resolved_task_id = row.task_id
            issue.resolved_at = now
            issue.revision += 1
            db.add(
                QbSyncIssueTask(
                    issue_id=issue.issue_id,
                    task_id=row.task_id,
                    evidence_json={'repair': 'accepted_same_question'},
                    observed_at=now,
                )
            ) if await db.get(QbSyncIssueTask, (issue.issue_id, row.task_id)) is None else None
            issue.evidence_json = {
                'importId': row.import_id,
                'batchNo': row.batch_no + 1,
                'collectorRunId': row.collector_run_id,
                'repair': 'accepted_same_question',
            }


def dump(row):
    return {
        'issueId': row.issue_id,
        'subjectId': row.subject_id,
        'textbookId': row.textbook_id,
        'objectKind': row.object_kind,
        'objectKey': row.object_key,
        'errorType': row.error_type,
        'status': row.status,
        'reason': row.reason,
        'firstTaskId': row.first_task_id,
        'latestTaskId': row.latest_task_id,
        'resolvedTaskId': row.resolved_task_id,
        'attempts': row.attempts,
        'evidence': row.evidence_json,
        'operatorNote': row.operator_note,
        'revision': row.revision,
        'firstSeenAt': utc_datetime(row.first_seen_at),
        'lastSeenAt': utc_datetime(row.last_seen_at),
        'resolvedAt': utc_datetime(row.resolved_at),
    }


async def list_issues(
    db,
    *,
    subject_id=None,
    textbook_id=None,
    task_id=None,
    status=None,
    error_type=None,
    since=None,
    until=None,
    before=None,
    page_size=20,
):
    query = select(QbSyncIssue)
    for column, value in (
        (QbSyncIssue.subject_id, subject_id),
        (QbSyncIssue.textbook_id, textbook_id),
        (QbSyncIssue.status, status),
        (QbSyncIssue.error_type, error_type),
    ):
        if value is not None:
            query = query.where(column == value)
    if task_id is not None:
        query = query.where(
            exists(
                select(1).where(QbSyncIssueTask.issue_id == QbSyncIssue.issue_id, QbSyncIssueTask.task_id == task_id)
            )
        )
    if since is not None:
        query = query.where(QbSyncIssue.last_seen_at >= since)
    if until is not None:
        query = query.where(QbSyncIssue.last_seen_at < until)
    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    if before is not None:
        query = query.where(QbSyncIssue.issue_id < before)
    rows = (await db.scalars(query.order_by(QbSyncIssue.issue_id.desc()).limit(page_size + 1))).all()
    books = (
        {
            book.textbook_id: book.textbook_name
            for book in (
                await db.scalars(select(QbTextbook).where(QbTextbook.textbook_id.in_([r.textbook_id for r in rows])))
            ).all()
        }
        if rows
        else {}
    )
    available = (
        set(
            (
                await db.scalars(select(QbSyncJob.run_id).where(QbSyncJob.run_id.in_([r.latest_task_id for r in rows])))
            ).all()
        )
        if rows
        else set()
    )
    return {
        'rows': [
            dict(
                dump(row), textbookName=books.get(row.textbook_id), latestTaskAvailable=row.latest_task_id in available
            )
            for row in rows[:page_size]
        ],
        'total': total,
        'nextCursor': rows[page_size - 1].issue_id if len(rows) > page_size else None,
    }


async def update_issue(db, issue_id, expected_revision, status, note):
    row = await db.get(QbSyncIssue, issue_id, with_for_update=True, populate_existing=True)
    if row is None:
        raise ServiceException(message='问题不存在')
    if row.revision != expected_revision:
        raise ServiceException(message='问题状态已变化，请刷新后重试')
    # "Resolved" requires actual matching repair evidence, not a UI button.
    if status not in ('open', 'ignored'):
        raise ServiceException(message='人工操作只能重新待处理或忽略，修复由对应入库结果确认')
    row.status, row.operator_note = status, note
    row.revision += 1
    await db.commit()
    return dump(row)


async def resolve_scope_issues(db, job, scope, now):
    """Only a matching sealed, complete scan can close a book-scope failure."""
    from plugins.bank.entity.do.bank_do import QbQuestionImport

    rows = (
        await db.scalars(
            select(QbQuestionImport).where(
                QbQuestionImport.task_id == job.run_id,
                QbQuestionImport.collector_run_id == scope.collector_run_id,
                QbQuestionImport.status.in_(('completed', 'partial')),
            )
        )
    ).all()
    proof = None
    for row in rows:
        scan = (row.run_coverage_json or {}).get('scan') or {}
        selected = scan.get('selectedCatalogCount')
        if (
            scan.get('targetsKnown') is True
            and selected
            and scan.get('scanCompletedCatalogCount') == selected
            and scan.get('unscannedCatalogCount') == 0
            and scan.get('catalogSelectionTruncated') is False
            and all(scan.get(key) == 0 for key in ('failedPageCount', 'duplicatePageCount', 'parseErrorCount'))
        ):
            proof = {
                'importId': row.import_id,
                'collectorRunId': scope.collector_run_id,
                'repair': 'matching_scope_scan',
            }
            break
    if proof is None:
        return
    issues = (
        await db.scalars(
            select(QbSyncIssue)
            .where(
                QbSyncIssue.subject_id == job.subject_id,
                QbSyncIssue.source_provider == scope.source_provider,
                QbSyncIssue.textbook_id == scope.local_textbook_id,
                QbSyncIssue.object_kind == 'scope',
                QbSyncIssue.object_key == scope.external_textbook_id,
                QbSyncIssue.error_type == 'scope_failure',
                QbSyncIssue.status != 'resolved',
            )
            .with_for_update()
        )
    ).all()
    for issue in issues:
        issue.status = 'resolved'
        issue.resolved_task_id = job.run_id
        issue.resolved_at = now
        issue.evidence_json = proof
        issue.revision += 1
        if await db.get(QbSyncIssueTask, (issue.issue_id, job.run_id)) is None:
            db.add(QbSyncIssueTask(issue_id=issue.issue_id, task_id=job.run_id, evidence_json=proof, observed_at=now))
