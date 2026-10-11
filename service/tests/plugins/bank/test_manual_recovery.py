import json
from types import SimpleNamespace

import pytest

from exceptions.exception import ServiceException
from plugins.bank.controller.manual_recovery_controller import manual_recovery_controller, owned
from plugins.bank.service import manual_recovery


def test_manual_recovery_http_requires_login_and_control_permission():
    assert len(manual_recovery_controller.dependencies) == 2
    assert manual_recovery_controller.dependencies[1].dependency.perm == 'bank:sync:control'


@pytest.mark.asyncio
async def test_other_user_cannot_control_an_existing_browser():
    class Redis:
        async def get(self,key):
            return json.dumps({'owner':'1','taskId':13})
    request=SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(redis=Redis())))
    with pytest.raises(ServiceException,match='其他管理员'):
        await owned(request,'session',SimpleNamespace(user=SimpleNamespace(user_id=2)))


@pytest.mark.asyncio
async def test_failed_probe_prevents_queue_or_resume(monkeypatch):
    calls=[]
    async def call(action,payload):
        calls.append(action)
        raise ServiceException(message='请先检查是否恢复')
    monkeypatch.setattr(manual_recovery,'call',call)
    with pytest.raises(ServiceException,match='请先检查'):
        await manual_recovery.finish_browser(None,'session',{'owner':'1'},'test')
    assert calls == ['validate']


@pytest.mark.asyncio
async def test_foreign_origin_is_rejected_before_ticket_read():
    from plugins.bank.controller.manual_recovery_controller import display_socket
    class Socket:
        headers = {'origin':'https://other.example','host':'lesson.hdz666.email'}
        async def close(self, code=1000):
            self.code=code
    socket=Socket()
    await display_socket(socket,'not-a-ticket')
    assert socket.code == 1008
