<template>
  <nav class="sync-center-nav" aria-label="同步中心导航">
    <router-link v-for="item in entries" :key="item.key" :to="item.path" :class="{ active: active === item.key }" :aria-current="active === item.key ? 'page' : undefined">
      <el-icon><component :is="item.icon" /></el-icon><span>{{ item.label }}</span>
    </router-link>
  </nav>
</template>
<script setup>
import { DataBoard, Search, Calendar, List } from '@element-plus/icons-vue'
defineProps({ active: String })
const entries = [
  { key: 'overview', label: '同步总览', path: '/sync-center/overview', icon: DataBoard },
  { key: 'discovery', label: '教材发现', path: '/sync-center/discovery', icon: Search },
  { key: 'plans', label: '学科计划', path: '/sync-center/plans', icon: Calendar },
  { key: 'tasks', label: '同步任务', path: '/sync-center/tasks', icon: List },
]
</script>
<style scoped>
.sync-center-nav{display:flex;gap:6px;border-bottom:1px solid var(--el-border-color-light);margin:0 0 24px;overflow-x:auto}
a{display:flex;align-items:center;gap:8px;white-space:nowrap;padding:14px 18px;color:var(--el-text-color-secondary);font-size:14px;border-bottom:3px solid transparent;text-decoration:none;transition:color .15s,background .15s}
a:hover{color:var(--el-color-primary);background:var(--el-color-primary-light-9)}a.active{color:var(--el-color-primary);border-color:var(--el-color-primary);font-weight:600}
@media(max-width:600px){a{padding:12px 10px;gap:5px;font-size:13px}.sync-center-nav{gap:0;margin-bottom:18px}}
</style>
