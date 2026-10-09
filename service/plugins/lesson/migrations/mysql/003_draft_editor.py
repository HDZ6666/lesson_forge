"""Independent v2 editor migration; historical snapshots remain unchanged."""

from sqlalchemy import text

from plugins.lesson.entity.do.lesson_do import LpEditorOperation


async def run(query_db):
    for table, additions in (
        (
            'lp_generation',
            {
                'editor_schema_version': 'INT NOT NULL DEFAULT 1',
                'revision': 'INT NOT NULL DEFAULT 1',
                'editor_json': 'JSON NULL',
                'source_generation_id': 'BIGINT NULL',
            },
        ),
        ('lp_generation_item', {'group_key': 'VARCHAR(64) NULL', 'rule_key': 'VARCHAR(64) NULL'}),
    ):
        columns = {row[0] for row in (await query_db.execute(text(f'SHOW COLUMNS FROM {table}'))).all()}
        for name, definition in additions.items():
            if name not in columns:
                await query_db.execute(text(f'ALTER TABLE {table} ADD COLUMN {name} {definition}'))
    await query_db.execute(
        text('ALTER TABLE lp_generation_item MODIFY rule_id BIGINT NULL, MODIFY phase VARCHAR(20) NULL')
    )
    connection = await query_db.connection()
    await connection.run_sync(lambda conn: LpEditorOperation.__table__.create(conn, checkfirst=True))
