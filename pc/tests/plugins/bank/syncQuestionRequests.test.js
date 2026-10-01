import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import { parse } from '@babel/parser'
import { parse as parseSfc } from '@vue/compiler-sfc'

// Execute the page's actual request functions with deferred HTTP responses so
// the last running response can arrive after the completed task has rendered.
const source = readFileSync(new URL('../../../plugins/bank/views/sync-question/detail.vue', import.meta.url), 'utf8')
const script = parseSfc(source).descriptor.scriptSetup.content
const names = new Set(['comparisonRequestKey', 'loadCatalogComparison', 'loadQuestions'])
const functions = parse(script, { sourceType: 'module' }).program.body
  .filter(node => node.type === 'FunctionDeclaration' && names.has(node.id.name))
  .map(node => script.slice(node.start, node.end)).join('\n')

for (const kind of ['catalog', 'question']) {
  for (const staleFails of [false, true]) {
    const requests = []
    const request = () => new Promise((resolve, reject) => requests.push({ resolve, reject }))
    const context = {
      mounted: true,
      taskId: { value: '18' }, task: { value: { status: 'running' } },
      selectedScopeKey: { value: 'tb1' },
      selectedScope: { value: { status: 'running', collectorRunId: 17 } },
      catalogLoading: { value: false }, catalogError: { value: '' },
      catalogComparison: { fetchedTree: ['saved'] },
      questionLoading: { value: false }, questionError: { value: '' },
      questionRows: { value: ['saved'] }, questionPage: { total: 1 },
      questionSummary: {}, remoteQuestionTypes: { value: [] },
      reviewRevision: { value: null },
      scopeQuery: () => ({ externalTextbookId: 'tb1' }),
      questionQuery: () => ({ externalTextbookId: 'tb1', pageNum: 1 }),
      getQuestionSyncCatalogComparison: request,
      getQuestionSyncQuestionComparison: request,
      normalizeCatalogComparison: value => value,
      normalizeQuestionComparisonPage: value => value,
      syncTaskErrorMessage: error => error.message,
    }
    runInNewContext(functions, context)
    const load = kind === 'catalog' ? context.loadCatalogComparison : context.loadQuestions
    const visibleRows = () => kind === 'catalog' ? context.catalogComparison.fetchedTree : context.questionRows.value
    const response = label => kind === 'catalog'
      ? { fetchedTree: [label], currentTree: [], summary: {} }
      : { rows: [label], total: 1, questionTypes: [], summary: {} }

    const running = load()
    context.task.value.status = 'completed'
    context.selectedScope.value.status = 'completed'
    await load() // The old request is still in flight.
    if (staleFails) requests[0].reject(new Error('old request failed'))
    else requests[0].resolve(response('stale'))
    await running
    assert.equal(requests.length, 2, `${kind} must fetch the completed snapshot`)
    assert.equal(visibleRows()[0], 'saved', `${kind} must ignore the stale response`)
    requests[1].resolve(response('completed'))
    await setImmediate()
    assert.equal(visibleRows()[0], 'completed')
    assert.equal(context.catalogError.value, '')
    assert.equal(context.questionError.value, '')
  }
}

// A refresh while the confirmation dialog is open must not silently replace
// the version the user reviewed with the newest version.
{
  const node = parse(script, {sourceType: 'module'}).program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'applyTask')
  let confirm
  let submitted
  const context = {
    task: {value: {taskId: 18, status: 'completed', eligible: true, isCurrent: false, token: 'seen-token'}},
    reviewRevision: {value: 3}, acting: {value: false}, applySuccess: {value: ''},
    currentFormalSummary: {value: 'current'}, affectedTextbookLabel: {value: 'book'},
    questionApplyCurrentTaskId: () => 17, questionApplyStateToken: task => task.token,
    questionApplyVerb: () => '同步', questionApplyWillReplace: () => true,
    ElMessageBox: {confirm: () => new Promise(resolve => {confirm = resolve})},
    ElMessage: {success: () => {}, warning: () => {}, error: message => {throw new Error(message)}},
    applyQuestionSyncTask: async (...args) => {submitted = args; return {data: {}}},
    formatQuestionApplyStats: () => '', loadTask: async () => {}, loadedScopeKey: '',
    syncTaskErrorMessage: error => error.message,
  }
  runInNewContext(script.slice(node.start, node.end), context)
  const pending = context.applyTask()
  context.reviewRevision.value = 4
  context.task.value.token = 'new-token'
  confirm()
  await pending
  assert.equal(submitted[0], 18)
  assert.equal(submitted[1].expectedReviewRevision, 3)
  assert.equal(submitted[1].expectedStateToken, 'seen-token')
}
