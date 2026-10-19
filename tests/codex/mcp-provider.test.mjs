// tests/codex/mcp-provider.test.mjs — MCP 形态端到端（真 spawn 假 codex 夹具）。
// 关键顺序：CODEX_BIN / CODEX_HOME 必须在 import provider 模块前就位（模块顶部即构造
// 描述符实例，env 是 process.env 的活引用）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { materializeCodexHome } from './helpers/fixture-home.mjs'

const FIX = (f) => fileURLToPath(new URL('./fixtures/' + f, import.meta.url))
// 临时 CODEX_HOME（fake-auth.json → auth.json，见 helper 头注的发布安全红线）。
const HOME = materializeCodexHome()
const FIX_HOME = HOME.home
const SETTINGS_HOME = mkdtempSync(join(tmpdir(), 'clb-codex-mcp-settings-'))
const SETTINGS_FILE = join(SETTINGS_HOME, 'cli-bridge-settings.json')
// 面板里配了默认模型与沙箱策略：MCP 面必须让它们生效（三形态行为一致）。
writeFileSync(SETTINGS_FILE, JSON.stringify({ codex: { defaultModel: 'from-settings', sandboxMode: 'read-only' } }), 'utf8')

process.env.CODEX_BIN = FIX('fake-codex.mjs')
process.env.CODEX_HOME = FIX_HOME
process.env.CLI_BRIDGE_SETTINGS_FILE = SETTINGS_FILE
// 实时清单端点指向本机未监听端口：MCP 面的 codex_models 失败必须是明确的 ok:false 文本。
process.env.CODEX_BRIDGE_MODELS_URL = 'http://127.0.0.1:9/mcp/models'

const mcp = await import('../../mcp/providers/codex.mjs')

const ARGV_FILE = join(SETTINGS_HOME, 'argv.json')
function argvOf() {
  try { rmSync(ARGV_FILE, { force: true }) } catch (e) { /* 无旧文件 */ }
  process.env.CODEX_FAKE_ARGV_FILE = ARGV_FILE
  return () => JSON.parse(readFileSync(ARGV_FILE, 'utf8'))
}

function mkIo() {
  const homeDir = mkdtempSync(join(tmpdir(), 'cli-bridge-codex-'))
  return {
    homeDir,
    fs: { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync },
    path: { join, dirname },
    env: process.env,
    log: () => {},
    _cleanup: () => { try { rmSync(homeDir, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  }
}

test('meta 与工具面：三件套 + codex_models，名字与描述符同源', () => {
  assert.equal(mcp.meta.id, 'codex')
  assert.equal(mcp.meta.label, 'CODEX')
  assert.match(mcp.meta.version, /^\d+\.\d+\.\d+/)
  const names = mcp.tools(process.env).map((t) => t.name)
  assert.deepEqual(names, ['codex_run', 'codex_continue', 'codex_status', 'codex_models'])
  for (const t of mcp.tools(process.env)) {
    assert.equal(t.inputSchema.type, 'object')
    assert.ok(t.description && t.description.length > 20)
  }
  assert.doesNotThrow(() => mcp.check(process.env))
})

test('codex_run：真 spawn 夹具 → SUCCESS + 答复正文 + thread id', async () => {
  const io = mkIo()
  try {
    const text = await mcp.call('codex_run', { prompt: 'go' }, io)
    assert.match(text, /codex OK \[status=SUCCESS/)
    assert.match(text, /FAKE_CODEX_OK/)
    assert.match(text, /session=01a154f6-06c9-7011-a742-e532461b9b74/)
    assert.match(text, /tokens=17208/)
  } finally { io._cleanup() }
})

test('codex_run：argv 契约（--json/--skip-git-repo-check/-s/-m 来自设置）+ prompt 位置', async () => {
  const io = mkIo()
  try {
    const argv = argvOf()
    await mcp.call('codex_run', { prompt: 'Reply exactly: PONG' }, io)
    const got = argv()
    assert.deepEqual(got.slice(0, 3), ['exec', '--json', '--skip-git-repo-check'])
    assert.ok(got.includes('-s') && got[got.indexOf('-s') + 1] === 'read-only', 'sandbox from settings')
    assert.ok(got.includes('-m') && got[got.indexOf('-m') + 1] === 'from-settings', 'model from settings')
    assert.equal(got[got.length - 1], 'Reply exactly: PONG', 'prompt is the last positional')
    assert.ok(!got.includes('-a'), 'codex exec rejects -a')
  } finally { io._cleanup() }
})

test('codex_continue：sessionId → exec resume <sid>，无 -C / -s / --add-dir', async () => {
  const io = mkIo()
  try {
    const argv = argvOf()
    const text = await mcp.call('codex_continue', { prompt: 'more', sessionId: 'sid-1234', cwd: undefined }, io)
    assert.match(text, /codex OK/)
    assert.match(text, /session=sid-1234/, 'fixture echoes the resumed thread id')
    const got = argv()
    assert.deepEqual(got.slice(0, 4), ['exec', 'resume', 'sid-1234', '--json'])
    assert.ok(!got.includes('-C'), 'resume has no -C (codex rejects it)')
    assert.ok(!got.includes('-s'), 'resume has no -s')
    assert.ok(!got.includes('--add-dir'))
    assert.ok(got.includes('-c') && /^sandbox_mode="/.test(got[got.indexOf('-c') + 1]), 'sandbox via -c')
    assert.equal(got[got.length - 1], 'more')
  } finally { io._cleanup() }
})

test('codex_continue：latest=true → exec resume --last', async () => {
  const io = mkIo()
  try {
    const argv = argvOf()
    const text = await mcp.call('codex_continue', { prompt: 'again', latest: true }, io)
    assert.match(text, /codex OK/)
    const got = argv()
    assert.deepEqual(got.slice(0, 4), ['exec', 'resume', '--last', '--json'])
  } finally { io._cleanup() }
})

test('codex_run：失败流（400 无效模型）→ FAILED 文本带状态与可行动指引', async () => {
  const io = mkIo()
  const prev = process.env.CODEX_FAKE_MODE
  process.env.CODEX_FAKE_MODE = 'error'
  try {
    const text = await mcp.call('codex_run', { prompt: 'go' }, io)
    assert.match(text, /codex FAILED \[status=TURN_FAILED/)
    assert.match(text, /not a valid model ID/)
    assert.match(text, /codex_models/, 'actionable hint points at codex_models')
  } finally {
    if (prev === undefined) delete process.env.CODEX_FAKE_MODE
    else process.env.CODEX_FAKE_MODE = prev
    io._cleanup()
  }
})

test('codex_run：未知可执行 → CODEX_UNAVAILABLE 文本（不抛）', async () => {
  const io = mkIo()
  const prev = process.env.CODEX_BIN
  process.env.CODEX_BIN = join(SETTINGS_HOME, 'definitely-missing-exe.exe')
  try {
    const text = await mcp.call('codex_run', { prompt: 'go' }, io)
    assert.match(text, /codex FAILED \[status=CODEX_UNAVAILABLE/)
  } finally {
    process.env.CODEX_BIN = prev
    io._cleanup()
  }
})

test('codex_run：状态快照原子写盘（灯数据通道）', async () => {
  const io = mkIo()
  try {
    await mcp.call('codex_run', { prompt: 'go' }, io)
    const p = join(io.homeDir, 'cli-bridge-mcp-codex.json')
    assert.ok(existsSync(p), 'snapshot file written')
    const snap = JSON.parse(readFileSync(p, 'utf8'))
    assert.equal(snap.provider, 'codex')
    assert.ok(Array.isArray(snap.projects) && snap.projects.length > 0)
    assert.equal(snap.projects[0].lastStatus, 'SUCCESS')
  } finally { io._cleanup() }
})

test('codex_status：可渲染文本（含 codex 标识）', async () => {
  const io = mkIo()
  try {
    await mcp.call('codex_run', { prompt: 'go' }, io)
    const text = await mcp.call('codex_status', {}, io)
    assert.ok(typeof text === 'string' && text.length > 0)
    assert.match(text, /codex status:/)
  } finally { io._cleanup() }
})

test('codex_models：端点不可达 → 明确失败文本，绝不静默空列表', async () => {
  const io = mkIo()
  try {
    const text = await mcp.call('codex_models', {}, io)
    assert.match(text, /codex_models failed:/)
    assert.match(text, /source="catalog"/, 'offers the explicit local-layer escape hatch')
  } finally { io._cleanup() }
})

test('codex_models：显式 source=catalog 可列出本地目录并标注来源', async () => {
  const io = mkIo()
  try {
    const text = await mcp.call('codex_models', { source: 'catalog' }, io)
    assert.match(text, /codex models \[catalog\] \(2 matched/)
    assert.match(text, /fixture\/free-model:free/)
    assert.match(text, /local, NOT authoritative/)
  } finally { io._cleanup() }
})

test('缺 prompt → 文本报错（MCP 错误也是文本，不抛异常）', async () => {
  const io = mkIo()
  try {
    const text = await mcp.call('codex_run', {}, io)
    assert.match(text, /prompt is required/)
  } finally { io._cleanup() }
})

test('未初始化 io 时 call 返回文本错误', async () => {
  const text = await mcp.call('codex_status', {}, null)
  assert.ok(typeof text === 'string')
})

// 收尾：清理临时目录（node:test 每文件独立进程，进程退出不影响其他测试）。
test('cleanup', () => {
  try { rmSync(SETTINGS_HOME, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  HOME.cleanup()
})
