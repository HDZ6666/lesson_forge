import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { parse } from '@babel/parser'
import { parse as parseSfc } from '@vue/compiler-sfc'

// The deploy command must load the tracked public API prefix and page title.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
const mode = pkg.scripts['build:docker'].match(/--mode (\S+)/)?.[1] || 'production'
const env = loadEnv(mode, root)
assert.equal(env.VITE_APP_BASE_API, '/prod-api')
assert.ok(env.VITE_APP_TITLE)

const page = readFileSync(new URL('../../../src/views/login.vue', import.meta.url), 'utf8')
const script = parseSfc(page).descriptor.scriptSetup.content
const functions = parse(script, { sourceType: 'module' }).program.body
  .filter(node => node.type === 'FunctionDeclaration' && ['getCode', 'handleCaptchaImageError'].includes(node.id.name))
const pending = []
const state = {
  captchaLoading: { value: false }, captchaError: { value: '' },
  captchaEnabled: { value: true }, register: { value: false }, codeUrl: { value: '' },
  loginForm: { value: { code: 'old', uuid: 'old' } },
  getCodeImg: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
}
runInNewContext(functions.map(node => script.slice(node.start, node.end)).join('\n'), state)

// An HTML fallback previously became data:image/png;base64,undefined.
const first = state.getCode()
assert.equal(state.captchaLoading.value, true)
await state.getCode()
assert.equal(pending.length, 1)
pending[0].resolve('<!DOCTYPE html><html>SPA fallback</html>')
await first
assert.equal(state.codeUrl.value, '')
assert.equal(state.loginForm.value.uuid, '')
assert.match(state.captchaError.value, /接口返回异常/)
assert.equal(state.captchaLoading.value, false)

// The same control recovers after a temporary request failure.
const second = state.getCode()
pending[1].reject(new Error('timeout of 20000ms exceeded'))
await second
assert.match(state.captchaError.value, /timeout/)
const third = state.getCode()
pending[2].resolve({ captchaEnabled: true, img: 'test-png', uuid: 'new-uuid' })
await third
assert.equal(state.codeUrl.value, 'data:image/png;base64,test-png')
assert.equal(state.loginForm.value.uuid, 'new-uuid')
assert.equal(state.loginForm.value.code, '')
assert.equal(state.captchaError.value, '')
state.handleCaptchaImageError()
assert.equal(state.codeUrl.value, '')
assert.equal(state.loginForm.value.uuid, '')
assert.match(state.captchaError.value, /图片加载失败/)

// Honor the server's explicit switch without changing authentication settings.
const fourth = state.getCode()
pending[3].resolve({ captchaEnabled: false })
await fourth
assert.equal(state.captchaEnabled.value, false)
assert.equal(state.captchaError.value, '')
assert.match(page, /加载失败，点击重试/)
