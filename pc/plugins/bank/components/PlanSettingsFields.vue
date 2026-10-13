<template>
  <el-form label-position="top">
    <el-form-item label="每个目录最多采集页数"><el-input-number :model-value="modelValue.catalogPageLimit ?? 1000" :min="1" :max="10000" :precision="0" :step="100" @update:model-value="v=>change('catalogPageLimit',v ?? 1000)"/><span class="unit">页</span><p class="hint">默认1000页，可改为1500等整数（1～10000）。每个章、节或知识点目录分别计数，到达上限后继续下一个目录；达到上限不代表来源题目已全部采完。保存后适用于尚未派发的排队任务及后续任务，正在执行的任务保持原设置。</p></el-form-item>
    <el-form-item label="计划名称"><el-input :model-value="modelValue.planName" maxlength="100" placeholder="例如：数学全教材同步" @update:model-value="v=>change('planName',v)"/></el-form-item>
    <el-form-item label="自动更新"><el-switch :model-value="modelValue.autoUpdate" active-text="每轮结束后重新同步全部教材" @update:model-value="v=>change('autoUpdate',v)"/><p class="hint">关闭后当前轮次继续执行，结束后不再自动开始下一轮。</p></el-form-item>
    <el-form-item label="整轮更新间隔"><el-input-number :model-value="modelValue.refreshDays" :min="1" :max="365" @update:model-value="v=>change('refreshDays',v)"/><span class="unit">天</span><p class="hint">从本轮所有教材处理结束时计算。例如10日结束，间隔7天就是17日开始下一轮；失败和部分完成也属于已处理。</p></el-form-item>
    <el-form-item label="题目分页并发"><el-select :model-value="modelValue.listConcurrency" @update:model-value="v=>change('listConcurrency',v)"><el-option v-for="n in [1,2,4,8]" :key="n" :value="n" :label="`${n} 页并发`"/></el-select><p class="hint">一本教材内同时请求的页数，每页通常10道。影响之后创建的任务，已有待办可单独调整。</p></el-form-item>
  </el-form>
</template>
<script setup>
const props=defineProps({modelValue:{type:Object,required:true}}),emit=defineEmits(['update:modelValue'])
function change(key,value){emit('update:modelValue',{...props.modelValue,[key]:value})}
</script>
<style scoped>
.hint{width:100%;font-size:12px;color:var(--el-text-color-secondary);line-height:1.7;margin:8px 0 0}.unit{margin-left:8px}
</style>
