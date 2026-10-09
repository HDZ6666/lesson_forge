"""Bounded host checks for new collection and incremental import work."""

from __future__ import annotations

import os
import re
import shutil
import time
from pathlib import Path

import psutil

from exceptions.exception import ServiceException

MIB = 1024 * 1024
_CACHE: tuple[tuple, float, dict] | None = None


class ResourcePressure(ServiceException):
    """Transient host pressure must requeue work without losing checkpoints."""


def configured_limit(name: str) -> int:
    raw = os.getenv(name, '').strip()
    if not raw:
        return 0
    if not re.fullmatch(r'\d{1,12}', raw):
        raise ServiceException(message=f'{name} 必须是非负整数，0 表示未配置保护上限')
    return int(raw)


def available_memory() -> int:
    available = int(psutil.virtual_memory().available)
    if available < 0:
        raise ValueError('Unknown available memory')
    for limit_path, used_path in (
        ('/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'),
        ('/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'),
    ):
        try:
            limit = int(Path(limit_path).read_text().strip())
            used = int(Path(used_path).read_text().strip())
            if 0 < limit < 2**53 and used >= 0:
                available = min(available, max(0, limit - used))
        except (OSError, ValueError):
            pass
    return available


def available_disk(path: Path) -> int:
    target = path.absolute()
    while not target.exists():
        if target.parent == target:
            raise OSError('No existing storage parent')
        target = target.parent
    return shutil.disk_usage(target).free


def resource_status(*, root: Path | None = None, fresh: bool = False) -> dict:
    global _CACHE
    if root is None:
        from plugins.bank.service.question_apply_service import _asset_root

        root = _asset_root()
    minimum_disk = configured_limit('BANK_MIN_DISK_FREE_MIB')
    minimum_memory = configured_limit('BANK_MIN_MEMORY_FREE_MIB')
    key = (str(root), minimum_disk, minimum_memory)
    now = time.monotonic()
    if not fresh and _CACHE and _CACHE[0] == key and 0 <= now - _CACHE[1] < 1:
        return dict(_CACHE[2])
    reasons = []
    disk = memory = None
    try:
        free_disk = available_disk(root)
        if free_disk < 0:
            raise ValueError('Unknown available storage')
        disk = free_disk // MIB
        if disk < minimum_disk:
            reasons.append('题库存储可用空间低于保留水位，等待空间恢复')
    except (OSError, ValueError):
        if minimum_disk:
            reasons.append('无法确认题库存储可用空间，暂缓后台工作')
    try:
        memory = available_memory() // MIB
        if memory < minimum_memory:
            reasons.append('后端主机可用内存低于保留水位，等待内存恢复')
    except (OSError, ValueError):
        if minimum_memory:
            reasons.append('无法确认后端主机可用内存，暂缓后台工作')
    state = {
        'paused': bool(reasons), 'reason': '；'.join(reasons) or None,
        'freeDiskMiB': disk, 'availableMemoryMiB': memory,
        'minDiskMiB': minimum_disk, 'minMemoryMiB': minimum_memory,
        'diskAndMemoryLimitsConfigured': minimum_disk > 0 and minimum_memory > 0,
    }
    _CACHE = (key, now, state)
    return dict(state)


def assert_resources(*, root: Path | None = None) -> None:
    try:
        state = resource_status(root=root)
    except ServiceException as exc:
        # An invalid operator limit must pause work, never permanently fail
        # a valid import or silently run without its intended protection.
        raise ResourcePressure(message=exc.message) from exc
    if state['paused']:
        raise ResourcePressure(message=state['reason'])
