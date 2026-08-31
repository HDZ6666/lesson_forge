"""SQLite connection helpers for the local collector evidence store."""

from __future__ import annotations

import sqlite3
from pathlib import Path


def connect_collector_sqlite(path: Path) -> sqlite3.Connection:
    """Open a query-only connection while retaining normal WAL handling."""

    resolved = Path(path).expanduser().resolve()
    if not resolved.is_file():
        raise sqlite3.OperationalError(f'collector SQLite 不存在：{resolved}')

    connection = sqlite3.connect(resolved, timeout=2)
    try:
        connection.execute('PRAGMA query_only = ON')
    except sqlite3.Error:
        connection.close()
        raise
    return connection
