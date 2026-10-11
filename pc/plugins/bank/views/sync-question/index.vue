<template>
  <div class="app-container sync-center-page sync-question-list-page">
    <header class="page-heading">
      <div>
        <h2>教材同步任务</h2>
        <p>计划发现教材后，逐本任务会全部列在这里。按名称或日期查看同一轮同步，跟进入库结果。</p>
      </div>
      <div class="heading-actions">
        <el-button v-if="activeTab==='tasks'" :icon="Refresh" :loading="loading" @click="loadTasks">刷新</el-button>
        <el-button v-hasPermi="['bank:sync:question:add', 'bank:sync:run']" plain :icon="Plus" @click="openCreate">手动同步一本</el-button>
      </div>
    </header>
    <SyncCenterNav active="tasks" :subject-id="filters.subjectId"/>

    <el-alert v-if="activeTab==='tasks'" class="state-alert" type="info" :closable="false" show-icon>
      采集完成表示本次抓取结束；题目是否已可用，请查看任务中的入库结果。
    </el-alert>
    <el-alert v-if="activeTab==='tasks' && hasInterruptedTasks" class="state-alert" type="warning" :closable="false" show-icon>
      采集中断任务的已有快照和断点保留，可断点续采；也可再同步一次从头采集。
    </el-alert>
    <el-alert v-if="errorMessage" class="state-alert" type="error" :closable="false" show-icon>{{ errorMessage }}</el-alert>

    <el-tabs v-model="activeTab"><el-tab-pane label="全部任务" name="tasks"/><el-tab-pane label="待处理问题" name="issues"/></el-tabs>
    <section v-show="activeTab==='tasks'" class="panel">
      <el-alert v-if="filters.planId" :title="`正在查看计划 #${filters.planId} 的第 ${filters.cycleNo} 轮任务，点击重置可查看全部批次。`" type="info" :closable="false"/>
      <el-form :inline="true" :model="filters" class="filter-form" @submit.prevent="searchTasks">
        <el-form-item label="学科"><SubjectSelect v-model="filters.subjectId" @change="searchTasks" /></el-form-item>
        <el-form-item label="同步批次"><el-input v-model="filters.cycleName" clearable placeholder="计划名称或日期，如 2026-10-10" @keyup.enter="searchTasks"/></el-form-item>
        <el-form-item label="任务编号"><el-input v-model="filters.taskNo" clearable placeholder="请输入任务编号" @keyup.enter="searchTasks" /></el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部状态" class="status-select">
            <el-option v-for="item in syncTaskStatusOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item v-show="advancedFilters" label="版本"><el-input v-model="filters.versionName" clearable placeholder="版本名称" @keyup.enter="searchTasks" /></el-form-item>
        <el-form-item v-show="advancedFilters" label="创建时间">
          <el-date-picker v-model="filters.createTimeRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" clearable />
        </el-form-item>
        <el-form-item><el-button type="primary" :icon="Search" @click="searchTasks">查询</el-button><el-button :icon="RefreshLeft" @click="resetFilters">重置</el-button><el-button link @click="advancedFilters = !advancedFilters">{{ advancedFilters ? '收起筛选' : '更多筛选' }}</el-button></el-form-item>
      </el-form>

      <div v-if="selectedRows.length" class="batch-toolbar">
        <span class="selection-hint">{{ selectedRows.length ? `已选 ${selectedRows.length} 个终态任务` : '仅可选择已完成、失败、阻断、采集中断或已停止的任务' }}</span>
        <el-button
          v-hasPermi="['bank:sync:question:remove', 'bank:sync:run']"
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
        <el-table-column label="所属学科同步批次" min-width="230"><template #default="{row}">{{ row.autoCycleName || (row.autoPlanId ? `计划 #${row.autoPlanId} · 第 ${row.autoCycleNo} 轮` : '手动单本同步') }}</template></el-table-column>
        <el-table-column label="任务编号" min-width="150" show-overflow-tooltip>
          <template #default="scope"><el-link type="primary" :underline="false" @click="openDetail(scope.row)">{{ scope.row.taskNo || scope.row.taskId }}</el-link></template>
        </el-table-column>
        <el-table-column label="状态" width="112" align="center"><template #default="scope"><el-tag size="small" :type="questionTaskStatusMeta(scope.row).type">{{ questionTaskStatusMeta(scope.row).label }}</el-tag></template></el-table-column>
        <el-table-column label="分页并发" min-width="210"><template #default="{row}"><TaskConcurrency :task="row" @updated="loadTasks(true)"/></template></el-table-column>
        <el-table-column label="教材" min-width="200"><template #default="{row}"><span class="cell-main">{{ textbookSummary(row) }}</span><span class="cell-sub">{{ row.versionName || '—' }}</span><span v-if="row.queueReason || row.queueState==='waiting'" class="cell-sub">{{ row.queueReason || '等待后台派发' }}</span></template></el-table-column>
        <el-table-column label="本次采集" min-width="140"><template #default="{row}"><span class="cell-main">{{ Number(row.questionCount || 0).toLocaleString() }} 道题</span><span class="cell-sub">{{ row.catalogCount || 0 }} 个目录</span></template></el-table-column>
        <el-table-column label="题目变化" min-width="135"><template #default="{row}"><span>新增 {{ row.newQuestionCount || 0 }}</span><span class="cell-sub">变化 {{ row.changedQuestionCount || 0 }}</span></template></el-table-column>
        <el-table-column label="执行记录" min-width="220"><template #default="{row}"><span class="cell-main">{{ executionSummary(row) }}</span><span class="cell-sub">最近启动：{{ formatTaskTime(row.lastExecutionAt) }}</span><TaskExecutionHistory :task="row"/></template></el-table-column>
        <el-table-column label="创建时间" min-width="166" show-overflow-tooltip><template #default="scope">{{ formatTaskTime(scope.row.createTime) }}</template></el-table-column>
        <el-table-column label="操作" width="260" fixed="right" align="center">
          <template #default="scope">
            <el-button v-hasPermi="['bank:sync:question:query', 'bank:sync:question:list', 'bank:sync:center:list']" link type="primary" :icon="View" @click="openDetail(scope.row)">查看详情</el-button>
            <el-button v-if="canCancelSyncTask(scope.row.status)" v-hasPermi="['bank:sync:question:cancel', 'bank:sync:run']" link type="danger" :icon="VideoPause" :loading="actionId === scope.row.taskId" @click="stopTask(scope.row)">停止</el-button>
            <el-button v-if="canResumeSyncTask(scope.row)" v-hasPermi="['bank:sync:question:resume', 'bank:sync:run']" link type="primary" :icon="RefreshRight" :loading="actionId === scope.row.taskId" :disabled="Boolean(actionId)" @click="resumeTask(scope.row)">{{ scope.row.workflowVersion === 2 ? '补采' : '断点续采' }}</el-button>
            <el-button v-if="canRetrySyncTask(scope.row.status)" v-hasPermi="['bank:sync:question:retry', 'bank:sync:question:add', 'bank:sync:run']" link type="warning" :icon="RefreshRight" :loading="actionId === scope.row.taskId" @click="retryTask(scope.row)">再同步一次</el-button>
            <el-button v-if="canDeleteSyncTask(scope.row.status)" v-hasPermi="['bank:sync:question:remove', 'bank:sync:run']" link type="danger" :icon="Delete" :loading="actionId === scope.row.taskId" @click="deleteTask(scope.row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty><el-empty :image-size="64" description="暂无同步题库任务"><p class="empty-copy">{{ total ? '当前页没有数据，请调整筛选条件。' : '可以调整筛选，或创建一个新任务开始同步。' }}</p><el-button v-hasPermi="['bank:sync:question:add', 'bank:sync:run']" type="primary" plain @click="openCreate">选择一本教材</el-button></el-empty></template>
      </el-table>
      <footer class="table-footer">
        <span>共 {{ total }} 个任务</span>
        <el-pagination v-model:current-page="filters.pageNum" v-model:page-size="filters.pageSize" :total="total" :page-sizes="[10, 20, 50]" layout="sizes, prev, pager, next, total" background @size-change="loadTasks" @current-change="loadTasks" />
      </footer>
    </section>

    <section v-if="activeTab==='issues'" class="sync-panel"><div class="section-heading"><h3>按学科查看问题</h3><SubjectSelect v-model="filters.subjectId"/></div><SyncIssues :subject-id="filters.subjectId"/></section>
    <el-dialog class="sync-center-dialog" v-model="createVisible" title="新增同步题库任务" width="720px" append-to-body @closed="resetCreate">
      <el-alert v-if="optionError" class="dialog-alert" type="error" :closable="false" show-icon>{{ optionError }}</el-alert>
      <el-alert v-if="!optionsLoading && !visibleOptionVersions.length && !optionError" type="info" :closable="false">该学科还没有可选版本。<el-button link type="primary" @click="createVisible=false;router.push('/sync-center/plans')">创建学科计划</el-button></el-alert>
      <el-form label-width="96px" v-loading="optionsLoading">
        <el-form-item label="学科"><SubjectSelect v-model="createForm.subjectId" :clearable="false" sync-only @change="resetBookSelection" /></el-form-item>
        <el-form-item label="选择版本" required>
          <el-select v-model="createForm.versionId" placeholder="请选择当前正式版本" filterable class="full-control" @change="handleVersionChange">
            <el-option v-for="version in visibleOptionVersions" :key="String(version.versionId)" :label="version.versionName" :value="version.versionId" :disabled="version.disabled">
              <div class="option-line"><span>{{ version.versionName }}</span><small v-if="version.disabled">{{ version.disabledReason || '缺少采集来源标识' }}</small></div>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="选择教材" required>
          <div class="textbook-picker">
            <el-empty v-if="!createForm.versionId" :image-size="58" description="请先选择一个版本" />
            <el-empty v-else-if="!currentVersionTextbooks.length" :image-size="58" description="该版本下暂无教材" />
            <el-radio-group v-else v-model="createForm.textbookId" class="textbook-options">
              <div v-for="book in currentVersionTextbooks" :key="String(book.textbookId)" class="textbook-option" :class="{ 'is-disabled': book.disabled }">
                <el-radio :value="book.textbookId" :disabled="book.disabled">
                  <span class="book-name">{{ book.textbookName }}</span>
                  <span v-if="book.grade || book.volume" class="book-meta">{{ [book.grade, book.volume].filter(Boolean).join(' · ') }}</span>
                </el-radio>
                <small v-if="book.disabled" class="disabled-reason">{{ book.disabledReason || '缺少采集来源标识' }}</small>
              </div>
            </el-radio-group>
          </div>
        </el-form-item>
        <el-form-item label="预计范围">
          <div class="scope-summary">
            <strong>{{ selectedVersion?.versionName || '尚未选择版本' }}</strong>
            <span>已选 {{ selectedBooks.length }} 本教材</span>
            <p v-if="selectedBooks.length">{{ selectedBooks.map((item) => item.textbookName).join('、') }}</p>
            <p v-else>一次任务可选择同一版本下的一本教材，其他教材另建任务。</p>
          </div>
        </el-form-item>
        <el-form-item label="分页并发"><div><el-select v-model="createForm.listConcurrency"><el-option :value="0" :label="`继承${concurrencyDefault.concurrencySource === 'plan' ? '计划' : '服务器'}：${concurrencyDefault.listConcurrency || '—'} 页`"/><el-option v-for="n in [1,2,4,8]" :key="n" :value="n" :label="`本任务自定义：${n} 页`"/></el-select><p>仅控制一本教材内同时请求的页数，每页通常 10 道题。</p></div></el-form-item>
        <el-form-item label="分页限制">
          <div class="page-limit-option">
            <el-switch v-model="createForm.limitTo1000Pages" active-text="最多 1000 页" inactive-text="按当前模式继续" />
            <p>开启后每个目录最多请求 1000 页，达到边界后正常结束该目录并继续其他目录；这不代表网站总题目已全部抓完。</p>
          </div>
        </el-form-item>
        <el-form-item v-if="concurrencyDefault.requiresPauseConfirmation" label="计划已暂停"><el-checkbox v-model="createForm.allowPaused">仅执行这一次，不恢复整个计划</el-checkbox></el-form-item>
        <el-form-item label="采集确认">
          <el-checkbox v-model="acknowledged">我已确认来源授权和采集规则，并了解合格成果会在后台自动分批入库。</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" :disabled="!canCreate" @click="createTask">确认创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import {executionSummary} from '../../utils/task-executions'
import TaskExecutionHistory from '../../components/TaskExecutionHistory.vue'
import TaskConcurrency from '../../components/TaskConcurrency.vue'
import request from '@/utils/request'
import SyncCenterNav from '../../components/SyncCenterNav.vue'
import '../../styles/sync-center.scss'
import SyncIssues from "../../components/SyncIssues.vue"
import SubjectSelect from "../../components/SubjectSelect.vue"
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Delete, Plus, Refresh, RefreshLeft, RefreshRight, Search, VideoPause, View } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import {
  cancelQuestionSyncTask,
  createQuestionSyncTask,
  deleteQuestionSyncTask,
  getQuestionSyncOptions,
  listQuestionSyncTasks,
  resumeQuestionSyncTask,
  retryQuestionSyncTask,
} from '../../api/bank'
import {
  canCancelSyncTask,
  canDeleteSyncTask,
  canResumeSyncTask,
  canRetrySyncTask,
  formatTaskTime,
  isActiveSyncTask,
  normalizeQuestionSyncOptions,
  syncTaskErrorMessage,
  questionTaskStatusMeta,
  syncTaskStatusOptions,
  unwrapSyncTask,
  unwrapSyncTaskPage,
} from '../../utils/sync-task'

const route = useRoute()
const activeTab = ref(route.query.tab === 'issues' ? 'issues' : 'tasks')
const advancedFilters = ref(false)
const router = useRouter()
const tasks = ref([])
const tableRef = ref()
const selectedRows = ref([])
const total = ref(0)
const loading = ref(false)
const errorMessage = ref('')
const actionId = ref('')
const createVisible = ref(false)
const creating = ref(false)
const batchDeleting = ref(false)
const optionsLoading = ref(false)
const optionError = ref('')
const optionVersions = ref([])
const acknowledged = ref(false)
const concurrencyDefault=ref({})
const createForm = reactive({ allowPaused:false, listConcurrency:0, subjectId: 1, versionId: '', textbookId: undefined, limitTo1000Pages: false })
const filters = reactive({ subjectId: Number(route.query.subjectId) || undefined, planId: Number(route.query.planId) || undefined, cycleNo: Number(route.query.cycleNo) || undefined, cycleName: '', taskNo: '', status: undefined, versionName: '', createTimeRange: [], pageNum: 1, pageSize: 10 })
watch(() => [route.query.tab, route.query.subjectId, route.query.planId, route.query.cycleNo], () => { activeTab.value = route.query.tab === 'issues' ? 'issues' : 'tasks'; filters.subjectId = Number(route.query.subjectId) || undefined; filters.planId=Number(route.query.planId)||undefined;filters.cycleNo=Number(route.query.cycleNo)||undefined; searchTasks() })
let taskListRevision = 0
let refreshTimer = null
let mounted = false

const visibleOptionVersions = computed(() => optionVersions.value.filter(item => String(item.subjectId || 1) === String(createForm.subjectId)))
const selectedVersion = computed(() => optionVersions.value.find((item) => String(item.versionId) === String(createForm.versionId)))
const currentVersionTextbooks = computed(() => selectedVersion.value?.textbooks || [])
const selectedBooks = computed(() => currentVersionTextbooks.value.filter((item) => String(createForm.textbookId) === String(item.textbookId)))
const canCreate = computed(() => Boolean(createForm.versionId && createForm.textbookId && acknowledged.value && !optionsLoading.value))
const hasInterruptedTasks = computed(() => tasks.value.some((task) => task.status === 'interrupted'))

function textbookSummary(task) {
  const names = task.textbookNames.filter(Boolean)
  if (!names.length) return task.textbookCount ? `${task.textbookCount} 本教材` : '—'
  const preview = names.slice(0, 2).join('、')
  return `${task.textbookCount || names.length} 本：${preview}${names.length > 2 ? ` 等 ${names.length} 本` : ''}`
}

function requestQuery() {
  const [createTimeStart, createTimeEnd] = Array.isArray(filters.createTimeRange) ? filters.createTimeRange : []
  return {
    subjectId: filters.subjectId,
    planId: filters.planId, cycleNo: filters.cycleNo, cycleName: filters.cycleName || undefined,
    taskNo: filters.taskNo || undefined,
    status: filters.status || undefined,
    versionName: filters.versionName || undefined,
    createTimeStart: createTimeStart || undefined,
    createTimeEnd: createTimeEnd || undefined,
    pageNum: filters.pageNum,
    pageSize: filters.pageSize,
  }
}

function clearRefreshTimer() {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
  refreshTimer = null
}

function scheduleRefresh() {
  clearRefreshTimer()
  if (!mounted || !tasks.value.some((task) => isActiveSyncTask(task.status) || ['queued','preparing','running'].includes(task.incrementalImport?.status) || ['pending','probing','retry'].includes(task.importIntake?.status) || task.awaitingImportIntake)) return
  refreshTimer = window.setTimeout(async () => {
    refreshTimer = null
    if (selectedRows.value.length || batchDeleting.value) {
      scheduleRefresh()
      return
    }
    await loadTasks(true)
  }, 3000)
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
  const revision = ++taskListRevision
  // Clear before the request too: a failed query must not leave an old row
  // armed for a later batch action.
  clearSelection()
  if (!silent) loading.value = true
  errorMessage.value = ''
  try {
    const page = unwrapSyncTaskPage(await listQuestionSyncTasks(requestQuery()), 'question')
    if (revision !== taskListRevision) return
    tasks.value = page.rows
    total.value = page.total
    // A refresh/query/page change invalidates table row identities; clear
    // selection so a stale task cannot be deleted accidentally.
    clearSelection()
  } catch (error) {
    if (revision !== taskListRevision) return
    if (!silent) { tasks.value = []; total.value = 0 }
    errorMessage.value = syncTaskErrorMessage(error, '同步题库任务加载失败')
  } finally {
    if (revision === taskListRevision) { loading.value = false; scheduleRefresh() }
  }
}

function searchTasks() { filters.pageNum = 1; loadTasks() }
function resetFilters() { filters.planId=undefined;filters.cycleNo=undefined;filters.cycleName=''; Object.assign(filters, { subjectId: undefined, taskNo: '', status: undefined, versionName: '', createTimeRange: [], pageNum: 1 }); loadTasks() }

async function loadOptions() {
  try { const r=await request({url:'/bank/sync/question/concurrency-default',params:{subjectId:createForm.subjectId}});concurrencyDefault.value=r.data || r } catch { concurrencyDefault.value={} }
  optionsLoading.value = true
  optionError.value = ''
  try {
    optionVersions.value = normalizeQuestionSyncOptions(await getQuestionSyncOptions()).versions
  } catch (error) {
    optionVersions.value = []
    optionError.value = syncTaskErrorMessage(error, '可同步版本与教材加载失败')
  } finally {
    optionsLoading.value = false
  }
}

async function openCreate() {
  resetCreate()
  createVisible.value = true
  await loadOptions()
}

function resetCreate() {
  createForm.allowPaused=false
  createForm.listConcurrency=0
  createForm.versionId = ''
  createForm.textbookId = undefined
  createForm.limitTo1000Pages = false
  acknowledged.value = false
  optionError.value = ''
}

function resetBookSelection() { createForm.versionId = ''; createForm.textbookId = undefined; createForm.listConcurrency=0; loadOptions() }

function handleVersionChange() {
  createForm.textbookId = undefined
}

async function createTask() {
  if (!canCreate.value || creating.value) return
  creating.value = true
  try {
    const requestData = {
      listConcurrency:createForm.listConcurrency || null,
      allowPaused:createForm.allowPaused,
      versionId: createForm.versionId,
      textbookId: createForm.textbookId,
    }
    if (createForm.limitTo1000Pages === true) requestData.limitTo1000Pages = true
    const task = unwrapSyncTask(await createQuestionSyncTask(requestData), 'question')
    if (!task?.taskId) throw new Error('服务端未返回任务编号')
    createVisible.value = false
    ElMessage.success('同步题库任务已加入队列；同一教材会复用未结束任务')
    await router.push(`/bank/sync-question/${encodeURIComponent(task.taskId)}`)
  } catch (error) {
    ElMessage.error(syncTaskErrorMessage(error, '同步题库任务创建失败'))
  } finally {
    creating.value = false
  }
}

function openDetail(task) { router.push(`/bank/sync-question/${encodeURIComponent(task.taskId)}`) }

async function resumeTask(task) {
  if (actionId.value || !canResumeSyncTask(task)) return
  try {
    await ElMessageBox.confirm(
      task.workflowVersion === 2 ? `将为任务“${task.taskNo || task.taskId}”新增一次关联的补采执行，保留已有成果，核对当前页面后补齐；合格题目自动分批入库。` : `将继续同一个任务“${task.taskNo || task.taskId}”。Collector 新 run 会继承旧快照并从断点继续，不会直接应用正式库。${task.status === 'blocked' ? '请先确认风控已解除。' : ''}确定断点续采吗？`,
      '断点续采',
      { type: 'warning', confirmButtonText: '确认续采', cancelButtonText: '取消' },
    )
    actionId.value = task.taskId
    const resumed = unwrapSyncTask(await resumeQuestionSyncTask(task.taskId), 'question')
    if (!resumed?.taskId) throw new Error('服务端未返回任务编号')
    ElMessage.success(task.workflowVersion === 2 ? '补采任务已提交' : '原任务续采已提交')
    await loadTasks(true)
    if (String(resumed.taskId) !== String(task.taskId)) openDetail(resumed)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '断点续采失败'))
  } finally {
    actionId.value = ''
  }
}

async function stopTask(task) {
  try {
    await ElMessageBox.confirm(`确定停止任务“${task.taskNo || task.taskId}”吗？任务日志会保留。`, '停止任务', { type: 'warning', confirmButtonText: '停止', cancelButtonText: '取消' })
    actionId.value = task.taskId
    await cancelQuestionSyncTask(task.taskId)
    ElMessage.success('停止请求已提交')
    await loadTasks(true)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '任务停止失败'))
  } finally { actionId.value = '' }
}

async function retryTask(task) {
  try {
    await ElMessageBox.confirm('将为同一任务排队执行一次新的采集，保留之前每次的结果和日志。', '再同步一次', { type: 'info', confirmButtonText: '加入队列', cancelButtonText: '取消' })
    actionId.value = task.taskId
    const retried = unwrapSyncTask(await retryQuestionSyncTask(task.taskId), 'question')
    if (!retried?.taskId) throw new Error('服务端未返回新任务编号')
    ElMessage.success('本任务已加入执行队列；已有执行记录保留')
    await router.push(`/bank/sync-question/${encodeURIComponent(retried.taskId)}`)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '任务重试失败'))
  } finally { actionId.value = '' }
}

async function deleteTask(task) {
  try {
    await ElMessageBox.confirm(
      `确定删除终态任务“${task.taskNo || task.taskId}”吗？将删除此任务的全部执行历史及范围，不会删除采集快照或正式题库数据。`,
      '删除任务',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    actionId.value = task.taskId
    await deleteQuestionSyncTask(task.taskId)
    ElMessage.success('同步题库任务已删除')
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
      `确定批量删除选中的 ${targets.length} 个终态任务吗？本操作删除所选任务的全部执行历史及范围，不会删除 Collector 不可变快照、断点或正式题库数据；但任务删除后将无法再从页面继续该任务。`,
      '批量删除任务',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    )
    batchDeleting.value = true
    const succeeded = []
    const failed = []
    for (const task of targets) {
      try {
        await deleteQuestionSyncTask(task.taskId)
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

onMounted(() => { mounted = true; loadTasks() })
onBeforeUnmount(() => { mounted = false; clearRefreshTimer() })
</script>

<style scoped>
.sync-question-list-page { min-height: calc(100vh - 84px); color: var(--el-text-color-primary); }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.page-heading h2 { margin: 0; font-size: 20px; font-weight: 600; }
.page-heading p { max-width: 760px; margin: 6px 0 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.heading-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.state-alert, .dialog-alert { margin-bottom: 14px; }
.panel { min-width: 0; padding: 16px; border: 1px solid var(--el-border-color-light); border-radius: 8px; background: var(--el-bg-color); }
.filter-form { margin-bottom: 4px; }
.batch-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; margin-bottom: 8px; }
.selection-hint { color: var(--el-text-color-secondary); font-size: 12px; }
.filter-form :deep(.el-form-item) { margin-bottom: 10px; }
.filter-form :deep(.el-input) { width: 180px; }
.filter-form :deep(.el-date-editor) { width: 260px; }
.status-select { width: 150px; }
.table-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; color: var(--el-text-color-secondary); font-size: 12px; }
.table-footer :deep(.el-pagination) { flex-wrap: wrap; justify-content: flex-end; }
.full-control { width: 100%; }
.option-line { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 16px; }
.option-line small { color: var(--el-color-danger); font-size: 11px; }
.textbook-picker { width: 100%; min-height: 120px; max-height: 320px; overflow: auto; border: 1px solid var(--el-border-color-light); border-radius: 6px; }
.textbook-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0; }
.textbook-option { min-width: 0; padding: 11px 13px; border-right: 1px solid var(--el-border-color-lighter); border-bottom: 1px solid var(--el-border-color-lighter); }
.textbook-option:nth-child(2n) { border-right: 0; }
.textbook-option.is-disabled { background: var(--el-fill-color-extra-light); }
.book-name { font-weight: 500; }
.book-meta { margin-left: 8px; color: var(--el-text-color-secondary); font-size: 11px; }
.disabled-reason { display: block; margin: 3px 0 0 24px; color: var(--el-color-danger); font-size: 11px; }
.scope-summary { width: 100%; padding: 12px 14px; border-radius: 6px; background: var(--el-fill-color-extra-light); }
.scope-summary strong, .scope-summary span { display: block; }
.scope-summary span { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 12px; }
.scope-summary p { margin: 7px 0 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.page-limit-option { width: 100%; }
.page-limit-option p { margin: 7px 0 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
@media (max-width: 760px) { .page-heading { flex-direction: column; } .heading-actions { justify-content: flex-start; } .table-footer { align-items: flex-start; flex-direction: column; } .textbook-options { grid-template-columns: 1fr; } .textbook-option { border-right: 0; } }
</style>
