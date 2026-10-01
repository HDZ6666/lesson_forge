<template>
  <div class="app-container bank-page">
    <div class="page-heading">
      <div><h2>目录与题目</h2></div>
      <el-button link type="primary" :icon="Refresh" :loading="loadingQuestions" @click="loadQuestions">刷新</el-button>
    </div>

    <el-alert v-if="errorMessage" class="state-alert" type="error" :closable="false" show-icon>{{ errorMessage }}</el-alert>

    <section class="context-bar">
      <el-form :inline="true" label-width="52px" class="context-form">
        <el-form-item label="版本">
          <el-select v-model="query.versionId" placeholder="请选择版本" clearable filterable class="context-select" @change="handleVersionChange">
            <el-option v-for="item in versions" :key="item.versionId" :label="item.versionName" :value="item.versionId" />
          </el-select>
        </el-form-item>
        <el-form-item label="教材">
          <el-select v-model="query.textbookId" placeholder="请选择教材" clearable filterable class="context-select" :disabled="!query.versionId" @change="handleTextbookChange">
            <el-option v-for="item in textbooks" :key="item.textbookId" :label="item.textbookName" :value="item.textbookId" />
          </el-select>
        </el-form-item>
      </el-form>
    </section>

    <div class="workspace" :class="{ 'is-loading': loadingCatalog }">
      <aside class="catalog-panel" aria-label="目录树">
        <div class="panel-title"><span>目录</span><el-tag size="small" type="info">{{ catalogCount }}</el-tag></div>
        <el-skeleton v-if="loadingCatalog" :rows="7" animated />
        <el-empty v-else-if="!query.textbookId" :image-size="64" description="请选择教材" />
        <el-empty v-else-if="!catalogTree.length" :image-size="64" description="暂无目录" />
        <el-tree
          v-else
          ref="catalogRef"
          :data="catalogTree"
          node-key="catalogId"
          :props="treeProps"
          highlight-current
          :expand-on-click-node="false"
          @node-click="handleCatalogChange"
        />
      </aside>

      <main class="question-panel">
        <el-form :inline="true" :model="query" class="filter-form" @submit.prevent="searchQuestions">
          <el-form-item label="关键词"><el-input v-model="query.keyword" clearable placeholder="题干或来源题号" @keyup.enter="searchQuestions" /></el-form-item>
          <el-form-item label="题型"><el-select v-model="query.questionType" clearable placeholder="全部" class="filter-select"><el-option v-for="dict in qb_question_type" :key="dict.value" :label="dict.label" :value="dict.value" /></el-select></el-form-item>
          <el-form-item label="难度"><el-select v-model="query.difficulty" clearable placeholder="全部" class="filter-select"><el-option v-for="dict in qb_difficulty" :key="dict.value" :label="dict.label" :value="dict.value" /></el-select></el-form-item>
          <el-form-item label="系数"><div class="coefficient-range"><el-input-number v-model="query.difficultyMin" :min="0" :max="1" :step="0.05" :precision="2" controls-position="right" placeholder="最小" /><span>至</span><el-input-number v-model="query.difficultyMax" :min="0" :max="1" :step="0.05" :precision="2" controls-position="right" placeholder="最大" /></div></el-form-item>
          <el-form-item label="年份"><el-input-number v-model="query.year" :min="1900" :max="2200" controls-position="right" placeholder="年份" /></el-form-item>
          <el-form-item label="地区"><el-input v-model="query.province" clearable placeholder="省份" /></el-form-item>
          <el-form-item label="标签维度"><el-select v-model="query.scene" multiple collapse-tags collapse-tags-tooltip clearable placeholder="场景" class="tag-select"><el-option v-for="dict in qb_scene" :key="dict.value" :label="dict.label" :value="dict.value" /></el-select></el-form-item>
          <el-form-item><el-select v-model="query.category" multiple collapse-tags collapse-tags-tooltip clearable placeholder="分类" class="tag-select"><el-option v-for="dict in qb_category" :key="dict.value" :label="dict.label" :value="dict.value" /></el-select></el-form-item>
          <el-form-item><el-select v-model="query.examMethod" multiple collapse-tags collapse-tags-tooltip clearable placeholder="考查方式" class="tag-select"><el-option v-for="dict in qb_exam_method" :key="dict.value" :label="dict.label" :value="dict.value" /></el-select></el-form-item>
          <el-form-item class="filter-actions"><el-button type="primary" :icon="Search" @click="searchQuestions">查询</el-button><el-button :icon="RefreshLeft" @click="resetFilters">重置</el-button></el-form-item>
        </el-form>

        <el-table v-loading="loadingQuestions" :data="questions" size="small" stripe class="question-table" @row-click="openDetail">
          <el-table-column label="题目" min-width="340" show-overflow-tooltip>
            <template #default="scope"><div class="question-title"><span v-if="scope.row.sourceQuestionNo" class="question-no">{{ scope.row.sourceQuestionNo }}</span><span>{{ rowText(scope.row) }}</span></div></template>
          </el-table-column>
          <el-table-column prop="questionType" label="题型" width="120" show-overflow-tooltip />
          <el-table-column prop="difficulty" label="难度" width="90" show-overflow-tooltip />
          <el-table-column prop="difficultyCoefficient" label="系数" width="85" align="right" />
          <el-table-column prop="year" label="年份" width="80" align="center" />
          <el-table-column prop="province" label="地区" width="100" show-overflow-tooltip />
          <el-table-column label="答案" width="90" align="center"><template #default="scope"><dict-tag :options="qb_answer_status" :value="scope.row.answerStatus || 'unknown'" /></template></el-table-column>
          <el-table-column label="操作" width="74" fixed="right" align="center"><template #default="scope"><el-button link type="primary" :icon="View" title="查看详情" aria-label="查看详情" @click.stop="openDetail(scope.row)" /></template></el-table-column>
        </el-table>
        <el-empty v-if="!loadingQuestions && query.textbookId && !questions.length" :image-size="70" description="没有符合条件的题目" />
        <div class="table-footer"><span class="result-count">共 {{ total }} 题</span><el-pagination v-model:current-page="query.pageNum" v-model:page-size="query.pageSize" :total="total" :page-sizes="[10, 20, 50]" layout="sizes, prev, pager, next, total" background @size-change="loadQuestions" @current-change="loadQuestions" /></div>
      </main>
    </div>

    <el-drawer v-model="detailVisible" title="题目详情" direction="rtl" size="min(720px, 92vw)" append-to-body>
      <el-skeleton v-if="loadingDetail" :rows="9" animated />
      <el-empty v-else-if="!detail" description="未找到题目" />
      <div v-else class="detail-content">
        <div class="detail-meta">
          <span v-if="detail.questionType">{{ detail.questionType }}</span><span v-if="detail.year">{{ detail.year }}年</span><span v-if="detail.province">{{ detail.province }}</span><span v-if="detail.difficulty">{{ detail.difficulty }}</span><span v-if="detail.difficultyCoefficient !== null && detail.difficultyCoefficient !== undefined">系数 {{ detail.difficultyCoefficient }}</span>
        </div>
        <dl class="meta-grid"><div><dt>来源</dt><dd>{{ detail.sourceProvider || '未知' }}</dd></div><div><dt>来源题号</dt><dd>{{ detail.sourceQuestionNo || '未采集' }}</dd></div><div><dt>答案状态</dt><dd><dict-tag :options="qb_answer_status" :value="detail.answerStatus || 'unknown'" /></dd></div><div><dt>组卷次数</dt><dd>{{ detail.assembleCount ?? '未采集' }}</dd></div><div><dt>引用次数</dt><dd>{{ detail.referenceCount ?? '未采集' }}</dd></div><div><dt>分值</dt><dd>{{ detail.score ?? '未采集' }}</dd></div></dl>
        <section class="detail-section"><h3>题干</h3><div class="rich-text" v-html="safeHtml(detail.contentHtml || detail.plainText)" /></section>
        <section v-if="detail.answerHtml" class="detail-section"><h3>答案</h3><div class="rich-text" v-html="safeHtml(detail.answerHtml)" /></section>
        <section v-if="detail.analysisHtml" class="detail-section"><h3>解析</h3><div class="rich-text" v-html="safeHtml(detail.analysisHtml)" /></section>
        <section class="detail-section"><h3>引用试卷</h3><el-empty v-if="!references.length" :image-size="48" description="暂无引用记录" /><ul v-else class="reference-list"><li v-for="(paper, index) in references" :key="paper.id || paper.paperId || index">{{ paper.paperName || paper.name || paper.title || paper }}</li></ul></section>
        <section class="detail-section"><h3>素材</h3><el-empty v-if="!assets.length" :image-size="48" description="暂无素材" /><div v-else class="asset-list"><div v-for="asset in assets" :key="asset.assetKey" class="asset-item"><el-icon><Document /></el-icon><a v-if="resolveAsset(asset)" :href="resolveAsset(asset)" target="_blank" rel="noopener noreferrer">{{ asset.fileName || asset.assetKey }}</a><span v-else>{{ asset.fileName || asset.assetKey }}</span><small>{{ resolveAsset(asset) ? (asset.assetType || asset.mimeType || '素材') : '未下载' }}</small></div></div></section>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, getCurrentInstance, onMounted, reactive, ref, watch } from 'vue'
import { Document, Refresh, RefreshLeft, Search, View } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { getQuestion, getQuestionAsset, listCatalog, listQuestionAssets, listQuestions, listTextbooks, listVersions } from '../../api/bank'
import { sanitizeHtml } from '../../utils/html'
import { useQuestionAssetStore } from '../../utils/assets'
import { createQuestionQuery, resetQuestionState } from '../../utils/state'
import { unwrapList, unwrapPage, unwrapTree } from '../../utils/response'

const query = reactive(createQuestionQuery())
const { proxy } = getCurrentInstance()
const { qb_question_type, qb_difficulty, qb_scene, qb_category, qb_exam_method, qb_answer_status } = proxy.useDict(
  'qb_question_type',
  'qb_difficulty',
  'qb_scene',
  'qb_category',
  'qb_exam_method',
  'qb_answer_status',
)
const versions = ref([])
const textbooks = ref([])
const catalogTree = ref([])
const questions = ref([])
const total = ref(0)
const loadingQuestions = ref(false)
const loadingCatalog = ref(false)
const loadingDetail = ref(false)
const detailVisible = ref(false)
const detail = ref(null)
const assets = ref([])
const assetStore = useQuestionAssetStore(getQuestionAsset)
let detailRequestId = 0
const errorMessage = ref('')
const catalogRef = ref(null)
const treeProps = { label: 'nodeName', children: 'children' }

const catalogCount = computed(() => countNodes(catalogTree.value))
const references = computed(() => Array.isArray(detail.value?.referencePapersJson) ? detail.value.referencePapersJson : [])

function countNodes(nodes) { return nodes.reduce((count, node) => count + 1 + countNodes(Array.isArray(node.children) ? node.children : []), 0) }
function idOf(item, name) { return item?.[name] ?? item?.[name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] }
function rowText(row) { return row?.plainText || row?.sourceText || row?.paperName || '题目内容未采集' }
function safeHtml(value) {
  return sanitizeHtml(value, (key) => {
    const asset = assets.value.find((item) => String(item.assetKey || '') === String(key))
    return assetStore.resolve(asset)
  })
}
function resolveAsset(asset) { return assetStore.resolve(asset) }

async function loadVersions() {
  try {
    const result = await listVersions({ pageNum: 1, pageSize: 100 })
    versions.value = unwrapList(result)
    if (!query.versionId && versions.value.length) query.versionId = idOf(versions.value[0], 'versionId')
    await handleVersionChange(query.versionId)
  } catch (error) {
    errorMessage.value = error?.message || '版本加载失败，请稍后重试'
  }
}

async function handleVersionChange(versionId) {
  resetQuestionState(query, 'version')
  query.versionId = versionId || undefined
  textbooks.value = []
  catalogTree.value = []
  questions.value = []
  total.value = 0
  if (!versionId) return
  try {
    const result = await listTextbooks({ versionId, pageNum: 1, pageSize: 100 })
    textbooks.value = unwrapList(result)
    if (textbooks.value.length) {
      query.textbookId = idOf(textbooks.value[0], 'textbookId')
      await handleTextbookChange(query.textbookId)
    }
  } catch (error) {
    errorMessage.value = error?.message || '教材加载失败，请稍后重试'
  }
}

async function handleTextbookChange(textbookId) {
  resetQuestionState(query, 'textbook')
  query.textbookId = textbookId || undefined
  catalogTree.value = []
  questions.value = []
  total.value = 0
  if (!textbookId) return
  loadingCatalog.value = true
  try {
    const result = await listCatalog({ textbookId })
    catalogTree.value = unwrapTree(result)
  } catch (error) {
    errorMessage.value = error?.message || '目录加载失败，请稍后重试'
  } finally {
    loadingCatalog.value = false
  }
  await loadQuestions()
}

function handleCatalogChange(node) {
  query.catalogId = idOf(node, 'catalogId')
  query.pageNum = 1
  loadQuestions()
}

async function loadQuestions() {
  if (!query.textbookId) { questions.value = []; total.value = 0; return }
  loadingQuestions.value = true
  errorMessage.value = ''
  try {
    const result = await listQuestions({ ...query, textbookId: query.textbookId, versionId: undefined })
    const page = unwrapPage(result)
    questions.value = page.rows
    total.value = page.total
  } catch (error) {
    questions.value = []
    total.value = 0
    errorMessage.value = error?.message || '题目加载失败，请稍后重试'
  } finally {
    loadingQuestions.value = false
  }
}

function searchQuestions() { query.pageNum = 1; loadQuestions() }
function resetFilters() { resetQuestionState(query, 'filters'); loadQuestions() }

async function openDetail(row) {
  const questionId = idOf(row, 'questionId')
  if (questionId === undefined || questionId === null) return
  const requestId = ++detailRequestId
  detailVisible.value = true
  loadingDetail.value = true
  detail.value = null
  assets.value = []
  assetStore.reset()
  try {
    const [questionResult, assetResult] = await Promise.all([getQuestion(questionId), listQuestionAssets(questionId)])
    if (requestId !== detailRequestId) return
    const questionValue = questionResult?.data && !questionResult.questionId ? questionResult.data : questionResult
    detail.value = questionValue?.data && !questionValue.questionId ? questionValue.data : questionValue
    assets.value = unwrapList(assetResult)
    void assetStore.load(questionId, assets.value)
  } catch (error) {
    if (requestId === detailRequestId) ElMessage.error(error?.message || '题目详情加载失败')
  } finally {
    if (requestId === detailRequestId) loadingDetail.value = false
  }
}

watch(detailVisible, (visible) => {
  if (!visible) { detailRequestId += 1; assetStore.reset() }
})
onMounted(loadVersions)
</script>

<style scoped>
.bank-page { min-height: calc(100vh - 84px); color: var(--el-text-color-primary); }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 16px; }
.page-heading h2 { margin: 0; font-size: 20px; font-weight: 600; }
.state-alert { margin-bottom: 14px; }
.context-bar, .catalog-panel, .question-panel { border: 1px solid var(--el-border-color-light); border-radius: 6px; background: var(--el-bg-color); }
.context-bar { padding: 12px 16px 2px; margin-bottom: 14px; }
.context-form, .filter-form { margin: 0; }
.context-form :deep(.el-form-item), .filter-form :deep(.el-form-item) { margin-bottom: 10px; }
.context-select { width: 250px; }
.workspace { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 14px; align-items: start; }
.catalog-panel { min-width: 0; min-height: 480px; padding: 14px 10px; overflow: hidden; }
.panel-title { display: flex; align-items: center; justify-content: space-between; padding: 0 6px 12px; font-size: 15px; font-weight: 600; }
.catalog-panel :deep(.el-tree) { min-width: 0; background: transparent; }
.catalog-panel :deep(.el-tree-node__label) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.question-panel { min-width: 0; padding: 14px; }
.filter-form { display: flex; flex-wrap: wrap; align-items: flex-start; }
.filter-form :deep(.el-form-item__label) { color: var(--el-text-color-secondary); font-size: 12px; }
.filter-form :deep(.el-input), .filter-form :deep(.el-select) { width: 150px; }
.filter-form :deep(.el-input-number) { width: 115px; }
.filter-select { width: 130px !important; }
.tag-select { width: 140px !important; }
.coefficient-range { display: flex; align-items: center; gap: 5px; }
.coefficient-range span { color: var(--el-text-color-secondary); }
.filter-actions { margin-left: auto; }
.question-table { width: 100%; cursor: pointer; }
.question-title { display: flex; gap: 7px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.question-no { flex: none; color: var(--el-color-primary); }
.table-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; }
.result-count { flex: none; color: var(--el-text-color-secondary); font-size: 12px; }
.table-footer :deep(.el-pagination) { flex-wrap: wrap; justify-content: flex-end; }
.detail-content { padding-bottom: 20px; }
.detail-meta { display: flex; flex-wrap: wrap; gap: 8px; padding-bottom: 14px; border-bottom: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); font-size: 13px; }
.detail-meta span { padding-right: 8px; border-right: 1px solid var(--el-border-color); }
.detail-meta span:last-child { border: 0; }
.meta-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 16px; margin: 16px 0 6px; }
.meta-grid div { min-width: 0; }
.meta-grid dt { color: var(--el-text-color-secondary); font-size: 12px; }
.meta-grid dd { margin: 4px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-section { padding-top: 18px; }
.detail-section h3 { margin: 0 0 9px; font-size: 14px; }
.rich-text { overflow-wrap: anywhere; line-height: 1.75; }
.rich-text :deep(img) { max-width: 100%; height: auto; }
.rich-text :deep(.qb-asset-missing) { display: inline-block; padding: 0 4px; border: 1px dashed var(--el-border-color); border-radius: 3px; color: var(--el-text-color-secondary); font-size: 12px; }
.rich-text :deep(table) { max-width: 100%; border-collapse: collapse; }
.rich-text :deep(td), .rich-text :deep(th) { padding: 4px 8px; border: 1px solid var(--el-border-color-light); }
.reference-list { margin: 0; padding-left: 20px; line-height: 1.8; }
.asset-list { display: flex; flex-direction: column; gap: 7px; }
.asset-item { display: flex; align-items: center; gap: 7px; min-height: 34px; padding: 5px 8px; border: 1px solid var(--el-border-color-lighter); border-radius: 4px; color: var(--el-text-color-secondary); }
.asset-item a { color: var(--el-color-primary); text-decoration: none; }
.asset-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-item small { margin-left: auto; color: var(--el-text-color-secondary); }
@media (max-width: 900px) { .workspace { grid-template-columns: 220px minmax(0, 1fr); } .context-select { width: 200px; } .filter-actions { margin-left: 0; } }
@media (max-width: 680px) { .workspace { grid-template-columns: 1fr; } .catalog-panel { min-height: 190px; max-height: 280px; overflow: auto; } .context-select { width: min(100%, 240px); } .context-form :deep(.el-form-item) { display: flex; } .filter-form :deep(.el-form-item) { margin-right: 8px; } .table-footer { align-items: flex-start; flex-direction: column; } .table-footer :deep(.el-pagination) { justify-content: flex-start; } .meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
