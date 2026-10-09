<template>
  <div class="subject-selector">
    <el-select :model-value="modelValue" :clearable="clearable" :disabled="disabled" :loading="loading"
      placeholder="请选择学段 / 学科" @update:model-value="change">
      <el-option v-for="item in subjects" :key="item.subjectId" :value="item.subjectId"
        :label="`${stageNames[item.stageCode] || item.stageCode} · ${item.subjectName}${item.status === '1' ? '（停用）' : ''}`" />
    </el-select>
    <el-button v-if="error" link type="danger" @click="load">学科加载失败，重试</el-button>
  </div>
</template>
<script setup>
import { onMounted, ref } from 'vue'
import { listSubjects } from '../api/bank'
import { unwrapList } from '../utils/response'
const props = defineProps({ modelValue: [Number, String], clearable: { type: Boolean, default: true }, disabled: Boolean, syncOnly: Boolean, includeDisabled: { type: Boolean, default: true } })
const emit = defineEmits(['update:modelValue', 'change'])
const subjects = ref([]), loading = ref(false), error = ref(false)
const stageNames = { primary: '小学', junior: '初中', senior: '高中' }
function change(value) { emit('update:modelValue', value); emit('change', value) }
async function load() {
  loading.value = true; error.value = false
  try { subjects.value = unwrapList(await listSubjects({ includeDisabled: props.includeDisabled })).filter(item => !props.syncOnly || (item.syncSupported && item.status === '0')) }
  catch { error.value = true }
  finally { loading.value = false }
}
onMounted(load)
</script>
<style scoped>
.subject-selector { min-width: 200px; }
.subject-selector :deep(.el-select) { width: 100%; }
</style>
