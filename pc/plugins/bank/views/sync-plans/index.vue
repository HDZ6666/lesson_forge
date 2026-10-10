<template>
  <div class="app-container sync-center-page">
    <header class="page-heading"><div><h2>学科同步计划</h2><p>创建一次，自动发现教材、逐本排队采集，再核验并分批入库。</p></div><div class="heading-actions"><SubjectSelect v-model="subjectId" :clearable="false" @change="load"/><el-button :loading="loading" @click="load">刷新</el-button></div></header>
    <SyncCenterNav active="plans" :subject-id="subjectId"/>
    <SyncWorkflow v-if="!plan.planId && !loading"/>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon/>
    <el-alert v-if="control.automaticReason" :title="control.automaticReason" type="info" :closable="false" show-icon/>
    <el-alert v-if="control.source?.manualRequired" :title="control.source.reason || '来源需要人工处理'" type="warning" :closable="false" show-icon><el-button v-hasPermi="['bank:sync:control']" :loading="saving" @click="resumeSource">已完成来源验证，恢复调度</el-button></el-alert>
    <section v-if="plan.planId" class="sync-panel plan-progress">
      <div class="section-heading"><div><h3>{{ plan.cycleName || plan.planName }}</h3><p>{{ phase }}</p><p>{{ control.paused ? control.reason || '同步已暂停' : plan.discoveryQueueReason || control.automaticReason || '后台执行，关闭页面也会继续。' }}</p></div><el-button v-if="plan.lastDiscoveryTaskId" link type="primary" @click="router.push(`/bank/sync-textbook/${plan.lastDiscoveryTaskId}`)">查看教材发现 #{{ plan.lastDiscoveryTaskId }}</el-button></div>
      <el-button v-if="plan.cycleNo" type="primary" @click="router.push({path:'/sync-center/tasks',query:{planId:plan.planId,cycleNo:plan.cycleNo,subjectId}})">查看本轮全部教材任务</el-button>
      <p class="field-hint">队列由计划自动生成，无需逐本创建任务。各教材的核验、入库进度在下方分别展示。</p>
      <el-progress :percentage="progress.total ? Math.round(progress.finished / progress.total * 100) : 0"/>
      <p class="field-hint">第 {{ plan.cycleNo || 1 }} 轮 · 已处理 {{ progress.finished }} / {{ progress.total }} 本。部分完成会保留合格成果，后续再补齐。</p>
      <el-alert v-if="plan.discoveryError" :title="`教材发现：${plan.discoveryError}`" type="warning" :closable="false" show-icon><p>已有成果保留，下一次重试：{{ formatTime(plan.discoveryNextAt) }}</p><el-button v-hasPermi="['bank:sync:plans:edit']" :loading="saving" @click="retryDiscovery">重试教材发现</el-button></el-alert>
    </section>
    <div v-if="plan.planId" class="sync-stat-grid">
      <div class="sync-stat"><span>本轮教材</span><strong>{{ progress.total }} <small>本</small></strong><small>{{ progress.queued }} 本排队 · {{ progress.collecting }} 本采集中</small></div>
      <div class="sync-stat accent"><span>完整完成</span><strong>{{ progress.completed }} <small>本</small></strong><small>{{ progress.partial }} 本部分完成</small></div>
      <div class="sync-stat"><span>核验与入库</span><strong>{{ progress.checking + progress.importing }} <small>本</small></strong><small>无需人工逐题审批</small></div>
      <div class="sync-stat"><span>需要处理</span><strong>{{ progress.failed }} <small>本</small></strong><small>{{ progress.cancelled }} 本已停止 · {{ progress.excluded }} 本排除</small></div>
    </div>
    <details class="sync-panel plan-settings-panel" :open="!plan.planId" v-loading="loading">
      <summary>{{ plan.planId ? '计划设置 · 名称、频率与启停' : '创建学科同步计划' }}</summary>
      <div class="section-heading"><div><h3>{{ plan.planId ? '同步安排' : '创建本学科的计划' }}</h3><p>先覆盖全部教材，再定期更新。新版优先，旧版保留；无需分别创建发现、采集和入库任务。</p></div><el-tag :type="plan.enabled ? 'success' : 'info'">{{ plan.enabled ? '计划已启用' : '计划未启用' }}</el-tag></div>
      <el-form label-position="top" @submit.prevent="save">
        <el-form-item label="计划名称"><el-input v-model="form.planName" maxlength="100" placeholder="例如：初中数学全教材同步；留空使用学科名称"/></el-form-item>
        <el-form-item label="题目分页并发"><div><el-select v-model="form.listConcurrency" style="width:200px"><el-option v-for="n in [1,2,4,8]" :key="n" :value="n" :label="`${n} 页并发`"/></el-select><p class="field-hint">一本教材内同时请求的页数，每页通常 10 道题。仅影响之后创建的任务；已有待办可在任务中单独修改，各教材仍逐本排队。</p></div></el-form-item>
        <details class="plan-settings"><summary>更新频率设置（默认每 7 天更新，未完成教材 24 小时后补采）</summary><div class="plan-fields">
          <el-form-item label="正常刷新间隔"><div><el-input-number v-model="form.refreshDays" :min="1" :max="365" controls-position="right"/><span class="unit">天</span><p class="field-hint">本次完整入库后，再次检查新题的间隔。</p></div></el-form-item>
          <el-form-item label="未完成教材的补采间隔"><div><el-input-number v-model="form.refillHours" :min="1" :max="720" controls-position="right"/><span class="unit">小时</span><p class="field-hint">已有成果保留，下轮重新扫描并合并新增、变化的题目。</p></div></el-form-item>
          <el-form-item label="教材清单更新间隔"><div><el-input-number v-model="form.discoveryDays" :min="1" :max="365" controls-position="right"/><span class="unit">天</span><p class="field-hint">发现新版本、新教材，自动加入后续循环。</p></div></el-form-item>
        </div></details>
        <div class="plan-save"><div><el-switch v-model="form.enabled" active-text="启用自动计划"/><p class="field-hint">关闭后保留待办，当前任务正常收尾。修改后需保存。</p></div><el-button v-hasPermi="['bank:sync:plans:edit']" type="primary" :loading="saving" :disabled="loading || !!error || !subjectId" @click="save">{{ plan.planId ? '保存计划' : form.enabled ? '创建并开始同步' : '保存为暂停计划' }}</el-button></div>
      </el-form>
    </details>
    <section class="sync-panel">
      <div class="section-heading"><div><h3>本轮教材与后续安排</h3><p>查看正在处理和需要关注的教材，也可单独重跑或调整安排。</p></div><div class="book-filters"><el-input v-model="bookSearch" clearable placeholder="搜索版本或教材" aria-label="搜索版本或教材"/><el-select v-model="bookStatus" clearable placeholder="全部教材" aria-label="教材调度状态"><el-option label="正在采集或入库" value="active"/><el-option label="需要处理" value="issues"/><el-option label="本轮待同步" value="waiting"/><el-option label="尚无可用题" value="empty"/><el-option label="暂停或人工单列" value="paused"/></el-select></div></div>

      <el-table v-loading="loading" :data="filteredBooks" row-key="textbookId">
        <el-table-column label="教材" min-width="190"><template #default="{row}"><span class="cell-main">{{ row.textbookName }}</span><span class="cell-sub">{{ row.versionName || '—' }} · {{ row.isNew ? '新版教材' : '旧版教材' }}</span></template></el-table-column>
        <el-table-column label="本轮进度" min-width="160"><template #default="{row}"><el-tag :type="planBookStage(row).type" effect="plain">{{ planBookStage(row).label }}</el-tag><span v-if="row.taskInCurrentCycle && row.taskReason" class="cell-sub">{{ row.taskReason }}</span></template></el-table-column>
        <el-table-column prop="usableQuestionCount" label="可用题数" width="100" align="right"/>
        <el-table-column label="调度安排" min-width="185"><template #default="{row}"><span>{{ row.exceptionKind ? exceptionLabels[row.exceptionKind] : row.enabled ? '自动同步' : '暂停自动' }}</span><span class="cell-sub">{{ row.enabled && !row.exceptionKind ? formatTime(row.nextDueAt) : row.operatorNote || '可手动同步复核' }}</span></template></el-table-column>
        <el-table-column label="操作" width="240" fixed="right"><template #default="{row}"><el-button v-if="row.lastTaskId" link type="primary" @click="openTask(row)">查看任务</el-button><el-button v-hasPermi="['bank:sync:question:add']" link type="primary" :loading="syncingId===row.textbookId" :disabled="syncingId!==null" @click="sync(row)">同步一次</el-button><el-button v-hasPermi="['bank:sync:plans:edit']" link @click="editBook(row)">设置</el-button></template></el-table-column>
        <template #empty><el-empty :image-size="64" :description="books.length ? '没有符合筛选条件的教材' : plan.planId ? '计划会自动发现教材，登记后在这里生成逐本队列' : '创建计划后自动发现教材并开始同步'"></el-empty></template>
      </el-table>
      <footer class="table-footer">显示 {{ filteredBooks.length }} / {{ books.length }} 本教材</footer>
    </section>
    <el-dialog v-model="bookDialog" class="sync-center-dialog" :title="`调度设置 · ${[bookForm.versionName, bookForm.textbookName].filter(Boolean).join(' · ')}`" width="500px">
      <el-form label-width="90px"><el-form-item label="自动同步"><el-switch v-model="bookForm.enabled"/></el-form-item><el-form-item label="人工单列"><el-select v-model="bookForm.exceptionKind" clearable placeholder="正常参与调度"><el-option label="来源无题" value="no_questions"/><el-option label="长期不可访问" value="inaccessible"/></el-select></el-form-item><el-form-item label="判断说明"><el-input v-model="bookForm.operatorNote" type="textarea" :rows="3" maxlength="500" show-word-limit/></el-form-item></el-form>
      <p class="field-hint">人工单列后保留覆盖记录，后续发现不会重新开启。仍可手动同步复核。</p>
      <template #footer><el-button @click="bookDialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveBook">保存</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { planBookStage, planProgress, planPhase } from '../../utils/sync-plan.js'
import { ElMessage } from 'element-plus'
import SyncWorkflow from '../../components/SyncWorkflow.vue'
import SyncCenterNav from '../../components/SyncCenterNav.vue'
import '../../styles/sync-center.scss'
import { useRoute, useRouter } from 'vue-router'
import request from '@/utils/request'
import SubjectSelect from '../../components/SubjectSelect.vue'
const route = useRoute()
const router = useRouter(), subjectId = ref(Number(route.query.subjectId) || 1), books = ref([]), plan = ref({}), control = ref({}), loading = ref(false), saving = ref(false), error = ref('')
const form = ref({listConcurrency:1,planName:'',enabled:true,refreshDays:7,refillHours:24,discoveryDays:7}), bookForm = ref({}), bookDialog = ref(false)
const exceptionLabels = {no_questions:'来源无题',inaccessible:'长期不可访问'}
const progress = computed(() => planProgress(books.value))
const phase = computed(() => planPhase(plan.value, progress.value))
const bookSearch = ref(''), bookStatus = ref(''), syncingId = ref(null)
const filteredBooks = computed(() => books.value.filter(b => (!bookSearch.value || [b.versionName, b.textbookName].filter(Boolean).join(' ').includes(bookSearch.value.trim())) && (!bookStatus.value || (bookStatus.value === 'active' ? ['collecting','checking','importing'].includes(planBookStage(b).key) : bookStatus.value === 'issues' ? ['failed','partial'].includes(planBookStage(b).key) : bookStatus.value === 'waiting' ? planBookStage(b).key === 'queued' : bookStatus.value === 'empty' ? !b.usableQuestionCount : b.exceptionKind || !b.enabled))))
let epoch=0, pollTimer, polling=false
const data = r=>r.data || r
async function load(silent=false) {
  silent = silent === true
  if (silent && (polling || saving.value || loading.value)) return
  if (silent) polling=true
  const id=++epoch; if(!silent) loading.value=true;error.value=''
  try {
    const [p,c]=await Promise.all([request({url:'/bank/sync/plans',params:{subjectId:subjectId.value}}),request({url:'/bank/sync/control'})])
    const current=data(p)[0] || {}, b=current.planId ? data(await request({url:`/bank/sync/plans/${current.planId}/books`})) : []
    if(id!==epoch)return
    plan.value=current;books.value=b;control.value=data(c)
    if (!silent) form.value={listConcurrency:current.listConcurrency || 1,planName:current.planName || '',enabled:current.planId ? current.enabled : true,refreshDays:current.refreshDays || 7,refillHours:current.refillHours || 24,discoveryDays:current.discoveryDays || 7}
  } catch(e){if(id===epoch)error.value=e.message || '计划读取失败'} finally{if(id===epoch)loading.value=false;if(silent)polling=false}
}
async function resumeSource(){saving.value=true;try{await request({url:'/bank/sync/control/source/resume',method:'post',data:{expectedRevision:control.value.source.revision}});await load()}catch(e){error.value=e.message}finally{saving.value=false}}
async function retryDiscovery(){saving.value=true;try{await request({url:`/bank/sync/plans/${plan.value.planId}/discovery/retry`,method:'post',data:{expectedRevision:plan.value.revision}});await load()}catch(e){error.value=e.message}finally{saving.value=false}}
async function save(){saving.value=true;try{await request({url:'/bank/sync/plans',method:'put',data:{...form.value,planName:form.value.planName.trim() || undefined,subjectId:subjectId.value,expectedRevision:plan.value.revision || null}});ElMessage.success('学科同步计划已保存');await load()}catch(e){error.value=e.message}finally{saving.value=false}}
function editBook(row){bookForm.value={...row};bookDialog.value=true}
async function saveBook(){saving.value=true;try{const b=bookForm.value;await request({url:`/bank/sync/plans/${plan.value.planId}/books/${b.textbookId}`,method:'put',data:{enabled:b.enabled,exceptionKind:b.exceptionKind || null,operatorNote:b.operatorNote || null,expectedRevision:b.revision}});bookDialog.value=false;await load()}catch(e){error.value=e.message}finally{saving.value=false}}
async function sync(row){syncingId.value=row.textbookId;try{const task=data(await request({url:'/bank/sync/question/tasks',method:'post',data:{versionId:row.versionId,textbookId:row.textbookId}}));router.push(`/bank/sync-question/${task.taskId || task.runId}`)}catch(e){error.value=e.message}finally{syncingId.value=null}}
function openTask(row){router.push(`/bank/sync-question/${row.lastTaskId}`)}
function formatTime(value){return value ? new Date(value).toLocaleString() : '首次覆盖待办'}
onMounted(() => { load(); pollTimer=setInterval(() => load(true), 5000) })
onBeforeUnmount(() => { ++epoch; clearInterval(pollTimer) })
</script>
<style scoped>
.plan-settings-panel>summary{cursor:pointer;font-size:15px;font-weight:600;line-height:1.6}.plan-settings-panel[open]>summary{margin-bottom:22px}.plan-settings-panel>summary:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:4px}.plan-settings{margin-bottom:18px}.plan-settings summary{cursor:pointer;color:var(--el-text-color-secondary);margin-bottom:18px}.flow-line{color:var(--el-color-primary);line-height:1.8;margin-bottom:20px}.plan-progress .el-alert{margin-top:16px}.plan-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}.unit{margin-left:10px;color:var(--el-text-color-secondary);font-size:13px}.field-hint{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7;margin:8px 0 0}.plan-save{display:flex;align-items:center;justify-content:space-between;gap:16px;border-top:1px solid var(--el-border-color-lighter);padding-top:16px}.book-filters{display:flex;gap:10px}.book-filters .el-input{width:200px}.book-filters .el-select{width:170px}@media(max-width:1100px){.plan-fields{grid-template-columns:1fr;gap:0}.book-filters{flex-wrap:wrap}}@media(max-width:600px){.book-filters{width:100%}.book-filters .el-input,.book-filters .el-select{width:100%}.plan-save{align-items:flex-start;flex-direction:column}}
</style>
