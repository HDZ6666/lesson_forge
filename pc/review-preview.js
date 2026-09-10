import { createApp, h, ref } from 'vue'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import './src/assets/styles/index.scss'
import Detail from './plugins/bank/views/sync-question/detail.vue'

if (!import.meta.env.DEV) throw new Error('本地预览仅用于开发环境')
const tasks = ref([])
const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/:taskId', component: Detail }, { path: '/:pathMatch(.*)*', redirect: '/17' }] })
fetch('/dev-api/preview/tasks').then(r => r.json()).then(r => { tasks.value = r.data || [] })
const app = createApp({ setup: () => () => h('div', [
  h('div', { style: 'padding:12px 24px;background:#ecf5ff;border-bottom:1px solid #b3d8ff;display:flex;gap:20px;align-items:center;position:sticky;top:0;z-index:20' }, [
    h('strong', '本地预览 · 线上实时数据'), h('span', { style: 'color:#606266;font-size:13px' }, '删除 / 恢复仅影响本地预览'),
    ...tasks.value.map(task => h('a', { href: `#/${task.taskId}`, style: 'color:#1677ff' }, `任务 ${task.taskId} · ${task.status}`)),
  ]), h(RouterView),
]) })
app.use(router).use(ElementPlus, { locale: zhCn })
app.directive('hasPermi', { mounted(el) { el.style.display = 'none' } })
app.mount('#app')
