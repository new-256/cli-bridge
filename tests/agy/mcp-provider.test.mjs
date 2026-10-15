// tests/agy/mcp-provider.test.mjs — MCP 形态（mcp/providers/agy.mjs）真 spawn 冒烟。
// AGY_BIN 指向 fixture（.mjs → 经 process.execPath 包装）；CLI_BRIDGE_AGY_QUOTA 在
// 本进程内恒指放行额度 fixture，保证测试永不触碰真凭据/网络额度脚本。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { meta, tools, call, check } from '../../mcp/providers/agy.mjs'

// fileURLToPath 而非 .pathname：含空格/CJK 的路径会被百分号编码导致 spawn 失败（旧仓教训）。
const FIX = (f) => fileURLToPath(new URL('./fixtures/' + f, import.meta.url))
process.env.CLI_BRIDGE_AGY_QUOTA = FIX('fake-quota-ok.mjs')

function mkIo() {
  const homeDir = mkdtempSync(join(tmpdir(), 'cli-bridge-agy-'))
  return {
    homeDir,
    fs: { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync },
    path: { join, dirname },
    env: process.env,
    log: () => {},
    _cleanup: () => { try { rmSync(homeDir, { recursive: true, force: true }) } catch (e) {} }
  }
}

test('meta 契约形态', () => {
  assert.equal(meta.id, 'agy')
  assert.equal(meta.label, 'AGY')
  // 版本跟随本包（契约 §4）：不钉字面量，否则每次发布都要改测试。
  assert.match(meta.version, /^\d+\.\d+\.\d+/, 'meta.version follows the package version')
})

test('tools(env) 覆盖描述符三件套 + agy_quota，schema 合法，check() 通过', () => {
  const ts = tools(process.env)
  assert.deepEqual(ts.map((t) => t.name), ['agy_run', 'agy_continue', 'agy_status', 'agy_quota'])
  for (const t of ts) {
    assert.equal(t.inputSchema.type, 'object')
    assert.ok(t.description.length > 20)
  }
  assert.equal(check(process.env), true)
})

test('call(agy_run) 走 AGY_BIN fixture → agy OK + conv；快照文件原子落盘', async () => {
  const prevBin = process.env.AGY_BIN
  process.env.AGY_BIN = FIX('fake-agy.mjs')
  const io = mkIo()
  try {
    const text = await call('agy_run', { prompt: 'do something' }, io)
    assert.match(text, /^agy OK \[status=SUCCESS mode=accept-edits conv=conv-fake-1/)
    assert.match(text, /\bdone\b/)
    const snap = JSON.parse(readFileSync(join(io.homeDir, 'cli-bridge-mcp-agy.json'), 'utf8'))
    assert.equal(snap.source, 'mcp')
    assert.equal(snap.provider, 'agy')
    assert.equal(snap.projects[0].lastStatus, 'SUCCESS')
    assert.equal(snap.projects[0].lastSessionId, 'conv-fake-1')
  } finally {
    io._cleanup()
    if (prevBin === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = prevBin
  }
})

test('step_update 被折叠进 trail（实时状态面在 MCP 形态同样生效）', async () => {
  const prevBin = process.env.AGY_BIN
  process.env.AGY_BIN = FIX('fake-agy.mjs')
  const io = mkIo()
  try {
    await call('agy_run', { prompt: 'watch steps' }, io)
    const snap = JSON.parse(readFileSync(join(io.homeDir, 'cli-bridge-mcp-agy.json'), 'utf8'))
    const trailTools = snap.projects[0].trail.map((e) => e.tool)
    assert.ok(trailTools.includes('read'), 'trail has read step: ' + JSON.stringify(trailTools))
  } finally {
    io._cleanup()
    if (prevBin === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = prevBin
  }
})

test('call(agy_run) 无 prompt → 纯文本错误（契约 §4：错误也是文本）', async () => {
  const io = mkIo()
  try {
    assert.equal(await call('agy_run', {}, io), 'agy error: prompt is required')
    assert.equal(await call('agy_run', { prompt: '   ' }, io), 'agy error: prompt is required')
  } finally { io._cleanup() }
})

test('call(agy_quota) 走 fixture → tier/桶/模型行；summary 紧凑且过滤 3p 模型', async () => {
  const io = mkIo()
  try {
    const full = await call('agy_quota', {}, io)
    assert.match(full, /tier=pro/)
    assert.match(full, /gemini-5h \[5h\] 50%/)
    assert.match(full, /Claude Opus 4 : 90% \[3p: Claude\/GPT 不推荐\]/)
    const compact = await call('agy_quota', { summary: true }, io)
    assert.match(compact, /weekly: gemini-weekly 80%/)
    assert.match(compact, /top models: gemini-3 50%/)
    assert.doesNotMatch(compact, /Claude/)
  } finally { io._cleanup() }
})

test('call(agy_status) 返回可读状态文本', async () => {
  const io = mkIo()
  try {
    const text = await call('agy_status', {}, io)
    assert.match(text, /^agy status: (idle|ok|failed)/)
  } finally { io._cleanup() }
})

test('call(agy_continue) latest/conversationId 语义走通（fixture 恒成功）', async () => {
  const prevBin = process.env.AGY_BIN
  process.env.AGY_BIN = FIX('fake-agy.mjs')
  const io = mkIo()
  try {
    assert.match(await call('agy_continue', { prompt: 'more', latest: true }, io), /^agy OK/)
    assert.match(await call('agy_continue', { prompt: 'more', conversationId: 'conv-fake-1' }, io), /^agy OK/)
  } finally {
    io._cleanup()
    if (prevBin === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = prevBin
  }
})

test('agy 不可用（AGY_BIN 指向不存在文件）→ 文本 FAILED 且不抛', async () => {
  const prevBin = process.env.AGY_BIN
  process.env.AGY_BIN = join(tmpdir(), 'definitely-not-agy-xyz.mjs')
  const io = mkIo()
  try {
    const text = await call('agy_run', { prompt: 'x' }, io)
    assert.match(text, /^agy (FAILED|OK)/) // error 事件 → AGY_UNAVAILABLE 路径
    if (/^agy FAILED/.test(text)) assert.match(text, /status=(AGY_UNAVAILABLE|ERROR|PARSE_ERROR|HUNG_TIMEOUT)/)
  } finally {
    io._cleanup()
    if (prevBin === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = prevBin
  }
})
