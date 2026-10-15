import pytest


@pytest.fixture(autouse=True)
def _fresh_resource_wait(monkeypatch):
    """The import resource gate is process-wide; isolate it per test.

    Tests drive recovery explicitly, so they use no backoff or stability
    window; test_resource_wait.py covers those timings directly.
    """
    from plugins.bank.service.resource_wait import IMPORT_RESOURCE_WAIT

    monkeypatch.setenv('BANK_RESOURCE_WAIT_MIN_SECONDS', '0')
    monkeypatch.setenv('BANK_RESOURCE_RECOVERY_STABLE_SECONDS', '0')
    IMPORT_RESOURCE_WAIT.reset()
    yield
    IMPORT_RESOURCE_WAIT.reset()
