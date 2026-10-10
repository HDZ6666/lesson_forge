<template>
  <div class="app-container browse-page">
    <div class="browse-header">
      <h2>教材浏览</h2>
      <el-button link type="primary" :icon="Refresh" :loading="loadingQuestions || loadingCatalog" @click="refreshBrowse">刷新</el-button>
    </div>

    <el-alert v-if="errorMessage" class="state-alert" type="error" :closable="false" show-icon>{{ errorMessage }}</el-alert>

    <div class="workspace">
      <aside class="catalog-panel" :class="{ 'is-mobile-collapsed': mobileCatalogCollapsed }" aria-label="教材目录">
        <SubjectSelect v-model="selectedSubjectId" :include-disabled="false" @change="handleSubjectChange" />
        <div class="book-selectors">
          <el-select
            v-model="selectedVersionId"
            class="book-select"
            placeholder="选择版本"
            clearable
            filterable
            @change="handleVersionChange"
          >
            <el-option v-for="item in versions" :key="item.versionId" :label="item.versionName || '未命名版本'" :value="item.versionId" />
          </el-select>
          <el-icon class="selector-arrow"><ArrowDown /></el-icon>
          <el-select
            v-model="query.textbookId"
            class="book-select"
            placeholder="选择教材"
            clearable
            filterable
            :disabled="!selectedVersionId"
            @change="handleTextbookChange"
          >
            <el-option v-for="item in textbooks" :key="item.textbookId" :label="item.textbookName || '未命名教材'" :value="item.textbookId" />
          </el-select>
        </div>

        <button class="mobile-catalog-toggle" type="button" :aria-expanded="!mobileCatalogCollapsed" @click="mobileCatalogCollapsed = !mobileCatalogCollapsed">
          <span>教材目录</span>
          <el-icon><ArrowDown /></el-icon>
        </button>

        <div class="catalog-tree-wrap">
          <div class="catalog-heading">
            <span>{{ selectedTextbook?.textbookName || '教材目录' }}</span>
            <span class="catalog-count">{{ catalogCount }}</span>
          </div>
          <button
            v-if="query.textbookId"
            class="all-catalog-node"
            :class="{ 'is-current': !query.catalogId }"
            type="button"
            @click="selectAllCatalogs"
          >
            <el-icon><Collection /></el-icon>
            <span>全部目录</span>
          </button>
          <el-skeleton v-if="loadingCatalog" :rows="9" animated />
          <el-empty v-else-if="!query.textbookId" :image-size="52" description="请选择教材" />
          <el-empty v-else-if="!catalogTree.length" :image-size="52" description="暂无目录" />
          <el-tree
            v-else
            ref="catalogRef"
            class="catalog-tree"
            :data="catalogTree"
            node-key="catalogId"
            :props="treeProps"
            :default-expanded-keys="expandedCatalogKeys"
            :current-node-key="query.catalogId"
            highlight-current
            :expand-on-click-node="false"
            @node-click="handleCatalogChange"
          >
            <template #default="{ data }">
              <div class="catalog-node" :title="data.nodeName">
                <span class="catalog-node-name">{{ data.nodeName }}</span>
                <span v-if="data.descendantUsableQuestionCount" class="catalog-node-count">{{ data.descendantUsableQuestionCount }}</span>
              </div>
            </template>
          </el-tree>
        </div>
      </aside>

      <main class="content-panel">
        <nav class="main-tabs" aria-label="教材浏览功能">
          <button class="main-tab is-active" type="button">试题</button>
          <button class="main-tab is-disabled" type="button" disabled title="同步套卷功能尚未接入">同步套卷</button>
          <button class="main-tab is-disabled" type="button" disabled title="上好课功能尚未接入">上好课</button>
        </nav>

        <el-alert v-if="selectedTextbook && (selectedTextbook.uncheckedQuestionCount || selectedTextbook.unusableQuestionCount)"
          class="state-alert" type="info" :closable="false" show-icon>
          仅展示已检查可用题目；当前教材还有 {{ selectedTextbook.uncheckedQuestionCount ?? 0 }} 道待检查、
          {{ selectedTextbook.unusableQuestionCount ?? 0 }} 道检查不通过。后台检查后点击“刷新”查看。
        </el-alert>
        <section class="filter-surface" aria-label="题目筛选">
          <div class="filter-row">
            <span class="filter-label">场景：</span>
            <div class="choice-list">
              <button class="choice-item" :class="{ 'is-active': !query.scene.length }" type="button" @click="selectChoice('scene')">全部</button>
              <button v-for="dict in qb_scene" :key="dict.value" class="choice-item" :class="{ 'is-active': isChoiceActive(query.scene, dict.value) }" type="button" @click="selectChoice('scene', dict.value)">{{ dict.label }}</button>
            </div>
          </div>

          <div class="filter-row">
            <span class="filter-label">题型：</span>
            <div class="choice-list">
              <button class="choice-item" :class="{ 'is-active': !query.questionType }" type="button" @click="selectChoice('questionType')">全部</button>
              <button v-for="dict in qb_question_type" :key="dict.value" class="choice-item" :class="{ 'is-active': query.questionType === dict.value }" type="button" @click="selectChoice('questionType', dict.value)">{{ dict.label }}</button>
            </div>
          </div>

          <div class="filter-row">
            <span class="filter-label">难度：</span>
            <div class="choice-list">
              <button class="choice-item" :class="{ 'is-active': !query.difficulty }" type="button" @click="selectChoice('difficulty')">全部</button>
              <button v-for="dict in qb_difficulty" :key="dict.value" class="choice-item" :class="{ 'is-active': query.difficulty === dict.value }" type="button" @click="selectChoice('difficulty', dict.value)">{{ dict.label }}</button>
            </div>
          </div>

          <div class="filter-row">
            <span class="filter-label">分类：</span>
            <div class="choice-list">
              <button class="choice-item" :class="{ 'is-active': !query.category.length }" type="button" @click="selectChoice('category')">全部</button>
              <button v-for="dict in qb_category" :key="dict.value" class="choice-item" :class="{ 'is-active': isChoiceActive(query.category, dict.value) }" type="button" @click="selectChoice('category', dict.value)">{{ dict.label }}</button>
            </div>
          </div>

          <div class="more-row" :class="{ 'is-open': moreOpen }">
            <button class="more-toggle" type="button" :aria-expanded="moreOpen" @click="moreOpen = !moreOpen">
              <span>更多</span>
              <el-icon><ArrowDown /></el-icon>
            </button>
            <div v-if="moreOpen" class="more-filters">
              <label class="more-field"><span>年份</span><el-input-number v-model="query.year" :min="1900" :max="2200" :controls="false" placeholder="年份" @change="runFilterChange" /></label>
              <label class="more-field"><span>地区</span><el-input v-model="query.province" clearable placeholder="省份或地区" @keyup.enter="runFilterChange" @clear="runFilterChange" /></label>
              <label class="more-field"><span>年级</span><el-select v-model="query.grade" clearable placeholder="年级" @change="runFilterChange"><el-option v-for="dict in qb_grade" :key="dict.value" :label="dict.label" :value="dict.value" /></el-select></label>
              <label class="more-field"><span>学期</span><el-select v-model="query.term" clearable placeholder="学期" @change="runFilterChange"><el-option v-for="dict in qb_term" :key="dict.value" :label="dict.label" :value="dict.value" /></el-select></label>
              <div class="more-field exam-method-field"><span>考法</span><div class="compact-choice-list"><button v-for="dict in qb_exam_method" :key="dict.value" class="compact-choice" :class="{ 'is-active': isChoiceActive(query.examMethod, dict.value) }" type="button" @click="toggleChoice('examMethod', dict.value)">{{ dict.label }}</button></div></div>
              <el-tooltip content="题目列表接口当前未提供 isFresh 筛选字段" placement="top">
                <label class="fresh-filter"><el-checkbox :model-value="false" disabled>只看新题</el-checkbox></label>
              </el-tooltip>
            </div>
          </div>
        </section>

        <section class="result-toolbar">
          <div class="sort-tabs" role="tablist" aria-label="题目排序">
            <button v-for="sort in sortOptions" :key="sort.key" class="sort-tab" :class="{ 'is-active': activeSort === sort.key }" type="button" role="tab" :aria-selected="activeSort === sort.key" @click="changeSort(sort.key)">{{ sort.label }}</button>
          </div>
          <el-input v-model="query.keyword" class="keyword-input" clearable placeholder="在结果中搜索" :prefix-icon="Search" @keyup.enter="searchQuestions" @clear="searchQuestions" />
          <span class="total-count">共 <strong>{{ total }}</strong> 道试题</span>
        </section>

        <section class="question-results">
          <el-skeleton v-if="loadingQuestions" :rows="8" animated />
          <el-empty v-else-if="!query.textbookId" :image-size="66" description="请先选择教材" />
          <el-empty v-else-if="!questions.length" :image-size="66" description="没有符合条件的题目" />
          <div v-else class="question-feed">
            <article v-for="row in questions" :key="row.questionId" class="question-item">
              <div class="question-head">
                <div class="source-line">
                  <span v-if="row.sourceQuestionNo" class="question-no">{{ row.sourceQuestionNo }}</span>
                  <span class="paper-name">{{ row.paperName || row.sourceText || row.sourceProvider || '来源未采集' }}</span>
                  <el-tag v-if="row.isFresh === 'Y'" size="small" type="danger">新题</el-tag>
                </div>
                <el-button link type="primary" :icon="View" title="查看详情" aria-label="查看详情" @click="openDetail(row)">详情</el-button>
              </div>
              <div class="question-meta">
                <span v-if="row.questionType">{{ row.questionType }}</span>
                <span v-if="row.difficulty">{{ row.difficulty }}</span>
                <span v-if="row.difficultyCoefficient !== null && row.difficultyCoefficient !== undefined">系数 {{ row.difficultyCoefficient }}</span>
                <span v-if="row.year">{{ row.year }}年</span>
                <span v-if="row.province">{{ row.province }}</span>
              </div>
              <div class="question-content rich-text" v-html="safeListHtml(row)" />
              <div v-if="questionTags(row).length" class="question-tags"><el-tag v-for="tag in questionTags(row)" :key="tag" size="small" effect="plain">{{ tag }}</el-tag></div>
              <div class="question-foot">
                <span v-if="row.websiteTimeText || row.externalUpdatedAt">{{ row.websiteTimeText || row.externalUpdatedAt }}</span>
                <span v-if="row.assembleCount !== null && row.assembleCount !== undefined">{{ row.assembleCount }}次组卷</span>
                <span v-if="row.referenceCount !== null && row.referenceCount !== undefined">{{ row.referenceCount }}条引用</span>
                <span v-if="row.score !== null && row.score !== undefined">{{ row.score }}分</span>
              </div>
            </article>
          </div>
        </section>

        <div v-if="query.textbookId" class="pagination-bar">
          <span class="pagination-summary">第 {{ total ? (query.pageNum - 1) * query.pageSize + 1 : 0 }}-{{ Math.min(query.pageNum * query.pageSize, total) }} 题</span>
          <el-pagination v-model:current-page="query.pageNum" v-model:page-size="query.pageSize" :total="total" :page-sizes="[10, 20, 50]" layout="sizes, prev, pager, next" background @size-change="loadQuestions" @current-change="loadQuestions" />
        </div>
      </main>
    </div>

    <el-drawer v-model="detailVisible" class="detail-scroll-drawer" title="题目详情" direction="rtl" size="min(720px, 92vw)" append-to-body>
      <el-alert v-if="detailError" type="error" :closable="false" show-icon>{{ detailError }}</el-alert>
      <el-skeleton v-if="loadingDetail" :rows="10" animated />
      <el-empty v-else-if="!detail" description="未找到题目" />
      <div v-else class="detail-content">
        <div class="detail-meta">
          <span v-if="detail.questionType">{{ detail.questionType }}</span>
          <span v-if="detail.difficulty">{{ detail.difficulty }}</span>
          <span v-if="detail.difficultyCoefficient !== null && detail.difficultyCoefficient !== undefined">系数 {{ detail.difficultyCoefficient }}</span>
          <span v-if="detail.year">{{ detail.year }}年</span>
          <span v-if="detail.province">{{ detail.province }}</span>
        </div>
        <dl class="meta-grid">
          <div><dt>来源试卷</dt><dd>{{ detail.paperName || detail.sourceText || '未采集' }}</dd></div>
          <div><dt>来源题号</dt><dd>{{ detail.sourceQuestionNo || '未采集' }}</dd></div>
          <div><dt>答案状态</dt><dd>{{ detail.answerStatus || 'unknown' }}</dd></div>
          <div><dt>组卷次数</dt><dd>{{ detail.assembleCount ?? '未采集' }}</dd></div>
          <div><dt>引用次数</dt><dd>{{ detail.referenceCount ?? '未采集' }}</dd></div>
          <div><dt>分值</dt><dd>{{ detail.score ?? '未采集' }}</dd></div>
        </dl>
        <section class="detail-section"><h3>题干</h3><div class="rich-text" v-html="safeDetailHtml(detail.contentHtml || detail.plainText)" /></section>
        <section v-if="detail.answerHtml" class="detail-section"><h3>答案</h3><div class="rich-text" v-html="safeDetailHtml(detail.answerHtml)" /></section>
        <section v-if="detail.analysisHtml" class="detail-section"><h3>解析</h3><div class="rich-text" v-html="safeDetailHtml(detail.analysisHtml)" /></section>
        <section class="detail-section"><h3>引用试卷</h3><el-empty v-if="!references.length" :image-size="48" description="暂无引用记录" /><ul v-else class="reference-list"><li v-for="(paper, index) in references" :key="paper.id || paper.paperId || index">{{ paper.paperName || paper.name || paper.title || paper }}</li></ul></section>
        <section class="detail-section"><h3>素材</h3><el-empty v-if="!assets.length" :image-size="48" description="暂无素材" /><div v-else class="asset-list"><div v-for="asset in assets" :key="asset.assetKey" class="asset-item"><el-icon><Document /></el-icon><a v-if="resolveAsset(asset)" :href="resolveAsset(asset)" target="_blank" rel="noopener noreferrer">{{ asset.fileName || asset.assetKey }}</a><span v-else>{{ asset.fileName || asset.assetKey }}</span><small>{{ assetStore.label(asset) }}</small><el-button v-if="assetStore.state(asset).status === 'failed'" link type="primary" @click="assetStore.retry(asset)">重试加载</el-button></div></div></section>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import SubjectSelect from "../../components/SubjectSelect.vue"
import { computed, getCurrentInstance, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { ArrowDown, Collection, Document, Refresh, Search, View } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { getQuestion, getQuestionAsset, getTextbook, listCatalog, listQuestionAssets, listQuestions, listTextbooks, listVersions } from '../../api/bank'
import { sanitizeHtml } from '../../utils/html'
import { useQuestionAssetStore } from '../../utils/assets'
import { unwrapList, unwrapPage, unwrapResponse, unwrapTree } from '../../utils/response'
import {
  applyBrowseSort,
  buildBrowseQuery,
  catalogNodeCount,
  createBrowseQuery,
  firstCatalogId,
  getBrowseId,
  isSelectedChoice,
  resetBrowseFilters,
  setSingleChoice,
  sortPresetFor,
} from '../../utils/browse'

const query = reactive(createBrowseQuery())
const { proxy } = getCurrentInstance()
const {
  qb_category,
  qb_difficulty,
  qb_exam_method,
  qb_grade,
  qb_question_type,
  qb_scene,
  qb_term,
} = proxy.useDict('qb_category', 'qb_difficulty', 'qb_exam_method', 'qb_grade', 'qb_question_type', 'qb_scene', 'qb_term')

let versionsReadRevision = 0
let textbooksReadRevision = 0
let catalogsReadRevision = 0
const versions = ref([])
const textbooks = ref([])
const catalogTree = ref([])
const questions = ref([])
const total = ref(0)
const selectedSubjectId = ref(undefined)
const selectedVersionId = ref(undefined)
const loadingCatalog = ref(false)
const loadingQuestions = ref(false)
const loadingDetail = ref(false)
const detailVisible = ref(false)
const detail = ref(null)
const assets = ref([])
const assetStore = useQuestionAssetStore(getQuestionAsset)
const errorMessage = ref('')
const detailError = ref('')
const moreOpen = ref(false)
const mobileCatalogCollapsed = ref(false)
const catalogRef = ref(null)
const expandedCatalogKeys = ref([])
const questionRequestId = ref(0)
const detailRequestId = ref(0)

const treeProps = { label: 'nodeName', children: 'children' }
const sortOptions = [
  { key: 'comprehensive', label: '综合' },
  { key: 'latest', label: '最新' },
  { key: 'hottest', label: '最热' },
]
const activeSort = computed(() => sortPresetFor(query))
const catalogCount = computed(() => catalogNodeCount(catalogTree.value))
const selectedTextbook = computed(() => textbooks.value.find((item) => String(getBrowseId(item, 'textbookId')) === String(query.textbookId)))
const references = computed(() => (Array.isArray(detail.value?.referencePapersJson) ? detail.value.referencePapersJson : []))

function idOf(item, name) {
  return getBrowseId(item, name)
}

function isChoiceActive(values, value) {
  return isSelectedChoice(value, values)
}

function setError(error, fallback) {
  errorMessage.value = error?.message || fallback
}

function selectChoice(field, value) {
  if (field === 'scene' || field === 'category') {
    setSingleChoice(query, field, value)
  } else {
    query[field] = value
    query.pageNum = 1
  }
  loadQuestions()
}

function toggleChoice(field, value) {
  const values = Array.isArray(query[field]) ? [...query[field]] : []
  const index = values.findIndex((item) => String(item) === String(value))
  if (index >= 0) values.splice(index, 1)
  else values.push(value)
  query[field] = values
  query.pageNum = 1
  loadQuestions()
}

function runFilterChange() {
  query.pageNum = 1
  loadQuestions()
}

async function handleSubjectChange() {
  versionsReadRevision += 1
  versions.value = []
  await handleVersionChange(undefined)
  await loadVersions()
}

async function loadVersions() {
  const revision = ++versionsReadRevision
  loadingQuestions.value = true
  try {
    const result = await listVersions({ subjectId: selectedSubjectId.value, pageNum: 1, pageSize: 100, status: '0' })
    if (revision !== versionsReadRevision) return
    versions.value = unwrapList(result)
    if (versions.value.length) await handleVersionChange(idOf(versions.value[0], 'versionId'))
  } catch (error) {
    if (revision === versionsReadRevision) setError(error, '版本加载失败，请稍后重试')
  } finally {
    if (revision === versionsReadRevision) loadingQuestions.value = false
  }
}

async function handleVersionChange(versionId) {
  const revision = ++textbooksReadRevision
  catalogsReadRevision += 1; questionRequestId.value += 1
  loadingCatalog.value = false; loadingQuestions.value = false
  selectedVersionId.value = versionId || undefined
  resetBrowseFilters(query); query.textbookId = undefined
  textbooks.value = []; catalogTree.value = []; expandedCatalogKeys.value = []
  questions.value = []; total.value = 0
  if (!versionId) return
  try {
    const result = await listTextbooks({ versionId, pageNum: 1, pageSize: 100, status: '0' })
    if (revision !== textbooksReadRevision) return
    textbooks.value = unwrapList(result)
    if (textbooks.value.length) await handleTextbookChange(idOf(textbooks.value[0], 'textbookId'))
  } catch (error) {
    if (revision === textbooksReadRevision) setError(error, '教材加载失败，请稍后重试')
  }
}

async function refreshBrowse() {
  const textbookId = query.textbookId
  if (!textbookId) return loadQuestions()
  const revision = ++catalogsReadRevision
  loadingCatalog.value = true
  const reloadCoverage = async () => {
    try {
      const [bookResult, treeResult] = await Promise.all([getTextbook(textbookId), listCatalog({ textbookId })])
      if (revision !== catalogsReadRevision || query.textbookId !== textbookId) return
      const book = unwrapResponse(bookResult)
      textbooks.value = textbooks.value.map((item) => String(idOf(item, 'textbookId')) === String(textbookId) ? book : item)
      catalogTree.value = unwrapTree(treeResult)
    } catch (error) {
      if (revision === catalogsReadRevision) setError(error, '教材覆盖刷新失败，请稍后重试')
    } finally {
      if (revision === catalogsReadRevision) loadingCatalog.value = false
    }
  }
  await Promise.all([reloadCoverage(), loadQuestions()])
}

async function handleTextbookChange(textbookId) {
  const revision = ++catalogsReadRevision
  questionRequestId.value += 1; loadingQuestions.value = false
  resetBrowseFilters(query); query.textbookId = textbookId || undefined
  catalogTree.value = []; expandedCatalogKeys.value = []; questions.value = []; total.value = 0
  if (!textbookId) { loadingCatalog.value = false; return }
  loadingCatalog.value = true; errorMessage.value = ''
  try {
    const result = await listCatalog({ textbookId })
    if (revision !== catalogsReadRevision) return
    catalogTree.value = unwrapTree(result)
    const rootId = firstCatalogId(catalogTree.value)
    expandedCatalogKeys.value = rootId === undefined ? [] : [rootId]
    query.catalogId = undefined
    await nextTick()
    if (revision !== catalogsReadRevision) return
    catalogRef.value?.setCurrentKey(undefined)
  } catch (error) {
    if (revision !== catalogsReadRevision) return
    setError(error, '目录加载失败，请稍后重试')
  } finally {
    if (revision === catalogsReadRevision) loadingCatalog.value = false
  }
  if (revision === catalogsReadRevision) await loadQuestions()
}

function handleCatalogChange(node) {
  query.catalogId = idOf(node, 'catalogId')
  query.pageNum = 1
  loadQuestions()
}

function selectAllCatalogs() {
  query.catalogId = undefined
  query.pageNum = 1
  catalogRef.value?.setCurrentKey(undefined)
  loadQuestions()
}

async function loadQuestions() {
  if (!query.textbookId) {
    questions.value = []
    total.value = 0
    return
  }
  const requestId = ++questionRequestId.value
  loadingQuestions.value = true
  errorMessage.value = ''
  try {
    const result = await listQuestions(buildBrowseQuery(query))
    if (requestId !== questionRequestId.value) return
    const page = unwrapPage(result)
    questions.value = page.rows
    total.value = page.total
  } catch (error) {
    if (requestId !== questionRequestId.value) return
    questions.value = []
    total.value = 0
    setError(error, '题目加载失败，请稍后重试')
  } finally {
    if (requestId === questionRequestId.value) loadingQuestions.value = false
  }
}

function searchQuestions() {
  query.pageNum = 1
  loadQuestions()
}

function changeSort(sortKey) {
  applyBrowseSort(query, sortKey)
  loadQuestions()
}

function safeListHtml(row) {
  return sanitizeHtml(row?.contentHtml || row?.plainText || '题目内容未采集', () => '')
}

function safeDetailHtml(value) {
  return sanitizeHtml(value, (key) => {
    const asset = assets.value.find((item) => String(item.assetKey || '') === String(key))
    return assetStore.resolve(asset)
  })
}

function resolveAsset(asset) {
  return assetStore.resolve(asset)
}

function questionTags(row) {
  const values = Array.isArray(row?.knowledge) ? row.knowledge : Array.isArray(row?.tags) ? row.tags : Array.isArray(row?.tagList) ? row.tagList : []
  return values.map((item) => typeof item === 'string' ? item : item?.name || item?.tagName).filter(Boolean)
}

function entityFromResponse(result) {
  const value = unwrapResponse(result)
  return unwrapResponse(value)
}

async function openDetail(row) {
  const questionId = idOf(row, 'questionId')
  if (questionId === undefined || questionId === null) return
  const requestId = ++detailRequestId.value
  detailVisible.value = true
  loadingDetail.value = true
  detailError.value = ''
  detail.value = null
  assets.value = []
  assetStore.reset()
  try {
    const [questionResult, assetResult] = await Promise.all([getQuestion(questionId), listQuestionAssets(questionId)])
    if (requestId !== detailRequestId.value) return
    detail.value = entityFromResponse(questionResult)
    assets.value = unwrapList(assetResult)
    void assetStore.load(questionId, assets.value)
  } catch (error) {
    if (requestId !== detailRequestId.value) return
    detailError.value = error?.message || '题目详情加载失败'
    ElMessage.error(detailError.value)
  } finally {
    if (requestId === detailRequestId.value) loadingDetail.value = false
  }
}

watch(detailVisible, (visible) => {
  if (!visible) { detailRequestId.value += 1; assetStore.reset() }
})
onMounted(loadVersions)
</script>

<style scoped>
.browse-page { box-sizing: border-box; min-width: 0; min-height: calc(100vh - 84px); overflow-x: hidden; color: var(--el-text-color-primary); background: #f4f5f7; }
.browse-header { display: flex; align-items: flex-start; justify-content: space-between; margin: -4px 0 12px; }
.browse-header h2 { margin: 0; font-size: 20px; font-weight: 600; }
.state-alert { margin-bottom: 12px; }
.workspace { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-width: 0; align-items: start; border: 1px solid #e5e7eb; background: var(--el-bg-color); }
.catalog-panel { min-width: 0; min-height: 700px; border-right: 1px solid #e5e7eb; background: #fff; }
.book-selectors { display: flex; align-items: center; gap: 3px; padding: 12px 10px; border-bottom: 1px solid #edf0f4; }
.book-select { min-width: 0; flex: 1; }
.book-select :deep(.el-input__wrapper) { padding: 1px 8px; box-shadow: none; }
.selector-arrow { flex: none; color: var(--el-color-primary); font-size: 12px; }
.catalog-tree-wrap { padding: 12px 8px 20px; }
.catalog-heading { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin: 0 4px 9px; color: var(--el-text-color-secondary); font-size: 12px; }
.catalog-heading > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-count { flex: none; color: var(--el-color-primary); }
.all-catalog-node { display: flex; align-items: center; width: 100%; height: 34px; margin-bottom: 2px; padding: 0 9px; gap: 7px; border: 0; border-radius: 3px; color: var(--el-text-color-primary); background: transparent; font-size: 13px; text-align: left; cursor: pointer; }
.all-catalog-node:hover { background: #f3f7ff; }
.all-catalog-node.is-current { color: var(--el-color-primary); background: #edf4ff; font-weight: 600; }
.catalog-tree { min-width: 0; background: transparent; }
.catalog-tree :deep(.el-tree-node__content) { min-width: 0; height: 34px; padding-right: 5px; border-radius: 3px; }
.catalog-tree :deep(.el-tree-node__content:hover) { background: #f3f7ff; }
.catalog-tree :deep(.is-current > .el-tree-node__content) { color: var(--el-color-primary); background: #edf4ff; }
.catalog-node { display: flex; align-items: center; min-width: 0; width: 100%; gap: 6px; font-size: 13px; }
.catalog-node-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-node-count { flex: none; color: var(--el-text-color-placeholder); font-size: 11px; }
.mobile-catalog-toggle { display: none; }
.content-panel { min-width: 0; overflow: hidden; background: #fff; }
.main-tabs { display: flex; align-items: stretch; height: 52px; padding: 0 20px; border-bottom: 1px solid #edf0f4; }
.main-tab { position: relative; margin-right: 30px; padding: 0 8px; border: 0; color: var(--el-text-color-primary); background: transparent; font-size: 15px; cursor: pointer; }
.main-tab.is-active { color: var(--el-color-primary); font-weight: 600; }
.main-tab.is-active::after { position: absolute; right: 7px; bottom: 0; left: 7px; height: 3px; border-radius: 3px 3px 0 0; background: var(--el-color-primary); content: ''; }
.main-tab.is-disabled { color: var(--el-text-color-placeholder); cursor: not-allowed; }
.filter-surface { margin: 0 20px; border-bottom: 1px solid #edf0f4; }
.filter-row { display: flex; min-width: 0; padding: 10px 0; border-bottom: 1px dashed #eef0f3; }
.filter-row:last-of-type { border-bottom: 0; }
.filter-label { flex: none; width: 47px; padding-top: 3px; color: var(--el-text-color-secondary); font-size: 13px; }
.choice-list { display: flex; flex-wrap: wrap; min-width: 0; gap: 2px 7px; }
.choice-item, .compact-choice { padding: 3px 8px; border: 0; border-radius: 2px; color: var(--el-text-color-primary); background: transparent; font-size: 13px; line-height: 22px; cursor: pointer; }
.choice-item:hover, .compact-choice:hover { color: var(--el-color-primary); }
.choice-item.is-active, .compact-choice.is-active { color: var(--el-color-primary); background: #edf4ff; font-weight: 600; }
.more-row { display: flex; min-width: 0; padding: 10px 0; }
.more-toggle { display: inline-flex; flex: none; align-items: center; gap: 3px; width: 47px; padding: 3px 0; border: 0; color: var(--el-text-color-secondary); background: transparent; font-size: 13px; cursor: pointer; }
.more-toggle .el-icon { transition: transform .2s ease; }
.more-row.is-open .more-toggle .el-icon { transform: rotate(180deg); }
.more-filters { display: flex; flex-wrap: wrap; align-items: center; min-width: 0; gap: 10px 14px; }
.more-field { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--el-text-color-secondary); font-size: 13px; }
.more-field :deep(.el-input), .more-field :deep(.el-input-number), .more-field :deep(.el-select) { width: 122px; }
.more-field :deep(.el-input__wrapper), .more-field :deep(.el-select .el-input__wrapper) { box-shadow: 0 0 0 1px #dcdfe6 inset; }
.exam-method-field { align-items: flex-start; }
.compact-choice-list { display: flex; flex-wrap: wrap; gap: 1px; max-width: 400px; }
.compact-choice { padding: 1px 6px; line-height: 20px; }
.fresh-filter { color: var(--el-text-color-placeholder); cursor: not-allowed; }
.result-toolbar { display: flex; align-items: center; min-width: 0; gap: 17px; margin: 12px 20px 0; padding: 8px 0; border-bottom: 1px solid #edf0f4; }
.sort-tabs { display: flex; flex: none; align-items: center; gap: 20px; }
.sort-tab { padding: 4px 0; border: 0; color: var(--el-text-color-secondary); background: transparent; font-size: 13px; cursor: pointer; }
.sort-tab.is-active { color: var(--el-color-primary); font-weight: 600; }
.keyword-input { width: min(220px, 28vw); margin-left: auto; }
.keyword-input :deep(.el-input__wrapper) { box-shadow: 0 0 0 1px #e2e5ea inset; }
.total-count { flex: none; color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; }
.total-count strong { color: var(--el-color-danger); font-weight: 600; }
.question-results { min-width: 0; padding: 0 20px; }
.question-feed { min-width: 0; }
.question-item { min-width: 0; padding: 17px 0 14px; border-bottom: 1px solid #edf0f4; }
.question-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-width: 0; }
.source-line { display: flex; align-items: center; min-width: 0; gap: 7px; color: var(--el-color-primary); font-size: 13px; }
.question-no { flex: none; color: var(--el-color-primary); }
.paper-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.question-head :deep(.el-button) { flex: none; padding: 0; }
.question-meta { display: flex; flex-wrap: wrap; gap: 0; margin: 9px 0 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.question-meta span { padding: 0 9px; border-right: 1px solid #dfe3e8; }
.question-meta span:first-child { padding-left: 0; }
.question-meta span:last-child { border-right: 0; }
.question-content { max-height: 132px; overflow: hidden; color: #303133; font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; }
.rich-text :deep(p) { margin: 0 0 6px; }
.rich-text :deep(p:last-child) { margin-bottom: 0; }
.rich-text :deep(img) { max-width: 100%; height: auto; }
.rich-text :deep(table) { max-width: 100%; border-collapse: collapse; }
.rich-text :deep(td), .rich-text :deep(th) { padding: 3px 7px; border: 1px solid var(--el-border-color-light); }
.rich-text :deep(.qb-asset-missing) { display: inline-block; padding: 0 4px; border: 1px dashed var(--el-border-color); border-radius: 3px; color: var(--el-text-color-secondary); font-size: 12px; }
.question-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
.question-foot { display: flex; flex-wrap: wrap; gap: 0; margin-top: 11px; color: var(--el-text-color-placeholder); font-size: 12px; }
.question-foot span { padding: 0 9px; border-right: 1px solid #e1e4e8; }
.question-foot span:first-child { padding-left: 0; }
.question-foot span:last-child { border-right: 0; }
.pagination-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 20px 16px; }
.pagination-summary { flex: none; color: var(--el-text-color-secondary); font-size: 12px; }
.pagination-bar :deep(.el-pagination) { flex-wrap: wrap; justify-content: flex-end; }
.detail-content { padding-bottom: 20px; }
.detail-meta { display: flex; flex-wrap: wrap; gap: 8px; padding-bottom: 14px; border-bottom: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); font-size: 13px; }
.detail-meta span { padding-right: 8px; border-right: 1px solid var(--el-border-color); }
.detail-meta span:last-child { border: 0; }
.meta-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 11px 16px; margin: 16px 0 6px; }
.meta-grid div { min-width: 0; }
.meta-grid dt { color: var(--el-text-color-secondary); font-size: 12px; }
.meta-grid dd { margin: 4px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-section { padding-top: 18px; }
.detail-section h3 { margin: 0 0 9px; font-size: 14px; }
.detail-section .rich-text { overflow-wrap: anywhere; line-height: 1.75; }
.reference-list { margin: 0; padding-left: 20px; line-height: 1.8; }
.asset-list { display: flex; flex-direction: column; gap: 7px; }
.asset-item { display: flex; align-items: center; min-height: 34px; gap: 7px; padding: 5px 8px; border: 1px solid var(--el-border-color-lighter); border-radius: 4px; color: var(--el-text-color-secondary); }
.asset-item a { color: var(--el-color-primary); text-decoration: none; }
.asset-item span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-item small { margin-left: auto; color: var(--el-text-color-secondary); }
@media (max-width: 1100px) { .more-filters { gap: 8px 10px; } .filter-surface, .result-toolbar, .question-results { margin-right: 14px; margin-left: 14px; } .question-results { padding-right: 0; padding-left: 0; } .result-toolbar { gap: 12px; } }
@media (max-width: 760px) {
  .browse-page { padding-right: 10px; padding-left: 10px; }
  .workspace { display: block; }
  .catalog-panel { min-height: 0; border-right: 0; border-bottom: 1px solid #e5e7eb; }
  .book-selectors { padding: 9px 8px; }
  .mobile-catalog-toggle { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 9px 12px; border: 0; border-top: 1px solid #f1f2f4; color: var(--el-text-color-secondary); background: #fafbfc; font-size: 13px; cursor: pointer; }
  .catalog-panel.is-mobile-collapsed .mobile-catalog-toggle .el-icon { transform: rotate(-90deg); }
  .catalog-panel.is-mobile-collapsed .catalog-tree-wrap { display: none; }
  .catalog-tree-wrap { max-height: 300px; overflow: auto; padding: 9px 8px 12px; }
  .main-tabs { padding: 0 12px; }
  .main-tab { margin-right: 15px; padding: 0 5px; font-size: 14px; }
  .filter-surface { margin-right: 12px; margin-left: 12px; }
  .filter-row { align-items: flex-start; }
  .filter-label, .more-toggle { width: 43px; }
  .choice-list { gap: 2px 4px; }
  .choice-item { padding-right: 6px; padding-left: 6px; }
  .more-filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: calc(100% - 43px); gap: 9px; }
  .more-field { align-items: flex-start; flex-direction: column; gap: 3px; }
  .more-field :deep(.el-input), .more-field :deep(.el-input-number), .more-field :deep(.el-select) { width: 100%; }
  .exam-method-field { grid-column: 1 / -1; }
  .compact-choice-list { max-width: none; }
  .fresh-filter { align-self: center; }
  .result-toolbar { flex-wrap: wrap; margin-right: 12px; margin-left: 12px; }
  .keyword-input { order: 3; width: 100%; margin-left: 0; }
  .total-count { margin-left: auto; }
  .question-results { margin-right: 12px; margin-left: 12px; }
  .question-item { padding-top: 14px; }
  .pagination-bar { align-items: flex-start; flex-direction: column; padding-right: 12px; padding-left: 12px; }
  .pagination-bar :deep(.el-pagination) { justify-content: flex-start; }
  .meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 420px) { .book-selectors { align-items: stretch; flex-direction: column; } .selector-arrow { display: none; } .more-filters { grid-template-columns: 1fr; } .exam-method-field { grid-column: auto; } .fresh-filter { align-self: start; } }
</style>
