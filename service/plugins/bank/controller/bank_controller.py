"""HTTP API for bank browsing, base-data management and batch operations."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Path, Query, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: TC002

from common.annotation.log_annotation import Log
from common.annotation.rate_limit_annotation import ApiRateLimit, ApiRateLimitPreset
from common.aspect.db_session import DBSessionDependency
from common.aspect.interface_auth import CheckUserInterfaceAuth, UserInterfaceAuthDependency
from common.aspect.pre_auth import CurrentUserDependency, PreAuthDependency
from common.constant import ApiNamespace
from common.enums import BusinessType
from common.router import APIRouterPro
from common.vo import DataResponseModel, PageResponseModel, ResponseBaseModel
from exceptions.exception import ServiceException
from module_admin.entity.vo.user_vo import CurrentUserModel  # noqa: TC001
from plugins.bank.entity.vo.bank_vo import (
    BatchModel,
    BatchPageQueryModel,
    CatalogNodeModel,
    CatalogPageQueryModel,
    CatalogTreeModel,
    CatalogTreeQueryModel,
    ImportResultQueryModel,
    QuestionApplyRequestModel,
    QuestionApplyResponseModel,
    QuestionAssetModel,
    QuestionDetailModel,
    QuestionModel,
    QuestionPageQueryModel,
    QuestionTaskCreateModel,
    QuestionTaskSelectionModel,
    QuestionWriteModel,
    SyncCompareQueryModel,
    SyncCompareResponseModel,
    SyncContentRunStartRequestModel,
    SyncEntityType,
    SyncMetadataSnapshotModel,
    SyncReviewRequestModel,
    SyncReviewResultModel,
    SyncRunModel,
    SyncRunPageQueryModel,
    SyncRunStartRequestModel,
    SyncTaskCreateModel,
    SyncTaskModel,
    SyncTaskPageQueryModel,
    SyncTextbookOverviewModel,
    TaskComparisonQueryModel,
    TaskComparisonResponseModel,
    TaskOptionsModel,
    TextbookApplyRequestModel,
    TextbookApplyResponseModel,
    TextbookCoverageModel,
    TextbookModel,
    TextbookQueryModel,
    TextbookVersionModel,
    TextbookVersionQueryModel,
)
from plugins.bank.service.bank_service import BankService
from plugins.bank.service.question_apply_service import QuestionApplyService
from plugins.bank.service.question_review_service import QuestionReviewService
from plugins.bank.service.sync_run_service import SyncRunService
from plugins.bank.service.sync_service import SyncService
from plugins.bank.service.task_service import SyncTaskService
from plugins.bank.service.textbook_apply_service import TextbookApplyService
from utils.response_util import ResponseUtil

bank_controller = APIRouterPro(
    prefix='/bank',
    order_num=20,
    tags=['题库管理'],
    dependencies=[PreAuthDependency()],
)

_SYNC_RUN_READ_PERMISSIONS = [
    'bank:sync:run',
    'bank:sync:version:list',
    'bank:sync:textbook:list',
    'bank:sync:catalog:list',
    'bank:sync:question:list',
]
_TEXTBOOK_TASK_READ_PERMISSIONS = ['bank:sync:discovery:list', 'bank:sync:center:list', 'bank:sync:textbook:list']
_QUESTION_TASK_READ_PERMISSIONS = ['bank:sync:tasks:list', 'bank:sync:center:list', 'bank:sync:question:list']
_QUESTION_OPTIONS_READ_PERMISSIONS = [
    'bank:sync:tasks:list',
    'bank:sync:center:list',
    'bank:sync:question:list',
    'bank:sync:version:list',
    'bank:sync:textbook:list',
]
_TEXTBOOK_TASK_QUERY_PERMISSIONS = [
    'bank:sync:discovery:list',
    'bank:sync:center:list',
    'bank:sync:textbook:list',
    'bank:sync:textbook:query',
]
_QUESTION_TASK_QUERY_PERMISSIONS = [
    'bank:sync:tasks:list',
    'bank:sync:center:list',
    'bank:sync:question:list',
    'bank:sync:question:query',
]
_TEXTBOOK_TASK_CREATE_PERMISSIONS = ['bank:sync:run', 'bank:sync:textbook:add']
_QUESTION_TASK_CREATE_PERMISSIONS = ['bank:sync:run', 'bank:sync:question:add']
_TEXTBOOK_TASK_CANCEL_PERMISSIONS = ['bank:sync:run', 'bank:sync:textbook:cancel']
_TEXTBOOK_TASK_RETRY_PERMISSIONS = ['bank:sync:run', 'bank:sync:textbook:retry']
_TEXTBOOK_TASK_DELETE_PERMISSIONS = ['bank:sync:run', 'bank:sync:textbook:remove']
_QUESTION_TASK_CANCEL_PERMISSIONS = ['bank:sync:run', 'bank:sync:question:cancel']
_QUESTION_TASK_RETRY_PERMISSIONS = ['bank:sync:run', 'bank:sync:question:retry']
_QUESTION_TASK_DELETE_PERMISSIONS = ['bank:sync:run', 'bank:sync:question:remove']
_QUESTION_TASK_RESUME_PERMISSIONS = ['bank:sync:run', 'bank:sync:question:resume']


class _SyncRunReadPermission:
    """Allow the sync-center permission or any legacy task read permission.

    Keeping the legacy permission list on ``perm`` preserves introspection for
    existing integrations while the callable itself implements the new OR
    semantics required by the consolidated sync-center page.
    """

    perm = ['bank:sync:center:list', *_SYNC_RUN_READ_PERMISSIONS]

    def __call__(self, request: Request) -> bool:
        return CheckUserInterfaceAuth(['bank:sync:center:list', *_SYNC_RUN_READ_PERMISSIONS])(request)


class _SyncListPermission:
    """Resolve the least-privilege list permission from the closed path enum."""

    def __call__(self, request: Request) -> bool:
        entity_type = request.path_params.get('entity_type')
        permission = {
            'version': 'bank:sync:version:list',
            'textbook': 'bank:sync:textbook:list',
            'catalog': 'bank:sync:catalog:list',
            'question': 'bank:sync:question:list',
        }.get(entity_type)
        if permission is None:
            raise ServiceException(message='不支持的同步实体类型')
        return CheckUserInterfaceAuth(['bank:sync:center:list', permission])(request)


def _parse_ids(value: str) -> list[int]:
    try:
        ids = [int(item.strip()) for item in value.split(',') if item.strip()]
    except ValueError as exc:
        raise ServiceException(message='ID 列表格式不正确') from exc
    if not ids or any(item <= 0 for item in ids) or len(ids) != len(set(ids)):
        raise ServiceException(message='ID 列表必须是去重后的正整数')
    return ids


@bank_controller.post(
    '/sync/run/metadata/start',
    response_model=DataResponseModel[SyncRunModel],
    dependencies=[UserInterfaceAuthDependency('bank:sync:run')],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='题库版本教材同步', business_type=BusinessType.OTHER)
async def start_metadata_sync_run(
    request: Request,
    payload: SyncRunStartRequestModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    operator = current_user.user.user_name if current_user and current_user.user else None
    return ResponseUtil.success(data=await SyncRunService.start_metadata(db, payload, operator))


@bank_controller.post(
    '/sync/run/content/start',
    response_model=DataResponseModel[SyncRunModel],
    dependencies=[UserInterfaceAuthDependency('bank:sync:run')],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='题库目录题目同步', business_type=BusinessType.OTHER)
async def start_content_sync_run(
    request: Request,
    payload: SyncContentRunStartRequestModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    operator = current_user.user.user_name if current_user and current_user.user else None
    return ResponseUtil.success(data=await SyncRunService.start_content(db, payload, operator))


@bank_controller.get(
    '/sync/catalog-progress',
    response_model=ResponseBaseModel,
    dependencies=[Depends(_SyncRunReadPermission())],
)
async def catalog_sync_progress() -> Response:
    return ResponseUtil.success(data=await SyncRunService.catalog_progress())


@bank_controller.get(
    '/sync/run/current',
    response_model=DataResponseModel[SyncRunModel | None],
    dependencies=[Depends(_SyncRunReadPermission())],
)
async def current_sync_run(db: Annotated[AsyncSession, DBSessionDependency()]) -> Response:
    current = await SyncRunService.current(db)
    # ResponseUtil omits ``data`` when its value is None; the explicit dict
    # keeps the no-current-task contract stable for the polling client.
    return ResponseUtil.success(dict_content={'data': current})


@bank_controller.get(
    '/sync/run/list',
    response_model=PageResponseModel[SyncRunModel],
    dependencies=[Depends(_SyncRunReadPermission())],
)
async def list_sync_runs(
    query: Annotated[SyncRunPageQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(model_content=await SyncRunService.list(db, query))


@bank_controller.get(
    '/sync/run/{run_id}',
    response_model=DataResponseModel[SyncRunModel],
    dependencies=[Depends(_SyncRunReadPermission())],
)
async def sync_run_detail(
    run_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await SyncRunService.detail(db, run_id))


@bank_controller.post(
    '/sync/run/{run_id}/cancel',
    response_model=DataResponseModel[SyncRunModel],
    dependencies=[UserInterfaceAuthDependency('bank:sync:run')],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='停止题库来源同步', business_type=BusinessType.OTHER)
async def cancel_sync_run(
    request: Request,
    run_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await SyncRunService.cancel(db, run_id))


# Independent task modules -------------------------------------------------
# These routes intentionally live beside the legacy sync-center routes.  They
# share the durable ``qb_sync_job`` table but have module-specific read
# permissions and immutable task/scope response projections.


@bank_controller.post(
    '/sync/textbook/tasks',
    response_model=DataResponseModel[SyncTaskModel],
    dependencies=[UserInterfaceAuthDependency(_TEXTBOOK_TASK_CREATE_PERMISSIONS)],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='同步教材任务', business_type=BusinessType.OTHER)
async def create_textbook_sync_task(
    request: Request,
    payload: SyncTaskCreateModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    operator = current_user.user.user_name if current_user and current_user.user else None
    return ResponseUtil.success(data=await SyncTaskService.create_textbook(db, payload, operator))


@bank_controller.get(
    '/sync/textbook/tasks',
    response_model=PageResponseModel[SyncTaskModel],
    dependencies=[UserInterfaceAuthDependency(_TEXTBOOK_TASK_READ_PERMISSIONS)],
)
async def list_textbook_sync_tasks(
    query: Annotated[SyncTaskPageQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(model_content=await SyncTaskService.list_textbook(db, query))


@bank_controller.get(
    '/sync/textbook/tasks/{task_id}',
    response_model=DataResponseModel[SyncTaskModel],
    dependencies=[UserInterfaceAuthDependency(_TEXTBOOK_TASK_QUERY_PERMISSIONS)],
)
async def get_textbook_sync_task(
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await SyncTaskService.textbook_detail(db, task_id))


@bank_controller.post(
    '/sync/textbook/tasks/{task_id}/apply',
    response_model=DataResponseModel[TextbookApplyResponseModel],
    dependencies=[UserInterfaceAuthDependency('bank:sync:textbook:apply')],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='应用正式教材快照', business_type=BusinessType.UPDATE)
async def apply_textbook_sync_task(
    request: Request,
    task_id: Annotated[int, Path(gt=0)],
    payload: TextbookApplyRequestModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    operator = current_user.user.user_name if current_user and current_user.user else None
    result = await TextbookApplyService.apply(
        db,
        task_id,
        payload.expected_current_task_id,
        operator,
    )
    return ResponseUtil.success(data=result)


@bank_controller.post(
    '/sync/textbook/tasks/{task_id}/discovery-retry',
    dependencies=[UserInterfaceAuthDependency('bank:sync:textbook:apply')],
)
@Log(title='重试教材发现登记', business_type=BusinessType.UPDATE)
async def retry_textbook_discovery(
    request: Request,
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    from plugins.bank.service.metadata_discovery import retry_discovery
    return ResponseUtil.success(data=await retry_discovery(db, task_id))


@bank_controller.delete(
    '/sync/textbook/tasks/{task_id}',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency(_TEXTBOOK_TASK_DELETE_PERMISSIONS)],
)
@Log(title='删除同步教材任务', business_type=BusinessType.DELETE)
async def delete_textbook_sync_task(
    request: Request,
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    await SyncTaskService.delete_textbook(db, task_id)
    return ResponseUtil.success(msg='删除成功')


@bank_controller.get(
    '/sync/textbook/tasks/{task_id}/comparison',
    response_model=DataResponseModel[TaskComparisonResponseModel],
    dependencies=[UserInterfaceAuthDependency(_TEXTBOOK_TASK_QUERY_PERMISSIONS)],
)
async def compare_textbook_sync_task(
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await SyncTaskService.textbook_comparison(db, task_id))


@bank_controller.post(
    '/sync/textbook/tasks/{task_id}/cancel',
    response_model=DataResponseModel[SyncTaskModel],
    dependencies=[UserInterfaceAuthDependency(_TEXTBOOK_TASK_CANCEL_PERMISSIONS)],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='停止同步教材任务', business_type=BusinessType.OTHER)
async def cancel_textbook_sync_task(
    request: Request,
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await SyncTaskService.cancel_textbook(db, task_id))


@bank_controller.post(
    '/sync/textbook/tasks/{task_id}/retry',
    response_model=DataResponseModel[SyncTaskModel],
    dependencies=[UserInterfaceAuthDependency(_TEXTBOOK_TASK_RETRY_PERMISSIONS)],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='重试同步教材任务', business_type=BusinessType.OTHER)
async def retry_textbook_sync_task(
    request: Request,
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    operator = current_user.user.user_name if current_user and current_user.user else None
    return ResponseUtil.success(data=await SyncTaskService.retry_textbook(db, task_id, operator))


@bank_controller.get(
    '/sync/question/options',
    response_model=DataResponseModel[TaskOptionsModel],
    dependencies=[UserInterfaceAuthDependency(_QUESTION_OPTIONS_READ_PERMISSIONS)],
)
async def list_question_sync_options(
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await SyncTaskService.question_options(db))


@bank_controller.post(
    '/sync/question/tasks',
    response_model=DataResponseModel[SyncTaskModel],
    dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_CREATE_PERMISSIONS)],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='同步题库任务', business_type=BusinessType.OTHER)
async def create_question_sync_task(
    request: Request,
    payload: QuestionTaskCreateModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    operator = current_user.user.user_name if current_user and current_user.user else None
    return ResponseUtil.success(data=await SyncTaskService.create_question(db, payload, operator))


@bank_controller.get(
    '/sync/question/tasks',
    response_model=PageResponseModel[SyncTaskModel],
    dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_READ_PERMISSIONS)],
)
async def list_question_sync_tasks(
    query: Annotated[SyncTaskPageQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(model_content=await SyncTaskService.list_question(db, query))


@bank_controller.get(
    '/sync/question/tasks/{task_id}',
    response_model=DataResponseModel[SyncTaskModel],
    dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_QUERY_PERMISSIONS)],
)
async def get_question_sync_task(
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await SyncTaskService.question_detail(db, task_id))


@bank_controller.post(
    '/sync/question/tasks/{task_id}/apply',
    response_model=DataResponseModel[QuestionApplyResponseModel],
    dependencies=[UserInterfaceAuthDependency('bank:sync:question:apply')],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='应用正式题库快照', business_type=BusinessType.UPDATE)
async def apply_question_sync_task(
    request: Request,
    task_id: Annotated[int, Path(gt=0)],
    payload: QuestionApplyRequestModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    operator = current_user.user.user_name if current_user and current_user.user else None
    result = await QuestionApplyService.apply(
        db,
        task_id,
        expected_current_task_id=payload.expected_current_task_id,
        operator=operator,
        expected_state_token=payload.expected_state_token,
        expected_review_revision=payload.expected_review_revision,
    )
    return ResponseUtil.success(data=result)


@bank_controller.post(
    '/sync/question/tasks/{task_id}/import',
    dependencies=[UserInterfaceAuthDependency('bank:sync:question:apply')],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='提交分批题库入库', business_type=BusinessType.UPDATE)
async def request_question_incremental_import(
    request: Request,
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    from plugins.bank.service.incremental_import import request_incremental_import

    await db.rollback()
    return ResponseUtil.success(data=await request_incremental_import(db, task_id))


@bank_controller.post(
    '/sync/question/tasks/{task_id}/import-intake/retry',
    dependencies=[UserInterfaceAuthDependency('bank:sync:question:apply')],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='重试题库封存核验', business_type=BusinessType.UPDATE)
async def retry_question_import_intake(
    request: Request,
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    from plugins.bank.service.import_intake import retry_import_intake

    await db.rollback()
    return ResponseUtil.success(data=await retry_import_intake(db, task_id))


@bank_controller.get(
    '/sync/question/tasks/{task_id}/imports',
    dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_READ_PERMISSIONS)],
)
async def question_import_history(
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
    before_id: Annotated[int | None, Query(alias='beforeId', gt=0)] = None,
    page_size: Annotated[int, Query(alias='pageSize', ge=1, le=50)] = 20,
) -> Response:
    from plugins.bank.service.import_results import list_import_history

    return ResponseUtil.success(data=await list_import_history(db, task_id, before_id=before_id, page_size=page_size))


@bank_controller.get(
    '/sync/question/tasks/{task_id}/imports/{import_id}/batches',
    dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_READ_PERMISSIONS)],
)
async def question_import_batches(
    task_id: Annotated[int, Path(gt=0)],
    import_id: Annotated[int, Path(gt=0)],
    query: Annotated[ImportResultQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    from plugins.bank.service.import_results import batch_results

    return ResponseUtil.success(data=await batch_results(db, task_id, import_id, cursor=query.cursor, page_size=query.page_size))


@bank_controller.get(
    '/sync/question/tasks/{task_id}/imports/{import_id}/issues',
    dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_READ_PERMISSIONS)],
)
async def question_import_issues(
    task_id: Annotated[int, Path(gt=0)],
    import_id: Annotated[int, Path(gt=0)],
    query: Annotated[ImportResultQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    from plugins.bank.service.import_results import issue_results

    return ResponseUtil.success(data=await issue_results(db, task_id, import_id, cursor=query.cursor, page_size=query.page_size))


@bank_controller.delete(
    '/sync/question/tasks/{task_id}',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_DELETE_PERMISSIONS)],
)
@Log(title='删除同步题库任务', business_type=BusinessType.DELETE)
async def delete_question_sync_task(
    request: Request,
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    await SyncTaskService.delete_question(db, task_id)
    return ResponseUtil.success(msg='删除成功')


@bank_controller.get('/sync/question/tasks/{task_id}/review/catalogs', dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_QUERY_PERMISSIONS)])
async def review_question_catalogs(task_id: Annotated[int, Path(gt=0)], query: Annotated[TaskComparisonQueryModel, Query()], db: Annotated[AsyncSession, DBSessionDependency()]) -> Response:
    return ResponseUtil.success(data=await QuestionReviewService.catalogs(db, task_id, query))


@bank_controller.get('/sync/question/tasks/{task_id}/review/questions', dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_QUERY_PERMISSIONS)])
async def review_question_list(task_id: Annotated[int, Path(gt=0)], query: Annotated[TaskComparisonQueryModel, Query()], db: Annotated[AsyncSession, DBSessionDependency()]) -> Response:
    return ResponseUtil.success(data=await QuestionReviewService.questions(db, task_id, query))


@bank_controller.get('/sync/question/tasks/{task_id}/review/questions/{external_id}', dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_QUERY_PERMISSIONS)])
async def review_question_detail(task_id: Annotated[int, Path(gt=0)], external_id: Annotated[str, Path(min_length=1, max_length=64)], query: Annotated[TaskComparisonQueryModel, Query()], db: Annotated[AsyncSession, DBSessionDependency()]) -> Response:
    return ResponseUtil.success(data=await QuestionReviewService.detail(db, task_id, external_id, query))


@bank_controller.post('/sync/question/tasks/{task_id}/review/selection', dependencies=[UserInterfaceAuthDependency('bank:sync:question:apply')])
async def review_question_selection(task_id: Annotated[int, Path(gt=0)], body: QuestionTaskSelectionModel, query: Annotated[TaskComparisonQueryModel, Query()], db: Annotated[AsyncSession, DBSessionDependency()]) -> Response:
    return ResponseUtil.success(data=await QuestionReviewService.select_questions(db, task_id, body, query))


@bank_controller.get(
    '/sync/question/tasks/{task_id}/catalog-comparison',
    response_model=DataResponseModel[TaskComparisonResponseModel],
    dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_QUERY_PERMISSIONS)],
)
async def compare_question_sync_catalogs(
    task_id: Annotated[int, Path(gt=0)],
    query: Annotated[TaskComparisonQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await SyncTaskService.catalog_comparison(db, task_id, query))


@bank_controller.get(
    '/sync/question/tasks/{task_id}/question-comparison',
    response_model=DataResponseModel[TaskComparisonResponseModel],
    dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_QUERY_PERMISSIONS)],
)
async def compare_question_sync_questions(
    task_id: Annotated[int, Path(gt=0)],
    query: Annotated[TaskComparisonQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await SyncTaskService.question_comparison(db, task_id, query))


@bank_controller.get(
    '/sync/question/tasks/{task_id}/questions/{external_id}',
    response_model=DataResponseModel[TaskComparisonResponseModel],
    dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_QUERY_PERMISSIONS)],
)
async def get_question_sync_question_detail(
    task_id: Annotated[int, Path(gt=0)],
    external_id: Annotated[str, Path(min_length=1, max_length=128)],
    query: Annotated[TaskComparisonQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await SyncTaskService.question_detail_comparison(db, task_id, external_id, query))


@bank_controller.post(
    '/sync/question/tasks/{task_id}/cancel',
    response_model=DataResponseModel[SyncTaskModel],
    dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_CANCEL_PERMISSIONS)],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='停止同步题库任务', business_type=BusinessType.OTHER)
async def cancel_question_sync_task(
    request: Request,
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await SyncTaskService.cancel_question(db, task_id))


@bank_controller.post(
    '/sync/question/tasks/{task_id}/resume',
    response_model=DataResponseModel[SyncTaskModel],
    dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_RESUME_PERMISSIONS)],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='续采中断的题库任务', business_type=BusinessType.OTHER)
async def resume_question_sync_task(
    request: Request,
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    operator = current_user.user.user_name if current_user and current_user.user else None
    return ResponseUtil.success(data=await SyncTaskService.resume_question(db, task_id, operator))


@bank_controller.post(
    '/sync/question/tasks/{task_id}/retry',
    response_model=DataResponseModel[SyncTaskModel],
    dependencies=[UserInterfaceAuthDependency(_QUESTION_TASK_RETRY_PERMISSIONS)],
)
@ApiRateLimit(namespace=ApiNamespace.BANK_SYNC_RUN, preset=ApiRateLimitPreset.USER_RESOURCE_SYNC)
@Log(title='重试同步题库任务', business_type=BusinessType.OTHER)
async def retry_question_sync_task(
    request: Request,
    task_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    operator = current_user.user.user_name if current_user and current_user.user else None
    return ResponseUtil.success(data=await SyncTaskService.retry_question(db, task_id, operator))


@bank_controller.get(
    '/sync/metadata/snapshot',
    response_model=SyncMetadataSnapshotModel,
    dependencies=[
        UserInterfaceAuthDependency(['bank:sync:center:list', 'bank:sync:textbook:list', 'bank:sync:version:list'])
    ],
)
async def metadata_sync_snapshot(
    db: Annotated[AsyncSession, DBSessionDependency()],
    metadata_run_id: Annotated[int | None, Query(alias='metadataRunId', gt=0)] = None,
) -> Response:
    return ResponseUtil.success(dict_content=await SyncService.metadata_snapshot(db, metadata_run_id))


@bank_controller.get(
    '/sync/metadata/textbook-overview',
    response_model=SyncTextbookOverviewModel,
    dependencies=[UserInterfaceAuthDependency(['bank:sync:center:list', 'bank:sync:textbook:list'])],
)
async def metadata_textbook_overview(
    db: Annotated[AsyncSession, DBSessionDependency()],
    metadata_run_id: Annotated[int | None, Query(alias='metadataRunId', gt=0)] = None,
) -> Response:
    return ResponseUtil.success(dict_content=await SyncService.metadata_textbook_overview(db, metadata_run_id))


@bank_controller.get(
    '/version/list',
    response_model=PageResponseModel[TextbookVersionModel],
    dependencies=[UserInterfaceAuthDependency(['bank:version:list', 'bank:browse:list'])],
)
async def list_versions(
    query: Annotated[TextbookVersionQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(model_content=await BankService.list_versions(db, query))


@bank_controller.get(
    '/version/{version_id}',
    response_model=DataResponseModel[TextbookVersionModel],
    dependencies=[UserInterfaceAuthDependency('bank:version:query')],
)
async def version_detail(
    version_id: Annotated[int, Path(gt=0)], db: Annotated[AsyncSession, DBSessionDependency()]
) -> Response:
    return ResponseUtil.success(data=await BankService.version_detail(db, version_id))


@bank_controller.post(
    '/version',
    response_model=DataResponseModel[TextbookVersionModel],
    dependencies=[UserInterfaceAuthDependency('bank:version:add')],
)
@Log(title='题库版本管理', business_type=BusinessType.INSERT)
async def add_version(
    request: Request,
    payload: TextbookVersionModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.add_version(db, payload))


@bank_controller.put(
    '/version',
    response_model=DataResponseModel[TextbookVersionModel],
    dependencies=[UserInterfaceAuthDependency('bank:version:edit')],
)
@Log(title='题库版本管理', business_type=BusinessType.UPDATE)
async def edit_version(
    request: Request,
    payload: TextbookVersionModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.update_version(db, payload))


@bank_controller.delete(
    '/version/{version_ids}',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('bank:version:remove')],
)
@Log(title='题库版本管理', business_type=BusinessType.DELETE)
async def delete_versions(
    request: Request,
    version_ids: Annotated[str, Path(min_length=1)],
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    await BankService.delete_versions(db, _parse_ids(version_ids))
    return ResponseUtil.success(msg='删除成功')


@bank_controller.get(
    '/textbook/list',
    response_model=PageResponseModel[TextbookCoverageModel],
    dependencies=[UserInterfaceAuthDependency(['bank:textbook:list', 'bank:browse:list'])],
)
async def list_textbooks(
    query: Annotated[TextbookQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(model_content=await BankService.list_textbooks(db, query))


@bank_controller.get(
    '/textbook/{textbook_id}',
    response_model=DataResponseModel[TextbookCoverageModel],
    dependencies=[UserInterfaceAuthDependency(['bank:textbook:query', 'bank:browse:list'])],
)
async def textbook_detail(
    textbook_id: Annotated[int, Path(gt=0)], db: Annotated[AsyncSession, DBSessionDependency()]
) -> Response:
    return ResponseUtil.success(data=await BankService.textbook_detail(db, textbook_id))


@bank_controller.post(
    '/textbook',
    response_model=DataResponseModel[TextbookModel],
    dependencies=[UserInterfaceAuthDependency('bank:textbook:add')],
)
@Log(title='题库教材管理', business_type=BusinessType.INSERT)
async def add_textbook(
    request: Request,
    payload: TextbookModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.add_textbook(db, payload))


@bank_controller.put(
    '/textbook',
    response_model=DataResponseModel[TextbookModel],
    dependencies=[UserInterfaceAuthDependency('bank:textbook:edit')],
)
@Log(title='题库教材管理', business_type=BusinessType.UPDATE)
async def edit_textbook(
    request: Request,
    payload: TextbookModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.update_textbook(db, payload))


@bank_controller.delete(
    '/textbook/{textbook_ids}',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('bank:textbook:remove')],
)
@Log(title='题库教材管理', business_type=BusinessType.DELETE)
async def delete_textbooks(
    request: Request,
    textbook_ids: Annotated[str, Path(min_length=1)],
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    await BankService.delete_textbooks(db, _parse_ids(textbook_ids))
    return ResponseUtil.success(msg='删除成功')


@bank_controller.get(
    '/catalog/tree',
    response_model=DataResponseModel[list[CatalogTreeModel]],
    dependencies=[UserInterfaceAuthDependency(['bank:catalog:list', 'bank:browse:list'])],
)
async def catalog_tree(
    query: Annotated[CatalogTreeQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.catalog_tree(db, query.textbook_id, query.include_disabled))


@bank_controller.get(
    '/catalog/list',
    response_model=PageResponseModel[CatalogNodeModel],
    dependencies=[UserInterfaceAuthDependency('bank:catalog:list')],
)
async def list_catalogs(
    query: Annotated[CatalogPageQueryModel, Query()], db: Annotated[AsyncSession, DBSessionDependency()]
) -> Response:
    return ResponseUtil.success(model_content=await BankService.list_catalogs(db, query))


@bank_controller.get(
    '/catalog/{catalog_id}',
    response_model=DataResponseModel[CatalogNodeModel],
    dependencies=[UserInterfaceAuthDependency('bank:catalog:query')],
)
async def catalog_detail(
    catalog_id: Annotated[int, Path(gt=0)], db: Annotated[AsyncSession, DBSessionDependency()]
) -> Response:
    return ResponseUtil.success(data=await BankService.catalog_detail(db, catalog_id))


@bank_controller.post(
    '/catalog',
    response_model=DataResponseModel[CatalogNodeModel],
    dependencies=[UserInterfaceAuthDependency('bank:catalog:add')],
)
@Log(title='题库目录管理', business_type=BusinessType.INSERT)
async def add_catalog(
    request: Request,
    payload: CatalogNodeModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.add_catalog(db, payload))


@bank_controller.put(
    '/catalog',
    response_model=DataResponseModel[CatalogNodeModel],
    dependencies=[UserInterfaceAuthDependency('bank:catalog:edit')],
)
@Log(title='题库目录管理', business_type=BusinessType.UPDATE)
async def edit_catalog(
    request: Request,
    payload: CatalogNodeModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.update_catalog(db, payload))


@bank_controller.delete(
    '/catalog/{catalog_ids}',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('bank:catalog:remove')],
)
@Log(title='题库目录管理', business_type=BusinessType.DELETE)
async def delete_catalogs(
    request: Request,
    catalog_ids: Annotated[str, Path(min_length=1)],
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    await BankService.delete_catalogs(db, _parse_ids(catalog_ids))
    return ResponseUtil.success(msg='删除成功')


@bank_controller.get(
    '/question/list',
    response_model=PageResponseModel[QuestionModel],
    dependencies=[UserInterfaceAuthDependency(['bank:question:list', 'bank:browse:list'])],
)
async def list_questions(
    query: Annotated[QuestionPageQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(model_content=await BankService.list_questions(db, query))


@bank_controller.post(
    '/question',
    response_model=DataResponseModel[QuestionDetailModel],
    dependencies=[UserInterfaceAuthDependency('bank:question:add')],
)
@Log(title='题目管理', business_type=BusinessType.INSERT)
async def add_question(
    request: Request,
    payload: QuestionWriteModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.add_question(db, payload))


@bank_controller.put(
    '/question',
    response_model=DataResponseModel[QuestionDetailModel],
    dependencies=[UserInterfaceAuthDependency('bank:question:edit')],
)
@Log(title='题目管理', business_type=BusinessType.UPDATE)
async def edit_question(
    request: Request,
    payload: QuestionWriteModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.update_question(db, payload))


@bank_controller.put(
    '/question/{question_id}/status/{status}',
    response_model=DataResponseModel[QuestionDetailModel],
    dependencies=[UserInterfaceAuthDependency('bank:question:edit')],
)
@Log(title='题目管理', business_type=BusinessType.UPDATE)
async def update_question_status(
    request: Request,
    question_id: Annotated[int, Path(gt=0)],
    status: Annotated[str, Path(pattern='^[01]$')],
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(
        data=await BankService.update_question(db, QuestionWriteModel(questionId=question_id, status=status))
    )


@bank_controller.delete(
    '/question/{question_ids}',
    response_model=ResponseBaseModel,
    dependencies=[UserInterfaceAuthDependency('bank:question:remove')],
)
@Log(title='题目管理', business_type=BusinessType.DELETE)
async def delete_questions(
    request: Request,
    question_ids: Annotated[str, Path(min_length=1)],
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    await BankService.delete_questions(db, _parse_ids(question_ids))
    return ResponseUtil.success(msg='删除成功')


@bank_controller.get(
    '/question/{question_id}/asset/list',
    response_model=DataResponseModel[list[QuestionAssetModel]],
    dependencies=[UserInterfaceAuthDependency(['bank:question:asset', 'bank:browse:list'])],
)
async def list_question_assets(
    question_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.list_assets(db, question_id=question_id))


@bank_controller.get(
    '/question/{question_id}',
    response_model=DataResponseModel[QuestionDetailModel],
    dependencies=[UserInterfaceAuthDependency(['bank:question:query', 'bank:browse:list'])],
)
async def question_detail(
    question_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.question_detail(db, question_id))


@bank_controller.get(
    '/asset/list',
    response_model=DataResponseModel[list[QuestionAssetModel]],
    dependencies=[UserInterfaceAuthDependency('bank:asset:list')],
)
async def list_assets(
    db: Annotated[AsyncSession, DBSessionDependency()],
    question_id: Annotated[int | None, Query(gt=0)] = None,
    asset_type: Annotated[str | None, Query(alias='assetType')] = None,
) -> Response:
    return ResponseUtil.success(data=await BankService.list_assets(db, question_id, asset_type))


@bank_controller.get(
    '/question/{question_id}/asset/{asset_key}',
    dependencies=[UserInterfaceAuthDependency(['bank:asset:query', 'bank:browse:list'])],
)
async def question_asset_file(
    question_id: Annotated[int, Path(gt=0)],
    asset_key: Annotated[str, Path(min_length=1, max_length=100)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> FileResponse:
    asset = await BankService.get_asset_by_key(db, question_id, asset_key)
    if asset is None:
        raise ServiceException(message='素材不存在')
    path = BankService.resolve_asset_path(asset.storage_path)
    return FileResponse(path, media_type=asset.mime_type or 'application/octet-stream', filename=path.name)


@bank_controller.get(
    '/sync/{entity_type}/compare',
    response_model=SyncCompareResponseModel,
    dependencies=[Depends(_SyncListPermission())],
)
async def compare_sync_candidates(
    entity_type: Annotated[SyncEntityType, Path()],
    query: Annotated[SyncCompareQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    """Compare collector candidates with current formal rows.

    The path is a closed Literal rather than a table name, and candidates are
    fetched through the configured collector HTTP service.
    """

    return ResponseUtil.success(dict_content=await SyncService.compare(db, entity_type, query))


@bank_controller.post(
    '/sync/{entity_type}/review',
    response_model=DataResponseModel[SyncReviewResultModel],
    dependencies=[UserInterfaceAuthDependency('bank:sync:review')],
)
@Log(title='题库同步候选审核', business_type=BusinessType.UPDATE)
async def review_sync_candidates(
    request: Request,
    entity_type: Annotated[SyncEntityType, Path()],
    payload: SyncReviewRequestModel,
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    reviewer = current_user.user.user_name if current_user.user else None
    return ResponseUtil.success(
        data=await SyncService.review(db, entity_type, payload, reviewer),
    )


@bank_controller.get(
    '/batch/list',
    response_model=PageResponseModel[BatchModel],
    dependencies=[UserInterfaceAuthDependency('bank:batch:list')],
)
async def list_batches(
    query: Annotated[BatchPageQueryModel, Query()],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(model_content=await BankService.list_batches(db, query))


@bank_controller.get(
    '/batch/{batch_id}',
    response_model=DataResponseModel[BatchModel],
    dependencies=[UserInterfaceAuthDependency('bank:batch:query')],
)
async def batch_detail(
    batch_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.batch_detail(db, batch_id))


@bank_controller.post(
    '/batch/{batch_id}/approve',
    response_model=DataResponseModel[BatchModel],
    dependencies=[UserInterfaceAuthDependency('bank:batch:approve')],
)
@Log(title='题库批次审批', business_type=BusinessType.UPDATE)
async def approve_batch(
    batch_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
    current_user: Annotated[CurrentUserModel, CurrentUserDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.approve_batch(db, batch_id, current_user.user.user_name))


@bank_controller.post(
    '/batch/{batch_id}/publish',
    response_model=DataResponseModel[BatchModel],
    dependencies=[UserInterfaceAuthDependency('bank:batch:publish')],
)
@Log(title='题库批次发布请求', business_type=BusinessType.UPDATE)
async def publish_batch(
    batch_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    # The endpoint only records a worker request.  It never performs DDL,
    # starts a process, or waits for the publisher in the HTTP worker.
    return ResponseUtil.success(data=await BankService.publish_batch(db, batch_id))


@bank_controller.post(
    '/batch/{batch_id}/rollback',
    response_model=DataResponseModel[BatchModel],
    dependencies=[UserInterfaceAuthDependency('bank:batch:rollback')],
)
@Log(title='题库批次回退请求', business_type=BusinessType.UPDATE)
async def rollback_batch(
    batch_id: Annotated[int, Path(gt=0)],
    db: Annotated[AsyncSession, DBSessionDependency()],
) -> Response:
    return ResponseUtil.success(data=await BankService.rollback_batch(db, batch_id))
