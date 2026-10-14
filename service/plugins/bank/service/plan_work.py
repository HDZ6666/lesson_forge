"""Task-level gates shared by dispatch, intake, import and discovery merge."""
from sqlalchemy import func

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbSyncJob


class PlanWorkPaused(ServiceException):
    pass


def allowed_condition(model=QbSyncJob):
    return (func.coalesce(model.options_json['planWorkPaused'].as_boolean(),False).is_(False)
            & func.coalesce(model.options_json['planWorkEnded'].as_boolean(),False).is_(False))


def results_allowed_condition(model=QbSyncJob):
    """Saved results keep moving after "end this sync" (spec 4.1); only a pause stops them."""
    return func.coalesce(model.options_json['planWorkPaused'].as_boolean(),False).is_(False)


def assert_results_options(options):
    if (options or {}).get('planWorkPaused'):
        raise PlanWorkPaused(message='学科计划已暂停')


async def assert_results_task(db, task_id):
    row=await db.get(QbSyncJob,task_id,populate_existing=True)
    if row is not None:
        assert_results_options(row.options_json)


def assert_options(options):
    if (options or {}).get('planWorkPaused') or (options or {}).get('planWorkEnded'):
        raise PlanWorkPaused(message='本轮已结束' if options.get('planWorkEnded') else '学科计划已暂停')


async def assert_task(db, task_id):
    row=await db.get(QbSyncJob,task_id,populate_existing=True)
    if row is not None:
        assert_options(row.options_json)
