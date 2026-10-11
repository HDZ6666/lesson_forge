export function executionSummary(task) {
  const count = Number(task.executionCount || 0)
  const pending = task.status === 'queued' && !task.startedAt
  return `已执行 ${count} 次${pending ? `，第 ${count + 1} 次待执行` : ''}`
}
export function executionLabel(row, count) {
  if (row.executionNumber) return `第 ${row.executionNumber} 次`
  return row.status === 'queued' ? `第 ${Number(count || 0) + 1} 次待执行` : '未启动'
}
