export const planTaskStages = {
  queued: ['排队中', 'info'], collecting: ['采集中', 'warning'],
  checking: ['核验成果', 'warning'], importing: ['分批入库', 'warning'],
  completed: ['完成', 'success'], partial: ['部分完成', 'warning'],
  failed: ['需要处理', 'danger'], cancelled: ['已停止', 'info'],
}
export function planBookStage(book) {
  if (!book.enabled || book.exceptionKind) return { key: 'excluded', label: '暂停或人工单列', type: 'info' }
  if (!book.inCurrentCycle) return { key: 'later', label: '等待下轮', type: 'info' }
  const key = book.taskInCurrentCycle ? book.taskStage || 'queued' : 'queued'
  const [label, type] = planTaskStages[key] || ['等待安排', 'info']
  return { key, label, type }
}
export function planProgress(books) {
  const counts = { total: 0, queued: 0, collecting: 0, checking: 0, importing: 0, completed: 0, partial: 0, failed: 0, cancelled: 0, excluded: 0 }
  for (const book of books) {
    if (!book.inCurrentCycle) continue
    counts.total++
    counts[planBookStage(book).key]++
  }
  counts.finished = counts.completed + counts.partial + counts.failed + counts.cancelled + counts.excluded
  return counts
}
export function planPhase(plan, progress) {
  if (!plan.planId) return '尚未创建'
  if (!plan.enabled) return '计划已暂停'
  if (plan.discoveryTaskId) {
    if (plan.discoveryStatus === 'completed' && !plan.discoveryRegistered) return '登记教材清单'
    return plan.discoveryStatus === 'queued' ? '等待教材发现' : '发现教材'
  }
  if (plan.discoveryError) return '教材发现待处理'
  if (!plan.cycleNo) return '准备教材发现'
  if (progress.finished < progress.total) return '逐本同步中'
  return '本轮已结束，等待下次更新'
}
