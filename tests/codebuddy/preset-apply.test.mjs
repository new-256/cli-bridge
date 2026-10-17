// tests/codebuddy/preset-apply.test.mjs — preset 宿主接线（mock ctx，无真 codebuddy/网络）。
// 覆盖：工具注册、codebuddy/mode 心跳（sessionId 兜底通道）、codebuddy/status 发布、
// codebuddy:policy 段、前台/后台/plan/续接/瞬时重试/限流弹窗/EN-preflight 早退。
// 纪律（mimo 侧真实事故）：withEnv 为 async 版；每个用例显式钉 CLI_BRIDGE_SETTINGS_FILE
// / CODEBUDDY_SETTINGS_FILE / LOCALAPPDATA / DSH_HOME / CODEBUDDY_CREDENTIALS_DIR 到
// tmp —— 测试永不读写真实设置与真实凭据目录。
import test from 'node:test'
import assert from 'node:assert/strict'

import { name as bridgeName, inject, apply } from '../../preset/codebuddy-first/cli-bridge.mjs'
import { withEnv, freshTmp } from './helpers/env.mjs'
import { CB_NDJSON } from './helpers/env.mjs'

const CB_NDJSON_ERR = '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"","session_id":"x"}'

function mkCtx(opts = {}) {
  const events = [], sections = [], registered = [], timers = [], disposers = [], spawnLog = [], uqAsks = []
  let jobsStart = null
  const queue = (opts.queue || []).slice()
  const mkHandle = (text, exitCode, stderrText) => ({
    collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: stderrText || '' }) } },
    done: Promise.resolve({ exitCode: exitCode == null ? 0 : exitCode }),
    terminate() {}
  })
  const ctx = {
    session: { id: 'sess-1' },
    get(service) {
      if (service === 'jobs') return { start(spec) { jobsStart = spec; return '7' } }
      if (service === 'userQuestions') return { ask(q) { uqAsks.push(q); return Promise.resolve({ answers: [{ selected: opts.uqSelect || [] }] }) } }
      if (service === 'agents') return { currentInitiator: () => ({ id: 'sess-init-1' }) }
      if (service === 'planMode') return opts.planActive ? { get: () => ({ active: true }) } : null
      if (service === 'sandboxPolicy') return opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : null
      return null
    },
    emit(ch, payload) { events.push({ ch, payload }) },
    effect(fn) { const c = fn(); if (typeof c === 'function') disposers.push(c); return () => {} },
    setInterval(fn, ms) { timers.push({ fn, ms }); return () => {} },
    timeout(fn, ms) { return () => {} },
    interval(fn, ms) { return () => {} },
    tools: { register(def) { registered.push(def); return () => {} } },
    systemPrompt: { section(s) { sections.push(s); return () => {} } },
    subprocess: {
      resolveExecutable: async () => 'codebuddy.exe',
      spawn(spec) {
        spawnLog.push(spec.argv)
        const scripted = queue.shift()
        if (scripted) return mkHandle(scripted.text, scripted.exitCode, scripted.stderr)
        return mkHandle(CB_NDJSON)
      }
    }
  }
  return { ctx, events, sections, registered, timers, disposers, spawnLog, uqAsks, jobsSpec: () => jobsStart }
}

// 统一 env 钉（Lead 坑 1）：所有设置/凭据/授权目录触点指 tmp，auth token 清空。
function pinEnv(extra) {
  const tmp = freshTmp('cbtest-pin-')
  return Object.assign({
    CLI_BRIDGE_SETTINGS_FILE: tmp + '\\nonexist.json',
    CODEBUDDY_SETTINGS_FILE: tmp + '\\nonexist-legacy.json',
    CODEBUDDY_AUTH_TOKEN: null,
    CODEBUDDY_CREDENTIALS_DIR: tmp + '\\creds',
    LOCALAPPDATA: tmp + '\\appdata',
    DSH_HOME: tmp,
    WORKBUDDY_BIN: null,
    CODEBUDDY_EN_BIN: null
  }, extra || {})
}

test('模块导出契约：name/inject/apply', () => {
  assert.equal(bridgeName, 'cli-bridge-codebuddy')
  assert.deepEqual(inject, ['tools', 'subprocess', 'systemPrompt', 'timer'])
  assert.equal(typeof apply, 'function')
})

test('apply 注册 3 工具 + codebuddy_models + codebuddy:policy 段 + 心跳/租约/dispose', async () => {
  await withEnv(pinEnv(), async () => {
    const m = mkCtx()
    apply(m.ctx)
    // 新增第四件 codebuddy_models（模型清单）；前三件名与顺序是 verbatim 红线。
    assert.deepEqual(m.registered.map((t) => t.name), ['codebuddy_run', 'codebuddy_continue', 'codebuddy_status', 'codebuddy_models'])
    for (const t of m.registered) {
      assert.equal(t.parameters.type, 'object')
      assert.equal(typeof t.execute, 'function')
      assert.equal(typeof t.output.render, 'function')
      assert.equal(t.output.render.length, 2, 'render(args,value) 双参形态（Lead 坑 2）')
    }
    // mode 心跳：挂载即宣告 + 本会话 sessionId（currentInitiator 通道）
    const mode = m.events.filter((e) => e.ch === 'codebuddy/mode')
    assert.ok(mode.length >= 1)
    assert.equal(mode[0].payload.active, true)
    assert.equal(mode[0].payload.sessionId, 'sess-init-1')
    assert.ok(m.timers.some((t) => t.ms === 30000), '30s heartbeat interval')
    // policy 段（旧 preset verbatim：order 5）
    assert.equal(m.sections.length, 1)
    assert.equal(m.sections[0].name, 'codebuddy:policy')
    assert.equal(m.sections[0].order, 5)
    assert.equal(m.sections[0].text.length, 6970, 'POLICY_TEXT 字节锚（与 provider 同源）')
    // dispose → 撤销宣告
    for (const d of m.disposers) d()
    const lastMode = m.events.filter((e) => e.ch === 'codebuddy/mode').slice(-1)[0]
    assert.equal(lastMode.payload.active, false)
  })
})

test('codebuddy_run 前台 → SUCCESS + 双写 session + status 事件发布（begin+end）', async () => {
  const ROOT = freshTmp('cbtest-root-')
  await withEnv(pinEnv(), async () => {
    const m = mkCtx({ workspaceRoot: ROOT })
    apply(m.ctx)
    const run = m.registered.find((t) => t.name === 'codebuddy_run')
    const res = await run.execute({ prompt: 'hello' }, { agent: 'a1' })
    assert.equal(res.ok, true)
    assert.equal(res.status, 'SUCCESS')
    assert.equal(res.sessionId, 'fake-s1')
    assert.equal(res.totalTokens, 15)
    assert.equal(res.backend, 'codebuddy')
    const out = run.output.render({ prompt: 'hello' }, res)
    assert.match(out[0].text, /^codebuddy OK \[status=SUCCESS mode=bypassPermissions model=hy3 session=fake-s1/)
    const status = m.events.filter((e) => e.ch === 'codebuddy/status')
    assert.ok(status.length >= 2)
    const last = status[status.length - 1].payload.snapshot
    assert.equal(last.provider, 'codebuddy')
    assert.equal(last.projects[0].cwd, ROOT, 'sandboxPolicy.workspaceRoot 作为 cwd 回落（旧 verbatim）')
    assert.equal(last.projects[0].lastStatus, 'SUCCESS')
    assert.equal(last.projects[0].runs, 1)
  })
})

test('noteSession 兜底通道：apply 时无 currentInitiator → 第一次调用从 exec.agent 补记', async () => {
  await withEnv(pinEnv(), async () => {
    const m = mkCtx()
    m.ctx.get = (service) => {
      if (service === 'jobs') return { start: () => '9' }
      if (service === 'agents') return { currentInitiator: () => null }
      return null
    }
    apply(m.ctx)
    const modeBefore = m.events.filter((e) => e.ch === 'codebuddy/mode')
    assert.equal(modeBefore[0].payload.sessionId, undefined, 'apply 阶段拿不到身份 → 旧全局语义')
    const run = m.registered.find((t) => t.name === 'codebuddy_run')
    await run.execute({ prompt: 'hi' }, { agent: { id: 'sess-late-1' } })
    const modeAfter = m.events.filter((e) => e.ch === 'codebuddy/mode')
    assert.ok(modeAfter.slice(-1)[0].payload.sessionId === 'sess-late-1', 'exec.agent 补记 + 重新宣告')
  })
})

test('codebuddy_run background=true → jobId 回执；job spec.run() 收口 completed', async () => {
  await withEnv(pinEnv(), async () => {
    const m = mkCtx()
    apply(m.ctx)
    const run = m.registered.find((t) => t.name === 'codebuddy_run')
    const res = await run.execute({ prompt: 'bg task', background: true }, { agent: 'a1', signal: undefined })
    assert.equal(res.ok, true)
    assert.equal(res.background, true)
    assert.equal(res.jobId, '7')
    assert.match(res.note, /running in background; collect with job_output 7/)
    const spec = m.jobsSpec()
    assert.ok(spec && spec.kind === 'bash' && /^codebuddy: /.test(spec.label))
    const outcome = await spec.run().done
    assert.equal(outcome.status, 'completed')
    assert.equal(outcome.detail, 'codebuddy SUCCESS')
  })
})

test('DSH plan 态 → argv --permission-mode plan + --allowedTools Bash（kit planActiveFor）', async () => {
  await withEnv(pinEnv(), async () => {
    const m = mkCtx({ planActive: true })
    apply(m.ctx)
    const run = m.registered.find((t) => t.name === 'codebuddy_run')
    const res = await run.execute({ prompt: 'read only' }, { agent: 'a1' })
    assert.equal(res.ok, true)
    const argv = m.spawnLog[0]
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'plan')
    assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'Bash')
  })
})

test('codebuddy_continue：sessionId → --resume 透传；latest → --continue', async () => {
  await withEnv(pinEnv(), async () => {
    const m = mkCtx()
    apply(m.ctx)
    const cont = m.registered.find((t) => t.name === 'codebuddy_continue')
    const r1 = await cont.execute({ prompt: 'more', sessionId: 'sess-42' }, { agent: 'a1' })
    assert.equal(r1.ok, true)
    assert.ok(m.spawnLog[0].includes('--resume') && m.spawnLog[0].includes('sess-42'), JSON.stringify(m.spawnLog[0]))
    const r2 = await cont.execute({ prompt: 'more', latest: true }, { agent: 'a1' })
    assert.equal(r2.ok, true)
    assert.ok(m.spawnLog[1].includes('--continue'), JSON.stringify(m.spawnLog[1]))
  })
})

test('空 prompt → BAD_ARGS（不进 spawn）', async () => {
  await withEnv(pinEnv(), async () => {
    const m = mkCtx()
    apply(m.ctx)
    const run = m.registered.find((t) => t.name === 'codebuddy_run')
    const res = await run.execute({ prompt: '   ' }, { agent: 'a1' })
    assert.equal(res.status, 'BAD_ARGS')
    assert.equal(res.stderr, 'prompt is required')
    assert.equal(m.spawnLog.length, 0)
  })
})

test('瞬时错误静默自动重试一次（第二次成功 → ok，不弹窗）', async () => {
  await withEnv(pinEnv(), async () => {
    const m = mkCtx({ queue: [{ text: CB_NDJSON_ERR, exitCode: 1, stderr: '' }] })
    apply(m.ctx)
    const run = m.registered.find((t) => t.name === 'codebuddy_run')
    const res = await run.execute({ prompt: 'flaky' }, { agent: 'a1' })
    assert.equal(res.ok, true, '第二次默认成功')
    assert.equal(m.spawnLog.length, 2, '恰好重试 1 次')
    assert.equal(m.uqAsks.length, 0, '瞬时错误不弹回退窗')
  })
})

test('限流失败 → userQuestions 弹窗（中文状态问题文案）→ 选回退 → FALLBACK_TO_DSH', async () => {
  await withEnv(pinEnv(), async () => {
    const m = mkCtx({
      queue: [{ text: CB_NDJSON_ERR, exitCode: 1, stderr: '请求过于频繁，已触发流量限制' }],
      uqSelect: ['使用 DSH 本地 API 配置（回退）']
    })
    apply(m.ctx)
    const run = m.registered.find((t) => t.name === 'codebuddy_run')
    const res = await run.execute({ prompt: 'x' }, { agent: 'a1' })
    assert.equal(res.status, 'FALLBACK_TO_DSH')
    assert.equal(res.fallback, true)
    assert.equal(m.uqAsks.length, 1, '弹窗一次')
    const q = m.uqAsks[0].questions[0]
    assert.equal(q.id, 'codebuddy-fallback')
    assert.match(q.question, /疑似流量受限\/网络不通，状态=ERROR_DURING_EXECUTION/)
    assert.deepEqual(q.options.map((o) => o.label), ['使用 DSH 本地 API 配置（回退）', '重试 codebuddy 一次', '不回退（返回错误）'])
    const out = run.output.render({ prompt: 'x' }, res)
    assert.match(out[0].text, /回退/)
  })
})

test('EN 面无凭据 → preflight 早退 AUTH_REQUIRED（零 spawn）', async () => {
  await withEnv(pinEnv(), async () => {
    const m = mkCtx()
    apply(m.ctx)
    const run = m.registered.find((t) => t.name === 'codebuddy_run')
    const res = await run.execute({ prompt: 'x', backend: 'codebuddy-en' }, { agent: 'a1' })
    assert.equal(res.status, 'AUTH_REQUIRED')
    assert.equal(res.ok, false)
    assert.match(res.stderr, /protector key/)
    assert.equal(m.spawnLog.length, 0)
  })
})

test('codebuddy_status：全量快照 + cwd 过滤（旧 preset verbatim）', async () => {
  const ROOT = freshTmp('cbtest-root-')
  await withEnv(pinEnv(), async () => {
    const m = mkCtx({ workspaceRoot: ROOT })
    apply(m.ctx)
    const run = m.registered.find((t) => t.name === 'codebuddy_run')
    await run.execute({ prompt: 'seed' }, { agent: 'a1' })
    const status = m.registered.find((t) => t.name === 'codebuddy_status')
    const snap = await status.execute({})
    assert.equal(snap.provider, 'codebuddy')
    assert.equal(snap.projects.length, 1)
    assert.equal(snap.runs, 1)
    assert.equal(snap.totalTokens, 15, '全局聚合 tokens（kit engine）')
    const out = status.output.render({}, snap)
    assert.match(out[0].text, /codebuddy status/)
    const filtered = await status.execute({ cwd: 'C:\\nope' })
    assert.equal(filtered.projects.length, 0)
  })
})
