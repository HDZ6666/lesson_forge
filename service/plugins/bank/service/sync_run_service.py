"""Orchestrate bank synchronization through the collector HTTP service.

The service owns task state in MySQL while the collector owns immutable
metadata/content snapshots.  No collector database or local crawler process
is used here.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import time
import urllib.error
from collections import deque
from collections.abc import Mapping
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from config.database import DataSourceRegistry
from exceptions.exception import ServiceException
from plugins.bank.dao.sync_job_dao import SyncJobDao
from plugins.bank.dao.sync_task_dao import SyncTaskDao
from plugins.bank.entity.do.bank_do import QbSyncJob, QbSyncJobScope, QbTextbook, QbTextbookVersion
from plugins.bank.entity.vo.bank_vo import (
    SyncContentRunStartRequestModel,
    SyncRunModel,
    SyncRunPageQueryModel,
    SyncRunStartRequestModel,
)
from plugins.bank.service.collector_client import CollectorClient
from plugins.bank.service.question_apply_service import _normalise_snapshot_summary

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


PROVIDER = 'zujuan'
SOURCE_HOST = 'zujuan.xkw.com'
SOURCE_BANK_PATH = 'czsx'
MAX_LOG_LINES = 160
MAX_LOG_CHARS = 24000
PROCESS_POLL_SECONDS = 0.8
WORKER_HEARTBEAT_TIMEOUT_SECONDS = 30.0
# Startup recovery is deliberately retried while the service is alive.  A
# one-shot startup hook cannot know whether a recent heartbeat belongs to a
# worker that died just before restart; the delayed pass safely marks that row
# interrupted once the heartbeat lease expires.
RECOVERY_MONITOR_INTERVAL_SECONDS = max(1.0, min(10.0, WORKER_HEARTBEAT_TIMEOUT_SECONDS / 3))
SITE_PAGE_LIMIT = 1000
MAX_SELECTED_TEXTBOOKS = 200
SYNC_RUN_TYPES = frozenset({'metadata', 'content'})
MAX_PARTIAL_RUN_SCAN = 50
TRANSIENT_ERROR_RE = re.compile(
    r'(?:timeout|timed\s*out|etimedout|econnreset|econnrefused|enetunreach|eai_again|network|fetch\s+failed|'
    r'gateway\s+(?:timeout|error)|http\s*[45]0[234]|(?:网络|连接|超时|暂时不可用|读取失败|请求失败))',
    re.IGNORECASE,
)
AUTO_RESUME_MAX_ATTEMPTS = 3
AUTO_RESUME_HARD_MAX_ATTEMPTS = 10
AUTO_RESUME_DELAYS_SECONDS = (30, 90, 300)
MAX_LIVE_PROJECTION_NODES = 1000
MAX_LIVE_PROJECTION_BYTES = 4 * 1024 * 1024


def _exception_message(exc: BaseException, fallback: str) -> str:
    """Return the public message carried by the project's service errors."""

    message = exc.message or exc.data if isinstance(exc, ServiceException) else str(exc)
    return str(message or fallback)[:2000]


def _jsonable(value: Any) -> Any:
    """Convert server-owned option values into JSON-safe primitives."""

    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_jsonable(item) for item in value]
    return str(value)


def _stable_json(value: Any) -> str:
    return json.dumps(_jsonable(value), ensure_ascii=False, sort_keys=True, separators=(',', ':'))


_WORKERS: dict[int, _WorkerHandle] = {}
_RECOVERY_MONITOR_TASK: asyncio.Task[None] | None = None
_RECOVERY_IN_PROGRESS = False
_QUEUE_OWNER: ContextVar[tuple[int, str] | None] = ContextVar('bank_queue_owner', default=None)


class WorkerOwnershipLost(ServiceException):
    """A successor owns this dispatch; the old worker must stop writing."""


class DispatchDeferred(ServiceException):
    """Collector explicitly declined a start; keep the same waiting task."""


class DispatchAckPending(ServiceException):
    """Collector may have accepted the UUID; replay it before freeing the slot."""


@dataclass
class _WorkerHandle:
    """In-process cancellation identity for one task.

    The worker token and remote collector job ID are kept here so a restart
    can safely resume polling the server-owned job.
    """

    token: str
    task: asyncio.Task[None] | None = None
    remote_job_id: str | None = None
    recovered: bool = False
    terminate_sent: bool = False
    log_lines: deque[str] = field(default_factory=lambda: deque(maxlen=MAX_LOG_LINES))
    last_persist: float = 0.0
    progress_writes: dict = field(default_factory=dict)
    options_compacted: bool = False
    # These fields are populated by the creator and are also reconstructed
    # from the durable row when a worker is recovered after a restart.
    run_type: str = 'metadata'
    task_module: str = 'center'
    metadata_run_id: int | None = None
    textbook_external_ids: list[str] = field(default_factory=list)
    # Server-resolved textbook identity used by independent question tasks.
    # This is rebuilt from durable scope rows/options during recovery.
    textbook_scopes: list[dict[str, Any]] = field(default_factory=list)
    # A same-ID resume request sets this marker so the remote adapter can
    # omit already completed scopes from the newly-created collector job.
    resumed: bool = False
    # A per-task question collection policy. Rehydrate this from options_json
    # so retries/resumes keep the same page-limit mode.
    limit_to_1000_pages: bool = False
    workflow_version: int = 1
    dispatch_job_id: str | None = None

def _max_pages() -> int:
    """Allow an operator/test environment to reduce the site page ceiling."""

    raw = os.environ.get('BANK_SYNC_MAX_PAGES')
    if not raw:
        return SITE_PAGE_LIMIT
    try:
        value = int(raw)
    except ValueError as exc:
        raise ServiceException(message='配置的 BANK_SYNC_MAX_PAGES 必须是整数') from exc
    if value < 1 or value > SITE_PAGE_LIMIT:
        raise ServiceException(message=f'配置的 BANK_SYNC_MAX_PAGES 必须在 1 到 {SITE_PAGE_LIMIT} 之间')
    return value

def _safe_external_id(value: object) -> bool:
    text = str(value or '').strip()
    return bool(text and re.fullmatch(r'(?:\d+|[A-Za-z0-9][A-Za-z0-9._-]{0,63})', text))


def _metadata_value(row: Mapping[str, Any] | object, *names: str, default: Any = None) -> Any:
    """Read a metadata field from a collector API shape or test double."""

    for name in names:
        if isinstance(row, Mapping):
            if name in row:
                return row[name]
        else:
            # Collector/API test doubles may expose attributes instead of a
            # mapping interface.
            try:
                return row[name]  # type: ignore[index]
            except (KeyError, IndexError, TypeError):
                if hasattr(row, name):
                    return getattr(row, name)
    return default


def _metadata_raw_objects(row: Mapping[str, Any] | object, textbook_id: str) -> list[Mapping[str, Any]]:
    """Return the structured raw metadata containers, rejecting bad JSON."""

    raw_value = _metadata_value(row, 'raw_json', 'rawJson', default=None)
    if raw_value in (None, ''):
        return []
    if isinstance(raw_value, Mapping):
        payload: Any = raw_value
    else:
        try:
            payload = json.loads(str(raw_value))
        except (TypeError, json.JSONDecodeError) as exc:
            raise ServiceException(message=f'教材 {textbook_id} 的 raw_json 不是有效对象') from exc
    if not isinstance(payload, Mapping):
        raise ServiceException(message=f'教材 {textbook_id} 的 raw_json 不是有效对象')
    nested = payload.get('raw')
    if nested is not None and not isinstance(nested, Mapping):
        raise ServiceException(message=f'教材 {textbook_id} 的 raw_json.raw 不是有效对象')
    return [payload, nested] if isinstance(nested, Mapping) else [payload]


def _validate_textbook_locator(
    value: object,
    textbook_id: str,
    *,
    field: str,
    allow_relative: bool,
) -> str:
    """Validate a source textbook URL/href against its own stable ID."""

    text = str(value or '').strip()
    expected_path = f'/{SOURCE_BANK_PATH}/zj{textbook_id}/'
    try:
        parsed = urlsplit(text)
        port = parsed.port
    except ValueError as exc:
        raise ServiceException(message=f'教材 {textbook_id} 的 {field} 不是合法入口') from exc
    is_absolute = bool(parsed.scheme or parsed.netloc)
    if is_absolute:
        if (
            parsed.scheme.lower() != 'https'
            or parsed.hostname != SOURCE_HOST
            or port not in (None, 443)
            or parsed.username is not None
            or parsed.password is not None
        ):
            raise ServiceException(message=f'教材 {textbook_id} 的 {field} 来源不受支持')
    elif not allow_relative or not text.startswith('/'):
        raise ServiceException(message=f'教材 {textbook_id} 的 {field} 不是合法入口')
    if parsed.path != expected_path or parsed.query or parsed.fragment:
        raise ServiceException(message=f'教材 {textbook_id} 的 {field} 与教材 ID 不匹配')
    return text


def _validate_metadata_textbook_entry(  # noqa: PLR0912
    row: Mapping[str, Any] | object, textbook_id: str
) -> str | None:
    """Validate available source identifiers; a bootstrap chapter is optional."""

    structured_url = _metadata_value(row, 'source_url', 'sourceUrl', default=None)
    if structured_url not in (None, ''):
        _validate_textbook_locator(
            structured_url,
            textbook_id,
            field='source_url',
            allow_relative=False,
        )

    raw_objects = _metadata_raw_objects(row, textbook_id)
    for raw in raw_objects:
        for raw_id_name in ('externalTextbookId', 'external_textbook_id'):
            raw_id = raw.get(raw_id_name)
            if raw_id not in (None, '') and str(raw_id).strip() != textbook_id:
                raise ServiceException(message=f'教材 {textbook_id} 的来源 ID 与教材快照不匹配')
        for source_name in ('sourceUrl', 'source_url'):
            source_url = raw.get(source_name)
            if source_url not in (None, ''):
                _validate_textbook_locator(
                    source_url,
                    textbook_id,
                    field='raw_json.source_url',
                    allow_relative=False,
                )
        for href_name in ('href',):
            href = raw.get(href_name)
            if href not in (None, ''):
                _validate_textbook_locator(
                    href,
                    textbook_id,
                    field='raw_json.href',
                    allow_relative=True,
                )
        attributes = raw.get('attributes')
        if attributes is not None and not isinstance(attributes, Mapping):
            raise ServiceException(message=f'教材 {textbook_id} 的 raw_json.attributes 不是有效对象')
        if isinstance(attributes, Mapping):
            href = attributes.get('href')
            if href not in (None, ''):
                _validate_textbook_locator(
                    href,
                    textbook_id,
                    field='raw_json.attributes.href',
                    allow_relative=True,
                )
            chapter_id = attributes.get('chapter-id')
            if chapter_id not in (None, ''):
                chapter_text = str(chapter_id).strip()
                if not _safe_external_id(chapter_text) or chapter_text != textbook_id:
                    raise ServiceException(message=f'教材 {textbook_id} 的 raw_json.chapter-id 与教材 ID 不匹配')
        chapter_id = raw.get('chapter-id')
        if chapter_id not in (None, ''):
            chapter_text = str(chapter_id).strip()
            if not _safe_external_id(chapter_text) or chapter_text != textbook_id:
                raise ServiceException(message=f'教材 {textbook_id} 的 raw_json.chapter-id 与教材 ID 不匹配')

    # An explicit source_url or raw href is checked above.  If an old collector
    # schema has neither, the stable textbook ID still deterministically maps
    # to the provider's textbook page and is the supported sync entry.
    bootstrap = str(
        _metadata_value(row, 'bootstrap_chapter_external_id', 'bootstrapChapterExternalId', default='') or ''
    ).strip()
    if bootstrap and not _safe_external_id(bootstrap):
        raise ServiceException(message=f'教材 {textbook_id} 的入口章节 ID 不安全')
    return bootstrap or None



def _has_safe_partial_progress(summary: Mapping[str, Any]) -> bool:
    """Require a usable immutable page snapshot before offering resume.

    A tag/asset/progress counter alone is not enough: the Collector clone
    contract needs the core catalog, question and question-catalog tables to
    be non-empty. These exact scoped counts are authoritative for the remote
    bounded summary reader.
    """

    def positive(value: Any) -> bool:
        try:
            return int(value or 0) > 0
        except (TypeError, ValueError):
            return False

    counts = summary.get('counts') if isinstance(summary.get('counts'), Mapping) else {}
    core_aliases = (
        ('catalogItemCount', 'catalogs', 'catalogCount'),
        ('questionItemCount', 'questions', 'questionCount'),
        ('questionCatalogCount', 'questionCatalogs', 'relationCount'),
    )
    if counts:
        return all(positive(next((counts[name] for name in aliases if name in counts), 0)) for aliases in core_aliases)
    run = summary.get('run') if isinstance(summary.get('run'), Mapping) else {}
    return all(
        positive(next((run[name] for name in aliases if name in run), 0))
        for aliases in (
            ('catalog_item_count', 'catalogItemCount', 'catalog_count', 'catalogCount'),
            ('question_item_count', 'questionItemCount', 'question_count', 'questionCount'),
            ('question_catalog_count', 'questionCatalogCount', 'relation_count', 'relationCount'),
        )
    )


def _is_transient_error(message: Any) -> bool:
    return bool(TRANSIENT_ERROR_RE.search(str(message or '')))



def _tail_text(lines: deque[str] | list[str]) -> str:
    text = '\n'.join(lines)
    if len(text) > MAX_LOG_CHARS:
        text = text[-MAX_LOG_CHARS:]
        newline = text.find('\n')
        if newline >= 0:
            text = text[newline + 1 :]
    return text


def _status_from_row(
    row: QbSyncJob | Mapping[str, Any] | None, scopes: list[QbSyncJobScope] | list[Mapping[str, Any]] | None = None
) -> dict[str, Any] | None:
    if row is None:
        return None

    def read(value: Mapping[str, Any] | object, *names: str, default: Any = None) -> Any:
        for name in names:
            if isinstance(value, Mapping):
                if name in value:
                    return value[name]
            elif hasattr(value, name):
                return getattr(value, name)
        return default

    def scope_resume_source(scope: Mapping[str, Any] | object) -> Any:
        status = str(read(scope, 'status', 'state', default='') or '').lower()
        resume = read(scope, 'resume_from_collector_run_id', 'resumeFromCollectorRunId')
        if resume in (None, '') and status == 'interrupted':
            resume = read(scope, 'collector_run_id', 'collectorRunId')
        return _positive_collector_run_id(resume)

    scope_items = [
        {
            'scopeId': read(scope, 'scope_id', 'scopeId'),
            'runId': read(scope, 'run_id', 'runId'),
            'localVersionId': read(scope, 'local_version_id', 'localVersionId'),
            'localTextbookId': read(scope, 'local_textbook_id', 'localTextbookId'),
            'versionId': read(scope, 'local_version_id', 'localVersionId'),
            'textbookId': read(scope, 'local_textbook_id', 'localTextbookId'),
            'versionNameSnapshot': read(scope, 'version_name_snapshot', 'versionNameSnapshot'),
            'textbookNameSnapshot': read(scope, 'textbook_name_snapshot', 'textbookNameSnapshot'),
            'versionName': read(scope, 'version_name_snapshot', 'versionNameSnapshot'),
            'textbookName': read(scope, 'textbook_name_snapshot', 'textbookNameSnapshot'),
            'sourceProvider': read(scope, 'source_provider', 'sourceProvider'),
            'externalVersionId': read(scope, 'external_version_id', 'externalVersionId'),
            'externalTextbookId': read(scope, 'external_textbook_id', 'externalTextbookId'),
            'metadataRunId': read(scope, 'metadata_run_id', 'metadataRunId'),
            'collectorJobId': read(scope, 'collector_job_id', 'collectorJobId'),
            'collectorRunId': read(scope, 'collector_run_id', 'collectorRunId'),
            'resumeFromCollectorRunId': scope_resume_source(scope),
            'resumeAvailable': (
                str(read(scope, 'status', 'state', default='') or '').lower() in {'interrupted', 'blocked'}
                and scope_resume_source(scope) is not None
            ),
            'status': read(scope, 'status', 'state'),
            'catalogCount': read(scope, 'catalog_count', 'catalogCount', default=0) or 0,
            'questionCount': read(scope, 'question_count', 'questionCount', default=0) or 0,
            'questionCatalogCount': read(
                scope,
                'question_catalog_count',
                'questionCatalogCount',
                'relation_count',
                'relationCount',
                default=0,
            )
            or 0,
            'questionTagCount': read(
                scope,
                'question_tag_count',
                'questionTagCount',
                'tag_count',
                'tagCount',
                default=0,
            )
            or 0,
            'questionAssetCount': read(
                scope,
                'question_asset_count',
                'questionAssetCount',
                'asset_count',
                'assetCount',
                default=0,
            )
            or 0,
            'snapshotComplete': _status_flag(
                read(scope, 'snapshot_complete', 'snapshotComplete', 'complete', default=False)
            ),
            'scanComplete': _status_flag(
                read(scope, 'scan_complete', 'scanComplete', default=False)
            ),
            'dataComplete': _status_flag(
                read(scope, 'data_complete', 'dataComplete', default=False)
            ),
            'completionQuality': read(scope, 'completion_quality', 'completionQuality'),
            'snapshotLockedAt': read(scope, 'snapshot_locked_at', 'snapshotLockedAt', 'lockedAt'),
            'newCatalogCount': read(scope, 'new_catalog_count', 'newCatalogCount', default=0) or 0,
            'changedCatalogCount': read(scope, 'changed_catalog_count', 'changedCatalogCount', default=0) or 0,
            'newQuestionCount': read(scope, 'new_question_count', 'newQuestionCount', default=0) or 0,
            'changedQuestionCount': read(scope, 'changed_question_count', 'changedQuestionCount', default=0) or 0,
            'errorMessage': read(scope, 'error_message', 'errorMessage', 'error'),
            'startedAt': read(scope, 'started_at', 'startedAt'),
            'finishedAt': read(scope, 'finished_at', 'finishedAt'),
        }
        for scope in scopes or []
    ]
    resumable_scope_ids = [
        item.get('resumeFromCollectorRunId')
        for item in scope_items
        if item.get('status') in {'interrupted', 'blocked'}
        and _positive_collector_run_id(item.get('resumeFromCollectorRunId')) is not None
    ]
    options = read(row, 'options_json', 'optionsJson')
    if isinstance(options, str):
        try:
            parsed_options = json.loads(options)
        except (TypeError, json.JSONDecodeError):
            parsed_options = {}
        options = parsed_options
    if not isinstance(options, dict):
        options = {}
    acknowledge_source_policy = read(row, 'acknowledge_source_policy', 'acknowledgeSourcePolicy')
    module = read(row, 'task_module', 'taskModule') or 'center'
    progress = read(row, 'progress_percent', 'progressPercent', default=Decimal('0')) or Decimal('0')
    run_id = read(row, 'run_id', 'runId', 'task_id', 'taskId')
    data = {
        'runId': run_id,
        'taskId': run_id,
        'taskNo': str(run_id),
        'runType': read(row, 'run_type', 'runType') or 'metadata',
        'taskModule': module,
        'status': read(row, 'status') or 'queued',
        'phase': read(row, 'phase') or 'metadata',
        'acknowledgeSourcePolicy': acknowledge_source_policy == 'Y' or acknowledge_source_policy is True,
        'metadataRunId': read(row, 'metadata_run_id', 'metadataRunId'),
        'totalVersions': read(row, 'total_versions', 'totalVersions', default=0) or 0,
        'completedVersions': read(row, 'completed_versions', 'completedVersions', default=0) or 0,
        'totalTextbooks': read(row, 'total_textbooks', 'totalTextbooks', default=0) or 0,
        'completedTextbooks': read(row, 'completed_textbooks', 'completedTextbooks', default=0) or 0,
        'catalogCount': read(row, 'catalog_count', 'catalogCount', default=0) or 0,
        'newCatalogCount': read(row, 'new_catalog_count', 'newCatalogCount', default=0) or 0,
        'changedCatalogCount': read(row, 'changed_catalog_count', 'changedCatalogCount', default=0) or 0,
        'questionCount': read(row, 'question_count', 'questionCount', default=0) or 0,
        'questionCatalogCount': read(
            row,
            'question_catalog_count',
            'questionCatalogCount',
            'relation_count',
            'relationCount',
            default=0,
        )
        or 0,
        'questionTagCount': read(row, 'question_tag_count', 'questionTagCount', 'tag_count', 'tagCount', default=0)
        or 0,
        'questionAssetCount': read(
            row,
            'question_asset_count',
            'questionAssetCount',
            'asset_count',
            'assetCount',
            default=0,
        )
        or 0,
        'snapshotComplete': _status_flag(read(row, 'snapshot_complete', 'snapshotComplete', 'complete', default=False)),
        'snapshotLockedAt': read(row, 'snapshot_locked_at', 'snapshotLockedAt', 'lockedAt'),
        'newQuestionCount': read(row, 'new_question_count', 'newQuestionCount', default=0) or 0,
        'changedQuestionCount': read(row, 'changed_question_count', 'changedQuestionCount', default=0) or 0,
        'newVersionCount': read(row, 'new_version_count', 'newVersionCount', default=0) or 0,
        'newTextbookCount': read(row, 'new_textbook_count', 'newTextbookCount', default=0) or 0,
        'sourceTaskId': read(row, 'source_task_id', 'sourceTaskId'),
        'retryOfRunId': read(row, 'retry_of_run_id', 'retryOfRunId'),
        'retryOfTaskId': read(row, 'retry_of_run_id', 'retryOfTaskId'),
        'collectorJobId': read(row, 'collector_job_id', 'collectorJobId'),
        'versionId': options.get('versionId') or options.get('version_id'),
        'versionName': options.get('versionName') or options.get('version_name'),
        'textbookCount': len(scope_items) or read(row, 'total_textbooks', 'totalTextbooks', default=0) or 0,
        'textbookNames': [str(item.get('textbookName') or '') for item in scope_items],
        'scopeItems': scope_items,
        'scope': scope_items,
        'fetchedVersionCount': read(row, 'total_versions', 'totalVersions', default=0) or 0,
        'fetchedTextbookCount': read(row, 'total_textbooks', 'totalTextbooks', default=0) or 0,
        'currentTextbookId': read(row, 'current_textbook_id', 'currentTextbookId'),
        'currentTextbookName': read(row, 'current_textbook_name', 'currentTextbookName'),
        'progress': progress,
        'progressPercent': progress,
        'logTail': read(row, 'log_tail', 'logTail'),
        'errorMessage': read(row, 'error_message', 'errorMessage'),
        'createdBy': read(row, 'created_by', 'createdBy'),
        'startedAt': read(row, 'started_at', 'startedAt'),
        'finishedAt': read(row, 'finished_at', 'finishedAt'),
        'completedAt': read(row, 'finished_at', 'finishedAt'),
        'createTime': read(row, 'create_time', 'createTime'),
        'updateTime': read(row, 'update_time', 'updateTime'),
        'resumeFromCollectorRunId': (
            resumable_scope_ids[0] if len(resumable_scope_ids) == 1 else None
        ),
        'resumeAvailable': (
            str(read(row, 'status') or '').lower() in {'interrupted', 'blocked'}
            and bool(resumable_scope_ids)
        ),
    }
    # The legacy model intentionally contains only the original center
    # fields.  Return the richer task projection directly for independent
    # modules while preserving its validated shape for old callers.
    if module in {'textbook', 'question'}:
        from plugins.bank.service.task_service import task_payload  # noqa: PLC0415

        return task_payload(row, scopes)
    return SyncRunModel.model_validate(data).model_dump(by_alias=True)


def _scope_field(value: Mapping[str, Any] | object, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(value, Mapping):
            if name in value:
                return value[name]
        elif hasattr(value, name):
            return getattr(value, name)
    return default


def _scope_datetime(value: Any) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00')).replace(tzinfo=None)
        except ValueError:
            return None
    return None


def _scope_entity_from_payload(
    run_id: int,
    payload: Mapping[str, Any] | object,
    metadata_run_id: int | None,
    task_module: str,
) -> QbSyncJobScope:
    """Build a scope ORM entity from either snake or camel case fields."""

    status = str(_scope_field(payload, 'status', 'state', default='queued') or 'queued').lower()
    if status == 'cancelling':
        status = 'running'
    if status not in {
        'queued',
        'starting',
        'running',
        'completed',
        'failed',
        'blocked',
        'cancelled',
        'interrupted',
    }:
        raise ServiceException(message='教材范围状态不受支持')
    external_id = str(
        _scope_field(
            payload,
            'external_textbook_id',
            'externalTextbookId',
            'textbook_external_id',
            'textbookExternalId',
            default='',
        )
        or ''
    ).strip()
    if not _safe_external_id(external_id):
        raise ServiceException(message='教材来源 ID 不安全')
    provider = str(_scope_field(payload, 'source_provider', 'sourceProvider', 'provider', default=PROVIDER) or PROVIDER)
    # Question scopes are self-contained formal/external identities. A
    # historical metadata run on an old payload is deliberately ignored.
    scope_metadata_run_id = None if task_module == 'question' else _scope_field(
        payload,
        'metadata_run_id',
        'metadataRunId',
        default=metadata_run_id,
    )
    return QbSyncJobScope(
        run_id=run_id,
        local_version_id=_scope_field(payload, 'local_version_id', 'localVersionId', 'version_id', 'versionId'),
        local_textbook_id=_scope_field(payload, 'local_textbook_id', 'localTextbookId', 'textbook_id', 'textbookId'),
        version_name_snapshot=_scope_field(payload, 'version_name_snapshot', 'versionNameSnapshot', 'versionName'),
        textbook_name_snapshot=_scope_field(payload, 'textbook_name_snapshot', 'textbookNameSnapshot', 'textbookName'),
        source_provider=provider,
        external_version_id=_scope_field(payload, 'external_version_id', 'externalVersionId'),
        external_textbook_id=external_id,
        metadata_run_id=scope_metadata_run_id,
        collector_job_id=_scope_field(payload, 'collector_job_id', 'collectorJobId'),
        collector_run_id=_scope_field(payload, 'collector_run_id', 'collectorRunId'),
        resume_from_collector_run_id=_scope_field(
            payload,
            'resume_from_collector_run_id',
            'resumeFromCollectorRunId',
        ),
        status=status,
        catalog_count=max(0, int(_scope_field(payload, 'catalog_count', 'catalogCount', default=0) or 0)),
        question_count=max(0, int(_scope_field(payload, 'question_count', 'questionCount', default=0) or 0)),
        new_catalog_count=max(0, int(_scope_field(payload, 'new_catalog_count', 'newCatalogCount', default=0) or 0)),
        changed_catalog_count=max(
            0,
            int(_scope_field(payload, 'changed_catalog_count', 'changedCatalogCount', default=0) or 0),
        ),
        new_question_count=max(0, int(_scope_field(payload, 'new_question_count', 'newQuestionCount', default=0) or 0)),
        changed_question_count=max(
            0,
            int(_scope_field(payload, 'changed_question_count', 'changedQuestionCount', default=0) or 0),
        ),
        question_catalog_count=max(
            0,
            int(
                _scope_field(
                    payload,
                    'question_catalog_count',
                    'questionCatalogCount',
                    'relation_count',
                    'relationCount',
                    default=0,
                )
                or 0
            ),
        ),
        question_tag_count=max(
            0,
            int(_scope_field(payload, 'question_tag_count', 'questionTagCount', 'tag_count', 'tagCount', default=0) or 0),
        ),
        question_asset_count=max(
            0,
            int(_scope_field(payload, 'question_asset_count', 'questionAssetCount', 'asset_count', 'assetCount', default=0) or 0),
        ),
        snapshot_complete=bool(
            _scope_field(payload, 'snapshot_complete', 'snapshotComplete', 'complete', default=False)
        ),
        snapshot_locked_at=_scope_datetime(
            _scope_field(payload, 'snapshot_locked_at', 'snapshotLockedAt', 'locked_at', 'lockedAt')
        ),
        error_message=_scope_field(payload, 'error_message', 'errorMessage', 'error'),
        started_at=_scope_datetime(_scope_field(payload, 'started_at', 'startedAt')),
        finished_at=_scope_datetime(_scope_field(payload, 'finished_at', 'finishedAt')),
        create_time=_scope_datetime(_scope_field(payload, 'create_time', 'createTime')) or datetime.now(),
        update_time=_scope_datetime(_scope_field(payload, 'update_time', 'updateTime')) or datetime.now(),
    )


async def _load_row(run_id: int) -> QbSyncJob | None:
    async with DataSourceRegistry.session() as db:
        return await SyncJobDao.get(db, run_id)


async def _update_row(
    run_id: int,
    values: dict[str, Any],
    *,
    expected_statuses: tuple[str, ...] | None = None,
) -> bool:
    async with DataSourceRegistry.session() as db:
        owner = _QUEUE_OWNER.get()
        owner_kwargs = {'expected_worker_token': owner[1]} if owner and owner[0] == run_id else {}
        affected = await SyncJobDao.update_fields(
            db,
            run_id,
            values,
            expected_statuses=expected_statuses,
            **owner_kwargs,
        )
        await db.commit()
        return affected > 0


def _row_options(row: Mapping[str, Any] | object | None) -> dict[str, Any]:
    value = _scope_field(row, 'options_json', 'optionsJson', default={}) if row is not None else {}
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return {}
        return dict(parsed) if isinstance(parsed, Mapping) else {}
    return {}


def _bound_live_node(value: Any, budget: list[int]) -> dict[str, Any] | None:
    """Keep only renderable fields from one collector live-tree node."""

    if not isinstance(value, Mapping) or budget[0] <= 0:
        return None
    budget[0] -= 1
    output: dict[str, Any] = {}
    for key in (
        'nodeKey', 'externalId', 'externalCatalogId', 'textbookExternalId',
        'parentExternalId', 'level', 'nodeLevel', 'type', 'nodeType',
        'name', 'label', 'sourcePath', 'path', 'sortOrder',
        'expectedTotal', 'expected', 'total', 'collectedCount', 'collected',
        'listSeenCount', 'questionCount', 'expectedPages', 'lastCompletedPage',
        'status', 'queried', 'hasProgress', 'observedAt',
        'latestSourceTotal', 'sourceReportedTotal', 'uniqueQuestionCount',
        'occurrenceCount', 'targetPages', 'attemptedPages',
        'lastContiguousSuccessfulPage', 'highestAttemptedPage',
        'failedPageCount', 'duplicatePageCount', 'emptyPageCount',
        'parseErrorCount', 'assetErrorCount', 'scanComplete', 'dataComplete',
        'completionQuality', 'pageLimitReached', 'current',
    ):
        if key in value and value[key] is not None:
            output[key] = _jsonable(value[key])
    children = value.get('children')
    if isinstance(children, list) and budget[0] > 0:
        output['children'] = []
        for child in children:
            bounded = _bound_live_node(child, budget)
            if bounded is None:
                break
            output['children'].append(bounded)
    else:
        output['children'] = []
    return output


def _bound_fetch_windows(value: Any) -> list[dict[str, Any]]:
    """Keep the live 8-way fetch window compact enough for task JSON."""

    if not isinstance(value, list):
        return []
    windows: list[dict[str, Any]] = []
    for item in value[:4]:
        if not isinstance(item, Mapping):
            continue
        slots: list[dict[str, Any]] = []
        raw_slots = item.get('slots')
        if isinstance(raw_slots, list):
            for slot in raw_slots[:16]:
                if not isinstance(slot, Mapping):
                    continue
                page_number = slot.get('pageNumber', slot.get('page_number'))
                question_count = slot.get('questionCount', slot.get('question_count'))
                source_total = slot.get('sourceTotal', slot.get('source_total'))
                try:
                    slot_index = int(slot.get('slot') or slot.get('workerId') or 0)
                except (TypeError, ValueError, OverflowError):
                    slot_index = 0
                slots.append({
                    'slot': max(0, slot_index),
                    'pageNumber': page_number if isinstance(page_number, int) else (
                        int(page_number) if str(page_number).isdigit() else None
                    ),
                    'status': str(slot.get('status') or slot.get('slot_status') or 'fetching')[:32],
                    'questionCount': question_count if isinstance(question_count, int) else None,
                    'resultType': None if slot.get('resultType') in (None, '') else str(
                        slot.get('resultType') or slot.get('result_type')
                    )[:64],
                    'sourceTotal': source_total if isinstance(source_total, int) else None,
                    'line': str(slot.get('line') or slot.get('message') or '')[:240],
                    'updatedAt': slot.get('updatedAt') or slot.get('updated_at'),
                })
        windows.append({
            'catalogExternalId': str(item.get('catalogExternalId') or item.get('catalog_external_id') or '')[:128],
            'catalogName': str(item.get('catalogName') or item.get('catalog_name') or '')[:200],
            'catalogPath': str(item.get('catalogPath') or item.get('catalog_path') or '')[:400],
            'targetPages': item.get('targetPages', item.get('target_pages')),
            'latestSourceTotal': item.get('latestSourceTotal', item.get('sourceReportedTotal')),
            'updatedAt': item.get('updatedAt') or item.get('updated_at'),
            'slots': slots,
        })
    return windows


def _bound_live_projection(value: Any, *, include_tree: bool = True, max_nodes: int = MAX_LIVE_PROJECTION_NODES) -> dict[str, Any] | None:
    """Bound a collector live projection before persisting it in task JSON."""

    if not isinstance(value, Mapping):
        return None
    output: dict[str, Any] = {}
    scalar_keys = (
        'available', 'live', 'message', 'runId', 'collectorRunId',
        'textbookExternalId', 'status', 'startedAt', 'finishedAt',
        'summaryStrategy', 'textbookExpectedTotal',
        'firstRoundComplete', 'totalsKnown', 'statisticsPending',
        'totalQuestionCount', 'expectedQuestionCount', 'collectedQuestionCount',
        'uniqueQuestionCount', 'questionItemsAvailable', 'listSeenCount',
        'progressPercent', 'progress', 'chapterCount',
        'knowledgePointCount', 'secondaryKnowledgePointCount', 'catalogCount',
        'summaryCatalogLevel', 'summaryNodeCount', 'treeNodeCount', 'treeTruncated', 'treeAvailable',
        'scanComplete', 'dataComplete', 'completionQuality', 'snapshotComplete',
        'pageLimitReached',
        'latestSourceTotal', 'sourceReportedTotal',
    )
    for key in scalar_keys:
        if key in value:
            output[key] = _jsonable(value[key])
    level_counts = value.get('catalogLevelCounts')
    if isinstance(level_counts, Mapping):
        normalized_levels: dict[str, int] = {}
        for key, item in list(level_counts.items())[:32]:
            try:
                normalized_levels[str(key)[:32]] = max(0, int(item or 0))
            except (TypeError, ValueError, OverflowError):
                continue
        output['catalogLevelCounts'] = normalized_levels
    summary_ids = value.get('summaryCatalogIds')
    if isinstance(summary_ids, (list, tuple)):
        output['summaryCatalogIds'] = [str(item)[:128] for item in summary_ids[:MAX_LIVE_PROJECTION_NODES]]
    current_ids = value.get('currentCatalogIds')
    if isinstance(current_ids, (list, tuple)):
        output['currentCatalogIds'] = [str(item)[:128] for item in current_ids[:32]]
    fetch_windows = _bound_fetch_windows(value.get('fetchWindows') or value.get('fetch_windows'))
    if fetch_windows:
        output['fetchWindows'] = fetch_windows
    raw_tree = value.get('tree') or value.get('catalogs') or value.get('catalogTree')
    budget = [max(0, min(MAX_LIVE_PROJECTION_NODES, int(max_nodes or 0)))]
    tree: list[dict[str, Any]] = []
    if include_tree and isinstance(raw_tree, list) and budget[0] > 0:
        for node in raw_tree:
            bounded = _bound_live_node(node, budget)
            if bounded is None:
                break
            tree.append(bounded)
        # Persist only one tree field.  `catalogs`/`catalogTree` remain input
        # aliases for older collector responses, never stored copies.
        output['tree'] = tree
        if budget[0] <= 0 and raw_tree:
            output['treeTruncated'] = True
    try:
        encoded = json.dumps(output, ensure_ascii=False, separators=(',', ':'))
    except (TypeError, ValueError):
        return None
    if len(encoded.encode('utf-8')) > MAX_LIVE_PROJECTION_BYTES:
        if include_tree:
            output['tree'] = []
        output['treeTruncated'] = True
    return output


def _remote_live_projection(payload: Mapping[str, Any]) -> tuple[dict[str, Any] | None, dict[str, dict[str, Any]]]:
    """Extract and bound live data without making it part of scalar row state."""

    raw_scopes = payload.get('liveProgressByScope') or payload.get('live_progress_by_scope')
    scope_count = len(raw_scopes) if isinstance(raw_scopes, Mapping) else 0
    per_scope_nodes = max(
        1,
        min(
            MAX_LIVE_PROJECTION_NODES,
            MAX_LIVE_PROJECTION_NODES // max(1, min(MAX_SELECTED_TEXTBOOKS, scope_count)),
        ),
    )
    primary = _bound_live_projection(
        payload.get('liveProgress') or payload.get('live_progress'),
        max_nodes=per_scope_nodes,
    )
    if primary is not None and primary.get('available') is False:
        primary = None
    by_scope: dict[str, dict[str, Any]] = {}
    if isinstance(raw_scopes, Mapping):
        for key, item in list(raw_scopes.items())[:MAX_SELECTED_TEXTBOOKS]:
            bounded = _bound_live_projection(item, max_nodes=per_scope_nodes)
            if bounded is not None and bounded.get('available') is not False:
                by_scope[str(key)[:128]] = bounded
    if not by_scope and primary is not None:
        textbook_id = primary.get('textbookExternalId')
        if textbook_id not in (None, ''):
            by_scope[str(textbook_id)[:128]] = primary
    return primary, by_scope


async def _persist_live_progress(run_id: int, payload: Mapping[str, Any] | None) -> bool:
    try:
        return await _cache_live_progress(run_id, payload)
    except Exception:
        # UI/cache failures must never fail or cancel a collector task.
        return False


async def _cache_live_progress(run_id: int, payload: Mapping[str, Any] | None) -> bool:
    """Cache display data only; the collector remains the durable source."""
    if not isinstance(payload, Mapping):
        return False
    from plugins.bank.service import live_progress_cache as cache
    primary, by_scope = _remote_live_projection(payload)
    if primary is None and not by_scope:
        return False
    job_id = payload.get('id') or payload.get('jobId') or payload.get('job_id')
    if not job_id:
        return False
    return await cache.put(_live_cache_key(job_id, payload.get('status')), {
        'liveProgress': _bound_live_projection(primary, include_tree=False) if primary else None,
        'liveProgressByScope': by_scope,
        'progressUpdatedAt': datetime.now().isoformat(),
    })


def _live_cache_key(job_id, status):
    return f'bank:live:v2:{job_id}:{status}'


async def enrich_live_progress(payload: dict[str, Any]) -> dict[str, Any]:
    """Overlay a disposable projection without mutating an ORM record."""
    from plugins.bank.service import live_progress_cache as cache
    job_id = payload.get('collectorJobId')
    if not job_id:
        return payload
    async def load():
        try:
            client = CollectorClient()
            client.timeout = min(client.timeout, 3.0)
            remote = await asyncio.to_thread(client.job, job_id)
            if str(remote.get('id') or remote.get('jobId') or '') != str(job_id):
                return None
            primary, by_scope = _remote_live_projection(remote)
            if primary is None and not by_scope:
                return None
            return {
                'liveProgress': _bound_live_projection(primary, include_tree=False) if primary else None,
                'liveProgressByScope': by_scope,
                'progressUpdatedAt': datetime.now().isoformat(),
            }
        except Exception:
            return None
    live = await cache.get_or_load(_live_cache_key(job_id, payload.get('status')), load)
    if live is not None:
        payload.update(live)
        payload['pageLimitReached'] = any(
            bool(item.get('pageLimitReached')) for item in (live.get('liveProgressByScope') or {}).values()
        ) or bool((live.get('liveProgress') or {}).get('pageLimitReached'))
        payload['progressStale'] = False
    else:
        # Preserve a legacy last-known projection; never invent zero counts.
        payload['progressStale'] = True
    return payload


async def _compact_active_options(run_id: int) -> None:
    """Remove legacy live trees once, after a fresh collector response exists."""
    async with DataSourceRegistry.session() as db:
        row = (await db.execute(select(QbSyncJob).where(QbSyncJob.run_id == run_id)
                               .with_for_update())).scalars().first()
        if row is None or row.status not in ('starting', 'running', 'cancelling'):
            return
        owner = _QUEUE_OWNER.get()
        if owner and owner[0] == run_id and row.worker_token != owner[1]:
            raise WorkerOwnershipLost(message='同步任务执行权已被接管')
        options = _row_options(row)
        compact = dict(options)
        for key in ('liveProgress', 'live_progress', 'liveProgressByScope', 'live_progress_by_scope'):
            compact.pop(key, None)
        if isinstance(compact.get('scopeItems'), list):
            compact['scopeItems'] = [
                {k: v for k, v in item.items() if k not in ('liveProgress', 'live_progress')}
                if isinstance(item, dict) else item for item in compact['scopeItems']
            ]
        if compact != options:
            row.options_json = compact
            await db.commit()


def _progress_write_due(handle, key, values, *, now=None):
    """Changed counters every 5s; unchanged ownership heartbeat every 10s."""
    now = time.monotonic() if now is None else now
    previous = handle.progress_writes.get(key)
    fingerprint = _stable_json(values)
    important = tuple(values.get(k) for k in (
        'status', 'phase', 'current_textbook_id', 'collector_run_id',
        'snapshot_complete', 'error_message'))
    if previous is None:
        return True
    last_time, last_fingerprint, last_important = previous
    if key.startswith('scope:') and values.get('status') in _TERMINAL_SCOPE_STATUSES:
        # A terminal poll may add final counts after the status changed.
        return fingerprint != last_fingerprint
    return (important != last_important or now - last_time >=
            (5.0 if fingerprint != last_fingerprint else 10.0))


def _mark_progress_write(handle, key, values):
    handle.progress_writes[key] = (time.monotonic(), _stable_json(values), tuple(
        values.get(k) for k in ('status', 'phase', 'current_textbook_id', 'collector_run_id',
                               'snapshot_complete', 'error_message')))


async def _persist_progress_scope(handle, run_id, external_id, values):
    key = f'scope:{external_id}'
    if _progress_write_due(handle, key, values):
        await _persist_remote_scope(run_id, external_id, values)
        _mark_progress_write(handle, key, values)


def _auto_resume_enabled(options: Mapping[str, Any]) -> bool:
    value = options.get('autoResume', options.get('auto_resume', True))
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value or '').strip().lower() not in {'0', 'false', 'no', 'off', 'disabled'}


def _bounded_auto_resume_attempts(options: Mapping[str, Any]) -> int:
    value = options.get(
        'autoResumeMaxAttempts',
        options.get('auto_resume_max_attempts', AUTO_RESUME_MAX_ATTEMPTS),
    )
    try:
        return max(0, min(AUTO_RESUME_HARD_MAX_ATTEMPTS, int(value)))
    except (TypeError, ValueError):
        return AUTO_RESUME_MAX_ATTEMPTS


async def _mark_auto_resume_pending(run_id: int, collector_run_id: int) -> bool:
    """Persist one bounded transient retry for the recovery monitor.

    No timer lives only in process memory: ``autoResumeNextAt`` survives a
    service restart.  Blocked/challenge failures never call this helper.
    """

    row = await _load_row(run_id)
    if row is None or str(_scope_field(row, 'task_module', 'taskModule', default='') or '') != 'question':
        return False
    options = _row_options(row)
    if not _auto_resume_enabled(options):
        return False
    maximum = _bounded_auto_resume_attempts(options)
    try:
        attempted = max(0, int(options.get('autoResumeAttempt', options.get('auto_resume_attempt', 0)) or 0))
    except (TypeError, ValueError):
        attempted = 0
    if attempted >= maximum:
        options.update({'autoResumePending': False, 'autoResumeNextAt': None})
        await _update_row(run_id, {'options_json': options}, expected_statuses=('starting', 'running'))
        return False
    next_attempt = attempted + 1
    delay = AUTO_RESUME_DELAYS_SECONDS[min(next_attempt - 1, len(AUTO_RESUME_DELAYS_SECONDS) - 1)]
    next_at = datetime.now() + timedelta(seconds=delay)
    options.update(
        {
            'autoResume': True,
            'autoResumeMaxAttempts': maximum,
            'autoResumeAttempt': next_attempt,
            'autoResumePending': True,
            'autoResumeNextAt': next_at.isoformat(),
            'autoResumeSourceRunId': int(collector_run_id),
        }
    )
    return await _update_row(
        run_id,
        {'options_json': options},
        expected_statuses=('starting', 'running'),
    )


async def _update_scope_values(
    run_id: int,
    values: dict[str, Any],
    *,
    external_textbook_id: str | None = None,
    expected_statuses: tuple[str, ...] | None = None,
) -> bool:
    """Persist scope progress without making scope writes mandatory for the
    legacy center task.  Missing migration 006 is treated as a no-op here;
    the task row itself remains authoritative for old installations.
    """

    try:
        async with DataSourceRegistry.session() as db:
            owner = _QUEUE_OWNER.get()
            if owner and owner[0] == run_id:
                parent = await SyncTaskDao.get_for_update(db, run_id)
                if parent is None or parent.worker_token != owner[1]:
                    raise WorkerOwnershipLost(message='同步任务执行权已被接管')
            if external_textbook_id:
                result = await db.execute(
                    select(QbSyncJobScope).where(
                        QbSyncJobScope.run_id == run_id,
                        QbSyncJobScope.external_textbook_id == external_textbook_id,
                    )
                )
                scope = result.scalars().first()
                if scope is None:
                    return False
                affected = await SyncTaskDao.update_scope(
                    db,
                    int(scope.scope_id),
                    values,
                    expected_statuses=expected_statuses,
                )
            else:
                affected = await SyncTaskDao.update_scopes_for_run(
                    db,
                    run_id,
                    values,
                    expected_statuses=expected_statuses,
                )
            await db.commit()
            return affected > 0
    except WorkerOwnershipLost:
        raise
    except Exception:
        return False


async def _materialize_textbook_scopes(  # noqa: PLR0912, PLR0915
    run_id: int,
    metadata_run_id: int,
) -> None:
    """Store every textbook observed by a metadata task before completion.

    Scope rows are part of the task's durable completion contract. Any
    malformed/incomplete collector projection or database failure is raised
    to the worker so the parent task becomes explicitly failed instead of
    appearing completed without its immutable metadata binding.
    """

    payload = await asyncio.to_thread(CollectorClient().metadata_snapshot, metadata_run_id)
    if not isinstance(payload, Mapping) or payload.get('available') is not True:
        raise ServiceException(message='collector 元数据快照不可用')
    if payload.get('immutable') is not True:
        raise ServiceException(message='collector 元数据快照未锁定，无法物化教材范围')
    if not isinstance(payload.get('run'), Mapping):
        raise ServiceException(message='collector 元数据快照结构不正确')
    raw_versions = payload.get('versions')
    raw_textbooks = payload.get('textbooks')
    run_payload = payload.get('run')
    remote_run_id = _scope_field(run_payload, 'id', 'runId', 'metadataRunId', default=None)
    if isinstance(remote_run_id, bool) or _positive_collector_run_id(remote_run_id) != int(metadata_run_id):
        raise ServiceException(message=f'元数据运行 {metadata_run_id} 的 collector 运行 ID 不一致')
    run_status = str(_scope_field(run_payload, 'status', default='') or '').strip().lower()
    if run_status not in {'success', 'completed'}:
        raise ServiceException(message=f'元数据运行 {metadata_run_id} 未成功完成')
    if _scope_field(run_payload, 'snapshot_locked_at', 'snapshotLockedAt', 'locked', default=None) in (
        None,
        '',
        0,
        '0',
        False,
    ):
        raise ServiceException(message=f'元数据运行 {metadata_run_id} 尚未锁定')
    expected_textbooks = _scope_field(run_payload, 'textbook_count', 'textbookCount', default=None)
    if expected_textbooks is None:
        raise ServiceException(message='collector 元数据快照缺少教材数量')
    try:
        expected_textbooks = int(expected_textbooks)
    except (TypeError, ValueError) as exc:
        raise ServiceException(message='collector 元数据快照教材数量无效') from exc
    if not isinstance(raw_textbooks, list):
        raise ServiceException(message='collector 元数据教材快照结构不正确')
    if expected_textbooks < 0 or len(raw_textbooks) != expected_textbooks:
        raise ServiceException(
            message=(
                f'元数据运行 {metadata_run_id} 应包含 {expected_textbooks} 本教材，'
                f'实际读取 {len(raw_textbooks)} 本，无法完整物化教材范围'
            )
        )

    # Resolve local identities where possible; external identity remains
    # valid even when a formal row has not yet been published.
    async with DataSourceRegistry.session() as db:
        existing = await db.execute(select(QbSyncJobScope).where(QbSyncJobScope.run_id == run_id))
        existing_rows = list(existing.scalars().all())
        existing_by_key = {
            (str(item.source_provider or ''), str(item.external_textbook_id or '')): item for item in existing_rows
        }
        versions_map: dict[tuple[str, str], tuple[int | None, str | None]] = {}
        if raw_versions is not None and not isinstance(raw_versions, list):
            raise ServiceException(message='collector 元数据版本快照结构不正确')
        for value in raw_versions or []:
            if not isinstance(value, dict):
                raise ServiceException(message='collector 元数据版本快照包含无效条目')
            provider = str(value.get('provider') or value.get('sourceProvider') or PROVIDER)
            external = str(value.get('external_version_id') or value.get('externalVersionId') or '')
            versions_map[(provider, external)] = (None, value.get('version_name') or value.get('versionName'))
        version_external_ids = [key[1] for key in versions_map if key[0] == PROVIDER and key[1]]
        for value in raw_textbooks:
            if not isinstance(value, dict):
                raise ServiceException(message='collector 元数据教材快照包含无效条目')
            version_external = str(value.get('version_external_id') or value.get('versionExternalId') or '').strip()
            if version_external:
                version_external_ids.append(version_external)
        version_external_ids = list(dict.fromkeys(value for value in version_external_ids if value))
        textbook_external_ids: list[str] = []
        normalized_textbooks: list[tuple[dict[str, Any], str, str, str | None]] = []
        seen_external_ids: set[str] = set()
        for value in raw_textbooks:
            assert isinstance(value, dict)  # validated above for type checkers
            provider = str(value.get('provider') or value.get('sourceProvider') or PROVIDER)
            external = str(
                value.get('external_textbook_id')
                or value.get('externalTextbookId')
                or value.get('textbookExternalId')
                or ''
            ).strip()
            if provider != PROVIDER or not _safe_external_id(external) or external in seen_external_ids:
                raise ServiceException(
                    message=f'元数据运行 {metadata_run_id} 包含无效或重复教材 ID：{external or "缺少 ID"}'
                )
            seen_external_ids.add(external)
            version_external = (
                str(value.get('version_external_id') or value.get('versionExternalId') or '').strip() or None
            )
            textbook_external_ids.append(external)
            normalized_textbooks.append((value, provider, external, version_external))
        formal_versions: dict[str, QbTextbookVersion] = {}
        formal_textbooks: dict[str, QbTextbook] = {}
        if version_external_ids:
            formal_version_result = await db.execute(
                select(QbTextbookVersion).where(
                    QbTextbookVersion.subject_id == 1, QbTextbookVersion.source_provider == PROVIDER,
                    QbTextbookVersion.external_version_id.in_(version_external_ids),
                )
            )
            formal_versions = {str(item.external_version_id): item for item in formal_version_result.scalars().all()}
        if textbook_external_ids:
            formal_textbook_result = await db.execute(
                select(QbTextbook).where(
                    QbTextbook.subject_id == 1, QbTextbook.source_provider == PROVIDER,
                    QbTextbook.external_textbook_id.in_(textbook_external_ids),
                )
            )
            formal_textbooks = {str(item.external_textbook_id): item for item in formal_textbook_result.scalars().all()}
        for external_id, item in formal_versions.items():
            previous_name = versions_map.get((PROVIDER, external_id), (None, None))[1]
            versions_map[(PROVIDER, external_id)] = (int(item.version_id), previous_name or item.version_name)
        rows: list[QbSyncJobScope] = []
        for value, provider, external, version_external in normalized_textbooks:
            formal_textbook = formal_textbooks.get(external)
            formal_version = formal_versions.get(version_external or '')
            existing_scope = existing_by_key.get((provider, external))
            scope_values = {
                'local_version_id': int(formal_textbook.version_id)
                if formal_textbook is not None
                else (int(formal_version.version_id) if formal_version is not None else None),
                'local_textbook_id': int(formal_textbook.textbook_id) if formal_textbook is not None else None,
                'version_name_snapshot': versions_map.get((provider, version_external or ''), (None, None))[1],
                'textbook_name_snapshot': value.get('textbook_name') or value.get('textbookName') or external,
                'metadata_run_id': metadata_run_id,
                'status': 'completed',
                'finished_at': datetime.now(),
                'update_time': datetime.now(),
            }
            if existing_scope is not None:
                # A remote collector may expose scope rows before formal
                # identity resolution is available. Fill only missing
                # identity/display fields and leave its run/counters.
                existing_metadata_run_id = getattr(existing_scope, 'metadata_run_id', None)
                if existing_metadata_run_id not in (None, metadata_run_id):
                    raise ServiceException(
                        message=(f'任务 {run_id} 的教材 {external} 已绑定其他 metadataRunId，不能覆盖不可变范围')
                    )
                changed = {
                    key: item
                    for key, item in scope_values.items()
                    if item is not None
                    and (key in {'status', 'finished_at'} or getattr(existing_scope, key, None) in (None, ''))
                }
                if changed:
                    affected = await SyncTaskDao.update_scope(db, int(existing_scope.scope_id), changed)
                    if affected != 1:
                        raise ServiceException(message=f'教材 {external} 的同步范围更新失败')
                continue
            rows.append(
                QbSyncJobScope(
                    run_id=run_id,
                    source_provider=provider,
                    external_version_id=version_external,
                    external_textbook_id=external,
                    metadata_run_id=metadata_run_id,
                    local_version_id=scope_values['local_version_id'],
                    local_textbook_id=scope_values['local_textbook_id'],
                    version_name_snapshot=scope_values['version_name_snapshot'],
                    textbook_name_snapshot=value.get('textbook_name') or value.get('textbookName') or external,
                    status='completed',
                    create_time=datetime.now(),
                    update_time=datetime.now(),
                )
            )
        if rows:
            db.add_all(rows)
        # Commit even when every scope already exists: the update path above
        # still changes the durable identity/status fields.
        await db.commit()


async def _current_status(run_id: int) -> str | None:
    row = await _load_row(run_id)
    return row.status if row else None


async def _load_scopes(run_id: int) -> list[QbSyncJobScope]:
    async with DataSourceRegistry.session() as db:
        try:
            return await SyncTaskDao.scopes(db, run_id)
        except SQLAlchemyError:
            # Databases upgraded before migration 006 legitimately have no
            # scope table; the legacy center status must remain queryable.
            return []


async def _load_scopes_strict(run_id: int) -> list[QbSyncJobScope]:
    """Read scope rows while preserving schema/read failures for strict paths."""

    async with DataSourceRegistry.session() as db:
        return await SyncTaskDao.scopes(db, run_id)


def _scope_identity(scope: Mapping[str, Any] | object) -> dict[str, Any]:
    """Return the bounded server-owned identity sent to the collector."""

    def read(*names: str, default: Any = None) -> Any:
        return _scope_field(scope, *names, default=default)

    provider = str(read('source_provider', 'sourceProvider', 'provider', default='') or '').strip()
    external_version = str(read('external_version_id', 'externalVersionId', default='') or '').strip()
    external_textbook = str(read('external_textbook_id', 'externalTextbookId', default='') or '').strip()
    version_name = str(read('version_name_snapshot', 'versionNameSnapshot', 'versionName', default='') or '').strip()
    textbook_name = str(read('textbook_name_snapshot', 'textbookNameSnapshot', 'textbookName', default='') or '').strip()
    resume_from = _positive_collector_run_id(
        read('resume_from_collector_run_id', 'resumeFromCollectorRunId', default=None)
    )
    return {
        'sourceProvider': provider,
        'externalVersionId': external_version,
        'externalTextbookId': external_textbook,
        'versionName': version_name,
        'textbookName': textbook_name,
        'resumeFromCollectorRunId': resume_from,
    }


def _normalise_textbook_scopes(value: Any) -> list[dict[str, Any]]:
    """Validate/normalise durable scope identity without trusting arbitrary options."""

    if not isinstance(value, list):
        return []
    result: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in value:
        if not isinstance(item, Mapping):
            continue
        identity = _scope_identity(item)
        provider = identity['sourceProvider']
        textbook_id = identity['externalTextbookId']
        version_id = identity['externalVersionId']
        if (
            not provider
            or not _safe_external_id(version_id)
            or not _safe_external_id(textbook_id)
            or (provider, textbook_id) in seen
        ):
            continue
        seen.add((provider, textbook_id))
        result.append(identity)
    return result


def _question_option_external_ids(options: Mapping[str, Any]) -> list[str] | None:
    """Read the persisted question selection for strict scope comparison."""

    marker = object()
    raw = options.get('textbookExternalIds', marker)
    if raw is marker:
        raw = options.get('textbook_external_ids', marker)
    if raw is marker:
        return None
    if not isinstance(raw, list) or not raw:
        raise ServiceException(message='题库任务的持久化教材选择无效')
    values = [str(value or '').strip() for value in raw]
    if len(values) != len(set(values)):
        raise ServiceException(message='题库任务的持久化教材选择包含重复 ID')
    if any(not _safe_external_id(value) for value in values):
        raise ServiceException(message='题库任务的持久化教材选择包含不安全 ID')
    return values


def _question_option_scope_identities(options: Mapping[str, Any]) -> list[dict[str, Any]] | None:
    """Validate an optional JSON scope snapshot for durable-scope comparison."""

    marker = object()
    raw = options.get('textbookScopes', marker)
    if raw is marker:
        raw = options.get('textbook_scopes', marker)
    if raw is marker:
        return None
    if not isinstance(raw, list) or not raw:
        raise ServiceException(message='题库任务的持久化教材范围选项无效')
    return _strict_question_scope_identities(
        raw,
        expected_external_ids=_question_option_external_ids(options),
    )


def _scope_identity_key(identity: Mapping[str, Any]) -> tuple[str, str, str]:
    return (
        str(identity.get('sourceProvider') or ''),
        str(identity.get('externalVersionId') or ''),
        str(identity.get('externalTextbookId') or ''),
    )


def _scope_identity_keys(identities: list[dict[str, Any]]) -> set[tuple[str, str, str]]:
    return {_scope_identity_key(identity) for identity in identities}


def _strict_question_scope_identities(
    scopes: list[object] | tuple[object, ...],
    *,
    expected_external_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Validate the immutable identity rows used by an independent question task.

    Scope rows are the durable authority.  This helper intentionally rejects
    malformed rows instead of dropping them as ``_normalise_textbook_scopes``
    does for optional/legacy JSON values.
    """

    if not isinstance(scopes, (list, tuple)) or not scopes:
        raise ServiceException(message='题库任务缺少持久化教材范围')
    identities: list[dict[str, Any]] = []
    seen_textbooks: set[str] = set()
    version_ids: set[str] = set()
    for scope in scopes:
        identity = _scope_identity(scope)
        provider = identity['sourceProvider']
        external_version_id = identity['externalVersionId']
        external_textbook_id = identity['externalTextbookId']
        if provider != PROVIDER:
            raise ServiceException(message='题库任务教材范围来源提供方不受支持')
        if not _safe_external_id(external_version_id):
            raise ServiceException(message='题库任务教材范围缺少安全版本来源 ID')
        if not _safe_external_id(external_textbook_id):
            raise ServiceException(message='题库任务教材范围缺少安全教材来源 ID')
        if external_textbook_id in seen_textbooks:
            raise ServiceException(message='题库任务持久化教材范围包含重复 ID')
        seen_textbooks.add(external_textbook_id)
        version_ids.add(external_version_id)
        identities.append(identity)
    if len(version_ids) != 1:
        raise ServiceException(message='题库任务教材范围必须属于同一个来源版本')
    if expected_external_ids is not None and set(expected_external_ids) != seen_textbooks:
        raise ServiceException(message='题库任务持久化教材范围与创建选项不一致')
    return identities


async def _durable_question_scope_identities(
    run_id: int,
    options: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Load and strictly validate a question task's durable scope rows."""

    expected_external_ids = _question_option_external_ids(options) if options is not None else None
    option_identities = _question_option_scope_identities(options) if options is not None else None
    try:
        scopes = await _load_scopes_strict(run_id)
    except (AttributeError, SQLAlchemyError) as exc:
        # A pre-006 installation has no durable scope table.  Keep a narrow
        # compatibility path for an already-created row whose options carry
        # the complete identity; never use textbookExternalIds alone.
        if options is None:
            raise ServiceException(message='题库任务持久化教材范围不可用') from exc
        fallback = options.get('textbookScopes')
        if not isinstance(fallback, list):
            raise ServiceException(message='题库任务缺少持久化教材范围') from exc
        return option_identities or _strict_question_scope_identities(
            fallback,
            expected_external_ids=expected_external_ids,
        )
    durable_identities = _strict_question_scope_identities(scopes, expected_external_ids=expected_external_ids)
    if option_identities is not None and _scope_identity_keys(durable_identities) != _scope_identity_keys(
        option_identities
    ):
        raise ServiceException(message='题库任务选项与持久化教材范围不一致')
    return durable_identities


async def _durable_question_scope_identities_from_db(
    db: AsyncSession,
    run_id: int,
    options: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Read question scope rows from an already-open recovery transaction."""

    expected_external_ids = _question_option_external_ids(options) if options is not None else None
    option_identities = _question_option_scope_identities(options) if options is not None else None
    try:
        scopes = await SyncTaskDao.scopes(db, run_id)
    except (AttributeError, SQLAlchemyError) as exc:
        # See the compatibility rule in _durable_question_scope_identities.
        if options is None:
            raise ServiceException(message='题库任务持久化教材范围不可用') from exc
        fallback = options.get('textbookScopes')
        if not isinstance(fallback, list):
            raise ServiceException(message='题库任务缺少持久化教材范围') from exc
        return option_identities or _strict_question_scope_identities(
            fallback,
            expected_external_ids=expected_external_ids,
        )
    durable_identities = _strict_question_scope_identities(scopes, expected_external_ids=expected_external_ids)
    if option_identities is not None and _scope_identity_keys(durable_identities) != _scope_identity_keys(
        option_identities
    ):
        raise ServiceException(message='题库任务选项与持久化教材范围不一致')
    return durable_identities


async def _question_handle_scopes(run_id: int, handle: _WorkerHandle) -> None:
    """Rebuild a question worker's scope identity from durable rows."""

    handle.metadata_run_id = None
    handle.textbook_scopes = await _durable_question_scope_identities(run_id)
    handle.textbook_external_ids = [identity['externalTextbookId'] for identity in handle.textbook_scopes]


_TERMINAL_SCOPE_STATUSES = frozenset({'completed', 'failed', 'blocked', 'cancelled', 'interrupted'})


def _positive_collector_run_id(value: Any) -> int | None:
    """Return a strict positive integer collector run ID, if present."""

    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    if not re.fullmatch(r'\d+', text):
        return None
    try:
        parsed = int(text)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _status_flag(value: Any) -> bool:
    """Parse persisted/API completion flags without treating ``'0'`` true."""

    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value or '').strip().lower() in {'1', 'true', 'yes', 'y', 'on', 'complete', 'completed', 'success'}


def _lock_present(value: Any) -> bool:
    if value is None or value is False or value == 0:
        return False
    if isinstance(value, str):
        return value.strip().lower() not in {'', '0', 'false', 'no', 'off', 'null', 'none'}
    return bool(value)



async def _persist_remote_scope(  # noqa: PLR0912
    run_id: int,
    external_textbook_id: str,
    values: dict[str, Any],
) -> None:
    """Persist one remote scope and reject missing/regressing scope rows.

    ``update_scope`` is conditional on a non-terminal state.  A repeated
    terminal response therefore has a zero row count even though it is a
    valid idempotent poll; this helper distinguishes that case from a real
    missing/write-failed scope and from an illegal terminal regression.
    """

    updated = await _update_scope_values(
        run_id,
        values,
        external_textbook_id=external_textbook_id,
        expected_statuses=('queued', 'starting', 'running'),
    )
    if updated:
        return

    scopes = await _load_scopes(run_id)
    scope = next(
        (
            item
            for item in scopes
            if str(_scope_field(item, 'external_textbook_id', 'externalTextbookId', default='') or '')
            == external_textbook_id
        ),
        None,
    )
    if scope is None:
        raise ServiceException(message=f'远程任务教材范围 {external_textbook_id} 不存在或写入失败')
    current_status = str(_scope_field(scope, 'status', 'state', default='') or '').lower()
    incoming_status = str(values.get('status') or '').lower()
    current_run_id = _positive_collector_run_id(_scope_field(scope, 'collector_run_id', 'collectorRunId', default=None))
    incoming_run_id = _positive_collector_run_id(values.get('collector_run_id'))
    if current_status in _TERMINAL_SCOPE_STATUSES:
        if incoming_status and incoming_status != current_status:
            raise ServiceException(
                message=(
                    f'远程任务教材范围 {external_textbook_id} 已终态 {current_status}，拒绝回退为 {incoming_status}'
                )
            )
        if incoming_run_id is not None and current_run_id is not None and incoming_run_id != current_run_id:
            raise ServiceException(message=f'远程任务教材范围 {external_textbook_id} 的 collectorRunId 发生变化')
        # A collector often reports bounded counters/lock markers only on its
        # terminal poll. Preserve those fields even when the status row has
        # already reached the same terminal state (a normal idempotent poll).
        terminal_projection = {
            key: value
            for key, value in values.items()
            if key
            in {
                'catalog_count',
                'question_count',
                'question_catalog_count',
                'question_tag_count',
                'question_asset_count',
                'snapshot_complete',
                'snapshot_locked_at',
                'resume_from_collector_run_id',
                'finished_at',
                'error_message',
            }
        }
        if terminal_projection:
            await _update_scope_values(
                run_id,
                terminal_projection,
                external_textbook_id=external_textbook_id,
            )
        return

    # MySQL may report zero affected rows when a poll repeats identical
    # values.  Accept that idempotent result only when every requested value
    # already matches the durable non-terminal scope.
    attr_names = {
        'collector_job_id': ('collector_job_id', 'collectorJobId'),
        'collector_run_id': ('collector_run_id', 'collectorRunId'),
        'resume_from_collector_run_id': ('resume_from_collector_run_id', 'resumeFromCollectorRunId'),
        'status': ('status', 'state'),
        'catalog_count': ('catalog_count', 'catalogCount'),
        'question_count': ('question_count', 'questionCount'),
        'new_catalog_count': ('new_catalog_count', 'newCatalogCount'),
        'changed_catalog_count': ('changed_catalog_count', 'changedCatalogCount'),
        'new_question_count': ('new_question_count', 'newQuestionCount'),
        'changed_question_count': ('changed_question_count', 'changedQuestionCount'),
        'question_catalog_count': ('question_catalog_count', 'questionCatalogCount', 'relation_count', 'relationCount'),
        'question_tag_count': ('question_tag_count', 'questionTagCount', 'tag_count', 'tagCount'),
        'question_asset_count': ('question_asset_count', 'questionAssetCount', 'asset_count', 'assetCount'),
        'snapshot_complete': ('snapshot_complete', 'snapshotComplete', 'complete'),
        'snapshot_locked_at': ('snapshot_locked_at', 'snapshotLockedAt', 'lockedAt'),
        'error_message': ('error_message', 'errorMessage', 'error'),
        'started_at': ('started_at', 'startedAt'),
        'finished_at': ('finished_at', 'finishedAt'),
    }
    for key, expected in values.items():
        names = attr_names.get(key, (key,))
        actual = _scope_field(scope, *names, default=None)
        if key in {
            'collector_run_id',
            'catalog_count',
            'question_count',
            'new_catalog_count',
            'changed_catalog_count',
            'new_question_count',
            'changed_question_count',
        }:
            try:
                if int(actual or 0) != int(expected or 0):
                    raise ServiceException(message=f'远程任务教材范围 {external_textbook_id} 写入状态不一致')
            except (TypeError, ValueError) as exc:
                raise ServiceException(message=f'远程任务教材范围 {external_textbook_id} 写入状态不一致') from exc
        elif key in {'started_at', 'finished_at'}:
            if _scope_datetime(actual) != _scope_datetime(expected):
                raise ServiceException(message=f'远程任务教材范围 {external_textbook_id} 写入状态不一致')
        elif str(actual or '') != str(expected or ''):
            raise ServiceException(message=f'远程任务教材范围 {external_textbook_id} 写入状态不一致')


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, '__await__'):
        return await value
    return value


_FINAL_SCOPE_ALIASES = {
    'collector_run_id': ('collector_run_id', 'collectorRunId'),
    'status': ('status', 'state'),
    'catalog_count': ('catalog_count', 'catalogCount'),
    'question_count': ('question_count', 'questionCount'),
    'question_catalog_count': ('question_catalog_count', 'questionCatalogCount'),
    'question_tag_count': ('question_tag_count', 'questionTagCount'),
    'question_asset_count': ('question_asset_count', 'questionAssetCount'),
    'snapshot_complete': ('snapshot_complete', 'snapshotComplete'),
    'snapshot_locked_at': ('snapshot_locked_at', 'snapshotLockedAt'),
}


def _final_scope_value_matches(actual: Any, expected: Any, key: str) -> bool:
    if key == 'snapshot_complete':
        return _status_flag(actual) is _status_flag(expected)
    if key == 'snapshot_locked_at':
        return _scope_datetime(actual) == _scope_datetime(expected)
    if key == 'status':
        return str(actual or '').lower() == str(expected or '').lower()
    try:
        return int(actual) == int(expected)
    except (TypeError, ValueError):
        return False


async def _persist_verified_remote_scope(
    run_id: int,
    external_id: str,
    projection: dict[str, Any],
) -> None:
    """Persist a terminal scope projection or prove it was already durable."""

    updated = await _update_scope_values(
        run_id,
        projection,
        external_textbook_id=external_id,
    )
    if updated:
        return
    refreshed_scopes = await _load_scopes(run_id)
    refreshed = next(
        (
            item
            for item in refreshed_scopes
            if str(_scope_field(item, 'external_textbook_id', 'externalTextbookId', default='') or '')
            == external_id
        ),
        None,
    )
    if refreshed is None:
        raise ServiceException(message=f'远程任务教材范围 {external_id} 最终状态写入失败')
    for key, expected in projection.items():
        actual = _scope_field(refreshed, *_FINAL_SCOPE_ALIASES[key], default=None)
        if not _final_scope_value_matches(actual, expected, key):
            raise ServiceException(message=f'远程任务教材范围 {external_id} 最终状态写入失败')


async def _validate_remote_question_scopes(
    run_id: int,
    handle: _WorkerHandle,
    observed_scopes: dict[str, dict[str, Any]],
    client: CollectorClient,
) -> None:
    """Require every selected question scope to own a completed snapshot."""

    expected_ids = list(
        dict.fromkeys(str(value).strip() for value in handle.textbook_external_ids if str(value).strip())
    )
    if not expected_ids:
        raise ServiceException(message='题库远程任务缺少预期教材范围')
    durable_scopes = await _load_scopes(run_id)
    durable_by_id = {
        str(_scope_field(item, 'external_textbook_id', 'externalTextbookId', default='') or ''): item
        for item in durable_scopes
    }
    # Eligibility ownership is proven by the bounded summary endpoint.  Do
    # not call the paginated question endpoint here: a one-row probe cannot
    # prove immutable completion or the five scoped counts.
    summary_reader = getattr(client, 'run_snapshot_summary', None) or getattr(client, 'snapshot_summary', None)
    for external_id in expected_ids:
        durable = durable_by_id.get(external_id)
        observed = observed_scopes.setdefault(external_id, {})
        status = str(
            _scope_field(durable, 'status', 'state', default=observed.get('status', ''))
            if durable
            else observed.get('status', '')
        ).lower()
        run_value = (
            _scope_field(
                durable,
                'collector_run_id',
                'collectorRunId',
                default=observed.get('collector_run_id') or observed.get('collectorRunId'),
            )
            if durable
            else observed.get('collector_run_id') or observed.get('collectorRunId')
        )
        collector_run_id = _positive_collector_run_id(run_value)
        if durable is None and not observed:
            raise ServiceException(message=f'远程任务教材范围 {external_id} 缺少持久化状态')
        if status != 'completed':
            raise ServiceException(message=f'远程任务教材范围 {external_id} 未成功完成')
        if collector_run_id is None:
            raise ServiceException(message=f'远程任务教材范围 {external_id} 缺少合法 collectorRunId')
        observed_run_id = _positive_collector_run_id(observed.get('collector_run_id') or observed.get('collectorRunId'))
        if observed_run_id is not None and observed_run_id != collector_run_id:
            raise ServiceException(message=f'远程任务教材范围 {external_id} 的 collectorRunId 不一致')

        # The current collector exposes the immutable summary API. Keep this
        # compatibility branch for old test/integration doubles only; the
        # production CollectorClient always has ``run_snapshot_summary``.
        if not callable(summary_reader):
            continue
        try:
            try:
                summary_payload = await asyncio.to_thread(
                    summary_reader,
                    collector_run_id,
                    textbook_external_id=external_id,
                )
            except TypeError:
                summary_payload = await asyncio.to_thread(summary_reader, collector_run_id)
            summary_payload = await _maybe_await(summary_payload)
        except Exception as exc:
            raise ServiceException(message=f'无法验证教材 {external_id} 的 collectorRunId 快照摘要归属') from exc
        try:
            summary = _normalise_snapshot_summary(summary_payload, run_id, external_id)
        except ServiceException:
            raise
        except Exception as exc:
            raise ServiceException(message=f'教材 {external_id} 的 collectorRunId 快照摘要结构无效') from exc
        summary_id = _positive_collector_run_id(summary.get('collector_run_id'))
        if summary_id != collector_run_id:
            raise ServiceException(message=f'教材 {external_id} 的 collectorRunId 快照身份不一致')
        summary_counts = summary.get('counts') or {}
        summary_run = summary.get('run') or {}
        verified_counts = {
            'catalog_count': int(summary_counts.get('catalogs', 0) or 0),
            'question_count': int(summary_counts.get('questions', 0) or 0),
            'question_catalog_count': int(summary_counts.get('questionCatalogs', 0) or 0),
            'question_tag_count': int(summary_counts.get('tags', 0) or 0),
            'question_asset_count': int(summary_counts.get('assets', 0) or 0),
        }
        observed.update(
            {
                'status': 'completed',
                'collector_run_id': collector_run_id,
                **verified_counts,
                'snapshot_complete': True,
                'snapshot_locked_at': _scope_datetime(
                    _scope_field(summary_run, 'snapshot_locked_at', 'snapshotLockedAt', 'locked')
                ),
            }
        )
        # The job's scope projection may be persisted before the summary is
        # fetched. Update the terminal row with the authoritative five counts
        # and lock/completion markers without changing its status or run ID.
        await _persist_verified_remote_scope(
            run_id,
            external_id,
            {
                'collector_run_id': collector_run_id,
                'status': 'completed',
                **verified_counts,
                'snapshot_complete': True,
                'snapshot_locked_at': _scope_datetime(
                    _scope_field(summary_run, 'snapshot_locked_at', 'snapshotLockedAt', 'locked')
                ),
            },
        )


def _progress_for(total_textbooks: int, completed_textbooks: int, phase: str) -> Decimal:
    if phase == 'metadata':
        return Decimal('10') if total_textbooks else Decimal('0')
    if phase == 'completed':
        return Decimal('100')
    if total_textbooks <= 0:
        return Decimal('50')
    return min(
        Decimal('100'), Decimal('50') + (Decimal(completed_textbooks) / Decimal(total_textbooks) * Decimal('50'))
    )


async def _resume_partial_summary(
    collector_run_id: int,
    textbook_external_id: str,
    *,
    error_hint: str | None = None,
) -> dict[str, Any]:
    """Validate one durable partial run before using it as a resume source."""

    client = CollectorClient()
    method = getattr(client, 'run_snapshot_summary', None) or getattr(client, 'snapshot_summary', None)
    if not callable(method):
        raise ServiceException(message='collector 客户端不支持不完整题库快照摘要接口')
    try:
        try:
            payload = await asyncio.to_thread(
                method,
                collector_run_id,
                textbook_external_id=textbook_external_id,
                allow_incomplete=True,
            )
        except TypeError:
            try:
                payload = await asyncio.to_thread(
                    method,
                    collector_run_id,
                    textbook_external_id=textbook_external_id,
                    allowIncomplete=True,
                )
            except TypeError:
                payload = await asyncio.to_thread(
                    method,
                    collector_run_id,
                    textbook_external_id=textbook_external_id,
                )
        payload = await _maybe_await(payload)
    except Exception as exc:
        raise ServiceException(message=f'无法读取教材 {textbook_external_id} 的中断快照摘要') from exc
    summary = _normalise_snapshot_summary(
        payload,
        0,
        str(textbook_external_id),
        allow_incomplete=True,
    )
    if _positive_collector_run_id(summary.get('collector_run_id')) != int(collector_run_id):
        raise ServiceException(message=f'collector 运行 {collector_run_id} 的摘要身份不一致')
    run = summary.get('run') if isinstance(summary.get('run'), Mapping) else {}
    run_status = str(run.get('status') or '').strip().lower()
    run_error = ' '.join(
        str(run.get(key) or '')
        for key in ('error', 'error_message', 'errorMessage', 'message')
    )
    if run_status == 'failed' and not _is_transient_error(f'{run_error} {error_hint or ""}'):
        raise ServiceException(message=f'collector 运行 {collector_run_id} 不是可安全续采的暂时性失败')
    # `blocked` is accepted only through this explicit operator resume path.
    # Automatic continuation only schedules transient `interrupted` runs.
    if run_status not in {'interrupted', 'failed', 'blocked'}:
        raise ServiceException(message=f'collector 运行 {collector_run_id} 不是可续采的中断状态')
    if not _has_safe_partial_progress(summary):
        raise ServiceException(message=f'collector 运行 {collector_run_id} 没有可安全续采的进度')
    return summary


async def _terminate_process(handle: _WorkerHandle) -> None:
    """Cancel the server-owned collector job, if this worker has one."""

    if handle.terminate_sent:
        return
    owner = _QUEUE_OWNER.get()
    if owner:
        row = await _load_row(owner[0])
        if row is None or row.worker_token != owner[1]:
            raise WorkerOwnershipLost(message='同步任务执行权已被接管')
        target = handle.remote_job_id or row.dispatch_job_id
        try:
            await asyncio.to_thread(CollectorClient().cancel_job, target, reserve_dispatch=True)
        except ServiceException as exc:
            raise DispatchAckPending(message='采集器暂不可用，正在等待确认停止结果') from exc
        handle.terminate_sent = True
        return
    handle.terminate_sent = True
    if not handle.remote_job_id:
        return
    try:
        await asyncio.to_thread(CollectorClient().cancel_job, handle.remote_job_id)
    except Exception:
        # The remote job may already be terminal or the collector may be
        # unavailable during shutdown. Durable service state is finalized by
        # the normal worker/recovery boundary.
        return


def _remote_status_values(payload: dict[str, Any]) -> dict[str, Any]:
    """Project the collector's bounded status into the durable MySQL row."""

    def pick(*names: str, default: Any = None) -> Any:
        for name in names:
            if name in payload and payload[name] is not None:
                return payload[name]
        return default

    values: dict[str, Any] = {
        'log_tail': str(pick('logTail', 'log_tail', 'logs', 'log', default='') or '')[-MAX_LOG_CHARS:] or None,
        'total_versions': max(0, int(pick('totalVersions', 'total_versions', default=0) or 0)),
        'completed_versions': max(0, int(pick('completedVersions', 'completed_versions', default=0) or 0)),
        'total_textbooks': max(0, int(pick('totalTextbooks', 'total_textbooks', default=0) or 0)),
        'completed_textbooks': max(0, int(pick('completedTextbooks', 'completed_textbooks', default=0) or 0)),
        'catalog_count': max(0, int(pick('catalogCount', 'catalog_count', default=0) or 0)),
        'new_catalog_count': max(0, int(pick('newCatalogCount', 'new_catalog_count', default=0) or 0)),
        'changed_catalog_count': max(0, int(pick('changedCatalogCount', 'changed_catalog_count', default=0) or 0)),
        'question_count': max(0, int(pick('questionCount', 'question_count', default=0) or 0)),
        'question_catalog_count': max(
            0,
            int(
                pick(
                    'questionCatalogCount',
                    'question_catalog_count',
                    'relationCount',
                    'relation_count',
                    default=0,
                )
                or 0
            ),
        ),
        'question_tag_count': max(
            0,
            int(pick('questionTagCount', 'question_tag_count', 'tagCount', 'tag_count', default=0) or 0),
        ),
        'question_asset_count': max(
            0,
            int(pick('questionAssetCount', 'question_asset_count', 'assetCount', 'asset_count', default=0) or 0),
        ),
        'snapshot_complete': pick('snapshotComplete', 'snapshot_complete', 'complete', default=False),
        'snapshot_locked_at': _scope_datetime(
            pick('snapshotLockedAt', 'snapshot_locked_at', 'lockedAt', 'locked_at')
        ),
        'new_question_count': max(0, int(pick('newQuestionCount', 'new_question_count', default=0) or 0)),
        'changed_question_count': max(0, int(pick('changedQuestionCount', 'changed_question_count', default=0) or 0)),
        'new_version_count': max(0, int(pick('newVersionCount', 'new_version_count', default=0) or 0)),
        'new_textbook_count': max(0, int(pick('newTextbookCount', 'new_textbook_count', default=0) or 0)),
        'current_textbook_id': str(pick('currentTextbookId', 'current_textbook_id', default='') or '') or None,
        'current_textbook_name': str(pick('currentTextbookName', 'current_textbook_name', default='') or '') or None,
    }
    # The collector's public job projection normally carries the UUID as
    # ``id``.  Preserve the service-side UUID when an older projection omits
    # it: writing ``collector_job_id = NULL`` during the first status poll
    # would make a later restart unable to resume the remote job.
    collector_job_id = str(
        pick('collectorJobId', 'collector_job_id', 'id', 'jobId', 'job_id', default='') or ''
    ).strip()
    if collector_job_id:
        values['collector_job_id'] = collector_job_id
    metadata_run_id = int(pick('metadataRunId', 'metadata_run_id', default=0) or 0)
    if metadata_run_id > 0:
        values['metadata_run_id'] = metadata_run_id
    try:
        progress = Decimal(str(pick('progressPercent', 'progress_percent', 'progress', default=0) or 0))
    except Exception:
        progress = Decimal('0')
    values['progress_percent'] = max(Decimal('0'), min(Decimal('100'), progress))
    return values


async def _execute_remote(  # noqa: PLR0912, PLR0915
    run_id: int,
    handle: _WorkerHandle,
    max_pages: int,
) -> None:
    """Delegate execution and candidate ownership to a remote collector."""

    all_question_ids = list(handle.textbook_external_ids)
    initial_question_counts = {
        'catalog_count': 0,
        'question_count': 0,
        'question_catalog_count': 0,
        'question_tag_count': 0,
        'question_asset_count': 0,
    }
    initial_completed_textbooks = 0
    initial_question_locks: list[datetime] = []
    if handle.task_module == 'question' and handle.resumed:
        durable_scopes = await _load_scopes(run_id)
        completed_ids: set[str] = set()
        for scope in durable_scopes:
            external_id = str(
                _scope_field(scope, 'external_textbook_id', 'externalTextbookId', default='') or ''
            ).strip()
            if str(_scope_field(scope, 'status', 'state', default='') or '').lower() != 'completed':
                continue
            if external_id not in all_question_ids:
                continue
            completed_ids.add(external_id)
            initial_completed_textbooks += 1
            for key, aliases in (
                ('catalog_count', ('catalog_count', 'catalogCount')),
                ('question_count', ('question_count', 'questionCount')),
                ('question_catalog_count', ('question_catalog_count', 'questionCatalogCount')),
                ('question_tag_count', ('question_tag_count', 'questionTagCount')),
                ('question_asset_count', ('question_asset_count', 'questionAssetCount')),
            ):
                initial_question_counts[key] += int(_scope_field(scope, *aliases, default=0) or 0)
            lock = _scope_datetime(_scope_field(scope, 'snapshot_locked_at', 'snapshotLockedAt', 'lockedAt'))
            if lock is not None:
                initial_question_locks.append(lock)
        pending_ids = [external_id for external_id in all_question_ids if external_id not in completed_ids]
        if not pending_ids:
            await _finish(
                run_id,
                handle,
                'completed',
                'completed',
                None,
                catalog_count=initial_question_counts['catalog_count'],
                question_count=initial_question_counts['question_count'],
                question_catalog_count=initial_question_counts['question_catalog_count'],
                question_tag_count=initial_question_counts['question_tag_count'],
                question_asset_count=initial_question_counts['question_asset_count'],
                total_textbooks=len(all_question_ids),
                completed_textbooks=initial_completed_textbooks,
                snapshot_complete=True,
            )
            return
        handle.textbook_external_ids = pending_ids
        handle.textbook_scopes = [
            identity
            for identity in handle.textbook_scopes
            if identity.get('externalTextbookId') in pending_ids
        ]

    client = CollectorClient()
    if handle.remote_job_id:
        # A process restart must resume polling the server-owned collector
        # job instead of creating a second crawl for the same task snapshot.
        remote = await asyncio.to_thread(client.job, handle.remote_job_id)
    else:
        start_kwargs: dict[str, Any] = {
            'max_pages': max_pages,
            'metadata_run_id': None if handle.task_module == 'question' else handle.metadata_run_id,
            'textbook_external_ids': list(handle.textbook_external_ids),
        }
        if handle.task_module == 'question' and handle.textbook_scopes:
            start_kwargs['textbook_scopes'] = list(handle.textbook_scopes)
        if handle.task_module == 'question' and handle.limit_to_1000_pages:
            start_kwargs['limit_to_1000_pages'] = True
        if handle.workflow_version >= 2:
            start_kwargs['workflow_version'] = 2
        dispatch_id = handle.dispatch_job_id
        if dispatch_id:
            start_kwargs['job_id'] = dispatch_id
        try:
            remote = await asyncio.to_thread(client.start_job, handle.run_type, **start_kwargs)
        except ServiceException as exc:
            cause = exc.__cause__
            if dispatch_id and isinstance(cause, urllib.error.HTTPError) and cause.code == 423:
                raise DispatchDeferred(message=exc.message) from exc
            if dispatch_id and not (isinstance(cause, urllib.error.HTTPError) and cause.code in (400, 401, 403, 409)):
                raise DispatchAckPending(message='等待核对采集器派发结果，将使用相同任务标识恢复') from exc
            raise
    remote_job_id = str(
        remote.get('id') or remote.get('jobId') or remote.get('job_id') or handle.remote_job_id or ''
    ).strip()
    if not re.fullmatch(r'[0-9a-fA-F-]{36}', remote_job_id):
        raise ServiceException(message='collector API 未返回有效任务 ID')
    handle.remote_job_id = remote_job_id
    await _update_row(run_id, {'collector_job_id': remote_job_id})
    observed_scopes: dict[str, dict[str, Any]] = {}
    while True:
        status = str(remote.get('status') or '')
        if status not in {
            'queued',
            'running',
            'cancelling',
            'completed',
            'failed',
            'blocked',
            'cancelled',
            'interrupted',
        }:
            raise ServiceException(message='collector API 返回了无效任务状态')
        values = _remote_status_values(remote)
        if handle.task_module == 'question':
            # The collector may include a legacy metadata field in a generic
            # projection. It must never attach that mutable identity to a new
            # independent question task.
            values.pop('metadata_run_id', None)
        cached = await _persist_live_progress(run_id, remote)
        if cached and not handle.options_compacted:
            await _compact_active_options(run_id)
            handle.options_compacted = True
        terminal = status not in {'queued', 'running', 'cancelling'}
        if terminal or _progress_write_due(handle, 'task', values):
            await _update_row(run_id, values)
            _mark_progress_write(handle, 'task', values)
        # New collector versions expose immutable per-textbook scope data on
        # the job response.  Copy only bounded identity/progress fields into
        # the service scope table; unknown/legacy payloads are ignored.
        raw_scopes = (
            remote.get('scopeItems') or remote.get('scope_items') or remote.get('scopes') or remote.get('scope')
        )
        if isinstance(raw_scopes, dict):
            raw_scopes = raw_scopes.get('scopeItems') or raw_scopes.get('items') or []
        if isinstance(raw_scopes, list):
            for scope in raw_scopes:
                if not isinstance(scope, dict):
                    continue
                external_id = str(
                    scope.get('externalTextbookId')
                    or scope.get('external_textbook_id')
                    or scope.get('textbookExternalId')
                    or ''
                ).strip()
                if not external_id:
                    continue
                if handle.task_module == 'question' and handle.resumed and external_id not in handle.textbook_external_ids:
                    continue
                scope_status = str(scope.get('status') or scope.get('state') or '').strip().lower()
                if scope_status == 'cancelling':
                    # The MySQL scope check intentionally has no transient
                    # cancelling state; the parent task carries that state.
                    scope_status = 'running'
                if scope_status not in {
                    'queued',
                    'starting',
                    'running',
                    'completed',
                    'failed',
                    'blocked',
                    'cancelled',
                    'interrupted',
                }:
                    scope_status = ''
                scope_values: dict[str, Any] = {
                    'collector_job_id': remote_job_id,
                    'collector_run_id': scope.get('collectorRunId') or scope.get('collector_run_id'),
                    'resume_from_collector_run_id': scope.get('resumeFromCollectorRunId')
                    or scope.get('resume_from_collector_run_id'),
                    'status': scope_status or None,
                    'catalog_count': scope.get('catalogCount') or scope.get('catalog_count'),
                    'question_count': scope.get('questionCount') or scope.get('question_count'),
                    'new_catalog_count': scope.get('newCatalogCount') or scope.get('new_catalog_count'),
                    'changed_catalog_count': scope.get('changedCatalogCount') or scope.get('changed_catalog_count'),
                    'new_question_count': scope.get('newQuestionCount') or scope.get('new_question_count'),
                    'changed_question_count': scope.get('changedQuestionCount') or scope.get('changed_question_count'),
                    'question_catalog_count': scope.get('questionCatalogCount') or scope.get('question_catalog_count') or scope.get('relationCount') or scope.get('relation_count'),
                    'question_tag_count': scope.get('questionTagCount') or scope.get('question_tag_count') or scope.get('tagCount') or scope.get('tag_count'),
                    'question_asset_count': scope.get('questionAssetCount') or scope.get('question_asset_count') or scope.get('assetCount') or scope.get('asset_count'),
                    'snapshot_complete': _status_flag(
                        scope.get('snapshotComplete')
                        if scope.get('snapshotComplete') is not None
                        else scope.get('snapshot_complete')
                    ),
                    'snapshot_locked_at': _scope_datetime(scope.get('snapshotLockedAt') or scope.get('snapshot_locked_at') or scope.get('lockedAt') or scope.get('locked_at')),
                    'error_message': scope.get('errorMessage') or scope.get('error_message') or scope.get('error'),
                    'started_at': _scope_datetime(scope.get('startedAt') or scope.get('started_at')),
                    'finished_at': _scope_datetime(scope.get('finishedAt') or scope.get('finished_at')),
                }
                scope_values = {key: value for key, value in scope_values.items() if value is not None}
                observed_scopes[external_id] = {
                    'status': scope_status or None,
                    'collector_run_id': scope_values.get('collector_run_id'),
                    'resume_from_collector_run_id': scope_values.get('resume_from_collector_run_id'),
                    'catalog_count': scope_values.get('catalog_count'),
                    'question_count': scope_values.get('question_count'),
                    'question_catalog_count': scope_values.get('question_catalog_count'),
                    'question_tag_count': scope_values.get('question_tag_count'),
                    'question_asset_count': scope_values.get('question_asset_count'),
                    'snapshot_complete': scope_values.get('snapshot_complete'),
                    'snapshot_locked_at': scope_values.get('snapshot_locked_at'),
                }
                await _persist_progress_scope(handle, run_id, external_id, scope_values)
        elif handle.task_module == 'question' and len(handle.textbook_external_ids) == 1:
            # Older collector projections expose a single scope's run ID only
            # at the top level.  Preserve that identity so the comparison
            # endpoint can still read the immutable snapshot.
            top_run_id = remote.get('collectorRunId') or remote.get('collector_run_id')
            observed_scopes[handle.textbook_external_ids[0]] = {
                'status': status if status != 'cancelling' else 'running',
                'collector_run_id': top_run_id,
                'resume_from_collector_run_id': remote.get('resumeFromCollectorRunId')
                or remote.get('resume_from_collector_run_id'),
                'catalog_count': remote.get('catalogCount') or remote.get('catalog_count') or 0,
                'question_count': remote.get('questionCount') or remote.get('question_count') or 0,
                'question_catalog_count': remote.get('questionCatalogCount') or remote.get('question_catalog_count') or remote.get('relationCount') or remote.get('relation_count') or 0,
                'question_tag_count': remote.get('questionTagCount') or remote.get('question_tag_count') or remote.get('tagCount') or remote.get('tag_count') or 0,
                'question_asset_count': remote.get('questionAssetCount') or remote.get('question_asset_count') or remote.get('assetCount') or remote.get('asset_count') or 0,
                'snapshot_complete': _status_flag(
                    remote.get('snapshotComplete')
                    if remote.get('snapshotComplete') is not None
                    else remote.get('snapshot_complete')
                ),
                'snapshot_locked_at': _scope_datetime(remote.get('snapshotLockedAt') or remote.get('snapshot_locked_at') or remote.get('lockedAt') or remote.get('locked_at')),
            }
            if top_run_id:
                await _persist_progress_scope(
                    handle,
                    run_id,
                    handle.textbook_external_ids[0],
                    {
                        'collector_job_id': remote_job_id,
                        'collector_run_id': top_run_id,
                        'resume_from_collector_run_id': remote.get('resumeFromCollectorRunId')
                        or remote.get('resume_from_collector_run_id'),
                        'status': status if status != 'cancelling' else 'running',
                        'catalog_count': remote.get('catalogCount') or remote.get('catalog_count') or 0,
                        'question_count': remote.get('questionCount') or remote.get('question_count') or 0,
                        'question_catalog_count': remote.get('questionCatalogCount') or remote.get('question_catalog_count') or 0,
                        'question_tag_count': remote.get('questionTagCount') or remote.get('question_tag_count') or 0,
                        'question_asset_count': remote.get('questionAssetCount') or remote.get('question_asset_count') or 0,
                        'snapshot_complete': _status_flag(
                            remote.get('snapshotComplete')
                            if remote.get('snapshotComplete') is not None
                            else remote.get('snapshot_complete')
                        ),
                        'snapshot_locked_at': _scope_datetime(remote.get('snapshotLockedAt') or remote.get('snapshot_locked_at') or remote.get('lockedAt') or remote.get('locked_at')),
                    },
                )
        durable_status = await _current_status(run_id)
        if durable_status == 'cancelling' and status not in {'cancelled', 'completed', 'failed', 'blocked'}:
            await _terminate_process(handle)
        elif durable_status not in {'starting', 'running', 'cancelling'}:
            await _terminate_process(handle)
            return

        if status in {'queued', 'running', 'cancelling'}:
            await asyncio.sleep(PROCESS_POLL_SECONDS)
            remote = await asyncio.to_thread(client.job, remote_job_id)
            continue

        metadata_run_id = int(remote.get('metadataRunId') or 0)
        if metadata_run_id > 0 and handle.task_module != 'question':
            handle.metadata_run_id = metadata_run_id
        if status == 'completed':
            if handle.task_module == 'question':
                await _validate_remote_question_scopes(run_id, handle, observed_scopes, client)
            if handle.task_module == 'textbook':
                metadata_id = int(remote.get('metadataRunId') or remote.get('metadata_run_id') or 0)
                if metadata_id <= 0:
                    await _finish(
                        run_id,
                        handle,
                        'failed',
                        'failed',
                        '远程元数据任务缺少 metadataRunId，无法物化教材范围',
                    )
                    return
                try:
                    await _materialize_textbook_scopes(run_id, metadata_id)
                except Exception as exc:
                    await _finish(
                        run_id,
                        handle,
                        'failed',
                        'failed',
                        f'教材范围物化失败：{_exception_message(exc, "教材范围物化失败")}',
                    )
                    return
            scope_summary_counts = (
                {
                    'catalog_count': initial_question_counts['catalog_count'] + sum(
                        int(item.get('catalog_count') or 0) for item in observed_scopes.values()
                    ),
                    'question_count': initial_question_counts['question_count'] + sum(
                        int(item.get('question_count') or 0) for item in observed_scopes.values()
                    ),
                    'question_catalog_count': initial_question_counts['question_catalog_count'] + sum(
                        int(item.get('question_catalog_count') or 0) for item in observed_scopes.values()
                    ),
                    'question_tag_count': initial_question_counts['question_tag_count'] + sum(
                        int(item.get('question_tag_count') or 0) for item in observed_scopes.values()
                    ),
                    'question_asset_count': initial_question_counts['question_asset_count'] + sum(
                        int(item.get('question_asset_count') or 0) for item in observed_scopes.values()
                    ),
                }
                if handle.task_module == 'question'
                else {}
            )
            scope_locks = list(initial_question_locks)
            scope_locks.extend(
                item.get('snapshot_locked_at')
                for item in observed_scopes.values()
                if item.get('snapshot_locked_at')
            )
            scope_snapshot_values = (
                {
                    'question_catalog_count': scope_summary_counts['question_catalog_count'],
                    'question_tag_count': scope_summary_counts['question_tag_count'],
                    'question_asset_count': scope_summary_counts['question_asset_count'],
                    'snapshot_complete': True,
                    'snapshot_locked_at': min(scope_locks) if scope_locks else None,
                }
                if handle.task_module == 'question'
                else {}
            )
            terminal_catalog_count = (
                int(scope_summary_counts['catalog_count'])
                if handle.task_module == 'question'
                else int(remote.get('catalogCount') or 0)
            )
            terminal_question_count = (
                int(scope_summary_counts['question_count'])
                if handle.task_module == 'question'
                else int(remote.get('questionCount') or 0)
            )
            terminal_textbook_count = (
                len(all_question_ids)
                if handle.task_module == 'question'
                else int(remote.get('totalTextbooks') or 0)
            )
            terminal_completed_textbook_count = (
                initial_completed_textbooks + len(handle.textbook_external_ids)
                if handle.task_module == 'question'
                else int(remote.get('completedTextbooks') or 0)
            )
            await _finish(
                run_id,
                handle,
                'completed',
                'completed',
                None,
                catalog_count=terminal_catalog_count,
                question_count=terminal_question_count,
                total_textbooks=terminal_textbook_count,
                completed_textbooks=terminal_completed_textbook_count,
                **scope_snapshot_values,
            )
            return
        if status == 'interrupted':
            # An interrupted remote collector has a sealed partial snapshot,
            # but it is never eligible for apply.  Preserve the partial
            # per-scope projection and leave the task resumable in place.
            if handle.task_module == 'question':
                missing_partial_ids = [
                    external_id
                    for external_id in handle.textbook_external_ids
                    if str(observed_scopes.get(external_id, {}).get('status') or '').lower() == 'interrupted'
                    and _positive_collector_run_id(
                        observed_scopes.get(external_id, {}).get('collector_run_id')
                    )
                    is None
                ]
                if missing_partial_ids:
                    await _finish(
                        run_id,
                        handle,
                        'failed',
                        'failed',
                        f'远程中断范围缺少 collectorRunId：{", ".join(missing_partial_ids)}',
                    )
                    return
            partial_counts = {
                key: initial_question_counts[key]
                + sum(int(item.get(key) or 0) for item in observed_scopes.values())
                for key in (
                    'catalog_count',
                    'question_count',
                    'question_catalog_count',
                    'question_tag_count',
                    'question_asset_count',
                )
            }
            partial_run_ids = [
                _positive_collector_run_id(item.get('collector_run_id'))
                for item in observed_scopes.values()
                if str(item.get('status') or '').lower() == 'interrupted'
            ]
            partial_run_ids = [item for item in partial_run_ids if item is not None]
            if handle.task_module == 'question' and len(partial_run_ids) == 1:
                auto_pending = await _mark_auto_resume_pending(run_id, partial_run_ids[0])
                if auto_pending:
                    handle.log_lines.append(
                        f'[自动续采] collectorRunId={partial_run_ids[0]} 已保留，将按退避策略续采'
                    )
            await _finish(
                run_id,
                handle,
                'interrupted',
                'interrupted',
                str(remote.get('errorMessage') or remote.get('error_message') or 'collector 采集被中断')[:1000],
                catalog_count=partial_counts['catalog_count'] or int(remote.get('catalogCount') or 0),
                question_count=partial_counts['question_count'] or int(remote.get('questionCount') or 0),
                question_catalog_count=partial_counts['question_catalog_count'],
                question_tag_count=partial_counts['question_tag_count'],
                question_asset_count=partial_counts['question_asset_count'],
                total_textbooks=len(all_question_ids) if handle.task_module == 'question' else None,
                completed_textbooks=initial_completed_textbooks + sum(
                    1 for item in observed_scopes.values() if str(item.get('status') or '').lower() == 'completed'
                )
                if handle.task_module == 'question'
                else None,
                snapshot_complete=False if handle.task_module == 'question' else None,
            )
            return
        if status == 'cancelled':
            await _finish(
                run_id,
                handle,
                'cancelled',
                'cancelled',
                '同步已停止',
                catalog_count=int(remote.get('catalogCount') or 0),
                question_count=int(remote.get('questionCount') or 0),
            )
            return
        message = str(remote.get('errorMessage') or 'collector 远程任务执行失败')[:1000]
        await _finish(
            run_id,
            handle,
            status,
            status,
            message,
            catalog_count=int(remote.get('catalogCount') or 0),
            question_count=int(remote.get('questionCount') or 0),
        )
        return


async def _execute(run_id: int, handle: _WorkerHandle) -> None:  # noqa: PLR0912, PLR0915
    owner_context = None
    try:
        # Rehydrate module/options from the durable row.  This is important
        # after a process restart and also keeps the worker from trusting
        # request-local state over the immutable task snapshot.
        try:
            persisted_row = await _load_row(run_id)
        except Exception:
            # The small unit-test doubles intentionally omit a database row;
            # a normal recovered worker must never continue without one.
            if handle.recovered:
                raise
            persisted_row = None
        if persisted_row is not None:
            if getattr(persisted_row, 'dispatch_job_id', None):
                if persisted_row.worker_token != handle.token:
                    return
                handle.dispatch_job_id = persisted_row.dispatch_job_id
                owner_context = _QUEUE_OWNER.set((run_id, handle.token))
            handle.task_module = (
                _scope_field(persisted_row, 'task_module', 'taskModule', default=None) or handle.task_module or 'center'
            )
            handle.run_type = _scope_field(persisted_row, 'run_type', 'runType', default=None) or handle.run_type
            if handle.task_module == 'question':
                # The database scope rows are the immutable execution input.
                # Rebuild them on every persisted-worker start, including a
                # normal in-process worker, so request/handle state cannot
                # replace a committed formal selection.
                options = _scope_field(persisted_row, 'options_json', 'optionsJson', default={})
                if isinstance(options, str):
                    try:
                        options = json.loads(options)
                    except (TypeError, json.JSONDecodeError):
                        options = {}
                options = options if isinstance(options, Mapping) else {}
                handle.workflow_version = int(options.get('workflowVersion', 1))
                handle.resumed = handle.resumed or bool(options.get('resumeTask') or options.get('resume_task'))
                handle.limit_to_1000_pages = _status_flag(
                    options.get(
                        'limitTo1000Pages',
                        options.get('limit_to_1000_pages', handle.limit_to_1000_pages),
                    )
                )
                handle.metadata_run_id = None
                handle.textbook_scopes = await _durable_question_scope_identities(run_id, options)
                handle.textbook_external_ids = [
                    identity['externalTextbookId'] for identity in handle.textbook_scopes
                ]
            if handle.task_module != 'question':
                handle.metadata_run_id = handle.metadata_run_id or _scope_field(
                    persisted_row,
                    'metadata_run_id',
                    'metadataRunId',
                )
            handle.remote_job_id = handle.remote_job_id or _scope_field(
                persisted_row,
                'collector_job_id',
                'collectorJobId',
            )
        if handle.recovered and persisted_row is None:
            await _finish(run_id, handle, 'failed', 'failed', '恢复同步任务时找不到持久化任务记录')
            return
        if handle.task_module == 'question' and persisted_row is None:
            # Narrow test/compatibility path for a freshly-created handle
            # whose caller already supplied the server-resolved scope rows.
            # Recovered workers never enter this branch without a durable row.
            handle.metadata_run_id = None
            handle.textbook_scopes = _strict_question_scope_identities(handle.textbook_scopes)
            handle.textbook_external_ids = [
                identity['externalTextbookId'] for identity in handle.textbook_scopes
            ]
        run_type = handle.run_type
        if run_type not in SYNC_RUN_TYPES:
            await _finish(run_id, handle, 'failed', 'failed', '不支持的同步任务类型')
            return
        # A worker may be recreated by a future recovery loop.  The task row's
        # server-generated options snapshot is the source of truth for the
        # selected textbook IDs; never infer a default scope.
        if run_type == 'content':
            row = persisted_row
            options = _scope_field(row, 'options_json', 'optionsJson', default=None) if row is not None else None
            if isinstance(options, str):
                try:
                    options = json.loads(options)
                except (TypeError, json.JSONDecodeError):
                    options = {}
            if isinstance(options, dict):
                handle.resumed = handle.resumed or bool(options.get('resumeTask') or options.get('resume_task'))
                handle.limit_to_1000_pages = _status_flag(
                    options.get(
                        'limitTo1000Pages',
                        options.get('limit_to_1000_pages', handle.limit_to_1000_pages),
                    )
                )
                # metadataRunId remains a legacy content/center input. An
                # independent question task is driven by its durable scopes.
                if handle.task_module != 'question':
                    handle.metadata_run_id = handle.metadata_run_id or options.get('metadataRunId')
                values = options.get('textbookExternalIds')
                if handle.task_module != 'question' and not handle.textbook_external_ids and isinstance(values, list):
                    handle.textbook_external_ids = [str(value).strip() for value in values]
        try:
            durable_status = await _current_status(run_id)
        except Exception:
            durable_status = None

        if handle.recovered:
            if durable_status == 'cancelling':
                # A restart can happen after the HTTP cancel request but
                # before the original worker reaches its cancellation branch.
                # Tell the collector as well; otherwise the service row would
                # become terminal while the remote crawl keeps running.
                await _terminate_process(handle)
                await _finish(run_id, handle, 'cancelled', 'cancelled', '同步已停止')
                return
            if durable_status not in {'queued', 'starting', 'running'}:
                return
            if durable_status == 'queued':
                # Queued rows are deliberately recovered after a process
                # restart. Claim them before polling a remote collector;
                # otherwise the heartbeat loop could treat the still-queued
                # row as an orphan and start a duplicate remote job.
                claimed = await _update_row(
                    run_id,
                    {
                        'status': 'starting',
                        'phase': 'metadata' if run_type == 'metadata' else 'catalogs_questions',
                        'started_at': datetime.now(),
                        'worker_token': handle.token,
                    },
                    expected_statuses=('queued',),
                )
                if not claimed:
                    try:
                        if await _current_status(run_id) == 'cancelling':
                            await _finish(run_id, handle, 'cancelled', 'cancelled', '同步已停止')
                    except Exception:
                        pass
                    return
                running = await _update_row(
                    run_id,
                    {
                        'status': 'running',
                        'phase': 'metadata' if run_type == 'metadata' else 'catalogs_questions',
                        'progress_percent': Decimal('5'),
                    },
                    expected_statuses=('starting',),
                )
                if not running:
                    try:
                        if await _current_status(run_id) == 'cancelling':
                            await _finish(run_id, handle, 'cancelled', 'cancelled', '同步已停止')
                    except Exception:
                        pass
                    return
            running = True
        else:
            claimed = await _update_row(
                run_id,
                {
                    'status': 'starting',
                    'phase': 'metadata' if run_type == 'metadata' else 'catalogs_questions',
                    'started_at': datetime.now(),
                    'worker_token': handle.token,
                    'log_tail': _tail_text(handle.log_lines),
                },
                expected_statuses=('queued',),
            )
            if not claimed:
                try:
                    cancelled_before_start = await _current_status(run_id) == 'cancelling'
                except Exception:
                    cancelled_before_start = False
                if cancelled_before_start:
                    if _QUEUE_OWNER.get():
                        await _terminate_process(handle)
                    await _finish(run_id, handle, 'cancelled', 'cancelled', '同步在启动前被停止')
                return

            running = await _update_row(
                run_id,
                {
                    'status': 'running',
                    'phase': 'metadata' if run_type == 'metadata' else 'catalogs_questions',
                    'progress_percent': Decimal('5'),
                },
                expected_statuses=('starting',),
            )
            if not running:
                try:
                    cancelled_before_start = await _current_status(run_id) == 'cancelling'
                except Exception:
                    cancelled_before_start = False
                if cancelled_before_start:
                    await _finish(run_id, handle, 'cancelled', 'cancelled', '同步在启动前被停止')
                return
        max_pages = _max_pages()
        await _execute_remote(run_id, handle, max_pages)
        return
    except DispatchDeferred as exc:
        await _update_row(run_id, {
            'status': 'queued', 'active_slot': None, 'started_at': None,
            'dispatch_error': exc.message,
            'dispatch_not_before': datetime.utcnow() + timedelta(seconds=30),
        }, expected_statuses=('starting', 'running'))
    except DispatchAckPending as exc:
        from plugins.bank.service.incremental_import import _clock
        async with DataSourceRegistry.session() as clock_db:
            retry_at = await _clock(clock_db) + timedelta(seconds=30)
        await _update_row(run_id, {
            'status': 'queued', 'dispatch_error': exc.message,
            'dispatch_not_before': retry_at,
        }, expected_statuses=('starting', 'running'))
    except WorkerOwnershipLost:
        return
    except asyncio.CancelledError:
        # Application shutdown can cancel the Python task after signalling the
        # child.  Keep a durable terminal state for the next process.
        try:
            await _terminate_process(handle)
            await _finish(run_id, handle, 'cancelled', 'cancelled', '后端服务关闭，任务已停止')
        except Exception:
            pass
        raise
    except (ServiceException, OSError, SQLAlchemyError) as exc:
        await _finish(
            run_id,
            handle,
            'failed',
            'failed',
            _exception_message(exc, '同步任务执行失败'),
        )
    except Exception as exc:  # pragma: no cover - defensive worker boundary
        await _finish(run_id, handle, 'failed', 'failed', f'同步任务异常：{exc}')
    finally:
        if owner_context is not None:
            _QUEUE_OWNER.reset(owner_context)
        if _WORKERS.get(run_id) is handle:
            _WORKERS.pop(run_id, None)


async def _finalize_scopes(
    run_id: int,
    status: str,
    error_message: str | None,
) -> None:
    """Move unfinished scope rows with their parent task into a terminal state.

    Scope updates are deliberately best-effort for pre-006 installations so
    the original synchronization centre remains usable while an operator is
    applying the additive migration.  A completed/failed/cancelled collector
    run is never reopened by this helper.
    """

    if status not in {'completed', 'failed', 'blocked', 'cancelled', 'interrupted'}:
        return
    try:
        scopes = await _load_scopes(run_id)
    except Exception:
        return
    for scope in scopes:
        current = str(_scope_field(scope, 'status', 'state', default='') or '').lower()
        if current in {'completed', 'failed', 'blocked', 'cancelled', 'interrupted'}:
            continue
        next_status = status
        message = error_message
        if status in {'failed', 'blocked'} and current == 'queued':
            next_status = 'cancelled'
            message = message or '因任务失败未执行'
        external_id = str(_scope_field(scope, 'external_textbook_id', 'externalTextbookId', default='') or '') or None
        values: dict[str, Any] = {
            'status': next_status,
            'finished_at': datetime.now(),
            'error_message': message,
        }
        await _update_scope_values(
            run_id,
            values,
            external_textbook_id=external_id,
            expected_statuses=('queued', 'starting', 'running'),
        )


async def _finish(  # noqa: PLR0913
    run_id: int,
    handle: _WorkerHandle,
    status: str,
    phase: str,
    error_message: str | None,
    *,
    catalog_count: int | None = None,
    question_count: int | None = None,
    total_textbooks: int | None = None,
    completed_textbooks: int | None = None,
    question_catalog_count: int | None = None,
    question_tag_count: int | None = None,
    question_asset_count: int | None = None,
    snapshot_complete: bool | None = None,
    snapshot_locked_at: datetime | None = None,
) -> None:
    def finish_values(final_status: str, final_phase: str, final_error: str | None) -> dict[str, Any]:
        values: dict[str, Any] = {
            'status': final_status,
            'phase': final_phase,
            'active_slot': None,
            'process_id': None,
            'worker_token': handle.token if _QUEUE_OWNER.get() else None,
            'current_textbook_id': None,
            'current_textbook_name': None,
            'finished_at': datetime.now(),
            'error_message': final_error,
        }
        # Remote collector jobs already persisted their log tail while being
        # polled.  The local handle is empty for those jobs, so writing its
        # empty buffer here would erase the durable remote log at completion.
        if handle.log_lines:
            values['log_tail'] = _tail_text(handle.log_lines)
        if final_status == 'completed':
            values['progress_percent'] = Decimal('100')
        values.update(
            {
                key: value
                for key, value in (
                    ('catalog_count', catalog_count),
                    ('question_count', question_count),
                    ('question_catalog_count', question_catalog_count),
                    ('question_tag_count', question_tag_count),
                    ('question_asset_count', question_asset_count),
                    ('total_textbooks', total_textbooks),
                    ('completed_textbooks', completed_textbooks),
                    ('snapshot_complete', snapshot_complete),
                    ('snapshot_locked_at', snapshot_locked_at),
                )
                if value is not None
            }
        )
        return values

    values = finish_values(status, phase, error_message)
    owner = _QUEUE_OWNER.get()
    if owner:
        async with DataSourceRegistry.session() as db:
            parent = await SyncTaskDao.get_for_update(db, run_id, 'question')
            if parent is None or parent.worker_token != owner[1] or parent.status not in (
                'queued', 'starting', 'running', 'cancelling',
            ):
                return
            if parent.status == 'cancelling':
                status, error_message = 'cancelled', '同步已停止'
                values = finish_values(status, status, error_message)
            for key, value in values.items():
                setattr(parent, key, value)
            # Job and unfinished scopes settle together. A dispatcher must
            # not release the book between these two lifecycle writes.
            for scope in await SyncTaskDao.scopes_for_update(db, run_id):
                if scope.status in ('queued', 'starting', 'running'):
                    scope.status = 'cancelled' if status in ('failed', 'blocked') and scope.status == 'queued' else status
                    scope.error_message = error_message
                    scope.finished_at = scope.update_time = datetime.now()
            await db.commit()
        from plugins.bank.service.import_intake_worker import register_task_intake
        await register_task_intake(run_id)
        return
    expected_statuses = (
        ('queued', 'starting', 'running', 'cancelling')
        if status == 'cancelled'
        else (
            'queued',
            'starting',
            'running',
        )
    )
    try:
        updated = await _update_row(run_id, values, expected_statuses=expected_statuses)
        if not updated and _QUEUE_OWNER.get():
            fallback = await _update_row(
                run_id, finish_values('cancelled', 'cancelled', '同步已停止'), expected_statuses=('cancelling',),
            )
            if not fallback:
                return
            status, error_message = 'cancelled', '同步已停止'
            updated = True
        if updated or status in {'cancelled', 'interrupted'}:
            await _finalize_scopes(run_id, status, error_message)
            if handle.task_module == 'question' and handle.workflow_version == 2:
                from plugins.bank.service.import_intake_worker import register_task_intake
                await register_task_intake(run_id)
            return

        # Cancellation and process completion can arrive together.  If the
        # durable cancellation update won, preserve that intent instead of
        # overwriting it with completed/failed/blocked.
        await _update_row(
            run_id,
            finish_values('cancelled', 'cancelled', '同步已停止'),
            expected_statuses=('cancelling',),
        )
        await _finalize_scopes(run_id, 'cancelled', '同步已停止')
        if handle.task_module == 'question' and handle.workflow_version == 2:
            from plugins.bank.service.import_intake_worker import register_task_intake
            await register_task_intake(run_id)
    except Exception:
        # The original task state remains queryable even if the final status
        # update races with a database shutdown; startup recovery handles it.
        return


class SyncRunService:
    """Public service used by the controller and plugin lifecycle hooks."""

    @staticmethod
    async def _create_job(  # noqa: PLR0912, PLR0913, PLR0915
        db: AsyncSession,
        *,
        run_type: str,
        acknowledge_source_policy: bool,
        operator: str | None,
        task_module: str = 'center',
        metadata_run_id: int | None = None,
        textbook_external_ids: list[str] | None = None,
        source_task_id: int | None = None,
        retry_of_run_id: int | None = None,
        scope_rows: list[dict[str, Any]] | None = None,
        extra_options: dict[str, Any] | None = None,
        defer_dispatch: bool = False,
    ) -> dict[str, Any]:
        """Persist one task and schedule its worker after the transaction commits."""

        if run_type not in SYNC_RUN_TYPES:
            raise ServiceException(message='不支持的同步任务类型')
        if task_module not in {'center', 'textbook', 'question'}:
            raise ServiceException(message='不支持的同步任务模块')
        if task_module == 'textbook' and run_type != 'metadata':
            raise ServiceException(message='同步教材任务必须使用 metadata 运行类型')
        if task_module == 'question' and run_type != 'content':
            raise ServiceException(message='同步题库任务必须使用 content 运行类型')
        if run_type == 'content' and task_module != 'question':
            # Legacy sync-center content jobs still identify a selected
            # metadata snapshot. Independent question jobs carry their own
            # formal/external scope identity and deliberately leave this NULL.
            if metadata_run_id is None:
                raise ServiceException(message='内容任务缺少 metadataRunId')
            try:
                valid_metadata_run_id = int(metadata_run_id) > 0
            except (TypeError, ValueError):
                valid_metadata_run_id = False
            if not valid_metadata_run_id:
                raise ServiceException(message='metadataRunId 必须是正整数')
            metadata_run_id = int(metadata_run_id)
        if not acknowledge_source_policy:
            raise ServiceException(message='开始同步前必须确认已核对来源站规则、授权范围和内容使用边界')
        from plugins.bank.service.sync_plans import control_status
        if (await control_status(db))['paused']:
            raise ServiceException(message='同步已紧急暂停，请在同步总览恢复后再创建任务')
        if task_module == 'textbook':
            defer_dispatch = True
        # Fail closed at task creation: every worker, resume, and status path
        # relies on the configured collector HTTP service.
        if not defer_dispatch:
            await asyncio.to_thread(CollectorClient().health)
        selected = list(textbook_external_ids or [])
        if len(selected) > MAX_SELECTED_TEXTBOOKS:
            raise ServiceException(message=f'教材选择数量不能超过 {MAX_SELECTED_TEXTBOOKS}')
        if len(selected) != len(set(selected)):
            raise ServiceException(message='教材选择列表不能包含重复 ID')
        if any(not _safe_external_id(value) for value in selected):
            raise ServiceException(message='教材来源 ID 不安全')
        if run_type == 'content' and not selected:
            raise ServiceException(message='内容任务必须选择教材范围')
        selected_scope_rows = list(scope_rows or [])
        if task_module == 'question' and not selected_scope_rows:
            raise ServiceException(message='题库任务必须持久化至少一个教材范围')
        if len(selected_scope_rows) > MAX_SELECTED_TEXTBOOKS:
            raise ServiceException(message=f'教材范围数量不能超过 {MAX_SELECTED_TEXTBOOKS}')
        resolved_textbook_scopes: list[dict[str, Any]] = []
        if selected_scope_rows:
            scope_selected = [
                str(
                    _scope_field(
                        item,
                        'external_textbook_id',
                        'externalTextbookId',
                        'textbookExternalId',
                        default='',
                    )
                    or ''
                ).strip()
                for item in selected_scope_rows
            ]
            if any(not _safe_external_id(value) for value in scope_selected):
                raise ServiceException(message='教材来源 ID 不安全')
            if len(scope_selected) != len(set(scope_selected)):
                raise ServiceException(message='教材范围不能包含重复来源 ID')
            if run_type == 'content' and not scope_selected:
                raise ServiceException(message='题库任务必须选择教材范围')
            if selected and set(selected) != set(scope_selected):
                raise ServiceException(message='教材范围与执行选项不一致')
            if not selected:
                selected = scope_selected
            for item in selected_scope_rows:
                identity = _scope_identity(item)
                if identity['sourceProvider'] != PROVIDER:
                    raise ServiceException(message='教材范围来源提供方不受支持')
                if not _safe_external_id(identity['externalVersionId']):
                    raise ServiceException(message='版本来源 ID 不安全')
                if not _safe_external_id(identity['externalTextbookId']):
                    raise ServiceException(message='教材来源 ID 不安全')
                resolved_textbook_scopes.append(identity)
        if selected and len(selected) != len(set(selected)):
            raise ServiceException(message='教材选择列表不能包含重复 ID')
        options: dict[str, Any] = {
            'provider': PROVIDER,
            'workflowVersion': 2 if not (source_task_id or retry_of_run_id) else 1,
            'subjectId': 1,
            'sourceProfile': 'zujuan_czsx',
            'sourceNamespace': 'zujuan:junior:math',
            'taskModule': task_module,
            'catalogLevels': [1, 2, 3],
            'maxPages': _max_pages(),
            'runType': run_type,
        }
        if task_module == 'question':
            options.update(
                {
                    'autoResume': True,
                    'autoResumeMaxAttempts': AUTO_RESUME_MAX_ATTEMPTS,
                    'autoResumeAttempt': 0,
                    'autoResumePending': False,
                    'autoResumeNextAt': None,
                    'limitTo1000Pages': False,
                }
            )
        if run_type == 'content':
            # This is a server-generated execution snapshot. Do not persist
            # collector URLs, database paths, scripts, or process settings.
            options.update(
                {
                    'metadataRunId': metadata_run_id if task_module != 'question' else None,
                    'textbookExternalIds': selected,
                }
            )
            if task_module == 'question':
                options['textbookScopes'] = resolved_textbook_scopes
        if source_task_id is not None:
            if int(source_task_id) <= 0:
                raise ServiceException(message='sourceTaskId 必须是正整数')
            options['sourceTaskId'] = int(source_task_id)
        if retry_of_run_id is not None:
            if int(retry_of_run_id) <= 0:
                raise ServiceException(message='retryOfRunId 必须是正整数')
            options['retryOfRunId'] = int(retry_of_run_id)
        if extra_options:
            # Only server-resolved display/identity values may be persisted.
            # Runtime collector configuration must come from the environment.
            # Reject configuration-shaped keys by family so spelling/case
            # variants cannot smuggle a local endpoint, script, or browser
            # mode into the durable task options.  Keep the concrete legacy
            # names out of runtime source: they are historical input values,
            # never supported service configuration.
            forbidden_modes = {'headful', 'executionmode'}
            safe_extra = {
                key: value
                for key, value in extra_options.items()
                if (
                    (normalized_key := re.sub(r'[^a-z0-9]', '', str(key).lower())) not in forbidden_modes
                    and 'collector' not in normalized_key
                    and 'script' not in normalized_key
                )
            }
            options.update(_jsonable(safe_extra))
        if task_module == 'question':
            # Keep the policy as a canonical boolean in the durable task
            # snapshot. Missing/legacy values intentionally mean disabled.
            options['limitTo1000Pages'] = _status_flag(
                options.get('limitTo1000Pages', options.get('limit_to_1000_pages', False))
            )
        # Identity fields are always reconstructed from the validated scope
        # rows after optional display options. This prevents an internal
        # caller from replacing the server-owned collector selection.
        if selected_scope_rows:
            options['textbookExternalIds'] = selected
            if task_module == 'question':
                options['textbookScopes'] = resolved_textbook_scopes
                options['metadataRunId'] = None
        if selected and not selected_scope_rows and task_module == 'question':
            raise ServiceException(message='题库任务必须持久化教材范围')
        if run_type == 'content' and options.get('workflowVersion', 2) >= 2 and len(selected) != 1:
            raise ServiceException(message='新同步任务必须且只能选择一本教材')
        dispatch_key = None
        if defer_dispatch:
            from plugins.bank.service.sync_dispatch import (
                book_key,
                existing_book_task,
                legacy_unsettled_book_task,
                request_manual_dispatch,
            )
            if task_module == 'textbook':
                from plugins.bank.service.subject_service import SubjectService
                await SubjectService.require(db, int(options['subjectId']), sync=True)
                dispatch_key = book_key(int(options['subjectId']), PROVIDER, '__discovery__')
                existing = await existing_book_task(db, dispatch_key, limit_to_1000_pages=False)
                if existing is not None:
                    if not options.get('autoPlanId'):
                        await request_manual_dispatch(db, existing, operator)
                    return _status_from_row(existing) or {}
            elif task_module == 'question' and options.get('workflowVersion') == 2 and len(selected_scope_rows) == 1:
                local_book_id = _scope_field(selected_scope_rows[0], 'local_textbook_id', 'localTextbookId')
                if not local_book_id or await db.get(QbTextbook, int(local_book_id), with_for_update=True) is None:
                    raise ServiceException(message='待办任务必须绑定正式教材')
                dispatch_key = book_key(int(options['subjectId']), PROVIDER, selected[0])
                existing = await existing_book_task(db, dispatch_key, limit_to_1000_pages=options.get('limitTo1000Pages', False))
                if existing is not None:
                    if not options.get('autoPlanId'):
                        await request_manual_dispatch(db, existing, operator)
                    return _status_from_row(existing, await SyncTaskDao.scopes(db, existing.run_id)) or {}
                legacy = await legacy_unsettled_book_task(db, int(options['subjectId']), PROVIDER, selected[0])
                if legacy is not None:
                    if _row_options(legacy).get('workflowVersion', 1) < 2:
                        raise ServiceException(message='该教材已有旧版活动任务，请先等待或停止原任务')
                    return _status_from_row(legacy, await SyncTaskDao.scopes(db, legacy.run_id)) or {}
            else:
                raise ServiceException(message='持久待办只接受教材发现或新版单本题库任务')
        row = QbSyncJob(
            run_type=run_type,
            task_module=task_module,
            status='queued',
            phase='metadata' if run_type == 'metadata' else 'catalogs_questions',
            acknowledge_source_policy='Y',
            metadata_run_id=None if task_module == 'question' else metadata_run_id,
            source_task_id=None if task_module == 'question' else source_task_id,
            retry_of_run_id=retry_of_run_id,
            options_json=options,
            total_textbooks=len(selected) if run_type == 'content' else 0,
            subject_id=int(options['subjectId']),
            active_slot=None if defer_dispatch else '1',
            dispatch_book_key=dispatch_key,
            dispatch_job_id=str(uuid4()) if defer_dispatch else None,
            created_by=operator,
            create_time=datetime.now(),
            update_time=datetime.now(),
        )
        scope_entities: list[QbSyncJobScope] = []
        run_id: int
        try:
            if not defer_dispatch:
                stale_before = datetime.now() - timedelta(seconds=WORKER_HEARTBEAT_TIMEOUT_SECONDS)
                await SyncJobDao.mark_interrupted(
                    db,
                    '后端工作进程已失联，未完成的同步任务已标记为失败',
                    stale_before,
                )
            await SyncJobDao.add(db, row)
            run_id = int(row.run_id)
            if selected_scope_rows:
                scope_entities = [
                    _scope_entity_from_payload(run_id, item, None if task_module == 'question' else metadata_run_id, task_module)
                    for item in selected_scope_rows
                ]
                if hasattr(db, 'add_all'):
                    db.add_all(scope_entities)
                else:
                    for scope in scope_entities:
                        db.add(scope)
                await db.flush()
            if task_module == 'question':
                from plugins.bank.service.question_review_service import capture_review
                await capture_review(db, run_id, scope_entities)
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            if defer_dispatch:
                existing = await existing_book_task(db, dispatch_key, limit_to_1000_pages=options.get('limitTo1000Pages', False))
                if existing is not None:
                    if not options.get('autoPlanId'):
                        await request_manual_dispatch(db, existing, operator)
                    return _status_from_row(existing, await SyncTaskDao.scopes(db, existing.run_id)) or {}
            raise ServiceException(message='已有同步任务正在运行，请等待当前任务完成') from exc

        # MySQL does not return every server-generated default on INSERT.
        # Load them explicitly before projecting the response so attribute
        # access cannot trigger implicit async IO outside greenlet_spawn.
        await db.refresh(row)
        for scope in scope_entities:
            await db.refresh(scope)
        response = _status_from_row(row, scope_entities) if scope_entities else _status_from_row(row)

        if defer_dispatch:
            return response or {}

        token = secrets.token_hex(32)
        handle = _WorkerHandle(
            token=token,
            run_type=run_type,
            task_module=task_module,
            metadata_run_id=None if task_module == 'question' else metadata_run_id,
            textbook_external_ids=selected,
            textbook_scopes=resolved_textbook_scopes,
            workflow_version=int(options.get('workflowVersion', 1)),
            limit_to_1000_pages=bool(options.get('limitTo1000Pages', False)),
        )
        task = asyncio.create_task(_execute(run_id, handle))
        handle.task = task
        _WORKERS[run_id] = handle
        return response or {}

    @staticmethod
    async def start_metadata(
        db: AsyncSession,
        payload: SyncRunStartRequestModel,
        operator: str | None,
    ) -> dict[str, Any]:
        """Start only the versions + textbooks metadata collector."""

        return await SyncRunService._create_job(
            db,
            run_type='metadata',
            acknowledge_source_policy=payload.acknowledge_source_policy,
            operator=operator,
        )

    @staticmethod
    async def start_content(
        db: AsyncSession,
        payload: SyncContentRunStartRequestModel,
        operator: str | None,
    ) -> dict[str, Any]:
        """Validate an exact metadata snapshot selection before scheduling content."""

        if not payload.acknowledge_source_policy:
            raise ServiceException(message='开始同步前必须确认已核对来源站规则、授权范围和内容使用边界')
        await asyncio.to_thread(CollectorClient().health)
        selected = [str(value or '').strip() for value in payload.textbook_external_ids]
        if not selected or len(selected) > MAX_SELECTED_TEXTBOOKS:
            raise ServiceException(message=f'教材选择数量必须在 1 到 {MAX_SELECTED_TEXTBOOKS} 之间')
        if len(selected) != len(set(selected)):
            raise ServiceException(message='教材选择列表不能包含重复 ID')
        if any(not _safe_external_id(value) for value in selected):
            raise ServiceException(message='教材来源 ID 不安全')
        # Validation is done before creating the MySQL task row so an invalid
        # snapshot can never occupy the global activity slot.
        await asyncio.to_thread(
            CollectorClient().validate_metadata,
            payload.metadata_run_id,
            selected,
        )
        return await SyncRunService._create_job(
            db,
            run_type='content',
            acknowledge_source_policy=payload.acknowledge_source_policy,
            operator=operator,
            metadata_run_id=payload.metadata_run_id,
            textbook_external_ids=selected,
        )

    @staticmethod
    async def catalog_progress() -> dict[str, Any]:
        """Read chapter/section/point crawl progress from the collector API."""

        return await asyncio.to_thread(CollectorClient().catalog_progress)

    @staticmethod
    async def current(db: AsyncSession) -> dict[str, Any] | None:
        row = await SyncJobDao.get_current(db)
        if row is None:
            return None
        module = str(getattr(row, 'task_module', None) or '')
        scopes = await SyncTaskDao.scopes(db, int(row.run_id)) if module in {'textbook', 'question'} else []
        return await enrich_live_progress(_status_from_row(row, scopes) or {})

    @staticmethod
    async def detail(db: AsyncSession, run_id: int) -> dict[str, Any]:
        row = await SyncJobDao.get(db, run_id)
        if row is None:
            raise ServiceException(message='同步任务不存在')
        module = str(getattr(row, 'task_module', None) or '')
        scopes = await SyncTaskDao.scopes(db, run_id) if module in {'textbook', 'question'} else []
        return await enrich_live_progress(_status_from_row(row, scopes) or {})

    @staticmethod
    async def list(db: AsyncSession, query: SyncRunPageQueryModel) -> Any:
        page = await SyncJobDao.list_page(db, query)
        projected: list[dict[str, Any]] = []
        for row in page.rows:
            module = str(_scope_field(row, 'task_module', 'taskModule', default='') or '')
            scopes = []
            if module in {'textbook', 'question'}:
                run_id = int(_scope_field(row, 'run_id', 'runId', default=0) or 0)
                scopes = await SyncTaskDao.scopes(db, run_id)
            projected.append(_status_from_row(row, scopes) or {})
        page.rows = projected
        return page

    @staticmethod
    async def resume_question(  # noqa: PLR0912, PLR0915
        db: AsyncSession,
        task_id: int,
        operator: str | None = None,
    ) -> dict[str, Any]:
        """Requeue an interrupted question task while preserving its ID.

        The task row is locked before scope rows, matching the apply/delete
        lock order.  Every interrupted scope is either bound to one strictly
        validated partial collector run or reset to a clean queued crawl;
        completed scopes remain immutable and are skipped by the worker.
        """

        try:
            parsed_task_id = int(task_id)
        except (TypeError, ValueError) as exc:
            raise ServiceException(message='同步题库任务 ID 无效') from exc
        if parsed_task_id <= 0:
            raise ServiceException(message='同步题库任务 ID 无效')
        row = await SyncTaskDao.get_for_update(db, parsed_task_id, 'question')
        if row is None:
            raise ServiceException(message='同步题库任务不存在')
        current_status = str(_scope_field(row, 'status', default='') or '').strip().lower()
        if current_status == 'queued' and getattr(row, 'dispatch_job_id', None):
            return _status_from_row(row, await SyncTaskDao.scopes(db, parsed_task_id)) or {}
        if current_status not in {'interrupted', 'blocked'}:
            raise ServiceException(message='只有已中断或已解除阻断的题库任务可以续采')
        if str(_scope_field(row, 'run_type', 'runType', default='content') or 'content').lower() != 'content':
            raise ServiceException(message='只有 content 题库任务可以续采')
        from plugins.bank.service.question_apply_service import _uses_incremental_workflow
        queue_resume = _uses_incremental_workflow(row)
        if queue_resume:
            from plugins.bank.service.import_intake import ensure_import_intake_finished
            from plugins.bank.service.incremental_import import ensure_no_active_incremental_import
            await ensure_no_active_incremental_import(db, parsed_task_id)
            await ensure_import_intake_finished(db, parsed_task_id, automatic=operator is None)

        scope_lock = getattr(SyncTaskDao, 'scopes_for_update', None) or getattr(SyncTaskDao, 'locked_scopes', None)
        if not callable(scope_lock):
            scope_lock = SyncTaskDao.scopes
        scopes = await scope_lock(db, parsed_task_id)
        if not scopes:
            raise ServiceException(message='中断题库任务缺少教材范围，不能续采')

        active = await SyncTaskDao.active(db, 'question')
        if active is not None and not queue_resume:
            active_id = _positive_collector_run_id(_scope_field(active, 'run_id', 'runId', default=None))
            if active_id is None or active_id != parsed_task_id:
                raise ServiceException(message='已有其他题库同步任务正在运行，请等待当前任务完成')
        if not queue_resume and any(other_id != parsed_task_id for other_id in _WORKERS):
            raise ServiceException(message='已有其他题库同步任务正在运行，请等待当前任务完成')

        options = _scope_field(row, 'options_json', 'optionsJson', default={})
        if isinstance(options, str):
            try:
                options = json.loads(options)
            except (TypeError, json.JSONDecodeError):
                options = {}
        options = options if isinstance(options, Mapping) else {}
        expected_ids = _question_option_external_ids(options)
        identities = _strict_question_scope_identities(scopes, expected_external_ids=expected_ids)
        identity_by_id = {identity['externalTextbookId']: identity for identity in identities}
        dispatch_key = None
        if queue_resume:
            from plugins.bank.service.sync_dispatch import book_key, existing_book_task
            if len(scopes) != 1:
                raise ServiceException(message='新版续采任务只能包含一本教材')
            dispatch_key = book_key(int(row.subject_id), identities[0]['sourceProvider'], identities[0]['externalTextbookId'])
            existing = await existing_book_task(db, dispatch_key, limit_to_1000_pages=bool(options.get('limitTo1000Pages')))
            if existing and existing.run_id != parsed_task_id:
                raise ServiceException(message='该教材已有其他待办或未结束任务，请先处理当前任务')

        completed_count = 0
        completed_catalogs = 0
        completed_questions = 0
        completed_relations = 0
        completed_tags = 0
        completed_assets = 0
        now = datetime.now()
        try:
            for scope in scopes:
                external_id = str(
                    _scope_field(scope, 'external_textbook_id', 'externalTextbookId', default='') or ''
                ).strip()
                status = str(_scope_field(scope, 'status', 'state', default='queued') or 'queued').lower()
                if external_id not in identity_by_id:
                    raise ServiceException(message=f'中断题库任务教材范围 {external_id} 不在持久化选择中')
                if status == 'completed':
                    completed_count += 1
                    completed_catalogs += int(_scope_field(scope, 'catalog_count', 'catalogCount', default=0) or 0)
                    completed_questions += int(_scope_field(scope, 'question_count', 'questionCount', default=0) or 0)
                    completed_relations += int(
                        _scope_field(scope, 'question_catalog_count', 'questionCatalogCount', default=0) or 0
                    )
                    completed_tags += int(
                        _scope_field(scope, 'question_tag_count', 'questionTagCount', default=0) or 0
                    )
                    completed_assets += int(
                        _scope_field(scope, 'question_asset_count', 'questionAssetCount', default=0) or 0
                    )
                    continue

                raw_resume_source = _scope_field(
                    scope,
                    'resume_from_collector_run_id',
                    'resumeFromCollectorRunId',
                    default=None,
                )
                raw_collector_source = _scope_field(scope, 'collector_run_id', 'collectorRunId', default=None)
                if raw_resume_source not in (None, '') and _positive_collector_run_id(raw_resume_source) is None:
                    raise ServiceException(message=f'教材 {external_id} 的 resumeFromCollectorRunId 无效')
                source_id = _positive_collector_run_id(raw_resume_source) or _positive_collector_run_id(
                    raw_collector_source
                )
                partial_summary: dict[str, Any] | None = None
                if source_id is not None:
                    try:
                        partial_summary = await _resume_partial_summary(
                            source_id,
                            external_id,
                            error_hint=str(
                                _scope_field(scope, 'error_message', 'errorMessage', default='') or ''
                            ),
                        )
                    except TypeError:
                        partial_summary = await _resume_partial_summary(source_id, external_id)
                    summary_counts = partial_summary.get('counts') or {}
                    run = partial_summary.get('run') or {}
                    lock = _scope_datetime(_scope_field(run, 'snapshot_locked_at', 'snapshotLockedAt', 'locked'))
                    scope.catalog_count = int(summary_counts.get('catalogItemCount', 0) or 0)
                    scope.question_count = int(summary_counts.get('questionItemCount', 0) or 0)
                    scope.question_catalog_count = int(summary_counts.get('questionCatalogCount', 0) or 0)
                    scope.question_tag_count = int(summary_counts.get('questionTagCount', 0) or 0)
                    scope.question_asset_count = int(summary_counts.get('questionAssetCount', 0) or 0)
                    scope.snapshot_complete = 0
                    scope.snapshot_locked_at = lock
                else:
                    # This scope never reached a safe checkpoint; reset all
                    # prior transient counters before starting it from head.
                    for name in (
                        'catalog_count',
                        'question_count',
                        'new_catalog_count',
                        'changed_catalog_count',
                        'new_question_count',
                        'changed_question_count',
                        'question_catalog_count',
                        'question_tag_count',
                        'question_asset_count',
                    ):
                        setattr(scope, name, 0)
                    scope.snapshot_complete = 0
                    scope.snapshot_locked_at = None
                scope.status = 'queued'
                scope.collector_job_id = None
                scope.collector_run_id = None
                scope.resume_from_collector_run_id = source_id
                scope.error_message = None
                scope.started_at = None
                scope.finished_at = None
                scope.update_time = now

            row.status = 'queued'
            row.phase = 'catalogs_questions'
            resume_options = dict(options)
            resume_options['resumeTask'] = True
            resume_options['autoResumePending'] = False
            resume_options['autoResumeNextAt'] = None
            resume_options['autoResumeLastStartedAt'] = now.isoformat()
            row.options_json = resume_options
            row.metadata_run_id = None
            row.collector_job_id = None
            row.active_slot = None if queue_resume else '1'
            if queue_resume:
                row.dispatch_book_key = dispatch_key
                row.dispatch_job_id = str(uuid4())
                row.dispatch_not_before = None
                row.dispatch_error = None
            row.process_id = None
            row.worker_token = None
            row.current_textbook_id = None
            row.current_textbook_name = None
            row.started_at = None
            row.finished_at = None
            row.error_message = None
            row.total_textbooks = len(scopes)
            row.completed_textbooks = completed_count
            row.catalog_count = completed_catalogs
            row.question_count = completed_questions
            row.question_catalog_count = completed_relations
            row.question_tag_count = completed_tags
            row.question_asset_count = completed_assets
            row.snapshot_complete = 1 if completed_count == len(scopes) else 0
            row.snapshot_locked_at = None
            row.progress_percent = _progress_for(len(scopes), completed_count, 'catalogs_questions')
            row.update_time = now
            if operator is not None:
                row.created_by = _scope_field(row, 'created_by', 'createdBy', default=operator) or operator
            if hasattr(db, 'flush'):
                await db.flush()
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            raise ServiceException(message='已有同步任务正在运行，请等待当前任务完成') from exc
        except Exception:
            await db.rollback()
            raise

        if queue_resume:
            return _status_from_row(row, scopes) or {}

        # Use the same durable identities, including resume sources, for the
        # new worker.  The run/task number intentionally remains unchanged.
        worker_scopes = [_scope_identity(scope) for scope in scopes]
        handle = _WorkerHandle(
            token=secrets.token_hex(32),
            run_type='content',
            task_module='question',
            metadata_run_id=None,
            textbook_external_ids=[identity['externalTextbookId'] for identity in worker_scopes],
            textbook_scopes=worker_scopes,
            resumed=True,
            workflow_version=int(options.get('workflowVersion', 1)),
            limit_to_1000_pages=_status_flag(
                options.get('limitTo1000Pages', options.get('limit_to_1000_pages', False))
            ),
        )
        task = asyncio.create_task(_execute(parsed_task_id, handle))
        handle.task = task
        _WORKERS[parsed_task_id] = handle
        return _status_from_row(row, scopes) or {}

    @staticmethod
    async def cancel(db: AsyncSession, run_id: int) -> dict[str, Any]:
        row = await SyncJobDao.get(db, run_id)
        if getattr(row, 'dispatch_job_id', None):
            from plugins.bank.service.sync_dispatch import cancel_waiting
            if await cancel_waiting(db, run_id):
                row = await SyncJobDao.get(db, run_id)
                return _status_from_row(row, await SyncTaskDao.scopes(db, run_id)) or {}
        if row is None:
            raise ServiceException(message='同步任务不存在')
        if row.status in {'completed', 'failed', 'blocked', 'cancelled', 'interrupted'}:
            module = str(getattr(row, 'task_module', None) or '')
            scopes = await SyncTaskDao.scopes(db, run_id) if module in {'textbook', 'question'} else []
            return _status_from_row(row, scopes) or {}
        cancelled = await SyncJobDao.request_cancel(db, run_id)
        await db.commit()
        if cancelled is None:
            cancelled = await SyncJobDao.get(db, run_id)
        if getattr(cancelled, 'dispatch_job_id', None):
            await db.refresh(cancelled)
        dispatch_id = getattr(cancelled, 'dispatch_job_id', None)
        remote_job_id = str(getattr(cancelled, 'collector_job_id', '') or dispatch_id or '').strip()
        if remote_job_id:
            try:
                kwargs = {'reserve_dispatch': True} if dispatch_id else {}
                await asyncio.to_thread(CollectorClient().cancel_job, remote_job_id, **kwargs)
            except ServiceException:
                # The worker will retry cancellation while polling.  A remote
                # terminal job is also safe to treat as already cancelled.
                pass
        # The owning worker polls this durable state and cancels the
        # server-owned job. Returning immediately keeps cancellation reliable
        # across workers and avoids waiting for the remote crawl to finish.
        module = str(getattr(cancelled, 'task_module', None) or getattr(row, 'task_module', None) or '')
        scopes = await SyncTaskDao.scopes(db, run_id) if module in {'textbook', 'question'} else []
        return _status_from_row(cancelled, scopes) or {}

    @staticmethod
    async def _recover_orphans_once() -> int:  # noqa: PLR0912, PLR0915
        recovered: list[tuple[int, _WorkerHandle]] = []
        terminalized: list[tuple[int, str, str]] = []
        async with DataSourceRegistry.session() as db:
            stale_before = datetime.now() - timedelta(seconds=WORKER_HEARTBEAT_TIMEOUT_SECONDS)
            try:
                active_rows = await SyncJobDao.list_active(db)
            except (AttributeError, SQLAlchemyError):
                # Keep compatibility with a database that predates the
                # independent task columns or a narrow test double.
                active_rows = []
            count = 0
            for row in active_rows:
                run_id = int(row.run_id)
                if run_id in _WORKERS:
                    continue
                queue_token = None
                if getattr(row, 'dispatch_job_id', None):
                    # Only an expired owner can be replaced. Recheck under a
                    # row lock; an older worker's ContextVar token then fails
                    # every task/scope write against this new durable token.
                    locked = (await db.execute(select(QbSyncJob).where(
                        QbSyncJob.run_id == run_id, QbSyncJob.active_slot.is_not(None),
                        QbSyncJob.update_time < stale_before,
                    ).with_for_update().execution_options(populate_existing=True))).scalars().first()
                    if locked is None or locked.status not in ('queued', 'starting', 'running', 'cancelling'):
                        continue
                    row = locked
                    queue_token = secrets.token_hex(32)
                    row.worker_token = queue_token
                    row.update_time = datetime.now()
                remote_job_id = str(getattr(row, 'collector_job_id', '') or '').strip()
                task_module = str(getattr(row, 'task_module', 'center') or 'center')
                options = getattr(row, 'options_json', None)
                if isinstance(options, str):
                    try:
                        options = json.loads(options)
                    except (TypeError, json.JSONDecodeError):
                        options = {}
                options = options if isinstance(options, Mapping) else {}
                question_scopes: list[dict[str, Any]] = []
                if task_module == 'question':
                    # Recovery must be driven by the committed scope rows.
                    # If they are absent or disagree with the options
                    # snapshot, fail the task closed instead of starting a
                    # worker with a guessed textbook selection.
                    try:
                        question_scopes = await _durable_question_scope_identities_from_db(db, run_id, options)
                    except ServiceException as exc:
                        message = _exception_message(exc, '题库任务持久化教材范围无效')
                        updated = await SyncJobDao.update_fields(
                            db,
                            run_id,
                            {
                                'status': 'failed',
                                'phase': 'failed',
                                'error_message': message,
                                'active_slot': None,
                                'process_id': None,
                                'worker_token': None,
                                'finished_at': datetime.now(),
                            },
                            expected_statuses=('queued', 'starting', 'running', 'cancelling'),
                        )
                        count += updated
                        if updated:
                            terminalized.append((run_id, 'failed', message))
                        continue
                if remote_job_id:
                    textbook_scopes = question_scopes
                    handle = _WorkerHandle(
                        token=queue_token or secrets.token_hex(32),
                        run_type=str(getattr(row, 'run_type', 'metadata') or 'metadata'),
                        task_module=task_module,
                        metadata_run_id=(
                            None if task_module == 'question' else getattr(row, 'metadata_run_id', None)
                        ),
                        textbook_external_ids=[identity['externalTextbookId'] for identity in textbook_scopes],
                        textbook_scopes=textbook_scopes,
                        remote_job_id=remote_job_id,
                        recovered=True,
                    )
                    recovered.append((run_id, handle))
                    continue
                # A remote job without a durable ID cannot be reattached after
                # a Python restart. Only queued jobs may be started afresh;
                # stale starting/running rows are finalized below.
                if str(getattr(row, 'status', '') or '') == 'queued' or queue_token:
                    if queue_token and row.status in ('starting', 'running'):
                        row.status = 'queued'
                    handle = _WorkerHandle(
                        token=queue_token or secrets.token_hex(32),
                        run_type=str(getattr(row, 'run_type', 'metadata') or 'metadata'),
                        task_module=str(getattr(row, 'task_module', 'center') or 'center'),
                        metadata_run_id=(
                            None
                            if str(getattr(row, 'task_module', 'center') or 'center') == 'question'
                            else getattr(row, 'metadata_run_id', None)
                        ),
                        recovered=True,
                    )
                    if task_module == 'question':
                        handle.textbook_scopes = question_scopes
                        handle.textbook_external_ids = [
                            identity['externalTextbookId'] for identity in question_scopes
                        ]
                    else:
                        values = options.get('textbookExternalIds') or options.get('textbook_external_ids') or []
                        if isinstance(values, list):
                            handle.textbook_external_ids = [
                                str(value).strip() for value in values if str(value).strip()
                            ]
                    recovered.append((run_id, handle))
                    continue
                if getattr(row, 'update_time', None) is not None and row.update_time >= stale_before:
                    continue
                was_cancelling = str(getattr(row, 'status', '') or '') == 'cancelling'
                updated = await SyncJobDao.update_fields(
                    db,
                    run_id,
                    {
                        'status': 'cancelled' if was_cancelling else 'failed',
                        'phase': 'cancelled' if was_cancelling else 'failed',
                        'error_message': (
                            '同步已停止' if was_cancelling else '后端工作进程已失联，未完成的同步任务已标记为失败'
                        ),
                        'active_slot': None,
                        'process_id': None,
                        'worker_token': None,
                        'finished_at': datetime.now(),
                    },
                    expected_statuses=('starting', 'running', 'cancelling'),
                )
                count += updated
                if updated:
                    terminalized.append(
                        (
                            run_id,
                            'cancelled' if was_cancelling else 'failed',
                            '同步已停止' if was_cancelling else '后端工作进程已失联，未完成的同步任务已标记为失败',
                        )
                    )
            # Older installations may not expose list_active; retain the
            # original bulk stale update as a fallback in that case.
            if not active_rows:
                count += await SyncJobDao.mark_interrupted(
                    db,
                    '后端工作进程已失联，未完成的同步任务已标记为失败',
                    stale_before,
                )
            await db.commit()
        for run_id, status, message in terminalized:
            await _finalize_scopes(run_id, status, message)
        for run_id, handle in recovered:
            task = asyncio.create_task(_execute(run_id, handle))
            handle.task = task
            _WORKERS[run_id] = handle
        return count

    @staticmethod
    async def recover_orphans() -> int:
        """Recover or terminalize durable workers without duplicate claims.

        The startup hook and the delayed monitor can wake at the same time.
        A small in-process gate ensures only one pass can inspect and claim a
        row, so a recovered remote job is never represented by two local
        polling workers.
        """

        global _RECOVERY_IN_PROGRESS  # noqa: PLW0603
        if _RECOVERY_IN_PROGRESS:
            return 0
        _RECOVERY_IN_PROGRESS = True
        try:
            return await SyncRunService._recover_orphans_once()
        finally:
            _RECOVERY_IN_PROGRESS = False

    @staticmethod
    async def resume_pending_question_tasks() -> int:
        """Start at most one due transient auto-resume task.

        The durable timestamp makes this safe across service restarts.  A
        blocked/challenge task is never selected here; those require the
        explicit resume endpoint after an operator has checked the source.
        """

        now = datetime.now()
        async with DataSourceRegistry.session() as db:
            result = await db.execute(
                select(QbSyncJob)
                .where(
                    QbSyncJob.task_module == 'question',
                    QbSyncJob.status == 'interrupted',
                )
                .order_by(QbSyncJob.run_id)
                .limit(MAX_PARTIAL_RUN_SCAN)
            )
            rows = list(result.scalars().all())
        due_ids: list[int] = []
        for row in rows:
            run_id = int(_scope_field(row, 'run_id', 'runId', default=0) or 0)
            if run_id <= 0 or run_id in _WORKERS:
                continue
            options = _row_options(row)
            if not _auto_resume_enabled(options) or not _status_flag(
                options.get('autoResumePending', options.get('auto_resume_pending', False))
            ):
                continue
            next_at = _scope_datetime(
                options.get('autoResumeNextAt') or options.get('auto_resume_next_at')
            )
            if next_at is not None and next_at > now:
                continue
            due_ids.append(run_id)

        if not due_ids:
            return 0
        for task_id in due_ids:
            try:
                async with DataSourceRegistry.session() as db:
                    await SyncRunService.resume_question(db, task_id, operator=None)
                return 1
            except ServiceException:
                # A book waiting for import/manual judgement must not prevent
                # other due books from claiming the single execution slot.
                continue
        return 0

    @staticmethod
    async def _recovery_monitor() -> None:
        """Keep checking recent orphan rows after the startup hook returns."""

        while True:
            await asyncio.sleep(RECOVERY_MONITOR_INTERVAL_SECONDS)
            try:
                await SyncRunService.recover_orphans()
                await SyncRunService.resume_pending_question_tasks()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Recovery is retried on the next heartbeat.  A temporary DB
                # outage must not kill the monitor and leave a row orphaned
                # forever.
                continue

    @staticmethod
    def start_recovery_monitor() -> None:
        """Start one process-local delayed recovery loop after startup."""

        global _RECOVERY_MONITOR_TASK  # noqa: PLW0603
        if _RECOVERY_MONITOR_TASK is not None and not _RECOVERY_MONITOR_TASK.done():
            return
        _RECOVERY_MONITOR_TASK = asyncio.create_task(SyncRunService._recovery_monitor())

    @staticmethod
    async def shutdown() -> None:
        global _RECOVERY_MONITOR_TASK  # noqa: PLW0603
        monitor = _RECOVERY_MONITOR_TASK
        _RECOVERY_MONITOR_TASK = None
        if monitor is not None and not monitor.done():
            monitor.cancel()
            await asyncio.gather(monitor, return_exceptions=True)
        handles = list(_WORKERS.values())
        for handle in handles:
            await _terminate_process(handle)
        tasks = [handle.task for handle in handles if handle.task is not None]
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


async def on_startup(context: object | None = None) -> None:
    """Plugin lifecycle hook: recover tasks left active by a process restart."""

    # Validate operator configuration during the plugin startup hook, without
    # making a network request.  Every task/status path constructs the same
    # client later; failing here prevents a bank plugin from appearing ready
    # while its collector URL is absent or malformed.
    CollectorClient()
    if context is None or bool(getattr(context, 'startup_write_enabled', True)):
        await SyncRunService.recover_orphans()
        try:
            await SyncRunService.resume_pending_question_tasks()
        except Exception:
            pass
    # The startup writer flag protects installation/global initialization;
    # it is not a durable daemon leader. A later process can reuse the ready
    # marker as a reader after the writer has exited. Every process therefore
    # starts its local loops; database slots, leases and ownership CAS decide
    # who can execute a business task. No install/menu/resource writes here.
    SyncRunService.start_recovery_monitor()
    from plugins.bank.service.incremental_import_worker import start_incremental_import_worker
    start_incremental_import_worker()
    from plugins.bank.service.question_readiness_worker import start_question_readiness_worker
    start_question_readiness_worker()
    from plugins.bank.service.sync_dispatch import start_sync_dispatch_worker
    start_sync_dispatch_worker()


async def on_shutdown(_context: object | None = None) -> None:
    from plugins.bank.service.sync_dispatch import stop_sync_dispatch_worker
    await stop_sync_dispatch_worker()
    from plugins.bank.service.incremental_import_worker import stop_incremental_import_worker
    await stop_incremental_import_worker()
    from plugins.bank.service.question_readiness_worker import stop_question_readiness_worker
    await stop_question_readiness_worker()
    await SyncRunService.shutdown()
    from plugins.bank.service.live_progress_cache import close
    await close()


__all__ = ['SyncRunService', 'on_shutdown', 'on_startup']
