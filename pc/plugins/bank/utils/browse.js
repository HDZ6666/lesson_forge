const API_QUERY_FIELDS = [
  'textbookId',
  'catalogId',
  'keyword',
  'questionType',
  'difficulty',
  'year',
  'grade',
  'term',
  'province',
  'scene',
  'category',
  'examMethod',
  'pageNum',
  'pageSize',
  'sort',
  'order',
]

const SORT_PRESETS = Object.freeze({
  comprehensive: Object.freeze({ sort: 'questionId', order: 'desc' }),
  latest: Object.freeze({ sort: 'updateTime', order: 'desc' }),
  hottest: Object.freeze({ sort: 'assembleCount', order: 'desc' }),
})

/** Build the exact query contract supported by the bank list endpoint. */
export function buildBrowseQuery(state) {
  const query = { usableOnly: true }
  for (const field of API_QUERY_FIELDS) {
    const value = state?.[field]
    if (Array.isArray(value)) {
      if (value.length) query[field] = [...value]
    } else if (value !== undefined && value !== null && value !== '') {
      query[field] = value
    }
  }
  return query
}

export function createBrowseQuery() {
  return {
    textbookId: undefined,
    catalogId: undefined,
    keyword: '',
    questionType: undefined,
    difficulty: undefined,
    year: undefined,
    grade: undefined,
    term: undefined,
    province: '',
    scene: [],
    category: [],
    examMethod: [],
    pageNum: 1,
    pageSize: 10,
    sort: SORT_PRESETS.comprehensive.sort,
    order: SORT_PRESETS.comprehensive.order,
  }
}

/** Reset only question filters while preserving the selected textbook. */
export function resetBrowseFilters(query) {
  query.catalogId = undefined
  query.keyword = ''
  query.questionType = undefined
  query.difficulty = undefined
  query.year = undefined
  query.grade = undefined
  query.term = undefined
  query.province = ''
  query.scene = []
  query.category = []
  query.examMethod = []
  query.pageNum = 1
  return query
}

/** Reset context-dependent values when a textbook changes. */
export function resetBrowseContext(query) {
  resetBrowseFilters(query)
  query.textbookId = undefined
  return query
}

export function applyBrowseSort(query, preset) {
  const sort = SORT_PRESETS[preset] || SORT_PRESETS.comprehensive
  query.sort = sort.sort
  query.order = sort.order
  query.pageNum = 1
  return query
}

export function sortPresetFor(query) {
  return Object.entries(SORT_PRESETS).find(([, value]) => value.sort === query?.sort && value.order === query?.order)?.[0] || 'comprehensive'
}

export function isSelectedChoice(value, choices) {
  return Array.isArray(choices) && choices.some((item) => String(item) === String(value))
}

export function setSingleChoice(query, field, value) {
  query[field] = value === undefined || value === null || value === '' ? [] : [value]
  query.pageNum = 1
  return query
}

export function getBrowseId(item, field) {
  if (!item || typeof item !== 'object') return undefined
  if (item[field] !== undefined && item[field] !== null) return item[field]
  const snake = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
  return item[snake]
}

export function catalogNodeCount(nodes) {
  if (!Array.isArray(nodes)) return 0
  return nodes.reduce((total, node) => total + 1 + catalogNodeCount(node?.children), 0)
}

export function firstCatalogId(nodes) {
  const first = Array.isArray(nodes) ? nodes[0] : undefined
  return getBrowseId(first, 'catalogId')
}

