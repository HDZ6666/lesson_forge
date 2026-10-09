<template>
  <div class="app-container">
    <div class="heading"><h2>学科管理</h2><el-button v-hasPermi="['bank:subject:add']" type="primary" @click="open()">新增学科</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-table v-loading="loading" :data="rows">
      <el-table-column label="学段"><template #default="{row}">{{ stages[row.stageCode] }}</template></el-table-column>
      <el-table-column prop="subjectName" label="学科" />
      <el-table-column prop="subjectCode" label="编码" />
      <el-table-column label="同步来源"><template #default="{row}">{{ profiles.find(p => p.key === row.sourceProfile)?.name || '尚未接入' }}</template></el-table-column>
      <el-table-column label="状态"><template #default="{row}">{{ row.status === '0' ? '启用' : '停用' }}</template></el-table-column>
      <el-table-column label="操作"><template #default="{row}"><el-button v-hasPermi="['bank:subject:edit']" link type="primary" @click="open(row)">修改</el-button></template></el-table-column>
    </el-table>
    <el-empty v-if="!loading && !rows.length" description="暂无学科" />
    <el-dialog v-model="visible" :title="form.subjectId ? '修改学科' : '新增学科'" width="520px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="学段" prop="stageCode"><el-select v-model="form.stageCode" :disabled="!!form.subjectId" @change="form.sourceProfile = null"><el-option v-for="(label,key) in stages" :key="key" :label="label" :value="key" /></el-select></el-form-item>
        <el-form-item label="学科编码" prop="subjectCode"><el-input v-model="form.subjectCode" :disabled="!!form.subjectId" placeholder="例如 math、chinese" @input="form.sourceProfile = null" /></el-form-item>
        <el-form-item label="学科名称" prop="subjectName"><el-input v-model="form.subjectName" maxlength="50" /></el-form-item>
        <el-form-item label="同步来源"><el-select v-model="form.sourceProfile" clearable :disabled="!!form.subjectId" placeholder="未接入的学科可先登记"><el-option v-for="p in availableProfiles" :key="p.key" :label="p.name" :value="p.key" /></el-select></el-form-item>
        <el-form-item label="显示顺序"><el-input-number v-model="form.sortOrder" :min="0" /></el-form-item>
        <el-form-item label="状态"><el-radio-group v-model="form.status"><el-radio value="0">启用</el-radio><el-radio value="1">停用</el-radio></el-radio-group></el-form-item>
      </el-form>
      <template #footer><el-button @click="visible=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { addSubject, updateSubject, listSubjects, listSourceProfiles } from '../../api/bank'
import { unwrapList } from '../../utils/response'
const rows = ref([]), profiles = ref([]), loading = ref(false), saving = ref(false), visible = ref(false), error = ref(''), formRef = ref()
const stages = { primary: '小学', junior: '初中', senior: '高中' }
const form = reactive({})
const rules = {
  stageCode: [{ required: true, message: '请选择学段' }],
  subjectCode: [{ required: true, pattern: /^[a-z][a-z0-9_]{0,29}$/, message: '使用小写字母、数字或下划线，字母开头' }],
  subjectName: [{ required: true, whitespace: true, message: '请输入学科名称' }],
}
const availableProfiles = computed(() => profiles.value.filter(p => p.stageCode === form.stageCode && p.subjectCode === form.subjectCode))
function open(row) {
  Object.assign(form, { subjectId: undefined, stageCode: 'junior', subjectCode: '', subjectName: '', sourceProfile: null, sortOrder: 0, status: '0' }, row || {})
  visible.value = true; formRef.value?.clearValidate()
}
async function load() {
  loading.value = true; error.value = ''
  try { const values = await Promise.all([listSubjects({ includeDisabled: true }), listSourceProfiles()]); rows.value = unwrapList(values[0]); profiles.value = unwrapList(values[1]) }
  catch (e) { error.value = e?.message || '学科加载失败' }
  finally { loading.value = false }
}
async function save() {
  if (!await formRef.value?.validate().catch(() => false)) return
  saving.value = true
  try { await (form.subjectId ? updateSubject : addSubject)({ ...form }); visible.value = false; ElMessage.success('已保存'); await load() }
  catch (e) { ElMessage.error(e?.message || '保存失败') }
  finally { saving.value = false }
}
onMounted(load)
</script>
<style scoped>.heading { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; } h2 { margin:0; font-size:20px; }</style>
