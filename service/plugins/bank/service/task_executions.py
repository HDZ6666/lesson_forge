"""Logical textbook tasks, backed by immutable per-execution job records."""
from sqlalchemy import func, select

from plugins.bank.entity.do.bank_do import QbSyncJob


def root_id(row):
    return row.logical_task_id or row.run_id


async def rows_for(db, roots):
    if not roots:
        return []
    return list((await db.scalars(select(QbSyncJob).where(
        QbSyncJob.task_module == 'question',
        func.coalesce(QbSyncJob.logical_task_id, QbSyncJob.run_id).in_(roots),
    ).order_by(QbSyncJob.run_id))).all())


async def attach_summary(db, payloads):
    roots = [p['logicalTaskId'] for p in payloads]
    if not roots:
        return
    group = func.coalesce(QbSyncJob.logical_task_id, QbSyncJob.run_id)
    rows = (await db.execute(select(group, func.count(QbSyncJob.started_at), func.count(),
        func.max(QbSyncJob.run_id), func.max(QbSyncJob.started_at)).where(
        QbSyncJob.task_module == 'question', group.in_(roots)).group_by(group))).all()
    groups = {r[0]: r for r in rows}
    for payload in payloads:
        result = groups.get(payload['logicalTaskId'])
        if result:
            _, count, records, latest, started = result
            payload.update(executionCount=count, executionRecordCount=records,
                           latestExecutionId=latest, lastExecutionAt=started)


async def history(db, task_id):
    from exceptions.exception import ServiceException
    from plugins.bank.service.task_service import _attach_page_import_progress, task_payload
    row = await db.get(QbSyncJob, task_id)
    if row is None or row.task_module != 'question':
        raise ServiceException(message='同步题库任务不存在')
    rows = await rows_for(db, [root_id(row)])
    items = []
    number = 0
    for execution in rows:
        number += int(execution.started_at is not None)
        item = task_payload(execution)
        item['executionNumber'] = number if execution.started_at else None
        items.append(item)
    await _attach_page_import_progress(db, items)
    return {'logicalTaskId': root_id(row), 'executionCount': number,
            'latestExecutionId': rows[-1].run_id, 'rows': list(reversed(items))}
