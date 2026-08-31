<template>
  <div class="app-container sync-compare-page">
    <div class="page-heading">
      <div>
        <h2>{{ title }}</h2>
        <p class="page-subtitle">采集库是候选数据；审核通过仅进入待发布，正式数据仍需通过发布批次合并。</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="loadList">刷新</el-button>
    </div>

    <SyncRunPanel @completed="handleRunCompleted" />

    <el-alert v-if="sourceAvailable === false" class="source-alert" type="warning" :closable="false" show-icon>
      <template #title>采集数据暂不可用</template>
      {{ sourceMessage || '当前没有可用的采集库数据，请先完成同步采集。页面不会伪造候选数据。' }}
    </el-alert>
    <el-alert v-if="errorMessage" class="state-alert" type="error" :closable="false" show-icon>{{ errorMessage }}</el-alert>

    <section class="summary-grid" aria-label="同步统计">
      <div v-for="item in summaryCards" :key="item.key" class="summary-card" :class="`summary-${item.tone}`">
        <span class="summary-label">{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
      </div>
    </section>

    <section class="panel">
      <el-form ref="queryRef" :model="query" :inline="true" class="filter-form" @submit.prevent="search">
        <el-form-item label="关键词" prop="keyword">
          <el-input v-model="query.keyword" clearable placeholder="名称、标题或外部 ID" @keyup.enter="search" />
        </el-form-item>
        <el-form-item label="差异状态" prop="comparisonStatus">
          <el-select v-model="query.comparisonStatus" clearable placeholder="全部" class="filter-select">
            <el-option v-for="item in comparisonStatusOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="审核状态" prop="reviewStatus">
          <el-select v-model="query.reviewStatus" clearable placeholder="全部" class="filter-select">
            <el-option v-for="item in reviewStatusOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="来源" prop="sourceProvider">
          <el-input v-model="query.sourceProvider" clearable placeholder="来源提供方" @keyup.enter="search" />
        </el-form-item>
        <el-form-item v-if="entityType === 'textbook'" label="版本外部 ID" prop="versionExternalId">
          <el-input v-model="query.versionExternalId" clearable placeholder="可选" @keyup.enter="search" />
        </el-form-item>
        <el-form-item v-if="entityType === 'catalog'" label="教材外部 ID" prop="textbookExternalId">
          <el-input v-model="query.textbookExternalId" clearable placeholder="审核前必填" @keyup.enter="search" />
        </el-form-item>
        <el-form-item v-if="entityType === 'question'" label="教材外部 ID" prop="textbookExternalId">
          <el-input v-model="query.textbookExternalId" clearable placeholder="审核前必填" @keyup.enter="search" />
        </el-form-item>
        <el-form-item class="filter-actions">
          <el-button type="primary" :icon="Search" @click="search">查询</el-button>
          <el-button :icon="RefreshLeft" @click="resetQuery">重置</el-button>
        </el-form-item>
      </el-form>

      <el-alert
        v-if="reviewScopeRequired && !hasReviewScope"
        class="state-alert"
        type="info"
        :closable="false"
        show-icon
      >目录或题目审核前请先填写教材外部 ID，系统会再次校验候选的教材归属。</el-alert>

      <div class="toolbar">
        <span class="selection-hint">已选择 {{ selected.length }} 行<span v-if="selected.length && actionableSelected.length !== selected.length">，{{ selected.length - actionableSelected.length }} 行缺少 stagedHash</span></span>
        <div class="toolbar-actions">
          <el-button v-hasPermi="['bank:sync:review']" type="success" plain :icon="Check" :disabled="!actionableSelected.length || reviewing" :loading="reviewing && reviewAction === 'approve'" @click="reviewRows(actionableSelected, 'approve')">批量通过</el-button>
          <el-button v-hasPermi="['bank:sync:review']" type="danger" plain :icon="Close" :disabled="!actionableSelected.length || reviewing" :loading="reviewing && reviewAction === 'reject'" @click="reviewRows(actionableSelected, 'reject')">批量驳回</el-button>
        </div>
      </div>

      <el-table
        v-loading="loading"
        :data="rows"
        stripe
        size="small"
        class="data-table"
        :row-key="syncRowKey"
        :empty-text="sourceAvailable === false ? '采集数据不可用' : '暂无候选数据'"
        @selection-change="selected = $event"
      >
        <el-table-column type="selection" width="48" align="center" :selectable="selectableRow" />
        <el-table-column label="外部 ID" min-width="145" show-overflow-tooltip>
          <template #default="scope">{{ scope.row.externalId || '未提供' }}</template>
        </el-table-column>
        <el-table-column label="采集候选值" min-width="215" show-overflow-tooltip>
          <template #default="scope"><span class="value-preview">{{ candidateText(scope.row) }}</span></template>
        </el-table-column>
        <el-table-column label="当前值" min-width="215" show-overflow-tooltip>
          <template #default="scope"><span class="value-preview muted">{{ currentText(scope.row) }}</span></template>
        </el-table-column>
        <el-table-column label="差异字段" min-width="145" show-overflow-tooltip>
          <template #default="scope">
            <span v-if="scope.row.diffFields.length">{{ scope.row.diffFields.join('、') }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="对比状态" width="100" align="center">
          <template #default="scope"><el-tag size="small" :type="comparisonStatusMeta(scope.row.comparisonStatus).type">{{ comparisonStatusMeta(scope.row.comparisonStatus).label }}</el-tag></template>
        </el-table-column>
        <el-table-column label="审核状态" width="100" align="center">
          <template #default="scope"><el-tag size="small" :type="reviewStatusMeta(scope.row.reviewStatus).type">{{ reviewStatusMeta(scope.row.reviewStatus).label }}</el-tag></template>
        </el-table-column>
        <el-table-column label="最近采集" min-width="155" show-overflow-tooltip>
          <template #default="scope">{{ scope.row.collectedAt || '未记录' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="175" fixed="right" align="center">
          <template #default="scope">
            <el-button link type="primary" :icon="View" title="查看对比" aria-label="查看对比" @click="openDetail(scope.row)" />
            <el-button v-hasPermi="['bank:sync:review']" link type="success" :icon="Check" title="通过" aria-label="通过" :disabled="!canReview(scope.row) || reviewing" @click="reviewRows([scope.row], 'approve')" />
            <el-button v-hasPermi="['bank:sync:review']" link type="danger" :icon="Close" title="驳回" aria-label="驳回" :disabled="!canReview(scope.row) || reviewing" @click="reviewRows([scope.row], 'reject')" />
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !rows.length" :image-size="72" :description="sourceAvailable === false ? '采集数据不可用' : '暂无候选数据'" />
      <div class="table-footer">
        <span>共 {{ total }} 条候选</span>
        <el-pagination
          v-model:current-page="query.pageNum"
          v-model:page-size="query.pageSize"
          :total="total"
          :page-sizes="[10, 20, 50]"
          layout="sizes, prev, pager, next, total"
          background
          @size-change="loadList"
          @current-change="loadList"
        />
      </div>
    </section>

    <el-drawer v-model="detailVisible" :title="`${title} · 对比详情`" direction="rtl" size="min(860px, 96vw)" append-to-body>
      <template v-if="detailRow">
        <div class="detail-meta">
          <el-tag size="small">{{ comparisonStatusMeta(detailRow.comparisonStatus).label }}</el-tag>
          <el-tag size="small" :type="reviewStatusMeta(detailRow.reviewStatus).type">{{ reviewStatusMeta(detailRow.reviewStatus).label }}</el-tag>
          <span>外部 ID：{{ detailRow.externalId || '未提供' }}</span>
          <span>stagedHash：{{ detailRow.stagedHash || '未提供（不可审核）' }}</span>
        </div>
        <div class="compare-grid">
          <section class="compare-side candidate-side">
            <h3>采集候选值</h3>
            <pre>{{ snapshotText(detailRow.stagedData) }}</pre>
          </section>
          <section class="compare-side current-side">
            <h3>当前数据库值</h3>
            <pre>{{ snapshotText(detailRow.currentData) }}</pre>
          </section>
        </div>
        <section class="detail-fields">
          <h3>差异字段</h3>
          <div v-if="detailRow.diffFields.length" class="field-tags"><el-tag v-for="field in detailRow.diffFields" :key="field" size="small" type="warning">{{ field }}</el-tag></div>
          <span v-else class="muted">无差异字段</span>
        </section>
        <section v-if="detailRow.reviewedBy || detailRow.reviewedAt || detailRow.reviewComment" class="review-trace">
          <h3>审核记录</h3>
          <dl>
            <template v-if="detailRow.reviewedBy"><dt>审核人</dt><dd>{{ detailRow.reviewedBy }}</dd></template>
            <template v-if="detailRow.reviewedAt"><dt>审核时间</dt><dd>{{ detailRow.reviewedAt }}</dd></template>
            <template v-if="detailRow.reviewComment"><dt>审核意见</dt><dd>{{ detailRow.reviewComment }}</dd></template>
          </dl>
        </section>
        <div class="detail-actions">
          <el-button v-hasPermi="['bank:sync:review']" type="success" :disabled="!canReview(detailRow) || reviewing" :loading="reviewing && reviewAction === 'approve'" @click="reviewRows([detailRow], 'approve')">通过</el-button>
          <el-button v-hasPermi="['bank:sync:review']" type="danger" :disabled="!canReview(detailRow) || reviewing" :loading="reviewing && reviewAction === 'reject'" @click="reviewRows([detailRow], 'reject')">驳回</el-button>
        </div>
      </template>
      <el-empty v-else description="未找到候选记录" />
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Check, Close, Refresh, RefreshLeft, Search, View } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { listSyncComparisons, reviewSyncItems } from '../../../api/bank'
import SyncRunPanel from './SyncRunPanel.vue'
import {
  buildSyncReviewItems,
  canReviewSyncRow,
  comparisonStatusMeta,
  comparisonStatusOptions,
  formatSyncSnapshot,
  normalizeSyncSummary,
  reviewStatusMeta,
  reviewStatusOptions,
  syncComparisonRowKey,
  summarizeSyncRow,
  unwrapSyncCompare,
} from '../../../utils/sync'

const props = defineProps({
  entityType: { type: String, required: true },
  title: { type: String, required: true },
})

const queryRef = ref()
const rows = ref([])
const selected = ref([])
const total = ref(0)
const summary = ref(normalizeSyncSummary({}, []))
const loading = ref(false)
const reviewing = ref(false)
const reviewAction = ref('')
const errorMessage = ref('')
const sourceAvailable = ref(undefined)
const sourceMessage = ref('')
const detailVisible = ref(false)
const detailRow = ref(null)
const reviewScopeRequired = computed(() => ['catalog', 'question'].includes(props.entityType))
const hasReviewScope = computed(() => !reviewScopeRequired.value || Boolean(String(query.textbookExternalId || '').trim()))
const query = reactive({
  pageNum: 1,
  pageSize: 10,
  keyword: '',
  comparisonStatus: undefined,
  reviewStatus: undefined,
  sourceProvider: '',
  versionExternalId: '',
  textbookExternalId: '',
})

const summaryCards = computed(() => [
  { key: 'total', label: '候选总数', value: summary.value.total, tone: 'primary' },
  { key: 'new', label: '新增', value: summary.value.new, tone: 'success' },
  { key: 'changed', label: '变更', value: summary.value.changed, tone: 'warning' },
  { key: 'unchanged', label: '无变化', value: summary.value.unchanged, tone: 'neutral' },
  { key: 'pending', label: '待审核', value: summary.value.pending, tone: 'warning' },
  { key: 'approved', label: '已通过', value: summary.value.approved, tone: 'success' },
  { key: 'rejected', label: '已驳回', value: summary.value.rejected, tone: 'danger' },
  { key: 'conflict', label: '冲突', value: summary.value.conflict, tone: 'danger' },
  { key: 'stale', label: '需复审', value: summary.value.stale, tone: 'warning' },
])
const actionableSelected = computed(() => selected.value.filter(canReview))

function canReview(row) { return canReviewSyncRow(row) && hasReviewScope.value }
function selectableRow(row) { return canReview(row) }
function syncRowKey(row) { return syncComparisonRowKey(row) }
function candidateText(row) { return summarizeSyncRow(row, 'staged', props.entityType) || '暂无候选值' }
function currentText(row) { return summarizeSyncRow(row, 'current', props.entityType) || '暂无当前值' }
function snapshotText(value) { return formatSyncSnapshot(value, props.entityType) }

async function loadList() {
  loading.value = true
  errorMessage.value = ''
  try {
    const result = unwrapSyncCompare(await listSyncComparisons(props.entityType, { ...query }))
    rows.value = result.rows
    total.value = result.total
    summary.value = result.summary
    sourceAvailable.value = result.sourceAvailable
    sourceMessage.value = result.sourceMessage
    selected.value = []
  } catch (error) {
    rows.value = []
    total.value = 0
    summary.value = normalizeSyncSummary({}, [])
    sourceAvailable.value = undefined
    sourceMessage.value = ''
    errorMessage.value = error?.message || '同步对比数据加载失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

function search() {
  query.pageNum = 1
  loadList()
}

function resetQuery() {
  queryRef.value?.resetFields()
  Object.assign(query, { keyword: '', comparisonStatus: undefined, reviewStatus: undefined, sourceProvider: '', versionExternalId: '', textbookExternalId: '', pageNum: 1 })
  loadList()
}

function handleRunCompleted() {
  loadList()
}

function openDetail(row) {
  detailRow.value = row
  detailVisible.value = true
}

async function reviewRows(targetRows, action) {
  if (!hasReviewScope.value) {
    ElMessage.warning('目录或题目审核前请先填写教材外部 ID')
    return
  }
  const items = buildSyncReviewItems(targetRows)
  if (!items.length) {
    ElMessage.warning('没有可审核的候选记录：stagedHash 缺失的记录不能审核')
    return
  }
  if (reviewing.value) return
  const actionText = action === 'approve' ? '通过' : '驳回'
  try {
    await ElMessageBox.confirm(`确定${actionText}选中的 ${items.length} 条候选记录吗？审核通过仅进入待发布，正式数据仍需通过发布批次合并。`, '同步审核确认', {
      type: action === 'approve' ? 'success' : 'warning',
      confirmButtonText: `确定${actionText}`,
      cancelButtonText: '取消',
    })
    const promptResult = await ElMessageBox.prompt('可填写简短意见（可选）', '审核意见', {
      inputValue: '',
      inputPlaceholder: '例如：来源页面已核对',
      inputType: 'textarea',
      inputValidator: (value) => String(value || '').length <= 500 || '意见不能超过 500 个字符',
      confirmButtonText: '提交审核',
      cancelButtonText: '取消',
    })
    reviewing.value = true
    reviewAction.value = action
    const comment = String(promptResult.value || '').trim()
    await reviewSyncItems(props.entityType, {
      action,
      items,
      reviewComment: comment,
      textbookExternalId: ['catalog', 'question'].includes(props.entityType)
        ? (query.textbookExternalId || undefined)
        : undefined,
    })
    ElMessage.success(`${actionText}成功`)
    selected.value = []
    detailVisible.value = false
    await loadList()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || `${actionText}失败`)
  } finally {
    reviewing.value = false
    reviewAction.value = ''
  }
}

onMounted(loadList)
</script>

<style scoped>
.sync-compare-page { min-height: calc(100vh - 84px); color: var(--el-text-color-primary); }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.page-heading h2 { margin: 0; font-size: 20px; font-weight: 600; }
.page-subtitle { margin: 7px 0 0; color: var(--el-text-color-secondary); font-size: 13px; }
.source-alert, .state-alert { margin-bottom: 14px; }
.summary-grid { display: grid; grid-template-columns: repeat(9, minmax(100px, 1fr)); gap: 10px; margin-bottom: 14px; }
.summary-card { min-width: 0; padding: 11px 13px; border: 1px solid var(--el-border-color-light); border-left: 3px solid var(--el-color-info); border-radius: 5px; background: var(--el-bg-color); }
.summary-card strong { display: block; margin-top: 5px; font-size: 21px; line-height: 1; }
.summary-label { color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; }
.summary-primary { border-left-color: var(--el-color-primary); }.summary-success { border-left-color: var(--el-color-success); }.summary-warning { border-left-color: var(--el-color-warning); }.summary-danger { border-left-color: var(--el-color-danger); }.summary-neutral { border-left-color: var(--el-border-color); }
.panel { min-width: 0; padding: 16px; border: 1px solid var(--el-border-color-light); border-radius: 6px; background: var(--el-bg-color); }
.filter-form { margin-bottom: 3px; }.filter-form :deep(.el-form-item) { margin-bottom: 10px; }.filter-form :deep(.el-input) { width: 165px; }.filter-select { width: 125px; }.filter-actions { margin-left: 2px; }
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 34px; margin-bottom: 10px; }.toolbar-actions { display: flex; gap: 8px; }.selection-hint { color: var(--el-text-color-secondary); font-size: 12px; }
.data-table { width: 100%; }.value-preview { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.muted { color: var(--el-text-color-secondary); }
.table-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; color: var(--el-text-color-secondary); font-size: 12px; }.table-footer :deep(.el-pagination) { flex-wrap: wrap; justify-content: flex-end; }
.detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-bottom: 14px; border-bottom: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); font-size: 12px; }.compare-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; margin-top: 14px; }.compare-side { min-width: 0; }.compare-side h3, .detail-fields h3, .review-trace h3 { margin: 0 0 8px; font-size: 14px; }.compare-side pre { min-height: 170px; max-height: 55vh; margin: 0; padding: 12px; overflow: auto; border: 1px solid var(--el-border-color-light); border-radius: 4px; background: var(--el-fill-color-lighter); color: var(--el-text-color-primary); font: 12px/1.65 var(--el-font-family); white-space: pre-wrap; overflow-wrap: anywhere; }.candidate-side pre { border-color: color-mix(in srgb, var(--el-color-success) 35%, var(--el-border-color-light)); }.current-side pre { border-color: var(--el-border-color-light); }.detail-fields { margin-top: 18px; }.field-tags { display: flex; flex-wrap: wrap; gap: 6px; }.review-trace { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--el-border-color-lighter); }.review-trace dl { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 7px 12px; margin: 0; font-size: 12px; }.review-trace dt { color: var(--el-text-color-secondary); }.review-trace dd { min-width: 0; margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }.detail-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--el-border-color-lighter); }
@media (max-width: 1280px) { .summary-grid { grid-template-columns: repeat(4, minmax(100px, 1fr)); } }
@media (max-width: 760px) { .page-heading { align-items: stretch; flex-direction: column; }.page-heading > .el-button { align-self: flex-start; }.summary-grid { grid-template-columns: repeat(2, minmax(110px, 1fr)); }.panel { padding: 12px; }.filter-form { display: flex; }.filter-form :deep(.el-form-item) { max-width: 100%; }.filter-form :deep(.el-input), .filter-select { width: 100%; }.filter-actions { width: 100%; margin-left: 0; }.toolbar { align-items: flex-start; flex-direction: column; }.toolbar-actions { width: 100%; }.toolbar-actions .el-button { flex: 1; }.table-footer { align-items: flex-start; flex-direction: column; }.table-footer :deep(.el-pagination) { justify-content: flex-start; }.compare-grid { grid-template-columns: 1fr; }.compare-side pre { max-height: 38vh; } }
</style>
