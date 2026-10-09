// tests/agy/plugin-list.test.mjs — cordis-agy 单源清单（standard 基线 + agy 桥接行）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildPlugins, meta } from '../../preset/agy-first/plugin-list.mjs'
import { standardPluginRows, jsExpr } from '../../preset/standard-base.mjs'

test('meta：preset id 是旧会话头引用，不可变', () => {
  assert.equal(meta.id, 'cordis-agy')
  assert.equal(meta.name, 'AGY 执行代理')
  assert.equal(typeof meta.description, 'string')
  assert.ok(meta.description.includes('agy_run'))
  assert.ok(meta.description.includes('agy 优先'))
  assert.equal(meta.order, 10)
})

test('行数 = standard 基线 + 唯一桥接行（动态断言，防上游漂移）', () => {
  const rows = buildPlugins({ bridgeName: '@luchenglong/cli-bridge/preset-agy' })
  assert.equal(rows.length, standardPluginRows().length + 1)
})

test('桥接行：id/name 与 package.json exports 子路径一致', () => {
  const rows = buildPlugins({ bridgeName: '@luchenglong/cli-bridge/preset-agy' })
  const bridge = rows[rows.length - 1]
  assert.equal(bridge.id, 'cli-bridge-agy')
  assert.equal(bridge.name, '@luchenglong/cli-bridge/preset-agy')
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./preset-agy'], './preset/agy-first/cli-bridge.mjs')
})

test('persona 行保持官方 standard 文案（prefix 必填 + suffix 可选）', () => {
  const rows = buildPlugins({})
  const persona = rows.find((r) => r.id === 'persona')
  assert.ok(persona, 'persona row present')
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.equal(persona.config.prefix, 'You are a coding agent powered by the {{model}} model.')
  assert.equal(persona.config.suffix, 'Your working directory is {{cwd}}.')
})

test('!!js 表达式保持 {__jsExpr} 字面量形态（不编译成真函数）', () => {
  const rows = buildPlugins({})
  const toolBash = rows.find((r) => r.id === 'tool-bash')
  assert.equal(typeof toolBash.disabled, 'object')
  assert.equal(toolBash.disabled.__jsExpr, "process.platform === 'win32'")
  assert.deepEqual(jsExpr('x'), { __jsExpr: 'x' })
})

test('不传 deps 时桥接行用默认包名（不崩）', () => {
  const rows = buildPlugins()
  const bridge = rows[rows.length - 1]
  assert.equal(bridge.id, 'cli-bridge-agy')
  assert.equal(bridge.name, '@luchenglong/cli-bridge/preset-agy')
})

test('standard 其余行逐项透传（除 persona/桥接外无增删改）', () => {
  const rows = buildPlugins({})
  const base = standardPluginRows()
  const mine = rows.filter((r) => r.id !== 'cli-bridge-agy')
  const cmp = (o) => JSON.stringify(o, (k, v) => (typeof v === 'function' ? 'fn' : v))
  assert.equal(mine.length, base.length)
  for (let i = 0; i < base.length; i++) {
    if (base[i].id === 'persona') continue
    assert.equal(cmp(mine[i]), cmp(base[i]), 'row drift at ' + base[i].id)
  }
})
