// tests/core/scheduling.test.mjs — 调度单源（core/scheduling.mjs）纯逻辑 + 读盘红线。
// 锁死语义：缺省全开、fail-open、enabled 过滤、priority ∩ enabled = order、钉住优先、
// ignorePin 让宿主形态不受全局 env 反噬。
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  SCHEDULING_SECTION, normalizeScheduling, defaultPriority, describeScheduling,
  resolveScheduling, isBridgeEnabled, schedulingSettingsPath
} from '../../core/scheduling.mjs'

const IDS = ['agy', 'codebuddy', 'mimo']

test('defaultPriority = 注册表顺序副本（不可变入参）', () => {
  const src = IDS.slice()
  const d = defaultPriority(src)
  assert.deepEqual(d, src)
  d.push('x')
  assert.equal(src.length, 3)
})

test('normalizeScheduling: 缺省/坏值 → 全开 + 注册表顺序（fail-open 根）', () => {
  for (const bad of [null, undefined, 0, '', [], {}, 'x', { enabled: 'no' }, { enabled: [1, 2, null] }, { priority: {} }]) {
    const s = normalizeScheduling(bad, IDS)
    assert.deepEqual(s.enabled, IDS, 'enabled all for ' + JSON.stringify(bad))
    assert.deepEqual(s.order, IDS, 'order default for ' + JSON.stringify(bad))
  }
})

test('normalizeScheduling: enabled 过滤未知 id + 去重；空数组保留「全关」语义', () => {
  const s = normalizeScheduling({ enabled: ['mimo', 'mimo', 'nope', 'agy'] }, IDS)
  assert.deepEqual(s.enabled, ['mimo', 'agy'])
  const empty = normalizeScheduling({ enabled: [] }, IDS)
  assert.deepEqual(empty.enabled, [], 'explicit empty array is respected (not back to all)')
  assert.deepEqual(empty.order, [])
})

test('normalizeScheduling: priority 漏写的补末尾；order = priority ∩ enabled', () => {
  const s = normalizeScheduling({ enabled: ['agy', 'mimo'], priority: ['mimo'] }, IDS)
  assert.deepEqual(s.priority, ['mimo', 'agy', 'codebuddy'], 'missing ids appended in registry order')
  assert.deepEqual(s.order, ['mimo', 'agy'], 'order excludes disabled codebuddy')
})

test('normalizeScheduling: enabled 有而 priority 未覆盖的 id 仍进 order 末尾', () => {
  const s = normalizeScheduling({ enabled: ['codebuddy', 'agy'], priority: ['agy'] }, IDS)
  assert.deepEqual(s.order, ['agy', 'codebuddy'])
})

test('describeScheduling: 文本渲染', () => {
  const s = normalizeScheduling({ enabled: ['mimo', 'agy'], priority: ['mimo', 'agy'] }, IDS)
  assert.equal(describeScheduling(s, (id) => id.toUpperCase()), 'MIMO → AGY')
  assert.equal(describeScheduling({ order: [] }), '（全部禁用）')
})

// ── 读盘 ─────────────────────────────────────────────────────────────────────
function fakeFs(map) {
  return (p) => { if (Object.prototype.hasOwnProperty.call(map, p)) return map[p]; throw new Error('ENOENT ' + p) }
}

test('schedulingSettingsPath: env 覆盖 > DSH_HOME/文件', () => {
  assert.equal(schedulingSettingsPath({ CLI_BRIDGE_SETTINGS_FILE: 'X:/custom.json' }), 'X:/custom.json')
  assert.ok(String(schedulingSettingsPath({ DSH_HOME: 'X:/home' })).replace(/\\/g, '/').endsWith('/home/cli-bridge-settings.json'))
  assert.equal(schedulingSettingsPath({}), null)
})

test('resolveScheduling: 文件缺失 → source=default 全开（fail-open）', () => {
  const s = resolveScheduling(IDS, { env: {}, readFileSync: fakeFs({}), path: 'X:/nope.json' })
  assert.equal(s.source, 'default')
  assert.deepEqual(s.enabled, IDS)
})

test('resolveScheduling: 文件 _scheduling 生效；source=file', () => {
  const body = JSON.stringify({ agy: {}, _scheduling: { enabled: ['codebuddy'], priority: ['codebuddy', 'agy'] } })
  const s = resolveScheduling(IDS, { env: {}, readFileSync: fakeFs({ 'X:/s.json': body }), path: 'X:/s.json' })
  assert.equal(s.source, 'file')
  assert.deepEqual(s.enabled, ['codebuddy'])
  assert.deepEqual(s.order, ['codebuddy'])
  assert.deepEqual(s.priority, ['codebuddy', 'agy', 'mimo'])
})

test('resolveScheduling: JSON 损坏 = 全开（绝不炸、绝不全关）', () => {
  const s = resolveScheduling(IDS, { env: {}, readFileSync: fakeFs({ 'X:/s.json': '{oops' }), path: 'X:/s.json' })
  assert.equal(s.source, 'default')
  assert.deepEqual(s.enabled, IDS)
})

test('resolveScheduling: 钉住最高优先（MCP 薄封装语义）', () => {
  const body = JSON.stringify({ _scheduling: { enabled: ['agy', 'mimo'] } })
  const s = resolveScheduling(IDS, { env: { CLI_BRIDGE_PROVIDER: 'codebuddy' }, readFileSync: fakeFs({ 'X:/s.json': body }), path: 'X:/s.json' })
  assert.equal(s.pinned, 'codebuddy')
  assert.deepEqual(s.enabled, ['codebuddy'])
  assert.match(s.source, /env:CLI_BRIDGE_PROVIDER/)
})

test('resolveScheduling: ignorePin 让宿主形态不受全局钉住影响', () => {
  const body = JSON.stringify({ _scheduling: { enabled: ['agy', 'mimo'], priority: ['mimo', 'agy'] } })
  const s = resolveScheduling(IDS, { env: { CLI_BRIDGE_PROVIDER: 'codebuddy' }, ignorePin: true, readFileSync: fakeFs({ 'X:/s.json': body }), path: 'X:/s.json' })
  assert.equal(s.pinned, '')
  assert.deepEqual(s.enabled, ['agy', 'mimo'])
  assert.deepEqual(s.order, ['mimo', 'agy'])
})

test('resolveScheduling: 钉住未知 id 被忽略（不报错、按文件）', () => {
  const s = resolveScheduling(IDS, { env: { CLI_BRIDGE_PROVIDER: 'nope' }, readFileSync: fakeFs({}), path: 'X:/nope.json' })
  assert.equal(s.pinned, '')
  assert.deepEqual(s.enabled, IDS)
})

// ── apply() 门禁 helper ─────────────────────────────────────────────────────
test('isBridgeEnabled: 无文件 → true（全开）', () => {
  assert.equal(isBridgeEnabled('agy', IDS, { readFileSync: fakeFs({}), path: 'X:/nope.json' }), true)
})

test('isBridgeEnabled: 禁用面 false；启用面 true', () => {
  const body = JSON.stringify({ _scheduling: { enabled: ['agy'] } })
  const io = { readFileSync: fakeFs({ 'X:/s.json': body }), path: 'X:/s.json' }
  assert.equal(isBridgeEnabled('agy', IDS, io), true)
  assert.equal(isBridgeEnabled('mimo', IDS, io), false)
})

test('isBridgeEnabled: 全关 → 三面都 false（用户显式意图）', () => {
  const body = JSON.stringify({ _scheduling: { enabled: [] } })
  const io = { readFileSync: fakeFs({ 'X:/s.json': body }), path: 'X:/s.json' }
  for (const id of IDS) assert.equal(isBridgeEnabled(id, IDS, io), false)
})

test('isBridgeEnabled: fail-open —— ids 不可得 / 抛错 / 不含自己 一律 true', () => {
  assert.equal(isBridgeEnabled('agy', [], {}), true)
  assert.equal(isBridgeEnabled('agy', undefined, {}), true)
  assert.equal(isBridgeEnabled('nope', IDS, {}), true)
  assert.equal(isBridgeEnabled('agy', IDS, { readFileSync: () => { throw new Error('boom') }, path: 'X:/s.json' }), true)
})

test('isBridgeEnabled: 忽略全局钉住（ignorePin 内置），宿主会话不被 MCP env 关掉', () => {
  const body = JSON.stringify({ _scheduling: { enabled: ['agy', 'codebuddy', 'mimo'] } })
  const io = { env: { CLI_BRIDGE_PROVIDER: 'agy' }, readFileSync: fakeFs({ 'X:/s.json': body }), path: 'X:/s.json' }
  assert.equal(isBridgeEnabled('mimo', IDS, io), true)
})
