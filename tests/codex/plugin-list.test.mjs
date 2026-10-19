// tests/codex/plugin-list.test.mjs — codex-first 单源清单（standard 基线 + codex 桥接行）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildPlugins, meta } from '../../preset/codex-first/plugin-list.mjs'
import { standardPluginRows, jsExpr } from '../../preset/standard-base.mjs'

test('meta：preset id 用 <provider>-first（不套旧包 cordis-* 前缀）', () => {
  assert.equal(meta.id, 'codex-first')
  assert.equal(meta.name, 'Codex 执行代理')
  assert.equal(typeof meta.description, 'string')
  assert.ok(meta.description.includes('codex_run'))
  assert.ok(meta.description.includes('codex_continue'))
  assert.ok(meta.description.includes('Codex 优先'))
  assert.equal(meta.order, 50)
})

test('行数 = standard 基线 + 唯一桥接行（动态断言，防上游漂移）', () => {
  const rows = buildPlugins({ bridgeName: '@luchenglong/cli-bridge/preset-codex' })
  assert.equal(rows.length, standardPluginRows().length + 1)
})

test('桥接行：id 固定，name 透传 deps.bridgeName；缺省用裸说明符', () => {
  const rows = buildPlugins({ bridgeName: '@luchenglong/cli-bridge/preset-codex' })
  const bridge = rows[rows.length - 1]
  assert.equal(bridge.id, 'cli-bridge-codex')
  assert.equal(bridge.name, '@luchenglong/cli-bridge/preset-codex')
  // 不传 deps 时的缺省（历史事故：相对路径在注册表 baseUrl 下必然错解）。
  const fallback = buildPlugins()
  assert.equal(fallback[fallback.length - 1].name, '@luchenglong/cli-bridge/preset-codex')
})

test('persona 行只带 prefix（suffix 必须缺席：DSH 只注册 provider/model）', () => {
  const rows = buildPlugins({})
  const persona = rows.find((r) => r.id === 'persona')
  assert.ok(persona, 'persona row present')
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.equal(persona.config.prefix, 'You are a coding agent powered by the {{model}} model.')
  // {{cwd}} 不是注册变量（当前 DSH 只注册 provider/model），写进 persona 会在提示词
  // 组装期抛 unknown prompt variable，使整个预设不可用。
  assert.equal(persona.config.suffix, undefined)
})

test('!!js 表达式保持 {__jsExpr} 字面量形态（不编译成真函数）', () => {
  const rows = buildPlugins({})
  const toolBash = rows.find((r) => r.id === 'tool-bash')
  assert.equal(typeof toolBash.disabled, 'object')
  assert.equal(toolBash.disabled.__jsExpr, "process.platform === 'win32'")
  assert.deepEqual(jsExpr('x'), { __jsExpr: 'x' })
})

test('standard 其余行逐项透传（除 persona/桥接外无增删改）', () => {
  const rows = buildPlugins({})
  const base = standardPluginRows()
  const mine = rows.filter((r) => r.id !== 'cli-bridge-codex')
  const cmp = (o) => JSON.stringify(o, (k, v) => (typeof v === 'function' ? 'fn' : v))
  assert.equal(mine.length, base.length)
  for (let i = 0; i < base.length; i++) {
    if (base[i].id === 'persona') continue
    assert.equal(cmp(mine[i]), cmp(base[i]), 'row drift at ' + base[i].id)
  }
})

test('桥接行说明符必须等于 Lead 要接的 exports 子路径 preset-codex（信息钉）', () => {
  const rows = buildPlugins({})
  const bridge = rows[rows.length - 1]
  // ⚠️ 新 provider 的 exports / registry / build.mjs PRESET_DIRS 由 Lead 统一接线；
  // 这里只锁死「说明符必须与 package.json exports 的子路径同形」，避免两边漂移：
  //   package.json exports["./preset-codex"] = "./preset/codex-first/cli-bridge.mjs"
  assert.equal(bridge.name, '@luchenglong/cli-bridge/preset-codex')
  assert.equal(bridge.name, '@luchenglong/cli-bridge/preset-' + meta.id.replace(/-first$/, ''))
})
