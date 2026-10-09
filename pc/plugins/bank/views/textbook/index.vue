<template>
  <div class="app-container bank-admin-page">
    <div class="page-heading"><h2>教材管理</h2><el-button :icon="Refresh" :loading="loading" @click="loadList">刷新</el-button></div>
    <el-alert v-if="errorMessage" class="state-alert" type="error" :closable="false" show-icon>{{ errorMessage }}</el-alert>
    <section class="panel">
      <el-form ref="queryRef" :model="query" :inline="true" class="filter-form" @submit.prevent="search">
        <el-form-item label="学科" prop="subjectId"><SubjectSelect v-model="query.subjectId" @change="handleSubjectChange" /></el-form-item>
        <el-form-item label="版本" prop="versionId"><el-select v-model="query.versionId" clearable filterable placeholder="全部版本" class="wide-select"><el-option v-for="item in versions" :key="idOf(item,'versionId')" :label="item.versionName" :value="idOf(item,'versionId')" /></el-select></el-form-item>
        <el-form-item label="教材名称" prop="textbookName"><el-input v-model="query.textbookName" clearable placeholder="请输入教材名称" @keyup.enter="search" /></el-form-item>
        <el-form-item label="年级" prop="grade"><el-select v-model="query.grade" clearable placeholder="年级" class="small-select"><el-option v-for="item in qb_grade" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item label="册次" prop="volume"><el-select v-model="query.volume" clearable placeholder="册次" class="small-select"><el-option v-for="item in qb_volume" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item label="状态" prop="status"><el-select v-model="query.status" clearable placeholder="全部" class="status-select"><el-option v-for="item in sys_normal_disable" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item><el-button type="primary" :icon="Search" @click="search">查询</el-button><el-button :icon="RefreshLeft" @click="resetQuery">重置</el-button></el-form-item>
      </el-form>
      <div class="toolbar"><el-button v-hasPermi="['bank:textbook:add']" type="primary" :icon="Plus" @click="openAdd">新增</el-button><el-button v-hasPermi="['bank:textbook:edit']" :disabled="selected.length !== 1" :icon="Edit" @click="openEdit(selected[0])">修改</el-button><el-button v-hasPermi="['bank:textbook:remove']" type="danger" plain :disabled="!deletableSelected" :icon="Delete" @click="removeSelected">删除</el-button></div>
      <el-table v-loading="loading" :data="rows" stripe size="small" class="data-table" @selection-change="selected = $event">
        <el-table-column type="selection" width="48" align="center" />
        <el-table-column prop="textbookName" label="教材名称" min-width="190" show-overflow-tooltip />
        <el-table-column label="版本" min-width="150" show-overflow-tooltip><template #default="scope">{{ versionName(scope.row.versionId) }}</template></el-table-column>
        <el-table-column prop="grade" label="年级" width="90" show-overflow-tooltip /><el-table-column prop="volume" label="册次" width="90" show-overflow-tooltip />
        <el-table-column prop="catalogCount" label="目录数" width="88" align="right" />
        <el-table-column prop="formalQuestionCount" label="累计正式题目" width="116" align="right" />
        <el-table-column label="当前启用题目" width="116" align="right"><template #default="{ row }">{{ row.activeQuestionCount ?? '未统计' }}</template></el-table-column>
        <el-table-column label="同步安排" min-width="180"><template #default="{row}">
          <el-button v-if="row.status==='0' && !isManual(row)" v-hasPermi="['bank:sync:question:add']" link type="primary" @click="syncBook(row)">立即同步</el-button><el-button v-if="row.latestTaskId" link type="primary" @click="router.push(`/bank/sync-question/${row.latestTaskId}`)">最近任务 {{row.latestTaskId}}</el-button>
          <div>{{ row.automaticEnabled ? (row.nextDueAt ? formatImportTime(row.nextDueAt) : '首次覆盖待办') : '未启用自动同步' }}</div>
          <small v-if="row.unresolvedIssueCount">待处理 {{row.unresolvedIssueCount}} 项</small>
          <div v-if="row.latestTaskOutcome"><small>最近扫描{{row.latestTaskOutcome.scanComplete?'完整':'未完整'}} · 入库 {{row.latestTaskOutcome.importStatus}} · 可用 {{row.latestTaskOutcome.usableQuestionCount}} 题<span v-if="row.savedImportRetries"> · 已重试入库 {{row.savedImportRetries}} 次</span></small></div>
        </template></el-table-column>
        <el-table-column label="已检查可用" width="112" align="right"><template #default="{ row }">{{ row.usableQuestionCount ?? '未统计' }}</template></el-table-column>
        <el-table-column label="待检查 / 不可用" width="132" align="right"><template #default="{ row }">{{ row.uncheckedQuestionCount ?? '未统计' }} / {{ row.unusableQuestionCount ?? '未统计' }}</template></el-table-column>
        <el-table-column label="最近来源报告" min-width="190"><template #default="{ row }">
          <template v-if="row.latestSourceObservation">{{ row.latestSourceObservation.count }} 道<br />
            <small>{{ row.latestSourceObservation.observedAt ? formatImportTime(row.latestSourceObservation.observedAt) : '观察时间未记录' }}</small>
          </template><template v-else>未记录</template>
        </template></el-table-column>
        <el-table-column prop="externalTextbookId" label="外部 ID" width="150" show-overflow-tooltip /><el-table-column label="状态" width="92" align="center"><template #default="scope"><dict-tag :options="sys_normal_disable" :value="scope.row.status" /></template></el-table-column>
        <el-table-column label="操作" width="150" fixed="right" align="center"><template #default="scope"><el-button v-hasPermi="['bank:textbook:edit']" link type="primary" :icon="Edit" title="修改" aria-label="修改" @click="openEdit(scope.row)" /><el-button v-if="isManual(scope.row)" v-hasPermi="['bank:textbook:remove']" link type="danger" :icon="Delete" title="删除" aria-label="删除" @click="remove(scope.row)" /><el-button v-else link disabled :icon="Delete" title="同步来源数据只能停用，不能删除" aria-label="同步来源数据只能停用，不能删除" /></template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && !rows.length" :image-size="72" description="暂无教材" /><div class="table-footer"><span>共 {{ total }} 条</span><el-pagination v-model:current-page="query.pageNum" v-model:page-size="query.pageSize" :total="total" :page-sizes="[10,20,50]" layout="sizes, prev, pager, next, total" background @size-change="loadList" @current-change="loadList" /></div>
    </section>
    <el-dialog v-model="dialogVisible" :title="form.textbookId ? '修改教材' : '新增教材'" width="580px" append-to-body @closed="resetForm">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="96px">
        <el-form-item label="所属版本" prop="versionId"><el-select v-model="form.versionId" filterable placeholder="请选择版本" class="full-width" :disabled="Boolean(form.textbookId && !isManual(form))"><el-option v-for="item in versions" :key="idOf(item,'versionId')" :label="item.versionName" :value="idOf(item,'versionId')" /></el-select></el-form-item>
        <el-form-item label="教材名称" prop="textbookName"><el-input v-model="form.textbookName" placeholder="请输入教材名称" /></el-form-item><el-form-item label="年级" prop="grade"><el-select v-model="form.grade" clearable placeholder="请选择年级" class="full-width"><el-option v-for="item in qb_grade" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item><el-form-item label="册次" prop="volume"><el-select v-model="form.volume" clearable placeholder="请选择册次" class="full-width"><el-option v-for="item in qb_volume" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item label="来源地址"><el-input v-model="form.sourceUrl" clearable placeholder="可选" /></el-form-item><el-form-item label="显示顺序"><el-input-number v-model="form.sortOrder" :min="0" controls-position="right" /></el-form-item><el-form-item label="状态" prop="status"><el-radio-group v-model="form.status"><el-radio v-for="item in sys_normal_disable" :key="item.value" :value="item.value">{{ item.label }}</el-radio></el-radio-group></el-form-item>
      </el-form><template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router'
const router=useRouter()
let scopeReadRevision = 0
import SubjectSelect from "../../components/SubjectSelect.vue"
import { computed, getCurrentInstance, onMounted, reactive, ref } from 'vue'
import { Delete, Edit, Plus, Refresh, RefreshLeft, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/utils/request'
import { addTextbook, deleteTextbooks, listTextbooks, listVersions, updateTextbook } from '../../api/bank'
import { unwrapList, unwrapPage } from '../../utils/response'
import { formatImportTime } from '../../utils/sync-task'
const { proxy } = getCurrentInstance(); const { qb_grade, qb_volume, sys_normal_disable } = proxy.useDict('qb_grade', 'qb_volume', 'sys_normal_disable')
const versions = ref([]); const rows = ref([]); const selected = ref([]); const total = ref(0); const loading = ref(false); const submitting = ref(false); const dialogVisible = ref(false); const errorMessage = ref(''); const queryRef = ref(); const formRef = ref()
const query = reactive({ pageNum: 1, pageSize: 10, subjectId: undefined, versionId: undefined, textbookName: '', grade: undefined, volume: undefined, sourceProvider: '', status: undefined }); const form = reactive({}); const rules = { versionId: [{ required: true, message: '所属版本不能为空', trigger: 'change' }], textbookName: [{ required: true, message: '教材名称不能为空', trigger: 'blur' }] }
const idOf = (item, key) => item?.[key] ?? item?.[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]; const isManual = (row) => String(row?.sourceProvider || '').toLowerCase() === 'manual'; const deletableSelected = computed(() => selected.value.length > 0 && selected.value.every(isManual)); function versionName(id) { return versions.value.find((item) => String(idOf(item, 'versionId')) === String(id))?.versionName || `版本 ${id || '-'}` } function unwrapOne(result) { return result?.data && !result.textbookId ? result.data : result }
function resetForm() { Object.assign(form, { textbookId: undefined, subjectId: undefined, versionId: undefined, sourceProvider: 'manual', externalTextbookId: undefined, textbookName: '', grade: undefined, volume: undefined, sourceUrl: '', sortOrder: 0, status: '0' }); formRef.value?.clearValidate() }
async function loadVersions() { const subjectId = query.subjectId; try { const result = unwrapList(await listVersions({ subjectId: query.subjectId, pageNum: 1, pageSize: 100, includeDisabled: true })); if (subjectId === query.subjectId) versions.value = result } catch (error) { if (subjectId !== query.subjectId) return; errorMessage.value = error?.message || '版本加载失败，请稍后重试' } }
async function loadList() { const revision = ++scopeReadRevision; loading.value = true; errorMessage.value = ''; try { const page = unwrapPage(await listTextbooks({ ...query, includeDisabled: true })); if (revision !== scopeReadRevision) return; rows.value = page.rows; total.value = page.total; selected.value = [] } catch (error) { if (revision !== scopeReadRevision) return; rows.value = []; total.value = 0; errorMessage.value = error?.message || '教材加载失败，请稍后重试' } finally { if (revision === scopeReadRevision) loading.value = false } }
async function handleSubjectChange() { scopeReadRevision += 1; query.versionId = undefined; query.pageNum = 1; selected.value = []; await loadVersions(); await loadList() }
function search() { query.pageNum = 1; loadList() } function resetQuery() { queryRef.value?.resetFields(); query.pageNum = 1; loadVersions().then(loadList) } function openAdd() { resetForm(); dialogVisible.value = true } function openEdit(row) { resetForm(); Object.assign(form, row); dialogVisible.value = true }
async function submit() { if (!(await formRef.value?.validate().catch(() => false))) return; const editing = Boolean(form.textbookId); submitting.value = true; try { const result = editing ? await updateTextbook({ ...form }) : await addTextbook({ ...form }); Object.assign(form, unwrapOne(result) || form); ElMessage.success(editing ? '修改成功' : '新增成功'); dialogVisible.value = false; await loadList() } catch (error) { ElMessage.error(error?.message || '保存失败') } finally { submitting.value = false } }
async function remove(row) { await removeRows([row.textbookId], `确定删除教材“${row.textbookName || row.textbookId}”吗？`) } async function removeSelected() { await removeRows(selected.value.map((item) => item.textbookId), '确定删除选中的人工教材吗？') } async function removeRows(ids, message) { try { await ElMessageBox.confirm(message, '删除确认', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }); await deleteTextbooks(ids); ElMessage.success('删除成功'); await loadList() } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '删除失败') } }
onMounted(async () => { await loadVersions(); await loadList() })
async function syncBook(row){try{const r=await request({url:'/bank/sync/question/tasks',method:'post',data:{versionId:row.versionId,textbookId:row.textbookId}});const task=r.data || r;router.push(`/bank/sync-question/${task.taskId || task.runId}`)}catch(e){errorMessage.value=e.message || '同步任务创建失败'}}
</script>
<style scoped>
.bank-admin-page { min-height:calc(100vh - 84px); color:var(--el-text-color-primary); }.page-heading { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:16px; }.page-heading h2 { margin:0; font-size:20px; font-weight:600; }.state-alert { margin-bottom:14px; }.panel { min-width:0; padding:16px; border:1px solid var(--el-border-color-light); border-radius:6px; background:var(--el-bg-color); }.filter-form { margin-bottom:4px; }.filter-form :deep(.el-form-item) { margin-bottom:10px; }.filter-form :deep(.el-input) { width:190px; }.wide-select { width:220px; }.small-select,.status-select { width:140px; }.toolbar { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }.data-table { width:100%; }.table-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; padding-top:12px; color:var(--el-text-color-secondary); font-size:12px; }.table-footer :deep(.el-pagination) { flex-wrap:wrap; justify-content:flex-end; }.full-width { width:100%; }@media (max-width:760px) { .table-footer { align-items:flex-start; flex-direction:column; }.table-footer :deep(.el-pagination) { justify-content:flex-start; } }
</style>
