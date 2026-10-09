// tests/agy/preset-resolve.test.mjs — 生成物一致性：agent.cordis.yml / preset.yml。
// （静态断言版：不真起 Cordis loader；生成物由 build.mjs --only=agy 维护，
//   build --check 已保证与 plugin-list.mjs 单源同步。）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const YML = readFileSync(fileURLToPath(new URL('../../preset/agy-first/agent.cordis.yml', import.meta.url)), 'utf8')
const PRESET = readFileSync(fileURLToPath(new URL('../../preset/agy-first/preset.yml', import.meta.url)), 'utf8')

test('agent.cordis.yml 头部标注生成物（勿手改）', () => {
  assert.match(YML, /^# 生成物 — 由 node scripts\/build\.mjs/)
})

test('桥接行落地为包名入口（不是旧仓相对文件路径）', () => {
  assert.match(YML, /- id: cli-bridge-agy\n\s+name: '@luchenglong\/cli-bridge\/preset-agy'/)
  assert.ok(!YML.includes('./agy-first-bridge.mjs'), 'no stale relative entry from the old repo')
})

test('persona 行保持旧 cordis-agy 语义（prefix/suffix 逐字）', () => {
  assert.match(YML, /You are a coding agent powered by the \{\{model\}\} model\./)
  assert.match(YML, /Your working directory is \{\{cwd\}\}\./)
})

test('!!js disabled 表达式按块标量落地（tool-bash/tool-pwsh 平台互斥）', () => {
  assert.match(YML, /- id: tool-bash[\s\S]*?disabled: !!js 'process\.platform === ''win32''/)
  assert.match(YML, /- id: tool-pwsh[\s\S]*?disabled: !!js 'process\.platform !== ''win32''/)
})

test('preset.yml 元信息与 meta 单源一致', () => {
  assert.match(PRESET, /^name: AGY 执行代理/m)
  assert.match(PRESET, /^description: '?完整编码 Agent/m)
  assert.match(PRESET, /agy_run/)
  assert.match(PRESET, /^order: 10/m)
})
