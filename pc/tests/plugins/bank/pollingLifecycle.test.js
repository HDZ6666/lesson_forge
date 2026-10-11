import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const hooks = {}, document = { hidden: false, addEventListener: (_, fn) => { document.listener = fn }, removeEventListener: () => { document.listener = null } }
let starts = 0, stops = 0
const context = { document, start: () => starts++, stop: () => stops++ }
for (const name of ['onMounted', 'onActivated', 'onDeactivated', 'onBeforeUnmount']) context[name] = fn => { hooks[name] = fn }
const source = readFileSync(new URL('../../../plugins/bank/composables/usePollingLifecycle.js', import.meta.url), 'utf8').replace(/^import .*\n/, '').replace('export function', 'function')
vm.runInNewContext(source + '\nusePollingLifecycle(start, stop)', context)
hooks.onMounted(); hooks.onActivated()
assert.equal(starts, 1)
hooks.onDeactivated(); assert.equal(stops, 1)
document.hidden = true; hooks.onActivated(); assert.equal(starts, 1)
document.hidden = false; document.listener(); assert.equal(starts, 2)
document.hidden = true; document.listener(); assert.equal(stops, 2)
hooks.onBeforeUnmount(); assert.equal(document.listener, null); assert.equal(stops, 2)
