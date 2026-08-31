/**
 * Normalize the long-running collector task contract for the sync panel.
 *
 * The backend uses camelCase in its public models, while this helper also
 * accepts snake_case and the usual RuoYi data envelope. That keeps polling
 * resilient while the task record evolves without spreading field aliases
 * through the view.
 */

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== ''

const firstDefined = (value, keys, fallback) => {
  if (!value || typeof value !== 'object') return fallback
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key]
  }
  return fallback
}

const sourcesOf = (value) => {
  if (!value || typeof value !== 'object') return []
  return [
    value,
    value.progress,
    value.statistics,
    value.stats,
    value.counts,
    value.summary,
    value.phaseProgress,
    value.phase_progress,
  ].filter((item) => item && typeof item === 'object')
}

const firstDeep = (value, keys, fallback = undefined) => {
  for (const source of sourcesOf(value)) {
    const result = firstDefined(source, keys, undefined)
    if (result !== undefined && result !== null) return result
  }
  return fallback
}

const numberOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

const numberFrom = (value, keys) => numberOrNull(firstDeep(value, keys))

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

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
  cancelled: 'cancelled',
  canceled: 'cancelled',
  stopped: 'cancelled',
}

const phaseAliases = {
  metadata: 'metadata',
  meta: 'metadata',
  discover: 'metadata',
  discovery: 'metadata',
  catalogs_questions: 'catalogs_questions',
  catalog_questions: 'catalogs_questions',
  catalogs: 'catalogs_questions',
  questions: 'catalogs_questions',
  scrape: 'catalogs_questions',
  fetching: 'catalogs_questions',
  completed: 'completed',
  complete: 'completed',
  failed: 'failed',
  blocked: 'blocked',
  cancelled: 'cancelled',
  canceled: 'cancelled',
}

export const syncRunPhaseOptions = [
  { value: 'metadata', label: '同步版本与教材' },
  { value: 'catalogs_questions', label: '同步目录与题库' },
]

export const syncRunStatusOptions = [
  { value: 'queued', label: '排队中', type: 'info' },
  { value: 'starting', label: '启动中', type: 'info' },
  { value: 'running', label: '运行中', type: 'warning' },
  { value: 'cancelling', label: '停止中', type: 'warning' },
  { value: 'completed', label: '已完成', type: 'success' },
  { value: 'failed', label: '失败', type: 'danger' },
  { value: 'blocked', label: '已阻断', type: 'danger' },
  { value: 'cancelled', label: '已停止', type: 'info' },
]

const normalizeEnum = (value, aliases, fallback) => {
  if (!hasValue(value)) return fallback
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_')
  return aliases[key] || key
}

export function normalizeSyncRunStatus(value, fallback = 'queued') {
  return normalizeEnum(value, statusAliases, fallback)
}

export function normalizeSyncRunPhase(value, fallback = 'metadata') {
  return normalizeEnum(value, phaseAliases, fallback)
}

export function syncRunStatusMeta(value) {
  const normalized = normalizeSyncRunStatus(value, '')
  return syncRunStatusOptions.find((item) => item.value === normalized) || {
    value: normalized,
    label: hasValue(value) ? String(value) : '未知',
    type: 'info',
  }
}

export function isActiveSyncRunStatus(value) {
  return ['queued', 'starting', 'running', 'cancelling'].includes(normalizeSyncRunStatus(value, ''))
}

export function isTerminalSyncRunStatus(value) {
  return ['completed', 'failed', 'blocked', 'cancelled'].includes(normalizeSyncRunStatus(value, ''))
}

const limitLogTail = (lines, maxChars = 12000) => {
  const result = []
  let chars = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = String(lines[index] || '').slice(-maxChars)
    if (chars + line.length > maxChars && result.length) break
    result.unshift(line.slice(0, Math.max(0, maxChars - chars)))
    chars += line.length + 1
  }
  return result
}

const normalizeLogs = (value) => {
  if (Array.isArray(value)) {
    return limitLogTail(value
      .map((item) => {
        if (item && typeof item === 'object') return String(firstDefined(item, ['message', 'text', 'line', 'detail'], '') || '')
        return String(item ?? '')
      })
      .filter(Boolean)
      .slice(-80))
  }
  if (!hasValue(value)) return []
  return limitLogTail(String(value).split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).slice(-80))
}

const normalizeCurrentTextbook = (value) => {
  if (value && typeof value === 'object') {
    const name = firstDefined(value, ['name', 'textbookName', 'textbook_name', 'title', 'displayName', 'display_name'], '')
    const externalId = firstDefined(value, ['externalId', 'external_id', 'id', 'textbookId', 'textbook_id'], '')
    if (hasValue(name) && hasValue(externalId)) return `${name}（${externalId}）`
    return String(name || externalId || '')
  }
  return hasValue(value) ? String(value) : ''
}

const countFrom = (value, countKeys, completedKeys) => ({
  count: numberFrom(value, countKeys),
  completed: numberFrom(value, completedKeys),
})

/**
 * Return a stable task shape. Unknown backend fields remain available on the
 * result so the panel can be extended without losing diagnostic information.
 */
export function normalizeSyncRun(run = {}) {
  const value = run && typeof run === 'object' ? run : {}
  const nested = firstDefined(value, ['run', 'job', 'task', 'current'], null)
  const source = nested && typeof nested === 'object' ? nested : value
  const runId = firstDefined(source, ['runId', 'run_id', 'jobId', 'job_id', 'taskId', 'task_id', 'id'], '')
  const status = normalizeSyncRunStatus(firstDefined(source, ['status', 'runStatus', 'run_status', 'state'], ''), hasValue(runId) ? 'running' : 'queued')
  const phase = normalizeSyncRunPhase(firstDefined(source, ['phase', 'currentPhase', 'current_phase', 'stage'], ''), status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'metadata')
  const textbookCountKeys = ['textbooks', 'textbook', 'textbookCount', 'textbook_count', 'textbooksCount', 'textbooks_count', 'textbookTotal', 'textbook_total']
  const textbookCompletedKeys = ['textbooksCompleted', 'textbooks_completed', 'textbookCompleted', 'textbook_completed', 'completedTextbooks', 'completed_textbooks', 'completedTextbook', 'completed_textbook']
  const versionCountKeys = ['versions', 'version', 'versionCount', 'version_count', 'versionsCount', 'versions_count']
  const versionCompletedKeys = ['versionsCompleted', 'versions_completed', 'versionCompleted', 'version_completed', 'completedVersions', 'completed_versions', 'completedVersion', 'completed_version']
  const catalogCountKeys = ['catalogs', 'catalog', 'catalogCount', 'catalog_count', 'catalogsCount', 'catalogs_count']
  const catalogCompletedKeys = ['catalogsCompleted', 'catalogs_completed', 'catalogCompleted', 'catalog_completed', 'completedCatalogs', 'completed_catalogs', 'completedCatalog', 'completed_catalog']
  const questionCountKeys = ['questions', 'question', 'questionCount', 'question_count', 'questionsCount', 'questions_count']
  const questionCompletedKeys = ['questionsCompleted', 'questions_completed', 'questionCompleted', 'question_completed', 'completedQuestions', 'completed_questions', 'completedQuestion', 'completed_question']
  const textbookCounts = countFrom(source, textbookCountKeys, textbookCompletedKeys)
  const versionCounts = countFrom(source, versionCountKeys, versionCompletedKeys)
  const catalogCounts = countFrom(source, catalogCountKeys, catalogCompletedKeys)
  const questionCounts = countFrom(source, questionCountKeys, questionCompletedKeys)
  const textbooksTotal = numberFrom(source, ['textbooksTotal', 'textbooks_total', 'textbookTotal', 'textbook_total', 'totalTextbooks', 'total_textbooks', 'totalTextbook', 'total_textbook']) ?? textbookCounts.count
  const textbooksCompleted = numberFrom(source, textbookCompletedKeys) ?? textbookCounts.completed
  const versionsTotal = numberFrom(source, ['versionsTotal', 'versions_total', 'versionTotal', 'version_total', 'totalVersions', 'total_versions', 'totalVersion', 'total_version']) ?? versionCounts.count
  const versionsCompleted = numberFrom(source, versionCompletedKeys) ?? versionCounts.completed ?? versionCounts.count
  const catalogsTotal = numberFrom(source, ['catalogsTotal', 'catalogs_total', 'catalogTotal', 'catalog_total', 'totalCatalogs', 'total_catalogs', 'totalCatalog', 'total_catalog'])
  const catalogsCompleted = numberFrom(source, catalogCompletedKeys) ?? catalogCounts.completed ?? catalogCounts.count
  const questionsTotal = numberFrom(source, ['questionsTotal', 'questions_total', 'questionTotal', 'question_total', 'totalQuestions', 'total_questions', 'totalQuestion', 'total_question'])
  const questionsCompleted = numberFrom(source, questionCompletedKeys) ?? questionCounts.completed ?? questionCounts.count
  const directProgress = numberOrNull(firstDefined(source, ['progressPercent', 'progress_percent', 'percentage', 'percent', 'progress'], null))
  const progressObject = firstDefined(source, ['progress', 'phaseProgress', 'phase_progress'], null)
  const progressFromObject = progressObject && typeof progressObject === 'object'
    ? numberOrNull(firstDefined(progressObject, ['percent', 'percentage', 'progressPercent', 'progress_percent'], null))
    : null
  const phaseProgressCurrent = numberOrNull(firstDefined(progressObject, ['current', 'completed', 'processed', 'done'], null))
  const phaseProgressTotal = numberOrNull(firstDefined(progressObject, ['total', 'totalCount', 'total_count'], null))
  const progress = directProgress ?? progressFromObject ?? (
    phaseProgressTotal > 0 && phaseProgressCurrent !== null ? (phaseProgressCurrent / phaseProgressTotal) * 100 : null
  )
  const logs = normalizeLogs(firstDefined(source, ['logTail', 'log_tail', 'logs', 'log', 'messages'], ''))
  const errorMessage = firstDefined(source, ['errorMessage', 'error_message', 'failureReason', 'failure_reason', 'error', 'reason'], '')
  const taskTypeValue = firstDefined(source, ['taskType', 'task_type', 'runType', 'run_type', 'type', 'jobType', 'job_type'], '')
  const taskType = String(taskTypeValue || '').trim().toLowerCase() === 'content' ? 'content' : 'metadata'
  const metadataRunId = firstDefined(source, ['metadataRunId', 'metadata_run_id', 'metadataTaskId', 'metadata_task_id'], '')
  const textbookExternalIds = firstDefined(source, ['textbookExternalIds', 'textbook_external_ids'], [])

  return {
    ...source,
    runId: runId === undefined || runId === null ? '' : String(runId),
    taskType,
    runType: taskType,
    metadataRunId: metadataRunId === undefined || metadataRunId === null ? '' : String(metadataRunId),
    textbookExternalIds: Array.isArray(textbookExternalIds) ? textbookExternalIds.map((item) => String(item)) : [],
    status,
    phase,
    currentTextbook: normalizeCurrentTextbook(firstDefined(source, ['currentTextbook', 'current_textbook', 'currentTextbookName', 'current_textbook_name', 'textbook'], '')),
    versionsTotal,
    versionsCompleted,
    textbooksTotal,
    textbooksCompleted,
    catalogsTotal,
    catalogsCompleted,
    questionsTotal,
    questionsCompleted,
    catalogCount: catalogCounts.count ?? catalogsCompleted,
    questionCount: questionCounts.count ?? questionsCompleted,
    phaseProgressCurrent,
    phaseProgressTotal,
    progress: progress === null ? null : clamp(progress, 0, 100),
    logs,
    errorMessage: errorMessage && typeof errorMessage === 'object' ? JSON.stringify(errorMessage) : String(errorMessage || ''),
    startedAt: firstDefined(source, ['startedAt', 'started_at', 'createTime', 'create_time'], ''),
    finishedAt: firstDefined(source, ['finishedAt', 'finished_at', 'completedAt', 'completed_at', 'updateTime', 'update_time'], ''),
  }
}

/** Unwrap RuoYi's response envelope and the current-run wrapper. */
export function unwrapSyncRun(response) {
  let value = response
  for (let index = 0; index < 4; index += 1) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) break
    if (value.data !== undefined && !hasValue(firstDefined(value, ['runId', 'run_id', 'jobId', 'job_id', 'taskId', 'task_id', 'id'], ''))) {
      value = value.data
      continue
    }
    const nested = firstDefined(value, ['run', 'job', 'task', 'current'], undefined)
    if (nested && typeof nested === 'object') value = nested
    break
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const normalized = normalizeSyncRun(value)
  return normalized.runId ? normalized : null
}

export function unwrapSyncRunList(response) {
  let value = response
  if (value && value.data !== undefined && value.rows === undefined && value.list === undefined) value = value.data
  if (Array.isArray(value)) return value.map(normalizeSyncRun)
  if (!value || typeof value !== 'object') return []
  const rows = value.rows || value.list || value.records || value.items || []
  return Array.isArray(rows) ? rows.map(normalizeSyncRun) : []
}

export function syncRunPhaseIndex(phase) {
  const normalized = normalizeSyncRunPhase(phase, 'metadata')
  if (normalized === 'catalogs_questions') return 1
  return normalized === 'completed' ? 2 : 0
}

export function syncRunProgress(run) {
  const normalized = normalizeSyncRun(run)
  if (normalized.status === 'completed') return 100
  if (normalized.progress !== null) return normalized.progress
  if (normalized.textbooksTotal > 0 && normalized.textbooksCompleted !== null) {
    return clamp((normalized.textbooksCompleted / normalized.textbooksTotal) * 50, 0, 50)
  }
  return 0
}

export function syncRunErrorMessage(error, fallback = '同步任务请求失败，请稍后重试') {
  if (typeof error === 'string' && error.trim()) return error
  return error?.message || error?.response?.data?.msg || fallback
}
