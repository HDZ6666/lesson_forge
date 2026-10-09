<template>
  <div class="app-container bank-admin-page">
    <div class="page-heading"><h2>目录管理</h2><el-button :icon="Refresh" :loading="loading" @click="loadTree">刷新</el-button></div>
    <el-alert v-if="errorMessage" class="state-alert" type="error" :closable="false" show-icon>{{ errorMessage }}</el-alert>
    <section class="panel context-panel">
      <el-form :inline="true" :model="context" class="filter-form">
        <el-form-item label="学科"><SubjectSelect v-model="context.subjectId" @change="handleSubjectChange" /></el-form-item>
        <el-form-item label="版本"><el-select v-model="context.versionId" clearable filterable placeholder="请选择版本" class="context-select" @change="handleVersionChange"><el-option v-for="item in versions" :key="idOf(item,'versionId')" :label="item.versionName" :value="idOf(item,'versionId')" /></el-select></el-form-item>
        <el-form-item label="教材"><el-select v-model="context.textbookId" clearable filterable placeholder="请选择教材" class="context-select" :disabled="!context.versionId" @change="handleTextbookChange"><el-option v-for="item in textbooks" :key="idOf(item,'textbookId')" :label="item.textbookName" :value="idOf(item,'textbookId')" /></el-select></el-form-item>
        <el-form-item label="节点名称"><el-input v-model="filters.nodeName" clearable placeholder="目录名称" @keyup.enter="loadTree" /></el-form-item>
        <el-form-item label="状态"><el-select v-model="filters.status" clearable placeholder="全部" class="status-select" @change="loadTree"><el-option v-for="item in sys_normal_disable" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item><el-button type="primary" :icon="Search" :disabled="!context.textbookId" @click="loadTree">查询</el-button><el-button :icon="RefreshLeft" @click="resetFilters">重置</el-button></el-form-item>
      </el-form>
    </section>
    <section class="panel table-panel">
      <div class="toolbar"><el-button v-hasPermi="['bank:catalog:add']" type="primary" :icon="Plus" :disabled="!context.textbookId" @click="openAdd(null)">新增根目录</el-button><el-button v-hasPermi="['bank:catalog:add']" :disabled="selected.length !== 1" :icon="Plus" @click="openAdd(selected[0])">新增子目录</el-button><el-button v-hasPermi="['bank:catalog:edit']" :disabled="selected.length !== 1" :icon="Edit" @click="openEdit(selected[0])">修改</el-button><el-button v-hasPermi="['bank:catalog:remove']" type="danger" plain :disabled="!deletableSelected" :icon="Delete" @click="removeSelected">删除</el-button></div>
      <el-table v-loading="loading" :data="visibleRows" row-key="catalogId" stripe size="small" class="data-table" :tree-props="{ children: 'children' }" @selection-change="selected = $event">
        <el-table-column type="selection" width="48" align="center" /><el-table-column prop="nodeName" label="目录名称" min-width="240" show-overflow-tooltip /><el-table-column label="类型" width="100"><template #default="scope"><dict-tag :options="qb_catalog_node_type" :value="scope.row.nodeType" /></template></el-table-column><el-table-column prop="directQuestionCount" label="直接题量" width="95" align="right" /><el-table-column prop="descendantQuestionCount" label="累计题量" width="95" align="right" /><el-table-column prop="sourceProvider" label="来源" width="110" show-overflow-tooltip /><el-table-column prop="sortOrder" label="排序" width="75" align="right" /><el-table-column label="状态" width="90" align="center"><template #default="scope"><dict-tag :options="sys_normal_disable" :value="scope.row.status" /></template></el-table-column>
        <el-table-column label="操作" width="178" fixed="right" align="center"><template #default="scope"><el-button v-hasPermi="['bank:catalog:add']" link type="primary" :icon="Plus" title="新增子目录" aria-label="新增子目录" @click.stop="openAdd(scope.row)" /><el-button v-hasPermi="['bank:catalog:edit']" link type="primary" :icon="Edit" title="修改" aria-label="修改" @click.stop="openEdit(scope.row)" /><el-button v-if="isManual(scope.row)" v-hasPermi="['bank:catalog:remove']" link type="danger" :icon="Delete" title="删除" aria-label="删除" @click.stop="remove(scope.row)" /><el-button v-else link disabled :icon="Delete" title="同步来源数据只能停用，不能删除" aria-label="同步来源数据只能停用，不能删除" /></template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && !visibleRows.length" :image-size="72" :description="context.textbookId ? '暂无目录' : '请选择版本和教材'" />
    </section>

    <el-dialog v-model="dialogVisible" :title="form.catalogId ? '修改目录' : (form.parentId ? '新增子目录' : '新增根目录')" width="560px" append-to-body @closed="resetForm">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="96px">
        <el-form-item label="所属教材" prop="textbookId"><el-select v-model="form.textbookId" disabled class="full-width"><el-option v-for="item in textbooks" :key="idOf(item,'textbookId')" :label="item.textbookName" :value="idOf(item,'textbookId')" /></el-select></el-form-item>
        <el-form-item label="父目录"><el-tree-select v-model="form.parentId" :data="parentOptions" clearable check-strictly filterable node-key="catalogId" :props="{ label: 'nodeName', value: 'catalogId' }" placeholder="不选为根目录" class="full-width" /></el-form-item>
        <el-form-item label="目录名称" prop="nodeName"><el-input v-model="form.nodeName" placeholder="请输入目录名称" /></el-form-item>
        <el-form-item label="目录类型" prop="nodeType"><el-select v-model="form.nodeType" placeholder="请选择目录类型" class="full-width"><el-option v-for="item in qb_catalog_node_type" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item label="来源地址"><el-input v-model="form.sourceUrl" clearable placeholder="可选" /></el-form-item><el-form-item label="显示顺序"><el-input-number v-model="form.sortOrder" :min="0" controls-position="right" /></el-form-item><el-form-item label="状态" prop="status"><el-radio-group v-model="form.status"><el-radio v-for="item in sys_normal_disable" :key="item.value" :value="item.value">{{ item.label }}</el-radio></el-radio-group></el-form-item>
      </el-form><template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
let scopeReadRevision = 0
let versionsReadRevision = 0
let textbooksReadRevision = 0
import SubjectSelect from "../../components/SubjectSelect.vue"
import { computed, getCurrentInstance, onMounted, reactive, ref } from 'vue'
import { Delete, Edit, Plus, Refresh, RefreshLeft, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { addCatalog, deleteCatalogs, listCatalog, listTextbooks, listVersions, updateCatalog } from '../../api/bank'
import { unwrapList, unwrapTree } from '../../utils/response'
const { proxy } = getCurrentInstance(); const { qb_catalog_node_type, sys_normal_disable } = proxy.useDict('qb_catalog_node_type', 'sys_normal_disable')
const versions = ref([]); const textbooks = ref([]); const tree = ref([]); const selected = ref([]); const loading = ref(false); const submitting = ref(false); const dialogVisible = ref(false); const errorMessage = ref(''); const formRef = ref()
const context = reactive({ subjectId: undefined, versionId: undefined, textbookId: undefined }); const filters = reactive({ nodeName: '', status: undefined }); const form = reactive({})
const rules = { nodeName: [{ required: true, message: '目录名称不能为空', trigger: 'blur' }], nodeType: [{ required: true, message: '目录类型不能为空', trigger: 'change' }] }
const idOf = (item, key) => item?.[key] ?? item?.[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]; const isManual = (row) => String(row?.sourceProvider || '').toLowerCase() === 'manual'; const deletableSelected = computed(() => selected.value.length > 0 && selected.value.every(isManual))
function descendants(nodes) { return nodes.flatMap((node) => [node, ...descendants(Array.isArray(node.children) ? node.children : [])]) }
const allRows = computed(() => descendants(tree.value)); const visibleRows = computed(() => { const name = filters.nodeName.trim().toLowerCase(); const status = filters.status; if (!name && !status) return tree.value; const matched = new Set(allRows.value.filter((row) => (!name || String(row.nodeName || '').toLowerCase().includes(name)) && (!status || String(row.status) === String(status))).map((row) => row.catalogId)); return allRows.value.filter((row) => matched.has(row.catalogId)).map((row) => ({ ...row, children: [] })) })
const parentOptions = computed(() => { const currentId = form.catalogId; const excluded = new Set(); if (currentId) { const visit = (rows) => rows.forEach((row) => { if (row.catalogId === currentId) descendants([row]).forEach((item) => excluded.add(item.catalogId)); else visit(row.children || []) }); visit(tree.value) } const clone = (rows) => rows.filter((row) => !excluded.has(row.catalogId)).map((row) => ({ ...row, children: clone(row.children || []) })); return clone(tree.value) })
function unwrapOne(result) { return result?.data && !result.catalogId ? result.data : result }
function resetForm() { Object.assign(form, { catalogId: undefined, subjectId: undefined, textbookId: context.textbookId, parentId: null, sourceProvider: 'manual', externalNodeId: undefined, nodeName: '', nodeType: qb_catalog_node_type.value?.[0]?.value || 'chapter', sourceUrl: '', sortOrder: 0, status: '0' }); formRef.value?.clearValidate() }
async function handleSubjectChange() {
  scopeReadRevision += 1; textbooksReadRevision += 1
  context.versionId = undefined; context.textbookId = undefined
  tree.value = []; versions.value = []; textbooks.value = []; selected.value = []; loading.value = false
  await loadVersions()
}
async function loadVersions() {
  const revision = ++versionsReadRevision
  try {
    const result = unwrapList(await listVersions({ subjectId: context.subjectId, pageNum: 1, pageSize: 100, includeDisabled: true }))
    if (revision === versionsReadRevision) versions.value = result
  } catch (error) {
    if (revision === versionsReadRevision) errorMessage.value = error?.message || '版本加载失败，请稍后重试'
  }
}
async function loadTextbooks(versionId) {
  const revision = ++textbooksReadRevision
  textbooks.value = []
  if (!versionId) return
  try {
    const result = unwrapList(await listTextbooks({ versionId, pageNum: 1, pageSize: 100, includeDisabled: true }))
    if (revision === textbooksReadRevision) textbooks.value = result
  } catch (error) {
    if (revision === textbooksReadRevision) errorMessage.value = error?.message || '教材加载失败，请稍后重试'
  }
}
async function handleVersionChange(versionId) {
  scopeReadRevision += 1; loading.value = false
  context.textbookId = undefined; tree.value = []; selected.value = []
  await loadTextbooks(versionId)
}
async function handleTextbookChange() { tree.value = []; selected.value = []; await loadTree() }
async function loadTree() {
  const revision = ++scopeReadRevision
  const textbookId = context.textbookId
  if (!textbookId) { tree.value = []; loading.value = false; return }
  loading.value = true; errorMessage.value = ''
  try {
    const result = unwrapTree(await listCatalog({ textbookId, includeDisabled: true }))
    if (revision === scopeReadRevision) tree.value = result
  } catch (error) {
    if (revision !== scopeReadRevision) return
    tree.value = []; errorMessage.value = error?.message || '目录加载失败，请稍后重试'
  } finally { if (revision === scopeReadRevision) loading.value = false }
}
function resetFilters() { filters.nodeName = ''; filters.status = undefined; loadTree() }
function openAdd(parent) { if (!context.textbookId) return; resetForm(); if (parent) { form.parentId = parent.catalogId; form.textbookId = parent.textbookId } dialogVisible.value = true }
function openEdit(row) { resetForm(); Object.assign(form, row); dialogVisible.value = true }
async function submit() { if (!(await formRef.value?.validate().catch(() => false))) return; const editing = Boolean(form.catalogId); submitting.value = true; try { const result = editing ? await updateCatalog({ ...form }) : await addCatalog({ ...form }); Object.assign(form, unwrapOne(result) || form); ElMessage.success(editing ? '修改成功' : '新增成功'); dialogVisible.value = false; await loadTree() } catch (error) { ElMessage.error(error?.message || '保存失败') } finally { submitting.value = false } }
async function remove(row) { await removeRows([row.catalogId], `确定删除目录“${row.nodeName || row.catalogId}”吗？`) } async function removeSelected() { await removeRows(selected.value.map((item) => item.catalogId), '确定删除选中的人工目录吗？') } async function removeRows(ids, message) { try { await ElMessageBox.confirm(message, '删除确认', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }); await deleteCatalogs(ids); ElMessage.success('删除成功'); await loadTree() } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '删除失败') } }
onMounted(async () => { await loadVersions() })
</script>
<style scoped>
.bank-admin-page { min-height:calc(100vh - 84px); color:var(--el-text-color-primary); }.page-heading { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:16px; }.page-heading h2 { margin:0; font-size:20px; font-weight:600; }.state-alert { margin-bottom:14px; }.panel { min-width:0; padding:16px; border:1px solid var(--el-border-color-light); border-radius:6px; background:var(--el-bg-color); }.context-panel { margin-bottom:14px; }.filter-form { margin-bottom:0; }.filter-form :deep(.el-form-item) { margin-bottom:10px; }.context-select { width:220px; }.status-select { width:140px; }.table-panel { min-height:430px; }.toolbar { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }.data-table { width:100%; }.full-width { width:100%; }@media (max-width:760px) { .context-select { width:100%; }.context-panel :deep(.el-form-item) { width:100%; }.context-panel :deep(.el-form-item__content) { min-width:0; }.table-panel { padding:10px; } }
</style>
