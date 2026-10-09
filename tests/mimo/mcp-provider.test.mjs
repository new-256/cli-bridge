// tests/mimo/mcp-provider.test.mjs — MCP 形态（mcp/providers/mimo.mjs）真 spawn 冒烟。
// MIMO_BIN 指向 fixture（.mjs → 经 process.execPath 包装）；桌面后端用 mock fetch。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, renameSync, mkdirSync, readFileSync as fsRead } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { meta, tools, call, check } from '../../mcp/providers/mimo.mjs'

// fileURLToPath 而非 .pathname：含空格/CJK 的路径会被百分号编码导致 spawn 失败（旧仓教训）。
const FIX = (f) => fileURLToPath(new URL('./fixtures/' + f, import.meta.url))

function mkIo() {
  const homeDir = mkdtempSync(join(tmpdir(), 'cli-bridge-mimo-'))
  return {
    homeDir,
    fs: { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync },
    path: { join, dirname },
    env: process.env,
    log: () => {},
    _cleanup: () => { try { rmSync(homeDir, { recursive: true, force: true }) } catch (e) {} }
  }
}

// 关键纪律：async 版 withEnv。同步版会在 fn 的第一个 await 处就把 env 还原
// （async 体一遇到 await 就把控制权交回 caller），导致测试中后段读到本机真实
// DSH_HOME 设置分区 —— 曾因此把 mimo-desktop 写进 %APPDATA%（已清理）。
async function withEnv(vars, fn) {
  const prev = {}
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === null) delete process.env[k]; else process.env[k] = vars[k] }
  try { return await fn() } finally {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] }
  }
}

test('meta 契约形态', () => {
  assert.deepEqual(meta, { id: 'mimo', label: 'MIMO', version: '0.1.0' })
})

test('tools(env) 覆盖描述符三件套 + mimo_settings，schema 合法，check() 通过', () => {
  const ts = tools(process.env)
  assert.deepEqual(ts.map((t) => t.name), ['mimo_run', 'mimo_continue', 'mimo_status', 'mimo_settings'])
  for (const t of ts) {
    assert.equal(t.inputSchema.type, 'object')
    assert.ok(t.description.length > 20)
  }
  // MCP 形态 stdio 恒同步：background 参数已从 run/continue 面剥离。
  assert.ok(!('background' in ts[0].inputSchema.properties), 'mimo_run MCP面 no background')
  assert.ok(!('background' in ts[1].inputSchema.properties), 'mimo_continue MCP面 no background')
  // sessionId 仍在（desktop 回读事故修复：mimo_run 必须能显式给已存在会话）。
  assert.ok('sessionId' in ts[0].inputSchema.properties, 'mimo_run keeps sessionId')
  assert.equal(check(process.env), true)
})

test('call(mimo_run) 走 MIMO_BIN fixture → mimo ok + session；快照文件原子落盘', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-bridge-mimo-set-'))
  await withEnv({ MIMO_BIN: FIX('fake-mimo.mjs'), CLI_BRIDGE_SETTINGS_FILE: join(home, 'nope.json'), DSH_HOME: home, MIMO_MCP_CWD: home }, async () => {
    const io = mkIo()
    try {
      const text = await call('mimo_run', { prompt: 'do something' }, io)
      assert.match(text, /^mimo ok status=SUCCESS backend=mimocode sessionId=ses_fake_1/)
      assert.match(text, /\bdone\b/)
      // Lead 复核纠错：文件名必须 cli-bridge-mcp-mimo.json（indicator readMcpFile 模式），
      // 否则 MCP 形态活动永远进不了状态灯 —— 这条断言就是防漂移锁。
      const snapPath = join(io.homeDir, 'cli-bridge-mcp-mimo.json')
      assert.ok(existsSync(snapPath), 'snapshot written as cli-bridge-mcp-mimo.json')
      assert.ok(!existsSync(join(io.homeDir, 'cli-bridge-mimo.json')), 'legacy wrong name must not be written')
      const snap = JSON.parse(readFileSync(snapPath, 'utf8'))
      assert.equal(snap.source, 'mcp')
      assert.equal(snap.provider, 'mimo')
      assert.equal(snap.projects[0].lastStatus, 'SUCCESS')
      assert.equal(snap.projects[0].lastSessionId, 'ses_fake_1')
    } finally {
      io._cleanup()
      try { rmSync(home, { recursive: true, force: true }) } catch (e) {}
    }
  })
})

test('tool 事件被折叠进 trail（实时状态面在 MCP 形态同样生效）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-bridge-mimo-set-'))
  await withEnv({ MIMO_BIN: FIX('fake-mimo.mjs'), CLI_BRIDGE_SETTINGS_FILE: join(home, 'nope.json'), DSH_HOME: home, MIMO_MCP_CWD: home }, async () => {
    const io = mkIo()
    try {
      await call('mimo_run', { prompt: 'watch steps' }, io)
      const snap = JSON.parse(readFileSync(join(io.homeDir, 'cli-bridge-mcp-mimo.json'), 'utf8'))
      const trailTools = snap.projects[0].trail.map((e) => e.tool)
      assert.ok(trailTools.includes('bash'), 'trail has bash step: ' + JSON.stringify(trailTools))
    } finally {
      io._cleanup()
      try { rmSync(home, { recursive: true, force: true }) } catch (e) {}
    }
  })
})

test('call(mimo_run) 无 prompt → 纯文本错误（契约 §4：错误也是文本）', async () => {
  const io = mkIo()
  try {
    assert.equal(await call('mimo_run', {}, io), 'mimo error: prompt is required')
    assert.equal(await call('mimo_run', { prompt: '   ' }, io), 'mimo error: prompt is required')
    assert.match(await call('mimo_bogus', {}, io), /unknown tool/)
  } finally { io._cleanup() }
})

test('call(mimo_status) 返回可读状态文本', async () => {
  const io = mkIo()
  try {
    const text = await call('mimo_status', {}, io)
    assert.match(text, /^mimo status: (idle|ok|failed)/)
  } finally { io._cleanup() }
})

test('call(mimo_continue) latest/sessionId 语义走通（fixture 恒成功）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-bridge-mimo-set-'))
  await withEnv({ MIMO_BIN: FIX('fake-mimo.mjs'), CLI_BRIDGE_SETTINGS_FILE: join(home, 'nope.json'), DSH_HOME: home, MIMO_MCP_CWD: home }, async () => {
    const io = mkIo()
    try {
      assert.match(await call('mimo_continue', { prompt: 'more', latest: true }, io), /^mimo ok/)
      assert.match(await call('mimo_continue', { prompt: 'more', sessionId: 'ses_fake_1' }, io), /^mimo ok/)
    } finally {
      io._cleanup()
      try { rmSync(home, { recursive: true, force: true }) } catch (e) {}
    }
  })
})

test('call(mimo_settings) 读文本含 backends；带 backend 写入临时 home 回读一致', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-bridge-mimo-set-'))
  await withEnv({ CLI_BRIDGE_SETTINGS_FILE: join(home, 'cli-bridge-settings.json'), DSH_HOME: null }, async () => {
    const io = mkIo()
    try {
      const read = await call('mimo_settings', {}, io)
      assert.match(read, /mimo settings/)
      assert.match(read, /backends\s+: mimocode \| mimo-desktop/)
      const write = await call('mimo_settings', { backend: 'mimo-desktop', desktopModel: 'mimo-pro' }, io)
      assert.match(write, /file backend   : mimo-desktop/)
      const all = JSON.parse(fsRead(join(home, 'cli-bridge-settings.json'), 'utf8'))
      assert.equal(all.mimo.preferredBackend, 'mimo-desktop')
      assert.equal(all.mimo.desktopModel, 'mimo-pro')
    } finally {
      io._cleanup()
      try { rmSync(home, { recursive: true, force: true }) } catch (e) {}
    }
  })
})

test('mimo 不可用（MIMO_BIN 指向不存在文件）→ FALLBACK 指引文本且不抛（旧 MCP isLimited→fallbackResult verbatim）', async () => {
  // 固定 mimocode 后端链：防止读到本机真实 DSH_HOME 分区（preferredBackend 漂移）。
  await withEnv({ MIMO_BIN: join(tmpdir(), 'definitely-not-mimo-xyz.mjs'), MIMO_BRIDGE_BACKEND: 'mimocode', CLI_BRIDGE_SETTINGS_FILE: join(tmpdir(), 'nope-mimo-settings.json') }, async () => {
    const io = mkIo()
    try {
      const text = await call('mimo_run', { prompt: 'x' }, io)
      // MIMO_UNAVAILABLE 被 mimo isLimited 命中 → 旧 MCP 语义直接落 fallback 文案（无弹窗通道）。
      assert.match(text, /^status=FALLBACK_TO_DSH fallback=true backend=mimocode/)
      assert.match(text, /NEVER call mimo again/)
    } finally { io._cleanup() }
  })
})

test('free-API 错误 fixture → isLimited 命中（mimo 专属文案），落 fallback 指引文本', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-bridge-mimo-set-'))
  await withEnv({ MIMO_BIN: FIX('fake-mimo-limit.mjs'), CLI_BRIDGE_SETTINGS_FILE: join(home, 'nope.json'), DSH_HOME: home, MIMO_MCP_CWD: home }, async () => {
    const io = mkIo()
    try {
      const text = await call('mimo_run', { prompt: 'x' }, io)
      assert.match(text, /^status=FALLBACK_TO_DSH fallback=true/)
      assert.match(text, /NEVER call mimo again for this task/, 'fallback guidance present')
      // provider.isLimited 才是判据（kit 版 LIMIT_RE 不含 free-API/登录/第三方文案）：
      const { default: defineProvider } = await import('../../providers/mimo.mjs')
      const p = defineProvider({ env: {} })
      assert.equal(p.isLimited({ ok: false, status: 'UnknownError', stderr: 'MiMo free API service has ended. Sign in or configure a third-party API.' }), true)
    } finally {
      io._cleanup()
      try { rmSync(home, { recursive: true, force: true }) } catch (e) {}
    }
  })
})

test('desktop 后端 mock fetch：call(mimo_run) 真 id → ok ACCEPTED；自造 id → failed', async () => {
  const sessionsList = [{ id: 'ses_desktop_real' }]
  const prev = globalThis.fetch
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
  await withEnv({ MIMO_DESKTOP_PORT: '59997', MIMO_DESKTOP_TOKEN: 'tok', MIMO_MCP_CWD: tmpdir() }, async () => {
    const io = mkIo()
    try {
      const okText = await call('mimo_run', { prompt: 'hi', backend: 'mimo-desktop', sessionId: 'ses_desktop_real' }, io)
      assert.match(okText, /^mimo ok status=ACCEPTED backend=mimo-desktop/)
      const badText = await call('mimo_run', { prompt: 'hi', backend: 'mimo-desktop', sessionId: 'ses_never_exists' }, io)
      assert.match(badText, /^mimo failed status=DESKTOP_SESSION_NOT_CREATED/)
    } finally {
      io._cleanup()
      if (prev) globalThis.fetch = prev; else delete globalThis.fetch
    }
  })
})
