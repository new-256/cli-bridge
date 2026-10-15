// tests/opencode/mcp-error.test.mjs — 失败路径端到端（独立文件/进程：
// mcp/providers/opencode.mjs 是单例模块，成功 fixture 与失败 fixture 的 OPENCODE_BIN
// 互斥，必须分文件加载）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIX = (f) => fileURLToPath(new URL('./fixtures/' + f, import.meta.url))
// 形态取自本机实测的真实 401 输出：error.data.message + exit 1。
process.env.OPENCODE_BIN = FIX('fake-opencode-error.mjs')

const mcp = await import('../../mcp/providers/opencode.mjs')

function mkIo() {
  const homeDir = mkdtempSync(join(tmpdir(), 'cli-bridge-opencode-err-'))
  return {
    homeDir,
    fs: { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync },
    path: { join, dirname },
    env: process.env,
    log: () => {},
    _cleanup: () => { try { rmSync(homeDir, { recursive: true, force: true }) } catch (e) {} }
  }
}

test('API key 无效：exit 1 + error 事件 → FAILED，原因进输出（不是静默成功）', async () => {
  const io = mkIo()
  try {
    const text = await mcp.call('opencode_run', { prompt: 'go' }, io)
    assert.match(text, /opencode FAILED \[status=ERROR/)
    assert.match(text, /Incorrect API key provided/, 'CLI 自报原因必须可见（error.data.message）')
  } finally { io._cleanup() }
})

test('失败也落盘快照（灯能看到失败态，不丢历史）', async () => {
  const io = mkIo()
  try {
    await mcp.call('opencode_run', { prompt: 'go' }, io)
    const p = join(io.homeDir, 'cli-bridge-mcp-opencode.json')
    assert.ok(existsSync(p), 'snapshot written even on failure')
    const snap = JSON.parse(readFileSync(p, 'utf8'))
    assert.ok(Array.isArray(snap.projects) && snap.projects.length > 0)
    assert.equal(snap.projects[0].lastStatus, 'ERROR')
    assert.equal(snap.projects[0].running, 0, 'run is finished, not dangling')
  } finally { io._cleanup() }
})
