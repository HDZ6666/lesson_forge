import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const api = readFileSync(resolve(here, '../../../plugins/bank/api/bank.js'), 'utf8')
const listPage = readFileSync(resolve(here, '../../../plugins/bank/views/sync-textbook/index.vue'), 'utf8')
const page = readFileSync(resolve(here, '../../../plugins/bank/views/sync-textbook/comparison.vue'), 'utf8')

assert.match(api, /export function getMetadataTextbookOverview\(metadataRunId\)/)
assert.match(api, /\/bank\/sync\/metadata\/textbook-overview/)
assert.match(listPage, /<h2>\s*同步教材任务\s*<\/h2>/)
assert.match(listPage, /新增同步教材任务/)
assert.match(listPage, /\/bank\/sync-textbook\//)
assert.match(page, /<h2>\s*\{\{ heading \}\}\s*<\/h2>/)
assert.match(page, /id="fetched-title">本次抓取/)
assert.match(page, /id="current-title">当前数据/)
assert.match(page, />新增<\/el-radio-button>/)
assert.match(page, />已有<\/el-radio-button>/)
assert.match(page, /overview\.sourceAvailable === false/)
assert.match(page, /currentLocalId/)
assert.match(page, /sourceProviderOf\(item\).*externalIdOf\(item\)/s)
assert.match(page, /scrollIntoView\(\{ behavior: 'smooth'/)
assert.match(page, /is-locate-highlight/)
assert.match(page, /@media \(max-width: 980px\)/)
assert.doesNotMatch(page, /v-html/)
assert.doesNotMatch(page, />\s*(?:启用|停用)\s*</)

console.log('sync textbook overview assertions passed')
