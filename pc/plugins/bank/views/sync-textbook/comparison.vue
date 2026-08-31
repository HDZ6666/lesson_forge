<template>
  <div class="sync-textbook-page">
    <header class="page-heading">
      <div class="heading-copy">
        <h2>{{ heading }}</h2>
        <p>{{ description }}</p>
      </div>
      <el-button type="primary" :icon="Refresh" :loading="loading" @click="loadOverview">刷新</el-button>
    </header>

    <div class="overview-meta">
      <span v-if="overview.metadataRunId">本次抓取任务：{{ overview.metadataRunId }}</span>
      <span v-if="overview.collectedAt">抓取时间：{{ formatCollectedAt(overview.collectedAt) }}</span>
      <span v-if="!overview.metadataRunId && !overview.collectedAt">尚未加载抓取快照</span>
    </div>

    <el-alert v-if="errorMessage" class="state-alert" type="error" :closable="false" show-icon>{{ errorMessage }}</el-alert>
    <el-alert v-if="overview.sourceAvailable === false" class="state-alert" type="warning" :closable="false" show-icon>
      {{ overview.sourceMessage || '当前没有可用的本次抓取快照，请先在同步中心刷新版本与教材。' }}
    </el-alert>
    <el-alert v-if="selectionNotice.text" class="state-alert selection-alert" :type="selectionNotice.type" show-icon @close="clearSelectionNotice">
      {{ selectionNotice.text }}
    </el-alert>

    <section class="summary-strip" aria-label="同步教材统计">
      <div class="summary-card source-summary">
        <span class="summary-label">本次抓取</span>
        <strong>{{ summary.fetchedVersionCount }} 个版本 · {{ summary.fetchedTextbookCount }} 本教材</strong>
        <small>新增 {{ summary.newVersionCount }} 个版本 / {{ summary.newTextbookCount }} 本教材</small>
      </div>
      <div class="summary-card existing-summary">
        <span class="summary-label">本次已有</span>
        <strong>{{ summary.existingVersionCount }} 个版本 · {{ summary.existingTextbookCount }} 本教材</strong>
        <small>按来源提供方和外部 ID 精确匹配当前数据</small>
      </div>
      <div class="summary-card current-summary">
        <span class="summary-label">当前数据</span>
        <strong>{{ summary.currentVersionCount }} 个版本 · {{ summary.currentTextbookCount }} 本教材</strong>
        <small>右侧展示全部正式版本与教材</small>
      </div>
    </section>

    <section class="overview-grid" aria-label="版本与教材对比">
      <section class="overview-pane source-pane" aria-labelledby="fetched-title">
        <div class="pane-heading">
          <div>
            <h3 id="fetched-title">本次抓取</h3>
            <p>完整展示最近一次抓取结果，点击已有项可定位右侧对应数据。</p>
          </div>
          <span class="pane-count">{{ filteredFetchedVersions.length }} / {{ overview.fetchedVersions.length }} 个版本</span>
        </div>
        <div class="pane-toolbar">
          <el-radio-group v-model="sourceFilter.status" size="small" aria-label="抓取差异筛选">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="new">新增</el-radio-button>
            <el-radio-button value="existing">已有</el-radio-button>
          </el-radio-group>
          <el-input v-model="sourceFilter.keyword" clearable :prefix-icon="Search" placeholder="搜索版本或教材" aria-label="搜索本次抓取的版本或教材" />
          <div class="pane-actions">
            <el-button link size="small" @click="expandAllSource">展开全部</el-button>
            <el-button link size="small" @click="collapseAllSource">收起全部</el-button>
          </div>
        </div>

        <div ref="sourceScrollEl" class="tree-scroll" v-loading="loading">
          <template v-if="filteredFetchedVersions.length">
            <article
              v-for="version in filteredFetchedVersions"
              :id="sourceVersionDomId(version)"
              :key="sourceVersionKey(version)"
              class="version-card"
              :class="{ 'is-new': isNew(version.matchStatus) }"
            >
              <button class="version-row" type="button" :aria-expanded="isSourceExpanded(version)" @click="handleFetchedVersionClick(version)">
                <el-icon class="expand-icon" :class="{ 'is-expanded': isSourceExpanded(version) }"><ArrowRight /></el-icon>
                <span class="version-main">
                  <strong>{{ version.versionName || '未命名版本' }}</strong>
                  <small>{{ version.sourceProvider || '未知来源' }}<span v-if="version.externalId"> · ID {{ version.externalId }}</span></small>
                </span>
                <span class="version-count">{{ version.textbookCount }} 本教材</span>
                <el-tag size="small" :type="matchTagType(version.matchStatus)">{{ matchLabel(version.matchStatus) }}</el-tag>
              </button>
              <div v-if="isSourceExpanded(version)" class="textbook-list">
                <button
                  v-for="textbook in version.textbooks"
                  :id="sourceTextbookDomId(version, textbook)"
                  :key="sourceTextbookKey(version, textbook)"
                  class="textbook-row"
                  :class="{ 'is-new': isNew(textbook.matchStatus) }"
                  type="button"
                  @click="handleFetchedTextbookClick(version, textbook)"
                >
                  <span class="book-dot" aria-hidden="true"></span>
                  <span class="textbook-main">
                    <strong>{{ textbook.textbookName || '未命名教材' }}</strong>
                    <small>{{ textbookMeta(textbook) }}</small>
                  </span>
                  <el-tag size="small" :type="matchTagType(textbook.matchStatus)">{{ matchLabel(textbook.matchStatus) }}</el-tag>
                </button>
                <div v-if="!version.textbooks.length" class="nested-empty">该版本暂无教材</div>
              </div>
            </article>
          </template>
          <el-empty v-else :image-size="72" :description="overview.fetchedVersions.length ? '暂无符合筛选条件的抓取数据' : '暂无本次抓取快照'" />
        </div>
      </section>

      <section class="overview-pane current-pane" aria-labelledby="current-title">
        <div class="pane-heading">
          <div>
            <h3 id="current-title">当前数据</h3>
            <p>完整展示当前正式版本与教材，仅用于核对结构和数量。</p>
          </div>
          <span class="pane-count">{{ filteredCurrentVersions.length }} / {{ overview.currentVersions.length }} 个版本</span>
        </div>
        <div class="pane-toolbar current-toolbar">
          <el-input v-model="currentFilter.keyword" clearable :prefix-icon="Search" placeholder="搜索当前版本或教材" aria-label="搜索当前版本或教材" />
          <div class="pane-actions">
            <el-button link size="small" @click="expandAllCurrent">展开全部</el-button>
            <el-button link size="small" @click="collapseAllCurrent">收起全部</el-button>
          </div>
        </div>

        <div ref="currentScrollEl" class="tree-scroll" v-loading="loading">
          <template v-if="filteredCurrentVersions.length">
            <article
              v-for="version in filteredCurrentVersions"
              :id="currentVersionDomId(version)"
              :key="currentVersionKey(version)"
              class="version-card current-version-card"
            >
              <button class="version-row" type="button" :aria-expanded="isCurrentExpanded(version)" @click="toggleCurrentVersion(version)">
                <el-icon class="expand-icon" :class="{ 'is-expanded': isCurrentExpanded(version) }"><ArrowRight /></el-icon>
                <span class="version-main">
                  <strong>{{ version.versionName || '未命名版本' }}</strong>
                  <small>{{ version.sourceProvider || '未知来源' }}<span v-if="version.externalId"> · ID {{ version.externalId }}</span></small>
                </span>
                <span class="version-count">{{ version.textbookCount }} 本教材</span>
              </button>
              <div v-if="isCurrentExpanded(version)" class="textbook-list">
                <div
                  v-for="textbook in version.textbooks"
                  :id="currentTextbookDomId(version, textbook)"
                  :key="currentTextbookKey(version, textbook)"
                  class="textbook-row current-textbook-row"
                >
                  <span class="book-dot" aria-hidden="true"></span>
                  <span class="textbook-main">
                    <strong>{{ textbook.textbookName || '未命名教材' }}</strong>
                    <small>{{ textbookMeta(textbook) }}</small>
                  </span>
                </div>
                <div v-if="!version.textbooks.length" class="nested-empty">该版本暂无教材</div>
              </div>
            </article>
          </template>
          <el-empty v-else :image-size="72" :description="overview.currentVersions.length ? '暂无符合筛选条件的当前数据' : '暂无当前正式数据'" />
        </div>
      </section>
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ArrowRight, Refresh, Search } from '@element-plus/icons-vue'
import { getMetadataTextbookOverview } from '../../api/bank'

const props = defineProps({
  metadataRunId: { type: [String, Number], default: '' },
  heading: { type: String, default: '同步教材' },
  description: { type: String, default: '对比本次抓取到的版本与教材，以及当前正式数据，确认新增内容后再决定是否同步。' },
  loadComparison: { type: Function, default: null },
  autoLoad: { type: Boolean, default: true },
})

const emit = defineEmits(['loaded', 'load-error'])

const emptySummary = () => ({
  fetchedVersionCount: 0,
  fetchedTextbookCount: 0,
  newVersionCount: 0,
  existingVersionCount: 0,
  newTextbookCount: 0,
  existingTextbookCount: 0,
  currentVersionCount: 0,
  currentTextbookCount: 0,
})

const emptyOverview = () => ({
  sourceAvailable: undefined,
  sourceMessage: '',
  metadataRunId: '',
  collectedAt: '',
  summary: emptySummary(),
  fetchedVersions: [],
  currentVersions: [],
})

const overview = ref(emptyOverview())
const loading = ref(false)
const errorMessage = ref('')
const sourceFilter = reactive({ status: 'all', keyword: '' })
const currentFilter = reactive({ keyword: '' })
const expandedSourceKeys = ref(new Set())
const expandedCurrentKeys = ref(new Set())
const sourceScrollEl = ref()
const currentScrollEl = ref()
const selectionNotice = ref({ type: 'info', text: '' })
let highlightTimer
let noticeTimer

const summary = computed(() => overview.value.summary)

const filteredFetchedVersions = computed(() => filterVersions(overview.value.fetchedVersions, sourceFilter.keyword, sourceFilter.status))
const filteredCurrentVersions = computed(() => filterVersions(overview.value.currentVersions, currentFilter.keyword))

function firstDefined(value, keys, fallback = '') {
  if (!value || typeof value !== 'object') return fallback
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key]
  }
  return fallback
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asCount(value) {
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? count : 0
}

function text(value) {
  return value === undefined || value === null ? '' : String(value)
}

function sourceProviderOf(item) {
  return text(firstDefined(item, ['sourceProvider', 'source_provider', 'provider']))
}

function externalIdOf(item) {
  return text(firstDefined(item, ['externalId', 'external_id', 'externalVersionId', 'external_version_id', 'externalTextbookId', 'external_textbook_id']))
}

function localIdOf(item) {
  return firstDefined(item, ['currentLocalId', 'current_local_id'], '')
}

function nameOf(item, type) {
  const keys = type === 'version'
    ? ['versionName', 'version_name', 'name']
    : ['textbookName', 'textbook_name', 'name', 'displayName', 'display_name']
  return text(firstDefined(item, keys))
}

function normalizeMatchStatus(value) {
  const normalized = text(value).trim().toLowerCase()
  return ['existing', 'same', 'matched', 'present', '已有', '已存在'].includes(normalized) ? 'existing' : 'new'
}

function normalizeTextbook(item, isCurrent = false, index = 0, parentKey = 'textbook') {
  const value = item && typeof item === 'object' ? item : {}
  return {
    ...value,
    __overviewKey: `${parentKey}:${localIdOf(value) || `${sourceProviderOf(value)}:${externalIdOf(value) || nameOf(value, 'textbook') || 'unnamed'}:${index}`}`,
    currentLocalId: localIdOf(value) || undefined,
    sourceProvider: sourceProviderOf(value),
    externalId: externalIdOf(value),
    textbookName: nameOf(value, 'textbook'),
    grade: text(firstDefined(value, ['grade'], '')),
    volume: text(firstDefined(value, ['volume'], '')),
    matchStatus: isCurrent ? 'existing' : normalizeMatchStatus(firstDefined(value, ['matchStatus', 'match_status', 'status'], 'new')),
  }
}

function normalizeVersion(item, isCurrent = false, index = 0) {
  const value = item && typeof item === 'object' ? item : {}
  const fallbackKey = `${isCurrent ? 'current' : 'fetched'}-version:${sourceProviderOf(value)}:${externalIdOf(value) || nameOf(value, 'version') || 'unnamed'}:${index}`
  const overviewKey = localIdOf(value) || fallbackKey
  const textbooks = asArray(firstDefined(value, ['textbooks', 'textbookList', 'textbook_list'], [])).map((book, textbookIndex) => normalizeTextbook(book, isCurrent, textbookIndex, overviewKey))
  return {
    ...value,
    __overviewKey: overviewKey,
    currentLocalId: localIdOf(value) || undefined,
    sourceProvider: sourceProviderOf(value),
    externalId: externalIdOf(value),
    versionName: nameOf(value, 'version'),
    textbooks,
    textbookCount: asCount(firstDefined(value, ['textbookCount', 'textbook_count'], textbooks.length)),
    matchStatus: isCurrent ? 'existing' : normalizeMatchStatus(firstDefined(value, ['matchStatus', 'match_status', 'status'], 'new')),
  }
}

function normalizeOverview(response) {
  let value = response
  if (value && value.data && typeof value.data === 'object' && !Array.isArray(value.data) && !value.fetchedVersions && !value.fetched_versions) value = value.data
  value = value && typeof value === 'object' ? value : {}
  const fetchedVersions = asArray(firstDefined(value, ['fetchedVersions', 'fetched_versions'], [])).map((item, index) => normalizeVersion(item, false, index))
  const currentVersions = asArray(firstDefined(value, ['currentVersions', 'current_versions'], [])).map((item, index) => normalizeVersion(item, true, index))
  const fetchedTextbooks = fetchedVersions.reduce((count, item) => count + item.textbooks.length, 0)
  const currentTextbooks = currentVersions.reduce((count, item) => count + item.textbooks.length, 0)
  const newVersions = fetchedVersions.filter((item) => item.matchStatus === 'new').length
  const existingVersions = fetchedVersions.length - newVersions
  const newTextbooks = fetchedVersions.reduce((count, item) => count + item.textbooks.filter((book) => book.matchStatus === 'new').length, 0)
  const existingTextbooks = fetchedTextbooks - newTextbooks
  const rawSummary = firstDefined(value, ['summary', 'statistics'], {})
  const sourceAvailable = firstDefined(value, ['sourceAvailable', 'source_available'], undefined)
  const normalizedSummary = {
    fetchedVersionCount: asCount(firstDefined(rawSummary, ['fetchedVersionCount', 'fetched_version_count'], fetchedVersions.length)),
    fetchedTextbookCount: asCount(firstDefined(rawSummary, ['fetchedTextbookCount', 'fetched_textbook_count'], fetchedTextbooks)),
    newVersionCount: asCount(firstDefined(rawSummary, ['newVersionCount', 'new_version_count'], newVersions)),
    existingVersionCount: asCount(firstDefined(rawSummary, ['existingVersionCount', 'existing_version_count'], existingVersions)),
    newTextbookCount: asCount(firstDefined(rawSummary, ['newTextbookCount', 'new_textbook_count'], newTextbooks)),
    existingTextbookCount: asCount(firstDefined(rawSummary, ['existingTextbookCount', 'existing_textbook_count'], existingTextbooks)),
    currentVersionCount: asCount(firstDefined(rawSummary, ['currentVersionCount', 'current_version_count'], currentVersions.length)),
    currentTextbookCount: asCount(firstDefined(rawSummary, ['currentTextbookCount', 'current_textbook_count'], currentTextbooks)),
  }
  return {
    sourceAvailable,
    sourceMessage: text(firstDefined(value, ['sourceMessage', 'source_message'], '')),
    metadataRunId: firstDefined(value, ['metadataRunId', 'metadata_run_id'], ''),
    collectedAt: firstDefined(value, ['collectedAt', 'collected_at'], ''),
    summary: normalizedSummary,
    fetchedVersions,
    currentVersions,
  }
}

function filterVersions(versions, keyword = '', status = 'all') {
  const query = text(keyword).trim().toLowerCase()
  return versions.reduce((result, version) => {
    const versionMatchesStatus = !status || status === 'all' || version.matchStatus === status
    const versionMatchesKeyword = !query || `${version.versionName} ${version.sourceProvider} ${version.externalId}`.toLowerCase().includes(query)
    const statusTextbooks = version.textbooks.filter((book) => {
      const statusMatches = !status || status === 'all' || book.matchStatus === status
      return statusMatches
    })
    const textbooks = statusTextbooks.filter((book) => !query || `${book.textbookName} ${book.sourceProvider} ${book.externalId} ${book.grade} ${book.volume}`.toLowerCase().includes(query))
    if (versionMatchesStatus && (versionMatchesKeyword || !query)) {
      const narrowedByStatus = status && status !== 'all'
      result.push(narrowedByStatus ? { ...version, textbooks: statusTextbooks } : version)
    } else if (textbooks.length) result.push({ ...version, textbooks })
    return result
  }, [])
}

function sourceVersionKey(version) {
  return `source-version:${version.__overviewKey || `${sourceProviderOf(version)}:${externalIdOf(version) || version.versionName}`}`
}

function currentVersionKey(version) {
  return `current-version:${version.__overviewKey || `${sourceProviderOf(version)}:${externalIdOf(version) || version.versionName}`}`
}

function sourceTextbookKey(version, textbook) {
  return `${sourceVersionKey(version)}:textbook:${textbook.__overviewKey || `${sourceProviderOf(textbook)}:${externalIdOf(textbook) || textbook.textbookName}`}`
}

function currentTextbookKey(version, textbook) {
  return `${currentVersionKey(version)}:textbook:${textbook.__overviewKey || `${sourceProviderOf(textbook)}:${externalIdOf(textbook) || textbook.textbookName}`}`
}

function domKey(value) {
  return encodeURIComponent(value).replace(/%/g, '_')
}

function sourceVersionDomId(version) { return `fetched-version-${domKey(sourceVersionKey(version))}` }
function sourceTextbookDomId(version, textbook) { return `fetched-textbook-${domKey(sourceTextbookKey(version, textbook))}` }
function currentVersionDomId(version) { return `current-version-${domKey(currentVersionKey(version))}` }
function currentTextbookDomId(version, textbook) { return `current-textbook-${domKey(currentTextbookKey(version, textbook))}` }

function isNew(status) { return normalizeMatchStatus(status) === 'new' }
function matchLabel(status) { return isNew(status) ? '新增' : '已有' }
function matchTagType(status) { return isNew(status) ? 'success' : 'info' }

function textbookMeta(textbook) {
  const parts = [textbook.grade, textbook.volume].filter((value) => text(value).trim())
  if (textbook.sourceProvider) parts.push(textbook.sourceProvider)
  if (textbook.externalId) parts.push(`ID ${textbook.externalId}`)
  return parts.join(' · ') || '未提供教材属性'
}

function isSourceExpanded(version) { return expandedSourceKeys.value.has(sourceVersionKey(version)) }
function isCurrentExpanded(version) { return expandedCurrentKeys.value.has(currentVersionKey(version)) }

function setExpanded(target, keys) { target.value = new Set(keys) }

function toggleKey(target, key) {
  const values = new Set(target.value)
  if (values.has(key)) values.delete(key)
  else values.add(key)
  target.value = values
}

function toggleCurrentVersion(version) { toggleKey(expandedCurrentKeys, currentVersionKey(version)) }
function expandAllSource() { setExpanded(expandedSourceKeys, filteredFetchedVersions.value.map(sourceVersionKey)) }
function collapseAllSource() { setExpanded(expandedSourceKeys, []) }
function expandAllCurrent() { setExpanded(expandedCurrentKeys, filteredCurrentVersions.value.map(currentVersionKey)) }
function collapseAllCurrent() { setExpanded(expandedCurrentKeys, []) }

function findCurrentVersion(sourceVersion) {
  const provider = sourceProviderOf(sourceVersion)
  const externalId = externalIdOf(sourceVersion)
  if (provider && externalId) {
    return overview.value.currentVersions.find((item) => (
      sourceProviderOf(item) === provider && externalIdOf(item) === externalId
    ))
  }
  const localId = localIdOf(sourceVersion)
  return localId === ''
    ? undefined
    : overview.value.currentVersions.find((item) => text(localIdOf(item)) === text(localId))
}

function findCurrentTextbook(sourceVersion, sourceTextbook) {
  const version = findCurrentVersion(sourceVersion)
  if (!version) return null
  const provider = sourceProviderOf(sourceTextbook)
  const externalId = externalIdOf(sourceTextbook)
  let textbook
  if (provider && externalId) {
    textbook = version.textbooks.find((book) => (
      sourceProviderOf(book) === provider && externalIdOf(book) === externalId
    ))
  } else {
    const localId = localIdOf(sourceTextbook)
    textbook = localId === ''
      ? undefined
      : version.textbooks.find((book) => text(localIdOf(book)) === text(localId))
  }
  return textbook ? { version, textbook } : null
}

function showSelectionNotice(type, message) {
  selectionNotice.value = { type, text: message }
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(clearSelectionNotice, 4200)
}

function clearSelectionNotice() {
  selectionNotice.value = { type: 'info', text: '' }
  clearTimeout(noticeTimer)
}

function handleFetchedVersionClick(version) {
  toggleKey(expandedSourceKeys, sourceVersionKey(version))
  if (isNew(version.matchStatus)) {
    showSelectionNotice('info', `版本“${version.versionName || '未命名版本'}”是本次新增数据，当前数据中暂无匹配项。`)
    return
  }
  const currentVersion = findCurrentVersion(version)
  if (!currentVersion) {
    showSelectionNotice('warning', `版本“${version.versionName || '未命名版本'}”标记为已有，但当前数据中未找到对应项。`)
    return
  }
  focusCurrentVersion(currentVersion)
}

function handleFetchedTextbookClick(version, textbook) {
  if (isNew(textbook.matchStatus)) {
    showSelectionNotice('info', `教材“${textbook.textbookName || '未命名教材'}”是本次新增数据，当前数据中暂无匹配项。`)
    return
  }
  const current = findCurrentTextbook(version, textbook)
  if (!current) {
    showSelectionNotice('warning', `教材“${textbook.textbookName || '未命名教材'}”标记为已有，但当前数据中未找到对应项。`)
    return
  }
  focusCurrentTextbook(current.version, current.textbook)
}

function focusCurrentVersion(version) {
  currentFilter.keyword = ''
  setExpanded(expandedCurrentKeys, [...expandedCurrentKeys.value, currentVersionKey(version)])
  nextTick(() => highlightElement(currentVersionDomId(version)))
}

function focusCurrentTextbook(version, textbook) {
  currentFilter.keyword = ''
  setExpanded(expandedCurrentKeys, [...expandedCurrentKeys.value, currentVersionKey(version)])
  nextTick(() => highlightElement(currentTextbookDomId(version, textbook)))
}

function highlightElement(id) {
  const element = document.getElementById(id)
  if (!element) return
  clearTimeout(highlightTimer)
  document.querySelectorAll('.sync-textbook-page .is-locate-highlight').forEach((node) => node.classList.remove('is-locate-highlight'))
  element.classList.add('is-locate-highlight')
  element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  highlightTimer = setTimeout(() => element.classList.remove('is-locate-highlight'), 1900)
}

function formatCollectedAt(value) {
  const raw = text(value)
  return raw ? raw.replace('T', ' ').replace(/\.\d+([+-]\d\d:\d\d|Z)?$/, '') : ''
}

async function loadOverview() {
  loading.value = true
  errorMessage.value = ''
  try {
    const response = props.loadComparison
      ? await props.loadComparison()
      : await getMetadataTextbookOverview(props.metadataRunId || undefined)
    overview.value = normalizeOverview(response)
    emit('loaded', overview.value)
  } catch (error) {
    overview.value = emptyOverview()
    errorMessage.value = error?.message || '同步教材数据加载失败，请稍后重试'
    emit('load-error', error)
  } finally {
    loading.value = false
  }
}

watch(() => props.metadataRunId, (current, previous) => {
  if (props.autoLoad && current && String(current) !== String(previous)) loadOverview()
})

defineExpose({ loadOverview })

onMounted(() => {
  if (props.autoLoad) loadOverview()
})
onBeforeUnmount(() => {
  clearTimeout(highlightTimer)
  clearTimeout(noticeTimer)
})
</script>

<style scoped>
.sync-textbook-page { min-height: calc(100vh - 84px); color: var(--el-text-color-primary); }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
.heading-copy h2 { margin: 0; font-size: 20px; font-weight: 600; }
.heading-copy p { margin: 6px 0 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.overview-meta { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 14px; color: var(--el-text-color-secondary); font-size: 12px; }
.state-alert { margin-bottom: 14px; }
.selection-alert { border: 1px solid var(--el-color-primary-light-7); }
.summary-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.summary-card { min-width: 0; padding: 15px 17px; border: 1px solid var(--el-border-color-light); border-radius: 8px; background: var(--el-bg-color); box-shadow: 0 1px 2px rgb(0 0 0 / 3%); }
.summary-label { display: block; margin-bottom: 7px; color: var(--el-text-color-secondary); font-size: 12px; }
.summary-card strong { display: block; overflow: hidden; color: var(--el-text-color-primary); font-size: 16px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.summary-card small { display: block; overflow: hidden; margin-top: 6px; color: var(--el-text-color-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.source-summary { border-top: 3px solid var(--el-color-primary); }
.existing-summary { border-top: 3px solid var(--el-color-success); }
.current-summary { border-top: 3px solid var(--el-color-info); }
.overview-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; height: calc(100vh - 290px); min-height: 560px; max-height: calc(100vh - 180px); }
.overview-pane { display: flex; min-width: 0; min-height: 0; height: 100%; flex-direction: column; overflow: hidden; border: 1px solid var(--el-border-color-light); border-radius: 8px; background: var(--el-bg-color); }
.pane-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 16px 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
.pane-heading h3 { margin: 0; font-size: 16px; font-weight: 600; }
.pane-heading p { margin: 5px 0 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }
.pane-count { flex: 0 0 auto; color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; }
.pane-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; padding: 11px 16px; border-bottom: 1px solid var(--el-border-color-lighter); background: var(--el-fill-color-extra-light); }
.pane-toolbar > .el-input { min-width: 150px; flex: 1 1 170px; }
.current-toolbar > .el-input { min-width: 220px; }
.pane-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; margin-left: auto; }
.tree-scroll { min-height: 0; flex: 1; overflow: auto; padding: 12px; }
.version-card { overflow: hidden; margin-bottom: 8px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; background: var(--el-bg-color); transition: border-color .2s, box-shadow .2s; }
.version-card:last-child { margin-bottom: 0; }
.version-card:hover { border-color: var(--el-color-primary-light-5); }
.version-card.is-new { border-left: 3px solid var(--el-color-success); }
.version-row, .textbook-row { width: 100%; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.version-row { display: flex; align-items: center; gap: 8px; min-height: 56px; padding: 9px 11px; background: transparent; }
.version-row:hover { background: var(--el-fill-color-light); }
.expand-icon { flex: 0 0 auto; color: var(--el-text-color-secondary); transition: transform .2s; }
.expand-icon.is-expanded { transform: rotate(90deg); }
.version-main, .textbook-main { min-width: 0; flex: 1; }
.version-main strong, .textbook-main strong { display: block; overflow: hidden; font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.version-main small, .textbook-main small { display: block; overflow: hidden; margin-top: 3px; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.version-count { flex: 0 0 auto; color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; }
.textbook-list { padding: 0 9px 8px 35px; border-top: 1px solid var(--el-border-color-lighter); background: var(--el-fill-color-extra-light); }
.textbook-row { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 7px 8px; border-bottom: 1px dashed var(--el-border-color-lighter); background: transparent; }
.textbook-row:last-child { border-bottom: 0; }
.textbook-row:hover { background: var(--el-fill-color-light); }
.textbook-row.is-new .book-dot { background: var(--el-color-success); }
.book-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--el-color-info-light-3); }
.current-textbook-row { cursor: default; }
.current-textbook-row:hover { background: var(--el-fill-color-light); }
.nested-empty { padding: 12px 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.is-locate-highlight { animation: locate-highlight 1.9s ease-out; }
@keyframes locate-highlight { 0%, 55% { background: var(--el-color-warning-light-8); box-shadow: 0 0 0 2px var(--el-color-warning-light-5); } 100% { background: transparent; box-shadow: 0 0 0 0 transparent; } }
@media (max-width: 980px) { .overview-grid { grid-template-columns: 1fr; height: auto; min-height: 0; max-height: none; } .overview-pane { min-height: 480px; height: min(620px, calc(100vh - 210px)); } }
@media (max-width: 680px) { .page-heading { align-items: stretch; flex-direction: column; } .page-heading > .el-button { align-self: flex-start; } .summary-strip { grid-template-columns: 1fr; } .pane-heading { flex-direction: column; } .pane-count { align-self: flex-start; } .pane-toolbar { align-items: stretch; flex-direction: column; } .pane-toolbar > .el-input, .current-toolbar > .el-input { width: 100%; min-width: 0; flex-basis: auto; } .pane-actions { justify-content: flex-end; margin-left: 0; } .version-count { display: none; } .textbook-list { padding-left: 27px; } }
</style>
