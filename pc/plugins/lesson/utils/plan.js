/**
 * 抽题页面的纯函数：目录勾选到知识点、规则表行与请求体的互转、结果标签。
 * 不依赖 Vue 与 DOM，便于 node:assert 直接测试。
 */

export const PHASE_NAMES = Object.freeze({
  intro: '导入',
  example: '例题',
  practice: '巩固练习',
  extend: '拓展提升',
  homework: '课后作业',
})

export const PHASE_ORDER = Object.freeze(['intro', 'example', 'practice', 'extend', 'homework'])

export const RELAX_LABELS = Object.freeze(['严格', '放宽 1 级', '放宽 2 级', '兜底'])

export const RELAX_TAG_TYPES = Object.freeze(['success', 'primary', 'warning', 'danger'])

export function phaseName(phase) {
  return PHASE_NAMES[phase] || phase || ''
}

export function relaxLabel(level) {
  const index = Number(level) || 0
  return RELAX_LABELS[Math.min(RELAX_LABELS.length - 1, Math.max(0, index))]
}

export function relaxTagType(level) {
  const index = Number(level) || 0
  return RELAX_TAG_TYPES[Math.min(RELAX_TAG_TYPES.length - 1, Math.max(0, index))]
}

/** 目录树中知识点（point）节点及无子节点的叶子都视为可抽题的知识点。 */
export function isPointNode(node) {
  if (!node || typeof node !== 'object') return false
  if (node.nodeType === 'point') return true
  return !Array.isArray(node.children) || node.children.length === 0
}

/** 展平目录树，返回 catalogId -> { catalogId, name, path, node } 的索引。 */
export function indexCatalogTree(tree, parentPath = []) {
  const index = new Map()
  for (const node of Array.isArray(tree) ? tree : []) {
    const catalogId = node?.catalogId ?? node?.catalog_id
    if (catalogId === undefined || catalogId === null) continue
    const name = node.nodeName ?? node.node_name ?? String(catalogId)
    const path = [...parentPath, name]
    index.set(String(catalogId), { catalogId, name, path: path.join(' › '), node })
    for (const [key, value] of indexCatalogTree(node.children, path)) index.set(key, value)
  }
  return index
}

/** 从 el-tree 勾选结果中只保留知识点节点，并按树中出现顺序去重。 */
export function collectCheckedPoints(tree, checkedKeys) {
  const wanted = new Set((checkedKeys || []).map((key) => String(key)))
  const points = []
  const walk = (nodes) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const catalogId = node?.catalogId ?? node?.catalog_id
      if (catalogId !== undefined && wanted.has(String(catalogId)) && isPointNode(node)) {
        points.push({ catalogId, name: node.nodeName ?? node.node_name ?? String(catalogId) })
      }
      walk(node?.children)
    }
  }
  walk(tree)
  return points
}

let ruleSequence = 0

/** 把服务端默认规则或已保存规则转成表格可编辑行。 */
export function ruleRowFrom(rule) {
  ruleSequence += 1
  return {
    key: `rule-${ruleSequence}`,
    phase: rule?.phase || 'practice',
    ruleName: rule?.ruleName ?? '',
    catalogIds: Array.isArray(rule?.catalogIds) ? rule.catalogIds.map((id) => Number(id)) : [],
    questionCount: Number(rule?.questionCount) > 0 ? Number(rule.questionCount) : 1,
    questionTypes: Array.isArray(rule?.questionTypes) ? [...rule.questionTypes] : [],
    easeRange: [
      rule?.easeMin === null || rule?.easeMin === undefined ? 0 : Number(rule.easeMin),
      rule?.easeMax === null || rule?.easeMax === undefined ? 1 : Number(rule.easeMax),
    ],
    maxExtraPoints: rule?.maxExtraPoints === null || rule?.maxExtraPoints === undefined ? 1 : Number(rule.maxExtraPoints),
    maxSubquestionCount: rule?.maxSubquestionCount ?? null,
    allowImage: rule?.allowImage !== false,
    allowTable: rule?.allowTable !== false,
  }
}

export function newRuleRow(points, phase = 'practice') {
  return ruleRowFrom({
    phase,
    ruleName: `${phaseName(phase)}·自定义`,
    catalogIds: (points || []).map((point) => point.catalogId),
    questionCount: 2,
    easeMin: 0.4,
    easeMax: 1,
  })
}

/** 表格行 -> 服务端 RuleInputModel。 */
export function ruleRowToPayload(row, sortNo) {
  const [easeMin, easeMax] = Array.isArray(row?.easeRange) ? row.easeRange : [0, 1]
  return {
    phase: row.phase,
    ruleName: row.ruleName || `${phaseName(row.phase)}`,
    catalogIds: (row.catalogIds || []).map((id) => Number(id)),
    questionCount: Number(row.questionCount) || 1,
    questionTypes: Array.isArray(row.questionTypes) ? row.questionTypes : [],
    easeMin: Number(easeMin),
    easeMax: Number(easeMax),
    maxExtraPoints: Number(row.maxExtraPoints) || 0,
    maxSubquestionCount: row.maxSubquestionCount ? Number(row.maxSubquestionCount) : null,
    allowImage: row.allowImage !== false,
    allowTable: row.allowTable !== false,
    sortNo,
  }
}

export function sortRuleRows(rows) {
  return [...(rows || [])].sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase))
}

/** 页面设置 + 规则表 -> 生成请求体。 */
export function buildGeneratePayload(settings, rows, points) {
  const rules = sortRuleRows(rows).map((row, index) => ruleRowToPayload(row, index))
  const exam = Array.isArray(settings?.preferredExamTypes) ? settings.preferredExamTypes.filter(Boolean) : []
  return {
    textbookId: Number(settings?.textbookId),
    title: (settings?.title || '').trim() || (points || []).map((point) => point.name).join('、'),
    lessonType: settings?.lessonType || 'new',
    durationMinutes: Number(settings?.durationMinutes) || 45,
    recentYears: Number(settings?.recentYears ?? 3),
    preferredProvince: (settings?.preferredProvince || '').trim() || null,
    preferredCity: (settings?.preferredCity || '').trim() || null,
    preferredExamTypes: exam,
    preferRealExam: settings?.preferRealExam !== false,
    rules,
  }
}

export function validateRuleRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '请先勾选知识点并生成规则'
  for (const row of rows) {
    if (!row.catalogIds?.length) return `规则「${row.ruleName || phaseName(row.phase)}」没有知识点`
    if (!(Number(row.questionCount) >= 1)) return `规则「${row.ruleName || phaseName(row.phase)}」题数必须大于 0`
    const [min, max] = row.easeRange || [0, 1]
    if (Number(min) > Number(max)) return `规则「${row.ruleName || phaseName(row.phase)}」易度区间无效`
  }
  return ''
}

export function totalQuestionCount(rows) {
  return (rows || []).reduce((sum, row) => sum + (Number(row.questionCount) || 0), 0)
}

export function simulationTagType(row) {
  if (!row) return 'info'
  if (row.satisfiedLevel === null || row.satisfiedLevel === undefined) return 'danger'
  if (row.satisfiedLevel === 0) return 'success'
  return 'warning'
}

export function questionSourceText(question) {
  if (!question) return ''
  return [
    question.year ? `${question.year}年` : '',
    question.province || '',
    question.city || '',
    question.examType || '',
    question.paperName || question.sourceText || '',
  ].filter(Boolean).join(' · ')
}

export function assetKeyOf(questionId, assetKey) {
  return `${questionId}:${assetKey}`
}

export function safeFileName(title, fallback = '教案') {
  const cleaned = String(title || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim()
  return `${cleaned || fallback}.docx`
}
