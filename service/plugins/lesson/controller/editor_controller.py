import asyncio
from typing import Annotated
from urllib.parse import quote

from fastapi import Query, Response
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from common.aspect.db_session import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import CurrentUserDependency, PreAuthDependency
from common.router import APIRouterPro
from module_admin.entity.vo.user_vo import CurrentUserModel
from plugins.lesson.entity.vo.editor_vo import (
    CandidateQuery,
    Command,
    CopyDraft,
    CreateDraft,
    Export,
    Fill,
    Mutation,
    Pick,
    Replace,
)
from plugins.lesson.service import editor_service as editor
from plugins.lesson.service.word_export import build_question_docx
from utils.response_util import ResponseUtil

editor_controller = APIRouterPro(
    prefix='/lesson/plan', order_num=29, tags=['教案编辑'], dependencies=[PreAuthDependency()]
)
DB = Annotated[AsyncSession, DBSessionDependency()]
USER = Annotated[CurrentUserModel, CurrentUserDependency()]
READ = UserInterfaceAuthDependency('lesson:plan:list')
WRITE = UserInterfaceAuthDependency('lesson:plan:generate')


@editor_controller.post('/drafts', dependencies=[WRITE])
async def create_draft(payload: CreateDraft, db: DB, user: USER) -> Response:
    return ResponseUtil.success(data=await editor.create(db, payload, user))


@editor_controller.get('/drafts', dependencies=[READ])
async def list_drafts(
    db: DB,
    user: USER,
    page_num: Annotated[int, Query(alias='pageNum', ge=1, le=100000)] = 1,
    page_size: Annotated[int, Query(alias='pageSize', ge=1, le=100)] = 20,
) -> Response:
    return ResponseUtil.success(data=await editor.list_drafts(db, user, page_num=page_num, page_size=page_size))


@editor_controller.get('/drafts/{draft_id}', dependencies=[READ])
async def draft_detail(draft_id: int, db: DB, user: USER) -> Response:
    return ResponseUtil.success(data=await editor.detail(db, draft_id, user))


@editor_controller.post('/candidates/query', dependencies=[READ])
async def query_candidates(payload: CandidateQuery, db: DB, user: USER) -> Response:
    return ResponseUtil.success(data=await editor.candidates(db, payload, user))


@editor_controller.post('/drafts/{draft_id}/commands', dependencies=[WRITE])
async def commands(draft_id: int, payload: Command, db: DB, user: USER) -> Response:
    return ResponseUtil.success(data=await editor.command(db, draft_id, payload, user))


@editor_controller.post('/drafts/{draft_id}/pick', dependencies=[WRITE])
async def pick(draft_id: int, payload: Pick, db: DB, user: USER) -> Response:
    return ResponseUtil.success(data=await editor.select_by_rules(db, draft_id, payload, user, direct=True))


@editor_controller.post('/drafts/{draft_id}/fill', dependencies=[WRITE])
async def fill(draft_id: int, payload: Fill, db: DB, user: USER) -> Response:
    return ResponseUtil.success(data=await editor.select_by_rules(db, draft_id, payload, user))


@editor_controller.post('/drafts/{draft_id}/items/{item_id}/replace', dependencies=[WRITE])
async def replace(draft_id: int, item_id: int, payload: Replace, db: DB, user: USER) -> Response:
    return ResponseUtil.success(data=await editor.select_by_rules(db, draft_id, payload, user, replace_item_id=item_id))


@editor_controller.delete('/drafts/{draft_id}', dependencies=[UserInterfaceAuthDependency('lesson:plan:remove')])
async def delete(draft_id: int, payload: Mutation, db: DB, user: USER) -> Response:
    return ResponseUtil.success(data=await editor.delete_draft(db, draft_id, payload, user))


@editor_controller.post('/generation/{generation_id}/copy-as-draft', dependencies=[WRITE])
async def copy_draft(generation_id: int, payload: CopyDraft, db: DB, user: USER) -> Response:
    return ResponseUtil.success(data=await editor.copy_as_draft(db, generation_id, payload, user))


@editor_controller.get('/drafts/{draft_id}/assets/{question_id}/{key}', dependencies=[READ])
async def draft_asset(draft_id: int, question_id: int, key: str, db: DB, user: USER) -> FileResponse:
    path, mime = await editor.snapshot_asset(db, draft_id, question_id, key, user)
    return FileResponse(path, media_type=mime)


@editor_controller.get('/drafts/{draft_id}/candidates/{question_id}/assets/{key}', dependencies=[READ])
async def candidate_asset(draft_id: int, question_id: int, key: str, db: DB, user: USER) -> FileResponse:
    row = await editor.require_draft(db, draft_id, user)
    from sqlalchemy import select

    from exceptions.exception import ServiceException
    from plugins.bank.entity.do.bank_do import QbQuestion, QbQuestionAsset
    from plugins.bank.service.question_readiness import probe_stem, question_payload
    from plugins.lesson.entity.do.lesson_do import LpScheme
    from plugins.lesson.entity.vo.editor_vo import QuestionFilter
    from plugins.lesson.service.editor_filter import filtered_ids
    from plugins.lesson.service.lesson_service import LessonService

    scheme = await db.get(LpScheme, row.scheme_id)
    query = await filtered_ids(db, scheme.textbook_id, QuestionFilter())
    if not await db.scalar(query.where(QbQuestion.question_id == question_id)):
        raise ServiceException(message='题目不属于本教案的可用教材范围')
    question = await db.get(QbQuestion, question_id)
    if key not in probe_stem(question_payload(question))['keys']:
        raise ServiceException(message='素材不属于该题题干')
    asset = await db.scalar(
        select(QbQuestionAsset).where(QbQuestionAsset.question_id == question_id, QbQuestionAsset.asset_key == key)
    )
    return FileResponse(
        LessonService.resolve_asset_path(asset.storage_path if asset else None),
        media_type=asset.mime_type if asset else None,
    )


@editor_controller.post('/drafts/{draft_id}/export', dependencies=[UserInterfaceAuthDependency('lesson:plan:export')])
async def export(draft_id: int, payload: Export, db: DB, user: USER) -> Response:
    model, paths = await editor.export_model(db, draft_id, payload.revision, user)
    content = await asyncio.to_thread(build_question_docx, model, lambda q, key: paths.get((q, key)))
    return Response(
        content=content,
        media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        headers={
            'Content-Disposition': f"attachment; filename*=UTF-8''{quote(model['title'] + '.docx')}",
            'Access-Control-Expose-Headers': 'Content-Disposition',
        },
    )


@editor_controller.get('/drafts/{draft_id}/filter-options', dependencies=[READ])
async def filter_options(draft_id: int, db: DB, user: USER) -> Response:
    from sqlalchemy import select

    from plugins.bank.entity.do.bank_do import QbQuestion
    from plugins.lesson.entity.do.lesson_do import LpScheme
    from plugins.lesson.entity.vo.editor_vo import QuestionFilter
    from plugins.lesson.service.editor_filter import filtered_ids

    row = await editor.require_draft(db, draft_id, user)
    scheme = await db.get(LpScheme, row.scheme_id)
    query = await filtered_ids(db, scheme.textbook_id, QuestionFilter())
    names = {
        'questionTypes': 'question_type',
        'difficulties': 'difficulty',
        'provinces': 'province',
        'cities': 'city',
        'examTypes': 'exam_type',
    }
    result = {}
    for key, name in names.items():
        column = getattr(QbQuestion, name)
        values = list(
            (
                await db.scalars(
                    select(column)
                    .where(QbQuestion.question_id.in_(query), column.is_not(None))
                    .distinct()
                    .order_by(column)
                )
            ).all()
        )
        result[key] = [value for value in values if value]
    return ResponseUtil.success(data=result)
