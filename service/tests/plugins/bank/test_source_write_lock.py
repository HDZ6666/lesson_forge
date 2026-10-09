"""Real MySQL connections prove Publisher and ORM writers share ownership."""

import asyncio
import json
import os

import pytest
from sqlalchemy import select, text

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbQuestion
from plugins.bank.publisher.worker import MySQLPublisher, PackageError, PublisherConfig
from plugins.bank.service.incremental_merge import merge_prepared_incremental_batch
from plugins.bank.service.source_write_lock import source_write_lock
from plugins.bank.source_write_contract import SOURCE_WRITE_LOCK_NAME
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_incremental_merge import snapshot


def test_publisher_cannot_opt_out_of_shared_write_lock():
    with pytest.raises(PackageError, match='统一题库写入锁'):
        PublisherConfig(lock_name='different-lock')


async def _publisher(db):
    if db.bind.dialect.name != 'mysql':
        pytest.skip('requires isolated MySQL source-write check')
    import pymysql

    source = json.loads(os.environ['DB_SOURCES'])['primary']
    assert source['db_host'] == '127.0.0.1' and int(source['db_port']) == 13316
    assert source['db_database'] == 'lesson_refactor'
    connection = await asyncio.to_thread(
        pymysql.connect,
        host='127.0.0.1', port=13316,
        user=source['db_username'], password=source['db_password'],
        database='lesson_refactor_merge',
    )
    return MySQLPublisher(connection, PublisherConfig(lock_timeout=0))


@pytest.mark.asyncio
async def test_publisher_blocks_incremental_write_then_release_allows_merge(bank_db):
    publisher = await _publisher(bank_db)
    try:
        await asyncio.to_thread(publisher.acquire_lock)
        with pytest.raises(ServiceException, match='题库正在入库或发布'):
            await merge_prepared_incremental_batch(bank_db, [snapshot('q3')], local_textbook_id=1, task_id=28)
        assert not bank_db.in_transaction()
        assert await bank_db.scalar(select(QbQuestion).where(QbQuestion.external_question_id == 'q3')) is None
        await bank_db.rollback()
        await asyncio.to_thread(publisher.release_lock)
        result = await merge_prepared_incremental_batch(bank_db, [snapshot('q3')], local_textbook_id=1, task_id=28)
        assert result['stats']['questions']['inserted'] == 1
    finally:
        await asyncio.to_thread(publisher.release_lock)
        await asyncio.to_thread(publisher.connection.close)


@pytest.mark.asyncio
async def test_orm_commit_keeps_lock_and_error_releases_it(bank_db):
    publisher = await _publisher(bank_db)
    try:
        with pytest.raises(RuntimeError, match='simulated writer error'):
            async with source_write_lock(bank_db):
                await bank_db.commit()
                with pytest.raises(PackageError, match='无法取得题库发布锁'):
                    await asyncio.to_thread(publisher.acquire_lock)
                raise RuntimeError('simulated writer error')
        await asyncio.to_thread(publisher.acquire_lock)
        assert publisher.config.lock_name == SOURCE_WRITE_LOCK_NAME
    finally:
        await asyncio.to_thread(publisher.release_lock)
        await asyncio.to_thread(publisher.connection.close)


@pytest.mark.asyncio
async def test_cancelled_writer_rolls_back_before_returning_lock_connection(bank_db):
    publisher = await _publisher(bank_db)
    await asyncio.to_thread(publisher.connection.close)
    entered = asyncio.Event()

    async def writer():
        async with source_write_lock(bank_db):
            row = await bank_db.get(QbQuestion, 1)
            row.plain_text = 'must roll back'
            await bank_db.flush()
            entered.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(writer())
    await asyncio.wait_for(entered.wait(), timeout=5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not bank_db.in_transaction()
    assert (await bank_db.get(QbQuestion, 1)).plain_text != 'must roll back'
    await bank_db.rollback()
    async with bank_db.bind.connect() as connection:
        assert await connection.scalar(text('SELECT IS_FREE_LOCK(:name)'), {'name': SOURCE_WRITE_LOCK_NAME}) == 1
