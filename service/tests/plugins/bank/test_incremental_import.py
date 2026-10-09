"""Real SQL commits prove import leases, checkpoints and failure recovery."""

import asyncio
import copy
import importlib.util
from datetime import datetime
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import event, func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import (
    QbQuestion,
    QbQuestionImport,
    QbQuestionImportBatch,
    QbQuestionReadiness,
    QbSyncJob,
    QbSyncJobScope,
)
from plugins.bank.service.incremental_import import (
    claim_incremental_import,
    fail_incremental_import,
    renew_incremental_import,
    submit_incremental_import_batch,
)
from plugins.bank.service.incremental_snapshot import (
    QC_FORMAT,
    SealedSnapshotReader,
    check_sealed_snapshot,
    read_checked_batch,
)
from plugins.bank.service.large_snapshot_spool import spool_snapshot
from plugins.bank.service.task_service import SyncTaskService
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_incremental_merge import snapshot
from tests.plugins.bank.test_incremental_snapshot import fixture_client


@pytest_asyncio.fixture
async def import_db(bank_db):
    now = datetime.now()
    bank_db.add(
        QbSyncJob(
            run_id=28,
            subject_id=1,
            task_module='question',
            run_type='content',
            status='failed',
            phase='failed',
            options_json={'workflowVersion': 2},
            acknowledge_source_policy='Y',
            create_time=now,
            update_time=now,
        )
    )
    bank_db.add(
        QbSyncJobScope(
            scope_id=30,
            run_id=28,
            subject_id=1,
            local_textbook_id=1,
            local_version_id=1,
            source_provider='zujuan',
            external_version_id='v1',
            external_textbook_id='tb1',
            collector_run_id=27,
            status='failed',
            snapshot_complete=0,
            snapshot_locked_at=datetime(2026, 10, 1, 1),
            question_count=3,
            create_time=now,
            update_time=now,
        )
    )
    await bank_db.commit()
    yield bank_db


def report():
    return {
        'format': QC_FORMAT,
        'qualityHash': 'a' * 64,
        'checked': 3,
        'accepted': 2,
        'quarantined': 1,
        'snapshotComplete': False,
        'taskId': 28,
        'collectorRunId': 27,
        'textbookExternalId': 'tb1',
        'snapshotLockedAt': '2026-10-01T01:00:00Z',
    }


def verdict(ordinal, question):
    value = snapshot(question)
    value['task_id'] = 28
    return {'ordinal': ordinal, 'questionId': question, 'status': 'accepted', 'normalized': value, 'reason': None}


def bad_verdict(ordinal=1):
    return {'ordinal': ordinal, 'questionId': 'bad', 'status': 'quarantined', 'normalized': None, 'reason': '题干缺失'}


@pytest.mark.asyncio
async def test_sealed_qc_to_formal_merge_and_restart_uses_committed_cursor(import_db, monkeypatch, tmp_path):
    db = import_db
    client, summary, rows, _calls = fixture_client(monkeypatch)
    # The bank fixture deliberately owns c2 in a second book; this scope
    # uses distinct source directories rather than moving that directory.
    rows['catalogs'][0]['catalog_external_id'] = 'qc-root'
    rows['catalogs'][1].update(catalog_external_id='qc-leaf', parent_external_id='qc-root')
    for relation in rows['questionCatalogs']:
        relation['catalog_external_id'] = 'qc-leaf'
    path = tmp_path / 'sealed.sqlite3'
    spool_snapshot(client, 27, 'tb1', path, sealed_for_import=True)
    with SealedSnapshotReader(path, summary, 28, 'tb1') as reader:
        quality = check_sealed_snapshot(reader, path, size=1)
    ticket = await claim_incremental_import(db, 30, quality)
    first = await submit_incremental_import_batch(
        db, ticket, read_checked_batch(path, ticket, size=1), expected_cursor=0
    )
    assert first['incrementalImport']['processedCount'] == 1
    await fail_incremental_import(db, ticket, '模拟进程退出')
    recovered = await claim_incremental_import(db, 30, quality)
    assert recovered['cursor'] == 1 and recovered['workerToken'] != ticket['workerToken']
    for cursor in (1, 2):
        recovered['cursor'] = cursor
        result = await submit_incremental_import_batch(
            db, recovered, read_checked_batch(path, recovered, size=1), expected_cursor=cursor
        )
    state = result['incrementalImport']
    assert (state['status'], state['processedCount'], state['acceptedCount'], state['quarantinedCount']) == (
        'partial',
        3,
        2,
        1,
    )
    assert state['isCurrent'] is False and state['snapshotComplete'] is False
    repeated = await claim_incremental_import(db, 30, quality)
    assert repeated['done'] and repeated['workerToken'] is None and repeated['batchCount'] == 3
    rows = (await db.execute(select(QbQuestion).where(QbQuestion.source_provider == 'zujuan'))).scalars().all()
    assert {row.external_question_id for row in rows} == {'q1', 'q3', 'missing'}
    assert next(row for row in rows if row.external_question_id == 'q1').status == '1'
    records = (await db.execute(select(QbQuestionImportBatch).order_by(QbQuestionImportBatch.batch_no))).scalars().all()
    assert [(r.start_cursor, r.next_cursor) for r in records] == [(0, 1), (1, 2), (2, 3)]
    assert records[1].issues_json[0]['questionId'] == 'q2'


@pytest.mark.asyncio
async def test_expired_owner_cannot_renew_fail_or_submit_after_takeover(import_db):
    db = import_db
    ticket = await claim_incremental_import(db, 30, report())
    await submit_incremental_import_batch(db, ticket, [verdict(0, 'q3')], expected_cursor=0)
    row = await db.get(QbQuestionImport, ticket['importId'])
    row.lease_until = datetime(2000, 1, 1)
    await db.commit()
    with pytest.raises(ServiceException, match='执行权'):
        await renew_incremental_import(db, ticket)
    recovered = await claim_incremental_import(db, 30, report())
    assert recovered['cursor'] == 1
    with pytest.raises(ServiceException, match='执行权'):
        await submit_incremental_import_batch(db, ticket, [verdict(1, 'q4')], expected_cursor=1)
    with pytest.raises(ServiceException, match='执行权'):
        await fail_incremental_import(db, ticket, '旧执行者不得覆盖新状态')
    with pytest.raises(ServiceException, match='断点已变化'):
        await submit_incremental_import_batch(db, recovered, [verdict(0, 'q3')], expected_cursor=0)
    await renew_incremental_import(db, recovered)
    row = await db.get(QbQuestionImport, recovered['importId'])
    assert (row.cursor, row.batch_no, row.accepted_count) == (1, 1, 1)
    assert (
        await db.scalar(select(func.count()).select_from(QbQuestion).where(QbQuestion.external_question_id == 'q4'))
        == 0
    )


@pytest.mark.asyncio
async def test_journal_failure_rolls_back_current_formal_batch_then_retry(import_db):
    db = import_db
    ticket = await claim_incremental_import(db, 30, report())
    await submit_incremental_import_batch(db, ticket, [verdict(0, 'q3')], expected_cursor=0)

    def break_journal(_conn, _cursor, statement, _parameters, _context, _many):
        if statement.startswith('INSERT INTO qb_question_import_batch'):
            raise RuntimeError('模拟批次日志写入失败')

    engine = db.bind.sync_engine
    event.listen(engine, 'before_cursor_execute', break_journal)
    try:
        with pytest.raises(RuntimeError, match='批次日志'):
            await submit_incremental_import_batch(db, ticket, [verdict(1, 'q4')], expected_cursor=1)
    finally:
        event.remove(engine, 'before_cursor_execute', break_journal)
    row = await db.get(QbQuestionImport, ticket['importId'])
    assert (row.cursor, row.batch_no, row.accepted_count) == (1, 1, 1)
    assert await db.scalar(select(func.count()).select_from(QbQuestionImportBatch)) == 1
    assert await db.scalar(select(func.count()).select_from(QbQuestionReadiness)) == 1
    assert (
        await db.scalar(select(func.count()).select_from(QbQuestion).where(QbQuestion.external_question_id == 'q4'))
        == 0
    )
    assert (
        await db.scalar(select(func.count()).select_from(QbQuestion).where(QbQuestion.external_question_id == 'q3'))
        == 1
    )
    await db.commit()
    await submit_incremental_import_batch(db, ticket, [verdict(1, 'q4')], expected_cursor=1)
    result = await submit_incremental_import_batch(db, ticket, [bad_verdict(2)], expected_cursor=2)
    assert result['incrementalImport']['batchCount'] == 3
    assert result['incrementalImport']['acceptedCount'] == 2


@pytest.mark.asyncio
async def test_changed_scope_and_wrong_verdict_stop_before_formal_writes(import_db):
    db = import_db
    ticket = await claim_incremental_import(db, 30, report())
    wrong = verdict(0, 'q3')
    wrong['normalized']['task_id'] = 999
    with pytest.raises(ServiceException, match='题目身份'):
        await submit_incremental_import_batch(db, ticket, [wrong], expected_cursor=0)
    scope = await db.get(QbSyncJobScope, 30)
    scope.collector_run_id = 99
    await db.commit()
    with pytest.raises(ServiceException, match='绑定'):
        await submit_incremental_import_batch(db, ticket, [verdict(0, 'q3')], expected_cursor=0)
    with pytest.raises(ServiceException, match='绑定'):
        await renew_incremental_import(db, ticket)
    assert await db.scalar(select(func.count()).select_from(QbQuestionImportBatch)) == 0
    assert (
        await db.scalar(select(func.count()).select_from(QbQuestion).where(QbQuestion.external_question_id == 'q3'))
        == 0
    )


@pytest.mark.asyncio
async def test_claim_deduplicates_and_rejects_conflicting_quality_identity(import_db):
    db = import_db
    ticket = await claim_incremental_import(db, 30, report())
    with pytest.raises(ServiceException, match='其他执行者'):
        await claim_incremental_import(db, 30, report())
    conflict = copy.deepcopy(report())
    conflict['qualityHash'] = 'b' * 64
    with pytest.raises(ServiceException, match='检查身份'):
        await claim_incremental_import(db, 30, conflict)
    wrong = report()
    wrong['checked'] = 4
    with pytest.raises(ServiceException, match='身份或数量'):
        await claim_incremental_import(db, 30, wrong)
    await renew_incremental_import(db, ticket)
    assert await db.scalar(select(func.count()).select_from(QbQuestionImport)) == 1


@pytest.mark.asyncio
async def test_concurrent_mysql_claims_have_one_owner(import_db):
    db = import_db
    if db.bind.dialect.name != 'mysql':
        pytest.skip('requires isolated MySQL row locks')
    factory = async_sessionmaker(db.bind, expire_on_commit=False)

    async def claim():
        async with factory() as session:
            try:
                return await claim_incremental_import(session, 30, report())
            except ServiceException as exc:
                return exc

    results = await asyncio.gather(claim(), claim())
    assert sum(isinstance(result, dict) for result in results) == 1
    assert sum(isinstance(result, ServiceException) for result in results) == 1
    assert await db.scalar(select(func.count()).select_from(QbQuestionImport)) == 1


@pytest.mark.asyncio
async def test_millisecond_seal_identity_survives_database_reload(import_db):
    db = import_db
    scope = await db.get(QbSyncJobScope, 30)
    scope.snapshot_locked_at = datetime(2026, 10, 1, 1, 0, 0, 125000)
    await db.commit()
    quality = report()
    quality['snapshotLockedAt'] = '2026-10-01T01:00:00.125Z'
    ticket = await claim_incremental_import(db, 30, quality)
    await renew_incremental_import(db, ticket)
    loaded = await db.get(QbQuestionImport, ticket['importId'], populate_existing=True)
    assert loaded.snapshot_locked_at == datetime(2026, 10, 1, 1, 0, 0, 125000)


@pytest.mark.asyncio
async def test_task_detail_separates_import_state_and_does_not_leak_old_run(import_db):
    db = import_db
    ticket = await claim_incremental_import(db, 30, report())
    await submit_incremental_import_batch(db, ticket, [verdict(0, 'q3')], expected_cursor=0)
    detail = await SyncTaskService.question_detail(db, 28)
    assert detail['workflowVersion'] == 2 and detail['status'] == 'failed'
    assert detail['eligible'] is False and detail['isCurrent'] is False
    assert detail['incrementalImport']['status'] == 'running'
    assert detail['incrementalImport']['acceptedCount'] == 1
    assert not {'workerToken', 'leaseUntil', 'identityHash', 'qualityHash'} & detail['incrementalImport'].keys()
    scope = await db.get(QbSyncJobScope, 30)
    scope.collector_run_id = 99
    await db.commit()
    resumed = await SyncTaskService.question_detail(db, 28)
    assert resumed['incrementalImport'] is None


@pytest.mark.asyncio
async def test_mysql_migration_repeat_preserves_committed_import_and_batch(import_db):
    db = import_db
    if db.bind.dialect.name != 'mysql':
        pytest.skip('requires isolated MySQL migrations')
    ticket = await claim_incremental_import(db, 30, report())
    await submit_incremental_import_batch(db, ticket, [verdict(0, 'q3')], expected_cursor=0)
    root = Path(__file__).parents[3] / 'plugins/bank/migrations/mysql'
    spec = importlib.util.spec_from_file_location('import_lock_precision', root / '015_snapshot_lock_precision.py')
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    for _ in range(2):
        for statement in (root / '014_incremental_import.sql').read_text().split(';'):
            if statement.strip():
                await db.execute(text(statement))
        await migration.run(db)
    await db.commit()
    row = await db.get(QbQuestionImport, ticket['importId'], populate_existing=True)
    assert (row.cursor, row.batch_no, row.accepted_count) == (1, 1, 1)
    assert await db.scalar(select(func.count()).select_from(QbQuestionImportBatch)) == 1
    for table in ('qb_sync_job_scope', 'qb_question_import'):
        column = (await db.execute(text(f"SHOW COLUMNS FROM `{table}` WHERE Field='snapshot_locked_at'"))).one()
        assert column[1] == 'datetime(6)'


@pytest.mark.asyncio
async def test_task_cannot_be_deleted_while_import_is_unfinished(import_db):
    db = import_db
    ticket = await claim_incremental_import(db, 30, report())
    await submit_incremental_import_batch(db, ticket, [verdict(0, 'q3')], expected_cursor=0)
    with pytest.raises(ServiceException, match='恢复断点'):
        await SyncTaskService.delete_question(db, 28)
    await db.rollback()
    assert await db.get(QbSyncJob, 28) is not None
    row = await db.get(QbQuestionImport, ticket['importId'])
    assert row.cursor == 1 and row.status == 'running'


@pytest.mark.asyncio
async def test_manual_asset_conflict_journal_is_local_and_checkpoint_continues(import_db, monkeypatch, tmp_path):
    import hashlib

    from plugins.bank.entity.do.bank_do import QbQuestionAsset

    monkeypatch.setenv('BANK_ASSET_ROOT', str(tmp_path))
    payload = b'local-image'
    (tmp_path / 'manual.png').write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    now = datetime.now()
    import_db.add(QbQuestionAsset(question_id=1, source_provider='manual', asset_key='img', asset_type='image',
                                storage_path='manual.png', file_hash=digest, download_status='downloaded',
                                create_time=now, update_time=now))
    await import_db.commit()
    ticket = await claim_incremental_import(import_db, 30, report())
    item = verdict(0, 'q1')
    source = snapshot('q1', asset=True)
    source['task_id'] = 28
    source['questions'][0]['content_html'] += '<img data-asset-key="img">'
    source['assets'][0].update(file_hash=digest, storage_path='manual.png', download_status='downloaded')
    item['normalized'] = source
    result = await submit_incremental_import_batch(import_db, ticket, [item, verdict(1, 'q4')], expected_cursor=0)
    status = result['incrementalImport']
    assert (status['processedCount'], status['acceptedCount'], status['quarantinedCount']) == (2, 1, 1)
    journal = (await import_db.scalars(select(QbQuestionImportBatch))).one()
    assert journal.issues_json[0]['questionId'] == 'q1' and '人工' in journal.issues_json[0]['reason']
    assert (await import_db.get(QbQuestion, 1)).content_html == '<p>旧题干</p>'
    await import_db.commit()
    final = await submit_incremental_import_batch(import_db, ticket, [bad_verdict(2)], expected_cursor=2)
    assert final['incrementalImport']['processedCount'] == 3
    assert final['incrementalImport']['status'] == 'partial'
