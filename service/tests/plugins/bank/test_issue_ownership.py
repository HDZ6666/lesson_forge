"""Issue ownership and impact scope follow what happened (spec section 6)."""
from types import SimpleNamespace

import pytest

from plugins.bank.service.issue_diagnostics import classify_issue, describe_issue


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
