<template>
  <section class="sync-issues">
    <div class="issues-heading"><div><h3>待处理问题</h3><p>默认显示需要人工判断的问题。自动重试的问题可通过“处理安排”查看。</p></div><el-button :loading="loading" @click="load()">刷新</el-button></div>
    <el-form inline class="issue-filters" label-position="top">
      <el-form-item label="教材"><el-select v-model="textbookId" clearable filterable remote :remote-method="searchBooks" placeholder="全部教材" @change="load()" @visible-change="shown=>shown&&searchBooks('')"><el-option v-for="book in books" :key="book.textbookId" :label="book.textbookName" :value="book.textbookId"/></el-select></el-form-item>
      <el-form-item label="状态"><el-select v-model="status" clearable placeholder="全部状态" @change="load()"><el-option label="待处理" value="open"/><el-option label="已忽略" value="ignored"/><el-option label="已修复" value="resolved"/></el-select></el-form-item>
      <el-form-item label="处理安排"><el-select v-model="handling" clearable placeholder="全部安排" @change="load()"><el-option label="人工处理" value="manual"/><el-option label="自动重试" value="retry"/></el-select></el-form-item>
      <el-form-item label="筛选"><el-button text @click="advanced=!advanced">{{advanced?'收起筛选':'更多筛选'}}</el-button></el-form-item>
      <template v-if="advanced"><el-form-item label="问题类型"><el-select v-model="errorType" clearable placeholder="全部类型" @change="load()"><el-option label="题目或素材" value="question_quality"/><el-option label="教材范围" value="scope_failure"/><el-option label="封存核验" value="intake_failure"/><el-option label="入库运行" value="import_failure"/><el-option label="教材身份" value="metadata_identity"/><el-option label="发现核验" value="metadata_validation"/></el-select></el-form-item><el-form-item label="出现日期"><el-date-picker v-model="dates" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" @change="load()"/></el-form-item></template>
    </el-form>
    <el-alert v-if="error" :title="error" type="error" :closable="false"/>
    <el-table max-height="min(560px, 60vh)" scrollbar-always-on :data="rows" v-loading="loading" row-key="issueId">
      <el-table-column type="expand"><template #default="{row}"><div class="issue-evidence"><p>问题 #{{row.issueId}} · 来源对象：{{row.objectKey}}</p><p v-if="row.operatorNote">人工说明：{{row.operatorNote}}</p><details><summary>查看定位信息</summary><pre tabindex="0" aria-label="问题定位信息">{{JSON.stringify(row.evidence,null,2)}}</pre></details></div></template></el-table-column>
      <el-table-column label="教材 / 问题原因" min-width="260"><template #default="{row}"><strong>{{row.textbookName || '教材发现（公共）'}}</strong><p class="issue-reason">{{row.reason}}</p></template></el-table-column>
      <el-table-column label="处理安排" min-width="170"><template #default="{row}"><el-tag :type="row.handling==='retry'?'info':'warning'" effect="plain">{{row.handling==='retry'?'自动重试':'人工核对'}}</el-tag><span v-if="row.nextAttemptAt" class="cell-sub">下次 {{new Date(row.nextAttemptAt).toLocaleString()}}</span></template></el-table-column>
      <el-table-column label="状态" width="95"><template #default="{row}"><el-tag :type="row.status==='resolved'?'success':row.status==='ignored'?'info':'warning'">{{ labels[row.status] }}</el-tag></template></el-table-column>
      <el-table-column label="最近出现" min-width="175"><template #default="{row}">{{ new Date(row.lastSeenAt).toLocaleString() }}<span class="cell-sub">累计 {{row.attempts}} 次</span></template></el-table-column>
      <el-table-column label="操作" width="175" fixed="right"><template #default="{row}"><span v-if="!row.latestTaskAvailable" class="cell-sub">任务已归档</span><el-button v-else link type="primary" @click="router.push(`/bank/${row.taskModule==='textbook'?'sync-textbook':'sync-question'}/${row.latestTaskId}`)">查看任务</el-button><el-button v-if="row.status!=='resolved'" v-hasPermi="['bank:sync:issues:edit']" link @click="change(row)">{{ row.status==='ignored' ? '重新待处理' : '忽略' }}</el-button></template></el-table-column>
      <template #empty><el-empty :image-size="56" description="当前筛选下没有问题"/></template>
    </el-table>
    <div class="issues-footer"><span>共 {{total}} 条 · 问题修复后自动更新状态，忽略仅表示暂不处理。</span><el-button v-if="cursor" :loading="loading" @click="load(true)">加载更多</el-button></div>
  </section>
</template>
<script setup>
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import request from '@/utils/request'
const props=defineProps({taskId:Number,subjectId:Number}),router=useRouter(),rows=ref([]),status=ref('open'),cursor=ref(),total=ref(0),loading=ref(false),error=ref('')
const advanced=ref(false)
const handling=ref('manual'),errorType=ref(),dates=ref([]),textbookId=ref(),books=ref([])
let booksEpoch=0
async function searchBooks(name){const id=++booksEpoch;try{const r=await request({url:'/bank/sync/issues/textbooks',params:{subjectId:props.subjectId,name}});if(id===booksEpoch)books.value=r.data || r}catch(e){if(id===booksEpoch)error.value=e.message}}
const labels={open:'待处理',ignored:'已忽略',resolved:'已修复'}
let epoch=0
async function load(more=false){const id=++epoch;loading.value=true;error.value='';try{const response=await request({url:'/bank/sync/issues',params:{handling:handling.value || undefined,taskId:props.taskId,subjectId:props.subjectId,textbookId:textbookId.value || undefined,status:status.value || undefined,errorType:errorType.value || undefined,since:dates.value?.[0]?new Date(`${dates.value[0]}T00:00:00`).toISOString():undefined,until:dates.value?.[1]?new Date(new Date(`${dates.value[1]}T00:00:00`).getTime()+86400000).toISOString():undefined,before:more?cursor.value:undefined}});if(id!==epoch)return;const r=response.data || response;rows.value=more?[...rows.value,...r.rows]:r.rows;cursor.value=r.nextCursor;total.value=r.total}catch(e){if(id===epoch)error.value=e.message}finally{if(id===epoch)loading.value=false}}
async function change(row){try{const {value}=await ElMessageBox.prompt('填写判断说明；忽略不代表已经修复。','处理问题',{inputValue:row.operatorNote || '',inputValidator:v=>v.length<=500 || '最多500字'});await request({url:`/bank/sync/issues/${row.issueId}`,method:'post',data:{expectedRevision:row.revision,status:row.status==='ignored'?'open':'ignored',operatorNote:value}});await load()}catch(e){if(e!=='cancel'&&e!=='close')error.value=e.message}}
watch(()=>[props.taskId,props.subjectId],()=>{++epoch;++booksEpoch;textbookId.value=null;books.value=[];rows.value=[];cursor.value=null;load()},{immediate:true})
</script>
<style scoped>
.sync-issues{min-width:0}.issues-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:12px 0 20px}.issues-heading h3{margin:0;font-size:16px}.issues-heading p{margin:8px 0 0;font-size:13px;color:var(--el-text-color-secondary);line-height:1.7}.issue-filters{display:flex;flex-wrap:wrap;gap:0 12px}.issue-filters .el-form-item{margin-right:0}.issue-filters .el-select{width:180px}.issue-reason{margin:6px 0 0;font-size:13px;line-height:1.65;overflow-wrap:anywhere}.issue-evidence{padding:8px 24px;color:var(--el-text-color-secondary);font-size:13px}.issue-evidence summary{cursor:pointer}.issue-evidence pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto}.cell-sub{display:block;font-size:12px;color:var(--el-text-color-secondary);margin-top:5px}.issues-footer{display:flex;gap:16px;align-items:center;justify-content:space-between;margin-top:16px;font-size:12px;color:var(--el-text-color-secondary);line-height:1.7}@media(max-width:600px){.issue-filters .el-form-item{max-width:100%}.issue-filters :deep(.el-date-editor){max-width:100%}.issues-footer{flex-wrap:wrap}}
</style>
