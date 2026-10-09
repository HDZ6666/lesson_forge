<template>
  <section>
    <div class="toolbar"><h3>待处理问题</h3><el-select v-model="textbookId" clearable filterable remote :remote-method="searchBooks" placeholder="按教材筛选" @change="load()" @visible-change="shown=>shown&&searchBooks('')"><el-option v-for="book in books" :key="book.textbookId" :label="book.textbookName" :value="book.textbookId"/></el-select><el-select v-model="status" clearable placeholder="全部状态" @change="load()"><el-option label="待处理" value="open"/><el-option label="已忽略" value="ignored"/><el-option label="已修复" value="resolved"/></el-select><el-select v-model="handling" clearable placeholder="处理安排" @change="load()"><el-option label="人工处理" value="manual"/><el-option label="自动重试" value="retry"/></el-select><el-select v-model="errorType" clearable placeholder="问题类型" @change="load()"><el-option label="题目或素材" value="question_quality"/><el-option label="教材范围" value="scope_failure"/><el-option label="封存核验" value="intake_failure"/><el-option label="入库运行" value="import_failure"/><el-option label="教材身份" value="metadata_identity"/><el-option label="发现核验" value="metadata_validation"/></el-select><el-date-picker v-model="dates" type="daterange" value-format="YYYY-MM-DD" start-placeholder="出现日期" end-placeholder="结束日期" @change="load()"/><el-button :loading="loading" @click="load()">刷新</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false"/>
    <p>同一来源对象的重复问题合并保存。对应范围核验、入库或题目检查成功后才自动修复；忽略只表示人工决定不处理。</p>
    <el-table :data="rows" v-loading="loading" row-key="issueId">
      <el-table-column label="教材" min-width="140"><template #default="{row}">{{row.textbookName || '教材发现（公共）'}}</template></el-table-column><el-table-column prop="issueId" label="问题" width="80"/><el-table-column prop="objectKey" label="来源对象" width="150"/>
      <el-table-column label="处理安排" min-width="170"><template #default="{row}">{{row.handling==='retry'?'自动重试中':'人工核对'}}<span v-if="row.nextAttemptAt"> · {{new Date(row.nextAttemptAt).toLocaleString()}}</span><el-popover trigger="click" width="360"><template #reference><el-button link>定位证据</el-button></template><pre style="white-space:pre-wrap;overflow-wrap:anywhere">{{JSON.stringify(row.evidence,null,2)}}</pre></el-popover></template></el-table-column>
      <el-table-column prop="reason" label="原因" min-width="200" show-overflow-tooltip/>
      <el-table-column label="状态" width="90"><template #default="{row}">{{ labels[row.status] }}</template></el-table-column>
      <el-table-column prop="attempts" label="出现次数" width="90"/>
      <el-table-column label="最后出现"><template #default="{row}">{{ new Date(row.lastSeenAt).toLocaleString() }}</template></el-table-column>
      <el-table-column label="操作" min-width="200"><template #default="{row}">
        <span v-if="!row.latestTaskAvailable">任务 {{row.latestTaskId}} 已归档</span><el-button v-else link type="primary" @click="router.push(`/bank/${row.taskModule==='textbook'?'sync-textbook':'sync-question'}/${row.latestTaskId}`)">任务 {{ row.latestTaskId }}</el-button>
        <el-button v-if="row.status!=='resolved'" v-hasPermi="['bank:sync:issues:edit']" link @click="change(row)">{{ row.status==='ignored' ? '重新待处理' : '忽略' }}</el-button>
      </template></el-table-column>
    </el-table>
    <el-button v-if="cursor" :loading="loading" @click="load(true)">加载更多（共 {{ total }} 条）</el-button>
  </section>
</template>
<script setup>
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import request from '@/utils/request'
const props=defineProps({taskId:Number,subjectId:Number}),router=useRouter(),rows=ref([]),status=ref('open'),cursor=ref(),total=ref(0),loading=ref(false),error=ref('')
const handling=ref('manual'),errorType=ref(),dates=ref([]),textbookId=ref(),books=ref([])
let booksEpoch=0
async function searchBooks(name){const id=++booksEpoch;try{const r=await request({url:'/bank/sync/issues/textbooks',params:{subjectId:props.subjectId,name}});if(id===booksEpoch)books.value=r.data || r}catch(e){if(id===booksEpoch)error.value=e.message}}
const labels={open:'待处理',ignored:'已忽略',resolved:'已修复'}
let epoch=0
async function load(more=false){const id=++epoch;loading.value=true;error.value='';try{const response=await request({url:'/bank/sync/issues',params:{handling:handling.value || undefined,taskId:props.taskId,subjectId:props.subjectId,textbookId:textbookId.value || undefined,status:status.value || undefined,errorType:errorType.value || undefined,since:dates.value?.[0]?new Date(`${dates.value[0]}T00:00:00`).toISOString():undefined,until:dates.value?.[1]?new Date(new Date(`${dates.value[1]}T00:00:00`).getTime()+86400000).toISOString():undefined,before:more?cursor.value:undefined}});if(id!==epoch)return;const r=response.data || response;rows.value=more?[...rows.value,...r.rows]:r.rows;cursor.value=r.nextCursor;total.value=r.total}catch(e){if(id===epoch)error.value=e.message}finally{if(id===epoch)loading.value=false}}
async function change(row){try{const {value}=await ElMessageBox.prompt('填写判断说明；忽略不代表已经修复。','处理问题',{inputValue:row.operatorNote || '',inputValidator:v=>v.length<=500 || '最多500字'});await request({url:`/bank/sync/issues/${row.issueId}`,method:'post',data:{expectedRevision:row.revision,status:row.status==='ignored'?'open':'ignored',operatorNote:value}});await load()}catch(e){if(e!=='cancel'&&e!=='close')error.value=e.message}}
watch(()=>[props.taskId,props.subjectId],()=>{++epoch;++booksEpoch;textbookId.value=null;books.value=[];rows.value=[];cursor.value=null;load()},{immediate:true})
</script>
<style scoped>.toolbar{display:flex;align-items:center;gap:12px;margin:16px 0;flex-wrap:wrap}.toolbar h3{flex:1}.toolbar .el-select{width:130px}p{color:var(--el-text-color-secondary)}</style>
