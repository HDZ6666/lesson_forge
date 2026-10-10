<template>
  <div class="app-container sync-center-page question-task-detail">
    <header class="page-heading">
      <div class="heading-copy">
        <el-button link type="primary" :icon="ArrowLeft" @click="goBack">返回任务列表</el-button>
        <h2>同步题库任务详情</h2>
        <p>{{ isIncremental ? '查看本次采集进度、分批入库结果和待处理题数。' : '查看目录新增和题数变化，选择本次需要同步的题目。' }}</p>
      </div>
      <div class="heading-actions">
        <el-button :icon="Refresh" :loading="loading" @click="refreshTask">刷新状态</el-button>
        <el-button
          v-if="isIncremental && ['blocked', 'retry'].includes(task?.importIntake?.status)"
          v-hasPermi="['bank:sync:question:apply']" type="warning" :icon="RefreshRight"
          :loading="acting" @click="retryIntake"
        >重试封存核验</el-button>
        <el-button
          v-if="isIncremental && task?.canRequestImport && !['completed', 'partial'].includes(task.incrementalImport?.status)"
          v-hasPermi="['bank:sync:question:apply']"
          type="primary" :icon="Upload" :loading="acting"
          :disabled="acting || isActiveIncrementalImport(task)"
          @click="requestImport"
        >{{ task.incrementalImport?.status === 'failed' ? '继续入库' : '分批入库' }}</el-button>
        <el-button
          v-if="task && task.status === 'completed' && task.eligible"
          v-hasPermi="['bank:sync:question:apply']"
          type="primary"
          :icon="Upload"
          :disabled="task.isCurrent"
          :loading="acting"
          @click="applyTask"
        >{{ questionApplyActionLabel(task) }}</el-button>
        <el-button v-if="task && canResumeSyncTask(task)" v-hasPermi="['bank:sync:question:resume', 'bank:sync:run']" type="primary" plain :icon="RefreshRight" :loading="acting" :disabled="acting || isActiveIncrementalImport(task) || isActiveImportIntake(task)" @click="resumeTask">{{ task.workflowVersion === 2 ? '补采' : '断点续采' }}</el-button>
        <el-button v-if="task && canCancelSyncTask(task.status)" v-hasPermi="['bank:sync:question:cancel', 'bank:sync:run']" type="danger" plain :icon="VideoPause" :loading="acting" @click="stopTask">停止任务</el-button>
        <el-button v-if="task && canRetrySyncTask(task.status)" v-hasPermi="['bank:sync:question:retry', 'bank:sync:question:add', 'bank:sync:run']" type="warning" plain :icon="RefreshRight" :loading="acting" @click="retryTask">重试任务</el-button>
      </div>
    </header>
    <SyncCenterNav active="tasks"/>

    <div v-if="task" class="sync-panel"><TaskConcurrency :task="task" @updated="refreshTask"/></div>
    <el-alert v-if="requestError" class="state-alert" type="error" :closable="false" show-icon>{{ requestError }}</el-alert>
    <el-alert v-if="task?.progressStale" class="state-alert" type="warning" :closable="false" show-icon>
      实时进度暂不可用，当前显示已保存的数据；不会影响任务的最终验收结果。
    </el-alert>
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
    <el-alert v-if="task?.limitTo1000Pages" class="state-alert" type="warning" :closable="false" show-icon>
      <template v-if="task?.pageLimitReached || liveProjection?.pageLimitReached">本任务内目录已按“最多 1000 页”策略结束；这是策略内完成，不代表网站全量题目。</template>
      <template v-else>本任务已开启“最多 1000 页”：每个目录达到 1000 页后正常结束并继续其他目录，不以页面显示题目总数作为验收门槛。</template>
    </el-alert>
    <el-alert v-if="task?.status === 'interrupted'" class="state-alert" type="warning" :closable="false" show-icon>
      <template v-if="task.autoResumePending">已保留完整页断点，系统将于 {{ formatTaskTime(task.autoResumeNextAt) }} 自动续采（{{ task.autoResumeAttempt }}/{{ task.autoResumeMaxAttempts }}）。</template>
      <template v-else>已有成果和日志保留，可创建补采任务；也可从头重跑。</template>
    </el-alert>
    <el-alert v-if="task?.status === 'blocked' && task?.resumeAvailable" class="state-alert" type="warning" :closable="false" show-icon>
      已有成果保留。请先处理来源验证，再补采；来源暂停状态会统一限制新任务。
    </el-alert>
    <el-alert v-if="task?.status === 'completed' && task?.isCurrent" class="state-alert" type="info" :closable="false" show-icon>
      当前任务快照已是正式题库，重复提交不会产生新的应用历史。
    </el-alert>
    <el-alert v-if="task?.status === 'completed' && task?.eligible && !task?.isCurrent && questionApplyWillReplace(task)" class="state-alert" type="warning" :closable="false" show-icon>
      本次应用将替换以下教材的当前正式题库快照：{{ affectedTextbookLabel }}。旧快照仍可回退或恢复。
    </el-alert>
    <el-alert v-if="!isIncremental && task?.status === 'completed' && !task?.isCurrent && !task?.eligible && task?.eligibilityMessage" class="state-alert" type="warning" :closable="false" show-icon>
      当前任务暂不可应用：{{ task.eligibilityMessage }}
    </el-alert>

    <section v-if="task" class="task-summary panel" v-loading="loading" aria-label="本次任务信息">
      <div class="status-line">
        <div><span class="task-number">本次任务 · {{ liveScopeTitle }}</span><el-tag :type="syncTaskStatusMeta(task.status).type">{{ syncTaskStatusMeta(task.status).label }}</el-tag></div>
        <span class="progress-copy">{{ summaryProgressLabel }}</span>
      </div>
      <el-progress :percentage="summaryProgressBar" :status="progressStatus" :stroke-width="10" :format="summaryProgressFormat" />
      <p class="progress-basis">{{ summaryProgressBasis }}</p>
      <div class="summary-stat-grid">
        <div class="summary-stat"><span>章节</span><strong>{{ liveStats.chapterCount }}</strong></div>
        <div class="summary-stat"><span>知识点</span><strong>{{ liveStats.knowledgePointCount }}</strong></div>
        <div class="summary-stat"><span>二级知识点</span><strong>{{ liveStats.secondaryKnowledgePointCount }}</strong></div>
        <div class="summary-stat summary-stat-wide"><span>{{ isIncremental ? '来源报告题数' : '总题目' }}</span><strong>{{ summaryTotalQuestionText }}</strong></div>
        <div class="summary-stat summary-stat-wide"><span>已采集</span><strong>{{ summaryCollectedQuestionText }}</strong></div>
      </div>
      <div class="summary-time-line">
        <span>开始时间：{{ formatTaskTime(summaryStartedAt) }}</span>
        <span>结束时间：{{ summaryFinishedAt }}</span>
      </div>
      <el-alert v-if="task.errorMessage" class="inner-alert" type="error" :closable="false" show-icon>{{ task.errorMessage }}</el-alert>
      <details class="log-panel sync-disclosure">
        <summary>运行日志 · 自动刷新最后 100 条</summary>
        <pre v-if="task.logs.length" tabindex="0" aria-label="运行日志">{{ task.logs.join('\n') }}</pre>
        <el-empty v-else :image-size="54" description="暂无运行日志" />
      </details>
    </section>

    <el-alert v-if="task?.queueState === 'waiting' || (task?.status === 'queued' && task?.queueReason)" type="info" :closable="false" show-icon>
      {{ task.queueReason || '任务已保存，等待后台依次派发。可以关闭页面，排队时不占用采集执行位置。' }}
      <template v-if="task.queueNotBefore">下次检查：{{ formatTaskTime(task.queueNotBefore) }}</template>
    </el-alert>

    <section v-if="task && isIncremental" class="import-summary panel" aria-label="本次入库结果">
      <div class="section-heading"><h3>本次入库结果</h3><el-tag :type="importMeta.type">{{ importMeta.label }}</el-tag></div>
      <p>{{ importMeta.message }}</p>
      <p v-if="task.importIntake && !task.incrementalImport" class="progress-basis">
        核验尝试：{{ task.importIntake.attemptCount }} / {{ task.importIntake.attemptLimit }}
        <template v-if="task.importIntake.nextAttemptAt"> · 下次核验：{{ formatImportTime(task.importIntake.nextAttemptAt) }}</template>
      </p>
      <el-alert v-if="task.importIntake?.errorMessage && !task.incrementalImport" type="warning" :closable="false">{{ task.importIntake.errorMessage }}</el-alert>
      <p v-if="task.incrementalImport" class="progress-basis">入库编号：{{ task.incrementalImport.importId }}</p>
      <div v-if="task.incrementalImport" class="summary-stat-grid">
        <div class="summary-stat"><span>质量已检查</span><strong>{{ task.incrementalImport.checkedCount }}</strong></div>
        <div class="summary-stat"><span>入库已处理</span><strong>{{ task.incrementalImport.processedCount }}</strong></div>
        <div class="summary-stat"><span>合格已合并</span><strong>{{ task.incrementalImport.acceptedCount }}</strong></div>
        <div class="summary-stat"><span>暂缓题目</span><strong>{{ task.incrementalImport.quarantinedCount }}</strong></div>
        <div class="summary-stat"><span>已提交批次</span><strong>{{ task.incrementalImport.batchCount }}</strong></div>
      </div>
      <p v-if="task.incrementalImport" class="progress-basis">合并数包含新增、更新和内容未变化的题目；累计可用题目以教材浏览为准。</p>
      <el-alert v-if="task.incrementalImport?.errorMessage" type="error" :closable="false">{{ task.incrementalImport.errorMessage }}</el-alert>
      <RunCoverage :coverage="task.incrementalImport?.runCoverage" />
      <SyncIssues :task-id="task.taskId" />
      <ImportResults :task-id="task.taskId" :current-import-id="task.incrementalImport?.importId" :current-batch-no="task.incrementalImport?.batchCount || 0" />
    </section>

    <section v-if="task && !isIncremental" class="comparison-workspace panel">
      <div class="workspace-heading">
        <div><h3>任务快照对比</h3><p>查看本次目录更新，筛选需要同步的题目。采集过程中自动刷新。</p></div>
        <el-select v-model="selectedScopeKey" placeholder="选择任务教材" filterable class="scope-select" @change="handleScopeChange">
          <el-option v-for="scope in task.scopeItems" :key="scopeKey(scope)" :label="scope.textbookName" :value="scopeKey(scope)" />
        </el-select>
      </div>
      <el-alert v-if="!task.scopeItems.length" type="warning" :closable="false" show-icon>任务详情未返回教材范围，暂时无法请求单本教材快照。</el-alert>

      <el-tabs v-if="task.scopeItems.length" v-model="activeTab" class="comparison-tabs" @tab-change="handleTabChange">
        <el-tab-pane label="目录对比" name="catalog">
          <el-alert v-if="catalogError" class="tab-alert" type="error" :closable="false" show-icon>{{ catalogError }}</el-alert>
          <div class="tree-toolbar">
            <span>与当前正式目录对比 · {{ formatTaskTime(catalogComparison.currentComparedAt) }} · 每个目录独立去重计数</span>
            <el-button link type="primary" :icon="Refresh" :loading="catalogLoading" @click="loadCatalogComparison">刷新目录</el-button>
          </div>
          <div class="review-catalog catalog-grid" v-loading="catalogLoading">
            <section class="tree-pane">
              <div class="pane-heading"><h4>本次抓取</h4><span>点击目录筛选下方题目</span></div>
              <div class="tree-scroll">
                <el-tree ref="fetchedTreeRef" :data="catalogComparison.fetchedTree" node-key="nodeKey" :props="treeProps" default-expand-all :expand-on-click-node="false" highlight-current @node-click="selectCatalogQuestions">
                  <template #default="{ data }">
                    <span class="catalog-node" :id="catalogDomId('fetched', data)">
                      <span class="node-label">{{ data.label }}</span>
                      <span class="review-node-count">{{ reviewNodeCount(data) }}</span>
                      <el-tag v-for="tag in data.reviewTags || []" :key="tag" size="small" :type="reviewTag(tag).type">{{ reviewTag(tag).label }}</el-tag>
                      <el-button v-if="data.comparisonStatus !== 'new' && data.comparisonStatus !== 'missing'" link size="small" @click.stop="locateCurrentCatalog(data)">定位</el-button>
                    </span>
                  </template>
                </el-tree>
                <el-empty v-if="!catalogLoading && !catalogComparison.fetchedTree.length" :image-size="64" description="等待抓取目录" />
              </div>
            </section>
            <section class="tree-pane">
              <div class="pane-heading"><h4>当前正式目录</h4><span>刷新后读取最新正式库</span></div>
              <div class="tree-scroll">
                <el-tree ref="currentTreeRef" :data="catalogComparison.currentTree" node-key="nodeKey" :props="treeProps" default-expand-all :expand-on-click-node="false" highlight-current>
                  <template #default="{ data }">
                    <span class="catalog-node" :id="catalogDomId('current', data)">
                      <span class="node-label">{{ data.label }}</span>
                      <span class="review-node-count">{{ formatLiveCount(data.questionCount) }} 题</span>
                    </span>
                  </template>
                </el-tree>
                <el-empty v-if="!catalogLoading && !catalogComparison.currentTree.length" :image-size="64" description="正式库暂无该教材目录" />
              </div>
            </section>
          </div>
        </el-tab-pane>

      </el-tabs>
      <section v-if="task.scopeItems.length" class="captured-questions">
          <div class="pane-heading"><h4>本次抓取题目</h4><span>删除后本任务不再同步该题，可在“已排除”中恢复</span></div>
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
            <el-form-item label="同步选择">
              <el-select v-model="questionFilters.selection" class="status-select" @change="searchQuestions">
                <el-option label="待同步" value="included" /><el-option label="已排除" value="excluded" /><el-option label="全部抓取" value="all" />
              </el-select>
            </el-form-item>
            <el-form-item><el-button type="primary" :icon="Search" @click="searchQuestions">查询</el-button><el-button :icon="RefreshLeft" @click="resetQuestionFilters">重置</el-button></el-form-item>
          </el-form>
          <div class="review-list-toolbar"><span>当前筛选：抓取 {{ formatLiveCount(questionSummary.captured) }} 题 · 已排除 {{ formatLiveCount(questionSummary.excluded) }} 题 · 待同步 {{ formatLiveCount(questionSummary.included) }} 题</span><div><el-button :disabled="!selectedQuestions.length || acting" @click="changeQuestionSelection(selectedQuestions, true)">批量删除</el-button><el-button :disabled="!selectedQuestions.length || acting" @click="changeQuestionSelection(selectedQuestions, false)">批量恢复</el-button></div></div>
          <el-table max-height="min(560px, 60vh)" scrollbar-always-on v-loading="questionLoading" :data="questionRows" stripe size="small" row-key="key" class="question-table" @row-click="openQuestionDetail" @selection-change="selectedQuestions = $event">
            <el-table-column type="selection" width="42" />
            <el-table-column label="同步" width="82" align="center"><template #default="scope"><el-tag size="small" :type="scope.row.excluded ? 'info' : 'success'">{{ scope.row.excluded ? '已排除' : '待同步' }}</el-tag></template></el-table-column>
            <el-table-column label="基础内容对比" width="118" align="center"><template #default="scope"><el-tag size="small" :type="scope.row.comparisonStatus === 'new' ? 'success' : scope.row.comparisonStatus === 'modified' ? 'warning' : 'info'">{{ scope.row.comparisonStatus === 'new' ? '新增' : scope.row.comparisonStatus === 'modified' ? '修改' : '基础内容相同' }}</el-tag></template></el-table-column>
            <el-table-column prop="externalQuestionId" label="外部题目 ID" min-width="145" show-overflow-tooltip />
            <el-table-column label="目录" min-width="130" show-overflow-tooltip><template #default="scope">{{ scope.row.catalogName || scope.row.catalogId || '—' }}</template></el-table-column>
            <el-table-column label="题型" width="110" show-overflow-tooltip><template #default="scope">{{ scope.row.questionType || '—' }}</template></el-table-column>
            <el-table-column label="题干摘要" min-width="300" show-overflow-tooltip><template #default="scope">{{ scope.row.stemText || '暂无题干' }}</template></el-table-column>
            <el-table-column label="操作" width="150" fixed="right" align="center"><template #default="scope"><el-button link type="primary" @click.stop="openQuestionDetail(scope.row)">详情</el-button><el-button link :disabled="acting" :type="scope.row.excluded ? 'primary' : 'danger'" @click.stop="changeQuestionSelection([scope.row], !scope.row.excluded)">{{ scope.row.excluded ? '恢复' : '删除' }}</el-button></template></el-table-column>
          </el-table>
          <el-empty v-if="!questionLoading && !questionRows.length" :image-size="70" description="暂无符合筛选条件的题目" />
          <footer class="table-footer">
            <span>共 {{ questionPage.total }} 道题</span>
            <el-pagination v-model:current-page="questionFilters.pageNum" v-model:page-size="questionFilters.pageSize" :total="questionPage.total" :page-sizes="[10, 20, 50, 100]" layout="sizes, prev, pager, next, total" background @size-change="loadQuestions" @current-change="loadQuestions" />
          </footer>
      </section>
    </section>


    <el-drawer v-model="questionDetailVisible" class="detail-scroll-drawer" title="本次抓取题目详情" direction="rtl" size="min(900px, 96vw)" append-to-body>
      <el-skeleton v-if="questionDetailLoading" :rows="10" animated />
      <el-alert v-else-if="questionDetailError" type="error" :closable="false" show-icon>{{ questionDetailError }}</el-alert>
      <template v-else-if="questionDetail">
        <div class="question-detail-meta">
          <span>外部 ID：{{ questionDetail.externalQuestionId || '—' }}</span>
          <span>题型：{{ questionDetail.questionType || '—' }}</span>
          <span>目录：{{ questionDetail.catalogName || questionDetail.catalogId || '—' }}</span>
        </div>
        <div>
          <QuestionSnapshot title="本次抓取" :snapshot="questionDetail.fetched" />
          <QuestionSnapshot v-if="questionDetail.current" title="当前正式题库" :snapshot="questionDetail.current" />
          <el-empty v-else :image-size="46" description="正式题库尚无这道题" />
        </div>
      </template>
      <el-empty v-else description="未找到题目快照" />
    </el-drawer>
  </div>
</template>

<script setup>
import TaskConcurrency from '../../components/TaskConcurrency.vue'
import SyncCenterNav from '../../components/SyncCenterNav.vue'
import '../../styles/sync-center.scss'
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ArrowLeft, Refresh, RefreshLeft, RefreshRight, Search, Upload, VideoPause, View } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import {
  cancelQuestionSyncTask,
  applyQuestionSyncTask,
  requestQuestionIncrementalImport,
  retryQuestionImportIntake,
  getQuestionReviewCatalogs as getQuestionSyncCatalogComparison,
  getQuestionReviewQuestions as getQuestionSyncQuestionComparison,
  getQuestionReviewDetail as getQuestionSyncQuestionDetail,
  setQuestionReviewSelection,
  getQuestionSyncTask,
  resumeQuestionSyncTask,
  retryQuestionSyncTask,
} from '../../api/bank'
import { sanitizeHtml } from '../../utils/html'
import ImportResults from '../../components/ImportResults.vue'
import SyncIssues from '../../components/SyncIssues.vue'
import RunCoverage from '../../components/RunCoverage.vue'
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
  formatImportTime,
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
  incrementalImportMeta,
  isActiveIncrementalImport,
  isActiveImportIntake,
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
const questionSummary = reactive({ captured: 0, excluded: 0, included: 0 })
const reviewRevision = ref(null)
const selectedQuestions = ref([])
const remoteQuestionTypes = ref([])
const questionFilters = reactive({ catalogId: '', questionType: '', keyword: '', selection: 'included', pageNum: 1, pageSize: 20 })
const questionDetailVisible = ref(false)
const questionDetailLoading = ref(false)
const questionDetailError = ref('')
const questionDetail = ref(null)
let pollTimer = null
let taskLoadRevision = 0
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
// Progress is page based over the whole selected catalog set (collector
// `progressBasis: pages_estimated`).  Spell the basis out so 100% is read as
// "the scan finished", never as "the data is complete".
const summaryProgressBasis = computed(() => {
  const live = liveProjection.value
  if (!live) return isActiveSyncTask(task.value?.status) ? '进度按页数计算：已扫描页 / 全部目录估算总页数' : ''
  const parts = []
  if (live.attemptedPages != null) {
    const total = live.estimatedTotalPages != null ? ` / 约 ${formatLiveCount(live.estimatedTotalPages)} 页` : ''
    parts.push(`已扫描 ${formatLiveCount(live.attemptedPages)}${total}`)
  }
  if (live.selectedCatalogCount != null) {
    const done = live.completedCatalogCount ?? 0
    const started = live.startedCatalogCount ?? 0
    parts.push(`目录 ${formatLiveCount(done)} 完成 / ${formatLiveCount(started)} 进行中 / 共 ${formatLiveCount(live.selectedCatalogCount)}`)
  }
  if (live.estimateComplete === false && !live.scanComplete) parts.push('部分层级尚无估算依据，总页数会随采集调整')
  if (live.scanComplete) parts.push(live.dataComplete === false ? '扫描已完成，存在异常页或素材问题' : '扫描已完成')
  if (live.pageLimitReached || task.value?.pageLimitReached) parts.push('已达到每目录 1000 页策略上限（不代表网站全量）')
  return parts.join(' · ')
})
const summaryTotalQuestionText = computed(() => {
  const source = task.value?.incrementalImport?.runCoverage?.sourceReport?.count
  if (isIncremental.value && source != null) return formatLiveCount(source)
  const value = liveProjection.value?.totalQuestionCount
  if (value != null) return formatLiveCount(value)
  if (isIncremental.value) return isActiveSyncTask(task.value?.status) ? '统计总数中' : '未记录'
  if (task.value?.status !== 'completed') return '统计总数中'
  return formatLiveCount(selectedScope.value?.questionCount ?? task.value?.questionCount)
})
const summaryCollectedQuestionText = computed(() => {
  const value = liveProjection.value?.collectedQuestionCount
  if (value != null) return formatLiveCount(value)
  if (isIncremental.value) return formatLiveCount(selectedScope.value?.questionCount ?? task.value?.questionCount)
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
  if (isIncremental.value) return '本次采集已结束。分批入库结果见下方，采集结束不代表已覆盖网站全部题目。'
  if (task.value?.isCurrent) return '采集已完成，且本任务快照已应用为当前正式题库。'
  const live = liveProjection.value
  const dataIncomplete = live?.dataComplete === false
    || live?.completionQuality === 'completed_with_issues'
    || task.value?.snapshotComplete === false
  if (dataIncomplete && task.value?.status === 'completed') {
    return '页面扫描已完成，但存在失败页、重复页或素材异常，当前快照不能直接覆盖正式题库。'
  }
  if (task.value?.limitTo1000Pages && (live?.pageLimitReached || task.value?.pageLimitReached)) {
    return `采集已按每目录最多 1000 页策略完成${task.value?.eligible ? '。请先核对下方快照差异，再确认应用正式题库快照。' : '，但当前快照暂不可应用。'}`
  }
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
  const unique = formatLiveCount(node?.uniqueQuestionCount ?? node?.collectedCount ?? node?.collected ?? node?.questionCount ?? 0)
  const expected = node?.latestSourceTotal ?? node?.sourceReportedTotal ?? node?.expectedTotal ?? node?.expected ?? node?.total
  const queried = node?.queried ?? node?.hasProgress ?? expected != null
  if (!queried || (expected == null && String(node?.status || 'pending') === 'pending')) return '暂未获取'
  const attempted = Number(node?.attemptedPages ?? node?.highestAttemptedPage ?? 0)
  const target = node?.targetPages ?? node?.expectedPages
  const pagePart = target == null || target === '' ? '' : ` · ${attempted}/${Number(target)} 页`
  const issues = [
    Number(node?.failedPageCount || 0) > 0 ? `失败${Number(node.failedPageCount)}` : '',
    Number(node?.duplicatePageCount || 0) > 0 ? `重复${Number(node.duplicatePageCount)}` : '',
    Number(node?.emptyPageCount || 0) > 0 ? `空页${Number(node.emptyPageCount)}` : '',
    Number(node?.parseErrorCount || 0) > 0 ? `解析${Number(node.parseErrorCount)}` : '',
    Number(node?.assetErrorCount || 0) > 0 ? `素材${Number(node.assetErrorCount)}` : '',
  ].filter(Boolean)
  const issuePart = issues.length ? ` · ${issues.join(' ')}` : ''
  const integrity = node?.scanComplete
    ? (node?.dataComplete === false || node?.completionQuality === 'completed_with_issues' ? ' · 数据不完整' : '')
    : ''
  const countPart = expected == null ? `${unique} / 统计中` : `${unique} / ${formatLiveCount(expected)}`
  return `${countPart}${pagePart}${issuePart}${integrity}`
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

const isIncremental = computed(() => task.value?.workflowVersion === 2)
const importMeta = computed(() => incrementalImportMeta(task.value || {}))
function goBack() { router.push(isIncremental.value ? '/sync-center/tasks' : '/bank/sync-question') }
function clearPoll() { if (pollTimer !== null) window.clearTimeout(pollTimer); pollTimer = null }
function schedulePoll() {
  clearPoll()
  if (!mounted || !task.value || (!isActiveSyncTask(task.value.status) && !isActiveIncrementalImport(task.value) && !isActiveImportIntake(task.value))) return
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
  if (isIncremental.value) return
  selectDefaultScope()
  if (!selectedScopeKey.value) return
  const key = `${selectedScopeKey.value}:${task.value?.status || ''}`
  if (key === loadedScopeKey && !isActiveSyncTask(task.value?.status)) return
  loadedScopeKey = key
  await Promise.all([loadCatalogComparison(), loadQuestions()])
}

async function loadTask(silent = false) {
  const requestedTaskId = taskId.value
  const requestRevision = ++taskLoadRevision
  if (!requestedTaskId) { requestError.value = '缺少任务编号，无法加载详情'; task.value = null; return }
  if (!silent) loading.value = true
  requestError.value = ''
  try {
    const result = unwrapSyncTask(await getQuestionSyncTask(requestedTaskId), 'question')
    if (requestRevision !== taskLoadRevision || requestedTaskId !== taskId.value) return
    if (!result) throw new Error('未找到同步题库任务')
    task.value = result
    selectDefaultScope()
    // The task and its saved logs can render before the larger comparison
    // requests finish; each comparison section has its own loading/error UI.
    void ensureComparisonLoaded()
  } catch (error) {
    if (requestRevision === taskLoadRevision && requestedTaskId === taskId.value) requestError.value = syncTaskErrorMessage(error, '同步题库任务详情加载失败')
  } finally {
    if (requestRevision === taskLoadRevision) {
      if (!silent) loading.value = false
      schedulePoll()
    }
  }
}

async function refreshTask() { loadedScopeKey = ''; await loadTask() }

async function handleScopeChange() {
  loadedScopeKey = ''
  resetComparisonState()
  await ensureComparisonLoaded()
}

function resetComparisonState() {
  reviewRevision.value = null
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

function comparisonRequestKey() {
  return JSON.stringify([taskId.value, selectedScopeKey.value, task.value?.status,
    selectedScope.value?.status, selectedScope.value?.collectorRunId])
}

async function loadCatalogComparison() {
  if (!selectedScope.value || catalogLoading.value) return
  const requestedKey = comparisonRequestKey()
  catalogLoading.value = true
  catalogError.value = ''
  try {
    const result = normalizeCatalogComparison(await getQuestionSyncCatalogComparison(taskId.value, scopeQuery()))
    if (!mounted || requestedKey !== comparisonRequestKey()) return
    Object.assign(catalogComparison, result)
    if (result.sourceAvailable === false) catalogError.value = result.sourceMessage || '该教材未生成可用的目录快照'
  } catch (error) {
    if (!mounted || requestedKey !== comparisonRequestKey()) return
    Object.assign(catalogComparison, { fetchedTree: [], currentTree: [], summary: {} })
    catalogError.value = syncTaskErrorMessage(error, '目录快照对比加载失败')
  } finally {
    catalogLoading.value = false
    if (mounted && requestedKey !== comparisonRequestKey()) void loadCatalogComparison()
  }
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
    selection: questionFilters.selection,
    pageNum: questionFilters.pageNum,
    pageSize: questionFilters.pageSize,
  }
}

async function loadQuestions() {
  if (!selectedScope.value || questionLoading.value) return
  const requestedKey = JSON.stringify([comparisonRequestKey(), questionQuery()])
  questionLoading.value = true
  questionError.value = ''
  try {
    const response = await getQuestionSyncQuestionComparison(taskId.value, questionQuery())
    if (!mounted || requestedKey !== JSON.stringify([comparisonRequestKey(), questionQuery()])) return
    const page = normalizeQuestionComparisonPage(response)
    reviewRevision.value = response.data?.revision ?? response.revision ?? null
    Object.assign(questionSummary, response.data?.summary || response.summary || {})
    questionRows.value = page.rows
    questionPage.total = page.total
    if (page.questionTypes.length) remoteQuestionTypes.value = page.questionTypes
  } catch (error) {
    if (!mounted || requestedKey !== JSON.stringify([comparisonRequestKey(), questionQuery()])) return
    reviewRevision.value = null
    questionRows.value = []
    questionPage.total = 0
    questionError.value = syncTaskErrorMessage(error, '题目快照对比加载失败')
  } finally {
    questionLoading.value = false
    if (mounted && requestedKey !== JSON.stringify([comparisonRequestKey(), questionQuery()])) void loadQuestions()
  }
}

function searchQuestions() { questionFilters.pageNum = 1; loadQuestions() }
function resetQuestionFilters() { Object.assign(questionFilters, { catalogId: '', questionType: '', keyword: '', selection: 'included', pageNum: 1 }); loadQuestions() }

const reviewTags = {
  new: { label: '新增', type: 'success' }, structure: { label: '目录变更', type: 'warning' },
  increased: { label: '题数增加', type: 'success' }, decreased: { label: '题数减少', type: 'warning' },
  existing: { label: '题数相同', type: 'info' }, running: { label: '采集中', type: 'primary' },
  incomplete: { label: '未完成', type: 'warning' }, missing: { label: '本次未发现', type: 'info' },
  pending: { label: '等待抓取', type: 'info' },
}
function reviewTag(tag) { return reviewTags[tag] || { label: tag, type: 'info' } }
function reviewNodeCount(node) {
  const previous = node.oldQuestionCount == null ? '' : `旧 ${formatLiveCount(node.oldQuestionCount)} → `
  const excluded = Number(node.excludedQuestionCount || 0)
  const selection = excluded ? ` · 待同步 ${formatLiveCount(node.questionCount - excluded)} · 已排除 ${excluded}` : ''
  return `${previous}${node.questionCount == null ? '本次未抓取' : `${node.scanComplete ? '本次' : '已抓取'} ${formatLiveCount(node.questionCount)} 题`}${selection}`
}
function selectCatalogQuestions(node) {
  questionFilters.catalogId = node.externalNodeId
  searchQuestions()
}
async function changeQuestionSelection(rows, excluded) {
  try {
    await ElMessageBox.confirm(excluded ? `从本任务排除 ${rows.length} 道题？相同题号在其他目录中也将跳过，可随时恢复。` : `恢复 ${rows.length} 道题参与同步？`, excluded ? '删除抓取题目' : '恢复题目', { type: 'warning' })
    acting.value = true
    await setQuestionReviewSelection(taskId.value, { externalQuestionIds: rows.map(row => row.externalQuestionId), excluded }, scopeQuery())
    ElMessage.success(excluded ? '已排除，同步时将跳过这些题目' : '已恢复')
    await Promise.all([loadQuestions(), loadCatalogComparison()])
    if (!questionRows.value.length && questionFilters.pageNum > 1) { questionFilters.pageNum--; await loadQuestions() }
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '题目选择保存失败'))
  } finally { acting.value = false }
}

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
      task.value.workflowVersion === 2 ? `将为任务“${task.value.taskNo || task.value.taskId}”创建关联的补采任务，保留已有成果，核对当前页面后补齐；合格题目自动分批入库。` : `将继续同一个任务“${task.value.taskNo || task.value.taskId}”。Collector 新 run 会继承旧快照并从断点继续，不会直接应用正式库。${task.value.status === 'blocked' ? '请先确认风控已解除。' : ''}确定断点续采吗？`,
      '断点续采',
      { type: 'warning', confirmButtonText: '确认续采', cancelButtonText: '取消' },
    )
    acting.value = true
    const resumed = unwrapSyncTask(await resumeQuestionSyncTask(task.value.taskId), 'question')
    if (!resumed?.taskId) throw new Error('服务端未返回任务编号')
    ElMessage.success(task.value.workflowVersion === 2 ? '补采任务已提交' : '原任务续采已提交')
    loadedScopeKey = ''
    if (String(resumed.taskId) !== String(task.value.taskId)) await router.push(`/bank/sync-question/${encodeURIComponent(resumed.taskId)}`)
    else await loadTask()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(syncTaskErrorMessage(error, '断点续采失败'))
  } finally { acting.value = false }
}

async function stopTask() {
  if (!task.value) return
  try {
    await ElMessageBox.confirm('停止后保留任务记录、日志和已采集成果；合格题仍可分批入库。确定停止吗？', '停止任务', { type: 'warning', confirmButtonText: '停止', cancelButtonText: '取消' })
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
  if (!Number.isInteger(reviewRevision.value)) {
    ElMessage.warning('请先加载题目对比，再确认入库')
    return
  }
  const expectedReviewRevision = reviewRevision.value
  const targetTaskId = task.value.taskId
  const expectedStateToken = questionApplyStateToken(task.value)
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
    if (task.value?.taskId !== targetTaskId) throw new Error('当前任务已变化，请重新确认入库')
    acting.value = true
    const response = await applyQuestionSyncTask(
      targetTaskId,
      { expectedCurrentTaskId: currentTaskId || null, expectedStateToken, expectedReviewRevision },
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

async function requestImport() {
  const targetTaskId = task.value?.taskId
  if (!targetTaskId || acting.value) return
  acting.value = true
  try {
    const response = await requestQuestionIncrementalImport(targetTaskId)
    if (task.value?.taskId !== targetTaskId) return
    const result = response?.data || response
    task.value.incrementalImport = result
    ElMessage.success(`已提交后台入库，编号 ${result.importId}`)
    schedulePoll()
  } catch (error) {
    if (task.value?.taskId === targetTaskId) ElMessage.error(syncTaskErrorMessage(error, '提交入库失败，请刷新后重试'))
  } finally { acting.value = false }
}

async function retryIntake() {
  const targetTaskId = task.value?.taskId
  if (!targetTaskId || acting.value) return
  acting.value = true
  try {
    const response = await retryQuestionImportIntake(targetTaskId)
    if (task.value?.taskId !== targetTaskId) return
    task.value.importIntake = response?.data || response
    ElMessage.success('已重新安排封存核验')
    schedulePoll()
  } catch (error) {
    if (task.value?.taskId === targetTaskId) ElMessage.error(syncTaskErrorMessage(error, '重试核验失败'))
  } finally { acting.value = false }
}

watch(taskId, () => {
  clearPoll(); loadedScopeKey = ''; task.value = null; resetComparisonState(); loadTask()
})

onMounted(() => { mounted = true; loadTask() })
onBeforeUnmount(() => { mounted = false; taskLoadRevision++; clearPoll() })
</script>

<style scoped>
.question-task-detail { min-height: calc(100vh - 84px); color: var(--el-text-color-primary); }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.heading-copy h2 { margin: 6px 0 0; font-size: 20px; font-weight: 600; }
.heading-copy p { max-width: 760px; margin: 6px 0 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.heading-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.state-alert { margin-bottom: 14px; }
.import-summary { margin-top: 16px; }
.panel { min-width: 0; padding: 16px; border: 1px solid var(--el-border-color-light); border-radius: 8px; background: var(--el-bg-color); }
.live-catalog-panel { margin-bottom: 16px; }
.task-summary { margin-bottom: 16px; }
.status-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.status-line > div { display: flex; align-items: center; gap: 10px; }
.task-number { font-size: 16px; font-weight: 600; }
.progress-copy { color: var(--el-text-color-secondary); font-size: 13px; }
.progress-basis { margin: 8px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
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
.log-panel pre { color: var(--el-text-color-primary); max-height: 260px; margin: 0; overflow: auto; padding: 12px; border-radius: 6px; background: var(--el-fill-color-extra-light); white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.8 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.workspace-heading { align-items: flex-start; padding-bottom: 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
.workspace-heading p { margin: 5px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
.scope-select { width: min(380px, 48%); }
.live-tree-toolbar { display: flex; justify-content: space-between; gap: 12px; margin: 12px 0 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.live-stat-pending { color: var(--el-color-warning); }
.live-tree-scroll { min-height: 220px; max-height: min(560px, calc(100vh - 370px)); overflow: auto; padding: 8px 4px; }
.live-catalog-node { display: flex; min-width: 0; flex: 1; align-items: center; justify-content: space-between; gap: 12px; padding: 3px 5px; border-radius: 4px; }
.live-catalog-node.is-current { background: var(--el-color-primary-light-9); }
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
.review-catalog .tree-scroll { max-height: 520px; min-height: 220px; }
.review-catalog .node-label { flex: 1; }
.review-node-count { color: var(--el-text-color-secondary); font-size: 12px; font-variant-numeric: tabular-nums; margin-left: auto; white-space: nowrap; }
.captured-questions { border-top: 1px solid var(--el-border-color-light); margin-top: 20px; padding-top: 20px; }
.review-list-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 12px 0; color: var(--el-text-color-secondary); font-size: 13px; flex-wrap: wrap; }
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
