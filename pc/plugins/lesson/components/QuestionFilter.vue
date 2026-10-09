<template>
  <el-form label-position="top" class="question-filter">
    <el-form-item v-if="!hideCatalog" label="目录范围（不选则整本教材）"><el-tree-select :model-value="value.catalogIds" @update:model-value="set('catalogIds',$event)" :data="catalogs" :props="treeProps" node-key="catalogId" multiple show-checkbox check-strictly/></el-form-item>
    <el-form-item label="题型"><el-select :model-value="value.questionTypes" @update:model-value="set('questionTypes',$event)" multiple clearable><el-option v-for="item in options.questionTypes || []" :key="item" :label="item" :value="item"/></el-select></el-form-item>
    <el-form-item label="难度标签"><el-select :model-value="value.difficulties" @update:model-value="set('difficulties',$event)" multiple clearable :disabled="value.easeMin!=null || value.easeMax!=null"><el-option v-for="item in options.difficulties || []" :key="item" :label="item" :value="item"/></el-select></el-form-item>
    <el-form-item label="易度区间（越大越容易，留空不限）"><div class="range"><el-input-number :model-value="value.easeMin" @update:model-value="set('easeMin',$event ?? null)" :disabled="value.difficulties?.length>0" :min="0" :max="1" :step="0.1" controls-position="right"/><span>至</span><el-input-number :model-value="value.easeMax" @update:model-value="set('easeMax',$event ?? null)" :disabled="value.difficulties?.length>0" :min="0" :max="1" :step="0.1" controls-position="right"/></div></el-form-item>
    <el-collapse><el-collapse-item title="年份、地区及高级条件" name="advanced">
      <el-form-item label="年份范围（留空不限）"><div class="range"><el-input-number :model-value="value.yearMin" @update:model-value="set('yearMin',$event ?? null)" :min="1900" :max="2200" controls-position="right"/><span>至</span><el-input-number :model-value="value.yearMax" @update:model-value="set('yearMax',$event ?? null)" :min="1900" :max="2200" controls-position="right"/></div></el-form-item>
      <el-form-item label="省份"><el-select :model-value="value.provinces" @update:model-value="set('provinces',$event)" multiple filterable><el-option v-for="item in options.provinces || []" :key="item" :label="item" :value="item"/></el-select></el-form-item>
      <el-form-item label="城市"><el-select :model-value="value.cities" @update:model-value="set('cities',$event)" multiple filterable><el-option v-for="item in options.cities || []" :key="item" :label="item" :value="item"/></el-select></el-form-item>
      <el-form-item label="考试类型"><el-select :model-value="value.examTypes" @update:model-value="set('examTypes',$event)" multiple filterable><el-option v-for="item in options.examTypes || []" :key="item" :label="item" :value="item"/></el-select></el-form-item>
      <el-form-item label="最多附带知识点（留空不限）"><el-input-number :model-value="value.maxExtraPoints" @update:model-value="set('maxExtraPoints',$event ?? null)" :min="0" :max="100"/></el-form-item>
      <el-form-item label="最大小问数（留空不限）"><el-input-number :model-value="value.maxSubquestionCount" @update:model-value="set('maxSubquestionCount',$event ?? null)" :min="1" :max="100"/></el-form-item>
      <p class="hint">限制开启时，未知字段的题目不视为符合条件；知识点数量只统计来源明确标注的内容。</p>
    </el-collapse-item></el-collapse>
    <el-form-item><el-checkbox :model-value="value.allowImage" @update:model-value="set('allowImage',$event)">允许题干图片</el-checkbox><el-checkbox :model-value="value.allowTable" @update:model-value="set('allowTable',$event)">允许表格</el-checkbox></el-form-item>
  </el-form>
</template>
<script setup>
import { computed } from 'vue'
const props=defineProps({modelValue:{type:Object,required:true},catalogs:{type:Array,default:()=>[]},options:{type:Object,default:()=>({})},hideCatalog:Boolean}),emit=defineEmits(['update:modelValue'])
const value=computed(()=>props.modelValue),treeProps={label:'nodeName',children:'children'}
function set(name,value){emit('update:modelValue',{...props.modelValue,[name]:value})}
</script>
<style scoped>.range{display:flex;gap:8px;align-items:center}.range .el-input-number{width:120px}.hint{font-size:12px;color:var(--el-text-color-secondary)}.el-select,.el-tree-select{width:100%}</style>
