// mcp/providers/agy.mjs — agy MCP 工具面（契约 §4；移植自旧 agy-mcp-server.mjs，
// framing/生命周期归 keystone 统一服务器 mcp/cli-bridge-mcp.mjs）。
//
// 旧语义保持：
//  - 直接 spawn agy(.exe)（win32 用 agy.exe；AGY_BIN 覆盖；.js/.mjs 目标经
//    process.execPath 包装，供测试 fixture 使用）。
//  - cwd 兜底 = env AGY_MCP_CWD || process.cwd()。旧仓硬编码
//    'C:\\Users\\lcl\\Desktop\\DSH'，机器特定，新实现按定案改 process.cwd() 兜底。
//    （注：AGY_MCP_ALLOWED_ROOTS 白名单是旧 codebuddy MCP 的特性，旧 agy MCP 没有，
//     不自造语义 —— Lead 定案 1。）
//  - 5h 额度硬阻断（30 分钟缓存）照旧：Gemini 5h <10% → 不调用 agy。
//  - 无 ctx.emit：状态走快照文件 {homeDir}/cli-bridge-mcp-agy.json
//    （bridge-kit buildMcpBridgePayload + 原子写 tmp→rename；写失败静默）。
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import defineProvider from '../../providers/agy.mjs'
import { createStatusEngine, createLineStream, buildMcpBridgePayload, isLimited, renderStatus } from '../../core/bridge-kit.mjs'
import { packageVersion } from '../version.mjs'

export const meta = { id: 'agy', label: 'AGY', version: packageVersion() }

const QUOTA_SCRIPT_DEFAULT = fileURLToPath(new URL('../../bin/agy-quota.mjs', import.meta.url))

const provider = defineProvider({
  env: process.env,
  process,
  nodeChild: { spawn: nodeSpawn },
  quotaScript: existsSync(QUOTA_SCRIPT_DEFAULT) ? QUOTA_SCRIPT_DEFAULT : null
})

let lastIo = null
function publishSnapshot(snapshot) {
  const io = lastIo
  if (!io) return
  try {
    const target = io.path.join(io.homeDir, 'cli-bridge-mcp-agy.json')
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

// ── exe / cwd 解析（旧 MCP verbatim + AGY_BIN）────────────────────────────────
function exePrefix() {
  const bin = process.env.AGY_BIN || process.env.AGY_CLI || ''
  if (bin) {
    if (/\.(mjs|cjs|js)$/i.test(bin)) return [process.execPath, bin]
    return [bin]
  }
  return [process.platform === 'win32' ? 'agy.exe' : 'agy']
}
function resolveCwd(a) {
  if (a && a.cwd) return resolvePath(String(a.cwd))
  return process.env.AGY_MCP_CWD || process.cwd()
}

// ── spawn（旧 runAgy verbatim 语义；实时折叠走 bridge-kit 行流）────────────────
function runAgy(args) {
  return new Promise((resolve) => {
    const built = provider.buildArgv(exePrefix(), args, { planActive: false, defaultMode: 'auto' })
    const cwd = resolveCwd(args)
    let child
    try {
      child = nodeSpawn(built.argv[0], built.argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      resolve({ ok: false, status: 'SPAWN_ERROR', response: '', conversationId: null, sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: null, stderr: String(e && e.message || e) })
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
      const res = { ok: false, status: 'AGY_UNAVAILABLE', response: '', conversationId: null, sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: null, stderr: 'agy spawn failed: ' + String(e && e.message || e) }
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

// 旧 textResult verbatim（conversationId/sessionId 双写已在 buildResult）。
function textResult(res) {
  if (res.fallback) {
    return 'agy unavailable (' + res.reason + '). Use native tools / the local model for this task; do not retry agy.'
  }
  const limited = !res.ok && isLimited(res)
  const head = 'agy ' + (res.ok ? 'OK' : 'FAILED') + ' [status=' + res.status + ' mode=' + res.mode +
    (res.conversationId ? ' conv=' + res.conversationId : '') +
    (res.durationSeconds != null ? ' ' + res.durationSeconds + 's' : '') + ']'
  let note = ''
  if (limited) note = '\n\n[Note: this looks like a rate-limit / network failure. Do NOT retry agy in a loop; finish the task with your own tools, or ask the user.]'
  const body = res.response || (res.stderr ? '[stderr] ' + res.stderr : (res.rawStdout ? '[raw] ' + res.rawStdout : ''))
  return head + (body ? '\n\n' + body : '') + note
}

// ── 工具面（旧 MCP TOOLS verbatim：run/continue 无 background，+agy_quota）────
const TOOLS = [
  {
    name: 'agy_run',
    description: 'Dispatch a coding/build/debug/investigation task to the local agy agent CLI and return its final answer. agy runs fully non-interactively (permissions auto-approved, never prompts). Prefer it for implementation, multi-file edits, refactors and debugging; use your own tools for quick read-only lookups and final build/test verification. mode=plan runs agy read-only; default accept-edits applies edits directly. While it runs, call agy_status to watch what agy is doing live.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task instruction for agy. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — agy reads the repo itself). For follow-ups on the same topic, use agy_continue with latest=true or conversationId (agy keeps conversation context; state only what is new).' },
        mode: { type: 'string', enum: ['plan', 'accept-edits'], description: 'plan = no writes; accept-edits = allow edits (default).' },
        model: { type: 'string', description: 'Optional agy model id — pick from the Gemini pool or utility models per the model-selection policy (use agy_quota to see the recommended:true list). Do NOT pass a Claude/GPT (3p) model.' },
        effort: { type: 'string', enum: ['low', 'medium', 'high'] },
        cwd: { type: 'string', description: 'Working directory for agy (default: AGY_MCP_CWD or the DSH workspace).' },
        addDirs: { type: 'array', items: { type: 'string' } },
        timeoutSec: { type: 'integer', description: '10-3600, default 600.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'agy_continue',
    description: 'Continue an existing agy conversation with a follow-up prompt, reusing agy context. Pass conversationId from a prior agy_run result, or latest=true for the most recent conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Follow-up instruction for the ongoing agy conversation. State only what is new; agy preserves its conversation context.' },
        conversationId: { type: 'string' },
        latest: { type: 'boolean', description: 'Continue the most recent agy conversation.' },
        mode: { type: 'string', enum: ['plan', 'accept-edits'] },
        model: { type: 'string' },
        effort: { type: 'string', enum: ['low', 'medium', 'high'] },
        cwd: { type: 'string' },
        timeoutSec: { type: 'integer', description: '10-3600, default 600.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'agy_status',
    description: 'Read a live snapshot of what the local agy agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or agent_response thinking/typing), the recent step trail (tools executed, done/error), and the last completed run status + conversation id. Optional cwd filters to a single project. Call this to check on an in-flight agy_run/agy_continue without waiting for it to finish.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }
  },
  {
    name: 'agy_quota',
    description: 'Query the Google AI plan (Antigravity OAuth consumer) quota pool behind the local agy CLI. Reads the Windows credential manager entry (gemini:antigravity) that agy wrote at login, refreshes the access token, then calls Google Cloud Code quota APIs: fetchAvailableModels (per-model remaining pool percentage) and retrieveUserQuotaSummary (grouped plan buckets: weekly + 5h windows). Each model carries family (gemini/claude/gpt/other) and recommended (false for Claude/GPT 3p models — do not pass those to agy_run; they are effectively unusable). Call before agy_run only if you want the numbers: the Gemini 5h window is the sole gate (agy_run/agy_continue already refuse silently below 10% of it), while the weekly window is NOT a per-task gate — an exhausted weekly bucket only means agy is a poor pick for the rest of the week, never a reason to abort or shrink the current task.',
    inputSchema: { type: 'object', properties: { summary: { type: 'boolean', description: 'Return only a compact summary (weekly buckets + top models).' } } }
  }
]

export function tools(env) {
  // MCP 形态是真 Node 进程（process 恒可用）→ quota 工具恒注册；畸形无 process
  // 环境退化为三件套（Lead 定案 4 的注册条件精神）。
  if (typeof process === 'undefined') return TOOLS.filter((t) => t.name !== 'agy_quota').map((t) => Object.assign({}, t))
  return TOOLS.map((t) => Object.assign({}, t))
}

export async function call(name, args, io) {
  if (io) lastIo = io
  if (!lastIo) return 'agy error: MCP io not initialized'
  const a = args || {}
  if (name === 'agy_quota') {
    const res = await provider.cachedQuotaCheck()
    const lines = []
    if (!res || !res.ok) {
      lines.push('agy_quota failed: ' + String((res && res.error) || 'unknown'))
    } else if (a.summary) {
      const weekly = (res.groups || []).flatMap((g) => (g.buckets || []).filter((b) => b.window === 'weekly').map((b) => ({ g: g.displayName, id: b.bucketId, pct: Math.round((b.remainingFraction || 0) * 100), reset: b.resetTime })))
      lines.push('agy quota [tier=' + (res.tier || '?') + '] weekly: ' + weekly.map((w) => (w.id || w.g) + ' ' + w.pct + '%').join(', '))
      const pool = (res.models || []).filter((m) => m.recommended !== false)
      const list = pool.length ? pool : (res.models || [])
      const top = list.slice(0, 4).map((m) => String(m.name).split('-').slice(0, 2).join('-') + ' ' + m.percentage + '%').join(', ')
      lines.push('top models: ' + (top || '(none)'))
    } else {
      lines.push('agy quota [tier=' + (res.tier || '?') + ']')
      for (const g of (res.groups || [])) {
        for (const b of (g.buckets || [])) {
          const pct = typeof b.remainingFraction === 'number' ? Math.round(b.remainingFraction * 100) : '?'
          lines.push('· ' + (b.bucketId || g.displayName || '') + ' [' + (b.window || '') + '] ' + pct + '%' + (b.resetTime ? ' reset=' + b.resetTime : ''))
        }
      }
      lines.push('models (pool %):')
      for (const m of (res.models || []).slice(0, 10)) { lines.push('  ' + (m.displayName || m.name) + ' : ' + m.percentage + '%' + (m.recommended === false ? ' [3p: Claude/GPT 不推荐]' : '') + (m.resetTime ? ' (reset ' + m.resetTime + ')' : '')) }
    }
    return lines.join('\n')
  }
  if (name === 'agy_status') {
    const snap = engine.statusSnapshot()
    if (a.cwd) {
      snap.projects = snap.projects.filter((p) => p.cwd === String(a.cwd))
      const g = snap.projects[0]
      if (g) Object.assign(snap, { state: g.state, running: g.running, current: g.current, trail: g.trail, lastStatus: g.lastStatus, lastAt: g.lastAt, lastSessionId: g.lastSessionId, lastBackend: g.lastBackend, fallbackActive: g.fallbackActive, updatedAt: g.updatedAt })
    }
    return renderStatus(snap, provider)[0].text
  }
  if (!a.prompt || !String(a.prompt).trim()) return 'agy error: prompt is required'
  const mapped = Object.assign({}, a)
  if (name === 'agy_continue') {
    if (!mapped.conversationId && mapped.latest) mapped.continueLatest = true
    if (mapped.conversationId) mapped.sessionId = mapped.conversationId
  }
  // v1.5.11 5h 硬阻断 verbatim：额度不可得/失败 → 静默放行（宽容降级）。
  const block = await provider.quotaGate5h(mapped, null)
  if (block) return 'agy 未调用（5h 池子额度 <10%）：' + block.stderr
  const res = await runAgy(mapped)
  return textResult(res)
}

export function check(env) {
  const ts = tools(env)
  const names = ts.map((t) => t.name)
  for (const req of ['agy_run', 'agy_continue', 'agy_status', 'agy_quota']) {
    if (!names.includes(req)) throw new Error('agy mcp: missing tool ' + req)
  }
  for (const t of ts) {
    if (!t.name || !t.description || !t.inputSchema || t.inputSchema.type !== 'object') throw new Error('agy mcp: bad tool def ' + JSON.stringify(t && t.name))
  }
  // MCP 面必须覆盖 descriptor 三件套（名字一致，提示词连续性红线）。
  for (const k of ['run', 'continue', 'status']) {
    if (!names.includes(provider.tools[k].name)) throw new Error('agy mcp: tools surface missing descriptor name ' + provider.tools[k].name)
  }
  const b = provider.buildArgv(['agy'], { prompt: 'x' }, { planActive: false })
  for (const f of ['--output-format', 'stream-json', '--dangerously-skip-permissions', '--print-timeout', '600s', '--mode', 'accept-edits']) {
    if (!b.argv.includes(f)) throw new Error('agy mcp: argv contract drift: ' + f)
  }
  return true
}
