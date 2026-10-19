// tests/claude/plugin-list.test.mjs — claude-first 单源清单（standard 基线 + claude 桥接行）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPlugins, meta } from '../../preset/claude-first/plugin-list.mjs'
import { standardPluginRows, jsExpr } from '../../preset/standard-base.mjs'

test('meta：preset id 是 claude-first（新 provider 用 <id>-first，不套 cordis-* 旧前缀）', () => {
  assert.equal(meta.id, 'claude-first')
  assert.equal(typeof meta.name, 'string')
  assert.ok(meta.description.includes('claude_run'))
  assert.ok(meta.description.includes('claude 优先'))
  assert.equal(meta.order, 50)
})

test('行数 = standard 基线 + 唯一桥接行（动态断言，防上游漂移）', () => {
  const rows = buildPlugins({ bridgeName: '@luchenglong/cli-bridge/preset-claude' })
  assert.equal(rows.length, standardPluginRows().length + 1)
})

test('桥接行：id=cli-bridge-claude，name 透传 deps.bridgeName（绝不写死路径）', () => {
  const rows = buildPlugins({ bridgeName: '@luchenglong/cli-bridge/preset-claude' })
  const bridge = rows[rows.length - 1]
  assert.equal(bridge.id, 'cli-bridge-claude')
  assert.equal(bridge.name, '@luchenglong/cli-bridge/preset-claude')
  // 相对路径在注册表 baseUrl 下必然错解（历史事故）——桥接行必须是裸包说明符。
  assert.ok(!bridge.name.startsWith('.') && !bridge.name.includes('\\'))
})

test('不传 deps 时桥接行用默认包名（不崩）', () => {
  const rows = buildPlugins()
  const bridge = rows[rows.length - 1]
  assert.equal(bridge.id, 'cli-bridge-claude')
  assert.equal(bridge.name, '@luchenglong/cli-bridge/preset-claude')
})

test('persona 行只带 prefix（suffix 必须缺席：DSH 只注册 provider/model）', () => {
  const rows = buildPlugins({})
  const persona = rows.find((r) => r.id === 'persona')
  assert.ok(persona, 'persona row present')
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.equal(persona.config.prefix, 'You are a coding agent powered by the {{model}} model.')
  // {{cwd}} 不是注册变量，写进 persona 会让整个预设组装期抛 unknown prompt variable。
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
  const mine = rows.filter((r) => r.id !== 'cli-bridge-claude')
  const cmp = (o) => JSON.stringify(o, (k, v) => (typeof v === 'function' ? 'fn' : v))
  assert.equal(mine.length, base.length)
  for (let i = 0; i < base.length; i++) {
    if (base[i].id === 'persona') continue
    assert.equal(cmp(mine[i]), cmp(base[i]), 'row drift at ' + base[i].id)
  }
})
