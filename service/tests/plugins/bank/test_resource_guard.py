"""Configured host pressure pauses work and can recover without API overrides."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from exceptions.exception import ServiceException
from plugins.bank.service import resource_guard as guard


@pytest.fixture(autouse=True)
def isolated_guard(monkeypatch):
    monkeypatch.setattr(guard, '_CACHE', None)
    monkeypatch.delenv('BANK_MIN_DISK_FREE_MIB', raising=False)
    monkeypatch.delenv('BANK_MIN_MEMORY_FREE_MIB', raising=False)


@pytest.mark.parametrize('value', ['-1', '1.5', 'NaN', 'true', '1000000000000'])
def test_invalid_operator_limit_never_disables_protection(monkeypatch, tmp_path, value):
    monkeypatch.setenv('BANK_MIN_DISK_FREE_MIB', value)
    with pytest.raises(ServiceException, match='必须是非负整数'):
        guard.resource_status(root=tmp_path)
    with pytest.raises(guard.ResourcePressure, match='必须是非负整数'):
        guard.assert_resources(root=tmp_path)


def test_low_resources_pause_then_recover_and_do_not_expose_paths(monkeypatch, tmp_path):
    monkeypatch.setenv('BANK_MIN_DISK_FREE_MIB', '200')
    monkeypatch.setenv('BANK_MIN_MEMORY_FREE_MIB', '100')
    monkeypatch.setattr(guard, 'available_disk', lambda _: 199 * guard.MIB)
    monkeypatch.setattr(guard, 'available_memory', lambda: 99 * guard.MIB)
    state = guard.resource_status(root=tmp_path)
    assert state['paused'] and state['diskAndMemoryLimitsConfigured']
    assert '空间' in state['reason'] and '内存' in state['reason']
    assert str(tmp_path) not in str(state)
    with pytest.raises(guard.ResourcePressure):
        guard.assert_resources(root=tmp_path)
    monkeypatch.setattr(guard, 'available_disk', lambda _: 200 * guard.MIB)
    monkeypatch.setattr(guard, 'available_memory', lambda: 100 * guard.MIB)
    assert not guard.resource_status(root=tmp_path, fresh=True)['paused']
    guard.assert_resources(root=tmp_path)


def test_unknown_measurements_fail_closed_only_for_configured_guards(monkeypatch, tmp_path):
    def unknown(*_args):
        raise OSError('measurement unavailable')

    monkeypatch.setattr(guard, 'available_disk', unknown)
    monkeypatch.setattr(guard, 'available_memory', unknown)
    assert not guard.resource_status(root=tmp_path)['paused']
    monkeypatch.setenv('BANK_MIN_MEMORY_FREE_MIB', '1')
    state = guard.resource_status(root=tmp_path)
    assert state['paused'] and state['freeDiskMiB'] is None and state['availableMemoryMiB'] is None


def test_cache_is_bounded_and_isolated_by_storage_and_settings(monkeypatch, tmp_path):
    now, calls = [10.0], []
    monkeypatch.setattr(guard.time, 'monotonic', lambda: now[0])
    monkeypatch.setattr(guard, 'available_disk', lambda root: calls.append(root) or 100 * guard.MIB)
    monkeypatch.setattr(guard, 'available_memory', lambda: 100 * guard.MIB)
    state = guard.resource_status(root=tmp_path)
    state['paused'] = True  # Returned projections cannot change the cache.
    assert not guard.resource_status(root=tmp_path)['paused'] and len(calls) == 1
    guard.resource_status(root=tmp_path / 'another-volume')
    assert len(calls) == 2
    monkeypatch.setenv('BANK_MIN_DISK_FREE_MIB', '101')
    assert guard.resource_status(root=tmp_path)['paused'] and len(calls) == 3
    now[0] += 1.1
    guard.resource_status(root=tmp_path)
    assert len(calls) == 4


def test_disk_uses_existing_parent_without_creating_directories(monkeypatch, tmp_path):
    measured = []
    monkeypatch.setattr(guard.shutil, 'disk_usage', lambda root: measured.append(root) or SimpleNamespace(free=123))
    path = tmp_path / 'new' / 'imports'
    assert guard.available_disk(path) == 123 and measured == [tmp_path]
    assert not path.parent.exists()


def test_memory_uses_container_remaining_capacity_and_ignores_unlimited(monkeypatch):
    monkeypatch.setattr(guard.psutil, 'virtual_memory', lambda: SimpleNamespace(available=1000))
    values = {'/sys/fs/cgroup/memory.max': 'max', '/sys/fs/cgroup/memory.current': '12',
              '/sys/fs/cgroup/memory/memory.limit_in_bytes': '600',
              '/sys/fs/cgroup/memory/memory.usage_in_bytes': '450'}
    monkeypatch.setattr(Path, 'read_text', lambda self: values[str(self)])
    assert guard.available_memory() == 150
    values['/sys/fs/cgroup/memory.max'] = '100'
    values['/sys/fs/cgroup/memory.current'] = '120'
    assert guard.available_memory() == 0


def test_import_yields_memory_before_collection_and_recovers(monkeypatch, tmp_path):
    monkeypatch.setenv('BANK_MIN_MEMORY_FREE_MIB','512')
    monkeypatch.setenv('BANK_IMPORT_MIN_MEMORY_MIB','1024')
    monkeypatch.setattr(guard,'available_disk',lambda _:10000*guard.MIB)
    monkeypatch.setattr(guard,'available_memory',lambda:800*guard.MIB)
    guard.assert_resources(root=tmp_path)
    with pytest.raises(guard.ResourcePressure,match='入库暂缓'):
        guard.assert_import_resources(root=tmp_path)
    monkeypatch.setattr(guard,'available_memory',lambda:1200*guard.MIB)
    guard.resource_status(root=tmp_path,fresh=True)
    guard.assert_import_resources(root=tmp_path)
