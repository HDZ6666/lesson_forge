"""Issues outlive task deletion; only the corresponding accepted observation closes QC issues."""

import hashlib
import json

from sqlalchemy import exists, func, select

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbSyncIssue,
    QbSyncIssueTask,
    QbSyncJob,
    QbSyncJobScope,
    QbTextbook,
    QbTextbookVersion,
)
from plugins.bank.service.import_dates import utc_datetime
from plugins.bank.service.issue_diagnostics import classify_issue, describe_issue


def _handling_column():
    return QbSyncIssue.evidence_json['handling'].as_string()


def _owner_column():
    return QbSyncIssue.evidence_json['owner'].as_string()


def needs_person_condition():
    """Open issues a person (source page or maintenance) must act on.

    Retries and program-owned waits are excluded. Legacy rows without an
    owner keep their previous meaning (anything not scheduled for retry).
    """
    return ((_handling_column().is_(None)) | (_handling_column() != 'retry')) & (
        _owner_column().is_(None) | (_owner_column() != 'program'))


def handling_condition(handling):
    if handling == 'retry':
        return _handling_column() == 'retry'
    if handling == 'manual':
        return needs_person_condition()
    if handling == 'program':
        return (_handling_column() == 'retry') | (_owner_column() == 'program')
    return _owner_column() == handling


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
            evidence={'importId': row.import_id, 'scopeId': row.scope_id, 'batchNo': row.batch_no + 1, 'collectorRunId': row.collector_run_id, 'cursor': row.cursor, 'ordinal': issue.get('ordinal'), 'handling': 'isolated',
                      'owner': 'program', 'impactScope': 'item'},
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


def _dump_handling(row):
    evidence = row.evidence_json or {}
    if evidence.get('handling') == 'retry':
        return 'retry'
    return classify_issue(row.error_type, row.reason, evidence)['owner']


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
        'handling': _dump_handling(row),
        **classify_issue(row.error_type, row.reason, row.evidence_json),
        'nextAttemptAt': (row.evidence_json or {}).get('nextAttemptAt'),
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
    handling=None,
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
    if handling:
        query = query.where(handling_condition(handling))
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
    books = dict((await db.execute(select(QbTextbook.textbook_id, QbTextbook.textbook_name)
        .where(QbTextbook.textbook_id.in_([r.textbook_id for r in rows])))).all()) if rows else {}
    versions = dict((await db.execute(select(QbTextbook.textbook_id, QbTextbookVersion.version_name)
        .join(QbTextbookVersion, QbTextbook.version_id == QbTextbookVersion.version_id)
        .where(QbTextbook.textbook_id.in_([r.textbook_id for r in rows])))).all()) if rows else {}
    scopes = list((await db.scalars(select(QbSyncJobScope).where(
        QbSyncJobScope.run_id.in_([r.latest_task_id for r in rows])))).all()) if rows else []
    scope_map = {(s.run_id, s.local_textbook_id, s.collector_run_id): s for s in scopes}
    available = (
        dict((await db.execute(select(QbSyncJob.run_id, QbSyncJob.task_module).where(
            QbSyncJob.run_id.in_([r.latest_task_id for r in rows])))).all())
        if rows
        else set()
    )
    return {
        'rows': [
            dict(
                dump(row), textbookName=books.get(row.textbook_id), versionName=versions.get(row.textbook_id),
                diagnosis=describe_issue(row, scope_map.get((row.latest_task_id, row.textbook_id, (row.evidence_json or {}).get('collectorRunId')))),
                latestTaskAvailable=row.latest_task_id in available, taskModule=available.get(row.latest_task_id, 'question')
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


async def record_runtime_failure(db, row, *, stage, message, now):
    """Preserve the failed execution's scope and recovery location."""
    from plugins.bank.entity.do.bank_do import QbSyncJobScope
    scope = await db.get(QbSyncJobScope, row.scope_id)
    if scope is None:
        return
    next_at = getattr(row, 'next_attempt_at', None)
    if stage == 'import':
        from datetime import timedelta

        from plugins.bank.entity.do.bank_do import QbSyncPlan
        task = await db.get(QbSyncJob, row.task_id)
        options = task.options_json or {} if task else {}
        plan_id = options.get('autoPlanId')
        plan = await db.get(QbSyncPlan, plan_id) if plan_id else None
        if plan and plan.enabled and options.get('planImportRetryCount', 0) < 3:
            next_at = now + timedelta(hours=plan.refill_hours)
    evidence = {
        'stage': stage, 'scopeId': row.scope_id, 'collectorRunId': row.collector_run_id,
        'textbookExternalId': scope.external_textbook_id,
        'importId': getattr(row, 'import_id', None), 'intakeId': getattr(row, 'intake_id', None),
        'cursor': getattr(row, 'cursor', None), 'batchNo': getattr(row, 'batch_no', None),
        'collectionError': scope.error_message,
        'snapshotCounts': {'catalogs': scope.catalog_count, 'questions': scope.question_count, 'relations': scope.question_catalog_count} if scope.snapshot_locked_at else None,
        'errorKind': getattr(row, 'error_kind', None), 'attempts': getattr(row, 'attempt_count', None),
        'nextAttemptAt': utc_datetime(next_at).isoformat() if next_at else None,
    }
    # Ownership is decided from the failure itself; a missing retry time no
    # longer turns a transient program failure into "needs a person".
    evidence.update(classify_issue(f'{stage}_failure', message, evidence))
    evidence['handling'] = 'retry' if next_at else evidence['owner']
    await observe(db, subject_id=scope.subject_id, provider=scope.source_provider,
        book_id=scope.local_textbook_id, task_id=row.task_id, kind='scope',
        key=f'{scope.external_textbook_id}:{stage}', error_type=f'{stage}_failure',
        reason=message, evidence=evidence, now=now)


async def resolve_runtime_failures(db, row, *, stage, now):
    from plugins.bank.entity.do.bank_do import QbSyncJobScope
    scope = await db.get(QbSyncJobScope, row.scope_id)
    if scope is None:
        return
    rows = (await db.scalars(select(QbSyncIssue).where(
        QbSyncIssue.subject_id == scope.subject_id, QbSyncIssue.source_provider == scope.source_provider,
        QbSyncIssue.textbook_id == scope.local_textbook_id, QbSyncIssue.object_kind == 'scope',
        QbSyncIssue.object_key == f'{scope.external_textbook_id}:{stage}',
        QbSyncIssue.error_type == f'{stage}_failure', QbSyncIssue.status != 'resolved',
        QbSyncIssue.evidence_json['scopeId'].as_integer() == row.scope_id,
        QbSyncIssue.evidence_json['collectorRunId'].as_integer() == row.collector_run_id,
    ).with_for_update())).all()
    for issue in rows:
        proof = {'repair': f'{stage}_settled', 'collectorRunId': row.collector_run_id,
                 'importId': getattr(row, 'import_id', None), 'intakeId': getattr(row, 'intake_id', None)}
        issue.status, issue.resolved_task_id, issue.resolved_at = 'resolved', row.task_id, now
        issue.evidence_json = proof
        issue.revision += 1
        occurrence = await db.get(QbSyncIssueTask, (issue.issue_id, row.task_id))
        if occurrence:
            occurrence.evidence_json = proof
        else:
            db.add(QbSyncIssueTask(issue_id=issue.issue_id, task_id=row.task_id, evidence_json=proof, observed_at=now))


async def resolve_metadata_issue(db, *, textbook_id, key, error_type, task_id, now):
    rows = (await db.scalars(select(QbSyncIssue).where(QbSyncIssue.subject_id == 1,
        QbSyncIssue.source_provider == 'zujuan', QbSyncIssue.textbook_id == textbook_id,
        QbSyncIssue.object_key == key, QbSyncIssue.error_type == error_type, QbSyncIssue.status != 'resolved').with_for_update())).all()
    for row in rows:
        row.status, row.resolved_task_id, row.resolved_at = 'resolved', task_id, now
        row.revision += 1
        proof = {'repair': 'matching_metadata_identity', 'taskId': task_id, 'externalId': key}
        row.evidence_json = proof
        occurrence = await db.get(QbSyncIssueTask, (row.issue_id, task_id))
        if occurrence:
            occurrence.evidence_json = proof
        else:
            db.add(QbSyncIssueTask(issue_id=row.issue_id, task_id=task_id, evidence_json=proof, observed_at=now))


async def mark_runtime_retry(db, row, *, stage, now):
    from plugins.bank.entity.do.bank_do import QbSyncJobScope
    scope = await db.get(QbSyncJobScope, row.scope_id)
    if scope is None:
        return
    issue = await db.scalar(select(QbSyncIssue).where(
        QbSyncIssue.subject_id == scope.subject_id, QbSyncIssue.source_provider == scope.source_provider,
        QbSyncIssue.textbook_id == scope.local_textbook_id, QbSyncIssue.object_kind == 'scope',
        QbSyncIssue.object_key == f'{scope.external_textbook_id}:{stage}',
        QbSyncIssue.error_type == f'{stage}_failure', QbSyncIssue.status != 'resolved',
        QbSyncIssue.evidence_json['scopeId'].as_integer() == row.scope_id,
        QbSyncIssue.evidence_json['collectorRunId'].as_integer() == row.collector_run_id,
    ).with_for_update())
    if issue:
        issue.evidence_json = {**(issue.evidence_json or {}), 'handling': 'retry',
                               'nextAttemptAt': utc_datetime(now).isoformat(), 'retryTaskId': row.task_id}
        issue.revision += 1
