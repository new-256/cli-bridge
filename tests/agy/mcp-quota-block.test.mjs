// tests/agy/mcp-quota-block.test.mjs — 5h 额度 <10% 硬阻断（独立文件/进程：
// mcp/providers/agy.mjs 的 provider 单例带 30 分钟额度缓存，与放行用例互斥）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIX = (f) => fileURLToPath(new URL('./fixtures/' + f, import.meta.url))
// 关键顺序：低额度 fixture 必须在 import provider 模块前就位。
process.env.CLI_BRIDGE_AGY_QUOTA = FIX('fake-quota-low.mjs')
process.env.AGY_BIN = FIX('fake-agy.mjs')

const { call } = await import('../../mcp/providers/agy.mjs')

function mkIo() {
  const homeDir = mkdtempSync(join(tmpdir(), 'cli-bridge-agy-block-'))
  return {
    homeDir,
    fs: { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync },
    path: { join, dirname },
    env: process.env,
    log: () => {},
    _cleanup: () => { try { rmSync(homeDir, { recursive: true, force: true }) } catch (e) {} }
  }
}

test('低额度 fixture 生效：agy_run 被硬阻断且不调用 agy', async () => {
  const io = mkIo()
  try {
    const text = await call('agy_run', { prompt: 'should not run' }, io)
    assert.match(text, /agy 未调用（5h 池子额度 <10%）/)
    assert.match(text, /Gemini 5h pool quota < 10% \(5%/ )
    // 阻断不产生运行记录（begin 在门禁之后，旧语义）
    const snapPath = join(io.homeDir, 'cli-bridge-mcp-agy.json')
    if (existsSync(snapPath)) {
      const snap = JSON.parse(readFileSync(snapPath, 'utf8'))
      assert.equal(snap.projects.reduce((n, p) => n + (p.running || 0), 0), 0)
    }
  } finally { io._cleanup() }
})

test('agy_continue 同样被门禁拦截', async () => {
  const io = mkIo()
  try {
    const text = await call('agy_continue', { prompt: 'follow up', latest: true }, io)
    assert.match(text, /agy 未调用/)
  } finally { io._cleanup() }
})
