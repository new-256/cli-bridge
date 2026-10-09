#!/usr/bin/env node
// mcp/cli-bridge-mcp.mjs — 统一零依赖 MCP（stdio JSON-RPC 2.0）服务器。
//
// 三个旧包各带一个 MCP 服务器（agy-mcp-server / codebuddy-mcp-server /
// mimo-mcp-server，~500 行 framing 几乎相同）。合并版：本文件只有一份 framing/
// 生命周期逻辑，工具面来自 mcp/providers/<id>.mjs（契约 §4）。
//
// 用法：
//   node mcp/cli-bridge-mcp.mjs                  → 聚合三个 provider 的全部工具
//   node mcp/cli-bridge-mcp.mjs --provider=agy   → 只暴露 agy 面（等价旧 agy-mcp-server；
//                                                  mcp/<id>-mcp-server.mjs 即此形态的薄封装）
//   node mcp/cli-bridge-mcp.mjs --check          → 自检：provider 模块可加载、工具表
//                                                  合法（name/inputSchema），打印 JSON 后退出
//
// 与 DSH 的 MCP 配置：command=node，args=[<绝对路径>/mcp/cli-bridge-mcp.mjs]，
// env 可选 CLI_BRIDGE_PROVIDER / DSH_HOME / CLI_BRIDGE_SETTINGS_FILE 等（各 provider
// 自己约定额外的 *_BIN / *_MCP_CWD 变量，见 README）。
//
// 状态上报：每次 call 结束把该 provider 的 engine 快照原子写
// {dsh-home}/cli-bridge-mcp-<id>.json，家级灯 GET /cli-bridge/status 读盘合并 ——
// MCP 子进程没有 ctx.emit，这是唯一的跨进程通道（红线：写失败静默，绝不影响工具结果）。

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMcpBridgePayload } from '../core/bridge-kit.mjs'
import * as agyMcp from './providers/agy.mjs'
import * as codebuddyMcp from './providers/codebuddy.mjs'
import * as mimoMcp from './providers/mimo.mjs'

const SERVER_NAME = 'cli-bridge-mcp'
const SERVER_VERSION = '0.1.0'
const PROTOCOL = '2024-11-05'

const PROVIDERS = [agyMcp, codebuddyMcp, mimoMcp]

function detectHomeDir() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'DSH Desktop', 'dsh-home')
  if (process.env.HOME) return join(process.env.HOME, '.dsh')
  try { return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))) } catch (e) { return process.cwd() }
}

const io = {
  fs: { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync },
  path: { join, dirname, resolve, sep: process.platform === 'win32' ? '\\' : '/', basename: (p) => String(p).split(/[\\/]/).pop() },
  homeDir: detectHomeDir(),
  env: process.env,
  log: (msg) => { try { process.stderr.write('[' + SERVER_NAME + '] ' + msg + '\n') } catch (e) { } }
}

// 快照写盘器：provider 模块的 engine publish 到这里。
export function makeSnapshotWriter(id) {
  const target = join(io.homeDir, 'cli-bridge-mcp-' + id + '.json')
  return function publish(snap) {
    try {
      const payload = buildMcpBridgePayload(snap, process.pid, Date.now())
      const tmp = target + '.' + process.pid + '.tmp'
      try { mkdirSync(dirname(target), { recursive: true }) } catch (e) { }
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, target)
    } catch (e) { /* 灯数据是尽力而为，绝不影响工具调用 */ }
  }
}

function selectedProviders() {
  const arg = process.argv.find((a) => a.startsWith('--provider='))
  const want = arg ? arg.slice('--provider='.length) : (process.env.CLI_BRIDGE_PROVIDER || '')
  if (!want) return PROVIDERS
  const hit = PROVIDERS.filter((p) => p.meta.id === want)
  if (!hit.length) { io.log('unknown --provider=' + want); process.exit(2) }
  return hit
}

function toolSurface() {
  const out = []
  for (const p of selectedProviders()) {
    try { for (const t of p.tools(process.env)) out.push(Object.assign({}, t, { __provider: p.meta.id })) }
    catch (e) { io.log('provider ' + p.meta.id + ' tools() failed: ' + String(e && e.message || e)) }
  }
  return out
}

const TOOLS = toolSurface()

function writeMsg(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n') } catch (e) { }
}

let pendingCalls = 0
let stdinClosed = false
function maybeExit() { if (stdinClosed && pendingCalls === 0) process.exit(0) }

async function handleLine(line) {
  let msg
  try { msg = JSON.parse(line) } catch (e) { return }
  if (!msg || typeof msg !== 'object') return
  const { id, method, params } = msg
  const isReq = id !== undefined && id !== null
  const reply = (result) => writeMsg({ jsonrpc: '2.0', id, result })
  const replyErr = (code, message) => writeMsg({ jsonrpc: '2.0', id, error: { code, message } })

  if (method === 'initialize') {
    writeMsg({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } } })
    return
  }
  if (method === 'notifications/initialized' || String(method || '').startsWith('notifications/')) return
  if (method === 'ping') { reply({}); return }
  if (method === 'tools/list') {
    reply({ tools: TOOLS.map(({ __provider, ...t }) => t) })
    return
  }
  if (method === 'tools/call') {
    const name = params && params.name
    const hit = TOOLS.filter((t) => t.name === name)[0]
    if (!hit) { replyErr(-32602, 'Unknown tool: ' + name); return }
    const provider = PROVIDERS.filter((p) => p.meta.id === hit.__provider)[0]
    pendingCalls++
    try {
      const text = await provider.call(name, (params && params.arguments) || {}, io)
      reply({ content: [{ type: 'text', text: String(text == null ? '' : text) }] })
    } catch (e) {
      reply({ content: [{ type: 'text', text: '[' + provider.meta.id + '] tool error: ' + String(e && e.message || e) }], isError: true })
    } finally {
      pendingCalls--
      maybeExit()
    }
    return
  }
  if (method === 'resources/list') { reply({ resources: [] }); return }
  if (method === 'prompts/list') { reply({ prompts: [] }); return }
  if (isReq) replyErr(-32601, 'Method not found: ' + method)
}

if (process.argv.includes('--check')) {
  const report = { ok: true, server: SERVER_NAME, version: SERVER_VERSION, providers: [], errors: [] }
  for (const p of selectedProviders()) {
    const entry = { id: p.meta.id, label: p.meta.label, version: p.meta.version, tools: [] }
    try {
      const tools = p.tools(process.env)
      if (!Array.isArray(tools) || !tools.length) throw new Error('tools() must return non-empty array')
      for (const t of tools) {
        if (!t.name || !t.inputSchema || t.inputSchema.type !== 'object') throw new Error('bad tool def: ' + JSON.stringify(t && t.name))
        entry.tools.push(t.name)
      }
      if (typeof p.check === 'function') p.check(process.env)
      if (typeof p.call !== 'function') throw new Error('call() missing')
    } catch (e) {
      entry.error = String(e && e.message || e)
      report.errors.push(p.meta.id + ': ' + entry.error)
    }
    report.providers.push(entry)
  }
  if (report.errors.length) report.ok = false
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.ok ? 0 : 1)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    if (line.trim()) handleLine(line)
  }
})
process.stdin.on('end', () => { stdinClosed = true; maybeExit() })
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
