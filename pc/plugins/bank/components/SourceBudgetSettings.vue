<template>
  <el-button v-hasPermi="['bank:sync:control']" @click="show">每日额度设置</el-button>
  <el-dialog v-model="visible" title="每日采集额度" width="640px" class="detail-scroll-dialog sync-center-dialog" :close-on-click-modal="false">
    <p class="budget-note">所有学科计划和单本任务共用这组额度。默认不限制；填写 0 表示不限。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-skeleton v-if="loading" :rows="5" animated />
    <template v-else-if="budget">
      <p class="budget-note">每天北京时间 08:00 重新统计，下次：{{ formatTaskTime(budget.resetAt) }}。修改额度不清空今日用量。</p>
      <el-form label-position="top" class="budget-fields">
        <el-form-item v-for="field in fields" :key="field.key" :label="field.label">
          <el-input-number v-model="form[field.key]" :min="0" :max="field.max" :precision="0" controls-position="right" :aria-label="field.label" :disabled="saving" />
          <span class="budget-usage">{{ form[field.key] == null ? '请填写额度' : form[field.key] === 0 ? '不限' : `上限 ${form[field.key].toLocaleString()} ${field.unit}` }} · 今日已用 {{ used(field) }} {{ field.unit }}</span>
        </el-form-item>
      </el-form>
      <p class="budget-note">启动次数按新采集任务统计，重跑与补采也计一次。保存后立即用于后续请求和任务；已暂停的计划需要手动继续。</p>
      <el-alert v-if="budget.paused" :title="budget.reason" type="warning" :closable="false" show-icon />
    </template>
    <template #footer>
      <el-button :disabled="loading || saving || !budget" @click="unlimited">全部设为不限</el-button>
      <el-button :disabled="saving" @click="visible=false">取消</el-button>
      <el-button v-if="error" :disabled="saving" @click="read">重新读取</el-button>
      <el-button type="primary" :loading="saving" :disabled="loading || !budget || !valid" @click="save">保存设置</el-button>
    </template>
  </el-dialog>
</template>
<script setup>
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'
import { formatTaskTime } from '../utils/sync-task'
const emit = defineEmits(['updated'])
const visible = ref(false), loading = ref(false), saving = ref(false), error = ref(''), budget = ref(null)
const form = reactive({ requests: 0, books: 0, activeSeconds: 0, downloadMiB: 0 })
const fields = [
  { key: 'books', label: '每日教材题目采集启动次数', unit: '次', usage: 'bookStarts', divisor: 1, max: 9007199254740991 },
  { key: 'requests', label: '每日请求数', unit: '次', usage: 'requests', divisor: 1, max: 9007199254740991 },
  { key: 'activeSeconds', label: '每日采集时长（秒）', unit: '秒', usage: 'activeMilliseconds', divisor: 1000, max: 9007199254740 },
  { key: 'downloadMiB', label: '每日素材下载量（MB）', unit: 'MB', usage: 'downloadBytes', divisor: 1048576, max: 8589934591 },
]
const valid = computed(() => fields.every(f => Number.isSafeInteger(form[f.key]) && form[f.key] >= 0 && form[f.key] <= f.max))
const used = field => Math.ceil((budget.value?.usage?.[field.usage] || 0) / field.divisor).toLocaleString('zh-CN')
function unlimited() { fields.forEach(f => { form[f.key] = 0 }) }
async function read() {
  loading.value = true; error.value = ''; budget.value = null
  try { const result = await request({ url: '/bank/sync/control/budget' }); budget.value = result.data || result; Object.assign(form, budget.value.settings) }
  catch (e) { error.value = e?.message || '读取额度失败' }
  finally { loading.value = false }
}
function show() { visible.value = true; read() }
async function save() {
  saving.value = true; error.value = ''
  try {
    await request({ url: '/bank/sync/control/budget', method: 'put', data: { ...form, expectedRevision: budget.value.revision } })
    ElMessage.success('每日额度已保存'); visible.value = false; emit('updated')
  } catch (e) { error.value = e?.message || '保存额度失败，请重新读取后重试' }
  finally { saving.value = false }
}
</script>
<style scoped>
.budget-note { color:var(--el-text-color-secondary); font-size:13px; line-height:1.7; }
.budget-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 20px; }
.budget-fields .el-input-number { width:100%; }
.budget-usage { display:block; width:100%; margin-top:6px; color:var(--el-text-color-secondary); font-size:12px; }
@media(max-width:600px) { .budget-fields { grid-template-columns:1fr; } }
</style>
