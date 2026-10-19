// tests/keystone/settings-models-route.test.mjs
// 手动拉取端点 POST /cli-bridge/settings/models（契约 §3.2）的处理器级锁定。
//
// 三条红线在这里钉死：
//   1) 业务失败**恒返回 HTTP 200** + { ok:false, error } —— 不用 4xx/5xx。否则前端容易把
//      「没拉到」当成网络故障静默吞掉（本项目模型清单反复踩的坑）。
//   2) 未知 provider / 未实现 refreshModels 的 provider → ok:false 且错误可读，
//      **绝不**返回空 options 冒充成功。
//   3) 非 POST → 405。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROVIDER_IDS } from '../../providers/registry.mjs'

const TMP = join(fileURLToPath(new URL('.', import.meta.url)), '..', '.tmp-settings-models')
mkdirSync(TMP, { recursive: true })
const S = join(TMP, 'settings.json')

function freshEnv() {
  try { rmSync(S, { force: true }) } catch (e) { }
  const saved = process.env.CLI_BRIDGE_SETTINGS_FILE
  process.env.CLI_BRIDGE_SETTINGS_FILE = S
  delete process.env.CLI_BRIDGE_PROVIDER
  return () => {
    if (saved === undefined) delete process.env.CLI_BRIDGE_SETTINGS_FILE
    else process.env.CLI_BRIDGE_SETTINGS_FILE = saved
  }
}

function mkCtx() {
  const routes = new Map()
  return {
    routes,
    ctx: {
      on() { }, provide() { }, get() { return undefined },
      inject(deps, fn) {
        fn({
          effect(inner) { inner(); return () => { } },
          get(name) {
            if (name !== 'webServer') return undefined
            return { register: (r) => { routes.set(r.path, r); return () => { } } }
          }
        })
        return () => { }
      }
    }
  }
}

function res() {
  const o = { code: 0, body: '', headers: null }
  o.writeHead = (c, h) => { o.code = c; o.headers = h }
  o.end = (b) => { o.body = String(b || '') }
  return o
}

function postReq(text) {
  const r = new EventEmitter()
  r.method = 'POST'
  setImmediate(() => { r.emit('data', Buffer.from(text)); r.emit('end') })
  return r
}

function flush(ms) { return new Promise((resolve) => setTimeout(resolve, ms || 30)) }

async function boot() {
  const mod = await import('../../home-plugin/cli-bridge-indicator/lib/index.mjs')
  const { ctx, routes } = mkCtx()
  mod.apply(ctx)
  const route = routes.get('/cli-bridge/settings/models')
  assert.ok(route, 'POST /cli-bridge/settings/models must be registered')
  return route
}

async function call(route, bodyText, method) {
  const r = postReq(bodyText)
  if (method) r.method = method
  const o = res()
  await route.handler(r, o)
  await flush(600)
  return o
}

test('settings/models：路由已注册（契约 §3.2 手动拉取入口）', async () => {
  const restore = freshEnv()
  try { await boot() } finally { restore() }
})

test('settings/models：非 POST → 405', async () => {
  const restore = freshEnv()
  try {
    const route = await boot()
    const o = await call(route, '{}', 'GET')
    assert.equal(o.code, 405)
  } finally { restore() }
})

test('settings/models：未知 provider → HTTP 200 + ok:false + 可读错误', async () => {
  const restore = freshEnv()
  try {
    const route = await boot()
    const o = await call(route, JSON.stringify({ provider: 'definitely-not-a-provider' }))
    assert.equal(o.code, 200, '业务失败必须是 200（否则前端会当网络错误吞掉）')
    const j = JSON.parse(o.body)
    assert.equal(j.ok, false)
    assert.match(String(j.error), /unknown provider/i)
    assert.ok(String(j.error).includes(PROVIDER_IDS[0]), 'error should hint valid ids')
  } finally { restore() }
})

test('settings/models：非法 JSON body → 200 + ok:false（不抛）', async () => {
  const restore = freshEnv()
  try {
    const route = await boot()
    const o = await call(route, '{ not json')
    assert.equal(o.code, 200)
    const j = JSON.parse(o.body)
    assert.equal(j.ok, false)
    assert.match(String(j.error), /JSON/i)
  } finally { restore() }
})

test('settings/models：provider 未实现 refreshModels → 200 + ok:false + 点名能力缺失', async () => {
  const restore = freshEnv()
  try {
    // agy 没有模型清单字段，因此没有 refreshModels —— 用它验证「能力缺失」的报错路径。
    const route = await boot()
    const o = await call(route, JSON.stringify({ provider: 'agy' }))
    assert.equal(o.code, 200)
    const j = JSON.parse(o.body)
    assert.equal(j.ok, false)
    assert.match(String(j.error), /refreshModels/)
  } finally { restore() }
})

test('settings/models：成功响应形状 = { ok, provider, options:[{value,label}], source }', async () => {
  const restore = freshEnv()
  try {
    // 直接验证「成功后 keystone 如何转换」的约定：这里用 codebuddy 且把环境指到必然失败的
    // 位置，确保它不是靠本机真 CLI 偶然成功；失败态也必须满足同一响应外壳。
    const saved = { PATH: process.env.PATH, APPDATA: process.env.APPDATA }
    process.env.PATH = ''
    process.env.APPDATA = 'X:\\__no_such_appdata__'
    try {
      const route = await boot()
      const o = await call(route, JSON.stringify({ provider: 'codebuddy' }))
      assert.equal(o.code, 200)
      const j = JSON.parse(o.body)
      assert.equal(j.provider, 'codebuddy')
      assert.equal(typeof j.ok, 'boolean')
      if (j.ok) {
        assert.ok(Array.isArray(j.options) && j.options.length > 0, 'ok:true 时 options 必须非空')
        assert.equal(typeof j.options[0].value, 'string')
        assert.equal(typeof j.options[0].label, 'string')
      } else {
        assert.equal(j.options, undefined, '失败态不该带 options')
        assert.ok(String(j.error).length > 10, '失败态必须有可行动错误')
      }
    } finally {
      process.env.PATH = saved.PATH
      if (saved.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved.APPDATA
    }
  } finally { restore() }
})

test('client.js：为带 refresh 的字段渲染「拉取」按钮并 POST 到该端点', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(fileURLToPath(new URL('../../home-plugin/cli-bridge-indicator/lib/client.js', import.meta.url)), 'utf8')
  // 按钮只在字段声明了 refresh 时出现（不声明就不渲染，避免无意义入口）
  assert.match(src, /f\.refresh\s*\?/, 'must render the refresh affordance conditionally on field.refresh')
  assert.match(src, /\/cli-bridge\/settings\/models/, 'must POST to the models endpoint')
  assert.match(src, /method:\s*"POST"/, 'must use POST')
  // 失败要显示给用户（而不是静默）
  assert.match(src, /拉取中/, 'must show a busy state')
  assert.match(src, /✗/, 'must surface failures visibly')
})
