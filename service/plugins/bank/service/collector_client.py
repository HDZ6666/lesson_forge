"""Bounded HTTP client for an independently deployed collector.

The collector URL and bearer token are operator-owned environment settings.
No controller request can supply a URL, script path, database path, SQL, or
command-line argument.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from exceptions.exception import ServiceException

DEFAULT_TIMEOUT_SECONDS = 15.0
DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024


def remote_collector_enabled() -> bool:
    return bool(os.environ.get('BANK_COLLECTOR_URL', '').strip())


class CollectorClient:
    """Synchronous standard-library client intended for ``asyncio.to_thread``."""

    def __init__(self) -> None:
        raw_url = os.environ.get('BANK_COLLECTOR_URL', '').strip()
        if not raw_url:
            raise ServiceException(message='未配置 BANK_COLLECTOR_URL')
        parsed = urllib.parse.urlsplit(raw_url)
        if parsed.scheme not in {'http', 'https'} or not parsed.netloc or parsed.username or parsed.password:
            raise ServiceException(message='BANK_COLLECTOR_URL 必须是有效的 HTTP(S) 地址')
        self.base_url = raw_url.rstrip('/')
        self.token = os.environ.get('BANK_COLLECTOR_TOKEN', '').strip()
        self.timeout = self._positive_float('BANK_COLLECTOR_TIMEOUT_SECONDS', DEFAULT_TIMEOUT_SECONDS)
        self.max_response_bytes = self._positive_int(
            'BANK_COLLECTOR_MAX_RESPONSE_BYTES',
            DEFAULT_MAX_RESPONSE_BYTES,
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
        if value <= 0:
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

    def start_job(
        self,
        run_type: str,
        *,
        max_pages: int,
        metadata_run_id: int | None = None,
        textbook_external_ids: list[str] | None = None,
        textbook_scopes: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            'runType': run_type,
            'acknowledgeSourcePolicy': True,
            'maxPages': max_pages,
            'metadataRunId': metadata_run_id,
            'textbookExternalIds': list(textbook_external_ids or []),
        }
        # Independent question tasks carry their server-resolved formal and
        # external identities directly. Keep this optional for legacy center
        # jobs, which still use metadataRunId.
        if textbook_scopes is not None:
            payload['textbookScopes'] = textbook_scopes
        return self._request(
            'POST',
            '/v1/jobs',
            payload=payload,
        )

    def job(self, job_id: str) -> dict[str, Any]:
        safe_id = urllib.parse.quote(str(job_id), safe='')
        return self._request('GET', f'/v1/jobs/{safe_id}')

    def cancel_job(self, job_id: str) -> dict[str, Any]:
        safe_id = urllib.parse.quote(str(job_id), safe='')
        return self._request('POST', f'/v1/jobs/{safe_id}/cancel', payload={})

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
    # The collector intentionally owns these rows.  Keep the methods small
    # wrappers around ``_request`` so callers can use the same client in
    # local/remote modes and so a collector response may evolve from snake
    # case to the stable camelCase contract without changing URL handling.

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
        """Read the complete immutable content snapshot for one scope.

        Applying a question task must never reconstruct a snapshot by walking
        the paginated ``/catalogs``/``/questions`` endpoints.  The collector's
        dedicated endpoint returns all five immutable row sets and their
        authoritative counts in one response.  Keeping this wrapper here also
        gives local and remote deployments the same service boundary.
        """

        safe_run_id = urllib.parse.quote(str(run_id), safe='')
        return self._request(
            'GET',
            f'/v1/runs/{safe_run_id}/snapshot',
            query={'textbookExternalId': textbook_external_id},
        )

    def run_snapshot_summary(
        self,
        run_id: int | str,
        *,
        textbook_external_id: str | None = None,
        allow_incomplete: bool = False,
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


__all__ = ['CollectorClient', 'remote_collector_enabled']
