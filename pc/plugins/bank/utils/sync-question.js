import { firstTaskField } from './sync-task.js'
import { unwrapResponse } from './response.js'
import { stripMarkup } from './sync.js'

const text = (value) => value === undefined || value === null ? '' : String(value)
const numberOrZero = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

const comparisonAliases = {
  new: 'new',
  added: 'new',
  add: 'new',
  created: 'new',
  existing: 'existing',
  exist: 'existing',
  unchanged: 'existing',
  same: 'existing',
  matched: 'existing',
  changed: 'changed',
  change: 'changed',
  updated: 'changed',
  modified: 'changed',
  '新增': 'new',
  '已有': 'existing',
  '已存在': 'existing',
  '变化': 'changed',
  '变更': 'changed',
}

export const taskComparisonStatusOptions = [
  { value: 'new', label: '新增', type: 'success' },
  { value: 'existing', label: '已有', type: 'info' },
  { value: 'changed', label: '变化', type: 'warning' },
]

export function normalizeTaskComparisonStatus(value, fallback = 'existing') {
  const key = text(value).trim().toLowerCase().replace(/[\s-]+/g, '_')
  return comparisonAliases[key] || key || fallback
}

export function taskComparisonStatusMeta(value) {
  const normalized = normalizeTaskComparisonStatus(value)
  return taskComparisonStatusOptions.find((item) => item.value === normalized) || {
    value: normalized,
    label: value || '未知',
    type: 'info',
  }
}

const itemProvider = (value) => text(firstTaskField(value, ['sourceProvider', 'source_provider', 'provider'], ''))
const itemExternalId = (value, type = 'catalog') => text(firstTaskField(value, type === 'question'
  ? ['externalQuestionId', 'external_question_id', 'questionExternalId', 'question_external_id', 'externalId', 'external_id']
  : ['externalNodeId', 'external_node_id', 'catalogExternalId', 'catalog_external_id', 'externalCatalogId', 'external_catalog_id', 'externalId', 'external_id'], ''))

const currentSnapshot = (value) => firstTaskField(value, ['current', 'currentData', 'current_data', 'formal', 'published', 'right'], {}) || {}
const fetchedSnapshot = (value) => firstTaskField(value, ['fetched', 'candidate', 'snapshot', 'source', 'stagedData', 'staged_data', 'left'], value) || value

const catalogName = (value) => text(firstTaskField(value, ['nodeName', 'node_name', 'catalogName', 'catalog_name', 'name', 'title', 'label'], ''))

function catalogMatchKey(value) {
  const provider = itemProvider(value)
  const externalId = itemExternalId(value, 'catalog')
  return provider && externalId ? `${provider}:${externalId}` : ''
}

function normalizeCatalogNode(item = {}, side = 'fetched', index = 0, parentKey = 'root') {
  const value = item && typeof item === 'object' ? item : {}
  const snapshot = side === 'current' ? currentSnapshot(value) : fetchedSnapshot(value)
  const provider = itemProvider(snapshot) || itemProvider(value)
  const externalNodeId = itemExternalId(snapshot, 'catalog') || itemExternalId(value, 'catalog')
  const rawChildren = firstTaskField(value, ['children', 'nodes', 'items'], firstTaskField(snapshot, ['children', 'nodes', 'items'], []))
  const matchKey = provider && externalNodeId ? `${provider}:${externalNodeId}` : ''
  const key = matchKey || `${side}:${parentKey}:${firstTaskField(value, ['catalogId', 'catalog_id', 'nodeId', 'node_id', 'id'], index)}`
  const children = Array.isArray(rawChildren)
    ? rawChildren.map((child, childIndex) => normalizeCatalogNode(child, side, childIndex, key))
    : []
  return {
    ...value,
    ...(snapshot && typeof snapshot === 'object' ? snapshot : {}),
    key,
    matchKey,
    nodeKey: key,
    label: catalogName(snapshot) || catalogName(value) || '未命名目录',
    sourceProvider: provider,
    externalNodeId,
    catalogId: firstTaskField(snapshot, ['catalogId', 'catalog_id', 'nodeId', 'node_id', 'id'], firstTaskField(value, ['catalogId', 'catalog_id', 'nodeId', 'node_id', 'id'], '')),
    parentExternalNodeId: text(firstTaskField(
      snapshot,
      ['parentExternalNodeId', 'parent_external_node_id', 'parentExternalId', 'parent_external_id'],
      firstTaskField(value, ['parentExternalNodeId', 'parent_external_node_id', 'parentExternalId', 'parent_external_id'], ''),
    )),
    comparisonStatus: side === 'current' ? 'existing' : normalizeTaskComparisonStatus(firstTaskField(value, ['comparisonStatus', 'comparison_status', 'diffStatus', 'diff_status', 'matchStatus', 'match_status', 'status'], firstTaskField(snapshot, ['comparisonStatus', 'comparison_status', 'status'], 'existing'))),
    children,
  }
}

function buildTreeFromFlat(rows, side) {
  const normalized = rows.map((row, index) => normalizeCatalogNode(row, side, index))
  const byMatchKey = new Map(normalized.filter((item) => item.matchKey).map((item) => [item.matchKey, item]))
  const roots = []
  normalized.forEach((item) => {
    const parentKey = item.parentExternalNodeId
      ? `${item.sourceProvider || ''}:${item.parentExternalNodeId}`
      : ''
    if (parentKey && byMatchKey.has(parentKey)) {
      byMatchKey.get(parentKey).children.push(item)
    } else {
      roots.push(item)
    }
  })
  return roots
}

const normalizeCatalogTree = (value, side) => {
  if (!Array.isArray(value)) return []
  const hasNestedChildren = value.some((item) => Array.isArray(firstTaskField(item, ['children', 'nodes', 'items'], undefined)))
  return hasNestedChildren
    ? value.map((item, index) => normalizeCatalogNode(item, side, index))
    : buildTreeFromFlat(value, side)
}

export function normalizeCatalogComparison(response) {
  const value = unwrapResponse(response)
  if (!value || typeof value !== 'object') return { fetchedTree: [], currentTree: [], summary: {} }
  let fetched = firstTaskField(value, ['fetchedTree', 'fetched_tree', 'sourceTree', 'source_tree', 'candidateTree', 'candidate_tree', 'leftTree', 'left_tree', 'fetchedCatalogs', 'fetched_catalogs'], undefined)
  let current = firstTaskField(value, ['currentTree', 'current_tree', 'formalTree', 'formal_tree', 'publishedTree', 'published_tree', 'rightTree', 'right_tree', 'currentCatalogs', 'current_catalogs'], undefined)
  const comparisons = firstTaskField(value, ['comparisons', 'comparisonRows', 'comparison_rows', 'rows', 'items'], [])
  if (fetched === undefined && Array.isArray(comparisons)) fetched = comparisons
  if (current === undefined && Array.isArray(comparisons)) {
    current = comparisons
      .map((item) => currentSnapshot(item))
      .filter((item) => item && typeof item === 'object' && Object.keys(item).length)
  }
  const fetchedTree = normalizeCatalogTree(Array.isArray(fetched) ? fetched : [], 'fetched')
  const currentTree = normalizeCatalogTree(Array.isArray(current) ? current : [], 'current')
  return {
    fetchedTree,
    currentTree,
    summary: firstTaskField(value, ['summary', 'statistics', 'counts'], {}) || {},
    sourceAvailable: firstTaskField(value, ['sourceAvailable', 'source_available'], undefined),
    sourceMessage: text(firstTaskField(value, ['sourceMessage', 'source_message'], '')),
  }
}

export function flattenCatalogTree(tree = []) {
  const result = []
  const walk = (nodes, prefix = '') => {
    nodes.forEach((node) => {
      result.push({
        value: node.catalogId || node.externalNodeId,
        externalNodeId: node.externalNodeId,
        label: `${prefix}${node.label}`,
      })
      walk(node.children || [], `${prefix}　`)
    })
  }
  walk(Array.isArray(tree) ? tree : [])
  return result
}

export function findCurrentCatalogNode(tree, sourceNode) {
  const wanted = catalogMatchKey(sourceNode)
  if (!wanted) return null
  const stack = [...(Array.isArray(tree) ? tree : [])]
  while (stack.length) {
    const node = stack.shift()
    if (node.matchKey === wanted) return node
    stack.unshift(...(node.children || []))
  }
  return null
}

const questionField = (value, keys, fallback = '') => firstTaskField(value, keys, fallback)

function normalizeQuestionSnapshot(value = {}) {
  const item = value && typeof value === 'object' ? value : {}
  return {
    ...item,
    externalQuestionId: itemExternalId(item, 'question'),
    sourceProvider: itemProvider(item),
    questionType: text(questionField(item, ['questionType', 'question_type', 'typeName', 'type_name', 'type'], '')),
    catalogId: questionField(item, ['catalogId', 'catalog_id', 'nodeId', 'node_id'], ''),
    catalogName: text(questionField(item, ['catalogName', 'catalog_name', 'nodeName', 'node_name'], '')),
    stemHtml: text(questionField(item, ['stemHtml', 'stem_html', 'contentHtml', 'content_html', 'questionHtml', 'question_html', 'titleHtml', 'title_html', 'stem', 'content', 'title'], '')),
    answerHtml: text(questionField(item, ['answerHtml', 'answer_html', 'answer', 'referenceAnswer', 'reference_answer'], '')),
    analysisHtml: text(questionField(item, ['analysisHtml', 'analysis_html', 'analysis', 'explanationHtml', 'explanation_html'], '')),
    solutionHtml: text(questionField(item, ['solutionHtml', 'solution_html'], '')),
    difficulty: text(questionField(item, ['difficultyName', 'difficulty_name', 'difficulty'], '')),
    contentHash: text(questionField(item, ['contentHash', 'content_hash', 'hash'], '')),
  }
}

export function normalizeQuestionComparisonRow(item = {}, index = 0) {
  const value = item && typeof item === 'object' ? item : {}
  const fetched = normalizeQuestionSnapshot(fetchedSnapshot(value))
  const currentRaw = currentSnapshot(value)
  const current = currentRaw && typeof currentRaw === 'object' && Object.keys(currentRaw).length
    ? normalizeQuestionSnapshot(currentRaw)
    : null
  const externalQuestionId = fetched.externalQuestionId || itemExternalId(value, 'question')
  const sourceProvider = fetched.sourceProvider || itemProvider(value)
  return {
    ...value,
    key: `${sourceProvider || 'unknown'}:${externalQuestionId || index}`,
    sourceProvider,
    externalQuestionId,
    comparisonStatus: normalizeTaskComparisonStatus(firstTaskField(value, ['comparisonStatus', 'comparison_status', 'diffStatus', 'diff_status', 'matchStatus', 'match_status', 'status'], current ? 'existing' : 'new'), current ? 'existing' : 'new'),
    diffFields: firstTaskField(value, ['diffFields', 'diff_fields', 'changedFields', 'changed_fields'], []) || [],
    fetched,
    current,
    questionType: fetched.questionType,
    catalogId: fetched.catalogId,
    catalogName: fetched.catalogName,
    stemText: stripMarkup(fetched.stemHtml).replace(/\s+/g, ' ').slice(0, 260),
  }
}

export function normalizeQuestionComparisonPage(response) {
  const value = unwrapResponse(response)
  if (Array.isArray(value)) return { rows: value.map(normalizeQuestionComparisonRow), total: value.length, questionTypes: [] }
  if (!value || typeof value !== 'object') return { rows: [], total: 0, questionTypes: [] }
  const page = value.page && typeof value.page === 'object' ? value.page : {}
  const rawRows = firstTaskField(value, ['rows', 'list', 'records', 'items', 'questions', 'comparisons'], firstTaskField(page, ['rows', 'list', 'records', 'items'], []))
  const rows = Array.isArray(rawRows) ? rawRows.map(normalizeQuestionComparisonRow) : []
  const rawTypes = firstTaskField(value, ['questionTypes', 'question_types', 'typeOptions', 'type_options'], [])
  return {
    rows,
    total: numberOrZero(firstTaskField(value, ['total', 'totalCount', 'total_count', 'count'], firstTaskField(page, ['total', 'totalCount', 'total_count'], rows.length))),
    summary: firstTaskField(value, ['summary', 'statistics', 'counts'], {}) || {},
    questionTypes: (Array.isArray(rawTypes) ? rawTypes : []).map((item) => typeof item === 'object'
      ? { value: firstTaskField(item, ['value', 'code', 'id', 'name'], ''), label: text(firstTaskField(item, ['label', 'name', 'title', 'value'], '')) }
      : { value: item, label: text(item) }),
  }
}

export function normalizeQuestionDetail(response) {
  const value = unwrapResponse(response)
  if (!value || typeof value !== 'object') return null
  const nested = firstTaskField(value, ['comparison', 'question', 'item'], value)
  return normalizeQuestionComparisonRow(nested)
}
