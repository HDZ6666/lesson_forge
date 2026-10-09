<template>
  <div class="app-container bank-admin-page">
    <div class="page-heading">
      <h2>版本管理</h2>
      <el-button :icon="Refresh" :loading="loading" @click="loadList">刷新</el-button>
    </div>

    <el-alert v-if="errorMessage" class="state-alert" type="error" :closable="false" show-icon>{{ errorMessage }}</el-alert>
    <section class="panel">
      <el-form ref="queryRef" :model="query" :inline="true" class="filter-form" @submit.prevent="search">
        <el-form-item label="学科" prop="subjectId"><SubjectSelect v-model="query.subjectId" @change="search" /></el-form-item>
        <el-form-item label="版本名称" prop="versionName"><el-input v-model="query.versionName" clearable placeholder="请输入版本名称" @keyup.enter="search" /></el-form-item>
        <el-form-item label="来源" prop="sourceProvider"><el-input v-model="query.sourceProvider" clearable placeholder="来源提供方" @keyup.enter="search" /></el-form-item>
        <el-form-item label="状态" prop="status"><el-select v-model="query.status" clearable placeholder="全部" class="status-select"><el-option v-for="item in sys_normal_disable" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item><el-button type="primary" :icon="Search" @click="search">查询</el-button><el-button :icon="RefreshLeft" @click="resetQuery">重置</el-button></el-form-item>
      </el-form>
      <div class="toolbar">
        <el-button v-hasPermi="['bank:version:add']" type="primary" :icon="Plus" @click="openAdd">新增</el-button>
        <el-button v-hasPermi="['bank:version:edit']" :disabled="selected.length !== 1" :icon="Edit" @click="openEdit(selected[0])">修改</el-button>
        <el-button v-hasPermi="['bank:version:remove']" type="danger" plain :disabled="!deletableSelected" :icon="Delete" @click="removeSelected">删除</el-button>
      </div>
      <el-table v-loading="loading" :data="rows" stripe size="small" class="data-table" @selection-change="selected = $event">
        <el-table-column type="selection" width="48" align="center" />
        <el-table-column prop="versionName" label="版本名称" min-width="190" show-overflow-tooltip />
        <el-table-column prop="sourceProvider" label="来源" width="120" show-overflow-tooltip />
        <el-table-column prop="externalVersionId" label="外部 ID" width="160" show-overflow-tooltip />
        <el-table-column prop="textbookCount" label="教材数" width="90" align="right" />
        <el-table-column label="状态" width="94" align="center"><template #default="scope"><dict-tag :options="sys_normal_disable" :value="scope.row.status" /></template></el-table-column>
        <el-table-column label="最近同步" min-width="165" show-overflow-tooltip><template #default="scope">{{ scope.row.lastSeenAt || scope.row.lastSyncBatchId || '未同步' }}</template></el-table-column>
        <el-table-column label="操作" width="150" fixed="right" align="center">
          <template #default="scope">
            <el-button v-hasPermi="['bank:version:edit']" link type="primary" :icon="Edit" title="修改" aria-label="修改" @click="openEdit(scope.row)" />
            <el-button v-if="isManual(scope.row)" v-hasPermi="['bank:version:remove']" link type="danger" :icon="Delete" title="删除" aria-label="删除" @click="remove(scope.row)" />
            <el-button v-else link disabled :icon="Delete" title="同步来源数据只能停用，不能删除" aria-label="同步来源数据只能停用，不能删除" />
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !rows.length" :image-size="72" description="暂无版本" />
      <div class="table-footer"><span>共 {{ total }} 条</span><el-pagination v-model:current-page="query.pageNum" v-model:page-size="query.pageSize" :total="total" :page-sizes="[10, 20, 50]" layout="sizes, prev, pager, next, total" background @size-change="loadList" @current-change="loadList" /></div>
    </section>

    <el-dialog v-model="dialogVisible" :title="form.versionId ? '修改版本' : '新增版本'" width="560px" append-to-body @closed="resetForm">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="96px">
        <el-form-item label="学科" prop="subjectId"><SubjectSelect v-model="form.subjectId" :clearable="false" :disabled="!!form.versionId" /></el-form-item>
        <el-form-item label="版本名称" prop="versionName"><el-input v-model="form.versionName" placeholder="请输入版本名称" /></el-form-item>
        <el-form-item label="来源提供方"><el-input v-model="form.sourceProvider" disabled placeholder="人工数据" /></el-form-item>
        <el-form-item label="外部 ID"><el-input v-model="form.externalVersionId" disabled placeholder="同步数据由系统维护" /></el-form-item>
        <el-form-item label="来源地址"><el-input v-model="form.sourceUrl" clearable placeholder="可选" /></el-form-item>
        <el-form-item label="是否新版本"><el-radio-group v-model="form.isNew"><el-radio v-for="item in sys_yes_no" :key="item.value" :value="item.value">{{ item.label }}</el-radio></el-radio-group></el-form-item>
        <el-form-item label="显示顺序" prop="sortOrder"><el-input-number v-model="form.sortOrder" :min="0" controls-position="right" /></el-form-item>
        <el-form-item label="状态" prop="status"><el-radio-group v-model="form.status"><el-radio v-for="item in sys_normal_disable" :key="item.value" :value="item.value">{{ item.label }}</el-radio></el-radio-group></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
let scopeReadRevision = 0
import SubjectSelect from "../../components/SubjectSelect.vue"
import { computed, getCurrentInstance, onMounted, reactive, ref } from 'vue'
import { Delete, Edit, Plus, Refresh, RefreshLeft, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { addVersion, deleteVersions, listVersions, updateVersion } from '../../api/bank'
import { unwrapPage } from '../../utils/response'

const { proxy } = getCurrentInstance()
const { sys_normal_disable, sys_yes_no } = proxy.useDict('sys_normal_disable', 'sys_yes_no')
const rows = ref([])
const selected = ref([])
const total = ref(0)
const loading = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const errorMessage = ref('')
const queryRef = ref()
const formRef = ref()
const query = reactive({ pageNum: 1, pageSize: 10, subjectId: undefined, versionName: '', sourceProvider: '', status: undefined })
const form = reactive({})
const rules = { subjectId: [{ required: true, message: '请选择学科', trigger: 'change' }], versionName: [{ required: true, message: '版本名称不能为空', trigger: 'blur' }] }
const isManual = (row) => String(row?.sourceProvider || '').toLowerCase() === 'manual'
const deletableSelected = computed(() => selected.value.length > 0 && selected.value.every(isManual))

function resetForm() { Object.assign(form, { versionId: undefined, subjectId: query.subjectId || 1, versionName: '', sourceProvider: 'manual', externalVersionId: undefined, sourceUrl: '', isNew: 'N', sortOrder: 0, status: '0' }); formRef.value?.clearValidate() }
function unwrapOne(result) { return result?.data && !result.versionId ? result.data : result }
async function loadList() { const revision = ++scopeReadRevision; loading.value = true; errorMessage.value = ''; try { const page = unwrapPage(await listVersions({ ...query, includeDisabled: true })); if (revision !== scopeReadRevision) return; rows.value = page.rows; total.value = page.total; selected.value = [] } catch (error) { if (revision !== scopeReadRevision) return; rows.value = []; total.value = 0; errorMessage.value = error?.message || '版本加载失败，请稍后重试' } finally { if (revision === scopeReadRevision) loading.value = false } }
function search() { query.pageNum = 1; loadList() }
function resetQuery() { queryRef.value?.resetFields(); query.pageNum = 1; loadList() }
function openAdd() { resetForm(); dialogVisible.value = true }
function openEdit(row) { resetForm(); Object.assign(form, row); dialogVisible.value = true }
async function submit() { if (!(await formRef.value?.validate().catch(() => false))) return; const editing = Boolean(form.versionId); submitting.value = true; try { const result = editing ? await updateVersion({ ...form }) : await addVersion({ ...form }); Object.assign(form, unwrapOne(result) || form); ElMessage.success(editing ? '修改成功' : '新增成功'); dialogVisible.value = false; await loadList() } catch (error) { ElMessage.error(error?.message || '保存失败') } finally { submitting.value = false } }
async function remove(row) { await removeRows([row.versionId], `确定删除版本“${row.versionName || row.versionId}”吗？`) }
async function removeSelected() { await removeRows(selected.value.map((item) => item.versionId), '确定删除选中的人工版本吗？') }
async function removeRows(ids, message) { try { await ElMessageBox.confirm(message, '删除确认', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }); await deleteVersions(ids); ElMessage.success('删除成功'); await loadList() } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '删除失败') } }
onMounted(loadList)
</script>

<style scoped>
.bank-admin-page { min-height: calc(100vh - 84px); color: var(--el-text-color-primary); }
.page-heading { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:16px; }
.page-heading h2 { margin:0; font-size:20px; font-weight:600; }
.state-alert { margin-bottom:14px; }
.panel { min-width:0; padding:16px; border:1px solid var(--el-border-color-light); border-radius:6px; background:var(--el-bg-color); }
.filter-form { margin-bottom:4px; } .filter-form :deep(.el-form-item) { margin-bottom:10px; } .filter-form :deep(.el-input) { width:190px; } .status-select { width:150px; }
.toolbar { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
.data-table { width:100%; } .table-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; padding-top:12px; color:var(--el-text-color-secondary); font-size:12px; } .table-footer :deep(.el-pagination) { flex-wrap:wrap; justify-content:flex-end; }
@media (max-width:760px) { .page-heading { align-items:flex-start; } .table-footer { align-items:flex-start; flex-direction:column; } .table-footer :deep(.el-pagination) { justify-content:flex-start; } }
</style>
