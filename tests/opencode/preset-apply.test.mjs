// tests/opencode/preset-apply.test.mjs — preset 形态冒烟（mock ctx）。
// 锁：三工具注册 + opencode:policy 段 + 心跳宣告 + 模块导出契约；
// 调度门禁的启用/禁用行为由 tests/keystone/scheduling-gate.test.mjs 统一覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'clb-opencode-preset-'))
// 全开调度（无 _scheduling 区 = fail-open 全启用），确保 apply 不被门禁短路。
writeFileSync(join(HOME, 'cli-bridge-settings.json'), JSON.stringify({ opencode: {} }))
process.env.CLI_BRIDGE_SETTINGS_FILE = join(HOME, 'cli-bridge-settings.json')

const mod = await import('../../preset/opencode-first/cli-bridge.mjs')
const { PROVIDER_IDS } = await import('../../providers/registry.mjs')

function mkCtx() {
  const registered = []
  const sections = []
  const events = []
  const timers = []
  const ctx = {
    session: { id: 'sess-opencode-1' },
    get() { return null },
    emit(ch, payload) { events.push({ ch, payload }) },
    effect(fn) { try { fn() } catch (e) { } return () => { } },
    setInterval(fn, ms) { timers.push({ fn, ms }); return () => { } },
    subprocess: { resolveExecutable: async (n) => 'C:/fake/' + n + '.exe', spawn: async () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} }) },
    tools: { register: (t) => { registered.push(t); return () => { } } },
    systemPrompt: { section: (s) => { sections.push(s); return () => { } } }
  }
  return { ctx, registered, sections, events, timers }
}

test('模块导出契约：name / inject / apply', () => {
  assert.equal(mod.name, 'cli-bridge-opencode')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('tools'))
  assert.equal(typeof mod.apply, 'function')
})

test('opencode 进注册表（单一 id 轴）', () => {
  assert.ok(PROVIDER_IDS.includes('opencode'))
  // 新增项追加在末尾，既有三家顺序不变（兼容旧会话与已落盘配置）。
  assert.deepEqual(PROVIDER_IDS.slice(0, 3), ['agy', 'codebuddy', 'mimo'])
})

test('apply 注册四件套（三件套 + opencode_models）+ opencode:policy 段', () => {
  const { ctx, registered, sections } = mkCtx()
  mod.apply(ctx)
  const names = registered.map((t) => t.name)
  assert.deepEqual(names, ['opencode_run', 'opencode_continue', 'opencode_status', 'opencode_models'])
  for (const t of registered) {
    assert.equal(t.parameters.type, 'object')
    assert.ok(typeof t.execute === 'function')
  }
  const pol = sections.find((s) => s.name === 'opencode:policy')
  assert.ok(pol, 'policy section registered')
  assert.match(pol.text, /opencode-first execution policy/)
  assert.match(pol.text, /opencode_run/)
  // 提示词必须说清「凭据归 opencode 自己管」，避免 agent 循环重试。
  assert.match(pol.text, /opencode auth login/)
  // 提示词必须引导优先用免费模型（用户要求）。
  assert.match(pol.text, /-free/)
})

test('apply 宣告 opencode/mode 心跳（30s 续租）', () => {
  const { ctx, events, timers } = mkCtx()
  mod.apply(ctx)
  const mode = events.filter((e) => e.ch === 'opencode/mode')
  assert.ok(mode.length >= 1, 'mode announced on mount')
  assert.equal(mode[0].payload.active, true)
  assert.ok(timers.some((t) => t.ms === 30000), '30s heartbeat lease')
})
