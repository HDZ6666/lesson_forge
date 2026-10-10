<template>
  <section class="sync-run-panel" aria-label="同步任务">
    <div class="run-toolbar">
      <div class="run-heading">
        <strong>同步任务</strong>
        <span class="run-hint">只刷新版本与教材元数据；目录和题目需在同步中心选择教材后提交</span>
      </div>
      <div class="run-actions">
        <el-button
          v-hasPermi="['bank:sync:run']"
          type="primary"
          :icon="VideoPlay"
          :loading="starting"
          :disabled="busy"
          @click="startRun"
        >{{ busy ? '任务进行中' : '刷新版本与教材' }}</el-button>
        <el-button
          v-if="canCancel"
          v-hasPermi="['bank:sync:run']"
          type="warning"
          plain
          :icon="VideoPause"
          :loading="cancelling"
          @click="cancelRun"
        >停止同步</el-button>
      </div>
    </div>

    <el-alert v-if="requestError" class="run-alert" type="error" :closable="false" show-icon>
      {{ requestError }}
    </el-alert>

    <template v-if="run">
      <div class="run-state-line">
        <div class="run-state">
          <el-tag size="small" :type="statusMeta.type">{{ statusMeta.label }}</el-tag>
          <span class="phase-label">{{ phaseLabel }}</span>
          <span class="phase-label">{{ run.taskType === 'content' ? '教材内容（目录 + 题目）' : '版本与教材' }}</span>
          <span v-if="run.currentTextbook" class="current-textbook">当前教材：{{ run.currentTextbook }}</span>
        </div>
        <span v-if="run.runId" class="run-id">任务 {{ run.runId }}</span>
      </div>

      <el-progress
        class="run-progress"
        :percentage="progress"
        :status="progressStatus"
        :stroke-width="8"
        :format="formatProgress"
      />

      <div class="run-stat-grid" aria-label="同步进度统计">
        <div class="run-stat">
          <span>版本</span>
          <strong>{{ countText(run.versionsCompleted, run.versionsTotal) }}</strong>
        </div>
        <div class="run-stat">
          <span>教材</span>
          <strong>{{ countText(run.textbooksCompleted, run.textbooksTotal) }}</strong>
        </div>
        <div class="run-stat">
          <span>目录</span>
          <strong>{{ countText(run.catalogsCompleted, run.catalogsTotal) }}</strong>
        </div>
        <div class="run-stat">
          <span>题目</span>
          <strong>{{ countText(run.questionsCompleted, run.questionsTotal) }}</strong>
        </div>
      </div>

      <el-alert v-if="run.errorMessage" class="run-alert" type="error" :closable="false" show-icon>
        {{ run.errorMessage }}
      </el-alert>

      <details v-if="run.logs.length" class="run-log-details" :open="run.status !== 'completed'">
        <summary>运行日志（最近 {{ run.logs.length }} 条）</summary>
        <pre class="run-log" aria-live="polite">{{ run.logs.join('\n') }}</pre>
      </details>
    </template>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { VideoPause, VideoPlay } from '@element-plus/icons-vue'
import { cancelSyncRun, getCurrentSyncRun, getSyncRun, startMetadataSyncRun } from '../../../api/bank'
import {
  isActiveSyncRunStatus,
  isTerminalSyncRunStatus,
  normalizeSyncRun,
  normalizeSyncRunPhase,
  syncRunErrorMessage,
  syncRunPhaseOptions,
  syncRunProgress,
  syncRunStatusMeta,
  unwrapSyncRun,
} from '../../../utils/sync-run'

const emit = defineEmits(['completed'])

const run = ref(null)
const starting = ref(false)
const cancelling = ref(false)
const requestError = ref('')
let pollTimer = null
let mounted = false

const busy = computed(() => starting.value || Boolean(run.value && isActiveSyncRunStatus(run.value.status)))
const canCancel = computed(() => Boolean(run.value && ['queued', 'starting', 'running'].includes(run.value.status) && !cancelling.value))
const statusMeta = computed(() => syncRunStatusMeta(run.value?.status))
const phaseLabel = computed(() => {
  const phase = normalizeSyncRunPhase(run.value?.phase, '')
  if (phase === 'completed') return '同步完成'
  if (phase === 'failed') return '同步失败'
  if (phase === 'blocked') return '同步已阻断'
  if (phase === 'cancelled') return '同步已停止'
  return syncRunPhaseOptions.find((item) => item.value === phase)?.label || phase || '准备同步'
})
const progress = computed(() => Math.round(syncRunProgress(run.value || {})))
const progressStatus = computed(() => {
  if (run.value?.status === 'failed' || run.value?.status === 'blocked') return 'exception'
  if (run.value?.status === 'cancelled') return 'warning'
  if (run.value?.status === 'completed') return 'success'
  return undefined
})

function formatProgress(value) {
  return `${value}%`
}

function countText(completed, total) {
  const done = Number.isFinite(Number(completed)) ? Number(completed) : 0
  const hasTotal = total !== null && total !== undefined && total !== '' && Number.isFinite(Number(total))
  return hasTotal ? `${done} / ${Number(total)}` : `${done}`
}

function clearPollTimer() {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer)
    pollTimer = null
  }
}

function schedulePoll(runId, delay = 2000) {
  clearPollTimer()
  if (!mounted || !runId || !run.value || !isActiveSyncRunStatus(run.value.status)) return
  pollTimer = window.setTimeout(() => {
    pollTimer = null
    pollRun(runId)
  }, delay)
}

function setRun(value) {
  const normalized = value ? normalizeSyncRun(value) : null
  run.value = normalized && normalized.runId ? normalized : null
  return run.value
}

async function pollRun(runId) {
  if (!mounted || !runId) return
  try {
    const current = unwrapSyncRun(await getSyncRun(runId))
    if (!mounted) return
    requestError.value = ''
    if (current) {
      setRun(current)
      if (isTerminalSyncRunStatus(current.status)) {
        clearPollTimer()
        if (current.status === 'completed') emit('completed', current)
        return
      }
    }
  } catch (error) {
    // A transient polling error must not stop a running collector task.
    if (mounted) requestError.value = syncRunErrorMessage(error, '同步状态暂时无法获取，将继续重试')
  }
  schedulePoll(runId)
}

async function restoreCurrentRun() {
  try {
    const current = unwrapSyncRun(await getCurrentSyncRun())
    if (!mounted) return
    requestError.value = ''
    if (!current) return
    setRun(current)
    if (isActiveSyncRunStatus(current.status)) schedulePoll(current.runId)
  } catch (error) {
    // No current task is a valid initial state. Only display an actual error
    // when the backend returned a meaningful response failure.
    if (error?.response?.status !== 404 && error?.status !== 404) {
      requestError.value = syncRunErrorMessage(error, '同步任务状态加载失败')
    }
  }
}

async function startRun() {
  if (busy.value) return
  try {
    await ElMessageBox.confirm(
      '本次只抓取来源中的版本和教材元数据，不会抓取目录或题目；结果只写入采集候选库，不会自动修改正式题库。确定开始吗？',
      '确认刷新版本与教材',
      {
        type: 'warning',
        confirmButtonText: '开始刷新',
        cancelButtonText: '取消',
      },
    )
    starting.value = true
    requestError.value = ''
    clearPollTimer()
    const started = unwrapSyncRun(await startMetadataSyncRun())
    if (started) {
      setRun(started)
      if (isTerminalSyncRunStatus(started.status)) {
        if (started.status === 'completed') emit('completed', started)
      } else {
        schedulePoll(started.runId, 500)
      }
    } else {
      // A backend may acknowledge the request before returning the task row.
      await restoreCurrentRun()
    }
    ElMessage.success('版本与教材同步任务已启动')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      requestError.value = syncRunErrorMessage(error, '同步任务启动失败')
      ElMessage.error(requestError.value)
    }
  } finally {
    starting.value = false
  }
}

async function cancelRun() {
  if (!run.value?.runId || cancelling.value) return
  try {
    await ElMessageBox.confirm('停止请求会让抓取脚本优雅退出，已写入采集候选库的数据会保留。确定停止吗？', '停止同步', {
      type: 'warning',
      confirmButtonText: '停止',
      cancelButtonText: '继续运行',
    })
    cancelling.value = true
    requestError.value = ''
    const runId = run.value.runId
    await cancelSyncRun(runId)
    run.value = { ...run.value, status: 'cancelling' }
    schedulePoll(runId, 500)
    ElMessage.success('已提交停止请求')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      requestError.value = syncRunErrorMessage(error, '停止同步失败')
      ElMessage.error(requestError.value)
    }
  } finally {
    cancelling.value = false
  }
}

onMounted(() => {
  mounted = true
  restoreCurrentRun()
})

onBeforeUnmount(() => {
  mounted = false
  clearPollTimer()
})
</script>

<style scoped>
.sync-run-panel { margin-bottom: 14px; padding: 14px 16px; border: 1px solid var(--el-border-color-light); border-radius: 6px; background: var(--el-bg-color); }
.run-toolbar, .run-state-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.run-heading, .run-state, .run-actions { display: flex; align-items: center; gap: 10px; }
.run-heading strong { font-size: 15px; font-weight: 600; }
.run-hint, .run-id, .phase-label, .current-textbook { color: var(--el-text-color-secondary); font-size: 12px; }
.run-actions { flex: none; }
.run-alert { margin-top: 12px; }
.run-state-line { margin-top: 14px; }
.run-state { min-width: 0; flex-wrap: wrap; }
.current-textbook { max-width: min(560px, 58vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-id { flex: none; }
.run-progress { margin-top: 12px; }
.run-progress :deep(.el-progress-bar__outer) { background: var(--el-fill-color-light); }
.run-stat-grid { display: grid; grid-template-columns: repeat(4, minmax(100px, 1fr)); gap: 10px; margin-top: 12px; }
.run-stat { min-width: 0; padding: 8px 10px; border-left: 3px solid var(--el-border-color); background: var(--el-fill-color-lighter); }
.run-stat span { display: block; color: var(--el-text-color-secondary); font-size: 12px; }
.run-stat strong { display: block; margin-top: 3px; font-size: 16px; line-height: 1.2; }
.run-log-details { margin-top: 12px; border-top: 1px solid var(--el-border-color-lighter); }
.run-log-details summary { padding-top: 10px; color: var(--el-text-color-regular); cursor: pointer; font-size: 12px; }
.run-log { max-height: 190px; margin: 8px 0 0; padding: 10px; overflow: auto; border: 1px solid var(--el-border-color-lighter); background: var(--el-fill-color-lighter); color: var(--el-text-color-primary); font: 13px/1.8 var(--el-font-family); white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 980px) { .run-stat-grid { grid-template-columns: repeat(2, minmax(100px, 1fr)); } }
@media (max-width: 760px) {
  .run-toolbar, .run-state-line { align-items: flex-start; flex-direction: column; }
  .run-heading { align-items: flex-start; flex-direction: column; gap: 4px; }
  .run-actions { width: 100%; }
  .run-actions .el-button { flex: 1; }
  .current-textbook { max-width: 100%; }
}
@media (max-width: 460px) { .run-stat-grid { grid-template-columns: 1fr; } }
</style>
