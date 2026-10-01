import assert from 'node:assert/strict'

import { createQuestionAssetStore } from '../../../plugins/bank/utils/assets.js'
import { sanitizeHtml } from '../../../plugins/bank/utils/html.js'
import { createQuestionQuery, isBatchActionable, resetQuestionState } from '../../../plugins/bank/utils/state.js'
import { unwrapList, unwrapPage } from '../../../plugins/bank/utils/response.js'

const unsafe = sanitizeHtml('<p onclick="alert(1)">题目</p><script>alert(2)</script><a href="javascript:alert(3)">链接</a>')
assert.match(unsafe, /题目/)
assert.doesNotMatch(unsafe, /onclick|script|javascript/i)
assert.doesNotMatch(sanitizeHtml('<img data-asset-key="image-a">', () => 'https://evil.example/image.png'), /src=/i)

let completeFirst
const firstAsset = new Promise((resolve) => { completeFirst = resolve })
const revoked = []
const originalCreate = URL.createObjectURL
const originalRevoke = URL.revokeObjectURL
URL.createObjectURL = (blob) => `blob:test-${blob.size}-${Math.random()}`
URL.revokeObjectURL = (url) => revoked.push(url)
try {
  const store = createQuestionAssetStore((questionId) => questionId === 1 ? firstAsset : Promise.resolve(new Blob(['new'])))
  const first = store.load(1, [{ assetKey: 'old', storagePath: 'old.png', downloadStatus: 'ready' }])
  await store.load(2, [{ assetKey: 'new', storagePath: 'new.png', downloadStatus: 'ready' }])
  const currentUrl = store.resolve({ assetKey: 'new', storagePath: 'new.png', downloadStatus: 'ready' })
  assert.match(currentUrl, /^blob:test-/)
  completeFirst(new Blob(['old']))
  await first
  assert.equal(store.resolve({ assetKey: 'old', storagePath: 'old.png', downloadStatus: 'ready' }), '')
  store.reset()
  assert.equal(store.resolve({ assetKey: 'new', storagePath: 'new.png', downloadStatus: 'ready' }), '')
  assert.ok(revoked.includes(currentUrl))
  assert.equal(revoked.length, 2)
} finally {
  URL.createObjectURL = originalCreate
  URL.revokeObjectURL = originalRevoke
}

const query = createQuestionQuery()
query.textbookId = 8
query.catalogId = 9
query.keyword = '保留'
query.scene = ['生活情境']
resetQuestionState(query, 'version')
assert.equal(query.textbookId, undefined)
assert.equal(query.catalogId, undefined)
assert.equal(query.keyword, '')
assert.deepEqual(query.scene, [])

assert.equal(isBatchActionable({ status: 'approval_pending' }, 'approve'), true)
assert.equal(isBatchActionable({ status: 'validated' }, 'approve'), false)
assert.equal(isBatchActionable({ status: 'approved' }, 'publish'), true)
assert.equal(isBatchActionable({ status: 'validated' }, 'publish'), false)
assert.equal(isBatchActionable({ status: 'published' }, 'rollback'), true)
assert.equal(isBatchActionable({ status: 'archived' }, 'rollback'), true)
assert.equal(isBatchActionable({ status: 'building' }, 'publish'), false)
assert.deepEqual(unwrapList({ data: { rows: [{ id: 1 }] } }), [{ id: 1 }])
assert.deepEqual(unwrapPage({ rows: [{ id: 1 }], total: 7 }), { rows: [{ id: 1 }], total: 7 })
