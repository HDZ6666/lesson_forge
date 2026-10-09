import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse } from '@babel/parser'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { incrementalImportMeta } from '../../../plugins/bank/utils/sync-task.js'

const api = readFileSync(new URL('../../../plugins/bank/api/bank.js', import.meta.url), 'utf8')
const declaration = parse(api, { sourceType: 'module' }).program.body
  .find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'createQuestionSyncTask').declaration
const sent = []
const context = { request: value => { sent.push(value); return Promise.resolve(value) }, questionSyncTaskBaseUrl: '/bank/sync/question/tasks' }
runInNewContext(api.slice(declaration.start, declaration.end), context)
await context.createQuestionSyncTask({ versionId: 4, textbookId: 8, collectorRunId: 99, sourceUrl: 'ignored' })
assert.deepEqual(JSON.parse(JSON.stringify(sent[0].data)), { versionId: 4, textbookId: 8 })
await context.createQuestionSyncTask({ versionId: 4, textbookIds: [8], limitTo1000Pages: true })
assert.equal(sent[1].data.limitTo1000Pages, true)
for (const data of [{ textbookIds: [8, 9] }, { textbookIds: [8, 8] }, { textbookIds: [] }, {}]) {
  await assert.rejects(context.createQuestionSyncTask({ versionId: 4, ...data }), /一本教材/)
}
assert.equal(sent.length, 2, 'invalid selection must not reach HTTP')

const page = readFileSync(new URL('../../../plugins/bank/views/sync-question/index.vue', import.meta.url), 'utf8')
assert.match(page, /el-radio-group v-else v-model="createForm.textbookId"/)
assert.doesNotMatch(page, /el-checkbox-group/)
assert.match(page, /SubjectSelect v-model="createForm.subjectId"/)
// Five established management pages remain present and use the same selector.
for (const view of ['version','textbook','catalog','question-manage','browse']) {
  const source = readFileSync(new URL(`../../../plugins/bank/views/${view}/index.vue`, import.meta.url), 'utf8')
  assert.match(source, /SubjectSelect/)
}

// Exercise the actual version-page loader: a late response after a subject
// switch must not overwrite the current page, even when the old call fails.
const versionScript = parseSfc(readFileSync(new URL('../../../plugins/bank/views/version/index.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content
const loader = parse(versionScript, { sourceType: 'module' }).program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'loadList')
for (const staleFails of [false, true]) {
  const pending = []
  const state = { scopeReadRevision: 0, query: { subjectId: 1 }, rows: { value: [] }, total: { value: 0 }, selected: { value: [] },
    loading: { value: false }, errorMessage: { value: '' }, unwrapPage: x => x,
    listVersions: () => new Promise((resolve,reject) => pending.push({ resolve,reject })) }
  runInNewContext(versionScript.slice(loader.start,loader.end), state)
  const old = state.loadList()
  state.query.subjectId = 2
  const latest = state.loadList()
  pending[1].resolve({ rows: [{ subjectId: 2 }], total: 1 }); await latest
  if (staleFails) pending[0].reject(new Error('stale failed'))
  else pending[0].resolve({ rows: [{ subjectId: 1 }], total: 1 })
  await old
  assert.equal(state.rows.value[0].subjectId, 2)
  assert.equal(state.errorMessage.value, '')
}

// Switching tasks must not display a late success/error from the old task.
const detailScript = parseSfc(readFileSync(new URL('../../../plugins/bank/views/sync-question/detail.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content
const taskLoader = parse(detailScript, { sourceType: 'module' }).program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'loadTask')
for (const staleFails of [false, true]) {
  const pending = []
  const state = { taskLoadRevision: 0, taskId: { value: 1 }, task: { value: null }, loading: { value: false }, requestError: { value: '' },
    unwrapSyncTask: x => x, selectDefaultScope() {}, ensureComparisonLoaded() {}, schedulePoll() {}, syncTaskErrorMessage: e => e.message,
    getQuestionSyncTask: () => new Promise((resolve,reject) => pending.push({ resolve,reject })) }
  runInNewContext(detailScript.slice(taskLoader.start, taskLoader.end), state)
  const old = state.loadTask()
  state.taskId.value = 2
  const latest = state.loadTask()
  pending[1].resolve({ taskId: 2 }); await latest
  if (staleFails) pending[0].reject(new Error('stale failed'))
  else pending[0].resolve({ taskId: 1 })
  await old
  assert.equal(state.task.value.taskId, 2)
  assert.equal(state.requestError.value, '')
  assert.equal(state.loading.value, false)
}
assert.equal(incrementalImportMeta({ status: 'completed' }).label, '尚未入库')
assert.equal(incrementalImportMeta({ status: 'failed', incrementalImport: { status: 'partial' } }).label, '部分成果已保留')
assert.match(incrementalImportMeta({ incrementalImport: { status: 'completed' } }).message, /不表示已覆盖/)

// A stopped partial run still displays saved captures. Unknown source totals
// remain unknown instead of being replaced by the number we happened to fetch.
const summaryNodes = parse(detailScript, { sourceType: 'module' }).program.body.filter(node => node.type === 'VariableDeclaration'
  && ['summaryCollectedQuestionText', 'summaryTotalQuestionText'].includes(node.declarations[0]?.id.name))
const summaryState = { computed: fn => fn(), liveProjection: { value: null }, isIncremental: { value: true },
  task: { value: { status: 'failed', questionCount: 3 } }, selectedScope: { value: { questionCount: 3 } },
  formatLiveCount: x => String(x), isActiveSyncTask: () => false }
runInNewContext(summaryNodes.map(node => detailScript.slice(node.start,node.end)).join('\n') + '\nresult = [summaryCollectedQuestionText, summaryTotalQuestionText]', summaryState)
assert.equal(summaryState.result[0], '3')
assert.equal(summaryState.result[1], '未记录')
