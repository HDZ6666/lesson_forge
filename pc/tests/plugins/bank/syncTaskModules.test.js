import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  canCancelSyncTask,
  canDeleteSyncTask,
  canResumeSyncTask,
  canRetrySyncTask,
  formatQuestionApplyStats,
  formatTextbookApplyStats,
  isActiveSyncTask,
  normalizeSyncTaskStatus,
  normalizeQuestionSyncOptions,
  normalizeSyncTask,
  questionApplyAffectedTextbooks,
  questionApplyCurrentTaskSummary,
  questionApplyStateToken,
  questionApplyWillReplace,
  syncTaskErrorMessage,
  syncTaskStatusMeta,
  syncTaskStatusOptions,
  textbookApplyActionLabel,
  textbookTaskMeaning,
  unwrapSyncTaskPage,
  parseFetchWindowsFromLogs,
  resolveVisibleFetchWindows,
} from '../../../plugins/bank/utils/sync-task.js'
import {
  normalizeCatalogComparison,
  normalizeQuestionComparisonPage,
} from '../../../plugins/bank/utils/sync-question.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../plugins/bank')
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8')
const manifest = readFileSync(resolve(here, '../../../../service/plugins/bank/plugin.yaml'), 'utf8')
const router = readFileSync(resolve(here, '../../../src/router/index.js'), 'utf8')

const api = read('api/bank.js')
const textbookList = read('views/sync-textbook/index.vue')
const textbookDetail = read('views/sync-textbook/detail.vue')
const questionList = read('views/sync-question/index.vue')
const questionDetail = read('views/sync-question/detail.vue')

for (const endpoint of [
  '/bank/sync/textbook/tasks',
  '/bank/sync/question/options',
  '/bank/sync/question/tasks',
  'catalog-comparison',
  'question-comparison',
]) {
  assert.match(api, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
}

assert.match(textbookList, /新增同步教材任务/)
assert.match(textbookList, /acknowledgeSourcePolicy: true/)
assert.match(textbookDetail, /metadataRunId/)
assert.match(textbookDetail, /该任务抓取的完整版本与教材/)
assert.match(textbookDetail, /:description="applySuccess"/)
assert.match(textbookDetail, /formatTextbookApplyStats\(result\)/)
assert.match(questionList, /versionId: createForm\.versionId/)
assert.match(questionList, /textbookIds: \[\.\.\.new Set\(createForm\.textbookIds\)\]/)
assert.match(questionList, /缺少采集来源标识/)
assert.match(questionDetail, /服务端按本任务完整快照计算/)
// 2026-09-07: the "当前 N 路窗口" block was removed from the task page; the
// progress basis (pages scanned / estimated total, catalogs done) replaces it.
assert.doesNotMatch(questionDetail, /路窗口/)
assert.doesNotMatch(questionDetail, /fetchWindowLogText|resolveVisibleFetchWindows/)
assert.match(questionDetail, /summaryProgressBasis/)
assert.match(questionDetail, /已扫描 \$\{formatLiveCount\(live\.attemptedPages\)\}/)
assert.match(questionDetail, /sanitizeHtml/)
assert.doesNotMatch(questionDetail, /v-html/)
assert.match(questionDetail, /来源答案\/解析（未分类）/)
assert.match(questionDetail, /maxlength="120"/)
assert.match(questionDetail, /questionApplyStateToken\(task\.value\)/)
assert.match(questionDetail, /currentFormalSummary/)

// The menu is the only source of dynamic task routes.  Keep its canonical
// names/order stable so an installed plugin can upgrade without duplicate
// routes, while the old list permissions remain the menu visibility gates.
assert.match(manifest, /- name: 同步教材\n\s+path: sync-textbook[\s\S]*?routeName: BankSyncTextbookOverview[\s\S]*?perms: bank:sync:textbook:list[\s\S]*?orderNum: 8/)
assert.match(manifest, /- name: 同步题库\n\s+path: sync-question\n\s+component: plugin\/bank\/sync-question\/index\n\s+routeName: BankSyncQuestionOverview[\s\S]*?perms: bank:sync:question:list[\s\S]*?orderNum: 9/)
for (const permission of [
  'bank:sync:textbook:query',
  'bank:sync:textbook:add',
  'bank:sync:textbook:cancel',
  'bank:sync:textbook:retry',
  'bank:sync:textbook:remove',
  'bank:sync:textbook:apply',
  'bank:sync:question:query',
  'bank:sync:question:add',
  'bank:sync:question:cancel',
  'bank:sync:question:retry',
  'bank:sync:question:remove',
  'bank:sync:question:apply',
]) {
  assert.match(manifest, new RegExp(`code: ${permission.replaceAll(':', '\\:')}`))
}

assert.match(router, /permissions: \['bank:sync:textbook:query', 'bank:sync:textbook:list', 'bank:sync:center:list'\]/)
assert.match(router, /permissions: \['bank:sync:question:query', 'bank:sync:question:list', 'bank:sync:center:list'\]/)
assert.match(textbookList, /v-hasPermi="\['bank:sync:textbook:add', 'bank:sync:run'\]"/)
assert.match(questionList, /v-hasPermi="\['bank:sync:question:add', 'bank:sync:run'\]"/)
assert.match(textbookDetail, /bank:sync:textbook:retry/)
assert.match(questionDetail, /bank:sync:question:retry/)
assert.match(textbookDetail, /v-hasPermi="\['bank:sync:textbook:apply'\]"/)
assert.match(questionDetail, /v-hasPermi="\['bank:sync:question:apply'\]"/)
assert.match(api, /export function deleteTextbookSyncTask\(taskId\)/)
assert.match(api, /export function deleteQuestionSyncTask\(taskId\)/)
assert.match(api, /export function resumeQuestionSyncTask\(taskId\)/)
assert.match(api, /questionSyncTaskBaseUrl}\/\$\{encodeURIComponent\(taskId\)\}\/resume/)
assert.match(api, /resumeQuestionSyncTask\(taskId\)[\s\S]{0,220}method: "post"/)
assert.match(api, /export function applyQuestionSyncTask\(taskId, expectedCurrentTaskId = null, expectedStateToken = null\)/)
assert.match(api, /data\.expectedStateToken = expectedStateToken/)
assert.match(textbookList, /canDeleteSyncTask\(scope\.row\.status\)/)
assert.match(questionList, /canDeleteSyncTask\(scope\.row\.status\)/)
assert.match(questionList, /canResumeSyncTask\(scope\.row\)/)
assert.match(questionList, /bank:sync:question:resume/)
assert.match(questionList, /断点续采/)
assert.match(questionList, /await resumeQuestionSyncTask\(task\.taskId\)/)
assert.match(questionList, /await loadTasks\(true\)/)
assert.match(questionDetail, /canResumeSyncTask\(task\.value\)/)
assert.match(questionDetail, /bank:sync:question:resume/)
assert.match(questionDetail, /resumeQuestionSyncTask\(task\.value\.taskId\)/)
assert.match(questionDetail, /已有快照和断点保留，可断点续采；也可重试从头创建新任务/)
assert.match(questionList, /继续同一个任务、?[^\n]*Collector 新 run 会继承旧快照并从断点继续，不会直接应用正式库/)
assert.match(questionDetail, /继续同一个任务、?[^\n]*Collector 新 run 会继承旧快照并从断点继续，不会直接应用正式库/)
assert.match(questionDetail, /await resumeQuestionSyncTask\(task\.value\.taskId\)/)
assert.match(questionDetail, /await loadTask\(\)/)
assert.equal(canDeleteSyncTask('completed'), true)
assert.equal(canDeleteSyncTask('failed'), true)
assert.equal(canDeleteSyncTask('interrupted'), true)
assert.equal(canRetrySyncTask('interrupted'), true)
assert.equal(canCancelSyncTask('interrupted'), false)
assert.equal(isActiveSyncTask('interrupted'), false)
assert.equal(canDeleteSyncTask('running'), false)
assert.equal(normalizeSyncTaskStatus('interrupted'), 'interrupted')
assert.deepEqual(syncTaskStatusOptions.find((item) => item.value === 'interrupted'), { value: 'interrupted', label: '采集中断', type: 'warning' })
assert.deepEqual(syncTaskStatusMeta('interrupted'), { value: 'interrupted', label: '采集中断', type: 'warning' })
assert.equal(canResumeSyncTask('interrupted'), true)
assert.equal(canResumeSyncTask({ status: 'interrupted', resumeAvailable: true }), true)
assert.equal(canResumeSyncTask({ status: 'interrupted', resumeAvailable: false }), false)
assert.equal(canResumeSyncTask('blocked'), false)
assert.equal(canResumeSyncTask({ status: 'blocked', resumeAvailable: true }), true)
assert.equal(canResumeSyncTask({ status: 'blocked', resumeAvailable: false }), false)
assert.equal(canResumeSyncTask({ status: 'failed', resumeAvailable: true }), false)

// Creation payloads must not leak collector-owned IDs, URLs or view state.
assert.match(api, /acknowledgeSourcePolicy: data\?\.acknowledgeSourcePolicy === true/)
assert.match(api, /data: \{\n\s+versionId: data\?\.versionId,\n\s+textbookIds,\n\s+\}/)
assert.doesNotMatch(api, /createQuestionSyncTask\(data\)[\s\S]{0,500}data:\s*data[\s,}]/)

const task = normalizeSyncTask({
  data: {
    runId: 12,
    taskModule: 'question',
    status: 'completed',
    scopes: [{
      scopeId: 3,
      localTextbookId: 21,
      textbookNameSnapshot: '九年级上册',
      externalTextbookId: '260617',
      collectorRunId: 44,
      catalogCount: 8,
      questionCount: 19,
      questionCatalogCount: 17,
      questionTagCount: 16,
      questionAssetCount: 15,
    }],
    newCatalogCount: 2,
    changedCatalogCount: 1,
    newQuestionCount: 4,
    changedQuestionCount: 3,
  },
}, 'question')
assert.equal(task.taskId, '12')
assert.equal(task.status, 'completed')
assert.equal(task.scopeItems[0].collectorRunId, 44)
assert.equal(task.scopeItems[0].textbookName, '九年级上册')
assert.equal(task.newQuestionCount, 4)
assert.equal(task.changedCatalogCount, 1)
assert.equal(task.relationCount, 17)
assert.equal(task.tagCount, 16)
assert.equal(task.assetCount, 15)

const questionApplyTask = normalizeSyncTask({
  taskId: 21,
  status: 'completed',
  applyStatus: {
    eligible: true,
    isCurrent: false,
    currentTaskId: 19,
    suggestedAction: 'restore',
    affectedTextbooks: [
      { textbookId: 3, textbookName: '八年级上册', currentTaskId: 19, stateToken: 'scope-token-a' },
      { textbookId: 4, textbookName: '八年级下册', currentTaskId: 20, stateToken: 'scope-token-b' },
    ],
  },
  scopeItems: [{ textbookId: 3, textbookName: '八年级上册' }],
}, 'question')
assert.equal(questionApplyTask.eligible, true)
assert.equal(questionApplyTask.currentTaskId, 19)
assert.equal(questionApplyTask.suggestedAction, 'restore')
assert.equal(questionApplyWillReplace(questionApplyTask), true)
assert.deepEqual(questionApplyAffectedTextbooks(questionApplyTask), ['八年级上册', '八年级下册'])
assert.deepEqual(questionApplyStateToken(questionApplyTask), { '3': 'scope-token-a', '4': 'scope-token-b' })
assert.equal(questionApplyCurrentTaskSummary(questionApplyTask), '八年级上册：任务 19；八年级下册：任务 20')
assert.match(formatQuestionApplyStats({
  stats: { catalogCount: 2, questionCount: { inserted: 3, updated: 4 }, relationCount: 5, tagCount: 6, assetCount: 7 },
  affectedTextbooks: ['八年级上册', '八年级下册'],
}), /目录：新增 2/)
assert.match(formatQuestionApplyStats({
  stats: { catalogCount: 2, questionCount: { inserted: 3, updated: 4 }, relationCount: 5, tagCount: 6, assetCount: 7 },
  affectedTextbooks: ['八年级上册', '八年级下册'],
}), /受影响教材：八年级上册、八年级下册/)

const rollbackTask = normalizeSyncTask({
  task_id: 8,
  status: 'completed',
  eligible: true,
  is_current: false,
  current_task_id: 9,
  suggested_action: 'rollback',
}, 'textbook')
assert.equal(rollbackTask.currentTaskId, 9)
assert.equal(rollbackTask.suggestedAction, 'rollback')
assert.equal(textbookApplyActionLabel(rollbackTask), '回退到任务 8')
assert.equal(textbookTaskMeaning(rollbackTask), '采集已完成，当前未作为正式版本')

const restoredTask = normalizeSyncTask({
  taskId: 9,
  status: 'completed',
  eligible: true,
  currentTaskId: 8,
  suggestedAction: 'restore',
}, 'textbook')
assert.equal(textbookApplyActionLabel(restoredTask), '恢复任务 9')
restoredTask.isCurrent = true
assert.equal(textbookTaskMeaning(restoredTask), '已应用，当前正式版本')

assert.equal(formatTextbookApplyStats({
  stats: {
    versions: { inserted: 1, updated: 2, unchanged: 3, disabled: 4 },
    textbooks: { inserted: 5, updated: 6, unchanged: 7, disabled: 8 },
  },
}), '版本：新增 1，更新 2，未变 3，禁用 4；教材：新增 5，更新 6，未变 7，禁用 8')
assert.equal(syncTaskErrorMessage({ response: { data: { detail: '无权限应用教材快照' } } }), '无权限应用教材快照')

const explicitTokenTask = normalizeSyncTask({
  taskId: 22,
  status: 'completed',
  applyStatus: { eligible: true, currentStateToken: { '260617': 'token-1' } },
}, 'question')
assert.deepEqual(questionApplyStateToken(explicitTokenTask), { '260617': 'token-1' })

const stateTokensAliasTask = normalizeSyncTask({
  taskId: 23,
  status: 'completed',
  applyStatus: { eligible: true, stateTokens: { '260617': 'token-2', '260618': null } },
}, 'question')
assert.deepEqual(questionApplyStateToken(stateTokensAliasTask), { '260617': 'token-2', '260618': null })

assert.deepEqual(questionApplyStateToken({
  applyStatus: {
    scopes: [
      { externalTextbookId: '260617', stateToken: 'token-3' },
      { externalTextbookId: '260618', stateToken: null },
    ],
  },
}), { '260617': 'token-3', '260618': null })

assert.deepEqual(questionApplyAffectedTextbooks({
  applyStatus: { affectedTextbooks: [{ externalTextbookId: '260617' }] },
}), ['教材 260617'])
assert.match(questionDetail, /solutionHtml && !props\.snapshot\.answerHtml && !props\.snapshot\.analysisHtml/)

const options = normalizeQuestionSyncOptions({
  data: {
    versions: [{
      versionId: 10,
      versionName: '北师大版',
      sourceProvider: 'zujuan',
      externalVersionId: '195847',
      textbooks: [{
        textbookId: 21,
        textbookName: '九年级上册',
        externalTextbookId: '260617',
        sourceProvider: 'zujuan',
      }],
    }],
  },
})
assert.equal(options.versions[0].textbooks[0].disabled, false)

const unavailableOptions = normalizeQuestionSyncOptions({
  versions: [{
    versionId: 11,
    versionName: '无来源版本',
    sourceProvider: 'manual',
    externalVersionId: '',
    textbooks: [{ textbookId: 22, textbookName: '无来源教材', sourceProvider: 'manual' }],
  }],
})
assert.equal(unavailableOptions.versions[0].disabled, true)
assert.equal(unavailableOptions.versions[0].textbooks[0].disabled, true)

const page = unwrapSyncTaskPage({ data: { rows: [{ runId: 1, status: 'queued' }], total: 1 } }, 'textbook')
assert.equal(page.rows[0].taskId, '1')
assert.equal(page.total, 1)

const parsedWindows = parseFetchWindowsFromLogs([
  '[列表] catalog=261285 page=1 questions=10 total=10028',
  '[列表] catalog=261285 page=2 questions=10 total=10028',
  '[列表] catalog=261285 page=3 empty=1 total=10028',
])
assert.equal(parsedWindows.length, 1)
assert.equal(parsedWindows[0].catalogExternalId, '261285')
assert.equal(parsedWindows[0].slots.length, 3)
assert.equal(parsedWindows[0].slots[0].pageNumber, 1)
assert.equal(parsedWindows[0].slots[2].status, 'empty')

const liveWindowTask = normalizeSyncTask({
  taskId: 11,
  status: 'running',
  liveProgressByScope: {
    260617: {
      available: true,
      fetchWindows: [{
        catalogExternalId: '261285',
        catalogName: '1.2 探索规律',
        latestSourceTotal: 10028,
        slots: [
          { slot: 1, pageNumber: 47, status: 'saved', questionCount: 10, sourceTotal: 10028, line: 'catalog=261285 page=47 questions=10 total=10028' },
        ],
      }],
      tree: [],
    },
  },
  logs: ['[列表] catalog=261285 page=1 questions=10 total=10028'],
}, 'question')
assert.equal(liveWindowTask.liveProgressByScope['260617'].fetchWindows[0].slots[0].pageNumber, 47)
assert.equal(
  resolveVisibleFetchWindows(liveWindowTask.liveProgressByScope['260617'], liveWindowTask.logs)[0].slots[0].pageNumber,
  47,
)
assert.equal(
  resolveVisibleFetchWindows({ fetchWindows: [] }, liveWindowTask.logs)[0].slots[0].pageNumber,
  1,
)

const singleScope = normalizeSyncTask({ taskId: 4, scope: { textbookId: 8, collectorRunId: 12 } }, 'question')
assert.equal(singleScope.scopeItems.length, 1)
assert.equal(singleScope.scopeItems[0].collectorRunId, 12)

const pendingScope = normalizeSyncTask({
  taskId: 5,
  scopes: [{ textbookId: 8, runId: 5, collectorRunId: null, status: 'running' }],
}, 'question')
assert.equal(pendingScope.scopeItems[0].collectorRunId, '')

const interruptedTask = normalizeSyncTask({
  taskId: 6,
  status: 'interrupted',
  resumeAvailable: true,
  scopeItems: [{ textbookId: 8, resumeFromCollectorRunId: 'collector-run-old', status: 'interrupted' }],
}, 'question')
assert.equal(interruptedTask.status, 'interrupted')
assert.equal(interruptedTask.resumeAvailable, true)
assert.equal(interruptedTask.scopeItems[0].resumeFromCollectorRunId, 'collector-run-old')
assert.equal(canResumeSyncTask(interruptedTask), true)

const flatCatalog = normalizeCatalogComparison({
  fetchedTree: [
    { sourceProvider: 'zujuan', externalNodeId: 'child', parentExternalId: 'root', nodeName: '子目录' },
    { sourceProvider: 'zujuan', externalNodeId: 'root', nodeName: '根目录' },
  ],
  currentTree: [],
})
assert.equal(flatCatalog.fetchedTree[0].children[0].externalNodeId, 'child')

const questionPage = normalizeQuestionComparisonPage({
  data: {
    rows: [{
      sourceProvider: 'zujuan',
      externalQuestionId: 'question-1',
      comparisonStatus: 'new',
      fetched: { contentHtml: '<p>题干</p>' },
      current: null,
    }],
    page: { pageNum: 2, pageSize: 20, total: 41, hasNext: true },
  },
})
assert.equal(questionPage.rows[0].externalQuestionId, 'question-1')
assert.equal(questionPage.rows[0].comparisonStatus, 'new')
assert.equal(questionPage.total, 41)

const unclassifiedQuestion = normalizeQuestionComparisonPage({
  rows: [{
    sourceProvider: 'zujuan',
    externalQuestionId: 'question-solution',
    fetched: {
      contentHtml: '<p>题干</p>',
      solutionHtml: '<p>来源答案/解析</p>',
    },
    current: {
      contentHtml: '<p>正式题干</p>',
      answerHtml: '<p>B</p>',
      analysisHtml: '<p>因为……</p>',
    },
  }],
})
assert.equal(unclassifiedQuestion.rows[0].fetched.solutionHtml, '<p>来源答案/解析</p>')
assert.equal(unclassifiedQuestion.rows[0].fetched.answerHtml, '')
assert.equal(unclassifiedQuestion.rows[0].fetched.analysisHtml, '')
assert.equal(unclassifiedQuestion.rows[0].current.answerHtml, '<p>B</p>')
assert.equal(unclassifiedQuestion.rows[0].current.analysisHtml, '<p>因为……</p>')

console.log('sync task module assertions passed')
