// mcp/providers/claude.mjs — claude MCP 工具面（契约 §4）。
// framing/生命周期归 keystone 统一服务器 mcp/cli-bridge-mcp.mjs。
//
// 与 opencode 面结构同构：直接 spawn claude（原生 exe 直接用；npm 的 .cmd 经 shell:true，
// Windows 限制；.js/.mjs 目标经 process.execPath 包装，供测试 fixture 使用）。
// 无 ctx.emit：状态走快照文件 {homeDir}/cli-bridge-mcp-claude.json（bridge-kit
// buildMcpBridgePayload + 原子写 tmp→rename；写失败静默，绝不影响工具结果）。
//
// 工具名/schema 从描述符取（单一来源，防两处漂移），描述与 background 语义按 MCP 面重写：
// MCP 没有 DSH jobs，background 参数在该形态无意义，故 schema 里裁掉。
import { spawn as nodeSpawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath, dirname } from 'node:path'

import defineProvider, { resolveExePrefix } from '../../providers/claude.mjs'
import { splitExeSpec, quoteShellArg } from '../../providers/claude-exe.mjs'
import { createStatusEngine, createLineStream, buildMcpBridgePayload, isLimited, renderStatus } from '../../core/bridge-kit.mjs'
import { packageVersion } from '../version.mjs'

export const meta = { id: 'claude', label: 'CLAUDE', version: packageVersion() }

const SETTINGS_FILE_NAME = 'cli-bridge-settings.json'

// 统一设置文件分区读（MCP 子进程无 ctx.get，只读 env/文件）—— 设置面板里的
// binPath/defaultModel 在 MCP 形态同样生效（与 preset 行为一致）。
function resolveSettingsFile(env) {
  try {
    if (env.CLI_BRIDGE_SETTINGS_FILE) return env.CLI_BRIDGE_SETTINGS_FILE
    if (env.DSH_HOME) return resolvePath(env.DSH_HOME, SETTINGS_FILE_NAME)
    if (process.platform === 'win32' && env.APPDATA) return resolvePath(env.APPDATA, 'DSH Desktop', 'dsh-home', SETTINGS_FILE_NAME)
    if (env.HOME) return resolvePath(env.HOME, '.dsh', SETTINGS_FILE_NAME)
  } catch (e) { }
  return null
}
function readPartition(env) {
  const p = resolveSettingsFile(env)
  if (!p) return { partition: null, path: null, home: null }
  try {
    const all = JSON.parse(readFileSync(p, 'utf8'))
    return { partition: (all && typeof all === 'object' && all.claude) ? all.claude : null, path: p, home: dirname(p) }
  } catch (e) {
    return { partition: null, path: p, home: dirname(p) }
  }
}

const provider = defineProvider({
  env: process.env,
  process,
  nodeChild: { spawn: nodeSpawn },
  readSettings: () => readPartition(process.env)
})

let lastIo = null
function publishSnapshot(snapshot) {
  const io = lastIo
  if (!io) return
  try {
    const target = io.path.join(io.homeDir, 'cli-bridge-mcp-claude.json')
    const payload = buildMcpBridgePayload(snapshot, process.pid, Date.now())
    const tmp = target + '.' + process.pid + '.tmp'
    try { io.fs.mkdirSync(io.path.dirname(target), { recursive: true }) } catch (e) {}
    io.fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    io.fs.renameSync(tmp, target)
  } catch (e) { /* 灯数据尽力而为，绝不影响工具调用 */ }
}
const engine = createStatusEngine({ provider, publish: publishSnapshot })
provider.engine = engine

function exePrefix() { return resolveExePrefix(process.env, '') }
function resolveCwd(a) {
  if (a && a.cwd) return resolvePath(String(a.cwd))
  return process.env.CLAUDE_MCP_CWD || process.cwd()
}

// ── spawn（实时折叠走 bridge-kit 行流；.cmd 走 shell）─────────────────────────
function runClaude(args) {
  return new Promise((resolve) => {
    const built = provider.buildArgv(exePrefix(), args, { planActive: false, defaultMode: 'auto' })
    const cwd = resolveCwd(args)
    const cmd = built.argv[0]
    const argv = built.argv.slice(1)
    const isShell = /\.(cmd|bat)$/i.test(cmd)
    const spawnCmd = isShell ? [cmd].concat(argv).map(quoteShellArg).join(' ') : cmd
    let child
    try {
      child = nodeSpawn(spawnCmd, isShell ? [] : argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: isShell })
    } catch (e) {
      resolve({ ok: false, status: 'SPAWN_ERROR', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: null, stderr: String(e && e.message || e) })
      return
    }
    engine.begin(cwd)
    let out = ''
    let err = ''
    let killed = false
    const timer = setTimeout(() => { killed = true; try { child.kill() } catch (e) {} }, (built.timeoutSec + 60) * 1000)
    const stream = createLineStream((ln) => {
      const t = ln.trim()
      if (!t.startsWith('{')) return
      try { engine.foldEvent(JSON.parse(t), cwd) } catch (e) {}
    })
    child.stdout.on('data', (d) => {
      out += d
      if (out.length > 4000000) out = out.slice(-2000000)
      stream.pushChunk(String(d))
    })
    child.stderr.on('data', (d) => { err += d; if (err.length > 1000000) err = err.slice(-500000) })
    child.on('error', (e) => {
      clearTimeout(timer)
      stream.flush()
      const res = { ok: false, status: 'CLAUDE_UNAVAILABLE', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: null, stderr: 'claude spawn failed: ' + String(e && e.message || e) }
      engine.end(res, cwd)
      resolve(res)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      stream.flush()
      const outcome = { exitCode: killed ? 124 : code }
      let res = provider.buildResult(provider.parseJson(out), outcome, built.mode, err, out, null)
      if (killed && !res.ok) {
        res.status = 'HUNG_TIMEOUT'
        res.stderr = (res.stderr ? res.stderr + ' ' : '') + '[killed by DSH timeout guard after ' + built.timeoutSec + 's; if this was a long-running task raise timeoutSec]'
      }
      engine.end(res, cwd)
      resolve(res)
    })
  })
}

function textResult(res) {
  const head = 'claude ' + (res.ok ? 'OK' : 'FAILED') + ' [status=' + res.status +
    (res.sessionId ? ' session=' + res.sessionId : '') +
    (res.modelUsed ? ' model=' + res.modelUsed : '') +
    (res.durationSeconds != null ? ' ' + res.durationSeconds + 's' : '') + ']'
  let note = ''
  if (!res.ok && isLimited(res)) note = '\n\n[Note: this looks like a rate-limit / network failure. Do NOT retry claude in a loop; finish the task with your own tools, or ask the user.]'
  const hint = provider.failureHint(res)
  const body = res.response || (res.stderr ? '[stderr] ' + res.stderr : (res.rawStdout ? '[raw] ' + res.rawStdout : ''))
  return head + (body ? '\n\n' + body : '') + (hint ? '\n\n' + hint : '') + note
}

// ── 工具面 ────────────────────────────────────────────────────────────────────
function mcpSchema(name) {
  const src = provider.tools[name].inputSchema
  const clone = JSON.parse(JSON.stringify(src))
  if (clone.properties) delete clone.properties.background
  return clone
}

export function tools(env) {
  const d = provider.tools
  return [
    {
      name: d.run.name,
      description: 'Dispatch a coding/build/debug/investigation task to the local Claude Code CLI and return its final answer. claude runs fully non-interactively (permissions approved, never blocks on a prompt) and streams live steps. Prefer it for implementation, multi-file edits, refactors and debugging; use your own tools for quick read-only lookups and final build/test verification. While it runs, call claude_status to watch what claude is doing live.',
      inputSchema: mcpSchema('run')
    },
    {
      name: d.continue.name,
      description: 'Continue an existing claude session with a follow-up prompt, reusing claude context (passes --resume <sessionId>, or --continue with latest=true).',
      inputSchema: mcpSchema('continue')
    },
    {
      name: d.status.name,
      description: 'Read a live snapshot of what the local claude agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or agent_response thinking/typing), the recent step trail, and the last completed run status + session id. Optional cwd filters to a single project.',
      inputSchema: JSON.parse(JSON.stringify(d.status.inputSchema))
    },
    {
      name: 'claude_models',
      description: 'List the models the current claude account/endpoint really supports, read LIVE from the server (probes it once with a deliberately invalid model id and parses the "The supported API model names are …" answer). Use it to pick a model before claude_run. Returns ok:false with an actionable error when no live roster can be read — it never invents a list and never presents ANTHROPIC_*_MODEL aliases as the usable set.',
      inputSchema: (function () {
        const et = (provider.extraTools || [])[0]
        return JSON.parse(JSON.stringify(et ? et.inputSchema : { type: 'object', properties: {} }))
      })()
    }
  ]
}

export async function call(name, args, io) {
  if (io) lastIo = io
  if (!lastIo) return 'claude error: MCP io not initialized'
  const a = args || {}
  if (name === 'claude_status') {
    const snap = engine.statusSnapshot()
    if (a.cwd) {
      snap.projects = snap.projects.filter((p) => p.cwd === String(a.cwd))
      const g = snap.projects[0]
      if (g) Object.assign(snap, { state: g.state, running: g.running, current: g.current, trail: g.trail, lastStatus: g.lastStatus, lastAt: g.lastAt, lastSessionId: g.lastSessionId, lastBackend: g.lastBackend, fallbackActive: g.fallbackActive, updatedAt: g.updatedAt })
    }
    return renderStatus(snap, provider)[0].text
  }
  if (name === 'claude_models') {
    const et = (provider.extraTools || [])[0]
    const res = await provider.listModels(a)
    if (et && typeof et.render === 'function') return et.render(a, res)[0].text
    return res.ok ? 'claude models: ' + res.models.map((m) => m.id).join(', ') : 'claude_models failed: ' + String(res.error || 'unknown')
  }
  if (!a.prompt || !String(a.prompt).trim()) return 'claude error: prompt is required'
  const mapped = Object.assign({}, a)
  if (name === 'claude_continue') {
    if (!mapped.sessionId && mapped.latest) mapped.continueLatest = true
  }
  const res = await runClaude(mapped)
  return textResult(res)
}

export function check(env) {
  const ts = tools(env)
  const names = ts.map((t) => t.name)
  for (const req of ['claude_run', 'claude_continue', 'claude_status', 'claude_models']) {
    if (names.indexOf(req) < 0) throw new Error('claude mcp: missing tool ' + req)
  }
  for (const t of ts) {
    if (!t.name || !t.description || !t.inputSchema || t.inputSchema.type !== 'object') throw new Error('claude mcp: bad tool def ' + JSON.stringify(t && t.name))
  }
  // MCP 面必须覆盖 descriptor 三件套（名字同源，提示词连续性红线）。
  for (const k of ['run', 'continue', 'status']) {
    if (names.indexOf(provider.tools[k].name) < 0) throw new Error('claude mcp: tools surface missing descriptor name ' + provider.tools[k].name)
  }
  // background 在 MCP 形态无 jobs 语义 → 必须裁掉（防止智能体误以为可后台派发丢结果）。
  if (ts[0].inputSchema.properties && ts[0].inputSchema.properties.background) throw new Error('claude mcp: run schema must not advertise background')
  // argv 契约漂移锁（实测 Claude Code 2.0.76 的 flag 集）。
  const b = provider.buildArgv(['claude'], { prompt: 'x' }, { planActive: false })
  for (const f of ['-p', 'x', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']) {
    if (b.argv.indexOf(f) < 0) throw new Error('claude mcp: argv contract drift: ' + f)
  }
  const b2 = provider.buildArgv(['claude'], { prompt: 'x', mode: 'plan' }, {})
  if (b2.argv.indexOf('--permission-mode') < 0 || b2.argv.indexOf('plan') < 0) throw new Error('claude mcp: plan mode must pass --permission-mode plan')
  const b3 = provider.buildArgv(['claude'], { prompt: 'x', sessionId: 'sid-1' }, {})
  if (b3.argv.indexOf('--resume') < 0 || b3.argv.indexOf('sid-1') < 0) throw new Error('claude mcp: resume must pass --resume <id>')
  return true
}
