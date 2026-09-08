<template>
  <div class="app-container lesson-plan-page">
    <div class="page-header">
      <div>
        <h2>抽题生成教案</h2>
        <p class="page-subtitle">左侧勾选知识点，中间确认规则并模拟题量，右侧预览、换题、编辑文字并导出 Word。</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Clock" @click="openHistory">历史教案</el-button>
      </div>
    </div>

    <el-alert v-if="errorMessage" class="state-alert" type="error" :closable="false" show-icon>{{ errorMessage }}</el-alert>

    <div class="workspace">
      <aside class="panel catalog-panel" aria-label="知识点选择">
        <div class="panel-title">1. 选择知识点</div>
        <div class="book-selectors">
          <el-select v-model="selectedVersionId" placeholder="选择版本" filterable @change="handleVersionChange">
            <el-option v-for="item in versions" :key="item.versionId" :label="item.versionName || '未命名版本'" :value="item.versionId" />
          </el-select>
          <el-select v-model="settings.textbookId" placeholder="选择教材" filterable :disabled="!selectedVersionId" @change="handleTextbookChange">
            <el-option v-for="item in textbooks" :key="item.textbookId" :label="item.textbookName || '未命名教材'" :value="item.textbookId" />
          </el-select>
        </div>
        <div class="catalog-tree-wrap">
          <el-skeleton v-if="loadingCatalog" :rows="8" animated />
          <el-empty v-else-if="!settings.textbookId" :image-size="52" description="请选择教材" />
          <el-empty v-else-if="!catalogTree.length" :image-size="52" description="该教材暂无目录" />
          <el-tree
            v-else
            ref="treeRef"
            class="catalog-tree"
            :data="catalogTree"
            node-key="catalogId"
            show-checkbox
            :props="treeProps"
            :default-expanded-keys="expandedKeys"
            @check="handleTreeCheck"
          >
            <template #default="{ data }">
              <div class="catalog-node" :title="data.nodeName">
                <span class="catalog-node-name">{{ data.nodeName }}</span>
                <span v-if="data.descendantQuestionCount || data.directQuestionCount" class="catalog-node-count">{{ data.descendantQuestionCount || data.directQuestionCount }}</span>
              </div>
            </template>
          </el-tree>
        </div>
        <div class="checked-points">
          <span class="checked-label">已选知识点 {{ checkedPoints.length }}</span>
          <el-tag v-for="point in checkedPoints" :key="point.catalogId" size="small" closable @close="uncheckPoint(point)">{{ point.name }}</el-tag>
        </div>
      </aside>

      <section class="panel rules-panel" aria-label="课型与规则">
        <div class="panel-title">2. 课型、偏好与抽题规则</div>
        <el-form :model="settings" label-width="72px" class="settings-form" size="default">
          <div class="form-grid">
            <el-form-item label="课题"><el-input v-model="settings.title" :placeholder="defaultTitle || '默认取知识点名'" maxlength="200" /></el-form-item>
            <el-form-item label="课型">
              <el-select v-model="settings.lessonType" @change="handleLessonTypeChange">
                <el-option v-for="item in options.lessonTypes" :key="item.lessonType" :label="item.name" :value="item.lessonType" />
              </el-select>
            </el-form-item>
            <el-form-item label="课时"><el-input-number v-model="settings.durationMinutes" :min="10" :max="240" :step="5" /></el-form-item>
            <el-form-item label="近几年"><el-input-number v-model="settings.recentYears" :min="0" :max="30" /></el-form-item>
            <el-form-item label="省份"><el-input v-model="settings.preferredProvince" placeholder="如 江苏" clearable /></el-form-item>
            <el-form-item label="城市"><el-input v-model="settings.preferredCity" placeholder="如 南京" clearable /></el-form-item>
            <el-form-item label="考试类型">
              <el-select v-model="settings.preferredExamTypes" multiple filterable allow-create default-first-option placeholder="如 中考、期末">
                <el-option v-for="dict in qb_exam_type" :key="dict.value" :label="dict.label" :value="dict.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="真题优先"><el-switch v-model="settings.preferRealExam" /></el-form-item>
          </div>
        </el-form>

        <div class="rules-toolbar">
          <span class="rules-summary">共 {{ ruleRows.length }} 条规则 · {{ totalCount }} 题</span>
          <div class="rules-actions">
            <el-button size="small" :disabled="!checkedPoints.length" @click="resetDefaultRules">重置为默认规则</el-button>
            <el-button size="small" :disabled="!checkedPoints.length" @click="addRule">添加规则</el-button>
            <el-button size="small" type="primary" plain :loading="simulating" :disabled="!ruleRows.length" @click="runSimulation">模拟候选题量</el-button>
          </div>
        </div>

        <el-table :data="ruleRows" row-key="key" class="rules-table" size="small" border>
          <el-table-column label="环节" width="104">
            <template #default="{ row }">
              <el-select v-model="row.phase" size="small" @change="markRulesDirty">
                <el-option v-for="item in options.phases" :key="item.phase" :label="item.name" :value="item.phase" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="知识点" min-width="150">
            <template #default="{ row }">
              <el-select v-model="row.catalogIds" multiple collapse-tags collapse-tags-tooltip size="small" @change="markRulesDirty">
                <el-option v-for="point in checkedPoints" :key="point.catalogId" :label="point.name" :value="point.catalogId" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="题数" width="86">
            <template #default="{ row }"><el-input-number v-model="row.questionCount" :min="1" :max="20" size="small" controls-position="right" @change="markRulesDirty" /></template>
          </el-table-column>
          <el-table-column label="题型" min-width="130">
            <template #default="{ row }">
              <el-select v-model="row.questionTypes" multiple collapse-tags size="small" placeholder="不限" @change="markRulesDirty">
                <el-option v-for="type in options.questionTypes" :key="type" :label="type" :value="type" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="易度区间" min-width="150">
            <template #default="{ row }">
              <div class="ease-cell">
                <el-slider v-model="row.easeRange" range :min="0" :max="1" :step="0.05" size="small" @change="markRulesDirty" />
                <span class="ease-text">{{ row.easeRange[0].toFixed(2) }} ~ {{ row.easeRange[1].toFixed(2) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="额外点" width="82">
            <template #default="{ row }"><el-input-number v-model="row.maxExtraPoints" :min="0" :max="10" size="small" controls-position="right" @change="markRulesDirty" /></template>
          </el-table-column>
          <el-table-column label="图/表" width="88">
            <template #default="{ row }">
              <div class="switch-cell">
                <el-switch v-model="row.allowImage" size="small" inline-prompt active-text="图" inactive-text="图" @change="markRulesDirty" />
                <el-switch v-model="row.allowTable" size="small" inline-prompt active-text="表" inactive-text="表" @change="markRulesDirty" />
              </div>
            </template>
          </el-table-column>
          <el-table-column label="候选（严格/1级/2级/兜底）" width="150">
            <template #default="{ $index }">
              <template v-if="simulation[$index]">
                <el-tag size="small" :type="simulationTagType(simulation[$index])">{{ simulation[$index].candidateCounts.join(' / ') }}</el-tag>
                <div class="simulation-message">{{ simulation[$index].message }}</div>
              </template>
              <span v-else class="muted">未模拟</span>
            </template>
          </el-table-column>
          <el-table-column width="52" fixed="right">
            <template #default="{ $index }"><el-button link type="danger" size="small" @click="removeRule($index)">删除</el-button></template>
          </el-table-column>
        </el-table>
        <p class="rules-hint">候选列显示 严格 / 放宽 1 级 / 放宽 2 级 / 兜底 四级下的可用题数；生成时按此顺序逐级放宽补齐。</p>

        <div class="generate-bar">
          <el-button type="primary" :loading="generating" :disabled="!ruleRows.length" @click="runGenerate">生成教案</el-button>
        </div>
      </section>

      <section class="panel preview-panel" aria-label="教案预览">
        <div class="panel-title preview-title">
          <span>3. 教案预览</span>
          <div v-if="generation" class="preview-actions">
            <el-tag size="small" :type="generation.status === 'ready' ? 'success' : 'warning'">{{ generation.status === 'ready' ? '题量满足' : '部分不足' }}</el-tag>
            <span class="seed-text">seed {{ generation.seed }}</span>
            <el-button size="small" :loading="regenerating" @click="runRegenerate">重新生成</el-button>
            <el-button size="small" :loading="savingText" @click="saveText">保存文字</el-button>
            <el-button size="small" type="primary" :loading="exporting" @click="runExport">导出 Word</el-button>
          </div>
        </div>

        <el-empty v-if="!generation" :image-size="80" description="生成后在此预览教案" />
        <div v-else class="lesson-preview">
          <el-alert v-if="shortSummaries.length" type="warning" :closable="false" show-icon class="short-alert">
            <div v-for="row in shortSummaries" :key="row.ruleId">{{ row.ruleName || phaseName(row.phase) }}：{{ row.message }}</div>
          </el-alert>

          <div class="lesson-head">
            <el-input v-model="textForm.title" class="lesson-title-input" maxlength="200" placeholder="教案课题" />
            <div class="lesson-meta">
              <span>{{ generation.lesson?.textbookName }}</span>
              <span>{{ generation.lesson?.lessonTypeName }}</span>
              <span>{{ generation.lesson?.durationMinutes }} 分钟</span>
              <span>共 {{ generationItemCount }} 题</span>
            </div>
            <div class="lesson-points">
              <el-tag v-for="point in generation.lesson?.knowledgePoints || []" :key="point.catalogId" size="small" effect="plain" :title="point.path">{{ point.name }}</el-tag>
            </div>
          </div>

          <el-collapse v-model="openTextSections" class="text-sections">
            <el-collapse-item title="教学目标 / 重难点 / 过程说明" name="text">
              <div class="text-grid">
                <label><span>教学目标</span><el-input v-model="textForm.text.objectives" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" /></label>
                <label><span>教学重点</span><el-input v-model="textForm.text.keyPoints" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" /></label>
                <label><span>教学难点</span><el-input v-model="textForm.text.difficultPoints" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" /></label>
                <label><span>过程说明</span><el-input v-model="textForm.text.process" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" /></label>
                <label><span>板书要点</span><el-input v-model="textForm.text.boardNotes" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" /></label>
                <label><span>作业说明</span><el-input v-model="textForm.text.homeworkNote" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" /></label>
              </div>
            </el-collapse-item>
          </el-collapse>

          <section v-for="phase in generation.phases" :key="phase.phase" class="phase-section">
            <h3 class="phase-heading">{{ phase.name }} <small>{{ phase.items.length }} 题</small></h3>
            <el-empty v-if="!phase.items.length" :image-size="40" description="本环节未选到题目" />
            <article v-for="(item, index) in phase.items" :key="item.itemId" class="question-card">
              <div class="question-head">
                <div class="question-badges">
                  <span class="question-index">{{ index + 1 }}</span>
                  <el-tag v-if="item.question?.questionType" size="small" effect="plain">{{ item.question.questionType }}</el-tag>
                  <el-tag v-if="item.question?.difficulty" size="small" effect="plain">{{ item.question.difficulty }}<template v-if="item.question.difficultyCoefficient !== null && item.question.difficultyCoefficient !== undefined"> {{ item.question.difficultyCoefficient }}</template></el-tag>
                  <el-tag size="small" :type="relaxTagType(item.relaxLevel)" effect="light">{{ relaxLabel(item.relaxLevel) }}</el-tag>
                  <el-tooltip v-if="item.evidenceType === 'query_membership'" content="该题与知识点的关系来自查询归属，非来源站明确标注" placement="top"><el-tag size="small" type="info" effect="plain">归属推断</el-tag></el-tooltip>
                  <el-tag v-if="item.replacedFromQuestionId" size="small" type="info" effect="plain">已换题</el-tag>
                </div>
                <el-button link type="primary" size="small" :loading="replacingItemId === item.itemId" @click="replaceItem(item)">换一题</el-button>
              </div>
              <div class="question-content rich-text" v-html="questionHtml(item)" />
              <div class="question-foot">{{ questionSourceText(item.question) || '来源未采集' }}</div>
            </article>
          </section>
        </div>
      </section>
    </div>

    <el-drawer v-model="historyVisible" title="历史教案" direction="rtl" size="min(720px, 92vw)" append-to-body>
      <div class="history-toolbar">
        <el-input v-model="historyQuery.keyword" placeholder="按课题搜索" clearable @keyup.enter="loadHistory" @clear="loadHistory" />
        <el-button :icon="Refresh" :loading="loadingHistory" @click="loadHistory">刷新</el-button>
      </div>
      <el-table :data="historyRows" v-loading="loadingHistory" size="small" class="history-table">
        <el-table-column label="课题" min-width="180" show-overflow-tooltip><template #default="{ row }">{{ row.title || row.schemeName }}</template></el-table-column>
        <el-table-column label="教材" min-width="120" prop="textbookName" show-overflow-tooltip />
        <el-table-column label="题数" width="60" prop="itemCount" />
        <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag size="small" :type="row.status === 'ready' ? 'success' : 'warning'">{{ row.status === 'ready' ? '满足' : '不足' }}</el-tag></template></el-table-column>
        <el-table-column label="生成时间" width="160"><template #default="{ row }">{{ parseTime(row.createTime, '{y}-{m}-{d} {h}:{i}') }}</template></el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openGeneration(row.generationId)">打开</el-button>
            <el-button v-hasPermi="['lesson:plan:remove']" link type="danger" size="small" @click="removeGeneration(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination v-model:current-page="historyQuery.pageNum" v-model:page-size="historyQuery.pageSize" :total="historyTotal" layout="total, prev, pager, next" background class="history-pagination" @current-change="loadHistory" />
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, getCurrentInstance, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Clock, Refresh } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { saveAs } from 'file-saver'
import {
  deleteGenerations,
  exportGeneration,
  generatePlan,
  getDefaultRules,
  getGeneration,
  getPlanAsset,
  getPlanCatalogTree,
  getPlanOptions,
  listGenerations,
  listPlanTextbooks,
  listPlanVersions,
  regeneratePlan,
  replaceGenerationItem,
  simulateRules,
  updateGenerationText,
} from '../../api/lesson'
import { sanitizeHtml } from '../../utils/html'
import {
  assetKeyOf,
  buildGeneratePayload,
  collectCheckedPoints,
  newRuleRow,
  phaseName,
  questionSourceText,
  relaxLabel,
  relaxTagType,
  ruleRowFrom,
  safeFileName,
  simulationTagType,
  sortRuleRows,
  validateRuleRows,
} from '../../utils/plan'

const { proxy } = getCurrentInstance()
const { qb_exam_type } = proxy.useDict('qb_exam_type')

const treeProps = { label: 'nodeName', children: 'children' }
const options = reactive({ lessonTypes: [], phases: [], questionTypes: [] })
const versions = ref([])
const textbooks = ref([])
const selectedVersionId = ref(undefined)
const catalogTree = ref([])
const expandedKeys = ref([])
const treeRef = ref(null)
const loadingCatalog = ref(false)
const checkedPoints = ref([])
const settings = reactive({
  textbookId: undefined,
  title: '',
  lessonType: 'new',
  durationMinutes: 45,
  recentYears: 3,
  preferredProvince: '',
  preferredCity: '',
  preferredExamTypes: [],
  preferRealExam: true,
})
const ruleRows = ref([])
const rulesDirty = ref(false)
const simulation = ref([])
const simulating = ref(false)
const generating = ref(false)
const regenerating = ref(false)
const savingText = ref(false)
const exporting = ref(false)
const replacingItemId = ref(null)
const generation = ref(null)
const textForm = reactive({ title: '', text: emptyText() })
const openTextSections = ref(['text'])
const assetUrls = reactive({})
const errorMessage = ref('')
const historyVisible = ref(false)
const loadingHistory = ref(false)
const historyRows = ref([])
const historyTotal = ref(0)
const historyQuery = reactive({ pageNum: 1, pageSize: 10, keyword: '' })

const totalCount = computed(() => ruleRows.value.reduce((sum, row) => sum + (Number(row.questionCount) || 0), 0))
const defaultTitle = computed(() => checkedPoints.value.map((point) => point.name).join('、'))
const shortSummaries = computed(() => (generation.value?.summary || []).filter((row) => row.short))
const generationItemCount = computed(() => (generation.value?.phases || []).reduce((sum, phase) => sum + phase.items.length, 0))

function emptyText() {
  return { objectives: '', keyPoints: '', difficultPoints: '', process: '', boardNotes: '', homeworkNote: '' }
}

function unwrap(result) {
  return result && result.data !== undefined && result.rows === undefined ? result.data : result
}

function rowsOf(result) {
  const value = unwrap(result)
  if (Array.isArray(value)) return value
  return value?.rows || value?.list || []
}

function setError(error, fallback) {
  errorMessage.value = error?.message || fallback
}

function markRulesDirty() {
  rulesDirty.value = true
  simulation.value = []
}

async function loadOptions() {
  try {
    const payload = unwrap(await getPlanOptions()) || {}
    options.lessonTypes = payload.lessonTypes || []
    options.phases = payload.phases || []
    options.questionTypes = payload.questionTypes || []
  } catch (error) {
    setError(error, '选项加载失败')
  }
}

async function loadVersions() {
  try {
    versions.value = rowsOf(await listPlanVersions({ pageNum: 1, pageSize: 100, status: '0' }))
    if (versions.value.length) {
      selectedVersionId.value = versions.value[0].versionId
      await handleVersionChange(selectedVersionId.value)
    }
  } catch (error) {
    setError(error, '版本加载失败，请稍后重试')
  }
}

async function handleVersionChange(versionId) {
  selectedVersionId.value = versionId || undefined
  textbooks.value = []
  await handleTextbookChange(undefined)
  if (!versionId) return
  try {
    textbooks.value = rowsOf(await listPlanTextbooks({ versionId, pageNum: 1, pageSize: 100, status: '0' }))
    if (textbooks.value.length) await handleTextbookChange(textbooks.value[0].textbookId)
  } catch (error) {
    setError(error, '教材加载失败，请稍后重试')
  }
}

async function handleTextbookChange(textbookId) {
  settings.textbookId = textbookId || undefined
  catalogTree.value = []
  expandedKeys.value = []
  checkedPoints.value = []
  ruleRows.value = []
  simulation.value = []
  rulesDirty.value = false
  if (!textbookId) return
  loadingCatalog.value = true
  errorMessage.value = ''
  try {
    catalogTree.value = unwrap(await getPlanCatalogTree(textbookId)) || []
    expandedKeys.value = catalogTree.value.slice(0, 1).map((node) => node.catalogId)
  } catch (error) {
    setError(error, '目录加载失败，请稍后重试')
  } finally {
    loadingCatalog.value = false
  }
}

async function handleTreeCheck() {
  await nextTick()
  const keys = treeRef.value?.getCheckedKeys?.() || []
  checkedPoints.value = collectCheckedPoints(catalogTree.value, keys)
  simulation.value = []
  if (!checkedPoints.value.length) {
    ruleRows.value = []
    rulesDirty.value = false
    return
  }
  if (rulesDirty.value) {
    const valid = new Set(checkedPoints.value.map((point) => String(point.catalogId)))
    for (const row of ruleRows.value) row.catalogIds = row.catalogIds.filter((id) => valid.has(String(id)))
    return
  }
  await resetDefaultRules()
}

function uncheckPoint(point) {
  treeRef.value?.setChecked?.(point.catalogId, false, false)
  handleTreeCheck()
}

async function resetDefaultRules() {
  if (!checkedPoints.value.length) return
  try {
    const rules = unwrap(await getDefaultRules({ lessonType: settings.lessonType, catalogIds: checkedPoints.value.map((point) => point.catalogId) })) || []
    ruleRows.value = sortRuleRows(rules.map(ruleRowFrom))
    rulesDirty.value = false
    simulation.value = []
  } catch (error) {
    setError(error, '默认规则加载失败')
  }
}

function handleLessonTypeChange() {
  if (!rulesDirty.value) resetDefaultRules()
}

function addRule() {
  ruleRows.value = sortRuleRows([...ruleRows.value, newRuleRow(checkedPoints.value)])
  markRulesDirty()
}

function removeRule(index) {
  ruleRows.value.splice(index, 1)
  markRulesDirty()
}

function currentPayload() {
  return buildGeneratePayload(settings, ruleRows.value, checkedPoints.value)
}

async function runSimulation() {
  const problem = validateRuleRows(ruleRows.value)
  if (problem) {
    ElMessage.warning(problem)
    return
  }
  simulating.value = true
  try {
    const payload = currentPayload()
    const rows = unwrap(await simulateRules({ textbookId: payload.textbookId, rules: payload.rules })) || []
    const ordered = sortRuleRows(ruleRows.value)
    ruleRows.value = ordered
    simulation.value = ordered.map((_, index) => rows.find((row) => row.ruleIndex === index) || null)
  } catch (error) {
    setError(error, '模拟失败')
  } finally {
    simulating.value = false
  }
}

async function runGenerate() {
  const problem = validateRuleRows(ruleRows.value)
  if (problem) {
    ElMessage.warning(problem)
    return
  }
  generating.value = true
  errorMessage.value = ''
  try {
    applyGeneration(unwrap(await generatePlan(currentPayload())))
    ElMessage.success('教案已生成')
  } catch (error) {
    setError(error, '生成失败')
  } finally {
    generating.value = false
  }
}

function applyGeneration(detail) {
  generation.value = detail || null
  textForm.title = detail?.lesson?.title || ''
  textForm.text = { ...emptyText(), ...(detail?.lesson?.text || {}) }
  loadAssets(detail)
}

async function loadAssets(detail) {
  const pending = []
  for (const phase of detail?.phases || []) {
    for (const item of phase.items || []) {
      for (const asset of item.question?.assets || []) {
        if (!asset.available) continue
        const key = assetKeyOf(item.questionId, asset.assetKey)
        if (assetUrls[key]) continue
        assetUrls[key] = 'loading'
        pending.push(
          getPlanAsset(item.questionId, asset.assetKey)
            .then((blob) => {
              assetUrls[key] = blob instanceof Blob ? URL.createObjectURL(blob) : ''
            })
            .catch(() => {
              assetUrls[key] = ''
            }),
        )
      }
    }
  }
  await Promise.all(pending)
}

function questionHtml(item) {
  const question = item?.question
  if (!question) return sanitizeHtml('<p>题目已不在正式题库中</p>')
  return sanitizeHtml(question.contentHtml || question.plainText || '题干未采集', (key) => assetUrls[assetKeyOf(item.questionId, key)] || '')
}

async function replaceItem(item) {
  if (!generation.value) return
  replacingItemId.value = item.itemId
  try {
    applyGeneration(unwrap(await replaceGenerationItem(generation.value.generationId, item.itemId)))
    ElMessage.success('已换题')
  } catch (error) {
    setError(error, '换题失败')
  } finally {
    replacingItemId.value = null
  }
}

async function runRegenerate() {
  if (!generation.value) return
  regenerating.value = true
  try {
    await persistText(false)
    applyGeneration(unwrap(await regeneratePlan(generation.value.generationId)))
    ElMessage.success('已按新种子重新生成')
  } catch (error) {
    setError(error, '重新生成失败')
  } finally {
    regenerating.value = false
  }
}

async function persistText(notify = true) {
  if (!generation.value) return
  const title = textForm.title.trim() || generation.value.lesson?.title || '教案'
  const detail = unwrap(await updateGenerationText(generation.value.generationId, { title, text: textForm.text }))
  generation.value = detail || generation.value
  textForm.title = detail?.lesson?.title || title
  if (notify) ElMessage.success('文字已保存')
}

async function saveText() {
  savingText.value = true
  try {
    await persistText(true)
  } catch (error) {
    setError(error, '保存失败')
  } finally {
    savingText.value = false
  }
}

async function runExport() {
  if (!generation.value) return
  exporting.value = true
  try {
    await persistText(false)
    const blob = await exportGeneration(generation.value.generationId)
    if (!(blob instanceof Blob)) throw new Error('导出结果不是文件')
    saveAs(blob, safeFileName(textForm.title || generation.value.lesson?.title))
  } catch (error) {
    setError(error, '导出失败')
  } finally {
    exporting.value = false
  }
}

async function openHistory() {
  historyVisible.value = true
  await loadHistory()
}

async function loadHistory() {
  loadingHistory.value = true
  try {
    const result = await listGenerations({ pageNum: historyQuery.pageNum, pageSize: historyQuery.pageSize, keyword: historyQuery.keyword || undefined })
    historyRows.value = rowsOf(result)
    historyTotal.value = Number(unwrap(result)?.total ?? result?.total ?? historyRows.value.length) || 0
  } catch (error) {
    setError(error, '历史加载失败')
  } finally {
    loadingHistory.value = false
  }
}

async function openGeneration(generationId) {
  try {
    const detail = unwrap(await getGeneration(generationId))
    applyGeneration(detail)
    hydrateSettings(detail)
    historyVisible.value = false
  } catch (error) {
    setError(error, '打开失败')
  }
}

function hydrateSettings(detail) {
  const scheme = detail?.scheme || {}
  settings.title = detail?.lesson?.title || ''
  settings.lessonType = scheme.lessonType || 'new'
  settings.durationMinutes = scheme.durationMinutes || 45
  settings.recentYears = scheme.recentYears ?? 3
  settings.preferredProvince = scheme.preferredProvince || ''
  settings.preferredCity = scheme.preferredCity || ''
  settings.preferredExamTypes = scheme.preferredExamTypes || []
  settings.preferRealExam = scheme.preferRealExam !== false
  checkedPoints.value = (detail?.lesson?.knowledgePoints || []).map((point) => ({ catalogId: point.catalogId, name: point.name }))
  ruleRows.value = sortRuleRows((detail?.rules || []).map(ruleRowFrom))
  rulesDirty.value = true
  simulation.value = []
  if (scheme.textbookId && scheme.textbookId !== settings.textbookId) {
    settings.textbookId = scheme.textbookId
    getPlanCatalogTree(scheme.textbookId)
      .then((result) => {
        catalogTree.value = unwrap(result) || []
        expandedKeys.value = catalogTree.value.slice(0, 1).map((node) => node.catalogId)
        return nextTick()
      })
      .then(() => treeRef.value?.setCheckedKeys?.(checkedPoints.value.map((point) => point.catalogId)))
      .catch(() => {})
  } else {
    treeRef.value?.setCheckedKeys?.(checkedPoints.value.map((point) => point.catalogId))
  }
}

async function removeGeneration(row) {
  try {
    await ElMessageBox.confirm(`确定删除「${row.title || row.schemeName}」的生成记录？不会影响题库数据。`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  try {
    await deleteGenerations([row.generationId])
    if (generation.value?.generationId === row.generationId) generation.value = null
    ElMessage.success('已删除')
    await loadHistory()
  } catch (error) {
    setError(error, '删除失败')
  }
}

function parseTime(value, pattern) {
  return proxy.parseTime ? proxy.parseTime(value, pattern) : value
}

onMounted(async () => {
  await loadOptions()
  await loadVersions()
})

onBeforeUnmount(() => {
  for (const url of Object.values(assetUrls)) {
    if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url)
  }
})
</script>

<style scoped>
.lesson-plan-page { min-width: 0; color: var(--el-text-color-primary); }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.page-header h2 { margin: 0; font-size: 20px; font-weight: 600; }
.page-subtitle { margin: 4px 0 0; color: var(--el-text-color-secondary); font-size: 13px; }
.state-alert { margin-bottom: 12px; }
.workspace { display: grid; grid-template-columns: 260px minmax(0, 1.35fr) minmax(0, 1fr); gap: 12px; align-items: start; min-width: 0; }
.panel { min-width: 0; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; background: var(--el-bg-color); }
.panel-title { padding: 10px 12px; border-bottom: 1px solid var(--el-border-color-lighter); font-size: 14px; font-weight: 600; }
.book-selectors { display: grid; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
.catalog-tree-wrap { max-height: 60vh; overflow: auto; padding: 8px; }
.catalog-node { display: flex; align-items: center; min-width: 0; gap: 6px; font-size: 13px; }
.catalog-node-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-node-count { flex: none; color: var(--el-text-color-placeholder); font-size: 11px; }
.checked-points { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--el-border-color-lighter); }
.checked-label { width: 100%; color: var(--el-text-color-secondary); font-size: 12px; }
.settings-form { padding: 10px 12px 0; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 12px; }
.form-grid :deep(.el-form-item) { margin-bottom: 12px; }
.form-grid :deep(.el-input-number), .form-grid :deep(.el-select) { width: 100%; }
.rules-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 12px; }
.rules-summary { color: var(--el-text-color-secondary); font-size: 12px; }
.rules-actions { display: flex; gap: 6px; }
.rules-table { width: 100%; }
.rules-table :deep(.el-input-number) { width: 100%; }
.ease-cell { display: flex; flex-direction: column; gap: 2px; padding: 0 6px; }
.ease-cell :deep(.el-slider) { --el-slider-height: 4px; --el-slider-button-size: 12px; }
.ease-text { color: var(--el-text-color-secondary); font-size: 11px; text-align: center; }
.switch-cell { display: flex; gap: 4px; }
.simulation-message { margin-top: 2px; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.3; }
.muted { color: var(--el-text-color-placeholder); font-size: 12px; }
.rules-hint { margin: 6px 12px 0; color: var(--el-text-color-placeholder); font-size: 12px; }
.generate-bar { display: flex; justify-content: flex-end; padding: 10px 12px 12px; }
.preview-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.preview-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.seed-text { color: var(--el-text-color-placeholder); font-size: 12px; }
.lesson-preview { padding: 12px; }
.short-alert { margin-bottom: 12px; }
.lesson-head { margin-bottom: 12px; }
.lesson-title-input :deep(.el-input__inner) { font-size: 18px; font-weight: 600; }
.lesson-meta { display: flex; flex-wrap: wrap; gap: 0; margin-top: 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.lesson-meta span { padding: 0 8px; border-right: 1px solid var(--el-border-color); }
.lesson-meta span:first-child { padding-left: 0; }
.lesson-meta span:last-child { border-right: 0; }
.lesson-points { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.text-sections { margin-bottom: 12px; }
.text-grid { display: grid; gap: 10px; }
.text-grid label { display: grid; gap: 4px; color: var(--el-text-color-secondary); font-size: 12px; }
.phase-section { margin-top: 12px; }
.phase-heading { display: flex; align-items: baseline; gap: 8px; margin: 0 0 8px; padding-bottom: 6px; border-bottom: 1px solid var(--el-border-color-lighter); font-size: 15px; }
.phase-heading small { color: var(--el-text-color-secondary); font-size: 12px; font-weight: normal; }
.question-card { padding: 10px 12px; margin-bottom: 8px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; }
.question-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.question-badges { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.question-index { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; border-radius: 11px; background: var(--el-color-primary-light-9); color: var(--el-color-primary); font-size: 12px; font-weight: 600; }
.question-content { margin-top: 8px; font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; }
.rich-text :deep(p) { margin: 0 0 6px; }
.rich-text :deep(img) { max-width: 100%; height: auto; vertical-align: middle; }
.rich-text :deep(table) { max-width: 100%; border-collapse: collapse; }
.rich-text :deep(td), .rich-text :deep(th) { padding: 3px 7px; border: 1px solid var(--el-border-color-light); }
.rich-text :deep(.lp-asset-missing) { display: inline-block; padding: 0 4px; border: 1px dashed var(--el-border-color); border-radius: 3px; color: var(--el-text-color-secondary); font-size: 12px; }
.question-foot { margin-top: 6px; color: var(--el-text-color-placeholder); font-size: 12px; }
.history-toolbar { display: flex; gap: 8px; margin-bottom: 10px; }
.history-pagination { margin-top: 10px; justify-content: flex-end; }
@media (max-width: 1400px) { .workspace { grid-template-columns: 260px minmax(0, 1fr); } .preview-panel { grid-column: 1 / -1; } }
@media (max-width: 900px) { .workspace { grid-template-columns: 1fr; } .preview-panel { grid-column: auto; } .form-grid { grid-template-columns: 1fr; } }
</style>
