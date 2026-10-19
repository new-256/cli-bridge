// tests/e2e/mcp-lamp-e2e.mjs — 验证「经 MCP 调用 CLI → 状态灯数据源被写入」这条真实链路。
//
// 常规会话（非 preset）里用户是通过 MCP 工具调用这些 CLI 的。MCP 子进程会把运行状态原子写进
// {dsh-home}/cli-bridge-mcp-<id>.json，家级灯在响应 /cli-bridge/status 时读盘合并。
// 若这条链断了，用户就永远看不到灯 —— 所以这里跑真实 stdio MCP 协议来验证。
//
// 用法：node tests/e2e/mcp-lamp-e2e.mjs [provider]   默认 claude
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const id = process.argv[2] || 'claude'
// 默认用临时 home 做隔离；传 CLB_MCP_HOME 可指向**真实** dsh-home（验证家级灯真会亮）。
const HOME = process.env.CLB_MCP_HOME || join(tmpdir(), 'clb-mcp-e2e-' + id)
const STATUS_FILE = join(HOME, 'cli-bridge-mcp-' + id + '.json')

if (existsSync(STATUS_FILE)) rmSync(STATUS_FILE)

const server = spawn(process.execPath, [join(ROOT, 'mcp', 'cli-bridge-mcp.mjs')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { DSH_HOME: HOME }),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})

let buf = ''
const pending = new Map()
server.stdout.on('data', (d) => {
  buf += d
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch (e) { continue }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
})
let stderr = ''
server.stderr.on('data', (d) => { stderr += d })

let seq = 0
function rpc(method, params) {
  const rid = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + method)), 180000)
    pending.set(rid, (m) => { clearTimeout(timer); resolve(m) })
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n')
  })
}

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lamp-e2e', version: '1' } })
  console.log('initialize ok: ' + JSON.stringify(init.result && init.result.serverInfo))
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  const tools = await rpc('tools/list', {})
  const names = (tools.result && tools.result.tools || []).map((t) => t.name)
  const wanted = id + '_run'
  console.log('tools 含 ' + wanted + ': ' + names.includes(wanted) + '（共 ' + names.length + ' 个）')
  if (!names.includes(wanted)) throw new Error('MCP 未暴露 ' + wanted)

  console.log('\n调用 ' + wanted + ' 跑一次真实任务…')
  const res = await rpc('tools/call', { name: wanted, arguments: { prompt: 'Reply with exactly: LAMP', timeoutSec: 150 } })
  const text = (res.result && res.result.content && res.result.content[0] && res.result.content[0].text) || ''
  console.log('返回: ' + JSON.stringify(String(text).slice(0, 120)))

  // MCP 是异步任务模型时，状态文件应在运行中就已写入
  if (existsSync(STATUS_FILE)) {
    const j = JSON.parse(readFileSync(STATUS_FILE, 'utf8'))
    const age = Math.round((Date.now() - Number(j.updatedAt || 0)) / 1000)
    console.log('\n✅ 状态文件已写入: ' + STATUS_FILE)
    console.log('   updatedAt=' + age + 's 前  projects=' + (Array.isArray(j.projects) ? j.projects.length : '(none)'))
    const p = (j.projects || [])[0]
    if (p) console.log('   project: cwd=' + String(p.cwd || '').slice(-30) + ' state=' + p.state + ' running=' + p.running + ' lastStatus=' + (p.lastStatus || '-'))
  } else {
    console.log('\n❌ 状态文件未生成 —— 常规会话里调用 CLI 不会亮灯（链路断裂）')
  }
} catch (e) {
  console.log('FAILED: ' + e.message)
  if (stderr) console.log('server stderr: ' + stderr.slice(0, 400))
  process.exitCode = 1
} finally {
  try { server.kill() } catch (e) { }
}
