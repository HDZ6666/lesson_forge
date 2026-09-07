import { unwrapResponse } from './response.js'

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== ''

export function firstTaskField(value, keys, fallback = undefined) {
  if (!value || typeof value !== 'object') return fallback
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key]
  }
  return fallback
}

const numberOrZero = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

const booleanValue = (value, fallback = undefined) => {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return ![false, 0, '0', 'false', 'False', 'FALSE', 'no', 'NO', 'disabled'].includes(value)
}

const statusAliases = {
  pending: 'queued',
  waiting: 'queued',
  queued: 'queued',
  starting: 'starting',
  running: 'running',
  in_progress: 'running',
  inprogress: 'running',
  cancelling: 'cancelling',
  cancel_requested: 'cancelling',
  completed: 'completed',
  complete: 'completed',
  success: 'completed',
  succeeded: 'completed',
  failed: 'failed',
  error: 'failed',
  blocked: 'blocked',
  interrupted: 'interrupted',
  interruption: 'interrupted',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  stopped: 'cancelled',
}

export const syncTaskStatusOptions = [
  { value: 'queued', label: '排队中', type: 'info' },
  { value: 'starting', label: '启动中', type: 'info' },
  { value: 'running', label: '采集中', type: 'warning' },
  { value: 'cancelling', label: '停止中', type: 'warning' },
  { value: 'interrupted', label: '采集中断', type: 'warning' },
  { value: 'completed', label: '采集完成', type: 'success' },
  { value: 'failed', label: '采集失败', type: 'danger' },
  { value: 'blocked', label: '已阻断', type: 'danger' },
  { value: 'cancelled', label: '已停止', type: 'info' },
]

export function normalizeSyncTaskStatus(value, fallback = 'queued') {
  if (!hasValue(value)) return fallback
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_')
  return statusAliases[key] || key
}

export function syncTaskStatusMeta(value) {
  const status = normalizeSyncTaskStatus(value, '')
  return syncTaskStatusOptions.find((item) => item.value === status) || {
    value: status,
    label: hasValue(value) ? String(value) : '未知',
    type: 'info',
  }
}

export function isActiveSyncTask(value) {
  return ['queued', 'starting', 'running', 'cancelling'].includes(normalizeSyncTaskStatus(value, ''))
}

export function canCancelSyncTask(value) {
  return ['queued', 'starting', 'running'].includes(normalizeSyncTaskStatus(value, ''))
}

export function canRetrySyncTask(value) {
  return ['failed', 'blocked', 'interrupted', 'cancelled'].includes(normalizeSyncTaskStatus(value, ''))
}

export function canDeleteSyncTask(value) {
  return ['completed', 'failed', 'blocked', 'interrupted', 'cancelled'].includes(normalizeSyncTaskStatus(value, ''))
}

/**
 * A resume always continues the task in place.  Interrupted tasks may expose
 * their normal checkpoint; blocked tasks require an explicit server-projected
 * resumeAvailable=true so a real challenge is never retried blindly.
 */
export function canResumeSyncTask(taskOrStatus) {
  const status = normalizeSyncTaskStatus(
    taskOrStatus && typeof taskOrStatus === 'object'
      ? firstTaskField(taskOrStatus, ['status', 'taskStatus', 'task_status', 'state'], '')
      : taskOrStatus,
    '',
  )
  if (!['interrupted', 'blocked'].includes(status)) return false
  if (!taskOrStatus || typeof taskOrStatus !== 'object') return status === 'interrupted'
  const explicit = firstTaskField(taskOrStatus, ['resumeAvailable', 'resume_available'], undefined)
  if (status === 'blocked') return booleanValue(explicit, false) === true
  return explicit === undefined ? true : booleanValue(explicit, false)
}

export function textbookApplyActionLabel(task = {}) {
  if (task.isCurrent || task.suggestedAction === 'alreadyApplied') return '已是当前正式版本'
  if (task.suggestedAction === 'rollback') return `回退到任务 ${task.taskNo || task.taskId}`
  if (task.suggestedAction === 'restore') return `恢复任务 ${task.taskNo || task.taskId}`
  return '添加到正式表'
}

export function textbookApplyVerb(task = {}) {
  if (task.suggestedAction === 'rollback') return '回退'
  if (task.suggestedAction === 'restore') return '恢复'
  return '应用'
}

export function textbookTaskMeaning(task = {}) {
  if (task.isCurrent || task.suggestedAction === 'alreadyApplied') return '已应用，当前正式版本'
  if (normalizeSyncTaskStatus(task.status, '') === 'completed') return '采集已完成，当前未作为正式版本'
  return '只抓取，未应用'
}

export function questionApplyActionLabel(task = {}) {
  if (task.isCurrent || task.suggestedAction === 'alreadyApplied') return '已是当前正式题库'
  if (task.suggestedAction === 'rollback') return `回退到任务 ${task.taskNo || task.taskId}`
  if (task.suggestedAction === 'restore') return `恢复任务 ${task.taskNo || task.taskId}`
  return '添加到正式表'
}

export function questionApplyVerb(task = {}) {
  if (task.suggestedAction === 'rollback') return '回退'
  if (task.suggestedAction === 'restore') return '恢复'
  return '应用'
}

export function questionTaskMeaning(task = {}) {
  if (normalizeSyncTaskStatus(task.status, '') === 'blocked' && task.resumeAvailable) return '已保留完整页断点，确认风控已解除后可续采'
  if (normalizeSyncTaskStatus(task.status, '') === 'interrupted') return '已有快照和断点保留，可断点续采；也可重试从头创建新任务'
  if (task.isCurrent || task.suggestedAction === 'alreadyApplied') return '已应用，当前正式题库'
  if (normalizeSyncTaskStatus(task.status, '') === 'completed') return '采集已完成，当前未作为正式题库'
  return '只抓取，未应用'
}

const normalizeApplyScope = (item, index = 0) => {
  if (typeof item === 'string' || typeof item === 'number') {
    return { textbookName: String(item), textbookId: '', externalTextbookId: '', currentTaskId: null }
  }
  const value = item && typeof item === 'object' ? item : {}
  const current = firstTaskField(value, ['current', 'currentScope', 'current_scope'], {})
  const currentValue = current && typeof current === 'object' ? current : {}
  const textbookId = firstTaskField(value, ['textbookId', 'textbook_id', 'localTextbookId', 'local_textbook_id', 'id'], firstTaskField(currentValue, ['textbookId', 'textbook_id', 'id'], ''))
  const externalTextbookId = firstTaskField(value, ['externalTextbookId', 'external_textbook_id', 'textbookExternalId', 'textbook_external_id'], firstTaskField(currentValue, ['externalTextbookId', 'external_textbook_id'], ''))
  const textbookName = firstTaskField(value, ['textbookName', 'textbook_name', 'textbookNameSnapshot', 'textbook_name_snapshot', 'name', 'title'], firstTaskField(currentValue, ['textbookName', 'textbook_name', 'name', 'title'], ''))
  return {
    ...value,
    textbookId,
    textbookName: String(textbookName || (textbookId || externalTextbookId ? `教材 ${textbookId || externalTextbookId}` : `教材 ${index + 1}`)),
    externalTextbookId,
    currentTaskId: firstTaskField(value, ['currentTaskId', 'current_task_id', 'taskId', 'task_id'], firstTaskField(currentValue, ['taskId', 'task_id', 'currentTaskId', 'current_task_id'], null)),
    currentTaskName: String(firstTaskField(value, ['currentTaskName', 'current_task_name'], firstTaskField(currentValue, ['taskName', 'task_name', 'currentTaskName', 'current_task_name'], '')) || ''),
    currentCollectorRunId: firstTaskField(value, ['currentCollectorRunId', 'current_collector_run_id'], firstTaskField(currentValue, ['collectorRunId', 'collector_run_id', 'currentCollectorRunId', 'current_collector_run_id'], null)),
    currentSnapshotHash: firstTaskField(value, ['currentSnapshotHash', 'current_snapshot_hash', 'snapshotHash', 'snapshot_hash'], firstTaskField(currentValue, ['snapshotHash', 'snapshot_hash'], null)),
    stateToken: firstTaskField(value, ['stateToken', 'state_token', 'currentStateToken', 'current_state_token'], firstTaskField(currentValue, ['stateToken', 'state_token'], null)),
    isCurrent: booleanValue(firstTaskField(value, ['isCurrent', 'is_current'], firstTaskField(currentValue, ['isCurrent', 'is_current'], undefined)), undefined),
    willReplace: booleanValue(firstTaskField(value, ['willReplace', 'will_replace', 'replacesCurrent', 'replaces_current', 'affected'], undefined), undefined),
  }
}

const normalizeApplyScopes = (value) => {
  if (Array.isArray(value)) return value.map(normalizeApplyScope)
  if (value && typeof value === 'object') return [normalizeApplyScope(value)]
  return []
}

function applyStatusOf(task = {}) {
  const value = firstTaskField(task, ['applyStatus', 'apply_status'], {})
  return value && typeof value === 'object' ? value : {}
}

/**
 * Return the textbook names whose formal question snapshots can be replaced.
 * The service may return an explicit affected scope; older projections only
 * expose the current task ID and the selected task scopes, which is still
 * sufficient to explain the replacement before confirmation.
 */
export function questionApplyAffectedTextbooks(task = {}) {
  const status = applyStatusOf(task)
  const explicit = firstTaskField(status, [
    'affectedTextbooks', 'affected_textbooks', 'affectedScopes', 'affected_scopes',
    'affectedScope', 'affected_scope', 'affectedTextbookNames', 'affected_textbook_names',
    'scopeItems', 'scope_items', 'scopes', 'scope',
  ], firstTaskField(task, [
    'affectedTextbooks', 'affected_textbooks', 'affectedScopes', 'affected_scopes',
    'affectedScope', 'affected_scope', 'affectedTextbookNames', 'affected_textbook_names',
  ], undefined))
  const current = firstTaskField(status, ['current', 'currentScope', 'current_scope', 'currentScopes', 'current_scopes'], undefined)
  const currentTaskId = firstTaskField(status, ['currentTaskId', 'current_task_id'], firstTaskField(task, ['currentTaskId', 'current_task_id'], null))
  const source = explicit !== undefined
    ? normalizeApplyScopes(explicit)
    : current !== undefined
      ? normalizeApplyScopes(current)
      : currentTaskId !== null && currentTaskId !== undefined
        ? normalizeApplyScopes(task.scopeItems)
        : []
  const unique = new Map()
  source.forEach((item) => {
    const key = String(item.textbookId || item.externalTextbookId || item.textbookName || '')
    if (key && !unique.has(key)) unique.set(key, item.textbookName)
  })
  return [...unique.values()]
}

export function questionApplyCurrentTaskId(task = {}) {
  const status = applyStatusOf(task)
  const current = firstTaskField(status, ['current', 'currentScope', 'current_scope'], {})
  return firstTaskField(status, ['currentTaskId', 'current_task_id'], firstTaskField(task, ['currentTaskId', 'current_task_id'], firstTaskField(current, ['taskId', 'task_id', 'currentTaskId', 'current_task_id'], null)))
}

/**
 * Return the per-textbook optimistic concurrency token emitted by the
 * question apply status projection.  A multi-textbook task cannot safely use
 * one currentTaskId: each textbook may have been switched by a different
 * task.  Keep a string token compatible with single-scope responses and
 * otherwise return a map keyed by externalTextbookId (or local textbook ID).
 */
export function questionApplyStateToken(task = {}) {
  const status = applyStatusOf(task)
  const explicit = firstTaskField(status, [
    'expectedStateToken', 'expected_state_token', 'currentStateToken', 'current_state_token',
    'stateToken', 'state_token', 'stateTokens', 'state_tokens',
  ], firstTaskField(task, [
    'expectedStateToken', 'expected_state_token', 'currentStateToken', 'current_state_token',
    'stateToken', 'state_token', 'stateTokens', 'state_tokens',
  ], undefined))
  if (typeof explicit === 'string' && explicit.trim()) return explicit
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) return { ...explicit }
  const scopes = normalizeApplyScopes(firstTaskField(status, [
    'scopes', 'scopeItems', 'scope_items', 'affectedScopes', 'affected_scopes',
    'affectedTextbooks', 'affected_textbooks', 'scope',
  ], firstTaskField(task, ['scopeItems', 'scope_items', 'scopes'], [])))
  const tokens = {}
  scopes.forEach((scope) => {
    const key = String(scope.externalTextbookId || scope.textbookId || '')
    if (!key || scope.stateToken === undefined || scope.stateToken === '') return
    if (scope.stateToken === null && scopes.length === 1) return
    tokens[key] = scope.stateToken ?? null
  })
  return Object.keys(tokens).length ? tokens : null
}

export function questionApplyCurrentTaskSummary(task = {}) {
  const status = applyStatusOf(task)
  const scopes = normalizeApplyScopes(firstTaskField(status, [
    'scopes', 'scopeItems', 'scope_items', 'affectedScopes', 'affected_scopes',
    'affectedTextbooks', 'affected_textbooks',
  ], firstTaskField(task, ['scopes', 'scopeItems', 'scope_items'], [])))
  const values = scopes
    .filter((scope) => scope.currentTaskId !== null && scope.currentTaskId !== undefined)
    .map((scope) => `${scope.textbookName}：任务 ${scope.currentTaskId}`)
  if (values.length) return values.join('；')
  const current = questionApplyCurrentTaskId(task)
  return current === null || current === undefined ? '尚未应用' : `任务 ${current}`
}

export function questionApplyWillReplace(task = {}) {
  const status = applyStatusOf(task)
  const explicit = firstTaskField(status, ['willReplace', 'will_replace', 'replacesCurrent', 'replaces_current', 'hasCurrent', 'has_current'], firstTaskField(task, ['willReplace', 'will_replace', 'replacesCurrent', 'replaces_current'], undefined))
  if (explicit !== undefined && explicit !== null) return booleanValue(explicit, false)
  if (questionApplyCurrentTaskId(task) !== null && questionApplyCurrentTaskId(task) !== undefined) return true
  const scopes = normalizeApplyScopes(firstTaskField(status, ['affectedTextbooks', 'affected_textbooks', 'affectedScopes', 'affected_scopes', 'affectedScope', 'affected_scope', 'scopeItems', 'scope_items', 'scopes', 'scope'], firstTaskField(task, ['scopeItems', 'scope_items', 'scopes'], [])))
  return scopes.some((item) => item.isCurrent === true || item.willReplace === true || item.currentTaskId !== null && item.currentTaskId !== undefined)
}

const statValues = (value = {}) => {
  if (typeof value === 'number' || typeof value === 'string') {
    return { inserted: numberOrZero(value), updated: 0, unchanged: 0, disabled: 0 }
  }
  const values = value && typeof value === 'object' ? value : {}
  return {
    inserted: numberOrZero(firstTaskField(values, ['inserted', 'created', 'added', 'new', 'insertedCount', 'createdCount', 'addedCount'], 0)),
    updated: numberOrZero(firstTaskField(values, ['updated', 'changed', 'modified', 'updatedCount', 'changedCount'], 0)),
    unchanged: numberOrZero(firstTaskField(values, ['unchanged', 'same', 'unchangedCount', 'sameCount'], 0)),
    disabled: numberOrZero(firstTaskField(values, ['disabled', 'deleted', 'removed', 'disabledCount', 'deletedCount'], 0)),
  }
}

/** Format question apply response statistics for the same success alert used by textbook apply. */
export function formatQuestionApplyStats(result = {}) {
  const stats = firstTaskField(result, ['stats', 'statistics', 'counts'], {}) || {}
  const getGroup = (keys) => firstTaskField(stats, keys, firstTaskField(result, keys, {}))
  const formatGroup = (label, values) => {
    const normalized = statValues(values)
    return `${label}：新增 ${normalized.inserted}，更新 ${normalized.updated}，未变 ${normalized.unchanged}，禁用 ${normalized.disabled}`
  }
  const names = questionApplyAffectedTextbooks(result)
  const scope = firstTaskField(result, ['affectedTextbooks', 'affected_textbooks', 'affectedScopes', 'affected_scopes', 'affectedScope', 'affected_scope'], undefined)
  const fallbackCount = Array.isArray(scope) ? scope.length : scope && typeof scope === 'object' ? 1 : numberOrZero(firstTaskField(result, ['affectedTextbookCount', 'affected_textbook_count'], 0))
  const affected = names.length ? names.join('、') : (fallbackCount ? `${fallbackCount} 本教材` : '无')
  return [
    formatGroup('目录', getGroup(['catalogs', 'catalog', 'catalogNodes', 'catalog_nodes', 'catalogCount', 'catalog_count'])),
    formatGroup('题目', getGroup(['questions', 'question', 'questionCount', 'question_count'])),
    formatGroup('关系', getGroup(['relations', 'relation', 'memberships', 'questionCatalogRelations', 'question_catalog_relations', 'relationCount', 'relation_count'])),
    formatGroup('标签', getGroup(['tags', 'tag', 'tagCount', 'tag_count'])),
    formatGroup('素材', getGroup(['assets', 'asset', 'materials', 'material', 'assetCount', 'asset_count'])),
    `受影响教材：${affected}`,
  ].join('；')
}

export function formatTextbookApplyStats(result = {}) {
  const stats = result?.stats || {}
  const formatGroup = (label, values = {}) => `${label}：新增 ${numberOrZero(values.inserted)}，更新 ${numberOrZero(values.updated)}，未变 ${numberOrZero(values.unchanged)}，禁用 ${numberOrZero(values.disabled)}`
  return [
    formatGroup('版本', stats.versions || result?.versions),
    formatGroup('教材', stats.textbooks || result?.textbooks),
  ].join('；')
}

const normalizeLogs = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === 'object') return String(firstTaskField(item, ['message', 'text', 'line', 'detail'], '') || '')
      return String(item ?? '')
    }).filter(Boolean).slice(-100)
  }
  if (!hasValue(value)) return []
  return String(value).split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).slice(-100)
}

const flattenLogLines = (logs) => {
  const lines = []
  const source = Array.isArray(logs) ? logs : [logs]
  source.forEach((item) => {
    String(item || '').split(/\r?\n/).forEach((line) => {
      const text = String(line || '').trim()
      if (text) lines.push(text)
    })
  })
  return lines
}

export function parseFetchWindowsFromLogs(logs, slotLimit = 8) {
  const limit = Math.max(1, Number(slotLimit) || 8)
  const rows = []
  flattenLogLines(logs).forEach((text) => {
    const catalogMatch = text.match(/catalog=([^\s]+)/)
    const pageMatch = text.match(/\bpage=(\d+)/)
    if (!catalogMatch || !pageMatch) return
    const questionsMatch = text.match(/\bquestions=(\d+)/)
    const totalMatch = text.match(/\btotal=(\d+|null)/)
    let status = 'saved'
    if (/empty=/.test(text) || /\bempty\b/.test(text)) status = 'empty'
    else if (/duplicate/.test(text)) status = 'duplicate'
    else if (/fail|request_failed|parse_failed/.test(text)) status = 'failed'
    else if (/抓取中/.test(text)) status = 'fetching'
    const catalogExternalId = catalogMatch[1]
    const pageNumber = Number(pageMatch[1])
    const questionCount = questionsMatch ? Number(questionsMatch[1]) : null
    const sourceTotal = !totalMatch || totalMatch[1] === 'null' ? null : Number(totalMatch[1])
    rows.push({
      catalogExternalId,
      pageNumber,
      questionCount,
      sourceTotal,
      status,
      line: `catalog=${catalogExternalId} page=${pageNumber}`
        + (questionCount == null ? '' : ` questions=${questionCount}`)
        + (sourceTotal == null ? '' : ` total=${sourceTotal}`),
    })
  })
  if (!rows.length) return []
  const catalogId = rows[rows.length - 1].catalogExternalId
  const recent = []
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].catalogExternalId !== catalogId) break
    recent.push(rows[index])
    if (recent.length >= limit) break
  }
  recent.reverse()
  const byPage = new Map()
  recent.forEach((row) => { byPage.set(row.pageNumber, row) })
  const unique = [...byPage.values()].sort((left, right) => left.pageNumber - right.pageNumber)
  return [{
    catalogExternalId: catalogId,
    catalogName: catalogId,
    latestSourceTotal: unique[unique.length - 1]?.sourceTotal ?? null,
    slots: unique.map((row, index) => ({
      slot: index + 1,
      pageNumber: row.pageNumber,
      status: row.status,
      questionCount: row.questionCount,
      sourceTotal: row.sourceTotal,
      line: row.line,
    })),
  }]
}

export function resolveVisibleFetchWindows(liveProjection, logs, slotLimit = 8) {
  const liveWindows = Array.isArray(liveProjection?.fetchWindows)
    ? liveProjection.fetchWindows.filter((window) => Array.isArray(window?.slots) && window.slots.length)
    : []
  if (liveWindows.length) return liveWindows
  return parseFetchWindowsFromLogs(logs, slotLimit)
}

const numberOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

const normalizeLiveTreeNode = (item, index = 0, depth = 0) => {
  if (!item || typeof item !== 'object' || depth > 100) return null
  const externalId = String(firstTaskField(item, ['externalId', 'externalCatalogId', 'catalogExternalId', 'catalog_external_id', 'id'], '') || '')
  const name = String(firstTaskField(item, ['label', 'name', 'title'], externalId || `目录 ${index + 1}`) || externalId || `目录 ${index + 1}`)
  const rawChildren = firstTaskField(item, ['children', 'nodes', 'items'], [])
  const children = Array.isArray(rawChildren)
    ? rawChildren.map((child, childIndex) => normalizeLiveTreeNode(child, childIndex, depth + 1)).filter(Boolean)
    : []
  const expectedTotal = numberOrNull(firstTaskField(item, ['latestSourceTotal', 'sourceReportedTotal', 'expectedTotal', 'expected', 'total', 'expected_total'], null))
  const uniqueQuestionCount = numberOrZero(firstTaskField(item, ['uniqueQuestionCount', 'collectedCount', 'collected', 'questionCount', 'question_count'], 0))
  const occurrenceCount = numberOrZero(firstTaskField(item, ['occurrenceCount', 'listSeenCount', 'list_seen_count'], uniqueQuestionCount))
  return {
    ...item,
    nodeKey: String(firstTaskField(item, ['nodeKey', 'node_key'], externalId || `live-node-${index}`) || externalId || `live-node-${index}`),
    externalId,
    externalCatalogId: externalId,
    parentExternalId: firstTaskField(item, ['parentExternalId', 'parent_external_id'], null),
    level: numberOrNull(firstTaskField(item, ['level', 'nodeLevel', 'node_level'], null)),
    nodeLevel: numberOrNull(firstTaskField(item, ['nodeLevel', 'node_level', 'level'], null)),
    name,
    label: name,
    expectedTotal,
    expected: expectedTotal,
    total: expectedTotal,
    latestSourceTotal: expectedTotal,
    sourceReportedTotal: expectedTotal,
    collectedCount: uniqueQuestionCount,
    collected: uniqueQuestionCount,
    uniqueQuestionCount,
    occurrenceCount,
    listSeenCount: occurrenceCount,
    questionCount: uniqueQuestionCount,
    expectedPages: numberOrNull(firstTaskField(item, ['targetPages', 'expectedPages', 'expected_pages', 'target_pages'], null)),
    targetPages: numberOrNull(firstTaskField(item, ['targetPages', 'target_pages', 'expectedPages', 'expected_pages'], null)),
    attemptedPages: numberOrZero(firstTaskField(item, ['attemptedPages', 'attempted_pages'], 0)),
    lastCompletedPage: numberOrZero(firstTaskField(item, ['lastCompletedPage', 'last_completed_page'], 0)),
    highestAttemptedPage: numberOrZero(firstTaskField(item, ['highestAttemptedPage', 'highest_attempted_page'], 0)),
    failedPageCount: numberOrZero(firstTaskField(item, ['failedPageCount', 'failed_page_count'], 0)),
    duplicatePageCount: numberOrZero(firstTaskField(item, ['duplicatePageCount', 'duplicate_page_count'], 0)),
    emptyPageCount: numberOrZero(firstTaskField(item, ['emptyPageCount', 'empty_page_count'], 0)),
    parseErrorCount: numberOrZero(firstTaskField(item, ['parseErrorCount', 'parse_error_count'], 0)),
    assetErrorCount: numberOrZero(firstTaskField(item, ['assetErrorCount', 'asset_error_count'], 0)),
    scanComplete: booleanValue(firstTaskField(item, ['scanComplete', 'scan_complete'], false), false),
    dataComplete: booleanValue(firstTaskField(item, ['dataComplete', 'data_complete'], true), true),
    completionQuality: firstTaskField(item, ['completionQuality', 'completion_quality'], null),
    status: String(firstTaskField(item, ['status', 'state'], 'pending') || 'pending'),
    queried: booleanValue(firstTaskField(item, ['queried', 'hasProgress', 'has_progress'], expectedTotal !== null), expectedTotal !== null),
    hasProgress: booleanValue(firstTaskField(item, ['hasProgress', 'has_progress', 'queried'], expectedTotal !== null), expectedTotal !== null),
    children,
  }
}

const normalizeLiveProjection = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rawTree = firstTaskField(value, ['tree', 'catalogs', 'catalogTree', 'catalog_tree'], [])
  const tree = Array.isArray(rawTree)
    ? rawTree.map((item, index) => normalizeLiveTreeNode(item, index)).filter(Boolean).slice(0, 1000)
    : []
  const totalQuestionCount = numberOrNull(firstTaskField(value, ['totalQuestionCount', 'expectedQuestionCount', 'total_question_count', 'expected_question_count'], null))
  const collectedQuestionCount = numberOrNull(firstTaskField(value, ['collectedQuestionCount', 'uniqueQuestionCount', 'listSeenCount', 'collected_question_count', 'unique_question_count', 'list_seen_count'], null))
  const progressPercent = numberOrNull(firstTaskField(value, ['progressPercent', 'progress_percent', 'progress'], null))
  const rawWindows = firstTaskField(value, ['fetchWindows', 'fetch_windows'], [])
  const fetchWindows = Array.isArray(rawWindows)
    ? rawWindows.map((window, index) => {
      const catalogExternalId = String(firstTaskField(window, ['catalogExternalId', 'catalog_external_id'], '') || '')
      const slots = Array.isArray(window?.slots) ? window.slots.map((slot, slotIndex) => ({
        slot: numberOrZero(firstTaskField(slot, ['slot', 'workerId', 'worker_id'], slotIndex + 1)),
        pageNumber: numberOrNull(firstTaskField(slot, ['pageNumber', 'page_number', 'currentPage'], null)),
        status: String(firstTaskField(slot, ['status', 'slot_status'], 'fetching') || 'fetching'),
        questionCount: numberOrNull(firstTaskField(slot, ['questionCount', 'question_count'], null)),
        resultType: firstTaskField(slot, ['resultType', 'result_type'], null),
        sourceTotal: numberOrNull(firstTaskField(slot, ['sourceTotal', 'source_total', 'latestSourceTotal'], null)),
        line: String(firstTaskField(slot, ['line', 'message'], '') || ''),
        updatedAt: firstTaskField(slot, ['updatedAt', 'updated_at'], null),
      })) : []
      return {
        catalogExternalId,
        catalogName: String(firstTaskField(window, ['catalogName', 'catalog_name', 'name'], catalogExternalId || `窗口 ${index + 1}`) || ''),
        catalogPath: firstTaskField(window, ['catalogPath', 'catalog_path'], null),
        targetPages: numberOrNull(firstTaskField(window, ['targetPages', 'target_pages'], null)),
        latestSourceTotal: numberOrNull(firstTaskField(window, ['latestSourceTotal', 'sourceReportedTotal', 'expectedTotal'], null)),
        updatedAt: firstTaskField(window, ['updatedAt', 'updated_at'], null),
        slots,
      }
    }).filter((window) => window.slots.length)
    : []
  const normalizedValue = Object.fromEntries(Object.entries(value).filter(([key]) => (
    !['tree', 'catalogs', 'catalogTree', 'catalog_tree'].includes(key)
  )))
  return {
    ...normalizedValue,
    available: booleanValue(firstTaskField(value, ['available'], true), true),
    live: booleanValue(firstTaskField(value, ['live'], true), true),
    totalQuestionCount,
    expectedQuestionCount: totalQuestionCount,
    collectedQuestionCount,
    uniqueQuestionCount: collectedQuestionCount,
    listSeenCount: collectedQuestionCount,
    progressPercent,
    progress: progressPercent,
    // Page-based progress basis (collector >= 2026-09-07): lets the page show
    // "已扫描 X / 约 Y 页 · 目录 m/n" instead of a bare percentage.
    attemptedPages: numberOrNull(firstTaskField(value, ['attemptedPages', 'attempted_pages'], null)),
    estimatedTotalPages: numberOrNull(firstTaskField(value, ['estimatedTotalPages', 'estimated_total_pages'], null)),
    estimateComplete: booleanValue(firstTaskField(value, ['estimateComplete', 'estimate_complete'], true), true),
    selectedCatalogCount: numberOrNull(firstTaskField(value, ['selectedCatalogCount', 'selected_catalog_count'], null)),
    startedCatalogCount: numberOrNull(firstTaskField(value, ['startedCatalogCount', 'started_catalog_count'], null)),
    completedCatalogCount: numberOrNull(firstTaskField(value, ['completedCatalogCount', 'completed_catalog_count'], null)),
    scanComplete: booleanValue(firstTaskField(value, ['scanComplete', 'scan_complete'], false), false),
    dataComplete: booleanValue(firstTaskField(value, ['dataComplete', 'data_complete'], true), true),
    completionQuality: firstTaskField(value, ['completionQuality', 'completion_quality'], null),
    snapshotComplete: booleanValue(firstTaskField(value, ['snapshotComplete', 'snapshot_complete'], false), false),
    firstRoundComplete: booleanValue(firstTaskField(value, ['firstRoundComplete', 'first_round_complete'], totalQuestionCount !== null), totalQuestionCount !== null),
    totalsKnown: booleanValue(firstTaskField(value, ['totalsKnown', 'totals_known'], totalQuestionCount !== null), totalQuestionCount !== null),
    statisticsPending: booleanValue(firstTaskField(value, ['statisticsPending', 'statistics_pending'], totalQuestionCount === null), totalQuestionCount === null),
    chapterCount: numberOrZero(firstTaskField(value, ['chapterCount', 'chapter_count'], 0)),
    knowledgePointCount: numberOrZero(firstTaskField(value, ['knowledgePointCount', 'knowledge_point_count'], 0)),
    secondaryKnowledgePointCount: numberOrZero(firstTaskField(value, ['secondaryKnowledgePointCount', 'secondary_knowledge_point_count'], 0)),
    catalogCount: numberOrZero(firstTaskField(value, ['catalogCount', 'catalog_count'], tree.length)),
    tree,
    fetchWindows,
  }
}

const unwrapNestedTask = (response) => {
  let value = unwrapResponse(response)
  for (let index = 0; index < 4; index += 1) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) break
    const nested = firstTaskField(value, ['task', 'job', 'run', 'item'], undefined)
    if (nested && typeof nested === 'object') {
      value = nested
      continue
    }
    break
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

const normalizeScopeItem = (item = {}, index = 0) => {
  const value = item && typeof item === 'object' ? item : {}
  const textbookId = firstTaskField(value, ['textbookId', 'textbook_id', 'localTextbookId', 'local_textbook_id', 'id'], '')
  const textbookName = firstTaskField(value, ['textbookName', 'textbook_name', 'textbookNameSnapshot', 'textbook_name_snapshot', 'name', 'nameSnapshot', 'name_snapshot', 'title'], '')
  return {
    ...value,
    scopeId: firstTaskField(value, ['scopeId', 'scope_id', 'jobScopeId', 'job_scope_id'], ''),
    textbookId,
    textbookName: String(textbookName || (hasValue(textbookId) ? `教材 ${textbookId}` : `教材 ${index + 1}`)),
    versionId: firstTaskField(value, ['versionId', 'version_id', 'localVersionId', 'local_version_id'], ''),
    versionName: String(firstTaskField(value, ['versionName', 'version_name', 'versionNameSnapshot', 'version_name_snapshot'], '') || ''),
    sourceProvider: String(firstTaskField(value, ['sourceProvider', 'source_provider', 'provider'], '') || ''),
    externalVersionId: String(firstTaskField(value, ['externalVersionId', 'external_version_id'], '') || ''),
    externalTextbookId: String(firstTaskField(value, ['externalTextbookId', 'external_textbook_id', 'textbookExternalId', 'textbook_external_id'], '') || ''),
    resumeFromCollectorRunId: firstTaskField(value, ['resumeFromCollectorRunId', 'resume_from_collector_run_id'], '') ?? '',
    // `runId` identifies the parent Service task on the scope projection;
    // never present it as the immutable per-textbook collector snapshot ID.
    collectorRunId: firstTaskField(value, ['collectorRunId', 'collector_run_id', 'contentRunId', 'content_run_id'], '') ?? '',
    status: normalizeSyncTaskStatus(firstTaskField(value, ['status', 'state'], ''), ''),
    catalogCount: numberOrZero(firstTaskField(value, ['catalogCount', 'catalog_count', 'nodeCount', 'node_count'], 0)),
    questionCount: numberOrZero(firstTaskField(value, ['questionCount', 'question_count'], 0)),
    newCatalogCount: numberOrZero(firstTaskField(value, ['newCatalogCount', 'new_catalog_count', 'addedCatalogCount', 'added_catalog_count'], 0)),
    changedCatalogCount: numberOrZero(firstTaskField(value, ['changedCatalogCount', 'changed_catalog_count', 'updatedCatalogCount', 'updated_catalog_count'], 0)),
    newQuestionCount: numberOrZero(firstTaskField(value, ['newQuestionCount', 'new_question_count', 'addedQuestionCount', 'added_question_count'], 0)),
    changedQuestionCount: numberOrZero(firstTaskField(value, ['changedQuestionCount', 'changed_question_count', 'updatedQuestionCount', 'updated_question_count'], 0)),
    relationCount: numberOrZero(firstTaskField(value, ['relationCount', 'relation_count', 'questionRelationCount', 'question_relation_count', 'questionCatalogCount', 'question_catalog_count', 'membershipCount', 'membership_count'], 0)),
    tagCount: numberOrZero(firstTaskField(value, ['tagCount', 'tag_count', 'questionTagCount', 'question_tag_count'], 0)),
    assetCount: numberOrZero(firstTaskField(value, ['assetCount', 'asset_count', 'questionAssetCount', 'question_asset_count', 'materialCount', 'material_count'], 0)),
    errorMessage: String(firstTaskField(value, ['errorMessage', 'error_message', 'error', 'reason'], '') || ''),
    startedAt: firstTaskField(value, ['startedAt', 'started_at'], ''),
    completedAt: firstTaskField(value, ['completedAt', 'completed_at', 'finishedAt', 'finished_at'], ''),
    liveProgress: normalizeLiveProjection(firstTaskField(value, ['liveProgress', 'live_progress'], null)),
  }
}

const normalizeTaskScopes = (value) => {
  const raw = firstTaskField(value, ['scopeItems', 'scope_items', 'scopes', 'scope', 'textbooks', 'selectedTextbooks', 'selected_textbooks'], [])
  if (Array.isArray(raw)) return raw.map(normalizeScopeItem)
  // Some older Service projections returned one scope object under `scope`
  // instead of an array.  Keep that response usable without ever inventing a
  // second scope or losing its immutable collectorRunId.
  if (raw && typeof raw === 'object') return [normalizeScopeItem(raw)]
  const ids = firstTaskField(value, ['textbookIds', 'textbook_ids'], [])
  const names = firstTaskField(value, ['textbookNames', 'textbook_names'], [])
  if (!Array.isArray(ids)) return []
  return ids.map((textbookId, index) => normalizeScopeItem({ textbookId, textbookName: Array.isArray(names) ? names[index] : '' }, index))
}

export function normalizeSyncTask(response, kind = '') {
  const value = unwrapNestedTask(response)
  const applyStatus = applyStatusOf(value)
  const applyField = (keys, fallback = undefined) => firstTaskField(value, keys, firstTaskField(applyStatus, keys, fallback))
  const taskId = firstTaskField(value, ['taskId', 'task_id', 'jobId', 'job_id', 'runId', 'run_id', 'id'], '')
  const baseScopeItems = normalizeTaskScopes(value)
  const applyScopes = normalizeApplyScopes(firstTaskField(applyStatus, [
    'scopes', 'scopeItems', 'scope_items', 'affectedScopes', 'affected_scopes',
    'affectedTextbooks', 'affected_textbooks',
  ], firstTaskField(value, ['scopes', 'scopeItems', 'scope_items'], [])))
  const scopeItems = baseScopeItems.map((scope) => {
    const key = String(scope.externalTextbookId || scope.textbookId || '')
    const applied = applyScopes.find((item) => (
      String(item.externalTextbookId || '') && String(item.externalTextbookId) === String(scope.externalTextbookId || '')
    ) || (
      String(item.textbookId || '') && String(item.textbookId) === String(scope.textbookId || '')
    ) || String(item.externalTextbookId || item.textbookId || '') === key)
    return applied
      ? {
        ...scope,
        ...applied,
        textbookName: scope.textbookName || applied.textbookName,
        textbookId: scope.textbookId || applied.textbookId,
        externalTextbookId: scope.externalTextbookId || applied.externalTextbookId,
        collectorRunId: applied.collectorRunId ?? scope.collectorRunId,
        status: applied.status || scope.status,
      }
      : scope
  })
  const textbookNames = firstTaskField(value, ['textbookNames', 'textbook_names'], [])
  const progress = Number(firstTaskField(value, ['progressPercent', 'progress_percent', 'progress', 'percent', 'percentage'], 0))
  const status = normalizeSyncTaskStatus(firstTaskField(value, ['status', 'taskStatus', 'task_status', 'state'], ''), hasValue(taskId) ? 'queued' : '')
  const versionName = firstTaskField(value, ['versionName', 'version_name', 'versionNameSnapshot', 'version_name_snapshot'], scopeItems.find((item) => item.versionName)?.versionName || '')
  const liveProgress = normalizeLiveProjection(firstTaskField(value, ['liveProgress', 'live_progress'], null))
  const rawLiveByScope = firstTaskField(value, ['liveProgressByScope', 'live_progress_by_scope'], {})
  const liveProgressByScope = rawLiveByScope && typeof rawLiveByScope === 'object' && !Array.isArray(rawLiveByScope)
    ? Object.fromEntries(Object.entries(rawLiveByScope).slice(0, 200).map(([key, item]) => [key, normalizeLiveProjection(item)]).filter(([, item]) => item))
    : {}
  return {
    ...value,
    taskId: taskId === undefined || taskId === null ? '' : String(taskId),
    taskNo: String(firstTaskField(value, ['taskNo', 'task_no', 'jobNo', 'job_no', 'runNo', 'run_no', 'serialNo', 'serial_no'], taskId || '') || ''),
    taskType: kind || String(firstTaskField(value, ['taskType', 'task_type', 'jobType', 'job_type', 'runType', 'run_type'], '') || ''),
    status,
    progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0,
    metadataRunId: firstTaskField(value, ['metadataRunId', 'metadata_run_id'], ''),
    collectorRunId: firstTaskField(value, ['collectorRunId', 'collector_run_id'], ''),
    fetchedVersionCount: numberOrZero(firstTaskField(value, ['fetchedVersionCount', 'fetched_version_count', 'versionCount', 'version_count', 'totalVersions', 'total_versions'], 0)),
    fetchedTextbookCount: numberOrZero(firstTaskField(value, ['fetchedTextbookCount', 'fetched_textbook_count', 'textbookCount', 'textbook_count', 'totalTextbooks', 'total_textbooks'], scopeItems.length)),
    newVersionCount: numberOrZero(firstTaskField(value, ['newVersionCount', 'new_version_count', 'addedVersionCount', 'added_version_count'], 0)),
    newTextbookCount: numberOrZero(firstTaskField(value, ['newTextbookCount', 'new_textbook_count', 'addedTextbookCount', 'added_textbook_count'], 0)),
    catalogCount: numberOrZero(firstTaskField(value, ['catalogCount', 'catalog_count', 'nodeCount', 'node_count'], scopeItems.reduce((sum, item) => sum + item.catalogCount, 0))),
    newCatalogCount: numberOrZero(firstTaskField(value, ['newCatalogCount', 'new_catalog_count', 'addedCatalogCount', 'added_catalog_count'], scopeItems.reduce((sum, item) => sum + item.newCatalogCount, 0))),
    changedCatalogCount: numberOrZero(firstTaskField(value, ['changedCatalogCount', 'changed_catalog_count', 'updatedCatalogCount', 'updated_catalog_count'], scopeItems.reduce((sum, item) => sum + item.changedCatalogCount, 0))),
    questionCount: numberOrZero(firstTaskField(value, ['questionCount', 'question_count'], scopeItems.reduce((sum, item) => sum + item.questionCount, 0))),
    newQuestionCount: numberOrZero(firstTaskField(value, ['newQuestionCount', 'new_question_count', 'addedQuestionCount', 'added_question_count'], 0)),
    changedQuestionCount: numberOrZero(firstTaskField(value, ['changedQuestionCount', 'changed_question_count', 'updatedQuestionCount', 'updated_question_count'], 0)),
    relationCount: numberOrZero(firstTaskField(value, ['relationCount', 'relation_count', 'questionRelationCount', 'question_relation_count', 'questionCatalogCount', 'question_catalog_count', 'membershipCount', 'membership_count'], scopeItems.reduce((sum, item) => sum + item.relationCount, 0))),
    tagCount: numberOrZero(firstTaskField(value, ['tagCount', 'tag_count', 'questionTagCount', 'question_tag_count'], scopeItems.reduce((sum, item) => sum + item.tagCount, 0))),
    assetCount: numberOrZero(firstTaskField(value, ['assetCount', 'asset_count', 'questionAssetCount', 'question_asset_count', 'materialCount', 'material_count'], scopeItems.reduce((sum, item) => sum + item.assetCount, 0))),
    sourceTaskId: firstTaskField(value, ['sourceTaskId', 'source_task_id'], ''),
    retryOfTaskId: firstTaskField(value, ['retryOfTaskId', 'retry_of_task_id', 'retryOfRunId', 'retry_of_run_id'], ''),
    collectorJobId: firstTaskField(value, ['collectorJobId', 'collector_job_id'], ''),
    resumeAvailable: booleanValue(firstTaskField(value, ['resumeAvailable', 'resume_available'], undefined), undefined),
    resumeFromCollectorRunId: firstTaskField(value, ['resumeFromCollectorRunId', 'resume_from_collector_run_id'], ''),
    autoResumeEnabled: booleanValue(firstTaskField(value, ['autoResumeEnabled', 'auto_resume_enabled'], true), true),
    autoResumeAttempt: numberOrZero(firstTaskField(value, ['autoResumeAttempt', 'auto_resume_attempt'], 0)),
    autoResumeMaxAttempts: numberOrZero(firstTaskField(value, ['autoResumeMaxAttempts', 'auto_resume_max_attempts'], 3)),
    autoResumePending: booleanValue(firstTaskField(value, ['autoResumePending', 'auto_resume_pending'], false), false),
    autoResumeNextAt: firstTaskField(value, ['autoResumeNextAt', 'auto_resume_next_at'], ''),
    versionId: firstTaskField(value, ['versionId', 'version_id', 'localVersionId', 'local_version_id'], scopeItems[0]?.versionId || ''),
    versionName: String(versionName || ''),
    scopeItems,
    textbookNames: Array.isArray(textbookNames) ? textbookNames.map(String) : scopeItems.map((item) => item.textbookName),
    textbookCount: numberOrZero(firstTaskField(value, ['selectedTextbookCount', 'selected_textbook_count', 'textbookCount', 'textbook_count'], scopeItems.length)),
    currentTextbookId: firstTaskField(value, ['currentTextbookId', 'current_textbook_id'], ''),
    currentTextbookName: String(firstTaskField(value, ['currentTextbookName', 'current_textbook_name', 'currentTextbook', 'current_textbook'], '') || ''),
    createdBy: String(firstTaskField(value, ['createdBy', 'created_by', 'createBy', 'create_by', 'creatorName', 'creator_name'], '') || ''),
    createTime: firstTaskField(value, ['createTime', 'create_time', 'createdAt', 'created_at'], ''),
    startedAt: firstTaskField(value, ['startedAt', 'started_at', 'startTime', 'start_time'], ''),
    completedAt: firstTaskField(value, ['completedAt', 'completed_at', 'finishedAt', 'finished_at', 'finishTime', 'finish_time'], ''),
    errorMessage: String(firstTaskField(value, ['errorMessage', 'error_message', 'failureReason', 'failure_reason', 'error', 'reason'], '') || ''),
    logs: normalizeLogs(firstTaskField(value, ['logs', 'logTail', 'log_tail', 'log', 'messages'], [])),
    applyStatus,
    applyScopes,
    eligible: booleanValue(applyField(['eligible'], false), false),
    isCurrent: booleanValue(applyField(['isCurrent', 'is_current'], false), false),
    currentTaskId: applyField(['currentTaskId', 'current_task_id'], null),
    currentMetadataRunId: applyField(['currentMetadataRunId', 'current_metadata_run_id'], null),
    currentSnapshotHash: String(applyField(['currentSnapshotHash', 'current_snapshot_hash'], '') || ''),
    appliedAt: applyField(['appliedAt', 'applied_at'], ''),
    suggestedAction: String(applyField(['suggestedAction', 'suggested_action', 'action'], '') || ''),
    eligibilityMessage: String(applyField(['eligibilityMessage', 'eligibility_message', 'reason'], '') || ''),
    currentStateToken: questionApplyStateToken({ ...value, applyStatus }),
    liveProgress,
    liveProgressByScope,
  }
}

export function unwrapSyncTask(response, kind = '') {
  const task = normalizeSyncTask(response, kind)
  return task.taskId ? task : null
}

export function unwrapSyncTaskPage(response, kind = '') {
  let value = unwrapResponse(response)
  if (Array.isArray(value)) return { rows: value.map((item) => normalizeSyncTask(item, kind)), total: value.length }
  if (!value || typeof value !== 'object') return { rows: [], total: 0 }
  const page = value.page && typeof value.page === 'object' ? value.page : {}
  const rawRows = firstTaskField(value, ['rows', 'list', 'records', 'items', 'tasks', 'jobs'], firstTaskField(page, ['rows', 'list', 'records', 'items'], []))
  const rows = Array.isArray(rawRows) ? rawRows.map((item) => normalizeSyncTask(item, kind)) : []
  return {
    rows,
    total: numberOrZero(firstTaskField(value, ['total', 'totalCount', 'total_count', 'count'], firstTaskField(page, ['total', 'totalCount', 'total_count'], rows.length))),
  }
}

const explicitDisabledReason = (value) => String(firstTaskField(value, ['disabledReason', 'disabled_reason', 'unavailableReason', 'unavailable_reason', 'reason'], '') || '')

function optionAvailability(value, type) {
  const explicitEnabled = booleanValue(firstTaskField(value, ['selectable', 'syncable', 'available', 'enabled'], undefined), undefined)
  const explicitDisabled = booleanValue(firstTaskField(value, ['disabled'], undefined), undefined)
  const provider = String(firstTaskField(value, ['sourceProvider', 'source_provider', 'provider'], '') || '')
  const externalId = String(firstTaskField(value, type === 'version'
    ? ['externalVersionId', 'external_version_id', 'versionExternalId', 'version_external_id']
    : ['externalTextbookId', 'external_textbook_id', 'textbookExternalId', 'textbook_external_id'], '') || '')
  let disabled = explicitEnabled === false || explicitDisabled === true
  let reason = explicitDisabledReason(value)
  if (!disabled && (!provider || provider.toLowerCase() === 'manual' || !externalId)) {
    disabled = true
    reason ||= '缺少采集来源标识'
  }
  return { disabled, reason, provider, externalId }
}

const normalizeQuestionOptionTextbook = (item = {}, version = {}) => {
  const availability = optionAvailability(item, 'textbook')
  const textbookId = firstTaskField(item, ['textbookId', 'textbook_id', 'id'], '')
  return {
    ...item,
    textbookId,
    textbookName: String(firstTaskField(item, ['textbookName', 'textbook_name', 'name', 'displayName', 'display_name', 'title'], textbookId ? `教材 ${textbookId}` : '未命名教材') || ''),
    versionId: firstTaskField(item, ['versionId', 'version_id'], firstTaskField(version, ['versionId', 'version_id', 'id'], '')),
    sourceProvider: availability.provider,
    externalTextbookId: availability.externalId,
    disabled: availability.disabled,
    disabledReason: availability.reason,
    grade: String(firstTaskField(item, ['grade'], '') || ''),
    volume: String(firstTaskField(item, ['volume'], '') || ''),
  }
}

export function normalizeQuestionSyncOptions(response) {
  const value = unwrapResponse(response)
  if (!value || typeof value !== 'object') return { versions: [] }
  const rawVersions = Array.isArray(value) ? value : firstTaskField(value, ['versions', 'versionList', 'version_list', 'rows', 'items'], [])
  const flatTextbooks = Array.isArray(firstTaskField(value, ['textbooks', 'textbookList', 'textbook_list'], []))
    ? firstTaskField(value, ['textbooks', 'textbookList', 'textbook_list'], [])
    : []
  const versions = (Array.isArray(rawVersions) ? rawVersions : []).map((item) => {
    const availability = optionAvailability(item, 'version')
    const versionId = firstTaskField(item, ['versionId', 'version_id', 'id'], '')
    const nested = firstTaskField(item, ['textbooks', 'textbookList', 'textbook_list', 'children'], [])
    const textbooks = (Array.isArray(nested) ? nested : flatTextbooks.filter((book) => String(firstTaskField(book, ['versionId', 'version_id'], '')) === String(versionId)))
      .map((book) => normalizeQuestionOptionTextbook(book, item))
    const disabled = availability.disabled || !textbooks.some((book) => !book.disabled)
    return {
      ...item,
      versionId,
      versionName: String(firstTaskField(item, ['versionName', 'version_name', 'name', 'title'], versionId ? `版本 ${versionId}` : '未命名版本') || ''),
      sourceProvider: availability.provider,
      externalVersionId: availability.externalId,
      disabled,
      disabledReason: availability.reason || (disabled && textbooks.length ? '该版本下暂无可同步教材' : ''),
      textbooks,
    }
  })
  return { versions }
}

export function syncTaskErrorMessage(error, fallback = '任务请求失败，请稍后重试') {
  if (typeof error === 'string' && error.trim() && error !== 'error') return error
  const response = error?.response?.data
  const detail = response?.detail
  if (typeof response?.msg === 'string' && response.msg.trim()) return response.msg
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => item?.msg || item?.message).filter(Boolean)
    if (messages.length) return messages.join('；')
  }
  return error?.message || fallback
}

export function formatTaskTime(value) {
  if (!hasValue(value)) return '—'
  return String(value).replace('T', ' ').replace(/\.\d+([+-]\d\d:\d\d|Z)?$/, '')
}
