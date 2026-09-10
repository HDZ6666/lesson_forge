"""Disposable UI projections. Never use this cache for task ownership or apply."""

from __future__ import annotations

import asyncio
import json
import time
from collections import OrderedDict
from typing import TYPE_CHECKING, Any

from redis.asyncio import Redis

from config.env import RedisConfig

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

TTL = 15
MAX_BYTES = 4 * 1024 * 1024
MAX_ENTRIES = 16
_local: OrderedDict[str, tuple[float, str]] = OrderedDict()
_client = None
_retry_at = 0.0
_inflight: dict[str, asyncio.Task] = {}


def _redis() -> Redis:
    global _client  # noqa: PLW0603 - one pool per service process
    if _client is None:
        _client = Redis(
            host=RedisConfig.redis_host,
            port=RedisConfig.redis_port,
            username=RedisConfig.redis_username or None,
            password=RedisConfig.redis_password or None,
            db=RedisConfig.redis_database,
            decode_responses=True,
            socket_connect_timeout=0.2,
            socket_timeout=0.2,
        )
    return _client


async def _command(method: str, *args: Any, **kwargs: Any) -> Any:
    global _retry_at  # noqa: PLW0603 - Redis outage circuit breaker
    if time.monotonic() < _retry_at:
        return None
    try:
        return await getattr(_redis(), method)(*args, **kwargs)
    except Exception:
        _retry_at = time.monotonic() + 15
        return None


def _remember(key: str, encoded: str) -> None:
    _local[key] = (time.monotonic() + 3, encoded)
    _local.move_to_end(key)
    while len(_local) > MAX_ENTRIES:
        _local.popitem(last=False)


async def put(key: str, value: Any, *, ttl: int = TTL) -> bool:
    encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if len(encoded.encode()) > MAX_BYTES:
        return False
    _remember(key, encoded)
    await _command('set', key, encoded, ex=ttl)
    return True


async def get(key: str) -> Any:
    cached = _local.get(key)
    if cached and cached[0] > time.monotonic():
        return json.loads(cached[1])
    encoded = await _command('get', key)
    if encoded:
        try:
            value = json.loads(encoded)
            _remember(key, encoded)
            return value
        except (ValueError, TypeError):
            pass
    return None


async def get_or_load(key: str, loader: Callable[[], Awaitable[Any]], *, ttl: int = TTL) -> Any:
    cached = await get(key)
    if cached is not None:
        return cached
    if key not in _inflight:

        async def fetch() -> Any:
            try:
                value = await loader()
                if value is not None:
                    await put(key, value, ttl=ttl)
                return value
            finally:
                _inflight.pop(key, None)

        _inflight[key] = asyncio.create_task(fetch())
    return await asyncio.shield(_inflight[key])


async def close() -> None:
    global _client  # noqa: PLW0603 - release the process-owned pool
    pending = list(_inflight.values())
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    if _client is not None:
        await _client.aclose()
        _client = None
    _local.clear()
