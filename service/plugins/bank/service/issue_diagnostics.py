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
    if any(word in (root or '').lower() for word in ('验证码', '防护', '验证页面', 'http 429')):
        action = '先在采集器浏览器处理来源验证，或等待来源冷却结束，再从任务详情重新采集。'
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
    }
