"""One persisted public wait for host resources instead of a requeue loop.

Before this, every poll claimed an import, found the host short of memory or
disk, and put it back: queued -> preparing -> queued every three seconds and
tens of thousands of ``import_deferred`` events for one real condition.

Now the dispatcher asks this gate first. While resources are short no import
or intake is claimed, the wait is written once (reason, since, next check)
to ``qb_sync_control.resource_wait_json``, checks back off up to a bounded
interval, and recovery is only declared after it has held for a while.
"""

from __future__ import annotations

import os
import time
from datetime import timedelta
from typing import Any

from plugins.bank.service import diagnostics
from plugins.bank.service.resource_guard import ResourcePressure, assert_import_resources


def _seconds(name: str, default: int) -> int:
    raw = os.getenv(name, '').strip()
    return int(raw) if raw.isdigit() else default


class ResourceWait:
    def __init__(self) -> None:
        self.reason: str | None = None
        self.since: float | None = None
        self.recovering_since: float | None = None
        self.next_check: float = 0.0
        self.interval: float = 0.0
        self.checks = 0

    @property
    def waiting(self) -> bool:
        return self.reason is not None

    def reset(self) -> None:
        self.__init__()

    async def allow(self, session_factory: Any, *, root=None, check=None, clock=time.monotonic) -> bool:
        """True when heavy import work may be claimed now."""
        now = clock()
        if self.waiting and now < self.next_check:
            return False
        check = check or (lambda: assert_import_resources(root=root))
        base = _seconds('BANK_RESOURCE_WAIT_MIN_SECONDS', 3)
        ceiling = _seconds('BANK_RESOURCE_WAIT_MAX_SECONDS', 300)
        stable = _seconds('BANK_RESOURCE_RECOVERY_STABLE_SECONDS', 30)
        try:
            check()
        except ResourcePressure as exc:
            self.checks += 1
            self.recovering_since = None
            changed = exc.message != self.reason
            entered = not self.waiting
            if entered or changed:
                self.reason = exc.message
                self.since = self.since if not entered else now
                self.interval = base
                diagnostics.event('resource_wait_entered' if entered else 'resource_wait_changed', reason=exc.message)
            else:
                self.interval = min(ceiling, max(base, self.interval * 2))
            self.next_check = now + self.interval
            # Every failed check is persisted so the page and the monitor read
            # the real next check and count; the backoff bounds these writes.
            await self._persist(session_factory, waiting=True, announce=entered or changed)
            return False
        if not self.waiting:
            return True
        # A single good sample is not a lasting recovery.
        if self.recovering_since is None:
            self.recovering_since = now
            self.checks += 1
            self.interval = stable
            await self._persist(session_factory, waiting=True, recovering=True)
        if now - self.recovering_since < stable:
            self.next_check = now + min(base, stable)
            return False
        diagnostics.event('resource_wait_recovered', reason=self.reason,
                          waitedSeconds=round(now - (self.since or now)), checks=self.checks)
        await self._persist(session_factory, waiting=False)
        self.reset()
        return True

    async def _persist(self, session_factory: Any, *, waiting: bool, announce: bool = False,
                       recovering: bool = False) -> None:
        if session_factory is None:
            return
        from sqlalchemy import update

        from plugins.bank.entity.do.bank_do import QbQuestionImport, QbSyncControl
        from plugins.bank.service.import_dates import utc_datetime
        from plugins.bank.service.incremental_import import _clock
        try:
            async with session_factory() as db:
                row = await db.get(QbSyncControl, 1, with_for_update=True)
                now = await _clock(db)
                if row is None:
                    row = QbSyncControl(control_id=1, paused=0, revision=1, issue_cursor=0, update_time=now)
                    db.add(row)
                previous = row.resource_wait_json or {}
                if waiting:
                    if announce:
                        # Queued imports show the one stable reason they wait on.
                        await db.execute(update(QbQuestionImport).where(QbQuestionImport.status == 'queued')
                                         .values(error_message=str(self.reason)[:2000]))
                    since = previous.get('since') if previous.get('active') else utc_datetime(now).isoformat()
                    row.resource_wait_json = {
                        'active': True, 'scope': 'server', 'reason': self.reason, 'since': since,
                        'nextCheckAt': utc_datetime(now + timedelta(seconds=self.interval)).isoformat(),
                        'checks': self.checks, 'lastCheckAt': utc_datetime(now).isoformat(),
                        'intervalSeconds': round(self.interval), 'recovering': recovering,
                    }
                else:
                    row.resource_wait_json = {**previous, 'active': False,
                                              'recoveredAt': utc_datetime(now).isoformat(), 'checks': self.checks}
                await db.commit()
        except Exception as exc:  # A diagnostics write must never stop the worker.
            diagnostics.event('resource_wait_persist_failed', errorType=type(exc).__name__)


IMPORT_RESOURCE_WAIT = ResourceWait()
