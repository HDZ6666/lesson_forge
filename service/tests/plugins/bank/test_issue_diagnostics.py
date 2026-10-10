"""Task 6: explain the collection failure, not just downstream empty intake."""

from datetime import datetime
from types import SimpleNamespace

import pytest

from exceptions.exception import ServiceException
from plugins.bank.entity.do.bank_do import QbSyncJobScope
from plugins.bank.service.issue_diagnostics import describe_issue
from plugins.bank.service.question_apply_service import _normalise_snapshot_summary
from plugins.bank.service.sync_issues import list_issues, observe
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db
from tests.plugins.bank.test_incremental_snapshot import fixture_client


def test_empty_sealed_snapshot_reports_counts_and_collection_cause(monkeypatch):
    _, summary, _, _ = fixture_client(monkeypatch)
    summary['counts'] = dict.fromkeys(summary['counts'], 0)
    summary['run']['message'] = '目录 ID 重复：4712'
    with pytest.raises(ServiceException) as exc:
        _normalise_snapshot_summary(summary, 6, 'tb1', sealed_for_import=True)
    assert '目录 0 条' in str(exc.value)
    assert '题目 0 条' in str(exc.value)
    assert '目录 ID 重复：4712' in str(exc.value)
    assert '重新采集' in str(exc.value)


def test_archived_issue_retains_counts_but_import_uses_its_own_failure():
    evidence = {
        'collectionError': '目录 ID 重复：4712',
        'snapshotCounts': {'catalogs': 0, 'questions': 0, 'relations': 0},
    }
    row = SimpleNamespace(error_type='intake_failure', reason='缺少必要目录、题目或目录关系', evidence_json=evidence)
    result = describe_issue(row)
    assert result['title'] == '目录解析失败：来源节点 4712 重复出现'
    assert result['counts']['questions'] == 0
    assert '重试任务' in result['actionHint']
    row.error_type = 'import_failure'
    row.reason = 'MySQL 连接中断'
    assert describe_issue(row)['rootCause'] == 'MySQL 连接中断'


@pytest.mark.asyncio
async def test_old_issue_joins_sealed_scope_without_remote_fetch(bank_db):
    now = datetime.utcnow()
    bank_db.add(
        QbSyncJobScope(
            scope_id=157,
            run_id=6,
            source_provider='zujuan',
            local_textbook_id=1,
            external_textbook_id='195861',
            collector_run_id=2,
            status='failed',
            error_message='目录 ID 重复：4712',
            snapshot_locked_at=now,
            catalog_count=0,
            question_count=0,
            question_catalog_count=0,
            create_time=now,
            update_time=now,
        )
    )
    await observe(
        bank_db,
        subject_id=1,
        provider='zujuan',
        book_id=1,
        task_id=6,
        kind='textbook',
        key='195861:intake',
        error_type='intake_failure',
        reason='缺少必要目录、题目或目录关系',
        evidence={'collectorRunId': 2},
        now=now,
    )
    await bank_db.commit()
    row = (await list_issues(bank_db, task_id=6))['rows'][0]
    assert row['versionName'] == '版本'
    assert row['diagnosis']['rootCause'] == '目录 ID 重复：4712'
    assert row['diagnosis']['counts'] == {'catalogs': 0, 'questions': 0, 'relations': 0}
    assert row['diagnosis']['textbookExternalId'] == '195861'
    assert row['status'] == 'open'
