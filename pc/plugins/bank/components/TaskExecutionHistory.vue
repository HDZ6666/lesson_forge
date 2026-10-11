<template>
  <el-button link type="primary" @click="open">执行历史</el-button>
  <el-drawer v-model="visible" title="教材任务执行历史" size="min(1100px, 96vw)" append-to-body class="detail-scroll-drawer">
    <p>任务 #{{ history.logicalTaskId || task.logicalTaskId || task.taskNo }} · 已执行 {{ history.executionCount || 0 }} 次。每次日志和入库结果分别保留；继续入库不增加执行次数。</p>
    <el-alert v-if="error" type="error" :title="error" :closable="false"/>
    <el-table v-loading="loading" :data="history.rows || []" max-height="65vh" stripe>
      <el-table-column label="执行" width="130"><template #default="{row}"><strong>{{ executionLabel(row, history.executionCount) }}</strong><div class="execution-meta">记录 #{{ row.taskId }}</div></template></el-table-column>
      <el-table-column label="状态" width="110"><template #default="{row}"><el-tag :type="questionTaskStatusMeta(row).type">{{ questionTaskStatusMeta(row).label }}</el-tag></template></el-table-column>
      <el-table-column label="开始 / 结束" min-width="175"><template #default="{row}"><div>{{ formatTaskTime(row.startedAt) }}</div><div>{{ formatTaskTime(row.finishedAt) }}</div></template></el-table-column>
      <el-table-column label="成果" min-width="140"><template #default="{row}"><div>采集 {{ Number(row.questionCount || 0).toLocaleString() }} 题</div><div>{{ row.incrementalImport ? `入库 ${Number(row.incrementalImport.acceptedCount || 0).toLocaleString()} 题` : '尚无入库结果' }}</div><div v-if="row.incrementalImport?.quarantinedCount">待处理 {{ row.incrementalImport.quarantinedCount }} 题</div></template></el-table-column>
      <el-table-column label="停止原因 / 待处理" min-width="260"><template #default="{row}">{{ row.incrementalImport?.errorMessage || row.importIntake?.errorMessage || row.errorMessage || row.queueReason || '—' }}</template></el-table-column>
      <el-table-column label="详情" width="110" fixed="right"><template #default="{row}"><el-button link type="primary" @click="view(row)">结果与日志</el-button></template></el-table-column>
    </el-table>
  </el-drawer>
</template>
<script setup>
import {ref} from 'vue'
import {useRouter} from 'vue-router'
import request from '@/utils/request'
import {formatTaskTime, questionTaskStatusMeta, syncTaskErrorMessage} from '../utils/sync-task'
import {executionLabel} from '../utils/task-executions'
const props=defineProps({task:{type:Object,required:true}})
const router=useRouter(), visible=ref(false), loading=ref(false), error=ref(''), history=ref({})
async function open(){
  visible.value=true; loading.value=true; error.value=''
  try { const result=await request({url:`/bank/sync/question/tasks/${props.task.taskId}/executions`}); history.value=result.data || result }
  catch(e){error.value=syncTaskErrorMessage(e,'执行历史加载失败')}
  finally{loading.value=false}
}
function view(row){visible.value=false;router.push(`/bank/sync-question/${row.taskId}`)}
</script>
<style scoped>
.execution-meta {color:var(--el-text-color-regular);font-size:12px;margin-top:6px}
p {line-height:1.7}
</style>
