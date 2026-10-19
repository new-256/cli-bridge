// tests/codex/preset-apply.test.mjs — preset 形态冒烟（mock ctx）。
// 锁：四工具注册（三件套 + codex_models）+ codex:policy 段 + 心跳宣告 + 模块导出契约。
// 调度门禁的启用/禁用行为由 tests/keystone/scheduling-gate.test.mjs 统一覆盖；codex 尚未
// 进 PROVIDER_IDS 时 isBridgeEnabled 走 fail-open（不在清单里 = 无门禁语义），故这里不断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'clb-codex-preset-'))
writeFileSync(join(HOME, 'cli-bridge-settings.json'), JSON.stringify({ codex: {} }))
process.env.CLI_BRIDGE_SETTINGS_FILE = join(HOME, 'cli-bridge-settings.json')

const mod = await import('../../preset/codex-first/cli-bridge.mjs')

function mkCtx(extra) {
  const registered = []
  const sections = []
  const events = []
  const timers = []
  const ctx = {
    session: { id: 'sess-codex-1' },
    get(name) {
      if (extra && Object.prototype.hasOwnProperty.call(extra, name)) return extra[name]
      return null
    },
    emit(ch, payload) { events.push({ ch, payload }) },
    effect(fn) { try { fn() } catch (e) { throw e } return () => { } },
    setInterval(fn, ms) { timers.push({ fn, ms }); return () => { } },
    subprocess: {
      resolveExecutable: async (n) => 'C:/fake/' + n + '.exe',
      spawn: async () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} })
    },
    tools: { register: (t) => { registered.push(t); return () => { } } },
    systemPrompt: { section: (s) => { sections.push(s); return () => { } } }
  }
  return { ctx, registered, sections, events, timers }
}

test('模块导出契约：name / inject / apply', () => {
  assert.equal(mod.name, 'cli-bridge-codex')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('tools'))
  assert.ok(mod.inject.includes('subprocess'))
  assert.ok(mod.inject.includes('systemPrompt'))
  assert.equal(typeof mod.apply, 'function')
})

test('apply 注册四件套（三件套 + codex_models）+ codex:policy 段', () => {
  const { ctx, registered, sections } = mkCtx()
  mod.apply(ctx)
  const names = registered.map((t) => t.name)
  assert.deepEqual(names, ['codex_run', 'codex_continue', 'codex_status', 'codex_models'])
  for (const t of registered) {
    assert.equal(t.parameters.type, 'object')
    assert.equal(typeof t.execute, 'function')
    assert.equal(typeof t.output.render, 'function')
  }
  const pol = sections.find((s) => s.name === 'codex:policy')
  assert.ok(pol, 'policy section registered')
  assert.match(pol.text, /codex-first execution policy/)
  assert.match(pol.text, /codex_run/)
  assert.match(pol.text, /codex_continue/)
  // 提示词必须写清真实调用形态与两条实测陷阱（否则 agent 会凭想象加旗）。
  assert.match(pol.text, /codex exec --json --skip-git-repo-check/)
  assert.match(pol.text, /NO -a\/--ask-for-approval/)
  assert.match(pol.text, /no -s and no -C/)
  // 凭据归 codex 自己管 —— 避免 agent 循环重试。
  assert.match(pol.text, /codex login/)
  // 模型清单权威性必须说清（本地目录 ≠ 服务端可用）。
  assert.match(pol.text, /codex_models/)
  assert.match(pol.text, /NOT a claim about server availability/)
})

test('apply 宣告 codex/mode 心跳（30s 续租）', () => {
  const { ctx, events, timers } = mkCtx()
  mod.apply(ctx)
  const mode = events.filter((e) => e.ch === 'codex/mode')
  assert.ok(mode.length >= 1, 'mode announced on mount')
  assert.equal(mode[0].payload.active, true)
  assert.equal(mode[0].payload.sessionId, 'sess-codex-1')
  assert.ok(timers.some((t) => t.ms === 30000), '30s heartbeat lease')
})

test('apply 尊重设置面板里的 binPath（ctx.get cliBridgeSettings）', () => {
  const { ctx, registered } = mkCtx({ cliBridgeSettings: { codex: { binPath: 'C:/panel/codex.exe' } } })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(registered.length, 4)
})

test('apply 在无 sandboxPolicy 的宿主里也不炸', () => {
  const { ctx } = mkCtx()
  ctx.get = () => undefined
  assert.doesNotThrow(() => mod.apply(ctx))
})

test('cleanup', () => {
  try { rmSync(HOME, { recursive: true, force: true }) } catch (e) { /* ignore */ }
})
