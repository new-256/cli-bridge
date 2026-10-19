// dynamic/claude.host.template.mjs — claude 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=claude）把 core/bridge-kit.mjs、providers/claude.mjs、
// providers/claude-*.mjs 片文件（含 claude-policy.mjs）与 core/scheduling.mjs 分别内联进下方
// 四个占位标记行（各占一行、行内仅此标记），生成 dynamic/claude.host.js。
// 注意：标记字面量绝不能出现在本注释里 —— 构建做全局替换，注释中出现同样会被替换成正文
// 代码而炸掉语法。
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生定时器
//    —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层 return
//    合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('claude', snap) 推给
//    家级灯（旧 claudeCollector 别名保留兼容）；动态形态不宣告 mode。
// core/bridge-kit.mjs — CLI Bridge 单一事实来源：通用执行/状态骨架。
//
// 深度重构核心（合并 agy-first-bridge / codebuddy-first-bridge / mimo-first-bridge）：
// 三条 bridge 的 host 半此前各自复制了一份几乎相同的「状态引擎 + 行流 + 执行编排
// + 限流回退弹窗 + MCP 快照上报 + 展示层」。本文件把这些**与 provider 无关**的骨架
// 收敛成一份参数化实现，每个 provider 只提供一个 descriptor（见 providers/*.mjs 与
// PROVIDER-CONTRACT.md），由 createRunner/createStatusEngine 回调它完成差异化步骤。
//
// 骨架覆盖：
//   - 纯函数：projectName / clampInt / shortLabel / summarizeArgs / endpointHost
//   - 限流/网络判定：LIMIT_RE + isLimited（provider 可收窄）
//   - 半行安全行流：createLineStream
//   - 按项目（cwd）聚合、按 provider 分桶的状态引擎：createStatusEngine
//   - 执行编排（前台/后台/超时守卫/瞬时错误重试/限流三选一弹窗/回退）：createRunner
//   - 工具结果与状态的人类可读渲染：renderResult / renderStatus
//   - MCP 子进程快照上报：buildMcpBridgePayload / normalizeMcpBridge（provider 分文件）
//   - 回退弹窗三选一文案（provider 名注入）
//
// 约束（沙箱与真实 Node 共用，勿违反）：
//   - 本模块**不 import 任何模块**、不用 process/Buffer/原生定时器/AbortController；
//     宿主能力（subprocess.spawn / ctx.interval / ctx.timeout / jobs / userQuestions）
//     全部经 createRunner 的 opts 注入，取消用 exec.signal + handle.terminate()。
//   - 不序列化任何 DSH 活对象；跨 RPC 只传无 Host 引用的纯 JSON 叶子字段。

// ── 常量 ──────────────────────────────────────────────────────────────────────

const MAX_TRAIL = 12
const MAX_ARG_LEN = 120
const MAX_PROJECTS = 24
const MAX_SESSIONS = 256

// 限流/网络类错误的宽松正则（英文 + 中文）。provider descriptor 可用自己的收窄版覆盖。
const LIMIT_RE =
  /rate.?limit|ratelimit|\b429\b|too many|quota|insufficient|credit|balance|exhausted|exceed|\bnetwork\b|offline|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|\btimeouts?\b|timed out|unavailable|\b50[023]\b|\b40[13]\b|unauthorized|invalid api|api key|proxy|socket|tls|ssl|\bdns\b|网络|超时|限流|流量|受限|配额|金额|余额|额度|认证|连接|断开/i

// 家级插件与 MCP 子进程之间的快照文件：{dsh-home}/cli-bridge-mcp-<provider>.json
const MCP_BRIDGE_PREFIX = 'cli-bridge-mcp-'
const MCP_BRIDGE_STALE_MS = 90000
function mcpBridgeFileName(providerId) { return MCP_BRIDGE_PREFIX + providerId + '.json' }

// ── 纯函数 ────────────────────────────────────────────────────────────────────

function projectName(cwd) {
  const s = String(cwd || '')
  const parts = s.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : s
}

function clampInt(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

function shortLabel(prompt) {
  const s = String(prompt || '').replace(/\s+/g, ' ').trim()
  return s.length > 80 ? s.slice(0, 77) + '...' : s
}

// 工具入参摘要（状态灯/活动面板）。返回可无损 JSON 化的数据；undefined 值跳过
// （DSH tool 渲染层不接受 undefined）。
function summarizeArgs(parameters) {
  if (!parameters || typeof parameters !== 'object') return null
  const out = {}
  for (const k of Object.keys(parameters)) {
    let v = parameters[k]
    if (v === undefined) continue
    if (typeof v === 'string' && v.length > MAX_ARG_LEN) v = v.slice(0, MAX_ARG_LEN) + '…'
    out[k] = v
  }
  return out
}

function endpointHost(url) {
  const m = String(url || '').match(/^https?:\/\/([^/]+)/i)
  return m ? m[1] : ''
}

// 限流/网络类失败（要问用户，重试可能烧额度）。
function isLimited(res) {
  if (!res || res.ok) return false
  // AUTH_REQUIRED 是配置问题（缺凭据），弹回退/重试无意义 —— 直接给可操作指引。
  if (res.status === 'AUTH_REQUIRED') return false
  if (res.status === 'SPAWN_ERROR' || res.status === 'CLI_UNAVAILABLE' || res.status === 'HUNG_TIMEOUT') return true
  const hay = String(res.stderr || '') + ' ' + String(res.status || '')
  // 端点域与登录域不匹配的 401：需要用户换登录域，不是限流。
  if (/401 authentication failed|differs from the current product endpoint/i.test(hay)) return false
  return LIMIT_RE.test(hay)
}

// ── 半行安全的行流（跨 chunk 的 NDJSON 行拼接）───────────────────────────────
function createLineStream(consumeLine) {
  let pending = ''
  function pushChunk(text) {
    if (typeof text !== 'string' || !text) return
    const lines = (pending + text).split(/\r?\n/)
    pending = lines.pop() || ''
    for (const ln of lines) consumeLine(ln)
  }
  function flush() {
    const rest = pending
    pending = ''
    if (rest) consumeLine(rest)
  }
  return { pushChunk, flush }
}

// ── 状态引擎（按 provider + 项目目录聚合的运行状态表）─────────────────────────
// opts: { provider: <descriptor>, publish(snapshot) }
// 快照结构（顶层为全局聚合，向后兼容单 provider 消费者）：
//   { provider, state, running, lastStatus, lastAt, lastSessionId, lastBackend,
//     fallbackActive, current, trail, runs, totalTokens, updatedAt,
//     projects:[{ cwd,name,provider,state,running,current,trail,lastStatus,lastAt,
//                 lastSessionId,lastBackend,fallbackActive,runs,totalTokens,updatedAt }] }
function createStatusEngine(opts) {
  const o = opts || {}
  const provider = o.provider
  const providerId = provider && provider.id ? provider.id : 'cli'
  const publish = typeof o.publish === 'function' ? o.publish : null
  const projects = Object.create(null)
  // sessionId -> { cwd, backend, provider }。会话按 provider 归属（登录域互斥），
  // 续接时一次解析出 cwd 与 backend。容量上限 MAX_SESSIONS，FIFO 淘汰。
  const sessions = Object.create(null)

  function ensureProject(cwd) {
    const key = String(cwd || '')
    let p = projects[key]
    if (!p) {
      if (Object.keys(projects).length >= MAX_PROJECTS) {
        const idle = Object.keys(projects).filter((k) => projects[k].running === 0)
        const pool = idle.length ? idle : Object.keys(projects)
        const victim = pool.sort((a, b) => projects[a].updatedAt - projects[b].updatedAt)[0]
        delete projects[victim]
      }
      p = { cwd: key, name: projectName(key), provider: providerId, state: 'idle', running: 0, lastStatus: null, lastAt: 0, lastSessionId: null, lastBackend: null, lastOk: false, lastFailed: false, fallbackActive: false, current: null, trail: [], runs: 0, totalTokens: 0, updatedAt: 0 }
      projects[key] = p
    }
    return p
  }

  function globalStatus() {
    const list = Object.keys(projects).map((k) => projects[k])
    let running = 0, lastStatus = null, lastAt = 0, lastSessionId = null, lastBackend = null, fallbackActive = false, current = null, trail = [], updatedAt = 0, runs = 0, totalTokens = 0
    for (const p of list) {
      running += p.running
      if (p.updatedAt > updatedAt) updatedAt = p.updatedAt
      if (p.running > 0 && !current && p.current) current = p.current
      if (p.lastAt > lastAt) { lastAt = p.lastAt; lastStatus = p.lastStatus; lastSessionId = p.lastSessionId; lastBackend = p.lastBackend }
      if (p.fallbackActive) fallbackActive = true
      runs += p.runs || 0
      totalTokens += p.totalTokens || 0
      for (const e of p.trail) trail.push(e)
    }
    trail.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    trail = trail.slice(-MAX_TRAIL)
    const state = running > 0 ? 'running' : (fallbackActive ? 'fallback' : (lastStatus ? (lastStatus === 'SUCCESS' ? 'ok' : 'failed') : 'idle'))
    return { state, running, lastStatus, lastAt, lastSessionId, lastBackend, fallbackActive, current, trail, runs, totalTokens, updatedAt }
  }

  function statusSnapshot() {
    const g = globalStatus()
    const list = Object.keys(projects).map((k) => projects[k]).sort((a, b) => b.updatedAt - a.updatedAt)
    return Object.assign({ provider: providerId }, g, {
      projects: list.map((p) => ({ cwd: p.cwd, name: p.name, provider: providerId, state: p.state, running: p.running, current: p.current, trail: p.trail.slice(-MAX_TRAIL), lastStatus: p.lastStatus, lastAt: p.lastAt, lastSessionId: p.lastSessionId, lastBackend: p.lastBackend, fallbackActive: p.fallbackActive, runs: p.runs || 0, totalTokens: p.totalTokens || 0, updatedAt: p.updatedAt }))
    })
  }

  function emit() { if (publish) { try { publish(statusSnapshot()) } catch (e) {} } }

  function begin(cwd) {
    const p = ensureProject(cwd)
    p.running += 1
    p.state = 'running'
    p.updatedAt = Date.now()
    emit()
  }

  function end(res, cwd) {
    const p = ensureProject(cwd)
    p.running = Math.max(0, p.running - 1)
    p.lastStatus = res ? res.status : null
    p.lastAt = Date.now()
    if (res && res.sessionId) {
      p.lastSessionId = res.sessionId
      sessions[res.sessionId] = { cwd: p.cwd, backend: res.backend || (provider && provider.defaultBackend), provider: providerId }
      const keys = Object.keys(sessions)
      if (keys.length > MAX_SESSIONS) delete sessions[keys[0]]
    }
    if (res && res.backend) p.lastBackend = res.backend
    p.runs = (p.runs || 0) + 1
    if (res && typeof res.totalTokens === 'number' && res.totalTokens > 0) p.totalTokens = (p.totalTokens || 0) + res.totalTokens
    if (res && res.fallback) { p.fallbackActive = true; p.state = 'fallback' }
    else if (p.running > 0) { p.state = 'running' }
    else { p.state = res && res.ok ? 'ok' : 'failed'; p.lastOk = !!(res && res.ok); p.lastFailed = !(res && res.ok) }
    p.current = null
    p.updatedAt = Date.now()
    emit()
  }

  // 流事件折叠为实时状态。provider 若有 stream-json，提供 foldStreamEvent(ev, project)；
  // 否则回退到 generic 形态（不产生实时步骤）。
  function foldEvent(ev, cwd) {
    const p = ensureProject(cwd)
    p.updatedAt = Date.now()
    if (provider && typeof provider.foldStreamEvent === 'function') {
      try { provider.foldStreamEvent(ev, p, summarizeArgs, MAX_ARG_LEN, MAX_TRAIL) } catch (e) {}
    }
    emit()
  }

  // 会话路由（cwd + backend 一次解析）。续接（--resume/--continue）时未给 cwd
  // 则回落到该 session 所在项目的 cwd（否则换目录报找不到会话）。
  function resolveTarget(args, fallbackCwd) {
    const a = args || {}
    let backend = null, cwd = null
    if (a.sessionId) { const hit = sessions[a.sessionId]; if (hit && hit.provider === providerId) { backend = hit.backend; cwd = hit.cwd } }
    if (a.cwd) {
      cwd = String(a.cwd)
    } else if (!cwd && (a.sessionId || a.continueLatest)) {
      const list = Object.keys(projects).map((k) => projects[k]).sort((a, b) => b.updatedAt - a.updatedAt)
      if (a.sessionId) {
        const projHit = list.find((p) => p.lastSessionId === a.sessionId)
        if (projHit) { cwd = projHit.cwd; if (!backend) backend = projHit.lastBackend }
      } else if (list.length && list[0].lastSessionId) { cwd = list[0].cwd; if (!backend) backend = list[0].lastBackend }
    }
    return { cwd: cwd || fallbackCwd, backend }
  }

  function resolveCwd(args, fallbackCwd) { return resolveTarget(args, fallbackCwd).cwd }

  return { providerId, projects, sessions, ensureProject, globalStatus, statusSnapshot, begin, end, foldEvent, resolveCwd, resolveTarget }
}

// ── 回退弹窗三选一（provider 名注入）──────────────────────────────────────────
function fallbackLabels(provider) {
  const bk = (provider && provider.id) || 'CLI'
  return {
    fallback: '使用 DSH 本地 API 配置（回退）',
    retry: '重试 ' + bk + ' 一次',
    cancel: '不回退（返回错误）'
  }
}

// 失败结果的可行动指引；provider.failureHint 优先，未给则通用兜底。
function failureHint(res, provider) {
  if (!res || res.ok) return ''
  if (provider && typeof provider.failureHint === 'function') {
    try { const h = provider.failureHint(res); if (h) return h } catch (e) {}
  }
  if (res.status === 'AUTH_REQUIRED') return '[诊断] ' + String(res.stderr || '')
  if (res.status === 'PARSE_ERROR') return '[诊断] 未能从输出解析出 result 事件（进程可能被中断或输出被截断）。可重试；持续出现请检查 CLI 版本。'
  if (/401 authentication failed|differs from the current product endpoint/i.test(String(res.stderr || ''))) {
    return '[诊断] 认证失败（401）：请求端点与当前 CLI 登录域不匹配（国际/国内登录互斥）。请让用户在对应产品域完成 CLI 登录后重试；这不是限流。'
  }
  return ''
}

function fallbackResult(res, mode, provider) {
  const bk = (provider && provider.id) || 'CLI'
  return Object.assign({}, res, { ok: false, fallback: true, status: 'FALLBACK_TO_DSH', response: '', stderr: (res && res.stderr ? res.stderr : '') + ' [user chose DSH fallback for ' + bk + ']' })
}

// ── 展示层 ────────────────────────────────────────────────────────────────────
function renderResult(value, provider) {
  const v = value || {}
  // backendLabel（codebuddy 旧语义 v1.1.0 verbatim：'workbuddy OK'/'codebuddy-intl OK'）：
  // 结果带具体 backend 时用 backend 标头；agy/mimo 旧包标头是硬编码 provider 名，不开此旗。
  const bk = (provider && provider.backendLabel && v.backend) || (provider && provider.id) || v.backend || 'CLI'
  if (v.background) return [{ type: 'text', text: bk + ' dispatched in background (mode=' + v.mode + '). jobId=' + v.jobId + '. Collect with job_output.' }]
  if (v.fallback) return [{ type: 'text', text: bk + ' 回退：用户选择使用 DSH 本地 API 配置（原因 ' + v.reason + '）。请改用原生工具/本地模型完成本任务，不要再调 ' + bk + '。' }]
  const head = bk + ' ' + (v.ok ? 'OK' : 'FAILED') + ' [status=' + v.status + ' mode=' + v.mode + (v.modelUsed ? ' model=' + v.modelUsed : '') + (v.retried ? ' retried=1' : '') + (v.sessionId ? ' session=' + v.sessionId : '') + (v.totalTokens != null ? ' tokens=' + v.totalTokens : '') + (v.durationSeconds != null ? ' ' + v.durationSeconds + 's' : '') + ']'
  const hint = failureHint(v, provider)
  let body = v.response ? v.response : (v.stderr ? '[stderr] ' + v.stderr : (v.rawStdout ? '[raw] ' + v.rawStdout : ''))
  if (hint) body = (body ? body + '\n\n' : '') + hint
  return [{ type: 'text', text: head + (body ? '\n\n' + body : '') }]
}

function renderStatus(value, provider) {
  const v = value || {}
  const bk = (provider && provider.id) || 'CLI'
  const lines = []
  lines.push(bk + ' status: ' + v.state + (v.running > 0 ? ' (' + v.running + ' running)' : '') + (v.projects && v.projects.length > 1 ? ' across ' + v.projects.length + ' projects' : '') + (v.totalTokens ? ' | total ' + v.runs + ' runs, ' + v.totalTokens + ' tokens' : ''))
  const projList = (v.projects && v.projects.length) ? v.projects : null
  if (projList) {
    for (const p of projList) {
      const cur = p.current ? (' step ' + p.current.stepIndex + ' → ' + p.current.tool + (p.current.args ? ' ' + JSON.stringify(p.current.args) : '')) : (p.running > 0 ? ' (starting / thinking)' : '')
      const usage = (p.runs ? ' | total ' + p.runs + ' runs, ' + (p.totalTokens || 0) + ' tokens' : '')
      const bkTag = (p.lastBackend && p.lastBackend !== bk) ? ' [' + p.lastBackend + ']' : ''
      lines.push('· ' + p.name + ' [' + p.state + (p.running > 0 ? ' ×' + p.running : '') + ']' + bkTag + cur + (p.lastStatus ? ' | last=' + p.lastStatus + (p.lastSessionId ? ' ' + p.lastSessionId.slice(0, 8) : '') : '') + usage)
      if (p.trail && p.trail.length) {
        lines.push('    steps:')
        for (const e of p.trail.slice(-3)) { const a = e.args ? ' ' + JSON.stringify(e.args) : ''; lines.push('      [' + e.state + '] step ' + e.stepIndex + ' ' + e.tool + a) }
      }
    }
  } else {
    if (v.current) { const c = v.current; lines.push('current: step ' + c.stepIndex + ' → ' + c.tool + (c.args ? ' ' + JSON.stringify(c.args) : '')) }
    else if (v.state === 'running') lines.push('current: (starting / thinking)')
    if (v.trail && v.trail.length) {
      lines.push('recent steps:')
      for (const e of v.trail.slice(-6)) { const a = e.args ? ' ' + JSON.stringify(e.args) : ''; lines.push('  [' + e.state + '] step ' + e.stepIndex + ' ' + e.tool + a) }
    }
    if (v.lastStatus) lines.push('last: ' + v.lastStatus + (v.lastSessionId ? ' session=' + v.lastSessionId : '') + (v.lastAt ? ' @ ' + new Date(v.lastAt).toISOString() : ''))
  }
  if (v.updatedAt) lines.push('updatedAt: ' + new Date(v.updatedAt).toISOString())
  return [{ type: 'text', text: lines.join('\n') }]
}

// ── MCP 子进程快照上报 ────────────────────────────────────────────────────────
// MCP server 是独立 stdio 子进程：没有 ctx.emit、拿不到 collector 服务，所以把快照
// 原子写进 {dsh-home}/cli-bridge-mcp-<provider>.json，家级灯在响应请求时读取合并。
function buildMcpBridgePayload(snap, pid, nowMs) {
  const s = snap && typeof snap === 'object' ? snap : {}
  const src = Array.isArray(s.projects) ? s.projects : []
  const projects = []
  for (const p of src) {
    if (!p || !p.cwd) continue
    projects.push({
      cwd: String(p.cwd), name: p.name ? String(p.name) : '', provider: p.provider || s.provider || '', state: p.state ? String(p.state) : 'idle',
      running: Number(p.running) || 0,
      current: p.current ? { stepIndex: Number(p.current.stepIndex) || 0, tool: String(p.current.tool || ''), args: p.current.args || null } : null,
      trail: Array.isArray(p.trail) ? p.trail.slice(-MAX_TRAIL).map((e) => ({ stepIndex: Number(e && e.stepIndex) || 0, tool: String((e && e.tool) || ''), state: String((e && e.state) || ''), args: (e && e.args) || null })) : [],
      lastStatus: p.lastStatus ? String(p.lastStatus) : null, lastAt: Number(p.lastAt) || 0, lastSessionId: p.lastSessionId ? String(p.lastSessionId) : null,
      lastBackend: p.lastBackend ? String(p.lastBackend) : null, fallbackActive: !!p.fallbackActive, runs: Number(p.runs) || 0, totalTokens: Number(p.totalTokens) || 0, updatedAt: Number(p.updatedAt) || 0
    })
  }
  return { source: 'mcp', provider: s.provider || '', pid: Number(pid) || 0, updatedAt: Number(nowMs) || 0, projects }
}

function normalizeMcpBridge(payload, nowMs, staleMs) {
  if (!payload || typeof payload !== 'object') return null
  const projects = Array.isArray(payload.projects) ? payload.projects : []
  const updatedAt = Number(payload.updatedAt) || 0
  const stale = (Number(nowMs) || 0) - updatedAt > (Number(staleMs) || MCP_BRIDGE_STALE_MS)
  const out = []
  for (const p of projects) {
    if (!p || !p.cwd) continue
    if (stale && (Number(p.running) || 0) > 0) out.push(Object.assign({}, p, { running: 0, current: null, state: p.state === 'running' ? 'idle' : p.state }))
    else out.push(p)
  }
  return { source: 'mcp', provider: payload.provider || '', pid: Number(payload.pid) || 0, updatedAt, stale, projects: out }
}

// ── 执行编排（三形态共用；provider 差异全走 descriptor）──────────────────────
// o: {
//   ctx,                 // Cordis ctx（interval/timeout/get）
//   subprocess,          // DSH subprocess 服务
//   provider,            // descriptor（见 PROVIDER-CONTRACT.md）
//   engine,              // createStatusEngine({provider}) 实例
//   resolveExe,          // async (backend, signal) => 'exe' | [nodeExe, binPath] | throw
//   getCwdFallback,      // () => 默认 cwd
//   getPreferredBackend, // () => 用户偏好后端（可缺省）
//   getSettings,         // () => 当前设置对象（可缺省；provider 用它读 defaultModel 等）
//   planActiveFor,       // (exec) => bool（plan 模式判定，可缺省）
//   defaultMode          // 'auto'
// }
function createRunner(o) {
  const ctx = o.ctx
  const subprocess = o.subprocess
  const provider = o.provider
  const engine = o.engine
  const stdio = { stdin: 'ignore', stdout: { maxBytes: 4000000, spill: { maxBytes: 40000000 } }, stderr: { maxBytes: 1000000, spill: { maxBytes: 8000000 } } }

  function readStreams(handle) {
    const stdoutText = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
    const stderrText = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    return { stdoutText, stderrText }
  }

  let built_env = null
  function spawnSpec(argv, cwd, callerSignal) {
    const spec = { argv, cwd, stdio, graceMs: 5000 }
    if (callerSignal) spec.signal = callerSignal
    if (built_env && typeof built_env === 'object') spec.env = built_env
    return spec
  }

  function startLiveParser(handle, cwd) {
    let cursor = 0
    const stream = createLineStream((ln) => {
      const t = ln.trim()
      if (!t.startsWith('{')) return
      try { engine.foldEvent(JSON.parse(t), cwd) } catch (e) {}
    })
    const tick = function () {
      try {
        const full = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
        if (full.length <= cursor) return
        const fresh = full.slice(cursor)
        cursor = full.length
        stream.pushChunk(fresh)
      } catch (e) {}
    }
    const disposeInterval = ctx.interval(tick, 250)
    return function disposeLive() { try { stream.flush() } catch (e) {} disposeInterval() }
  }

  async function runSync(argv, cwd, timeoutSec, callerSignal, extraEnv) {
    const spec = spawnSpec(argv, cwd, callerSignal)
    if (extraEnv && typeof extraEnv === 'object') spec.env = Object.assign({}, spec.env, extraEnv)
    const handle = subprocess.spawn(spec)
    let lastEventSummary = '(no events yet)'
    let timedOut = false
    const disposeTimer = ctx.timeout(function () {
      timedOut = true
      try {
        const p = engine.ensureProject(cwd)
        lastEventSummary = (p.current ? ('last step ' + p.current.stepIndex + ' -> ' + p.current.tool) : '') +
          ' | trail=' + (p.trail.length ? p.trail.slice(-2).map((e) => '[' + e.state + ']' + e.tool).join(',') : 'empty') +
          ' | elapsed=' + Math.round((Date.now() - (p.updatedAt || Date.now())) / 1000) + 's since last activity'
      } catch (e) {}
      try { handle.terminate() } catch (e) {}
    }, (timeoutSec + 60) * 1000)
    const disposeLive = startLiveParser(handle, cwd)
    try {
      const outcome = await handle.done
      const s = readStreams(handle)
      return { outcome, stdoutText: s.stdoutText, stderrText: s.stderrText, timedOut, lastEventSummary }
    } finally { disposeLive(); disposeTimer() }
  }

  async function askFallback(exec, res, canRetry) {
    const uq = ctx.get('userQuestions')
    if (!uq || !exec || !exec.agent) return 'error'
    const labels = fallbackLabels(provider)
    const bk = provider.id
    const detail = String(res.stderr || res.response || res.status || '').slice(-600)
    const opts = [{ label: labels.fallback, description: '本次改由 DSH 本地模型/原生工具完成，不再走 ' + bk }]
    if (canRetry) opts.push({ label: labels.retry, description: '再调用一次 ' + bk + '（网络抖动时可用）' })
    opts.push({ label: labels.cancel, description: '不回退，直接返回 ' + bk + ' 错误' })
    try {
      const ans = await uq.ask({ agent: exec.agent, signal: exec.signal, questions: [{ id: bk + '-fallback', header: bk + ' 受限', question: bk + ' 调用失败（疑似流量受限/网络不通，状态=' + String(res.status) + '）。是否改用 DSH 本地 API 配置继续？', detail, options: opts }] })
      const sel = (ans && ans.answers && ans.answers[0] && ans.answers[0].selected) || []
      if (sel.indexOf(labels.fallback) >= 0) return 'fallback'
      if (sel.indexOf(labels.retry) >= 0) return 'retry'
      return 'error'
    } catch (e) { return 'error' }
  }

  async function coreExecute(rawArgs, exec) {
    const args = rawArgs || {}
    built_env = null
    const mk = (over) => Object.assign({ ok: false, status: 'BAD_ARGS', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: provider.defaultMode || 'auto', backend: null, stderr: '' }, over)
    if (!args.prompt || !String(args.prompt).trim()) return mk({ stderr: 'prompt is required' })

    const target = engine.resolveTarget(args, o.getCwdFallback())
    const backend = provider.resolveBackend ? provider.resolveBackend(args, target, o.getPreferredBackend ? o.getPreferredBackend() : null) : (o.getPreferredBackend ? o.getPreferredBackend() : provider.defaultBackend)
    const cwd = target.cwd

    // provider 前置检查（凭据/桌面健康等）：返回 { abort: res } 则直接结束。
    if (provider.preflight) {
      const pre = provider.preflight({ args, exec, backend, cwd, engine, ctx, o })
      if (pre && pre.abort) { engine.begin(cwd); engine.end(pre.abort, cwd); return pre.abort }
    }

    let exePrefix = provider.fallbackExePrefix ? provider.fallbackExePrefix(backend) : [provider.exeName || provider.id]
    let exeOk = true, resolveErr = ''
    try { const resExe = await o.resolveExe(backend, exec ? exec.signal : undefined); exePrefix = Array.isArray(resExe) ? resExe : [resExe] }
    catch (e) { exeOk = false; resolveErr = String(e && e.message || e) }

    const built = provider.buildArgv(exePrefix, args, {
      planActive: o.planActiveFor ? o.planActiveFor(exec) : false,
      defaultMode: provider.defaultMode || 'auto',
      defaultModel: (!args.model && o.getSettings) ? (o.getSettings() || {}).defaultModel || null : null,
      backend, settings: o.getSettings ? o.getSettings() : null, engine
    })
    built_env = (built.env && typeof built.env === 'object') ? built.env : null
    const unavailableStatus = provider.unavailableStatus || 'CLI_UNAVAILABLE'

    if (!exeOk) {
      engine.begin(cwd)
      let res = mk({ status: unavailableStatus, mode: built.mode, backend, stderr: (backend || provider.id) + ' executable not found: ' + resolveErr })
      if (await askFallback(exec, res, true) === 'fallback') res = fallbackResult(res, built.mode, provider)
      engine.end(res, cwd); return res
    }

    // 非 spawn 路径（如 mimo 桌面走本地 HTTP）：provider 若给 execute 且（未给 delegates
    // 或 delegates(backend)=true）则完全交给它；否则落回通用 pipeline（jobs/重试/弹窗）。
    if (provider.execute && (!provider.delegates || provider.delegates(backend, args))) {
      engine.begin(cwd)
      try {
        const res = await provider.execute({ args, exec, backend, cwd, built, engine, ctx, o, runSync })
        engine.end(res, cwd); return res
      } catch (e) {
        const res = mk({ status: 'SPAWN_ERROR', mode: built.mode, backend, stderr: String(e && e.message || e) })
        engine.end(res, cwd); return res
      }
    }

    const jobs = ctx.get('jobs')
    if (args.background && jobs && exec && exec.agent) {
      try {
        engine.begin(cwd)
        const jobId = jobs.start({
          kind: 'bash', label: provider.id + ': ' + shortLabel(args.prompt), owner: exec.agent,
          run() {
            const handle = subprocess.spawn(spawnSpec(built.argv, cwd))
            const disposeLive = startLiveParser(handle, cwd)
            let bgKilled = false
            const disposeGuard = ctx.timeout(function () { bgKilled = true; try { handle.terminate() } catch (e) {} }, (built.timeoutSec + 60) * 1000)
            const done = handle.done.then(function (outcome) {
              disposeLive(); disposeGuard()
              const s = readStreams(handle)
              const res = provider.buildResult(provider.parseJson(s.stdoutText), outcome, built.mode, s.stderrText, s.stdoutText, backend)
              if (bgKilled && !res.ok) { res.status = 'HUNG_TIMEOUT'; res.stderr = (res.stderr ? res.stderr + ' ' : '') + '[killed by timeout guard after ' + built.timeoutSec + 's; raise timeoutSec for long builds]' }
              engine.end(res, cwd)
              return { status: res.ok ? 'completed' : 'failed', detail: provider.id + ' ' + res.status, output: JSON.stringify(res) }
            }).catch(function (err) { disposeLive(); disposeGuard(); engine.end(mk({ status: 'JOB_ERROR', backend }), cwd); return { status: 'failed', detail: String(err && err.message || err) } })
            return { cancel: function () { try { handle.terminate() } catch (e) {} }, done }
          }
        })
        return { ok: true, background: true, jobId: String(jobId), mode: built.mode, backend, note: provider.id + ' running in background; collect with job_output ' + String(jobId) + '. Background failures do NOT open the fallback dialog; on failure re-run in foreground to be prompted.' }
      } catch (e) {
        const res = mk({ status: 'JOB_START_ERROR', mode: built.mode, backend, stderr: 'failed to start background job: ' + String(e && e.message || e) })
        engine.end(res, cwd); return res
      }
    }

    engine.begin(cwd)
    try {
      let attempt = 0, cliRetried = false, res
      while (true) {
        attempt += 1
        const r = await runSync(built.argv, cwd, built.timeoutSec, exec ? exec.signal : undefined, built.env)
        if (r.timedOut) { res = mk({ status: 'HUNG_TIMEOUT', mode: built.mode, backend, exitCode: r.outcome ? r.outcome.exitCode : null, stderr: provider.id + ' did not finish within ' + built.timeoutSec + 's (DSH hard timeout). Last activity: ' + r.lastEventSummary + '. NOTE: raise timeoutSec for long builds; this was a hang guard.' }); break }
        res = provider.buildResult(provider.parseJson(r.stdoutText), r.outcome, built.mode, r.stderrText, r.stdoutText, backend)
        if (res.ok) break
        if (provider.isTransientCliError && provider.isTransientCliError(res)) {
          if (!cliRetried) { cliRetried = true; attempt -= 1; continue }
          res.retried = true; break
        }
        if (!(provider.isLimited ? provider.isLimited(res) : isLimited(res))) break
        const decision = await askFallback(exec, res, attempt < 2)
        if (decision === 'fallback') { res = fallbackResult(res, built.mode, provider); break }
        if (decision === 'retry' && attempt < 2) continue
        break
      }
      engine.end(res, cwd); return res
    } catch (e) {
      const res = mk({ status: 'SPAWN_ERROR', mode: built.mode, backend, stderr: String(e && e.message || e) })
      const out = (await askFallback(exec, res, true) === 'fallback') ? fallbackResult(res, built.mode, provider) : res
      engine.end(out, cwd); return out
    }
  }

  return { coreExecute, runSync, askFallback }
}

// providers/claude.mjs — claude provider descriptor（Claude Code CLI；本仓第五家 CLI）。
//
// 基线 = 本机实测 Claude Code 2.0.76（`claude` = 原生 claude.exe），端点被用户指向第三方
// Anthropic 兼容服务（~/.claude/settings.json 的 env: ANTHROPIC_BASE_URL/AUTH_TOKEN +
// ANTHROPIC_DEFAULT_*_MODEL 别名映射）。写代码时最容易踩的几条事实：
//   • 非交互 = `claude -p "<prompt>"`，prompt 是**单参数**（不是位置参数流，也不是 stdin）。
//   • `--output-format json` → stdout 单行 result 事件；`stream-json` 必须配 `--verbose`，
//     实测 4 行：system(init) / assistant(thinking) / assistant(text) / result。
//   • ⚠️ 成功判定陷阱：result 事件 `is_error:true` 时退出码**可能是 0 也可能 1**
//     （实测无效模型 = exit 1，但 stdout 仍是合法 JSON 且 `subtype` 竟然还是 "success"）。
//     故 buildResult 只认 `is_error` + `subtype`，绝不只看 exit code。
//   • 续聊 = `--resume <session_id>`；`-c/--continue` 续最近一次。session_id 来自
//     result 事件（json/stream-json 都有）。
//   • 权限：`--permission-mode plan|acceptEdits|...` 或 `--dangerously-skip-permissions`；
//     -p 模式没有 TTY，任何需要交互批准的路径都必须走 bypass，否则会挂到超时。
//
// 红线（PROVIDER-CONTRACT.md §8 + §1）：
//  - 本文件会被 build 内联进 dynamic 沙箱（new Function）：绝不出现 import.meta 字面量；
//    process 只经 deps 注入或 typeof 守卫读取；宿主能力全部走 deps/attach(hostOpts)。
//  - 只允许 import '../core/bridge-kit.mjs' 与同目录片文件（claude-exe / claude-models）。
//  - 模型清单只认服务端权威探测；拿不到 = ok:false + 可操作错误（绝不静默空数组/配置冒充）。
// import { createStatusEngine, createRunner, clampInt, isLimited } from '../core/bridge-kit.mjs'
// import { claudeExeCandidates, claudePathHint, resolveExePrefix, splitExeSpec, CLAUDE_BIN_ENV_VARS } from './claude-exe.mjs'
// import { PROBE_MODEL, parseSupportedModels, probeSupportedModels, readCachedModels, readConfiguredModels, listAccountModels, resetModelsCache, claudeConfigDir } from './claude-models.mjs'
// import { ENDPOINT_MODES, DEFAULT_PROXY_URL, resolveEndpoint, overlaySettingsJson, readConfiguredBaseUrl } from './claude-endpoint.mjs'
// 单行 re-export（build 内联时整行剥离；多行形态风险见 build.mjs 的 stripModuleSyntax 注释）。

function nowIso() { return new Date().toISOString() }

// 权限模式的用户可见取值（auto 由 DSH plan 状态决定；其余直通 CLI）。
const MODE_ENUM = ['auto', 'plan', 'accept-edits', 'bypass']

// 手动拉取（契约 §3.2）的探测时限与失败指引。
// 失败文案必须「可操作」：面板只会把 error 原样显示给用户，没写下一步等于没帮上忙。
const REFRESH_TIMEOUT_MS = 30000
const REFRESH_HINT = '排查顺序：① 确认设置面板的「claude 可执行文件路径」或 CLAUDE_BIN 指向真实 claude（原生 .exe 优先）；② 确认 ~/.claude/settings.json 的 env 里 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 指向可用端点（该面若未登录，先在终端跑一次 claude 完成登录）；③ 再点一次「拉取可用模型」。'

/** 缓存年龄的短文案（面板 note 用；只描述事实，不假装新鲜）。 */
function ageText(ms) {
  const min = Math.floor(Math.max(0, Number(ms) || 0) / 60000)
  if (min < 1) return '刚刚拉取'
  if (min < 60) return min + ' 分钟前拉取'
  return Math.floor(min / 60) + ' 小时前拉取'
}

// ── 三工具 schema ─────────────────────────────────────────────────────────────
const RUN_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The task instruction for claude. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — claude reads the repo itself). For follow-ups on the same topic, use claude_continue with latest=true or sessionId (claude keeps session context; state only what is new).' },
    mode: { type: 'string', enum: MODE_ENUM, description: 'Permission mode. auto (default) follows the DSH plan state: plan when the session is in plan mode, otherwise bypass (permissions auto-approved so claude never blocks). plan = read-only planning; accept-edits = allow file edits but still ask for risky commands; bypass = --dangerously-skip-permissions.' },
    model: { type: 'string', description: 'Optional model id or alias (e.g. "sonnet", "opus", or a full id). Which ids actually work is decided by the endpoint, not by this bridge — call claude_models for the authoritative server-side list. Omit to use the model chosen in CLI Bridge settings, else claude\'s own configuration.' },
    maxBudgetUsd: { type: 'number', description: 'Optional hard cap on API spend for this run (passes --max-budget-usd).' },
    cwd: { type: 'string', description: 'Working directory for claude. Defaults to the DSH workspace root.' },
    addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to allow tool access to (--add-dir).' },
    allowedTools: { type: 'array', items: { type: 'string' }, description: 'Optional allow-list of tool names (--allowedTools).' },
    disallowedTools: { type: 'array', items: { type: 'string' }, description: 'Optional deny-list of tool names (--disallowedTools).' },
    systemPrompt: { type: 'string', description: 'Optional replacement system prompt (--system-prompt).' },
    appendSystemPrompt: { type: 'string', description: 'Optional system prompt appended to the default one (--append-system-prompt).' },
    forkSession: { type: 'boolean', description: 'When resuming, create a new session id instead of reusing the original (--fork-session).' },
    timeoutSec: { type: 'integer', description: 'Execution timeout seconds (10-3600, default 600).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with claude_status. Set false to block for the final answer.' }
  }
}
const CONTINUE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing claude session. State only what is new; claude preserves its session context.' },
    sessionId: { type: 'string', description: 'claude session id to resume (from a prior claude_run result; passes --resume).' },
    latest: { type: 'boolean', description: 'Continue the most recent claude conversation instead of a specific id (--continue).' },
    mode: { type: 'string', enum: MODE_ENUM, description: 'Permission mode; default auto.' },
    model: { type: 'string', description: 'Optional model id or alias.' },
    maxBudgetUsd: { type: 'number', description: 'Optional hard cap on API spend for this run.' },
    cwd: { type: 'string', description: 'Working directory for claude.' },
    forkSession: { type: 'boolean', description: 'Create a new session id instead of reusing the original (--fork-session).' },
    timeoutSec: { type: 'integer', description: 'Execution timeout seconds (10-3600, default 600).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output. Set false to block for the final answer.' }
  }
}
const STATUS_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }

// claude_models（附加工具）：服务端权威模型清单（探测 400 报文，绝不用配置冒充）。
const MODELS_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    refresh: { type: 'boolean', description: 'Bypass the 5-minute probe cache and ask the endpoint again.' },
    timeoutMs: { type: 'integer', description: 'Probe timeout in ms (5000-90000, default 30000).' }
  }
}
const MODELS_DESCRIPTION = 'List the models the current claude account/endpoint really supports, read LIVE from the server. Mechanism: the CLI is run once with a deliberately invalid model id, which makes the endpoint answer HTTP 400 with "The supported API model names are X, Y" — that roster is authoritative for this endpoint+key. Returns { ok, source:"account-live", models:[{id, configuredAs}], count }. The ANTHROPIC_*_MODEL entries in ~/.claude/settings.json are alias mappings, NOT the full supported set, so they are only returned as a diagnostic hint (never as models). If no live roster can be read this returns ok:false with an actionable error — it never invents a list.'

// 渲染函数签名遵循 harness 契约 render(args, value)（extraTools[].render 同签名，
// preset/dynamic/MCP 三处都按两参数调用 —— 只写一个参数会渲染出空壳）。
function renderModels(args, value) {
  const v = value || {}
  if (!v.ok) {
    const lines = ['claude_models failed: ' + String(v.error || 'unknown')]
    const cfg = v.diagnostic && Array.isArray(v.diagnostic.configured) ? v.diagnostic.configured : []
    if (cfg.length) {
      lines.push('configured aliases (NOT authoritative): ' + cfg.map((m) => m.id).join(', '))
      if (v.diagnostic && v.diagnostic.settingsPath) lines.push('  from ' + v.diagnostic.settingsPath)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const list = Array.isArray(v.models) ? v.models : []
  if (!list.length) return [{ type: 'text', text: 'claude_models: server returned an empty roster' }]
  const lines = ['claude models (' + list.length + ') [source=' + (v.source || 'account-live') + ']:']
  for (const m of list.slice(0, 40)) lines.push('  ' + m.id + (m.configuredAs ? '  [configured as ' + m.configuredAs + ']' : ''))
  if (list.length > 40) lines.push('  … and ' + (list.length - 40) + ' more')
  if (v.diagnostic && v.diagnostic.settingsPath) lines.push('settings: ' + v.diagnostic.settingsPath)
  return [{ type: 'text', text: lines.join('\n') }]
}

// usage 汇总：input/output + 两个 cache 计数（claude 的 input_tokens 不含 cache 命中）。
function sumTokens(usage) {
  if (!usage || typeof usage !== 'object') return null
  let total = 0
  let any = false
  for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
    if (typeof usage[k] === 'number' && Number.isFinite(usage[k])) { total += usage[k]; any = true }
  }
  return any ? total : null
}

// 本次实际跑的主模型：modelUsage 里按 costUSD（再退 token 量）挑最大者。
function pickModelUsed(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return null
  let best = null
  let bestScore = -1
  for (const k of Object.keys(modelUsage)) {
    const u = modelUsage[k] && typeof modelUsage[k] === 'object' ? modelUsage[k] : {}
    const score = (Number(u.costUSD) || 0) * 1e6 + (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0)
    if (score > bestScore) { bestScore = score; best = k }
  }
  return best
}

function defineProvider (deps = {}) {
  const env = deps.env || {}
  let host = null
  let settingsRef = { binPath: '', defaultModel: '', maxBudgetUsd: '' }

  /**
   * 当前生效设置（面板改完即时生效，无需重启）。三源合并，后者覆盖前者：
   *   ① settingsRef（attach 时快照/缺省）② deps.readSettings（MCP 形态现读文件）
   *   ③ host.getSettings('claude')（preset/dynamic 形态）。
   */
  function currentSettings() {
    const out = Object.assign({}, settingsRef)
    try {
      if (typeof deps.readSettings === 'function') {
        const r = deps.readSettings()
        if (r && typeof r === 'object') {
          const part = ('partition' in r || 'path' in r || 'home' in r) ? r.partition : r
          if (part && typeof part === 'object') Object.assign(out, part)
        }
      }
    } catch (e) { }
    try {
      if (host && typeof host.getSettings === 'function') {
        const s = host.getSettings('claude')
        if (s && typeof s === 'object') Object.assign(out, s)
      }
    } catch (e) { }
    return out
  }

  const descriptor = {
    id: 'claude', label: 'CLAUDE', presetId: 'claude-first', defaultBackend: null, defaultMode: 'auto',
    exeName: 'claude', binEnvVars: CLAUDE_BIN_ENV_VARS, unavailableStatus: 'CLAUDE_UNAVAILABLE',

    // 单后端：模型/凭据由 claude 自身配置（~/.claude/settings.json）决定，桥不引入第二后端。
    backends() { return null },
    normalizeBackend() { return null },
    resolveBackend(args, target, preferred) { return null },

    // 实测 flag 集（Claude Code 2.0.76 `claude --help`）。
    buildArgv(exePrefix, args, opts) {
      const o = opts || {}
      const argv = Array.isArray(exePrefix) ? exePrefix.slice() : [String(exePrefix)]
      argv.push('-p', String(args.prompt))
      // stream-json 才能实时折叠步骤（foldStreamEvent 吃 system/assistant/result 事件）；
      // stream=false 时退单行 json（更省字节，仍可解析）。
      const stream = args.stream !== false
      if (stream) argv.push('--output-format', 'stream-json', '--verbose')
      else argv.push('--output-format', 'json')
      if (stream && args.includePartialMessages) argv.push('--include-partial-messages')
      const timeoutSec = clampInt(args.timeoutSec, 600, 10, 3600)
      // 端点：cc-switch 的 proxy 模式把 Claude 指向第三方网关，而该网关要求自家 session 头
      // （claude CLI 不会发）——**直连必然 400**，必须经 cc-switch 本地代理转发。
      // 这里用 --settings 只覆盖 ANTHROPIC_BASE_URL，绝不改写用户的 ~/.claude/settings.json。
      const ep = resolveEndpoint(currentSettings(), deps.env || {}, { probe: o.probeProxy, configDir: claudeConfigDir(deps.env || {}) })
      if (ep.error) { const e = new Error(ep.error); e.code = 'ENDPOINT_UNAVAILABLE'; throw e }
      if (ep.mode === 'proxy' && ep.baseUrl) argv.push('--settings', overlaySettingsJson(ep.baseUrl))

      // 权限：auto → 跟随 DSH plan 状态；plan 用 CLI 的 plan 模式，其余走 bypass
      //（-p 没有 TTY，任何交互批准都会挂到超时 —— 与 agy/codebuddy/opencode 同语义）。
      let mode = String(args.mode || descriptor.defaultMode || 'auto')
      if (MODE_ENUM.indexOf(mode) < 0) mode = 'auto'
      if (mode === 'auto') mode = o.planActive ? 'plan' : 'bypass'
      if (mode === 'plan') argv.push('--permission-mode', 'plan')
      else if (mode === 'accept-edits') argv.push('--permission-mode', 'acceptEdits')
      else { mode = 'bypass'; argv.push('--dangerously-skip-permissions') }

      // 模型优先级：调用参数 > 设置面板 defaultModel > kit 注入的 defaultModel > 不传（claude 自决）。
      const model = args.model || currentSettings().defaultModel || o.defaultModel || ''
      if (model) argv.push('--model', String(model))

      const budgetRaw = args.maxBudgetUsd != null ? args.maxBudgetUsd : currentSettings().maxBudgetUsd
      const budget = budgetRaw == null ? NaN : Number(budgetRaw)
      if (Number.isFinite(budget) && budget > 0) argv.push('--max-budget-usd', String(budget))

      if (args.systemPrompt) argv.push('--system-prompt', String(args.systemPrompt))
      if (args.appendSystemPrompt) argv.push('--append-system-prompt', String(args.appendSystemPrompt))
      if (Array.isArray(args.allowedTools) && args.allowedTools.length) argv.push('--allowedTools', args.allowedTools.map(String).join(','))
      if (Array.isArray(args.disallowedTools) && args.disallowedTools.length) argv.push('--disallowedTools', args.disallowedTools.map(String).join(','))
      if (Array.isArray(args.addDirs)) for (const d of args.addDirs) { if (d) argv.push('--add-dir', String(d)) }
      if (args.noSessionPersistence) argv.push('--no-session-persistence')

      if (args.sessionId) argv.push('--resume', String(args.sessionId))
      else if (args.continueLatest) argv.push('--continue')
      if (args.forkSession && (args.sessionId || args.continueLatest)) argv.push('--fork-session')
      return { argv, mode, timeoutSec }
    },

    // stdout 解析：json = 单行 result；stream-json = 多行事件，取**最后**一个 result。
    // 无 result 事件 → null（buildResult 据此判 PARSE_ERROR，绝不假造成功）。
    parseJson(stdoutText) {
      const trimmed = String(stdoutText || '').trim()
      if (!trimmed) return null
      let last = null
      for (const raw of trimmed.split(/\r?\n/)) {
        const t = raw.trim()
        if (!t.startsWith('{')) continue
        let obj
        try { obj = JSON.parse(t) } catch (e) { continue }
        if (obj && obj.type === 'result') last = obj
      }
      if (last) return last
      try {
        const obj = JSON.parse(trimmed)
        if (obj && obj.type === 'result') return obj
      } catch (e) { }
      return null
    },

    // 统一结果对象。⚠️ 成功判据 = is_error === false（且 subtype 非错误态）**并且** exit 0；
    // 只看 exit code 会把「无效模型」误判成成功（实测该场景 exit 1 + subtype "success"），
    // 反过来也存在 exit 0 + is_error true 的形态，故两者必须同时成立。
    buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
      const exitCode = outcome ? outcome.exitCode : null
      const stderr = stderrText ? String(stderrText).slice(-2000) : ''
      if (parsed && typeof parsed === 'object') {
        const isError = parsed.is_error === true
        const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : ''
        const response = typeof parsed.result === 'string' ? parsed.result : ''
        const errorText = isError ? (response || (typeof parsed.error === 'string' ? parsed.error : '')) : ''
        let status
        if (exitCode === 130) status = 'ABORTED'
        else if (isError) status = subtype === 'error_max_turns' ? 'MAX_TURNS' : 'EXEC_ERROR'
        else if (exitCode !== 0) status = 'CLI_ERROR'
        else status = 'SUCCESS'
        const ok = !isError && exitCode === 0 && status === 'SUCCESS'
        const denials = Array.isArray(parsed.permission_denials) ? parsed.permission_denials.length : 0
        return {
          ok,
          status,
          response,
          sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
          durationSeconds: typeof parsed.duration_ms === 'number' ? Math.round(parsed.duration_ms / 100) / 10 : null,
          numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
          totalTokens: sumTokens(parsed.usage),
          exitCode, mode, backend: backend || null,
          // is_error 的正文也必须进 stderr：限流/凭据判定与失败指引都读它。
          stderr: (stderr ? stderr + ' ' : '') + errorText,
          subtype: subtype || null,
          modelUsed: pickModelUsed(parsed.modelUsage),
          costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
          permissionDenials: denials
        }
      }
      const text = String(stdoutText || '').trim()
      const status = exitCode === 0 ? 'PARSE_ERROR' : 'CLI_ERROR'
      return {
        ok: false,
        status,
        response: '',
        sessionId: null,
        durationSeconds: null, numTurns: null, totalTokens: null,
        exitCode, mode, backend: backend || null,
        stderr: (stderr ? stderr + ' ' : '') + (exitCode === 0 ? 'no result event in claude output' : ''),
        subtype: null, modelUsed: null, costUsd: null, permissionDenials: 0,
        rawStdout: text.slice(-2000)
      }
    },

    // 实时步骤折叠（stream-json → project.current/trail）。
    // 事件形态（实测）：system/subtype=init 带 model+permissionMode；assistant.message.content
    // 是 Anthropic 内容块数组（thinking / text / tool_use）；user.message.content 带 tool_result。
    foldStreamEvent(ev, p, summarizeArgs, maxArgLen, maxTrail) {
      if (!ev || typeof ev !== 'object') return
      const type = ev.type
      if (!type) return
      const cap = maxTrail || 12
      const capLen = maxArgLen || 120
      const push = (entry) => { p.trail.push(entry); while (p.trail.length > cap) p.trail.shift() }
      const blocksOf = (m) => (m && typeof m === 'object' && Array.isArray(m.content) ? m.content : [])
      p.updatedAt = Date.now()
      if (type === 'system') {
        if (ev.subtype === 'init') {
          p.current = { tool: 'session', args: { model: ev.model || '', permissionMode: ev.permissionMode || '' }, stepIndex: 0, since: nowIso() }
          return
        }
        return
      }
      if (type === 'assistant') {
        for (const b of blocksOf(ev.message)) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'tool_use') {
            const tool = b.name || 'tool'
            const args = summarizeArgs(b.input)
            const idx = p.trail.length
            push({ stepIndex: idx, state: 'ACTIVE', tool, args: args || null, at: nowIso() })
            p.current = { tool, args: args || null, stepIndex: idx, since: nowIso() }
          } else if (b.type === 'text' && typeof b.text === 'string' && b.text) {
            p.current = { tool: 'agent_response', args: { text_delta: b.text.slice(0, capLen) }, stepIndex: p.trail.length, since: nowIso() }
          } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
            p.current = { tool: 'reasoning', args: { text_delta: b.thinking.slice(0, capLen) }, stepIndex: p.trail.length, since: nowIso() }
          }
        }
        return
      }
      if (type === 'user') {
        for (const b of blocksOf(ev.message)) {
          if (!b || typeof b !== 'object' || b.type !== 'tool_result') continue
          // 把最近一个仍在 ACTIVE 的步骤收尾（tool_result 不带 tool name，按时间序配对）。
          for (let i = p.trail.length - 1; i >= 0; i--) {
            if (p.trail[i].state === 'ACTIVE') { p.trail[i].state = b.is_error === true ? 'ERROR' : 'DONE'; break }
          }
          p.current = null
        }
        return
      }
      if (type === 'result') { p.current = null }
    },

    // 瞬时错误静默重试一次：只认网络/过载类，且明确排除模型名/凭据类（那些重试无用）。
    isTransientCliError(res) {
      if (!res || res.ok) return false
      if (isLimited(res)) return false
      const hay = String(res.stderr || '') + ' ' + String(res.response || '')
      if (/supported API model names|invalid_request_error|model .* not|authentication|invalid api key|401|403/i.test(hay)) return false
      return /overloaded|529|503|ECONNRESET|socket hang up|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|terminated|connection (reset|closed)/i.test(hay)
    },

    failureHint(res) {
      if (!res || res.ok) return ''
      const st = String(res.status || '')
      if (st === 'CLAUDE_UNAVAILABLE') return '[诊断] 未找到 claude 可执行文件：请安装 Claude Code（或 npm i -g @anthropic-ai/claude-code），或在 CLI Bridge 设置面板填写 claude 可执行文件路径（也可设 CLAUDE_BIN）。'
      if (st === 'PARSE_ERROR') return '[诊断] claude 没有输出 result 事件（进程可能被中断/输出被截断）。若你手动改了 output-format，请改回；否则重试一次，持续失败请检查 CLI 版本（--output-format json 是 2.x 的行为）。'
      const hay = String(res.stderr || '') + ' ' + String(res.response || '')
      const supported = parseSupportedModels(hay)
      if (supported) return '[诊断] 模型名被端点拒绝。该端点当前支持的模型：' + supported.join(', ') + ' —— 用 claude_models 取权威清单，然后在调用参数或设置面板里改 model；字符串 "[1M]" 之类的后缀属于配置里的别名写法，不能直接当 --model 传入。'
      if (/supported API model names|invalid_request_error/i.test(hay)) return '[诊断] 模型名被端点拒绝（400 invalid_request_error）：先用 claude_models 确认服务端支持的模型，再传 model。'
      if (res.permissionDenials) return '[诊断] 有 ' + res.permissionDenials + ' 次工具调用被权限拒绝：-p 模式没有交互确认，请用 mode=bypass（默认 auto 在非 plan 模式下就是 bypass），或在 allowedTools 里放行所需工具。'
      if (/authentication_error|invalid x-api-key|invalid api key|401|unauthorized|not logged in|oauth|api key/i.test(hay) && !/rate.?limit|quota|限流|额度/i.test(hay)) {
        return '[诊断] claude 凭据/端点问题：请让用户检查 ~/.claude/settings.json 的 env 块（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN）或重新登录 claude；这不是限流。'
      }
      if (/rate.?limit|\b429\b|quota|insufficient|credit|balance|额度/i.test(hay)) {
        return '[诊断] 端点报告限流/额度不足：不要循环重试；换 model（用 claude_models 挑一个可用的）或改用 DSH 原生工具完成本任务。'
      }
      return ''
    },

    isSuccessStatus(st) { return st === 'SUCCESS' },

    tools: {
      run: { name: 'claude_run', description: 'Dispatch a coding/build/debug/investigation task to the local Claude Code CLI and return its final answer. Prefer this for implementation, edits, refactors, multi-file investigation and debugging in every mode. DSH fully controls claude: it always runs non-interactively with permissions auto-approved (claude never blocks on a prompt), in stream-json mode so live steps reach claude_status. Use read-only native tools only for quick lookups and for final build/test verification. Runs in the background by default (returns a jobId immediately; collect with job_output); set background=false to block for the final answer.', inputSchema: RUN_PARAMS },
      continue: { name: 'claude_continue', description: 'Continue an existing claude session with a follow-up prompt, reusing claude context. Pass sessionId from a prior claude_run result (--resume), or set latest=true to continue the most recent conversation (--continue). Same DSH-controlled, no-prompt execution as claude_run.', inputSchema: CONTINUE_PARAMS },
      status: { name: 'claude_status', description: 'Read a live snapshot of what the local claude agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or agent_response thinking/typing), the recent step trail (tools executed, done/error), and the last completed run status + session id. Optional cwd filters to a single project. Call this to check on an in-flight claude_run/claude_continue without waiting for it to finish.', inputSchema: STATUS_PARAMS }
    },

    // claude_models：三形态都注册（探测只需 node child_process；拿不到 spawn 能力时
    // logic 明确返回 ok:false，而不是静默缺席或伪造列表）。
    extraTools: [{
      name: 'claude_models',
      description: MODELS_DESCRIPTION,
      inputSchema: MODELS_PARAMS,
      render: renderModels,
      async logic(args) {
        return await descriptor.listModels(args || {})
      }
    }],

    /**
     * 列出服务端权威可用模型（三形态共用）。
     * 铁律：只认账号/端点探测；探测失败 = ok:false + 可操作错误 + 配置线索（非权威）。
     */
    async listModels(args) {
      const a = args || {}
      return await listAccountModels(env, {
        binPath: currentSettings().binPath,
        timeoutMs: clampInt(a.timeoutMs, 30000, 5000, 90000),
        refresh: !!a.refresh
      })
    },

    // ── 设置分区（契约 §3）─────────────────────────────────────────────────────
    settings: {
      keys: ['binPath', 'defaultModel', 'maxBudgetUsd'],
      defaults: () => ({ binPath: '', defaultModel: '', maxBudgetUsd: '' }),
      normalize: (raw) => {
        const r = raw && typeof raw === 'object' ? raw : {}
        const out = { binPath: '', defaultModel: '', maxBudgetUsd: '' }
        for (const k of ['binPath', 'defaultModel', 'maxBudgetUsd']) {
          if (typeof r[k] === 'string') out[k] = String(r[k]).trim()
        }
        return out
      },
      /**
       * 设置面板元数据（契约 §3.2）：**只读缓存、绝不探测**。
       * 面板是同步回调，而探测要起子进程打网络（3-5s）——放在这里会把首屏拖慢，且探不到时
       * 用户无法区分「没模型」与「没拉到」。故探测改为用户点「拉取可用模型」→
       * settings.refreshModels() 显式触发；成功后写回同一份缓存，这里下次渲染直接命中。
       */
      meta: (env2) => {
        const e = env2 && typeof env2 === 'object' ? env2 : {}
        const s = currentSettings()
        const cached = readCachedModels(e, { binPath: s.binPath })
        const options = (cached ? cached.ids : []).map((id) => ({ value: id, label: id }))
        const exeCandidates = claudeExeCandidates(e, '')
        // 端点实际走向（proxy / direct）——面板上如实显示，用户不用猜为什么请求失败。
        const epInfo = resolveEndpoint(s, e, { configDir: claudeConfigDir(e) })
        return {
          titleSuffix: 'Claude Code',
          fields: [
            {
              key: 'binPath', label: 'claude 可执行文件路径', type: 'select', allowCustom: true,
              options: exeCandidates.map((p) => ({ value: p, label: p })),
              placeholder: '留空 = 自动探测本地安装 / PATH',
              note: '检测到 ' + exeCandidates.length + ' 个候选；npm 全局安装给的是 .cmd（模型探测与 MCP 形态经 shell 启动），原生安装给 .exe —— preset 形态建议指向原生 .exe（.cmd 能否执行取决于宿主 subprocess）。也可手动粘贴任意路径（.mjs/.js 经 node 启动）。'
            },
            {
              key: 'defaultModel', label: '默认模型', type: 'select', allowCustom: true,
              options,
              // 面板据此渲染「手动拉取」按钮（契约 §3.2）；meta() 自身永不探测。
              refresh: { label: '拉取可用模型' },
              placeholder: '留空 = 由 claude 自身配置（~/.claude/settings.json）决定',
              note: options.length
                ? '共 ' + options.length + ' 个服务端权威可用模型（' + ageText(cached.ageMs) + '，源：' + cached.mode + '）。点「拉取可用模型」重新获取；调用时传 model 可覆盖本项。'
                : '还没拉取过（或上次没拉到）：点「拉取可用模型」向端点取权威清单；空表示尚未拉取 / 该面未登录。可直接手动输入模型名 —— 配置里的 ANTHROPIC_*_MODEL 只是别名映射，不作为候选展示。'
            },
            {
              key: 'maxBudgetUsd', label: '单次最大花费（美元）', type: 'text',
              placeholder: '留空 = 不限制',
              note: '非空时自动附加 --max-budget-usd；调用参数 maxBudgetUsd 可覆盖。'
            },
            {
              key: 'endpointMode', label: '端点模式', type: 'select',
              options: [
                { value: 'auto', label: 'auto —— 代理活着就走代理，否则直连' },
                { value: 'proxy', label: 'proxy —— 强制走本地代理' },
                { value: 'direct', label: 'direct —— 强制直连配置的端点' }
              ],
              note: epInfo.note + '。cc-switch 的 proxy 模式把 Claude 指向第三方网关，该网关要求自家 session 头而 claude CLI 不会发：直连必然 400，必须经 cc-switch 本地代理转发。'
            },
            {
              key: 'proxyUrl', label: '本地代理地址', type: 'text',
              placeholder: DEFAULT_PROXY_URL,
              note: 'cc-switch 的本地代理默认监听 127.0.0.1:15721。若你改过端口，填这里。桥接用 --settings 只覆盖 ANTHROPIC_BASE_URL，**不会改写** ~/.claude/settings.json。'
            }
          ]
        }
      },

      /**
       * 手动拉取（契约 §3.2）：面板「拉取可用模型」按钮 → keystone
       * POST /cli-bridge/settings/models → 这里。这是本 provider 唯一的面板探测入口。
       *
       * 复用 listAccountModels（异步 probeSupportedModels + 配置诊断），不写第二套探测；
       * 其成功路径已把权威清单写回 modelsCache，随后 meta() 直接命中（无需再探测）。
       * 铁律：失败 = ok:false + 可操作错误 + 空 ids，绝不返回 {ok:true, ids:[]}；
       * 也绝不把 settings.json 里的别名映射冒充成服务端可用全集。
       */
      async refreshModels(settings, env2) {
        const e = (env2 && typeof env2 === 'object') ? env2 : env
        const s = descriptor.settings.normalize(settings)
        // 探测必须走**同一个端点**：cc-switch proxy 模式下直连第三方网关会 400，那样探测
        // 永远拿不到东西（但配置清单仍应给出，见 listAccountModels 的合并逻辑）。
        const ep = resolveEndpoint(s, e, { configDir: claudeConfigDir(e) })
        const got = await listAccountModels(e, {
          binPath: s.binPath,
          baseUrl: ep.mode === 'proxy' ? ep.baseUrl : '',
          timeoutMs: REFRESH_TIMEOUT_MS,
          refresh: true
        })
        if (!got.ok) {
          return { ok: false, ids: [], source: got.source || 'none', error: String(got.error || 'probe failed') + ' ' + REFRESH_HINT + ' 端点：' + ep.note }
        }
        const ids = (got.models || []).map((m) => m.id).filter(Boolean)
        if (!ids.length) {
          return { ok: false, ids: [], source: got.source || 'none', error: '探测声称成功但未返回任何模型 id（内部不一致）。' + REFRESH_HINT }
        }
        // labels 标出「来自配置」还是「服务端报文补充」，面板可据此区分来源。
        const labels = {}
        for (const m of got.models) {
          labels[m.id] = m.id + (m.source === 'configured'
            ? '  [' + String(m.configuredAs || 'settings.json') + ']'
            : '  [服务端清单]')
        }
        return { ok: true, ids, labels, source: got.source || 'configured', endpoint: ep.note }
      },
      diagnose: (settings, env2) => {
        const s = settings && typeof settings === 'object' ? settings : {}
        const e = env2 && typeof env2 === 'object' ? env2 : {}
        const bits = []
        if (s.binPath) bits.push('bin=设置:' + s.binPath)
        else if (claudePathHint(e)) bits.push('bin=' + claudePathHint(e))
        else bits.push('bin=PATH:claude')
        bits.push(s.defaultModel ? 'model=' + s.defaultModel : 'model=(claude 自决)')
        if (s.maxBudgetUsd) bits.push('maxBudget=$' + s.maxBudgetUsd)
        const cfg = readConfiguredModels(e)
        if (cfg.ok && cfg.models.length) bits.push('settings.json env: ' + cfg.models.length + ' 个别名映射（非权威清单）')
        if (!cfg.ok && cfg.error) bits.push('settings.json: ' + cfg.error.slice(0, 120))
        return bits.join(' · ')
      }
    },

    // MCP 面版本由宿主注入（mcp/version.mjs 单源派生），描述符不复制 version 字面量。
    mcp: (deps.mcp && typeof deps.mcp === 'object') ? Object.assign({}, deps.mcp) : {}
  }

  // ── 三形态共用的工具逻辑（签名固定：宿主接线见 preset/dynamic/mcp 三处）──────────
  descriptor.runToolLogic = async function (args, exec) {
    const a = args || {}
    const normalized = a.background === undefined ? Object.assign({}, a, { background: true }) : a
    return this.runner.coreExecute(normalized, exec)
  }
  descriptor.continueToolLogic = async function (args, exec) {
    const a = args || {}
    const mapped = {
      prompt: a.prompt, mode: a.mode, model: a.model, maxBudgetUsd: a.maxBudgetUsd,
      cwd: a.cwd, forkSession: a.forkSession, timeoutSec: a.timeoutSec,
      background: a.background === undefined ? true : a.background
    }
    const sid = a.sessionId || null
    if (sid) mapped.sessionId = sid
    else if (a.latest) mapped.continueLatest = true
    return this.runner.coreExecute(mapped, exec)
  }
  descriptor.statusToolLogic = function (args) {
    const a = args || {}
    const snap = this.engine.statusSnapshot()
    if (a.cwd) {
      const key = String(a.cwd)
      snap.projects = snap.projects.filter((p) => p.cwd === key)
      const g = snap.projects[0]
      if (g) {
        Object.assign(snap, {
          state: g.state, running: g.running, current: g.current, trail: g.trail,
          lastStatus: g.lastStatus, lastAt: g.lastAt, lastSessionId: g.lastSessionId,
          lastBackend: g.lastBackend, fallbackActive: g.fallbackActive, updatedAt: g.updatedAt
        })
      }
    }
    return snap
  }

  descriptor.attach = function (hostOpts) {
    host = hostOpts || {}
    try {
      if (typeof host.getSettings === 'function') {
        const s = host.getSettings('claude')
        if (s && typeof s === 'object') settingsRef = descriptor.settings.normalize(s)
      }
    } catch (e) { }
    this.engine = createStatusEngine({ provider: this, publish: host.publish })
    const runner = createRunner(Object.assign({}, host, { provider: this, engine: this.engine }))
    this.runner = runner
    return runner
  }
  return descriptor
}

// ── inlined from providers/claude-endpoint.mjs ──
// providers/claude-endpoint.mjs — claude 的端点解析（第三片）。
//
// 为什么需要这一层（真实事故，2026-10-20）：
// 用户用 cc-switch 管理 Claude 配置，其「proxy 模式」把 Claude 指向第三方网关
// （例：ANTHROPIC_BASE_URL=https://opencode.ai/zen/go）。该网关要求自家 session 头
// （`x-opencode-session` / MissingSessionID），claude CLI 不会发 → **直连必然 400**。
// 能用是因为 cc-switch 在本机起了一个转发代理，由它补头/认证：
//   实测 POST http://127.0.0.1:15721/v1/messages → 200；同一配置直连 → 400 MissingSessionID。
// 所以「把 base_url 换成 cc-switch 代理」不是降级，而是这套配置**唯一可行**的访问方式。
//
// 注入方式：`--settings <json>` 覆盖 env.ANTHROPIC_BASE_URL，**不改用户的
// ~/.claude/settings.json**（那是 cc-switch 的领地，改它会在下次切换时被覆盖，也可能
// 破坏用户的 GUI 会话）。
//
// 探活采用「起一次 node 子进程做 HTTP GET」：buildArgv/meta 都是同步回调，Node 无同步
// HTTP。结果按 URL 缓存 30s，避免每次调用都起进程。探不到就如实回落直连（并在诊断里
// 说明"代理未响应"），绝不再假装已接管。

/** 默认的 cc-switch 本地代理地址（其 proxy_config.listen_port 实测为 15721）。 */
const DEFAULT_PROXY_URL = 'http://127.0.0.1:15721'

/** 端点模式：auto = 代理活着就用它；proxy = 强制；direct = 强制直连。 */
const ENDPOINT_MODES = ['auto', 'proxy', 'direct']

const PROXY_TTL_MS = 30 * 1000
let proxyCache = { url: '', at: 0, alive: false, detail: '' }

/** 允许测试注入探测结果，避免每个用例都起子进程。 */
function resetProxyCache() { proxyCache = { url: '', at: 0, alive: false, detail: '' } }

function builtin(name) {
  const p = globalThis.process
  try { return (p && typeof p.getBuiltinModule === 'function') ? p.getBuiltinModule(name) : null } catch (e) { return null }
}

/** 探活子脚本：对 url 发 GET，任何 HTTP 响应都算活着（404 也算 —— cc-switch 根路径就是 404）。 */
const PROBE_SCRIPT = [
  "const http=require('http'),https=require('https');",
  "const u=process.argv[1];",
  "const m=/^https:/i.test(u)?https:http;",
  "const r=m.get(u,{timeout:1500},(res)=>{res.resume();console.log('ALIVE '+res.statusCode);process.exit(0)});",
  "r.on('error',(e)=>{console.log('DEAD '+(e.code||e.message));process.exit(0)});",
  "r.on('timeout',()=>{console.log('DEAD timeout');try{r.destroy()}catch(e){};process.exit(0)});"
].join('')

/**
 * 同步探活（带 30s 缓存）。返回 { alive, detail }。
 * 起 `node -e` 子进程是唯一能在同步回调里做真实 HTTP 的办法；代价约 100-250ms，
 * 且被 URL 维度缓存 —— 只在「首次」或「缓存过期」时付。
 */
function detectProxySync(url, nowMs) {
  const target = String(url || '').trim()
  if (!target) return { alive: false, detail: 'no url' }
  const at = Number(nowMs) || Date.now()
  if (proxyCache.url === target && at - proxyCache.at < PROXY_TTL_MS) {
    return { alive: proxyCache.alive, detail: proxyCache.detail }
  }
  const child = builtin('node:child_process')
  const proc = globalThis.process
  let alive = false
  let detail = 'no child_process'
  if (child && typeof child.spawnSync === 'function' && proc && proc.execPath) {
    try {
      const r = child.spawnSync(proc.execPath, ['-e', PROBE_SCRIPT, target], {
        encoding: 'utf8', timeout: 4000, windowsHide: true,
        env: Object.assign({}, proc.env)
      })
      const out = String((r && r.stdout) || '')
      alive = /^ALIVE\b/m.test(out)
      detail = out.trim().split(/\r?\n/).pop() || (r && r.error && (r.error.code || r.error.message)) || 'unknown'
    } catch (e) { detail = 'probe threw: ' + String(e && e.message || e) }
  }
  proxyCache = { url: target, at, alive, detail }
  return { alive, detail }
}

/** 读 ~/.claude/settings.json 里配置的 ANTHROPIC_BASE_URL（只读，不写）。 */
function readConfiguredBaseUrl(env, configDir) {
  const fs = builtin('node:fs')
  const path = builtin('node:path')
  if (!fs || !path) return ''
  const dir = configDir || ((env && (env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME)) || '')
  if (!dir) return ''
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
    const block = raw && raw.env && typeof raw.env === 'object' ? raw.env : {}
    return typeof block.ANTHROPIC_BASE_URL === 'string' ? block.ANTHROPIC_BASE_URL.trim() : ''
  } catch (e) { return '' }
}

/**
 * 解析最终端点。
 * @returns {{ mode: 'proxy'|'direct', baseUrl: string, proxyUrl: string, proxyAlive: boolean,
 *             configuredBaseUrl: string, note: string, error?: string }}
 */
function resolveEndpoint(settings, env, opts) {
  const o = opts || {}
  const s = settings && typeof settings === 'object' ? settings : {}
  const mode = ENDPOINT_MODES.indexOf(String(s.endpointMode || '')) >= 0 ? String(s.endpointMode) : 'auto'
  const proxyUrl = String(s.proxyUrl || DEFAULT_PROXY_URL).trim() || DEFAULT_PROXY_URL
  const configuredBaseUrl = readConfiguredBaseUrl(env, o.configDir)

  if (mode === 'direct') {
    return { mode: 'direct', baseUrl: configuredBaseUrl, proxyUrl, proxyAlive: false, configuredBaseUrl, note: '强制直连（endpointMode=direct）' }
  }
  const det = o.probe ? o.probe(proxyUrl) : detectProxySync(proxyUrl)
  if (det.alive) {
    return {
      mode: 'proxy', baseUrl: proxyUrl, proxyUrl, proxyAlive: true, configuredBaseUrl,
      note: '经 cc-switch 本地代理 ' + proxyUrl + '（配置的端点 ' + (configuredBaseUrl || '(未读到)') + ' 需要代理补头）'
    }
  }
  if (mode === 'proxy') {
    return {
      mode: 'proxy', baseUrl: proxyUrl, proxyUrl, proxyAlive: false, configuredBaseUrl,
      note: '强制走代理但探测失败：' + det.detail,
      error: 'cc-switch 本地代理 ' + proxyUrl + ' 无响应（' + det.detail + '）。请启动 cc-switch（含其本地代理），' +
        '或把「端点模式」改为 direct 直连，或在「代理地址」里填实际端口。'
    }
  }
  return {
    mode: 'direct', baseUrl: configuredBaseUrl, proxyUrl, proxyAlive: false, configuredBaseUrl,
    note: '直连配置的端点 ' + (configuredBaseUrl || '(未读到)') + '（本地代理 ' + proxyUrl + ' 未响应：' + det.detail + '）。' +
      '若该端点来自 cc-switch 的 proxy 模式，请启动 cc-switch —— 否则会被网关以缺 session 头拒绝。'
  }
}

/** 把端点覆盖编成 claude 的 `--settings` JSON（只覆盖 base_url，不动其它键）。 */
function overlaySettingsJson(baseUrl) {
  if (!baseUrl) return ''
  return JSON.stringify({ env: { ANTHROPIC_BASE_URL: String(baseUrl) } })
}

// ── inlined from providers/claude-exe.mjs ──
// providers/claude-exe.mjs — claude 可执行文件探测/包装（无宿主依赖的纯逻辑片）。
//
// 从 providers/claude.mjs 拆出，让两个文件都留在 600 行红线内（规则 §26）。
// scripts/build.mjs 会把 providers/claude-*.mjs 按文件名字典序内联进 dynamic 沙箱的
// 同一个作用域，所以沙箱里这些函数天然可见；ESM 形态走本文件的 import。
// ⚠️ 注释里绝不写出口令标记字面量（build 全局替换会把注释劈开 → 生成物语法崩）。
//
// 本机实测事实（Claude Code 2.0.76，Windows）：
//   • PATH 上的 `claude` 是原生 exe（.cherrystudio\bin\claude.exe）；官方原生 installer
//     给 claude.exe，npm 全局安装给 claude.cmd + node_modules/@anthropic-ai/claude-code/cli.js。
//   • Windows 上 Node 的 spawn 不能直接执行 .cmd/.bat（CreateProcess 只补 .exe），
//     必须 shell:true；.js/.mjs 目标必须经 node 包装。这两条决定下面的 splitExeSpec。

// 沙箱可能没有 fs/path：一律经 getBuiltinModule + typeof 守卫读取，读不到就退保守值。
function claudeBuiltin(name) {
  try {
    const proc = globalThis.process
    return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule(name) : null
  } catch (e) { return null }
}

// PATH 兜底名（Windows 由 CreateProcess 自动补 .exe）。
const CLAUDE_EXE_BASENAME = 'claude'

// 用户可以显式指定可执行文件的既有环境变量（按优先级）。
const CLAUDE_BIN_ENV_VARS = ['CLAUDE_BIN', 'CLAUDE_CLI', 'CLAUDE_CODE_BIN']

// 已知的本地安装位置（native installer / 官方 local 目录）；存在才收，不做版本猜测。
const CLAUDE_LOCAL_REL = [
  ['.claude', 'local', 'claude.exe'],
  ['.claude', 'local', 'claude'],
  ['.local', 'bin', 'claude.exe'],
  ['.local', 'bin', 'claude']
]

/**
 * 把「一个可执行文件路径」拆成 spawn 需要的形态。
 * .js/.cjs/.mjs → 经当前 node 启动（测试 fixture 与 npm 安装的 cli.js 都是这形态）；
 * .cmd/.bat    → 只能 shell 执行（Windows 限制），调用方必须带 shell:true；
 * 其余         → 直接执行（原生 exe / PATH 名字）。
 * @param {string} exe
 * @returns {{cmd: string, prefixArgs: string[], shell: boolean, kind: string}}
 */
function splitExeSpec(exe) {
  const s = String(exe || '')
  if (/\.(mjs|cjs|js)$/i.test(s)) {
    const proc = globalThis.process
    const node = (proc && proc.execPath) ? proc.execPath : 'node'
    return { cmd: node, prefixArgs: [s], shell: false, kind: 'node' }
  }
  if (/\.(cmd|bat)$/i.test(s)) return { cmd: s, prefixArgs: [], shell: true, kind: 'shell' }
  return { cmd: s, prefixArgs: [], shell: false, kind: 'binary' }
}

/** shell:true 下的命令行拼装（只用于参数集合固定的探测调用，不拼装用户 prompt）。 */
function quoteShellArg(a) {
  const s = String(a)
  return /[\s"&|<>^()]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/**
 * 候选可执行文件列表（顺序 = 优先级）：设置面板 binPath > env 变量 > 已知本地安装 > PATH 名字。
 * 纯函数、零副作用；无 fs 能力时只返回设置/env/PATH 名，绝不抛。
 * @param {object} env 环境变量
 * @param {string} [binPath] 设置面板里显式填写的路径
 * @returns {string[]}
 */
function claudeExeCandidates(env, binPath) {
  const e = env || {}
  const out = []
  const push = (p) => { const v = String(p || '').trim(); if (v && out.indexOf(v) < 0) out.push(v) }
  if (binPath) push(binPath)
  for (const k of CLAUDE_BIN_ENV_VARS) if (e[k]) push(e[k])
  const fs = claudeBuiltin('node:fs')
  const path = claudeBuiltin('node:path')
  const home = e.USERPROFILE || e.HOME || ''
  if (fs && path && typeof fs.existsSync === 'function' && typeof path.join === 'function' && home) {
    for (const rel of CLAUDE_LOCAL_REL) {
      const p = path.join.apply(path, [home].concat(rel))
      try { if (fs.existsSync(p)) push(p) } catch (err) { }
    }
  }
  push(CLAUDE_EXE_BASENAME)
  return out
}

/**
 * 探测时优先尝试的候选（去掉 PATH 兜底名——它由 spawn 的 PATH 搜索处理，且不是绝对路径）。
 * @returns {string[]}
 */
function claudeProbeCandidates(env, binPath) {
  return claudeExeCandidates(env, binPath).filter((c) => c !== CLAUDE_EXE_BASENAME)
}

/**
 * buildArgv 需要的前缀数组：设置 binPath > env > 本地安装 > PATH 名字。
 * .js/.mjs 目标返回 [node, file]。宿主形态（preset/dynamic）也会用它做 existsSync 校验。
 * @returns {string[]}
 */
function resolveExePrefix(env, binPath) {
  const cands = claudeExeCandidates(env, binPath)
  const spec = splitExeSpec(cands[0] || CLAUDE_EXE_BASENAME)
  return [spec.cmd].concat(spec.prefixArgs)
}

/** PATH 里的 claude 是否真的可执行（仅诊断用：返回路径或空串）。 */
function claudePathHint(env) {
  const e = env || {}
  for (const k of CLAUDE_BIN_ENV_VARS) if (e[k]) return String(e[k])
  const cands = claudeExeCandidates(e, '')
  return cands.length ? String(cands[0]) : ''
}

// ── inlined from providers/claude-models.mjs ──
// providers/claude-models.mjs — claude 模型清单探测（账号实时权威源，纯逻辑 + 最小 spawn）。
//
// 从 providers/claude.mjs 拆出（规则 §26：单文件 600 行红线）。build 会把
// providers/claude-*.mjs 按字典序内联进 dynamic 沙箱同一作用域；ESM 形态走 import。
// ⚠️ 注释里绝不写出口令标记字面量。
//
// 为什么必须「探测」而不是读配置（本机 Claude Code 2.0.76 + 第三方 Anthropic 兼容端点实测）：
//   传一个故意无效的模型名 → 服务端返回 400，CLI 把报文塞进 result 事件：
//     {"type":"result","subtype":"success","is_error":true,
//      "result":"API Error: 400 {\"error\":{\"message\":\"The supported API model names are
//                deepseek-flash, deepseek-v4-pro, but you passed __clb_probe_invalid__.\"}}"}
//   → 这条 "The supported API model names are X, Y" 就是该端点/该 key 的权威可用清单。
//   ~/.claude/settings.json 的 env.ANTHROPIC_DEFAULT_*_MODEL 只是「别名映射」，
//   不是服务端可用全集 —— 红线：绝不把它冒充成可用清单，也绝不静默返回空数组。
//
// 缓存与「谁探测」（契约 §3.2 手动拉取）：
//   • settings.meta() 是同步回调，且**不再自动探测** —— 它只调 readCachedModels() 读这里的
//     缓存（纯读、不 spawn、不联网）；没命中就留空，由 note 提示用户点「拉取可用模型」。
//   • 探测只有一条路：settings.refreshModels() → 异步 probeSupportedModels()（用户显式触发）。
//     成功后经 cachedModels() 写回同一个缓存，下次 meta() 直接命中 —— 面板首屏不再被拖慢。
//   • 5 分钟 TTL 只约束**工具调用**（claude_models 的重复调用）；面板展示的是「上次拉取到的
//     权威清单」，过期也照旧展示，但 note 会标注拉取时间（宁可显式标旧，也不让下拉莫名清空）。
// import { claudeExeCandidates, claudeProbeCandidates, splitExeSpec, quoteShellArg } from './claude-exe.mjs'
// 故意无效的探测模型名（服务端必然拒绝；保持带前缀，便于日志辨认来源）。
const PROBE_MODEL = '__clb_probe_invalid__'
const MODELS_TTL_MS = 5 * 60 * 1000

// 探测结果缓存：key（后端/端点标识） → { at, value }
const modelsCache = new Map()

/** 清空探测缓存（测试与「模型变更后刷新」用）。 */
function resetModelsCache() { modelsCache.clear() }

// 缓存键 = 候选可执行文件集合（同一台机器可能切换 CLAUDE_BIN / 面板路径，键必须跟着变，
// 否则会把「上一个 exe 的探测结果」错配给新 exe）。
function candidateKey(env, binPath) {
  const list = claudeProbeCandidates(env, binPath)
  return list.length ? list.join('|') : 'claude'
}

/** 缓存的键（面板读缓存与工具探测必须用同一把键，否则写进去读不出来）。 */
function modelsCacheKey(env, binPath) {
  return 'claude:' + candidateKey(env, binPath)
}

/** 缓存里只可能存「成功的权威清单」；失败绝不入缓存（否则会把坏状态固化）。 */
function isUsableProbe(v) {
  return !!(v && v.ok === true && Array.isArray(v.ids) && v.ids.length)
}

/**
 * 缓存包装（异步工具路径）：TTL 内直接返回上次成功结果；失败不写缓存。
 * @param {string} key
 * @param {() => Promise<object>|object} load
 * @param {number} [nowMs]
 */
function cachedModels(key, load, nowMs) {
  const at = Number(nowMs) || Date.now()
  const hit = modelsCache.get(key)
  if (hit && at - hit.at < MODELS_TTL_MS) return hit.value
  return Promise.resolve().then(load).then((v) => {
    if (isUsableProbe(v)) modelsCache.set(key, { at, value: v })
    return v
  })
}

/**
 * 只读缓存（settings.meta 专用）：纯读、不 spawn、不联网。
 * 与 cachedModels 的区别：这里**不受 TTL 限制** —— 面板展示的是「上次真正拉取到的那份
 * 服务端清单」，附 ageMs 让 note 如实标注新旧；空/过期与否都不该凭空清空用户看到的下拉。
 *
 * 为什么要「精确键未命中 → 取最近一次成功结果」：keystone 渲染面板时只把 env 传给
 * meta()，**拿不到面板里保存的 binPath**（settingsView 里 createProvider 只带 env），
 * 而缓存键含候选 exe 集合 → 用户一旦填过 binPath，精确键必然错开，下拉会在拉取成功后
 * 仍然空着（看起来像按钮没起作用）。这不算降级：清单是 claude 自己 settings.json 里
 * 端点+凭据裁决的，与走哪个候选 exe 无关（exe 只决定探测能否跑起来），且 note 会带上
 * 「N 分钟前拉取 / 源 account-live」，用户看到的是真实的探测结果与真实的年龄。
 * @param {object} env
 * @param {{binPath?: string, nowMs?: number}} [opts]
 * @returns {{ids: string[], mode: string, exe: (string|null), at: number, ageMs: number}|null}
 */
function readCachedModels(env, opts) {
  const o = opts || {}
  const at = Number(o.nowMs) || Date.now()
  const exact = modelsCache.get(modelsCacheKey(env, o.binPath))
  let hit = isUsableProbe(exact && exact.value) ? exact : null
  if (!hit) {
    for (const entry of modelsCache.values()) {
      if (!isUsableProbe(entry.value)) continue
      if (!hit || entry.at > hit.at) hit = entry
    }
  }
  if (!hit) return null
  return {
    ids: hit.value.ids.slice(),
    mode: hit.value.mode || 'account-live',
    exe: hit.value.exe || null,
    at: hit.at,
    ageMs: Math.max(0, at - hit.at)
  }
}

/**
 * 从 400 报文里解析「服务端支持的模型名」。
 * 主格式（实测）：`The supported API model names are A, B, but you passed Z.`
 * 兼容：句尾直接是句号（无 "but you passed"）、JSON 转义形态、大小写差异。
 * @param {string} text
 * @returns {string[]|null} 无该锚点返回 null（调用方必须据此报错，不得伪造清单）
 */
function parseSupportedModels(text) {
  const s = String(text || '')
  if (!s) return null
  const anchorRe = /the supported API model names are\s+/i
  const m = anchorRe.exec(s)
  if (!m) return null
  const tail = s.slice(m.index + m[0].length)
  // ① 有 "but you passed" → 这是清单的确定右边界（模型名里可以有 '.'，不能按句点切）。
  let body = ''
  const end = /,?\s*but you passed/i.exec(tail)
  if (end) body = tail.slice(0, end.index)
  else {
    // ② 无右边界锚点：截到引号/换行/行尾，再 chomp 单个句点。
    const stop = tail.search(/["\r\n]/)
    body = (stop >= 0 ? tail.slice(0, stop) : tail).replace(/[.\s]+$/, '')
  }
  const ids = []
  for (const raw of body.split(/\s*,\s*|\s+and\s+/i)) {
    const id = String(raw || '').trim().replace(/^["'`[]+|["'`\]]+$/g, '')
    if (!id) continue
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/.test(id)) continue
    if (id === PROBE_MODEL) continue
    if (ids.indexOf(id) < 0) ids.push(id)
  }
  return ids.length ? ids : null
}

/**
 * 从探测进程的完整输出里挖出模型清单。
 * CLI 的 stdout 是 result 事件 JSON（is_error:true）；它的 result 字段里才是 400 报文，
 * 且报文自身是 JSON 字符串（转义）。顺序：raw 文本 → 每行 JSON 的 result 字段。
 * @param {string} stdoutText
 * @param {string} [stderrText]
 * @returns {{ids: string[]|null, errorText: string, sawResult: boolean}}
 */
function extractProbeIds(stdoutText, stderrText) {
  const out = String(stdoutText || '')
  const err = String(stderrText || '')
  const lines = out.split(/\r?\n/).filter(Boolean)
  let errorText = ''
  let sawResult = false
  for (const ln of lines) {
    const t = ln.trim()
    if (!t.startsWith('{')) continue
    let obj
    try { obj = JSON.parse(t) } catch (e) { continue }
    if (!obj || obj.type !== 'result') continue
    sawResult = true
    if (typeof obj.result === 'string' && obj.result) errorText = obj.result
    else if (obj.is_error && typeof obj.error === 'string') errorText = obj.error
  }
  if (!errorText) errorText = err || out
  const ids = parseSupportedModels(errorText) || parseSupportedModels(out) || parseSupportedModels(err)
  return { ids: ids || null, errorText: errorText.slice(0, 800), sawResult }
}

/** ~/.claude/settings.json 路径（CLAUDE_CONFIG_DIR 可覆盖配置根，本机实测存在）。 */
function claudeConfigDir(env) {
  const e = env || {}
  if (e.CLAUDE_CONFIG_DIR) return String(e.CLAUDE_CONFIG_DIR)
  const home = e.USERPROFILE || e.HOME || ''
  if (!home) return ''
  const path = (function () { try { const p = globalThis.process; return (p && typeof p.getBuiltinModule === 'function') ? p.getBuiltinModule('node:path') : null } catch (x) { return null } })()
  if (!path || typeof path.join !== 'function') return ''
  return path.join(home, '.claude')
}

/**
 * 读 ~/.claude/settings.json 的 env 块里「用户配置的模型名」。
 * ⚠️ 这是别名映射（ANTHROPIC_DEFAULT_OPUS_MODEL 之类），**不是**服务端可用全集：
 * 只作为诊断/解释线索返回，绝不塞进 ok:true 的模型清单。
 * @returns {{ok: boolean, path: string, models: Array<{id: string, key: string}>, error: string}}
 */
function readConfiguredModels(env) {
  const dir = claudeConfigDir(env)
  if (!dir) return { ok: false, path: '', models: [], error: 'cannot resolve home directory (no USERPROFILE/HOME/CLAUDE_CONFIG_DIR)' }
  const fs = (function () { try { const p = globalThis.process; return (p && typeof p.getBuiltinModule === 'function') ? p.getBuiltinModule('node:fs') : null } catch (x) { return null } })()
  const path = (function () { try { const p = globalThis.process; return (p && typeof p.getBuiltinModule === 'function') ? p.getBuiltinModule('node:path') : null } catch (x) { return null } })()
  if (!fs || !path) return { ok: false, path: '', models: [], error: 'no fs capability in this host form' }
  const file = path.join(dir, 'settings.json')
  let raw
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    return { ok: false, path: file, models: [], error: 'cannot read ' + file + ': ' + String(e && e.message || e) }
  }
  const envBlock = raw && raw.env && typeof raw.env === 'object' ? raw.env : {}
  const models = []
  const seen = Object.create(null)
  for (const key of Object.keys(envBlock)) {
    if (!/^(ANTHROPIC_(MODEL|DEFAULT_[A-Z]+_MODEL|DEFAULT_[A-Z]+_MODEL_NAME|SMALL_FAST_MODEL))$/i.test(key)) continue
    const v = envBlock[key]
    if (typeof v !== 'string' || !v.trim()) continue
    const id = v.trim()
    if (seen[id]) continue
    seen[id] = true
    models.push({ id, key })
  }
  return { ok: true, path: file, models, error: '' }
}

/** 探测 argv（不含 exe 前缀）：固定参数集，绝不拼装用户 prompt。 */
/**
 * 探测用的 argv。`baseUrl` 非空时用 `--settings` 覆盖 ANTHROPIC_BASE_URL ——
 * 这是 cc-switch proxy 模式唯一可行的访问方式（直连第三方网关缺 session 头必 400）。
 * 只覆盖 base_url，不碰用户的 ~/.claude/settings.json。
 */
function probeArgv(baseUrl) {
  const argv = ['-p', 'hi', '--model', PROBE_MODEL, '--output-format', 'json', '--no-session-persistence']
  if (baseUrl) argv.push('--settings', JSON.stringify({ env: { ANTHROPIC_BASE_URL: String(baseUrl) } }))
  return argv
}

/** 探测失败时的可操作文案（区分「没找到 CLI」与「CLI 跑了但服务端没报清单」）。 */
function probeFailureText(reasons, tried) {
  const head = '无法获取服务端权威模型清单（已尝试探测 ' + tried + ' 个候选可执行文件）'
  const body = reasons.join('; ')
  return head + (body ? ': ' + body : '') +
    '。请确认 claude CLI 已安装且端点/凭据可用（claude 在 ~/.claude/settings.json 的 env 里读 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN），或在设置面板填写正确的可执行文件路径后重试。'
}

/**
 * 异步探测（唯一探测实现：MCP / preset / dynamic 三形态 + 面板「拉取可用模型」共用）：
 * 起一次真实 CLI 调用，解析 400 报文。
 * 铁律：只认探测结果；失败 = ok:false + 可操作错误，绝不回落到配置文件/静态表。
 * @param {object} env
 * @param {{binPath?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, ids: string[], mode: string, exe?: string, error?: string}>}
 */
function probeSupportedModels(env, opts) {
  const o = opts || {}
  const child = (function () { try { const p = globalThis.process; return (p && typeof p.getBuiltinModule === 'function') ? p.getBuiltinModule('node:child_process') : null } catch (x) { return null } })()
  if (!child || typeof child.spawn !== 'function') {
    return Promise.resolve({ ok: false, ids: [], mode: 'account-live', error: 'no spawn capability in this host form' })
  }
  const cands = claudeProbeCandidates(env, o.binPath)
  const probeList = cands.length ? cands : ['claude']
  const proc = globalThis.process
  const env2 = Object.assign({}, (proc && proc.env) || {})
  return new Promise((resolve) => {
    let idx = 0
    const reasons = []
    const attempt = () => {
      if (idx >= probeList.length) {
        resolve({ ok: false, ids: [], mode: 'account-live', error: probeFailureText(reasons, probeList.length) })
        return
      }
      const exe = probeList[idx++]
      const spec = splitExeSpec(exe)
      const argv = spec.prefixArgs.concat(probeArgv(o.baseUrl))
      let c
      try {
        const spawnCmd = spec.shell ? [spec.cmd].concat(argv).map(quoteShellArg).join(' ') : spec.cmd
        c = child.spawn(spawnCmd, spec.shell ? [] : argv, {
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: !!spec.shell, env: env2
        })
      } catch (e) { reasons.push(exe + ': spawn threw ' + String(e && e.message || e)); attempt(); return }
      let out = ''
      let err = ''
      const timer = setTimeout(() => { try { c.kill() } catch (e) { } }, Math.max(5000, Math.min(Number(o.timeoutMs) || 30000, 90000)))
      // 一个候选只允许结算一次：spawn 失败时 'error' 与 'close' 会先后都触发，
      // 两个回调各调一次 attempt() 会把后面的候选整个跳过（idx 多走一格）——
      // 实测后果是「binPath 填错 → 明明 CLAUDE_BIN 里那个能跑，探测却直接失败」。
      let settled = false
      const nextCandidate = (reason) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (reason) reasons.push(reason)
        attempt()
      }
      c.stdout.on('data', (d) => { out += d; if (out.length > 400000) out = out.slice(-200000) })
      c.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000) })
      c.on('error', (e) => {
        nextCandidate(exe + ': ' + String((e && e.code) || (e && e.message) || 'spawn error'))
      })
      c.on('close', (code) => {
        if (settled) return
        const got = extractProbeIds(out, err)
        if (got.ids && got.ids.length) {
          settled = true
          clearTimeout(timer)
          resolve({ ok: true, ids: got.ids, mode: 'account-live', exe })
          return
        }
        const head = String(got.errorText || '').replace(/\s+/g, ' ').trim().slice(0, 160)
        nextCandidate(exe + ': exit ' + code + '，未解析出可用模型清单' + (head ? ' — ' + head : ''))
      })
    }
    attempt()
  })
}

/**
 * 组装 claude_models 的返回值（三形态共用；工具逻辑与 MCP 面共用这一份，杜绝两处漂移）。
 * 成功 = 服务端清单（source: account-live）；失败 = ok:false + configured 诊断线索
 * （配置里那串名字只作「你可能想用哪个」的提示，明确标注非权威）。
 * @param {object} env
 * @param {{binPath?: string, timeoutMs?: number, refresh?: boolean}} [opts]
 */
/**
 * 列出可用模型 —— **合并两个来源**，而不是只认服务端报文。
 *
 * 为什么必须合并（真实事故）：服务端「无效模型触发 400」只回吐**基础模型名**。
 * 实测 DeepSeek 的 Anthropic 兼容端点报 `deepseek-flash, deepseek-v4-pro`，
 * 但用户实际配置在用的 `deepseek-v4-pro[1M]` / `deepseek-v4-flash` 逐个实测都是 200 ——
 * 它们只是带上下文窗口后缀/命名变体，服务端报文不列。若只信报文，用户会看到一份
 * 「比我配的还少」的清单，等于给错答案。
 *
 * 因此：configured（`~/.claude/settings.json` 的 env，cc-switch 等工具写入的**最终生效**
 * 配置）+ account-live（服务端报文）取并集，逐项标注来源；configured 排在前面。
 *
 * 且 configured **不依赖探测成功** —— 端点若根本不支持 400 技巧（如某些代理对任何
 * 模型都先校验 session），我们仍能把用户配置的模型给出来，而不是返回空。
 */
async function listAccountModels(env, opts) {
  const o = opts || {}
  const key = modelsCacheKey(env, o.binPath)
  if (o.refresh) modelsCache.delete(key)
  const probe = await cachedModels(key, () => probeSupportedModels(env, o))
  const cfg = readConfiguredModels(env)
  const configured = cfg.models || []

  // 大小写不敏感 + 忽略 [1m]/[1M] 这类后缀后做去重键，避免同一模型重复占两行。
  const dk = (id) => String(id).trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
  const seen = new Set()
  const models = []
  for (const m of configured) {
    const k = dk(m.id)
    if (seen.has(k)) continue
    seen.add(k)
    models.push({ id: m.id, source: 'configured', configuredAs: m.key })
  }
  const probeIds = probe && probe.ok ? (probe.ids || []) : []
  for (const id of probeIds) {
    const k = dk(id)
    if (seen.has(k)) continue
    seen.add(k)
    models.push({ id, source: 'account-live', configuredAs: null })
  }

  if (!models.length) {
    return {
      ok: false, source: 'none', models: [], count: 0,
      error: String((probe && probe.error) || 'no configured models and probe returned nothing') +
        (cfg.error ? '；settings.json: ' + cfg.error : ''),
      diagnostic: { configured, settingsPath: cfg.path, probeError: (probe && probe.error) || null }
    }
  }
  // source 汇总：两个来源都有效时标注合并，便于面板/工具如实显示。
  const source = (configured.length && probeIds.length) ? 'configured+account-live'
    : (configured.length ? 'configured' : 'account-live')
  return {
    ok: true,
    source,
    models,
    count: models.length,
    ext: { exe: (probe && probe.exe) || null, mode: (probe && probe.mode) || null },
    diagnostic: {
      settingsPath: cfg.path,
      configured,
      probeError: (probe && !probe.ok) ? String(probe.error || 'probe failed') : null
    }
  }
}

// ── inlined from providers/claude-policy.mjs ──
// providers/claude-policy.mjs — claude 提示词策略段（preset 与 dynamic 两种宿主唯一来源）。
//
// 为什么单独成片：同一段策略文本要在 preset/claude-first/cli-bridge.mjs（ESM 导入）与
// dynamic/claude.host.template.mjs（沙箱内联，禁 import）两处出现；各写一份必然漂移
// （历史上 agy/opencode 两处文案已经出现过不一致）。本文件被 scripts/build.mjs 作为
// providers/claude-*.mjs 之一内联进沙箱同一作用域，故两形态共用同一个常量。
// ⚠️ 注释里绝不写出口令标记字面量（build 全局替换会把注释劈开）。

const POLICY_TEXT = [
  'claude-first execution policy (local Claude Code CLI bridge).',
  '',
  'Local agent CLI "claude" handles coding tasks under full DSH control (non-interactive -p mode, permissions auto-approved so claude never blocks on a prompt). By default, claude runs in the background and returns a jobId immediately; collect results via job_output and watch live progress via claude_status anytime.',
  '',
  'Decision table for tool selection:',
  '- Single read/glob/grep or short (<30s) command -> Native tools.',
  '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> claude_run.',
  '- Follow-ups on the same topic -> claude_continue (with latest=true or sessionId; claude preserves session context via --resume).',
  '- Final build/test verification of claude output -> Native tools.',
  '',
  'Context protocol (one topic = one claude session):',
  '- First dispatch on a topic: provide the task with a compact CONTEXT preamble (point to paths, do not paste file contents):',
  '  CONTEXT: 2-6 lines — goal; repo root; key paths; decisions/constraints; current state.',
  '  TASK: the complete instruction.',
  '- Follow-ups: call claude_continue and state only what is new.',
  '',
  'Execution & Fallback protocol:',
  '- Dispatch defaults to background=true (set background=false only to block). Collect via job_output.',
  '- mode=auto follows the DSH plan state: in plan mode claude runs with --permission-mode plan (read-only), otherwise permissions are bypassed so long edits/builds never stall on an approval prompt.',
  '- On rate-limit or network failure, a confirmation dialog opens in BOTH foreground and background while in flight.',
  '- If result has fallback=true (status FALLBACK_TO_DSH), the user chose DSH-local: finish with native tools and NEVER call claude again for this task.',
  '- Never loop claude calls; never ask claude to call back into DSH.',
  '',
  'Model & credentials:',
  '- Which model ids actually work is decided by the ENDPOINT, not by this bridge: call claude_models to read the authoritative server-side roster (it probes the endpoint), then pass model. Never trust ANTHROPIC_*_MODEL entries in ~/.claude/settings.json as the usable set — they are alias mappings only.',
  '- Omit the model unless you have a reason: claude then uses its own configuration (or the model chosen in CLI Bridge settings). A rejected model surfaces as a run failure with the supported list in the diagnostic hint — fix the model, do not retry blindly.',
  '- Credentials are owned by claude, not by this bridge: base URL and auth token live in ~/.claude/settings.json (env block). On auth/401 failures tell the user to check that file or re-login; do not retry in a loop.'
].join('\n')

// core/scheduling.mjs — CLI 调度（启用集合 + 调用优先级）单源纯逻辑。
//
// 语义（用户可见的两件事）：
//   • enabled  = 勾选启用哪些 CLI（数量随之而定）；未启用的一面不注册工具、不进提示词。
//   • priority = 智能体调用 CLI 的建议顺序，数组顺序即优先级（首位最高）。
//
// 落盘位置：统一设置文件 {DSH_HOME}/cli-bridge-settings.json 的顶层 `_scheduling` 区。
// 下划线前缀 = 非 provider 分区（registry 的 PROVIDER_IDS 永远不含它，逐分区语义不受影响），
// 因此新代码写出的文件被旧包读取时整区被忽略 = 纯增量，向后兼容。
//
// 缺省语义（文件缺失/无该区）：全部 provider 启用、按注册表顺序 —— 与调度特性上线前
// 的行为逐字一致（读不到配置永远不等于关掉所有桥）。
//
// 沙箱纪律：与 bridge-kit 同源约束 —— 不得 import；Node 内建一律经
// globalThis.process.getBuiltinModule + typeof 守卫（动态宿主沙箱可能没有 fs，
// 那种环境读不到文件 → 走缺省全开，绝不炸 apply）。

/** 设置文件里调度区的键名（下划线前缀避开 provider id 命名空间）。 */
const SCHEDULING_SECTION = '_scheduling'

/** 人类可读的默认注册顺序（调用建议顺序）；enabled 缺省 = 全部启用。 */
function defaultPriority(ids) {
  return (Array.isArray(ids) ? ids : []).slice()
}

/**
 * 清洗任意来源的调度对象。
 * @param {unknown} raw  文件/POST 里的原始值（可能是任何东西，全部容错）
 * @param {string[]} ids 全量 provider id（顺序 = 缺省优先级）
 * @param {(id: string) => string} [labelOf] 展示名（仅用于诊断文本，不参与判定）
 */
function normalizeScheduling(raw, ids, labelOf) {
  const all = Array.isArray(ids) ? ids.slice() : []
  const label = typeof labelOf === 'function' ? labelOf : ((id) => String(id))
  const enabled = all.slice()
  let priority = all.slice()
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (Array.isArray(raw.enabled)) {
      const seen = Object.create(null)
      const picked = []
      for (const x of raw.enabled) {
        const id = String(x == null ? '' : x)
        if (!id || all.indexOf(id) < 0 || seen[id]) continue
        seen[id] = true; picked.push(id)
      }
      // 空数组 = 用户真的想把全部关掉（而不是「没配」），保留该语义；
      // 非空但过滤后为空 = 写的全是未知 id（坏值）→ 回落全开（fail-open，
      // 绝不让一次手滑/陈旧配置把所有桥关掉）。
      if (raw.enabled.length === 0 || picked.length > 0) {
        enabled.length = 0
        Array.prototype.push.apply(enabled, picked)
      }
    }
    if (Array.isArray(raw.priority)) {
      const seen2 = Object.create(null)
      const ordered = []
      for (const x of raw.priority) {
        const id = String(x == null ? '' : x)
        if (!id || all.indexOf(id) < 0 || seen2[id]) continue
        seen2[id] = true; ordered.push(id)
      }
      for (const id of all) if (!seen2[id]) ordered.push(id) // 漏写的排在末尾
      if (ordered.length) priority = ordered
    }
  }
  const order = priority.filter((id) => enabled.indexOf(id) >= 0)
  for (const id of enabled) if (order.indexOf(id) < 0) order.push(id)
  return { enabled, priority, order }
}

/** 展示文本：「CB → MIMO」或「全部启用 · CB → AGY → MIMO」。 */
function describeScheduling(s, labelOf) {
  const st = s || {}
  const label = typeof labelOf === 'function' ? labelOf : ((id) => String(id))
  const order = Array.isArray(st.order) ? st.order : []
  const names = order.map(label).join(' → ')
  return names ? names : '（全部禁用）'
}

// ── 读盘（四形态共用；无 fs 时安全返回 null）────────────────────────────────────
// 名字带 sched 前缀：本文件会与 bridge-kit / provider 描述符【文本内联进同一个动态
// 沙箱脚本作用域】（providers/codebuddy.mjs 已有 builtinModule），撞名即隐患。
function schedBuiltinModule(name) {
  try {
    const proc = globalThis.process
    return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule(name) : null
  } catch (e) { return null }
}

function schedulingSettingsPath(env) {
  const e = env || (globalThis.process && globalThis.process.env) || {}
  try {
    if (e.CLI_BRIDGE_SETTINGS_FILE) return String(e.CLI_BRIDGE_SETTINGS_FILE)
    const nodePath = schedBuiltinModule('node:path')
    if (nodePath && e.DSH_HOME) return nodePath.join(String(e.DSH_HOME), 'cli-bridge-settings.json')
  } catch (e2) { }
  return null
}

/**
 * 生效调度：文件 _scheduling > 缺省全开。
 * env/argv CLI_BRIDGE_PROVIDER（单面钉住，旧薄封装兼容语义）存在时视为最高优先 ——
 * 它代表「这个 MCP 进程只为这一家而启动」（部署者的显式意志，比面板勾选更具体、
 * 更靠近进程生命周期），调度不再削减它。
 * 宿主形态（preset / dynamic 桥接插件）应传 ignorePin：钉住只是 MCP 进程的启动参数，
 * 不该让全局 env 反过来把用户会话里的其他桥关掉。
 * @param {string[]} ids 全量 provider id
 * @param {{ env?: Record<string,string>, readFileSync?: Function, path?: string|null, ignorePin?: boolean }} [io]
 */
function resolveScheduling(ids, io) {
  const o = io || {}
  const env = o.env || (globalThis.process && globalThis.process.env) || {}
  let raw = null
  try {
    const p = ('path' in o) ? o.path : schedulingSettingsPath(env)
    const nodeFs = o.readFileSync ? { readFileSync: o.readFileSync } : schedBuiltinModule('node:fs')
    if (p && nodeFs && typeof nodeFs.readFileSync === 'function') {
      raw = JSON.parse(nodeFs.readFileSync(p, 'utf8'))
    }
  } catch (e) { raw = null }
  const file = normalizeScheduling(raw && typeof raw === 'object' ? raw[SCHEDULING_SECTION] : null, ids)
  const pinned = o.ignorePin ? '' : String(env.CLI_BRIDGE_PROVIDER || '').trim()
  if (pinned && ids.indexOf(pinned) >= 0) {
    return Object.assign(file, {
      enabled: [pinned],
      order: [pinned],
      pinned: pinned,
      source: raw ? 'env:CLI_BRIDGE_PROVIDER+file' : 'env:CLI_BRIDGE_PROVIDER'
    })
  }
  return Object.assign(file, { pinned: '', source: raw ? 'file' : 'default' })
}

/**
 * 桥接面门禁（preset / dynamic 的 apply() 首行用）：本 provider 是否被调度启用。
 * fail-open —— 任何异常（无 fs、文件损坏、沙箱限制）都返回 true：读不到配置永远
 * 不等于关掉桥（否则一次文件损坏就把三条 CLI 全灭了）。ignorePin 固定 true：
 * 钉住语义属于 MCP 独立进程，宿主形态的全局 env 不该反向影响用户会话。
 */
function isBridgeEnabled(selfId, ids, io) {
  try {
    const list = Array.isArray(ids) ? ids : []
    // 全量清单本身不可得（空/不含自己）= 无门禁语义，fail-open。
    if (!list.length || list.indexOf(String(selfId)) < 0) return true
    const o = Object.assign({ ignorePin: true }, io || {})
    return resolveScheduling(list, o).enabled.indexOf(String(selfId)) >= 0
  } catch (e) { return true }
}


const SCHED_ALL_IDS = ["agy","codebuddy","mimo","opencode","claude","codex"]


return {
  inject: ['tools', 'subprocess', 'systemPrompt', 'timer'],
  apply(ctx) {
    // 调度门禁：设置面板关掉 claude → 本形态不注册工具/政策段；fail-open。
    if (!isBridgeEnabled('claude', SCHED_ALL_IDS)) return
    const subprocess = ctx.subprocess
    const sandboxPolicy = ctx.get('sandboxPolicy')
    // 沙箱可能运行在无 process 的环境：typeof 守卫读 env（旧仓 dynamic 的等价面）。
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}

    const provider = defineProvider({ env })

    function publish(snapshot) {
      try {
        const collector = ctx.get('cliBridgeCollector')
        if (collector && typeof collector.mergeSnapshot === 'function') { collector.mergeSnapshot('claude', snapshot); return }
      } catch (e) { /* fall through to legacy alias */ }
      try {
        const legacy = ctx.get('claudeCollector')
        if (legacy && typeof legacy.mergeSnapshot === 'function') legacy.mergeSnapshot(snapshot)
      } catch (e) { /* 灯数据尽力而为 */ }
    }

    // exe 优先级（与描述符同一套）：env CLAUDE_BIN/CLAUDE_CLI/CLAUDE_CODE_BIN > 已知本地安装
    // > PATH 名 claude（subprocess.resolveExecutable 兜底）。动态沙箱拿不到设置面板值。
    const exeCandidates = claudeExeCandidates(env, '')
    async function resolveExe(backend, signal) {
      for (const c of exeCandidates) {
        if (!c) continue
        if (/\.(mjs|cjs|js)$/i.test(c) && typeof process !== 'undefined' && process.execPath) return [process.execPath, c]
        return c
      }
      return await subprocess.resolveExecutable('claude', undefined, signal)
    }

    // cwd 兜底：CLAUDE_MCP_CWD > sandboxPolicy.workspaceRoot > process.cwd() > '.'。
    function getCwdFallback() {
      if (env.CLAUDE_MCP_CWD) return String(env.CLAUDE_MCP_CWD)
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
      if (typeof process !== 'undefined' && typeof process.cwd === 'function') { try { return process.cwd() } catch (e) {} }
      return '.'
    }

    provider.attach({ ctx, subprocess, resolveExe, getCwdFallback, publish })

    const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

    harness.registerTool(ctx, harness.defineTool({
      name: provider.tools.run.name,
      description: provider.tools.run.description,
      parameters: provider.tools.run.inputSchema,
      output: { schema: OUTPUT_SCHEMA, render: function (args, value) { return renderResult(value, provider) } },
      execute: function (args, exec) { return provider.runToolLogic(args, exec) }
    }))
    harness.registerTool(ctx, harness.defineTool({
      name: provider.tools.continue.name,
      description: provider.tools.continue.description,
      parameters: provider.tools.continue.inputSchema,
      output: { schema: OUTPUT_SCHEMA, render: function (args, value) { return renderResult(value, provider) } },
      execute: function (args, exec) { return provider.continueToolLogic(args, exec) }
    }))
    harness.registerTool(ctx, harness.defineTool({
      name: provider.tools.status.name,
      description: provider.tools.status.description,
      parameters: provider.tools.status.inputSchema,
      output: { schema: OUTPUT_SCHEMA, render: function (args, value) { return renderStatus(value, provider) } },
      execute: function (args) { return provider.statusToolLogic(args) }
    }))
    // 附加工具（claude_models）：render 适配 harness 契约 render(args, value)。
    for (const et of (provider.extraTools || [])) {
      harness.registerTool(ctx, harness.defineTool({
        name: et.name,
        description: et.description,
        parameters: et.inputSchema,
        output: { schema: OUTPUT_SCHEMA, render: function (args, value) { return et.render ? et.render(args, value) : renderResult(value, provider) } },
        execute: function (args, exec) { return et.logic(args, exec) }
      }))
    }

    // 浏览器指示灯轮询的 RPC 面（旧 dynamic handle('<id>_status') verbatim 语义）。
    harness.handle('claude_status', function () { return provider.statusToolLogic({}) })

    ctx.systemPrompt.section({
      name: 'claude:policy',
      order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
      text: POLICY_TEXT
    })
  }
}
