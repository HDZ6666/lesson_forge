import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canDeleteSyncTask } from '../../../plugins/bank/utils/sync-task.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relativePath) => readFileSync(resolve(here, '../../../plugins/bank', relativePath), 'utf8')
const textbookList = read('views/sync-textbook/index.vue')
const questionList = read('views/sync-question/index.vue')
const textbookDetail = read('views/sync-textbook/detail.vue')
const questionDetail = read('views/sync-question/detail.vue')

for (const [view, removePermission, deleteCall, formalData] of [
  [textbookList, 'bank:sync:textbook:remove', 'deleteTextbookSyncTask', '正式教材数据'],
  [questionList, 'bank:sync:question:remove', 'deleteQuestionSyncTask', '正式题库数据'],
]) {
  assert.match(view, /<el-table-column type="selection"/)
  assert.match(view, /@selection-change="handleSelectionChange"/)
  assert.match(view, /:selectable="isSelectableTask"/)
  assert.match(view, /const selectedRows = ref\(\[\]\)/)
  assert.match(view, /批量删除（\{\{ selectedRows\.length \}\}）/)
  assert.match(view, new RegExp(`v-hasPermi="\\['${removePermission}', 'bank:sync:run'\\]"`))
  assert.match(view, /function batchDeleteTasks\(\)/)
  assert.match(view, new RegExp(`await ${deleteCall}\\(task\.taskId\\)`))
  assert.match(view, /for \(const task of targets\)/)
  assert.match(view, /成功 \$\{succeeded\.length\} 个，失败 \$\{failed\.length\} 个/)
  assert.match(view, new RegExp(`不会删除[^。]*${formalData}`))
  if (formalData === '正式题库数据') {
    assert.match(view, /不会删除 Collector 不可变快照、断点或正式题库数据/)
    assert.match(view, /任务删除后将无法再从页面继续该任务/)
  }
  assert.match(view, /function clearSelection\(\)/)
  assert.match(view, /clearSelection\(\)/)
  assert.match(view, /selectedRows\.value\.length \|\| batchDeleting\.value/)
  assert.match(view, /scheduleRefresh\(\)\n\s+return/)
}

for (const status of ['completed', 'failed', 'blocked', 'interrupted', 'cancelled']) assert.equal(canDeleteSyncTask(status), true)
for (const status of ['queued', 'starting', 'running', 'cancelling']) assert.equal(canDeleteSyncTask(status), false)

const textbookComparison = textbookDetail.indexOf('class="comparison-panel"')
const textbookSummary = textbookDetail.indexOf('class="task-summary panel"')
const questionSummary = questionDetail.indexOf('class="task-summary panel"')
const questionWindows = questionDetail.indexOf('class="log-panel fetch-window-log"')
const questionLogs = questionDetail.indexOf('运行日志')
const questionTree = questionDetail.indexOf('class="live-catalog-panel panel"')
const questionComparison = questionDetail.indexOf('class="comparison-workspace panel"')
assert.ok(textbookComparison >= 0 && textbookComparison < textbookSummary, '教材对比应位于任务摘要上方')
assert.ok(questionSummary >= 0 && questionWindows > questionSummary, '8 路窗口应在任务摘要内')
assert.ok(questionLogs > questionWindows, '8 路窗口应位于运行日志上方')
assert.ok(questionTree > questionLogs, '采集中先看窗口和日志，目录树放在后面')
assert.ok(questionComparison > questionTree, '完成后的快照对比仍在目录树下方')

console.log('sync batch delete and detail layout assertions passed')
