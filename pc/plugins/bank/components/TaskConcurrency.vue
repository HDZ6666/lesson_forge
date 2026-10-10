<template>
  <div class="task-concurrency">
    <span>{{ task.listConcurrency ? `${task.listConcurrency} 页并发` : '并发：沿用服务器配置' }}<small v-if="task.listConcurrency"> · {{ sources[task.concurrencySource] || '任务设置' }}</small></span>
    <el-button v-if="task.concurrencyEditable" v-hasPermi="['bank:sync:question:add','bank:sync:run']" link type="primary" @click="open(false)">调整并发</el-button>
    <el-button v-else-if="terminal" v-hasPermi="['bank:sync:question:retry','bank:sync:question:add','bank:sync:run']" link type="primary" @click="open(true)">调整并发重跑</el-button>
    <el-dialog v-model="visible" :title="retrying ? '设置并发并创建新任务' : '调整待办任务并发'" width="480px" class="sync-center-dialog" append-to-body>
      <el-alert v-if="error" :title="error" type="error" :closable="false"/>
      <el-form label-position="top" v-loading="loading">
        <el-form-item label="题目分页并发"><el-select v-model="value" style="width:100%"><el-option :value="0" :label="`继承${defaults.concurrencySource === 'plan' ? '学科计划' : '服务器'}：${defaults.listConcurrency || '—'} 页`"/><el-option v-for="n in [1,2,4,8]" :key="n" :value="n" :label="`本任务自定义：${n} 页`"/></el-select></el-form-item>
      </el-form>
      <p>控制一本教材内同时请求的页数，每页通常 10 道题；各教材仍逐本排队。</p>
      <p>{{ retrying ? '原任务和成果保留，新任务使用这里选择的并发。' : '只修改这条尚未派发的任务，不修改计划或其他任务。' }}</p>
      <template #footer><el-button @click="visible=false">取消</el-button><el-button type="primary" :disabled="loading || !!loadError" :loading="saving" @click="save">{{ retrying ? '创建新任务' : '保存设置' }}</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'
const props = defineProps({ task: { type: Object, required: true } })
const emit = defineEmits(['updated'])
const router = useRouter(), visible=ref(false), loading=ref(false), saving=ref(false), error=ref(''), loadError=ref(false), retrying=ref(false), value=ref(0), defaults=ref({}), expectedToken=ref('')
const sources={task:'本任务自定义',plan:'继承计划',server:'服务器默认'}
const terminal=computed(()=>['completed','failed','blocked','interrupted','cancelled'].includes(props.task.status))
async function open(retry) {
  visible.value=true;retrying.value=retry;error.value='';loadError.value=false;loading.value=true
  value.value=props.task.concurrencySource==='task' ? props.task.listConcurrency : 0
  expectedToken.value=props.task.concurrencyToken
  try { const r=await request({url:'/bank/sync/question/concurrency-default',params:{subjectId:props.task.subjectId || 1}}); defaults.value=r.data || r }
  catch(e){error.value=e.message;loadError.value=true}finally{loading.value=false}
}
async function save() {
  saving.value=true;error.value=''
  try {
    const r=await request({url:`/bank/sync/question/tasks/${props.task.taskId}/${retrying.value ? 'retry' : 'concurrency'}`,method:retrying.value ? 'post' : 'put',data:{listConcurrency:value.value || null,...(retrying.value ? {} : {expectedToken:expectedToken.value})}})
    visible.value=false;ElMessage.success(retrying.value ? '新任务已创建' : '本任务并发已保存');emit('updated')
    if(retrying.value){const task=r.data || r;await router.push(`/bank/sync-question/${task.taskId || task.runId}`)}
  }catch(e){error.value=e.message}finally{saving.value=false}
}
</script>
<style scoped>
.task-concurrency{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}.task-concurrency small{color:var(--el-text-color-secondary)}p{font-size:13px;line-height:1.7;color:var(--el-text-color-secondary)}
</style>
