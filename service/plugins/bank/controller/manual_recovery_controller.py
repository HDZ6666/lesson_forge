"""Authenticated manual browser handoff; public sockets use single-use tickets."""
import asyncio
import json
import secrets
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import Request, WebSocket
from pydantic import Field
from websockets.asyncio.client import connect

from common.aspect.db_session import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import CurrentUserDependency, PreAuthDependency
from common.router import APIRouterPro
from exceptions.exception import ServiceException
from module_admin.entity.vo.user_vo import CurrentUserModel
from plugins.bank.entity.vo.bank_vo import BankModel
from plugins.bank.service import manual_recovery
from plugins.bank.service.collector_client import CollectorClient
from utils.response_util import ResponseUtil

manual_recovery_controller = APIRouterPro(prefix='/bank/sync/manual-recovery', tags=['来源人工处理'],
    dependencies=[PreAuthDependency(), UserInterfaceAuthDependency('bank:sync:control')])
manual_display_controller = APIRouterPro(prefix='/bank/sync/manual-display', tags=['来源人工画面'])
USER = Annotated[CurrentUserModel, CurrentUserDependency()]


class OpenInput(BankModel):
    subject_id: int = Field(gt=0)


class SessionInput(BankModel):
    session_id: str = Field(min_length=36, max_length=36)


async def owned(request, session_id, user):
    raw = await request.app.state.redis.get(f'bank:manual:{session_id}')
    state = json.loads(raw) if raw else None
    if not state or state['owner'] != str(user.user.user_id):
        raise ServiceException(message='人工处理会话已过期或由其他管理员持有，请重新打开')
    return state


@manual_recovery_controller.post('/open')
async def open_browser(payload: OpenInput, request: Request, user: USER, db=DBSessionDependency()):
    state, result = await manual_recovery.open_browser(db, payload.subject_id, str(user.user.user_id))
    await request.app.state.redis.set(f"bank:manual:{result['sessionId']}", json.dumps(state), ex=1800)
    return ResponseUtil.success(data=result)


@manual_recovery_controller.post('/ticket')
async def display_ticket(payload: SessionInput, request: Request, user: USER):
    state = await owned(request, payload.session_id, user)
    ticket = secrets.token_urlsafe(32)
    await request.app.state.redis.set(f'bank:manual-ticket:{ticket}', json.dumps({**state, 'sessionId':payload.session_id}), ex=60)
    return ResponseUtil.success(data={'ticket': ticket})


@manual_recovery_controller.post('/check')
async def check_browser(payload: SessionInput, request: Request, user: USER):
    state = await owned(request, payload.session_id, user)
    return ResponseUtil.success(data=await manual_recovery.call('check', {'sessionId':payload.session_id,'owner':state['owner']}))


@manual_recovery_controller.post('/finish')
async def finish_browser(payload: SessionInput, request: Request, user: USER, db=DBSessionDependency()):
    state = await owned(request, payload.session_id, user)
    if state.get('completed'):
        return ResponseUtil.success(data=state['completed'])
    result = await manual_recovery.finish_browser(db, payload.session_id, state, user.user.user_name)
    state['completed'] = result
    await request.app.state.redis.set(f'bank:manual:{payload.session_id}', json.dumps(state), ex=1800)
    return ResponseUtil.success(data=result)


@manual_recovery_controller.post('/close')
async def close_browser(payload: SessionInput, request: Request, user: USER):
    state = await owned(request, payload.session_id, user)
    result = await manual_recovery.call('close', {'sessionId':payload.session_id,'owner':state['owner']})
    await request.app.state.redis.delete(f'bank:manual:{payload.session_id}')
    return ResponseUtil.success(data=result)


@manual_display_controller.websocket('/{ticket}')
async def display_socket(socket: WebSocket, ticket: str):
    # This route intentionally has no HTTP Bearer dependency. Its ticket can
    # only be minted by the authenticated control-permission POST above.
    if urlsplit(socket.headers.get('origin','')).netloc != socket.headers.get('host'):
        await socket.close(code=1008)
        return
    raw = await socket.app.state.redis.getdel(f'bank:manual-ticket:{ticket}')
    if not raw:
        await socket.close(code=1008)
        return
    state = json.loads(raw)
    stored = await socket.app.state.redis.get(f"bank:manual:{state['sessionId']}")
    if not stored or json.loads(stored)['owner'] != state['owner']:
        await socket.close(code=1008)
        return
    client = CollectorClient()
    target = client.base_url.replace('https://','wss://').replace('http://','ws://')
    tasks = []
    try:
        async with connect(f"{target}/v1/manual-recovery/display?sessionId={state['sessionId']}",
                           additional_headers={'Authorization':f'Bearer {client.token}'}, max_size=8*1024*1024,
                           open_timeout=10) as upstream:
            await socket.accept(subprotocol='binary' if 'binary' in socket.headers.get('sec-websocket-protocol','') else None)
            async def incoming():
                while True:
                    await upstream.send(await socket.receive_bytes())
            async def outgoing():
                async for data in upstream:
                    await socket.send_bytes(data)
            tasks = [asyncio.create_task(incoming()), asyncio.create_task(outgoing())]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except Exception:
        pass
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        try:
            await socket.close()
        except RuntimeError:
            pass
