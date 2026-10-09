// tests/mimo/plugin-list.test.mjs — cordis-mimo 单源清单（standard 基线 + mimo 桥接行
// + MiMo-first 委派 persona）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildPlugins, meta } from '../../preset/mimo-first/plugin-list.mjs'
import { standardPluginRows, jsExpr } from '../../preset/standard-base.mjs'

test('meta：preset id 是旧会话头引用，不可变（Lead 红线）', () => {
  assert.equal(meta.id, 'cordis-mimo')
  assert.equal(meta.name, 'MiMo 执行代理')
  assert.equal(typeof meta.description, 'string')
  assert.ok(meta.description.includes('mimo_run'))
  assert.ok(meta.description.includes('MiMo 优先'))
  assert.equal(meta.order, 10)
})

test('行数 = standard 基线 + 唯一桥接行（Lead 定案：19+1=20，动态断言防漂移）', () => {
  const rows = buildPlugins({ bridgeName: '@luchenglong/cli-bridge/preset-mimo' })
  assert.equal(standardPluginRows().length, 19, 'baseline is 19')
  assert.equal(rows.length, standardPluginRows().length + 1)
  assert.equal(rows.length, 20)
})

test('桥接行：id/name 与 package.json exports 子路径一致（历史 bug：相对路径）', () => {
  const rows = buildPlugins({ bridgeName: '@luchenglong/cli-bridge/preset-mimo' })
  const bridge = rows[rows.length - 1]
  assert.equal(bridge.id, 'cli-bridge-mimo')
  assert.equal(bridge.name, '@luchenglong/cli-bridge/preset-mimo')
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./preset-mimo'], './preset/mimo-first/cli-bridge.mjs')
})

test('MiMo-first 委派 persona 注入 spawn/fork 两个 tool-subagent（旧 agent.cordis.yml verbatim）', () => {
  const rows = buildPlugins({})
  const delegation = rows.find((r) => r.id === 'delegation')
  const sub = delegation.config.filter((c) => c.name === '@deepseek-ai/dsh-tool-subagent' && (c.config.provider === 'spawn' || c.config.provider === 'fork'))
  assert.equal(sub.length, 2, 'spawn + fork rows present')
  for (const s of sub) {
    assert.ok(s.config.persona, 'delegation persona injected on ' + s.config.provider)
    assert.match(s.config.persona, /MiMo-first session/)
    assert.match(s.config.persona, /mimo_run/)
  }
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
  assert.equal(bridge.id, 'cli-bridge-mimo')
  assert.equal(bridge.name, '@luchenglong/cli-bridge/preset-mimo')
})

test('standard 其余行逐项透传（唯一差异 = delegation persona 注入；其余零增删改）', () => {
  const rows = buildPlugins({})
  const base = standardPluginRows()
  const mine = rows.filter((r) => r.id !== 'cli-bridge-mimo')
  const cmp = (o) => JSON.stringify(o, (k, v) => (typeof v === 'function' ? 'fn' : v))
  assert.equal(mine.length, base.length)
  for (let i = 0; i < base.length; i++) {
    if (base[i].id === 'delegation') {
      // delegation：mimo 唯一语义差异 = spawn/fork 行注入 MiMo-first persona；
      // 剥掉 persona 后必须与基线逐项一致（防夹带其它改动）。
      const stripped = JSON.parse(cmp(mine[i]))
      for (const c of stripped.config) {
        if (c.config && (c.config.provider === 'spawn' || c.config.provider === 'fork')) delete c.config.persona
      }
      assert.equal(JSON.stringify(stripped), cmp(base[i]), 'delegation drift beyond persona')
      continue
    }
    // persona 及其它行：mimo 与官方 standard 逐字一致，纳入比对。
    assert.equal(cmp(mine[i]), cmp(base[i]), 'row drift at ' + base[i].id)
  }
})
