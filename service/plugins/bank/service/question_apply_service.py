"""Apply immutable collector question snapshots to the formal bank tables.

The collector owns the five immutable snapshot tables.  This service owns the
scope state/history and the single transaction that projects a completed
question task into the seven formal tables.  Formal question identities are
provider + external ID; textbook scope is carried by catalog ownership and is
therefore never used to delete or disable data outside the selected scope.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import mimetypes
import os
import re
import secrets
import tempfile
import urllib.parse
from collections.abc import Mapping
from contextlib import AsyncExitStack
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from exceptions.exception import ServiceException
from plugins.bank.dao.question_apply_dao import QuestionApplyDao
from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbQuestionApplyHistory,
    QbQuestionApplyState,
    QbQuestionAsset,
    QbQuestionCatalog,
    QbQuestionTag,
    QbSyncJob,
    QbSyncJobScope,
    QbTextbook,
)
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.snapshot_content import validate_list_content
from plugins.bank.service.source_write_lock import source_write_lock

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


PROVIDER = 'zujuan'
MAX_SNAPSHOT_ROWS = 100_000
MAX_EXTERNAL_ID_LENGTH = 64
MAX_TAG_RELATION_LENGTH = 120
CONTROL_CHAR_LIMIT = 32
MYSQL_TABLE_NOT_FOUND = 1146
SAFE_EXTERNAL_ID_CHARS = frozenset('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-')
SNAPSHOT_COUNT_FIELDS: dict[str, tuple[str, ...]] = {
    'catalogs': ('catalogItemCount', 'catalog_item_count', 'catalogCount', 'catalog_count', 'catalogsCount'),
    'questions': ('questionItemCount', 'question_item_count', 'questionCount', 'question_count', 'questionsCount'),
    'questionCatalogs': (
        'questionCatalogCount',
        'question_catalog_count',
        'questionCatalogsCount',
        'relationCount',
        'relation_count',
    ),
    'tags': ('questionTagCount', 'question_tag_count', 'tagCount', 'tag_count', 'tagsCount'),
    'assets': ('questionAssetCount', 'question_asset_count', 'assetCount', 'asset_count', 'assetsCount'),
}


def _pick(value: Mapping[str, Any] | object, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(value, Mapping):
            if name in value:
                return value[name]
        elif hasattr(value, name):
            return getattr(value, name)
    return default


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode('utf-8', errors='replace')
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_jsonable(item) for item in value]
    return str(value)


def _canonical_hash(value: Any) -> str:
    payload = json.dumps(_jsonable(value), ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def _safe_external_id(value: Any) -> bool:
    text = str(value or '').strip()
    return bool(text) and len(text) <= MAX_EXTERNAL_ID_LENGTH and all(char in SAFE_EXTERNAL_ID_CHARS for char in text)


def _as_bool(value: Any) -> bool:
    """Parse booleans emitted by the collector JSON contract and older builds."""

    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value or '').strip().lower()
    return text in {'1', 'true', 'yes', 'y', 'on', 'complete', 'completed', 'success', 'locked'}


_PUBLIC_ANSWER_STATUSES = frozenset(
    {
        'public',
        'public_captured',
        'public-captured',
        'published',
        'visible',
        'available',
        'open',
        '公开',
        '已公开',
        '公开采集',
    }
)

# Collector snapshots use capture-oriented status names while the formal
# question table uses the stable dictionary values seeded by the bank schema.
# Keep the conversion at the snapshot boundary so neither comparison output
# nor a formal write can leak a collector-only enum into the application.
_ANSWER_STATUS_MAP = {
    'public_captured': 'available',
    'public-captured': 'available',
    'public': 'available',
    'published': 'available',
    'visible': 'available',
    'available': 'available',
    'open': 'available',
    '公开': 'available',
    '已公开': 'available',
    '公开采集': 'available',
    'login_required': 'restricted',
    'login-required': 'restricted',
    'restricted': 'restricted',
    '需要登录': 'restricted',
    'not_visible': 'not_provided',
    'not-visible': 'not_provided',
    'not_provided': 'not_provided',
    'not-provided': 'not_provided',
    '不可见': 'not_provided',
    'not_collected': 'unknown',
    'not-collected': 'unknown',
    'unknown': 'unknown',
}


def _normalise_answer_status(value: Any) -> str:
    """Map collector answer status values to the formal bank dictionary."""

    normalized = str(value or '').strip().lower()
    return _ANSWER_STATUS_MAP.get(normalized, 'unknown')


def _answer_is_unknown(item: Mapping[str, Any]) -> bool:
    """Return whether a snapshot has no trusted answer evidence.

    The normalizer maps both ``not_collected`` and ``unknown`` to the formal
    ``unknown`` value.  Keep this check at the apply boundary as well so a
    manually assembled/older normalized snapshot cannot accidentally clear a
    previously captured answer.
    """

    return _normalise_answer_status(_pick(item, 'answer_status', 'answerStatus')) == 'unknown'


def _answer_is_public(value: Any) -> bool:
    """Return whether a collector explicitly proved public solutions."""

    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    return str(value or '').strip().lower() in _PUBLIC_ANSWER_STATUSES


def _lock_present(value: Any) -> bool:
    """Accept a timestamp lock while rejecting explicit false markers."""

    if value is None or value is False or value == 0:
        return False
    if isinstance(value, str):
        text = value.strip().lower()
        return bool(text) and text not in {'0', 'false', 'no', 'n', 'off', 'null', 'none'}
    return bool(value)


def _safe_storage_path(value: Any) -> str | None:
    if value in (None, ''):
        return None
    text = str(value).strip().replace('\\', '/')
    if not text or text.startswith('/') or ':' in text.split('/', 1)[0]:
        return None
    parts = [part for part in text.split('/') if part not in ('', '.')]
    if any(part == '..' or any(ord(char) < CONTROL_CHAR_LIMIT for char in part) for part in parts):
        return None
    return '/'.join(parts)[:1000] or None


ASSET_SHA256_LENGTH = 64
_ASSET_SHA256_RE = re.compile(r'^[0-9a-f]{64}$')
_ASSET_EXT_RE = re.compile(r'^[a-z0-9]{1,12}$')
_ASSET_CACHE_MAX_BYTES = 64 * 1024 * 1024
ASSET_DOWNLOAD_CONCURRENCY = 8


def _asset_byte_size(row: Mapping[str, Any]) -> int | None:
    """Return the collector-declared byte size, when present and valid."""

    value = _pick(
        row,
        'byte_size',
        'byteSize',
        'content_length',
        'contentLength',
        'file_size',
        'fileSize',
        'size',
    )
    if value in (None, ''):
        return None
    if isinstance(value, bool):
        raise ServiceException(message='题库素材大小必须是非负整数')
    if isinstance(value, float) and not value.is_integer():
        raise ServiceException(message='题库素材大小必须是非负整数')
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ServiceException(message='题库素材大小必须是非负整数') from exc
    if parsed < 0 or parsed > _ASSET_CACHE_MAX_BYTES:
        raise ServiceException(message='题库素材大小超出安全上限')
    return parsed


def _asset_extension(row: Mapping[str, Any]) -> str:
    """Choose a harmless extension for the service-owned content-addressed file."""

    candidates = (
        _pick(row, 'file_name', 'fileName'),
        _pick(row, 'source_url', 'sourceUrl', 'url'),
        _pick(row, 'mime_type', 'mimeType'),
    )
    for candidate in candidates:
        text = str(candidate or '').strip()
        if not text:
            continue
        if '/' in text or '?' in text or '#' in text:
            text = urllib.parse.urlsplit(text).path
        suffix = Path(text).suffix.rsplit('.', 1)[-1].lower() if '.' in Path(text).name else ''
        if _ASSET_EXT_RE.fullmatch(suffix):
            return f'.{suffix}'
        guessed = mimetypes.guess_extension(text.lower()) if '/' in text else None
        if guessed:
            guessed = guessed.rsplit('.', 1)[-1].lower()
            if _ASSET_EXT_RE.fullmatch(guessed):
                return f'.{guessed}'
    return '.bin'


def _asset_relative_path(file_hash: str, row: Mapping[str, Any]) -> str:
    """Build the only storage layout accepted for downloaded collector assets."""

    digest = str(file_hash or '').strip().lower()
    if not _ASSET_SHA256_RE.fullmatch(digest):
        raise ServiceException(message='题库素材内容摘要无效')
    path = f'assets/{digest[:2]}/{digest}{_asset_extension(row)}'
    safe = _safe_storage_path(path)
    if safe is None:
        raise ServiceException(message='题库素材存储路径不合法')
    return safe


def _asset_root() -> Path:
    configured = str(os.environ.get('BANK_ASSET_ROOT', 'data/bank') or '').strip()
    if not configured:
        configured = 'data/bank'
    return Path(configured).expanduser().resolve()


def _path_inside(root: Path, candidate: Path) -> Path:
    """Resolve a path and require it to remain below the service asset root."""

    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ServiceException(message='题库素材路径不合法') from exc
    return resolved


def _valid_cached_asset(root: Path, digest: str, expected_size: int | None, preferred_path: str | None = None) -> Path | None:
    """Find a previously downloaded file with the requested content hash."""

    try:
        directory = _path_inside(root, root / 'assets' / digest[:2])
    except ServiceException:
        # A hostile/surprising symlink at the cache directory must not make a
        # read path escape the service-owned root. Treat it as a cache miss;
        # the atomic download path below will recreate a safe directory.
        return None
    if not directory.is_dir():
        return None
    def candidates() -> Any:
        # Most assets already have their canonical extension. Avoid scanning
        # the whole hash directory for every reference in a large snapshot.
        if preferred_path:
            yield root / preferred_path
        try:
            yield from sorted(directory.glob(f'{digest}.*'))
        except OSError:
            return

    for candidate in candidates():
        try:
            resolved = _path_inside(root, candidate)
            if candidate.is_symlink() or not resolved.is_file():
                continue
            size = resolved.stat().st_size
            if size > _ASSET_CACHE_MAX_BYTES or (expected_size is not None and size != expected_size):
                continue
            hasher = hashlib.sha256()
            with resolved.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    hasher.update(chunk)
            if hasher.hexdigest() == digest:
                return resolved
        except (OSError, ServiceException):
            continue
    return None


def _download_and_store_asset(
    root: Path,
    digest: str,
    item: Mapping[str, Any],
    expected_size: int | None,
    result: Any,
) -> tuple[Path, str]:
    """Validate one response and atomically persist it.

    This function intentionally contains every potentially expensive byte
    operation (conversion, hashing, temporary-file write, fsync and replace)
    so callers can run it in a worker thread without blocking the event loop.
    """

    if not isinstance(result, (bytes, bytearray, memoryview)):
        raise ServiceException(message=f'素材 {digest} 下载响应不是二进制')
    content = bytes(result)
    if len(content) > _ASSET_CACHE_MAX_BYTES:
        raise ServiceException(message=f'素材 {digest} 超出大小上限')
    if expected_size is not None and len(content) != expected_size:
        raise ServiceException(message=f'素材 {digest} 大小校验失败')
    if hashlib.sha256(content).hexdigest() != digest:
        raise ServiceException(message=f'素材 {digest} 哈希校验失败')
    relative = _asset_relative_path(digest, item)
    target = _path_inside(root, root / relative)
    parent = _path_inside(root, target.parent)
    parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='wb',
            dir=str(parent),
            prefix=f'.{digest}.',
            suffix='.tmp',
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, target)
        temporary_name = None
    finally:
        if temporary_name:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
    return target, relative


async def _invoke_asset_client(
    method: Any,
    run_id: int,
    digest: str,
    textbook_id: str,
) -> Any:
    """Invoke sync clients off-loop while accepting async test doubles."""

    # Calling a synchronous CollectorClient through to_thread is important:
    # urllib performs blocking socket I/O.  An async double returns a
    # coroutine from this worker invocation; only that coroutine is awaited on
    # the event loop, so both implementations remain compatible.
    result = await asyncio.to_thread(
        method,
        run_id,
        digest,
        textbook_external_id=textbook_id,
    )
    if inspect.isawaitable(result):
        return await result
    return result


async def _materialize_one_asset(
    semaphore: asyncio.Semaphore,
    client: CollectorClient,
    method: Any,
    root: Path,
    run_id: int,
    textbook_id: str,
    digest: str,
    item: Mapping[str, Any],
    expected_size: int | None,
) -> tuple[Path, str]:
    async with semaphore:
        cached_path = await asyncio.to_thread(
            _valid_cached_asset, root, digest, expected_size, _asset_relative_path(digest, item),
        )
        if cached_path is not None:
            return cached_path, _safe_storage_path(str(cached_path.relative_to(root))) or ''
        try:
            result = await _invoke_asset_client(method, run_id, digest, textbook_id)
        except ServiceException:
            raise
        except Exception as exc:
            raise ServiceException(message=f'素材 {digest} 下载失败') from exc
        try:
            return await asyncio.to_thread(
                _download_and_store_asset,
                root,
                digest,
                item,
                expected_size,
                result,
            )
        except ServiceException:
            raise
        except Exception as exc:
            raise ServiceException(message=f'素材 {digest} 落盘失败') from exc


async def _download_snapshot_assets(snapshot: dict[str, Any], *, sealed_for_import: bool = False) -> None:  # noqa: PLR0912
    """Materialize declared assets with bounded, service-owned concurrency."""

    assets = snapshot.get('assets')
    if not isinstance(assets, list) or not assets:
        return
    run_value = snapshot.get('collector_run_id') or snapshot.get('collectorRunId')
    if isinstance(run_value, bool):
        raise ServiceException(message='题库素材缺少快照运行范围')
    try:
        run_id = int(run_value)
    except (TypeError, ValueError) as exc:
        raise ServiceException(message='题库素材缺少快照运行范围') from exc
    textbook_id = str(snapshot.get('textbook_external_id') or snapshot.get('textbookExternalId') or '')
    if run_id <= 0 or not textbook_id:
        raise ServiceException(message='题库素材缺少快照运行范围')
    # Construct the client before creating any local directories.  A missing
    # collector URL must fail closed without leaving an otherwise empty cache
    # behind during an apply attempt.
    client = CollectorClient()
    root = await asyncio.to_thread(_asset_root)
    await asyncio.to_thread(root.mkdir, parents=True, exist_ok=True)
    method = getattr(client, 'run_asset_bytes', None) or getattr(client, 'asset_bytes', None)
    if not callable(method):
        raise ServiceException(message='collector 客户端不支持素材下载')
    if sealed_for_import:
        from functools import partial
        method = partial(method, sealed_for_import=True)

    # Group by content address before any I/O.  A run can reference the same
    # binary from multiple questions or HTML fields; one worker then serves
    # every occurrence with the same service-owned path.
    groups: dict[str, list[tuple[dict[str, Any], int | None]]] = {}
    for item in assets:
        if not isinstance(item, dict):
            raise ServiceException(message='题库素材行结构不正确')
        digest = str(
            item.get('file_hash')
            or item.get('fileHash')
            or item.get('content_sha256')
            or item.get('contentSha256')
            or ''
        ).strip().lower()
        if not _ASSET_SHA256_RE.fullmatch(digest):
            raise ServiceException(message='题库素材内容摘要无效')
        expected_size = item.get('byte_size')
        if expected_size is None:
            expected_size = _asset_byte_size(item)
        if expected_size is not None:
            expected_size = _asset_byte_size({'byte_size': expected_size})
        item['byte_size'] = expected_size
        groups.setdefault(digest, []).append((item, expected_size))

    # Conflicting declarations for the same content address are an invalid
    # snapshot.  Reject before downloading anything rather than letting the
    # first occurrence decide which size to trust.
    grouped: list[tuple[str, list[tuple[dict[str, Any], int | None]], int | None]] = []
    for digest, entries in groups.items():
        sizes = {size for _item, size in entries if size is not None}
        if len(sizes) > 1:
            raise ServiceException(message=f'素材 {digest} 大小声明不一致')
        grouped.append((digest, entries, next(iter(sizes), None)))

    # One snapshot may reference more than 100,000 distinct files. Creating
    # one coroutine per file would retain that many tasks even though the
    # semaphore permits only eight downloads. Fixed workers keep the number
    # of live coroutines independent of snapshot size.
    semaphore = asyncio.Semaphore(ASSET_DOWNLOAD_CONCURRENCY)
    pending = iter(enumerate(grouped))
    results: list[tuple[Path, str] | BaseException | None] = [None] * len(grouped)

    async def worker() -> None:
        for index, (digest, entries, expected_size) in pending:
            try:
                results[index] = await _materialize_one_asset(
                    semaphore, client, method, root, run_id, textbook_id,
                    digest, entries[0][0], expected_size,
                )
            except Exception as exc:
                results[index] = exc
                return

    await asyncio.gather(*(worker() for _ in range(min(ASSET_DOWNLOAD_CONCURRENCY, len(grouped)))))
    for result in results:
        if isinstance(result, BaseException):
            raise result
    if any(result is None for result in results):
        raise ServiceException(message='素材准备未完整完成')

    for (digest, entries, _expected_size), result in zip(grouped, results, strict=True):
        assert isinstance(result, tuple)
        target, relative = result
        if not relative:
            raise ServiceException(message=f'素材 {digest} 缓存路径不合法')
        # ``target`` is returned for type/diagnostic completeness; all rows
        # deliberately receive one relative path, never a collector path.
        del target
        for item, _item_size in entries:
            item['storage_path'] = relative
            item['download_status'] = 'downloaded'
            item['error_message'] = None


def _as_int(value: Any, *, field: str, allow_none: bool = False) -> int | None:
    if value is None or value == '':
        if allow_none:
            return None
        raise ServiceException(message=f'快照缺少有效 {field}')
    # bool is an int subclass, but accepting it for a row count is almost
    # always an API producer bug.
    if isinstance(value, bool):
        raise ServiceException(message=f'快照 {field} 必须是整数')
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ServiceException(message=f'快照 {field} 必须是整数') from exc
    if number < 0:
        raise ServiceException(message=f'快照 {field} 不能为负数')
    return number


def _array_value(raw: Mapping[str, Any], aliases: tuple[str, ...], *, label: str) -> list[Any]:
    """Extract one complete array and reject paginated/partial wrappers."""

    value = next((raw[name] for name in aliases if name in raw), None)
    if isinstance(value, Mapping):
        # A few collector deployments wrap each set as ``{items,total,...}``.
        for marker in ('partial', 'isPartial', 'truncated', 'hasMore', 'has_more'):
            if marker in value and _as_bool(value[marker]):
                raise ServiceException(message=f'题库快照 {label} 不是完整快照')
        items = next((value[name] for name in ('items', 'rows', 'data', 'values') if name in value), None)
        if not isinstance(items, list):
            raise ServiceException(message=f'题库快照缺少完整 {label} 数组')
        total = next((value[name] for name in ('total', 'count', 'expectedCount') if name in value), None)
        if total is not None and _as_int(total, field=f'{label} count') != len(items):
            raise ServiceException(message=f'题库快照 {label} 仍为分页结果')
        value = items
    if not isinstance(value, list):
        raise ServiceException(message=f'题库快照缺少完整 {label} 数组')
    return value


def _snapshot_header(raw: Mapping[str, Any], textbook_external_id: str, *, sealed_for_import: bool = False) -> tuple[dict[str, Any], dict[str, Any]]:  # noqa: PLR0912
    """Validate and return the stable run/header portions of a snapshot."""

    payload: Mapping[str, Any] = raw
    # HTTP clients often wrap the body in ``data``; do not silently unwrap a
    # scalar because that would make malformed responses look valid.
    for wrapper in ('data', 'snapshot'):
        candidate = payload.get(wrapper)
        if isinstance(candidate, Mapping) and not any(
            name in payload for name in ('run', 'counts', 'catalogs', 'questions', 'questionItems')
        ):
            payload = candidate
            break
        if isinstance(candidate, Mapping) and not any(name in payload for name in ('catalogs', 'questions', 'questionItems')):
            # Preserve a top-level run/immutability marker while taking the
            # actual row sets from a conventional ``data`` envelope.
            payload = {**candidate, **{key: value for key, value in payload.items() if key not in {'data', 'snapshot'}}}
            break
    if payload.get('available') is not True:
        raise ServiceException(message=str(payload.get('message') or 'collector 没有可用的题库快照'))
    for marker in (('truncated', 'hasMore', 'has_more') if sealed_for_import else ('partial', 'isPartial', 'truncated', 'hasMore', 'has_more')):
        if marker in payload and _as_bool(payload[marker]):
            raise ServiceException(message=f'教材 {textbook_external_id} 的题库快照仍为分页或部分结果')
    # A complete endpoint may expose page metadata for observability, but a
    # positive next cursor/total larger than the returned arrays is proof that
    # the caller received only one page.  ``_array_value`` performs the same
    # check for per-set wrappers.
    if payload.get('nextPage') not in (None, '', 0, False) or payload.get('next_page') not in (None, '', 0, False):
        raise ServiceException(message=f'教材 {textbook_external_id} 的题库快照仍为分页结果')
    if payload.get('immutable') is not True:
        raise ServiceException(message=f'教材 {textbook_external_id} 的题库快照未锁定')
    run = payload.get('run')
    if not isinstance(run, Mapping):
        raise ServiceException(message=f'教材 {textbook_external_id} 的题库快照缺少运行信息')
    if sealed_for_import:
        _normalise_snapshot_summary(payload, 0, textbook_external_id, sealed_for_import=True)
        return dict(payload), dict(run)
    # ``snapshot_complete`` is intentionally mandatory.  A terminal status or
    # lock timestamp alone cannot prove that every page/detail/material row
    # was persisted.
    complete_values = [
        source[name]
        for source in (payload, run)
        for name in ('snapshot_complete', 'snapshotComplete', 'complete', 'isComplete')
        if name in source and source[name] is not None
    ]
    if not complete_values or not all(_as_bool(value) for value in complete_values):
        raise ServiceException(message=f'教材 {textbook_external_id} 的题库快照未完成')
    provider = str(_pick(run, 'provider', 'sourceProvider', 'source_provider', default='') or '').strip()
    status = str(_pick(run, 'status', default='') or '').strip().lower()
    run_id = _pick(run, 'id', 'runId', 'collectorRunId')
    if provider != PROVIDER or status not in {'success', 'completed'}:
        raise ServiceException(message=f'collector 运行 {run_id or ""} 未成功完成或来源不受支持')
    error_count = _pick(
        run,
        'error_count',
        'errorCount',
        default=_pick(payload, 'error_count', 'errorCount'),
    )
    if error_count is None or int(_as_int(error_count, field='error_count') or 0) != 0:
        raise ServiceException(message=f'collector 运行 {run_id or ""} 包含采集错误或缺少错误计数')
    if not _pick(run, 'finished_at', 'finishedAt'):
        raise ServiceException(message=f'collector 运行 {run_id or ""} 缺少完成时间')
    locked = _pick(run, 'snapshot_locked_at', 'snapshotLockedAt', 'locked')
    if not _lock_present(locked):
        raise ServiceException(message=f'collector 运行 {run_id or ""} 尚未锁定')
    scope = _pick(run, 'scope', 'scope_json', 'scopeJson', default=None)
    if scope in (None, '', {}):
        scope = _pick(
            run,
            'textbookExternalId',
            'textbook_external_id',
            'textbookExternalIds',
            'textbook_external_ids',
            default=_pick(payload, 'scope', 'scopeItems', 'scope_items', 'textbookExternalIds', 'textbook_external_ids', default={}),
        )
    if isinstance(scope, list):
        scope = {'textbookExternalIds': scope}
    scope_ids = _run_scope_ids(scope)
    if not scope_ids or str(textbook_external_id) not in scope_ids:
        raise ServiceException(message=f'collector 运行 {run_id or ""} 与教材 {textbook_external_id} 不匹配')
    return dict(payload), dict(run)


def _coerce_datetime(value: Any) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError:
        for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S'):
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue
        else:
            return None
    if parsed.tzinfo is not None:
        return parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _same(left: Any, right: Any) -> bool:
    if isinstance(left, datetime) or isinstance(right, datetime):
        return _coerce_datetime(left) == _coerce_datetime(right)
    return _jsonable(left) == _jsonable(right)


def _run_scope_ids(scope: Any) -> set[str]:
    if isinstance(scope, str):
        try:
            scope = json.loads(scope)
        except (TypeError, json.JSONDecodeError):
            # A few hand-migrated/older collector stores used a scalar
            # textbook ID instead of a JSON object.  Accept only a safe
            # external-ID spelling here; malformed JSON must not become a
            # wildcard scope.
            value = scope.strip()
            return {value} if _safe_external_id(value) else set()
    if isinstance(scope, (int, float)) and not isinstance(scope, bool):
        value = str(scope).strip()
        return {value} if _safe_external_id(value) else set()
    if not isinstance(scope, Mapping):
        return set()
    values: list[Any] = []
    for key in ('textbookExternalIds', 'textbook_external_ids', 'textbookIds', 'textbook_ids'):
        candidate = scope.get(key)
        if isinstance(candidate, list):
            values.extend(candidate)
    values.extend(
        scope.get(key)
        for key in ('textbookExternalId', 'textbook_external_id', 'textbookId', 'textbook_id')
        if scope.get(key) not in (None, '')
    )
    for key in ('scopeItems', 'scope_items', 'textbooks', 'selectedTextbooks'):
        candidate = scope.get(key)
        if isinstance(candidate, list):
            for item in candidate:
                if isinstance(item, Mapping):
                    values.extend(
                        item.get(name)
                        for name in (
                            'externalTextbookId',
                            'external_textbook_id',
                            'textbookExternalId',
                            'textbook_external_id',
                            'textbookId',
                            'textbook_id',
                        )
                        if item.get(name) not in (None, '')
                    )
                elif item not in (None, ''):
                    values.append(item)
    return {str(value).strip() for value in values if str(value or '').strip()}


async def _read_snapshot(run_id: int, textbook_external_id: str) -> dict[str, Any]:
    payload = await asyncio.to_thread(
        CollectorClient().run_snapshot,
        run_id,
        textbook_external_id=textbook_external_id,
    )
    if not isinstance(payload, Mapping):
        raise ServiceException(message='collector API 完整题库快照结构不正确')
    _snapshot_header(payload, str(textbook_external_id))
    return dict(payload)


def _summary_payload(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Unwrap a collector summary without touching any row arrays."""

    payload: Mapping[str, Any] = raw
    # HTTP clients may wrap the response in ``data``.  A summary endpoint is
    # intentionally array-free, so use the presence of run/count markers to
    # distinguish an envelope from a legitimate field named ``data``.
    for wrapper in ('data', 'summary'):
        candidate = payload.get(wrapper)
        if not isinstance(candidate, Mapping):
            continue
        # Preserve scalar markers left beside a wrapped response (for
        # example ``available``) while taking run/count fields from the
        # nested summary.  Top-level keys remain authoritative on conflicts.
        payload = {
            **candidate,
            **{key: value for key, value in payload.items() if key not in {'data', 'summary'}},
        }
        break
    return dict(payload)


def _summary_counts(  # noqa: PLR0912
    payload: Mapping[str, Any],
    run: Mapping[str, Any],
    textbook_external_id: str,
    *,
    task_id: int,
) -> dict[str, int]:
    """Read all five authoritative counters from a summary response."""

    scoped = payload.get('scoped')
    scoped_values = scoped if isinstance(scoped, Mapping) else {}
    scoped_counts: Any = next(
        (scoped_values[name] for name in ('counts', 'snapshotCounts', 'snapshot_counts') if name in scoped_values),
        None,
    )
    if isinstance(scoped_counts, str):
        try:
            scoped_counts = json.loads(scoped_counts)
        except (TypeError, json.JSONDecodeError):
            scoped_counts = None
    if not isinstance(scoped_counts, Mapping):
        scoped_counts = {}
    counts_raw: Any = next(
        (payload[name] for name in ('counts', 'snapshotCounts', 'snapshot_counts') if name in payload),
        None,
    )
    if isinstance(counts_raw, str):
        try:
            counts_raw = json.loads(counts_raw)
        except (TypeError, json.JSONDecodeError):
            counts_raw = None
    if not isinstance(counts_raw, Mapping):
        counts_raw = payload
    elif not any(name in counts_raw for aliases in SNAPSHOT_COUNT_FIELDS.values() for name in aliases):
        scoped = counts_raw.get(str(textbook_external_id))
        if isinstance(scoped, Mapping):
            counts_raw = scoped

    result: dict[str, int] = {}
    for key, aliases in SNAPSHOT_COUNT_FIELDS.items():
        value = next((counts_raw[name] for name in aliases if name in counts_raw), None)
        if value is None:
            value = next((payload[name] for name in aliases if name in payload), None)
        if value is None:
            value = next((scoped_values[name] for name in aliases if name in scoped_values), None)
        if value is None:
            value = next((scoped_counts[name] for name in aliases if name in scoped_counts), None)
        if value is None:
            value = next((run[name] for name in aliases if name in run), None)
        if value is None:
            raise ServiceException(
                message=f'任务 {task_id} 教材 {textbook_external_id} 缺少有效 {key} 快照计数'
            )
        result[key] = int(_as_int(value, field=f'{key} count') or 0)
    return result


def _missing_snapshot_message(task_id, textbook_external_id, counts, run):
    labels = {'catalogs': '目录', 'questions': '题目', 'questionCatalogs': '题目与目录关联'}
    missing = '、'.join(label for key, label in labels.items() if counts.get(key, 0) <= 0)
    stats = '，'.join(f'{label} {counts.get(key, 0)} 条' for key, label in labels.items())
    cause = _pick(run, 'message', 'errorMessage', 'error_message', default='')
    reason = f'；采集停止原因：{cause}' if cause else ''
    return (f'任务 {task_id} 教材 {textbook_external_id} 本次成果无法入库：未采集到{missing}。'
            f'已保存{stats}{reason}。请检查采集日志后重新采集，重试核验不会补齐缺失内容。')


def _normalise_snapshot_summary(  # noqa: PLR0912, PLR0915
    raw: Mapping[str, Any],
    task_id: int,
    textbook_external_id: str,
    allow_incomplete: bool = False,
    *,
    sealed_for_import: bool = False,
) -> dict[str, Any]:
    """Validate a bounded immutable content-run summary.

    This validator deliberately never accepts, inspects, or normalizes the
    five row arrays.  It is used by task-detail eligibility only; the apply
    path continues through ``_normalise_snapshot`` for strict row-level
    validation.
    """

    if allow_incomplete and sealed_for_import:
        raise ValueError('resume and incremental-import policies are distinct')
    if not isinstance(raw, Mapping):
        raise ServiceException(message='collector API 题库快照摘要结构不正确')
    payload = _summary_payload(raw)
    if payload.get('available') is not True:
        raise ServiceException(message=str(payload.get('message') or 'collector 没有可用的题库快照'))
    if payload.get('immutable') is not True:
        raise ServiceException(message=f'教材 {textbook_external_id} 的题库快照摘要未锁定')

    run_value = payload.get('run')
    run = dict(run_value) if isinstance(run_value, Mapping) else dict(payload)
    complete_values = [
        source[name]
        for source in (payload, run)
        for name in ('snapshot_complete', 'snapshotComplete', 'complete', 'isComplete')
        if name in source and source[name] is not None
    ]
    complete = bool(complete_values) and all(_as_bool(value) for value in complete_values)
    if sealed_for_import and complete_values and any(_as_bool(value) for value in complete_values) != complete:
        raise ServiceException(message=f'教材 {textbook_external_id} 的完整标记互相矛盾')
    if not complete_values or (not complete and not (allow_incomplete or sealed_for_import)):
        raise ServiceException(message=f'教材 {textbook_external_id} 的题库快照摘要未完成')
    if allow_incomplete and complete:
        raise ServiceException(message=f'教材 {textbook_external_id} 的题库快照已完整，不能作为中断断点')

    # Prefer the structured ``run`` object, but accept the scalar/header
    # aliases used by older summary clients.  A sparse nested object must not
    # accidentally turn a valid top-level provider or run ID into a false
    # negative, while row arrays remain completely outside this path.
    provider = str(
        _pick(
            run,
            'provider',
            'sourceProvider',
            'source_provider',
            default=_pick(payload, 'provider', 'sourceProvider', 'source_provider', default=''),
        )
        or ''
    ).strip()
    run_id = _pick(
        run,
        'id',
        'runId',
        'collectorRunId',
        'collector_run_id',
        default=_pick(payload, 'id', 'runId', 'collectorRunId', 'collector_run_id'),
    )
    if isinstance(run_id, bool):
        raise ServiceException(message=f'collector 运行 {run_id or ""} 的运行 ID 无效')
    if provider != PROVIDER:
        raise ServiceException(message=f'collector 运行 {run_id or ""} 来源不受支持')
    status = str(_pick(run, 'status', default=_pick(payload, 'status', default='')) or '').strip().lower()
    accepted_statuses = (
        {'success', 'completed'}
        | ({'interrupted', 'failed', 'blocked'} if allow_incomplete or sealed_for_import else set())
        | ({'cancelled'} if sealed_for_import else set())
    )
    if status not in accepted_statuses:
        raise ServiceException(message=f'collector 运行 {run_id or ""} 未成功完成')
    if allow_incomplete and status in {'success', 'completed'}:
        raise ServiceException(message=f'collector 运行 {run_id or ""} 的不完整状态不受支持')
    error_count = _pick(
        run,
        'error_count',
        'errorCount',
        default=_pick(payload, 'error_count', 'errorCount'),
    )
    if error_count is None:
        raise ServiceException(message=f'collector 运行 {run_id or ""} 包含采集错误或缺少错误计数')
    parsed_error_count = int(_as_int(error_count, field='error_count') or 0)
    if not (allow_incomplete or sealed_for_import) and parsed_error_count != 0:
        raise ServiceException(message=f'collector 运行 {run_id or ""} 包含采集错误或缺少错误计数')
    if not _pick(run, 'finished_at', 'finishedAt', default=_pick(payload, 'finished_at', 'finishedAt')):
        raise ServiceException(message=f'collector 运行 {run_id or ""} 缺少完成时间')
    locked = _pick(
        run,
        'snapshot_locked_at',
        'snapshotLockedAt',
        'locked',
        default=_pick(payload, 'snapshot_locked_at', 'snapshotLockedAt', 'locked'),
    )
    if not _lock_present(locked):
        raise ServiceException(message=f'collector 运行 {run_id or ""} 尚未锁定')

    scoped = payload.get('scoped')
    scoped_values = scoped if isinstance(scoped, Mapping) else {}
    scope = _pick(run, 'scope', 'scope_json', 'scopeJson', default=None)
    if scope in (None, '', {}):
        scope = _pick(
            run,
            'textbookExternalId',
            'textbook_external_id',
            'textbookExternalIds',
            'textbook_external_ids',
            default=_pick(
                payload,
                'scope',
                'scopeItems',
                'scope_items',
                'textbookExternalId',
                'textbook_external_id',
                'textbookExternalIds',
                'textbook_external_ids',
                default=scoped_values,
            ),
        )
    if isinstance(scope, list):
        scope = {'textbookExternalIds': scope}
    scope_identity = scope
    if isinstance(scope_identity, str):
        try:
            scope_identity = json.loads(scope_identity)
        except (TypeError, ValueError):
            scope_identity = {}
    if isinstance(scope_identity, Mapping):
        namespace = _pick(scope_identity, 'sourceNamespace', 'source_namespace', default='zujuan:junior:math')
        if namespace != 'zujuan:junior:math' or str(scope_identity.get('bankPath', 'czsx')) != 'czsx' or str(scope_identity.get('bankId', 2)) != '2':
            raise ServiceException(message='Collector 快照的学科来源不受支持')
    if isinstance(scope, Mapping):
        # The summary route commonly exposes ``externalTextbookId`` at the
        # top level while keeping the run scope object broad.  Include that
        # explicit ID in the ownership set without accepting arbitrary row
        # data as scope evidence.
        direct_id = _pick(
            payload,
            'externalTextbookId',
            'external_textbook_id',
            'textbookExternalId',
            'textbook_external_id',
            default=_pick(
                scoped_values,
                'externalTextbookId',
                'external_textbook_id',
                'textbookExternalId',
                'textbook_external_id',
            ),
        )
        if direct_id not in (None, '') and not _run_scope_ids(scope):
            scope = {**scope, 'textbookExternalId': direct_id}
    scope_ids = _run_scope_ids(scope) | _run_scope_ids(scoped_values)
    if not scope_ids or str(textbook_external_id) not in scope_ids:
        raise ServiceException(message=f'collector 运行 {run_id or ""} 与教材 {textbook_external_id} 不匹配')
    # ``scoped`` is the endpoint's per-textbook projection.  If present, it
    # must agree with the requested scope; accepting a broad run declaration
    # alone would allow a multi-textbook response to be applied to the wrong
    # formal textbook.
    if scoped_values and _run_scope_ids(scoped_values) != {str(textbook_external_id)}:
        raise ServiceException(message=f'collector 运行 {run_id or ""} 与教材 {textbook_external_id} 不匹配')

    counts = _summary_counts(payload, run, textbook_external_id, task_id=task_id)
    if not allow_incomplete and (counts['catalogs'] <= 0 or counts['questions'] <= 0 or counts['questionCatalogs'] <= 0):
        raise ServiceException(message=_missing_snapshot_message(task_id, textbook_external_id, counts, run))
    if allow_incomplete and (counts['catalogs'] <= 0 or counts['questions'] <= 0 or counts['questionCatalogs'] <= 0):
        raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 没有可安全续采的完整页快照')
    try:
        normalized_run_id = int(run_id)
    except (TypeError, ValueError) as exc:
        raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的 collector 运行 ID 无效') from exc
    if normalized_run_id <= 0:
        raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的 collector 运行 ID 无效')
    from plugins.bank.service.run_coverage import normalise_run_coverage

    sealed_evidence = (
        scope_identity.get('sealedCoverageEvidence') if isinstance(scope_identity, Mapping) else None
    )
    coverage = normalise_run_coverage(
        payload.get('coverage', sealed_evidence), normalized_run_id, str(textbook_external_id), _coerce_datetime(locked),
    )
    if sealed_evidence is not None and coverage != normalise_run_coverage(
        sealed_evidence, normalized_run_id, str(textbook_external_id), _coerce_datetime(locked),
    ):
        raise ServiceException(message='Collector 返回的覆盖摘要与封存记录不一致')
    return {
        'run': run,
        'immutable': True,
        'partial': not complete,
        'incomplete': not complete,
        'snapshot_complete': complete,
        'snapshotComplete': complete,
        'counts': counts,
        'collector_run_id': normalized_run_id,
        'snapshot_locked_at': _coerce_datetime(locked),
        'textbook_external_id': str(textbook_external_id),
        'run_coverage': coverage,
        # Keep an optional server-provided hash for status projections, but
        # never derive one from an omitted/full row array.
        'snapshot_hash': _pick(
            payload,
            'snapshotHash',
            'snapshot_hash',
            default=_pick(scoped_values, 'snapshotHash', 'snapshot_hash'),
        ),
    }


async def _read_snapshot_summary(run_id: int, textbook_external_id: str) -> dict[str, Any]:
    """Read and validate only bounded immutable snapshot metadata/counts."""
    payload = await asyncio.to_thread(
        CollectorClient().run_snapshot_summary,
        run_id,
        textbook_external_id=textbook_external_id,
    )
    normalized = _normalise_snapshot_summary(payload, 0, str(textbook_external_id))
    if int(normalized['collector_run_id']) != int(run_id):
        raise ServiceException(message=f'collector 运行 ID 与教材 {textbook_external_id} 不一致')
    return normalized


def _normalise_catalog_rows(rows: list[Mapping[str, Any]], task_id: int, textbook_external_id: str) -> list[dict[str, Any]]:
    """Validate a whole source tree once; callers may then use ancestor subsets."""
    def row_scope(row: Mapping[str, Any]) -> str:
        value = _pick(
            row,
            'textbook_external_id',
            'textbookExternalId',
            'externalTextbookId',
            'textbook_id',
            'textbookId',
            default=textbook_external_id,
        )
        return str(value or '').strip()

    def has_scope_field(row: Mapping[str, Any]) -> bool:
        return any(
            name in row
            for name in (
                'textbook_external_id',
                'textbookExternalId',
                'externalTextbookId',
                'textbook_id',
                'textbookId',
            )
        )

    def row_provider(row: Mapping[str, Any]) -> str:
        return str(_pick(row, 'provider', 'sourceProvider', 'source_provider', default='') or '').strip()

    def row_int(row: Mapping[str, Any], *aliases: str, default: int = 0) -> int:
        value = _pick(row, *aliases, default=default)
        try:
            return int(value or 0)
        except (TypeError, ValueError) as exc:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 快照数字字段无效') from exc

    catalogs: list[dict[str, Any]] = []
    catalog_ids: set[str] = set()
    for row in rows:
        external_id = str(_pick(row, 'catalog_external_id', 'catalogExternalId', 'externalNodeId', 'externalId', default='') or '').strip()
        name = str(_pick(row, 'name', 'nodeName', 'node_name', 'catalogName', default='') or '').strip()
        if not has_scope_field(row) or row_provider(row) != PROVIDER or row_scope(row) != str(textbook_external_id) or not _safe_external_id(external_id) or not name or external_id in catalog_ids:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 包含无效或重复目录 ID')
        catalog_ids.add(external_id)
        parent = _pick(row, 'parent_external_id', 'parentExternalId', 'parentExternalNodeId')
        parent = str(parent).strip() if parent not in (None, '') else None
        if parent and (not _safe_external_id(parent) or parent == external_id):
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的目录父 ID 不安全')
        catalogs.append(
            {
                'external_id': external_id,
                'parent_external_id': parent,
                'node_level': _pick(row, 'node_level', 'nodeLevel', 'catalogLevel'),
                'node_type': str(_pick(row, 'node_type', 'nodeType', default='other') or 'other')[:20],
                'node_name': name[:300],
                'source_url': _pick(row, 'source_url', 'sourceUrl'),
                'sort_order': row_int(row, 'sort_order', 'sortOrder'),
                'last_seen_at': _coerce_datetime(_pick(row, 'captured_at', 'capturedAt', 'observed_at', 'observedAt')),
            }
        )
    for row in catalogs:
        if row['parent_external_id'] and row['parent_external_id'] not in catalog_ids:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的目录父节点不在同一快照')
    # Guard against a cyclic source tree.  Merely checking that each parent
    # exists is insufficient and would make the formal tree impossible to
    # traverse safely.
    parent_by_catalog = {row['external_id']: row['parent_external_id'] for row in catalogs}
    checked_parents: set[str] = set()
    for catalog_id in parent_by_catalog:
        seen_parents: set[str] = set()
        cursor = catalog_id
        while cursor and cursor not in checked_parents:
            if cursor in seen_parents:
                raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的目录树存在循环')
            seen_parents.add(cursor)
            cursor = parent_by_catalog.get(cursor)
        checked_parents.update(seen_parents)

    return catalogs


def _normalise_snapshot(raw: Mapping[str, Any], task_id: int, textbook_external_id: str, *, sealed_for_import: bool = False) -> dict[str, Any]:  # noqa: PLR0912, PLR0915
    """Validate and normalize the collector's complete five-table snapshot."""

    payload, run = _snapshot_header(raw, str(textbook_external_id), sealed_for_import=sealed_for_import)
    run_id = _pick(run, 'id', 'runId', 'collectorRunId')
    if run_id is None:
        raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 缺少 collector 运行 ID')
    if isinstance(run_id, bool):
        raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的 collector 运行 ID 无效')
    try:
        normalized_run_id = int(run_id)
    except (TypeError, ValueError) as exc:
        raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的 collector 运行 ID 无效') from exc
    if normalized_run_id <= 0:
        raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的 collector 运行 ID 无效')
    names = {
        'catalogs': ('catalogs', 'catalogItems', 'catalog_items'),
        'questions': ('questions', 'questionItems', 'question_items'),
        'questionCatalogs': ('questionCatalogs', 'question_catalogs', 'catalogRelations', 'relations'),
        'tags': ('tags', 'questionTags', 'question_tags'),
        'assets': ('assets', 'questionAssets', 'question_assets', 'materials'),
    }
    rows: dict[str, list[dict[str, Any]]] = {}
    for output_name, aliases in names.items():
        values = _array_value(payload, aliases, label=output_name)
        rows[output_name] = [dict(item) for item in values if isinstance(item, Mapping)]
        if len(rows[output_name]) != len(values):
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的 {output_name} 快照包含无效行')
        if len(rows[output_name]) > MAX_SNAPSHOT_ROWS:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 快照超过安全上限')

    counts_raw: Any = next(
        (payload[name] for name in ('counts', 'snapshotCounts', 'snapshot_counts') if name in payload),
        None,
    )
    if isinstance(counts_raw, str):
        try:
            counts_raw = json.loads(counts_raw)
        except (TypeError, json.JSONDecodeError):
            counts_raw = None
    if not isinstance(counts_raw, Mapping):
        # Some collector revisions put the five counters beside the run
        # metadata instead of under ``counts``.  Accept that spelling while
        # still requiring every counter explicitly.
        counts_raw = payload
    elif not any(name in counts_raw for aliases in SNAPSHOT_COUNT_FIELDS.values() for name in aliases):
        scoped = counts_raw.get(str(textbook_external_id))
        if isinstance(scoped, Mapping):
            counts_raw = scoped
    expected: dict[str, int] = {}
    for key, aliases in SNAPSHOT_COUNT_FIELDS.items():
        count_value = next((counts_raw[name] for name in aliases if name in counts_raw), None)
        run_value = next((run[name] for name in aliases if name in run), None)
        run_scope_count = len(_run_scope_ids(_pick(run, 'scope', 'scope_json', 'scopeJson', default={})))
        if count_value is not None and run_value is not None and run_scope_count <= 1:
            try:
                if int(count_value) != int(run_value):
                    raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的 {key} 计数元数据冲突')
            except (TypeError, ValueError) as exc:
                raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 缺少有效快照计数') from exc
        value = count_value if count_value is not None else run_value
        if value is None:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 缺少有效快照计数')
        expected[key] = int(_as_int(value, field=f'{key} count') or 0)
        if len(rows[key]) != expected[key]:
            raise ServiceException(
                message=f'任务 {task_id} 教材 {textbook_external_id} 的 {key} 计数不一致：'
                f'{len(rows[key])}/{expected[key]}'
            )
    if expected['catalogs'] <= 0 or expected['questions'] <= 0 or expected['questionCatalogs'] <= 0:
        raise ServiceException(message=_missing_snapshot_message(task_id, textbook_external_id, expected, run))

    def row_scope(row: Mapping[str, Any]) -> str:
        value = _pick(
            row,
            'textbook_external_id',
            'textbookExternalId',
            'externalTextbookId',
            'textbook_id',
            'textbookId',
            default=textbook_external_id,
        )
        return str(value or '').strip()

    def has_scope_field(row: Mapping[str, Any]) -> bool:
        return any(
            name in row
            for name in (
                'textbook_external_id',
                'textbookExternalId',
                'externalTextbookId',
                'textbook_id',
                'textbookId',
            )
        )

    def row_provider(row: Mapping[str, Any]) -> str:
        return str(_pick(row, 'provider', 'sourceProvider', 'source_provider', default='') or '').strip()

    def row_int(row: Mapping[str, Any], *aliases: str, default: int = 0) -> int:
        value = _pick(row, *aliases, default=default)
        try:
            return int(value or 0)
        except (TypeError, ValueError) as exc:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 快照数字字段无效') from exc

    def row_optional_int(row: Mapping[str, Any], *aliases: str) -> int | None:
        value = _pick(row, *aliases)
        if value in (None, ''):
            return None
        try:
            return int(value)
        except (TypeError, ValueError) as exc:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 快照数字字段无效') from exc

    catalogs = _normalise_catalog_rows(rows['catalogs'], task_id, textbook_external_id)
    catalog_ids = {row['external_id'] for row in catalogs}

    assets_by_question: dict[str, dict[str, dict[str, Any]]] = {}
    for asset in rows['assets']:
        owner = str(_pick(asset, 'question_external_id', 'questionExternalId', 'externalQuestionId', default='') or '')
        key = str(_pick(asset, 'asset_key', 'assetKey', default='') or '')
        assets_by_question.setdefault(owner, {})[key] = asset
    questions: list[dict[str, Any]] = []
    question_ids: set[str] = set()
    for row in rows['questions']:
        external_id = str(_pick(row, 'question_external_id', 'questionExternalId', 'externalQuestionId', 'externalId', default='') or '').strip()
        content_html = _pick(row, 'content_html', 'contentHtml')
        plain_text = _pick(row, 'plain_text', 'plainText', default='') or ''
        question_type = _pick(row, 'question_type', 'questionType')
        if not has_scope_field(row) or row_provider(row) != PROVIDER or row_scope(row) != str(textbook_external_id) or not _safe_external_id(external_id) or external_id in question_ids:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 包含无效或重复题目 ID')
        if not str(question_type or '').strip():
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的题目 {external_id} 缺少题型')
        if not str(content_html or '').strip() and not str(plain_text).strip():
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的题目 {external_id} 缺少题干')
        detail_marker = _pick(row, 'detail_fetched', 'detailFetched')
        if _pick(row, 'content_source', 'contentSource') == 'list_api' and not _as_bool(detail_marker):
            validate_list_content(row, assets_by_question.get(external_id, {}))
        else:
            if detail_marker is None or not _as_bool(detail_marker):
                raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的题目 {external_id} 详情未完整抓取')
            detail_hash = _pick(row, 'detail_content_hash', 'detailContentHash')
            if ('detail_content_hash' in row or 'detailContentHash' in row) and not str(detail_hash or '').strip():
                raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的题目 {external_id} 缺少详情摘要')
        question_ids.add(external_id)
        content_hash = _pick(row, 'content_hash', 'contentHash', 'detail_content_hash', 'detailContentHash')
        if not content_hash:
            content_hash = _canonical_hash({'contentHtml': content_html, 'plainText': plain_text})
        raw_json = _pick(row, 'raw_json', 'rawJson', 'rawData', 'raw_data_json')
        if isinstance(raw_json, str):
            try:
                raw_json = json.loads(raw_json)
            except (TypeError, json.JSONDecodeError):
                raw_json = {'raw': raw_json}
        fresh_value = _pick(row, 'is_new', 'isNew')
        fresh = None if fresh_value is None else ('Y' if _as_bool(fresh_value) else 'N')
        reference_papers = _pick(row, 'reference_papers_json', 'referencePapers')
        if isinstance(reference_papers, str):
            try:
                reference_papers = json.loads(reference_papers)
            except (TypeError, json.JSONDecodeError):
                reference_papers = None
        raw_answer_status = _pick(row, 'answer_status', 'answerStatus')
        answer_status = _normalise_answer_status(raw_answer_status)
        # ``solution_html`` is a single combined source block.  Independent
        # answer/analysis fields are trusted only when the collector marks
        # the solution as publicly captured; for every other status they are
        # intentionally normalized to NULL so a private solution can never
        # leak into the formal answer columns.
        answer_html = _pick(row, 'answer_html', 'answerHtml')
        analysis_html = _pick(row, 'analysis_html', 'analysisHtml')
        if not _answer_is_public(raw_answer_status):
            answer_html = None
            analysis_html = None
        questions.append(
            {
                'external_id': external_id,
                'source_url': _pick(row, 'detail_url', 'detailUrl', 'source_url', 'sourceUrl'),
                'source_question_no': _pick(row, 'source_question_no', 'sourceQuestionNo'),
                'source_text': _pick(row, 'source_short', 'sourceShort', 'source_text', 'sourceText'),
                'paper_name': _pick(row, 'source_title', 'sourceTitle', 'paper_name', 'paperName'),
                'academic_year': _pick(row, 'academic_year', 'academicYear'),
                'year': row_optional_int(row, 'year'),
                'grade': _pick(row, 'grade'),
                'term': _pick(row, 'term'),
                'province': _pick(row, 'province'),
                'city': _pick(row, 'city'),
                'district': _pick(row, 'district'),
                'school_name': _pick(row, 'school_name', 'schoolName'),
                'exam_type': _pick(row, 'exam_type', 'examType'),
                'question_type': str(question_type).strip(),
                'difficulty': _pick(row, 'difficulty_label', 'difficultyLabel', 'difficulty'),
                'difficulty_coefficient': _pick(row, 'ease_coefficient', 'easeCoefficient', 'difficultyCoefficient'),
                'score': _pick(row, 'score'),
                'content_html': content_html,
                'plain_text': plain_text,
                # ``solution_html`` is intentionally retained only inside the
                # raw JSON payload.  The collector does not classify it into
                # separate answer/analysis columns.
                'answer_html': answer_html,
                'analysis_html': analysis_html,
                'answer_status': answer_status,
                'subquestion_count': row_optional_int(row, 'subquestion_count', 'subquestionCount') or 0,
                'website_time_text': _pick(row, 'website_time_text', 'websiteTimeText'),
                'external_updated_at': _coerce_datetime(_pick(row, 'provider_updated_at', 'providerUpdatedAt', 'external_updated_at', 'externalUpdatedAt')),
                'assemble_count': row_optional_int(row, 'assemble_count', 'assembleCount', 'use_count', 'useCount'),
                'reference_count': row_optional_int(row, 'reference_count', 'referenceCount'),
                'reference_papers_json': reference_papers,
                'is_fresh': fresh,
                'content_hash': str(content_hash),
                'raw_data_json': raw_json,
                'last_seen_at': _coerce_datetime(_pick(row, 'captured_at', 'capturedAt', 'observed_at', 'observedAt')),
            }
        )

    relations: list[dict[str, Any]] = []
    relation_keys: set[tuple[str, str, str]] = set()
    for row in rows['questionCatalogs']:
        question_id = str(_pick(row, 'question_external_id', 'questionExternalId', 'externalQuestionId', default='') or '').strip()
        catalog_id = str(_pick(row, 'catalog_external_id', 'catalogExternalId', 'externalCatalogId', default='') or '').strip()
        if not has_scope_field(row) or row_provider(row) != PROVIDER or row_scope(row) != str(textbook_external_id) or question_id not in question_ids or catalog_id not in catalog_ids:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的目录关系引用了不存在的题目/目录')
        relation_type = str(_pick(row, 'relation_type', 'relationType', default='query_catalog') or 'query_catalog')
        evidence = str(_pick(row, 'evidence_type', 'evidenceType', default='query_membership') or 'query_membership')
        if relation_type != 'query_catalog' or evidence not in {'query_membership', 'provider_asserted'}:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的目录关系类型无效')
        key = (question_id, catalog_id, evidence)
        if key in relation_keys:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的目录关系重复')
        relation_keys.add(key)
        relations.append(
            {
                'question_external_id': question_id,
                'catalog_external_id': catalog_id,
                'relation_type': relation_type,
                'evidence_type': evidence,
                'sort_order': row_int(row, 'sort_order', 'sortOrder', 'catalog_level', 'catalogLevel'),
                'last_seen_at': _coerce_datetime(_pick(row, 'captured_at', 'capturedAt', 'observed_at', 'observedAt')),
            }
        )
    if not relations:
        raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 缺少必要目录关系')
    related_questions = {row['question_external_id'] for row in relations}
    if related_questions != question_ids:
        missing_questions = sorted(question_ids - related_questions)
        raise ServiceException(
            message=f'任务 {task_id} 教材 {textbook_external_id} 存在未绑定目录的题目：{", ".join(missing_questions[:5])}'
        )

    tags: list[dict[str, Any]] = []
    tag_keys: set[tuple[str, str, str, str, str]] = set()
    tag_observations: dict[tuple[str, str, str, str, str], tuple[str, set[str], dict[str, Any]]] = {}
    for row in rows['tags']:
        question_id = str(_pick(row, 'question_external_id', 'questionExternalId', 'externalQuestionId', default='') or '').strip()
        dimension = str(_pick(row, 'dimension', 'tag_type', 'tagType', default='') or '').strip()
        tag_name = str(_pick(row, 'tag_value', 'tagValue', 'value', 'tag_name', 'tagName', default='') or '').strip()
        if not has_scope_field(row) or row_provider(row) != PROVIDER or row_scope(row) != str(textbook_external_id) or question_id not in question_ids or not dimension or not tag_name:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 包含无效标签')
        evidence = str(_pick(row, 'evidence_type', 'evidenceType', default='provider_asserted') or 'provider_asserted')
        relation_type = str(_pick(row, 'relation_type', 'relationType', default='provider_asserted') or 'provider_asserted')
        if evidence not in {'query_membership', 'provider_asserted'}:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的标签证据类型无效')
        if not relation_type or len(relation_type) > MAX_TAG_RELATION_LENGTH:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的标签关系类型无效')
        if len(dimension) > 30 or len(tag_name) > 100:
            raise ServiceException(message=f'题目 {question_id} 的标签长度超过正式表上限')
        key = (question_id, dimension, tag_name, evidence, relation_type)
        external_tag_id = str(_pick(row, 'tag_external_id', 'tagExternalId', default='') or '')
        fingerprint = str(_pick(row, 'query_fingerprint', 'queryFingerprint', default='') or '')
        observed_at = _coerce_datetime(_pick(row, 'observed_at', 'observedAt', 'captured_at', 'capturedAt'))
        if key in tag_keys:
            original_id, fingerprints, original = tag_observations[key]
            if not fingerprint or '' in fingerprints or fingerprint in fingerprints or original_id != external_tag_id:
                raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的标签重复或来源 ID 冲突')
            if original['sort_order'] != row_int(row, 'sort_order', 'sortOrder'):
                raise ServiceException(message=f'题目 {question_id} 的重复标签排序冲突')
            fingerprints.add(fingerprint)
            if observed_at and (not original['last_seen_at'] or observed_at > original['last_seen_at']):
                original['last_seen_at'] = observed_at
            continue
        tag_keys.add(key)
        tags.append(
            {
                'question_external_id': question_id,
                'tag_type': dimension[:30],
                'tag_name': tag_name[:100],
                'evidence_type': evidence,
                'relation_type': relation_type[:120],
                'sort_order': row_int(row, 'sort_order', 'sortOrder'),
                'last_seen_at': observed_at,
            }
        )
        tag_observations[key] = (external_tag_id, {fingerprint}, tags[-1])

    assets: list[dict[str, Any]] = []
    asset_keys: set[tuple[str, str]] = set()
    for row in rows['assets']:
        question_id = str(_pick(row, 'question_external_id', 'questionExternalId', 'externalQuestionId', default='') or '').strip()
        asset_key = str(_pick(row, 'asset_key', 'assetKey', default='') or '').strip()[:100]
        source_url = str(_pick(row, 'source_url', 'sourceUrl', 'url', default='') or '').strip()
        asset_type = str(_pick(row, 'asset_type', 'assetType', 'type', default='') or '').strip()
        file_hash = str(
            _pick(row, 'content_sha256', 'contentSha256', 'sha256', 'file_hash', 'fileHash', default='') or ''
        ).strip().lower()
        if not has_scope_field(row) or row_provider(row) != PROVIDER or row_scope(row) != str(textbook_external_id) or question_id not in question_ids or not asset_key or not asset_type or not source_url:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 包含无效素材')
        if len(file_hash) != ASSET_SHA256_LENGTH or any(char not in '0123456789abcdef' for char in file_hash):
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的素材 {asset_key} 内容摘要无效')
        storage_path = _asset_relative_path(file_hash, row)
        key = (question_id, asset_key)
        if key in asset_keys:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_external_id} 的素材键重复')
        asset_keys.add(key)
        assets.append(
            {
                'question_external_id': question_id,
                'asset_key': asset_key[:100],
                'asset_type': asset_type[:30],
                'source_url': source_url[:1000],
                'storage_path': storage_path,
                'mime_type': _pick(row, 'mime_type', 'mimeType'),
                'file_name': _pick(row, 'file_name', 'fileName'),
                'file_hash': file_hash,
                'byte_size': _asset_byte_size(row),
                'width': _pick(row, 'width'),
                'height': _pick(row, 'height'),
                'download_status': str(_pick(row, 'download_status', 'downloadStatus', default='downloaded') or 'downloaded'),
                'error_message': _pick(row, 'error_message', 'errorMessage'),
                'sort_order': row_int(row, 'sort_order', 'sortOrder'),
                'last_seen_at': _coerce_datetime(_pick(row, 'observed_at', 'observedAt', 'captured_at', 'capturedAt')),
            }
        )

    business = {
        'provider': PROVIDER,
        'externalTextbookId': str(textbook_external_id),
        'catalogs': sorted(catalogs, key=lambda item: item['external_id']),
        'questions': sorted(questions, key=lambda item: item['external_id']),
        'questionCatalogs': sorted(relations, key=lambda item: (item['question_external_id'], item['catalog_external_id'], item['evidence_type'])),
        'tags': sorted(
            tags,
            key=lambda item: (
                item['question_external_id'],
                item['tag_type'],
                item['tag_name'],
                item.get('relation_type', 'provider_asserted'),
                item['evidence_type'],
            ),
        ),
        'assets': sorted(assets, key=lambda item: (item['question_external_id'], item['asset_key'])),
    }
    return {
        'run': dict(run),
        'catalogs': catalogs,
        'questions': questions,
        'question_catalogs': relations,
        'tags': tags,
        'assets': assets,
        'snapshot_hash': _canonical_hash(business),
        'business': business,
        'counts': expected,
        'collector_run_id': normalized_run_id,
        'textbook_external_id': str(textbook_external_id),
        'snapshot_complete': not sealed_for_import or _normalise_snapshot_summary(payload, task_id, textbook_external_id, sealed_for_import=True)['snapshot_complete'],
    }


def _task_value(row: object, *names: str, default: Any = None) -> Any:
    return _pick(row, *names, default=default)


def _uses_incremental_workflow(task: object) -> bool:
    options = _task_value(task, 'options_json', 'optionsJson', default={})
    if isinstance(options, str):
        try:
            options = json.loads(options)
        except (TypeError, ValueError) as exc:
            raise ServiceException(message='任务流程标记损坏，不能选择入库方式') from exc
    if options is None:
        return False
    if not isinstance(options, Mapping):
        raise ServiceException(message='任务流程标记损坏，不能选择入库方式')
    version = options.get('workflowVersion', 1)
    if isinstance(version, bool) or version not in (1, 2):
        raise ServiceException(message='任务流程版本不受支持')
    return version == 2


def _positive_run_id(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


_TASK_SIGNATURE_FIELDS = (
    'run_id',
    'run_type',
    'task_module',
    'status',
    'phase',
    'metadata_run_id',
    'source_task_id',
    'retry_of_run_id',
    'collector_job_id',
    'options_json',
    'catalog_count',
    'question_count',
    'question_catalog_count',
    'question_tag_count',
    'question_asset_count',
    'snapshot_complete',
    'snapshot_locked_at',
)
_SCOPE_SIGNATURE_FIELDS = (
    'scope_id',
    'run_id',
    'local_version_id',
    'local_textbook_id',
    'version_name_snapshot',
    'textbook_name_snapshot',
    'source_provider',
    'external_version_id',
    'external_textbook_id',
    'metadata_run_id',
    'collector_job_id',
    'collector_run_id',
    'resume_from_collector_run_id',
    'status',
    'catalog_count',
    'question_count',
    'new_catalog_count',
    'changed_catalog_count',
    'new_question_count',
    'changed_question_count',
    'question_catalog_count',
    'question_tag_count',
    'question_asset_count',
    'snapshot_complete',
    'snapshot_locked_at',
)


def _freeze_signature_value(value: Any) -> Any:
    """Copy row values into a recursively immutable comparison shape."""

    if isinstance(value, datetime):
        return ('datetime', value.isoformat())
    if isinstance(value, Mapping):
        return tuple(sorted(((str(key), _freeze_signature_value(item)) for key, item in value.items()), key=repr))
    if isinstance(value, (list, tuple)):
        return tuple(_freeze_signature_value(item) for item in value)
    if isinstance(value, (set, frozenset)):
        return tuple(sorted((_freeze_signature_value(item) for item in value), key=repr))
    if isinstance(value, bytearray):
        return bytes(value)
    return value


def _row_signature(row: object, fields: tuple[str, ...]) -> tuple[tuple[str, Any], ...]:
    return tuple((field, _freeze_signature_value(_task_value(row, field))) for field in fields)


def _task_scope_signature(task: object, scopes: list[object]) -> tuple[Any, ...]:
    task_signature = _row_signature(task, _TASK_SIGNATURE_FIELDS)
    scope_signatures = tuple(
        sorted(
            (_row_signature(scope, _SCOPE_SIGNATURE_FIELDS) for scope in scopes),
            key=repr,
        )
    )
    return task_signature, scope_signatures


async def _rollback_read_transaction(db: AsyncSession) -> None:
    """End the initial read transaction before any collector or disk I/O."""

    rollback = getattr(db, 'rollback', None)
    if not callable(rollback):
        return
    result = rollback()
    if inspect.isawaitable(result):
        await result


async def _load_task_and_scopes(
    db: AsyncSession,
    task_id: int,
    *,
    for_update: bool = False,
) -> tuple[QbSyncJob, list[QbSyncJobScope]]:
    """Load a question task and all scopes, optionally acquiring row locks.

    Apply uses this twice: an unlocked read creates an immutable signature,
    then the HTTP/materialization phase runs after rollback, and finally this
    function is called with ``for_update=True`` to lock and revalidate the
    exact rows before formal writes begin.
    """

    task_query = select(QbSyncJob).where(
        QbSyncJob.run_id == int(task_id),
        QbSyncJob.task_module == 'question',
    )
    if for_update:
        task_query = task_query.with_for_update()
    result = await db.execute(task_query)
    scalar = getattr(result, 'scalars', None)
    task = next(iter(scalar().all()), None) if callable(scalar) else None
    if task is None:
        raise ServiceException(message='同步题库任务不存在')
    scope_query = (
        select(QbSyncJobScope)
        .where(QbSyncJobScope.run_id == int(task_id))
        .order_by(QbSyncJobScope.scope_id)
    )
    if for_update:
        scope_query = scope_query.with_for_update()
    scope_result = await db.execute(scope_query)
    scalar = getattr(scope_result, 'scalars', None)
    scopes = list(scalar().all()) if callable(scalar) else []
    return task, scopes


async def _validate_task_snapshots(db: AsyncSession, task_id: int, expected_review_revision: int | None = None, *, write_stack: AsyncExitStack | None = None) -> tuple[QbSyncJob, list[QbSyncJobScope], list[dict[str, Any]]]:
    task, scopes = await _load_task_and_scopes(db, task_id)
    if _uses_incremental_workflow(task):
        raise ServiceException(message='新版任务使用分批增量入库，不能执行旧版整批应用；增量入库正在重构中')
    from plugins.bank.entity.do.bank_do import QbQuestionTaskReview
    review = await db.get(QbQuestionTaskReview, task_id)
    excluded_ids = set(review.excluded_json) if review else set()
    review_revision = review.revision if review else 0
    if expected_review_revision is not None and review_revision != expected_review_revision:
        raise ServiceException(message='审核选择版本已变化，请刷新题目对比后重新确认入库')
    initial_signature = _task_scope_signature(task, scopes)
    if str(_task_value(task, 'status', default='') or '').strip().lower() != 'completed':
        raise ServiceException(message='只有已成功完成的同步题库任务才能应用正式表')
    if not scopes:
        raise ServiceException(message='同步题库任务缺少教材范围，不能应用正式表')
    seen: set[str] = set()
    scope_inputs: list[tuple[str, int]] = []
    for scope in scopes:
        provider = str(_task_value(scope, 'source_provider', 'sourceProvider', default='') or '').strip()
        textbook_id = str(_task_value(scope, 'external_textbook_id', 'externalTextbookId', default='') or '').strip()
        scope_status = str(_task_value(scope, 'status', default='') or '').strip().lower()
        collector_run_id = _task_value(scope, 'collector_run_id', 'collectorRunId')
        if provider != PROVIDER or not _safe_external_id(textbook_id) or scope_status != 'completed':
            raise ServiceException(message=f'任务 {task_id} 存在未成功绑定的题库教材范围')
        if textbook_id in seen:
            raise ServiceException(message=f'任务 {task_id} 的教材范围重复：{textbook_id}')
        seen.add(textbook_id)
        try:
            collector_run_id = int(collector_run_id)
        except (TypeError, ValueError) as exc:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_id} 缺少 collectorRunId') from exc
        if collector_run_id <= 0:
            raise ServiceException(message=f'任务 {task_id} 教材 {textbook_id} 缺少 collectorRunId')
        scope_inputs.append((textbook_id, collector_run_id))

    # The first SELECT starts an AsyncSession transaction even without a row
    # lock. End it before touching the remote collector or the local asset
    # filesystem; no database transaction/lock spans network or disk latency.
    await _rollback_read_transaction(db)

    snapshots: list[dict[str, Any]] = []
    for textbook_id, collector_run_id in scope_inputs:
        raw = await _read_snapshot(collector_run_id, textbook_id)
        snapshot = _normalise_snapshot(raw, task_id, textbook_id)
        _filter_review_selection(snapshot, excluded_ids)
        if int(snapshot['collector_run_id'] or 0) != collector_run_id:
            raise ServiceException(message=f'collector 运行 ID 与任务 {task_id} 教材 {textbook_id} 不一致')
        await _download_snapshot_assets(snapshot)
        snapshots.append(snapshot)

    # Re-read and lock both the task and every scope only after all remote and
    # asset work has completed. Any status, scope membership, identity or run
    # change during the unlocked phase fails closed before formal writes.
    if write_stack is not None:
        await write_stack.enter_async_context(source_write_lock(db))
    locked_task, locked_scopes = await _load_task_and_scopes(db, task_id, for_update=True)
    locked_review = await db.get(QbQuestionTaskReview, task_id, populate_existing=True)
    if (locked_review.revision if locked_review else 0) != review_revision:
        raise ServiceException(message='题目选择在同步准备期间发生变化，请重新同步')
    if _task_scope_signature(locked_task, locked_scopes) != initial_signature:
        raise ServiceException(message='同步题库任务或教材范围在快照读取期间发生变化，请刷新后重试')
    locked_by_key = {
        (
            str(_task_value(scope, 'source_provider', 'sourceProvider', default='') or '').strip(),
            str(_task_value(scope, 'external_textbook_id', 'externalTextbookId', default='') or '').strip(),
        ): scope
        for scope in locked_scopes
    }
    for snapshot in snapshots:
        key = (PROVIDER, str(snapshot['textbook_external_id']))
        locked_scope = locked_by_key.get(key)
        if locked_scope is None:
            raise ServiceException(message='同步题库任务教材范围在锁定复核期间发生变化，请刷新后重试')
        snapshot['scope'] = locked_scope
        snapshot['task_id'] = int(task_id)
    return locked_task, locked_scopes, snapshots


def _filter_review_selection(snapshot, excluded_ids):
    """Filter only after original snapshot integrity validation, before asset IO."""
    if not excluded_ids:
        return
    snapshot['excluded_question_ids'] = set(excluded_ids)
    snapshot['questions'] = [row for row in snapshot['questions'] if row['external_id'] not in excluded_ids]
    for collection in ('question_catalogs', 'tags', 'assets'):
        snapshot[collection] = [row for row in snapshot[collection] if row['question_external_id'] not in excluded_ids]
    snapshot['snapshot_hash'] = _canonical_hash({'snapshot': snapshot['snapshot_hash'], 'excluded': sorted(excluded_ids)})


def _stats_bucket() -> dict[str, int]:
    return {'inserted': 0, 'updated': 0, 'unchanged': 0, 'disabled': 0, 'removed': 0}


def _empty_stats() -> dict[str, dict[str, int]]:
    return {name: _stats_bucket() for name in ('catalogs', 'questions', 'questionCatalogs', 'tags', 'assets')}


def _merge_stats(total: dict[str, dict[str, int]], value: Mapping[str, Mapping[str, int]]) -> None:
    for name, stats in value.items():
        bucket = total.setdefault(name, _stats_bucket())
        for key, number in stats.items():
            bucket[key] = bucket.get(key, 0) + int(number or 0)


def _state_status(row: object | None) -> dict[str, Any]:
    return {
        'externalTextbookId': _task_value(row, 'external_textbook_id', 'externalTextbookId') if row else None,
        'currentTaskId': int(_task_value(row, 'current_task_id', 'currentTaskId')) if row and _task_value(row, 'current_task_id', 'currentTaskId') is not None else None,
        'currentCollectorRunId': int(_task_value(row, 'current_collector_run_id', 'currentCollectorRunId')) if row and _task_value(row, 'current_collector_run_id', 'currentCollectorRunId') is not None else None,
        'snapshotHash': _task_value(row, 'snapshot_hash', 'snapshotHash') if row else None,
        'stateToken': _task_value(row, 'state_token', 'stateToken') if row else None,
        'appliedBy': _task_value(row, 'applied_by', 'appliedBy') if row else None,
        'appliedAt': _task_value(row, 'applied_at', 'appliedAt') if row else None,
    }


def _scope_key(scope: object | None) -> str:
    return str(_task_value(scope, 'external_textbook_id', 'externalTextbookId', default='') or '').strip()


def _scope_local_textbook_id(scope: object | None) -> str | None:
    value = _task_value(scope, 'local_textbook_id', 'localTextbookId', 'textbook_id', 'textbookId')
    return None if value in (None, '') else str(value)


def _state_token_for_scope(state: object | None) -> str | None:
    value = _task_value(state, 'state_token', 'stateToken') if state is not None else None
    return None if value in (None, '') else str(value)


def _expected_token_for_scope(expected: str | Mapping[str, Any] | None, scope: object, textbook_id: str) -> Any:
    if not isinstance(expected, Mapping):
        return expected
    local_id = _scope_local_textbook_id(scope)
    candidates: list[Any] = [textbook_id]
    if local_id is not None:
        candidates.extend([local_id, int(local_id) if local_id.isdigit() else local_id])
    for candidate in candidates:
        if candidate in expected:
            value = expected[candidate]
            if isinstance(value, Mapping):
                return _pick(value, 'stateToken', 'state_token', 'currentStateToken', 'current_state_token')
            return value
    # Be liberal about snake/camel keyed maps from older clients while still
    # treating an absent scope token as a concurrency error below.
    for candidate in (textbook_id, local_id):
        if candidate is None:
            continue
        for key in (f'{candidate}:stateToken', f'{candidate}.stateToken'):
            if key in expected:
                value = expected[key]
                if isinstance(value, Mapping):
                    return _pick(value, 'stateToken', 'state_token', 'currentStateToken', 'current_state_token')
                return value
    return ...


def _status_token_projection(scope_statuses: list[Mapping[str, Any]]) -> tuple[Any, dict[str, Any]]:
    tokens = {
        str(item.get('externalTextbookId')): item.get('stateToken')
        for item in scope_statuses
        if item.get('externalTextbookId')
    }
    if len(scope_statuses) == 1:
        scalar = scope_statuses[0].get('stateToken')
        return scalar, tokens
    return (tokens or None), tokens


class QuestionApplyService:
    """Apply and inspect provider/textbook-scoped question snapshots."""

    # Keep these helpers available on the service class, mirroring the
    # textbook-apply service and making test/integration code independent of
    # the module-level implementation details.
    _empty_stats = staticmethod(_empty_stats)

    @staticmethod
    async def _state(db: AsyncSession, provider: str, textbook_id: str, *, for_update: bool = False) -> QbQuestionApplyState | None:
        try:
            return await QuestionApplyDao.get_state(db, provider, textbook_id, for_update=for_update)
        except SQLAlchemyError as exc:
            original = getattr(exc, 'orig', exc)
            arguments = getattr(original, 'args', ())
            message = str(original or exc).lower()
            if (arguments and arguments[0] == MYSQL_TABLE_NOT_FOUND) or (
                'qb_question_apply_state' in message
                and any(marker in message for marker in ('does not exist', 'no such table', "doesn't exist"))
            ):
                return None
            raise

    @classmethod
    async def task_apply_status(cls, db: AsyncSession, task: object, scopes: list[object]) -> dict[str, Any]:
        task_id = _task_value(task, 'run_id', 'runId', 'task_id', 'taskId')
        scope_statuses: list[dict[str, Any]] = []
        task_completed = str(_task_value(task, 'status', default='') or '').strip().lower() == 'completed'
        eligible = task_completed and bool(scopes)
        reason: str | None = None if task_completed else '任务未成功完成'
        for scope in scopes:
            textbook_id = _scope_key(scope)
            state = await cls._state(db, PROVIDER, textbook_id)
            current_id = _task_value(state, 'current_task_id') if state else None
            current_run = _task_value(state, 'current_collector_run_id') if state else None
            item = {
                'externalTextbookId': textbook_id,
                'localTextbookId': _task_value(scope, 'local_textbook_id', 'localTextbookId', 'textbook_id', 'textbookId'),
                'textbookId': _task_value(scope, 'local_textbook_id', 'localTextbookId', 'textbook_id', 'textbookId'),
                'textbookName': _task_value(scope, 'textbook_name_snapshot', 'textbookNameSnapshot', 'textbook_name', 'textbookName'),
                'catalogCount': int(_task_value(scope, 'catalog_count', 'catalogCount', default=0) or 0),
                'questionCount': int(_task_value(scope, 'question_count', 'questionCount', default=0) or 0),
                'resumeFromCollectorRunId': _task_value(
                    scope,
                    'resume_from_collector_run_id',
                    'resumeFromCollectorRunId',
                ),
                # The interrupted state alone is not enough: old/imported
                # rows may not be bound to an immutable Collector run.  Keep
                # this secondary apply-status projection consistent with the
                # authoritative task projection before the UI offers resume.
                'resumeAvailable': (
                    str(_task_value(scope, 'status', default='') or '').lower() == 'interrupted'
                    and _positive_run_id(
                        _task_value(
                            scope,
                            'resume_from_collector_run_id',
                            'resumeFromCollectorRunId',
                        )
                    )
                    is not None
                ),
                'questionCatalogCount': int(
                    _task_value(scope, 'question_catalog_count', 'questionCatalogCount', 'relation_count', 'relationCount', default=0)
                    or 0
                ),
                'questionTagCount': int(
                    _task_value(scope, 'question_tag_count', 'questionTagCount', 'tag_count', 'tagCount', default=0)
                    or 0
                ),
                'questionAssetCount': int(
                    _task_value(scope, 'question_asset_count', 'questionAssetCount', 'asset_count', 'assetCount', default=0)
                    or 0
                ),
                'snapshotComplete': _as_bool(
                    _task_value(scope, 'snapshot_complete', 'snapshotComplete', 'complete', default=False)
                ),
                'snapshotLockedAt': _task_value(scope, 'snapshot_locked_at', 'snapshotLockedAt', 'lockedAt'),
                'currentTaskId': int(current_id) if current_id is not None else None,
                'currentCollectorRunId': int(current_run) if current_run is not None else None,
                'currentSnapshotHash': _task_value(state, 'snapshot_hash') if state else None,
                'stateToken': _state_token_for_scope(state),
                'currentStateToken': _state_token_for_scope(state),
                'appliedAt': _task_value(state, 'applied_at') if state else None,
                'eligible': False,
                'isCurrent': bool(current_id is not None and task_id is not None and int(current_id) == int(task_id)),
                'affectedTextbooks': [textbook_id] if textbook_id else [],
            }
            if task_completed:
                # Completion already verified this Collector run and persisted
                # its five counts and lock marker. The immutable snapshot is
                # read and checked again by apply(), where it actually matters.
                run_id = _positive_run_id(_task_value(scope, 'collector_run_id', 'collectorRunId'))
                item['eligible'] = bool(
                    textbook_id
                    and str(_task_value(scope, 'source_provider', 'sourceProvider', default='') or '') == PROVIDER
                    and str(_task_value(scope, 'status', default='') or '').lower() == 'completed'
                    and run_id is not None
                    and item['snapshotComplete']
                    and item['snapshotLockedAt']
                )
                for collection, count_key in (
                    ('catalogs', 'catalogCount'),
                    ('questions', 'questionCount'),
                    ('questionCatalogs', 'questionCatalogCount'),
                    ('tags', 'questionTagCount'),
                    ('assets', 'questionAssetCount'),
                ):
                    if item[count_key] > MAX_SNAPSHOT_ROWS:
                        item['eligible'] = False
                        if reason is None:
                            reason = (
                                f'教材 {textbook_id} 的 {collection} 有 {item[count_key]} 行，'
                                f'超过当前入库上限 {MAX_SNAPSHOT_ROWS}；需要分批入库'
                            )
                item['isCurrent'] = bool(
                    item['isCurrent'] and run_id is not None and int(current_run or 0) == run_id
                )
                if not item['eligible'] and reason is None:
                    reason = f'教材 {textbook_id} 缺少已验证的完整快照，请检查采集任务'
            scope_statuses.append(item)

        current_ids = {item['currentTaskId'] for item in scope_statuses}
        current_task_id = next(iter(current_ids)) if len(current_ids) == 1 else None
        all_current = bool(scope_statuses) and all(item['isCurrent'] for item in scope_statuses)
        if all_current:
            action = 'alreadyApplied'
        elif not any(item['currentTaskId'] is not None for item in scope_statuses):
            action = 'apply'
        elif task_id is not None and all(
            item['currentTaskId'] is not None and int(task_id) < int(item['currentTaskId'])
            for item in scope_statuses
        ):
            action = 'rollback'
        else:
            action = 'restore'
        scalar_token, token_map = _status_token_projection(scope_statuses)
        affected = [
            {
                'externalTextbookId': item['externalTextbookId'],
                'localTextbookId': item.get('localTextbookId'),
                'textbookId': item.get('textbookId'),
                'textbookName': item.get('textbookName'),
                'currentTaskId': item.get('currentTaskId'),
                'stateToken': item.get('stateToken'),
                'isCurrent': item.get('isCurrent'),
            }
            for item in scope_statuses
        ]
        status = {
            'eligible': eligible and all(item['eligible'] for item in scope_statuses),
            'isCurrent': all_current,
            'currentTaskId': int(current_task_id) if current_task_id is not None else None,
            'currentTaskName': f'同步题库任务 {current_task_id}' if current_task_id is not None else None,
            'currentStateToken': scalar_token,
            # ``stateToken`` remains a scalar for one scope and is a map for
            # multi-scope tasks.  This is the shape consumed by both old and
            # new management clients.
            'stateToken': scalar_token,
            'expectedStateToken': scalar_token,
            'stateTokens': token_map or None,
            'action': action,
            'suggestedAction': action,
            'eligibilityMessage': None if all_current else reason,
            'scopes': scope_statuses,
            'affectedTextbooks': affected,
        }
        if _uses_incremental_workflow(task):
            status.update(eligible=False, isCurrent=False, action='incremental', suggestedAction='incremental',
                          eligibilityMessage='新版任务使用分批增量入库，增量入库正在重构中')
            for item in scope_statuses:
                item.update(eligible=False, isCurrent=False)
        # Return the nested projection too.  ``task_payload`` keeps unknown
        # fields, so this is backwards-compatible with clients that consumed
        # the former top-level fields.
        status['applyStatus'] = dict(status)
        return status

    @classmethod
    async def ensure_task_not_current(cls, db: AsyncSession, task_id: int) -> None:
        try:
            result = await db.execute(
                select(QbQuestionApplyState)
                .where(QbQuestionApplyState.current_task_id == int(task_id))
                .with_for_update()
            )
        except SQLAlchemyError as exc:
            original = getattr(exc, 'orig', exc)
            arguments = getattr(original, 'args', ())
            message = str(original or exc).lower()
            if (arguments and arguments[0] == MYSQL_TABLE_NOT_FOUND) or (
                'qb_question_apply_state' in message
                and any(marker in message for marker in ('does not exist', 'no such table', "doesn't exist"))
            ):
                return
            raise
        scalars = getattr(result, 'scalars', None)
        rows = list(scalars().all()) if callable(scalars) else []
        if rows:
            textbooks = ', '.join(str(row.external_textbook_id) for row in rows[:5])
            raise ServiceException(message=f'任务当前对应正式题库教材 scope（{textbooks}），不能删除；请先切换正式题库任务')

    @classmethod
    async def apply(  # noqa: PLR0912, PLR0915
        cls,
        db: AsyncSession,
        task_id: int,
        expected_current_task_id: int | None = None,
        operator: str | None = None,
        expected_state_token: str | Mapping[str, str] | None = None,
        expected_review_revision: int | None = None,
    ) -> dict[str, Any]:
        write_stack = AsyncExitStack()
        try:
            target_task_id = int(task_id)
            if expected_review_revision is None:
                _task, _scopes, snapshots = await _validate_task_snapshots(db, target_task_id, write_stack=write_stack)
            else:
                _task, _scopes, snapshots = await _validate_task_snapshots(db, target_task_id, expected_review_revision, write_stack=write_stack)
            keys = sorted({(str(_pick(snapshot['run'], 'provider', 'sourceProvider', default=PROVIDER)), snapshot['textbook_external_id']) for snapshot in snapshots})
            states: dict[str, QbQuestionApplyState] = {}
            scopes_by_textbook = {snapshot['textbook_external_id']: snapshot.get('scope') for snapshot in snapshots}
            for provider, textbook_id in keys:
                row = await cls._state(db, provider, textbook_id, for_update=True)
                if row is None:
                    row = await QuestionApplyDao.add_state(db, provider, textbook_id)
                states[textbook_id] = row

            current_ids = {
                int(row.current_task_id) if row.current_task_id is not None else None
                for row in states.values()
            }
            # ``expectedCurrentTaskId`` is a legacy single-value token.  A
            # map of per-scope state tokens is authoritative for multi-scope
            # tasks and may legitimately accompany a mixed current-task set.
            if expected_current_task_id is not None and expected_state_token is None:
                if len(current_ids) != 1 or next(iter(current_ids)) != int(expected_current_task_id):
                    current_display = next(iter(current_ids)) if len(current_ids) == 1 else '多个任务'
                    raise ServiceException(message=f'正式题库任务已变化（当前为任务 {current_display or "无"}），请刷新任务详情后重新确认')
            elif expected_current_task_id is not None and len(current_ids) == 1:
                # When both values are supplied, retain the old check where it
                # is unambiguous; the per-scope token still protects every
                # row in a multi-scope request.
                if next(iter(current_ids)) != int(expected_current_task_id):
                    raise ServiceException(message=f'正式题库任务已变化（当前为任务 {next(iter(current_ids)) or "无"}），请刷新任务详情后重新确认')
            elif expected_current_task_id is None and current_ids != {None} and expected_state_token is None:
                raise ServiceException(message='正式题库状态缺少并发 token，请刷新任务详情后重新确认')

            if expected_state_token is not None:
                if not isinstance(expected_state_token, Mapping) and len(states) > 1:
                    raise ServiceException(message='多教材正式题库必须提供按教材区分的状态 token')
                if isinstance(expected_state_token, Mapping):
                    # Unknown keys usually indicate that the UI submitted a
                    # token for a different textbook selection.
                    valid_keys = {
                        key
                        for textbook_id, scope in scopes_by_textbook.items()
                        for key in (textbook_id, _scope_local_textbook_id(scope))
                        if key is not None
                    }
                    unknown = [str(key) for key in expected_state_token if key not in valid_keys]
                    if unknown:
                        raise ServiceException(message='正式题库状态 token 范围与任务教材不一致，请刷新任务详情后重试')
                for textbook_id, state in states.items():
                    expected = _expected_token_for_scope(
                        expected_state_token,
                        scopes_by_textbook.get(textbook_id),
                        textbook_id,
                    )
                    actual = _state_token_for_scope(state)
                    # The UI's compatibility helper omits null tokens for
                    # scopes that have never been applied.  Treat that one
                    # omission as an explicit ``None`` while still failing
                    # closed for a missing token on an already-applied scope.
                    if expected is ... and actual is None:
                        expected = None
                    elif expected is ...:
                        raise ServiceException(message=f'正式题库教材 {textbook_id} 缺少状态 token，请刷新任务详情后重新确认')
                    if expected == '' or (expected is None and actual is not None) or (
                        expected is not None and str(expected) != str(actual)
                    ):
                        raise ServiceException(message=f'正式题库教材 {textbook_id} 状态 token 已变化，请刷新任务详情后重新确认')

            all_already = True
            aggregate = _empty_stats()
            scope_results: list[dict[str, Any]] = []
            now = datetime.now()
            for snapshot in snapshots:
                textbook_id = snapshot['textbook_external_id']
                state = states[textbook_id]
                current_task_id = int(state.current_task_id) if state.current_task_id is not None else None
                previous = {
                    'task_id': current_task_id,
                    'collector_run_id': int(state.current_collector_run_id) if state.current_collector_run_id is not None else None,
                    'snapshot_hash': state.snapshot_hash,
                    'state_token': state.state_token,
                }
                snapshot['previous_task_id'] = current_task_id
                snapshot_hash = str(snapshot['snapshot_hash'])
                if current_task_id == target_task_id and int(state.current_collector_run_id or 0) == int(snapshot['collector_run_id'] or 0) and str(state.snapshot_hash or '') == snapshot_hash:
                    scope_results.append({
                        'externalTextbookId': textbook_id,
                        'action': 'alreadyApplied',
                        'alreadyApplied': True,
                        'previousTaskId': current_task_id,
                        'collectorRunId': snapshot['collector_run_id'],
                        'snapshotHash': snapshot_hash,
                        'stateToken': state.state_token,
                        'stats': _empty_stats(),
                    })
                    _merge_stats(aggregate, _empty_stats())
                    continue
                all_already = False
                stats = await cls._apply_scope(db, snapshot, now)
                action = 'apply' if current_task_id is None else ('rollback' if target_task_id < current_task_id else 'restore')
                token = secrets.token_hex(32)
                state.current_task_id = target_task_id
                state.current_collector_run_id = int(snapshot['collector_run_id'])
                state.snapshot_hash = snapshot_hash
                state.state_token = token
                state.applied_by = operator
                state.applied_at = now
                state.update_time = now
                await QuestionApplyDao.add_history(
                    db,
                    QbQuestionApplyHistory(
                        source_provider=PROVIDER,
                        external_textbook_id=textbook_id,
                        task_id=target_task_id,
                        collector_run_id=int(snapshot['collector_run_id']),
                        snapshot_hash=snapshot_hash,
                        state_token=token,
                        action=action,
                        previous_task_id=previous['task_id'],
                        previous_collector_run_id=previous['collector_run_id'],
                        previous_snapshot_hash=previous['snapshot_hash'],
                        change_stats_json=stats,
                        applied_by=operator,
                        applied_at=now,
                        create_time=now,
                        update_time=now,
                    ),
                )
                _merge_stats(aggregate, stats)
                scope_results.append({
                    'externalTextbookId': textbook_id,
                    'action': action,
                    'alreadyApplied': False,
                    'previousTaskId': previous['task_id'],
                    'collectorRunId': snapshot['collector_run_id'],
                    'snapshotHash': snapshot_hash,
                    'stateToken': token,
                    'stats': stats,
                })
            await db.flush()
            await db.commit()
            actions = {item['action'] for item in scope_results if item['action'] != 'alreadyApplied'}
            action = next(iter(actions)) if len(actions) == 1 else ('apply' if 'apply' in actions else 'restore')
            response_token, response_token_map = _status_token_projection(scope_results)
            affected_textbooks = [
                {
                    'externalTextbookId': item.get('externalTextbookId'),
                    'currentTaskId': item.get('previousTaskId'),
                    'stateToken': item.get('stateToken'),
                }
                for item in scope_results
            ]
            response_stats = dict(aggregate)
            response_stats['relations'] = aggregate.get('questionCatalogs', _stats_bucket())
            return {
                'action': 'alreadyApplied' if all_already else action,
                'alreadyApplied': all_already,
                'targetTaskId': target_task_id,
                'previousTaskId': scope_results[0].get('previousTaskId') if len({item.get('previousTaskId') for item in scope_results}) == 1 else None,
                'scopes': scope_results,
                'affectedTextbooks': affected_textbooks,
                'stats': response_stats,
                # These aliases keep the response useful to existing clients
                # that expect a single-scope response shape.
                'collectorRunId': scope_results[0].get('collectorRunId') if len(scope_results) == 1 else None,
                'snapshotHash': scope_results[0].get('snapshotHash') if len(scope_results) == 1 else None,
                'stateToken': response_token,
                'currentStateToken': response_token,
                'stateTokens': response_token_map or None,
            }
        except BaseException:
            await db.rollback()
            raise
        finally:
            await write_stack.aclose()

    @classmethod
    async def _apply_scope(cls, db: AsyncSession, snapshot: Mapping[str, Any], now: datetime) -> dict[str, dict[str, int]]:  # noqa: PLR0912, PLR0915
        textbook_external_id = str(snapshot['textbook_external_id'])
        scope = snapshot['scope']
        local_textbook_id = _task_value(scope, 'local_textbook_id', 'localTextbookId', 'textbook_id', 'textbookId')
        textbook_query = select(QbTextbook).where(
            QbTextbook.subject_id == 1, QbTextbook.source_provider == PROVIDER,
            QbTextbook.external_textbook_id == textbook_external_id,
        )
        textbook = (await db.execute(textbook_query)).scalars().first()
        if textbook is None:
            raise ServiceException(message=f'正式教材不存在：{textbook_external_id}')
        if local_textbook_id is not None and int(textbook.textbook_id) != int(local_textbook_id):
            raise ServiceException(message=f'任务教材 scope {textbook_external_id} 与正式教材不匹配')
        local_textbook_id = int(textbook.textbook_id)
        stats = _empty_stats()

        catalog_rows = list((await db.execute(select(QbCatalogNode).where(QbCatalogNode.subject_id == 1, QbCatalogNode.source_provider == PROVIDER))).scalars().all())
        catalogs_by_external = {str(row.external_node_id): row for row in catalog_rows if row.external_node_id and int(row.textbook_id) == local_textbook_id}
        old_scope_catalogs = [row for row in catalog_rows if int(row.textbook_id) == local_textbook_id]
        target_catalogs = snapshot['catalogs']
        target_external_ids = {str(item['external_id']) for item in target_catalogs}
        catalog_map: dict[str, QbCatalogNode] = {}
        catalog_outcomes: dict[str, str] = {}
        for item in target_catalogs:
            external_id = str(item['external_id'])
            row = catalogs_by_external.get(external_id)
            values = {
                'textbook_id': local_textbook_id,
                'parent_id': None,
                'node_name': item['node_name'],
                'node_type': item['node_type'],
                'source_url': item['source_url'],
                'sort_order': item['sort_order'],
                'status': '0',
                'last_seen_at': item['last_seen_at'],
            }
            if snapshot.get('task_id'):
                values['last_sync_batch_id'] = int(snapshot['task_id'])
            if row is None:
                row = QbCatalogNode(
                    source_provider=PROVIDER,
                    external_node_id=external_id,
                    create_time=now,
                    update_time=now,
                    **values,
                )
                db.add(row)
                await db.flush()
                catalogs_by_external[external_id] = row
                stats['catalogs']['inserted'] += 1
                catalog_outcomes[external_id] = 'inserted'
            else:
                changed = {key: value for key, value in values.items() if not _same(getattr(row, key), value)}
                if changed:
                    for key, value in changed.items():
                        setattr(row, key, value)
                    row.update_time = now
                    stats['catalogs']['updated'] += 1
                    catalog_outcomes[external_id] = 'updated'
                else:
                    stats['catalogs']['unchanged'] += 1
                    catalog_outcomes[external_id] = 'unchanged'
            catalog_map[external_id] = row
        for item in target_catalogs:
            parent_external_id = item['parent_external_id']
            row = catalog_map[item['external_id']]
            parent_id = catalog_map[parent_external_id].catalog_id if parent_external_id else None
            if row.parent_id != parent_id:
                row.parent_id = parent_id
                row.update_time = now
                # Parent IDs are resolved only after every target node has a
                # stable local primary key. Convert this row's own unchanged
                # outcome to updated without double-counting inserted rows or
                # rows already changed by another field.
                if catalog_outcomes[item['external_id']] == 'unchanged':
                    stats['catalogs']['unchanged'] -= 1
                    stats['catalogs']['updated'] += 1
                    catalog_outcomes[item['external_id']] = 'updated'
        for row in old_scope_catalogs:
            if str(row.external_node_id or '') not in target_external_ids and str(row.status or '0') != '1':
                row.status = '1'
                row.update_time = now
                stats['catalogs']['disabled'] += 1
        await db.flush()
        scope_catalog_rows = [row for row in catalogs_by_external.values() if int(row.textbook_id) == local_textbook_id]
        scope_catalog_ids = {int(row.catalog_id) for row in scope_catalog_rows}

        formal_questions = list((await db.execute(select(QbQuestion).where(QbQuestion.subject_id == 1, QbQuestion.source_provider == PROVIDER))).scalars().all())
        questions_by_external = {str(row.external_question_id): row for row in formal_questions if row.external_question_id}
        question_map: dict[str, QbQuestion] = {}
        question_fields = (
            'source_url', 'source_question_no', 'source_text', 'paper_name', 'academic_year', 'year', 'grade', 'term',
            'province', 'city', 'district', 'school_name', 'exam_type', 'question_type', 'difficulty',
            'difficulty_coefficient', 'score', 'content_html', 'plain_text', 'answer_html', 'analysis_html',
            'answer_status', 'subquestion_count', 'website_time_text',
            'external_updated_at', 'assemble_count', 'reference_count', 'reference_papers_json', 'is_fresh',
            'content_hash', 'raw_data_json', 'last_seen_at',
        )
        for item in snapshot['questions']:
            external_id = str(item['external_id'])
            row = questions_by_external.get(external_id)
            values = {field: item[field] for field in question_fields}
            unknown_answer = _answer_is_unknown(item)
            if unknown_answer and row is not None:
                # ``unknown`` means this run did not provide credible public
                # answer evidence.  Preserve a solution already present in
                # the formal table; an incremental crawl must not erase it
                # merely because answer collection was disabled or omitted
                # for this managed run.
                # Restricted/public statuses remain in ``values`` and retain
                # their existing replacement/clearing semantics.
                values.pop('answer_html')
                values.pop('analysis_html')
                values.pop('answer_status')
            elif unknown_answer:
                # New questions still start with an explicitly empty unknown
                # answer, even if an older/hand-built snapshot carries
                # untrusted answer fields alongside that status.
                values['answer_html'] = None
                values['analysis_html'] = None
                values['answer_status'] = 'unknown'
            values['status'] = '0'
            if snapshot.get('task_id'):
                values['last_sync_batch_id'] = int(snapshot['task_id'])
            if row is None:
                row = QbQuestion(
                    source_provider=PROVIDER,
                    external_question_id=external_id,
                    create_time=now,
                    update_time=now,
                    **values,
                )
                db.add(row)
                await db.flush()
                questions_by_external[external_id] = row
                stats['questions']['inserted'] += 1
            else:
                changed = {key: value for key, value in values.items() if not _same(getattr(row, key), value)}
                if changed:
                    for key, value in changed.items():
                        setattr(row, key, value)
                    row.update_time = now
                    stats['questions']['updated'] += 1
                else:
                    stats['questions']['unchanged'] += 1
            question_map[external_id] = row
        await db.flush()

        old_relations = list((await db.execute(
            select(QbQuestionCatalog).where(
                QbQuestionCatalog.catalog_id.in_(scope_catalog_ids),
                QbQuestionCatalog.relation_type == 'query_catalog',
            )
        )).scalars().all()) if scope_catalog_ids else []
        question_by_id = {int(row.question_id): row for row in formal_questions if row.question_id is not None}
        # The relationship table intentionally has no provider column.  A
        # relation to a manually authored question must therefore be guarded
        # by the question's provider (and an untagged/manual relation remains
        # conservative even if it points at a synced question).
        old_question_ids = {
            int(row.question_id)
            for row in old_relations
            if str(getattr(question_by_id.get(int(row.question_id)), 'source_provider', '') or '') == PROVIDER
        }
        desired: dict[tuple[int, int, str, str], dict[str, Any]] = {}
        for item in snapshot['question_catalogs']:
            question_id = int(question_map[item['question_external_id']].question_id)
            catalog_id = int(catalog_map[item['catalog_external_id']].catalog_id)
            key = (question_id, catalog_id, 'query_catalog', item['evidence_type'])
            desired[key] = item
        old_by_key = {
            (int(row.question_id), int(row.catalog_id), str(row.relation_type), str(row.evidence_type)): row
            for row in old_relations
            if str(getattr(question_by_id.get(int(row.question_id)), 'source_provider', '') or '') == PROVIDER
        }
        for key, row in old_by_key.items():
            if str(getattr(question_by_id.get(key[0]), 'external_question_id', '')) in snapshot.get('excluded_question_ids', set()):
                continue
            relation_managed = getattr(row, 'last_sync_batch_id', None) is not None
            if key not in desired and relation_managed:
                await db.delete(row)
                stats['questionCatalogs']['removed'] += 1
        for key, item in desired.items():
            row = old_by_key.get(key)
            if row is None:
                db.add(QbQuestionCatalog(
                    question_id=key[0], catalog_id=key[1], relation_type=key[2], evidence_type=key[3],
                    sort_order=item['sort_order'], last_seen_at=item['last_seen_at'],
                    last_sync_batch_id=int(snapshot.get('task_id') or 0) or None,
                    create_time=now, update_time=now,
                ))
                stats['questionCatalogs']['inserted'] += 1
            else:
                if getattr(row, 'last_sync_batch_id', None) is None:
                    # Relationships do not have a provider column.  Preserve
                    # an untagged/manual relation instead of taking it over.
                    stats['questionCatalogs']['unchanged'] += 1
                    continue
                changed = {}
                for field in ('sort_order', 'last_seen_at'):
                    if not _same(getattr(row, field), item[field]):
                        changed[field] = item[field]
                if getattr(row, 'last_sync_batch_id', None) != int(snapshot.get('task_id') or 0):
                    changed['last_sync_batch_id'] = int(snapshot.get('task_id') or 0) or None
                if changed:
                    for field, value in changed.items():
                        setattr(row, field, value)
                    row.update_time = now
                    stats['questionCatalogs']['updated'] += 1
                else:
                    stats['questionCatalogs']['unchanged'] += 1
        await db.flush()

        target_question_ids = old_question_ids | {int(row.question_id) for row in question_map.values()}
        target_question_ids -= {int(row.question_id) for row in formal_questions
                                if str(row.external_question_id) in snapshot.get('excluded_question_ids', set())}
        if target_question_ids:
            enabled_query = select(QbQuestionCatalog.question_id).join(
                QbCatalogNode, QbCatalogNode.catalog_id == QbQuestionCatalog.catalog_id
            ).where(
                QbQuestionCatalog.question_id.in_(target_question_ids),
                QbQuestionCatalog.relation_type == 'query_catalog',
                QbCatalogNode.status == '0',
            ).distinct()
            enabled_result = await db.execute(enabled_query)
            enabled_rows = enabled_result.all() if callable(getattr(enabled_result, 'all', None)) else []
            enabled_ids: set[int] = set()
            for value in enabled_rows:
                try:
                    raw_value = value[0]
                except (IndexError, KeyError, TypeError):
                    raw_value = value
                enabled_ids.add(int(raw_value))
            question_rows = list((await db.execute(select(QbQuestion).where(QbQuestion.question_id.in_(target_question_ids)))).scalars().all())
            for row in question_rows:
                if str(row.source_provider or '') != PROVIDER:
                    # Manual/other-provider questions may be related to a
                    # synced catalog, but their status is outside this
                    # provider's apply boundary.
                    continue
                qid = int(row.question_id)
                if qid in enabled_ids:
                    if str(row.status or '0') != '0':
                        row.status = '0'
                        row.update_time = now
                        stats['questions']['updated'] += 1
                elif qid in target_question_ids and str(row.status or '0') != '1':
                    row.status = '1'
                    row.update_time = now
                    stats['questions']['disabled'] += 1

        # A global question row can be shared by several textbook scopes.  Do
        # not erase tags/assets that are still owned by another enabled scope.
        desired_tags: dict[int, list[dict[str, Any]]] = {}
        desired_assets: dict[int, list[dict[str, Any]]] = {}
        for item in snapshot['tags']:
            desired_tags.setdefault(int(question_map[item['question_external_id']].question_id), []).append(item)
        for item in snapshot['assets']:
            desired_assets.setdefault(int(question_map[item['question_external_id']].question_id), []).append(item)
        # Tags/assets have no textbook column in the seven-table schema.  Work
        # out ownership from active catalog relations: an exclusive question
        # may have its source rows replaced, while a shared question only gets
        # additive updates so another textbook's data is never erased.
        affected_question_ids = target_question_ids
        all_active_relations: list[QbQuestionCatalog] = []
        if affected_question_ids:
            relation_result = await db.execute(
                select(QbQuestionCatalog).where(
                    QbQuestionCatalog.question_id.in_(affected_question_ids),
                    QbQuestionCatalog.relation_type == 'query_catalog',
                )
            )
            all_active_relations = list(relation_result.scalars().all())
        # Include rows inserted/re-enabled above.  ``catalog_rows`` is the
        # pre-apply query and therefore cannot by itself describe a newly
        # created target catalog.
        catalog_book_by_id = {
            int(row.catalog_id): int(row.textbook_id)
            for row in [*catalog_rows, *catalog_map.values()]
            if row.catalog_id is not None and row.textbook_id is not None
        }
        active_catalog_ids = {
            int(row.catalog_id)
            for row in [*catalog_rows, *catalog_map.values()]
            if row.catalog_id is not None and str(row.status or '0') == '0'
        }
        relation_books: dict[int, set[int]] = {}
        for relation in all_active_relations:
            catalog_id = int(relation.catalog_id)
            if catalog_id in active_catalog_ids:
                textbook_id = catalog_book_by_id.get(catalog_id)
                if textbook_id is not None:
                    relation_books.setdefault(int(relation.question_id), set()).add(textbook_id)
        exclusive_ids = {
            qid
            for qid in affected_question_ids
            if not relation_books.get(qid) or relation_books[qid] == {local_textbook_id}
        }
        for qid in affected_question_ids:
            replace_rows = qid in exclusive_ids
            current_tags = list((await db.execute(select(QbQuestionTag).where(QbQuestionTag.question_id == qid))).scalars().all())
            desired_tag_values = desired_tags.get(qid, [])
            desired_tag_keys = {
                (item['tag_type'], item['tag_name'], item['evidence_type'], item.get('relation_type', 'provider_asserted')): item
                for item in desired_tag_values
            }
            current_tag_keys = {
                (
                    str(row.tag_type),
                    str(row.tag_name),
                    str(row.evidence_type),
                    str(getattr(row, 'relation_type', 'provider_asserted') or 'provider_asserted'),
                ): row
                for row in current_tags
            }
            for key, row in current_tag_keys.items():
                if replace_rows and key not in desired_tag_keys and getattr(row, 'last_sync_batch_id', None) is not None:
                    await db.delete(row)
                    stats['tags']['removed'] += 1
            for key, item in desired_tag_keys.items():
                row = current_tag_keys.get(key)
                if row is None:
                    db.add(QbQuestionTag(
                        question_id=qid, tag_type=key[0], tag_name=key[1], evidence_type=key[2], relation_type=key[3],
                        sort_order=item['sort_order'], last_seen_at=item['last_seen_at'],
                        last_sync_batch_id=int(snapshot.get('task_id') or 0) or None,
                        create_time=now, update_time=now,
                    ))
                    stats['tags']['inserted'] += 1
                elif getattr(row, 'last_sync_batch_id', None) is None:
                    # Tags predate provider columns.  A NULL sync batch is
                    # the only conservative evidence that a same-key row is
                    # human-owned; never update or claim it during sync.
                    stats['tags']['unchanged'] += 1
                else:
                    changed = {}
                    for field in ('relation_type', 'sort_order', 'last_seen_at'):
                        if not _same(getattr(row, field), item[field]):
                            changed[field] = item[field]
                    if getattr(row, 'last_sync_batch_id', None) != int(snapshot.get('task_id') or 0):
                        changed['last_sync_batch_id'] = int(snapshot.get('task_id') or 0) or None
                    if changed:
                        for field, value in changed.items():
                            setattr(row, field, value)
                        row.update_time = now
                        stats['tags']['updated'] += 1
                    else:
                        stats['tags']['unchanged'] += 1
            current_assets = list((await db.execute(select(QbQuestionAsset).where(QbQuestionAsset.question_id == qid))).scalars().all())
            desired_asset_values = desired_assets.get(qid, [])
            desired_asset_keys = {item['asset_key']: item for item in desired_asset_values}
            current_asset_keys = {str(row.asset_key): row for row in current_assets}
            for key, row in current_asset_keys.items():
                if (
                    replace_rows
                    and key not in desired_asset_keys
                    and str(getattr(row, 'source_provider', '') or '') == PROVIDER
                    and getattr(row, 'last_sync_batch_id', None) is not None
                ):
                    await db.delete(row)
                    stats['assets']['removed'] += 1
            for key, item in desired_asset_keys.items():
                row = current_asset_keys.get(key)
                if row is not None and str(getattr(row, 'source_provider', '') or '') != PROVIDER:
                    # Assets do carry a provider column.  A same-key manual
                    # asset must not be overwritten merely because the
                    # provider question has a new snapshot row.
                    stats['assets']['unchanged'] += 1
                    continue
                values = {
                    'source_provider': PROVIDER, 'asset_type': item['asset_type'], 'source_url': item['source_url'],
                    'storage_path': item['storage_path'], 'mime_type': item['mime_type'], 'file_name': item['file_name'],
                    'file_hash': item['file_hash'], 'width': item['width'], 'height': item['height'],
                    'sort_order': item['sort_order'], 'download_status': item['download_status'],
                    'error_message': item['error_message'], 'last_seen_at': item['last_seen_at'],
                    'last_sync_batch_id': int(snapshot.get('task_id') or 0) or None,
                }
                if row is None:
                    db.add(QbQuestionAsset(question_id=qid, asset_key=key, create_time=now, update_time=now, **values))
                    stats['assets']['inserted'] += 1
                else:
                    changed = {field: value for field, value in values.items() if not _same(getattr(row, field), value)}
                    if changed:
                        for field, value in changed.items():
                            setattr(row, field, value)
                        row.update_time = now
                        stats['assets']['updated'] += 1
                    else:
                        stats['assets']['unchanged'] += 1
        await db.flush()
        return stats


__all__ = [
    'QuestionApplyService',
    '_normalise_snapshot',
    '_normalise_snapshot_summary',
    '_read_snapshot_summary',
]
