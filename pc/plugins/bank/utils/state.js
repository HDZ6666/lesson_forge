export function createQuestionQuery() {
  return {
    versionId: undefined,
    textbookId: undefined,
    catalogId: undefined,
    keyword: '',
    questionType: undefined,
    difficulty: undefined,
    difficultyMin: undefined,
    difficultyMax: undefined,
    year: undefined,
    province: '',
    scene: [],
    category: [],
    examMethod: [],
    pageNum: 1,
    pageSize: 10,
    sort: 'questionId',
    order: 'desc',
  }
}

/** Reset dependent state when the selected dataset context changes. */
export function resetQuestionState(query, scope) {
  if (scope === 'version') {
    query.textbookId = undefined
    query.catalogId = undefined
  } else if (scope === 'textbook') {
    query.catalogId = undefined
  }
  query.keyword = ''
  query.questionType = undefined
  query.difficulty = undefined
  query.difficultyMin = undefined
  query.difficultyMax = undefined
  query.year = undefined
  query.province = ''
  query.scene = []
  query.category = []
  query.examMethod = []
  query.pageNum = 1
}

export function isBatchActionable(batch, action) {
  const status = String(batch?.status || '').toLowerCase()
  if (action === 'approve') return status === 'approval_pending'
  if (action === 'publish') return status === 'approved'
  if (action === 'rollback') return ['published', 'archived'].includes(status)
  return false
}

export function isTerminalBatchStatus(status) {
  return ['published', 'failed', 'archived', 'rolled_back'].includes(String(status || '').toLowerCase())
}
