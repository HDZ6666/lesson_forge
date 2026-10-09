"""教案抽题与生成接口。"""

from __future__ import annotations

import asyncio
from typing import Annotated
from urllib.parse import quote

from fastapi import Path, Query, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: TC002

from common.annotation.log_annotation import Log
from common.aspect.db_session import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import CurrentUserDependency, PreAuthDependency
from common.enums import BusinessType
from common.router import APIRouterPro
from common.vo import DataResponseModel, PageResponseModel
from exceptions.exception import ServiceException
from module_admin.entity.vo.user_vo import CurrentUserModel  # noqa: TC001
from plugins.bank.entity.vo.bank_vo import (
    CatalogTreeModel,
    TextbookModel,
    TextbookQueryModel,
    TextbookVersionModel,
    TextbookVersionQueryModel,
)
from plugins.bank.service.bank_service import BankService
from plugins.lesson.entity.vo.lesson_vo import (
    DefaultRulesRequestModel,
    GenerationDetailModel,
    GenerationPageQueryModel,
    GenerationSummaryRowModel,
    RuleSimulationModel,
    SchemeInputModel,
    SimulateRequestModel,
    TextUpdateModel,
)
from plugins.lesson.service.lesson_service import LessonService
from plugins.lesson.service.word_export import build_lesson_docx
from utils.response_util import ResponseUtil

lesson_controller = APIRouterPro(
    prefix='/lesson/plan',
    order_num=30,
    tags=['教案生成'],
    dependencies=[PreAuthDependency()],
)

_DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'


def _operator(current_user: CurrentUserModel | None) -> str | None:
    return current_user.user.user_name if current_user and current_user.user else None


def _parse_ids(value: str) -> list[int]:
    try:
        ids = [int(item.strip()) for item in value.split(',') if item.strip()]
    except ValueError as exc:
        raise ServiceException(message='ID 列表格式不正确') from exc
    if not ids or any(item <= 0 for item in ids) or len(ids) != len(set(ids)):
        raise ServiceException(message='ID 列表必须是去重后的正整数')
    return ids


@lesson_controller.get(
    '/options',
    response_model=DataResponseModel[dict],
    dependencies=[UserInterfaceAuthDependency('lesson:plan:list')],
)
async def plan_options() -> Response:
    return ResponseUtil.success(data=LessonService.options())


@lesson_controller.get(
    '/versions',
    response_model=PageResponseModel[TextbookVersionModel],
    dependencies=[UserInterfaceAuthDependency('lesson:plan:list')],
)
async def plan_versions(
    query: Annotated[TextbookVersionQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(model_content=await BankService.list_versions(db, query))


@lesson_controller.get(
    '/textbooks',
    response_model=PageResponseModel[TextbookModel],
    dependencies=[UserInterfaceAuthDependency('lesson:plan:list')],
)
async def plan_textbooks(
    query: Annotated[TextbookQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(model_content=await BankService.list_textbooks(db, query))


@lesson_controller.get(
    '/catalog-tree',
    response_model=DataResponseModel[list[CatalogTreeModel]],
    dependencies=[UserInterfaceAuthDependency('lesson:plan:list')],
)
async def plan_catalog_tree(
    textbook_id: Annotated[int, Query(alias='textbookId', gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.catalog_tree(db, textbook_id))


@lesson_controller.post(
    '/rules/default',
    response_model=DataResponseModel[list[dict]],
    dependencies=[UserInterfaceAuthDependency('lesson:plan:list')],
)
async def plan_default_rules(
    payload: DefaultRulesRequestModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await LessonService.default_rules(db, payload))


@lesson_controller.post(
    '/simulate',
    response_model=DataResponseModel[list[RuleSimulationModel]],
    dependencies=[UserInterfaceAuthDependency('lesson:plan:list')],
)
async def plan_simulate(
    payload: SimulateRequestModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await LessonService.simulate(db, payload))


@lesson_controller.post(
    '/generate',
    response_model=DataResponseModel[GenerationDetailModel],
    dependencies=[UserInterfaceAuthDependency('lesson:plan:generate')],
)
@Log(title='教案生成', business_type=BusinessType.INSERT)
async def plan_generate(
    request: Request,
    payload: SchemeInputModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(data=await LessonService.generate(db, payload, _operator(current_user)))


@lesson_controller.get(
    '/generation/list',
    response_model=PageResponseModel[GenerationSummaryRowModel],
    dependencies=[UserInterfaceAuthDependency('lesson:plan:list')],
)
async def plan_generation_list(
    query: Annotated[GenerationPageQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(model_content=await LessonService.list_generations(db, query))


@lesson_controller.get(
    '/generation/{generation_id}',
    response_model=DataResponseModel[GenerationDetailModel],
    dependencies=[UserInterfaceAuthDependency('lesson:plan:list')],
)
async def plan_generation_detail(
    generation_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await LessonService.detail(db, generation_id))


@lesson_controller.post(
    '/generation/{generation_id}/regenerate',
    response_model=DataResponseModel[GenerationDetailModel],
    dependencies=[UserInterfaceAuthDependency('lesson:plan:generate')],
)
@Log(title='教案重新生成', business_type=BusinessType.INSERT)
async def plan_regenerate(
    request: Request,
    generation_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(data=await LessonService.regenerate(db, generation_id, _operator(current_user)))


@lesson_controller.post(
    '/generation/{generation_id}/items/{item_id}/replace',
    response_model=DataResponseModel[GenerationDetailModel],
    dependencies=[UserInterfaceAuthDependency('lesson:plan:generate')],
)
@Log(title='教案换题', business_type=BusinessType.UPDATE)
async def plan_replace_item(
    request: Request,
    generation_id: Annotated[int, Path(gt=0)],
    item_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(
        data=await LessonService.replace_item(db, generation_id, item_id, _operator(current_user))
    )


@lesson_controller.put(
    '/generation/{generation_id}/text',
    response_model=DataResponseModel[GenerationDetailModel],
    dependencies=[UserInterfaceAuthDependency('lesson:plan:generate')],
)
@Log(title='教案文字保存', business_type=BusinessType.UPDATE)
async def plan_update_text(
    request: Request,
    generation_id: Annotated[int, Path(gt=0)],
    payload: TextUpdateModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(
        data=await LessonService.update_text(db, generation_id, payload, _operator(current_user))
    )


@lesson_controller.delete(
    '/generation/{generation_ids}',
    dependencies=[UserInterfaceAuthDependency('lesson:plan:remove')],
)
@Log(title='教案删除', business_type=BusinessType.DELETE)
async def plan_delete_generations(
    request: Request,
    generation_ids: Annotated[str, Path(min_length=1, max_length=500)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    deleted = await LessonService.delete_generations(db, _parse_ids(generation_ids))
    return ResponseUtil.success(msg=f'已删除 {deleted} 条生成记录')


@lesson_controller.get(
    '/generation/{generation_id}/export',
    dependencies=[UserInterfaceAuthDependency('lesson:plan:export')],
)
@Log(title='教案导出', business_type=BusinessType.EXPORT)
async def plan_export(
    request: Request,
    generation_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    detail = await LessonService.detail(db, generation_id)
    assets = {
        (int(item['questionId']), asset['assetKey']): asset
        for phase in detail.get('phases') or []
        for item in phase.get('items') or []
        for asset in ((item.get('question') or {}).get('assets') or [])
    }
    storage_paths: dict[tuple[int, str], str | None] = {}
    snapshot_paths = await LessonService.snapshot_asset_paths(db, generation_id)
    for (question_id, asset_key), asset in assets.items():
        if not asset.get('available'):
            continue
        path = snapshot_paths.get((question_id, asset_key))
        if path is None:
            row = await LessonService.asset_row(db, question_id, asset_key)
            path = row.storage_path if row is not None else None
        storage_paths[(question_id, asset_key)] = path

    def resolver(question_id: int, asset_key: str):  # noqa: ANN202
        storage_path = storage_paths.get((question_id, asset_key))
        if not storage_path:
            return None
        try:
            return LessonService.resolve_asset_path(storage_path)
        except Exception:
            return None

    content = await asyncio.to_thread(build_lesson_docx, detail, resolver)
    title = str((detail.get('lesson') or {}).get('title') or f'教案-{generation_id}')
    filename = quote(f'{title}.docx')
    return Response(
        content=content,
        media_type=_DOCX_MEDIA_TYPE,
        headers={
            'Content-Disposition': f"attachment; filename*=UTF-8''{filename}",
            'Access-Control-Expose-Headers': 'Content-Disposition',
        },
    )


@lesson_controller.get(
    '/asset/{question_id}/{asset_key}',
    dependencies=[UserInterfaceAuthDependency('lesson:plan:list')],
)
async def plan_asset_file(
    question_id: Annotated[int, Path(gt=0)],
    asset_key: Annotated[str, Path(min_length=1, max_length=100)],
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
    generation_id: Annotated[int | None, Query(alias='generationId', gt=0)] = None,
) -> FileResponse:
    path, media_type = await LessonService.asset_file(db, question_id, asset_key, generation_id)
    return FileResponse(path, media_type=media_type, filename=path.name)
