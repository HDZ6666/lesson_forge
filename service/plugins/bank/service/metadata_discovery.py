"""Merge completed manual/automatic discoveries through one durable path."""

from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select, update

from plugins.bank.entity.do.bank_do import QbSyncJob, QbSyncPlan
from plugins.bank.service.incremental_import import _clock
from plugins.bank.service.plan_work import PlanWorkPaused, allowed_condition
from plugins.bank.service.textbook_apply_service import TextbookApplyService


async def merge_completed_discoveries(*, session_factory):
    async with session_factory() as db:
        ids = list((await db.scalars(select(QbSyncJob.run_id).where(
            allowed_condition(), QbSyncJob.task_module == 'textbook', QbSyncJob.status == 'completed',
            QbSyncJob.options_json['discoveryMode'].as_string() == 'merge',
            QbSyncJob.options_json['discoveryResult'].is_(None) |
            (QbSyncJob.options_json['discoveryResult'].as_string().is_(None)),
            or_(QbSyncJob.options_json['discoveryAttempts'].as_integer().is_(None),
                QbSyncJob.options_json['discoveryAttempts'].as_integer() < 3),
        ).order_by(QbSyncJob.run_id).limit(25))).all())
    for task_id in ids:
        async with session_factory() as db:
            row = await db.get(QbSyncJob, task_id)
            options = dict(row.options_json or {})
            if options.get('discoveryResult'):
                continue
            retry_at = options.get('discoveryRetryAt')
            if retry_at and datetime.fromisoformat(retry_at) > datetime.now(timezone.utc).replace(tzinfo=None):
                continue
            await db.rollback()
            try:
                await TextbookApplyService.apply(db, task_id, operator='discovery', discovery=True)
                await db.execute(update(QbSyncPlan).where(
                    (QbSyncPlan.discovery_task_id == task_id) |
                    ((QbSyncPlan.discovery_task_id.is_(None)) & (QbSyncPlan.discovery_processed_task_id == task_id))
                ).values(discovery_error=None))
                await db.commit()
            except PlanWorkPaused:
                await db.rollback()
                continue
            except Exception as exc:
                await db.rollback()
                row = await db.get(QbSyncJob, task_id, with_for_update=True, populate_existing=True)
                if row is None or (row.options_json or {}).get('discoveryResult'):
                    continue
                options = dict(row.options_json or {})
                attempts = int(options.get('discoveryAttempts', 0)) + 1
                message = str(getattr(exc, 'message', None) or exc)[:500]
                timestamp = await _clock(db)
                options.update(discoveryAttempts=attempts, discoveryError=message,
                               discoveryRetryAt=(timestamp + timedelta(seconds=(30, 90, 300)[min(attempts-1, 2)])).isoformat())
                row.options_json = options
                if attempts >= 3:
                    from plugins.bank.service.sync_issues import observe
                    await observe(db, subject_id=row.subject_id or 1, provider='zujuan', book_id=0,
                                  task_id=task_id, kind='metadata', key='discovery', error_type='metadata_validation',
                                  reason=message, evidence={'stage': 'discovery', 'attempts': attempts}, now=timestamp)
                await db.commit()


async def retry_discovery(db, task_id):
    from exceptions.exception import ServiceException
    row = await db.get(QbSyncJob, task_id, with_for_update=True, populate_existing=True)
    if row is None or row.task_module != 'textbook' or row.status != 'completed' or (row.options_json or {}).get('discoveryMode') != 'merge':
        raise ServiceException(message='只有已完成的新发现任务可以重试登记')
    options = dict(row.options_json or {})
    if not options.get('discoveryResult'):
        options.update(discoveryAttempts=0, discoveryError=None, discoveryRetryAt=None)
        row.options_json = options
    await db.commit()
    return {'taskId': task_id, 'registered': bool(options.get('discoveryResult'))}
