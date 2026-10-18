// tests/codebuddy/plugin-list.test.mjs — codebuddy-first 单源清单（standard 基线 +
// codebuddy 桥接行；persona 无定制 —— 旧包 agent.cordis.yml 就没有）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildPlugins, meta } from '../../preset/codebuddy-first/plugin-list.mjs'
import { standardPluginRows, jsExpr } from '../../preset/standard-base.mjs'

test('meta：preset id codebuddy-first 是旧会话头引用，不可变（Lead 红线）', () => {
  assert.equal(meta.id, 'codebuddy-first')
  assert.equal(meta.name, 'CodeBuddy-First 执行代理')
  assert.ok(meta.description.includes('codebuddy_run'))
  assert.ok(meta.description.includes('codebuddy 优先'))
  assert.equal(meta.order, 10)
})

test('行数 = standard 基线 + 唯一桥接行（动态断言防漂移）', () => {
  const rows = buildPlugins({ bridgeName: '@luchenglong/cli-bridge/preset-codebuddy' })
  assert.equal(rows.length, standardPluginRows().length + 1)
})

test('桥接行：id/name 与 package.json exports 子路径一致', () => {
  const rows = buildPlugins({ bridgeName: '@luchenglong/cli-bridge/preset-codebuddy' })
  const bridge = rows[rows.length - 1]
  assert.equal(bridge.id, 'cli-bridge-codebuddy')
  assert.equal(bridge.name, '@luchenglong/cli-bridge/preset-codebuddy')
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./preset-codebuddy'], './preset/codebuddy-first/cli-bridge.mjs')
})

test('persona 行只带 prefix（suffix 必须缺席 —— codebuddy 侧零定制）', () => {
  const rows = buildPlugins({})
  const persona = rows.find((r) => r.id === 'persona')
  assert.ok(persona, 'persona row present')
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.equal(persona.config.prefix, 'You are a coding agent powered by the {{model}} model.')
  // {{cwd}} 不是注册变量（当前 DSH 只注册 provider/model），写进 persona 会在提示词
  // 组装期抛 unknown prompt variable，使整个预设不可用。工作目录改由 working-directory
  // 服务以「不插值的用户上下文」提供，所以这里必须【没有】suffix。
  assert.equal(persona.config.suffix, undefined)
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
  assert.equal(bridge.id, 'cli-bridge-codebuddy')
  assert.equal(bridge.name, '@luchenglong/cli-bridge/preset-codebuddy')
})

test('standard 其余行逐项透传（codebuddy 零语义差异：连 persona 都不改）', () => {
  const rows = buildPlugins({})
  const base = standardPluginRows()
  const mine = rows.filter((r) => r.id !== 'cli-bridge-codebuddy')
  const cmp = (o) => JSON.stringify(o, (k, v) => (typeof v === 'function' ? 'fn' : v))
  assert.equal(mine.length, base.length)
  for (let i = 0; i < base.length; i++) {
    assert.equal(cmp(mine[i]), cmp(base[i]), 'row drift at ' + base[i].id)
  }
})
