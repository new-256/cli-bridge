// tests/claude/mcp-provider.test.mjs — MCP 形态端到端（真 spawn fixture）。
// 关键顺序：CLAUDE_BIN 必须在 import provider 模块前就位（模块 import 时构造描述符）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, renameSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIX = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
process.env.CLAUDE_BIN = FIX

const mcp = await import('../../mcp/providers/claude.mjs')

function mkIo() {
  const homeDir = mkdtempSync(join(tmpdir(), 'cli-bridge-claude-'))
  // 隔离配置目录：否则 readConfiguredModels 会读**本机真实** ~/.claude/settings.json，
  // 把用户实际在用的模型混进 fixture 清单（实测踩到：期望 2 个却出来 5 个）。
  const cfgDir = join(homeDir, '.claude')
  mkdirSync(cfgDir, { recursive: true })
  return {
    homeDir,
    fs: { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync },
    path: { join, dirname },
    env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: cfgDir }),
    log: () => { },
    _cleanup: () => { try { rmSync(homeDir, { recursive: true, force: true }) } catch (e) { } }
  }
}

test('meta 与工具面：四件套（三件套 + claude_models），名字带 claude_ 前缀', () => {
  assert.equal(mcp.meta.id, 'claude')
  assert.equal(mcp.meta.label, 'CLAUDE')
  assert.match(mcp.meta.version, /^\d+\.\d+\.\d+/)
  const names = mcp.tools(process.env).map((t) => t.name)
  assert.deepEqual(names, ['claude_run', 'claude_continue', 'claude_status', 'claude_models'])
  for (const t of mcp.tools(process.env)) {
    assert.equal(t.inputSchema.type, 'object')
    assert.ok(t.description && t.description.length > 20)
  }
  assert.doesNotThrow(() => mcp.check(process.env))
})

test('MCP schema 裁掉 background（MCP 无 DSH jobs 语义）', () => {
  const run = mcp.tools(process.env).find((t) => t.name === 'claude_run')
  assert.equal(run.inputSchema.properties.background, undefined)
  assert.ok(run.inputSchema.properties.prompt)
  assert.deepEqual(run.inputSchema.required, ['prompt'])
})

test('claude_run 前台：真 spawn fixture → SUCCESS + 正文 + session', async () => {
  const io = mkIo()
  try {
    const text = await mcp.call('claude_run', { prompt: 'go' }, io)
    assert.match(text, /claude OK \[status=SUCCESS/)
    assert.match(text, /FAKE_CLAUDE_OK/)
    assert.match(text, /session=sid_fake_claude_0001/)
  } finally { io._cleanup() }
})

test('claude_run：状态快照原子写盘（灯数据通道）', async () => {
  const io = mkIo()
  try {
    await mcp.call('claude_run', { prompt: 'go' }, io)
    const p = join(io.homeDir, 'cli-bridge-mcp-claude.json')
    assert.ok(existsSync(p), 'snapshot file written')
    const snap = JSON.parse(readFileSync(p, 'utf8'))
    assert.equal(snap.provider, 'claude')
    assert.ok(Array.isArray(snap.projects) && snap.projects.length > 0)
    assert.equal(snap.projects[0].lastStatus, 'SUCCESS')
  } finally { io._cleanup() }
})

test('⚠️ is_error=true + exit 0（限流形态）→ FAILED 且提示不要循环重试', async () => {
  const io = mkIo()
  const prev = process.env.FAKE_CLAUDE_MODE
  process.env.FAKE_CLAUDE_MODE = 'rate-limit'
  try {
    const text = await mcp.call('claude_run', { prompt: 'go' }, io)
    assert.match(text, /claude FAILED \[status=EXEC_ERROR/)
    assert.match(text, /Do NOT retry/, '限流必须显式提示，不能静默成功')
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_MODE
    else process.env.FAKE_CLAUDE_MODE = prev
    io._cleanup()
  }
})

test('claude_continue：sessionId 透传（--resume），latest → --continue', async () => {
  const io = mkIo()
  try {
    const a = await mcp.call('claude_continue', { prompt: 'more', sessionId: 'sid-x' }, io)
    assert.match(a, /claude OK/)
    const b = await mcp.call('claude_continue', { prompt: 'more', latest: true }, io)
    assert.match(b, /claude OK/)
  } finally { io._cleanup() }
})

test('claude_models：经 MCP 面读服务端权威清单', async () => {
  // MCP 面的 provider 是模块级单例（env 绑定 process.env），io.env 覆盖不到它 ——
  // 所以隔离必须临时改 process.env.CLAUDE_CONFIG_DIR，否则会读到本机真实
  // ~/.claude/settings.json，把用户配置的模型混进 fixture 清单。
  const io = mkIo()
  const prev = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = io.env.CLAUDE_CONFIG_DIR
  try {
    const text = await mcp.call('claude_models', { refresh: true }, io)
    assert.match(text, /claude models \(2\)/)
    assert.match(text, /fake-model-alpha/)
    assert.match(text, /fake-model-beta/)
    assert.match(text, /source=account-live/)
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prev
    io._cleanup()
  }
})

test('claude_status：返回可渲染文本且带 provider 标识', async () => {
  const io = mkIo()
  try {
    const text = await mcp.call('claude_status', {}, io)
    assert.match(text, /claude status:/)
    assert.match(text, /claude OK|claude status: idle|claude status: ok/)
  } finally { io._cleanup() }
})

test('缺 prompt → 文本报错（不抛异常，MCP 错误也是文本）', async () => {
  const io = mkIo()
  try {
    const text = await mcp.call('claude_run', {}, io)
    assert.match(text, /prompt is required/)
  } finally { io._cleanup() }
})
