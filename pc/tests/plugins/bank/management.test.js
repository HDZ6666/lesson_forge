import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const views = resolve(here, '../../../plugins/bank/views')
const readView = (name) => readFileSync(resolve(views, name, 'index.vue'), 'utf8')

for (const name of ['version', 'textbook', 'catalog', 'question-manage']) {
  assert.match(readView(name), /includeDisabled:\s*true/, `${name} management must request disabled rows`)
}

const browse = readView('browse')
assert.match(browse, />全部目录</)
assert.match(browse, /query\.catalogId = undefined/)
assert.doesNotMatch(browse, /按教材目录浏览和筛选题目/)
