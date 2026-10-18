// tests/mimo/plugin-list.test.mjs — cordis-mimo 单源清单（standard 基线 + mimo 桥接行
// + MiMo-first 委派 persona）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildPlugins, meta, MEMBER_PRESET_ID } from '../../preset/mimo-first/plugin-list.mjs'
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

test('委派：persona 已迁出 tool-subagent（0.2.1 会 throw），改由 spawn 行的 agentPreset 指向成员预设', () => {
  const rows = buildPlugins({})
  const delegation = rows.find((r) => r.id === 'delegation')
  const sub = delegation.config.filter((c) => c.name === '@deepseek-ai/dsh-tool-subagent')
  assert.ok(sub.length >= 2, 'tool-subagent rows present')

  // 1) persona/toolFilter 一律不得留在 tool-subagent 的 config 上：dsh-tool-subagent
  //    0.2.1 的 apply() 对它们显式 throw，会让整个预设挂载失败。
  for (const s of sub) {
    assert.equal(s.config.persona, undefined, 'persona must be gone from tool-subagent (' + s.id + ')')
    assert.equal(s.config.toolFilter, undefined, 'toolFilter must be gone from tool-subagent (' + s.id + ')')
  }

  // 2) agentPreset 只有 in-process spawn 支持；fork 与外部后端会拒绝它。
  const spawn = sub.find((s) => s.config.provider === 'spawn')
  const fork = sub.find((s) => s.config.provider === 'fork')
  assert.ok(spawn, 'spawn row present')
  assert.ok(fork, 'fork row present')
  assert.equal(spawn.config.agentPreset, MEMBER_PRESET_ID, 'spawn row selects the member preset')
  assert.equal(fork.config.agentPreset, undefined, 'fork row must NOT carry agentPreset (rejected)')
})

test('成员预设单源：人格即旧委派指令，工具面含 mimo 桥接 + 只读文件面', async () => {
  const member = await import('../../preset/mimo-member/plugin-list.mjs')
  assert.equal(member.meta.id, 'cordis-mimo-member')
  assert.equal(member.meta.id, MEMBER_PRESET_ID, '委派行引用的 id 必须等于成员预设身份')
  const rows = member.buildPlugins({ bridgeName: '@luchenglong/cli-bridge/preset-mimo' })

  const persona = rows.find((r) => r.id === 'persona')
  assert.ok(persona, 'member persona row present')
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.equal(persona.config.prefix, member.MIMO_DELEGATION_PERSONA)
  assert.match(persona.config.prefix, /MiMo-first session/)
  assert.match(persona.config.prefix, /mimo_run/)
  assert.equal(persona.config.suffix, undefined, '成员人格也不设 suffix')

  // 子 agent 必须能调 mimo_run，否则"把活派给 mimo"无从谈起。
  const bridge = rows.find((r) => r.id === 'cli-bridge-mimo')
  assert.ok(bridge, 'member preset carries the mimo bridge row')
  assert.equal(bridge.name, '@luchenglong/cli-bridge/preset-mimo')

  // 只读文件面 = 旧 toolFilter 白名单的新表达（写/改工具直接不存在）。
  const fs = rows.find((r) => r.id === 'tool-fs')
  assert.equal(fs.config.read, true)
  assert.equal(fs.config.write, false)
  assert.equal(fs.config.edit, false)
})

test('persona 行只带 prefix（suffix 必须缺席：DSH 只注册 provider/model）', () => {
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
  assert.equal(bridge.id, 'cli-bridge-mimo')
  assert.equal(bridge.name, '@luchenglong/cli-bridge/preset-mimo')
})

test('standard 其余行逐项透传（唯一差异 = spawn 行的 agentPreset；其余零增删改）', () => {
  const rows = buildPlugins({})
  const base = standardPluginRows()
  const mine = rows.filter((r) => r.id !== 'cli-bridge-mimo')
  const cmp = (o) => JSON.stringify(o, (k, v) => (typeof v === 'function' ? 'fn' : v))
  assert.equal(mine.length, base.length)
  for (let i = 0; i < base.length; i++) {
    if (base[i].id === 'delegation') {
      // delegation：mimo 唯一语义差异 = spawn 行加 agentPreset 指向成员预设；
      // 剥掉它之后必须与基线逐项一致（防夹带其它改动）。
      const stripped = JSON.parse(cmp(mine[i]))
      for (const c of stripped.config) {
        if (c.config && c.config.provider === 'spawn') delete c.config.agentPreset
      }
      assert.equal(JSON.stringify(stripped), cmp(base[i]), 'delegation drift beyond agentPreset')
      continue
    }
    // persona 及其它行：mimo 与官方 standard 逐字一致，纳入比对。
    assert.equal(cmp(mine[i]), cmp(base[i]), 'row drift at ' + base[i].id)
  }
})
