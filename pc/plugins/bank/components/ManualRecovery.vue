<template>
  <el-alert type="warning" :closable="false" show-icon title="采集暂停，需要处理来源验证">
    <p>{{ reason }}</p><p>已有成果保留，后续采集等待人工处理。</p>
    <el-button v-hasPermi="['bank:sync:control']" type="primary" :loading="busy" @click="open">打开浏览器处理</el-button>
  </el-alert>
  <el-drawer v-model="visible" title="服务器浏览器 · 来源验证" size="96%" :close-on-click-modal="false" :before-close="close" append-to-body>
    <p>任务 #{{ session.taskId }} · {{ session.textbookName }} · 已保存 {{ session.savedCount || 0 }} 题 · {{ session.catalogName }} 第 {{ session.pageNumber }} 页</p>
    <p>这是采集器使用的服务器浏览器。请在画面中完成验证或登录，再点击“检查是否恢复”。关闭页面会保留暂停，不会自动继续。</p>
    <el-alert :type="session.verified ? 'success' : 'info'" :title="message || session.message || '正在连接浏览器…'" :closable="false"/>
    <div class="recovery-actions">
      <el-button :disabled="busy" @click="connectDisplay">重新连接画面</el-button>
      <el-button type="primary" :loading="busy" @click="check">检查是否恢复</el-button>
      <el-button type="success" :disabled="!session.verified || busy" @click="finish">补采并恢复队列</el-button>
      <el-button :disabled="busy" @click="close()">暂不继续</el-button>
    </div>
    <div ref="display" class="recovery-display" tabindex="0" aria-label="服务器采集浏览器画面"></div>
  </el-drawer>
</template>
<script setup>
import {nextTick,onBeforeUnmount,ref} from 'vue'
import {ElMessage} from 'element-plus'
import RFB from '@novnc/novnc/lib/rfb'
import request from '@/utils/request'
const props=defineProps({subjectId:{type:Number,required:true},reason:String})
const emit=defineEmits(['updated'])
const visible=ref(false),busy=ref(false),session=ref({}),message=ref(''),display=ref(null)
let rfb=null
async function api(action,data){const r=await request({url:`/bank/sync/manual-recovery/${action}`,method:'post',data,timeout:65000});return r.data || r}
async function open(){busy.value=true;message.value='';try{session.value=await api('open',{subjectId:props.subjectId});visible.value=true;await nextTick();await connectDisplay()}catch(e){ElMessage.error(e.message || '浏览器打开失败')}finally{busy.value=false}}
async function connectDisplay(){
  rfb?.disconnect();rfb=null
  try{
    const {ticket}=await api('ticket',{sessionId:session.value.sessionId})
    const base=new URL(import.meta.env.VITE_APP_BASE_API || '/prod-api',window.location.origin)
    const url=`${base.protocol==='https:'?'wss:':'ws:'}//${base.host}${base.pathname.replace(/\/$/,'')}/bank/sync/manual-display/${ticket}`
    rfb=new RFB(display.value,url,{shared:false});rfb.scaleViewport=true;rfb.resizeSession=false
    rfb.addEventListener('connect',()=>{message.value='已连接。请在下方完成验证，然后检查是否恢复'})
    rfb.addEventListener('disconnect',()=>{if(visible.value)message.value='画面连接已断开，采集仍暂停。可重新连接；离线 90 秒后会关闭浏览器'})
    rfb.addEventListener('securityfailure',()=>{message.value='远程画面认证失败，请关闭后重新打开'})
  }catch(e){message.value=e.message || '画面连接失败'}
}
async function check(){busy.value=true;try{const r=await api('check',{sessionId:session.value.sessionId});session.value={...session.value,...r};message.value=r.message}catch(e){session.value.verified=false;message.value=e.message}finally{busy.value=false}}
async function finish(){busy.value=true;try{const r=await api('finish',{sessionId:session.value.sessionId});visible.value=false;rfb?.disconnect();rfb=null;ElMessage.success(r.message);emit('updated')}catch(e){message.value=e.message}finally{busy.value=false}}
async function close(done){if(busy.value)return;busy.value=true;try{await api('close',{sessionId:session.value.sessionId})}catch(e){ElMessage.warning(e.message || '会话将自动关闭，采集仍保持暂停')}finally{visible.value=false;rfb?.disconnect();rfb=null;busy.value=false;if(typeof done==='function')done();emit('updated')}}
onBeforeUnmount(()=>{rfb?.disconnect();if(session.value.sessionId && visible.value)void api('close',{sessionId:session.value.sessionId}).catch(()=>{})})
</script>
<style scoped>
.recovery-actions{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}.recovery-display{height:calc(100vh - 300px);min-height:380px;background:#18212b;overflow:auto;border-radius:8px}p{line-height:1.6;color:var(--el-text-color-regular)}
</style>
