"""Serialize formal source writes with offline Publisher table swaps."""

from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession

from exceptions.exception import ServiceException
from plugins.bank.source_write_contract import SOURCE_WRITE_LOCK_NAME


class SourceWriteBusy(ServiceException):
    """Temporary contention; the durable runner should retry its checkpoint."""


@asynccontextmanager
async def source_write_lock(db: AsyncSession, *, timeout: int = 0):
    """Hold a dedicated connection until the caller commits or rolls back.

An ORM commit can return its connection to the pool. The separate connection
keeps GET_LOCK ownership through that commit and through Publisher's DDL.
Call only after remote reads and asset preparation, before taking row locks.
SQLite tests have no Publisher/DDL and retain their transaction protection.
"""
    bind = db.bind
    engine = bind.engine if isinstance(bind, AsyncConnection) else bind
    if not isinstance(engine, AsyncEngine):
        raise ServiceException(message='题库写入锁缺少数据库连接')
    if engine.dialect.name == 'sqlite':
        yield
        return
    if engine.dialect.name != 'mysql':
        raise ServiceException(message='当前数据库不支持题库写入锁')
    if db.in_transaction():
        raise ServiceException(message='题库写入锁必须在远程准备结束后、数据库事务开始前获取')
    if type(timeout) is not int or not 0 <= timeout <= 30:
        raise ValueError('source write lock timeout must be 0..30')
    async with engine.connect() as connection:
        try:
            acquired = await connection.scalar(
                text('SELECT GET_LOCK(:name, :timeout)'),
                {'name': SOURCE_WRITE_LOCK_NAME, 'timeout': timeout},
            )
            if acquired != 1:
                raise SourceWriteBusy(message='题库正在入库或发布，请稍后重试')
            yield
        finally:
            # Also release after cancellation or an uncertain GET_LOCK result.
            # If release fails, discard the physical connection rather than
            # returning a connection with an advisory lock to the pool.
            try:
                if db.in_transaction():
                    await db.rollback()
                await connection.scalar(
                    text('SELECT RELEASE_LOCK(:name)'), {'name': SOURCE_WRITE_LOCK_NAME},
                )
            except BaseException:
                await connection.invalidate()
                raise
