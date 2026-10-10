"""Resolve and freeze per-task pagination settings without source requests."""
import hashlib
import json
import os

from sqlalchemy import select

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbSyncJob, QbSyncPlan


def server_default():
    value = int(os.getenv('BANK_DEFAULT_LIST_CONCURRENCY', '1'))
    if not 1 <= value <= 16:
        raise ServiceException(message='服务器题目分页并发配置无效')
    return value


async def resolve(db, subject_id, override=None):
    plan = await db.scalar(select(QbSyncPlan).where(QbSyncPlan.subject_id == subject_id))
    inherited = plan.list_concurrency if plan else server_default()
    return {
        'listConcurrency': override if override is not None else inherited,
        'concurrencySource': 'task' if override is not None else 'plan' if plan else 'server',
        'inheritedConcurrency': inherited,
    }


def snapshot(options):
    return {k: options[k] for k in ('listConcurrency', 'concurrencySource', 'inheritedConcurrency') if k in options}


def token(options):
    return hashlib.sha256(json.dumps(snapshot(options), sort_keys=True).encode()).hexdigest()


async def update_waiting(db, task_id, payload):
    row = await db.get(QbSyncJob, task_id, with_for_update=True, populate_existing=True)
    if row is None or row.task_module != 'question':
        raise ServiceException(message='教材同步任务不存在')
    if row.status != 'queued' or row.active_slot is not None or row.collector_job_id or not row.dispatch_job_id:
        raise ServiceException(message='仅排队中且尚未派发的任务可修改并发；执行中的任务请停止后重跑')
    options = dict(row.options_json or {})
    if payload.expected_token != token(options):
        raise ServiceException(message='任务并发设置已变化，请刷新后重试')
    options.update(await resolve(db, row.subject_id, payload.list_concurrency))
    row.options_json = options
    await db.commit()
    return {'taskId': task_id, **snapshot(options), 'concurrencyToken': token(options)}
