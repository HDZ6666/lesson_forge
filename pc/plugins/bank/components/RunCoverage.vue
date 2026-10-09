<template>
  <section class="run-coverage" aria-label="本次采集范围与来源观察">
    <h3>本次采集范围</h3>
    <p v-if="!view" class="coverage-note">本次未保存来源观察和扫描范围记录，覆盖情况尚不能确定。</p>
    <template v-else>
      <p>来源报告（整本教材）：{{ count(view.sourceCount) }} 道 · 观察时间：{{ view.observedAt ? formatImportTime(view.observedAt) : '未记录' }}</p>
      <p>本次去重采集：{{ count(view.collectedCount) }} 道<template v-if="view.difference !== null"> · 来源报告减去本次题数：{{ view.difference }}</template></p>
      <p v-if="view.difference !== null" class="coverage-note">数量差仅供参考；来源数量会随时间变化，本次目录范围也可能不同，不能据此确定漏题数量。</p>
      <div class="coverage-grid">
        <span>范围内可选目录：{{ count(view.available) }}</span>
        <span>目标目录：{{ count(view.targets) }}</span>
        <span>已完整扫描目录：{{ count(view.scanned) }}</span>
        <span>待继续扫描目录：{{ count(view.unscanned) }}</span>
        <span>失败页：{{ count(view.failedPages) }}</span>
        <span>解析异常：{{ count(view.parseErrors) }}</span>
        <span>素材异常：{{ count(view.assetErrors) }}</span>
        <span>重复页：{{ count(view.duplicatePages) }}</span>
      </div>
      <p v-if="view.limits.length" class="coverage-note">本次范围设置：{{ view.limits.join('；') }}。</p>
      <p class="coverage-note">完整扫描表示目标范围已扫描；题目能否使用还取决于入库检查与启停状态。未记录的指标保留为未知。</p>
    </template>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { runCoverageView } from '../utils/run-coverage'
import { formatImportTime } from '../utils/sync-task'
const props = defineProps({ coverage: Object })
const view = computed(() => runCoverageView(props.coverage))
const count = value => value === null ? '未记录' : value
</script>

<style scoped>
.run-coverage { margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--el-border-color-light); }
.run-coverage h3 { font-size: 16px; }.coverage-note { color: var(--el-text-color-secondary); font-size: 13px; }
.coverage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
</style>
