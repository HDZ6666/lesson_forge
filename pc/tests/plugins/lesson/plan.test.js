import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolvePluginViewPath } from '../../../src/utils/pluginViewResolver.js'
import {
  buildGeneratePayload,
  collectCheckedPoints,
  indexCatalogTree,
  newRuleRow,
  relaxLabel,
  relaxTagType,
  ruleRowFrom,
  ruleRowToPayload,
  safeFileName,
  simulationTagType,
  sortRuleRows,
  validateRuleRows,
} from '../../../plugins/lesson/utils/plan.js'
import { isSafeImageSource, sanitizeHtml } from '../../../plugins/lesson/utils/html.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '../../../plugins/lesson')
const read = (relativePath) => readFileSync(resolve(pluginRoot, relativePath), 'utf8')

// 菜单组件路径必须能解析到插件视图文件。
assert.equal(resolvePluginViewPath('plugin/lesson/plan/index'), '../../../plugins/lesson/views/plan/index.vue')
assert.ok(existsSync(resolve(pluginRoot, 'views/plan/index.vue')))

// 目录勾选：只保留知识点（point 或叶子），父节点勾选不会把章节当知识点。
const tree = [
  {
    catalogId: 1,
    nodeName: '第二章',
    nodeType: 'chapter',
    children: [
      { catalogId: 11, nodeName: '2 配方法', nodeType: 'section', children: [
        { catalogId: 111, nodeName: '配方法', nodeType: 'point', children: [] },
        { catalogId: 112, nodeName: '直接开平方法', nodeType: 'point' },
      ] },
      { catalogId: 12, nodeName: '空小节', nodeType: 'section', children: [] },
    ],
  },
]
assert.deepEqual(collectCheckedPoints(tree, [1, 11, 111, 112, 12]).map((point) => point.catalogId), [111, 112, 12])
assert.deepEqual(collectCheckedPoints(tree, ['112']).map((point) => point.name), ['直接开平方法'])
assert.equal(indexCatalogTree(tree).get('111').path, '第二章 › 2 配方法 › 配方法')

// 规则行与请求体互转，空易度按 0~1 处理，排序按环节顺序。
const row = ruleRowFrom({ phase: 'homework', ruleName: '作业', catalogIds: ['111', 112], questionCount: 4, questionTypes: ['解答题'], easeMin: null, easeMax: 0.9, maxExtraPoints: 2 })
assert.deepEqual(row.catalogIds, [111, 112])
assert.deepEqual(row.easeRange, [0, 0.9])
assert.equal(row.allowImage, true)
const payload = ruleRowToPayload(row, 3)
assert.equal(payload.easeMin, 0)
assert.equal(payload.easeMax, 0.9)
assert.equal(payload.sortNo, 3)
assert.equal(payload.maxSubquestionCount, null)

const rows = [row, ruleRowFrom({ phase: 'intro', catalogIds: [111], questionCount: 1 }), newRuleRow([{ catalogId: 111, name: '配方法' }], 'practice')]
assert.deepEqual(sortRuleRows(rows).map((item) => item.phase), ['intro', 'practice', 'homework'])
assert.equal(validateRuleRows(rows), '')
assert.match(validateRuleRows([{ phase: 'intro', catalogIds: [], questionCount: 1, easeRange: [0, 1] }]), /没有知识点/)
assert.match(validateRuleRows([]), /请先勾选知识点/)

const generatePayload = buildGeneratePayload(
  { textbookId: '7', title: '  ', lessonType: 'review', durationMinutes: 40, recentYears: 5, preferredProvince: ' 江苏 ', preferredCity: '', preferredExamTypes: ['中考', ''], preferRealExam: false },
  rows,
  [{ catalogId: 111, name: '配方法' }, { catalogId: 112, name: '直接开平方法' }],
)
assert.equal(generatePayload.textbookId, 7)
assert.equal(generatePayload.title, '配方法、直接开平方法')
assert.equal(generatePayload.preferredProvince, '江苏')
assert.equal(generatePayload.preferredCity, null)
assert.deepEqual(generatePayload.preferredExamTypes, ['中考'])
assert.equal(generatePayload.preferRealExam, false)
assert.deepEqual(generatePayload.rules.map((rule) => rule.phase), ['intro', 'practice', 'homework'])
assert.deepEqual(generatePayload.rules.map((rule) => rule.sortNo), [0, 1, 2])

// 展示标签与文件名。
assert.equal(relaxLabel(0), '严格')
assert.equal(relaxLabel(3), '兜底')
assert.equal(relaxLabel(9), '兜底')
assert.equal(relaxTagType(2), 'warning')
assert.equal(simulationTagType({ satisfiedLevel: 0 }), 'success')
assert.equal(simulationTagType({ satisfiedLevel: null }), 'danger')
assert.equal(simulationTagType({ satisfiedLevel: 2 }), 'warning')
assert.equal(safeFileName('配方法/第1课时: 复习'), '配方法 第1课时  复习.docx')
assert.equal(safeFileName(''), '教案.docx')

// 无 DOM 环境下的清洗退化：脚本、事件与外链一律去掉。
const cleaned = sanitizeHtml('<p onclick="x()">a<script>alert(1)</script><img src="http://evil/x.png" data-asset-key="k"></p>')
assert.doesNotMatch(cleaned, /script|onclick|http:\/\/evil/)
assert.equal(isSafeImageSource('blob:http://localhost/abc'), true)
assert.equal(isSafeImageSource('/lesson/plan/asset/1/k'), true)
assert.equal(isSafeImageSource('https://zujuan.xkw.com/x.png'), false)

// 页面结构：三栏、规则表、模拟、生成、换题、重新生成、导出、历史抽屉、图片走鉴权接口。
const view = read('views/plan/index.vue')
const catalogPanel = view.indexOf('class="panel catalog-panel"')
const rulesPanel = view.indexOf('class="panel rules-panel"')
const previewPanel = view.indexOf('class="panel preview-panel"')
assert.ok(catalogPanel >= 0 && catalogPanel < rulesPanel && rulesPanel < previewPanel, '左目录、中规则、右预览的顺序')
assert.match(view, /<el-tree[\s\S]*show-checkbox/)
assert.match(view, /@click="runSimulation"/)
assert.match(view, /@click="runGenerate"/)
assert.match(view, /@click="replaceItem\(item\)"/)
assert.match(view, /@click="runRegenerate"/)
assert.match(view, /@click="runExport"/)
assert.match(view, /@click="saveText"/)
assert.match(view, /<el-drawer v-model="historyVisible"/)
assert.match(view, /v-hasPermi="\['lesson:plan:remove'\]"/)
assert.match(view, /getPlanAsset\(item\.questionId, asset\.assetKey, detail\.generationId\)/)
assert.match(view, /URL\.createObjectURL/)
assert.match(view, /URL\.revokeObjectURL/)
assert.match(view, /saveAs\(blob, safeFileName/)
assert.doesNotMatch(view, /\/bank\/question\//, '页面不直接依赖 bank 接口路径')

const api = read('api/lesson.js')
for (const path of ['/options', '/versions', '/textbooks', '/catalog-tree', '/rules/default', '/simulate', '/generate', '/generation/list', '/regenerate', '/replace', '/text', '/export', '/asset/']) {
  assert.ok(api.includes(path), `api 应包含 ${path}`)
}
assert.match(api, /responseType: 'blob'/)

console.log('lesson plan utils and view assertions passed')
