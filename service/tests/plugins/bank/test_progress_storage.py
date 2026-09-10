import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from plugins.bank.service import live_progress_cache as cache
from plugins.bank.service import sync_run_service as service


@pytest.fixture(autouse=True)
def isolated_cache(monkeypatch):
    cache._local.clear()
    cache._inflight.clear()
    monkeypatch.setattr(cache, '_command', AsyncMock(return_value=None))


def test_progress_changes_are_coalesced_and_heartbeat_is_not_lost(monkeypatch):
    handle = service._WorkerHandle(token='test')
    values = {'question_count': 1, 'current_textbook_id': '1'}
    monkeypatch.setattr(service.time, 'monotonic', lambda: 100.0)
    assert service._progress_write_due(handle, 'task', values)
    service._mark_progress_write(handle, 'task', values)
    assert not service._progress_write_due(handle, 'task', values, now=109)
    assert service._progress_write_due(handle, 'task', values, now=110)
    changed = {**values, 'question_count': 5}
    assert not service._progress_write_due(handle, 'task', changed, now=104)
    assert service._progress_write_due(handle, 'task', changed, now=105)
    assert service._progress_write_due(handle, 'task', {**values, 'current_textbook_id': '2'}, now=101)


@pytest.mark.asyncio
async def test_live_tree_is_cached_without_mysql_writes(monkeypatch):
    forbidden = AsyncMock(side_effect=AssertionError('UI projection must not write MySQL'))
    monkeypatch.setattr(service, '_update_row', forbidden)
    monkeypatch.setattr(service, '_load_row', forbidden)
    live = {'textbookExternalId': 'book', 'tree': [{'externalId': 'chapter', 'questionCount': 12}]}
    assert await service._persist_live_progress(1, {'id': 'job', 'status': 'running', 'liveProgress': live})
    value = await cache.get(service._live_cache_key('job', 'running'))
    assert value['liveProgressByScope']['book']['tree'][0]['questionCount'] == 12
    assert 'tree' not in value['liveProgress']
    forbidden.assert_not_called()


@pytest.mark.asyncio
async def test_cache_miss_rebuilds_from_collector_without_changing_durable_status(monkeypatch):
    job = lambda _: {
        'id': 'job',
        'status': 'completed',
        'liveProgress': {'textbookExternalId': 'book', 'pageLimitReached': True, 'tree': []},
    }
    monkeypatch.setattr(service, 'CollectorClient', lambda: SimpleNamespace(job=job, timeout=30))
    value = await service.enrich_live_progress({'collectorJobId': 'job', 'status': 'running'})
    assert value['status'] == 'running'
    assert value['pageLimitReached'] is True
    assert value['progressStale'] is False


@pytest.mark.asyncio
async def test_collector_unavailable_keeps_last_known_progress(monkeypatch):
    def unavailable(_):
        raise OSError('offline')

    monkeypatch.setattr(service, 'CollectorClient', lambda: SimpleNamespace(job=unavailable, timeout=30))
    value = await service.enrich_live_progress({'collectorJobId': 'job', 'liveProgress': {'questionCount': 12}})
    assert value['progressStale'] is True
    assert value['liveProgress']['questionCount'] == 12


@pytest.mark.asyncio
async def test_parallel_cache_misses_share_one_loader():
    calls = 0

    async def loader():
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return {'rows': [1]}

    values = await asyncio.gather(*(cache.get_or_load('same', loader) for _ in range(8)))
    assert calls == 1
    values[0]['rows'].append(2)
    assert (await cache.get('same'))['rows'] == [1]


@pytest.mark.asyncio
async def test_terminal_scope_transition_is_immediate(monkeypatch):
    handle = service._WorkerHandle(token='test')
    values = {'status': 'running', 'question_count': 12}
    monkeypatch.setattr(service.time, 'monotonic', lambda: 100.0)
    service._mark_progress_write(handle, 'scope:b', values)
    write = AsyncMock()
    monkeypatch.setattr(service, '_persist_remote_scope', write)
    await service._persist_progress_scope(handle, 1, 'b', {**values, 'status': 'completed'})
    write.assert_awaited_once()


@pytest.mark.asyncio
async def test_compaction_preserves_options_and_only_writes_once(monkeypatch):
    row = SimpleNamespace(status='running', options_json={
        'limitTo1000Pages': True, 'autoResume': True, 'custom': {'keep': 1},
        'liveProgressByScope': {'book': {'tree': ['large']}},
        'scopeItems': [{'externalTextbookId': 'book', 'liveProgress': {'tree': ['large']}}],
    })
    db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(
        scalars=lambda: SimpleNamespace(first=lambda: row))), commit=AsyncMock())
    @asynccontextmanager
    async def session():
        yield db
    monkeypatch.setattr(service.DataSourceRegistry, 'session', session)
    await service._compact_active_options(17)
    await service._compact_active_options(17)
    assert row.options_json == {'limitTo1000Pages': True, 'autoResume': True,
                                'custom': {'keep': 1}, 'scopeItems': [{'externalTextbookId': 'book'}]}
    db.commit.assert_awaited_once()
    assert 'FOR UPDATE' in str(db.execute.call_args.args[0])


def test_final_scope_counters_are_flushed_even_inside_throttle_window(monkeypatch):
    handle = service._WorkerHandle(token='test')
    values = {'status': 'completed', 'question_count': 12}
    monkeypatch.setattr(service.time, 'monotonic', lambda: 100.0)
    service._mark_progress_write(handle, 'scope:b', values)
    assert service._progress_write_due(handle, 'scope:b', {**values, 'question_count': 15}, now=100.1)
    assert not service._progress_write_due(handle, 'scope:b', values, now=200.0)
