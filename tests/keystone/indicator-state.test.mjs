// tests/keystone/indicator-state.test.mjs — 统一指示灯状态机（keystone 纯函数）回归。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIndicatorState, PRESET_TTL_MS } from '../../home-plugin/cli-bridge-indicator/lib/index.mjs'

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
  assert.deepEqual(Object.keys(st.snapshot().providers).sort(), ['agy', 'codebuddy', 'mimo'])
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

