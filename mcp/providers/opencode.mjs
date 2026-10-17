// mcp/providers/opencode.mjs — opencode MCP 工具面（契约 §4）。
// framing/生命周期归 keystone 统一服务器 mcp/cli-bridge-mcp.mjs。
//
// 与 agy 面的结构同构（旧 MCP 语义保持）：直接 spawn opencode(.exe)（win32 用
// opencode.exe；OPENCODE_BIN 覆盖；.js/.mjs 目标经 process.execPath 包装，供测试
// fixture 使用）。无 ctx.emit：状态走快照文件 {homeDir}/cli-bridge-mcp-opencode.json
// （bridge-kit buildMcpBridgePayload + 原子写 tmp→rename；写失败静默）。
//
// opencode 无 quota/额度门禁（凭据与额度由 opencode 自身与 provider 决定），
// 因此本面只有三件套。
import { spawn as nodeSpawn } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'

import defineProvider, { resolveExePrefix } from '../../providers/opencode.mjs'
import { createStatusEngine, createLineStream, buildMcpBridgePayload, isLimited, renderStatus } from '../../core/bridge-kit.mjs'
import { packageVersion } from '../version.mjs'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const meta = { id: 'opencode', label: 'OPENCODE', version: packageVersion() }

// ── 统一设置文件分区读（MCP 子进程无 ctx.get，只读 env/文件）───────────────────
// 与 mimo/agy 面同规则。注入 descriptor 的 readSettings，使设置面板里指定的
// binPath/defaultModel 在 MCP 形态同样生效（不只 preset 形态）—— 三个形态行为一致。
const SETTINGS_FILE_NAME = 'cli-bridge-settings.json'
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
    return { partition: (all && typeof all === 'object' && all.opencode) ? all.opencode : null, path: p, home: dirname(p) }
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
    const target = io.path.join(io.homeDir, 'cli-bridge-mcp-opencode.json')
    const payload = buildMcpBridgePayload(snapshot, process.pid, Date.now())
    const tmp = target + '.' + process.pid + '.tmp'
    try { io.fs.mkdirSync(io.path.dirname(target), { recursive: true }) } catch (e) {}
    io.fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    io.fs.renameSync(tmp, target)
  } catch (e) { /* 灯数据尽力而为，绝不影响工具调用 */ }
}
// provider.engine 在 attach 后才存在；MCP 形态不 attach，用本模块的 engine。
const engine = createStatusEngine({ provider, publish: publishSnapshot })
provider.engine = engine

// ── exe / cwd 解析 ────────────────────────────────────────────────────────────
// 与描述符同一套优先级（env > 桌面版探测 > PATH 名字）；二进制名 opencode-cli.exe
// （V2 桌面版），不做 opencode.exe 兜底以免误命中不能并存的另一个版本。
function exePrefix() {
  return resolveExePrefix(process.env, '')
}
function resolveCwd(a) {
  if (a && a.cwd) return resolvePath(String(a.cwd))
  return process.env.OPENCODE_MCP_CWD || process.cwd()
}

// ── spawn（实时折叠走 bridge-kit 行流）────────────────────────────────────────
function runOpencode(args) {
  return new Promise((resolve) => {
    const built = provider.buildArgv(exePrefix(), args, { planActive: false, defaultMode: 'auto' })
    const cwd = resolveCwd(args)
    let child
    try {
      child = nodeSpawn(built.argv[0], built.argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
      const res = { ok: false, status: 'OPENCODE_UNAVAILABLE', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: null, stderr: 'opencode spawn failed: ' + String(e && e.message || e) }
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
        res.stderr = (res.stderr ? res.stderr + ' ' : '') + '[killed by DSH timeout guard after ' + built.timeoutSec + 's; if this was a long-running script (build/test) raise timeoutSec]'
      }
      engine.end(res, cwd)
      resolve(res)
    })
  })
}

function textResult(res) {
  if (res.fallback) {
    return 'opencode unavailable (' + res.reason + '). Use native tools / the local model for this task; do not retry opencode.'
  }
  const limited = !res.ok && isLimited(res)
  const head = 'opencode ' + (res.ok ? 'OK' : 'FAILED') + ' [status=' + res.status +
    (res.sessionId ? ' session=' + res.sessionId : '') +
    (res.durationSeconds != null ? ' ' + res.durationSeconds + 's' : '') + ']'
  let note = ''
  if (limited) note = '\n\n[Note: this looks like a rate-limit / network failure. Do NOT retry opencode in a loop; finish the task with your own tools, or ask the user.]'
  const body = res.response || (res.stderr ? '[stderr] ' + res.stderr : (res.rawStdout ? '[raw] ' + res.rawStdout : ''))
  return head + (body ? '\n\n' + body : '') + note
}

// ── 工具面 ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'opencode_run',
    description: 'Dispatch a coding/build/debug/investigation task to the local opencode agent CLI and return its final answer. opencode runs fully non-interactively (permissions auto-approved, never blocks on a prompt). Prefer it for implementation, multi-file edits, refactors and debugging; use your own tools for quick read-only lookups and final build/test verification. While it runs, call opencode_status to watch what opencode is doing live.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task instruction for opencode. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — opencode reads the repo itself). For follow-ups on the same topic, use opencode_continue with latest=true or sessionId (opencode keeps session context; state only what is new).' },
        model: { type: 'string', description: 'Optional model in provider/model form (e.g. "anthropic/claude-sonnet-4-20250514"). Omit to let opencode use its own configured default.' },
        agent: { type: 'string', description: 'Optional opencode agent (subagent) name.' },
        variant: { type: 'string', description: 'Optional provider-specific reasoning variant (e.g. high, max, minimal).' },
        cwd: { type: 'string', description: 'Working directory for opencode (default: OPENCODE_MCP_CWD or the DSH workspace).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional file paths to attach to the message.' },
        title: { type: 'string', description: 'Optional session title.' },
        timeoutSec: { type: 'integer', description: '10-3600, default 600.' },
        autoApprove: { type: 'boolean', description: 'Default true: pass --auto so opencode never blocks on a permission prompt. Set false to require explicit approval.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'opencode_continue',
    description: 'Continue an existing opencode session with a follow-up prompt, reusing opencode context. Pass sessionId from a prior opencode_run result, or set latest=true for the most recent session.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Follow-up instruction for the ongoing opencode session. State only what is new; opencode preserves its session context.' },
        sessionId: { type: 'string' },
        latest: { type: 'boolean', description: 'Continue the most recent opencode session.' },
        model: { type: 'string' },
        agent: { type: 'string' },
        variant: { type: 'string' },
        cwd: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        timeoutSec: { type: 'integer', description: '10-3600, default 600.' },
        autoApprove: { type: 'boolean' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'opencode_status',
    description: 'Read a live snapshot of what the local opencode agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or agent_response thinking/typing), the recent step trail (tools executed, done/error), and the last completed run status + session id. Optional cwd filters to a single project. Call this to check on an in-flight opencode_run/opencode_continue without waiting for it to finish.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }
  },
  {
    name: 'opencode_models',
    description: 'List the models available to the local opencode CLI (from `opencode models`). Use it to pick a model before opencode_run, or to check which models are free. Prefer a -free model for routine work and reserve paid/frontier models for tasks that genuinely need them. If the CLI is missing or not logged in this returns ok:false with an actionable error — it never invents a model list.',
    inputSchema: {
      type: 'object',
      properties: {
        freeOnly: { type: 'boolean', description: 'Return only free models (id ends with -free).' },
        provider: { type: 'string', description: 'Optional provider filter, e.g. "opencode" or "opencode-go".' }
      }
    }
  }
]

export function tools(env) {
  return TOOLS.map((t) => Object.assign({}, t))
}

export async function call(name, args, io) {
  if (io) lastIo = io
  if (!lastIo) return 'opencode error: MCP io not initialized'
  const a = args || {}
  if (name === 'opencode_status') {
    const snap = engine.statusSnapshot()
    if (a.cwd) {
      snap.projects = snap.projects.filter((p) => p.cwd === String(a.cwd))
      const g = snap.projects[0]
      if (g) Object.assign(snap, { state: g.state, running: g.running, current: g.current, trail: g.trail, lastStatus: g.lastStatus, lastAt: g.lastAt, lastSessionId: g.lastSessionId, lastBackend: g.lastBackend, fallbackActive: g.fallbackActive, updatedAt: g.updatedAt })
    }
    return renderStatus(snap, provider)[0].text
  }
  if (name === 'opencode_models') {
    const res = await provider.listModels(a)
    if (!res.ok) return 'opencode_models failed: ' + String(res.error || 'unknown')
    const list = res.models || []
    if (!list.length) return 'opencode_models: no models matched'
    const lines = ['opencode models (' + list.length + '):']
    for (const m of list.slice(0, 40)) lines.push('  ' + m.id + (m.free ? '  [free]' : ''))
    if (list.length > 40) lines.push('  … and ' + (list.length - 40) + ' more')
    const free = list.filter((m) => m.free).length
    lines.push('free: ' + free + ' / ' + list.length)
    if (a.freeOnly && !free) lines.push('(no free models under this filter)')
    return lines.join('\n')
  }
  if (!a.prompt || !String(a.prompt).trim()) return 'opencode error: prompt is required'
  const mapped = Object.assign({}, a)
  if (name === 'opencode_continue') {
    if (!mapped.sessionId && mapped.latest) mapped.continueLatest = true
  }
  const res = await runOpencode(mapped)
  return textResult(res)
}

export function check(env) {
  const ts = tools(env)
  const names = ts.map((t) => t.name)
  for (const req of ['opencode_run', 'opencode_continue', 'opencode_status', 'opencode_models']) {
    if (!names.includes(req)) throw new Error('opencode mcp: missing tool ' + req)
  }
  for (const t of ts) {
    if (!t.name || !t.description || !t.inputSchema || t.inputSchema.type !== 'object') throw new Error('opencode mcp: bad tool def ' + JSON.stringify(t && t.name))
  }
  // MCP 面必须覆盖 descriptor 三件套（名字一致，提示词连续性红线）。
  for (const k of ['run', 'continue', 'status']) {
    if (!names.includes(provider.tools[k].name)) throw new Error('opencode mcp: tools surface missing descriptor name ' + provider.tools[k].name)
  }
  // argv 契约漂移锁（实测 opencode 1.19.0 flag 集）。
  const b = provider.buildArgv(['opencode'], { prompt: 'x' }, { planActive: false })
  for (const f of ['run', 'x', '--format', 'json', '--auto']) {
    if (!b.argv.includes(f)) throw new Error('opencode mcp: argv contract drift: ' + f)
  }
  const b2 = provider.buildArgv(['opencode'], { prompt: 'x', autoApprove: false }, { planActive: false })
  if (b2.argv.includes('--auto')) throw new Error('opencode mcp: autoApprove=false must omit --auto')
  return true
}
