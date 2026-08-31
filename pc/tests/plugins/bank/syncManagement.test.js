import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildSyncReviewItems,
  canReviewSyncRow,
  comparisonStatusOptions,
  formatSyncSnapshot,
  normalizeSyncComparisonRow,
  normalizeSyncRow,
  normalizeSyncSummary,
  reviewStatusOptions,
  syncComparisonRowKey,
  unwrapSyncCompare,
  unwrapMetadataSnapshot,
} from '../../../plugins/bank/utils/sync.js'
import {
  isActiveSyncRunStatus,
  isTerminalSyncRunStatus,
  normalizeSyncRun,
  syncRunProgress,
  unwrapSyncRun,
} from '../../../plugins/bank/utils/sync-run.js'

const here = dirname(fileURLToPath(import.meta.url))
const views = resolve(here, '../../../plugins/bank/views/sync')
const component = readFileSync(resolve(views, 'components/SyncComparePage.vue'), 'utf8')
const runComponent = readFileSync(resolve(views, 'components/SyncRunPanel.vue'), 'utf8')
const runUtils = readFileSync(resolve(here, '../../../plugins/bank/utils/sync-run.js'), 'utf8')
const api = readFileSync(resolve(here, '../../../plugins/bank/api/bank.js'), 'utf8')
const center = readFileSync(resolve(views, 'index.vue'), 'utf8')

for (const name of ['version', 'textbook', 'catalog', 'question']) {
  const view = readFileSync(resolve(views, name, 'index.vue'), 'utf8')
  assert.match(view, /SyncComparePage/)
  assert.match(view, new RegExp(`entity-type="${name}"`))
}

assert.match(api, /\/bank\/sync\/.+\/compare/)
assert.match(api, /\/bank\/sync\/.+\/review/)
assert.match(api, /\/bank\/sync\/run/)
assert.match(api, /getCurrentSyncRun/)
assert.match(api, /getSyncRun/)
assert.match(api, /listSyncRuns/)
assert.match(api, /cancelSyncRun/)
assert.match(api, /startMetadataSyncRun/)
assert.match(api, /startContentSyncRun/)
assert.match(api, /metadata\/snapshot/)
assert.match(api, /syncRunBaseUrl}\/metadata\/start/)
assert.match(api, /syncRunBaseUrl}\/content\/start/)
assert.match(component, /<SyncRunPanel @completed="handleRunCompleted" \/>/)
assert.match(component, /function handleRunCompleted\(\)/)
assert.doesNotMatch(runComponent, /一键同步/)
assert.match(runComponent, /刷新版本与教材/)
assert.equal((runComponent.match(/v-hasPermi="\['bank:sync:run'\]"/g) || []).length, 2)
assert.match(runComponent, /startMetadataSyncRun\(\)/)
assert.match(runComponent, /startMetadataSyncRun|来源中的版本和教材元数据/)
assert.match(runComponent, /轮询|pollRun|schedulePoll/)
assert.match(runComponent, /停止同步/)
assert.match(runComponent, /版本/)
assert.match(runComponent, /run\.versionsCompleted/)
assert.match(runComponent, /onBeforeUnmount/)
assert.match(runComponent, /clearPollTimer/)
assert.match(runComponent, /requestError\.value = ''/) 
assert.match(runUtils, /metadata/)
assert.match(runUtils, /catalogs_questions/)
assert.match(runUtils, /normalizeSyncRun/)
assert.match(runUtils, /unwrapSyncRun/)
assert.match(component, /采集库是候选数据；审核通过仅进入待发布，正式数据仍需通过发布批次合并/)
assert.match(component, /sourceAvailable === false/)
assert.match(component, /ElMessageBox\.confirm/)
assert.match(component, /ElMessageBox\.prompt/)
assert.match(component, /stagedHash/)
assert.match(component, /reviewComment/)
assert.equal((component.match(/v-hasPermi="\['bank:sync:review'\]"/g) || []).length, 6)
assert.match(component, /:row-key="syncRowKey"/)
assert.match(component, /审核记录/)
assert.match(component, /entityType === 'textbook'/)
assert.match(component, /entityType === 'catalog'/)
assert.doesNotMatch(component, /entityType !== 'version'/)
assert.doesNotMatch(component, /v-html/)
assert.deepEqual(comparisonStatusOptions.map((item) => item.value), ['new', 'changed', 'unchanged', 'conflict'])
assert.deepEqual(reviewStatusOptions.map((item) => item.value), ['pending', 'approved', 'rejected', 'stale'])

const result = unwrapSyncCompare({
  data: {
    rows: [{
      sourceProvider: 'zujuan',
      externalId: 'q-1',
      candidate: { plainText: '<p>候选题目</p>', lastSeenAt: '2026-08-26T10:00:00Z' },
      current: { plainText: '旧题目' },
      stagedHash: 'hash-1',
      comparisonStatus: 'changed',
      reviewStatus: 'pending',
      changedFields: ['plainText'],
    }],
    page: { total: 9, pageNum: 2, pageSize: 10 },
    source_available: true,
    summary: { total: 9, changed: 1, pending: 1, conflictCount: 2, staleCount: 3 },
  },
})
assert.equal(result.total, 9)
assert.equal(result.pageNum, 2)
assert.equal(result.pageSize, 10)
assert.equal(result.rows[0].externalId, 'q-1')
assert.equal(result.rows[0].stagedData.plainText, '<p>候选题目</p>')
assert.equal(result.rows[0].currentData.plainText, '旧题目')
assert.equal(result.rows[0].stagedHash, 'hash-1')
assert.equal(result.rows[0].comparisonStatus, 'changed')
assert.equal(result.rows[0].reviewStatus, 'pending')
assert.deepEqual(result.rows[0].diffFields, ['plainText'])
assert.equal(result.rows[0].collectedAt, '2026-08-26T10:00:00Z')
assert.equal(result.sourceAvailable, true)
assert.equal(canReviewSyncRow(result.rows[0]), true)
assert.deepEqual(buildSyncReviewItems(result.rows), [{ sourceProvider: 'zujuan', externalId: 'q-1', stagedHash: 'hash-1' }])
assert.equal(canReviewSyncRow(normalizeSyncComparisonRow({ comparisonStatus: 'conflict', stagedHash: 'x'.repeat(64) })), false)
assert.equal(syncComparisonRowKey(result.rows[0]), 'zujuan:q-1')
assert.notEqual(syncComparisonRowKey({ sourceProvider: 'other', externalId: 'q-1' }), syncComparisonRowKey(result.rows[0]))
assert.equal(canReviewSyncRow(normalizeSyncRow({ externalId: 'q-2' })), false)
assert.equal(normalizeSyncComparisonRow({ candidate: { name: '教材' }, current: { name: '旧教材' }, changedFields: ['name'] }).stagedData.name, '教材')
assert.equal(normalizeSyncComparisonRow({ comparisonStatus: 'conflict', reviewStatus: 'stale' }).comparisonStatus, 'conflict')
assert.equal(normalizeSyncComparisonRow({ comparisonStatus: 'conflict', reviewStatus: 're_review' }).reviewStatus, 'stale')
assert.deepEqual(normalizeSyncComparisonRow({ reviewed_by: '管理员', reviewed_at: '2026-08-26', review_comment: '已核对' }), {
  reviewed_by: '管理员',
  reviewed_at: '2026-08-26',
  review_comment: '已核对',
  externalId: '',
  sourceProvider: '',
  stagedHash: '',
  stagedData: {},
  currentData: {},
  comparisonStatus: undefined,
  reviewStatus: 'pending',
  diffFields: [],
  collectedAt: '',
  reviewedBy: '管理员',
  reviewedAt: '2026-08-26',
  reviewComment: '已核对',
})

assert.equal(result.summary.conflict, 2)
assert.equal(result.summary.conflictCount, 2)
assert.equal(result.summary.stale, 3)
assert.equal(result.summary.staleCount, 3)
const summary = normalizeSyncSummary({}, [...result.rows, { comparisonStatus: 'conflict', reviewStatus: 'stale' }])
assert.equal(summary.derived, true)
assert.equal(summary.pageChanged, 1)
assert.equal(summary.pagePending, 1)
assert.equal(summary.pageConflict, 1)
assert.equal(summary.pageStale, 1)
assert.match(formatSyncSnapshot({ contentHtml: '<script>alert(1)</script><p>安全文本</p>' }, 'question'), /安全文本/)
assert.doesNotMatch(formatSyncSnapshot({ contentHtml: '<script>alert(1)</script><p>安全文本</p>' }, 'question'), /<script>/i)

const run = normalizeSyncRun({
  data: { ignored: true },
  run_id: 'run-1',
  status: 'running',
  phase: 'catalogs-questions',
  progress: { current: 3, total: 10 },
  version_count: 1,
  versions_completed: 1,
  textbooks_total: 4,
  textbooks_completed: 2,
  catalog_count: 7,
  question_count: 18,
  current_textbook: { name: '数学九年级上册', external_id: 'tb-1' },
  log_tail: ['metadata ok', 'catalogs ok'],
})
assert.equal(run.runId, 'run-1')
assert.equal(run.status, 'running')
assert.equal(run.phase, 'catalogs_questions')
assert.equal(run.versionsTotal, 1)
assert.equal(run.versionsCompleted, 1)
assert.equal(run.currentTextbook, '数学九年级上册（tb-1）')
assert.equal(run.textbooksTotal, 4)
assert.equal(run.textbooksCompleted, 2)
assert.equal(run.catalogCount, 7)
assert.equal(run.questionCount, 18)
assert.equal(run.progress, 30)
assert.deepEqual(run.logs, ['metadata ok', 'catalogs ok'])
assert.equal(syncRunProgress(run), 30)
assert.equal(isActiveSyncRunStatus(run.status), true)
assert.equal(isTerminalSyncRunStatus(run.status), false)
assert.equal(unwrapSyncRun({ code: 200, data: { runId: 'run-2', status: 'completed' } }).runId, 'run-2')
assert.equal(unwrapSyncRun({ code: 200, data: null }), null)

console.log('sync management assertions passed')

const snapshot = unwrapMetadataSnapshot({
  data: {
    sourceAvailable: true,
    metadataRunId: 17,
    versions: [{
      sourceProvider: 'zujuan',
      externalId: 'v-1',
      versionName: '人教版',
      stagedHash: 'v'.repeat(64),
      comparisonStatus: 'unchanged',
      textbooks: [{
        sourceProvider: 'zujuan',
        externalId: 'tb-1',
        textbookName: '九年级上册',
        stagedHash: 't'.repeat(64),
        comparisonStatus: 'new',
      }],
    }],
  },
})
assert.equal(snapshot.metadataRunId, 17)
assert.equal(snapshot.versions[0].textbooks[0].externalId, 'tb-1')
assert.match(center, /同步中心/)
assert.match(center, /刷新版本与教材/)
assert.match(center, /来源候选/)
assert.match(center, /本次同步范围/)
assert.match(center, /同步所选教材内容/)
assert.match(center, /题库内容/)
assert.match(center, /同步记录/)
assert.match(center, /目录和题目属于同一教材内容范围/)
assert.match(center, /sourceProvider: textbook\.sourceProvider/)
assert.doesNotMatch(center, /v-html/)
