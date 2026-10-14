<template>
  <div class="app-container sync-center-page">
    <header class="page-heading"><div><h2>{{ plan.planName || '学科同步计划' }}</h2><p>一份教材清单，按保存的顺序逐本采集；每轮结束后再安排下一轮。</p></div><div class="heading-actions"><SubjectSelect v-model="subjectId" :clearable="false" @change="load"/><el-button :loading="loading" @click="load">刷新</el-button></div></header>
    <SyncCenterNav active="plans" :subject-id="subjectId"/>
    <SyncWorkflow v-if="showCreate"/>
    <section v-if="loading && !plan.planId" class="sync-panel" role="status" aria-busy="true"><p>正在加载学科计划…</p><el-skeleton :rows="5" animated/></section>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon/>
    <el-alert v-if="control.automaticReason && !control.source?.manualRequired" :title="control.automaticReason" type="info" :closable="false" show-icon/>
    <el-alert v-if="control.resourceWait?.active" :title="`等待资源恢复：${control.resourceWait.reason}`" type="warning" :closable="false" show-icon><p>开始于 {{ formatTime(control.resourceWait.since) }}，下次检查 {{ formatTime(control.resourceWait.nextCheckAt) }}。已保存成果保留，不会重新采集；恢复后从原阶段继续。</p></el-alert>
    <ManualRecovery v-if="control.source?.manualRequired" :subject-id="Number(subjectId)" :reason="control.source.reason" @updated="load"/>
    <section v-if="plan.planId" class="sync-panel">
      <div class="section-heading"><div><h3>{{ plan.cycleName || '准备首次同步' }}</h3><p v-if="plan.sessionNo">第 {{ plan.sessionNo }} 次同步 · 第 {{ plan.sessionRound || 1 }} 轮<template v-if="plan.maxRounds"> / 最多 {{ plan.maxRounds }} 轮</template><template v-if="plan.sessionEndReason"> · {{ endReasonLabel(plan.sessionEndReason) }}</template></p><p>{{ phase }}</p><p v-if="plan.nextCycleAt">下一轮：{{ formatTime(plan.nextCycleAt) }}</p><p v-else-if="!plan.autoUpdate">自动更新已关闭，本轮结束后不再自动创建下一轮。</p></div><el-tag :type="plan.enabled ? 'success' : 'warning'">{{ controlLabel }}</el-tag></div>
      <div class="plan-actions">
        <el-button v-if="plan.controlState==='paused'" v-hasPermi="['bank:sync:plans:edit']" type="primary" :loading="saving" @click="act('resume')">继续整个计划</el-button>
        <el-button v-else-if="['pausing','ending'].includes(plan.controlState)" disabled>{{ plan.controlState==='ending' ? '正在结束本轮' : '正在暂停' }}</el-button>
        <el-button v-else v-hasPermi="['bank:sync:plans:edit']" type="warning" :loading="saving" @click="pause">暂停整个计划</el-button>
        <el-button v-if="plan.enabled && plan.controlState==='active' && ['completed','stopped'].includes(plan.cycleState)" v-hasPermi="['bank:sync:plans:edit']" type="primary" :loading="saving" @click="act('start')">提前同步一次</el-button><el-button v-if="plan.enabled && plan.controlState==='active' && ['completed','stopped'].includes(plan.cycleState)" v-hasPermi="['bank:sync:plans:edit']" :loading="saving" @click="startFull">全量扫描一次</el-button>
        <el-button v-if="['discovering','running'].includes(plan.cycleState) && !['pausing','ending'].includes(plan.controlState)" v-hasPermi="['bank:sync:plans:edit']" @click="endVisible=true;keepUpdates=plan.autoUpdate">结束本次同步</el-button>
        <el-button @click="settingsVisible=true">计划设置</el-button><el-button @click="showHistory">执行历史</el-button>
        <el-button v-if="plan.cycleNo" @click="openCycle(plan.cycleNo)">本轮全部任务</el-button>
        <el-button v-if="plan.lastDiscoveryTaskId" link type="primary" @click="router.push(`/bank/sync-textbook/${plan.lastDiscoveryTaskId}`)">教材发现 #{{ plan.lastDiscoveryTaskId }}</el-button>
      </div>
      <el-progress :percentage="progress.total ? Math.round(progress.finished/progress.total*100) : 0"/>
      <p class="field-hint">本轮 {{ progress.total }} 本 · 已处理 {{ progress.finished }} 本。暂停保留所有成果；继续后先处理暂停时的教材，再恢复队列。</p>
      <el-alert v-if="plan.discoveryError" :title="`教材发现：${plan.discoveryError}`" type="warning" :closable="false"><p>尚未登记完整教材清单，后续题目任务未启动。</p><el-button v-hasPermi="['bank:sync:plans:edit']" :loading="saving" @click="retryDiscovery">重试教材发现</el-button></el-alert>
    </section>
    <div v-if="plan.planId" class="sync-stat-grid">
      <div class="sync-stat"><span>待执行</span><strong>{{ progress.queued }}</strong><small>{{ progress.paused || 0 }} 本暂停</small></div>
      <div class="sync-stat accent"><span>完整完成</span><strong>{{ progress.completed }}</strong><small>{{ progress.partial }} 本部分完成</small></div>
      <div class="sync-stat"><span>正在处理</span><strong>{{ progress.collecting + progress.checking + progress.importing }}</strong><small>采集、核验及入库</small></div>
      <div class="sync-stat"><span>需要关注</span><strong>{{ progress.failed }}</strong><small>{{ progress.cancelled }} 本停止 · {{ progress.excluded }} 本排除</small></div>
    </div>
    <section v-if="plan.planId && queue" class="sync-panel">
      <div class="section-heading"><div><h3>当前队列</h3><p>按后端实际派发顺序显示。“置顶”只让该教材在当前任务结束后优先执行，不改变计划顺序，也不中断当前任务。</p></div></div>
      <div class="queue-now"><div><span class="cell-sub">当前任务</span><strong>{{ queue.current ? queue.current.textbookName : '无' }}</strong><span v-if="queue.current" class="cell-sub">{{ queue.current.syncMode==='full' ? '全量窗口扫描' : '增量' }}</span></div><div><span class="cell-sub">下一任务</span><strong>{{ queue.next ? queue.next.textbookName : '无' }}</strong><span v-if="queue.next?.waitReason" class="cell-sub">{{ queue.next.waitReason }}</span></div><div><span class="cell-sub">待执行</span><strong>{{ queue.queue.length }} 本</strong></div></div>
      <el-table v-if="queue.queue.length" max-height="min(320px, 40vh)" scrollbar-always-on :data="queue.queue.slice(0,50)" row-key="taskId">
        <el-table-column type="index" label="次序" width="65"/>
        <el-table-column label="教材" min-width="200"><template #default="{row}">{{ row.textbookName }}<el-tag v-if="row.pinned" size="small" type="warning" style="margin-left:6px">已置顶</el-tag></template></el-table-column>
        <el-table-column label="等待原因" min-width="180"><template #default="{row}">{{ row.waitReason || '—' }}</template></el-table-column>
        <el-table-column label="操作" width="120"><template #default="{row,$index}"><el-button v-if="$index>0" v-hasPermi="['bank:sync:plans:edit']" link type="primary" :disabled="saving" @click="pin(row.textbookId)">置顶</el-button></template></el-table-column>
      </el-table>
    </section>
    <section v-if="showCreate" class="sync-panel"><h3>创建本学科的计划</h3><PlanSettingsFields v-model="form"/><el-button v-hasPermi="['bank:sync:plans:edit']" type="primary" :loading="saving" :disabled="loading || !!error" @click="save">创建并开始同步</el-button></section>
    <section v-if="plan.planId" class="sync-panel">
      <div class="section-heading"><div><h3>教材清单与执行顺序</h3><p>排序影响本轮未开始的任务和以后各轮；“提前执行”只调整这一次。</p></div><el-button v-hasPermi="['bank:sync:plans:edit']" :disabled="loading || saving" @click="openOrder">调整顺序</el-button></div>
      <div class="book-filters"><el-input v-model="bookSearch" clearable placeholder="搜索版本或教材" aria-label="搜索版本或教材"/><el-select v-model="bookStatus" clearable placeholder="全部教材" aria-label="教材调度状态"><el-option label="正在处理" value="active"/><el-option label="需要处理" value="issues"/><el-option label="本轮待执行" value="waiting"/><el-option label="暂停或人工单列" value="paused"/></el-select></div>
      <el-table max-height="min(560px, 60vh)" scrollbar-always-on v-loading="loading" :data="filteredBooks" row-key="textbookId">
        <el-table-column prop="order" label="顺序" width="65"/>
        <el-table-column label="教材" min-width="190"><template #default="{row}"><span class="cell-main">{{ row.textbookName }}</span><span class="cell-sub">{{ row.versionName }} · {{ row.isNew ? '新版' : '旧版' }}</span></template></el-table-column>
        <el-table-column label="本轮状态" min-width="150"><template #default="{row}"><el-tag :type="planBookStage(row).type">{{ planBookStage(row).label }}</el-tag><span v-if="row.taskInCurrentCycle && row.taskReason" class="cell-sub">{{ row.taskReason }}</span><el-button v-if="row.manualTaskId" link type="primary" @click="router.push(`/bank/sync-question/${row.manualTaskId}`)">单本任务 #{{row.manualTaskId}}</el-button></template></el-table-column>
        <el-table-column prop="usableQuestionCount" label="可用题" width="90"/>
        <el-table-column label="最近处理" min-width="165"><template #default="{row}">{{ row.lastFinishedAt ? formatTime(row.lastFinishedAt) : '尚未完成' }}</template></el-table-column>
        <el-table-column label="执行记录" min-width="150"><template #default="{row}"><span v-if="row.executionCount != null" class="cell-main">已执行 {{ row.executionCount }} 次</span><span v-if="row.sessionRounds?.length" class="cell-sub">本次同步参与 {{ row.sessionRounds.length }} 轮（第 {{ row.sessionRounds.join('、') }} 轮）</span><TaskExecutionHistory v-if="row.lastTaskId" :task="{taskId:row.lastTaskId,logicalTaskId:row.logicalTaskId}"/></template></el-table-column>
        <el-table-column label="操作" width="310"><template #default="{row}"><el-button v-if="row.lastTaskId" link type="primary" @click="router.push(`/bank/sync-question/${row.lastTaskId}`)">查看</el-button><el-button v-hasPermi="['bank:sync:question:add']" link type="primary" :disabled="saving" @click="openSingle(row)">{{ planBookStage(row).key==='queued' ? '提前执行' : ['collecting','checking','importing'].includes(planBookStage(row).key) ? '查看当前任务' : '再同步一次' }}</el-button><el-button v-if="planBookStage(row).key==='queued'" v-hasPermi="['bank:sync:plans:edit']" link :disabled="saving" @click="pin(row.textbookId)">置顶</el-button><el-button v-hasPermi="['bank:sync:plans:edit']" link @click="editBook(row)">设置</el-button></template></el-table-column>
        <template #empty><el-empty :image-size="64" :description="books.length ? '没有符合筛选的教材' : '计划正在发现教材，登记后自动生成清单与任务'"/></template>
      </el-table><footer class="table-footer">显示 {{filteredBooks.length}} / {{books.length}} 本教材</footer>
    </section>
    <el-dialog v-model="settingsVisible" title="计划设置" width="560px" class="detail-scroll-dialog sync-center-dialog"><PlanSettingsFields v-model="form"/><template #footer><el-button @click="settingsVisible=false">取消</el-button><el-button v-hasPermi="['bank:sync:plans:edit']" type="primary" :loading="saving" @click="save">保存设置</el-button></template></el-dialog>
    <el-dialog v-model="endVisible" title="结束本次同步" width="480px" class="detail-scroll-dialog sync-center-dialog"><p>停止当前工作，取消本轮未完成的队列，保留已采集和已入库成果。</p><el-checkbox v-model="keepUpdates">继续自动更新：结束本轮后 {{form.refreshDays}} 天开始新一轮</el-checkbox><template #footer><el-button @click="endVisible=false">取消</el-button><el-button type="danger" :loading="saving" @click="act('end',keepUpdates)">结束本次同步</el-button></template></el-dialog>
    <el-dialog v-model="orderVisible" title="调整教材顺序" width="650px" class="detail-scroll-dialog sync-center-dialog"><p>拖动或使用上下移动按钮。正在执行和已完成的任务不会重跑；新发现教材追加到清单末尾。</p><draggable v-model="orderBooks" item-key="textbookId" handle=".drag-handle" class="order-list"><template #item="{element,index}"><div class="order-row"><span class="drag-handle" tabindex="0" aria-label="拖动教材">⠿</span><span>{{index+1}}</span><div><strong>{{element.textbookName}}</strong><small>{{element.versionName}}</small></div><el-button :disabled="index===0" @click="move(index,-1)">上移</el-button><el-button :disabled="index===orderBooks.length-1" @click="move(index,1)">下移</el-button></div></template></draggable><template #footer><el-button @click="orderVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveOrder(orderBooks)">保存顺序</el-button></template></el-dialog>
    <el-dialog v-model="singleVisible" :title="`单本同步 · ${singleBook?.textbookName || ''}`" width="480px" class="detail-scroll-dialog sync-center-dialog"><p>当前教材已在队列时提前执行；没有未结束执行时，为本轮同一任务新增一次执行，不改变整轮更新时间。</p><el-form label-position="top"><el-form-item label="扫描方式"><el-checkbox v-model="singleFull">全量扫描这本教材每个目录的当前前 1000 页</el-checkbox><p class="field-hint">默认增量：接上历史保存范围后跳过已有部分。全量不清空题库。</p></el-form-item><el-form-item label="本次分页并发"><el-select v-model="singleConcurrency"><el-option :value="0" :label="`继承计划：${plan.listConcurrency} 页`"/><el-option v-for="n in [1,2,4,8]" :key="n" :value="n" :label="`自定义：${n} 页`"/></el-select></el-form-item></el-form><el-checkbox v-if="!plan.enabled || plan.controlState==='paused'" v-model="allowPaused">仅执行这一次，不恢复整个计划</el-checkbox><template #footer><el-button @click="singleVisible=false">取消</el-button><el-button type="primary" :loading="saving" :disabled="(!plan.enabled || plan.controlState==='paused') && !allowPaused" @click="syncSingle">同步这本教材</el-button></template></el-dialog>
    <el-dialog v-model="bookDialog" :title="`教材安排 · ${bookForm.textbookName || ''}`" width="480px" class="detail-scroll-dialog sync-center-dialog"><el-form label-position="top"><el-form-item label="参与自动同步"><el-switch v-model="bookForm.enabled"/></el-form-item><el-form-item label="人工单列"><el-select v-model="bookForm.exceptionKind" clearable><el-option label="来源无题" value="no_questions"/><el-option label="长期不可访问" value="inaccessible"/></el-select></el-form-item><el-form-item label="说明"><el-input v-model="bookForm.operatorNote" type="textarea" maxlength="500"/></el-form-item></el-form><template #footer><el-button @click="bookDialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveBook">保存</el-button></template></el-dialog>
    <el-drawer v-model="historyVisible" class="detail-scroll-drawer" title="执行历史" size="min(700px, 96vw)"><el-table max-height="min(560px, 60vh)" scrollbar-always-on :data="historyRows"><el-table-column label="轮次" min-width="220"><template #default="{row}">{{row.cycleName}}<span v-if="row.sessionNo" class="cell-sub">第 {{row.sessionNo}} 次同步 · 第 {{row.roundNo}} 轮{{row.legacy?'（旧记录）':''}}</span></template></el-table-column><el-table-column label="新增题/关联" width="110"><template #default="{row}">{{row.summary?.newQuestionCount ?? '—'}} / {{row.summary?.newRelationCount ?? '—'}}</template></el-table-column><el-table-column prop="targetCount" label="教材" width="70"/><el-table-column label="结果" width="130"><template #default="{row}">{{row.endReason?endReasonLabel(row.endReason):row.summary?.decision==='continue'?'有新增，继续下一轮':row.status==='completed'?'已处理完':row.status==='stopped'?'已结束':'执行中'}}</template></el-table-column><el-table-column label="结束时间" min-width="160"><template #default="{row}">{{row.finishedAt ? formatTime(row.finishedAt) : '—'}}</template></el-table-column><el-table-column label="任务" width="70"><template #default="{row}"><el-button link type="primary" @click="openCycle(row.cycleNo)">查看</el-button></template></el-table-column></el-table><el-button v-if="historyCursor" @click="showHistory(true)">更多历史</el-button></el-drawer>
  </div>
</template>
<script setup>
import {computed,ref} from 'vue'
import {usePollingLifecycle} from '../../composables/usePollingLifecycle'
import {useRoute,useRouter} from 'vue-router'
import {ElMessage,ElMessageBox} from 'element-plus'
import draggable from 'vuedraggable'
import request from '@/utils/request'
import SubjectSelect from '../../components/SubjectSelect.vue'
import TaskExecutionHistory from '../../components/TaskExecutionHistory.vue'
import ManualRecovery from '../../components/ManualRecovery.vue'
import SyncCenterNav from '../../components/SyncCenterNav.vue'
import SyncWorkflow from '../../components/SyncWorkflow.vue'
import PlanSettingsFields from '../../components/PlanSettingsFields.vue'
import {planBookStage,planProgress,planPhase} from '../../utils/sync-plan.js'
import '../../styles/sync-center.scss'
const route=useRoute(),router=useRouter(),subjectId=ref(Number(route.query.subjectId)||1),books=ref([]),plan=ref({}),control=ref({}),loading=ref(true),saving=ref(false),error=ref('')
const form=ref({planName:'',enabled:true,autoUpdate:true,refreshDays:7,listConcurrency:8,catalogPageLimit:1000,maxRounds:null}),settingsVisible=ref(false),endVisible=ref(false),keepUpdates=ref(true)
const queue=ref(null),singleFull=ref(false)
const orderVisible=ref(false),orderBooks=ref([]),orderRevision=ref(),singleVisible=ref(false),singleBook=ref(),singleConcurrency=ref(0),allowPaused=ref(false)
const bookForm=ref({}),bookDialog=ref(false),bookSearch=ref(''),bookStatus=ref(''),historyVisible=ref(false),historyRows=ref([]),historyCursor=ref()
const progress=computed(()=>planProgress(books.value)),phase=computed(()=>control.value.source?.manualRequired ? '等待人工处理来源验证，后续采集已暂停' : planPhase(plan.value,progress.value))
const END_REASONS={no_new:'一轮无新增，已休眠',no_new_with_issues:'无新增，带问题休眠',no_runnable_books:'没有可执行教材',round_limit:'达到最多轮数',user_end:'已手动结束'}
function endReasonLabel(reason){return END_REASONS[reason]||reason}
const controlLabel=computed(()=>control.value.source?.manualRequired ? '等待人工处理' : ({active:plan.value.enabled?'运行中':'已暂停',paused:'已暂停',pausing:'正在暂停',ending:'正在结束本轮'})[plan.value.controlState]||'准备中')
const filteredBooks=computed(()=>books.value.filter(b=>(!bookSearch.value||`${b.versionName} ${b.textbookName}`.includes(bookSearch.value.trim()))&&(!bookStatus.value||(bookStatus.value==='active'?['collecting','checking','importing'].includes(planBookStage(b).key):bookStatus.value==='issues'?['failed','partial'].includes(planBookStage(b).key):bookStatus.value==='waiting'?planBookStage(b).key==='queued':planBookStage(b).key==='paused'||!b.enabled||b.exceptionKind))))
const data=r=>r.data||r
const loadedSubjectId=ref(null)
const showCreate=computed(()=>loadedSubjectId.value===subjectId.value&&!loading.value&&!error.value&&!plan.value.planId)
let epoch=0,timer,polling=false,pageActive=false
async function load(silent=false) {
  silent=silent===true
  if(silent&&(!pageActive||polling||saving.value||loading.value))return
  if(silent)polling=true
  const id=++epoch, requestedSubject=subjectId.value
  if(!silent)loading.value=true
  if(loadedSubjectId.value!==requestedSubject){plan.value={};books.value=[];control.value={}}
  error.value=''
  try {
    const [p,c]=await Promise.all([
      request({url:'/bank/sync/plans',params:{subjectId:requestedSubject}}),
      request({url:'/bank/sync/control'}),
    ])
    const current=data(p)[0]||{}
    if(id!==epoch)return
    plan.value=current;control.value=data(c);loadedSubjectId.value=requestedSubject
    const [b,q]=current.planId?await Promise.all([request({url:`/bank/sync/plans/${current.planId}/books`}).then(data),request({url:`/bank/sync/plans/${current.planId}/queue`}).then(data).catch(()=>null)]) : [[],null]
    if(id!==epoch)return
    plan.value=current;books.value=b;queue.value=q;control.value=data(c);loadedSubjectId.value=requestedSubject
    if(!silent&&!settingsVisible.value)form.value={planName:current.planName||'',enabled:current.planId?current.enabled:true,autoUpdate:current.autoUpdate ?? true,refreshDays:current.refreshDays||7,listConcurrency:current.listConcurrency||8,catalogPageLimit:current.catalogPageLimit ?? 1000,maxRounds:current.maxRounds ?? null}
  } catch(e) {
    if(id===epoch)error.value=e.message || '计划加载失败，请点击刷新重试'
  } finally {
    if(id===epoch)loading.value=false
    if(silent)polling=false
  }
}
async function save(){saving.value=true;try{await request({url:'/bank/sync/plans',method:'put',data:{...form.value,planName:form.value.planName.trim()||undefined,subjectId:subjectId.value,expectedRevision:plan.value.revision||null}});settingsVisible.value=false;ElMessage.success('计划设置已保存');await load()}catch(e){error.value=e.message}finally{saving.value=false}}
async function startFull(){try{await ElMessageBox.confirm('本次同步的第一轮对每个目录重新扫描当前前 1000 页，不使用增量提前结束；不清空题库，已有题目去重。后续轮次仍为增量。','全量扫描一次',{confirmButtonText:'开始全量扫描',cancelButtonText:'取消'});await act('start',true,true)}catch{}}
async function pin(textbookId){saving.value=true;try{await request({url:`/bank/sync/plans/${plan.value.planId}/books/${textbookId}/pin`,method:'post',data:{expectedRevision:plan.value.revision}});ElMessage.success('已置顶，当前任务结束后优先执行');await load()}catch(e){error.value=e.message}finally{saving.value=false}}
async function act(action,keep=true,full=false){saving.value=true;try{await request({url:`/bank/sync/plans/${plan.value.planId}/action`,method:'post',data:{action,keepUpdates:keep,full,expectedRevision:plan.value.revision}});endVisible.value=false;await load()}catch(e){error.value=e.message}finally{saving.value=false}}
async function pause(){try{await ElMessageBox.confirm('暂停本计划的采集、核验、入库和重试。已取得成果保留，之后可以继续。','暂停整个计划',{confirmButtonText:'暂停计划',cancelButtonText:'取消'});await act('pause')}catch{}}
async function resumeSource(){saving.value=true;try{await request({url:'/bank/sync/control/source/resume',method:'post',data:{expectedRevision:control.value.source.revision}});await load()}catch(e){error.value=e.message}finally{saving.value=false}}
async function retryDiscovery(){saving.value=true;try{await request({url:`/bank/sync/plans/${plan.value.planId}/discovery/retry`,method:'post',data:{expectedRevision:plan.value.revision}});await load()}catch(e){error.value=e.message}finally{saving.value=false}}
function openOrder(){orderBooks.value=books.value.map(b=>({...b}));orderRevision.value=plan.value.revision;orderVisible.value=true}
function move(index,delta){const next=orderBooks.value.splice(index,1)[0];orderBooks.value.splice(index+delta,0,next)}
async function saveOrder(order,revision=orderRevision.value){saving.value=true;try{await request({url:`/bank/sync/plans/${plan.value.planId}/order`,method:'put',data:{textbookIds:order.map(b=>b.textbookId),expectedRevision:revision}});orderVisible.value=false;await load()}catch(e){error.value=e.message}finally{saving.value=false}}
function openSingle(row){if(['collecting','checking','importing'].includes(planBookStage(row).key)&&row.lastTaskId){router.push(`/bank/sync-question/${row.lastTaskId}`);return}singleBook.value=row;singleConcurrency.value=0;allowPaused.value=false;singleFull.value=false;singleVisible.value=true}
async function syncSingle(){saving.value=true;try{const task=data(await request({url:`/bank/sync/plans/${plan.value.planId}/books/${singleBook.value.textbookId}/sync`,method:'post',data:{expectedRevision:plan.value.revision,listConcurrency:singleConcurrency.value||null,allowPaused:allowPaused.value,full:singleFull.value}}));singleVisible.value=false;await load();router.push(`/bank/sync-question/${task.taskId}`)}catch(e){error.value=e.message}finally{saving.value=false}}
function editBook(row){bookForm.value={...row};bookDialog.value=true}
async function saveBook(){saving.value=true;try{const b=bookForm.value;await request({url:`/bank/sync/plans/${plan.value.planId}/books/${b.textbookId}`,method:'put',data:{enabled:b.enabled,exceptionKind:b.exceptionKind||null,operatorNote:b.operatorNote||null,expectedRevision:b.revision}});bookDialog.value=false;await load()}catch(e){error.value=e.message}finally{saving.value=false}}
async function showHistory(more=false){more=more===true;historyVisible.value=true;try{const result=data(await request({url:`/bank/sync/plans/${plan.value.planId}/history`,params:{before:more?historyCursor.value:undefined}}));historyRows.value=more?[...historyRows.value,...result.rows]:result.rows;historyCursor.value=result.nextCursor}catch(e){error.value=e.message}}
function openCycle(no){router.push({path:'/sync-center/tasks',query:{planId:plan.value.planId,cycleNo:no,subjectId:subjectId.value}})}
function formatTime(v){return v?new Date(v).toLocaleString():'—'}
usePollingLifecycle(()=>{pageActive=true;load();timer=setInterval(()=>load(true),5000)},()=>{pageActive=false;++epoch;clearInterval(timer)})
</script>
<style scoped>
.queue-now{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px}.queue-now>div{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--el-border-color-lighter);border-radius:8px}.plan-actions{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:22px}.plan-actions .el-button{margin-left:0}.field-hint{font-size:13px;color:var(--el-text-color-secondary);line-height:1.7}.book-filters{display:flex;gap:12px;margin-bottom:18px}.book-filters .el-input{width:240px}.book-filters .el-select{width:180px}.cell-main{font-weight:500}.cell-sub{display:block;font-size:12px;color:var(--el-text-color-secondary);margin-top:5px}.order-list{max-height:55vh;overflow:auto;margin-top:16px}.order-row{display:flex;gap:12px;align-items:center;padding:12px 4px;border-bottom:1px solid var(--el-border-color-lighter)}.order-row>div{flex:1;min-width:0}.order-row small{display:block;color:var(--el-text-color-secondary);margin-top:4px}.drag-handle{cursor:grab;font-size:22px;color:var(--el-text-color-secondary)}@media(max-width:600px){.book-filters{flex-direction:column}.book-filters .el-input,.book-filters .el-select{width:100%}.order-row{gap:6px}.order-row .el-button{padding:6px;font-size:12px}}
</style>
