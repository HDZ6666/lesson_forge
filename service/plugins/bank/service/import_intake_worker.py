"""Recover terminal runs and probe bounded headers outside database locks."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from config.database import DataSourceRegistry
from exceptions.exception import ServiceException
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.import_intake import (
    claim_import_intake,
    complete_import_intake,
    defer_plan_intake,
    due_import_intake_ids,
    fail_import_intake,
    register_import_intake,
    unregistered_terminal_scope_ids,
)
from plugins.bank.service.plan_work import PlanWorkPaused
from plugins.bank.service.question_apply_service import _normalise_snapshot_summary, _summary_payload
from utils.log_util import logger

PROBE_TIMEOUT_SECONDS = 8


async def register_task_intake(task_id: int, *, session_factory: Any = None):
    from sqlalchemy import select

    from plugins.bank.entity.do.bank_do import QbSyncJobScope

    factory = session_factory or DataSourceRegistry.session
    async with factory() as db:
        scopes = list((await db.scalars(select(QbSyncJobScope.scope_id).where(
            QbSyncJobScope.run_id == task_id,
        ))).all())
    if len(scopes) == 1:
        async with factory() as db:
            await register_import_intake(db, scopes[0])


async def recover_import_intakes(*, session_factory: Any = None):
    factory = session_factory or DataSourceRegistry.session
    async with factory() as db:
        scopes = await unregistered_terminal_scope_ids(db)
    for scope_id in scopes:
        try:
            async with factory() as db:
                await register_import_intake(db, scope_id)
        except ServiceException:
            # A changed binding or disabled source must not stop other books.
            continue


async def _record_failure(factory: Any, ticket: dict[str, Any], kind: str, message: str, *, retryable: bool):
    try:
        async with factory() as db:
            await fail_import_intake(db, ticket, kind, message, retryable=retryable)
    except ServiceException:
        pass  # An expired probe cannot overwrite a successor's result.


async def dispatch_import_intakes_once(*, session_factory: Any = None, client: Any = None):
    factory = session_factory or DataSourceRegistry.session
    await recover_import_intakes(session_factory=factory)
    async with factory() as db:
        ids = await due_import_intake_ids(db)
    for intake_id in ids:
        try:
            async with factory() as db:
                ticket = await claim_import_intake(db, intake_id)
        except ServiceException:
            continue
        if ticket is None:
            continue
        try:
            # Only read the configured Collector, never crawl a source here.
            # A dedicated client bounds each probe without changing import
            # page/asset budgets on the other worker's client.
            probe = client or CollectorClient()
            if client is None:
                probe.timeout = min(probe.timeout, 5)
                probe.max_response_bytes = min(probe.max_response_bytes, 256 * 1024)
            raw = await asyncio.wait_for(
                asyncio.to_thread(
                    probe.run_snapshot_summary, ticket['collectorRunId'],
                    textbook_external_id=ticket['textbookExternalId'], sealed_for_import=True,
                ), timeout=PROBE_TIMEOUT_SECONDS,
            )
        except asyncio.CancelledError:
            raise  # Leave the persisted lease for takeover after shutdown.
        except Exception as exc:
            message = exc.message if isinstance(exc, ServiceException) else '采集服务摘要暂不可用'
            await _record_failure(factory, ticket, 'collector', message, retryable=True)
            continue
        try:
            summary = _normalise_snapshot_summary(
                raw, ticket['taskId'], ticket['textbookExternalId'], sealed_for_import=True,
            )
        except ServiceException as exc:
            payload = _summary_payload(raw) if isinstance(raw, Mapping) else {}
            retryable = payload.get('available') is not True or payload.get('immutable') is not True
            await _record_failure(factory, ticket, 'snapshot', exc.message, retryable=retryable)
            continue
        try:
            async with factory() as db:
                await complete_import_intake(db, ticket, summary)
        except PlanWorkPaused:
            async with factory() as db:
                await defer_plan_intake(db,ticket)
        except ServiceException as exc:
            await _record_failure(factory, ticket, 'identity', exc.message, retryable=False)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Commit failure rolls back both the final counts and import ID.
            # An uncertain committed outcome is safe: a ready row rejects the
            # failure report and registration cannot create a second import.
            await _record_failure(factory, ticket, 'database', '入库提交暂不可用，请稍后重试核验', retryable=True)
            logger.warning(f'封存核验 {intake_id} 提交异常，类型 {type(exc).__name__}')
