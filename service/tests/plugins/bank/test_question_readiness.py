"""Usability, bounded backfill and invalidation through actual ORM transactions."""

import hashlib
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from plugins.bank.dao.bank_dao import BankDao
from plugins.bank.entity.do.bank_do import (
    QbCatalogNode,
    QbQuestion,
    QbQuestionAsset,
    QbQuestionCatalog,
    QbQuestionReadiness,
    QbQuestionReadinessSweep,
    QbSubject,
    QbTextbook,
)
from plugins.bank.entity.vo.bank_vo import QuestionPageQueryModel
from plugins.bank.service import question_readiness_worker as worker
from plugins.bank.service.bank_service import BankService
from plugins.bank.service.book_coverage import book_coverage
from plugins.bank.service.coverage_queries import catalog_coverage
from plugins.bank.service.incremental_merge import merge_prepared_incremental_batch, prepare_incremental_verdicts
from plugins.bank.service.question_readiness import (
    asset_payload,
    check_question,
    question_payload,
    store_proofs,
    usable_predicate,
)
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_incremental_merge import snapshot


def question(html='<p>计算 1+1</p>', **extra):
    return {
        'question_id': 1,
        'subject_id': 1,
        'source_provider': 'manual',
        'external_question_id': None,
        'readiness_revision': None,
        'content_hash': None,
        'content_html': html,
        'plain_text': '',
        **extra,
    }


def asset(tmp_path, key='image', data=b'image', **extra):
    path = tmp_path / f'{key}.png'
    path.write_bytes(data)
    return {
        'question_id': 1,
        'asset_key': key,
        'asset_type': 'image',
        'source_provider': 'manual',
        'storage_path': path.name,
        'file_hash': hashlib.sha256(data).hexdigest(),
        'download_status': 'downloaded',
        'mime_type': 'image/png',
        'width': None,
        'height': None,
        **extra,
    }


def test_stem_only_proof_image_table_and_failed_answer(tmp_path):
    stem = asset(tmp_path)
    answer = asset(tmp_path, 'answer', download_status='failed', storage_path=None)
    q = question('<table><tr><td>求值</td></tr></table><img data-asset-key="image">', answer_html='<img>')
    proof = check_question(q, [stem, answer], tmp_path)
    assert proof['status'] == 'ready' and proof['has_image'] and proof['has_table']
    answer['file_hash'] = 'f' * 64
    assert check_question(q, [stem, answer], tmp_path)['asset_signature'] == proof['asset_signature']
    (tmp_path / 'image.png').unlink()
    missing = check_question(q, [stem, answer], tmp_path)
    assert missing['status'] == 'invalid' and missing['stem_valid'] and not missing['assets_ready']


@pytest.mark.parametrize(
    'html',
    [
        '<p> </p>',
        '<img src="https://example.test/a.png">',
        '<script>x</script>',
        '<img data-asset-key="x" onerror="alert(1)">',
        '<p>\u200b</p>',
    ],
)
def test_invalid_html_cannot_be_rescued_by_stale_plain_text(tmp_path, html):
    assert check_question(question(html, plain_text='旧文本'), [], tmp_path)['status'] == 'invalid'
    assert check_question(question('', plain_text='纯文本人工题'), [], tmp_path)['status'] == 'ready'


def test_path_escape_symlink_and_hash_mismatch_are_not_ready(tmp_path):
    row = asset(tmp_path)
    q = question('<img data-asset-key="image">')
    for path in ('../image.png', str(tmp_path / 'image.png'), 'missing.png'):
        assert check_question(q, [{**row, 'storage_path': path}], tmp_path)['status'] == 'invalid'
    link = tmp_path / 'link.png'
    link.symlink_to(tmp_path / 'image.png')
    assert check_question(q, [{**row, 'storage_path': 'link.png'}], tmp_path)['status'] == 'invalid'
    (tmp_path / 'image.png').write_bytes(b'changed')
    assert check_question(q, [row], tmp_path)['status'] == 'invalid'


async def cache(db, row, assets, root):
    proof = check_question(question_payload(row), [asset_payload(a) for a in assets], root)
    assert await store_proofs(db, [row], assets, [proof]) == {row.question_id}
    await db.commit()
    return row.readiness_revision


@pytest.mark.asyncio
async def test_manual_null_hash_body_changes_invalidate_atomically_and_rollback(bank_db, tmp_path):
    row = await bank_db.get(QbQuestion, 2)
    revision = await cache(bank_db, row, [], tmp_path)
    assert row.content_hash is None
    assert (
        await bank_db.scalar(select(QbQuestion.question_id).where(QbQuestion.question_id == 2, usable_predicate())) == 2
    )
    row.plain_text = '改题干'
    await bank_db.flush()
    assert row.readiness_revision != revision
    assert (
        await bank_db.scalar(select(QbQuestion.question_id).where(QbQuestion.question_id == 2, usable_predicate()))
        is None
    )
    await bank_db.rollback()
    row = await bank_db.get(QbQuestion, 2)
    assert row.readiness_revision == revision
    row.answer_html = '修改答案不改题干'
    row.last_seen_at = datetime.now()
    await bank_db.commit()
    assert row.readiness_revision == revision
    row.plain_text = '正式改题干'
    await bank_db.commit()
    assert row.readiness_revision != revision


@pytest.mark.asyncio
async def test_asset_insert_change_delete_invalidate_cache_and_loaded_revision(bank_db, tmp_path):
    row = await bank_db.get(QbQuestion, 2)
    row.content_html = '<img data-asset-key="image">'
    values = asset(tmp_path)
    values['question_id'] = 2
    image = QbQuestionAsset(**values, create_time=datetime.now(), update_time=datetime.now())
    bank_db.add(image)
    await bank_db.flush()
    token = await cache(bank_db, row, [image], tmp_path)
    assert (await bank_db.get(QbQuestionReadiness, 2)).question_revision == token
    image.storage_path = 'missing.png'
    await bank_db.flush()
    assert row.readiness_revision != token
    assert (
        await bank_db.scalar(select(QbQuestion.question_id).where(QbQuestion.question_id == 2, usable_predicate()))
        is None
    )
    image_id = image.asset_id
    await bank_db.rollback()
    row = await bank_db.get(QbQuestion, 2)
    image = await bank_db.get(QbQuestionAsset, image_id)
    await bank_db.delete(image)
    await bank_db.commit()
    assert row.readiness_revision != token
    await BankDao.delete_questions(bank_db, [2])
    await bank_db.commit()
    assert await bank_db.get(QbQuestionReadiness, 2) is None


@pytest.mark.asyncio
async def test_worker_legacy_page_cas_and_expired_owner(bank_db, tmp_path):
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    row = await bank_db.get(QbQuestion, 2)
    row.readiness_revision = None
    await bank_db.commit()
    first = await worker.check_readiness_once(session_factory=factory, root=tmp_path)
    assert first['checked'] == 3 and first['lastQuestionId'] == 3
    async with factory() as db:
        row = await db.get(QbQuestion, 2)
        assert row.readiness_revision and (await db.get(QbQuestionReadiness, 2)).status == 'ready'
        sweep = await db.get(QbQuestionReadinessSweep, 1)
        sweep.last_question_id = 0
        sweep.next_check_at = None
        await db.commit()

    async def concurrent_change():
        async with factory() as db:
            row = await db.get(QbQuestion, 2)
            row.plain_text = '检查期间发生编辑'
            await db.commit()

    second = await worker.check_readiness_once(session_factory=factory, root=tmp_path, after_prepare=concurrent_change)
    assert second['checked'] == 2
    async with factory() as db:
        assert (
            await db.scalar(select(QbQuestion.question_id).where(QbQuestion.question_id == 2, usable_predicate()))
            is None
        )
        sweep = await db.get(QbQuestionReadinessSweep, 1)
        sweep.next_check_at = None
        sweep.last_question_id = 0
        await db.commit()

    async def successor():
        async with factory() as db:
            sweep = await db.get(QbQuestionReadinessSweep, 1)
            sweep.worker_token = 'b' * 32
            sweep.lease_until = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(minutes=5)
            await db.commit()

    stale = await worker.check_readiness_once(session_factory=factory, root=tmp_path, after_prepare=successor)
    assert stale == {'status': 'superseded', 'checked': 0}
    assert (await worker.check_readiness_once(session_factory=factory, root=tmp_path))['status'] == 'waiting'


@pytest.mark.asyncio
async def test_worker_is_bounded_and_recheck_invalidates_file_loss(bank_db, tmp_path, monkeypatch):
    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    monkeypatch.setattr(worker, 'PAGE_SIZE', 2)
    row = await bank_db.get(QbQuestion, 2)
    row.content_html = '<img data-asset-key="image">'
    values = asset(tmp_path)
    values['question_id'] = 2
    image = QbQuestionAsset(**values, create_time=datetime.now(), update_time=datetime.now())
    bank_db.add(image)
    await bank_db.commit()
    first = await worker.check_readiness_once(session_factory=factory, root=tmp_path)
    assert first['checked'] == 2 and first['lastQuestionId'] == 2
    assert await worker.recheck_questions([2, 999], session_factory=factory, root=tmp_path) == {
        'readyQuestionIds': [2],
        'affectedQuestionIds': [999],
    }
    (tmp_path / 'image.png').unlink()
    result = await worker.recheck_questions([2], session_factory=factory, root=tmp_path)
    assert result == {'readyQuestionIds': [], 'affectedQuestionIds': [2]}
    bank_db.expire_all()
    assert (await bank_db.get(QbQuestionReadiness, 2)).status == 'invalid'


@pytest.mark.asyncio
async def test_counts_lists_distinct_directory_rollup_and_enabled_scope(bank_db, tmp_path):
    row = await bank_db.get(QbQuestion, 1)
    row.status = '0'
    await cache(bank_db, row, [], tmp_path)
    node = await bank_db.get(QbCatalogNode, 1)
    node.status = '0'
    now = datetime.now()
    bank_db.add(
        QbCatalogNode(
            catalog_id=3,
            subject_id=1,
            textbook_id=1,
            parent_id=1,
            source_provider='manual',
            node_name='子目录',
            node_type='section',
            status='0',
            create_time=now,
            update_time=now,
        )
    )
    for q, c in ((1, 1), (1, 3), (2, 3), (3, 3)):
        bank_db.add(
            QbQuestionCatalog(
                question_id=q,
                catalog_id=c,
                relation_type='query_catalog',
                evidence_type='query_membership',
                create_time=now,
                update_time=now,
            )
        )
    await bank_db.commit()
    counts = (await book_coverage(bank_db, [1]))[1]
    assert counts['formalQuestionCount'] == counts['activeQuestionCount'] == 3
    assert counts['usableQuestionCount'] == 1 and counts['uncheckedQuestionCount'] == 2
    directory = await catalog_coverage(bank_db, 1)
    assert directory[1]['directQuestionCount'] == 1 and directory[1]['descendantQuestionCount'] == 3
    assert directory[1]['descendantUsableQuestionCount'] == 1
    page = await BankDao.list_questions(
        bank_db, QuestionPageQueryModel(textbookId=1, usableOnly=True, includeDisabled=True)
    )
    assert page.total == 1 and len(page.rows) == 1
    subject = await bank_db.get(QbSubject, 1)
    subject.status = '1'
    await bank_db.commit()
    assert (await book_coverage(bank_db, [1]))[1]['usableQuestionCount'] == 0
    assert (await BankDao.list_questions(bank_db, QuestionPageQueryModel(textbookId=1, usableOnly=True))).total == 0
    subject.status = '0'
    await bank_db.commit()
    book = await bank_db.get(QbTextbook, 1)
    book.status = '1'
    await bank_db.commit()
    # Q1 still belongs to another enabled book. That must not make it
    # eligible through the disabled book requested by this query.
    assert (await BankDao.list_questions(bank_db, QuestionPageQueryModel(textbookId=1, usableOnly=True))).total == 0
    node.parent_id = 3
    await bank_db.commit()
    with pytest.raises(Exception, match='循环'):
        await BankService.catalog_tree(bank_db, 1)


@pytest.mark.asyncio
async def test_new_batch_saves_proof_and_manual_stem_collision_is_local(bank_db, tmp_path, monkeypatch):
    monkeypatch.setenv('BANK_ASSET_ROOT', str(tmp_path))
    image = asset(tmp_path, 'img')
    image['question_id'] = 1
    bank_db.add(QbQuestionAsset(**image, create_time=datetime.now(), update_time=datetime.now()))
    await bank_db.commit()
    protected = snapshot('q1', asset=True)
    protected['questions'][0]['content_html'] += '<img data-asset-key="img">'
    protected['assets'][0].update(
        file_hash=image['file_hash'],
        storage_path=image['storage_path'],
        source_provider='zujuan',
        download_status='downloaded',
        mime_type='image/png',
    )
    result = await merge_prepared_incremental_batch(
        bank_db, [protected, snapshot('q4')], local_textbook_id=1, task_id=28
    )
    assert len(result['writeIssues']) == 1 and result['writeIssues'][0]['questionId'] == 'q1'
    assert (await bank_db.get(QbQuestion, 1)).content_html == '<p>旧题干</p>'
    assert (
        await bank_db.scalars(
            select(QbQuestionReadiness)
            .join(QbQuestion, QbQuestion.question_id == QbQuestionReadiness.question_id)
            .where(
                QbQuestion.external_question_id == 'q4',
                QbQuestion.source_provider == 'zujuan',
            )
        )
    ).one().status == 'ready'
    assert (await bank_db.get(QbQuestionAsset, 1)).source_provider == 'manual'


@pytest.mark.asyncio
async def test_missing_answer_assets_do_not_quarantine_complete_stem(monkeypatch):
    from plugins.bank.service import incremental_merge

    async def download(value, **_kwargs):
        if value['assets']:
            from exceptions.exception import ServiceException

            raise ServiceException(message='答案图片下载失败')

    monkeypatch.setattr(incremental_merge, '_download_snapshot_assets', download)
    result = await prepare_incremental_verdicts([{'status': 'accepted', 'normalized': snapshot(asset=True)}])
    assert result[0]['status'] == 'accepted'
    assert result[0]['normalized']['assets'][0]['download_status'] == 'failed'


@pytest.mark.asyncio
async def test_backfill_file_io_holds_no_session_or_source_lock(bank_db, tmp_path, monkeypatch):
    from contextlib import asynccontextmanager

    factory = async_sessionmaker(bank_db.bind, expire_on_commit=False)
    active = 0

    @asynccontextmanager
    async def tracked():
        nonlocal active
        async with factory() as db:
            active += 1
            try:
                yield db
            finally:
                active -= 1

    real = worker.check_question

    def verify(*args):
        assert active == 0
        return real(*args)

    monkeypatch.setattr(worker, 'check_question', verify)
    assert (await worker.check_readiness_once(session_factory=tracked, root=tmp_path))['checked'] == 3


@pytest.mark.asyncio
async def test_readiness_migration_repeat_and_old_publisher_table_reset(bank_db, tmp_path):
    if bank_db.bind.dialect.name != 'mysql':
        pytest.skip('requires isolated MySQL migrations/publisher')
    import asyncio
    import importlib.util
    from pathlib import Path

    from sqlalchemy import text

    from tests.plugins.bank.test_source_write_lock import _publisher

    row = await bank_db.get(QbQuestion, 2)
    token = await cache(bank_db, row, [], tmp_path)
    path = Path(__file__).parents[3] / 'plugins/bank/migrations/mysql/019_question_readiness.py'
    spec = importlib.util.spec_from_file_location('readiness_migration', path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    for _ in range(2):
        await migration.run(bank_db)
        await bank_db.commit()
    assert (await bank_db.get(QbQuestionReadiness, 2, populate_existing=True)).question_revision == token
    # A pre-migration rollback table must gain the nullable revision column.
    await bank_db.execute(text('DROP TABLE IF EXISTS qb_question_old_19'))
    await bank_db.execute(text('CREATE TABLE qb_question_old_19 LIKE qb_question'))
    await bank_db.execute(text('INSERT INTO qb_question_old_19 SELECT * FROM qb_question'))
    await bank_db.execute(text('ALTER TABLE qb_question_old_19 DROP COLUMN readiness_revision'))
    await bank_db.commit()
    publisher = await _publisher(bank_db)
    try:
        await asyncio.to_thread(publisher.acquire_lock)
        await asyncio.to_thread(publisher._reset_candidate_readiness, 'qb_question_old_19')
        assert (
            await bank_db.scalar(text('SELECT COUNT(*) FROM qb_question_old_19 WHERE readiness_revision IS NOT NULL'))
            == 0
        )
        await bank_db.commit()
    finally:
        await asyncio.to_thread(publisher.release_lock)
        await asyncio.to_thread(publisher.connection.close)
        await bank_db.execute(text('DROP TABLE qb_question_old_19'))
        await bank_db.commit()


def test_total_stem_asset_read_budget_is_bounded(tmp_path, monkeypatch):
    from plugins.bank.service import question_readiness

    monkeypatch.setattr(question_readiness, 'MAX_ASSET_BYTES', 8)
    images = [asset(tmp_path, 'a', data=b'12345'), asset(tmp_path, 'b', data=b'12345')]
    q = question('<img data-asset-key="a"><img data-asset-key="b">')
    proof = check_question(q, images, tmp_path)
    assert proof['status'] == 'invalid' and '预算' in proof['reason']


@pytest.mark.asyncio
async def test_multi_book_directory_query_does_not_follow_foreign_book_parent(bank_db):
    from sqlalchemy import event

    root = await bank_db.get(QbCatalogNode, 1)
    root.status = '0'
    foreign = await bank_db.get(QbCatalogNode, 2)
    foreign.parent_id = 1
    now = datetime.now()
    bank_db.add(
        QbQuestionCatalog(
            question_id=2,
            catalog_id=2,
            relation_type='query_catalog',
            evidence_type='query_membership',
            create_time=now,
            update_time=now,
        )
    )
    await bank_db.commit()
    statements = []

    def record(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(bank_db.bind.sync_engine, 'before_cursor_execute', record)
    try:
        counts = await catalog_coverage(bank_db, [1, 2], include_disabled=True)
        assert len(statements) == 1
        assert counts[1]['descendantQuestionCount'] == 0
        assert counts[2]['descendantQuestionCount'] == 2
    finally:
        event.remove(bank_db.bind.sync_engine, 'before_cursor_execute', record)
