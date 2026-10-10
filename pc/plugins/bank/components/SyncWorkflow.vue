<template>
  <section class="sync-workflow" aria-label="自动同步流程">
    <div class="workflow-intro"><strong>只需创建计划，后续自动完成</strong><span>每本教材独立排队，可保存顺序；每轮结束后按设定间隔重新同步。</span></div>
    <ol><li v-for="(step, index) in steps" :key="step.title"><span class="step-number">{{ index + 1 }}</span><div><strong>{{ step.title }}</strong><span>{{ step.description }}</span></div></li></ol>
  </section>
</template>
<script setup>
const steps = [
  { title: '创建学科计划', description: '选学科、命名，开始同步' },
  { title: '发现并登记教材', description: '自动更新版本和教材清单' },
  { title: '逐本排队采集', description: '一本一条任务，进度分别显示' },
  { title: '核验并分批入库', description: '合格题目入库，异常保留' },
]
</script>
<style scoped>
.sync-workflow{padding:20px 22px;margin-bottom:20px;border:1px solid var(--el-border-color-lighter);border-radius:12px;background:var(--el-fill-color-extra-light)}.workflow-intro{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:18px}.workflow-intro strong{font-size:14px}.workflow-intro span,li div span{font-size:12px;color:var(--el-text-color-secondary);line-height:1.6}ol{list-style:none;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;padding:0;margin:0}li{display:flex;gap:10px;align-items:flex-start;min-width:0}.step-number{display:grid;place-items:center;width:26px;height:26px;flex-shrink:0;border-radius:50%;background:var(--el-color-primary-light-9);color:var(--el-color-primary);font-size:13px;font-weight:600}li div{display:flex;flex-direction:column;gap:4px}li strong{font-size:13px;font-weight:600;line-height:26px}@media(max-width:1000px){ol{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}}@media(max-width:480px){.sync-workflow{padding:16px}ol{grid-template-columns:1fr}.workflow-intro{gap:6px}}
</style>
