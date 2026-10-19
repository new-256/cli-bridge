// tests/keystone/indicator-state.test.mjs — 统一指示灯状态机（keystone 纯函数）回归。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIndicatorState, PRESET_TTL_MS } from '../../home-plugin/cli-bridge-indicator/lib/index.mjs'
import { PROVIDER_IDS } from '../../providers/registry.mjs'

function makeState(opts) {
  let nowMs = 1000
  const st = createIndicatorState(Object.assign({ now: () => nowMs }, opts))
  return { st, tick: (d) => { nowMs += d }, at: () => nowMs }
}

test('buckets isolated per provider', () => {
  const { st } = makeState()
  st.mergeSnapshot('agy', { projects: [{ cwd: 'C:/a', running: 1, state: 'running', updatedAt: 1000 }] })
  st.mergeSnapshot('mimo', { projects: [{ cwd: 'C:/m', running: 1, state: 'running', updatedAt: 1000 }] })
  const s = st.snapshot()
  assert.equal(s.providers.agy.running, 1)
  assert.equal(s.providers.mimo.running, 1)
  assert.equal(s.providers.codebuddy.running, 0)
  assert.equal(s.providers.agy.projects[0].cwd, 'C:/a')
})

test('snapshot accepts flat single-project shape (mimo style)', () => {
  const { st } = makeState()
  st.mergeSnapshot('mimo', { cwd: 'C:/x', name: 'x', running: 2, updatedAt: 1000 })
  const b = st.bucketSnapshot('mimo')
  assert.equal(b.running, 2)
  assert.equal(b.projects.length, 1)
})

test('ACCEPTED counts as success when isSuccessStatus says so', () => {
  const { st } = makeState({ isSuccessStatus: (id, s) => s === 'SUCCESS' || s === 'ACCEPTED' })
  st.mergeSnapshot('mimo', { projects: [{ cwd: 'C:/x', lastStatus: 'ACCEPTED', updatedAt: 1000 }] })
  assert.equal(st.bucketSnapshot('mimo').state, 'ok')
})

test('unknown provider id is ignored, not fatal', () => {
  const { st } = makeState()
  st.mergeSnapshot('nope', { projects: [{ cwd: 'C:/x' }] })
  st.onMode('nope', { active: true })
  // 单一 id 轴（契约 §3.1）：桶清单从注册表派生，禁止硬编码三家。
  assert.deepEqual(Object.keys(st.snapshot().providers).sort(), PROVIDER_IDS.slice().sort())
})

test('mode lease: global fallback when client cannot judge', () => {
  const { st, tick } = makeState()
  st.onMode('codebuddy', { active: true, sessionId: 'sess-1' })
  let b = st.bucketSnapshot('codebuddy')
  assert.equal(b.presetActive, true)
  assert.deepEqual(b.presetSessions, ['sess-1'])
  tick(PRESET_TTL_MS + 1)
  b = st.bucketSnapshot('codebuddy')
  assert.equal(b.presetActive, false)
  assert.deepEqual(b.presetSessions, [])
})

test('deactivating one session keeps others', () => {
  const { st } = makeState()
  st.onMode('agy', { active: true, sessionId: 's1' })
  st.onMode('agy', { active: true, sessionId: 's2' })
  st.onMode('agy', { active: false, sessionId: 's1' })
  const b = st.bucketSnapshot('agy')
  assert.deepEqual(b.presetSessions, ['s2'])
})

test('live enumeration unions with leases', () => {
  const { st } = makeState({ listPresetSessions: (id) => (id === 'agy' ? ['live-1'] : []) })
  st.onMode('agy', { active: true, sessionId: 'leased' })
  const b = st.bucketSnapshot('agy')
  assert.ok(b.presetSessions.includes('live-1'))
  assert.ok(b.presetSessions.includes('leased'))
})

test('stale marker for old idle projects; running never stale', () => {
  const { st, tick } = makeState({ projectTtlMs: 1000 })
  st.mergeSnapshot('agy', { projects: [{ cwd: 'C:/old', lastStatus: 'SUCCESS', updatedAt: 1000 }] })
  st.mergeSnapshot('agy', { projects: [{ cwd: 'C:/run', running: 1, state: 'running', updatedAt: 1000 }] })
  tick(5000)
  const b = st.bucketSnapshot('agy')
  const old = b.projects.find((p) => p.cwd === 'C:/old')
  const run = b.projects.find((p) => p.cwd === 'C:/run')
  assert.equal(old.stale, true)
  assert.equal(run.stale, false)
})

test('mcp bridge file merges into bucket; legacy writtenAt tolerated', () => {
  const { st } = makeState({
    readMcpFile: (id) => (id === 'codebuddy' ? { writtenAt: 999, provider: 'codebuddy', projects: [{ cwd: 'C:/mcp', running: 1, state: 'running' }] } : null)
  })
  const b = st.bucketSnapshot('codebuddy')
  assert.equal(b.running, 1)
  assert.equal(b.projects[0].cwd, 'C:/mcp')
})

test('mcp stale snapshot zeroes running', () => {
  const { st } = makeState({
    staleMs: 100,
    readMcpFile: () => ({ updatedAt: 1, provider: 'agy', projects: [{ cwd: 'C:/m', running: 3, state: 'running' }] })
  })
  const b = st.bucketSnapshot('agy')
  assert.equal(b.running, 0)
  assert.equal(b.projects[0].state, 'idle')
})

test('MRU eviction never evicts running', () => {
  const { st } = makeState()
  st.mergeSnapshot('agy', { projects: [{ cwd: 'C:/busy', running: 1, state: 'running', updatedAt: 1 }] })
  for (let i = 0; i < 30; i++) st.mergeSnapshot('agy', { projects: [{ cwd: 'C:/p' + i, updatedAt: 2 }] })
  const b = st.bucketSnapshot('agy')
  assert.ok(b.projects.some((p) => p.cwd === 'C:/busy'))
})

// 0.2.1 修复「指示灯长期存在」服务端半边：陈旧历史项目不参与顶层聚合。
test('stale projects do not drive aggregate state (falls back to idle)', () => {
  const { st, tick } = makeState({ projectTtlMs: 1000 })
  st.mergeSnapshot('agy', { projects: [{ cwd: 'C:/old', lastStatus: 'ERROR', updatedAt: 1000 }] })
  assert.equal(st.bucketSnapshot('agy').state, 'failed')
  tick(5000) // 越过 TTL → stale
  const b = st.bucketSnapshot('agy')
  assert.equal(b.projects[0].stale, true)
  assert.equal(b.state, 'idle', 'stale failed history must not keep the light red forever')
  assert.equal(b.lastStatus, null)
  assert.equal(b.fallbackActive, false)
})

test('stale history does not shadow a fresh project', () => {
  const { st, tick } = makeState({ projectTtlMs: 1000 })
  st.mergeSnapshot('agy', { projects: [{ cwd: 'C:/old', lastStatus: 'ERROR', updatedAt: 1000 }] })
  tick(5000)
  st.mergeSnapshot('agy', { projects: [{ cwd: 'C:/new', lastStatus: 'SUCCESS', updatedAt: 6000 }] })
  const b = st.bucketSnapshot('agy')
  assert.equal(b.state, 'ok', 'fresh last top-level wins over stale failed one')
  assert.equal(b.projects.length, 2, 'stale kept in list (popup history) but not aggregated')
})

test('running project is never stale and still aggregates', () => {
  const { st, tick } = makeState({ projectTtlMs: 1000 })
  st.mergeSnapshot('agy', { projects: [{ cwd: 'C:/run', running: 1, state: 'running', updatedAt: 1000 }] })
  tick(5000)
  const b = st.bucketSnapshot('agy')
  assert.equal(b.projects[0].stale, false)
  assert.equal(b.state, 'running')
})

// ── 完成后快速淡出（0.2.4）：已收口项目走更短的新鲜期 ──────────────────────────
// 动机：单一 10 分钟 TTL 下，任务跑完灯要挂满 10 分钟才消失，用户感知是「灯不灭」。
// 区分两态：有终态(lastStatus) → doneTtlMs；无终态 → projectTtlMs（防抖）。
test('已收口项目按 doneTtlMs 淡出：短 TTL 内即 stale，未收口的仍按长 TTL 保留', () => {
  // 长 TTL 5s、已收口 TTL 500ms：两者都不显式跟随 projectTtlMs。
  const { st, tick } = makeState({ projectTtlMs: 5000, doneTtlMs: 500 })
  st.mergeSnapshot('agy', { projects: [
    { cwd: 'C:/done', running: 0, lastStatus: 'SUCCESS', updatedAt: 1000 },
    { cwd: 'C:/pending', running: 0, updatedAt: 1000 }
  ] })
  tick(1000) // 越过 doneTtlMs(500)，未越 projectTtlMs(5000)
  const b = st.bucketSnapshot('agy')
  const done = b.projects.find((p) => p.cwd === 'C:/done')
  const pending = b.projects.find((p) => p.cwd === 'C:/pending')
  assert.equal(done.stale, true, '已完成项目应在短 TTL 后淡出')
  assert.equal(pending.stale, false, '无终态项目仍按长 TTL 防抖，不该被提前判 stale')
})

test('doneTtlMs 缺省跟随显式传入的 projectTtlMs（传短 TTL 必须真的生效）', () => {
  // 只传 projectTtlMs=1000：doneTtlMs 应同为 1000，而不是回落到生产的 60s 默认值
  // （否则「传了短 TTL 却不生效」会静默坑人 —— 本改动第一版就踩了这个坑）。
  const { st, tick } = makeState({ projectTtlMs: 1000 })
  st.mergeSnapshot('agy', { projects: [{ cwd: 'C:/old', lastStatus: 'ERROR', updatedAt: 1000 }] })
  tick(2000)
  const b = st.bucketSnapshot('agy')
  assert.equal(b.projects[0].stale, true, 'explicit projectTtlMs must also govern done projects')
  assert.equal(b.state, 'idle')
})

test('生产默认值：已完成 TTL = 10s（用户要求「跑完后 10 秒内消失」）', async () => {
  const mod = await import('../../home-plugin/cli-bridge-indicator/lib/index.mjs')
  assert.ok(mod.PROJECT_DONE_TTL_MS < mod.PROJECT_TTL_MS, 'done TTL must be shorter than in-flight TTL')
  // 用户明确要求：常规会话里任务跑完，灯 10 秒内消失。钉死这个值，防止被改回去
  // （改大就又变成「灯不灭」，改小则刚跑完就闪没，用户来不及看到结果）。
  assert.equal(mod.PROJECT_DONE_TTL_MS, 10 * 1000)
  // 运行中仍走 10 分钟防抖：短暂停顿不该让灯闪。
  assert.equal(mod.PROJECT_TTL_MS, 10 * 60 * 1000)
  // 第二层 stale 过滤（MCP 上报规范化）不得比它更早切掉数据，否则 10s 无从体现。
  const kit = await import('../../core/bridge-kit.mjs')
  assert.ok(kit.MCP_BRIDGE_STALE_MS > mod.PROJECT_DONE_TTL_MS, 'MCP stale 窗口必须宽于完成态 TTL')
})

test('淡出只影响聚合/渲染，项目仍在列表里（弹窗历史不丢）', () => {
  const { st, tick } = makeState({ projectTtlMs: 1000 })
  st.mergeSnapshot('mimo', { projects: [{ cwd: 'C:/done', running: 0, lastStatus: 'ACCEPTED', updatedAt: 1000 }] })
  tick(5000)
  const b = st.bucketSnapshot('mimo')
  assert.equal(b.projects.length, 1, 'stale 项目保留在列表（弹窗历史）')
  assert.equal(b.projects[0].stale, true)
  assert.equal(b.state, 'idle', '但不再驱动顶层灯色')
})

