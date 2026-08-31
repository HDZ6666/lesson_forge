import assert from 'node:assert/strict'

import { resolvePluginViewPath } from '../../../src/utils/pluginViewResolver.js'

assert.equal(resolvePluginViewPath('plugin/bank/textbook/index'), '../../../plugins/bank/views/textbook/index.vue')
assert.equal(resolvePluginViewPath('plugin/bank/version/index'), '../../../plugins/bank/views/version/index.vue')
assert.equal(resolvePluginViewPath('plugin/bank/catalog/index'), '../../../plugins/bank/views/catalog/index.vue')
assert.equal(resolvePluginViewPath('plugin/bank/question-manage/index'), '../../../plugins/bank/views/question-manage/index.vue')
assert.equal(resolvePluginViewPath('plugin/bank/browse/index'), '../../../plugins/bank/views/browse/index.vue')
assert.equal(resolvePluginViewPath('plugin/bank/question/index'), '../../../plugins/bank/views/question/index.vue')
assert.equal(resolvePluginViewPath('plugin/bank/batch/index'), '../../../plugins/bank/views/batch/index.vue')
assert.equal(resolvePluginViewPath('plugin/bank/sync/index'), '../../../plugins/bank/views/sync/index.vue')
assert.equal(resolvePluginViewPath('plugin/bank/sync-textbook/index'), '../../../plugins/bank/views/sync-textbook/index.vue')
assert.equal(resolvePluginViewPath('plugin/bank/sync-question/index'), '../../../plugins/bank/views/sync-question/index.vue')
assert.equal(resolvePluginViewPath('plugin/bank/sync-question/detail'), '../../../plugins/bank/views/sync-question/detail.vue')
assert.equal(resolvePluginViewPath('plugin/bank/sync/version/index'), '../../../plugins/bank/views/sync/version/index.vue')
assert.equal(resolvePluginViewPath('plugin/bank/sync/textbook/index'), '../../../plugins/bank/views/sync/textbook/index.vue')
assert.equal(resolvePluginViewPath('plugin/bank/sync/catalog/index'), '../../../plugins/bank/views/sync/catalog/index.vue')
assert.equal(resolvePluginViewPath('plugin/bank/sync/question/index'), '../../../plugins/bank/views/sync/question/index.vue')
assert.equal(resolvePluginViewPath('bank/question/index'), '')
assert.equal(resolvePluginViewPath('plugin/Bank/question/index'), '')
assert.equal(resolvePluginViewPath('plugin/bank/question/index.vue'), '')
