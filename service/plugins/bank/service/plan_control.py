"""Plan actions own all collection, verification and import descendants."""
from datetime import timedelta

from sqlalchemy import func, or_, select, update

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbQuestionImport,
    QbQuestionImportIntake,
    QbSyncBookState,
    QbSyncCycle,
    QbSyncJob,
    QbSyncJobScope,
    QbSyncPlan,
)
from plugins.bank.service.incremental_import import _clock
from plugins.bank.service.plan_work import allowed_condition

TERMINAL=('completed','failed','blocked','cancelled','interrupted')


def owned_condition(plan_id):
    return or_(QbSyncJob.options_json['autoPlanId'].as_integer()==plan_id,
               QbSyncJob.options_json['manualPlanId'].as_integer()==plan_id)


async def _lock_plan(db, plan_id, revision):
    plan=await db.get(QbSyncPlan,plan_id,with_for_update=True,populate_existing=True)
    if plan is None or plan.revision!=revision:
        raise ServiceException(message='计划已变化，请刷新后重试')
    return plan


async def action(db, plan_id, payload, operator):
    from plugins.bank.service.sync_plans import plan_dump
    from plugins.bank.service.sync_run_service import SyncRunService
    plan=await _lock_plan(db,plan_id,payload.expected_revision)
    now=await _clock(db)
    active=[]
    if payload.action in ('pause','end'):
        if plan.control_state in ('pausing','ending'):
            raise ServiceException(message='计划正在收尾，请等待停止完成')
        end=payload.action=='end'
        plan.enabled=0
        plan.control_state='ending' if end else 'pausing'
        if end:
            plan.auto_update=int(payload.keep_updates)
        rows=(await db.scalars(select(QbSyncJob).where(owned_condition(plan_id))
                              .order_by(QbSyncJob.run_id).with_for_update())).all()
        for row in rows:
            options=dict(row.options_json or {})
            if options.get('planWorkEnded'):
                continue
            options.update(planWorkPaused=not end,planWorkEnded=end)
            options.pop('allowWhilePlanPaused',None)
            options['autoResumePending']=False
            if row.task_module=='question' and row.status in ('starting','running','cancelling'):
                options['planResumePending']=not end
            if end:
                options['planResumePending']=False
            row.options_json=options
            if row.status=='queued' and row.active_slot is None and end:
                row.status=row.phase='cancelled'
                row.finished_at=row.update_time=now
                row.dispatch_book_key=None
                for scope in (await db.scalars(select(QbSyncJobScope).where(QbSyncJobScope.run_id==row.run_id).with_for_update())).all():
                    scope.status='cancelled';scope.finished_at=now
            if row.active_slot is not None:
                active.append(row.run_id)
        if plan.discovery_task_id:
            task=await db.get(QbSyncJob,plan.discovery_task_id)
            if task and task.status=='queued' and task.active_slot is None:
                task.status=task.phase='cancelled';task.dispatch_book_key=None;task.finished_at=now
    elif payload.action=='resume':
        if plan.control_state!='paused':
            raise ServiceException(message='请等待计划暂停完成后再继续')
        plan.enabled=1;plan.control_state='active'
        rows=(await db.scalars(select(QbSyncJob).where(owned_condition(plan_id)).with_for_update())).all()
        for row in rows:
            options=dict(row.options_json or {})
            if not options.get('planWorkEnded'):
                options['planWorkPaused']=False
                row.options_json=options
                if row.dispatch_error=='学科计划已暂停':
                    row.dispatch_error=None;row.dispatch_not_before=None
        if plan.discovery_task_id:
            task=await db.get(QbSyncJob,plan.discovery_task_id)
            if task and task.status=='cancelled':
                plan.discovery_processed_task_id=max(plan.discovery_processed_task_id or 0,task.run_id)
                plan.discovery_task_id=None;plan.discovery_next_at=None;plan.discovery_error=None
                plan.cycle_state='discovering'
    elif payload.action=='start':
        if plan.control_state in ('pausing','ending') or plan.cycle_state in ('running','discovering'):
            raise ServiceException(message='已有一轮正在执行，请先处理当前轮次')
        plan.enabled=1;plan.control_state='active';plan.cycle_state='discovering'
        plan.discovery_next_at=None;plan.discovery_error=None;plan.next_cycle_at=None
    else:
        raise ServiceException(message='不支持的计划操作')
    plan.revision+=1;plan.next_check_at=None;plan.update_time=now
    await db.commit()
    # Network cancellation happens only after durable gates are visible.
    for task_id in active:
        await SyncRunService.cancel(db,task_id)
    return plan_dump(plan)


async def reconcile_controls(session_factory):
    async with session_factory() as db:
        plans=list((await db.scalars(select(QbSyncPlan).where(QbSyncPlan.control_state.in_(('pausing','ending'))))).all())
        ids=[p.plan_id for p in plans]
    for plan_id in ids:
        async with session_factory() as db:
            plan=await db.get(QbSyncPlan,plan_id,with_for_update=True,populate_existing=True)
            if plan.control_state not in ('pausing','ending'):
                continue
            now=await _clock(db)
            task_ids=select(QbSyncJob.run_id).where(owned_condition(plan_id))
            ending=plan.control_state=='ending'
            # Queued or expired work has no live batch to finish.
            if not ending:
                await db.execute(update(QbQuestionImport).where(QbQuestionImport.task_id.in_(task_ids),
                    or_(QbQuestionImport.status=='queued',
                        QbQuestionImport.status.in_(('preparing','running')) & (QbQuestionImport.lease_until<=now)))
                    .values(status='paused',stage='paused',worker_token=None,lease_until=None,active_source_slot=None))
            if ending:
                await db.execute(update(QbQuestionImport).where(QbQuestionImport.task_id.in_(task_ids),
                    or_(QbQuestionImport.status.in_(('queued','paused')),
                        QbQuestionImport.status.in_(('preparing','running')) & (QbQuestionImport.lease_until<=now)))
                    .values(status='cancelled',stage='cancelled',worker_token=None,lease_until=None,active_source_slot=None))
                await db.execute(update(QbQuestionImportIntake).where(QbQuestionImportIntake.task_id.in_(task_ids),
                    or_(QbQuestionImportIntake.status.in_(('pending','retry')),
                        (QbQuestionImportIntake.status=='probing') & (QbQuestionImportIntake.lease_until<=now)))
                    .values(status='discarded',worker_token=None,lease_until=None))
            collecting=await db.scalar(select(QbSyncJob.run_id).where(owned_condition(plan_id),QbSyncJob.active_slot.is_not(None)).limit(1))
            importing=await db.scalar(select(QbQuestionImport.import_id).where(QbQuestionImport.task_id.in_(task_ids),
                QbQuestionImport.status.in_(('preparing','running')),QbQuestionImport.lease_until>now).limit(1))
            probing=await db.scalar(select(QbQuestionImportIntake.intake_id).where(QbQuestionImportIntake.task_id.in_(task_ids),
                QbQuestionImportIntake.status=='probing',QbQuestionImportIntake.lease_until>now).limit(1))
            if collecting or importing or probing:
                await db.commit();continue
            plan.control_state='active' if ending else 'paused'
            if ending:
                plan.enabled=1
                plan.cycle_state='stopped';plan.cycle_finished_at=now
                plan.next_cycle_at=now+timedelta(days=plan.refresh_days) if plan.auto_update else None
                cycle=await db.scalar(select(QbSyncCycle).where(QbSyncCycle.plan_id==plan_id,QbSyncCycle.cycle_no==plan.cycle_no))
                if cycle:cycle.status='stopped';cycle.finished_at=now
                if plan.discovery_task_id:
                    plan.discovery_processed_task_id=max(plan.discovery_processed_task_id or 0,plan.discovery_task_id)
                    plan.discovery_task_id=None
            await db.commit()
    await resume_stopped_collections(session_factory)


async def resume_stopped_collections(session_factory):
    async with session_factory() as db:
        ids=list((await db.scalars(select(QbSyncJob.run_id).where(
            QbSyncJob.options_json['planResumePending'].as_boolean().is_(True),allowed_condition(),
            QbSyncJob.status.in_(TERMINAL)))).all())
    for task_id in ids:
        async with session_factory() as db:
            row=await db.get(QbSyncJob,task_id,with_for_update=True,populate_existing=True)
            if not (row.options_json or {}).get('planResumePending'):
                continue
            scope=await db.scalar(select(QbSyncJobScope).where(QbSyncJobScope.run_id==task_id))
            busy=await db.scalar(select(QbQuestionImport.import_id).where(QbQuestionImport.task_id==task_id,
                QbQuestionImport.status.in_(('queued','preparing','running','paused'))).limit(1))
            intake=await db.scalar(select(QbQuestionImportIntake.intake_id).where(QbQuestionImportIntake.task_id==task_id,
                QbQuestionImportIntake.status.in_(('pending','probing','retry'))).limit(1))
            if busy or intake:
                continue
            from plugins.bank.service.task_service import SyncTaskService
            options=dict(row.options_json or {})
            options['planResumePending']=False
            options['resumeFirst']=True
            row.options_json=options;row.dispatch_book_key=None
            if scope and not scope.snapshot_complete:
                if scope.collector_run_id and scope.snapshot_locked_at:
                    extra={k:v for k,v in options.items() if k in (
                        'autoPlanId','autoPlanName','autoCycleNo','autoCycleName','manualPlanId','manualSingle',
                        'manualDispatchRequested','allowWhilePlanPaused','listConcurrency','concurrencySource','inheritedConcurrency')}
                    extra['resumeFirst']=True
                    if options.get('concurrencySource')!='task':
                        from plugins.bank.service import task_concurrency
                        extra.update(task_concurrency.snapshot(await task_concurrency.resolve(db,row.subject_id)))
                    result=await SyncTaskService.create_question(db,{'versionId':scope.local_version_id,'textbookId':scope.local_textbook_id,
                        'limitTo1000Pages':options.get('limitTo1000Pages',False),'allow_paused':bool(options.get('allowWhilePlanPaused'))},
                        operator='plan-resume',resume_task_id=task_id,automatic_options=extra)
                else:
                    from plugins.bank.entity.vo.bank_vo import TaskConcurrencyInput
                    result=await SyncTaskService.retry_question(db,task_id,'plan-resume',settings=TaskConcurrencyInput(
                        listConcurrency=options.get('listConcurrency') if options.get('concurrencySource')=='task' else None))
                plan_id=options.get('autoPlanId') or options.get('manualPlanId')
                if plan_id:
                    state=await db.scalar(select(QbSyncBookState).where(QbSyncBookState.plan_id==plan_id,QbSyncBookState.textbook_id==scope.local_textbook_id))
                    if state:
                        new_id=result.get('taskId') or result['runId']
                        if options.get('autoPlanId'):state.last_task_id=new_id
                        else:state.last_manual_task_id=new_id
            await db.commit()


async def set_order(db, plan_id, payload):
    from plugins.bank.service.sync_plans import list_books
    plan=await _lock_plan(db,plan_id,payload.expected_revision)
    books=await list_books(db,plan_id)
    valid={b['textbookId'] for b in books}
    ids=payload.textbook_ids
    if len(set(ids))!=len(ids) or set(ids)!=valid:
        raise ServiceException(message='教材清单已变化，请刷新后重新排序')
    plan.textbook_order=ids;plan.revision+=1
    ranks={id:i for i,id in enumerate(ids)}
    rows=(await db.execute(select(QbSyncJob,QbSyncJobScope.local_textbook_id)
        .join(QbSyncJobScope,QbSyncJobScope.run_id==QbSyncJob.run_id)
        .where(owned_condition(plan_id),QbSyncJob.status=='queued',QbSyncJob.active_slot.is_(None)).with_for_update())).all()
    for job,book_id in rows:job.dispatch_rank=ranks.get(book_id,len(ids))
    await db.commit()
    return {'revision':plan.revision,'textbookIds':ids}


async def sync_book_once(db, plan_id, textbook_id, payload, operator):
    from plugins.bank.entity.do.bank_do import QbTextbook
    from plugins.bank.service.sync_dispatch import book_key
    from plugins.bank.service.task_service import SyncTaskService
    plan=await _lock_plan(db,plan_id,payload.expected_revision)
    book=await db.get(QbTextbook,textbook_id)
    if book is None or book.subject_id!=plan.subject_id:
        raise ServiceException(message='教材不属于当前计划')
    paused=plan.control_state!='active' or not plan.enabled
    if plan.control_state in ('pausing','ending'):
        raise ServiceException(message='计划正在停止，请稍后再同步单本教材')
    if paused and not payload.allow_paused:
        raise ServiceException(message='计划已暂停，请确认仅执行这一次单本同步')
    existing=await db.scalar(select(QbSyncJob).where(QbSyncJob.dispatch_book_key==book_key(plan.subject_id,book.source_provider,book.external_textbook_id)).with_for_update())
    if existing:
        if existing.status=='queued' and existing.active_slot is None:
            from plugins.bank.service.task_concurrency import set_waiting
            await set_waiting(db,existing,payload.list_concurrency)
            existing.options_json={**(existing.options_json or {}),'manualDispatchRequested':True,
                                   'planWorkPaused':False,'allowWhilePlanPaused':bool(payload.allow_paused)}
            existing.dispatch_priority=(await db.scalar(select(func.max(QbSyncJob.dispatch_priority))) or 0)+1
            if existing.dispatch_error=='学科计划已暂停':
                existing.dispatch_not_before=None;existing.dispatch_error=None
            await db.commit()
        if payload.allow_paused and (existing.options_json or {}).get('planWorkPaused'):
            existing.options_json={**existing.options_json,'planWorkPaused':False,'allowWhilePlanPaused':True,'manualDispatchRequested':True}
            await db.commit()
        return {'taskId':existing.run_id,'existing':True}
    # Re-run the book under its current cycle task. A later scheduled cycle
    # creates its own root, while a manual execution between cycles stays here.
    from plugins.bank.entity.do.bank_do import QbSyncJobScope
    previous = await db.scalar(select(QbSyncJob).join(QbSyncJobScope, QbSyncJobScope.run_id == QbSyncJob.run_id).where(
        QbSyncJob.task_module == 'question', QbSyncJobScope.local_textbook_id == textbook_id,
        QbSyncJob.options_json['autoPlanId'].as_integer() == plan_id,
        QbSyncJob.options_json['autoCycleNo'].as_integer() == plan.cycle_no,
    ).order_by(QbSyncJob.run_id.desc()).limit(1))
    previous_id = previous.run_id if previous else None
    options = {'manualPlanId': plan_id, 'manualSingle': True, 'manualDispatchRequested': True,
               'allowWhilePlanPaused': bool(payload.allow_paused), 'autoPlanId': plan_id,
               'autoPlanName': plan.plan_name, 'autoCycleNo': plan.cycle_no, 'autoCycleName': plan.cycle_name}
    await db.commit()
    if previous_id:
        result = await SyncTaskService.retry_question(db, previous_id, operator, settings=payload, execution_options=options)
    else:
        result = await SyncTaskService.create_question(db, {'versionId': book.version_id, 'textbookId': textbook_id,
            'listConcurrency': payload.list_concurrency, 'allowPaused': payload.allow_paused}, operator,
            automatic_options=options)
    task_id=result.get('taskId') or result['runId']
    row=await db.get(QbSyncJob,task_id,with_for_update=True)
    row.dispatch_priority=(await db.scalar(select(func.max(QbSyncJob.dispatch_priority))) or 0)+1
    state=await db.scalar(select(QbSyncBookState).where(QbSyncBookState.plan_id==plan_id,QbSyncBookState.textbook_id==textbook_id))
    if state is None:
        state=QbSyncBookState(plan_id=plan_id,textbook_id=textbook_id,enabled=1,last_cycle_no=0,revision=1)
        db.add(state)
    state.last_manual_task_id=task_id
    state.last_task_id=task_id
    await db.commit()
    return {'taskId':task_id,'existing':False}
