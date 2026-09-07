<template>
  <div class="app-container sync-center-page">
    <header class="page-heading">
      <div class="heading-copy">
        <h2>同步中心</h2>
        <p>先刷新版本与教材，再选择教材同步目录和题目。所有同步结果只进入采集候选库。</p>
      </div>
      <el-button
        v-hasPermi="['bank:sync:run']"
        type="primary"
        :icon="Refresh"
        :loading="metadataStarting"
        :disabled="taskBusy"
        @click="refreshMetadata"
      >刷新版本与教材</el-button>
    </header>

    <el-alert class="policy-alert" type="info" :closable="false" show-icon>
      版本与教材刷新不会抓取目录或题目；选择教材后提交内容任务，目录和题目会一起同步。同步不会自动审核或发布正式数据。
    </el-alert>

    <section class="task-panel" aria-label="同步任务面板">
      <div class="task-heading">
        <div class="task-title">
          <strong>同步任务</strong>
          <span>支持版本与教材、教材内容两种任务</span>
        </div>
        <div class="task-actions">
          <el-button link :icon="Refresh" title="刷新任务状态" aria-label="刷新任务状态" :loading="taskRefreshing" @click="refreshTaskState" />
          <el-button
            v-if="canCancelTask"
            v-hasPermi="['bank:sync:run']"
            type="warning"
            plain
            :icon="VideoPause"
            :loading="taskCancelling"
            @click="cancelTask"
          >停止任务</el-button>
        </div>
      </div>

      <el-alert v-if="taskError" class="task-alert" type="error" :closable="false" show-icon>{{ taskError }}</el-alert>
      <template v-if="currentTask">
        <div class="task-state-line">
          <div class="task-state">
            <el-tag size="small" :type="syncRunStatusMeta(currentTask.status).type">{{ syncRunStatusMeta(currentTask.status).label }}</el-tag>
            <span class="task-type">{{ taskTypeLabel(currentTask) }}</span>
            <span class="task-phase">{{ phaseLabel(currentTask) }}</span>
            <span v-if="currentTask.currentTextbook" class="current-textbook">当前教材：{{ currentTask.currentTextbook }}</span>
          </div>
          <span class="task-id">任务 {{ currentTask.runId }}</span>
        </div>
        <el-progress class="task-progress" :percentage="Math.round(syncRunProgress(currentTask))" :status="taskProgressStatus" :stroke-width="8" />
        <div class="task-stat-grid" aria-label="同步进度统计">
          <div class="task-stat"><span>版本</span><strong>{{ countText(currentTask.versionsCompleted, currentTask.versionsTotal) }}</strong></div>
          <div class="task-stat"><span>教材</span><strong>{{ countText(currentTask.textbooksCompleted, currentTask.textbooksTotal) }}</strong></div>
          <div class="task-stat"><span>目录</span><strong>{{ countText(currentTask.catalogsCompleted, currentTask.catalogsTotal, currentTask.catalogCount) }}</strong></div>
          <div class="task-stat"><span>题目</span><strong>{{ countText(currentTask.questionsCompleted, currentTask.questionsTotal, currentTask.questionCount) }}</strong></div>
        </div>
        <el-alert v-if="currentTask.errorMessage" class="task-alert" type="error" :closable="false" show-icon>{{ currentTask.errorMessage }}</el-alert>
        <details v-if="currentTask.logs.length" class="task-logs" :open="isActiveSyncRunStatus(currentTask.status)">
          <summary>运行日志（最近 {{ currentTask.logs.length }} 条）</summary>
          <pre aria-live="polite">{{ currentTask.logs.join('\n') }}</pre>
        </details>
      </template>
      <div v-else class="task-empty">暂无同步任务。刷新版本与教材后，任务会显示在这里。</div>
      <div v-if="catalogProgress?.catalogs?.length" class="catalog-progress">
        <div class="catalog-progress-heading">
          <strong>章 / 节 / 知识点</strong>
          <span v-if="catalogProgress.progressPercent != null">按页 {{ catalogProgress.progressPercent }}%</span>
          <span>不重复题 {{ catalogProgress.questionUnique }}</span>
        </div>
        <el-tree
          class="catalog-progress-tree"
          :data="catalogProgress.catalogs"
          node-key="externalId"
          :props="{ label: 'name', children: 'children' }"
          :expand-on-click-node="false"
        >
          <template #default="{ data }">
            <span class="progress-node" :class="{ 'is-current': Boolean(data.current) }">
              <span class="progress-name">{{ data.name }}</span>
              <span class="progress-counts">{{ catalogNodeCountText(data) }}</span>
            </span>
          </template>
        </el-tree>
      </div>
    </section>

    <el-tabs v-model="activeTab" class="sync-tabs">
      <el-tab-pane label="教材来源" name="metadata">
        <section class="workspace-panel" aria-labelledby="metadata-workspace-title">
          <div class="section-heading">
            <div>
              <h3 id="metadata-workspace-title">选择教材同步范围</h3>
              <p>按版本查看来源候选。移动到右侧仅保存本次选择，不会立即写入、审核或发布。</p>
            </div>
            <div class="section-meta">
              <span v-if="metadataRunId">最近成功元数据任务：{{ metadataRunId }}</span>
              <span v-else>尚未找到成功的版本与教材任务</span>
            </div>
          </div>

          <el-alert v-if="metadataError" class="state-alert" type="error" :closable="false" show-icon>{{ metadataError }}</el-alert>
          <el-alert v-if="metadataAvailable === false" class="state-alert" type="warning" :closable="false" show-icon>
            {{ metadataMessage || '当前没有可用的采集候选数据，请先刷新版本与教材。' }}
          </el-alert>

          <div class="metadata-toolbar">
            <el-input v-model="metadataFilter.keyword" clearable class="keyword-input" placeholder="搜索教材名称或来源 ID" :prefix-icon="Search" />
            <el-select v-model="metadataFilter.status" clearable class="status-select" placeholder="全部差异状态">
              <el-option v-for="item in comparisonStatusOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-button :icon="Check" :disabled="!sourceSelectableRows.length" @click="selectAllSourceVisible">选择当前筛选</el-button>
            <span class="toolbar-hint">来源候选 {{ sourceSelectableRows.length }} 条，已选 {{ selectedTextbooks.length }} 条</span>
          </div>

          <div class="transfer-layout">
            <section class="transfer-pane" aria-labelledby="source-candidates-title">
              <div class="transfer-pane-heading">
                <div class="pane-title">
                  <el-checkbox :model-value="allSourceVisibleChecked" :indeterminate="sourceVisibleIndeterminate" :disabled="!sourceSelectableRows.length" @change="toggleAllSourceVisible" />
                  <h4 id="source-candidates-title">来源候选</h4>
                </div>
                <span>{{ sourceVisibleRows.length }} 条</span>
              </div>
              <div class="transfer-list" v-loading="metadataLoading">
                <template v-if="groupedSourceRows.length">
                  <div v-for="group in groupedSourceRows" :key="group.key" class="version-group">
                    <div class="version-group-heading">
                      <span class="version-name">{{ group.name }}</span>
                      <span class="version-external-id">{{ group.externalId ? `来源 ID ${group.externalId}` : '未关联版本' }}</span>
                      <el-tag v-if="group.versionStatus" size="small" :type="comparisonStatusMeta(group.versionStatus).type">{{ comparisonStatusMeta(group.versionStatus).label }}</el-tag>
                    </div>
                    <div v-for="item in group.rows" :key="syncComparisonRowKey(item)" class="transfer-row" :class="{ 'is-disabled': !isSelectableTextbook(item), 'is-selected': isSourceChecked(item) }">
                      <el-checkbox :model-value="isSourceChecked(item)" :disabled="!isSelectableTextbook(item)" @change="toggleSourceCheck(item, $event)" />
                      <button class="row-main" type="button" @click="openDetail(item, 'textbook')">
                        <span class="row-title">{{ textbookName(item) || item.externalId || '未命名教材' }}</span>
                        <span class="row-summary">当前：{{ currentSummary(item, 'textbook') }}</span>
                      </button>
                      <el-tag class="row-status" size="small" :type="comparisonStatusMeta(item.comparisonStatus).type">{{ comparisonStatusMeta(item.comparisonStatus).label }}</el-tag>
                      <el-button link type="primary" :icon="View" title="查看字段对比" aria-label="查看字段对比" @click.stop="openDetail(item, 'textbook')" />
                    </div>
                  </div>
                </template>
                <el-empty v-else :image-size="60" description="暂无符合条件的教材候选" />
              </div>
            </section>

            <div class="transfer-actions" aria-label="移动同步范围">
              <el-button class="icon-action" type="primary" :icon="ArrowRight" title="移入本次同步范围" aria-label="移入本次同步范围" :disabled="!sourceCheckedRows.length" @click="moveSourceToTarget" />
              <el-button class="icon-action" :icon="ArrowLeft" title="移回来源候选" aria-label="移回来源候选" :disabled="!targetCheckedRows.length" @click="moveTargetToSource" />
            </div>

            <section class="transfer-pane target-pane" aria-labelledby="selected-textbooks-title">
              <div class="transfer-pane-heading">
                <div class="pane-title">
                  <el-checkbox :model-value="allTargetChecked" :indeterminate="targetIndeterminate" :disabled="!selectedTextbooks.length" @change="toggleAllTarget" />
                  <h4 id="selected-textbooks-title">本次同步范围</h4>
                </div>
                <span>{{ selectedTextbooks.length }} 本</span>
              </div>
              <div class="transfer-list">
                <div v-for="item in selectedTextbooks" :key="syncComparisonRowKey(item)" class="transfer-row target-row" :class="{ 'is-selected': isTargetChecked(item) }">
                  <el-checkbox :model-value="isTargetChecked(item)" @change="toggleTargetCheck(item, $event)" />
                  <div class="row-main">
                    <span class="row-title">{{ textbookName(item) || item.externalId || '未命名教材' }}</span>
                    <span class="row-summary">{{ versionName(item) }} · {{ comparisonStatusMeta(item.comparisonStatus).label }}</span>
                  </div>
                  <el-button link :icon="View" title="查看字段对比" aria-label="查看字段对比" @click="openDetail(item, 'textbook')" />
                </div>
                <el-empty v-if="!selectedTextbooks.length" :image-size="60" description="请从左侧选择教材" />
              </div>
            </section>
          </div>

          <div class="workspace-footer">
            <span class="selection-note">已选择 {{ selectedTextbooks.length }} 本教材。提交后会同步这些教材的完整目录和题目。</span>
            <el-button
              v-hasPermi="['bank:sync:run']"
              type="primary"
              :icon="VideoPlay"
              :disabled="!selectedTextbooks.length || !metadataRunId || taskBusy"
              :loading="contentStarting"
              @click="startSelectedContentSync"
            >同步所选教材内容</el-button>
          </div>
        </section>
      </el-tab-pane>

      <el-tab-pane label="题库内容" name="content">
        <section class="workspace-panel" aria-labelledby="content-workspace-title">
          <div class="section-heading">
            <div>
              <h3 id="content-workspace-title">目录与题目候选</h3>
              <p>目录和题目属于同一教材内容范围。选择或排除只影响本次审核操作，不会直接写入正式题库。</p>
            </div>
            <el-button :icon="Refresh" :loading="contentLoading" :disabled="!contentTextbookId" @click="loadContentForTextbook(contentTextbookId)" />
          </div>

          <div class="content-toolbar">
            <label class="toolbar-label" for="content-textbook">教材</label>
            <el-select id="content-textbook" v-model="contentTextbookId" filterable clearable class="content-textbook-select" placeholder="请选择已有候选内容的教材" @change="loadContentForTextbook">
              <el-option v-for="item in contentTextbookOptions" :key="syncComparisonRowKey(item)" :label="`${versionName(item)} · ${textbookName(item) || item.externalId}`" :value="syncComparisonRowKey(item)" />
            </el-select>
            <el-tag v-if="contentTextbookId" size="small" type="info">目录 + 题目统一范围</el-tag>
            <span v-if="contentScopeMessage" class="toolbar-hint">{{ contentScopeMessage }}</span>
          </div>

          <el-alert v-if="contentError" class="state-alert" type="error" :closable="false" show-icon>{{ contentError }}</el-alert>
          <div v-if="contentTextbookId" class="content-workspace">
            <section class="content-source-pane" aria-label="来源候选目录和题目">
              <div class="content-pane-heading">
                <div>
                  <strong>来源候选</strong>
                  <span>{{ contentSourceSummary }}</span>
                </div>
                <el-radio-group v-model="contentMode" size="small" aria-label="候选类型">
                  <el-radio-button value="catalog">目录</el-radio-button>
                  <el-radio-button value="question">题目</el-radio-button>
                </el-radio-group>
              </div>

              <template v-if="contentMode === 'catalog'">
                <div class="catalog-toolbar">
                  <el-input v-model="contentFilter.keyword" clearable placeholder="搜索目录名称" :prefix-icon="Search" @keyup.enter="filterCatalogs" />
                  <el-select v-model="contentFilter.status" clearable placeholder="全部状态" @change="filterCatalogs">
                    <el-option v-for="item in comparisonStatusOptions" :key="item.value" :label="item.label" :value="item.value" />
                  </el-select>
                </div>
                <el-tree
                  v-if="catalogTreeComplete"
                  ref="catalogTreeRef"
                  class="catalog-tree"
                  node-key="key"
                  show-checkbox
                  check-strictly
                  default-expand-all
                  :data="catalogTree"
                  :props="catalogTreeProps"
                  :default-checked-keys="selectedCatalogKeysArray"
                  empty-text="暂无目录候选"
                  @check="handleCatalogTreeCheck"
                />
                <div v-else class="catalog-flat-list" v-loading="contentLoading">
                  <label v-for="row in filteredCatalogRows" :key="syncComparisonRowKey(row)" class="catalog-flat-row" :class="{ 'is-disabled': !canReviewSyncRow(row) || row.comparisonStatus === 'conflict' }">
                    <el-checkbox :model-value="isCatalogSelected(row)" :disabled="!canReviewSyncRow(row) || row.comparisonStatus === 'conflict'" @change="toggleCatalogRow(row, $event)" />
                    <span class="catalog-indent">{{ catalogLevel(row) }}</span>
                    <span class="catalog-row-main"><strong>{{ catalogName(row) || row.externalId }}</strong><small>{{ catalogParentText(row) }}</small></span>
                    <el-tag size="small" :type="comparisonStatusMeta(row.comparisonStatus).type">{{ comparisonStatusMeta(row.comparisonStatus).label }}</el-tag>
                  </label>
                  <el-empty v-if="!filteredCatalogRows.length" :image-size="60" description="暂无目录候选" />
                </div>
              </template>

              <template v-else>
                <div class="question-toolbar">
                  <el-input v-model="questionFilter.keyword" clearable placeholder="搜索题干或来源 ID" :prefix-icon="Search" @keyup.enter="loadQuestionPage" />
                  <el-select v-model="questionFilter.status" clearable placeholder="全部状态" @change="loadQuestionPage">
                    <el-option v-for="item in comparisonStatusOptions" :key="item.value" :label="item.label" :value="item.value" />
                  </el-select>
                </div>
                <el-table ref="questionTableRef" v-loading="questionLoading" :data="questionRows" row-key="syncKey" stripe size="small" class="question-table" :empty-text="questionSourceAvailable === false ? '题目候选不可用' : '暂无题目候选'" @selection-change="handleQuestionSelection">
                  <el-table-column type="selection" width="48" align="center" :selectable="selectableContentRow" />
                  <el-table-column label="题目预览" min-width="240" show-overflow-tooltip>
                    <template #default="scope"><span class="safe-preview">{{ candidateSummary(scope.row, 'question') || '暂无题干' }}</span></template>
                  </el-table-column>
                  <el-table-column label="目录" min-width="130" show-overflow-tooltip>
                    <template #default="scope">{{ questionCatalogText(scope.row) || '未关联目录' }}</template>
                  </el-table-column>
                  <el-table-column label="状态" width="88" align="center"><template #default="scope"><el-tag size="small" :type="comparisonStatusMeta(scope.row.comparisonStatus).type">{{ comparisonStatusMeta(scope.row.comparisonStatus).label }}</el-tag></template></el-table-column>
                  <el-table-column label="操作" width="70" align="center"><template #default="scope"><el-button link type="primary" :icon="View" title="查看题目对比" aria-label="查看题目对比" @click="openDetail(scope.row, 'question')" /></template></el-table-column>
                </el-table>
                <div class="table-footer">
                  <span>已选 {{ selectedQuestionRows.length }} 题</span>
                  <el-pagination v-model:current-page="questionPage.pageNum" v-model:page-size="questionPage.pageSize" :total="questionPage.total" :page-sizes="[10, 20, 50]" layout="sizes, prev, pager, next, total" background @size-change="loadQuestionPage" @current-change="loadQuestionPage" />
                </div>
              </template>
            </section>

            <aside class="content-target-pane" aria-labelledby="content-target-title">
              <div class="content-pane-heading">
                <div>
                  <strong id="content-target-title">本次待纳入</strong>
                  <span>仅用于当前审核范围</span>
                </div>
                <el-button link :icon="RefreshLeft" title="清空当前选择" aria-label="清空当前选择" :disabled="!selectedCatalogRows.length && !selectedQuestionRows.length" @click="clearContentSelection" />
              </div>
              <dl class="selection-summary">
                <div><dt>教材</dt><dd>{{ selectedContentTextbookName || '未选择' }}</dd></div>
                <div><dt>目录</dt><dd>{{ selectedCatalogRows.length }} 个</dd></div>
                <div><dt>题目</dt><dd>{{ selectedQuestionRows.length }} 题（当前页选择可跨页保留）</dd></div>
              </dl>
              <div class="selected-preview-list">
                <div v-for="row in selectedCatalogRows.slice(0, 10)" :key="`catalog-${syncComparisonRowKey(row)}`" class="selected-preview-item">
                  <el-tag size="small" type="info">目录</el-tag><span>{{ catalogName(row) || row.externalId }}</span>
                </div>
                <div v-for="row in selectedQuestionRows.slice(0, 10)" :key="`question-${syncComparisonRowKey(row)}`" class="selected-preview-item">
                  <el-tag size="small" type="success">题目</el-tag><span>{{ candidateSummary(row, 'question') || row.externalId }}</span>
                </div>
                <span v-if="selectedCatalogRows.length + selectedQuestionRows.length > 20" class="more-hint">还有 {{ selectedCatalogRows.length + selectedQuestionRows.length - 20 }} 项未展开</span>
                <el-empty v-if="!selectedCatalogRows.length && !selectedQuestionRows.length" :image-size="54" description="请从左侧选择目录或题目" />
              </div>
              <div class="review-actions">
                <el-button v-hasPermi="['bank:sync:review']" type="success" :icon="Check" plain :disabled="!reviewableSelection.length || reviewing" :loading="reviewing && reviewAction === 'approve'" @click="reviewContentSelection('approve')">批量通过</el-button>
                <el-button v-hasPermi="['bank:sync:review']" type="danger" :icon="Close" plain :disabled="!reviewableSelection.length || reviewing" :loading="reviewing && reviewAction === 'reject'" @click="reviewContentSelection('reject')">批量驳回</el-button>
              </div>
              <p class="non-publish-note">审核通过只进入待发布流程，不会自动修改正式题库。</p>
            </aside>
          </div>
          <el-empty v-else :image-size="72" description="请先选择一本已有候选内容的教材" />
        </section>
      </el-tab-pane>

      <el-tab-pane label="同步记录" name="history">
        <section class="history-panel" aria-labelledby="history-title">
          <div class="section-heading">
            <div><h3 id="history-title">同步记录</h3><p>记录包含任务状态和统计，不代表已发布到正式题库。</p></div>
            <el-button :icon="Refresh" :loading="historyLoading" @click="loadTaskHistory" />
          </div>
          <el-table v-loading="historyLoading" :data="taskHistory" stripe size="small" class="history-table" empty-text="暂无同步记录">
            <el-table-column prop="runId" label="任务" width="90" />
            <el-table-column label="任务类型" min-width="145"><template #default="scope">{{ taskTypeLabel(scope.row) }}</template></el-table-column>
            <el-table-column label="状态" width="90" align="center"><template #default="scope"><el-tag size="small" :type="syncRunStatusMeta(scope.row.status).type">{{ syncRunStatusMeta(scope.row.status).label }}</el-tag></template></el-table-column>
            <el-table-column label="进度" width="80" align="right"><template #default="scope">{{ Math.round(syncRunProgress(scope.row)) }}%</template></el-table-column>
            <el-table-column label="当前教材" min-width="180" show-overflow-tooltip><template #default="scope">{{ scope.row.currentTextbook || '—' }}</template></el-table-column>
            <el-table-column label="目录 / 题目" min-width="130"><template #default="scope">{{ countText(scope.row.catalogsCompleted, scope.row.catalogsTotal, scope.row.catalogCount) }} / {{ countText(scope.row.questionsCompleted, scope.row.questionsTotal, scope.row.questionCount) }}</template></el-table-column>
            <el-table-column label="开始时间" min-width="160" show-overflow-tooltip><template #default="scope">{{ scope.row.startedAt || '—' }}</template></el-table-column>
            <el-table-column label="结束时间" min-width="160" show-overflow-tooltip><template #default="scope">{{ scope.row.finishedAt || '—' }}</template></el-table-column>
          </el-table>
        </section>
      </el-tab-pane>
    </el-tabs>

    <el-drawer v-model="detailVisible" :title="detailTitle" direction="rtl" size="min(860px, 96vw)" append-to-body>
      <template v-if="detailRow">
        <div class="detail-meta">
          <el-tag size="small" :type="comparisonStatusMeta(detailRow.comparisonStatus).type">{{ comparisonStatusMeta(detailRow.comparisonStatus).label }}</el-tag>
          <span>外部 ID：{{ detailRow.externalId || '未提供' }}</span>
          <span>stagedHash：{{ detailRow.stagedHash || '未提供（不可审核）' }}</span>
        </div>
        <div class="compare-grid">
          <section class="compare-side"><h3>来源候选值</h3><pre>{{ formatSyncSnapshot(detailRow.stagedData, detailType) }}</pre></section>
          <section class="compare-side"><h3>当前正式值</h3><pre>{{ formatSyncSnapshot(detailRow.currentData, detailType) }}</pre></section>
        </div>
        <section class="detail-fields"><h3>差异字段</h3><div v-if="detailRow.diffFields.length" class="field-tags"><el-tag v-for="field in detailRow.diffFields" :key="field" size="small" type="warning">{{ field }}</el-tag></div><span v-else class="muted">无差异字段</span></section>
        <section v-if="detailType === 'question'" class="safe-question-detail"><h3>安全文本预览</h3><pre>{{ candidateSummary(detailRow, 'question') || '暂无题干' }}</pre></section>
        <div v-if="detailType === 'catalog' || detailType === 'question'" class="detail-actions">
          <el-button v-hasPermi="['bank:sync:review']" type="success" :disabled="!canReviewSyncRow(detailRow) || reviewing" :loading="reviewing && reviewAction === 'approve'" @click="reviewContentRows([detailRow], detailType, 'approve')">通过</el-button>
          <el-button v-hasPermi="['bank:sync:review']" type="danger" :disabled="!canReviewSyncRow(detailRow) || reviewing" :loading="reviewing && reviewAction === 'reject'" @click="reviewContentRows([detailRow], detailType, 'reject')">驳回</el-button>
        </div>
      </template>
      <el-empty v-else description="未找到候选记录" />
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, Check, Close, Refresh, RefreshLeft, Search, VideoPause, VideoPlay, View } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  cancelSyncRun,
  getCatalogProgress,
  getCurrentSyncRun,
  getMetadataSyncSnapshot,
  getSyncRun,
  listSyncComparisons,
  listSyncRuns,
  reviewSyncItems,
  startContentSyncRun,
  startMetadataSyncRun,
} from '../../api/bank'
import {
  buildSyncReviewItems,
  canReviewSyncRow,
  comparisonStatusMeta,
  comparisonStatusOptions,
  formatSyncSnapshot,
  summarizeSyncRow,
  syncComparisonRowKey,
  unwrapMetadataSnapshot,
  unwrapSyncCompare,
} from '../../utils/sync'
import {
  isActiveSyncRunStatus,
  isTerminalSyncRunStatus,
  normalizeSyncRun,
  normalizeSyncRunPhase,
  syncRunErrorMessage,
  syncRunProgress,
  syncRunStatusMeta,
  unwrapSyncRun,
  unwrapSyncRunList,
} from '../../utils/sync-run'

const activeTab = ref('metadata')

const metadataLoading = ref(false)
const metadataStarting = ref(false)
const metadataError = ref('')
const metadataAvailable = ref(undefined)
const metadataMessage = ref('')
const versionRows = ref([])
const textbookRows = ref([])
const metadataRunId = ref('')
const metadataFilter = reactive({ keyword: '', status: undefined })
const sourceCheckedKeys = ref(new Set())
const targetCheckedKeys = ref(new Set())
const targetTextbookKeys = ref(new Set())

const contentTextbookId = ref('')
const contentMode = ref('catalog')
const contentLoading = ref(false)
const contentError = ref('')
const contentScopeMessage = ref('')
const contentFilter = reactive({ keyword: '', status: undefined })
const questionFilter = reactive({ keyword: '', status: undefined })
const catalogRows = ref([])
const questionRows = ref([])
const questionSourceAvailable = ref(undefined)
const questionPage = reactive({ pageNum: 1, pageSize: 10, total: 0 })
const selectedCatalogKeys = ref(new Set())
const selectedQuestionMap = ref(new Map())
const syncingQuestionSelection = ref(false)
const catalogTreeRef = ref()
const questionTableRef = ref()
const catalogTreeProps = { label: 'label', children: 'children', disabled: 'disabled' }

const currentTask = ref(null)
const catalogProgress = ref(null)
const taskHistory = ref([])
const taskRefreshing = ref(false)
const taskCancelling = ref(false)
const taskError = ref('')
let pollTimer = null
let isMounted = false

const detailVisible = ref(false)
const detailRow = ref(null)
const detailType = ref('textbook')
const reviewing = ref(false)
const reviewAction = ref('')
const contentStarting = ref(false)

const sourceVisibleRows = computed(() => {
  const keyword = metadataFilter.keyword.trim().toLowerCase()
  return textbookRows.value.filter((row) => {
    if (targetTextbookKeys.value.has(syncComparisonRowKey(row))) return false
    if (metadataFilter.status && row.comparisonStatus !== metadataFilter.status) return false
    if (!keyword) return true
    return `${textbookName(row)} ${row.externalId} ${versionName(row)}`.toLowerCase().includes(keyword)
  })
})
const sourceSelectableRows = computed(() => sourceVisibleRows.value.filter(isSelectableTextbook))
const selectedTextbooks = computed(() => textbookRows.value.filter((row) => targetTextbookKeys.value.has(syncComparisonRowKey(row))))
const sourceCheckedRows = computed(() => sourceVisibleRows.value.filter((row) => sourceCheckedKeys.value.has(syncComparisonRowKey(row)) && isSelectableTextbook(row)))
const targetCheckedRows = computed(() => selectedTextbooks.value.filter((row) => targetCheckedKeys.value.has(syncComparisonRowKey(row))))
const allSourceVisibleChecked = computed(() => sourceSelectableRows.value.length > 0 && sourceSelectableRows.value.every((row) => sourceCheckedKeys.value.has(syncComparisonRowKey(row))))
const sourceVisibleIndeterminate = computed(() => sourceCheckedRows.value.length > 0 && !allSourceVisibleChecked.value)
const allTargetChecked = computed(() => selectedTextbooks.value.length > 0 && selectedTextbooks.value.every((row) => targetCheckedKeys.value.has(syncComparisonRowKey(row))))
const targetIndeterminate = computed(() => targetCheckedRows.value.length > 0 && !allTargetChecked.value)
const groupedSourceRows = computed(() => {
  const groups = new Map()
  sourceVisibleRows.value.forEach((row) => {
    const externalId = String(candidateField(row, 'versionExternalId') || '')
    const key = externalId || '__unknown__'
    if (!groups.has(key)) {
      const version = versionRows.value.find((item) => String(item.externalId) === externalId)
      groups.set(key, { key, externalId, name: versionNameFromRow(version) || (externalId ? `版本 ${externalId}` : '未关联版本'), versionStatus: version?.comparisonStatus, rows: [] })
    }
    groups.get(key).rows.push(row)
  })
  return [...groups.values()]
})

const contentTextbookOptions = computed(() => textbookRows.value.filter((row) => row.comparisonStatus !== 'conflict' && isSelectableTextbook(row)))
const selectedContentTextbook = computed(() => contentTextbookOptions.value.find((row) => syncComparisonRowKey(row) === contentTextbookId.value))
const selectedContentTextbookName = computed(() => selectedContentTextbook.value ? `${versionName(selectedContentTextbook.value)} · ${textbookName(selectedContentTextbook.value)}` : '')
const filteredCatalogRows = computed(() => {
  const keyword = contentFilter.keyword.trim().toLowerCase()
  return catalogRows.value.filter((row) => (!contentFilter.status || row.comparisonStatus === contentFilter.status) && (!keyword || `${catalogName(row)} ${row.externalId}`.toLowerCase().includes(keyword)))
})
const catalogTree = computed(() => buildCatalogTree(filteredCatalogRows.value).tree)
const catalogTreeComplete = computed(() => buildCatalogTree(filteredCatalogRows.value).complete && filteredCatalogRows.value.length > 0)
const selectedCatalogRows = computed(() => catalogRows.value.filter((row) => selectedCatalogKeys.value.has(syncComparisonRowKey(row))))
const selectedQuestionRows = computed(() => [...selectedQuestionMap.value.values()])
const reviewableSelection = computed(() => [...selectedCatalogRows.value.filter(canReviewSyncRow), ...selectedQuestionRows.value.filter(canReviewSyncRow)])
const selectedCatalogKeysArray = computed(() => [...selectedCatalogKeys.value])
const contentSourceSummary = computed(() => `${catalogRows.value.length} 个目录 · ${questionPage.total} 题目`)
const taskBusy = computed(() => Boolean(currentTask.value && isActiveSyncRunStatus(currentTask.value.status)) || metadataStarting.value || contentStarting.value)
const canCancelTask = computed(() => Boolean(currentTask.value && ['queued', 'starting', 'running'].includes(currentTask.value.status) && !taskCancelling.value))
const taskProgressStatus = computed(() => {
  if (['failed', 'blocked'].includes(currentTask.value?.status)) return 'exception'
  if (currentTask.value?.status === 'cancelled') return 'warning'
  if (currentTask.value?.status === 'completed') return 'success'
  return undefined
})
const detailTitle = computed(() => `${detailType.value === 'textbook' ? '教材' : detailType.value === 'catalog' ? '目录' : '题目'} · 对比详情`)

watch(selectedCatalogKeysArray, async (keys) => {
  await nextTick()
  catalogTreeRef.value?.setCheckedKeys(keys)
}, { deep: true })

function candidateField(row, ...keys) {
  const values = [row?.stagedData, row?.candidate, row]
  for (const value of values) {
    if (!value || typeof value !== 'object') continue
    for (const key of keys) {
      if (value[key] !== undefined && value[key] !== null && value[key] !== '') return value[key]
      const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
      if (value[snake] !== undefined && value[snake] !== null && value[snake] !== '') return value[snake]
    }
  }
  return ''
}

function currentField(row, ...keys) {
  const value = row?.currentData
  if (!value || typeof value !== 'object') return ''
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== '') return value[key]
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    if (value[snake] !== undefined && value[snake] !== null && value[snake] !== '') return value[snake]
  }
  return ''
}

function versionNameFromRow(row) {
  return row ? String(candidateField(row, 'versionName', 'name') || currentField(row, 'versionName', 'name') || row.externalId || '') : ''
}

function versionName(row) {
  const externalId = String(candidateField(row, 'versionExternalId') || '')
  const version = versionRows.value.find((item) => String(item.externalId) === externalId)
  return versionNameFromRow(version) || (externalId ? `版本 ${externalId}` : '未关联版本')
}

function textbookName(row) {
  return String(candidateField(row, 'textbookName', 'name', 'displayName') || currentField(row, 'textbookName', 'name', 'displayName') || '')
}

function catalogName(row) {
  return String(candidateField(row, 'nodeName', 'name', 'title') || currentField(row, 'nodeName', 'name', 'title') || '')
}

function candidateSummary(row, type) {
  return summarizeSyncRow(row, 'staged', type).replace(/\s+/g, ' ').slice(0, 360)
}

function currentSummary(row, type) {
  const current = row?.currentData
  if (!current || typeof current !== 'object' || Object.keys(current).length === 0) return '暂无正式值'
  return summarizeSyncRow(row, 'current', type).replace(/\s+/g, ' ').slice(0, 180) || '暂无正式值'
}

function isSelectableTextbook(row) {
  const status = candidateField(row, 'status')
  return row?.comparisonStatus !== 'conflict'
    && String(status || '0') !== '1'
    && canReviewSyncRow(row)
}

function isSourceChecked(row) { return sourceCheckedKeys.value.has(syncComparisonRowKey(row)) }
function isTargetChecked(row) { return targetCheckedKeys.value.has(syncComparisonRowKey(row)) }

function replaceSet(refValue, values) { refValue.value = new Set(values) }

function toggleSourceCheck(row, checked) {
  const values = new Set(sourceCheckedKeys.value)
  if (checked && isSelectableTextbook(row)) values.add(syncComparisonRowKey(row))
  else values.delete(syncComparisonRowKey(row))
  replaceSet(sourceCheckedKeys, values)
}

function toggleTargetCheck(row, checked) {
  const values = new Set(targetCheckedKeys.value)
  if (checked) values.add(syncComparisonRowKey(row))
  else values.delete(syncComparisonRowKey(row))
  replaceSet(targetCheckedKeys, values)
}

function toggleAllSourceVisible(checked) {
  const values = new Set(sourceCheckedKeys.value)
  sourceSelectableRows.value.forEach((row) => checked ? values.add(syncComparisonRowKey(row)) : values.delete(syncComparisonRowKey(row)))
  replaceSet(sourceCheckedKeys, values)
}

function selectAllSourceVisible() {
  toggleAllSourceVisible(true)
}

function toggleAllTarget(checked) {
  const values = new Set(targetCheckedKeys.value)
  selectedTextbooks.value.forEach((row) => checked ? values.add(syncComparisonRowKey(row)) : values.delete(syncComparisonRowKey(row)))
  replaceSet(targetCheckedKeys, values)
}

function moveSourceToTarget() {
  const values = new Set(targetTextbookKeys.value)
  sourceCheckedRows.value.forEach((row) => values.add(syncComparisonRowKey(row)))
  replaceSet(targetTextbookKeys, values)
  replaceSet(sourceCheckedKeys, [])
}

function moveTargetToSource() {
  const values = new Set(targetTextbookKeys.value)
  targetCheckedRows.value.forEach((row) => values.delete(syncComparisonRowKey(row)))
  replaceSet(targetTextbookKeys, values)
  replaceSet(targetCheckedKeys, [])
}

async function loadAllComparisons(entityType, query = {}) {
  const rows = []
  let pageNum = 1
  let total = 0
  let sourceAvailable
  let sourceMessage = ''
  const pageSize = 100
  while (pageNum <= 50) {
    const result = unwrapSyncCompare(await listSyncComparisons(entityType, { ...query, pageNum, pageSize }))
    sourceAvailable = result.sourceAvailable
    sourceMessage = result.sourceMessage
    rows.push(...result.rows)
    total = result.total
    if (!result.rows.length || rows.length >= total || result.rows.length < pageSize) break
    pageNum += 1
  }
  return { rows, total: total || rows.length, sourceAvailable, sourceMessage }
}

async function loadMetadataComparisons() {
  metadataLoading.value = true
  metadataError.value = ''
  try {
    const snapshot = unwrapMetadataSnapshot(await getMetadataSyncSnapshot(metadataRunId.value || undefined))
    versionRows.value = snapshot.versions
    textbookRows.value = snapshot.versions.flatMap((version) => version.textbooks.map((textbook) => ({
      ...textbook,
      versionExternalId: version.externalId,
      versionName: version.versionName,
      stagedData: { ...textbook.stagedData, versionExternalId: textbook.stagedData?.versionExternalId || version.externalId },
    })))
    metadataRunId.value = snapshot.metadataRunId ? String(snapshot.metadataRunId) : ''
    metadataAvailable.value = snapshot.sourceAvailable
    metadataMessage.value = snapshot.sourceMessage || ''
    const textbookKeys = new Set(textbookRows.value.filter(isSelectableTextbook).map((row) => syncComparisonRowKey(row)))
    replaceSet(targetTextbookKeys, [...targetTextbookKeys.value].filter((key) => textbookKeys.has(key)))
    replaceSet(sourceCheckedKeys, [])
    replaceSet(targetCheckedKeys, [])
  } catch (error) {
    versionRows.value = []
    textbookRows.value = []
    metadataAvailable.value = undefined
    metadataMessage.value = ''
    metadataError.value = error?.message || '版本与教材候选加载失败，请稍后重试'
  } finally {
    metadataLoading.value = false
  }
}

function openDetail(row, type) {
  detailRow.value = row
  detailType.value = type
  detailVisible.value = true
}

async function refreshMetadata() {
  if (taskBusy.value) return
  try {
    await ElMessageBox.confirm(
      '本次只同步版本和教材元数据，不会抓取目录或题目；结果只写入采集候选库。确定开始吗？',
      '刷新版本与教材',
      { type: 'info', confirmButtonText: '开始刷新', cancelButtonText: '取消' },
    )
    metadataStarting.value = true
    taskError.value = ''
    const started = unwrapSyncRun(await startMetadataSyncRun())
    await acceptStartedTask(started)
    ElMessage.success('版本与教材同步任务已启动')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      taskError.value = syncRunErrorMessage(error, '版本与教材任务启动失败')
      ElMessage.error(taskError.value)
    }
  } finally {
    metadataStarting.value = false
  }
}

async function startSelectedContentSync() {
  if (!metadataRunId.value || !selectedTextbooks.value.length || taskBusy.value) return
  try {
    await ElMessageBox.confirm(
      `将同步已选 ${selectedTextbooks.value.length} 本教材的全部目录和题目，目录+题目一起同步，结果只进候选库，不会自动审核或发布。确定继续吗？`,
      '确认同步教材内容',
      { type: 'warning', confirmButtonText: '同步目录和题目', cancelButtonText: '取消' },
    )
    contentStarting.value = true
    taskError.value = ''
    const started = unwrapSyncRun(await startContentSyncRun({
      metadataRunId: metadataRunId.value,
      textbookExternalIds: selectedTextbooks.value.map((row) => row.externalId),
      acknowledgeSourcePolicy: true,
    }))
    await acceptStartedTask(started)
    ElMessage.success('教材内容同步任务已启动')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      taskError.value = syncRunErrorMessage(error, '教材内容任务启动失败')
      ElMessage.error(taskError.value)
    }
  } finally {
    contentStarting.value = false
  }
}

async function acceptStartedTask(started) {
  if (started) {
    setCurrentTask(started)
    if (isTerminalSyncRunStatus(started.status)) await handleTaskTerminal(started)
    else schedulePoll(started.runId, 400)
  } else {
    await refreshTaskState()
  }
  await loadTaskHistory()
}

function setCurrentTask(value) {
  const normalized = value ? normalizeSyncRun(value) : null
  currentTask.value = normalized?.runId ? normalized : null
  return currentTask.value
}

function clearPollTimer() {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer)
    pollTimer = null
  }
}

function schedulePoll(runId, delay = 2000) {
  clearPollTimer()
  if (!isMounted || !runId || !currentTask.value || !isActiveSyncRunStatus(currentTask.value.status)) return
  pollTimer = window.setTimeout(() => {
    pollTimer = null
    pollTask(runId)
  }, delay)
}

async function pollTask(runId) {
  if (!isMounted || !runId) return
  try {
    const latest = unwrapSyncRun(await getSyncRun(runId))
    if (latest) {
      setCurrentTask(latest)
      await loadCatalogProgress()
      taskError.value = ''
      if (isTerminalSyncRunStatus(latest.status)) {
        clearPollTimer()
        await handleTaskTerminal(latest)
        return
      }
    }
  } catch (error) {
    if (isMounted) taskError.value = syncRunErrorMessage(error, '同步状态暂时无法获取，将继续重试')
  }
  schedulePoll(runId)
}

async function handleTaskTerminal(task) {
  if (task.status === 'completed' && task.taskType === 'metadata') {
    metadataRunId.value = task.metadataRunId || ''
    await loadMetadataComparisons()
  }
  await loadTaskHistory()
}

async function refreshTaskState() {
  taskRefreshing.value = true
  try {
    const [currentResult] = await Promise.all([getCurrentSyncRun(), loadTaskHistory(), loadCatalogProgress()])
    const latest = unwrapSyncRun(currentResult)
    if (latest) {
      setCurrentTask(latest)
      if (isActiveSyncRunStatus(latest.status)) schedulePoll(latest.runId)
      else if (latest.status === 'completed' && latest.taskType === 'metadata') {
        metadataRunId.value = latest.metadataRunId || ''
        await loadMetadataComparisons()
      }
    }
  } catch (error) {
    if (error?.response?.status !== 404 && error?.status !== 404) taskError.value = syncRunErrorMessage(error, '同步任务状态加载失败')
  } finally {
    taskRefreshing.value = false
  }
}

async function loadTaskHistory() {
  historyLoading.value = true
  try {
    const runs = unwrapSyncRunList(await listSyncRuns({ pageNum: 1, pageSize: 30 }))
    taskHistory.value = runs
    const latestMetadata = runs.find((run) => run.taskType === 'metadata' && run.status === 'completed' && run.metadataRunId)
    if (latestMetadata) metadataRunId.value = String(latestMetadata.metadataRunId)
  } catch (error) {
    taskError.value = syncRunErrorMessage(error, '同步记录加载失败')
  } finally {
    historyLoading.value = false
  }
}

const historyLoading = ref(false)

async function cancelTask() {
  if (!currentTask.value?.runId || taskCancelling.value) return
  try {
    await ElMessageBox.confirm('已写入采集候选库的数据会保留。确定停止当前同步任务吗？', '停止同步任务', { type: 'warning', confirmButtonText: '停止任务', cancelButtonText: '继续运行' })
    taskCancelling.value = true
    await cancelSyncRun(currentTask.value.runId)
    currentTask.value = { ...currentTask.value, status: 'cancelling' }
    schedulePoll(currentTask.value.runId, 400)
    ElMessage.success('已提交停止请求')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      taskError.value = syncRunErrorMessage(error, '停止同步任务失败')
      ElMessage.error(taskError.value)
    }
  } finally {
    taskCancelling.value = false
  }
}

function taskTypeLabel(task) {
  return task?.taskType === 'content' ? '教材内容（目录 + 题目）' : '版本与教材'
}

function phaseLabel(task) {
  const phase = normalizeSyncRunPhase(task?.phase, '')
  if (phase === 'metadata') return '发现版本与教材'
  if (phase === 'catalogs_questions') return '同步目录与题目'
  if (phase === 'completed') return '任务完成'
  if (phase === 'failed') return '任务失败'
  if (phase === 'cancelled') return '任务已停止'
  if (phase === 'blocked') return '任务已阻断'
  return phase || '准备中'
}

function unwrapCatalogProgress(payload) {
  const source = payload?.data ?? payload
  if (!source || typeof source !== 'object') return null
  return Array.isArray(source.catalogs) ? source : null
}

async function loadCatalogProgress() {
  try {
    catalogProgress.value = unwrapCatalogProgress(await getCatalogProgress())
  } catch {
    catalogProgress.value = catalogProgress.value
  }
}

function catalogNodeCountText(node) {
  const crawled = Number(node?.uniqueQuestionCount ?? node?.crawledUnique ?? node?.collectedCount ?? 0)
  const total = node?.latestSourceTotal ?? node?.sourceReportedTotal ?? node?.expectedTotal
  const pages = node?.targetPages ?? node?.expectedPages
  const donePages = Number(node?.attemptedPages ?? node?.lastCompletedPage ?? 0)
  const countPart = total == null || total === '' ? `${crawled} / —` : `${crawled} / ${Number(total)}`
  const pagePart = pages == null || pages === '' ? '' : ` · ${donePages}/${Number(pages)} 页`
  const integrity = node?.dataComplete === false || node?.completionQuality === 'completed_with_issues'
    ? ' · 数据不完整'
    : ''
  return `${countPart}${pagePart}${integrity}`
}

function countText(completed, total, fallback) {
  const doneValue = completed ?? fallback
  const done = Number.isFinite(Number(doneValue)) ? Number(doneValue) : 0
  const hasTotal = total !== null && total !== undefined && total !== '' && Number.isFinite(Number(total))
  return hasTotal ? `${done} / ${Number(total)}` : `${done}`
}

function buildCatalogTree(rows) {
  const nodes = new Map(rows.map((row) => [syncComparisonRowKey(row), { key: syncComparisonRowKey(row), label: catalogName(row) || row.externalId, disabled: !canReviewSyncRow(row) || row.comparisonStatus === 'conflict', children: [], row }]))
  const roots = []
  let complete = true
  rows.forEach((row) => {
    const node = nodes.get(syncComparisonRowKey(row))
    const parentId = String(candidateField(row, 'parentExternalId') || '')
    const parent = [...nodes.values()].find((item) => String(item.row.externalId) === parentId)
    if (parent && parent !== node) parent.children.push(node)
    else {
      if (parentId) complete = false
      roots.push(node)
    }
  })
  return { tree: roots, complete }
}

function handleCatalogTreeCheck(_data, checked) {
  const keys = checked?.checkedKeys || []
  replaceSet(selectedCatalogKeys, keys)
}

function toggleCatalogRow(row, checked) {
  const values = new Set(selectedCatalogKeys.value)
  if (checked) values.add(syncComparisonRowKey(row))
  else values.delete(syncComparisonRowKey(row))
  replaceSet(selectedCatalogKeys, values)
}

function isCatalogSelected(row) { return selectedCatalogKeys.value.has(syncComparisonRowKey(row)) }
function catalogLevel(row) { return Number(candidateField(row, 'nodeLevel') || 1) }
function catalogParentText(row) { return candidateField(row, 'parentExternalId') ? `父目录 ${candidateField(row, 'parentExternalId')}` : '根目录' }
function filterCatalogs() {}

async function loadContentForTextbook(key) {
  contentTextbookId.value = key || ''
  selectedCatalogKeys.value = new Set()
  selectedQuestionMap.value = new Map()
  catalogRows.value = []
  questionRows.value = []
  questionPage.pageNum = 1
  questionPage.total = 0
  contentScopeMessage.value = ''
  if (!key) return
  const textbook = contentTextbookOptions.value.find((row) => syncComparisonRowKey(row) === key)
  if (!textbook) return
  contentLoading.value = true
  contentError.value = ''
  try {
    const textbookExternalId = textbook.externalId
    const catalogs = await loadAllComparisons('catalog', {
      sourceProvider: textbook.sourceProvider,
      textbookExternalId,
    })
    catalogRows.value = catalogs.rows
    if (catalogs.sourceAvailable === false) contentScopeMessage.value = catalogs.sourceMessage || '目录候选不可用'
    await loadQuestionPage()
  } catch (error) {
    contentError.value = error?.message || '目录与题目候选加载失败，请稍后重试'
  } finally {
    contentLoading.value = false
  }
}

function questionMatchesTextbook(row) {
  const textbookExternalId = selectedContentTextbook.value?.externalId
  const direct = candidateField(row, 'textbookExternalId')
  if (direct) return String(direct) === String(textbookExternalId)
  const chapterId = candidateField(row, 'chapterId')
  if (!chapterId) return false
  const catalogIds = new Set(catalogRows.value.map((item) => String(item.externalId)))
  return catalogIds.has(String(chapterId))
}

async function loadQuestionPage() {
  if (!contentTextbookId.value) return
  questionLoading.value = true
  contentError.value = ''
  try {
    const result = unwrapSyncCompare(await listSyncComparisons('question', {
      pageNum: questionPage.pageNum,
      pageSize: questionPage.pageSize,
      keyword: questionFilter.keyword || undefined,
      comparisonStatus: questionFilter.status || undefined,
      sourceProvider: selectedContentTextbook.value?.sourceProvider,
      textbookExternalId: selectedContentTextbook.value?.externalId,
    }))
    questionRows.value = result.rows.filter(questionMatchesTextbook).map((row) => ({ ...row, syncKey: syncComparisonRowKey(row) }))
    questionPage.total = result.total
    questionSourceAvailable.value = result.sourceAvailable
    if (result.sourceAvailable === true && result.rows.some((row) => !candidateField(row, 'textbookExternalId', 'chapterId'))) {
      contentScopeMessage.value = '题目接口未提供完整教材关系，已按目录关联或服务端筛选结果展示。'
    }
    const selectedOnPage = questionRows.value.filter((row) => selectedQuestionMap.value.has(syncComparisonRowKey(row)))
    await nextTick()
    syncingQuestionSelection.value = true
    questionTableRef.value?.clearSelection()
    selectedOnPage.forEach((row) => questionTableRef.value?.toggleRowSelection(row, true))
    await nextTick()
    syncingQuestionSelection.value = false
  } catch (error) {
    questionRows.value = []
    questionPage.total = 0
    questionSourceAvailable.value = false
    contentError.value = error?.message || '题目候选加载失败，请稍后重试'
  } finally {
    questionLoading.value = false
  }
}

const questionLoading = ref(false)

function selectableContentRow(row) { return canReviewSyncRow(row) && row.comparisonStatus !== 'conflict' }

function handleQuestionSelection(rows) {
  if (syncingQuestionSelection.value) return
  const map = new Map(selectedQuestionMap.value)
  const currentPageKeys = new Set(questionRows.value.map((row) => syncComparisonRowKey(row)))
  currentPageKeys.forEach((key) => map.delete(key))
  rows.forEach((row) => map.set(syncComparisonRowKey(row), row))
  selectedQuestionMap.value = map
}

function questionCatalogText(row) {
  const chapterId = candidateField(row, 'chapterId')
  const catalog = catalogRows.value.find((item) => String(item.externalId) === String(chapterId))
  return catalogName(catalog) || chapterId || ''
}

function clearContentSelection() {
  selectedCatalogKeys.value = new Set()
  selectedQuestionMap.value = new Map()
  catalogTreeRef.value?.setCheckedKeys([])
  questionTableRef.value?.clearSelection()
}

async function reviewContentSelection(action) {
  const catalogTargets = selectedCatalogRows.value.filter(canReviewSyncRow)
  const questionTargets = selectedQuestionRows.value.filter(canReviewSyncRow)
  if (!catalogTargets.length && !questionTargets.length) return
  const label = action === 'approve' ? '通过' : '驳回'
  try {
    const promptResult = await ElMessageBox.prompt(`请填写本次批量${label}的备注（可选）`, `批量${label}目录与题目`, { inputPlaceholder: '审核备注', confirmButtonText: `提交${label}`, cancelButtonText: '取消' })
    await submitContentReviews(catalogTargets, questionTargets, action, String(promptResult.value || '').trim())
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || `批量${label}失败`)
  }
}

async function reviewContentRows(rows, entityType, action) {
  if (!rows.length || !rows.every(canReviewSyncRow)) return
  const label = action === 'approve' ? '通过' : '驳回'
  try {
    const promptResult = await ElMessageBox.prompt(`请填写本次${label}的备注（可选）`, `${label}${entityType === 'catalog' ? '目录' : '题目'}`, { inputPlaceholder: '审核备注', confirmButtonText: `提交${label}`, cancelButtonText: '取消' })
    await submitContentReviews(entityType === 'catalog' ? rows : [], entityType === 'question' ? rows : [], action, String(promptResult.value || '').trim())
    detailVisible.value = false
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || `${label}失败`)
  }
}

async function submitContentReviews(catalogTargets, questionTargets, action, comment) {
  reviewing.value = true
  reviewAction.value = action
  try {
    const requests = []
    const textbookExternalId = selectedContentTextbook.value?.externalId
    const sourceProvider = selectedContentTextbook.value?.sourceProvider
    if (catalogTargets.length) requests.push(reviewSyncItems('catalog', {
      action,
      sourceProvider,
      textbookExternalId,
      items: buildSyncReviewItems(catalogTargets),
      reviewComment: comment,
    }))
    if (questionTargets.length) requests.push(reviewSyncItems('question', {
      action,
      sourceProvider,
      textbookExternalId,
      items: buildSyncReviewItems(questionTargets),
      reviewComment: comment,
    }))
    await Promise.all(requests)
    ElMessage.success(`${action === 'approve' ? '通过' : '驳回'}成功`)
    clearContentSelection()
    await loadContentForTextbook(contentTextbookId.value)
  } finally {
    reviewing.value = false
    reviewAction.value = ''
  }
}

function isActiveSyncRunStatusValue(status) { return isActiveSyncRunStatus(status) }

onMounted(async () => {
  isMounted = true
  await Promise.all([loadMetadataComparisons(), refreshTaskState()])
})

onBeforeUnmount(() => {
  isMounted = false
  clearPollTimer()
})
</script>

<style scoped>
.sync-center-page { min-height: calc(100vh - 84px); color: var(--el-text-color-primary); }
.page-heading, .section-heading, .task-heading, .task-state-line, .transfer-pane-heading, .workspace-footer, .content-pane-heading, .table-footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.page-heading { align-items: flex-start; margin-bottom: 14px; }
.heading-copy, .section-heading > div, .task-title, .pane-title, .content-pane-heading > div { min-width: 0; }
.page-heading h2 { margin: 0; font-size: 20px; font-weight: 600; }
.page-heading p, .section-heading p { margin: 6px 0 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.55; }
.policy-alert, .state-alert, .task-alert { margin-bottom: 14px; }
.task-panel, .workspace-panel, .history-panel { min-width: 0; margin-bottom: 14px; padding: 16px; border: 1px solid var(--el-border-color-light); border-radius: 6px; background: var(--el-bg-color); }
.task-title, .task-state, .task-actions, .pane-title { display: flex; align-items: center; gap: 10px; }
.task-title strong { font-size: 15px; font-weight: 600; }
.task-title span, .task-state-line, .transfer-pane-heading > span, .section-meta, .toolbar-hint, .content-pane-heading span, .task-id, .task-phase, .task-type, .current-textbook { color: var(--el-text-color-secondary); font-size: 12px; }
.task-state-line { margin-top: 14px; }
.task-state { min-width: 0; flex-wrap: wrap; }
.current-textbook { max-width: min(560px, 58vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-progress { margin-top: 12px; }
.task-progress :deep(.el-progress-bar__outer) { background: var(--el-fill-color-light); }
.task-stat-grid { display: grid; grid-template-columns: repeat(4, minmax(110px, 1fr)); gap: 10px; margin-top: 12px; }
.task-stat { min-width: 0; padding: 8px 10px; border-left: 3px solid var(--el-border-color); background: var(--el-fill-color-lighter); }
.task-stat span { display: block; color: var(--el-text-color-secondary); font-size: 12px; }
.task-stat strong { display: block; margin-top: 3px; font-size: 16px; line-height: 1.2; }
.catalog-progress { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--el-border-color-lighter); }
.catalog-progress-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.catalog-progress-heading strong { color: var(--el-text-color-primary); font-size: 13px; }
.catalog-progress-tree { max-height: 280px; overflow: auto; }
.progress-node { display: flex; min-width: 0; flex: 1; align-items: center; justify-content: space-between; gap: 12px; padding-right: 8px; }
.progress-node.is-current .progress-name { color: var(--el-color-primary); font-weight: 600; }
.progress-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.progress-counts { flex: none; color: var(--el-text-color-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.task-empty { padding: 12px 0 2px; color: var(--el-text-color-secondary); font-size: 12px; }
.task-logs { margin-top: 12px; border-top: 1px solid var(--el-border-color-lighter); }
.task-logs summary { padding-top: 10px; color: var(--el-text-color-regular); cursor: pointer; font-size: 12px; }
.task-logs pre { max-height: 180px; margin: 8px 0 0; padding: 10px; overflow: auto; border: 1px solid var(--el-border-color-lighter); background: var(--el-fill-color-lighter); color: var(--el-text-color-secondary); font: 12px/1.65 var(--el-font-family); white-space: pre-wrap; overflow-wrap: anywhere; }
.sync-tabs :deep(.el-tabs__header) { margin-bottom: 14px; }
.workspace-panel, .history-panel { margin-bottom: 0; }
.section-heading { align-items: flex-start; margin-bottom: 14px; }
.section-heading h3 { margin: 0; font-size: 16px; font-weight: 600; }
.section-meta { flex: none; text-align: right; }
.metadata-toolbar, .content-toolbar, .catalog-toolbar, .question-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.keyword-input { width: min(300px, 100%); }
.status-select { width: 140px; }
.toolbar-hint { min-width: 0; overflow-wrap: anywhere; }
.transfer-layout { display: grid; grid-template-columns: minmax(0, 1fr) 64px minmax(0, 1fr); align-items: stretch; gap: 12px; }
.transfer-pane { min-width: 0; min-height: 470px; border: 1px solid var(--el-border-color-light); border-radius: 5px; overflow: hidden; }
.transfer-pane-heading { min-height: 48px; padding: 0 12px; border-bottom: 1px solid var(--el-border-color-lighter); background: var(--el-fill-color-lighter); }
.pane-title h4 { margin: 0; font-size: 14px; font-weight: 600; }
.transfer-list { height: 420px; overflow: auto; }
.version-group + .version-group { border-top: 1px solid var(--el-border-color-lighter); }
.version-group-heading { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 12px; background: var(--el-fill-color-extra-light); }
.version-name { min-width: 0; overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.version-external-id { overflow: hidden; color: var(--el-text-color-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.version-group-heading .el-tag { margin-left: auto; flex: none; }
.transfer-row { display: flex; align-items: center; gap: 8px; min-height: 58px; padding: 7px 10px; border-bottom: 1px solid var(--el-border-color-lighter); }
.transfer-row:hover, .transfer-row.is-selected { background: var(--el-fill-color-light); }
.transfer-row.is-disabled { color: var(--el-text-color-placeholder); background: var(--el-fill-color-extra-light); }
.row-main { display: flex; min-width: 0; flex: 1; flex-direction: column; align-items: flex-start; gap: 3px; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left; }
.row-main:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.row-title, .row-summary { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-title { font-size: 13px; }
.row-summary { color: var(--el-text-color-secondary); font-size: 11px; }
.row-status { flex: none; }
.transfer-actions { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; }
.icon-action { width: 44px; height: 40px; margin-left: 0 !important; padding: 0; }
.workspace-footer { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--el-border-color-lighter); }
.selection-note { min-width: 0; color: var(--el-text-color-secondary); font-size: 12px; overflow-wrap: anywhere; }
.content-toolbar { padding-bottom: 2px; }
.toolbar-label { color: var(--el-text-color-regular); font-size: 13px; }
.content-textbook-select { width: min(420px, 100%); }
.content-workspace { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(280px, .65fr); gap: 14px; }
.content-source-pane, .content-target-pane { min-width: 0; border: 1px solid var(--el-border-color-light); border-radius: 5px; }
.content-pane-heading { min-height: 52px; padding: 0 12px; border-bottom: 1px solid var(--el-border-color-lighter); background: var(--el-fill-color-lighter); }
.content-pane-heading strong { display: block; font-size: 14px; }
.content-pane-heading span { display: block; margin-top: 3px; }
.content-source-pane > .catalog-toolbar, .content-source-pane > .question-toolbar { padding: 12px 12px 0; }
.catalog-toolbar .el-input, .question-toolbar .el-input { width: min(280px, 100%); }
.catalog-toolbar .el-select, .question-toolbar .el-select { width: 130px; }
.catalog-tree { height: 430px; padding: 8px 12px; overflow: auto; }
.catalog-flat-list { height: 430px; overflow: auto; }
.catalog-flat-row { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 6px 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
.catalog-flat-row:hover { background: var(--el-fill-color-light); }
.catalog-flat-row.is-disabled { color: var(--el-text-color-placeholder); }
.catalog-indent { width: 20px; color: var(--el-text-color-secondary); font-size: 11px; text-align: center; }
.catalog-row-main { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
.catalog-row-main strong, .catalog-row-main small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-row-main strong { font-size: 13px; font-weight: 500; }
.catalog-row-main small { color: var(--el-text-color-secondary); font-size: 11px; }
.question-table { width: 100%; min-height: 360px; }
.safe-preview { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.table-footer { align-items: flex-start; padding: 10px 12px 12px; color: var(--el-text-color-secondary); font-size: 12px; }
.table-footer :deep(.el-pagination) { flex-wrap: wrap; justify-content: flex-end; }
.selection-summary { display: grid; gap: 8px; margin: 0; padding: 14px 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
.selection-summary div { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 8px; }
.selection-summary dt { color: var(--el-text-color-secondary); font-size: 12px; }
.selection-summary dd { min-width: 0; margin: 0; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.selected-preview-list { min-height: 260px; max-height: 430px; padding: 10px 12px; overflow: auto; }
.selected-preview-item { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 6px 0; border-bottom: 1px solid var(--el-border-color-lighter); font-size: 12px; }
.selected-preview-item span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.more-hint, .non-publish-note { display: block; margin: 9px 0 0; color: var(--el-text-color-secondary); font-size: 11px; }
.review-actions { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--el-border-color-lighter); }
.history-table { width: 100%; }
.detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-bottom: 14px; border-bottom: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); font-size: 12px; }
.compare-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; margin-top: 14px; }
.compare-side { min-width: 0; }
.compare-side h3, .detail-fields h3, .safe-question-detail h3 { margin: 0 0 8px; font-size: 14px; }
.compare-side pre, .safe-question-detail pre { min-height: 170px; max-height: 55vh; margin: 0; padding: 12px; overflow: auto; border: 1px solid var(--el-border-color-light); border-radius: 4px; background: var(--el-fill-color-lighter); color: var(--el-text-color-primary); font: 12px/1.65 var(--el-font-family); white-space: pre-wrap; overflow-wrap: anywhere; }
.detail-fields, .safe-question-detail { margin-top: 18px; }
.field-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.muted { color: var(--el-text-color-secondary); }
.detail-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--el-border-color-lighter); }
@media (max-width: 1100px) { .content-workspace { grid-template-columns: 1fr; }.content-target-pane { order: -1; }.selected-preview-list { max-height: 240px; min-height: 90px; }.transfer-layout { grid-template-columns: minmax(0, 1fr) 56px minmax(0, 1fr); } }
@media (max-width: 760px) {
  .page-heading, .section-heading, .task-heading, .task-state-line, .workspace-footer { align-items: flex-start; flex-direction: column; }
  .page-heading > .el-button, .workspace-footer > .el-button { align-self: flex-start; }
  .section-meta { text-align: left; }
  .task-actions { align-self: stretch; justify-content: flex-end; }
  .task-stat-grid { grid-template-columns: repeat(2, minmax(100px, 1fr)); }
  .transfer-layout { grid-template-columns: 1fr; }
  .transfer-actions { flex-direction: row; min-height: 48px; }
  .icon-action { width: 48px; height: 38px; }
  .transfer-pane { min-height: 300px; }
  .transfer-list { height: 320px; }
  .metadata-toolbar, .content-toolbar, .catalog-toolbar, .question-toolbar { align-items: stretch; flex-direction: column; }
  .keyword-input, .status-select, .content-textbook-select, .catalog-toolbar .el-input, .catalog-toolbar .el-select, .question-toolbar .el-input, .question-toolbar .el-select { width: 100%; }
  .table-footer { align-items: flex-start; flex-direction: column; }
  .table-footer :deep(.el-pagination) { justify-content: flex-start; }
  .compare-grid { grid-template-columns: 1fr; }
  .compare-side pre { max-height: 38vh; }
}
@media (max-width: 460px) { .task-stat-grid { grid-template-columns: 1fr; }.task-title { align-items: flex-start; flex-direction: column; gap: 4px; }.current-textbook { max-width: 100%; } }
</style>
