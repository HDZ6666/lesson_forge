<template>
  <div class="app-container">
    <div class="toolbar"><h2>自动同步计划</h2><SubjectSelect v-model="subjectId" @change="load"/><el-button :loading="loading" @click="load">刷新</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false"/>
    <el-alert v-if="control.automaticReason" :title="control.automaticReason" type="info" :closable="false"/>
    <el-alert v-if="control.source?.manualRequired" :title="control.source.reason || '来源需要人工处理'" type="warning" :closable="false"/>
    <el-button v-if="control.source?.manualRequired" v-hasPermi="['bank:sync:control']" :loading="saving" @click="resumeSource">已完成来源验证，恢复调度</el-button>
    <p v-if="control.collector?.sourceBudget">今日主动请求 {{ control.collector.sourceBudget.usage.requests }} · 启动教材 {{ control.collector.sourceBudget.usage.bookStarts }} · 采集占用 {{ Math.ceil(control.collector.sourceBudget.usage.activeMilliseconds/1000) }} 秒 · 素材响应体 {{ (control.collector.sourceBudget.usage.downloadBytes/1048576).toFixed(1) }} MiB</p>
    <p>每个任务只同步一本教材。先让本轮所有教材获得一次机会，再按完整程度安排补采或刷新；暂停计划后当前任务正常收尾。</p>
    <el-form inline>
      <el-form-item label="正常刷新（天）"><el-input-number v-model="form.refreshDays" :min="1" :max="365"/></el-form-item>
      <el-form-item label="部分成果补采（小时）"><el-input-number v-model="form.refillHours" :min="1" :max="720"/></el-form-item>
      <el-form-item label="刷新教材清单（天）"><el-input-number v-model="form.discoveryDays" :min="1" :max="365"/></el-form-item>
      <el-form-item label="自动计划"><el-switch v-model="form.enabled"/></el-form-item>
      <el-button v-hasPermi="['bank:sync:plans:edit']" type="primary" :loading="saving" @click="save">保存计划</el-button>
    </el-form>
    <p v-if="plan.planId">第 {{ plan.cycleNo }} 轮 · 固定目标 {{ plan.cycleTargetCount }} 本 · 当前教材 {{ books.length }} 本 · 本轮已完成 {{ completed }} 本 · 有可用题 {{ usable }} 本 · 人工单列 {{ exceptions }} 本</p>
    <el-alert v-if="plan.discoveryError" :title="`教材发现：${plan.discoveryError}`" type="warning" :closable="false"/>
    <el-table v-loading="loading" :data="books" row-key="textbookId">
      <el-table-column prop="textbookName" label="教材" min-width="170"/>
      <el-table-column label="版本" width="85"><template #default="{row}">{{ row.isNew ? '新版' : '旧版' }}</template></el-table-column>
      <el-table-column label="本轮" width="95"><template #default="{row}">{{ !row.inCurrentCycle ? '下轮纳入' : row.lastCycleNo >= plan.cycleNo ? '已尝试' : '待同步' }}</template></el-table-column>
      <el-table-column prop="usableQuestionCount" label="可用题数" width="100"/>
      <el-table-column label="下次到期" min-width="180"><template #default="{row}">{{ formatTime(row.nextDueAt) }}</template></el-table-column>
      <el-table-column label="调度" min-width="120"><template #default="{row}">{{ row.exceptionKind ? exceptionLabels[row.exceptionKind] : row.enabled ? '自动' : '暂停自动' }}</template></el-table-column>
      <el-table-column label="操作" min-width="240"><template #default="{row}">
        <el-button link type="primary" @click="openTask(row)">{{ row.lastTaskId ? '查看任务' : '立即同步' }}</el-button>
        <el-button v-hasPermi="['bank:sync:question:add']" link @click="sync(row)">同步一次</el-button>
        <el-button v-hasPermi="['bank:sync:plans:edit']" link @click="editBook(row)">调度设置</el-button>
      </template></el-table-column>
    </el-table>
    <el-dialog v-model="bookDialog" title="教材调度设置" width="460px">
      <el-form label-width="90px">
        <el-form-item label="自动同步"><el-switch v-model="bookForm.enabled"/></el-form-item>
        <el-form-item label="人工单列"><el-select v-model="bookForm.exceptionKind" clearable><el-option label="来源无题" value="no_questions"/><el-option label="长期不可访问" value="inaccessible"/></el-select></el-form-item>
        <el-form-item label="判断说明"><el-input v-model="bookForm.operatorNote" type="textarea" maxlength="500"/></el-form-item>
      </el-form>
      <p>人工单列保留在覆盖台账中，后续发现不会重新开启。手动同步一次仍可用于复核。</p>
      <template #footer><el-button @click="bookDialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveBook">保存</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import request from '@/utils/request'
import SubjectSelect from '../../components/SubjectSelect.vue'
const router = useRouter(), subjectId = ref(1), books = ref([]), plan = ref({}), control = ref({}), loading = ref(false), saving = ref(false), error = ref('')
const form = ref({enabled:false,refreshDays:7,refillHours:24,discoveryDays:7}), bookForm = ref({}), bookDialog = ref(false)
const exceptionLabels = {no_questions:'来源无题',inaccessible:'长期不可访问'}
const completed = computed(()=>books.value.filter(b=>b.inCurrentCycle && b.lastCycleNo >= plan.value.cycleNo).length)
const usable = computed(()=>books.value.filter(b=>b.usableQuestionCount > 0).length)
const exceptions = computed(()=>books.value.filter(b=>b.exceptionKind).length)
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
async function save(){saving.value=true;try{await request({url:'/bank/sync/plans',method:'put',data:{...form.value,subjectId:subjectId.value,expectedRevision:plan.value.revision || null}});await load()}catch(e){error.value=e.message}finally{saving.value=false}}
function editBook(row){bookForm.value={...row};bookDialog.value=true}
async function saveBook(){saving.value=true;try{const b=bookForm.value;await request({url:`/bank/sync/plans/${plan.value.planId}/books/${b.textbookId}`,method:'put',data:{enabled:b.enabled,exceptionKind:b.exceptionKind || null,operatorNote:b.operatorNote || null,expectedRevision:b.revision}});bookDialog.value=false;await load()}catch(e){error.value=e.message}finally{saving.value=false}}
async function sync(row){try{const task=data(await request({url:'/bank/sync/question/tasks',method:'post',data:{versionId:row.versionId,textbookId:row.textbookId}}));router.push(`/bank/sync-question/${task.taskId || task.runId}`)}catch(e){error.value=e.message}}
function openTask(row){if(row.lastTaskId)router.push(`/bank/sync-question/${row.lastTaskId}`);else sync(row)}
function formatTime(value){return value ? new Date(value).toLocaleString() : '首次覆盖待办'}
onMounted(load)
</script>
<style scoped>.toolbar{display:flex;align-items:center;gap:16px;margin-bottom:16px}.toolbar h2{flex:1}p{color:var(--el-text-color-secondary)}</style>
