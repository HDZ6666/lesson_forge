<template>
  <div class="app-container sync-center-page textbook-task-detail">
    <header class="page-heading">
      <div class="heading-copy">
        <el-button link type="primary" :icon="ArrowLeft" @click="goBack">返回任务列表</el-button>
        <h2>教材发现详情</h2>
        <p>查看本次发现的教材和登记结果；记录独立保存，方便回看变化。</p>
      </div>
      <div class="heading-actions">
        <el-button :icon="Refresh" :loading="loading" @click="refreshTask">刷新状态</el-button>
        <el-button
          v-if="task && task.eligible"
          v-hasPermi="['bank:sync:textbook:apply']"
          type="primary"
          :icon="Upload"
          :disabled="task.isCurrent"
          :loading="acting"
          @click="applyTask"
        >{{ textbookApplyActionLabel(task) }}</el-button>
        <el-button
          v-if="task && canCancelSyncTask(task.status)"
          v-hasPermi="['bank:sync:textbook:cancel', 'bank:sync:run']"
          type="danger"
          plain
          :icon="VideoPause"
          :loading="acting"
          @click="stopTask"
        >停止任务</el-button>
        <el-button
          v-if="task && canRetrySyncTask(task.status)"
          v-hasPermi="['bank:sync:textbook:retry', 'bank:sync:textbook:add', 'bank:sync:run']"
          type="warning"
          plain
          :icon="RefreshRight"
          :loading="acting"
          @click="retryTask"
        >重试任务</el-button>
      </div>
    </header>
    <SyncCenterNav active="discovery"/>

    <section v-if="task?.discoveryMode" class="panel">
      <h3>{{ task.discoveryResult ? '发现登记结果' : '等待自动登记' }}</h3>
      <p>正常新增及改名自动登记；人工业务启停保持不变，本次未发现不删除或停用旧教材。</p>
      <el-alert v-if="task.discoveryError" :title="task.discoveryError" type="error" :closable="false"/>
      <el-button v-if="task.discoveryError" v-hasPermi="['bank:sync:textbook:apply']" :loading="acting" @click="retryDiscovery">重试登记当前快照</el-button>
      <template v-if="task.discoveryResult"><p v-if="task.discoveryResult.action==='superseded'">已有更新的发现任务 {{task.discoveryResult.supersededBy}}，本次仅保留历史。</p>
        <details v-for="(label,key) in discoveryLabels" :key="key" class="sync-disclosure"><summary>{{label}} · {{task.discoveryResult.changes?.[key]?.length || 0}} 项</summary>
          <el-table max-height="min(560px, 60vh)" scrollbar-always-on v-if="task.discoveryResult.changes?.[key]?.length" :data="task.discoveryResult.changes[key]"><el-table-column prop="externalId" label="来源ID"/><el-table-column prop="oldName" label="原名称"/><el-table-column prop="name" label="名称"/><el-table-column v-if="key==='conflicts'" prop="observedVersionId" label="来源版本ID"/><el-table-column prop="reason" label="说明"/></el-table>
          <p v-if="!task.discoveryResult.changes?.[key]?.length" class="sync-muted">本次没有此类变化。</p>
        </details>
      </template>
    </section>
    <section v-if="task?.discoveryMode" class="sync-panel"><SyncIssues :task-id="task.taskId" :subject-id="task.subjectId"/></section>
    <el-alert v-if="requestError" class="state-alert" type="error" :closable="false" show-icon>{{ requestError }}</el-alert>
    <el-alert
      v-if="applySuccess"
      class="state-alert"
      type="success"
      title="正式教材版本已切换"
      :description="applySuccess"
      show-icon
      @close="applySuccess = ''"
    />
    <el-alert v-if="task?.status === 'completed'" class="state-alert" type="success" :closable="false" show-icon>
      {{ completedStateMessage }}
    </el-alert>
    <el-alert v-if="task?.eligible && task?.isCurrent" class="state-alert" type="info" :closable="false" show-icon>
      当前任务快照已是正式版本，重复提交不会产生新的应用历史。
    </el-alert>
    <el-alert v-if="!task?.discoveryMode && task?.status === 'completed' && !task?.eligible && task?.eligibilityMessage" class="state-alert" type="warning" :closable="false" show-icon>
      当前任务暂不可应用：{{ task.eligibilityMessage }}
    </el-alert>

    <!-- Put the snapshot comparison first so review is the primary task
         action; metadata, status and the raw log remain below it. -->
    <section v-if="task && !task.discoveryMode && task.status === 'completed'" class="comparison-panel">
      <TextbookComparison
        ref="comparisonRef"
        :metadata-run-id="task.metadataRunId"
        :load-comparison="loadTaskComparison"
        :auto-load="false"
        heading="任务快照对比"
        description="左侧是该任务抓取的完整版本与教材，右侧是当前正式数据。点击左侧已有数据可定位右侧对应项。"
      />
    </section>
    <section v-else-if="task && !task.discoveryMode && task.status !== 'completed'" class="waiting-panel panel">
      <el-empty :image-size="76" :description="comparisonWaitingText" />
    </section>

    <section v-if="task" class="task-summary panel" v-loading="loading">
      <div class="status-line">
        <div>
          <span class="task-number">任务 {{ task.taskNo || task.taskId }}</span>
          <el-tag :type="syncTaskStatusMeta(task.status).type">{{ syncTaskStatusMeta(task.status).label }}</el-tag>
        </div>
        <span class="progress-copy">{{ Math.round(task.progress) }}%</span>
      </div>
      <el-progress :percentage="task.progress" :status="progressStatus" :stroke-width="10" />
      <details class="sync-disclosure"><summary>任务信息与采集统计</summary>
      <el-descriptions :column="2" border size="small" class="task-descriptions">
        <el-descriptions-item label="Service taskId">{{ task.taskId }}</el-descriptions-item>
        <el-descriptions-item label="当前阶段">{{ task.phase || '—' }}</el-descriptions-item>
        <el-descriptions-item label="Collector job">{{ task.collectorJobId || '—' }}</el-descriptions-item>
        <el-descriptions-item label="metadataRunId">{{ task.metadataRunId || '待绑定' }}</el-descriptions-item>
        <el-descriptions-item label="抓取版本">{{ task.fetchedVersionCount }}</el-descriptions-item>
        <el-descriptions-item label="抓取教材">{{ task.fetchedTextbookCount }}</el-descriptions-item>
        <el-descriptions-item label="新增版本">{{ task.newVersionCount }}</el-descriptions-item>
        <el-descriptions-item label="新增教材">{{ task.newTextbookCount }}</el-descriptions-item>
        <el-descriptions-item label="创建人">{{ task.createdBy || '—' }}</el-descriptions-item>
        <el-descriptions-item label="当前阶段">{{ task.currentTextbookName || '版本与教材元数据' }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatTaskTime(task.createTime) }}</el-descriptions-item>
        <el-descriptions-item label="开始时间">{{ formatTaskTime(task.startedAt) }}</el-descriptions-item>
        <el-descriptions-item label="完成时间">{{ formatTaskTime(task.completedAt) }}</el-descriptions-item>
        <el-descriptions-item label="任务含义">{{ textbookTaskMeaning(task) }}</el-descriptions-item>
        <el-descriptions-item v-if="!task.discoveryMode" label="正式版本">{{ task.isCurrent ? `任务 ${task.taskNo || task.taskId}` : (task.currentTaskId ? `任务 ${task.currentTaskId}` : '尚未应用') }}</el-descriptions-item>
        <el-descriptions-item v-if="!task.discoveryMode" label="最近应用时间">{{ formatTaskTime(task.appliedAt) }}</el-descriptions-item>
      </el-descriptions></details>
      <el-alert v-if="task.errorMessage" class="inner-alert" type="error" :closable="false" show-icon>{{ task.errorMessage }}</el-alert>
      <el-button v-if="['failed','blocked'].includes(task.status)" :loading="failureLoading" @click="showFailurePage">查看出错现场</el-button>
      <details class="log-panel sync-disclosure">
        <summary>运行日志 · 自动刷新最后 100 条</summary>
        <pre v-if="task.logs.length" tabindex="0" aria-label="运行日志">{{ task.logs.join('\n') }}</pre>
        <el-empty v-else :image-size="54" description="暂无运行日志" />
      </details>
    </section>

    <el-dialog v-model="failureVisible" class="detail-scroll-dialog" title="采集器出错现场" width="min(960px, 94vw)">
      <p class="sync-muted">这是服务器采集浏览器保存的页面，截图只能查看；需要验证时须在同一个服务器浏览器中人工处理。</p>
      <template v-if="failurePage?.available">
        <p>{{ failurePage.title }} · {{ formatTaskTime(failurePage.capturedAt) }}</p>
        <p>{{ failurePage.url }}</p>
        <el-link v-if="failureSourceUrl" :href="failureSourceUrl" target="_blank" rel="noopener noreferrer" type="primary">在本机打开来源页面</el-link>
        <img v-if="failurePage.screenshot" :src="failurePage.screenshot" alt="服务器采集浏览器出错页面" style="display:block;max-width:100%;margin-top:16px" />
        <pre class="detail-log" tabindex="0" aria-label="出错页面文本">{{ failurePage.text }}</pre>
      </template>
      <el-empty v-else description="本次未保存页面现场。旧任务没有截图；更新后的任务会在浏览器关闭前保存现场。" />
    </el-dialog>
  </div>
</template>

<script setup>
import { usePollingLifecycle } from '../../composables/usePollingLifecycle'
import SyncCenterNav from '../../components/SyncCenterNav.vue'
import '../../styles/sync-center.scss'
import request from '@/utils/request'
const discoveryLabels={newVersions:'新增版本',renamedVersions:'版本改名',missingVersions:'本次未发现版本',newTextbooks:'新增教材',renamedTextbooks:'教材改名',missingTextbooks:'本次未发现教材',conflicts:'归属冲突'}

import { computed, nextTick, ref, watch } from 'vue'
const failureVisible = ref(false)
const failureLoading = ref(false)
const failurePage = ref(null)
const failureSourceUrl = computed(() => {
  try {
    const url = new URL(failurePage.value?.url)
    return url.protocol === 'https:' && url.hostname === 'zujuan.xkw.com' ? url.href : null
  } catch { return null }
})
async function showFailurePage() {
  failureLoading.value = true
  try {
    const response = await request({ url: `/bank/sync/textbook/tasks/${task.value.taskId}/failure-page`, method: 'get' })
    failurePage.value = response.data
    failureVisible.value = true
  } finally { failureLoading.value = false }
}
import { ArrowLeft, Refresh, RefreshRight, Upload, VideoPause } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import TextbookComparison from './comparison.vue'
import SyncIssues from '../../components/SyncIssues.vue'
import {
  cancelTextbookSyncTask,
  applyTextbookSyncTask,
  getTextbookSyncTask,
  getTextbookSyncTaskComparison,
  retryTextbookSyncTask,
} from '../../api/bank'
import {
  canCancelSyncTask,
  canRetrySyncTask,
  formatTextbookApplyStats,
  formatTaskTime,
  isActiveSyncTask,
  syncTaskErrorMessage,
  syncTaskStatusMeta,
  textbookApplyActionLabel,
  textbookApplyVerb,
  textbookTaskMeaning,
  unwrapSyncTask,
} from '../../utils/sync-task'

const route = useRoute()
const router = useRouter()
const task = ref(null)
const loading = ref(false)
const acting = ref(false)
const requestError = ref('')
const applySuccess = ref('')
const comparisonRef = ref()
let pollTimer = null
let mounted = false
let loadedComparisonTaskId = ''

const taskId = computed(() => String(route.params.taskId || route.query.taskId || ''))
const progressStatus = computed(() => {
  if (['failed', 'blocked'].includes(task.value?.status)) return 'exception'
  if (task.value?.status === 'cancelled') return 'warning'
  if (task.value?.status === 'completed') return 'success'
  return undefined
})
const comparisonWaitingText = computed(() => {
  if (['failed', 'blocked'].includes(task.value?.status)) return '任务未成功，不能查看或应用快照对比'
  if (task.value?.status === 'cancelled') return '任务已停止，不会生成可应用的完整快照'
  return '采集进行中，完成后将自动加载本任务的版本与教材快照对比'
})
const completedStateMessage = computed(() => {
  if (task.value?.discoveryMode) return task.value.discoveryResult ? '采集完成，正常项已自动登记；变化及冲突见发现结果。' : task.value.discoveryError ? '采集完成，登记失败；可重试登记当前快照。' : '采集完成，正在后台登记。'
  if (task.value?.isCurrent) return '采集已完成，且本任务快照已应用为当前正式版本。'
  if (task.value?.eligible) return `采集已完成。请先核对下方快照差异，再确认${textbookApplyVerb(task.value)}正式版本。`
  return '采集已完成，但当前快照暂不可应用。'
})

function goBack() {
  router.push('/sync-center/discovery')
}

function clearPoll() {
  if (pollTimer !== null) window.clearTimeout(pollTimer)
  pollTimer = null
}

function schedulePoll() {
  clearPoll()
  if (!mounted || !task.value || (!isActiveSyncTask(task.value.status) && !(task.value.discoveryMode && task.value.status === 'completed' && !task.value.discoveryResult && !task.value.discoveryError))) return
  pollTimer = window.setTimeout(async () => {
    pollTimer = null
    await loadTask(true)
  }, 2500)
}

async function ensureComparisonLoaded() {
  if (!task.value || task.value.discoveryMode || task.value.status !== 'completed' || loadedComparisonTaskId === task.value.taskId) return
  loadedComparisonTaskId = task.value.taskId
  await nextTick()
  try {
    await comparisonRef.value?.loadOverview()
  } catch {
    loadedComparisonTaskId = ''
  }
}

async function loadTask(silent = false) {
  if (!taskId.value) {
    requestError.value = '缺少任务编号，无法加载详情'
    task.value = null
    return
  }
  if (!silent) loading.value = true
  requestError.value = ''
  try {
    const result = unwrapSyncTask(await getTextbookSyncTask(taskId.value), 'textbook')
    if (!result) throw new Error('未找到同步教材任务')
    task.value = result
    await ensureComparisonLoaded()
  } catch (error) {
    requestError.value = syncTaskErrorMessage(error, '教材发现详情加载失败')
  } finally {
    if (!silent) loading.value = false
    schedulePoll()
  }
}

async function refreshTask() {
  loadedComparisonTaskId = ''
  await loadTask()
}

function loadTaskComparison() {
  return getTextbookSyncTaskComparison(taskId.value)
}

async function retryDiscovery(){
  acting.value=true
  try{await request({url:`/bank/sync/textbook/tasks/${task.value.taskId}/discovery-retry`,method:'post'}); await loadTask(true); ElMessage.success('已安排后台重新登记')}catch(e){ElMessage.error(syncTaskErrorMessage(e,'登记重试失败'))}finally{acting.value=false}
}

async function stopTask() {
  if (!task.value) return
  try {
    await ElMessageBox.confirm('停止后将保留任务状态和日志，但不会生成可应用的完整快照。确定停止吗？', '停止任务', {
      type: 'warning', confirmButtonText: '停止', cancelButtonText: '取消',
    })
    acting.value = true
    await cancelTextbookSyncTask(task.value.taskId)
    ElMessage.success('停止请求已提交')
    await loadTask(true)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '任务停止失败'))
  } finally {
    acting.value = false
  }
}

async function retryTask() {
  if (!task.value) return
  try {
    await ElMessageBox.confirm('重试将创建一个新任务，原任务快照和日志保持不变。', '重试任务', {
      type: 'info', confirmButtonText: '创建新任务', cancelButtonText: '取消',
    })
    acting.value = true
    const retried = unwrapSyncTask(await retryTextbookSyncTask(task.value.taskId), 'textbook')
    if (!retried?.taskId) throw new Error('服务端未返回新任务编号')
    ElMessage.success('新任务已创建')
    await router.push(`/bank/sync-textbook/${encodeURIComponent(retried.taskId)}`)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '任务重试失败'))
  } finally {
    acting.value = false
  }
}

async function applyTask() {
  if (!task.value || !task.value.eligible || task.value.isCurrent) return
  const currentTask = task.value.currentTaskId ? `任务 ${task.value.currentTaskId}` : '尚未应用正式版本'
  const targetTask = `任务 ${task.value.taskNo || task.value.taskId}`
  const action = textbookApplyVerb(task.value)
  try {
    applySuccess.value = ''
    await ElMessageBox.confirm(
      `确定将正式教材从“${currentTask}”切换为“${targetTask}”吗？同来源未出现在目标快照的数据将被禁用，不会物理删除；目录和题目不变。`,
      `${action}正式教材快照`,
      { type: 'warning', confirmButtonText: `确认${action}`, cancelButtonText: '取消' },
    )
    acting.value = true
    const response = await applyTextbookSyncTask(task.value.taskId, task.value.currentTaskId || null)
    const result = response?.data || response
    applySuccess.value = `${action}成功。${formatTextbookApplyStats(result)}`
    ElMessage.success({
      message: `${action}成功，已更新正式教材版本`,
      duration: 7000,
      showClose: true,
    })
    loadedComparisonTaskId = ''
    await loadTask()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, `${action}正式教材快照失败，请确认权限并刷新任务状态后重试`))
  } finally {
    acting.value = false
  }
}

watch(taskId, () => {
  clearPoll()
  loadedComparisonTaskId = ''
  task.value = null
  loadTask()
})

usePollingLifecycle(() => { mounted = true; loadTask() }, () => { mounted = false; clearPoll() })
</script>

<style scoped>
.textbook-task-detail { min-height: calc(100vh - 84px); color: var(--el-text-color-primary); }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.heading-copy h2 { margin: 6px 0 0; font-size: 20px; font-weight: 600; }
.heading-copy p { max-width: 760px; margin: 6px 0 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.heading-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.state-alert { margin-bottom: 14px; }
.panel { min-width: 0; padding: 16px; border: 1px solid var(--el-border-color-light); border-radius: 8px; background: var(--el-bg-color); }
.task-summary { margin-bottom: 16px; }
.status-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.status-line > div { display: flex; align-items: center; gap: 10px; }
.task-number { font-size: 16px; font-weight: 600; }
.progress-copy { color: var(--el-text-color-secondary); font-size: 13px; }
.task-descriptions { margin-top: 16px; }
.inner-alert { margin-top: 14px; }
.log-panel { margin-top: 16px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.section-heading h3 { margin: 0; font-size: 15px; }
.section-heading span { color: var(--el-text-color-secondary); font-size: 12px; }
.log-panel pre { max-height: 260px; margin: 0; overflow: auto; padding: 12px; border-radius: 6px; background: var(--el-fill-color-extra-light); color: var(--el-text-color-primary); white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.8 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.comparison-panel { min-width: 0; margin-bottom: 16px; }
.waiting-panel { min-height: 220px; }
@media (max-width: 900px) { .task-descriptions :deep(.el-descriptions__body) { overflow-x: auto; } }
@media (max-width: 720px) { .page-heading { flex-direction: column; } .heading-actions { justify-content: flex-start; } .status-line { align-items: flex-start; flex-direction: column; } }
</style>
