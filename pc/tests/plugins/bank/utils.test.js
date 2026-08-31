import assert from 'node:assert/strict'

import { buildAssetUrl, resolveAssetUrl, sanitizeHtml } from '../../../plugins/bank/utils/html.js'
import { createQuestionQuery, isBatchActionable, resetQuestionState } from '../../../plugins/bank/utils/state.js'
import { unwrapList, unwrapPage } from '../../../plugins/bank/utils/response.js'

const unsafe = sanitizeHtml('<p onclick="alert(1)">题目</p><script>alert(2)</script><a href="javascript:alert(3)">链接</a>')
assert.match(unsafe, /题目/)
assert.doesNotMatch(unsafe, /onclick|script|javascript/i)
assert.equal(buildAssetUrl(3, 'image-a'), '/bank/question/3/asset/image-a')
assert.equal(buildAssetUrl(3, 'image/a'), '')
assert.equal(buildAssetUrl(3, 'javascript:alert(1)'), '')
assert.equal(buildAssetUrl('../3', 'image-a'), '')
assert.equal(resolveAssetUrl({ assetKey: 'image-a', storagePath: 'ab/hash.png', downloadStatus: 'ready', assetUrl: 'https://evil.example/image.png' }, 3), '/bank/question/3/asset/image-a')
assert.equal(resolveAssetUrl({ assetKey: 'image-a', url: 'https://evil.example/image.png' }, 3), '')
assert.doesNotMatch(sanitizeHtml('<img data-asset-key="image-a">', () => 'https://evil.example/image.png'), /src=/i)

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
