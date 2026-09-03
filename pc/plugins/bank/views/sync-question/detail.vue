<template>
  <div class="app-container question-task-detail">
    <header class="page-heading">
      <div class="heading-copy">
        <el-button link type="primary" :icon="ArrowLeft" @click="goBack">返回任务列表</el-button>
        <h2>同步题库任务详情</h2>
        <p>采集中实时展示目录进度；任务完成后，目录和题目对比仍只读取各教材绑定的不可变快照。</p>
      </div>
      <div class="heading-actions">
        <el-button :icon="Refresh" :loading="loading" @click="refreshTask">刷新状态</el-button>
        <el-button
          v-if="task && task.status === 'completed' && task.eligible"
          v-hasPermi="['bank:sync:question:apply']"
          type="primary"
          :icon="Upload"
          :disabled="task.isCurrent"
          :loading="acting"
          @click="applyTask"
        >{{ questionApplyActionLabel(task) }}</el-button>
        <el-button v-if="task && canResumeSyncTask(task)" v-hasPermi="['bank:sync:question:resume', 'bank:sync:run']" type="primary" plain :icon="RefreshRight" :loading="acting" :disabled="acting" @click="resumeTask">断点续采</el-button>
        <el-button v-if="task && canCancelSyncTask(task.status)" v-hasPermi="['bank:sync:question:cancel', 'bank:sync:run']" type="danger" plain :icon="VideoPause" :loading="acting" @click="stopTask">停止任务</el-button>
        <el-button v-if="task && canRetrySyncTask(task.status)" v-hasPermi="['bank:sync:question:retry', 'bank:sync:question:add', 'bank:sync:run']" type="warning" plain :icon="RefreshRight" :loading="acting" @click="retryTask">重试任务</el-button>
      </div>
    </header>

    <el-alert v-if="requestError" class="state-alert" type="error" :closable="false" show-icon>{{ requestError }}</el-alert>
    <el-alert
      v-if="applySuccess"
      class="state-alert"
      type="success"
      title="正式题库快照已切换"
      :description="applySuccess"
      show-icon
      @close="applySuccess = ''"
    />
    <el-alert v-if="task?.status === 'completed'" class="state-alert" type="success" :closable="false" show-icon>
      {{ completedStateMessage }}
    </el-alert>
    <el-alert v-if="task?.status === 'interrupted'" class="state-alert" type="warning" :closable="false" show-icon>
      <template v-if="task.autoResumePending">已保留完整页断点，系统将于 {{ formatTaskTime(task.autoResumeNextAt) }} 自动续采（{{ task.autoResumeAttempt }}/{{ task.autoResumeMaxAttempts }}）。</template>
      <template v-else>已有快照和断点保留，可断点续采；也可重试从头创建新任务。</template>
    </el-alert>
    <el-alert v-if="task?.status === 'blocked' && task?.resumeAvailable" class="state-alert" type="warning" :closable="false" show-icon>
      已保留完整页断点。请先确认滑块/403 等风控已解除，再点击“断点续采”；阻断任务不会自动重试。
    </el-alert>
    <el-alert v-if="task?.status === 'completed' && task?.eligible && task?.isCurrent" class="state-alert" type="info" :closable="false" show-icon>
      当前任务快照已是正式题库，重复提交不会产生新的应用历史。
    </el-alert>
    <el-alert v-if="task?.status === 'completed' && task?.eligible && !task?.isCurrent && questionApplyWillReplace(task)" class="state-alert" type="warning" :closable="false" show-icon>
      本次应用将替换以下教材的当前正式题库快照：{{ affectedTextbookLabel }}。旧快照仍可回退或恢复。
    </el-alert>
    <el-alert v-if="task?.status === 'completed' && !task?.eligible && task?.eligibilityMessage" class="state-alert" type="warning" :closable="false" show-icon>
      当前任务暂不可应用：{{ task.eligibilityMessage }}
    </el-alert>

    <section v-if="task" class="live-catalog-panel panel" aria-label="动态目录树">
      <div class="workspace-heading live-workspace-heading">
        <div>
          <h3>{{ liveScopeTitle }}</h3>
          <p>动态目录树 · 每个目录显示自身已采集题目数，不合并父子目录。</p>
        </div>
        <el-select
          v-if="task.scopeItems.length > 1"
          v-model="selectedScopeKey"
          placeholder="选择任务教材"
          filterable
          class="scope-select"
          @change="handleScopeChange"
        >
          <el-option v-for="scope in task.scopeItems" :key="scopeKey(scope)" :label="scope.textbookName" :value="scopeKey(scope)" />
        </el-select>
      </div>
      <div class="live-tree-toolbar">
        <span v-if="liveProjection?.treeTruncated">目录较多，当前仅展示前 {{ liveProjection.treeNodeCount || liveCatalogTree.length }} 个节点</span>
        <span v-else>{{ liveCatalogTree.length ? `共 ${liveProjection?.catalogCount || liveCatalogTree.length} 个目录节点` : '目录树准备中' }}</span>
        <span v-if="liveProjection?.statisticsPending" class="live-stat-pending">统计总数中</span>
      </div>
      <div class="live-tree-scroll" v-loading="loading">
        <el-tree
          v-if="liveCatalogTree.length"
          :data="liveCatalogTree"
          node-key="nodeKey"
          :props="treeProps"
          default-expand-all
          :expand-on-click-node="false"
        >
          <template #default="{ data }">
            <span class="live-catalog-node">
              <span class="node-label">{{ data.label }}</span>
              <span class="live-node-count">{{ liveNodeCountText(data) }}</span>
            </span>
          </template>
        </el-tree>
        <el-empty
          v-else
          :image-size="64"
          :description="liveTreeEmptyText"
        />
      </div>
    </section>

    <section v-if="task" class="task-summary panel" v-loading="loading">
      <div class="status-line">
        <div><span class="task-number">{{ liveScopeTitle }}</span><el-tag :type="syncTaskStatusMeta(task.status).type">{{ syncTaskStatusMeta(task.status).label }}</el-tag></div>
        <span class="progress-copy">{{ summaryProgressLabel }}</span>
      </div>
      <el-progress :percentage="summaryProgressBar" :status="progressStatus" :stroke-width="10" :format="summaryProgressFormat" />
      <div class="summary-stat-grid">
        <div class="summary-stat"><span>章节</span><strong>{{ liveStats.chapterCount }}</strong></div>
        <div class="summary-stat"><span>知识点</span><strong>{{ liveStats.knowledgePointCount }}</strong></div>
        <div class="summary-stat"><span>二级知识点</span><strong>{{ liveStats.secondaryKnowledgePointCount }}</strong></div>
        <div class="summary-stat summary-stat-wide"><span>总题目</span><strong>{{ summaryTotalQuestionText }}</strong></div>
        <div class="summary-stat summary-stat-wide"><span>已采集</span><strong>{{ summaryCollectedQuestionText }}</strong></div>
      </div>
      <div class="summary-time-line">
        <span>开始时间：{{ formatTaskTime(summaryStartedAt) }}</span>
        <span>结束时间：{{ summaryFinishedAt }}</span>
      </div>
      <el-alert v-if="task.errorMessage" class="inner-alert" type="error" :closable="false" show-icon>{{ task.errorMessage }}</el-alert>
      <section class="log-panel">
        <div class="section-heading"><h3>运行日志</h3><span>自动刷新最后 100 条</span></div>
        <pre v-if="task.logs.length">{{ task.logs.join('\n') }}</pre>
        <el-empty v-else :image-size="54" description="暂无运行日志" />
      </section>
    </section>

    <section v-if="task && task.status === 'completed'" class="comparison-workspace panel">
      <div class="workspace-heading">
        <div><h3>任务快照对比</h3><p>先选择本任务中的一本教材，再查看该教材的目录或题目。</p></div>
        <el-select v-model="selectedScopeKey" placeholder="选择任务教材" filterable class="scope-select" @change="handleScopeChange">
          <el-option v-for="scope in task.scopeItems" :key="scopeKey(scope)" :label="scope.textbookName" :value="scopeKey(scope)" />
        </el-select>
      </div>
      <el-alert v-if="!task.scopeItems.length" type="warning" :closable="false" show-icon>任务详情未返回教材范围，暂时无法请求单本教材快照。</el-alert>

      <el-tabs v-if="task.scopeItems.length" v-model="activeTab" class="comparison-tabs" @tab-change="handleTabChange">
        <el-tab-pane label="目录对比" name="catalog">
          <el-alert v-if="catalogError" class="tab-alert" type="error" :closable="false" show-icon>{{ catalogError }}</el-alert>
          <div class="tree-toolbar">
            <span>匹配规则：sourceProvider + externalNodeId</span>
            <el-button link type="primary" :icon="Refresh" :loading="catalogLoading" @click="loadCatalogComparison">刷新目录</el-button>
          </div>
          <div class="catalog-grid" v-loading="catalogLoading">
            <section class="tree-pane">
              <div class="pane-heading"><h4>本次抓取</h4><span>点击已有/变化节点定位右侧</span></div>
              <div class="tree-scroll">
                <el-tree ref="fetchedTreeRef" :data="catalogComparison.fetchedTree" node-key="nodeKey" :props="treeProps" default-expand-all :expand-on-click-node="false" highlight-current @node-click="locateCurrentCatalog">
                  <template #default="{ data }">
                    <span class="catalog-node" :id="catalogDomId('fetched', data)">
                      <span class="node-label">{{ data.label }}</span>
                      <el-tag size="small" :type="taskComparisonStatusMeta(data.comparisonStatus).type">{{ taskComparisonStatusMeta(data.comparisonStatus).label }}</el-tag>
                    </span>
                  </template>
                </el-tree>
                <el-empty v-if="!catalogLoading && !catalogComparison.fetchedTree.length" :image-size="64" description="该任务快照暂无目录" />
              </div>
            </section>
            <section class="tree-pane">
              <div class="pane-heading"><h4>当前正式目录</h4><span>不会因本次未抓到而自动删除</span></div>
              <div class="tree-scroll">
                <el-tree ref="currentTreeRef" :data="catalogComparison.currentTree" node-key="nodeKey" :props="treeProps" default-expand-all :expand-on-click-node="false" highlight-current>
                  <template #default="{ data }"><span class="catalog-node" :id="catalogDomId('current', data)"><span class="node-label">{{ data.label }}</span></span></template>
                </el-tree>
                <el-empty v-if="!catalogLoading && !catalogComparison.currentTree.length" :image-size="64" description="当前正式库暂无目录" />
              </div>
            </section>
          </div>
        </el-tab-pane>

        <el-tab-pane label="题目对比" name="question">
          <el-alert v-if="questionError" class="tab-alert" type="error" :closable="false" show-icon>{{ questionError }}</el-alert>
          <el-form :inline="true" :model="questionFilters" class="question-filters" @submit.prevent="searchQuestions">
            <el-form-item label="目录">
              <el-select v-model="questionFilters.catalogId" clearable filterable placeholder="全部目录" class="catalog-select">
                <el-option v-for="item in catalogOptions" :key="String(item.value)" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="题型">
              <el-select v-model="questionFilters.questionType" clearable filterable placeholder="全部题型" class="type-select">
                <el-option v-for="item in questionTypeOptions" :key="String(item.value)" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="关键词"><el-input v-model="questionFilters.keyword" maxlength="120" show-word-limit clearable placeholder="搜索题干、答案或解析" @keyup.enter="searchQuestions" /></el-form-item>
            <el-form-item label="差异">
              <el-select v-model="questionFilters.comparisonStatus" clearable placeholder="全部差异" class="status-select">
                <el-option v-for="item in taskComparisonStatusOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item><el-button type="primary" :icon="Search" @click="searchQuestions">查询</el-button><el-button :icon="RefreshLeft" @click="resetQuestionFilters">重置</el-button></el-form-item>
          </el-form>
          <div class="server-page-hint">服务端按本任务完整快照计算 {{ questionPage.total }} 道题；浏览器当前只加载第 {{ questionFilters.pageNum }} 页。</div>
          <el-table v-loading="questionLoading" :data="questionRows" stripe size="small" row-key="key" class="question-table" @row-click="openQuestionDetail">
            <el-table-column label="差异" width="82" align="center"><template #default="scope"><el-tag size="small" :type="taskComparisonStatusMeta(scope.row.comparisonStatus).type">{{ taskComparisonStatusMeta(scope.row.comparisonStatus).label }}</el-tag></template></el-table-column>
            <el-table-column prop="externalQuestionId" label="外部题目 ID" min-width="145" show-overflow-tooltip />
            <el-table-column label="目录" min-width="130" show-overflow-tooltip><template #default="scope">{{ scope.row.catalogName || scope.row.catalogId || '—' }}</template></el-table-column>
            <el-table-column label="题型" width="110" show-overflow-tooltip><template #default="scope">{{ scope.row.questionType || '—' }}</template></el-table-column>
            <el-table-column label="题干摘要" min-width="300" show-overflow-tooltip><template #default="scope">{{ scope.row.stemText || '暂无题干' }}</template></el-table-column>
            <el-table-column label="操作" width="106" fixed="right" align="center"><template #default="scope"><el-button link type="primary" :icon="View" @click.stop="openQuestionDetail(scope.row)">左右对比</el-button></template></el-table-column>
          </el-table>
          <el-empty v-if="!questionLoading && !questionRows.length" :image-size="70" description="暂无符合筛选条件的题目" />
          <footer class="table-footer">
            <span>共 {{ questionPage.total }} 道题</span>
            <el-pagination v-model:current-page="questionFilters.pageNum" v-model:page-size="questionFilters.pageSize" :total="questionPage.total" :page-sizes="[10, 20, 50, 100]" layout="sizes, prev, pager, next, total" background @size-change="loadQuestions" @current-change="loadQuestions" />
          </footer>
        </el-tab-pane>
      </el-tabs>
    </section>


    <el-drawer v-model="questionDetailVisible" title="题目快照对比" direction="rtl" size="min(1100px, 96vw)" append-to-body>
      <el-skeleton v-if="questionDetailLoading" :rows="10" animated />
      <el-alert v-else-if="questionDetailError" type="error" :closable="false" show-icon>{{ questionDetailError }}</el-alert>
      <template v-else-if="questionDetail">
        <div class="question-detail-meta">
          <el-tag :type="taskComparisonStatusMeta(questionDetail.comparisonStatus).type">{{ taskComparisonStatusMeta(questionDetail.comparisonStatus).label }}</el-tag>
          <span>外部 ID：{{ questionDetail.externalQuestionId || '—' }}</span>
          <span>题型：{{ questionDetail.questionType || '—' }}</span>
          <span>目录：{{ questionDetail.catalogName || questionDetail.catalogId || '—' }}</span>
        </div>
        <div v-if="questionDetail.diffFields?.length" class="diff-fields"><span>变化字段：</span><el-tag v-for="field in questionDetail.diffFields" :key="field" size="small" type="warning">{{ field }}</el-tag></div>
        <div class="question-compare-grid">
          <QuestionSnapshot title="本次抓取" :snapshot="questionDetail.fetched" />
          <QuestionSnapshot title="当前正式题目" :snapshot="questionDetail.current" />
        </div>
      </template>
      <el-empty v-else description="未找到题目快照" />
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ArrowLeft, Refresh, RefreshLeft, RefreshRight, Search, Upload, VideoPause, View } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import {
  cancelQuestionSyncTask,
  applyQuestionSyncTask,
  getQuestionSyncCatalogComparison,
  getQuestionSyncQuestionComparison,
  getQuestionSyncQuestionDetail,
  getQuestionSyncTask,
  resumeQuestionSyncTask,
  retryQuestionSyncTask,
} from '../../api/bank'
import { sanitizeHtml } from '../../utils/html'
import {
  flattenCatalogTree,
  findCurrentCatalogNode,
  normalizeCatalogComparison,
  normalizeQuestionComparisonPage,
  normalizeQuestionDetail,
  taskComparisonStatusMeta,
  taskComparisonStatusOptions,
} from '../../utils/sync-question'
import {
  canCancelSyncTask,
  canResumeSyncTask,
  canRetrySyncTask,
  formatQuestionApplyStats,
  formatTaskTime,
  isActiveSyncTask,
  questionApplyActionLabel,
  questionApplyAffectedTextbooks,
  questionApplyCurrentTaskSummary,
  questionApplyCurrentTaskId,
  questionApplyStateToken,
  questionApplyVerb,
  questionApplyWillReplace,
  syncTaskErrorMessage,
  syncTaskStatusMeta,
  unwrapSyncTask,
} from '../../utils/sync-task'

const QuestionSnapshot = defineComponent({
  name: 'QuestionSyncSnapshot',
  props: { title: { type: String, required: true }, snapshot: { type: Object, default: null } },
  setup(props) {
    const htmlBlock = (label, value) => h('section', { class: 'snapshot-section' }, [
      h('h5', label),
      value
        ? h('div', { class: 'safe-html', innerHTML: sanitizeHtml(value) })
        : h('div', { class: 'snapshot-empty' }, '暂无内容'),
    ])
    return () => h('section', { class: 'question-snapshot' }, [
      h('h4', props.title),
      props.snapshot
        ? h('div', null, [
          htmlBlock('题干', props.snapshot.stemHtml),
          props.snapshot.solutionHtml && !props.snapshot.answerHtml && !props.snapshot.analysisHtml
            ? htmlBlock('来源答案/解析（未分类）', props.snapshot.solutionHtml)
            : null,
          props.snapshot.answerHtml ? htmlBlock('答案', props.snapshot.answerHtml) : null,
          props.snapshot.analysisHtml ? htmlBlock('解析', props.snapshot.analysisHtml) : null,
        ].filter(Boolean))
        : h('div', { class: 'snapshot-missing' }, '当前正式题库中不存在该外部 ID'),
    ])
  },
})

const route = useRoute()
const router = useRouter()
const task = ref(null)
const loading = ref(false)
const acting = ref(false)
const requestError = ref('')
const applySuccess = ref('')
const activeTab = ref('catalog')
const selectedScopeKey = ref('')
const catalogLoading = ref(false)
const catalogError = ref('')
const catalogComparison = reactive({ fetchedTree: [], currentTree: [], summary: {}, sourceAvailable: undefined, sourceMessage: '' })
const fetchedTreeRef = ref()
const currentTreeRef = ref()
const treeProps = { label: 'label', children: 'children' }
const questionLoading = ref(false)
const questionError = ref('')
const questionRows = ref([])
const questionPage = reactive({ total: 0 })
const remoteQuestionTypes = ref([])
const questionFilters = reactive({ catalogId: '', questionType: '', keyword: '', comparisonStatus: '', pageNum: 1, pageSize: 20 })
const questionDetailVisible = ref(false)
const questionDetailLoading = ref(false)
const questionDetailError = ref('')
const questionDetail = ref(null)
let pollTimer = null
let mounted = false
let loadedScopeKey = ''

const taskId = computed(() => String(route.params.taskId || route.query.taskId || ''))
const selectedScope = computed(() => task.value?.scopeItems.find((item) => scopeKey(item) === selectedScopeKey.value) || null)
const liveProjection = computed(() => {
  const scope = selectedScope.value
  const byScope = task.value?.liveProgressByScope || {}
  const keys = [scope?.externalTextbookId, scope?.textbookId, scope ? scopeKey(scope) : '']
    .filter((value, index, values) => value !== undefined && value !== null && String(value) !== '' && values.indexOf(value) === index)
  for (const key of keys) {
    const candidate = byScope[String(key)]
    if (candidate && candidate.available !== false) return candidate
  }
  const scoped = scope?.liveProgress
  if (scoped && scoped.available !== false) return scoped
  const taskLive = task.value?.liveProgress
  if (!taskLive || taskLive.available === false) return null
  const taskLiveTextbookId = taskLive.textbookExternalId
  const scopeTextbookId = scope?.externalTextbookId
  if (
    task.value?.scopeItems?.length > 1
    && taskLiveTextbookId != null
    && scopeTextbookId != null
    && String(taskLiveTextbookId) !== String(scopeTextbookId)
  ) return null
  return taskLive
})
const liveScopeTitle = computed(() => {
  const scope = selectedScope.value || task.value?.scopeItems?.[0] || {}
  const version = String(scope.versionName || task.value?.versionName || '').trim()
  const textbook = String(scope.textbookName || task.value?.currentTextbookName || task.value?.textbookNames?.[0] || '').trim()
  if (version && textbook && version !== textbook) return `${version} · ${textbook}`
  return textbook || version || '任务教材'
})
const liveCatalogTree = computed(() => {
  if (liveProjection.value?.tree?.length) return liveProjection.value.tree
  if (task.value?.status === 'completed' && catalogComparison.fetchedTree.length) {
    return comparisonTreeAsLive(catalogComparison.fetchedTree)
  }
  return []
})
const liveStats = computed(() => {
  const counts = countLiveTreeLevels(liveCatalogTree.value)
  const live = liveProjection.value
  return {
    chapterCount: Number(live?.chapterCount || counts.chapter),
    knowledgePointCount: Number(live?.knowledgePointCount || counts.knowledgePoint),
    secondaryKnowledgePointCount: Number(live?.secondaryKnowledgePointCount || counts.secondaryKnowledgePoint),
  }
})
const summaryProgressValue = computed(() => {
  const value = liveProjection.value?.progressPercent
    ?? liveProjection.value?.progress
    ?? task.value?.progressPercent
    ?? task.value?.progress
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : null
})
const summaryProgressBar = computed(() => summaryProgressValue.value ?? 0)
const summaryProgressLabel = computed(() => summaryProgressValue.value == null ? '统计总数中' : `${Math.round(summaryProgressValue.value)}%`)
const summaryTotalQuestionText = computed(() => {
  const value = liveProjection.value?.totalQuestionCount
  if (value != null) return formatLiveCount(value)
  if (task.value?.status !== 'completed') return '统计总数中'
  return formatLiveCount(selectedScope.value?.questionCount ?? task.value?.questionCount)
})
const summaryCollectedQuestionText = computed(() => {
  const value = liveProjection.value?.collectedQuestionCount
  if (value != null) return formatLiveCount(value)
  if (task.value?.status !== 'completed') return '统计中'
  return formatLiveCount(selectedScope.value?.questionCount ?? task.value?.questionCount)
})
const summaryStartedAt = computed(() => liveProjection.value?.startedAt || task.value?.startedAt || '')
const summaryFinishedAt = computed(() => {
  if (isActiveSyncTask(task.value?.status)) return '采集中'
  return formatTaskTime(liveProjection.value?.finishedAt || task.value?.completedAt || task.value?.finishedAt) || '—'
})
const liveTreeEmptyText = computed(() => {
  if (['failed', 'blocked'].includes(task.value?.status)) return '暂未读取到本次运行目录'
  if (task.value?.status === 'cancelled' || task.value?.status === 'interrupted') return '该任务暂无可展示的目录进度'
  return '目录树准备中，正在获取节点统计'
})
const progressStatus = computed(() => {
  if (['failed', 'blocked'].includes(task.value?.status)) return 'exception'
  if (task.value?.status === 'cancelled') return 'warning'
  if (task.value?.status === 'interrupted') return 'warning'
  if (task.value?.status === 'completed') return 'success'
  return undefined
})
const catalogOptions = computed(() => flattenCatalogTree(catalogComparison.fetchedTree))
const questionTypeOptions = computed(() => {
  const values = new Map(remoteQuestionTypes.value.map((item) => [String(item.value), item]))
  questionRows.value.forEach((row) => {
    if (row.questionType && !values.has(String(row.questionType))) values.set(String(row.questionType), { value: row.questionType, label: row.questionType })
  })
  return [...values.values()]
})
const affectedTextbookLabel = computed(() => {
  const names = questionApplyAffectedTextbooks(task.value || {})
  return names.length ? names.join('、') : '任务范围内的教材'
})
const currentFormalSummary = computed(() => questionApplyCurrentTaskSummary(task.value || {}))
const completedStateMessage = computed(() => {
  if (task.value?.isCurrent) return '采集已完成，且本任务快照已应用为当前正式题库。'
  if (task.value?.eligible) return `采集已完成。请先核对下方快照差异，再确认${questionApplyVerb(task.value)}正式题库快照。`
  return '采集已完成，但当前快照暂不可应用。'
})

function formatLiveCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number).toLocaleString('zh-CN') : '—'
}

function countLiveTreeLevels(tree) {
  const counts = { chapter: 0, knowledgePoint: 0, secondaryKnowledgePoint: 0 }
  const visit = (nodes) => {
    if (!Array.isArray(nodes)) return
    nodes.forEach((node) => {
      const level = Number(node?.level ?? node?.nodeLevel)
      if (level === 1) counts.chapter += 1
      if (level === 2) counts.knowledgePoint += 1
      if (level === 3) counts.secondaryKnowledgePoint += 1
      visit(node?.children)
    })
  }
  visit(tree)
  return counts
}

function comparisonTreeAsLive(nodes, depth = 0) {
  if (!Array.isArray(nodes)) return []
  return nodes.map((node, index) => {
    const externalId = String(node?.externalId || node?.externalCatalogId || node?.catalogExternalId || node?.value || `catalog-${depth}-${index}`)
    const label = String(node?.label || node?.name || node?.title || externalId)
    const level = Number(node?.level ?? node?.nodeLevel ?? depth + 1)
    const collectedCount = Number(node?.collectedCount ?? node?.questionCount ?? 0)
    // A completed snapshot comparison carries the final per-catalog
    // occurrence count even when the mutable live projection is unavailable.
    // Use it as the completed node total so the fallback tree still shows
    // the same final numbers instead of marking every node as unqueried.
    const expectedTotal = node?.expectedTotal ?? node?.expected
      ?? (node?.questionCount == null ? null : node.questionCount)
    return {
      ...node,
      nodeKey: String(node?.nodeKey || externalId),
      externalId,
      label,
      name: label,
      level: Number.isFinite(level) ? level : depth + 1,
      nodeLevel: Number.isFinite(level) ? level : depth + 1,
      expectedTotal: expectedTotal == null ? null : Number(expectedTotal),
      collectedCount: Number.isFinite(collectedCount) ? Math.max(0, collectedCount) : 0,
      queried: expectedTotal != null,
      hasProgress: expectedTotal != null,
      children: comparisonTreeAsLive(node?.children, depth + 1),
    }
  })
}

function liveNodeCountText(node) {
  const collected = formatLiveCount(node?.collectedCount ?? node?.collected ?? node?.listSeenCount ?? node?.questionCount ?? 0)
  const expected = node?.expectedTotal ?? node?.expected ?? node?.total
  const queried = node?.queried ?? node?.hasProgress ?? expected != null
  if (!queried || (expected == null && String(node?.status || 'pending') === 'pending')) return '暂未获取'
  return expected == null ? `${collected} / 统计中` : `${collected} / ${formatLiveCount(expected)}`
}

function summaryProgressFormat() { return summaryProgressLabel.value }

function scopeKey(scope) {
  return String(scope?.scopeId || scope?.textbookId || scope?.externalTextbookId || scope?.collectorRunId || scope?.textbookName || '')
}

function scopeQuery() {
  const scope = selectedScope.value
  return scope ? {
    scopeId: scope.scopeId || undefined,
    textbookId: scope.textbookId || undefined,
    externalTextbookId: scope.externalTextbookId || undefined,
    collectorRunId: scope.collectorRunId || undefined,
  } : {}
}

function goBack() { router.push('/bank/sync-question') }
function clearPoll() { if (pollTimer !== null) window.clearTimeout(pollTimer); pollTimer = null }
function schedulePoll() {
  clearPoll()
  if (!mounted || !task.value || !isActiveSyncTask(task.value.status)) return
  pollTimer = window.setTimeout(async () => { pollTimer = null; await loadTask(true) }, 2500)
}

function selectDefaultScope() {
  const scopes = task.value?.scopeItems || []
  if (!scopes.length) { selectedScopeKey.value = ''; return }
  if (!scopes.some((item) => scopeKey(item) === selectedScopeKey.value)) {
    const preferred = scopes.find((item) => (
      task.value?.currentTextbookId != null
      && String(item.externalTextbookId || item.textbookId) === String(task.value.currentTextbookId)
    )) || scopes.find((item) => item.liveProgress?.tree?.length)
      || scopes.find((item) => ['running', 'starting'].includes(item.status))
      || scopes[0]
    selectedScopeKey.value = scopeKey(preferred)
  }
}

async function ensureComparisonLoaded() {
  if (task.value?.status !== 'completed') return
  selectDefaultScope()
  if (!selectedScopeKey.value || loadedScopeKey === selectedScopeKey.value) return
  loadedScopeKey = selectedScopeKey.value
  if (activeTab.value === 'catalog') await loadCatalogComparison()
  else await loadQuestions()
}

async function loadTask(silent = false) {
  if (!taskId.value) { requestError.value = '缺少任务编号，无法加载详情'; task.value = null; return }
  if (!silent) loading.value = true
  requestError.value = ''
  try {
    const result = unwrapSyncTask(await getQuestionSyncTask(taskId.value), 'question')
    if (!result) throw new Error('未找到同步题库任务')
    task.value = result
    selectDefaultScope()
    await ensureComparisonLoaded()
  } catch (error) {
    requestError.value = syncTaskErrorMessage(error, '同步题库任务详情加载失败')
  } finally {
    if (!silent) loading.value = false
    schedulePoll()
  }
}

async function refreshTask() { loadedScopeKey = ''; await loadTask() }

async function handleScopeChange() {
  // Keep the completed-snapshot loader armed while a scope is being viewed
  // during collection.  Otherwise the first completed poll would see the
  // same key and incorrectly skip loading the comparison workspace.
  loadedScopeKey = task.value?.status === 'completed' ? selectedScopeKey.value : ''
  resetComparisonState()
  if (task.value?.status !== 'completed') return
  if (activeTab.value === 'catalog') await loadCatalogComparison()
  else await loadQuestions()
}

function resetComparisonState() {
  Object.assign(catalogComparison, { fetchedTree: [], currentTree: [], summary: {}, sourceAvailable: undefined, sourceMessage: '' })
  questionRows.value = []
  questionPage.total = 0
  remoteQuestionTypes.value = []
  Object.assign(questionFilters, { catalogId: '', questionType: '', keyword: '', comparisonStatus: '', pageNum: 1 })
}

async function handleTabChange(name) {
  if (!selectedScope.value) return
  if (name === 'catalog' && !catalogComparison.fetchedTree.length && !catalogLoading.value) await loadCatalogComparison()
  if (name === 'question' && !questionRows.value.length && !questionLoading.value) await loadQuestions()
}

async function loadCatalogComparison() {
  if (!selectedScope.value || catalogLoading.value) return
  catalogLoading.value = true
  catalogError.value = ''
  try {
    const result = normalizeCatalogComparison(await getQuestionSyncCatalogComparison(taskId.value, scopeQuery()))
    Object.assign(catalogComparison, result)
    if (result.sourceAvailable === false) catalogError.value = result.sourceMessage || '该教材未生成可用的目录快照'
  } catch (error) {
    Object.assign(catalogComparison, { fetchedTree: [], currentTree: [], summary: {} })
    catalogError.value = syncTaskErrorMessage(error, '目录快照对比加载失败')
  } finally { catalogLoading.value = false }
}

function catalogDomId(side, node) {
  return `sync-catalog-${side}-${encodeURIComponent(node.nodeKey).replace(/%/g, '_')}`
}

function expandTreeNode(treeRef, key) {
  const node = treeRef.value?.getNode(key)
  let parent = node?.parent
  while (parent) { parent.expanded = true; parent = parent.parent }
}

async function locateCurrentCatalog(sourceNode) {
  if (sourceNode.comparisonStatus === 'new') {
    ElMessage.info(`目录“${sourceNode.label}”是本次新增，当前正式目录中暂无对应节点。`)
    return
  }
  const current = findCurrentCatalogNode(catalogComparison.currentTree, sourceNode)
  if (!current) {
    ElMessage.warning(`未按 sourceProvider + externalNodeId 找到“${sourceNode.label}”的正式目录节点。`)
    return
  }
  expandTreeNode(currentTreeRef, current.nodeKey)
  currentTreeRef.value?.setCurrentKey(current.nodeKey)
  await nextTick()
  const element = document.getElementById(catalogDomId('current', current))
  element?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  element?.classList.add('is-locate-highlight')
  window.setTimeout(() => element?.classList.remove('is-locate-highlight'), 1900)
}

function questionQuery() {
  return {
    ...scopeQuery(),
    catalogId: questionFilters.catalogId || undefined,
    questionType: questionFilters.questionType || undefined,
    keyword: questionFilters.keyword || undefined,
    comparisonStatus: questionFilters.comparisonStatus || undefined,
    pageNum: questionFilters.pageNum,
    pageSize: questionFilters.pageSize,
  }
}

async function loadQuestions() {
  if (!selectedScope.value || questionLoading.value) return
  questionLoading.value = true
  questionError.value = ''
  try {
    const page = normalizeQuestionComparisonPage(await getQuestionSyncQuestionComparison(taskId.value, questionQuery()))
    questionRows.value = page.rows
    questionPage.total = page.total
    if (page.questionTypes.length) remoteQuestionTypes.value = page.questionTypes
  } catch (error) {
    questionRows.value = []
    questionPage.total = 0
    questionError.value = syncTaskErrorMessage(error, '题目快照对比加载失败')
  } finally { questionLoading.value = false }
}

function searchQuestions() { questionFilters.pageNum = 1; loadQuestions() }
function resetQuestionFilters() { Object.assign(questionFilters, { catalogId: '', questionType: '', keyword: '', comparisonStatus: '', pageNum: 1 }); loadQuestions() }

async function openQuestionDetail(row) {
  if (!row?.externalQuestionId) {
    ElMessage.warning('该题目缺少稳定外部 ID，无法读取不可变详情快照')
    return
  }
  questionDetailVisible.value = true
  questionDetailLoading.value = true
  questionDetailError.value = ''
  questionDetail.value = null
  try {
    const detail = normalizeQuestionDetail(await getQuestionSyncQuestionDetail(taskId.value, row.externalQuestionId, {
      ...scopeQuery(),
      sourceProvider: row.sourceProvider || undefined,
    }))
    if (!detail) throw new Error('未找到题目快照')
    questionDetail.value = detail
  } catch (error) {
    questionDetailError.value = syncTaskErrorMessage(error, '题目详情对比加载失败')
  } finally { questionDetailLoading.value = false }
}

async function resumeTask() {
  if (!task.value || acting.value || !canResumeSyncTask(task.value)) return
  try {
    await ElMessageBox.confirm(
      `将继续同一个任务“${task.value.taskNo || task.value.taskId}”。Collector 新 run 会继承旧快照并从断点继续，不会直接应用正式库。${task.value.status === 'blocked' ? '请先确认风控已解除。' : ''}确定断点续采吗？`,
      '断点续采',
      { type: 'warning', confirmButtonText: '确认续采', cancelButtonText: '取消' },
    )
    acting.value = true
    const resumed = unwrapSyncTask(await resumeQuestionSyncTask(task.value.taskId), 'question')
    if (resumed?.taskId && String(resumed.taskId) !== String(task.value.taskId)) throw new Error('服务端返回了不同的任务编号')
    ElMessage.success('断点续采已提交，仍将继续原任务')
    loadedScopeKey = ''
    await loadTask()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '断点续采失败'))
  } finally { acting.value = false }
}

async function stopTask() {
  if (!task.value) return
  try {
    await ElMessageBox.confirm('停止后保留任务记录和日志，但不能进入发布批次。确定停止吗？', '停止任务', { type: 'warning', confirmButtonText: '停止', cancelButtonText: '取消' })
    acting.value = true
    await cancelQuestionSyncTask(task.value.taskId)
    ElMessage.success('停止请求已提交')
    await loadTask(true)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '任务停止失败'))
  } finally { acting.value = false }
}

async function retryTask() {
  if (!task.value) return
  try {
    await ElMessageBox.confirm('重试将按原版本和教材范围创建新任务，原任务保持不变。', '重试任务', { type: 'info', confirmButtonText: '创建新任务', cancelButtonText: '取消' })
    acting.value = true
    const retried = unwrapSyncTask(await retryQuestionSyncTask(task.value.taskId), 'question')
    if (!retried?.taskId) throw new Error('服务端未返回新任务编号')
    ElMessage.success('新任务已创建')
    await router.push(`/bank/sync-question/${encodeURIComponent(retried.taskId)}`)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '任务重试失败'))
  } finally { acting.value = false }
}

async function applyTask() {
  if (!task.value || task.value.status !== 'completed' || !task.value.eligible || task.value.isCurrent) return
  const currentTaskId = questionApplyCurrentTaskId(task.value)
  const currentTask = currentFormalSummary.value
  const targetTask = `任务 ${task.value.taskNo || task.value.taskId}`
  const action = questionApplyVerb(task.value)
  const affected = affectedTextbookLabel.value
  const replacementText = questionApplyWillReplace(task.value)
    ? `本次将替换以下教材的当前正式题库快照：${affected}。旧快照仍可回退或恢复。`
    : '本次尚未有当前正式题库快照，应用后将建立第一版正式快照。'
  try {
    applySuccess.value = ''
    await ElMessageBox.confirm(
      `确定将正式题库从“${currentTask}”切换为“${targetTask}”吗？${replacementText}目录、题目、关系、标签和素材将按本任务完整快照合并。`,
      `${action}正式题库快照`,
      { type: 'warning', confirmButtonText: `确认${action}`, cancelButtonText: '取消' },
    )
    acting.value = true
    const response = await applyQuestionSyncTask(
      task.value.taskId,
      currentTaskId || null,
      questionApplyStateToken(task.value),
    )
    const result = response?.data || response
    applySuccess.value = `${action}成功。${formatQuestionApplyStats(result)}`
    ElMessage.success({
      message: `${action}成功，已更新正式题库快照`,
      duration: 7000,
      showClose: true,
    })
    loadedScopeKey = ''
    await loadTask()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, `${action}正式题库快照失败，请确认权限并刷新任务状态后重试`))
  } finally { acting.value = false }
}

watch(taskId, () => {
  clearPoll(); loadedScopeKey = ''; task.value = null; resetComparisonState(); loadTask()
})

onMounted(() => { mounted = true; loadTask() })
onBeforeUnmount(() => { mounted = false; clearPoll() })
</script>

<style scoped>
.question-task-detail { min-height: calc(100vh - 84px); color: var(--el-text-color-primary); }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.heading-copy h2 { margin: 6px 0 0; font-size: 20px; font-weight: 600; }
.heading-copy p { max-width: 760px; margin: 6px 0 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.heading-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.state-alert { margin-bottom: 14px; }
.panel { min-width: 0; padding: 16px; border: 1px solid var(--el-border-color-light); border-radius: 8px; background: var(--el-bg-color); }
.live-catalog-panel { margin-bottom: 16px; }
.task-summary { margin-bottom: 16px; }
.status-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.status-line > div { display: flex; align-items: center; gap: 10px; }
.task-number { font-size: 16px; font-weight: 600; }
.progress-copy { color: var(--el-text-color-secondary); font-size: 13px; }
.summary-stat-grid { display: grid; grid-template-columns: repeat(5, minmax(100px, 1fr)); gap: 10px; margin-top: 16px; }
.summary-stat { min-width: 0; padding: 11px 13px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; background: var(--el-fill-color-extra-light); }
.summary-stat span { display: block; color: var(--el-text-color-secondary); font-size: 12px; }
.summary-stat strong { display: block; margin-top: 5px; color: var(--el-text-color-primary); font-size: 18px; font-weight: 600; }
.summary-time-line { display: flex; flex-wrap: wrap; gap: 8px 28px; margin-top: 14px; color: var(--el-text-color-secondary); font-size: 12px; }
.inner-alert { margin-top: 14px; }
.log-panel { margin-top: 16px; }
.section-heading, .workspace-heading, .tree-toolbar, .pane-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.section-heading { margin-bottom: 8px; }
.section-heading h3, .workspace-heading h3 { margin: 0; font-size: 15px; }
.section-heading span, .tree-toolbar, .pane-heading span { color: var(--el-text-color-secondary); font-size: 12px; }
.log-panel pre { max-height: 260px; margin: 0; overflow: auto; padding: 12px; border-radius: 6px; background: var(--el-fill-color-extra-light); white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.workspace-heading { align-items: flex-start; padding-bottom: 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
.workspace-heading p { margin: 5px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
.scope-select { width: min(380px, 48%); }
.live-tree-toolbar { display: flex; justify-content: space-between; gap: 12px; margin: 12px 0 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.live-stat-pending { color: var(--el-color-warning); }
.live-tree-scroll { min-height: 220px; max-height: min(560px, calc(100vh - 370px)); overflow: auto; padding: 8px 4px; }
.live-catalog-node { display: flex; min-width: 0; flex: 1; align-items: center; justify-content: space-between; gap: 12px; padding: 3px 5px; border-radius: 4px; }
.live-node-count { flex: 0 0 auto; color: var(--el-text-color-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.comparison-tabs { margin-top: 8px; }
.comparison-workspace { margin-bottom: 16px; }
.tab-alert { margin-bottom: 10px; }
.tree-toolbar { margin-bottom: 10px; }
.catalog-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; height: min(620px, calc(100vh - 250px)); min-height: 420px; }
.tree-pane { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; border: 1px solid var(--el-border-color-light); border-radius: 6px; }
.pane-heading { padding: 12px 14px; border-bottom: 1px solid var(--el-border-color-lighter); }
.pane-heading h4 { margin: 0; font-size: 14px; }
.tree-scroll { min-height: 0; flex: 1; overflow: auto; padding: 10px; }
.catalog-node { display: flex; min-width: 0; flex: 1; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 5px; border-radius: 4px; }
.node-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.is-locate-highlight { animation: locate-highlight 1.9s ease-out; }
@keyframes locate-highlight { 0%, 55% { background: var(--el-color-warning-light-8); box-shadow: 0 0 0 2px var(--el-color-warning-light-5); } 100% { background: transparent; box-shadow: 0 0 0 transparent; } }
.question-filters { margin-bottom: 2px; }
.question-filters :deep(.el-form-item) { margin-bottom: 10px; }
.question-filters :deep(.el-input) { width: 220px; }
.catalog-select { width: 240px; }
.type-select { width: 150px; }
.status-select { width: 130px; }
.server-page-hint { margin-bottom: 10px; color: var(--el-text-color-secondary); font-size: 12px; }
.question-table :deep(.el-table__row) { cursor: pointer; }
.table-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; color: var(--el-text-color-secondary); font-size: 12px; }
.table-footer :deep(.el-pagination) { flex-wrap: wrap; justify-content: flex-end; }
.question-detail-meta, .diff-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; color: var(--el-text-color-secondary); font-size: 12px; }
.question-compare-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
:deep(.question-snapshot) { min-width: 0; padding: 14px; border: 1px solid var(--el-border-color-light); border-radius: 7px; }
:deep(.question-snapshot > h4) { margin: 0 0 14px; font-size: 15px; }
:deep(.snapshot-section) { margin-bottom: 16px; }
:deep(.snapshot-section:last-child) { margin-bottom: 0; }
:deep(.snapshot-section h5) { margin: 0 0 7px; color: var(--el-text-color-secondary); font-size: 12px; }
:deep(.safe-html) { min-height: 42px; overflow-x: auto; padding: 10px; border-radius: 5px; background: var(--el-fill-color-extra-light); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
:deep(.safe-html img) { max-width: 100%; height: auto; }
:deep(.snapshot-empty), :deep(.snapshot-missing) { padding: 16px; border-radius: 5px; background: var(--el-fill-color-extra-light); color: var(--el-text-color-secondary); font-size: 12px; }
@media (max-width: 1000px) { .summary-stat-grid { grid-template-columns: repeat(3, minmax(100px, 1fr)); } }
@media (max-width: 900px) { .catalog-grid, .question-compare-grid { grid-template-columns: 1fr; height: auto; } .tree-pane { min-height: 420px; } .workspace-heading { flex-direction: column; } .scope-select { width: 100%; } }
@media (max-width: 720px) { .page-heading, .status-line { align-items: flex-start; flex-direction: column; } .heading-actions { justify-content: flex-start; } .table-footer { align-items: flex-start; flex-direction: column; } }
@media (max-width: 560px) { .summary-stat-grid { grid-template-columns: repeat(2, minmax(100px, 1fr)); } .summary-stat-wide { grid-column: span 2; } }
</style>
