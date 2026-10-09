<template>
  <div class="app-container">
    <div class="heading"><h2>同步总览</h2><SubjectSelect v-model="subjectId" @change="load" /><el-button :loading="loading" @click="load">刷新</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div class="stats">
      <el-card v-for="stat in stats" :key="stat.name"><span>{{ stat.name }}</span><strong>{{ stat.value }}</strong></el-card>
    </div>
    <p class="note">有可用题表示正式题库已通过题干和必要素材检查；完成范围扫描是另一项指标。</p>
    <div class="actions"><el-button @click="router.push('/sync-center/plans')">自动同步计划</el-button><el-button @click="router.push('/sync-center/discovery')">教材发现</el-button><el-button type="primary" @click="router.push('/sync-center/tasks')">同步任务</el-button></div>
    <el-alert v-if="summary.control?.paused" :title="summary.control.reason || '同步已紧急暂停'" type="warning" :closable="false"/>
    <el-button v-hasPermi="['bank:sync:control']" :loading="controlling" @click="toggleControl">{{ summary.control?.paused ? '恢复同步' : '紧急暂停同步' }}</el-button>
    <p>当前任务：{{ summary.currentTask?.taskId || '暂无' }}；下一项待办：{{ summary.nextTask?.taskId || '暂无' }}<span v-if="summary.nextTask?.reason"> · {{summary.nextTask.reason}}</span></p>
    <el-alert v-if="control.collectorError" :title="`采集器：${control.collectorError}`" type="warning" :closable="false"/>
    <el-alert v-if="control.source?.paused" :title="control.source.reason || '来源已暂停'" type="warning" :closable="false"/>
    <el-alert v-if="control.collector?.resources?.reason" :title="control.collector.resources.reason" type="warning" :closable="false"/>
    <p v-if="control.collector?.sourceBudget">今日主动请求 {{control.collector.sourceBudget.usage.requests}} · 启动教材 {{control.collector.sourceBudget.usage.bookStarts}} · 占用 {{Math.ceil(control.collector.sourceBudget.usage.activeMilliseconds/1000)}} 秒 · 下载 {{(control.collector.sourceBudget.usage.downloadBytes/1048576).toFixed(1)}} MiB</p>
    <p v-if="control.collector?.resources">采集器可用内存 {{Math.floor(control.collector.resources.memoryMiB)}} MiB<span v-for="disk in control.collector.resources.disks" :key="disk.kind"> · {{disk.kind}} 可用 {{Math.floor(disk.freeMiB)}} MiB</span></p>
    <h3>最近任务</h3>
    <el-table v-loading="loading" :data="summary.recentTasks || []">
      <el-table-column prop="taskId" label="任务" width="100" />
      <el-table-column label="类型"><template #default="{row}">{{ row.taskModule === 'textbook' ? '教材发现' : row.taskModule === 'question' ? '教材内容' : '历史同步' }}</template></el-table-column>
      <el-table-column label="状态"><template #default="{row}">{{ labels[row.status] || row.status }}</template></el-table-column>
      <el-table-column prop="createTime" label="创建时间" />
      <el-table-column prop="error" label="需关注的信息" show-overflow-tooltip />
      <el-table-column label="操作"><template #default="{row}"><el-button link type="primary" @click="open(row)">查看任务</el-button></template></el-table-column>
    </el-table>
    <SyncIssues :subject-id="subjectId"/>
  </div>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import request from '@/utils/request'
import SubjectSelect from '../../components/SubjectSelect.vue'
import SyncIssues from '../../components/SyncIssues.vue'
const router = useRouter(), subjectId = ref(), summary = ref({}), loading = ref(false), error = ref('')
const controlling = ref(false), control = ref({})
async function toggleControl(){controlling.value=true;try{await request({url:'/bank/sync/control',method:'post',data:{paused:!summary.value.control?.paused,expectedRevision:summary.value.control?.revision || 1}});await load()}catch(e){error.value=e.message}finally{controlling.value=false}}
let requestId = 0
const labels = { queued: '待执行', starting: '启动中', running: '采集中', cancelling: '取消中', completed: '采集完成', failed: '失败', blocked: '阻断', cancelled: '已取消', interrupted: '已中断' }
const stats = computed(() => [
  { name: '当前教材', value: summary.value.textbooks || 0 },
  { name: '有可用题的教材', value: summary.value.textbooksWithQuestions || 0 },
  { name: '尚无可用题的教材', value: summary.value.textbooksWithoutQuestions || 0 },
  { name: '执行中任务', value: ['starting','running','cancelling'].reduce((n,s) => n + (summary.value.taskCounts?.[s] || 0), 0) },
])
async function loadControl(id) {
  try { const result = await request({url:'/bank/sync/control'}); if(id===requestId) control.value=result.data || result }
  catch(e) { if(id===requestId) control.value={collectorError:e?.message || '控制状态加载失败'} }
}
async function load() {
  const id = ++requestId; loading.value = true; error.value = ''; void loadControl(id)
  try { const result = await request({ url: '/bank/sync/overview', params: { subjectId: subjectId.value } }); if (id === requestId) summary.value = result.data || result }
  catch (e) { if (id === requestId) { summary.value = {}; error.value = e?.message || '总览加载失败' } }
  finally { if (id === requestId) loading.value = false }
}
function open(row) { router.push(row.taskModule === 'textbook' ? `/bank/sync-textbook/${row.taskId}` : row.taskModule === 'question' ? `/bank/sync-question/${row.taskId}` : '/bank/sync') }
onMounted(load)
</script>
<style scoped>
.heading { display:flex; align-items:center; gap:16px; margin-bottom:20px; } h2 { margin:0; font-size:20px; flex:1; }
.stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; }.stats strong { display:block; font-size:28px; margin-top:12px; }.note { color:var(--el-text-color-secondary); }.actions { margin:20px 0; }
@media (max-width:760px) { .stats { grid-template-columns:repeat(2,1fr); }.heading { flex-wrap:wrap; } }
</style>
