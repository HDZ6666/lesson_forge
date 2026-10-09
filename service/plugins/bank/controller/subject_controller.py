from typing import Annotated

from fastapi import Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from common.aspect.db_session import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import PreAuthDependency
from common.router import APIRouterPro
from plugins.bank.entity.vo.bank_vo import SubjectModel, SubjectQueryModel
from plugins.bank.service.subject_service import SOURCE_PROFILES, SubjectService
from utils.response_util import ResponseUtil

subject_controller = APIRouterPro(
    prefix='/bank/subject',
    order_num=19,
    tags=['学科管理'],
    dependencies=[PreAuthDependency()],
)


@subject_controller.get(
    '/list',
    dependencies=[
        UserInterfaceAuthDependency(
            [
                'bank:sync:overview:list',
                'bank:sync:tasks:list',
                'bank:sync:discovery:list',
                'bank:subject:list',
                'bank:version:list',
                'bank:textbook:list',
                'bank:catalog:list',
                'bank:question:list',
                'bank:browse:list',
                'bank:sync:center:list',
                'bank:sync:question:list',
            ],
            is_strict=False,
        )
    ],
)
async def list_subjects(
    query: Annotated[SubjectQueryModel, Query()], db: Annotated[AsyncSession, DBSessionDependency()]
) -> Response:
    return ResponseUtil.success(data=await SubjectService.list(db, query.include_disabled))


@subject_controller.get('/profiles', dependencies=[UserInterfaceAuthDependency('bank:subject:list')])
async def source_profiles() -> Response:
    return ResponseUtil.success(data=[{'key': key, **value} for key, value in SOURCE_PROFILES.items()])


@subject_controller.post('', dependencies=[UserInterfaceAuthDependency('bank:subject:add')])
async def add_subject(payload: SubjectModel, db: Annotated[AsyncSession, DBSessionDependency()]) -> Response:
    return ResponseUtil.success(data=await SubjectService.save(db, payload))


@subject_controller.put('', dependencies=[UserInterfaceAuthDependency('bank:subject:edit')])
async def update_subject(payload: SubjectModel, db: Annotated[AsyncSession, DBSessionDependency()]) -> Response:
    return ResponseUtil.success(data=await SubjectService.save(db, payload, editing=True))
