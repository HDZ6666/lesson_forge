<template><div class="question-stem"><div v-html="html"/><el-button v-if="failed" link type="warning" @click="load">图片加载失败，重试</el-button></div></template>
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import request from '@/utils/request'
import { sanitizeHtml } from '../utils/html'
const props=defineProps({question:{type:Object,required:true},draftId:Number,candidate:Boolean}),urls=ref({}),failed=ref(false)
let epoch=0
const html=computed(()=>{const plain=String(props.question.plainText || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');return sanitizeHtml(props.question.contentHtml || plain,key=>urls.value[key] ?? 'loading')})
function clear(){Object.values(urls.value).forEach(url=>{if(url?.startsWith('blob:'))URL.revokeObjectURL(url)});urls.value={}}
async function load(){const id=++epoch;clear();failed.value=false;await Promise.all((props.question.assets || []).map(async asset=>{try{const result=await request({url:`/lesson/plan/drafts/${props.draftId}/${props.candidate?'candidates/':''}${props.candidate?`${props.question.questionId}/assets/${encodeURIComponent(asset.assetKey)}`:`assets/${props.question.questionId}/${encodeURIComponent(asset.assetKey)}`}`,responseType:'blob'});const blob=result instanceof Blob?result:result.data;if(!(blob instanceof Blob))throw Error('图片响应无效');if(id===epoch)urls.value[asset.assetKey]=URL.createObjectURL(blob)}catch(e){if(id===epoch){urls.value[asset.assetKey]='';failed.value=true}}}))}
watch(()=>[props.question,props.draftId,props.candidate],load,{immediate:true})
onBeforeUnmount(()=>{++epoch;clear()})
</script>
<style scoped>.question-stem{line-height:1.8;overflow-wrap:anywhere}.question-stem :deep(img){max-width:100%;height:auto}.question-stem :deep(table){border-collapse:collapse;max-width:100%}.question-stem :deep(td),.question-stem :deep(th){border:1px solid #bbb;padding:4px}</style>
