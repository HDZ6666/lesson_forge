"""Local-only review UI: live production reads, isolated local selection writes.

Run from service/ with REVIEW_CONNECTION_FILE and REVIEW_SSH_SOCKET configured.
No production HTTP write endpoints or database migrations are exposed.
"""
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Annotated

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import Depends, FastAPI, Query
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import URL, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from exceptions.exception import ServiceException
from plugins.bank.dao.sync_task_dao import SyncTaskDao
from plugins.bank.entity.do.bank_do import QbSyncJob, QbQuestionTaskReview
from plugins.bank.entity.vo.bank_vo import TaskComparisonQueryModel, QuestionTaskSelectionModel
from plugins.bank.service import question_review_service as review_module
from plugins.bank.service.task_service import task_payload

connection = Path(os.environ['REVIEW_CONNECTION_FILE']).read_text().splitlines()
config = json.loads(connection[0])['primary']
engine = create_async_engine(URL.create('mysql+asyncmy', username=config['db_username'], password=config['db_password'],
    host='127.0.0.1', port=13317, database=config['db_database']), echo=False)
online = async_sessionmaker(engine, expire_on_commit=False)
local_engine = create_async_engine('sqlite+aiosqlite:////private/tmp/lesson-question-review-preview.sqlite3')
local = async_sessionmaker(local_engine, expire_on_commit=False)
locks = {}


class ReadOnlyCollector:
    def call(self, module, export, run_id, options=None, external_id=None):
        source = (Path(__file__).resolve().parents[2] / 'collector/src/storage/readers' / f'{module}.cjs').read_text()
        args = ['/data/zujuan.sqlite3', run_id]
        if external_id is not None:
            args.append(external_id)
        args.append(options or {})
        program = 'const Module = require("module"); const m = new Module("/app/src/storage/readers/' + module + '.cjs");'
        program += 'm.filename=m.id; m.paths=Module._nodeModulePaths("/app/src/storage/readers");'
        program += f'm._compile({json.dumps(source)},m.filename); process.stdout.write(JSON.stringify(m.exports[{json.dumps(export)}](...{json.dumps(args)})));'
        result = subprocess.run(['ssh', '-S', os.environ['REVIEW_SSH_SOCKET'], 'ubuntu@124.221.251.234',
            'sudo docker exec -i lesson-forge-collector node -'], input=program, text=True, capture_output=True, timeout=60)
        if result.returncode:
            raise ServiceException(message='线上采集数据读取失败：' + result.stderr[-500:])
        return json.loads(result.stdout)

    def run_catalogs_preview(self, run_id, **options):
        return self.call('catalogs', 'readRunCatalogs', run_id, options)

    def run_questions_preview(self, run_id, **options):
        return self.call('questions', 'readRunQuestions', run_id, options)

    def run_question_detail(self, run_id, external_id, *, textbook_external_id=None):
        return self.call('questions', 'readRunQuestion', run_id, {'textbookExternalId': textbook_external_id}, external_id)


async def local_review(db, task_id, scopes):
    async with locks.setdefault(task_id, asyncio.Lock()):
        async with local() as state:
            value = await state.get(QbQuestionTaskReview, task_id)
            if value is None:
                class CaptureSession:
                    execute = db.execute
                    add = state.add
                    flush = state.flush
                value = await review_module.capture_review(CaptureSession(), task_id, scopes, origin='first_review')
                await state.commit()
            return value


review_module.CollectorClient = ReadOnlyCollector
review_module.get_review = local_review
app = FastAPI()


@app.on_event('startup')
async def init():
    async with local_engine.begin() as conn:
        await conn.run_sync(lambda sync: QbQuestionTaskReview.__table__.create(sync, checkfirst=True))


async def db_session():
    async with online() as db:
        await db.execute(text('SET TRANSACTION READ ONLY'))
        try:
            yield db
        finally:
            await db.rollback()


@app.exception_handler(ServiceException)
async def service_error(_request, exc):
    return JSONResponse({'code': 500, 'msg': str(getattr(exc, 'message', None) or exc)}, status_code=200)


def ok(value):
    return {'code': 200, 'data': jsonable_encoder(value)}


@app.get('/preview/tasks')
async def tasks(db=Depends(db_session)):
    rows = (await db.execute(select(QbSyncJob).where(QbSyncJob.task_module == 'question',
        (QbSyncJob.run_id == 17) | (QbSyncJob.status == 'completed')).order_by(QbSyncJob.run_id.desc()).limit(10))).scalars().all()
    return ok([{'taskId': row.run_id, 'status': row.status} for row in rows])


@app.get('/bank/sync/question/tasks/{task_id}')
async def task(task_id: int, db=Depends(db_session)):
    row = await SyncTaskDao.get(db, task_id, 'question')
    if row is None:
        raise ServiceException(message='任务不存在')
    value = task_payload(row, await SyncTaskDao.scopes(db, task_id))
    value['eligible'] = False
    return ok(value)


@app.get('/bank/sync/question/tasks/{task_id}/review/catalogs')
async def catalogs(task_id: int, query: Annotated[TaskComparisonQueryModel, Query()], db=Depends(db_session)):
    return ok(await review_module.QuestionReviewService.catalogs(db, task_id, query))


@app.get('/bank/sync/question/tasks/{task_id}/review/questions')
async def questions(task_id: int, query: Annotated[TaskComparisonQueryModel, Query()], db=Depends(db_session)):
    return ok(await review_module.QuestionReviewService.questions(db, task_id, query))


@app.get('/bank/sync/question/tasks/{task_id}/review/questions/{external_id}')
async def detail(task_id: int, external_id: str, query: Annotated[TaskComparisonQueryModel, Query()], db=Depends(db_session)):
    return ok(await review_module.QuestionReviewService.detail(db, task_id, external_id, query))


@app.post('/bank/sync/question/tasks/{task_id}/review/selection')
async def selection(task_id: int, request: QuestionTaskSelectionModel, query: Annotated[TaskComparisonQueryModel, Query()], db=Depends(db_session)):
    _, scope, _ = await review_module.QuestionReviewService.context(db, task_id, query)
    from plugins.bank.service.task_service import SAFE_EXTERNAL_ID
    ids = set(request.external_question_ids)
    if any(not SAFE_EXTERNAL_ID.fullmatch(value) for value in ids):
        raise ServiceException(message='题目 ID 无效')
    payload = await asyncio.to_thread(ReadOnlyCollector().run_questions_preview, scope.collector_run_id,
        textbookExternalId=str(scope.external_textbook_id), excludedIds=sorted(ids), selection='excluded', page=1, pageSize=1)
    if payload['total'] != len(ids):
        raise ServiceException(message='所选题目不属于本教材')
    async with locks.setdefault(task_id, asyncio.Lock()):
        async with local() as state:
            value = await state.get(QbQuestionTaskReview, task_id)
            old = set(value.excluded_json)
            value.excluded_json = sorted(old | ids if request.excluded else old - ids)
            value.revision += 1
            await state.commit()
            return ok({'revision': value.revision})


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=9099)
