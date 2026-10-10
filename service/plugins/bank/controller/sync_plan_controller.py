import asyncio
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import Query, Response
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from common.aspect.db_session import DBSessionDependency
from common.aspect.interface_auth import UserInterfaceAuthDependency
from common.aspect.pre_auth import CurrentUserDependency, PreAuthDependency
from common.router import APIRouterPro
from module_admin.entity.vo.user_vo import CurrentUserModel
from plugins.bank.entity.vo.bank_vo import BankModel
from plugins.bank.service import sync_issues, sync_plans
from plugins.bank.service.collector_client import CollectorClient
from utils.response_util import ResponseUtil

sync_plan_controller = APIRouterPro(
    prefix='/bank/sync', order_num=22, tags=['同步计划'], dependencies=[PreAuthDependency()]
)
DB = Annotated[AsyncSession, DBSessionDependency()]
USER = Annotated[CurrentUserModel, CurrentUserDependency()]
READ = UserInterfaceAuthDependency(
    ['bank:sync:plans:list', 'bank:sync:overview:list', 'bank:sync:tasks:list', 'bank:sync:question:list']
)


class PlanInput(BankModel):
    list_concurrency: int = Field(default=1, strict=True, ge=1, le=8)
    plan_name: str | None = Field(default=None, min_length=1, max_length=100)
    subject_id: int = Field(gt=0)
    expected_revision: int | None = Field(default=None, gt=0)
    enabled: bool = False
    refresh_days: int = Field(default=7, ge=1, le=365)
    refill_hours: int = Field(default=24, ge=1, le=720)
    discovery_days: int = Field(default=7, ge=1, le=365)


class BookOverride(BankModel):
    expected_revision: int = Field(ge=0)
    enabled: bool = True
    exception_kind: Literal['no_questions', 'inaccessible'] | None = None
    operator_note: str | None = Field(default=None, max_length=500)


class ControlInput(BankModel):
    expected_revision: int = Field(gt=0)
    paused: bool
    reason: str = Field(default='人工紧急暂停', min_length=1, max_length=500)


class RevisionInput(BankModel):
    expected_revision: int = Field(ge=0)


class IssueInput(BankModel):
    expected_revision: int = Field(gt=0)
    status: Literal['open', 'ignored']
    operator_note: str | None = Field(default=None, max_length=500)


@sync_plan_controller.get('/plans', dependencies=[READ])
async def plans(db: DB, subject_id: Annotated[int | None, Query(alias='subjectId', gt=0)] = None) -> Response:
    return ResponseUtil.success(data=await sync_plans.list_plans(db, subject_id))


@sync_plan_controller.put('/plans', dependencies=[UserInterfaceAuthDependency('bank:sync:plans:edit')])
async def save_plan(payload: PlanInput, db: DB) -> Response:
    return ResponseUtil.success(data=await sync_plans.save_plan(db, payload))


@sync_plan_controller.post('/plans/{plan_id}/discovery/retry', dependencies=[UserInterfaceAuthDependency('bank:sync:plans:edit')])
async def retry_plan_discovery(plan_id: int, payload: RevisionInput, db: DB) -> Response:
    return ResponseUtil.success(data=await sync_plans.retry_plan_discovery(db, plan_id, payload.expected_revision))


@sync_plan_controller.get('/plans/{plan_id}/books', dependencies=[READ])
async def plan_books(plan_id: int, db: DB) -> Response:
    return ResponseUtil.success(data=await sync_plans.list_books(db, plan_id))


@sync_plan_controller.put(
    '/plans/{plan_id}/books/{textbook_id}', dependencies=[UserInterfaceAuthDependency('bank:sync:plans:edit')]
)
async def save_book(plan_id: int, textbook_id: int, payload: BookOverride, db: DB) -> Response:
    return ResponseUtil.success(data=await sync_plans.save_book_override(db, plan_id, textbook_id, payload))


@sync_plan_controller.get('/control', dependencies=[READ])
async def control(db: DB) -> Response:
    local = await sync_plans.control_status(db)
    from plugins.bank.service.resource_guard import resource_status
    local['serviceResources'] = resource_status()
    await db.rollback()
    try:
        client = CollectorClient()
        health, source = await asyncio.gather(
            asyncio.to_thread(client.health), asyncio.to_thread(client.source_control)
        )
        local.update(collector=health, source=source, automaticReason=sync_plans.unattended_reason(health))
    except Exception as exc:
        local.update(collectorError=str(exc), automaticReason='采集器暂不可用')
    return ResponseUtil.success(data=local)


@sync_plan_controller.post('/control', dependencies=[UserInterfaceAuthDependency('bank:sync:control')])
async def change_control(payload: ControlInput, db: DB, user: USER) -> Response:
    return ResponseUtil.success(
        data=await sync_plans.set_control(
            db, payload.paused, payload.expected_revision, payload.reason, user.user.user_name
        )
    )


@sync_plan_controller.post('/control/source/resume', dependencies=[UserInterfaceAuthDependency('bank:sync:control')])
async def resume_source(payload: RevisionInput) -> Response:
    return ResponseUtil.success(
        data=await asyncio.to_thread(CollectorClient().resume_source, payload.expected_revision)
    )


@sync_plan_controller.get('/issues', dependencies=[READ])
async def issues(
    db: DB,
    subject_id: Annotated[int | None, Query(alias='subjectId', gt=0)] = None,
    textbook_id: Annotated[int | None, Query(alias='textbookId', gt=0)] = None,
    task_id: Annotated[int | None, Query(alias='taskId', gt=0)] = None,
    status: Literal['open', 'ignored', 'resolved'] | None = None,
    error_type: Annotated[str | None, Query(alias='errorType', max_length=50)] = None,
    handling: Literal['manual', 'retry'] | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    before: Annotated[int | None, Query(gt=0)] = None,
    page_size: Annotated[int, Query(alias='pageSize', ge=1, le=50)] = 20,
) -> Response:
    return ResponseUtil.success(
        data=await sync_issues.list_issues(
            db,
            subject_id=subject_id,
            textbook_id=textbook_id,
            task_id=task_id,
            status=status,
            error_type=error_type,
            since=since.astimezone(timezone.utc).replace(tzinfo=None) if since and since.tzinfo else since,
            until=until.astimezone(timezone.utc).replace(tzinfo=None) if until and until.tzinfo else until,
            before=before,
            page_size=page_size, handling=handling,
        )
    )


@sync_plan_controller.post('/issues/{issue_id}', dependencies=[UserInterfaceAuthDependency('bank:sync:issues:edit')])
async def issue_action(issue_id: int, payload: IssueInput, db: DB) -> Response:
    return ResponseUtil.success(
        data=await sync_issues.update_issue(
            db, issue_id, payload.expected_revision, payload.status, payload.operator_note
        )
    )


@sync_plan_controller.get('/issues/textbooks', dependencies=[READ])
async def issue_books(
    db: DB,
    subject_id: Annotated[int | None, Query(alias='subjectId', gt=0)] = None,
    name: Annotated[str | None, Query(max_length=100)] = None,
) -> Response:
    from sqlalchemy import exists, select

    from plugins.bank.entity.do.bank_do import QbSyncIssue, QbTextbook

    query = select(QbTextbook).where(exists(select(1).where(QbSyncIssue.textbook_id == QbTextbook.textbook_id)))
    if subject_id is not None:
        query = query.where(QbTextbook.subject_id == subject_id)
    if name:
        query = query.where(QbTextbook.textbook_name.contains(name, autoescape=True))
    rows = (await db.scalars(query.order_by(QbTextbook.textbook_id).limit(50))).all()
    return ResponseUtil.success(data=[{'textbookId': b.textbook_id, 'textbookName': b.textbook_name} for b in rows])
