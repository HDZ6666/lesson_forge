import assert from 'node:assert/strict'
import { createImportResultsModel } from '../../../plugins/bank/utils/import-results.js'
import { formatImportTime } from '../../../plugins/bank/utils/sync-task.js'

const page = (id, cursor = 'first', nextCursor = null) => ({
  import: { importId: id, currentBinding: true }, items: [{ batchNo: cursor === 'second' ? 2 : 1 }],
  page: { cursor, nextCursor, hasNext: !!nextCursor, total: 2, upToBatchNo: 2 },
})
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Returning to the first page uses its saved server cursor/watermark.
const cursors = []
let fail = false
const model = createImportResultsModel({
  history: async () => ({ items: [{ importId: 1 }], nextBeforeId: null }),
  batches: async (_task, id, query) => {
    cursors.push(query.cursor)
    if (fail) throw new Error('请求失败')
    return page(id, query.cursor || 'first', query.cursor === 'second' ? null : 'second')
  },
  issues: async (_task, id) => page(id),
})
await model.reset(28, 1)
await model.next()
await model.previous()
assert.deepEqual(cursors, [undefined, 'second', 'first'])
assert.equal(model.state.pages.batches.positions.length, 0)

// Failed next-page/refresh requests keep the visible page and navigation.
const before = structuredClone(model.state.pages.batches)
fail = true
await model.next()
assert.deepEqual(model.state.pages.batches, before)
await model.refresh()
assert.deepEqual(model.state.pages.batches, before)
assert.equal(model.state.error, '请求失败')

// An old task response cannot overwrite the newer task or clear its spinner.
const histories = [deferred(), deferred()], batches = [deferred(), deferred()]
let hi = 0, bi = 0
const racing = createImportResultsModel({ history: () => histories[hi++].promise, batches: () => batches[bi++].promise })
const older = racing.reset(28, 1)
const newer = racing.reset(29, 2)
histories[0].resolve({ items: [{ importId: 1 }], nextBeforeId: null })
batches[0].resolve(page(1))
await older
assert.equal(racing.state.selectedId, 2)
assert.equal(racing.state.selected, undefined)
assert.equal(racing.state.pageLoading, true)
histories[1].resolve({ items: [{ importId: 2 }], nextBeforeId: null })
batches[1].resolve(page(2))
await newer
assert.equal(racing.state.selected.importId, 2)
assert.equal(racing.state.pageLoading, false)

// A terminal task with only older imports never auto-selects old results.
const historyOnly = createImportResultsModel({
  history: async () => ({ items: [{ importId: 1, currentBinding: false }], nextBeforeId: null }),
  batches: async () => { throw new Error('historical result was selected implicitly') },
})
await historyOnly.reset(28, undefined)
assert.equal(historyOnly.state.selectedId, undefined)
assert.equal(historyOnly.state.pages.batches.loaded, false)

// Switching tabs cancels presentation of a late response, not the selected run.
const pending = deferred()
const tabs = createImportResultsModel({
  history: async () => ({ items: [], nextBeforeId: null }), batches: () => pending.promise,
  issues: async (_task, id) => page(id, 'issues'),
})
const loading = tabs.reset(28, 3)
tabs.state.activeTab = 'issues'
await tabs.loadActive()
pending.resolve(page(3))
await loading
assert.equal(tabs.state.pages.batches.loaded, false)
assert.equal(tabs.state.pages.issues.loaded, true)
assert.equal(tabs.state.pageLoading, false)

console.log('import result pagination and request race checks passed')

const oldTimezone = process.env.TZ
process.env.TZ = 'Asia/Shanghai'
assert.equal(formatImportTime('2026-10-02T09:33:14Z'), '2026-10-02 17:33:14')
assert.equal(formatImportTime('2026-10-02T09:33:14+00:00'), '2026-10-02 17:33:14')
assert.equal(formatImportTime('2026-10-02T17:33:14'), '2026-10-02 17:33:14')
assert.equal(formatImportTime('not-a-timeZ'), '—')
if (oldTimezone === undefined) delete process.env.TZ
else process.env.TZ = oldTimezone
