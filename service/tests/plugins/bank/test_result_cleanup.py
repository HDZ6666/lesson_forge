from datetime import datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbQuestionImport, QbSyncJob, QbSyncJobScope
from plugins.bank.service.incremental_import import claim_incremental_import
from plugins.bank.service.result_cleanup import cleanup_once
from plugins.bank.service.task_service import SyncTaskService
from tests.plugins.bank.test_incremental_import import import_db as import_db
from tests.plugins.bank.test_incremental_import import report
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db


@pytest.mark.asyncio
async def test_cleanup_keeps_latest_and_quarantined_then_reclaims_superseded(import_db, tmp_path):
    db = import_db
    ticket = await claim_incremental_import(db, 30, report())
    row = await db.get(QbQuestionImport, ticket['importId'])
    row.status = 'partial'
    row.cursor = 3
    row.quarantined_count = 1
    row.accepted_count = 2
    row.worker_token = None
    row.lease_until = None
    row.active_source_slot = None
    row.finished_at = datetime.utcnow() - timedelta(days=2)
    path = tmp_path / f'import-{row.import_id}.sqlite3'
    path.write_bytes(b'completed spool')
    await db.commit()
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    calls = []

    class Client:
        def reclaim_run(self, **payload):
            calls.append(payload)
            return {'reclaimedAt': '2026-10-11T00:00:00Z', 'deletedBytes': 123}

    await cleanup_once(session_factory=factory, client=Client(), root=tmp_path)
    assert path.exists() and not calls
    await db.refresh(row)
    row.quarantined_count = 0
    row.accepted_count = 3
    await db.commit()
    await cleanup_once(session_factory=factory, client=Client(), root=tmp_path)
    assert not path.exists() and not calls  # Latest Collector snapshot is retained.
    now = datetime.utcnow()
    db.add(
        QbSyncJobScope(
            scope_id=31,
            run_id=29,
            source_provider='zujuan',
            local_textbook_id=1,
            collector_run_id=28,
            question_count=4,
            snapshot_locked_at=now,
            create_time=now,
            update_time=now,
        )
    )
    await db.commit()
    # A queued explicit continuation protects its source snapshot.
    db.add(
        QbSyncJob(
            run_id=29,
            subject_id=1,
            task_module='question',
            run_type='content',
            status='queued',
            phase='catalogs_questions',
            options_json={},
            acknowledge_source_policy='Y',
            create_time=now,
            update_time=now,
        )
    )
    scope = await db.get(QbSyncJobScope, 31)
    scope.resume_from_collector_run_id = 27
    await db.commit()
    await cleanup_once(session_factory=factory, client=Client(), root=tmp_path)
    assert not calls
    job = await db.get(QbSyncJob, 29)
    job.status = 'completed'
    await db.commit()
    await cleanup_once(session_factory=factory, client=Client(), root=tmp_path)
    assert calls[0]['runId'] == 27
    task = await db.get(QbSyncJob, 28, populate_existing=True)
    assert task.options_json['snapshotReclaimed'] and not task.options_json['snapshotCleanupPending']
    with pytest.raises(ServiceException, match='已回收'):
        await SyncTaskService.create_question(db, {'versionId': 1, 'textbookId': 1}, 'test', resume_task_id=28)
    await db.rollback()
    await cleanup_once(session_factory=factory, client=Client(), root=tmp_path)
    assert len(calls) == 1
