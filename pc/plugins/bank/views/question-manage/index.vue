<template>
  <div class="app-container bank-admin-page">
    <div class="page-heading"><h2>题目管理</h2><el-button :icon="Refresh" :loading="loading" @click="loadQuestions">刷新</el-button></div>
    <el-alert v-if="errorMessage" class="state-alert" type="error" :closable="false" show-icon>{{ errorMessage }}</el-alert>
    <section class="panel">
      <el-form ref="queryRef" :model="query" :inline="true" class="filter-form" @submit.prevent="search">
        <el-form-item label="学科"><SubjectSelect v-model="context.subjectId" @change="handleSubjectChange" /></el-form-item>
        <el-form-item label="版本"><el-select v-model="context.versionId" clearable filterable placeholder="版本" class="context-select" @change="handleVersionChange"><el-option v-for="item in versions" :key="idOf(item,'versionId')" :label="item.versionName" :value="idOf(item,'versionId')" /></el-select></el-form-item>
        <el-form-item label="教材"><el-select v-model="context.textbookId" clearable filterable placeholder="教材" class="context-select" :disabled="!context.versionId" @change="handleTextbookChange"><el-option v-for="item in textbooks" :key="idOf(item,'textbookId')" :label="item.textbookName" :value="idOf(item,'textbookId')" /></el-select></el-form-item>
        <el-form-item label="目录"><el-select v-model="query.catalogId" clearable filterable placeholder="全部目录" class="context-select" :disabled="!context.textbookId"><el-option v-for="item in catalogOptions" :key="idOf(item,'catalogId')" :label="item.nodeName" :value="idOf(item,'catalogId')" /></el-select></el-form-item>
        <el-form-item label="关键词"><el-input v-model="query.keyword" clearable placeholder="题干或来源题号" @keyup.enter="search" /></el-form-item>
        <el-form-item label="题型"><el-select v-model="query.questionType" clearable placeholder="全部题型" class="small-select"><el-option v-for="item in qb_question_type" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item label="难度"><el-select v-model="query.difficulty" clearable placeholder="全部难度" class="small-select"><el-option v-for="item in qb_difficulty" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item label="来源"><el-input v-model="query.sourceProvider" clearable placeholder="来源提供方" /></el-form-item>
        <el-form-item label="状态"><el-select v-model="query.status" clearable placeholder="全部状态" class="small-select"><el-option v-for="item in sys_normal_disable" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item><el-button type="primary" :icon="Search" @click="search">查询</el-button><el-button :icon="RefreshLeft" @click="resetQuery">重置</el-button></el-form-item>
      </el-form>
      <div class="toolbar"><el-button v-hasPermi="['bank:question:add']" type="primary" :icon="Plus" :disabled="!context.textbookId" @click="openAdd">新增</el-button><el-button v-hasPermi="['bank:question:edit']" :disabled="selected.length !== 1" :icon="Edit" @click="openEdit(selected[0])">修改</el-button><el-button v-hasPermi="['bank:question:remove']" type="danger" plain :disabled="!deletableSelected" :icon="Delete" @click="removeSelected">删除</el-button></div>
      <el-table v-loading="loading" :data="rows" stripe size="small" class="data-table" @selection-change="selected = $event" @row-dblclick="openDetail">
        <el-table-column type="selection" width="48" align="center" /><el-table-column label="题目" min-width="300" show-overflow-tooltip><template #default="scope"><div class="question-title"><span v-if="scope.row.sourceQuestionNo" class="question-no">{{ scope.row.sourceQuestionNo }}</span><span>{{ rowText(scope.row) }}</span></div></template></el-table-column><el-table-column prop="externalQuestionId" label="来源 ID" width="150" show-overflow-tooltip /><el-table-column prop="questionType" label="题型" width="100" show-overflow-tooltip /><el-table-column prop="difficulty" label="难度" width="88" show-overflow-tooltip /><el-table-column prop="assembleCount" label="组卷次数" width="95" align="right" /><el-table-column prop="sourceProvider" label="来源" width="110" show-overflow-tooltip /><el-table-column label="状态" width="92" align="center"><template #default="scope"><dict-tag :options="sys_normal_disable" :value="scope.row.status" /></template></el-table-column>
        <el-table-column label="操作" width="190" fixed="right" align="center"><template #default="scope"><el-button v-hasPermi="['bank:question:query']" link type="primary" :icon="View" title="详情" aria-label="详情" @click.stop="openDetail(scope.row)" /><el-button v-hasPermi="['bank:question:edit']" link type="primary" :icon="Edit" title="修改" aria-label="修改" @click.stop="openEdit(scope.row)" /><el-button v-if="isManual(scope.row)" v-hasPermi="['bank:question:remove']" link type="danger" :icon="Delete" title="删除" aria-label="删除" @click.stop="remove(scope.row)" /><el-button v-else link disabled :icon="Delete" title="同步来源题目不能删除" aria-label="同步来源题目不能删除" /></template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && !rows.length" :image-size="72" description="暂无题目" /><div class="table-footer"><span>共 {{ total }} 题</span><el-pagination v-model:current-page="query.pageNum" v-model:page-size="query.pageSize" :total="total" :page-sizes="[10,20,50]" layout="sizes, prev, pager, next, total" background @size-change="loadQuestions" @current-change="loadQuestions" /></div>
    </section>

    <el-dialog v-model="dialogVisible" class="detail-scroll-dialog" :title="form.questionId ? '修改题目' : '新增题目'" width="760px" append-to-body @closed="resetForm">
      <el-alert v-if="isSyncForm" type="info" :closable="false" show-icon class="dialog-alert">同步来源题目仅允许修改启停状态，题干和来源字段由同步批次维护。</el-alert>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="96px">
        <el-row :gutter="14"><el-col :xs="24" :sm="12"><el-form-item label="题型" prop="questionType"><el-select v-model="form.questionType" clearable placeholder="请选择题型" class="full-width" :disabled="isSyncForm"><el-option v-for="item in qb_question_type" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="难度" prop="difficulty"><el-select v-model="form.difficulty" clearable placeholder="请选择难度" class="full-width" :disabled="isSyncForm"><el-option v-for="item in qb_difficulty" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item></el-col></el-row>
        <el-form-item v-if="!isSyncForm" label="所属教材"><el-select v-model="form.textbookId" clearable filterable placeholder="请先选择列表中的教材" class="full-width" @change="handleFormTextbookChange"><el-option v-for="item in textbooks" :key="idOf(item,'textbookId')" :label="item.textbookName" :value="idOf(item,'textbookId')" /></el-select></el-form-item>
        <el-form-item v-if="!isSyncForm" label="所属目录" prop="catalogIds"><el-select v-model="form.catalogIds" multiple filterable collapse-tags collapse-tags-tooltip placeholder="至少选择一个目录" class="full-width" :disabled="!form.textbookId"><el-option v-for="item in catalogOptions" :key="idOf(item,'catalogId')" :label="item.nodeName" :value="idOf(item,'catalogId')" :disabled="String(item.status) === '1'" /></el-select></el-form-item>
        <el-form-item label="题干 HTML" prop="contentHtml"><el-input v-model="form.contentHtml" type="textarea" :rows="5" :disabled="isSyncForm" placeholder="允许安全 HTML；也可只填写纯文本" /></el-form-item><el-form-item label="纯文本" prop="plainText"><el-input v-model="form.plainText" type="textarea" :rows="3" :disabled="isSyncForm" placeholder="题干纯文本" /></el-form-item>
        <el-row :gutter="14"><el-col :xs="24" :sm="12"><el-form-item label="答案 HTML"><el-input v-model="form.answerHtml" type="textarea" :rows="3" :disabled="isSyncForm" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="解析 HTML"><el-input v-model="form.analysisHtml" type="textarea" :rows="3" :disabled="isSyncForm" /></el-form-item></el-col></el-row>
        <el-row :gutter="14"><el-col :xs="24" :sm="12"><el-form-item label="来源题号"><el-input v-model="form.sourceQuestionNo" :disabled="isSyncForm" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="来源试卷"><el-input v-model="form.paperName" :disabled="isSyncForm" /></el-form-item></el-col></el-row>
        <el-form-item label="来源地址"><el-input v-model="form.sourceUrl" clearable :disabled="isSyncForm" /></el-form-item><el-form-item label="状态" prop="status"><el-radio-group v-model="form.status"><el-radio v-for="item in sys_normal_disable" :key="item.value" :value="item.value">{{ item.label }}</el-radio></el-radio-group></el-form-item>
      </el-form><template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">保存</el-button></template>
    </el-dialog>

    <el-drawer v-model="detailVisible" class="detail-scroll-drawer" title="题目详情" direction="rtl" size="min(720px, 94vw)" append-to-body><el-skeleton v-if="detailLoading" :rows="10" animated /><el-empty v-else-if="!detail" description="未找到题目" /><div v-else class="detail-content"><div class="detail-meta"><el-tag v-if="detail.questionType" size="small">{{ detail.questionType }}</el-tag><el-tag v-if="detail.difficulty" size="small" type="warning">{{ detail.difficulty }}</el-tag><span>{{ detail.sourceProvider || '未知来源' }}</span><span>来源 ID：{{ detail.externalQuestionId || '未采集' }}</span></div><section class="detail-section"><h3>题干</h3><div class="rich-text" v-html="safeHtml(detail.contentHtml || detail.plainText)" /></section><section v-if="detail.answerHtml" class="detail-section"><h3>答案</h3><div class="rich-text" v-html="safeHtml(detail.answerHtml)" /></section><section v-if="detail.analysisHtml" class="detail-section"><h3>解析</h3><div class="rich-text" v-html="safeHtml(detail.analysisHtml)" /></section><section class="detail-section"><h3>素材</h3><el-empty v-if="!assets.length" :image-size="48" description="暂无素材或素材未下载" /><div v-else class="asset-list"><div v-for="asset in assets" :key="asset.assetKey" class="asset-item"><a v-if="resolveAsset(asset)" :href="resolveAsset(asset)" target="_blank" rel="noopener noreferrer">{{ asset.fileName || asset.assetKey }}</a><span v-else>{{ asset.fileName || asset.assetKey }}</span><small>{{ assetStore.label(asset) }}</small><el-button v-if="assetStore.state(asset).status === 'failed'" link type="primary" @click="assetStore.retry(asset)">重试加载</el-button></div></div></section></div></el-drawer>
  </div>
</template>

<script setup>
let scopeReadRevision = 0
let versionsReadRevision = 0
let textbooksReadRevision = 0
let catalogsReadRevision = 0
import SubjectSelect from "../../components/SubjectSelect.vue"
import { computed, getCurrentInstance, onMounted, reactive, ref, watch } from 'vue'
import { Delete, Edit, Plus, Refresh, RefreshLeft, Search, View } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { addQuestion, deleteQuestions, getQuestion, getQuestionAsset, listCatalog, listQuestionAssets, listQuestions, listTextbooks, listVersions, updateQuestion, updateQuestionStatus } from '../../api/bank'
import { sanitizeHtml } from '../../utils/html'
import { useQuestionAssetStore } from '../../utils/assets'
import { unwrapList, unwrapPage, unwrapTree } from '../../utils/response'
const { proxy } = getCurrentInstance(); const { qb_question_type, qb_difficulty, sys_normal_disable } = proxy.useDict('qb_question_type', 'qb_difficulty', 'sys_normal_disable')
const versions = ref([]); const textbooks = ref([]); const catalogOptions = ref([]); const rows = ref([]); const selected = ref([]); const total = ref(0); const loading = ref(false); const submitting = ref(false); const dialogVisible = ref(false); const detailVisible = ref(false); const detailLoading = ref(false); const detail = ref(null); const assets = ref([]); const errorMessage = ref(''); const queryRef = ref(); const formRef = ref(); const isSyncForm = ref(false)
const assetStore = useQuestionAssetStore(getQuestionAsset)
let detailRequestId = 0
const context = reactive({ subjectId: undefined, versionId: undefined, textbookId: undefined }); const query = reactive({ pageNum: 1, pageSize: 10, catalogId: undefined, keyword: '', questionType: undefined, difficulty: undefined, sourceProvider: '', status: undefined, sort: 'questionId', order: 'desc' }); const form = reactive({})
const rules = { contentHtml: [{ validator: (_rule, _value, callback) => { if (isSyncForm.value || String(form.contentHtml || '').trim() || String(form.plainText || '').trim()) callback(); else callback(new Error('题干 HTML 与纯文本至少填写一个')) }, trigger: 'blur' }], catalogIds: [{ validator: (_rule, _value, callback) => { if (isSyncForm.value || (Array.isArray(form.catalogIds) && form.catalogIds.length)) callback(); else callback(new Error('人工题目至少关联一个目录')) }, trigger: 'change' }] }
const idOf = (item, key) => item?.[key] ?? item?.[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]; const isManual = (row) => String(row?.sourceProvider || '').toLowerCase() === 'manual'; const deletableSelected = computed(() => selected.value.length > 0 && selected.value.every(isManual)); function rowText(row) { return row?.plainText || row?.sourceText || row?.paperName || '题目内容未采集' } function flatten(nodes) { return nodes.flatMap((node) => [node, ...flatten(node.children || [])]) }
function unwrapOne(result) { return result?.data && !result.questionId ? result.data : result }
function resetForm() { Object.assign(form, { questionId: undefined, subjectId: undefined, textbookId: context.textbookId, catalogIds: [], sourceProvider: 'manual', externalQuestionId: undefined, sourceQuestionNo: '', sourceText: '', paperName: '', sourceUrl: '', questionType: undefined, difficulty: undefined, contentHtml: '', plainText: '', answerHtml: '', analysisHtml: '', status: '0' }); isSyncForm.value = false; formRef.value?.clearValidate() }
async function handleSubjectChange() {
  scopeReadRevision += 1; textbooksReadRevision += 1; catalogsReadRevision += 1
  context.versionId = undefined; context.textbookId = undefined; query.catalogId = undefined
  catalogOptions.value = []; textbooks.value = []; versions.value = []; selected.value = []
  rows.value = []; total.value = 0; loading.value = false; query.pageNum = 1
  await Promise.all([loadVersions(), loadQuestions()])
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
async function handleVersionChange(versionId) {
  const revision = ++textbooksReadRevision
  scopeReadRevision += 1; catalogsReadRevision += 1; loading.value = false
  context.textbookId = undefined; query.catalogId = undefined; catalogOptions.value = []; textbooks.value = []
  rows.value = []; total.value = 0
  if (!versionId) { await loadQuestions(); return }
  try {
    const result = unwrapList(await listTextbooks({ versionId, pageNum: 1, pageSize: 100, includeDisabled: true }))
    if (revision === textbooksReadRevision) textbooks.value = result
  } catch (error) {
    if (revision === textbooksReadRevision) errorMessage.value = error?.message || '教材加载失败，请稍后重试'
  }
}
async function handleTextbookChange(textbookId) {
  const revision = ++catalogsReadRevision
  scopeReadRevision += 1; loading.value = false
  query.catalogId = undefined; catalogOptions.value = []; rows.value = []; total.value = 0
  if (!textbookId) { await loadQuestions(); return }
  try {
    const result = flatten(unwrapTree(await listCatalog({ textbookId, includeDisabled: true })))
    if (revision !== catalogsReadRevision) return
    catalogOptions.value = result
  } catch (error) {
    if (revision !== catalogsReadRevision) return
    errorMessage.value = error?.message || '目录加载失败，请稍后重试'
  }
  await loadQuestions()
}
async function loadQuestions() { const revision = ++scopeReadRevision; loading.value = true; errorMessage.value = ''; try { const page = unwrapPage(await listQuestions({ ...query, subjectId: context.subjectId, textbookId: context.textbookId, includeDisabled: true })); if (revision !== scopeReadRevision) return; rows.value = page.rows; total.value = page.total; selected.value = [] } catch (error) { if (revision !== scopeReadRevision) return; rows.value = []; total.value = 0; errorMessage.value = error?.message || '题目加载失败，请稍后重试' } finally { if (revision === scopeReadRevision) loading.value = false } }
function search() { query.pageNum = 1; loadQuestions() } function resetQuery() { queryRef.value?.resetFields(); query.pageNum = 1; loadQuestions() }
function openAdd() { resetForm(); dialogVisible.value = true }
async function openEdit(row) { resetForm(); Object.assign(form, row); isSyncForm.value = !isManual(row); dialogVisible.value = true; if (!isSyncForm.value) { try { const result = await getQuestion(row.questionId); const value = unwrapOne(result); Object.assign(form, value || {}); form.textbookId = context.textbookId; if (!catalogOptions.value.length && form.textbookId) await handleFormTextbookChange(form.textbookId) } catch (error) { ElMessage.error(error?.message || '题目详情加载失败') } } }
async function handleFormTextbookChange(textbookId) { form.catalogIds = []; if (!textbookId) { catalogOptions.value = []; return } try { catalogOptions.value = flatten(unwrapTree(await listCatalog({ textbookId }))) } catch (error) { ElMessage.error(error?.message || '目录加载失败') } }
async function submit() { if (!(await formRef.value?.validate().catch(() => false))) return; submitting.value = true; try { if (isSyncForm.value) await updateQuestionStatus(form.questionId, form.status); else { const payload = { ...form }; delete payload.textbookId; if (form.questionId) await updateQuestion(payload); else await addQuestion(payload) } ElMessage.success(form.questionId ? '修改成功' : '新增成功'); dialogVisible.value = false; await loadQuestions() } catch (error) { ElMessage.error(error?.message || '保存失败') } finally { submitting.value = false } }
async function toggleStatus(row, status) { try { await updateQuestionStatus(row.questionId, status); ElMessage.success('状态已更新'); await loadQuestions() } catch (error) { ElMessage.error(error?.message || '状态更新失败') } }
async function openDetail(row) { const questionId = idOf(row, 'questionId'); if (!questionId) return; const requestId = ++detailRequestId; detailVisible.value = true; detailLoading.value = true; detail.value = null; assets.value = []; assetStore.reset(); try { const [questionResult, assetResult] = await Promise.all([getQuestion(questionId), listQuestionAssets(questionId)]); if (requestId !== detailRequestId) return; detail.value = unwrapOne(questionResult); assets.value = unwrapList(assetResult); void assetStore.load(questionId, assets.value) } catch (error) { if (requestId === detailRequestId) ElMessage.error(error?.message || '详情加载失败') } finally { if (requestId === detailRequestId) detailLoading.value = false } }
function safeHtml(value) { return sanitizeHtml(value, (key) => assetStore.resolve(assets.value.find((item) => String(item.assetKey) === String(key)))) } function resolveAsset(asset) { return assetStore.resolve(asset) }
async function remove(row) { await removeRows([row.questionId], `确定删除题目“${row.sourceQuestionNo || row.questionId}”吗？`) } async function removeSelected() { await removeRows(selected.value.map((item) => item.questionId), '确定删除选中的人工题目吗？') } async function removeRows(ids, message) { try { await ElMessageBox.confirm(message, '删除确认', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }); await deleteQuestions(ids); ElMessage.success('删除成功'); await loadQuestions() } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '删除失败') } }
watch(detailVisible, (visible) => { if (!visible) { detailRequestId += 1; assetStore.reset() } })
onMounted(async () => { await loadVersions(); await loadQuestions() })
</script>
<style scoped>
.bank-admin-page { min-height:calc(100vh - 84px); color:var(--el-text-color-primary); }.page-heading { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:16px; }.page-heading h2 { margin:0; font-size:20px; font-weight:600; }.state-alert { margin-bottom:14px; }.panel { min-width:0; padding:16px; border:1px solid var(--el-border-color-light); border-radius:6px; background:var(--el-bg-color); }.filter-form { margin-bottom:4px; }.filter-form :deep(.el-form-item) { margin-bottom:10px; }.filter-form :deep(.el-input) { width:180px; }.context-select { width:180px; }.small-select { width:130px; }.toolbar { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }.data-table { width:100%; }.question-title { display:flex; gap:7px; min-width:0; }.question-title > span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.question-no { flex:none; color:var(--el-color-primary); }.table-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; padding-top:12px; color:var(--el-text-color-secondary); font-size:12px; }.table-footer :deep(.el-pagination) { flex-wrap:wrap; justify-content:flex-end; }.full-width { width:100%; }.dialog-alert { margin-bottom:16px; }.detail-content { color:var(--el-text-color-primary); }.detail-meta { display:flex; flex-wrap:wrap; align-items:center; gap:9px; padding-bottom:14px; border-bottom:1px solid var(--el-border-color-lighter); color:var(--el-text-color-secondary); font-size:12px; }.detail-section { padding-top:16px; }.detail-section h3 { margin:0 0 9px; font-size:14px; }.rich-text { overflow-wrap:anywhere; line-height:1.75; }.rich-text :deep(img) { max-width:100%; height:auto; }.asset-list { display:flex; flex-direction:column; gap:8px; }.asset-item { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.asset-item a { color:var(--el-color-primary); }@media (max-width:760px) { .table-footer { align-items:flex-start; flex-direction:column; }.table-footer :deep(.el-pagination) { justify-content:flex-start; }.filter-form :deep(.el-form-item) { max-width:100%; }.context-select { width:160px; } }
</style>
