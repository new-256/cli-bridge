// tests/agy/preset-apply.test.mjs — preset 宿主接线（mock ctx，无真 agy/网络）。
// 覆盖：工具注册、agy/mode 心跳、agy/status 发布、agy:policy 段、前台/后台两条执行路。
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { name as bridgeName, inject, apply } from '../../preset/agy-first/cli-bridge.mjs'

const FIX = (f) => fileURLToPath(new URL('./fixtures/' + f, import.meta.url))
// 调度门禁（0.2.0）在 apply() 里现读统一设置文件：本文件顶层把它钉到不存在路径
// （node --test 每文件独立进程，无需 restore）。否则本机真实 DSH_HOME 里用户一旦
// 关掉 agy，下面每个用例都会静默变「零注册」而误红 —— mimo/codebuddy 侧同款纪律。
process.env.CLI_BRIDGE_SETTINGS_FILE = fileURLToPath(new URL('./fixtures/__no_such_settings__.json', import.meta.url))
delete process.env.CLI_BRIDGE_PROVIDER
const AGY_NDJSON = [
  '{"event":"step_update","step_update":{"step_type":"tool","step_index":0,"state":"ACTIVE","tool_name":"read","tool_info":{"name":"read","parameters":{"file_path":"a.txt"}}}}',
  '{"event":"result","result":{"status":"SUCCESS","response":"done","conversation_id":"conv-fake-1","duration_seconds":1.5,"num_turns":2,"usage":{"total_tokens":123}}}'
].join('\n') + '\n'
const QUOTA_OK = JSON.stringify({ ok: true, tier: 'pro', groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5 }] }], models: [] })

function mkCtx() {
  const events = []
  const sections = []
  const registered = []
  const timers = []
  let spawnLog = []
  let jobsStart = null
  const mkHandle = (text) => ({
    collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
    done: Promise.resolve({ exitCode: 0 }),
    terminate() {}
  })
  const ctx = {
    session: { id: 'sess-1' },
    get(service) {
      if (service === 'jobs') return { start(spec) { jobsStart = spec; return '7' } }
      return null
    },
    emit(ch, payload) { events.push({ ch, payload }) },
    effect(fn) { fn(); return () => {} },
    setInterval(fn, ms) { timers.push({ fn, ms }); return () => {} },
    timeout(fn, ms) { return () => {} },
    interval(fn, ms) { return () => {} },
    tools: { register(def) { registered.push(def); return () => {} } },
    systemPrompt: { section(s) { sections.push(s) } },
    subprocess: {
      resolveExecutable: async () => 'agy.exe',
      spawn(spec) {
        const joined = spec.argv.join(' ')
        spawnLog.push(spec.argv)
        if (/fake-quota/.test(joined) || /agy-quota\.mjs/.test(joined)) return mkHandle(QUOTA_OK)
        return mkHandle(AGY_NDJSON)
      }
    }
  }
  return { ctx, events, sections, registered, timers, spawnLog, jobsSpec: () => jobsStart }
}

test('模块导出契约：name/inject/apply', () => {
  assert.equal(bridgeName, 'cli-bridge-agy')
  assert.deepEqual(inject, ['tools', 'subprocess', 'systemPrompt', 'timer'])
  assert.equal(typeof apply, 'function')
})

test('apply 注册 4 工具（3 件套 + agy_quota）并挂 agy:policy 与心跳', () => {
  const prev = { bin: process.env.AGY_BIN, quota: process.env.CLI_BRIDGE_AGY_QUOTA }
  process.env.AGY_BIN = FIX('fake-agy.mjs')
  process.env.CLI_BRIDGE_AGY_QUOTA = FIX('fake-quota-ok.mjs')
  const m = mkCtx()
  try {
    apply(m.ctx)
    assert.deepEqual(m.registered.map((t) => t.name), ['agy_run', 'agy_continue', 'agy_status', 'agy_quota'])
    for (const t of m.registered) {
      assert.equal(t.parameters.type, 'object')
      assert.equal(typeof t.execute, 'function')
      assert.equal(typeof t.output.render, 'function')
    }
    // agy/mode 心跳：挂载即宣告一次 + 30s 定时器（TTL 75s 租约，契约 §2）
    const mode = m.events.filter((e) => e.ch === 'agy/mode')
    assert.ok(mode.length >= 1)
    assert.equal(mode[0].payload.active, true)
    assert.equal(mode[0].payload.sessionId, 'sess-1')
    assert.ok(m.timers.some((t) => t.ms === 30000), '30s heartbeat interval registered')
    // policy 段
    assert.equal(m.sections.length, 1)
    assert.equal(m.sections[0].name, 'agy:policy')
    assert.equal(m.sections[0].order, 2810)
    assert.match(m.sections[0].text, /agy-first execution policy/)
    assert.match(m.sections[0].text, /QUOTA_BLOCKED/)
  } finally {
    if (prev.bin === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = prev.bin
    if (prev.quota === undefined) delete process.env.CLI_BRIDGE_AGY_QUOTA; else process.env.CLI_BRIDGE_AGY_QUOTA = prev.quota
  }
})

test('agy_run foreground（background:false）→ SUCCESS + conversationId/sessionId 双写 + status 事件', async () => {
  const prev = { bin: process.env.AGY_BIN, quota: process.env.CLI_BRIDGE_AGY_QUOTA }
  process.env.AGY_BIN = FIX('fake-agy.mjs')
  process.env.CLI_BRIDGE_AGY_QUOTA = FIX('fake-quota-ok.mjs')
  const m = mkCtx()
  try {
    apply(m.ctx)
    const run = m.registered.find((t) => t.name === 'agy_run')
    const res = await run.execute({ prompt: 'hello', background: false }, undefined)
    assert.equal(res.ok, true)
    assert.equal(res.status, 'SUCCESS')
    assert.equal(res.conversationId, 'conv-fake-1')
    assert.equal(res.sessionId, 'conv-fake-1')
    assert.equal(res.mode, 'accept-edits')
    assert.equal(res.totalTokens, 123)
    // 渲染面（bridge-kit renderResult）
    const out = run.output.render({ prompt: 'hello' }, res)
    assert.match(out[0].text, /^agy OK \[status=SUCCESS mode=accept-edits session=conv-fake-1/)
    // agy/status 事件已发布（begin 与 end 各一次）
    const status = m.events.filter((e) => e.ch === 'agy/status')
    assert.ok(status.length >= 2)
    const last = status[status.length - 1].payload.snapshot
    assert.equal(last.provider, 'agy')
    assert.equal(last.projects[0].lastStatus, 'SUCCESS')
  } finally {
    if (prev.bin === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = prev.bin
    if (prev.quota === undefined) delete process.env.CLI_BRIDGE_AGY_QUOTA; else process.env.CLI_BRIDGE_AGY_QUOTA = prev.quota
  }
})

test('agy_run 默认 background=true：返回 jobId，jobs 捕获 run 可完成收口', async () => {
  const prev = { bin: process.env.AGY_BIN, quota: process.env.CLI_BRIDGE_AGY_QUOTA }
  process.env.AGY_BIN = FIX('fake-agy.mjs')
  process.env.CLI_BRIDGE_AGY_QUOTA = FIX('fake-quota-ok.mjs')
  const m = mkCtx()
  try {
    apply(m.ctx)
    const run = m.registered.find((t) => t.name === 'agy_run')
    const res = await run.execute({ prompt: 'bg task' }, { agent: 'a1', signal: undefined })
    assert.equal(res.ok, true)
    assert.equal(res.background, true)
    assert.equal(res.jobId, '7')
    const spec = m.jobsSpec()
    assert.ok(spec && spec.kind === 'bash' && /agy: /.test(spec.label))
    const controller = spec.run()
    const outcome = await controller.done
    assert.equal(outcome.status, 'completed')
    assert.equal(outcome.detail, 'agy SUCCESS')
  } finally {
    if (prev.bin === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = prev.bin
    if (prev.quota === undefined) delete process.env.CLI_BRIDGE_AGY_QUOTA; else process.env.CLI_BRIDGE_AGY_QUOTA = prev.quota
  }
})

test('agy_continue conversationId 透传 --conversation（spawn argv 校验）', async () => {
  const prev = { bin: process.env.AGY_BIN, quota: process.env.CLI_BRIDGE_AGY_QUOTA }
  process.env.AGY_BIN = FIX('fake-agy.mjs')
  process.env.CLI_BRIDGE_AGY_QUOTA = FIX('fake-quota-ok.mjs')
  const m = mkCtx()
  try {
    apply(m.ctx)
    const cont = m.registered.find((t) => t.name === 'agy_continue')
    const res = await cont.execute({ prompt: 'follow up', conversationId: 'conv-42', background: false }, undefined)
    assert.equal(res.ok, true)
    const argvs = m.spawnLog.filter((a) => !/fake-quota|agy-quota/.test(a.join(' ')))
    assert.ok(argvs.length >= 1)
    assert.ok(argvs[0].includes('--conversation') && argvs[0].includes('conv-42'), JSON.stringify(argvs[0]))
  } finally {
    if (prev.bin === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = prev.bin
    if (prev.quota === undefined) delete process.env.CLI_BRIDGE_AGY_QUOTA; else process.env.CLI_BRIDGE_AGY_QUOTA = prev.quota
  }
})

test('agy_status 返回快照对象；render 可读', async () => {
  const prev = { bin: process.env.AGY_BIN, quota: process.env.CLI_BRIDGE_AGY_QUOTA }
  process.env.AGY_BIN = FIX('fake-agy.mjs')
  process.env.CLI_BRIDGE_AGY_QUOTA = FIX('fake-quota-ok.mjs')
  const m = mkCtx()
  try {
    apply(m.ctx)
    const run = m.registered.find((t) => t.name === 'agy_run')
    await run.execute({ prompt: 'seed', background: false }, undefined)
    const status = m.registered.find((t) => t.name === 'agy_status')
    const snap = await status.execute({}, undefined)
    assert.equal(snap.provider, 'agy')
    assert.equal(snap.projects.length, 1)
    const out = status.output.render({}, snap)
    assert.match(out[0].text, /agy status: ok/)
    const filtered = await status.execute({ cwd: 'C:\\nope' }, undefined)
    assert.equal(filtered.projects.length, 0)
  } finally {
    if (prev.bin === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = prev.bin
    if (prev.quota === undefined) delete process.env.CLI_BRIDGE_AGY_QUOTA; else process.env.CLI_BRIDGE_AGY_QUOTA = prev.quota
  }
})
