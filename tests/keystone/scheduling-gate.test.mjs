// tests/keystone/scheduling-gate.test.mjs — 调度门禁的「行为」红线（0.2.0）。
//
// 单源逻辑（core/scheduling.mjs）由 tests/core/scheduling.test.mjs 覆盖；这里锁的是
// 四形态里最关键的两件事：
//   1) 桥接插件 apply()：禁用面 → 零注册（工具 / 政策段 / 心跳 / 事件全都不出现），
//      启用面 → 正常注册；文件缺失/坏值 → 一律正常注册（fail-open）。
//   2) declareBridgePresets：三个 preset 恒常注册（禁用 ≠ 消失），注册【顺序】= priority。
// 纪律：每个用例显式钉 CLI_BRIDGE_SETTINGS_FILE 到临时文件，绝不读本机真实 DSH_HOME。
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply as applyAgy } from '../../preset/agy-first/cli-bridge.mjs'
import { apply as applyCodebuddy } from '../../preset/codebuddy-first/cli-bridge.mjs'
import { apply as applyMimo } from '../../preset/mimo-first/cli-bridge.mjs'
import { apply as applyOpencode } from '../../preset/opencode-first/cli-bridge.mjs'
import { declareBridgePresets } from '../../home-plugin/cli-bridge-indicator/lib/preset-declarations.mjs'
import { PROVIDER_IDS, providerMeta } from '../../providers/registry.mjs'

// 单一 id 轴（契约 §3.1）：id 清单与 apply 映射都从注册表派生，禁止硬编码三家。
const IDS = PROVIDER_IDS.slice()
const SELF = { agy: applyAgy, codebuddy: applyCodebuddy, mimo: applyMimo, opencode: applyOpencode }
/** provider id → preset id（从描述符派生，避免第二处硬编码）。 */
const PRESET_OF = Object.create(null)
for (const id of IDS) PRESET_OF[id] = providerMeta(id).presetId

function mkCtx() {
  const registered = [], sections = [], events = [], timers = []
  const ctx = {
    session: { id: 'sess-gate-1' },
    get() { return null },
    emit(ch, payload) { events.push({ ch, payload }) },
    effect(fn) { try { fn() } catch (e) { } return () => { } },
    setInterval(fn, ms) { timers.push({ fn, ms }); return () => { } },
    timeout() { return () => { } },
    interval() { return () => { } },
    tools: { register(def) { registered.push(def); return () => { } } },
    systemPrompt: { section(s) { sections.push(s); return () => { } } },
    subprocess: { resolveExecutable: async () => 'x.exe', spawn() { return { collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } }, done: Promise.resolve({ exitCode: 0 }), terminate() { } } } }
  }
  return { ctx, registered, sections, events, timers }
}

let seq = 0
function settingsFileWith(obj) {
  const dir = join(tmpdir(), 'clbgate-' + process.pid + '-' + ++seq)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'cli-bridge-settings.json')
  if (obj === null) rmSync(p, { force: true })
  else writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8')
  return p
}

function withScheduling(value, fn) {
  const prev = { file: process.env.CLI_BRIDGE_SETTINGS_FILE, pin: process.env.CLI_BRIDGE_PROVIDER, home: process.env.DSH_HOME }
  process.env.DSH_HOME = 'X:\\__never_used__'
  if (value === undefined) delete process.env.CLI_BRIDGE_SETTINGS_FILE
  else process.env.CLI_BRIDGE_SETTINGS_FILE = value
  delete process.env.CLI_BRIDGE_PROVIDER
  try { return fn() } finally {
    for (const k of ['file', 'pin', 'home']) {
      const v = prev[k]
      const name = k === 'file' ? 'CLI_BRIDGE_SETTINGS_FILE' : k === 'pin' ? 'CLI_BRIDGE_PROVIDER' : 'DSH_HOME'
      if (v === undefined) delete process.env[name]; else process.env[name] = v
    }
  }
}

test('禁用面 apply() 零注册：三面各自独立生效', () => {
  const p = settingsFileWith({ _scheduling: { enabled: ['agy'], priority: IDS } })
  for (const id of IDS) {
    const m = mkCtx()
    withScheduling(p, () => SELF[id](m.ctx, {}))
    if (id === 'agy') {
      assert.ok(m.registered.length > 0, 'enabled agy registers tools')
      assert.equal(m.sections.length, 1, 'enabled agy mounts policy section')
    } else {
      assert.equal(m.registered.length, 0, 'disabled ' + id + ' registers no tool')
      assert.equal(m.sections.length, 0, 'disabled ' + id + ' mounts no policy section')
      assert.equal(m.events.length, 0, 'disabled ' + id + ' publishes no heartbeat/status event')
      assert.equal(m.timers.length, 0, 'disabled ' + id + ' sets no timer')
    }
  }
})

test('启用面照常注册（enabled 含自己）', () => {
  const p = settingsFileWith({ _scheduling: { enabled: ['codebuddy', 'mimo'], priority: ['mimo', 'codebuddy', 'agy'] } })
  for (const id of ['codebuddy', 'mimo']) {
    const m = mkCtx()
    withScheduling(p, () => SELF[id](m.ctx, {}))
    assert.ok(m.registered.length >= 3, id + ' still registers its tool set')
    assert.equal(m.sections.length, 1, id + ' mounts its policy section')
  }
  const m = mkCtx()
  withScheduling(p, () => SELF.agy(m.ctx))
  assert.equal(m.registered.length, 0, 'agy excluded by enabled list')
})

test('全关 = 三面都零注册（用户显式意图被尊重）', () => {
  const p = settingsFileWith({ _scheduling: { enabled: [] } })
  for (const id of IDS) {
    const m = mkCtx()
    withScheduling(p, () => SELF[id](m.ctx, {}))
    assert.equal(m.registered.length, 0, id + ' off')
    assert.equal(m.sections.length, 0, id + ' no policy')
  }
})

test('fail-open：无文件路径 / 文件不存在 / JSON 损坏 → 三面照常注册', () => {
  const cases = {
    'no env var': undefined,
    'missing file': join(tmpdir(), 'clbgate-does-not-exist-' + process.pid + '.json'),
    'broken json': settingsFileWith('{oops'),
    'wrong type': settingsFileWith({ _scheduling: { enabled: 'nope' } }),
    'unknown ids only': settingsFileWith({ _scheduling: { enabled: ['ghost'] } })
  }
  for (const [label, v] of Object.entries(cases)) {
    for (const id of IDS) {
      const m = mkCtx()
      withScheduling(v, () => SELF[id](m.ctx, {}))
      assert.ok(m.registered.length >= 3, label + ' → ' + id + ' must stay enabled (fail-open)')
    }
  }
})

test('全局 env 钉住不会把宿主会话的其它桥关掉（ignorePin）', () => {
  const prevPin = process.env.CLI_BRIDGE_PROVIDER
  const p = settingsFileWith({ _scheduling: { enabled: IDS } })
  const prevFile = process.env.CLI_BRIDGE_SETTINGS_FILE
  const prevHome = process.env.DSH_HOME
  process.env.CLI_BRIDGE_SETTINGS_FILE = p
  process.env.CLI_BRIDGE_PROVIDER = 'agy'
  process.env.DSH_HOME = 'X:\\__never_used__'
  try {
    for (const id of IDS) {
      const m = mkCtx()
      SELF[id](m.ctx, {})
      assert.ok(m.registered.length >= 3, id + ' unaffected by CLI_BRIDGE_PROVIDER pin')
    }
  } finally {
    if (prevPin === undefined) delete process.env.CLI_BRIDGE_PROVIDER; else process.env.CLI_BRIDGE_PROVIDER = prevPin
    if (prevFile === undefined) delete process.env.CLI_BRIDGE_SETTINGS_FILE; else process.env.CLI_BRIDGE_SETTINGS_FILE = prevFile
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome
  }
})

// ── declareBridgePresets：恒常注册 + priority 顺序 ───────────────────────────
function mkInjectCtx() {
  const order = []
  return {
    ctx: {
      inject(deps, fn) { order.push('wait'); return () => { } },
      _seen: order
    },
    order
  }
}

function captureOrder(io) {
  const seen = []
  const ctx = {
    inject(deps, fn) {
      seen.push({ deps })
      const child = {
        effect(inner) { inner(); return () => { } },
        agentPresets: { register: async (def) => { seen.push(def.id); return () => { } } },
        logger: { warn() { } }
      }
      fn(child)
      return () => { }
    }
  }
  const out = declareBridgePresets(ctx, io === undefined ? {} : { io })
  // buildPresetDefinition 是 async（运行时 import plugin-list）→ 排空微任务再断言。
  return { seen, out, flush: () => new Promise((r) => setTimeout(r, 50)) }
}

test('declareBridgePresets：缺省 = 注册表顺序注册全部 preset', async () => {
  const prevFile = process.env.CLI_BRIDGE_SETTINGS_FILE
  const prevPin = process.env.CLI_BRIDGE_PROVIDER
  process.env.CLI_BRIDGE_SETTINGS_FILE = join(tmpdir(), 'clbgate-none-' + process.pid + '.json')
  delete process.env.CLI_BRIDGE_PROVIDER
  try {
    const c = captureOrder({ env: process.env, readFileSync: () => { throw new Error('ENOENT') }, path: null })
    await c.flush()
    const ids = c.seen.filter((x) => typeof x === 'string').map((x) => x)
    // 期望 = 注册表顺序的 preset id 序列（从描述符派生，新增 provider 零改动）。
    assert.deepEqual(ids, IDS.map((id) => PRESET_OF[id]), 'all providers registered in registry order')
  } finally {
    if (prevFile === undefined) delete process.env.CLI_BRIDGE_SETTINGS_FILE; else process.env.CLI_BRIDGE_SETTINGS_FILE = prevFile
    if (prevPin === undefined) delete process.env.CLI_BRIDGE_PROVIDER; else process.env.CLI_BRIDGE_PROVIDER = prevPin
  }
})

// 0.2.5 行为变更（用户定案）：预设只注册**启用面**。
// 停用的 CLI 不该在预设列表里占位 —— 选中它等于立刻撞上一个零注册的桥，纯噪音。
test('declareBridgePresets：只注册启用的 provider，禁用面不进预设目录', async () => {
  const p = settingsFileWith({ _scheduling: { enabled: ['codebuddy'], priority: ['codebuddy', 'mimo', 'agy'] } })
  const prevFile = process.env.CLI_BRIDGE_SETTINGS_FILE
  process.env.CLI_BRIDGE_SETTINGS_FILE = p
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = 'X:\\__never_used__'
  let c
  try { c = captureOrder(undefined) } finally {
    if (prevFile === undefined) delete process.env.CLI_BRIDGE_SETTINGS_FILE; else process.env.CLI_BRIDGE_SETTINGS_FILE = prevFile
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome
  }
  await c.flush()
  const ids = c.seen.filter((x) => typeof x === 'string')
  // 只启用 codebuddy → 只有 codebuddy-first 被注册；mimo/agy/opencode 均不出现。
  assert.deepEqual(ids, [PRESET_OF.codebuddy], 'only enabled providers register their preset')
})

test('declareBridgePresets：多面启用时按 priority 顺序注册', async () => {
  const p = settingsFileWith({ _scheduling: { enabled: ['agy', 'mimo'], priority: ['mimo', 'agy', 'codebuddy'] } })
  const prevFile = process.env.CLI_BRIDGE_SETTINGS_FILE
  process.env.CLI_BRIDGE_SETTINGS_FILE = p
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = 'X:\\__never_used__'
  let c
  try { c = captureOrder(undefined) } finally {
    if (prevFile === undefined) delete process.env.CLI_BRIDGE_SETTINGS_FILE; else process.env.CLI_BRIDGE_SETTINGS_FILE = prevFile
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome
  }
  await c.flush()
  const ids = c.seen.filter((x) => typeof x === 'string')
  assert.deepEqual(ids, [PRESET_OF.mimo, PRESET_OF.agy], 'order = priority ∩ enabled')
})

test('declareBridgePresets：opts.ids 显式传入 = 跳过调度（测试/手工可控）', async () => {
  const p = settingsFileWith({ _scheduling: { enabled: [], priority: [] } })
  const c = withScheduling(p, () => {
    const seen = []
    const ctx = {
      inject(deps, fn) {
        seen.push(deps)
        const child = {
          effect(inner) { inner(); return () => { } },
          agentPresets: { register: async (def) => { seen.push(def.id); return () => { } } },
          logger: { warn() { } }
        }
        fn(child)
        return () => { }
      }
    }
    return declareBridgePresets(ctx, { ids: IDS }), seen
  })
  const seen = c
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(seen.filter((x) => typeof x === 'string').length, IDS.length, 'explicit ids ignore the all-disabled file')
})

test('declareBridgePresets：ctx 无 inject（旧宿主/非组合根）→ 返回空表不抛', () => {
  assert.deepEqual(declareBridgePresets({}, {}), [])
  assert.deepEqual(declareBridgePresets({ inject: null }, {}), [])
})
