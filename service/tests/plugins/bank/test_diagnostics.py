import gzip
import json

import pytest

from plugins.bank.service import diagnostics


def records(root):
    return [json.loads(line) for p in root.glob('*.gz') for line in gzip.open(p,'rt')]


def test_request_failure_has_route_cursor_timeout_and_shared_id(tmp_path,monkeypatch):
    monkeypatch.setenv('BANK_DIAGNOSTICS_DIR',str(tmp_path))
    class Client:
        timeout=5
        @diagnostics.audited_request
        def request(self,method,route,**kwargs):
            diagnostics.event('collector_http_response',status=504)
            raise TimeoutError('timeout')
    token=diagnostics.bind(taskId=16,importId=13)
    try:
        with pytest.raises(TimeoutError):
            Client().request('GET','/v1/runs/15/snapshot-page',query={'collection':'questions','cursor':500,'token':'secret'})
    finally:
        diagnostics.reset(token)
    rows=records(tmp_path)
    assert {r['requestId'] for r in rows} == {rows[0]['requestId']}
    assert rows[-1]['route']=='/v1/runs/15/snapshot-page'
    assert rows[-1]['params']=={'collection':'questions','cursor':500}
    assert rows[-1]['timeoutSeconds']==5
    assert rows[-1]['taskId']==16
    assert rows[-1]['outcome']=='error'
    assert rows[-1]['errorType']=='TimeoutError'
    assert 'secret' not in str(rows)


def test_batch_success_and_credentials_redacted(tmp_path,monkeypatch):
    monkeypatch.setenv('BANK_DIAGNOSTICS_DIR',str(tmp_path))
    with diagnostics.span('batch_mysql_commit',cursor=100) as result:
        result['processedCount']=200
        result['ownerToken']='secret'
    rows=records(tmp_path)
    assert len(rows)==2
    assert rows[0]['spanId']==rows[1]['spanId']
    assert rows[1]['processedCount']==200
    assert rows[1]['ownerToken']=='[REDACTED]'


def test_resource_trigger_includes_decision_values(tmp_path,monkeypatch):
    from plugins.bank.service import resource_guard
    monkeypatch.setenv('BANK_DIAGNOSTICS_DIR',str(tmp_path))
    monkeypatch.setattr(resource_guard,'resource_status',lambda **kwargs: {'paused':True,'reason':'low memory','availableMemoryMiB':128,'minMemoryMiB':512})
    monkeypatch.setattr(resource_guard,'resource_snapshot',lambda: {'hostAvailableBytes':128*1024*1024})
    with pytest.raises(resource_guard.ResourcePressure):
        resource_guard.assert_resources()
    row=records(tmp_path)[0]
    assert row['state']['availableMemoryMiB']==128
    assert row['triggerSnapshot']['hostAvailableBytes']==128*1024*1024
