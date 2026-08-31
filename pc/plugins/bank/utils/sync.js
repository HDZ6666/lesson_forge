/**
 * Helpers shared by the synchronization review pages.
 *
 * The collector and the API have deliberately been kept backwards compatible
 * with both camelCase and snake_case payloads.  Keeping that tolerance here
 * keeps the view focused on the review workflow rather than response quirks.
 */

const firstDefined = (value, keys, fallback) => {
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

const nonEmpty = (value) => value !== undefined && value !== null && String(value).trim() !== ''

export const comparisonStatusOptions = [
  { value: 'new', label: '新增', type: 'success' },
  { value: 'changed', label: '变更', type: 'warning' },
  { value: 'unchanged', label: '无变化', type: 'info' },
  { value: 'conflict', label: '冲突', type: 'danger' },
]

export const reviewStatusOptions = [
  { value: 'pending', label: '待审核', type: 'warning' },
  { value: 'approved', label: '已通过', type: 'success' },
  { value: 'rejected', label: '已驳回', type: 'danger' },
  { value: 'stale', label: '需复审', type: 'warning' },
]

const comparisonAliases = {
  new: 'new',
  added: 'new',
  create: 'new',
  created: 'new',
  insert: 'new',
  新增: 'new',
  changed: 'changed',
  change: 'changed',
  updated: 'changed',
  update: 'changed',
  modified: 'changed',
  变更: 'changed',
  unchanged: 'unchanged',
  same: 'unchanged',
  no_change: 'unchanged',
  nochange: 'unchanged',
  无变化: 'unchanged',
  conflict: 'conflict',
  conflicts: 'conflict',
  冲突: 'conflict',
}

const reviewAliases = {
  pending: 'pending',
  waiting: 'pending',
  reviewing: 'pending',
  approval_pending: 'pending',
  approved: 'approved',
  approve: 'approved',
  passed: 'approved',
  validated: 'approved',
  rejected: 'rejected',
  reject: 'rejected',
  declined: 'rejected',
  已驳回: 'rejected',
  stale: 'stale',
  需复审: 'stale',
  re_review: 'stale',
  rereview: 'stale',
  needs_review: 'stale',
  need_review: 'stale',
  review_required: 'stale',
  需重审: 'stale',
  待审核: 'pending',
  已通过: 'approved',
}

const normalizeEnum = (value, aliases) => {
  if (!nonEmpty(value)) return undefined
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_')
  return aliases[key] || key
}

export function normalizeComparisonStatus(value) {
  return normalizeEnum(value, comparisonAliases)
}

export function normalizeReviewStatus(value) {
  return normalizeEnum(value, reviewAliases)
}

export function comparisonStatusMeta(value) {
  const normalized = normalizeComparisonStatus(value)
  return comparisonStatusOptions.find((item) => item.value === normalized) || { value: normalized || '', label: value || '未知', type: 'info' }
}

export function reviewStatusMeta(value) {
  const normalized = normalizeReviewStatus(value)
  return reviewStatusOptions.find((item) => item.value === normalized) || { value: normalized || '', label: value || '未知', type: 'info' }
}

export function normalizeDiffFields(value) {
  if (Array.isArray(value)) return value.filter(nonEmpty).map((item) => String(item))
  if (value && typeof value === 'object') return Object.keys(value).filter(nonEmpty)
  if (!nonEmpty(value)) return []
  return String(value).split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)
}

/**
 * Normalize one row without dropping fields supplied by a newer backend.
 */
export function normalizeSyncComparisonRow(row = {}) {
  const value = row && typeof row === 'object' ? row : {}
  const candidate = firstDefined(value, ['candidate', 'candidateData', 'candidate_data', 'sourceData', 'source_data'], {})
  const current = firstDefined(value, ['current', 'currentData', 'current_data', 'publishedData', 'published_data', 'databaseData', 'database_data'], {})
  const stagedData = firstDefined(value, ['stagedData', 'staged_data'], candidate)
  const currentData = firstDefined(value, ['currentData', 'current_data'], current)
  const externalId = firstDefined(value, ['externalId', 'external_id', 'sourceExternalId', 'source_external_id', 'externalVersionId', 'externalTextbookId', 'externalCatalogId', 'externalQuestionId'], firstDefined(candidate, ['externalId', 'external_id'], ''))
  const stagedHash = firstDefined(value, ['stagedHash', 'staged_hash', 'candidateHash', 'candidate_hash', 'sourceHash', 'source_hash'], firstDefined(candidate, ['stagedHash', 'staged_hash', 'hash'], ''))
  const sourceProvider = firstDefined(value, ['sourceProvider', 'source_provider', 'provider'], firstDefined(candidate, ['sourceProvider', 'source_provider', 'provider'], ''))
  const comparisonStatus = normalizeComparisonStatus(firstDefined(value, ['comparisonStatus', 'comparison_status', 'diffStatus', 'diff_status', 'status'], ''))
  const reviewStatus = normalizeReviewStatus(firstDefined(value, ['reviewStatus', 'review_status', 'auditStatus', 'audit_status', 'approvalStatus', 'approval_status'], 'pending'))
  const diffFields = normalizeDiffFields(firstDefined(value, ['diffFields', 'diff_fields', 'changedFields', 'changed_fields', 'differences', 'diff'], []))
  const collectedAt = firstDefined(value, ['collectedAt', 'collected_at'], firstDefined(candidate, ['lastSeenAt', 'last_seen_at', 'collectedAt', 'collected_at'], firstDefined(value, ['lastCollectedAt', 'last_collected_at', 'syncTime', 'sync_time', 'capturedAt', 'captured_at', 'updatedAt', 'updated_at'], '')))
  const reviewedBy = firstDefined(value, ['reviewedBy', 'reviewed_by', 'auditedBy', 'audited_by'], '')
  const reviewedAt = firstDefined(value, ['reviewedAt', 'reviewed_at', 'auditedAt', 'audited_at'], '')
  const reviewComment = firstDefined(value, ['reviewComment', 'review_comment', 'auditComment', 'audit_comment', 'comment'], '')

  return {
    ...value,
    externalId: externalId === undefined || externalId === null ? '' : String(externalId),
    sourceProvider: sourceProvider === undefined || sourceProvider === null ? '' : String(sourceProvider),
    stagedHash: stagedHash === undefined || stagedHash === null ? '' : String(stagedHash),
    stagedData: stagedData === undefined || stagedData === null ? {} : stagedData,
    currentData: currentData === undefined || currentData === null ? {} : currentData,
    comparisonStatus,
    reviewStatus,
    diffFields,
    collectedAt,
    reviewedBy: reviewedBy === undefined || reviewedBy === null ? '' : String(reviewedBy),
    reviewedAt: reviewedAt === undefined || reviewedAt === null ? '' : String(reviewedAt),
    reviewComment: reviewComment === undefined || reviewComment === null ? '' : String(reviewComment),
  }
}

// Backwards-compatible name used by the first version of the sync page.
export const normalizeSyncRow = normalizeSyncComparisonRow

const summaryValue = (summary, keys) => numberOrZero(firstDefined(summary, keys, 0))

/**
 * Normalize the optional summary returned by the compare endpoint.  When an
 * older endpoint does not provide summary, deriving it from the current page
 * is still useful and explicitly marked as a page-level estimate by callers.
 */
export function normalizeSyncSummary(summary = {}, rows = []) {
  const normalizedRows = rows.map(normalizeSyncRow)
  const source = summary && typeof summary === 'object' ? summary : {}
  const hasSummary = Object.keys(source).length > 0
  const countBy = (predicate) => normalizedRows.reduce((count, row) => count + (predicate(row) ? 1 : 0), 0)
  return {
    total: summaryValue(source, ['total', 'candidateTotal', 'candidate_total', 'candidates', 'count']) || (hasSummary ? 0 : normalizedRows.length),
    new: summaryValue(source, ['new', 'newCount', 'new_count', 'added', 'addedCount', 'added_count', 'created', '新增']),
    changed: summaryValue(source, ['changed', 'changedCount', 'changed_count', 'updated', 'updatedCount', 'updated_count', 'modified', '变更']),
    unchanged: summaryValue(source, ['unchanged', 'unchangedCount', 'unchanged_count', 'same', 'noChange', 'no_change', '无变化']),
    pending: summaryValue(source, ['pending', 'pendingCount', 'pending_count', 'reviewPending', 'review_pending', 'waiting', '待审核']),
    approved: summaryValue(source, ['approved', 'approvedCount', 'approved_count', 'passed', 'validated', '已通过']),
    rejected: summaryValue(source, ['rejected', 'rejectedCount', 'rejected_count', 'declined', '已驳回']),
    conflict: summaryValue(source, ['conflict', 'conflicts', 'conflictCount', 'conflict_count', '冲突']),
    stale: summaryValue(source, ['stale', 'staleCount', 'stale_count', 'reReview', 're_review', 'reReviewCount', 're_review_count', 'needsReview', 'needs_review', 'needReview', '需复审', '需重审']),
    // Keep the API names available to consumers that need to render a raw
    // summary, while the page uses the normalized conflict/stale fields.
    conflictCount: summaryValue(source, ['conflictCount', 'conflict_count', 'conflict', 'conflicts', '冲突']),
    staleCount: summaryValue(source, ['staleCount', 'stale_count', 'stale', 'reReview', 're_review', 'reReviewCount', 're_review_count', 'needsReview', 'needs_review', '需复审', '需重审']),
    // Expose this only for diagnostics; the cards use the stable fields above.
    derived: !hasSummary,
    pageNew: countBy((row) => row.comparisonStatus === 'new'),
    pageChanged: countBy((row) => row.comparisonStatus === 'changed'),
    pageUnchanged: countBy((row) => row.comparisonStatus === 'unchanged'),
    pagePending: countBy((row) => row.reviewStatus === 'pending'),
    pageApproved: countBy((row) => row.reviewStatus === 'approved'),
    pageRejected: countBy((row) => row.reviewStatus === 'rejected'),
    pageConflict: countBy((row) => row.comparisonStatus === 'conflict'),
    pageStale: countBy((row) => row.reviewStatus === 'stale'),
    // Legacy diagnostics field.
    pageReReview: countBy((row) => row.reviewStatus === 'stale'),
  }
}

/** Unwrap the compare response while preserving source availability metadata. */
export function unwrapSyncCompare(response) {
  let value = response
  if (value && value.data !== undefined && value.rows === undefined) value = value.data
  if (value && value.data !== undefined && value.rows === undefined && value.list === undefined) value = value.data
  if (Array.isArray(value)) value = { rows: value }
  if (!value || typeof value !== 'object') value = {}
  const page = value.page && typeof value.page === 'object' ? value.page : {}
  const rawRows = value.rows || value.list || value.records || value.items || page.rows || page.list || []
  const rows = Array.isArray(rawRows) ? rawRows.map(normalizeSyncComparisonRow) : []
  const sourceAvailableValue = value.sourceAvailable !== undefined ? value.sourceAvailable : value.source_available
  const sourceAvailable = sourceAvailableValue === undefined ? undefined : ![false, 0, '0', 'false', 'False', 'FALSE', 'no', 'NO'].includes(sourceAvailableValue)
  return {
    rows,
    total: numberOrZero(value.total ?? value.totalCount ?? value.count ?? page.total ?? page.totalCount ?? rows.length),
    pageNum: numberOrZero(value.pageNum ?? value.page_num ?? page.pageNum ?? page.page_num ?? 1) || 1,
    pageSize: numberOrZero(value.pageSize ?? value.page_size ?? page.pageSize ?? page.page_size ?? rows.length) || rows.length,
    summary: normalizeSyncSummary(value.summary || value.statistics || {}, rows),
    sourceAvailable,
    sourceMessage: value.sourceMessage || value.source_message || '',
  }
}

/**
 * Normalize the grouped metadata snapshot used by the sync-center transfer.
 * Unlike the paged compare endpoint, this payload is already bounded to one
 * successful metadata collector run and carries version -> textbook groups.
 */
export function unwrapMetadataSnapshot(response) {
  let value = response
  for (let index = 0; index < 3; index += 1) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) break
    if (value.data !== undefined && value.versions === undefined) {
      value = value.data
      continue
    }
    break
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      sourceAvailable: false,
      sourceMessage: '',
      metadataRunId: '',
      collectedAt: '',
      versions: [],
      textbookCount: 0,
      versionCount: 0,
    }
  }
  const rawVersions = Array.isArray(value.versions) ? value.versions : []
  const versions = rawVersions.map((version) => {
    const normalizedVersion = normalizeSyncComparisonRow(version)
    const textbooks = Array.isArray(version?.textbooks)
      ? version.textbooks.map((textbook) => normalizeSyncComparisonRow(textbook))
      : []
    return {
      ...normalizedVersion,
      versionName: version?.versionName || summarizeSyncRow(normalizedVersion, 'staged', 'version') || normalizedVersion.externalId,
      textbooks,
    }
  })
  const sourceAvailableValue = value.sourceAvailable !== undefined ? value.sourceAvailable : value.source_available
  return {
    sourceAvailable: sourceAvailableValue === undefined
      ? undefined
      : ![false, 0, '0', 'false', 'False', 'FALSE', 'no', 'NO'].includes(sourceAvailableValue),
    sourceMessage: value.sourceMessage || value.source_message || '',
    metadataRunId: value.metadataRunId ?? value.metadata_run_id ?? '',
    collectedAt: value.collectedAt || value.collected_at || '',
    versions,
    versionCount: Number(value.versionCount ?? value.version_count ?? versions.length) || versions.length,
    textbookCount: Number(value.textbookCount ?? value.textbook_count ?? versions.reduce((sum, item) => sum + item.textbooks.length, 0)) || 0,
  }
}

export function canReviewSyncRow(row) {
  const normalized = normalizeSyncComparisonRow(row)
  return Boolean(row && nonEmpty(normalized.stagedHash) && normalized.comparisonStatus !== 'conflict')
}

/** Stable table key; external IDs may repeat across providers. */
export function syncComparisonRowKey(row = {}) {
  const normalized = normalizeSyncComparisonRow(row)
  return `${normalized.sourceProvider || 'unknown'}:${normalized.externalId || normalized.stagedHash || 'unknown'}`
}

const htmlEntity = (entity) => {
  const entities = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
  return entities[entity.toLowerCase()] || entity
}

export function stripMarkup(value) {
  if (!nonEmpty(value)) return ''
  return String(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, htmlEntity)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim()
}

const snapshotValue = (value, key, entityType) => {
  if (value === undefined || value === null) return value
  const normalizedKey = String(key || '').toLowerCase().replace(/_/g, '')
  if (entityType === 'question' || ['contenthtml', 'answerhtml', 'analysishtml', 'rawjson'].includes(normalizedKey)) {
    if (typeof value === 'string') return stripMarkup(value).slice(0, 1000)
  }
  if (Array.isArray(value)) return value.map((item) => snapshotValue(item, key, entityType))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, snapshotValue(childValue, childKey, entityType)]))
  }
  return value
}

/** Safe text-only snapshot for the side-by-side detail drawer. */
export function formatSyncSnapshot(value, entityType = '') {
  if (value === undefined || value === null || value === '') return '暂无数据'
  const safeValue = snapshotValue(value, '', entityType)
  if (typeof safeValue === 'string') return entityType === 'question' ? stripMarkup(safeValue) : safeValue
  try {
    return JSON.stringify(safeValue, null, 2)
  } catch (_error) {
    return String(safeValue)
  }
}

const preferredFields = ['name', 'versionName', 'textbookName', 'nodeName', 'title', 'questionTitle', 'plainText', 'sourceText', 'displayName', 'externalId']

export function summarizeSyncRow(row, side = 'staged', entityType = '') {
  const normalized = normalizeSyncRow(row)
  const direct = side === 'current' ? firstDefined(normalized, ['currentValue', 'current_value', 'currentName', 'current_name'], undefined) : firstDefined(normalized, ['candidateValue', 'candidate_value', 'stagedValue', 'staged_value', 'sourceValue', 'source_value'], undefined)
  const data = direct !== undefined ? direct : side === 'current' ? normalized.currentData : normalized.stagedData
  if (typeof data === 'string' || typeof data === 'number') return stripMarkup(data).slice(0, 180)
  if (data && typeof data === 'object') {
    for (const field of preferredFields) {
      if (nonEmpty(data[field])) return stripMarkup(data[field]).replace(/\s+/g, ' ').slice(0, 180)
    }
  }
  return formatSyncSnapshot(data, entityType).replace(/\s+/g, ' ').slice(0, 180)
}

export function buildSyncReviewItems(rows) {
  return rows.filter(canReviewSyncRow).map((row) => {
    const normalized = normalizeSyncComparisonRow(row)
    return {
      sourceProvider: normalized.sourceProvider,
      externalId: normalized.externalId,
      stagedHash: normalized.stagedHash,
    }
  })
}
