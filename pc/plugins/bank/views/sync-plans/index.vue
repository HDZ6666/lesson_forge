<template>
  <div class="app-container sync-center-page">
    <header class="page-heading"><div><h2>自动同步计划</h2><p>按学科设置更新频率，让每本教材轮流同步。遇到问题会保留成果，再安排补齐。</p></div><div class="heading-actions"><SubjectSelect v-model="subjectId" :clearable="false" @change="load"/><el-button :loading="loading" @click="load">刷新</el-button></div></header>
    <SyncCenterNav active="plans"/>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon/>
    <el-alert v-if="control.automaticReason" :title="control.automaticReason" type="info" :closable="false" show-icon/>
    <el-alert v-if="control.source?.manualRequired" :title="control.source.reason || '来源需要人工处理'" type="warning" :closable="false" show-icon><el-button v-hasPermi="['bank:sync:control']" :loading="saving" @click="resumeSource">已完成来源验证，恢复调度</el-button></el-alert>
    <section class="sync-panel" v-loading="loading">
      <div class="section-heading"><div><h3>{{ plan.planId ? '更新安排' : '创建本学科的计划' }}</h3><p>先覆盖全部教材，再周期更新；新版优先，旧版也会保留。</p></div><el-tag :type="plan.enabled ? 'success' : 'info'">{{ plan.enabled ? '计划已启用' : '计划未启用' }}</el-tag></div>
      <el-form label-position="top" @submit.prevent="save">
        <div class="plan-fields">
          <el-form-item label="正常刷新间隔"><div><el-input-number v-model="form.refreshDays" :min="1" :max="365" controls-position="right"/><span class="unit">天</span><p class="field-hint">本次完整入库后，再次检查新题的间隔。</p></div></el-form-item>
          <el-form-item label="未完成教材的补采间隔"><div><el-input-number v-model="form.refillHours" :min="1" :max="720" controls-position="right"/><span class="unit">小时</span><p class="field-hint">已有成果保留，下次继续补齐缺少的题目。</p></div></el-form-item>
          <el-form-item label="教材清单更新间隔"><div><el-input-number v-model="form.discoveryDays" :min="1" :max="365" controls-position="right"/><span class="unit">天</span><p class="field-hint">发现新版本、新教材，自动加入后续循环。</p></div></el-form-item>
        </div>
        <div class="plan-save"><div><el-switch v-model="form.enabled" active-text="启用自动计划"/><p class="field-hint">关闭后停止安排新任务，当前任务正常收尾。修改后需保存。</p></div><el-button v-hasPermi="['bank:sync:plans:edit']" type="primary" :loading="saving" :disabled="loading || !!error || !subjectId" @click="save">保存计划</el-button></div>
      </el-form>
    </section>
    <div v-if="plan.planId" class="sync-stat-grid">
      <div class="sync-stat"><span>第 {{ plan.cycleNo }} 轮固定目标</span><strong>{{ plan.cycleTargetCount || 0 }} <small>本</small></strong><small>新发现教材下轮纳入</small></div>
      <div class="sync-stat"><span>本轮已尝试</span><strong>{{ completed }} <small>本</small></strong><small>不代表所有题目已采全</small></div>
      <div class="sync-stat accent"><span>有可用题的教材</span><strong>{{ usable }} <small>本</small></strong><small>当前共 {{ books.length }} 本教材</small></div>
      <div class="sync-stat"><span>人工单列</span><strong>{{ exceptions }} <small>本</small></strong><small>保留记录，不再自动安排</small></div>
    </div>
    <section class="sync-panel">
      <div class="section-heading"><div><h3>教材调度</h3><p>可单独暂停一本教材，也可手动同步一次。</p></div><div class="book-filters"><el-input v-model="bookSearch" clearable placeholder="搜索教材名称" aria-label="搜索教材名称"/><el-select v-model="bookStatus" clearable placeholder="全部教材" aria-label="教材调度状态"><el-option label="本轮待同步" value="waiting"/><el-option label="尚无可用题" value="empty"/><el-option label="暂停或人工单列" value="paused"/></el-select></div></div>
      <el-alert v-if="plan.discoveryError" :title="`教材发现：${plan.discoveryError}`" type="warning" :closable="false"/>
      <el-table v-loading="loading" :data="filteredBooks" row-key="textbookId">
        <el-table-column label="教材" min-width="190"><template #default="{row}"><span class="cell-main">{{ row.textbookName }}</span><span class="cell-sub">{{ row.isNew ? '新版教材' : '旧版教材' }}</span></template></el-table-column>
        <el-table-column label="本轮进度" width="105"><template #default="{row}"><el-tag :type="!row.inCurrentCycle ? 'info' : row.lastCycleNo >= plan.cycleNo ? 'success' : 'warning'" effect="plain">{{ !row.inCurrentCycle ? '下轮纳入' : row.lastCycleNo >= plan.cycleNo ? '已尝试' : '待同步' }}</el-tag></template></el-table-column>
        <el-table-column prop="usableQuestionCount" label="可用题数" width="100" align="right"/>
        <el-table-column label="调度安排" min-width="185"><template #default="{row}"><span>{{ row.exceptionKind ? exceptionLabels[row.exceptionKind] : row.enabled ? '自动同步' : '暂停自动' }}</span><span class="cell-sub">{{ row.enabled && !row.exceptionKind ? formatTime(row.nextDueAt) : row.operatorNote || '可手动同步复核' }}</span></template></el-table-column>
        <el-table-column label="操作" width="240" fixed="right"><template #default="{row}"><el-button v-if="row.lastTaskId" link type="primary" @click="openTask(row)">查看任务</el-button><el-button v-hasPermi="['bank:sync:question:add']" link type="primary" :loading="syncingId===row.textbookId" :disabled="syncingId!==null" @click="sync(row)">同步一次</el-button><el-button v-hasPermi="['bank:sync:plans:edit']" link @click="editBook(row)">设置</el-button></template></el-table-column>
        <template #empty><el-empty :image-size="64" :description="books.length ? '没有符合筛选条件的教材' : plan.planId ? '该学科尚未发现教材' : '保存计划后，在这里管理教材调度'"><el-button v-if="plan.planId && !books.length" type="primary" plain @click="router.push('/sync-center/discovery')">去发现教材</el-button></el-empty></template>
      </el-table>
      <footer class="table-footer">显示 {{ filteredBooks.length }} / {{ books.length }} 本教材</footer>
    </section>
    <el-dialog v-model="bookDialog" class="sync-center-dialog" :title="`调度设置 · ${bookForm.textbookName || ''}`" width="500px">
      <el-form label-width="90px"><el-form-item label="自动同步"><el-switch v-model="bookForm.enabled"/></el-form-item><el-form-item label="人工单列"><el-select v-model="bookForm.exceptionKind" clearable placeholder="正常参与调度"><el-option label="来源无题" value="no_questions"/><el-option label="长期不可访问" value="inaccessible"/></el-select></el-form-item><el-form-item label="判断说明"><el-input v-model="bookForm.operatorNote" type="textarea" :rows="3" maxlength="500" show-word-limit/></el-form-item></el-form>
      <p class="field-hint">人工单列后保留覆盖记录，后续发现不会重新开启。仍可手动同步复核。</p>
      <template #footer><el-button @click="bookDialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveBook">保存</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import SyncCenterNav from '../../components/SyncCenterNav.vue'
import '../../styles/sync-center.scss'
import { useRouter } from 'vue-router'
import request from '@/utils/request'
import SubjectSelect from '../../components/SubjectSelect.vue'
const router = useRouter(), subjectId = ref(1), books = ref([]), plan = ref({}), control = ref({}), loading = ref(false), saving = ref(false), error = ref('')
const form = ref({enabled:false,refreshDays:7,refillHours:24,discoveryDays:7}), bookForm = ref({}), bookDialog = ref(false)
const exceptionLabels = {no_questions:'来源无题',inaccessible:'长期不可访问'}
const completed = computed(()=>books.value.filter(b=>b.inCurrentCycle && b.lastCycleNo >= plan.value.cycleNo).length)
const usable = computed(()=>books.value.filter(b=>b.usableQuestionCount > 0).length)
const exceptions = computed(()=>books.value.filter(b=>b.exceptionKind).length)
const bookSearch = ref(''), bookStatus = ref(''), syncingId = ref(null)
const filteredBooks = computed(() => books.value.filter(b => (!bookSearch.value || b.textbookName?.includes(bookSearch.value.trim())) && (!bookStatus.value || (bookStatus.value === 'waiting' ? b.inCurrentCycle && b.lastCycleNo < plan.value.cycleNo : bookStatus.value === 'empty' ? !b.usableQuestionCount : b.exceptionKind || !b.enabled))))
let epoch=0
const data = r=>r.data || r
async function load() {
  const id=++epoch; loading.value=true;error.value=''
  try {
    const [p,c]=await Promise.all([request({url:'/bank/sync/plans',params:{subjectId:subjectId.value}}),request({url:'/bank/sync/control'})])
    const current=data(p)[0] || {}, b=current.planId ? data(await request({url:`/bank/sync/plans/${current.planId}/books`})) : []
    if(id!==epoch)return
    plan.value=current;books.value=b;control.value=data(c)
    form.value={enabled:current.enabled || false,refreshDays:current.refreshDays || 7,refillHours:current.refillHours || 24,discoveryDays:current.discoveryDays || 7}
  } catch(e){if(id===epoch)error.value=e.message || '计划读取失败'} finally{if(id===epoch)loading.value=false}
}
async function resumeSource(){saving.value=true;try{await request({url:'/bank/sync/control/source/resume',method:'post',data:{expectedRevision:control.value.source.revision}});await load()}catch(e){error.value=e.message}finally{saving.value=false}}
async function save(){saving.value=true;try{await request({url:'/bank/sync/plans',method:'put',data:{...form.value,subjectId:subjectId.value,expectedRevision:plan.value.revision || null}});ElMessage.success('自动计划已保存');await load()}catch(e){error.value=e.message}finally{saving.value=false}}
function editBook(row){bookForm.value={...row};bookDialog.value=true}
async function saveBook(){saving.value=true;try{const b=bookForm.value;await request({url:`/bank/sync/plans/${plan.value.planId}/books/${b.textbookId}`,method:'put',data:{enabled:b.enabled,exceptionKind:b.exceptionKind || null,operatorNote:b.operatorNote || null,expectedRevision:b.revision}});bookDialog.value=false;await load()}catch(e){error.value=e.message}finally{saving.value=false}}
async function sync(row){syncingId.value=row.textbookId;try{const task=data(await request({url:'/bank/sync/question/tasks',method:'post',data:{versionId:row.versionId,textbookId:row.textbookId}}));router.push(`/bank/sync-question/${task.taskId || task.runId}`)}catch(e){error.value=e.message}finally{syncingId.value=null}}
function openTask(row){router.push(`/bank/sync-question/${row.lastTaskId}`)}
function formatTime(value){return value ? new Date(value).toLocaleString() : '首次覆盖待办'}
onMounted(load)
</script>
<style scoped>
.plan-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}.unit{margin-left:10px;color:var(--el-text-color-secondary);font-size:13px}.field-hint{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7;margin:8px 0 0}.plan-save{display:flex;align-items:center;justify-content:space-between;gap:16px;border-top:1px solid var(--el-border-color-lighter);padding-top:16px}.book-filters{display:flex;gap:10px}.book-filters .el-input{width:200px}.book-filters .el-select{width:170px}@media(max-width:1100px){.plan-fields{grid-template-columns:1fr;gap:0}.book-filters{flex-wrap:wrap}}@media(max-width:600px){.book-filters{width:100%}.book-filters .el-input,.book-filters .el-select{width:100%}.plan-save{align-items:flex-start;flex-direction:column}}
</style>
