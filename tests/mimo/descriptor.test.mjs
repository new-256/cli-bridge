// tests/mimo/descriptor.test.mjs — providers/mimo.mjs 描述符契约与移植语义。
import test from 'node:test'
import assert from 'node:assert/strict'

import defineProvider from '../../providers/mimo.mjs'

const provider = defineProvider({ env: {} })

test('契约 ★ 字段齐备（PROVIDER-CONTRACT.md §1）', () => {
  assert.equal(provider.id, 'mimo')
  assert.equal(provider.label, 'MIMO')
  assert.equal(provider.presetId, 'cordis-mimo')
  assert.equal(provider.defaultBackend, 'mimocode')
  assert.equal(provider.defaultMode, 'auto')
  assert.equal(provider.exeName, 'mimo')
  assert.deepEqual(provider.binEnvVars, ['MIMO_BIN', 'MIMO_CLI'])
  assert.equal(provider.unavailableStatus, 'MIMO_UNAVAILABLE')
  for (const f of ['backends', 'normalizeBackend', 'resolveBackend', 'buildArgv', 'parseJson', 'buildResult', 'runToolLogic', 'continueToolLogic', 'statusToolLogic', 'attach', 'delegates', 'preflight', 'execute', 'foldStreamEvent', 'isLimited', 'failureHint', 'isSuccessStatus']) {
    assert.equal(typeof provider[f], 'function', f + ' must be a function')
  }
  assert.equal(provider.tools.run.name, 'mimo_run')
  assert.equal(provider.tools.continue.name, 'mimo_continue')
  assert.equal(provider.tools.status.name, 'mimo_status')
  assert.equal(provider.extraTools[0].name, 'mimo_settings')
})

test('normalizeBackend：别名归一（旧 runtime-settings verbatim）', () => {
  assert.deepEqual(provider.backends(), ['mimocode', 'mimo-desktop'])
  for (const v of ['mimocode', 'mimo-code', 'CLI', 'mimo-cli', ' MiMoCode ']) {
    assert.equal(provider.normalizeBackend(v), 'mimocode', 'normalizeBackend(' + String(v) + ')')
  }
  for (const v of ['mimo-desktop', 'desktop', 'mimo_desktop', 'Xiaomi-Mimo', 'xiaomi-mimo-desktop']) {
    assert.equal(provider.normalizeBackend(v), 'mimo-desktop', 'normalizeBackend(' + String(v) + ')')
  }
  for (const v of ['bogus', '', null, undefined]) {
    assert.equal(provider.normalizeBackend(v), null, 'normalizeBackend(' + String(v) + ')')
  }
})

test('resolveBackend：arg > preferred > default（预选链）', () => {
  assert.equal(provider.resolveBackend({ backend: 'desktop' }, null, 'mimocode'), 'mimo-desktop')
  assert.equal(provider.resolveBackend({}, null, 'mimo-desktop'), 'mimo-desktop')
  assert.equal(provider.resolveBackend({}, null, 'bogus'), 'mimocode')
  assert.equal(provider.resolveBackend({}, null, null), 'mimocode')
})

test('delegates：仅 mimo-desktop 委托 provider.execute（Lead 定案 1）', () => {
  assert.equal(provider.delegates('mimo-desktop'), true)
  assert.equal(provider.delegates('mimocode'), false)
})

// ── buildArgv（旧 core L213-241 verbatim）────────────────────────────────────
test('buildArgv mimocode 基础旗标：run + --format json + 免提示 + 默认 build', () => {
  const b = provider.buildArgv('mimo', { prompt: 'do it' }, { planActive: false, backend: 'mimocode' })
  assert.deepEqual(b.argv.slice(0, 5), ['mimo', 'run', 'do it', '--format', 'json'])
  assert.ok(b.argv.includes('--dangerously-skip-permissions'))
  assert.equal(b.argv[b.argv.indexOf('--agent') + 1], 'build')
  assert.equal(b.timeoutSec, 600)
})

test('buildArgv auto 跟随 DSH plan 态；accept-edits 映射 build', () => {
  const planB = provider.buildArgv('mimo', { prompt: 'x' }, { planActive: true, backend: 'mimocode' })
  assert.equal(planB.argv[planB.argv.indexOf('--agent') + 1], 'plan')
  assert.equal(planB.mode, 'plan')
  const b = provider.buildArgv('mimo', { prompt: 'x', mode: 'accept-edits' }, { backend: 'mimocode' })
  assert.ok(b.argv.join(' ').includes('--agent build'))
})

test('buildArgv 全旗标组合：--model/--variant/--dir/--session/--title 顺序稳定', () => {
  const b = provider.buildArgv(['mimo'], {
    prompt: 'p', mode: 'plan', model: 'mimo/mimo', effort: 'low',
    cwd: 'C:\\x', sessionId: 'ses_1', title: 'T', timeoutSec: 90
  }, { backend: 'mimocode' })
  const argv = b.argv
  assert.equal(argv[0], 'mimo')
  assert.deepEqual(argv.slice(1, 4), ['run', 'p', '--format'])
  assert.ok(argv.indexOf('--agent') < argv.indexOf('--model'), 'agent precedes model')
  assert.equal(argv[argv.indexOf('--model') + 1], 'mimo/mimo')
  assert.equal(argv[argv.indexOf('--variant') + 1], 'minimal', 'effort low→minimal')
  assert.equal(argv[argv.indexOf('--dir') + 1], 'C:\\x')
  assert.equal(argv[argv.indexOf('--session') + 1], 'ses_1')
  assert.equal(argv[argv.indexOf('--title') + 1], 'T')
  assert.ok(!argv.includes('--continue'), '--session wins over --continue')
  assert.equal(b.timeoutSec, 90)
})

test('buildArgv effort 映射：high→high、medium 不发 --variant（旧语义）', () => {
  assert.ok(!provider.buildArgv('mimo', { prompt: 'x', effort: 'medium' }, { backend: 'mimocode' }).argv.includes('--variant'))
  const hi = provider.buildArgv('mimo', { prompt: 'x', effort: 'high' }, { backend: 'mimocode' }).argv
  assert.equal(hi[hi.indexOf('--variant') + 1], 'high')
})

test('buildArgv continueLatest → --continue', () => {
  assert.ok(provider.buildArgv('mimo', { prompt: 'x', continueLatest: true }, { backend: 'mimocode' }).argv.includes('--continue'))
})

test('buildArgv timeoutSec 夹取（10..3600，默认 600）', () => {
  const cases = [[undefined, 600], [5, 10], [99999, 3600], ['42.7', 42], ['abc', 600], [0, 10]]
  for (const [input, want] of cases) {
    const b = provider.buildArgv('mimo', { prompt: 'x', timeoutSec: input }, { backend: 'mimocode' })
    assert.equal(b.timeoutSec, want, 'timeoutSec(' + String(input) + ')')
  }
})

test('buildArgv mimo-desktop：空壳 argv（非 spawn 路径，交 execute）', () => {
  const b = provider.buildArgv('mimo', { prompt: 'x' }, { backend: 'mimo-desktop' })
  assert.deepEqual(b.argv, [])
  assert.equal(b.mode, 'auto')
  assert.equal(b.timeoutSec, 600)
})

// ── parseJson / buildResult（旧 core verbatim）───────────────────────────────
test('parseMimoJson：sessionID/text/error/step_update tokens', () => {
  const p = provider.parseJson([
    '{"type":"session","properties":{"id":"ses_a"}}',
    '{"type":"tool","properties":{"tool":"bash","arguments":{"command":"ls"}}}',
    '{"type":"text","text":"Hello","sessionID":"ses_b"}',
    '{"type":"step_update","properties":{"tokens":{"total":42}}}'
  ].join('\n'))
  assert.equal(p.sessionId, 'ses_b')
  assert.equal(p.text, 'Hello')
  assert.equal(p.totalTokens, 42)
})

test('buildResult：成功 SUCCESS；error → failed + errorName；accepted 无 text → ACCEPTED', () => {
  const ok = provider.buildResult(provider.parseJson('{"type":"text","text":"PONG","sessionID":"ses_x"}'), { exitCode: 0 }, 'build', '', '', 'mimocode')
  assert.equal(ok.ok, true)
  assert.equal(ok.status, 'SUCCESS')
  assert.equal(ok.sessionId, 'ses_x')
  const err = provider.buildResult(provider.parseJson('{"type":"error","sessionID":"ses_e","error":{"name":"UnknownError","data":{"message":"boom"}}}'), { exitCode: 1 }, 'build', '', '', 'mimocode')
  assert.equal(err.ok, false)
  assert.equal(err.status, 'UnknownError')
  const acc = provider.buildResult({ text: '', sessionId: 's', accepted: true }, { exitCode: 0 }, 'auto', '', '', 'mimo-desktop')
  assert.equal(acc.ok, true)
  assert.equal(acc.status, 'ACCEPTED')
})

test('isSuccessStatus：ACCEPTED 计入成功态（指示灯不红，契约 §1）', () => {
  assert.equal(provider.isSuccessStatus('SUCCESS'), true)
  assert.equal(provider.isSuccessStatus('ACCEPTED'), true)
  assert.equal(provider.isSuccessStatus('ERROR'), false)
  assert.equal(provider.isSuccessStatus(null), false)
})

// ── isLimited（mimo 专属 LIMIT_RE 覆盖 kit 版）───────────────────────────────
test('isLimited：MiMo 免费 API/登录/第三方文案命中；普通异常不命中', () => {
  const free = { ok: false, status: 'UnknownError', stderr: 'MiMo free API service has ended. Sign in or configure a third-party API.' }
  assert.equal(provider.isLimited(free), true, 'free-API wording must be limited')
  assert.equal(provider.isLimited({ ok: false, stderr: '请先登录' }), true)
  assert.equal(provider.isLimited({ ok: false, stderr: 'TypeError: x is not a function' }), false)
  assert.equal(provider.isLimited({ ok: false, status: 'MIMO_UNAVAILABLE' }), true)
  assert.equal(provider.isLimited({ ok: false, status: 'HUNG_TIMEOUT' }), true)
  assert.equal(provider.isLimited({ ok: true, status: 'SUCCESS' }), false)
})

test('failureHint：MIMO_UNAVAILABLE / DESKTOP_UNREACHABLE / SESSION_NOT_CREATED / free-API 中文指引', () => {
  assert.match(provider.failureHint({ ok: false, status: 'MIMO_UNAVAILABLE' }), /MIMO_BIN/)
  assert.match(provider.failureHint({ ok: false, status: 'DESKTOP_UNREACHABLE' }), /mimocode/)
  assert.match(provider.failureHint({ ok: false, status: 'DESKTOP_SESSION_NOT_CREATED' }), /sessionId/)
  assert.match(provider.failureHint({ ok: false, status: 'X', stderr: 'free API service has ended' }), /登录|第三方/)
  assert.equal(provider.failureHint({ ok: true }), '')
})

// ── preflight（契约 §9：dynamic 无 fetch / 无 fs 发现 → abort DESKTOP_UNREACHABLE）─
test('preflight：mimocode 放行；desktop 沙箱（无 fs 发现）abort DESKTOP_UNREACHABLE 并提示 mimocode', () => {
  assert.equal(provider.preflight({ backend: 'mimocode' }), null)
  const pre = provider.preflight({ backend: 'mimo-desktop' })
  assert.ok(pre && pre.abort, 'desktop must abort when api not discoverable (env {} + no nodeFs)')
  assert.equal(pre.abort.status, 'DESKTOP_UNREACHABLE')
  assert.match(pre.abort.errorMessage, /mimocode/)
  assert.equal(pre.abort.backend, 'mimo-desktop')
})

// ── settings 分区（契约 §3）─────────────────────────────────────────────────
test('settings.keys 是 preferredBackend/desktopModel（迁移由 keystone 做，Lead 定案 8）', () => {
  assert.deepEqual(provider.settings.keys, ['preferredBackend', 'desktopModel'])
  assert.deepEqual(provider.settings.defaults(), { preferredBackend: 'mimocode', desktopModel: 'mimo-auto' })
  assert.deepEqual(provider.settings.normalize({ preferredBackend: 'desktop', desktopModel: '  mimo-pro  ', junk: 1 }), { preferredBackend: 'mimo-desktop', desktopModel: 'mimo-pro' })
  assert.deepEqual(provider.settings.normalize({ preferredBackend: 'bogus' }), { preferredBackend: 'mimocode', desktopModel: 'mimo-auto' })
})

test('settings.meta：titleSuffix MiMo + select/text 字段（GUI 渲染契约）', () => {
  const m = provider.settings.meta()
  assert.equal(m.titleSuffix, 'MiMo')
  const keys = m.fields.map((f) => f.key)
  assert.deepEqual(keys, ['preferredBackend', 'desktopModel'])
  assert.equal(m.fields[0].type, 'select')
  assert.equal(m.fields[1].type, 'text')
})

test('settings.diagnose 同步返回字符串（无 fetch → 空串）', () => {
  const d = provider.settings.diagnose({ preferredBackend: 'mimocode' })
  assert.equal(typeof d, 'string')
})

// ── mimo-desktop 回读回归锁（Lead：delivered = accepted && verified !== false）─
test('desktopSendTurn：202 但会话列表无该 id → delivered=false（实测事故回归锁）', async () => {
  const routes = []
  const prev = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    routes.push({ u, method: init && init.method })
    let body = '{}'
    if (u.includes('/v1/health')) body = '{"ok":true}'
    else if (u.includes('/turns')) body = '{"ok":true}'
    else if (u.includes('/v1/sessions')) body = JSON.stringify([{ id: 'ses_real_existing' }])
    return { ok: true, status: u.includes('/turns') ? 202 : 200, text: async () => body }
  }
  const p = defineProvider({ env: { MIMO_DESKTOP_PORT: '59999', MIMO_DESKTOP_TOKEN: 'tok' } })
  try {
    const turn = await p._internals.desktopSendTurn('ses_invented', { prompt: 'x' })
    assert.equal(turn.accepted, true)
    assert.equal(turn.verified, false)
    assert.equal(turn.delivered, false, 'invented id must NOT count as delivered')
    const real = await p._internals.desktopSendTurn('ses_real_existing', { prompt: 'x' })
    assert.equal(real.delivered, true, 'real id readback must deliver')
  } finally {
    if (prev) globalThis.fetch = prev; else delete globalThis.fetch
  }
})

test('desktop execute（mock fetch）：真 id 无事件 → ACCEPTED；自造 id → DESKTOP_SESSION_NOT_CREATED', async () => {
  const prev = globalThis.fetch
  const sessionsList = [{ id: 'ses_desktop_real' }]
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    let body = '{}'
    let status = 200
    if (u.includes('/v1/health')) body = '{"ok":true}'
    else if (u.includes('/turns')) { status = 202; body = '{"ok":true}' }
    else if (u.includes('/v1/sessions?')) body = JSON.stringify(sessionsList)
    else if (u.includes('/events')) body = '{"type":"text","text":""}'
    return { ok: status < 300, status, text: async () => body }
  }
  const p = defineProvider({ env: { MIMO_DESKTOP_PORT: '59999', MIMO_DESKTOP_TOKEN: 'tok' } })
  try {
    const resReal = await p.execute({ args: { prompt: 'hi', sessionId: 'ses_desktop_real' }, cwd: 'C:\\w', built: { argv: [], mode: 'auto', timeoutSec: 600 }, backend: 'mimo-desktop' })
    assert.equal(resReal.ok, true)
    assert.equal(resReal.status, 'ACCEPTED')
    assert.equal(resReal.backend, 'mimo-desktop')
    const resFake = await p.execute({ args: { prompt: 'hi', sessionId: 'ses_never_exists' }, cwd: 'C:\\w', built: { argv: [], mode: 'auto', timeoutSec: 600 }, backend: 'mimo-desktop' })
    assert.equal(resFake.ok, false)
    assert.equal(resFake.status, 'DESKTOP_SESSION_NOT_CREATED')
    assert.match(resFake.errorMessage, /会话/)
  } finally {
    if (prev) globalThis.fetch = prev; else delete globalThis.fetch
  }
})

test('desktop execute：health 失败 → DESKTOP_UNAVAILABLE，不抛', async () => {
  const prev = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  const p = defineProvider({ env: { MIMO_DESKTOP_PORT: '59998', MIMO_DESKTOP_TOKEN: 'tok' } })
  try {
    const res = await p.execute({ args: { prompt: 'hi' }, cwd: 'C:\\w', built: { argv: [], mode: 'auto', timeoutSec: 600 }, backend: 'mimo-desktop' })
    assert.equal(res.ok, false)
    assert.equal(res.status, 'DESKTOP_UNAVAILABLE')
  } finally {
    if (prev) globalThis.fetch = prev; else delete globalThis.fetch
  }
})

test('_internals 暴露纯函数面（测试/宿主可用）', () => {
  const I = provider._internals
  assert.deepEqual(I.BACKENDS, ['mimocode', 'mimo-desktop'])
  assert.equal(typeof I.parseMimoJson, 'function')
  assert.equal(typeof I.buildDesktopTurnBody, 'function')
  const body = I.buildDesktopTurnBody({ prompt: 'm', model: 'mimo-auto', cwd: 'C:\\w' })
  assert.deepEqual(body, { message: 'm', model: 'mimo-auto', directory: 'C:\\w' })
  assert.match(I.newDesktopSessionId(), /^ses_[a-z0-9]{18}$/)
})
