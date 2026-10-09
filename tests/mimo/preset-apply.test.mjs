// tests/mimo/preset-apply.test.mjs — preset 宿主接线（mock ctx，无真 mimo/网络）。
// 覆盖：模块导出契约、4 工具注册（3 件套 + mimo_settings）、mimo/mode 心跳、
// mimo/status 发布、mimo:policy 段、前台执行路（fake exe）、后台 jobs 路、
// mimo_settings 临时 home 写盘回读、mimo 专属 LIMIT_RE 文案渲染。
// 设置文件恒指向不存在的临时路径（防读到本机真实 DSH_HOME 分区 → 测试不确定）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { name as bridgeName, inject, apply } from '../../preset/mimo-first/cli-bridge.mjs'

const FIX = (f) => fileURLToPath(new URL('./fixtures/' + f, import.meta.url))
const MIMO_NDJSON = [
  '{"type":"session","properties":{"id":"ses_fake_1"}}',
  '{"type":"tool","properties":{"tool":"bash","arguments":{"command":"ls"}}}',
  '{"type":"text","sessionID":"ses_fake_1","text":"done"}'
].join('\n') + '\n'
const MIMO_LIMIT_NDJSON = '{"type":"error","sessionID":"ses_e","error":{"name":"UnknownError","data":{"message":"MiMo free API service has ended. Sign in or configure a third-party API."}}}\n'

function mkCtx() {
  const events = []
  const sections = []
  const registered = []
  const timers = []
  const spawnLog = []
  let jobsStart = null
  const mkHandle = (text, exitCode) => ({
    collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
    done: Promise.resolve({ exitCode: exitCode == null ? 0 : exitCode }),
    terminate() {}
  })
  const ctx = {
    session: { id: 'sess-1' },
    get(service) {
      if (service === 'jobs') return { start(spec) { jobsStart = spec; return '7' } }
      if (service === 'sandboxPolicy') return { workspaceRoot: 'C:\\ws' }
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
      resolveExecutable: async () => 'mimo.exe',
      spawn(spec) {
        spawnLog.push(spec.argv)
        const joined = spec.argv.join(' ')
        if (/fake-mimo-limit/.test(joined)) return mkHandle(MIMO_LIMIT_NDJSON, 1)
        return mkHandle(MIMO_NDJSON, 0)
      }
    }
  }
  return { ctx, events, sections, registered, timers, spawnLog, jobsSpec: () => jobsStart }
}

// 关键纪律：async 版 withEnv —— 同步版会在 fn 的第一个 await 处提前还原 env，
// 测试中后段就会读到本机真实 DSH_HOME 分区（曾因此把 mimo-desktop 误当预选）。
async function withEnv(vars, fn) {
  const prev = {}
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === null) delete process.env[k]; else process.env[k] = vars[k] }
  try { return await fn() } finally {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] }
  }
}
const EXEC = { agent: 'a1', signal: undefined }

test('模块导出契约：name/inject/apply', () => {
  assert.equal(bridgeName, 'cli-bridge-mimo')
  assert.deepEqual(inject, ['tools', 'subprocess', 'systemPrompt', 'timer'])
  assert.equal(typeof apply, 'function')
})

test('apply 注册 4 工具（3 件套 + mimo_settings）并挂 mimo:policy 与心跳', () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-bridge-mimo-t-'))
  try {
    withEnv({ MIMO_BIN: FIX('fake-mimo.mjs'), CLI_BRIDGE_SETTINGS_FILE: join(home, 'nope.json'), DSH_HOME: home }, () => {
      const m = mkCtx()
      apply(m.ctx)
      assert.deepEqual(m.registered.map((t) => t.name), ['mimo_run', 'mimo_continue', 'mimo_status', 'mimo_settings'])
      for (const t of m.registered) {
        assert.equal(t.parameters.type, 'object')
        assert.equal(typeof t.execute, 'function')
        assert.equal(typeof t.output.render, 'function')
      }
      // mimo/mode 心跳：挂载即宣告一次 + 30s 定时器（TTL 75s 租约，契约 §2）
      const mode = m.events.filter((e) => e.ch === 'mimo/mode')
      assert.ok(mode.length >= 1, 'mode announced')
      assert.equal(mode[0].payload.active, true)
      assert.equal(mode[0].payload.sessionId, 'sess-1')
      assert.ok(m.timers.some((t) => t.ms === 30000), '30s heartbeat interval registered')
      // policy 段
      assert.equal(m.sections.length, 1)
      assert.equal(m.sections[0].name, 'mimo:policy')
      assert.equal(m.sections[0].order, 2810)
      assert.match(m.sections[0].text, /mimo-first execution policy/)
      assert.match(m.sections[0].text, /mimo-desktop/)
    })
  } finally { try { rmSync(home, { recursive: true, force: true }) } catch (e) {} }
})

test('mimo_run 前台（background=false）走 fake-mimo fixture → SUCCESS + session + status 事件', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-bridge-mimo-t-'))
  try {
    await withEnv({ MIMO_BIN: FIX('fake-mimo.mjs'), CLI_BRIDGE_SETTINGS_FILE: join(home, 'nope.json'), DSH_HOME: home }, async () => {
      const m = mkCtx()
      apply(m.ctx)
      const run = m.registered.find((t) => t.name === 'mimo_run')
      const res = await run.execute({ prompt: 'seed', background: false }, EXEC)
      assert.equal(res.ok, true)
      assert.equal(res.status, 'SUCCESS')
      assert.equal(res.backend, 'mimocode')
      assert.equal(res.sessionId, 'ses_fake_1')
      assert.match(m.spawnLog[0].join(' '), /--format json/)
      const out = run.output.render({ prompt: 'seed' }, res)
      assert.match(out[0].text, /^mimo OK \[status=SUCCESS/)
      // mimo/status 事件已发布（begin 与 end 各一次）
      const statusEvents = m.events.filter((e) => e.ch === 'mimo/status')
      assert.ok(statusEvents.length >= 2)
      const last = statusEvents[statusEvents.length - 1].payload.snapshot
      assert.equal(last.provider, 'mimo')
      assert.equal(last.projects[0].lastStatus, 'SUCCESS')
    })
  } finally { try { rmSync(home, { recursive: true, force: true }) } catch (e) {} }
})

test('mimo_run 默认 background=true：返回 jobId，jobs 捕获 run 可完成收口', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-bridge-mimo-t-'))
  try {
    await withEnv({ MIMO_BIN: FIX('fake-mimo.mjs'), CLI_BRIDGE_SETTINGS_FILE: join(home, 'nope.json'), DSH_HOME: home }, async () => {
      const m = mkCtx()
      apply(m.ctx)
      const run = m.registered.find((t) => t.name === 'mimo_run')
      const res = await run.execute({ prompt: 'bg task' }, EXEC)
      assert.equal(res.ok, true)
      assert.equal(res.background, true)
      assert.equal(res.jobId, '7')
      const spec = m.jobsSpec()
      assert.ok(spec && spec.kind === 'bash' && /^mimo: /.test(spec.label))
      const controller = spec.run()
      const outcome = await controller.done
      assert.equal(outcome.status, 'completed')
      assert.equal(outcome.detail, 'mimo SUCCESS')
    })
  } finally { try { rmSync(home, { recursive: true, force: true }) } catch (e) {} }
})

test('mimo_continue sessionId 透传 --session（spawn argv 校验）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-bridge-mimo-t-'))
  try {
    await withEnv({ MIMO_BIN: FIX('fake-mimo.mjs'), CLI_BRIDGE_SETTINGS_FILE: join(home, 'nope.json'), DSH_HOME: home }, async () => {
      const m = mkCtx()
      apply(m.ctx)
      const cont = m.registered.find((t) => t.name === 'mimo_continue')
      const res = await cont.execute({ prompt: 'follow up', sessionId: 'ses_42', background: false }, EXEC)
      assert.equal(res.ok, true)
      assert.ok(m.spawnLog[0].includes('--session') && m.spawnLog[0].includes('ses_42'), JSON.stringify(m.spawnLog[0]))
      const latest = await cont.execute({ prompt: 'more', latest: true, background: false }, EXEC)
      assert.equal(latest.ok, true)
      assert.ok(m.spawnLog[1].includes('--continue'), 'latest → --continue')
    })
  } finally { try { rmSync(home, { recursive: true, force: true }) } catch (e) {} }
})

test('mimo_status 有 session 快照；输出可渲染；cwd 过滤', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-bridge-mimo-t-'))
  try {
    await withEnv({ MIMO_BIN: FIX('fake-mimo.mjs'), CLI_BRIDGE_SETTINGS_FILE: join(home, 'nope.json'), DSH_HOME: home }, async () => {
      const m = mkCtx()
      apply(m.ctx)
      const run = m.registered.find((t) => t.name === 'mimo_run')
      await run.execute({ prompt: 'seed', background: false }, EXEC)
      const status = m.registered.find((t) => t.name === 'mimo_status')
      const snap = await status.execute({}, undefined)
      assert.equal(snap.provider, 'mimo')
      assert.equal(snap.projects.length, 1)
      const out = status.output.render({}, snap)
      assert.match(out[0].text, /mimo status/)
      const filtered = await status.execute({ cwd: 'C:\\nope' }, undefined)
      assert.equal(filtered.projects.length, 0)
    })
  } finally { try { rmSync(home, { recursive: true, force: true }) } catch (e) {} }
})

test('mimo_settings 在 preset 宿主有 nodeFs → saved 写盘 + 读回（临时 home）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-bridge-mimo-set-'))
  try {
    await withEnv({ MIMO_BIN: FIX('fake-mimo.mjs'), CLI_BRIDGE_SETTINGS_FILE: null, DSH_HOME: home }, async () => {
      const m = mkCtx()
      apply(m.ctx)
      const settings = m.registered.find((t) => t.name === 'mimo_settings')
      const v = await settings.execute({ backend: 'mimo-desktop' }, undefined)
      assert.equal(v.ok, true)
      assert.equal(v.fileBackend, 'mimo-desktop')
      assert.equal(v.saved, true, 'preset form persists via nodeFs')
      const file = join(home, 'cli-bridge-settings.json')
      const all = JSON.parse(readFileSync(file, 'utf8'))
      assert.equal(all.mimo.preferredBackend, 'mimo-desktop')
      // 渲染面（renderSettings 旧行 verbatim）
      const out = settings.output.render({}, v)
      assert.match(out[0].text, /mimo settings/)
      assert.match(out[0].text, /file backend   : mimo-desktop/)
    })
  } finally { try { rmSync(home, { recursive: true, force: true }) } catch (e) {} }
})

test('fake-mimo-limit 前台 → UnknownError + mimo 专属文案渲染（LIMIT_RE 覆盖 sign in/第三方）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-bridge-mimo-t-'))
  try {
    await withEnv({ MIMO_BIN: FIX('fake-mimo-limit.mjs'), CLI_BRIDGE_SETTINGS_FILE: join(home, 'nope.json'), DSH_HOME: home }, async () => {
      const m = mkCtx()
      apply(m.ctx)
      const run = m.registered.find((t) => t.name === 'mimo_run')
      const res = await run.execute({ prompt: 'seed', background: false }, EXEC)
      assert.equal(res.ok, false)
      assert.equal(res.status, 'UnknownError')
      const rendered = run.output.render({}, res)[0].text
      assert.match(rendered, /FAILED \[status=UnknownError/)
      assert.match(rendered, /登录|第三方/, 'mimo-flavored hint (kit LIMIT_RE alone would miss this)')
    })
  } finally { try { rmSync(home, { recursive: true, force: true }) } catch (e) {} }
})
