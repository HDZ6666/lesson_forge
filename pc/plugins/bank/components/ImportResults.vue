<template>
  <section class="import-results" aria-label="入库批次与暂缓题目">
    <div class="result-heading">
      <h3>入库记录</h3>
      <el-select v-model="state.selectedId" aria-label="选择入库记录" placeholder="本轮尚无入库记录" @change="selectImport">
        <el-option v-for="row in state.history" :key="row.importId" :value="row.importId" :label="recordLabel(row)" />
      </el-select>
      <el-button :loading="state.historyLoading || state.pageLoading" @click="refresh">刷新结果</el-button>
      <el-button v-if="state.nextBeforeId" :loading="state.historyLoading" link @click="loadHistory(true)">更多历史记录</el-button>
    </div>
    <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" show-icon />
    <el-alert v-if="state.selected && !state.selected.currentBinding" title="历史运行成果：用于查看之前已提交的批次，不代表本轮采集或入库结果。" type="warning" :closable="false" />
    <p v-if="state.selected" class="result-note">入库编号 {{ state.selected.importId }} · 合格已合并 {{ state.selected.acceptedCount }} 题 · 暂缓 {{ state.selected.quarantinedCount }} 题</p>
    <p v-if="hasNewBatches" class="result-note">已有新批次提交，点击“刷新结果”查看最新结果。</p>
    <p v-if="!state.selectedId && !state.historyLoading" class="result-note">本轮尚未提交入库批次；之前的记录可从上方选择。</p>
    <el-tabs v-if="state.selectedId" v-model="state.activeTab" @tab-change="loadActive">
      <el-tab-pane label="已提交批次" name="batches">
        <el-table :data="state.pages.batches.items" v-loading="state.pageLoading" empty-text="当前范围暂无已提交批次">
          <el-table-column prop="batchNo" label="批次" width="80" />
          <el-table-column prop="processedCount" label="处理题数" width="110" />
          <el-table-column prop="acceptedCount" label="合格合并" width="110" />
          <el-table-column prop="quarantinedCount" label="暂缓题数" width="110" />
          <el-table-column label="新增题目" width="110"><template #default="{ row }">{{ row.stats?.questions?.inserted ?? '—' }}</template></el-table-column>
          <el-table-column label="更新题目" width="110"><template #default="{ row }">{{ row.stats?.questions?.updated ?? '—' }}</template></el-table-column>
          <el-table-column label="提交时间"><template #default="{ row }">{{ formatImportTime(row.committedAt) }}</template></el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="暂缓题目" name="issues">
        <p class="result-note">以下题目在该次入库中被暂缓，原因不会改变已提交的合格成果。后续是否修复需要对应题目的新检查结果。</p>
        <el-table :data="state.pages.issues.items" v-loading="state.pageLoading" row-key="resultKey" empty-text="当前范围暂无暂缓题目">
          <el-table-column prop="questionId" label="来源题目 ID" width="190" />
          <el-table-column prop="batchNo" label="批次" width="80" />
          <el-table-column prop="reason" label="暂缓原因" min-width="260" />
          <el-table-column label="记录时间" width="180"><template #default="{ row }">{{ formatImportTime(row.recordedAt) }}</template></el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
    <div v-if="state.selectedId && activePage.loaded" class="result-pagination">
      <span>截至批次 {{ activePage.page.upToBatchNo }} · 共 {{ activePage.page.total }} {{ state.activeTab === 'batches' ? '批' : '道暂缓题' }} · 第 {{ activePage.positions.length + 1 }} 页</span>
      <el-button :disabled="state.pageLoading || !activePage.positions.length" @click="previous">上一页</el-button>
      <el-button :disabled="state.pageLoading || !activePage.page.hasNext" @click="next">下一页</el-button>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import { listQuestionImports, listQuestionImportBatches, listQuestionImportIssues } from '../api/bank'
import { formatImportTime } from '../utils/sync-task'
import { createImportResultsModel, createImportResultsState } from '../utils/import-results'

const props = defineProps({ taskId: { type: Number, required: true }, currentImportId: Number, currentBatchNo: { type: Number, default: 0 } })
const state = reactive(createImportResultsState())
const model = createImportResultsModel({ history: listQuestionImports, batches: listQuestionImportBatches, issues: listQuestionImportIssues }, state)
const activePage = computed(() => state.pages[state.activeTab])
const hasNewBatches = computed(() => state.selectedId === props.currentImportId && activePage.value.loaded && props.currentBatchNo > (activePage.value.page.upToBatchNo || 0))
const recordLabel = row => `${row.currentBinding ? '当前运行' : '历史运行'} · 入库 ${row.importId} · ${formatImportTime(row.createdAt)}`
const { selectImport, loadHistory, loadActive, refresh, next, previous } = model
watch(() => [props.taskId, props.currentImportId], () => model.reset(props.taskId, props.currentImportId), { immediate: true })
onBeforeUnmount(model.dispose)
</script>

<style scoped>
.import-results { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--el-border-color-light); }
.result-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.result-heading h3 { margin: 0; font-size: 16px; }.result-heading .el-select { width: min(430px, 100%); }
.result-note { color: var(--el-text-color-secondary); font-size: 13px; }.el-alert { margin-top: 12px; }
.result-pagination { display: flex; align-items: center; justify-content: flex-end; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
.result-pagination span { margin-right: auto; font-size: 13px; color: var(--el-text-color-secondary); }
</style>
