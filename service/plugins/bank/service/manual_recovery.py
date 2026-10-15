"""Bind manual verification to a persisted failed execution, never a client URL."""
import asyncio
import re

from sqlalchemy import func, or_, select

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbSyncJob, QbSyncJobScope
from plugins.bank.service.collector_client import CollectorClient


async def call(action, payload):
    client = CollectorClient()
    client.timeout = 60
    return await asyncio.to_thread(client._request, 'POST', f'/v1/manual-recovery/{action}', payload=payload)


async def open_browser(db, subject_id, owner):
    source = await asyncio.to_thread(CollectorClient().source_control)
    if not source.get('manualRequired'):
        raise ServiceException(message='当前来源没有待处理的人工验证')
    result = (await db.execute(select(QbSyncJob, QbSyncJobScope).join(QbSyncJobScope,
        QbSyncJobScope.run_id == QbSyncJob.run_id).where(QbSyncJob.subject_id == subject_id,
        QbSyncJob.task_module == 'question', QbSyncJob.status == 'blocked',
        QbSyncJob.error_message == source.get('reason')).order_by(QbSyncJob.run_id.desc()).limit(1))).first()
    if not result:
        return await _open_discovery(db, subject_id, owner, source)
    row, scope = result
    match = re.search(r'目录\s+(\S+)\s+第\s+(\d+)\s+页', row.error_message or '')
    if not match or not scope.snapshot_locked_at:
        raise ServiceException(message='缺少原失败目录、页码或已封存成果，暂不能自动核验恢复')
    state = {'owner':owner,'taskId':row.run_id}
    payload = {**state, 'collectorRunId':scope.collector_run_id,'textbookId':scope.external_textbook_id,
               'catalogId':match[1], 'pageNumber':int(match[2])}
    name = scope.textbook_name_snapshot
    count = row.question_count
    await db.rollback()
    result = await call('open', payload)
    # A reopened own session must still refer to the server-selected task.
    state['taskId'] = result['taskId']
    return state, {**result,'textbookName':name,'savedCount':count}


async def _open_discovery(db, subject_id, owner, source):
    """Textbook discovery blocked by source protection (R07).

    The browser re-checks the discovery request itself, not a question page;
    finishing only lets the plan run discovery again, it never lifts a pause
    the user set.
    """
    row = await db.scalar(select(QbSyncJob).where(
        QbSyncJob.task_module == 'textbook', QbSyncJob.status.in_(('blocked', 'failed')),
        QbSyncJob.error_message == source.get('reason'),
        or_(QbSyncJob.subject_id == subject_id, QbSyncJob.subject_id.is_(None)),
    ).order_by(QbSyncJob.run_id.desc()).limit(1))
    if row is None:
        raise ServiceException(message='没有匹配的题目列表或教材发现阻断任务，无法确定要复核的请求')
    state = {'owner': owner, 'taskId': row.run_id, 'kind': 'discovery'}
    collector_job_id = row.collector_job_id
    if not collector_job_id:
        raise ServiceException(message='旧发现任务缺少采集执行关联，无法确定原失败请求，请重新执行教材发现')
    # Only a plain read happened here (no row locks), so nothing is held
    # across the Collector call.
    result = await call('open', {**state, 'collectorJobId': collector_job_id})
    return state, {**result, 'textbookName': '教材清单发现', 'savedCount': 0}


async def _finish_discovery(db, payload, state):
    from plugins.bank.entity.do.bank_do import QbSyncPlan
    from plugins.bank.service.incremental_import import _clock
    now = await _clock(db)
    task = await db.get(QbSyncJob, state['taskId'], with_for_update=True)
    if task and task.status in ('blocked', 'failed') and task.active_slot is None:
        # Verification can finish before the dispatcher releases the failed
        # discovery's reservation. The new attempt must not deduplicate to it.
        task.dispatch_book_key = None
        task.worker_token = None
    plans = (await db.scalars(select(QbSyncPlan).where(
        or_(QbSyncPlan.discovery_task_id == state['taskId'],
            (QbSyncPlan.discovery_task_id.is_(None)) &
            (QbSyncPlan.discovery_processed_task_id == state['taskId']))).with_for_update())).all()
    for plan in plans:
        # Discovery runs again on the next tick; a plan the user paused stays paused.
        if plan.discovery_task_id == state['taskId']:
            plan.discovery_processed_task_id = state['taskId']
            plan.discovery_task_id = None
        plan.discovery_error = None
        plan.discovery_next_at = now
    await db.commit()
    await call('finish', payload)
    return {'taskId': state['taskId'], 'message': '浏览器已交回，教材发现将重新执行，来源队列已恢复'}


async def finish_browser(db, session_id, state, operator):
    from plugins.bank.service.task_service import SyncTaskService
    payload = {'sessionId':session_id,'owner':state['owner']}
    await call('validate', payload)
    if state.get('kind') == 'discovery':
        return await _finish_discovery(db, payload, state)
    row = await db.get(QbSyncJob, state['taskId'])
    scope = await db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id == row.run_id))
    options = row.options_json or {}
    inherited = {k:v for k,v in options.items() if k in
                 ('autoPlanId','autoPlanName','autoCycleNo','autoCycleName','manualPlanId','manualSingle','supplementId',
                  'syncMode','allowWhilePlanPaused')}
    # A full scan resumes as a full scan; incremental stays incremental (R08).
    inherited['syncMode'] = options.get('syncMode') or 'incremental'
    inherited.update(manualDispatchRequested=True, resumeFirst=True)
    # Source remains paused while the durable refill is queued. Closing the
    # browser and clearing source pause is the final step.
    result = await SyncTaskService.create_question(db, {'versionId':scope.local_version_id,
        'textbookId':scope.local_textbook_id,'listConcurrency':options.get('listConcurrency',8),
        'limitTo1000Pages':bool(options.get('limitTo1000Pages'))},operator,
        automatic_options=inherited,resume_task_id=row.run_id)
    task_id = result.get('taskId') or result['runId']
    queued = await db.get(QbSyncJob, task_id)
    queued.dispatch_priority = (await db.scalar(select(func.max(QbSyncJob.dispatch_priority))) or 0)+1
    await db.commit()
    await call('finish',payload)
    return {'taskId':task_id, 'message':'浏览器已交回，补采已优先排队，来源队列已恢复'}
