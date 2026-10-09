"""Import timestamps use UTC even when the MySQL session uses a local zone."""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.encoders import jsonable_encoder
from sqlalchemy import text

from plugins.bank.service.import_dates import utc_datetime
from plugins.bank.service.incremental_import import _clock
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db


def test_import_dates_encode_an_explicit_zone_without_changing_the_instant():
    instant = datetime(2026, 10, 2, 9, 33, 14)
    assert utc_datetime(None) is None
    assert jsonable_encoder(utc_datetime(instant)) == '2026-10-02T09:33:14+00:00'
    local = instant.replace(hour=17, tzinfo=timezone(timedelta(hours=8)))
    assert utc_datetime(local) == instant.replace(tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_import_clock_uses_the_database_utc_clock(bank_db):
    now = await _clock(bank_db)
    assert isinstance(now, datetime) and now.tzinfo is None
    assert abs((utc_datetime(now) - datetime.now(timezone.utc)).total_seconds()) < 5


@pytest.mark.asyncio
async def test_mysql_session_timezone_cannot_shift_import_deadlines(bank_db):
    db = bank_db
    if db.bind.dialect.name != 'mysql':
        pytest.skip('requires the explicitly isolated MySQL check')
    previous = await db.scalar(text('SELECT @@session.time_zone'))
    try:
        await db.execute(text("SET SESSION time_zone = '+08:00'"))
        now = await _clock(db)
        clocks = (await db.execute(text('SELECT UTC_TIMESTAMP(), CURRENT_TIMESTAMP()'))).one()
        assert abs((now - clocks[0]).total_seconds()) <= 1
        assert abs((clocks[1] - now).total_seconds() - 8 * 3600) <= 1
    finally:
        # SET SESSION survives rollback, so restore it before returning the connection.
        await db.execute(text('SET SESSION time_zone = :zone'), {'zone': previous})
        await db.rollback()
