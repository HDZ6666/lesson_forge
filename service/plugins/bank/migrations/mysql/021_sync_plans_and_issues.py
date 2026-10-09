"""Persistent plans, book overrides, emergency pause and cross-task issues."""

from sqlalchemy import text

from plugins.bank.entity.do.bank_do import QbSyncBookState, QbSyncControl, QbSyncIssue, QbSyncIssueTask, QbSyncPlan


async def run(query_db):
    connection = await query_db.connection()
    for model in (QbSyncControl, QbSyncPlan, QbSyncBookState, QbSyncIssue, QbSyncIssueTask):
        await connection.run_sync(lambda conn, table=model.__table__: table.create(conn, checkfirst=True))
    await query_db.execute(
        text(
            'INSERT IGNORE INTO qb_sync_control (control_id,paused,revision,issue_cursor,update_time) '
            'VALUES (1,0,1,0,UTC_TIMESTAMP())',
        )
    )
