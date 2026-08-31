from __future__ import annotations

import io
import json
import urllib.error
from typing import TYPE_CHECKING, Any

import pytest

from exceptions.exception import ServiceException
from plugins.bank.service import collector_client as module

if TYPE_CHECKING:
    from collections.abc import Iterator


class FakeResponse:
    def __init__(self, payload: object) -> None:
        self.body = io.BytesIO(json.dumps(payload, ensure_ascii=False).encode())

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, size: int = -1) -> bytes:
        return self.body.read(size)


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv('BANK_COLLECTOR_URL', 'http://collector.internal:9110/')
    monkeypatch.setenv('BANK_COLLECTOR_TOKEN', 'secret-token')
    yield


def test_client_sends_bearer_auth_and_server_owned_job_shape(
    monkeypatch: pytest.MonkeyPatch,
    configured: None,
) -> None:
    captured: dict[str, Any] = {}

    def fake_urlopen(request: Any, timeout: float) -> FakeResponse:
        captured.update(
            url=request.full_url,
            method=request.method,
            headers=dict(request.header_items()),
            payload=json.loads(request.data.decode()),
            timeout=timeout,
        )
        return FakeResponse({'id': '00000000-0000-0000-0000-000000000001', 'status': 'queued'})

    monkeypatch.setattr(module.urllib.request, 'urlopen', fake_urlopen)
    result = module.CollectorClient().start_job(
        'content',
        max_pages=4,
        metadata_run_id=12,
        textbook_external_ids=['tb-1'],
    )

    assert result['status'] == 'queued'
    assert captured['url'] == 'http://collector.internal:9110/v1/jobs'
    assert captured['method'] == 'POST'
    assert captured['headers']['Authorization'] == 'Bearer secret-token'
    assert captured['payload'] == {
        'runType': 'content',
        'acknowledgeSourcePolicy': True,
        'maxPages': 4,
        'metadataRunId': 12,
        'textbookExternalIds': ['tb-1'],
    }


def test_client_encodes_candidate_scope(monkeypatch: pytest.MonkeyPatch, configured: None) -> None:
    urls: list[str] = []

    def fake_urlopen(request: Any, timeout: float) -> FakeResponse:
        del timeout
        urls.append(request.full_url)
        return FakeResponse({'available': True, 'rows': []})

    monkeypatch.setattr(module.urllib.request, 'urlopen', fake_urlopen)
    module.CollectorClient().candidates(
        'question',
        source_provider='zujuan',
        metadata_run_id=9,
        textbook_external_id='tb/1',
    )

    assert urls == [
        (
            'http://collector.internal:9110/v1/candidates?'
            'entityType=question&provider=zujuan&metadataRunId=9&textbookExternalId=tb%2F1'
        )
    ]


@pytest.mark.parametrize(
    'url',
    ['', 'collector.internal:9110', 'file:///tmp/collector', 'http://user:pass@collector:9110'],
)
def test_client_rejects_missing_or_unsafe_url(monkeypatch: pytest.MonkeyPatch, url: str) -> None:
    monkeypatch.setenv('BANK_COLLECTOR_URL', url)
    with pytest.raises(ServiceException):
        module.CollectorClient()


def test_client_surfaces_bounded_api_error(monkeypatch: pytest.MonkeyPatch, configured: None) -> None:
    def fake_urlopen(request: Any, timeout: float) -> FakeResponse:
        del request, timeout
        body = io.BytesIO(json.dumps({'error': {'message': '任务冲突'}}).encode())
        raise urllib.error.HTTPError('http://collector/v1/jobs', 409, 'conflict', {}, body)

    monkeypatch.setattr(module.urllib.request, 'urlopen', fake_urlopen)
    with pytest.raises(ServiceException) as error:
        module.CollectorClient().health()
    assert '任务冲突' in (error.value.message or '')
