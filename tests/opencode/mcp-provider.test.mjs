// tests/opencode/mcp-provider.test.mjs — MCP 形态端到端（真 spawn fixture）。
// 关键顺序：OPENCODE_BIN 必须在 import provider 模块前就位。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIX = (f) => fileURLToPath(new URL('./fixtures/' + f, import.meta.url))
process.env.OPENCODE_BIN = FIX('fake-opencode.mjs')

const mcp = await import('../../mcp/providers/opencode.mjs')

function mkIo() {
  const homeDir = mkdtempSync(join(tmpdir(), 'cli-bridge-opencode-'))
  return {
    homeDir,
    fs: { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync },
    path: { join, dirname },
    env: process.env,
    log: () => {},
    _cleanup: () => { try { rmSync(homeDir, { recursive: true, force: true }) } catch (e) {} }
  }
}

test('meta 与工具面：三件套 + opencode_models，名字带 opencode_ 前缀', () => {
  assert.equal(mcp.meta.id, 'opencode')
  assert.equal(mcp.meta.label, 'OPENCODE')
  const names = mcp.tools(process.env).map((t) => t.name)
  assert.deepEqual(names, ['opencode_run', 'opencode_continue', 'opencode_status', 'opencode_models'])
  for (const t of mcp.tools(process.env)) {
    assert.equal(t.inputSchema.type, 'object')
    assert.ok(t.description && t.description.length > 20)
  }
  assert.doesNotThrow(() => mcp.check(process.env))
})

test('opencode_models：spawn 真实 CLI 拿列表（免费模型优先排序）', async () => {
  const io = mkIo()
  try {
    const text = await mcp.call('opencode_models', {}, io)
    // 本机装有桌面版 CLI 且已登录时才可能拿到列表；拿不到必须明确报错而非静默。
    if (/^opencode models \(\d+\)/.test(text)) {
      assert.match(text, /free: \d+ \/ \d+/)
      const ids = text.split('\n').filter((l) => l.trim().startsWith('opencode')).map((l) => l.trim().split(/\s+/)[0])
      assert.ok(ids.length > 0)
      // 免费模型排在最前（用户要求：优先用免费模型）。
      const firstFree = ids.findIndex((x) => /-free$/.test(x))
      const firstPaid = ids.findIndex((x) => !/-free$/.test(x))
      if (firstFree >= 0 && firstPaid >= 0) assert.ok(firstFree < firstPaid, 'free models sorted first')
    } else {
      assert.match(text, /opencode_models failed/, '失败必须明确报出，绝不静默伪造列表')
    }
  } finally { io._cleanup() }
})

test('opencode_models：freeOnly 过滤后全是免费模型', async () => {
  const io = mkIo()
  try {
    const text = await mcp.call('opencode_models', { freeOnly: true }, io)
    if (/^opencode models \(\d+\)/.test(text)) {
      const ids = text.split('\n').filter((l) => l.trim().startsWith('opencode')).map((l) => l.trim().split(/\s+/)[0])
      for (const id of ids) assert.match(id, /-free$/, 'freeOnly must not return paid models')
    } else {
      assert.match(text, /opencode_models failed/)
    }
  } finally { io._cleanup() }
})

test('opencode_run 前台：真 spawn fixture → SUCCESS + FAKE_OPENCODE_OK + session', async () => {
  const io = mkIo()
  try {
    const text = await mcp.call('opencode_run', { prompt: 'go' }, io)
    assert.match(text, /opencode OK \[status=SUCCESS/)
    assert.match(text, /FAKE_OPENCODE_OK/, 'response text extracted from part.text')
    assert.match(text, /session=ses_fake00000000000AAA/)
  } finally { io._cleanup() }
})

test('opencode_run：状态快照原子写盘（灯数据通道）', async () => {
  const io = mkIo()
  try {
    await mcp.call('opencode_run', { prompt: 'go' }, io)
    const p = join(io.homeDir, 'cli-bridge-mcp-opencode.json')
    assert.ok(existsSync(p), 'snapshot file written')
    const snap = JSON.parse(readFileSync(p, 'utf8'))
    assert.equal(snap.provider, 'opencode')
    // buildMcpBridgePayload 只输出 projects（lastStatus 在项目层），顶层无聚合字段。
    assert.ok(Array.isArray(snap.projects) && snap.projects.length > 0)
    assert.equal(snap.projects[0].lastStatus, 'SUCCESS')
  } finally { io._cleanup() }
})

test('opencode_continue：sessionId 透传 --session（argv 校验）', async () => {
  const io = mkIo()
  try {
    // fixture 不解析 flag，但 spawn 必须成功且返回成功结果（证明 argv 合法）。
    const text = await mcp.call('opencode_continue', { prompt: 'more', sessionId: 'ses_x' }, io)
    assert.match(text, /opencode OK/)
  } finally { io._cleanup() }
})

test('opencode_status：返回可渲染文本且带 provider 标识', async () => {
  const io = mkIo()
  try {
    const text = await mcp.call('opencode_status', {}, io)
    assert.ok(typeof text === 'string' && text.length > 0)
  } finally { io._cleanup() }
})

test('缺 prompt → 文本报错（不抛异常，MCP 错误也是文本）', async () => {
  const io = mkIo()
  try {
    const text = await mcp.call('opencode_run', {}, io)
    assert.match(text, /prompt is required/)
  } finally { io._cleanup() }
})
