"""A shared source knowledge point is a separate directory membership per book."""
from sqlalchemy import text


async def run(db):
    rows = (await db.execute(text('SHOW INDEX FROM qb_catalog_node'))).all()
    name = 'uk_qb_catalog_provider_external'
    columns = [row[4] for row in sorted(rows, key=lambda row: row[3]) if row[2] == name]
    if columns == ['source_provider', 'subject_id', 'textbook_id', 'external_node_id']:
        return
    drop = f'DROP INDEX {name}, ' if columns else ''
    await db.execute(text(f'ALTER TABLE qb_catalog_node {drop}ADD UNIQUE KEY {name} '
                          '(source_provider, subject_id, textbook_id, external_node_id)'))
