"""Preserve existing sync read grants when introducing the sync-center menu."""

from sqlalchemy import text


async def on_upgrade(context):
    db = context.query_db
    if db is None:
        return
    for old, new in (
        ('bank:sync:center:list', 'bank:sync:overview:list'),
        ('bank:sync:textbook:list', 'bank:sync:discovery:list'),
        ('bank:sync:question:list', 'bank:sync:tasks:list'),
        ('bank:sync:question:list', 'bank:sync:plans:list'),
    ):
        # Grant only the equivalent new read page to roles already holding
        # the old page. Do not grant new write/subject-management permissions.
        await db.execute(
            text("""
            INSERT IGNORE INTO sys_role_menu (role_id, menu_id)
            SELECT r.role_id, new.menu_id
            FROM sys_role_menu r
            JOIN sys_menu old ON old.menu_id = r.menu_id
            JOIN sys_menu new ON new.perms = :new_perm AND new.remark LIKE '%plugin:bank%'
            WHERE old.perms = :old_perm AND old.remark LIKE '%plugin:bank%'
        """),
            {'old_perm': old, 'new_perm': new},
        )
    await db.execute(
        text("""
        INSERT IGNORE INTO sys_role_menu (role_id, menu_id)
        SELECT DISTINCT r.role_id, parent.menu_id
        FROM sys_role_menu r JOIN sys_menu child ON child.menu_id = r.menu_id
        JOIN sys_menu parent ON parent.menu_id = child.parent_id
        WHERE parent.path = 'sync-center' AND parent.remark LIKE '%plugin:bank%'
    """)
    )
