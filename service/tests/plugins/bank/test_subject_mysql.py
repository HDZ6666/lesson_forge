"""Opt-in MySQL migration check, restricted to the isolated refactor instance.

Run via scripts/refactor_env.py with LESSON_REFACTOR_MYSQL_CHECK=1.
The scratch schema must be granted in the local refactor Docker instance.
"""

import importlib.util
import json
import os
from pathlib import Path

import pytest
from sqlalchemy import URL, text
from sqlalchemy.ext.asyncio import create_async_engine

pytestmark = pytest.mark.skipif(
    os.getenv('LESSON_REFACTOR_MYSQL_CHECK') != '1', reason='requires isolated refactor MySQL'
)
TABLES = ('qb_textbook_version', 'qb_textbook', 'qb_catalog_node', 'qb_question', 'qb_sync_job', 'qb_sync_job_scope')
SCRATCH = 'lesson_refactor_migration'


@pytest.mark.asyncio
async def test_migration_backfills_legacy_ids_and_is_restartable():
    config = json.loads(os.environ['DB_SOURCES'])['primary']
    assert (config['db_host'], config['db_port'], config['db_database']) == ('127.0.0.1', 13316, 'lesson_refactor')
    source = create_async_engine(
        URL.create(
            'mysql+asyncmy',
            username=config['db_username'],
            password=config['db_password'],
            host=config['db_host'],
            port=config['db_port'],
            database=config['db_database'],
        )
    )
    target = create_async_engine(source.url.set(database=SCRATCH))
    try:
        async with source.connect() as conn:
            definitions = [(await conn.execute(text(f'SHOW CREATE TABLE `{table}`'))).one()[1] for table in TABLES]
        async with target.begin() as conn:
            for table in ('qb_subject', *TABLES):
                await conn.execute(text(f'DROP TABLE IF EXISTS `{table}`'))
            for table, ddl in zip(TABLES, definitions, strict=True):
                await conn.execute(text(ddl))
                indexes = (await conn.execute(text(f'SHOW INDEX FROM `{table}`'))).all()
                for index in {row[2] for row in indexes if row[2].endswith('_subject')}:
                    await conn.execute(text(f'ALTER TABLE `{table}` DROP INDEX `{index}`'))
                columns = (await conn.execute(text(f'SHOW COLUMNS FROM `{table}`'))).all()
                if 'subject_id' in {row[0] for row in columns}:
                    await conn.execute(text(f'ALTER TABLE `{table}` DROP COLUMN subject_id'))
            await conn.execute(
                text("""INSERT INTO qb_question
                (question_id,source_provider,external_question_id,plain_text,answer_html,answer_status,status,create_time,update_time)
                VALUES (17,'zujuan','same-id','旧题干','已有答案','available','1',NOW(),NOW())""")
            )
            path = Path(__file__).parents[3] / 'plugins/bank/migrations/mysql/013_subject_scope.py'
            spec = importlib.util.spec_from_file_location('refactor_subject_migration', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            await module.run(conn)
            await module.run(conn)  # MySQL DDL auto-commits: retry must be safe.
            row = (
                await conn.execute(text('SELECT subject_id,question_id,plain_text,answer_html,status FROM qb_question'))
            ).one()
            assert tuple(row) == (1, 17, '旧题干', '已有答案', '1')
            await conn.execute(
                text("""INSERT INTO qb_question
                (subject_id,source_provider,external_question_id,plain_text,create_time,update_time)
                VALUES (2,'zujuan','same-id','其他学科',NOW(),NOW())""")
            )
            assert (await conn.execute(text('SELECT COUNT(*) FROM qb_question'))).scalar_one() == 2
            index = (
                await conn.execute(
                    text("SHOW INDEX FROM qb_question WHERE Key_name='uk_qb_question_provider_external'")
                )
            ).all()
            assert [row[4] for row in sorted(index, key=lambda row: row[3])] == [
                'source_provider',
                'subject_id',
                'external_question_id',
            ]
            for table in TABLES:
                assert (
                    await conn.execute(text(f'SELECT COUNT(*) FROM `{table}` WHERE subject_id IS NULL'))
                ).scalar_one() == 0
    finally:
        await source.dispose()
        await target.dispose()
