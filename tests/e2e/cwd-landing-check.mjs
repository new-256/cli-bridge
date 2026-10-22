// tests/e2e/cwd-landing-check.mjs — 权威判定：agent 派出的任务**实际落在哪个目录**。
//
// 方法：让 CLI 写一个相对路径文件（./cwd-probe.txt），然后看它出现在哪：
//   A = DSH 会话目录（期望）  B = CLI 自身目录（干扰）  C = MCP 进程目录（错位源）
// 相对路径只有一种可能——CLI 认为的工作目录。这比读它自报的字符串更可靠。
//
// 走**真实 MCP 协议**（与 DSH 调用完全一致）：MCP server 以错误目录 C 启动、DSH_SESSION_ID 指向 A。
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const id = process.argv[2] || 'agy'

// 假 dsh-home：projcache 里把"会话 A"写死
const HOME = mkdtempSync(join(tmpdir(), 'clb-land-'))
const SESSION = 'session-99999999-8888-7777-6666-555555555555'
const A = join(HOME, 'dirA-session')
const B = join(HOME, 'dirB-cli-home')
const C = join(HOME, 'dirC-mcp-process')
for (const d of [A, B, C]) mkdirSync(d, { recursive: true })
mkdirSync(join(HOME, 'storages', 'session_projcache', 'sessions'), { recursive: true })
writeFileSync(join(HOME, 'storages', 'session_projcache', 'sessions', SESSION + '.json'),
  JSON.stringify({ version: 4, record: { identity: { cwd: A }, rows: {} } }), 'utf8')

console.log('A 会话目录(期望)  : ' + A)
console.log('C MCP进程目录(干扰): ' + C + '\n')

const server = spawn(process.execPath, [join(ROOT, 'mcp', 'cli-bridge-mcp.mjs')], {
  cwd: C,   // 模拟 DSH：以空/无关目录启动 MCP
  env: Object.assign({}, process.env, {
    DSH_HOME: HOME, DSH_SESSION_ID: SESSION,
    HOME: B, USERPROFILE: B,   // CLI 自己的 home 也指向 B（干扰项）
    AGY_MCP_CWD: '', CLAUDE_MCP_CWD: '', OPENCODE_MCP_CWD: '', CODEX_BRIDGE_CWD: '', MIMO_MCP_CWD: '', CODEBUDDY_MCP_CWD: ''
  }),
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
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
    const t = setTimeout(() => reject(new Error('rpc timeout: ' + method)), 240000)
    pending.set(rid, (m) => { clearTimeout(t); resolve(m) })
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n')
  })
}

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'land', version: '1' } })
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  // 用相对路径写文件 —— 落点即 CLI 的工作目录
  const res = await rpc('tools/call', {
    name: id + '_run',
    arguments: {
      prompt: 'Create a new file named exactly "cwd-probe.txt" (relative path, in your current working directory) containing the text OK. Then reply DONE.',
      timeoutSec: 180
    }
  })
  const text = (res.result && res.result.content && res.result.content[0] && res.result.content[0].text) || ''
  console.log('调用返回: ' + JSON.stringify(String(text).slice(0, 160)) + '\n')
} catch (e) {
  console.log('调用失败: ' + e.message)
  if (stderr) console.log('stderr: ' + stderr.slice(0, 300))
} finally {
  try { server.kill() } catch (e) { }
}

const probe = 'cwd-probe.txt'
const hit = []
for (const [label, dir] of [['A(会话✓)', A], ['B(CLI自身✗)', B], ['C(MCP进程✗)', C]]) {
  if (existsSync(join(dir, probe))) hit.push(label)
}
console.log('文件 cwd-probe.txt 出现在: ' + (hit.length ? hit.join(' + ') : '(哪里都没有)'))
console.log('目录内容: A=[' + readdirSync(A).join(',') + ']  B=[' + readdirSync(B).join(',') + ']  C=[' + readdirSync(C).join(',') + ']')

if (hit.length === 1 && hit[0].startsWith('A')) {
  console.log('\n✅ 任务落在会话目录 A —— 修复有效')
} else if (hit.includes('C(进程✗)')) {
  console.log('\n❌ 任务落在 MCP 进程目录 C —— 仍未修好')
  process.exitCode = 1
} else if (hit.includes('B(CLI自身✗)')) {
  console.log('\n❌ 任务落在 CLI 自身目录 B —— CLI 自己有目录判定，需要额外手段')
  process.exitCode = 1
} else {
  console.log('\n⚠ 没检测到写入（可能任务失败/限流），需换可用通道重测')
  process.exitCode = 2
}

try { rmSync(HOME, { recursive: true, force: true }) } catch (e) { }
