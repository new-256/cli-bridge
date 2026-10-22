// tests/e2e/session-cwd-fix.mjs
// 验证「MCP 进程 cwd ≠ 会话 cwd」时，provider 会不会用会话真实目录。
//
// 复现条件（与线上完全一致）：DSH 的 mcp-client 以 config.cwd=""（空）启动 stdio server，
// 于是 MCP 进程的 cwd = DSH 主进程目录，而不是用户会话目录。
// 期望：provider 通过 DSH_SESSION_ID 从 projcache 读到会话 cwd 并用它，而不是 process.cwd()。
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const id = process.argv[2] || 'agy'

// 假 dsh-home：projcache 里写死"会话 cwd = 某项目目录"
const HOME = mkdtempSync(join(tmpdir(), 'clb-cwdfix-'))
const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const PROJECT = join(HOME, 'my-project')
const WRONG = join(HOME, 'wrong-dsh-process-dir')   // 模拟 DSH 主进程目录（错的那个）
mkdirSync(PROJECT, { recursive: true })
mkdirSync(WRONG, { recursive: true })
mkdirSync(join(HOME, 'storages', 'session_projcache', 'sessions'), { recursive: true })
writeFileSync(join(HOME, 'storages', 'session_projcache', 'sessions', SESSION + '.json'), JSON.stringify({
  version: 4,
  record: { identity: { cwd: PROJECT }, rows: {} }
}), 'utf8')

console.log('会话真实 cwd : ' + PROJECT)
console.log('MCP 进程 cwd : ' + WRONG + '   ← 故意设错（模拟 DSH 的行为）')

const server = spawn(process.execPath, [join(ROOT, 'mcp', 'cli-bridge-mcp.mjs')], {
  cwd: WRONG,   // 关键：MCP 进程在一个"错误"目录下启动
  env: Object.assign({}, process.env, {
    DSH_HOME: HOME,
    DSH_SESSION_ID: SESSION,
    // 清掉可能干扰的 env 覆盖
    AGY_MCP_CWD: '', CLAUDE_MCP_CWD: '', OPENCODE_MCP_CWD: '', CODEX_BRIDGE_CWD: '', MIMO_MCP_CWD: '', CODEBUDDY_MCP_CWD: ''
  }),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})

let buf = ''
const pending = new Map()
server.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let m
    try { m = JSON.parse(line) } catch (e) { continue }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
})
let stderr = ''
server.stderr.on('data', (d) => { stderr += d })

let seq = 0
function rpc(method, params) {
  const rid = ++seq
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('rpc timeout: ' + method)), 180000)
    pending.set(rid, (m) => { clearTimeout(t); resolve(m) })
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n')
  })
}

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cwd-test', version: '1' } })
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  // 调用时不传 cwd —— 正是出问题的用法
  const res = await rpc('tools/call', {
    name: id + '_run',
    arguments: { prompt: 'Reply with exactly: CWDOK', timeoutSec: 120 }
  })
  const text = (res.result && res.result.content && res.result.content[0] && res.result.content[0].text) || ''
  console.log('\n调用结果: ' + JSON.stringify(String(text).slice(0, 140)))

  // 状态文件里记录的 cwd 就是 provider 实际用的工作目录
  const sf = join(HOME, 'cli-bridge-mcp-' + id + '.json')
  if (!existsSync(sf)) { console.log('\n✗ 没有生成状态文件，无法判定'); process.exitCode = 1 }
  else {
    const j = JSON.parse(readFileSync(sf, 'utf8'))
    const used = (j.projects && j.projects[0] && j.projects[0].cwd) || ''
    console.log('状态文件记录 cwd: ' + used)
    const okSession = used.replace(/\\/g, '/') === PROJECT.replace(/\\/g, '/')
    const isWrong = used.replace(/\\/g, '/') === WRONG.replace(/\\/g, '/')
    console.log('')
    if (okSession) console.log('✅ 用的是会话真实目录（修复生效）')
    else if (isWrong) { console.log('❌ 仍在用 MCP 进程目录（修复未生效）'); process.exitCode = 1 }
    else { console.log('⚠ 既不是会话目录也不是进程目录: ' + used); process.exitCode = 1 }
  }
} catch (e) {
  console.log('FAILED: ' + e.message)
  if (stderr) console.log('stderr: ' + stderr.slice(0, 300))
  process.exitCode = 1
} finally {
  try { server.kill() } catch (e) { }
  try { rmSync(HOME, { recursive: true, force: true }) } catch (e) { }
}
