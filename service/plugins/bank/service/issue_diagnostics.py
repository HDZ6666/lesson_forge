"""Explain saved failures without re-reading the remote collector on page load."""

import re

STAGES = {
    'scope_failure': '教材采集',
    'intake_failure': '入库前核验',
    'import_failure': '分批入库',
    'question_quality': '题目质量检查',
    'metadata_identity': '教材登记',
    'metadata_validation': '教材发现核验',
}


OWNER_LABELS = {
    'source_manual': '需要你操作来源页面',
    'program': '程序处理',
    'maintenance': '需要维护',
}
SCOPE_LABELS = {'item': '单题/单页', 'book': '目录/教材', 'source': '公共来源会话', 'server': '服务器或公共服务'}
# Persistent program failures become maintenance, never a teacher judgement.
PERSISTENT_ATTEMPTS = 6

_PROTECTION = re.compile(r'验证码|滑块|防护|安全验证|访问验证|waiting_verification|verification_required|captcha|challenge', re.I)
_RESOURCE = re.compile(r'内存|磁盘|水位|资源不足|enospc|no space|disk|memory', re.I)
_TRANSIENT = re.compile(r'超时|timeout|timed out|http 50[234]|\b50[234]\b|reader_timeout|econnreset|网络|暂时|暂不可用|稍后|服务不可用|unavailable', re.I)
_DETERMINISTIC = re.compile(r'目录 ?id ?重复|解析|身份|冲突|parse|identity|schema|contract|结构', re.I)
_DIAGNOSE_HTTP = re.compile(r'http[_ ]?40[135]|unexpected_html|返回了 ?html', re.I)


def classify_issue(error_type, reason='', evidence=None):
    """Return who handles an issue and how far it reaches, kept as two facts.

    Ownership comes from what actually happened, never from whether a retry
    time happens to be scheduled (spec 6.1). Bare HTTP 401/403/405 or plain
    HTML is a technical diagnosis, not a slider for a person to solve.
    """
    evidence = evidence or {}
    if evidence.get('owner') in OWNER_LABELS:
        return {'owner': evidence['owner'], 'impactScope': evidence.get('impactScope') or 'book'}
    text = ' '.join(str(v) for v in (reason, evidence.get('collectionError'), evidence.get('errorKind')) if v)
    if error_type == 'question_quality':
        return {'owner': 'program', 'impactScope': 'item'}
    if error_type in ('metadata_identity', 'metadata_validation'):
        return {'owner': 'maintenance', 'impactScope': 'book'}
    if _PROTECTION.search(text):
        return {'owner': 'source_manual', 'impactScope': 'source'}
    if _DIAGNOSE_HTTP.search(text):
        return {'owner': 'maintenance', 'impactScope': 'source'}
    if _DETERMINISTIC.search(text):
        return {'owner': 'maintenance', 'impactScope': 'book'}
    if _RESOURCE.search(text) or _TRANSIENT.search(text):
        attempts = evidence.get('attempts') or 0
        if evidence.get('handling') != 'retry' and attempts >= PERSISTENT_ATTEMPTS:
            return {'owner': 'maintenance', 'impactScope': 'server'}
        return {'owner': 'program', 'impactScope': 'server'}
    return {'owner': 'maintenance', 'impactScope': 'book'}


def describe_issue(row, scope=None):
    evidence = row.evidence_json or {}
    collection_error = scope.error_message if scope and scope.error_message else evidence.get('collectionError')
    root = collection_error or row.reason if row.error_type in ('scope_failure', 'intake_failure') else row.reason
    counts = evidence.get('snapshotCounts')
    if scope and scope.snapshot_locked_at:
        counts = {
            'catalogs': scope.catalog_count,
            'questions': scope.question_count,
            'relations': scope.question_catalog_count,
        }
    title = row.reason
    impact = '该问题会保留在记录中，其他教材可继续处理。'
    action = '查看任务日志，按具体错误处理后再重试。'
    action_label = '查看任务与日志'
    duplicate = re.search(r'目录 ID 重复[：:]\s*([^；\s]+)', root or '')
    empty = counts is not None and all(value == 0 for value in counts.values())
    if duplicate:
        title = f'目录解析失败：来源节点 {duplicate.group(1)} 重复出现'
        impact = (
            '本次采集在读取目录时停止，还没有取得可入库题目。'
            if empty
            else '采集未能继续，已保存成果需按本次核验结果处理。'
        )
        action = (
            '同一知识点出现在不同章节时应分别保留，不能删除其中一处。'
            '请在任务详情点击“重试任务”重新采集；对旧空成果反复“重试封存核验”不会产生题目。'
        )
        action_label = '前往任务重新采集'
    elif empty and row.error_type in ('scope_failure', 'intake_failure'):
        title = '本次没有采集到目录和题目，无法入库'
        impact = '本次正式题库未新增题目，已有题库内容保留。'
        action = '先查看下面的采集停止原因，处理后在任务详情点击“重试任务”；无需重复核验空成果。'
        action_label = '前往任务重新采集'
    elif row.error_type == 'question_quality':
        title = '这道题暂未入库：' + row.reason
        impact = '仅暂缓这道题，同批合格题目可以正常入库。'
        action = '查看具体缺失内容；后续采集到这道题的合格内容后会自动更新处理状态。'
    elif row.error_type == 'intake_failure':
        impact = '本次成果尚未通过入库前核验，正式题库已有内容保留。'
        action = '确认采集服务和已保存成果可用后，在任务详情点击“重试封存核验”。若成果缺失，需要重新采集。'
        action_label = '前往任务检查成果'
    elif row.error_type == 'import_failure':
        impact = '已提交的批次保留，剩余题目尚未完成入库。'
        action = '处理错误后，在任务详情点击“继续入库”，从保存的批次位置继续。'
        action_label = '前往任务继续入库'
    elif row.error_type in ('metadata_identity', 'metadata_validation'):
        impact = '有冲突的数据未自动登记，原有教材保留。'
        action = '核对教材归属和来源记录；修正后在教材发现详情重试登记。'
    ownership = classify_issue(row.error_type, root or row.reason, evidence)
    if ownership['owner'] == 'source_manual':
        action = '来源需要验证，采集已暂停，已保存成果保留。打开服务器浏览器处理后，检查原请求是否恢复，再明确恢复或重新排队。'
        action_label = '打开服务器浏览器'
    elif ownership['owner'] == 'program' and row.error_type != 'question_quality':
        action = '程序会在条件恢复后从原阶段继续，已保存成果不会重新采集；无需你判断。'
    elif ownership['owner'] == 'maintenance' and ownership['impactScope'] == 'server':
        action = '多次自动恢复仍未成功，需要维护服务或存储；已保存成果保留。'
    if evidence.get('handling') == 'retry':
        action = '系统已安排自动重试，可查看下次重试时间；连续失败时再按原始错误排查。'
    return {
        'stage': STAGES.get(row.error_type, '同步处理'),
        'title': title,
        'rootCause': root,
        'impact': impact,
        'actionHint': action,
        'actionLabel': action_label,
        'counts': counts,
        'collectorRunId': evidence.get('collectorRunId') or (scope.collector_run_id if scope else None),
        'textbookExternalId': evidence.get('textbookExternalId') or (scope.external_textbook_id if scope else None),
        'catalogOccurrences': evidence.get('catalogOccurrences', []),
        'sourceObservedAt': evidence.get('sourceObservedAt'),
        'owner': ownership['owner'],
        'ownerLabel': OWNER_LABELS[ownership['owner']],
        'impactScope': ownership['impactScope'],
        'impactScopeLabel': SCOPE_LABELS.get(ownership['impactScope'], ownership['impactScope']),
    }


STOP_CAUSE_LABELS = {
    'user_pause': '用户暂停计划',
    'user_end': '用户结束本次同步',
    'user_cancel': '用户停止任务',
    'resource': '主机资源不足，安全停止',
    'service_restart': '服务重启或部署，安全停止',
    'source_verification': '来源需要验证',
}


def stop_cause(options, status, message, *, was_cancelling=False):
    """Why a collection stopped (spec E15): a signal alone is not a fault.

    User intent recorded on the task wins, then resource and source causes
    found in the stop message; a bare SIGTERM/SIGINT with no recorded intent
    is a service restart or deployment, handled by the program.
    """
    if status not in ('interrupted', 'cancelled', 'blocked'):
        return None
    options = options or {}
    text = str(message or '')
    if options.get('planWorkEnded'):
        cause = 'user_end'
    elif options.get('planWorkPaused'):
        cause = 'user_pause'
    elif was_cancelling or status == 'cancelled':
        cause = 'user_cancel'
    elif any(word in text for word in ('内存', '磁盘', 'resource_pressure', 'disk')):
        cause = 'resource'
    elif any(word in text for word in ('验证', '防护', 'captcha')):
        cause = 'source_verification'
    elif any(word in text for word in ('SIGTERM', 'SIGINT', 'stop_requested', '安全点停止')):
        cause = 'service_restart'
    else:
        return None
    signal = next((s for s in ('SIGTERM', 'SIGINT') if s in text), None)
    return {'cause': cause, 'label': STOP_CAUSE_LABELS[cause], 'signal': signal,
            'operator': options.get('planActionBy'), 'message': text[:300] or None}
