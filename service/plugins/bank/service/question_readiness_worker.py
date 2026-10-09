"""Durable, bounded background backfill of legacy stem facts."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import load_only

from config.database import DataSourceRegistry
from plugins.bank.entity.do.bank_do import QbQuestion, QbQuestionReadinessSweep
from plugins.bank.service.incremental_import import _clock
from plugins.bank.service.question_apply_service import _asset_root
from plugins.bank.service.question_readiness import (
    QUESTION_COLUMNS,
    asset_payload,
    check_question,
    fetch_required_assets,
    question_payload,
    store_proofs,
)
from plugins.bank.service.source_write_lock import SourceWriteBusy, source_write_lock
from utils.log_util import logger

PAGE_SIZE = 25
POLL_SECONDS = 30
LEASE_SECONDS = 300
_WORKER_TASK: asyncio.Task | None = None


async def check_readiness_once(*, session_factory=None, root: Path | None = None, after_prepare=None):
    """One keyset page; no connection or writer lock spans file checks.

    The cursor is committed with the derived facts. Cancelled workers leave
    an expiring lease; stale owners cannot overwrite a successor's work.
    """
    session_factory = session_factory or DataSourceRegistry.session
    async with session_factory() as db:
        async with source_write_lock(db):
            now = await _clock(db)
            sweep = await db.get(QbQuestionReadinessSweep, 1, with_for_update=True, populate_existing=True)
            if sweep is None:
                sweep = QbQuestionReadinessSweep(sweep_id=1, last_question_id=0)
                db.add(sweep)
            if sweep.lease_until and sweep.lease_until > now or sweep.next_check_at and sweep.next_check_at > now:
                return {'status': 'waiting', 'checked': 0}
            token, cursor = uuid4().hex, sweep.last_question_id
            sweep.worker_token = token
            sweep.lease_until = now + timedelta(seconds=LEASE_SECONDS)
            await db.commit()
    async with session_factory() as db:
        rows = (
            await db.scalars(
                select(QbQuestion)
                .options(load_only(*(getattr(QbQuestion, key) for key in QUESTION_COLUMNS)))
                .where(QbQuestion.question_id > cursor)
                .order_by(QbQuestion.question_id)
                .limit(PAGE_SIZE)
            )
        ).all()
        payloads = [question_payload(row) for row in rows]
        assets = [asset_payload(row) for row in await fetch_required_assets(db, payloads)]
    # Rechecking each cycle also detects out-of-band file loss. The keyset
    # cursor bounds both DB reads and disk work independently of total size.
    proofs = await asyncio.to_thread(
        lambda: [
            check_question(
                q,
                [a for a in assets if a['question_id'] == q['question_id']],
                root or _asset_root(),
            )
            for q in payloads
        ]
    )
    if after_prepare:
        await after_prepare()
    async with session_factory() as db:
        async with source_write_lock(db):
            now = await _clock(db)
            sweep = await db.get(QbQuestionReadinessSweep, 1, with_for_update=True, populate_existing=True)
            if (
                sweep.worker_token != token
                or not sweep.lease_until
                or sweep.lease_until <= now
                or sweep.last_question_id != cursor
            ):
                return {'status': 'superseded', 'checked': 0}
            ids = [q['question_id'] for q in payloads]
            current = (
                await db.scalars(
                    select(QbQuestion)
                    .options(load_only(*(getattr(QbQuestion, key) for key in QUESTION_COLUMNS)))
                    .where(QbQuestion.question_id.in_(ids))
                    .with_for_update()
                    .execution_options(populate_existing=True)
                )
            ).all()
            current_assets = await fetch_required_assets(db, [question_payload(row) for row in current], lock=True)
            count = await store_proofs(db, current, current_assets, proofs)
            sweep.last_question_id = payloads[-1]['question_id'] if payloads else 0
            sweep.worker_token = None
            sweep.lease_until = None
            sweep.next_check_at = now + timedelta(seconds=POLL_SECONDS if payloads else 300)
            await db.commit()
            return {
                'status': 'checked' if payloads else 'cycle_complete',
                'checked': len(count),
                'lastQuestionId': sweep.last_question_id,
            }


async def recheck_questions(question_ids: list[int], *, session_factory=None, root: Path | None = None):
    """Action-time verification for later selection/replacement/export wiring.

    Return explicit affected IDs; callers must refuse missing/changed items,
    never substitute another question. No filesystem work in a transaction.
    """
    if not question_ids or len(question_ids) > 100 or any(type(q) is not int or q <= 0 for q in question_ids):
        raise ValueError('readiness recheck requires 1..100 question IDs')
    session_factory = session_factory or DataSourceRegistry.session
    async with session_factory() as db:
        payloads = [
            question_payload(row)
            for row in (
                await db.scalars(
                    select(QbQuestion)
                    .options(load_only(*(getattr(QbQuestion, key) for key in QUESTION_COLUMNS)))
                    .where(QbQuestion.question_id.in_(question_ids))
                )
            ).all()
        ]
        assets = [asset_payload(row) for row in await fetch_required_assets(db, payloads)]
    proofs = await asyncio.to_thread(
        lambda: [
            check_question(
                q,
                [a for a in assets if a['question_id'] == q['question_id']],
                root or _asset_root(),
            )
            for q in payloads
        ]
    )
    async with session_factory() as db:
        async with source_write_lock(db):
            rows = (
                await db.scalars(
                    select(QbQuestion)
                    .options(load_only(*(getattr(QbQuestion, key) for key in QUESTION_COLUMNS)))
                    .where(QbQuestion.question_id.in_(question_ids))
                    .with_for_update()
                )
            ).all()
            actual_assets = await fetch_required_assets(db, [question_payload(row) for row in rows], lock=True)
            # Store returns the successfully CAS-matched proof IDs as cache
            # rows; changed or removed questions are reported explicitly.
            matched = await store_proofs(db, rows, actual_assets, proofs)
            await db.flush()
            from plugins.bank.service.question_readiness import usable_predicate

            ready = set(
                (
                    await db.scalars(
                        select(QbQuestion.question_id).where(
                            QbQuestion.question_id.in_(matched),
                            usable_predicate(),
                        )
                    )
                ).all()
            )
            await db.commit()
    return {'readyQuestionIds': sorted(ready), 'affectedQuestionIds': sorted(set(question_ids) - ready)}


async def _run():
    while True:
        try:
            await check_readiness_once()
        except asyncio.CancelledError:
            raise
        except SourceWriteBusy:
            pass  # Formal writes have priority; the lease is recoverable.
        except Exception as exc:
            logger.warning(f'题干检查回填暂不可用，类型 {type(exc).__name__}')
        await asyncio.sleep(POLL_SECONDS)


def start_question_readiness_worker():
    global _WORKER_TASK
    if _WORKER_TASK is None or _WORKER_TASK.done():
        _WORKER_TASK = asyncio.create_task(_run(), name='bank-question-readiness-worker')


async def stop_question_readiness_worker():
    global _WORKER_TASK
    if _WORKER_TASK is not None:
        _WORKER_TASK.cancel()
        await asyncio.gather(_WORKER_TASK, return_exceptions=True)
        _WORKER_TASK = None
