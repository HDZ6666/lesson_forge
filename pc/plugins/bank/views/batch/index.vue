<template>
  <div class="app-container bank-page">
    <div class="page-heading">
      <div><h2>同步批次</h2></div>
      <el-button link type="primary" :icon="Refresh" :loading="loading" @click="loadBatches">刷新</el-button>
    </div>
    <el-alert v-if="errorMessage" class="state-alert" type="error" :closable="false" show-icon>{{ errorMessage }}</el-alert>
    <section class="panel">
      <el-form :inline="true" :model="filters" class="filter-form" @submit.prevent="searchBatches">
        <el-form-item label="批次号"><el-input v-model="filters.batchNo" clearable placeholder="批次号" @keyup.enter="searchBatches" /></el-form-item>
        <el-form-item label="状态"><el-select v-model="filters.status" clearable placeholder="全部" class="status-select"><el-option v-for="status in statusOptions" :key="status.value" :label="status.label" :value="status.value" /></el-select></el-form-item>
        <el-form-item><el-button type="primary" :icon="Search" @click="searchBatches">查询</el-button><el-button :icon="RefreshLeft" @click="resetFilters">重置</el-button></el-form-item>
      </el-form>
      <el-table v-loading="loading" :data="batches" size="small" stripe class="batch-table" @row-click="openReport">
        <el-table-column prop="batchNo" label="批次号" min-width="170" show-overflow-tooltip />
        <el-table-column label="状态" width="116" align="center"><template #default="scope"><el-tag size="small" :type="statusType(scope.row.status)">{{ statusLabel(scope.row.status) }}</el-tag></template></el-table-column>
        <el-table-column prop="sourceProvider" label="来源" width="105" show-overflow-tooltip />
        <el-table-column label="数据量" min-width="210"><template #default="scope"><div class="count-line"><span>题目 {{ scope.row.questionCount ?? 0 }}</span><span>目录 {{ scope.row.catalogCount ?? 0 }}</span><span>素材 {{ scope.row.assetCount ?? 0 }}</span></div></template></el-table-column>
        <el-table-column prop="createTime" label="创建时间" width="170" show-overflow-tooltip />
        <el-table-column prop="publishedAt" label="发布时间" width="170" show-overflow-tooltip />
        <el-table-column label="报告" width="84" align="center"><template #default><el-button link type="primary" :icon="DocumentChecked" title="查看校验与差异报告" aria-label="查看校验与差异报告" /></template></el-table-column>
        <el-table-column label="操作" width="170" fixed="right" align="center">
          <template #default="scope">
            <el-button v-if="canApprove(scope.row)" v-hasPermi="['bank:batch:approve']" link type="primary" :icon="CircleCheck" title="批准" aria-label="批准" @click.stop="approve(scope.row)" />
            <el-button v-if="canPublish(scope.row)" v-hasPermi="['bank:batch:publish']" link type="success" :icon="Upload" title="发布" aria-label="发布" :loading="publishingId === scope.row.batchId" @click.stop="publish(scope.row)" />
            <el-button v-if="canRollback(scope.row)" v-hasPermi="['bank:batch:rollback']" link type="danger" :icon="RefreshLeft" title="回退" aria-label="回退" @click.stop="rollback(scope.row)" />
            <span v-if="publishingId === scope.row.batchId" class="polling-label">处理中</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !batches.length" :image-size="72" description="暂无同步批次" />
      <div class="table-footer"><span class="result-count">共 {{ total }} 个批次</span><el-pagination v-model:current-page="filters.pageNum" v-model:page-size="filters.pageSize" :total="total" :page-sizes="[10, 20, 50]" layout="sizes, prev, pager, next, total" background @size-change="loadBatches" @current-change="loadBatches" /></div>
    </section>

    <el-drawer v-model="reportVisible" title="批次报告" direction="rtl" size="min(700px, 92vw)" append-to-body>
      <el-skeleton v-if="loadingReport" :rows="8" animated />
      <el-empty v-else-if="!reportBatch" description="未找到批次" />
      <template v-else>
        <div class="report-heading"><strong>{{ reportBatch.batchNo || `批次 ${reportBatch.batchId}` }}</strong><el-tag size="small" :type="statusType(reportBatch.status)">{{ statusLabel(reportBatch.status) }}</el-tag></div>
        <el-tabs v-model="reportTab">
          <el-tab-pane label="校验报告" name="validation"><ReportContent :value="reportBatch.validationReportJson" empty-text="暂无校验报告" /></el-tab-pane>
          <el-tab-pane label="差异报告" name="diff"><ReportContent :value="reportBatch.diffReportJson" empty-text="暂无差异报告" /></el-tab-pane>
        </el-tabs>
        <el-descriptions :column="2" border size="small" class="report-summary"><el-descriptions-item label="批次类型">{{ reportBatch.batchType || 'full' }}</el-descriptions-item><el-descriptions-item label="结构版本">{{ reportBatch.schemaVersion || '未记录' }}</el-descriptions-item><el-descriptions-item label="包摘要" :span="2">{{ reportBatch.artifactSha256 || '未记录' }}</el-descriptions-item><el-descriptions-item v-if="reportBatch.errorMessage" label="错误" :span="2">{{ reportBatch.errorMessage }}</el-descriptions-item></el-descriptions>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { defineComponent, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { CircleCheck, DocumentChecked, Refresh, RefreshLeft, Search, Upload } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { approveBatch, getBatch, listBatches, publishBatch, rollbackBatch } from '../../api/bank'
import { isBatchActionable, isTerminalBatchStatus } from '../../utils/state'
import { unwrapPage } from '../../utils/response'

const ReportContent = defineComponent({
  name: 'BankReportContent',
  props: {
    value: { type: [Object, Array, String, Number, Boolean], default: null },
    emptyText: { type: String, default: '暂无报告' },
  },
  setup(props) {
    return () => h(
      'div',
      { class: 'report-content' },
      props.value === null || props.value === undefined || props.value === ''
        ? props.emptyText
        : h('pre', JSON.stringify(props.value, null, 2)),
    )
  },
})

const batches = ref([])
const total = ref(0)
const loading = ref(false)
const loadingReport = ref(false)
const reportVisible = ref(false)
const reportBatch = ref(null)
const reportTab = ref('validation')
const publishingId = ref(null)
const errorMessage = ref('')
const pollTimers = new Map()
const filters = reactive({ batchNo: '', status: undefined, pageNum: 1, pageSize: 10 })
const statusOptions = [
  { value: 'building', label: '构建中' }, { value: 'validating', label: '校验中' }, { value: 'validated', label: '已校验' },
  { value: 'approval_pending', label: '待批准' }, { value: 'approved', label: '已批准' }, { value: 'publishing', label: '发布中' },
  { value: 'published', label: '已发布' }, { value: 'failed', label: '失败' }, { value: 'archived', label: '已归档' }, { value: 'rolled_back', label: '已回退' },
]

function statusLabel(value) { return statusOptions.find((item) => item.value === value)?.label || value || '未知' }
function statusType(value) { return ({ building: 'info', validating: 'warning', validated: 'warning', approval_pending: 'warning', approved: 'primary', publishing: 'warning', published: 'success', failed: 'danger', archived: 'info', rolled_back: 'info' })[value] || 'info' }
function canApprove(batch) { return isBatchActionable(batch, 'approve') }
function canPublish(batch) { return isBatchActionable(batch, 'publish') }
function canRollback(batch) { return isBatchActionable(batch, 'rollback') }

async function loadBatches() {
  loading.value = true
  errorMessage.value = ''
  try {
    const page = unwrapPage(await listBatches({ ...filters }))
    batches.value = page.rows
    total.value = page.total
  } catch (error) {
    batches.value = []
    total.value = 0
    errorMessage.value = error?.message || '批次加载失败，请稍后重试'
  } finally { loading.value = false }
}
function searchBatches() { filters.pageNum = 1; loadBatches() }
function resetFilters() { filters.batchNo = ''; filters.status = undefined; filters.pageNum = 1; loadBatches() }

async function openReport(row) {
  reportVisible.value = true
  loadingReport.value = true
  reportBatch.value = null
  reportTab.value = 'validation'
  try {
    const result = await getBatch(row.batchId)
    reportBatch.value = result?.data && !result.batchId ? result.data : result
  } catch (error) {
    ElMessage.error(error?.message || '报告加载失败')
  } finally { loadingReport.value = false }
}

async function approve(row) {
  try {
    await ElMessageBox.confirm(`确定批准批次“${row.batchNo || row.batchId}”吗？`, '批准确认', { type: 'warning', confirmButtonText: '批准', cancelButtonText: '取消' })
    await approveBatch(row.batchId)
    ElMessage.success('批次已提交批准')
    await loadBatches()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '批准失败')
  }
}

async function publish(row) {
  try {
    await ElMessageBox.confirm(`确定发布批次“${row.batchNo || row.batchId}”吗？发布会切换正式题库。`, '发布确认', { type: 'warning', confirmButtonText: '发布', cancelButtonText: '取消' })
    publishingId.value = row.batchId
    await publishBatch(row.batchId)
    ElMessage.success('发布请求已提交')
    pollBatch(row.batchId)
  } catch (error) {
    publishingId.value = null
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '发布失败')
  }
}

async function rollback(row) {
  try {
    await ElMessageBox.confirm(`确定回退批次“${row.batchNo || row.batchId}”吗？`, '回退确认', { type: 'warning', confirmButtonText: '回退', cancelButtonText: '取消' })
    await rollbackBatch(row.batchId)
    ElMessage.success('回退请求已提交')
    await loadBatches()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '回退失败')
  }
}

function pollBatch(batchId) {
  if (pollTimers.has(batchId)) return
  const tick = async () => {
    try {
      const result = await getBatch(batchId)
      const current = result?.data && !result.batchId ? result.data : result
      const index = batches.value.findIndex((item) => item.batchId === batchId)
      if (index >= 0) batches.value[index] = { ...batches.value[index], ...current }
      if (isTerminalBatchStatus(current?.status)) { publishingId.value = null; pollTimers.delete(batchId); await loadBatches(); return }
    } catch { /* the next poll retries transient failures */ }
    const timer = window.setTimeout(tick, 2500)
    pollTimers.set(batchId, timer)
  }
  tick()
}

onMounted(loadBatches)
onBeforeUnmount(() => { for (const timer of pollTimers.values()) window.clearTimeout(timer); pollTimers.clear() })
</script>

<style scoped>
.bank-page { min-height: calc(100vh - 84px); color: var(--el-text-color-primary); }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 16px; }
.page-heading h2 { margin: 0; font-size: 20px; font-weight: 600; }
.state-alert { margin-bottom: 14px; }
.panel { min-width: 0; padding: 16px; border: 1px solid var(--el-border-color-light); border-radius: 6px; background: var(--el-bg-color); }
.filter-form { margin-bottom: 6px; }
.filter-form :deep(.el-form-item) { margin-bottom: 10px; }
.filter-form :deep(.el-input) { width: 190px; }
.status-select { width: 150px; }
.count-line { display: flex; flex-wrap: wrap; gap: 10px; color: var(--el-text-color-secondary); font-size: 12px; }
.batch-table :deep(.el-table__row) { cursor: pointer; }
.polling-label { color: var(--el-color-warning); font-size: 12px; }
.table-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; }
.result-count { flex: none; color: var(--el-text-color-secondary); font-size: 12px; }
.table-footer :deep(.el-pagination) { flex-wrap: wrap; justify-content: flex-end; }
.report-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.report-content { min-height: 160px; padding: 10px 0; }
.report-content pre { max-height: 460px; margin: 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 var(--el-font-family); }
.report-summary { margin-top: 18px; }
@media (max-width: 680px) { .table-footer { align-items: flex-start; flex-direction: column; } .table-footer :deep(.el-pagination) { justify-content: flex-start; } }
</style>
