"""New import/intake timestamps are stored using a UTC database clock."""

from datetime import datetime, timezone


def utc_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
