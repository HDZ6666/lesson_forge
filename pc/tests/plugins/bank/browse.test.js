import assert from 'node:assert/strict'

import {
  applyBrowseSort,
  buildBrowseQuery,
  createBrowseQuery,
  resetBrowseFilters,
  setSingleChoice,
  sortPresetFor,
} from '../../../plugins/bank/utils/browse.js'

const query = createBrowseQuery()
query.textbookId = 8
query.catalogId = 13
query.keyword = '二次函数'
query.scene = ['作业']
query.category = ['典型题']
query.pageNum = 2
query.pageSize = 20
query.sort = 'updateTime'
query.order = 'desc'
query.isFresh = true
query.unsupported = 'must-not-be-sent'

assert.deepEqual(buildBrowseQuery(query), {
  usableOnly: true,
  textbookId: 8,
  catalogId: 13,
  keyword: '二次函数',
  scene: ['作业'],
  category: ['典型题'],
  pageNum: 2,
  pageSize: 20,
  sort: 'updateTime',
  order: 'desc',
})

resetBrowseFilters(query)
assert.equal(query.textbookId, 8)
assert.equal(query.catalogId, undefined)
assert.equal(query.keyword, '')
assert.deepEqual(query.scene, [])
assert.equal(query.pageNum, 1)

setSingleChoice(query, 'scene', '期末')
assert.deepEqual(query.scene, ['期末'])
setSingleChoice(query, 'scene', undefined)
assert.deepEqual(query.scene, [])

applyBrowseSort(query, 'latest')
assert.equal(query.sort, 'updateTime')
assert.equal(query.order, 'desc')
assert.equal(query.pageNum, 1)
assert.equal(sortPresetFor(query), 'latest')
applyBrowseSort(query, 'hottest')
assert.equal(query.sort, 'assembleCount')
assert.equal(sortPresetFor(query), 'hottest')
applyBrowseSort(query, 'unknown')
assert.equal(query.sort, 'questionId')
assert.equal(sortPresetFor(query), 'comprehensive')

console.log('browse utility assertions passed')

