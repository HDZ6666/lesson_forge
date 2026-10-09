<template>
  <div class="app-container lesson-editor">
    <header><h2>教案生成</h2><el-button @click="historyVisible=true;loadHistory()">历史与草稿</el-button></header>
    <el-alert v-if="error" :title="error" type="error" :closable="false"/><el-button v-if="failed" :loading="saving" @click="retry">重试未保存操作</el-button><el-button v-if="failed && draft" :disabled="saving" @click="refreshSaved">放弃本地操作，读取已保存版本</el-button>
    <div v-if="!draft" class="create-panel">
      <h3>选择本节课使用的教材</h3><SubjectSelect v-model="subjectId" @change="loadVersions"/>
      <el-select v-model="versionId" placeholder="版本" @change="loadBooks"><el-option v-for="v in versions" :key="v.versionId" :label="v.versionName" :value="v.versionId"/></el-select>
      <el-select v-model="bookId" placeholder="教材"><el-option v-for="b in books" :key="b.textbookId" :label="b.textbookName" :value="b.textbookId"/></el-select>
      <el-input v-model="newTitle" placeholder="教案名称" maxlength="200"/>
      <el-button v-hasPermi="['lesson:plan:generate']" type="primary" :disabled="!bookId" :loading="saving" @click="create">开始备课</el-button>
    </div>
    <template v-else>
      <div class="draft-header"><el-input v-model="title" :disabled="draft.readOnly || saving || !!failed" maxlength="200" @change="saveTitle"/><span>{{ draft.readOnly ? '历史教案（只读）' : saving ? '保存中' : failed ? '保存失败，操作已保留' : '已保存' }} · 版本 {{ draft.revision }}</span>
        <el-button v-if="draft.readOnly" @click="copyDraft(draft.draftId)">复制为可编辑教案</el-button>
        <el-button :disabled="busy || dirty" @click="previewVisible=true">预览</el-button>
        <el-button v-hasPermi="['lesson:plan:export']" :disabled="saving || !!failed || dirty" @click="exportWord">导出 Word</el-button>
        <el-button :disabled="saving || !!failed || dirty" @click="leave">新建另一份</el-button>
      </div>
      <el-alert v-if="draft.items.some(i=>i.snapshotMissing)" title="部分历史题目缺少当时的快照；复制时使用当前题库重建并注明，无法找回当年题干。" type="warning" :closable="false"/>
      <el-tabs v-if="!draft.readOnly" v-model="mode" @tab-change="changeMode"><el-tab-pane label="按教学内容配题" name="content"/><el-tab-pane label="直接筛题" name="direct"/></el-tabs>
      <div class="editor-layout">
        <aside>
          <h3>教学内容</h3>
          <el-button v-if="!draft.readOnly" :disabled="busy" @click="newGroup">新增内容</el-button>
          <div v-for="(group,groupIndex) in draft.groups" :key="group.groupKey" :class="['group',{active:activeGroup===group.groupKey}]" @click="chooseGroup(group)">
            <strong>{{ group.name }}</strong><small>{{ draft.items.filter(i=>i.groupKey===group.groupKey).length }} 道题</small>
            <el-button v-if="!draft.readOnly" link :disabled="busy" @click.stop="editGroup(group)">编辑内容和条件</el-button><span v-if="!draft.readOnly"><el-button link :disabled="busy || groupIndex===0" @click.stop="moveGroup(groupIndex,-1)">上移</el-button><el-button link :disabled="busy || groupIndex===draft.groups.length-1" @click.stop="moveGroup(groupIndex,1)">下移</el-button></span>
          </div>
          <div :class="['group',{active:!activeGroup}]" @click="chooseGroup(null)"><strong>待整理</strong><small>{{ draft.unassignedCount || 0 }} 道题</small></div>
          <p>可以先列教学内容，也可以直接筛题后再分组。</p>
          <el-button v-if="!draft.readOnly" :disabled="busy" :loading="saving" @click="fill()">补齐全部内容</el-button>
        </aside>
        <main v-if="!draft.readOnly">
          <template v-if="mode==='content'">
            <h3>{{ currentGroup?.name || '请先选择教学内容' }}</h3>
            <el-select v-model="activeRule" clearable placeholder="选择条件组" @change="queryCandidates()"><el-option v-for="r in currentGroup?.rules || []" :key="r.ruleKey" :label="`${r.name} · 目标 ${r.targetCount} 道`" :value="r.ruleKey"/></el-select>
            <p v-if="currentRuleSummary">符合 {{ currentRuleSummary.matchedCount }} · 待复核 {{ currentRuleSummary.needsReviewCount }} · 超额 {{ currentRuleSummary.excessCount }} · 缺额 {{ currentRuleSummary.deficit }}</p>
            <el-button :disabled="busy || !currentGroup" @click="fill(activeGroup)">补齐当前内容</el-button>
            <el-button :disabled="!activeRule" @click="queryCandidates()">查看候选</el-button>
          </template>
          <template v-else>
            <h3>筛选题目</h3><QuestionFilter v-model="filter" :catalogs="catalogs" :options="options"/>
            <div class="pick-bar"><el-button type="primary" :loading="querying" :disabled="busy" @click="queryCandidates()">搜索题目</el-button><el-input-number v-model="pickCount" :min="1" :max="20"/><el-button :disabled="busy" @click="pick">按数量选入</el-button></div>
            <p>选入位置：{{ currentGroup?.name || '待整理' }}。直接筛题选入为手选题，不自动占用条件组名额。</p>
          </template>
          <p>符合条件 {{ candidates.total || 0 }} 道 · 尚未选入 {{ candidates.remainingCount || 0 }} 道</p>
          <div v-for="question in candidates.rows || []" :key="question.questionId" class="question-card">
            <div class="candidate-title"><span>{{ question.questionType || '题型未知' }} · {{ question.difficulty || '难度未知' }} · {{ question.year || '年份未知' }}</span><el-button :disabled="busy || question.selected" @click="select(question)">{{ question.selected?`已选入 ${groupName(question.selectedGroupKey)}`:'选入' }}</el-button></div>
            <QuestionStem :question="question" :draft-id="draft.draftId" candidate/>
          </div>
          <el-pagination v-if="candidates.total" v-model:current-page="page" :page-size="20" :total="candidates.total" layout="prev,pager,next" @current-change="queryCandidates(false)"/>
        </main>
        <section class="selected">
          <h3>已选题目（{{ draft.items.length }}）</h3>
          <el-button v-if="undoId && !draft.readOnly" :disabled="busy" @click="undo">撤销最近移出</el-button>
          <div v-for="(item,index) in selectedItems" :key="item.itemId" class="question-card">
            <div><strong>{{ index+1 }}.</strong><el-tag v-if="item.needsReview" type="warning">条件已变化，待复核</el-tag><el-tag v-if="!item.ruleKey" type="info">手选题</el-tag><el-tag v-if="item.currentStatus && item.currentStatus!=='enabled'" type="warning">当前题库{{item.currentStatus==='missing'?'已不存在':'已停用'}}</el-tag><el-tag v-else-if="item.sourceChanged" type="info">题库已更新，保留选入版本</el-tag></div>
            <QuestionStem v-if="item.question" :question="item.question" :draft-id="draft.draftId"/>
            <div v-if="!draft.readOnly" class="item-actions">
              <el-button link :disabled="busy || index===0" @click="moveUp(item,index)">上移</el-button><el-button link :disabled="busy || index===selectedItems.length-1" @click="moveDown(item,index)">下移</el-button>
              <el-dropdown :disabled="busy" @command="key=>move(item,key)"><el-button link>移动到内容</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item :command="null">待整理</el-dropdown-item><el-dropdown-item v-for="g in draft.groups" :key="g.groupKey" :command="g.groupKey">{{g.name}}</el-dropdown-item></el-dropdown-menu></template></el-dropdown><el-dropdown v-if="currentGroup?.rules.length" :disabled="busy" @command="ruleKey=>assignRule(item,ruleKey)"><el-button link>规则归属</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item :command="'manual'">作为手选题</el-dropdown-item><el-dropdown-item v-for="r in currentGroup.rules" :key="r.ruleKey" :command="r.ruleKey">{{r.name}}</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
              <el-button link :disabled="busy" @click="replace(item)">换一题</el-button><el-button link type="danger" :disabled="busy" @click="remove(item)">移出</el-button>
            </div>
          </div>
        </section>
      </div>
      <el-dialog v-model="groupVisible" title="教学内容与条件组" width="min(720px,95vw)" :close-on-click-modal="false" @closed="groupClosed">
        <el-input v-model="groupForm.name" placeholder="例如：同号相加" maxlength="100"/>
        <el-tree-select v-model="groupForm.catalogIds" :data="catalogs" :props="treeProps" node-key="catalogId" multiple show-checkbox check-strictly placeholder="选择该内容的目录范围"/>
        <el-tabs v-model="editingRule"><el-tab-pane v-for="r in groupForm.rules" :key="r.ruleKey" :label="r.name" :name="r.ruleKey">
          <el-input v-model="r.name" maxlength="100" placeholder="条件组名称"/><el-input-number v-model="r.targetCount" :min="0" :max="20"/><QuestionFilter v-model="r.filter" hide-catalog :catalogs="catalogs" :options="options"/>
          <el-button type="danger" link @click="deleteRule(r.ruleKey)">删除条件组（保留题目）</el-button>
        </el-tab-pane></el-tabs>
        <el-button @click="addRule">新增条件组</el-button>
        <template #footer><el-button v-if="groupForm.existing" type="danger" :disabled="busy" @click="deleteGroup">删除内容（题目转待整理）</el-button><el-button @click="groupVisible=false">取消</el-button><el-button type="primary" :loading="saving" :disabled="!!failed" @click="saveGroup">保存内容与条件</el-button></template>
      </el-dialog>
      <el-dialog v-model="previewVisible" title="题目预览" width="min(900px,95vw)">
        <div class="print-settings"><el-checkbox v-model="printSettings.showGroupTitles" :disabled="draft.readOnly || busy" @change="savePrint">显示分组标题</el-checkbox><el-select v-model="printSettings.blankLines" :disabled="draft.readOnly || busy" @change="savePrint"><el-option v-for="n in [0,2,4]" :key="n" :value="n" :label="`题后留白 ${n} 行`"/></el-select></div>
        <article><h2>{{ draft.title }}</h2><div v-for="g in printGroups" :key="g.groupKey || 'supplement'">
          <h3 v-if="printSettings.showGroupTitles">{{ g.name }}</h3><div v-for="item in g.items" :key="item.itemId"><strong>{{ item.number }}.</strong><QuestionStem :question="item.question" :draft-id="draft.draftId"/><div :style="{height:`${printSettings.blankLines*24}px`}"/></div>
        </div></article>
        <template #footer><el-button type="primary" :disabled="busy" @click="exportWord">导出当前已保存版本</el-button></template>
      </el-dialog>
    </template>
    <el-drawer v-model="historyVisible" title="历史与草稿" size="500px">
      <h3>可编辑草稿</h3><div v-for="item in history" :key="item.draftId" class="history-row"><el-button link @click="openDraft(item.draftId)">{{item.title}}</el-button><el-button link @click="copyDraft(item.draftId)">复制</el-button><el-button v-hasPermi="['lesson:plan:remove']" link type="danger" @click="deleteDraft(item)">删除</el-button></div>
      <el-pagination v-if="historyTotal>20" v-model:current-page="historyPage" :page-size="20" :total="historyTotal" layout="prev,pager,next" @current-change="loadHistory"/><h3>历史教案（只读）</h3><div v-for="item in legacy" :key="item.generationId" class="history-row"><el-button link @click="openDraft(item.generationId)">{{item.title || item.schemeName}}</el-button><el-button link @click="copyDraft(item.generationId)">复制为草稿</el-button></div>
      <el-pagination v-if="legacyTotal>20" v-model:current-page="legacyPage" :page-size="20" :total="legacyTotal" layout="prev,pager,next" @current-change="loadHistory"/>
    </el-drawer>
  </div>
</template>
<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import request from '@/utils/request'
import SubjectSelect from '../../../bank/components/SubjectSelect.vue'
import QuestionFilter from '../../components/QuestionFilter.vue'
import QuestionStem from '../../components/QuestionStem.vue'
const base='/lesson/plan',data=r=>r.data || r,clone=v=>JSON.parse(JSON.stringify(v)),key=()=>crypto.randomUUID()
const emptyFilter=()=>({catalogIds:[],questionTypes:[],difficulties:[],easeMin:null,easeMax:null,yearMin:null,yearMax:null,provinces:[],cities:[],examTypes:[],maxExtraPoints:null,maxSubquestionCount:null,allowImage:true,allowTable:true})
const subjectId=ref(1),versionId=ref(),bookId=ref(),versions=ref([]),books=ref([]),newTitle=ref('新教案'),draft=ref(),title=ref(''),catalogs=ref([]),options=ref({}),filter=ref(emptyFilter()),mode=ref('content'),activeGroup=ref(null),activeRule=ref(null),candidates=ref({}),page=ref(1),pickCount=ref(1)
const saving=ref(false),error=ref(''),failed=ref(null),querying=ref(false),undoId=ref(),groupVisible=ref(false),groupForm=ref({rules:[]}),editingRule=ref(),previewVisible=ref(false),printSettings=ref({showGroupTitles:true,blankLines:2}),historyVisible=ref(false),history=ref([]),legacy=ref([])
const treeProps={label:'nodeName',children:'children'},busy=computed(()=>saving.value || !!failed.value),dirty=computed(()=>groupVisible.value || title.value!==(draft.value?.title || ''))
const currentGroup=computed(()=>draft.value?.groups.find(g=>g.groupKey===activeGroup.value)),currentRuleSummary=computed(()=>draft.value?.rules?.find(r=>r.ruleKey===activeRule.value)),selectedItems=computed(()=>draft.value?.items.filter(i=>i.groupKey===activeGroup.value).sort((a,b)=>a.sortNo-b.sortNo || a.itemId-b.itemId) || [])
const printGroups=computed(()=>{let n=0;return [...(draft.value?.groups || []),{groupKey:null,name:'补充题'}].map(g=>({...g,items:(draft.value?.items || []).filter(i=>i.groupKey===g.groupKey).sort((a,b)=>a.sortNo-b.sortNo || a.itemId-b.itemId).map(i=>({...i,number:++n}))})).filter(g=>g.items.length)})
const historyPage=ref(1),historyTotal=ref(0),legacyPage=ref(1),legacyTotal=ref(0)
let searchEpoch=0,scopeEpoch=0,historyEpoch=0
async function loadVersions(){const id=++scopeEpoch;versionId.value=null;bookId.value=null;books.value=[];try{const r=await request({url:`${base}/versions`,params:{subjectId:subjectId.value,pageSize:100}});if(id===scopeEpoch)versions.value=r.rows || r.data?.rows || []}catch(e){error.value=e.message}}
async function loadBooks(){const id=++scopeEpoch;bookId.value=null;try{const r=await request({url:`${base}/textbooks`,params:{versionId:versionId.value,subjectId:subjectId.value,pageSize:100}});if(id===scopeEpoch)books.value=r.rows || r.data?.rows || []}catch(e){error.value=e.message}}
async function openDraft(id){if(busy.value || dirty.value)return;await readDraft(id);historyVisible.value=false}
async function readDraft(id){const d=data(await request({url:`${base}/drafts/${id}`}));if(draft.value?.draftId!==d.draftId){chooseGroup(null);filter.value=emptyFilter();undoId.value=null;previewVisible.value=false}draft.value=d;if(activeGroup.value&&!d.groups.some(g=>g.groupKey===activeGroup.value))chooseGroup(null);if(activeRule.value&&!d.groups.some(g=>g.rules.some(r=>r.ruleKey===activeRule.value)))activeRule.value=null;title.value=d.title;printSettings.value=clone(d.printSettings);const [c,o]=await Promise.all([request({url:`${base}/catalog-tree`,params:{textbookId:d.textbookId}}),d.readOnly?Promise.resolve({data:{}}):request({url:`${base}/drafts/${id}/filter-options`})]);catalogs.value=data(c);options.value=data(o)}
async function perform(operation){if(saving.value)return;saving.value=true;error.value='';try{const r=data(await request(operation));failed.value=null;if(r.deleted){if(draft.value?.draftId===r.draftId)leave();await loadHistory();return r}if(r.undoRequestId)undoId.value=r.undoRequestId;await readDraft(r.draftId);++searchEpoch;querying.value=false;const chosen=new Set(draft.value.items.map(i=>i.questionId));if(candidates.value.rows)candidates.value.rows=candidates.value.rows.map(q=>({...q,selected:chosen.has(q.questionId)}));return r}catch(e){failed.value=operation;error.value=e.message || '保存失败，输入和操作已保留';throw e}finally{saving.value=false}}
async function execute(operation){try{return await perform(operation)}catch{return null}}
async function retry(){if(failed.value)await execute(failed.value)}
async function refreshSaved(){try{await readDraft(draft.value.draftId);failed.value=null;error.value='';groupVisible.value=false;chooseGroup(null)}catch(e){error.value=e.message}}

function mutation(path,payload,method='post'){return execute({url:`${base}/drafts/${draft.value.draftId}${path}`,method,data:{...clone(payload),expectedRevision:draft.value.revision,requestId:key()}})}
async function create(){await execute({url:`${base}/drafts`,method:'post',data:{textbookId:bookId.value,title:newTitle.value,requestId:key()}})}
async function saveTitle(){await mutation('/commands',{type:'set_title',title:title.value})}
async function savePrint(){await mutation('/commands',{type:'set_print',printSettings:printSettings.value})}
function chooseGroup(group){activeGroup.value=group?.groupKey || null;activeRule.value=null;candidates.value={};querying.value=false;++searchEpoch}
function changeMode(){candidates.value={};querying.value=false;++searchEpoch}
async function queryCandidates(reset=true){if(!draft.value || draft.value.readOnly)return;if(mode.value==='content'&&!activeRule.value)return;if(reset)page.value=1;const id=++searchEpoch;querying.value=true;try{const r=await request({url:`${base}/candidates/query`,method:'post',data:{draftId:draft.value.draftId,filter:mode.value==='direct'?filter.value:emptyFilter(),ruleKey:mode.value==='content'?activeRule.value:null,pageNum:page.value,pageSize:20}});if(id===searchEpoch && data(r).revision===draft.value.revision)candidates.value=data(r)}catch(e){if(id===searchEpoch)error.value=e.message}finally{if(id===searchEpoch)querying.value=false}}
async function select(q){const result=await mutation('/commands',{type:'select',questionIds:[q.questionId],groupKey:activeGroup.value,ruleKey:mode.value==='content'?activeRule.value:null,filter:mode.value==='direct'?filter.value:null});if(result){if(result.rejected?.length)error.value='该题已失效或不符合条件，未选入';await queryCandidates(false)}}
async function pick(){const r=await mutation('/pick',{filter:filter.value,count:pickCount.value,groupKey:activeGroup.value});if(r){const gap=r.allocationResults?.[0]?.shortfall;if(gap)error.value=`已选入可匹配题目，仍缺 ${gap} 道`;await queryCandidates(false)}}
async function fill(groupKey=null){const result=await mutation('/fill',{groupKey});if(result){const gaps=result.allocationResults?.filter(r=>r.shortfall);if(gaps?.length)error.value=`已补齐可匹配部分，${gaps.length} 个条件组仍有缺额`}}
function newGroup(){groupForm.value={groupKey:key(),name:'新教学内容',catalogIds:[],rules:[],existing:false};editingRule.value=null;groupVisible.value=true}
function editGroup(g){groupForm.value={...clone(g),existing:true};editingRule.value=g.rules[0]?.ruleKey;groupVisible.value=true}
function addRule(){const r={ruleKey:key(),name:`条件组 ${groupForm.value.rules.length+1}`,targetCount:1,filter:emptyFilter()};groupForm.value.rules.push(r);editingRule.value=r.ruleKey}
function deleteRule(id){groupForm.value.rules=groupForm.value.rules.filter(r=>r.ruleKey!==id);editingRule.value=groupForm.value.rules[0]?.ruleKey}
async function saveGroup(){const g=clone(groupForm.value);delete g.existing;const groups=clone(draft.value.groups),index=groups.findIndex(x=>x.groupKey===g.groupKey);if(index<0)groups.push(g);else groups[index]=g;const r=await mutation('/commands',{type:'set_structure',groups});if(r){candidates.value={};activeGroup.value=g.groupKey;groupVisible.value=false}}
async function deleteGroup(){const r=await mutation('/commands',{type:'set_structure',groups:draft.value.groups.filter(g=>g.groupKey!==groupForm.value.groupKey)});if(r){activeGroup.value=null;groupVisible.value=false}}
function groupClosed(){groupForm.value={rules:[]}}
async function move(item,groupKey){await mutation('/commands',{type:'move',itemIds:[item.itemId],groupKey})}
async function moveUp(item,index){if(!index)return;const ids=selectedItems.value.map(i=>i.itemId);[ids[index-1],ids[index]]=[ids[index],ids[index-1]];await mutation('/commands',{type:'reorder',groupKey:item.groupKey,itemIds:ids})}
async function remove(item){await mutation('/commands',{type:'remove',itemIds:[item.itemId]})}
async function undo(){const r=await mutation('/commands',{type:'undo',undoRequestId:undoId.value});if(r)undoId.value=null}
async function replace(item){if(!item.ruleKey&&mode.value!=='direct'){mode.value='direct';error.value='手选题换题：请设置筛选条件，再点击换一题';return}const r=await mutation(`/items/${item.itemId}/replace`,{filter:item.ruleKey?null:filter.value});if(r&&r.replaced===false)error.value=r.reason}
async function exportWord(){if(busy.value||dirty.value)return;try{const r=await request({url:`${base}/drafts/${draft.value.draftId}/export`,method:'post',data:{revision:draft.value.revision},responseType:'blob',timeout:60000});const blob=r instanceof Blob?r:r.data;if(!(blob instanceof Blob))throw Error('导出响应无效');const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${draft.value.title}.docx`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(e){error.value=e.message || 'Word导出失败'}}
async function loadHistory(){const id=++historyEpoch;try{const [d,l]=await Promise.all([request({url:`${base}/drafts`,params:{pageNum:historyPage.value,pageSize:20}}),request({url:`${base}/generation/list`,params:{pageNum:legacyPage.value,pageSize:20}})]);if(id!==historyEpoch)return;history.value=data(d).rows || [];historyTotal.value=data(d).total || 0;legacy.value=l.rows || l.data?.rows || [];legacyTotal.value=l.total || l.data?.total || 0}catch(e){if(id===historyEpoch)error.value=e.message}}
async function copyDraft(id){if(busy.value || dirty.value)return;const result=await execute({url:`${base}/generation/${id}/copy-as-draft`,method:'post',data:{requestId:key()}});if(result)historyVisible.value=false}
async function deleteDraft(item){if(busy.value || dirty.value)return;await execute({url:`${base}/drafts/${item.draftId}`,method:'delete',data:{requestId:key(),expectedRevision:item.revision}})}
function leave(){++searchEpoch;querying.value=false;draft.value=null;title.value='';activeGroup.value=null;activeRule.value=null;candidates.value={};undoId.value=null}
function groupName(id){return draft.value?.groups.find(g=>g.groupKey===id)?.name || '待整理'}
async function moveGroup(index,delta){const groups=clone(draft.value.groups);[groups[index],groups[index+delta]]=[groups[index+delta],groups[index]];await mutation('/commands',{type:'set_structure',groups})}
async function moveDown(item,index){const ids=selectedItems.value.map(i=>i.itemId);if(index>=ids.length-1)return;[ids[index],ids[index+1]]=[ids[index+1],ids[index]];await mutation('/commands',{type:'reorder',groupKey:item.groupKey,itemIds:ids})}
async function assignRule(item,ruleKey){await mutation('/commands',{type:'move',itemIds:[item.itemId],groupKey:item.groupKey,ruleKey:ruleKey==='manual'?null:ruleKey})}
function beforeUnload(event){if(dirty.value || busy.value){event.preventDefault();event.returnValue=''}}
onBeforeRouteLeave(()=>!dirty.value && !busy.value)
onMounted(()=>{loadVersions();window.addEventListener('beforeunload',beforeUnload)})
onBeforeUnmount(()=>{++searchEpoch;++scopeEpoch;window.removeEventListener('beforeunload',beforeUnload)})
</script>
<style scoped>
header,.draft-header{display:flex;gap:12px;align-items:center;margin-bottom:16px}header h2{flex:1}.draft-header .el-input{max-width:360px}.draft-header span{flex:1;font-size:13px;color:var(--el-text-color-secondary)}.create-panel{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.create-panel .el-input,.create-panel .el-select{width:220px}.editor-layout{display:grid;grid-template-columns:220px minmax(300px,1fr) minmax(300px,1fr);gap:20px;margin-top:16px}.group{padding:14px;margin:8px 0;border:1px solid var(--el-border-color);border-radius:6px;cursor:pointer}.group.active{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.group small{display:block}.question-card{border:1px solid var(--el-border-color);padding:14px;margin:12px 0;border-radius:6px}.candidate-title,.item-actions,.pick-bar,.print-settings,.history-row{display:flex;gap:12px;align-items:center;margin:8px 0}.candidate-title span{flex:1}.print-settings .el-select{width:180px}p,small{color:var(--el-text-color-secondary)}article{background:white;color:#222;padding:32px}.el-dialog .el-tree-select{width:100%;margin:12px 0}@media(max-width:1100px){.editor-layout{grid-template-columns:180px 1fr}.selected{grid-column:1/-1}}@media(max-width:700px){.editor-layout{display:block}.draft-header{flex-wrap:wrap}.draft-header .el-input{max-width:none}}
</style>
