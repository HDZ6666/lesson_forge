<template>
  <div class="app-container sync-center-page sync-task-list-page">
    <header class="page-heading">
      <div>
        <h2>教材发现任务</h2>
        <p>学科计划会自动创建发现任务。这里查看教材清单的更新记录、登记结果和异常。</p>
      </div>
      <div class="heading-actions">
        <el-button :icon="Refresh" :loading="loading" @click="loadTasks">刷新</el-button>
        <el-button v-hasPermi="['bank:sync:textbook:add', 'bank:sync:run']" plain :icon="Plus" @click="openCreate">手动发现一次</el-button>
      </div>
    </header>
    <SyncCenterNav active="discovery"/>

    <el-alert class="state-alert" type="info" :closable="false" show-icon>
      计划中的发现任务登记成功后，会自动生成逐本教材任务。手动发现只更新清单；首次使用请先创建学科计划。
      <el-button link type="primary" @click="router.push('/sync-center/plans')">查看学科计划</el-button>
    </el-alert>
    <el-alert v-if="errorMessage" class="state-alert" type="error" :closable="false" show-icon>{{ errorMessage }}</el-alert>

    <section class="panel">
      <el-form :inline="true" :model="filters" class="filter-form" @submit.prevent="searchTasks">
        <el-form-item label="任务编号">
          <el-input v-model="filters.taskNo" clearable placeholder="请输入任务编号" @keyup.enter="searchTasks" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部状态" class="status-select">
            <el-option v-for="item in syncTaskStatusOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="创建时间">
          <el-date-picker
            v-model="filters.createTimeRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            clearable
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="searchTasks">查询</el-button>
          <el-button :icon="RefreshLeft" @click="resetFilters">重置</el-button>
        </el-form-item>
      </el-form>

      <div v-if="selectedRows.length" class="batch-toolbar">
        <span class="selection-hint">{{ selectedRows.length ? `已选 ${selectedRows.length} 个终态任务` : '仅可选择已完成、失败、阻断或已停止的任务' }}</span>
        <el-button
          v-hasPermi="['bank:sync:textbook:remove', 'bank:sync:run']"
          type="danger"
          plain
          :icon="Delete"
          :disabled="!selectedRows.length || batchDeleting"
          :loading="batchDeleting"
          @click="batchDeleteTasks"
        >批量删除（{{ selectedRows.length }}）</el-button>
      </div>

      <el-table
        ref="tableRef"
        v-loading="loading"
        :data="tasks"
        :row-key="(row) => String(row.taskId)"
        stripe
        class="task-table"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="48" align="center" :selectable="isSelectableTask" />
        <el-table-column label="任务编号" min-width="150" show-overflow-tooltip>
          <template #default="scope"><el-link type="primary" :underline="false" @click="openDetail(scope.row)">{{ scope.row.taskNo || scope.row.taskId }}</el-link></template>
        </el-table-column>
        <el-table-column label="状态" width="112" align="center">
          <template #default="scope"><el-tag size="small" :type="syncTaskStatusMeta(scope.row.status).type">{{ syncTaskStatusMeta(scope.row.status).label }}</el-tag></template>
        </el-table-column>
        <el-table-column label="发现清单" min-width="150"><template #default="{row}"><span class="cell-main">{{ row.fetchedTextbookCount || 0 }} 本教材</span><span class="cell-sub">{{ row.fetchedVersionCount || 0 }} 个版本</span></template></el-table-column>
        <el-table-column label="本次新增" min-width="145"><template #default="{row}"><span>{{ row.newTextbookCount || 0 }} 本教材</span><span class="cell-sub">{{ row.newVersionCount || 0 }} 个版本</span></template></el-table-column>
        <el-table-column label="登记结果" min-width="170"><template #default="{row}">{{ row.discoveryMode ? (row.discoveryResult ? '已登记观察结果' : row.discoveryError ? '登记需处理' : '等待自动登记') : '历史快照' }}</template></el-table-column>
        <el-table-column label="创建时间" min-width="166" show-overflow-tooltip><template #default="scope">{{ formatTaskTime(scope.row.createTime) }}</template></el-table-column>
        <el-table-column label="操作" width="210" fixed="right" align="center">
          <template #default="scope">
            <el-button v-hasPermi="['bank:sync:textbook:query', 'bank:sync:textbook:list', 'bank:sync:center:list']" link type="primary" :icon="View" @click="openDetail(scope.row)">查看详情</el-button>
            <el-button
              v-if="canCancelSyncTask(scope.row.status)"
              v-hasPermi="['bank:sync:textbook:cancel', 'bank:sync:run']"
              link
              type="danger"
              :icon="VideoPause"
              :loading="actionId === scope.row.taskId"
              @click="stopTask(scope.row)"
            >停止</el-button>
            <el-button
              v-if="canRetrySyncTask(scope.row.status)"
              v-hasPermi="['bank:sync:textbook:retry', 'bank:sync:textbook:add', 'bank:sync:run']"
              link
              type="warning"
              :icon="RefreshRight"
              :loading="actionId === scope.row.taskId"
              @click="retryTask(scope.row)"
            >重试</el-button>
            <el-button
              v-if="canDeleteSyncTask(scope.row.status)"
              v-hasPermi="['bank:sync:textbook:remove', 'bank:sync:run']"
              link
              type="danger"
              :icon="Delete"
              :loading="actionId === scope.row.taskId"
              @click="deleteTask(scope.row)"
            >删除</el-button>
          </template>
        </el-table-column>
        <template #empty><el-empty :image-size="64" description="暂无教材发现任务"><p class="empty-copy">{{ total ? '当前页没有数据，请调整筛选条件。' : '可以调整筛选，或创建一个新任务开始同步。' }}</p><el-button v-hasPermi="['bank:sync:textbook:add', 'bank:sync:run']" type="primary" plain @click="openCreate">发现版本与教材</el-button></el-empty></template>
      </el-table>
      <footer class="table-footer">
        <span>共 {{ total }} 个任务</span>
        <el-pagination
          v-model:current-page="filters.pageNum"
          v-model:page-size="filters.pageSize"
          :total="total"
          :page-sizes="[10, 20, 50]"
          layout="sizes, prev, pager, next, total"
          background
          @size-change="loadTasks"
          @current-change="loadTasks"
        />
      </footer>
    </section>

    <el-dialog class="sync-center-dialog" v-model="createVisible" title="新增教材发现任务" width="600px" append-to-body @closed="resetCreate">
      <el-alert type="warning" :closable="false" show-icon>本任务会访问已配置的第三方来源，请先确认授权和采集规则。</el-alert>
      <ul class="create-rules">
        <li>本次抓取来源中的全部版本和教材。</li>
        <li>不抓取目录和题目。</li>
        <li>正常新增和改名自动登记，归属冲突单独待人工核对。</li>
        <li>每次保留独立的发现记录，方便回看本次变化。</li>
      </ul>
      <el-checkbox v-model="acknowledged">我已确认来源授权、站点规则和内容使用边界</el-checkbox>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" :disabled="!acknowledged" @click="createTask">确认创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import SyncCenterNav from '../../components/SyncCenterNav.vue'
import '../../styles/sync-center.scss'
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Delete, Plus, Refresh, RefreshLeft, RefreshRight, Search, VideoPause, View } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import {
  cancelTextbookSyncTask,
  createTextbookSyncTask,
  deleteTextbookSyncTask,
  listTextbookSyncTasks,
  retryTextbookSyncTask,
} from '../../api/bank'
import {
  canCancelSyncTask,
  canDeleteSyncTask,
  canRetrySyncTask,
  formatTaskTime,
  isActiveSyncTask,
  syncTaskErrorMessage,
  syncTaskStatusMeta,
  syncTaskStatusOptions,
  unwrapSyncTask,
  unwrapSyncTaskPage,
} from '../../utils/sync-task'

const router = useRouter()
const tasks = ref([])
const tableRef = ref()
const selectedRows = ref([])
const total = ref(0)
const loading = ref(false)
const actionId = ref('')
const errorMessage = ref('')
const createVisible = ref(false)
const acknowledged = ref(false)
const creating = ref(false)
const batchDeleting = ref(false)
const filters = reactive({ taskNo: '', status: undefined, createTimeRange: [], pageNum: 1, pageSize: 10 })
let refreshTimer = null
let mounted = false

function requestQuery() {
  const [createTimeStart, createTimeEnd] = Array.isArray(filters.createTimeRange) ? filters.createTimeRange : []
  return {
    taskNo: filters.taskNo || undefined,
    status: filters.status || undefined,
    createTimeStart: createTimeStart || undefined,
    createTimeEnd: createTimeEnd || undefined,
    pageNum: filters.pageNum,
    pageSize: filters.pageSize,
  }
}

function scheduleRefresh() {
  clearRefreshTimer()
  if (!mounted || !tasks.value.some((task) => isActiveSyncTask(task.status))) return
  refreshTimer = window.setTimeout(async () => {
    refreshTimer = null
    if (selectedRows.value.length || batchDeleting.value) {
      scheduleRefresh()
      return
    }
    await loadTasks(true)
  }, 3000)
}

function clearRefreshTimer() {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
  refreshTimer = null
}

function isSelectableTask(row) {
  return canDeleteSyncTask(row?.status)
}

function handleSelectionChange(rows) {
  selectedRows.value = (Array.isArray(rows) ? rows : []).filter(isSelectableTask)
}

function clearSelection() {
  selectedRows.value = []
  tableRef.value?.clearSelection?.()
}

async function loadTasks(silent = false) {
  // Clear before the request too: a failed query must not leave an old row
  // armed for a later batch action.
  clearSelection()
  if (!silent) loading.value = true
  errorMessage.value = ''
  try {
    const page = unwrapSyncTaskPage(await listTextbookSyncTasks(requestQuery()), 'textbook')
    tasks.value = page.rows
    total.value = page.total
    // Query, pagination and automatic refresh can replace rows underneath the
    // table.  Never retain a stale selection across those boundaries.
    clearSelection()
  } catch (error) {
    if (!silent) {
      tasks.value = []
      total.value = 0
    }
    errorMessage.value = syncTaskErrorMessage(error, '教材发现任务加载失败')
  } finally {
    if (!silent) loading.value = false
    scheduleRefresh()
  }
}

function searchTasks() {
  filters.pageNum = 1
  loadTasks()
}

function resetFilters() {
  filters.taskNo = ''
  filters.status = undefined
  filters.createTimeRange = []
  filters.pageNum = 1
  loadTasks()
}

function openCreate() {
  acknowledged.value = false
  createVisible.value = true
}

function resetCreate() {
  acknowledged.value = false
  creating.value = false
}

async function createTask() {
  if (!acknowledged.value || creating.value) return
  creating.value = true
  try {
    const task = unwrapSyncTask(await createTextbookSyncTask({ acknowledgeSourcePolicy: true }), 'textbook')
    if (!task?.taskId) throw new Error('服务端未返回任务编号')
    createVisible.value = false
    ElMessage.success('教材发现任务已创建')
    await router.push(`/bank/sync-textbook/${encodeURIComponent(task.taskId)}`)
  } catch (error) {
    ElMessage.error(syncTaskErrorMessage(error, '教材发现任务创建失败'))
  } finally {
    creating.value = false
  }
}

function openDetail(task) {
  router.push(`/bank/sync-textbook/${encodeURIComponent(task.taskId)}`)
}

async function stopTask(task) {
  try {
    await ElMessageBox.confirm(`确定停止任务“${task.taskNo || task.taskId}”吗？已抓取的运行记录会保留。`, '停止任务', {
      type: 'warning', confirmButtonText: '停止', cancelButtonText: '取消',
    })
    actionId.value = task.taskId
    await cancelTextbookSyncTask(task.taskId)
    ElMessage.success('停止请求已提交')
    await loadTasks(true)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '任务停止失败'))
  } finally {
    actionId.value = ''
  }
}

async function retryTask(task) {
  try {
    await ElMessageBox.confirm('重试会创建一个新任务，原任务和日志保持不变。确定继续吗？', '重试任务', {
      type: 'info', confirmButtonText: '创建新任务', cancelButtonText: '取消',
    })
    actionId.value = task.taskId
    const retried = unwrapSyncTask(await retryTextbookSyncTask(task.taskId), 'textbook')
    if (!retried?.taskId) throw new Error('服务端未返回新任务编号')
    ElMessage.success('已创建新的教材发现任务')
    await router.push(`/bank/sync-textbook/${encodeURIComponent(retried.taskId)}`)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '任务重试失败'))
  } finally {
    actionId.value = ''
  }
}

async function deleteTask(task) {
  try {
    await ElMessageBox.confirm(
      `确定删除终态任务“${task.taskNo || task.taskId}”吗？删除后仅移除服务端任务记录及范围，不会删除采集快照或正式题库数据。`,
      '删除任务',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    actionId.value = task.taskId
    await deleteTextbookSyncTask(task.taskId)
    ElMessage.success('教材发现任务已删除')
    await loadTasks(true)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '任务删除失败'))
  } finally {
    actionId.value = ''
  }
}

async function batchDeleteTasks() {
  if (batchDeleting.value || !selectedRows.value.length) return
  const targets = selectedRows.value.filter(isSelectableTask)
  if (!targets.length) {
    clearSelection()
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定批量删除选中的 ${targets.length} 个终态任务吗？本操作仅删除服务端任务记录及范围，不会删除 collector 不可变快照，也不会删除正式教材数据。`,
      '批量删除任务',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    )
    batchDeleting.value = true
    const succeeded = []
    const failed = []
    for (const task of targets) {
      try {
        await deleteTextbookSyncTask(task.taskId)
        succeeded.push(task)
      } catch (error) {
        failed.push({ task, error })
      }
    }
    const summary = `批量删除完成：成功 ${succeeded.length} 个，失败 ${failed.length} 个。`
    if (failed.length) {
      const detail = failed.slice(0, 3).map(({ task, error }) => `${task.taskNo || task.taskId}：${syncTaskErrorMessage(error, '删除失败')}`).join('；')
      ElMessage.warning(`${summary}${detail ? ` ${detail}` : ''}`)
    } else {
      ElMessage.success(summary)
    }
    clearSelection()
    await loadTasks(true)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '批量删除任务失败'))
  } finally {
    batchDeleting.value = false
    clearSelection()
  }
}

onMounted(() => {
  mounted = true
  loadTasks()
})

onBeforeUnmount(() => {
  mounted = false
  clearRefreshTimer()
})
</script>

<style scoped>
.sync-task-list-page { min-height: calc(100vh - 84px); color: var(--el-text-color-primary); }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.page-heading h2 { margin: 0; font-size: 20px; font-weight: 600; }
.page-heading p { max-width: 760px; margin: 6px 0 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.heading-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.state-alert { margin-bottom: 14px; }
.panel { min-width: 0; padding: 16px; border: 1px solid var(--el-border-color-light); border-radius: 8px; background: var(--el-bg-color); }
.filter-form { margin-bottom: 4px; }
.batch-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; margin-bottom: 8px; }
.selection-hint { color: var(--el-text-color-secondary); font-size: 12px; }
.filter-form :deep(.el-form-item) { margin-bottom: 10px; }
.filter-form :deep(.el-input) { width: 190px; }
.filter-form :deep(.el-date-editor) { width: 260px; }
.status-select { width: 150px; }
.task-table { width: 100%; }
.table-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; color: var(--el-text-color-secondary); font-size: 12px; }
.table-footer :deep(.el-pagination) { flex-wrap: wrap; justify-content: flex-end; }
.create-rules { margin: 16px 0; padding-left: 22px; color: var(--el-text-color-regular); font-size: 13px; line-height: 1.9; }
@media (max-width: 760px) { .page-heading { flex-direction: column; } .heading-actions { justify-content: flex-start; } .table-footer { align-items: flex-start; flex-direction: column; } .table-footer :deep(.el-pagination) { justify-content: flex-start; } }
</style>
