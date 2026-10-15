"""Issue ownership and impact scope follow what happened (spec section 6)."""
from types import SimpleNamespace

import pytest

from plugins.bank.service.issue_diagnostics import classify_issue, describe_issue
from tests.plugins.bank.test_incremental_import import import_db as import_db
from tests.plugins.bank.test_incremental_merge import bank_db as bank_db


@pytest.mark.parametrize('error_type,reason,evidence,owner,scope', [
    # E01: explicit protection evidence is the only path to a person on the source page.
    ('scope_failure', '题目列表返回验证/防护：目录 5289 第 25 页', {}, 'source_manual', 'source'),
    # E02/A24: a bare 405 or plain HTML is diagnosed, never assumed to be a slider.
    ('scope_failure', '题目列表请求失败：HTTP 405', {'errorKind': 'http_405'}, 'maintenance', 'source'),
    ('scope_failure', '列表返回非 JSON', {'errorKind': 'unexpected_html'}, 'maintenance', 'source'),
    # E03/E04: timeouts recover in the program even when no retry time is set.
    ('intake_failure', '采集服务 API 超时', {'attempts': 3}, 'program', 'server'),
    ('import_failure', 'HTTP 504 Gateway Timeout', {}, 'program', 'server'),
    # E05/E06: resource waits are the program's, not the teacher's.
    ('import_failure', '主机可用内存低于水位', {}, 'program', 'server'),
    ('scope_failure', '磁盘可用空间低于 4096 MiB', {}, 'program', 'server'),
    # Persistent program failure becomes maintenance, not a teacher judgement.
    ('intake_failure', '采集服务 API 超时', {'attempts': 9}, 'maintenance', 'server'),
    # E07/E08: catalog identity conflicts are program maintenance scoped to the book.
    ('intake_failure', '空快照', {'collectionError': '目录 ID 重复：4712'}, 'maintenance', 'book'),
    # E09/E13: an isolated question is program handled.
    ('question_quality', '缺少题干图片', {}, 'program', 'item'),
])
def test_classify_issue(error_type, reason, evidence, owner, scope):
    assert classify_issue(error_type, reason, evidence) == {'owner': owner, 'impactScope': scope}


def test_stored_owner_wins_and_description_carries_labels():
    assert classify_issue('scope_failure', '验证码', {'owner': 'program', 'impactScope': 'item'})['owner'] == 'program'
    row = SimpleNamespace(error_type='import_failure', reason='HTTP 504', evidence_json={'handling': 'manual'})
    described = describe_issue(row)
    assert described['owner'] == 'program' and described['ownerLabel'] == '程序处理'
    assert '无需你判断' in described['actionHint']


@pytest.mark.asyncio
async def test_empty_snapshot_links_root_issue_and_is_not_reverified(import_db):
    """E08/A30: an empty result after a collection failure points at the root, not a new manual problem."""
    from datetime import datetime

    from sqlalchemy import select

    from plugins.bank.entity.do.bank_do import QbQuestionImportIntake, QbSyncIssue, QbSyncJobScope
    from plugins.bank.service import sync_issues, sync_plans

    db = import_db
    now = datetime.utcnow().replace(microsecond=0)
    scope = await db.get(QbSyncJobScope, 30)
    scope.question_count = scope.catalog_count = scope.question_catalog_count = 0
    scope.error_message = '目录 ID 重复：4712'
    await sync_issues.observe(db, subject_id=1, provider='zujuan', book_id=1, task_id=28, kind='scope', key='tb1',
                              error_type='scope_failure', reason='目录 ID 重复：4712', evidence={}, now=now)
    await db.flush()
    root = await db.scalar(select(QbSyncIssue.issue_id).where(QbSyncIssue.error_type == 'scope_failure'))
    db.add(QbQuestionImportIntake(intake_id=5, task_id=28, scope_id=30, collector_run_id=27, binding_hash='b' * 64, status='blocked',
                                  attempt_count=6, attempt_limit=6, error_message='空快照', create_time=now, update_time=now))
    await db.commit()
    intake = SimpleNamespace(scope_id=30, task_id=28, collector_run_id=27, intake_id=5, error_kind='empty', attempt_count=6)
    await sync_issues.record_runtime_failure(db, intake, stage='intake', message='空快照', now=now)
    await db.commit()
    issue = await db.scalar(select(QbSyncIssue).where(QbSyncIssue.error_type == 'intake_failure'))
    assert issue.evidence_json['emptySnapshot'] is True and issue.evidence_json['rootIssueId'] == root
    assert issue.evidence_json['owner'] == 'maintenance' and issue.evidence_json['impactScope'] == 'book'
    assert await sync_plans.retry_saved_book_results(db, 1, now) is False, 'an empty result is never re-verified'


@pytest.mark.parametrize('options,status,message,cancelling,cause', [
    ({'planWorkPaused': True, 'planActionBy': 'teacher'}, 'interrupted', '收到 SIGTERM，采集在安全点停止', False, 'user_pause'),
    ({'planWorkEnded': True}, 'cancelled', '同步已停止', True, 'user_end'),
    ({}, 'cancelled', '同步已停止', True, 'user_cancel'),
    ({}, 'interrupted', '主机可用内存低于保留水位', False, 'resource'),
    ({}, 'interrupted', '收到 SIGTERM，采集在安全点停止', False, 'service_restart'),
])
def test_stop_cause_combines_user_intent_resource_and_signal(options, status, message, cancelling, cause):
    """E15: a signal alone is never a fault; recorded intent wins."""
    from plugins.bank.service.issue_diagnostics import stop_cause

    result = stop_cause(options, status, message, was_cancelling=cancelling)
    assert result['cause'] == cause
    if 'SIGTERM' in message:
        assert result['signal'] == 'SIGTERM'
    assert stop_cause({}, 'completed', '', was_cancelling=False) is None
