import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse } from '@babel/parser'
import { parse as parseSfc } from '@vue/compiler-sfc'

const source = parseSfc(readFileSync(new URL('../../../plugins/bank/views/sync-overview/index.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content
const ast = parse(source, { sourceType: 'module' }).program.body
const toggle = ast.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'toggleControl')
for (const [paused, canEmergencyPause, expectedCalls] of [[false, false, 0], [false, true, 1], [true, false, 1]]) {
  const requests = [], confirmations = []
  const context = {
    summary: { value: { control: { paused, canEmergencyPause, revision: 7 } } },
    controlling: { value: false }, error: { value: '' }, load: async () => {},
    request: async value => { requests.push(value) },
    ElMessageBox: { confirm: async (...args) => confirmations.push(args) }, ElMessage: { success() {} },
  }
  runInNewContext(source.slice(toggle.start, toggle.end), context)
  await context.toggleControl()
  assert.equal(requests.length, expectedCalls)
  assert.equal(confirmations.length, !paused && canEmergencyPause ? 1 : 0)
  if (requests.length) assert.equal(requests[0].data.paused, !paused)
  assert.equal(context.controlling.value, false)
}
const runtime = ast.find(node => node.type === 'VariableDeclaration' && node.declarations[0]?.id.name === 'runtime')
for (const [paused, label] of [[false, '空闲'], [true, '调度已暂停']]) {
  const context = {
    computed: fn => fn(), loading: { value: false }, controlLoading: { value: false }, error: { value: '' },
    control: { value: {} }, summary: { value: { control: { paused, hasPendingWork: false } } },
  }
  runInNewContext(source.slice(runtime.start, runtime.end) + ';result = runtime', context)
  assert.equal(context.result.label, label)
  if (paused) assert.equal(context.result.type, 'info')
}
