<template>
  <el-form label-position="top">
    <el-form-item label="每个目录最多采集页数"><el-input-number :model-value="Math.min(modelValue.catalogPageLimit ?? 1000, 1000)" :min="1" :max="1000" :precision="0" :step="100" @update:model-value="v=>change('catalogPageLimit',v ?? 1000)"/><span class="unit">页</span><p class="hint">每个章、节或知识点目录只处理来源当前可访问的前1000页（不足则到实际末尾），可设更小的上限。到达上限是正常结束，不代表来源题目已全部采完。<template v-if="(modelValue.catalogPageLimit ?? 0) > 1000">原设置 {{ modelValue.catalogPageLimit }} 页已保留，本次有效上限为 1000 页。</template></p></el-form-item>
    <el-form-item label="每次同步最多轮数"><el-checkbox :model-value="modelValue.maxRounds == null" @update:model-value="v=>change('maxRounds',v?null:3)">不限制</el-checkbox><el-input-number v-if="modelValue.maxRounds != null" :model-value="modelValue.maxRounds" :min="1" :max="1000" :precision="0" style="margin-left:12px" @update:model-value="v=>change('maxRounds',v ?? 1)"/><span v-if="modelValue.maxRounds != null" class="unit">轮</span><p class="hint">一轮检查完全部教材后，如有正式新增题目或新增关联就继续下一轮；没有新增则休眠。不限制轮数时仍会在无新增后休眠。</p></el-form-item>
    <el-form-item label="计划名称"><el-input :model-value="modelValue.planName" maxlength="100" placeholder="例如：数学全教材同步" @update:model-value="v=>change('planName',v)"/></el-form-item>
    <el-form-item label="自动更新"><el-switch :model-value="modelValue.autoUpdate" active-text="每轮结束后重新同步全部教材" @update:model-value="v=>change('autoUpdate',v)"/><p class="hint">关闭后当前轮次继续执行，结束后不再自动开始下一轮。</p></el-form-item>
    <el-form-item label="休眠后自动唤醒间隔"><el-input-number :model-value="modelValue.refreshDays" :min="1" :max="365" @update:model-value="v=>change('refreshDays',v)"/><span class="unit">天</span><p class="hint">从本次同步收尾的时间计算。例如10日因无新增休眠，间隔7天就是17日开始下一次同步，先发现教材再同步。</p></el-form-item>
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
