<template>
  <div class="app-container sync-center-page">
    <header class="page-heading">
      <div><h2>同步中心</h2><p>逐本建立题库，查看采集进度，集中处理需要你关注的问题。</p></div>
      <div class="heading-actions"><SubjectSelect v-model="subjectId" @change="load" /><SourceBudgetSettings @updated="load" /><el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button></div>
    </header>
    <SyncCenterNav active="overview" :subject-id="subjectId" />
    <SyncWorkflow />
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <section v-if="!loading && !error && !summary.textbooks" class="welcome sync-panel">
      <div class="welcome-icon"><el-icon><Collection /></el-icon></div>
      <div class="welcome-copy"><span class="eyebrow">从这里开始</span><h3>创建一个计划，自动建立题库</h3><p>选择学科创建同步计划，系统自动发现教材、逐本排队采集，并将合格题目分批入库。</p></div>
      <el-button type="primary" @click="router.push({path:'/sync-center/plans',query:{subjectId}})">创建学科同步计划 <el-icon class="el-icon--right"><ArrowRight /></el-icon></el-button>
    </section>
    <div class="sync-stat-grid" v-loading="loading">
      <div class="sync-stat"><span>当前教材</span><strong>{{ number(summary.textbooks) }}</strong><small>{{ number(summary.textbooksWithoutQuestions) }} 本尚无可用题</small></div>
      <div class="sync-stat accent"><span>有可用题的教材</span><strong>{{ number(summary.textbooksWithQuestions) }}</strong><small>题干和必要素材已检查</small></div>
      <div class="sync-stat"><span>待补齐教材</span><strong>{{ number(summary.textbooksNeedingRefill) }}</strong><small>后续循环继续补齐</small></div>
      <div class="sync-stat" :class="{ warning: summary.openIssueCount > 0 }"><span>待处理问题</span><strong>{{ number(summary.openIssueCount) }}</strong><el-button link type="primary" @click="openIssues">查看问题 <el-icon><ArrowRight /></el-icon></el-button></div>
    </div>
    <div class="overview-grid">
      <section class="sync-panel">
        <div class="section-heading"><h3>运行状态</h3><el-tag :type="runtime.type" effect="light" round>{{ runtime.label }}</el-tag></div>
        <el-alert v-if="runtime.reason" :title="runtime.reason" :type="runtime.type === 'danger' ? 'error' : 'warning'" :closable="false" show-icon />
        <div class="task-slot"><span class="slot-label">正在执行</span><template v-if="summary.currentTask"><strong>{{ summary.currentTask.textbookName || `任务 #${summary.currentTask.taskId}` }}</strong><el-button link type="primary" @click="open(summary.currentTask)">查看进度</el-button></template><template v-else><strong>暂无执行中的任务</strong><span class="sync-muted">新任务会在后台依次执行，可随时离开页面。</span></template></div>
        <div class="queue-line"><span>下一项到期待办</span><el-button v-if="summary.nextTask" link type="primary" @click="open(summary.nextTask)">{{ summary.nextTask.textbookName || `任务 #${summary.nextTask.taskId}` }}</el-button><span v-else>暂无</span></div>
        <p v-if="summary.deferredTask" class="sync-muted">暂缓：{{ summary.deferredTask.textbookName || `任务 #${summary.deferredTask.taskId}` }} · {{ summary.deferredTask.reason }}<template v-if="summary.deferredTask.notBefore"> · 最早 {{ formatTaskTime(summary.deferredTask.notBefore) }}</template></p>
        <div class="panel-actions"><el-button type="primary" plain @click="router.push('/sync-center/tasks')">管理同步任务</el-button><el-button v-hasPermi="['bank:sync:control']" :type="summary.control?.paused ? 'primary' : 'danger'" link :disabled="loading || !!error" :loading="controlling" @click="toggleControl">{{ summary.control?.paused ? '恢复同步' : '紧急暂停' }}</el-button></div>
      </section>
      <section class="sync-panel">
        <div class="section-heading"><h3>本轮覆盖进度</h3><el-button link type="primary" @click="router.push({path:'/sync-center/plans',query:{subjectId}})">查看学科计划 <el-icon><ArrowRight /></el-icon></el-button></div>
        <div class="cycle-number"><strong>{{ number(summary.cycleAttemptedCount) }}</strong><span>/ {{ number(summary.cycleTargetCount) }} 本已尝试</span></div>
        <el-progress :percentage="cyclePercent" :show-text="false" :stroke-width="8" />
        <p class="sync-muted">{{ summary.cycleTargetCount ? '按计划顺序处理全部教材，本轮结束后再计算下一轮时间。' : '尚未开始本轮同步，请在学科计划中查看发现进度或创建计划。' }}</p>
        <div class="mini-stats"><div><strong>{{ activeCount }}</strong><span>执行中任务</span></div><div><strong>{{ number(summary.taskCounts?.queued) }}</strong><span>排队中</span></div><div><strong>{{ number(summary.retryIssueCount) }}</strong><span>自动重试问题</span></div></div>
        <p v-if="control.automaticReason" class="plan-note"><el-icon><InfoFilled /></el-icon>{{ control.automaticReason }}</p>
      </section>
    </div>
    <section class="sync-panel">
      <div class="section-heading"><div><h3>最近任务</h3><p>采集完成后，合格题目会在后台分批入库。</p></div><el-button link type="primary" @click="router.push('/sync-center/tasks')">全部任务 <el-icon><ArrowRight /></el-icon></el-button></div>
      <el-table v-loading="loading" :data="summary.recentTasks || []">
        <el-table-column label="任务" min-width="150"><template #default="{row}"><el-button link type="primary" @click="open(row)">#{{ row.taskId }} · {{ row.taskModule === 'textbook' ? '教材发现' : row.taskModule === 'question' ? '教材同步' : '历史同步' }}</el-button></template></el-table-column>
        <el-table-column label="状态" width="115"><template #default="{row}"><el-tag :type="syncTaskStatusMeta(row.status).type" effect="light">{{ syncTaskStatusMeta(row.status).label }}</el-tag></template></el-table-column>
        <el-table-column label="创建时间" min-width="170"><template #default="{row}">{{ formatTaskTime(row.createTime) }}</template></el-table-column>
        <el-table-column label="需关注的信息" min-width="220" show-overflow-tooltip><template #default="{row}">{{ row.error || '—' }}</template></el-table-column>
        <el-table-column label="操作" width="100" fixed="right"><template #default="{row}"><el-button link type="primary" @click="open(row)">查看详情</el-button></template></el-table-column>
        <template #empty><el-empty :image-size="64" description="还没有同步任务"><el-button type="primary" plain @click="router.push({path:'/sync-center/plans',query:{subjectId}})">创建同步计划</el-button></el-empty></template>
      </el-table>
    </section>
    <section class="sync-panel resource-panel">
      <details><summary>运行环境与今日用量 <span class="sync-muted">查看服务资源、存储及请求统计</span></summary>
        <div class="resource-grid">
          <div><h4>后端服务</h4><p>可用内存 <strong>{{ mib(control.serviceResources?.availableMemoryMiB) }}</strong></p><p>可用磁盘 <strong>{{ mib(control.serviceResources?.freeDiskMiB) }}</strong></p><p>数据库 <strong>{{ mib(summary.storage?.databaseBytes == null ? null : summary.storage.databaseBytes / 1048576) }}</strong></p></div>
          <div><h4>采集器</h4><p>可用内存 <strong>{{ mib(control.collector?.resources?.memoryMiB) }}</strong></p><p v-for="disk in control.collector?.resources?.disks || []" :key="disk.kind">{{ diskLabels[disk.kind] || disk.kind }} <strong>{{ mib(disk.freeMiB) }}</strong></p></div>
          <div><h4>今日采集</h4><p>主动请求 <strong>{{ number(control.collector?.sourceBudget?.usage?.requests) }} 次</strong></p><p>启动教材 <strong>{{ number(control.collector?.sourceBudget?.usage?.bookStarts) }} 本</strong></p><p>运行时长 <strong>{{ Math.ceil((control.collector?.sourceBudget?.usage?.activeMilliseconds || 0) / 60000) }} 分钟</strong></p></div>
          <div><h4>素材</h4><p>今日下载 <strong>{{ mib((control.collector?.sourceBudget?.usage?.downloadBytes || 0) / 1048576) }}</strong></p><p>去重素材 <strong>{{ number(summary.storage?.uniqueAssetCount) }} 份</strong></p></div>
        </div>
      </details>
    </section>
  </div>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh, Collection, ArrowRight, InfoFilled } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/utils/request'
import SubjectSelect from '../../components/SubjectSelect.vue'
import SourceBudgetSettings from '../../components/SourceBudgetSettings.vue'
import SyncWorkflow from '../../components/SyncWorkflow.vue'
import SyncCenterNav from '../../components/SyncCenterNav.vue'
import { formatTaskTime, syncTaskStatusMeta } from '../../utils/sync-task'
import '../../styles/sync-center.scss'
const router = useRouter(), subjectId = ref(), summary = ref({}), loading = ref(false), error = ref('')
const controlling = ref(false), control = ref({})
const number = value => Number(value || 0).toLocaleString('zh-CN')
const mib = value => value == null ? '—' : value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${Number(value).toFixed(0)} MB`
const diskLabels = { database:'快照磁盘', data:'素材磁盘', profile:'浏览器磁盘' }
const activeCount = computed(() => ['starting','running','cancelling'].reduce((n,s) => n + (summary.value.taskCounts?.[s] || 0), 0))
const cyclePercent = computed(() => summary.value.cycleTargetCount ? Math.min(100, Math.round(summary.value.cycleAttemptedCount / summary.value.cycleTargetCount * 100)) : 0)
const runtime = computed(() => {
  if (loading.value || controlLoading.value) return {label:'读取状态',type:'info'}
  if (error.value || control.value.collectorError) return {label:'状态需检查',type:'danger',reason:error.value || control.value.collectorError}
  const reason = summary.value.control?.paused ? summary.value.control.reason || '同步已紧急暂停' : control.value.source?.paused ? control.value.source.reason || '来源暂停中' : control.value.serviceResources?.reason || control.value.collector?.resources?.reason || control.value.collector?.sourceBudget?.reason
  return reason ? {label:'等待处理',type:'warning',reason} : {label:summary.value.currentTask ? '正在同步' : '就绪',type:'success'}
})
const controlLoading = ref(false)
async function toggleControl() {
  if (!summary.value.control?.paused) {
    try { await ElMessageBox.confirm('暂停调度并停止当前采集，已取得的成果会保留。', '紧急暂停同步', {confirmButtonText:'暂停同步',cancelButtonText:'取消',type:'warning'}) } catch { return }
  }
  controlling.value=true
  try { await request({url:'/bank/sync/control',method:'post',data:{paused:!summary.value.control?.paused,expectedRevision:summary.value.control?.revision || 1}});ElMessage.success('同步状态已更新');await load() }
  catch(e){error.value=e.message} finally{controlling.value=false}
}
let requestId = 0
async function loadControl(id) {
  controlLoading.value=true
  try { const result = await request({url:'/bank/sync/control'}); if(id===requestId) control.value=result.data || result }
  catch(e) { if(id===requestId) control.value={collectorError:e?.message || '控制状态加载失败'} }
  finally { if(id===requestId) controlLoading.value=false }
}
async function load() {
  const id = ++requestId; loading.value = true; error.value = ''; void loadControl(id)
  try { const result = await request({ url: '/bank/sync/overview', params: { subjectId: subjectId.value } }); if (id === requestId) summary.value = result.data || result }
  catch (e) { if (id === requestId) { summary.value = {}; error.value = e?.message || '总览加载失败' } }
  finally { if (id === requestId) loading.value = false }
}
function openIssues(){router.push({path:'/sync-center/tasks',query:{tab:'issues',...(subjectId.value ? {subjectId:subjectId.value} : {})}})}
function open(row) { router.push(row.taskModule === 'textbook' ? `/bank/sync-textbook/${row.taskId}` : row.taskModule === 'question' ? `/bank/sync-question/${row.taskId}` : '/bank/sync') }
onMounted(load)
</script>
<style scoped>
.welcome{display:flex;align-items:center;gap:20px;background:linear-gradient(110deg,var(--el-color-primary-light-9),var(--el-bg-color));border-color:var(--el-color-primary-light-7)}.welcome-icon{display:grid;place-items:center;width:58px;height:58px;background:var(--el-color-primary-light-8);color:var(--el-color-primary);font-size:28px;border-radius:14px;flex-shrink:0}.welcome-copy{flex:1}.eyebrow{font-size:12px;color:var(--el-color-primary);font-weight:600}.welcome h3{margin:6px 0;font-size:19px}.welcome p{margin:0;color:var(--el-text-color-secondary);font-size:13px;line-height:1.8}
.overview-grid{display:grid;grid-template-columns:1.15fr 1fr;gap:18px}.task-slot{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:16px;background:var(--el-fill-color-extra-light);border-radius:8px}.task-slot strong{font-size:15px;flex:1}.slot-label{width:100%;font-size:12px;color:var(--el-text-color-secondary)}.task-slot>.sync-muted{width:100%}.queue-line{display:flex;justify-content:space-between;align-items:center;margin:20px 0;font-size:13px;color:var(--el-text-color-secondary)}.panel-actions{display:flex;justify-content:space-between;gap:12px;align-items:center;padding-top:14px;border-top:1px solid var(--el-border-color-lighter)}.cycle-number{display:flex;align-items:baseline;gap:10px;margin-bottom:18px}.cycle-number strong{font-size:32px}.cycle-number span{font-size:13px;color:var(--el-text-color-secondary)}.mini-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:22px}.mini-stats strong{display:block;font-size:20px}.mini-stats span{display:block;color:var(--el-text-color-secondary);font-size:12px;margin-top:6px}.plan-note{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--el-text-color-secondary);line-height:1.7}.plan-note .el-icon{margin-top:3px;flex-shrink:0}.resource-panel summary{cursor:pointer;font-size:14px;font-weight:500}.resource-panel summary span{margin-left:16px;font-weight:400}.resource-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;margin-top:20px}.resource-grid h4{font-size:13px}.resource-grid p{display:flex;justify-content:space-between;gap:8px;color:var(--el-text-color-secondary);font-size:12px}.resource-grid strong{font-weight:500;color:var(--el-text-color-primary)}
@media(max-width:1000px){.overview-grid{grid-template-columns:1fr}.resource-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:600px){.welcome{flex-wrap:wrap}.welcome-icon{display:none}.welcome-copy{flex-basis:100%}.resource-panel summary span{display:block;margin:8px 0 0}.resource-grid{gap:16px}.task-slot strong{flex-basis:75%}}
</style>
