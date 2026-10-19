// tests/claude/preset-apply.test.mjs — preset 形态冒烟（mock ctx，端到端走 bridge-kit）。
// 锁：四工具注册（三件套 + claude_models）+ claude:policy 段 + 心跳宣告 +
// claude/status 发布通道 + run 前台执行的成功判定（is_error 语义在 descriptor.test 深测）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIX = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const HOME = mkdtempSync(join(tmpdir(), 'clb-claude-preset-'))
writeFileSync(join(HOME, 'cli-bridge-settings.json'), JSON.stringify({ claude: {} }))
process.env.CLI_BRIDGE_SETTINGS_FILE = join(HOME, 'cli-bridge-settings.json')
// preset 形态在 apply() 里用 process.env 构造描述符；exe 探测据此命中 fixture（.mjs → node 包装）。
process.env.CLAUDE_BIN = FIX

const mod = await import('../../preset/claude-first/cli-bridge.mjs')

const RESULT_LINE = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 120, num_turns: 1,
  result: 'PRESET_OK', session_id: 'sid_preset_1', total_cost_usd: 0.001,
  usage: { input_tokens: 10, output_tokens: 2 }, modelUsage: {}, permission_denials: []
})

function fakeHandle() {
  const done = new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0 }), 5))
  return {
    done,
    collected: {
      stdout: { readFrom: () => ({ text: RESULT_LINE }) },
      stderr: { readFrom: () => ({ text: '' }) }
    },
    terminate() { }
  }
}

function mkCtx() {
  const registered = []
  const sections = []
  const events = []
  const timers = []
  const spawns = []
  const ctx = {
    session: { id: 'sess-claude-1' },
    get(id) {
      if (id === 'cliBridgeSettings') return { claude: { defaultModel: '', binPath: '' } }
      return null
    },
    emit(ch, payload) { events.push({ ch, payload }) },
    effect(fn) { try { fn() } catch (e) { } return () => { } },
    setInterval(fn, ms) { timers.push({ fn, ms }); return () => { } },
    interval(fn, ms) { timers.push({ fn, ms }); return () => { } },
    timeout() { return () => { } },
    subprocess: {
      resolveExecutable: async (n) => 'C:/fake/' + n + '.exe',
      spawn(spec) { spawns.push(spec); return fakeHandle() }
    },
    tools: { register: (t) => { registered.push(t); return () => { } } },
    systemPrompt: { section: (s) => { sections.push(s); return () => { } } }
  }
  return { ctx, registered, sections, events, timers, spawns }
}

test('模块导出契约：name / inject / apply', () => {
  assert.equal(mod.name, 'cli-bridge-claude')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('tools'))
  assert.ok(mod.inject.includes('systemPrompt'))
  assert.equal(typeof mod.apply, 'function')
})

test('apply 注册四件套（三件套 + claude_models）+ claude:policy 段', () => {
  const { ctx, registered, sections } = mkCtx()
  mod.apply(ctx)
  const names = registered.map((t) => t.name)
  assert.deepEqual(names, ['claude_run', 'claude_continue', 'claude_status', 'claude_models'])
  for (const t of registered) {
    assert.equal(t.parameters.type, 'object')
    assert.equal(typeof t.execute, 'function')
    assert.equal(typeof t.output.render, 'function')
  }
  const pol = sections.find((s) => s.name === 'claude:policy')
  assert.ok(pol, 'policy section registered')
  assert.match(pol.text, /claude-first execution policy/)
  assert.match(pol.text, /claude_run/)
  assert.match(pol.text, /claude_models/)
  assert.match(pol.text, /settings\.json/, '凭据归属必须写清是 claude 自己的配置')
  assert.ok(typeof pol.order === 'number')
})

test('apply 宣告 claude/mode 心跳（30s 续租）', () => {
  const { ctx, events, timers } = mkCtx()
  mod.apply(ctx)
  const mode = events.filter((e) => e.ch === 'claude/mode')
  assert.ok(mode.length >= 1, 'mode announced on mount')
  assert.equal(mode[0].payload.active, true)
  assert.equal(mode[0].payload.sessionId, 'sess-claude-1')
  assert.ok(timers.some((t) => t.ms === 30000), '30s heartbeat lease')
})

test('claude_run 前台端到端（mock subprocess）：argv 正确 + SUCCESS + session 回传', async () => {
  const { ctx, registered, spawns, events } = mkCtx()
  mod.apply(ctx)
  const run = registered.find((t) => t.name === 'claude_run')
  const res = await run.execute({ prompt: 'Reply exactly: PONG', background: false }, { agent: null, signal: null })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.status, 'SUCCESS')
  assert.equal(res.response, 'PRESET_OK')
  assert.equal(res.sessionId, 'sid_preset_1')
  // argv 契约：-p <prompt> + stream-json + verbose + skip-permissions（本机实测 flag 集）。
  assert.equal(spawns.length, 1)
  const argv = spawns[0].argv
  assert.equal(argv[0], process.execPath, '.mjs fixture 经 node 包装')
  assert.equal(argv[1], FIX)
  for (const f of ['-p', 'Reply exactly: PONG', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']) {
    assert.ok(argv.indexOf(f) >= 0, 'argv missing ' + f)
  }
  // 状态发布通道（家级灯）：engine.begin/end 都会 emit claude/status。
  const status = events.filter((e) => e.ch === 'claude/status')
  assert.ok(status.length >= 1, 'claude/status published')
  assert.equal(status[status.length - 1].payload.snapshot.provider, 'claude')
  assert.equal(status[status.length - 1].payload.snapshot.lastStatus, 'SUCCESS')
})

test('claude_status：statusToolLogic 返回快照（可渲染且带 provider）', async () => {
  const { ctx, registered } = mkCtx()
  mod.apply(ctx)
  const status = registered.find((t) => t.name === 'claude_status')
  const snap = await status.execute({}, {})
  assert.equal(snap.provider, 'claude')
  assert.equal(typeof snap.state, 'string')
  assert.ok(Array.isArray(snap.projects))
  const rendered = status.output.render({}, snap)
  assert.match(rendered[0].text, /claude status:/)
})

test('claude_models：经工具面调用返回服务端清单（fixture 400 报文）', async () => {
  const { ctx, registered } = mkCtx()
  mod.apply(ctx)
  const models = registered.find((t) => t.name === 'claude_models')
  const res = await models.execute({ refresh: true }, {})
  assert.equal(res.ok, true)
  assert.deepEqual(res.models.map((m) => m.id), ['fake-model-alpha', 'fake-model-beta'])
  const text = models.output.render({}, res)[0].text
  assert.match(text, /claude models \(2\)/)
  assert.match(text, /fake-model-beta/)
})
