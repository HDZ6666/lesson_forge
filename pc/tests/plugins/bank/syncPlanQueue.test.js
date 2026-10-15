import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse } from '@babel/parser'
import { parse as parseSfc } from '@vue/compiler-sfc'

const source = parseSfc(readFileSync(new URL('../../../plugins/bank/views/sync-plans/index.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content
const ast = parse(source, { sourceType: 'module' }).program.body
const declarations = ['filteredQueue', 'visibleQueue'].map(name => ast.find(node => node.type === 'VariableDeclaration' && node.declarations.some(d => d.id.name === name)))
const queue = Array.from({ length: 155 }, (_, index) => ({ taskId: index+1, textbookId: index+1, textbookName: '七年级上册', versionName: `版本${index+1}`, externalTextbookId: `s${index+1}` }))
const context = { computed: fn => ({ get value(){ return fn() } }), queue: { value: { queue } }, queueSearch: { value: '' }, queuePage: { value: 8 } }
runInNewContext(declarations.map(n => source.slice(n.start,n.end)).join('\n') + ';getRows=()=>visibleQueue.value;getAll=()=>filteredQueue.value', context)
assert.equal(context.getAll().length, 155)
assert.equal(context.getRows().length, 15)
assert.equal(context.getRows()[0].queuePosition, 141)
context.queueSearch.value='s155';context.queuePage.value=1
assert.equal(context.getRows().length, 1)
assert.equal(context.getRows()[0].queuePosition, 155)
assert.equal(context.getRows()[0].taskId, 155)
