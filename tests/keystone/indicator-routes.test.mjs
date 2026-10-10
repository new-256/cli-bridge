// tests/keystone/indicator-routes.test.mjs
// 家级灯 apply() 注册的 HTTP 路由面（四形态之②的处理器级锁定）：
//   GET /cli-bridge/settings → scheduling 视图；POST _scheduling → 落盘 + 回读；
//   GET /cli-bridge/status → 每次现读附 scheduling（改完即见，不重启）。
// mock 宿主只提供 webServer.register + 事件通道 no-op；设置文件走 CLI_BRIDGE_SETTINGS_FILE tmp。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = join(fileURLToPath(new URL('.', import.meta.url)), '..', '.tmp-indicator-routes')
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
  const ctx = {
    on() { }, provide() { }, get() { return undefined },
    inject(deps, fn) {
      const child = {
        effect(inner) { inner(); return () => { } },
        get(name) {
          if (name !== 'webServer') return undefined
          return { register: (r) => { routes.set(r.path, r); return () => { } } }
        }
      }
      fn(child)
      return () => { }
    }
  }
  return { ctx, routes }
}

async function load() {
  return import('../../home-plugin/cli-bridge-indicator/lib/index.mjs')
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

// POST 处理器内部走 readBody promise（data/end 在 setImmediate 发出，再 .then 写响应），
// 断言前必须等一个宏任务 + 微任务链。
function flush() { return new Promise((resolve) => setTimeout(resolve, 20)) }

test('routes: apply() 注册四路由', async () => {
  const restore = freshEnv()
  try {
    const mod = await load()
    const { ctx, routes } = mkCtx()
    mod.apply(ctx)
    assert.ok(routes.has('/cli-bridge/status'), 'status 路由')
    assert.ok(routes.has('/cli-bridge/settings'), 'settings 路由')
    assert.ok(routes.has('/agy-indicator/quota'), 'quota 路由')
    for (const id of ['agy', 'codebuddy', 'mimo']) assert.ok(routes.has('/' + id + '-indicator/status'), '旧路由 ' + id)
  } finally { restore() }
})

test('routes: GET settings 视图含 scheduling（默认全开）', async () => {
  const restore = freshEnv()
  try {
    const mod = await load()
    const { ctx, routes } = mkCtx()
    mod.apply(ctx)
    const r = res()
    await routes.get('/cli-bridge/settings').handler({ method: 'GET' }, r)
    assert.equal(r.code, 200)
    const j = JSON.parse(r.body)
    assert.ok(j.scheduling && j.scheduling.enabled.length === 3 && j.scheduling.order.length === 3, '缺省全开视图')
    assert.ok(j.scheduling.labels.agy, 'labels 齐')
  } finally { restore() }
})

test('routes: POST _scheduling → 落盘 → status 输出即时反映（②面端到端）', async () => {
  const restore = freshEnv()
  try {
    const mod = await load()
    const { ctx, routes } = mkCtx()
    mod.apply(ctx)
    // POST 关 mimo + 重排 priority
    const p = res()
    await routes.get('/cli-bridge/settings').handler(postReq(JSON.stringify({ _scheduling: { enabled: ['codebuddy', 'agy'], priority: ['codebuddy', 'agy', 'mimo'] } })), p)
    await flush()
    assert.equal(p.code, 200, 'POST ok: ' + p.body.slice(0, 200))
    const j = JSON.parse(p.body)
    assert.ok(j.ok && j.settings && j.settings.scheduling.enabled.indexOf('mimo') < 0)
    // 文件真落盘且带 _scheduling 区
    const raw = JSON.parse(readFileSync(S, 'utf8'))
    assert.ok(raw._scheduling && raw._scheduling.enabled.indexOf('mimo') < 0, '文件含 _scheduling')
    // GET status（②面）现读 → scheduling 即时可见，无需任何重启
    const s = res()
    await routes.get('/cli-bridge/status').handler({ method: 'GET' }, s)
    const sj = JSON.parse(s.body)
    assert.ok(sj.scheduling, 'status 附 scheduling')
    assert.equal(sj.scheduling.order.join(','), 'codebuddy,agy', 'order=priority∩enabled')
    assert.ok(sj.scheduling.all.length === 3 && sj.scheduling.labels.mimo)
    // 非法 POST 走 400
    const bad = res()
    await routes.get('/cli-bridge/settings').handler(postReq(JSON.stringify({ _scheduling: { enabled: 'nope' } })), bad)
    await flush()
    assert.equal(bad.code, 400)
    // provider-only POST（旧客户端形态）不动调度
    const keep = res()
    await routes.get('/cli-bridge/settings').handler(postReq(JSON.stringify({ agy: { cwd: 'X:\\keep' } })), keep)
    await flush()
    const kj = JSON.parse(keep.body)
    assert.ok(kj.settings.scheduling.enabled.indexOf('mimo') < 0, '保留 _scheduling')
  } finally { restore() }
})

test('routes: status 路由本体在 scheduling 读取失败时仍 200（不影响灯）', async () => {
  const restore = freshEnv()
  try {
    writeFileSync(S, '{ broken', 'utf8') // 坏文件 = fail-open 全开，不抛
    const mod = await load()
    const { ctx, routes } = mkCtx()
    mod.apply(ctx)
    const s = res()
    await routes.get('/cli-bridge/status').handler({ method: 'GET' }, s)
    assert.equal(s.code, 200)
    const sj = JSON.parse(s.body)
    assert.ok(sj.scheduling && sj.scheduling.enabled.length === 3, '坏文件 = 缺省全开')
  } finally { restore(); try { rmSync(TMP, { recursive: true, force: true }) } catch (e) { } }
})
