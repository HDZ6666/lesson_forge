"""Bounded HTTP client for an independently deployed collector.

The collector URL and bearer token are operator-owned environment settings.
No controller request can supply a URL, script path, database path, SQL, or
command-line argument.
"""

from __future__ import annotations

import json
import math
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from typing import Any

from exceptions.exception import ServiceException

DEFAULT_TIMEOUT_SECONDS = 15.0
DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_ASSET_BYTES = 64 * 1024 * 1024
DEFAULT_SNAPSHOT_PAGE_SIZE = 500
MAX_SNAPSHOT_PAGE_SIZE = 5_000
MAX_SNAPSHOT_ROWS = 100_000
MAX_STREAM_SNAPSHOT_ROWS = 2_000_000
SNAPSHOT_COLLECTIONS = ('catalogs', 'questions', 'questionCatalogs', 'tags', 'assets')
_URL_MAX_PORT = 65_535
_URL_CONTROL_CHAR_LIMIT = 32
_URL_DELETE_CHAR = 127
_SHA256_RE = re.compile(r'^[0-9a-fA-F]{64}$')
_SNAPSHOT_COUNT_ALIASES: dict[str, tuple[str, ...]] = {
    'catalogs': ('catalogs', 'catalogItemCount', 'catalog_item_count', 'catalogCount', 'catalog_count'),
    'questions': ('questions', 'questionItemCount', 'question_item_count', 'questionCount', 'question_count'),
    'questionCatalogs': (
        'questionCatalogs',
        'questionCatalogCount',
        'question_catalog_count',
        'relationCount',
        'relation_count',
    ),
    'tags': ('tags', 'questionTagCount', 'question_tag_count', 'tagCount', 'tag_count'),
    'assets': ('assets', 'questionAssetCount', 'question_asset_count', 'assetCount', 'asset_count'),
}
_RUN_ID_ALIASES = ('id', 'runId', 'collectorRunId', 'run_id')


class CollectorClient:
    """Synchronous standard-library client intended for ``asyncio.to_thread``."""

    def __init__(self) -> None:
        raw_url = os.environ.get('BANK_COLLECTOR_URL', '').strip()
        if not raw_url:
            raise ServiceException(message='未配置 BANK_COLLECTOR_URL')
        try:
            parsed = urllib.parse.urlsplit(raw_url)
            parsed_port = parsed.port  # Force malformed port values to fail during config validation.
            parsed_hostname = parsed.hostname
        except ValueError as exc:
            raise ServiceException(message='BANK_COLLECTOR_URL 必须是有效的 HTTP(S) 地址') from exc
        if (
            parsed.scheme not in {'http', 'https'}
            or not parsed.netloc
            or not parsed_hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or (parsed_port is not None and parsed_port > _URL_MAX_PORT)
            or any(ord(char) <= _URL_CONTROL_CHAR_LIMIT or ord(char) == _URL_DELETE_CHAR for char in raw_url)
        ):
            raise ServiceException(message='BANK_COLLECTOR_URL 必须是有效的 HTTP(S) 地址')
        self.base_url = raw_url.rstrip('/')
        self.token = os.environ.get('BANK_COLLECTOR_TOKEN', '').strip()
        self.timeout = self._positive_float('BANK_COLLECTOR_TIMEOUT_SECONDS', DEFAULT_TIMEOUT_SECONDS)
        self.max_response_bytes = self._positive_int(
            'BANK_COLLECTOR_MAX_RESPONSE_BYTES',
            DEFAULT_MAX_RESPONSE_BYTES,
        )
        self.max_asset_bytes = self._positive_int(
            'BANK_COLLECTOR_MAX_ASSET_BYTES',
            min(self.max_response_bytes, DEFAULT_MAX_ASSET_BYTES),
        )

    @staticmethod
    def _positive_float(name: str, default: float) -> float:
        raw = os.environ.get(name, '').strip()
        if not raw:
            return default
        try:
            value = float(raw)
        except ValueError as exc:
            raise ServiceException(message=f'{name} 必须是正数') from exc
        if value <= 0 or not math.isfinite(value):
            raise ServiceException(message=f'{name} 必须是正数')
        return value

    @staticmethod
    def _positive_int(name: str, default: int) -> int:
        raw = os.environ.get(name, '').strip()
        if not raw:
            return default
        try:
            value = int(raw)
        except ValueError as exc:
            raise ServiceException(message=f'{name} 必须是正整数') from exc
        if value <= 0:
            raise ServiceException(message=f'{name} 必须是正整数')
        return value

    def _request(
        self,
        method: str,
        route: str,
        *,
        query: dict[str, object | None] | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f'{self.base_url}{route}'
        if query:
            encoded = urllib.parse.urlencode(
                {key: value for key, value in query.items() if value is not None and value != ''}
            )
            if encoded:
                url = f'{url}?{encoded}'
        body = None
        headers = {'Accept': 'application/json'}
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            headers['Content-Type'] = 'application/json; charset=utf-8'
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read(self.max_response_bytes + 1)
        except urllib.error.HTTPError as exc:
            raw = exc.read(self.max_response_bytes + 1)
            message = self._error_message(raw) or f'HTTP {exc.code}'
            raise ServiceException(message=f'collector API 请求失败：{message}') from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ServiceException(message=f'collector API 不可用：{exc}') from exc
        if len(raw) > self.max_response_bytes:
            raise ServiceException(message='collector API 响应超过安全上限')
        try:
            value = json.loads(raw.decode('utf-8')) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ServiceException(message='collector API 返回了无效 JSON') from exc
        if not isinstance(value, dict):
            raise ServiceException(message='collector API 响应结构不正确')
        return value

    def _request_bytes(
        self,
        method: str,
        route: str,
        *,
        query: dict[str, object | None] | None = None,
        max_bytes: int | None = None,
    ) -> bytes:
        """Perform a bounded authenticated request for a binary asset."""

        url = f'{self.base_url}{route}'
        if query:
            encoded = urllib.parse.urlencode(
                {key: value for key, value in query.items() if value is not None and value != ''}
            )
            if encoded:
                url = f'{url}?{encoded}'
        headers = {'Accept': 'application/octet-stream'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        request = urllib.request.Request(url, headers=headers, method=method)
        limit = max_bytes if max_bytes is not None else self.max_asset_bytes
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                headers = getattr(response, 'headers', {})
                content_length = headers.get('Content-Length') if headers is not None else None
                if content_length:
                    try:
                        declared_length = int(content_length)
                        if declared_length < 0:
                            raise ValueError('negative content length')
                        if declared_length > limit:
                            raise ServiceException(message='collector 素材响应超过安全上限')
                    except ValueError as exc:
                        raise ServiceException(message='collector 素材响应长度无效') from exc
                raw = response.read(limit + 1)
        except urllib.error.HTTPError as exc:
            raw = exc.read(min(limit + 1, self.max_response_bytes) if limit > 0 else 1)
            message = self._error_message(raw) or f'HTTP {exc.code}'
            raise ServiceException(message=f'collector API 素材请求失败：{message}') from exc
        except ServiceException:
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ServiceException(message=f'collector API 素材不可用：{exc}') from exc
        if len(raw) > limit:
            raise ServiceException(message='collector 素材响应超过安全上限')
        return raw

    @staticmethod
    def _error_message(raw: bytes) -> str | None:
        try:
            value = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        if not isinstance(value, dict):
            return None
        error = value.get('error')
        if isinstance(error, dict):
            message = error.get('message')
            return str(message)[:1000] if message else None
        return None

    def health(self) -> dict[str, Any]:
        return self._request('GET', '/v1/health')

    def source_control(self):
        return self._request('GET', '/v1/source-control')

    def resume_source(self, revision):
        return self._request('POST', '/v1/source-control/resume', payload={'expectedRevision': revision})

    def start_job(
        self,
        run_type: str,
        *,
        max_pages: int,
        metadata_run_id: int | None = None,
        textbook_external_ids: list[str] | None = None,
        textbook_scopes: list[dict[str, Any]] | None = None,
        limit_to_1000_pages: bool | None = None,
        workflow_version: int | None = None,
        job_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            'runType': run_type,
            'acknowledgeSourcePolicy': True,
            'maxPages': max_pages,
            'metadataRunId': metadata_run_id,
            'textbookExternalIds': list(textbook_external_ids or []),
            # Omitted versions on durable Service tasks are the historical
            # contract. New Service tasks explicitly pass version 2.
            'workflowVersion': workflow_version if workflow_version is not None else 1,
            'sourceNamespace': 'zujuan:junior:math',
        }
        # Independent question tasks carry their server-resolved formal and
        # external identities directly. Keep this optional for legacy center
        # jobs, which still use metadataRunId.
        if textbook_scopes is not None:
            payload['textbookScopes'] = textbook_scopes
        # Omit the optional field for older callers; the collector treats an
        # omitted value as false. Independent question workers pass the
        # persisted task choice when enabled.
        if limit_to_1000_pages is not None:
            payload['limitTo1000Pages'] = bool(limit_to_1000_pages)
        if job_id is not None:
            if not re.fullmatch(r'[0-9a-fA-F-]{36}', job_id):
                raise ServiceException(message='派发任务 ID 无效')
            payload['jobId'] = job_id
        return self._request(
            'POST',
            '/v1/jobs',
            payload=payload,
        )

    def job(self, job_id: str) -> dict[str, Any]:
        safe_id = urllib.parse.quote(str(job_id), safe='')
        return self._request('GET', f'/v1/jobs/{safe_id}')

    def cancel_job(self, job_id: str, *, reserve_dispatch: bool = False) -> dict[str, Any]:
        safe_id = urllib.parse.quote(str(job_id), safe='')
        return self._request(
            'POST', f'/v1/jobs/{safe_id}/cancel', payload={'reserveDispatch': True} if reserve_dispatch else {},
        )

    def validate_metadata(self, metadata_run_id: int, textbook_external_ids: list[str]) -> dict[str, Any]:
        return self._request(
            'POST',
            '/v1/metadata/validate',
            payload={
                'metadataRunId': metadata_run_id,
                'textbookExternalIds': textbook_external_ids,
            },
        )

    def metadata_snapshot(self, metadata_run_id: int | None = None) -> dict[str, Any]:
        return self._request(
            'GET',
            '/v1/metadata/snapshot',
            query={'metadataRunId': metadata_run_id},
        )

    def candidates(
        self,
        entity_type: str,
        *,
        source_provider: str | None = None,
        metadata_run_id: int | None = None,
        textbook_external_id: str | None = None,
    ) -> dict[str, Any]:
        return self._request(
            'GET',
            '/v1/candidates',
            query={
                'entityType': entity_type,
                'provider': source_provider,
                'metadataRunId': metadata_run_id,
                'textbookExternalId': textbook_external_id,
            },
        )

    def catalog_progress(self) -> dict[str, Any]:
        return self._request('GET', '/v1/catalog-progress')

    # ------------------------------------------------------------------
    # Immutable content-run snapshots
    # ------------------------------------------------------------------
    # The collector intentionally owns these rows. Keep the methods small
    # wrappers around ``_request`` so callers share one HTTP boundary and a
    # response may evolve from snake case to the stable camelCase contract
    # without changing URL handling.

    def run_questions_preview(self, run_id: int, **options: Any) -> dict[str, Any]:
        return self._request('POST', f'/v1/runs/{int(run_id)}/questions-preview', payload=options)

    def run_catalogs_preview(self, run_id: int, **options: Any) -> dict[str, Any]:
        return self._request('POST', f'/v1/runs/{int(run_id)}/catalogs-preview', payload=options)

    def run_catalogs(
        self,
        run_id: int | str,
        *,
        textbook_external_id: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
    ) -> dict[str, Any]:
        safe_id = urllib.parse.quote(str(run_id), safe='')
        return self._request(
            'GET',
            f'/v1/runs/{safe_id}/catalogs',
            query={
                'textbookExternalId': textbook_external_id,
                'page': page,
                'pageSize': page_size,
            },
        )

    def run_questions(
        self,
        run_id: int | str,
        *,
        textbook_external_id: str | None = None,
        catalog_external_id: str | None = None,
        question_type: str | None = None,
        keyword: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
    ) -> dict[str, Any]:
        safe_id = urllib.parse.quote(str(run_id), safe='')
        return self._request(
            'GET',
            f'/v1/runs/{safe_id}/questions',
            query={
                'textbookExternalId': textbook_external_id,
                'catalogExternalId': catalog_external_id,
                'questionType': question_type,
                'keyword': keyword,
                'page': page,
                'pageSize': page_size,
            },
        )

    def run_question_detail(
        self,
        run_id: int | str,
        external_id: str,
        *,
        textbook_external_id: str | None = None,
    ) -> dict[str, Any]:
        safe_run_id = urllib.parse.quote(str(run_id), safe='')
        safe_external_id = urllib.parse.quote(str(external_id), safe='')
        return self._request(
            'GET',
            f'/v1/runs/{safe_run_id}/questions/{safe_external_id}',
            query={'textbookExternalId': textbook_external_id},
        )

    def run_snapshot(
        self,
        run_id: int | str,
        *,
        textbook_external_id: str | None = None,
    ) -> dict[str, Any]:
        """Aggregate all five bounded pages from one immutable collector run.

        The summary is fetched first and every page is required to repeat the
        same run, collection, counters and total.  This prevents a mutable or
        cross-scope response from being silently applied when a long request
        spans a collector refresh.
        """

        summary = self.run_snapshot_summary(run_id, textbook_external_id=textbook_external_id)
        payload = self._snapshot_envelope(summary)
        self._validate_snapshot_header(payload, run_id, textbook_external_id)
        summary_run = payload['run']
        counts = self._snapshot_counts(payload.get('counts'), payload, summary_run)
        result: dict[str, Any] = {
            'available': True,
            'immutable': True,
            'run': dict(summary_run),
            'counts': self._canonical_counts(counts),
            'snapshotComplete': True,
        }
        for collection in SNAPSHOT_COLLECTIONS:
            expected = counts[collection]
            cursor = 0
            items: list[dict[str, Any]] = []
            seen_ids: set[str] = set()
            while True:
                page = self.run_snapshot_page(
                    run_id,
                    collection,
                    textbook_external_id=textbook_external_id,
                    cursor=cursor,
                    page_size=DEFAULT_SNAPSHOT_PAGE_SIZE,
                )
                self._validate_snapshot_page(
                    page,
                    run_id,
                    textbook_external_id,
                    collection,
                    counts,
                    summary_run,
                    cursor,
                    page_size=DEFAULT_SNAPSHOT_PAGE_SIZE,
                )
                batch = [dict(item) for item in page['items']]
                if len(items) + len(batch) > MAX_SNAPSHOT_ROWS:
                    raise ServiceException(message='collector 运行快照超过安全上限')
                for item in batch:
                    identity = self._item_identity(collection, item)
                    if identity is not None:
                        if identity in seen_ids:
                            raise ServiceException(message=f'collector 运行快照 {collection} 包含重复行')
                        seen_ids.add(identity)
                    items.append(item)
                next_cursor = page['nextCursor']
                if next_cursor is None:
                    break
                cursor = next_cursor
            if len(items) != expected:
                raise ServiceException(
                    message=f'collector 运行快照 {collection} 计数不一致：{len(items)}/{expected}'
                )
            result[collection] = items
        return result

    @staticmethod
    def _snapshot_envelope(raw: Mapping[str, Any]) -> dict[str, Any]:
        payload: Mapping[str, Any] = raw
        for wrapper in ('data', 'summary'):
            candidate = payload.get(wrapper)
            if not isinstance(candidate, Mapping):
                continue
            # A few HTTP clients wrap the response body in ``data`` or
            # ``summary`` while retaining markers such as ``available`` at
            # the outer level.  Always merge the two projections so a valid
            # outer marker is not lost merely because the nested object does
            # not repeat it.  Outer keys win when both levels provide a
            # value, which preserves the canonical top-level contract.
            payload = {
                **candidate,
                **{key: value for key, value in payload.items() if key not in {'data', 'summary'}},
            }
            break
        return dict(payload)

    @classmethod
    def _snapshot_counts(
        cls,
        raw_counts: Any,
        payload: Mapping[str, Any],
        run: Mapping[str, Any],
        *,
        max_rows: int = MAX_SNAPSHOT_ROWS,
    ) -> dict[str, int]:
        values: Mapping[str, Any] = raw_counts if isinstance(raw_counts, Mapping) else payload
        result: dict[str, int] = {}
        for collection, aliases in _SNAPSHOT_COUNT_ALIASES.items():
            present = [values[name] for name in aliases if name in values]
            run_present = [run[name] for name in aliases if name in run]
            if not present and not run_present:
                raise ServiceException(message=f'collector 快照缺少有效 {collection} 计数')
            parsed = [
                cls._strict_nonnegative_int(value, f'collector 快照 {collection} 计数')
                for value in present
            ]
            if parsed and len(set(parsed)) != 1:
                raise ServiceException(message=f'collector 快照 {collection} 计数别名不一致')
            parsed_run = [
                cls._strict_nonnegative_int(value, f'collector 运行 {collection} 计数')
                for value in run_present
            ]
            if parsed_run and len(set(parsed_run)) != 1:
                raise ServiceException(message=f'collector 运行 {collection} 计数别名不一致')
            # A summary for one requested textbook has scoped counters while
            # the embedded run may retain aggregate counters for a
            # multi-textbook crawl.  In the single-scope case both views must
            # agree; otherwise the scoped ``counts`` object is authoritative
            # and the run counters are still checked for internal consistency.
            scope_ids = cls._scope_ids(run.get('scope'))
            scope_ids.update(cls._scope_ids(run.get('textbookExternalIds')))
            scope_ids.update(cls._scope_ids(run.get('textbook_external_ids')))
            if parsed and parsed_run and len(scope_ids) <= 1 and parsed[0] != parsed_run[0]:
                raise ServiceException(message=f'collector 快照 {collection} 计数与运行信息不一致')
            value = parsed[0] if parsed else parsed_run[0]
            if value > max_rows:
                raise ServiceException(message=f'collector 快照 {collection} 计数超过安全上限')
            result[collection] = value
        return result

    @staticmethod
    def _strict_nonnegative_int(value: Any, label: str) -> int:
        """Parse JSON integer fields without silently truncating floats."""

        if isinstance(value, bool):
            raise ServiceException(message=f'{label}无效')
        if isinstance(value, int):
            parsed = value
        elif isinstance(value, str):
            text = value.strip()
            if not re.fullmatch(r'\d+', text):
                raise ServiceException(message=f'{label}无效')
            parsed = int(text)
        elif isinstance(value, float) and value.is_integer():
            parsed = int(value)
        else:
            raise ServiceException(message=f'{label}无效')
        if parsed < 0:
            raise ServiceException(message=f'{label}无效')
        return parsed

    @staticmethod
    def _canonical_counts(counts: Mapping[str, int]) -> dict[str, int]:
        return {
            'catalogItemCount': int(counts['catalogs']),
            'questionItemCount': int(counts['questions']),
            'questionCatalogCount': int(counts['questionCatalogs']),
            'questionTagCount': int(counts['tags']),
            'questionAssetCount': int(counts['assets']),
        }

    @staticmethod
    def _run_id(run: Mapping[str, Any]) -> int | str | None:
        return next((run[name] for name in _RUN_ID_ALIASES if run.get(name) is not None), None)

    @staticmethod
    def _scope_ids(value: Any) -> set[str]:
        """Extract explicit textbook IDs from a run/scope projection."""

        if isinstance(value, str):
            text = value.strip()
            if not text:
                return set()
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                return {text}
            if isinstance(parsed, str):
                return {parsed.strip()} if parsed.strip() else set()
            if isinstance(parsed, (int, float)) and not isinstance(parsed, bool):
                # A numeric source ID such as "260617" is still a scalar ID;
                # JSON decoding it must not make the scope disappear.
                return {text}
            value = parsed
        if isinstance(value, Mapping):
            result: set[str] = set()
            for name in (
                'textbookExternalId',
                'textbook_external_id',
                'externalTextbookId',
                'external_textbook_id',
            ):
                item = value.get(name)
                if item not in (None, ''):
                    result.add(str(item).strip())
            for name in (
                'textbookExternalIds',
                'textbook_external_ids',
                'textbookIds',
                'textbook_ids',
            ):
                items = value.get(name)
                if isinstance(items, list):
                    result.update(str(item).strip() for item in items if item not in (None, ''))
            for name in ('scope', 'scopeItems', 'scope_items', 'textbooks', 'selectedTextbooks'):
                nested = value.get(name)
                if isinstance(nested, (Mapping, list, str)):
                    result.update(CollectorClient._scope_ids(nested))
            return {item for item in result if item}
        if isinstance(value, list):
            result: set[str] = set()
            for item in value:
                result.update(CollectorClient._scope_ids(item))
            return result
        return set()

    @staticmethod
    def _flag_is_true(value: Any) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        return str(value or '').strip().lower() in {'1', 'true', 'yes', 'y', 'on', 'complete', 'completed'}

    @classmethod
    def _validate_snapshot_header(
        cls,
        payload: Mapping[str, Any],
        run_id: int | str,
        textbook_external_id: str | None,
    ) -> None:
        if payload.get('available') is not True or payload.get('immutable') is not True:
            raise ServiceException(message='collector 题库快照摘要未锁定或不可用')
        run = payload.get('run')
        if not isinstance(run, Mapping):
            raise ServiceException(message='collector 题库快照缺少运行信息')
        remote_id = cls._run_id(run)
        if remote_id is None or str(remote_id) != str(run_id):
            raise ServiceException(message='collector 题库快照运行 ID 不一致')
        if textbook_external_id is not None:
            scope_ids = cls._scope_ids(run) | cls._scope_ids(payload)
            if str(textbook_external_id) not in scope_ids:
                raise ServiceException(message='collector 题库快照教材范围不一致')
        for source in (payload, run):
            for marker in ('snapshotComplete', 'snapshot_complete', 'complete', 'isComplete'):
                if marker in source and source[marker] is not None and not cls._flag_is_true(source[marker]):
                    raise ServiceException(message='collector 题库快照未完成')

    @classmethod
    def _validate_snapshot_page(  # noqa: PLR0912, PLR0915
        cls,
        page: Mapping[str, Any],
        run_id: int | str,
        textbook_external_id: str | None,
        collection: str,
        expected_counts: Mapping[str, int],
        summary_run: Mapping[str, Any],
        cursor: int,
        *,
        page_size: int | None = None,
        sealed_for_import: bool = False,
    ) -> None:
        if page.get('available') is not True or page.get('immutable') is not True:
            raise ServiceException(message='collector 分页快照未锁定或不可用')
        if page.get('collection') != collection:
            raise ServiceException(message='collector 分页快照 collection 不一致')
        run = page.get('run')
        if not isinstance(run, Mapping) or str(cls._run_id(run)) != str(run_id):
            raise ServiceException(message='collector 分页快照运行信息不一致')
        for source in (page, run):
            for marker in ('snapshotComplete', 'snapshot_complete', 'complete', 'isComplete'):
                if not sealed_for_import and marker in source and source[marker] is not None and not cls._flag_is_true(source[marker]):
                    raise ServiceException(message='collector 分页快照未完成')
        if sealed_for_import:
            from plugins.bank.service.question_apply_service import _normalise_snapshot_summary
            _normalise_snapshot_summary(page, 0, str(textbook_external_id), sealed_for_import=True)
            summary_complete = next((summary_run[name] for name in ('snapshotComplete', 'snapshot_complete') if name in summary_run), None)
            page_complete = next((run[name] for name in ('snapshotComplete', 'snapshot_complete') if name in run), None)
            if cls._flag_is_true(summary_complete) != cls._flag_is_true(page_complete):
                raise ServiceException(message='collector 分页快照完整标记与摘要不一致')
        if textbook_external_id is not None:
            page_scope_ids = cls._scope_ids(run) | cls._scope_ids(page)
            if str(textbook_external_id) not in page_scope_ids:
                raise ServiceException(message='collector 分页快照教材范围不一致')
        summary_provider = summary_run.get('provider', summary_run.get('sourceProvider'))
        page_provider = run.get('provider', run.get('sourceProvider'))
        if summary_provider is not None and page_provider is not None and str(summary_provider) != str(page_provider):
            raise ServiceException(message='collector 分页快照来源不一致')
        for aliases in (
            ('status',),
            ('snapshotLockedAt', 'snapshot_locked_at', 'locked'),
            ('finishedAt', 'finished_at'),
            ('textbookExternalId', 'textbook_external_id'),
        ):
            summary_value = next((summary_run[name] for name in aliases if name in summary_run), None)
            page_value = next((run[name] for name in aliases if name in run), None)
            if summary_value is not None and page_value is not None and str(summary_value) != str(page_value):
                raise ServiceException(message='collector 分页快照运行信息不一致')
        summary_scopes = next(
            (summary_run[name] for name in ('textbookExternalIds', 'textbook_external_ids') if name in summary_run),
            None,
        )
        page_scopes = next(
            (run[name] for name in ('textbookExternalIds', 'textbook_external_ids') if name in run),
            None,
        )
        if summary_scopes is not None and page_scopes is not None:
            summary_scope_ids = cls._scope_ids(summary_scopes)
            page_scope_ids = cls._scope_ids(page_scopes)
            if not summary_scope_ids or not page_scope_ids:
                raise ServiceException(message='collector 分页快照教材范围结构不正确')
            # ``snapshot-summary`` may describe a multi-textbook run while
            # each page is deliberately projected to the requested textbook.
            # The requested ID must be present in both projections; requiring
            # identical sets here would reject a valid scoped page.  When no
            # scope was requested, the collector must keep the same set.
            if textbook_external_id is not None:
                if str(textbook_external_id) not in summary_scope_ids or str(textbook_external_id) not in page_scope_ids:
                    raise ServiceException(message='collector 分页快照教材范围不一致')
            elif summary_scope_ids != page_scope_ids:
                raise ServiceException(message='collector 分页快照教材范围不一致')
        page_counts = cls._snapshot_counts(page.get('counts'), page, run, max_rows=MAX_STREAM_SNAPSHOT_ROWS)
        if dict(page_counts) != dict(expected_counts):
            raise ServiceException(message='collector 分页快照计数与摘要不一致')
        total = cls._strict_nonnegative_int(page.get('total'), 'collector 分页快照 total')
        if total != expected_counts[collection]:
            raise ServiceException(message='collector 分页快照 total 与摘要不一致')
        items = page.get('items')
        if not isinstance(items, list) or any(not isinstance(item, Mapping) for item in items):
            raise ServiceException(message='collector 分页快照 items 结构不正确')
        if len(items) > MAX_SNAPSHOT_PAGE_SIZE or (page_size is not None and len(items) > page_size):
            raise ServiceException(message='collector 分页快照页大小超过安全上限')
        page_cursor = page.get('cursor')
        if page_cursor is not None:
            page_cursor = cls._strict_nonnegative_int(page_cursor, 'collector 分页快照 cursor')
            if page_cursor != cursor:
                raise ServiceException(message='collector 分页快照 cursor 不一致')
        next_cursor = page.get('nextCursor')
        if next_cursor is not None:
            next_cursor = cls._strict_nonnegative_int(next_cursor, 'collector 分页快照 nextCursor')
            if next_cursor != cursor + len(items) or next_cursor <= cursor or next_cursor >= total or not items:
                raise ServiceException(message='collector 分页快照游标未前进')
        elif cursor + len(items) != total:
            raise ServiceException(message='collector 分页快照提前结束')

    @staticmethod
    def _item_identity(collection: str, item: Mapping[str, Any]) -> str | None:
        def value(*names: str) -> str:
            raw = next((item[name] for name in names if name in item and item[name] not in (None, '')), '')
            return str(raw)

        aliases = {
            'catalogs': ('catalogExternalId', 'catalog_external_id', 'externalId', 'external_id'),
            'questions': (
                'questionExternalId',
                'question_external_id',
                'externalQuestionId',
                'external_question_id',
                'externalId',
                'external_id',
            ),
            'questionCatalogs': (
                'questionExternalId',
                'question_external_id',
                'externalQuestionId',
                'external_question_id',
            ),
            'tags': (
                'questionExternalId',
                'question_external_id',
                'externalQuestionId',
                'external_question_id',
            ),
            'assets': (
                'questionExternalId',
                'question_external_id',
                'externalQuestionId',
                'external_question_id',
            ),
        }[collection]
        identity = next((item[name] for name in aliases if name in item and item[name] not in (None, '')), None)
        if identity is None:
            return None
        if collection in {'questionCatalogs', 'tags', 'assets'}:
            suffix = '|'.join(value(*names) for names in {
                'questionCatalogs': (
                    'catalogExternalId',
                    'catalog_external_id',
                    'externalCatalogId',
                    'external_catalog_id',
                ),
                'tags': ('dimension', 'tagType', 'tag_value', 'tagValue'),
                'assets': ('assetKey', 'asset_key'),
            }[collection])
            return f'{identity}|{suffix}'
        return str(identity)

    def run_snapshot_page(
        self,
        run_id: int | str,
        collection: str,
        *,
        textbook_external_id: str | None = None,
        cursor: int = 0,
        page_size: int = DEFAULT_SNAPSHOT_PAGE_SIZE,
        sealed_for_import: bool = False,
    ) -> dict[str, Any]:
        if collection not in SNAPSHOT_COLLECTIONS:
            raise ServiceException(message='collector 快照 collection 不受支持')
        if isinstance(cursor, bool) or not isinstance(cursor, int) or cursor < 0:
            raise ServiceException(message='collector 快照 cursor 必须是非负整数')
        if isinstance(page_size, bool) or not isinstance(page_size, int) or not 0 < page_size <= MAX_SNAPSHOT_PAGE_SIZE:
            raise ServiceException(message='collector 快照 pageSize 超过安全上限')
        safe_run_id = urllib.parse.quote(str(run_id), safe='')
        payload = self._request(
            'GET',
            f'/v1/runs/{safe_run_id}/snapshot-page',
            query={
                'collection': collection,
                'textbookExternalId': textbook_external_id,
                'cursor': cursor,
                'pageSize': page_size,
                **({'sealedForImport': 'true'} if sealed_for_import else {}),
            },
        )
        # Validate the inexpensive structural markers here. Cross-page count
        # and run consistency is checked by run_snapshot once the summary is
        # available.
        if payload.get('available') is not True or payload.get('immutable') is not True:
            raise ServiceException(message='collector 分页快照不可用或未锁定')
        if payload.get('collection') != collection:
            raise ServiceException(message='collector 分页快照 collection 不一致')
        if not isinstance(payload.get('run'), Mapping) or not isinstance(payload.get('counts'), Mapping):
            raise ServiceException(message='collector 分页快照缺少 run/counts')
        if not isinstance(payload.get('items'), list) or any(
            not isinstance(item, Mapping) for item in payload['items']
        ):
            raise ServiceException(message='collector 分页快照 items 结构不正确')
        page_counts = self._snapshot_counts(
            payload.get('counts'), payload, payload['run'], max_rows=MAX_STREAM_SNAPSHOT_ROWS,
        )
        self._validate_snapshot_page(
            payload,
            run_id,
            textbook_external_id,
            collection,
            page_counts,
            payload['run'],
            cursor,
            page_size=page_size,
            sealed_for_import=sealed_for_import,
        )
        return payload

    # Explicit aliases used by a few service integrations.
    snapshot_page = run_snapshot_page

    def run_asset_bytes(
        self,
        run_id: int | str,
        content_sha256: str,
        *,
        textbook_external_id: str | None = None,
        sealed_for_import: bool = False,
    ) -> bytes:
        digest = str(content_sha256 or '').strip().lower()
        if not _SHA256_RE.fullmatch(digest):
            raise ServiceException(message='素材 contentSha256 必须是 64 位十六进制 SHA-256')
        safe_run_id = urllib.parse.quote(str(run_id), safe='')
        safe_digest = urllib.parse.quote(digest, safe='')
        return self._request_bytes(
            'GET',
            f'/v1/runs/{safe_run_id}/assets/{safe_digest}',
            query={'textbookExternalId': textbook_external_id, **({'sealedForImport': 'true'} if sealed_for_import else {})},
        )

    asset_bytes = run_asset_bytes

    def run_snapshot_summary(
        self,
        run_id: int | str,
        *,
        textbook_external_id: str | None = None,
        allow_incomplete: bool = False,
        sealed_for_import: bool = False,
    ) -> dict[str, Any]:
        """Read bounded metadata/counts for one immutable content scope.

        Eligibility checks must not fetch the five potentially very large
        snapshot arrays.  The collector owns this endpoint and returns only
        run trust markers plus exact per-scope counts; an actual apply still
        calls :meth:`run_snapshot` and performs the full row validation.
        """

        safe_run_id = urllib.parse.quote(str(run_id), safe='')
        query: dict[str, Any] = {'textbookExternalId': textbook_external_id}
        if allow_incomplete:
            query['allowIncomplete'] = 'true'
        if sealed_for_import:
            query['sealedForImport'] = 'true'
        return self._request(
            'GET',
            f'/v1/runs/{safe_run_id}/snapshot-summary',
            query=query,
        )

    # A few integrations used the longer name while the endpoint was being
    # rolled out.  Keep the aliases deliberately pointing at the one strict
    # implementation so no caller can accidentally fall back to paginated
    # reads for an apply operation.
    run_content_snapshot = run_snapshot
    snapshot = run_snapshot
    snapshot_summary = run_snapshot_summary

    # Short aliases mirror the endpoint names and make test/integration
    # doubles written against either naming convention interoperable.
    catalogs = run_catalogs
    questions = run_questions
    question_detail = run_question_detail
    run_catalog_snapshot = run_catalogs
    run_question_snapshot = run_questions
    run_question = run_question_detail

    def job_scope(self, job_id: str) -> dict[str, Any]:
        """Return the scope projection attached to a collector job.

        New collectors expose ``scope``/``scopeItems`` on ``GET /v1/jobs``;
        older collectors do not, in which case an empty mapping is returned
        while the ordinary job payload remains available to the caller.
        """

        payload = self.job(job_id)
        for key in ('scope', 'scopeItems', 'scope_items', 'textbooks', 'selectedTextbooks'):
            value = payload.get(key)
            if isinstance(value, dict):
                return value
            if isinstance(value, list):
                return {'scopeItems': value}
        return {}


__all__ = ['CollectorClient']
