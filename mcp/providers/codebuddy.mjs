// mcp/providers/codebuddy.mjs — codebuddy MCP 工具面（契约 §4；移植自旧
// mcp/codebuddy-mcp-server.mjs，framing/生命周期归 keystone 统一服务器
// mcp/cli-bridge-mcp.mjs）。
//
// 旧语义保持（verbatim 行锚 = 旧 codebuddy-mcp-server.mjs）：
//  - 三面独立安装包候选链 commandFor（L111-126）：node + bin 脚本优先（.cmd shim
//    spawn EINVAL，CVE-2024-27980），workbuddy/codebuddy-en 走 Program Files 候选，
//    npm 面 CODEBUDDY_BIN > npm 全局 bin > 裸 'codebuddy'。
//  - backendUnavailable 前置检查（L129-137）与 spawn error 文案（L293）。
//  - codebuddy-en 无凭据 → AUTH_REQUIRED 早退，不白跑 spawn（L213-220）。
//  - CODEBUDDY_MCP_ALLOWED_ROOTS cwd 白名单（L140-158）：守卫在 call() 分发前
//    解析最终 cwd（参数 > 会话归属 > 默认）后执行；env 一律读 io.env（测试注入
//    面，Lead 定案），不直接摸 process.env。
//  - 瞬时错误静默重试一次（L449-453，续接类不重试）；旧 `if(!res.ok) out.isError
//    =false` 怪癖在新形态天然成立（keystone 统一包装无 isError 位）。
//  - 状态灯：本模块自持 engine，快照原子写 {homeDir}/cli-bridge-mcp-codebuddy.json
//    （keystone readMcpFile 约定；写失败静默）。kit 的 makeSnapshotWriter 在本聚合
//    服务器内 —— 反向 import 会成环，按 agy 面同款复刻原子写。
//  - 设置：统一文件 cli-bridge-settings.json 的 codebuddy 分区（5s 缓存），旧扁平
//    文件的字段级迁移在 DSH 面板侧由 keystone 完成；这里读不到即用默认值。
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve as resolvePath, join as nodePathJoin } from 'node:path'

import defineProvider from '../../providers/codebuddy.mjs'
import { createStatusEngine, createLineStream, buildMcpBridgePayload, mcpBridgeFileName } from '../../core/bridge-kit.mjs'

export const meta = { id: 'codebuddy', label: 'CODEBUDDY', version: '0.1.0' }

const provider = defineProvider({
  env: process.env,
  process,
  nodeFs: { readFileSync, existsSync },
  nodePath: { join: nodePathJoin, sep: process.platform === 'win32' ? '\\' : '/' }
})

// publish 用 io（最近一次 call 注入）定位 homeDir；模块级 engine 只经此通道写盘。
let lastIo = null
function publishSnapshot(snapshot) {
  const io = lastIo
  if (!io) return
  try {
    const target = io.path.join(io.homeDir, mcpBridgeFileName('codebuddy'))
    const payload = buildMcpBridgePayload(snapshot, process.pid, Date.now())
    const tmp = target + '.' + process.pid + '.tmp'
    try { io.fs.mkdirSync(io.path.dirname(target), { recursive: true }) } catch (e) {}
    io.fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    io.fs.renameSync(tmp, target)
  } catch (e) { /* 灯数据尽力而为，绝不影响工具调用 */ }
}
const engine = createStatusEngine({ provider, publish: publishSnapshot })
provider.engine = engine

// ── settings（统一文件 codebuddy 分区 + 5s 缓存；旧 readSettings L69-76 语义）──
const SETTINGS_FILE_NAME = 'cli-bridge-settings.json'
let settingsCache = { at: 0, value: null }
function readSettings(io) {
  const now = Date.now()
  if (settingsCache.value && now - settingsCache.at < 5000) return settingsCache.value
  const o = io || lastIo || {}
  let snap = provider.normalizeSettings(null)
  try {
    const env = o.env || {}
    const p = env.CLI_BRIDGE_SETTINGS_FILE || (o.homeDir && o.path ? o.path.join(o.homeDir, SETTINGS_FILE_NAME) : null)
    if (p && o.fs && typeof o.fs.readFileSync === 'function') {
      const all = JSON.parse(o.fs.readFileSync(p, 'utf8'))
      if (all && typeof all === 'object' && all.codebuddy && typeof all.codebuddy === 'object') snap = provider.normalizeSettings(all.codebuddy)
    }
  } catch (e) { /* 文件缺失/损坏 → 默认值 */ }
  settingsCache = { at: now, value: snap }
  return snap
}

// ── CLI command resolution（旧 commandFor L111-126 verbatim；env 读 io.env）─────
function commandFor(backend, io) {
  const env = io.env || {}
  const nodeExe = process.execPath || 'node'
  if (backend === 'workbuddy') {
    const wbBin = env.WORKBUDDY_BIN || 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy'
    return [nodeExe, wbBin]
  }
  if (backend === 'codebuddy-en') {
    const enBin = env.CODEBUDDY_EN_BIN || 'C:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy'
    return [nodeExe, enBin]
  }
  const envBin = env.CODEBUDDY_BIN
  if (envBin && existsSync(envBin)) return [nodeExe, envBin]
  const npmBin = (env.APPDATA || 'C:\\Users\\lcl\\AppData\\Roaming') + '\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy'
  if (existsSync(npmBin)) return [nodeExe, npmBin]
  return ['codebuddy']
}

// 后端不可用时的明确错误信息（旧 backendUnavailable L129-137 verbatim）。
function backendUnavailable(backend, prefix) {
  if (backend === 'workbuddy' && !existsSync(prefix[1] || '')) {
    return 'WorkBuddy CLI not found at "' + (prefix[1] || '') + '" — install the WorkBuddy desktop app (the CLI ships with it at <install>\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy) or set WORKBUDDY_BIN.'
  }
  if (backend === 'codebuddy-en' && !existsSync(prefix[1] || '')) {
    return 'WorkBuddy AI (international) CLI not found at "' + (prefix[1] || '') + '" — install the WorkBuddy AI desktop app (the CLI ships with it at <install>\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy) or set CODEBUDDY_EN_BIN.'
  }
  return null
}

// ── cwd whitelist guard（旧 L140-158 verbatim；env 读 io.env —— Lead 定案）─────
// CODEBUDDY_MCP_ALLOWED_ROOTS 白名单（; 或 , 分隔的绝对目录）。设置后，每个
// codebuddy 调用的 cwd（含会话回落得到的 cwd）都必须位于白名单目录内，否则
// 拒绝。未设置 → 放行（默认兼容）。
function cwdBlockedReason(cwd, io) {
  const raw = (io.env || {}).CODEBUDDY_MCP_ALLOWED_ROOTS
  if (!raw || !String(raw).trim()) return null
  const target = resolvePath(String(cwd))
  const roots = String(raw).split(/[;,]+/).map((s) => s.trim()).filter(Boolean)
  if (!roots.length) return null
  const sep = io.path && io.path.sep ? io.path.sep : (process.platform === 'win32' ? '\\' : '/')
  const ok = roots.some((r) => {
    try {
      const rp = resolvePath(r)
      return target === rp || target.startsWith(rp.endsWith('/') || rp.endsWith('\\') ? rp : rp + sep)
    } catch (e) { return false }
  })
  if (ok) return null
  return 'cwd "' + target + '" is outside CODEBUDDY_MCP_ALLOWED_ROOTS (' + roots.join('; ') + '); this MCP server launches codebuddy with permissions bypassed, so the working directory is restricted to the whitelist. Pass an allowed cwd, or ask the server operator to extend CODEBUDDY_MCP_ALLOWED_ROOTS.'
}

// ── run orchestration（旧 runCodebuddy L198-313 verbatim 语义）────────────────
function runCodebuddy(args, io) {
  return new Promise((resolve) => {
    const settings = readSettings(io)
    const cwdFallback = (io.env || {}).CODEBUDDY_MCP_CWD || process.cwd()
    const target = engine.resolveTarget(args, cwdFallback)
    const backend = provider.resolveBackend(args, target, settings.preferredBackend)
    // 端点/凭据：端点按登录域自动对齐（修 npm 面 401）；凭据仅 codebuddy-en 需要
    // （其 token 被桌面 App 的 protector key 封装，headless 读不到）。
    const authDomain = provider.readBackendAuthDomain(backend, { env: io.env || {} })
    const enTok = backend === 'codebuddy-en' ? provider.resolveEnToken(settings.codebuddyEnToken) : { token: null }
    const authToken = enTok.token
    if (backend === 'codebuddy-en' && !authToken) {
      resolve({
        ok: false, status: 'AUTH_REQUIRED', response: '', sessionId: null, durationSeconds: null,
        numTurns: null, totalTokens: null, exitCode: null, mode: 'accept-edits', backend: backend,
        stderr: provider.endpointMismatchHint(backend, authDomain, false)
      })
      return
    }
    const prefix = commandFor(backend, io)
    const built = provider.buildArgv(prefix, args, {
      backend,
      defaultMode: 'accept-edits',
      defaultModel: (args && args.model) ? null : settings.defaultModel,
      settings,
      env: provider.endpointEnv(backend, settings.endpointOverride, authDomain, authToken)
    })
    const { argv, timeoutSec } = built
    // codebuddy/workbuddy 会话按项目目录（cwd）归档：续接未显式给 cwd 时回落到
    // 该 session 所在项目的 cwd，否则 "No conversation found with session ID"。
    let cwd = resolvePath(target.cwd)
    const blocked = cwdBlockedReason(cwd, io)
    if (blocked) {
      resolve({ ok: false, status: 'CWD_BLOCKED', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: backend, stderr: blocked })
      return
    }
    const unavailable = backendUnavailable(backend, prefix)
    if (unavailable) {
      resolve({ ok: false, status: 'CODEBUDDY_UNAVAILABLE', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: backend, stderr: unavailable })
      return
    }
    const spawnEnv = (built.env && typeof built.env === 'object') ? Object.assign({}, process.env, built.env) : undefined
    let child
    try {
      // No shell: argv passed verbatim（prompt 含空格/引号安全）。spawnEnv 仅
      // codebuddy-en（端点/凭据注入）时设置。
      child = nodeSpawn(argv[0], argv.slice(1), {
        cwd,
        ...(spawnEnv ? { env: spawnEnv } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (e) {
      resolve({ ok: false, status: 'SPAWN_ERROR', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: backend, stderr: String(e && e.message || e) })
      return
    }
    engine.begin(cwd)
    let out = '', err = ''
    let killed = false
    const timer = setTimeout(() => { killed = true; try { child.kill() } catch (e) {} }, (timeoutSec + 60) * 1000)
    // 半行安全的实时事件流（跨 chunk 的 NDJSON 行拼接）。
    const stream = createLineStream((ln) => {
      const t = ln.trim()
      if (!t.startsWith('{')) return
      try { engine.foldEvent(JSON.parse(t), cwd) } catch (e) {}
    })
    // stdout 必须声明 utf8：不声明时 'data' 派发 Buffer，createLineStream.pushChunk
    // 只接受字符串 → foldEvent 从不触发、状态灯活动明细全空。用 setEncoding 而非
    // String(d)：后者会在多字节 UTF-8 跨 chunk 边界产生乱码。
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      out += d
      if (out.length > 4000000) out = out.slice(-2000000)
      stream.pushChunk(d)
    })
    child.stderr.on('data', (d) => { err += d; if (err.length > 1000000) err = err.slice(-500000) })
    // ENOENT 等场景 Node 先派 'error' 再派 'close'；settled 保证 p.running 只减
    // 一次、Promise 只 resolve 一次（旧版双派发会双减计数）。
    let settled = false
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.flush()
      const msg = backend + ' spawn failed: ' + String(e && e.message || e) + (backend === 'workbuddy' ? ' — the WorkBuddy desktop app must be installed (or set WORKBUDDY_BIN)' : ' — install CodeBuddy Code (npm i -g @tencent-ai/codebuddy-code) or set CODEBUDDY_BIN')
      engine.end({ ok: false, status: 'CODEBUDDY_UNAVAILABLE', backend: backend, stderr: msg }, cwd)
      resolve({ ok: false, status: 'CODEBUDDY_UNAVAILABLE', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: backend, stderr: msg })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.flush()
      const outcome = { exitCode: killed ? 124 : code }
      const parsed = provider.parseJson(out)
      let res = provider.buildResult(parsed, outcome, built.mode, err, out, backend)
      if (killed && !res.ok) {
        res.status = 'HUNG_TIMEOUT'
        res.stderr = (res.stderr ? res.stderr + ' ' : '') + '[killed by timeout guard after ' + timeoutSec + 's; if this was a long-running script (build/test) raise timeoutSec]'
      }
      engine.end(res, cwd)
      resolve(res)
    })
  })
}

// ── text rendering（MCP has no fallback dialog: no human answerer；旧 L316-333
// verbatim；isLimited/failureHint 用描述符实现 —— 中文限流表红线）────────────────
function textResult(res) {
  const bk = res.backend || 'codebuddy'
  const limited = !res.ok && provider.isLimited(res)
  const head = bk + ' ' + (res.ok ? 'OK' : 'FAILED') + ' [status=' + res.status + ' mode=' + res.mode +
    (res.modelUsed ? ' model=' + res.modelUsed : '') +
    (res.retried ? ' retried=1' : '') +
    (res.sessionId ? ' session=' + res.sessionId : '') +
    (res.totalTokens != null ? ' tokens=' + res.totalTokens : '') +
    (res.durationSeconds != null ? ' ' + res.durationSeconds + 's' : '') + ']'
  let note = ''
  if (limited) note = '\n\n[Note: this looks like a rate-limit / network failure. Do NOT retry ' + bk + ' in a loop; finish the task with your own tools, or ask the user.]'
  let body = res.response || (res.stderr ? '[stderr] ' + res.stderr : '')
  // 观测性：无 result 事件时附带原始 stdout 尾部（诊断挂起/解析失败用）。
  if (!res.ok && res.rawStdout) body = (body ? body + '\n\n' : '') + '[raw stdout tail] ' + res.rawStdout
  const hint = provider.failureHint(res)
  if (hint) body = (body ? body + '\n\n' : '') + hint
  return head + (body ? '\n\n' + body : '') + note
}

// 旧 statusText L336-380 verbatim（runs/tokens 聚合、bkTag、trail 明细是
// codebuddy 面特有观测格式，不走 kit 通用 renderStatus）。
function statusText(filterCwd) {
  const snap = engine.statusSnapshot()
  let projects = snap.projects
  let g = snap
  if (filterCwd) {
    const key = String(filterCwd)
    projects = projects.filter((p) => p.cwd === key)
    const first = projects[0]
    if (first) g = first
  }
  const lines = []
  lines.push('codebuddy status: ' + g.state + (g.running > 0 ? ' (' + g.running + ' running)' : '') + (projects.length > 1 ? ' across ' + projects.length + ' projects' : '') + (g.totalTokens ? ' | total ' + g.runs + ' runs, ' + g.totalTokens + ' tokens' : ''))
  if (projects.length) {
    for (const p of projects) {
      const cur = p.current ? (' step ' + p.current.stepIndex + ' → ' + p.current.tool + (p.current.args ? ' ' + JSON.stringify(p.current.args) : '')) : (p.running > 0 ? ' (starting / thinking)' : '')
      const usage = (p.runs ? ' | total ' + p.runs + ' runs, ' + (p.totalTokens || 0) + ' tokens' : '')
      const bkTag = (p.lastBackend && p.lastBackend !== 'codebuddy') ? ' [' + p.lastBackend + ']' : ''
      lines.push('· ' + p.name + ' [' + p.state + (p.running > 0 ? ' ×' + p.running : '') + ']' + bkTag + cur + (p.lastStatus ? ' | last=' + p.lastStatus + (p.lastSessionId ? ' ' + p.lastSessionId.slice(0, 8) : '') : '') + usage)
      if (p.trail && p.trail.length) {
        lines.push('    steps:')
        for (const e of p.trail.slice(-3)) {
          const a = e.args ? ' ' + JSON.stringify(e.args) : ''
          lines.push('      [' + e.state + '] step ' + e.stepIndex + ' ' + e.tool + a)
        }
      }
    }
  } else {
    if (g.current) {
      const c = g.current
      lines.push('current: step ' + c.stepIndex + ' → ' + c.tool + (c.args ? ' ' + JSON.stringify(c.args) : ''))
    } else if (g.state === 'running') {
      lines.push('current: (starting / thinking)')
    }
    if (g.trail && g.trail.length) {
      lines.push('recent steps:')
      for (const e of g.trail.slice(-6)) {
        const a = e.args ? ' ' + JSON.stringify(e.args) : ''
        lines.push('  [' + e.state + '] step ' + e.stepIndex + ' ' + e.tool + a)
      }
    }
    if (g.lastStatus) lines.push('last: ' + g.lastStatus + (g.lastSessionId ? ' session=' + g.lastSessionId : '') + (g.lastAt ? ' @ ' + new Date(g.lastAt).toISOString() : ''))
  }
  if (g.updatedAt) lines.push('updatedAt: ' + new Date(g.updatedAt).toISOString())
  return lines.join('\n')
}

// ── 工具面（旧 MCP TOOLS L383-428 verbatim：mode 无 auto、无 background，
// run/continue/status 描述与 DSH preset 面文本不同 —— 契约 §8 逐字红线）───────
const TOOLS = [
  {
    name: 'codebuddy_run',
    description: 'Dispatch a coding/build/debug/investigation task to the local codebuddy agent CLI (Tencent CodeBuddy Code) and return its final answer. codebuddy runs fully non-interactively with permissions auto-approved (--permission-mode bypassPermissions, never prompts) and applies edits directly. Prefer it for implementation, multi-file edits, refactors and debugging; use your own tools for quick read-only lookups and final build/test verification. mode=plan runs codebuddy read-only. Optional model/effort/maxTurns select the codebuddy model and caps; timeoutSec (10-3600, default 300) is a server-side hang guard. While it runs, call codebuddy_status to watch what codebuddy is doing live. backend="codebuddy-intl" (the INTERNATIONAL face of the same npm CLI — product.ioa.json catalogue: claude-sonnet-5 / claude-opus-5 / gemini-3.1-pro / gpt-6-astra / hy3-ioa; aliases codebuddy-ioa / codebuddy-international accepted), backend="codebuddy-en" (WorkBuddy international edition — the WorkBuddyAI desktop bundled CLI; aliases workbuddy-en / workbuddy-ai accepted) and backend="workbuddy" (WorkBuddy domestic desktop bundled CLI; office-scenario product face: documents/slides/spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies) route to the other product faces.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full task/instruction for codebuddy. Be complete and self-contained.' },
        backend: { type: 'string', enum: ['codebuddy', 'codebuddy-intl', 'codebuddy-ioa', 'codebuddy-international', 'codebuddy-en', 'workbuddy-en', 'workbuddy-ai', 'workbuddy'], description: 'codebuddy (default) for coding work (domestic CodeBuddy npm CLI); codebuddy-intl = the INTERNATIONAL face of that same npm CLI (product.ioa.json catalogue: claude-sonnet-5 / claude-opus-5 / gemini-3.1-pro / gpt-6-astra / hy3-ioa; aliases codebuddy-ioa / codebuddy-international) — use it for international CodeBuddy accounts; codebuddy-en = WorkBuddy international edition (the WorkBuddyAI desktop CLI at C:\\Program Files\\WorkBuddyAI; aliases workbuddy-en / workbuddy-ai accepted; needs codebuddyEnToken in the settings file unless DSH already holds a workbuddy key — its login token is sealed by a protector key the headless CLI cannot read); workbuddy for the WorkBuddy domestic desktop CLI, also the office-scenario face (docs/slides, knowledge base, media generation, WeChat/WeCom replies). New calls without a backend follow the user-preferred default backend (settings file). Continuing a session routes back to its owning backend automatically.' },
        mode: { type: 'string', enum: ['plan', 'accept-edits'], description: 'plan = no writes; accept-edits = allow edits (default).' },
        model: { type: 'string', description: 'Optional model id. When unspecified, the user-preferred default model (plugin settings) is used if set, else the CLI default. Two layers decide: the PRODUCT FACE decides whether the id exists in its catalogue, then the ACCOUNT decides whether it is licensed. The free tier (hy3, deepseek-v4.1-flash at x0.00 credits; hy4-preview at x0.29) belongs to the npm CLI faces codebuddy/codebuddy-intl: hy4-preview, hy3, hy3-x, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3, minimax-m2.7, kimi-k3-1, kimi-k2.8-preview, kimi-k2.7, kimi-k2.6, deepseek-v4-pro. codebuddy-en (WorkBuddyAI) carries NO hy4-preview and NO deepseek-v4.1-flash; its only free model is hy3. International ids (claude-sonnet-5, gemini-3.1-pro, ...) are account-gated. Availability is per ACCOUNT: the CLI rejects an id outside the account catalogue with "400 service info not found" and one inside it but unlicensed with "400 only available for authorized users" (many catalogue flagships such as claude-opus-4.8, gpt-5.4 and gpt-6-astra are in this second group for a domestic account). Run the CLI with a deliberately invalid model id to print "Currently supported models for your account:" and get the authoritative list; the plugin caches that result and the settings panel lists exactly those ids with their credit multiplier (x0.00 = free), read live from the CLI descriptor so it stays in sync with CLI upgrades. Prefer the cheapest model that can do the job, and prefer a free (x0.00) one for routine work. Pass a model only when the task clearly benefits from a specific one.' },
        effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' },
        maxTurns: { type: 'integer', description: 'Optional max agentic turns (1-500, default unlimited).' },
        cwd: { type: 'string', description: 'Working directory for codebuddy (default: CODEBUDDY_MCP_CWD or the fallback workspace). If the server sets CODEBUDDY_MCP_ALLOWED_ROOTS, this must be inside the whitelist.' },
        addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to add to the codebuddy workspace.' },
        timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); the server force-kills at timeout+60s.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'codebuddy_continue',
    description: 'Continue an existing codebuddy conversation with a follow-up prompt, reusing codebuddy context. Pass sessionId from a prior codebuddy_run result, or latest=true for the most recent conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Follow-up instruction for the ongoing codebuddy conversation.' },
        sessionId: { type: 'string', description: 'codebuddy session id to resume (from a prior codebuddy_run result).' },
        latest: { type: 'boolean', description: 'Continue the most recent codebuddy conversation.' },
        backend: { type: 'string', enum: ['codebuddy', 'codebuddy-intl', 'codebuddy-ioa', 'codebuddy-international', 'codebuddy-en', 'workbuddy-en', 'workbuddy-ai', 'workbuddy'], description: 'Which CLI face to resume on (codebuddy-en = WorkBuddy international, aliases workbuddy-en / workbuddy-ai accepted); defaults to the backend owning the sessionId, then the user-preferred default backend (settings file).' },
        mode: { type: 'string', enum: ['plan', 'accept-edits'], description: 'plan = no writes; accept-edits = allow edits (default).' },
        model: { type: 'string', description: 'Optional model id (two layers: product face carries it, account licenses it; the credit multiplier of each id comes from the CLI descriptor — see codebuddy_run).' },
        effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
        maxTurns: { type: 'integer', description: 'Optional max agentic turns (1-500).' },
        cwd: { type: 'string', description: "Working directory for codebuddy; when resuming, defaults to the resumed session's project directory." },
        timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300).' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'codebuddy_status',
    description: 'Read a live snapshot of what the local codebuddy agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or thinking/typing), the recent step trail (tools executed, done/error), the last completed run status + session id, and per-project cumulative usage (runs + total tokens, since codebuddy exposes no quota API). Optional cwd filters to a single project. Call this to check on an in-flight codebuddy_run/codebuddy_continue without waiting for it to finish.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }
  }
]

export function tools(env) {
  return TOOLS.map((t) => Object.assign({}, t))
}

export async function call(name, args, io) {
  if (io) lastIo = io
  if (!lastIo) return 'codebuddy error: MCP io not initialized'
  const a = args || {}
  if (name === 'codebuddy_status') return statusText(a.cwd)
  if (!a.prompt || !String(a.prompt).trim()) return 'codebuddy error: prompt is required'
  const mapped = Object.assign({}, a)
  if (name === 'codebuddy_continue' && !mapped.sessionId && mapped.latest) mapped.continueLatest = true
  // MCP has no human answerer → no fallback dialog：失败返回错误文本（限流特征
  // 时附注），由调用方决定下一步。
  let res = await runCodebuddy(mapped, lastIo)
  // CLI 侧瞬时错误（error_during_execution，CLI 不给原因）：静默自动重试一次。
  // 续接类调用（--resume/--continue）不自动重试：会话状态可能已被前一次改动。
  if (provider.isTransientCliError(res) && !mapped.sessionId && !mapped.continueLatest) {
    const retry = await runCodebuddy(mapped, lastIo)
    if (retry.ok) res = retry
    else { res = retry; res.retried = true }
  }
  return textResult(res)
}

// --check 守卫（keystone gate 之外自带 argv-drift 探针，agy 面同款精神）：
// 三工具名与描述符一致 + buildArgv 关键面不许漂移。
export function check(env) {
  const ts = tools(env)
  const names = ts.map((t) => t.name)
  for (const req of ['codebuddy_run', 'codebuddy_continue', 'codebuddy_status']) {
    if (!names.includes(req)) throw new Error('codebuddy mcp: missing tool ' + req)
  }
  for (const t of ts) {
    if (!t.name || !t.description || !t.inputSchema || t.inputSchema.type !== 'object') throw new Error('codebuddy mcp: bad tool def ' + JSON.stringify(t && t.name))
  }
  for (const k of ['run', 'continue', 'status']) {
    if (!names.includes(provider.tools[k].name)) throw new Error('codebuddy mcp: tools surface missing descriptor name ' + provider.tools[k].name)
  }
  const b = provider.buildArgv(['codebuddy'], { prompt: 'x' }, { planActive: false, defaultMode: 'accept-edits' })
  for (const f of ['--output-format', 'stream-json', '--permission-mode', 'bypassPermissions']) {
    if (!b.argv.includes(f)) throw new Error('codebuddy mcp: argv contract drift: ' + f)
  }
  const bp = provider.buildArgv(['codebuddy'], { prompt: 'x', mode: 'plan' }, {})
  if (!bp.argv.includes('--allowedTools') || !bp.argv.includes('plan')) throw new Error('codebuddy mcp: argv contract drift: plan branch (--permission-mode plan / --allowedTools Bash)')
  return true
}
