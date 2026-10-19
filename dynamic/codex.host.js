// dynamic/codex.host.template.mjs — codex 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=codex）把 core/bridge-kit.mjs、providers/codex.mjs、
// providers/codex-*.mjs 片文件、core/scheduling.mjs 分别内联进下方四个占位标记行
// （各占一行、行内仅此标记），生成 dynamic/codex.host.js。
// 注意：标记字面量绝不能出现在本文件注释里 —— 构建做全局文本替换，注释中出现同样会被
// 替换成正文代码而炸掉语法（历史事故）。
//
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生
//    定时器 —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层
//    return 合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('codex', snap)
//    推给家级灯；动态形态不宣告 mode（普通模式灯仅在调用时临时显示）。
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

// providers/codex.mjs — codex provider descriptor（第五家 CLI，无旧包可迁）。
//
// 基线 = 本机实测 codex-cli 0.98.0（Windows，mise/cherrystudio shim）+ 真实 argv/事件流。
// 写代码时最容易踩的几条（全部实机验证过，见 docs 里 codex 任务卡）：
//   • 非交互 = `codex exec [OPTIONS] "PROMPT"`，prompt 是**位置参数**，必须放最后。
//   • ⚠️ `codex exec` **不接受** `-a/--ask-for-approval`（clap 直接报 unexpected argument；
//     那是根命令 `codex` 的旗）。要设审批策略只能走 `-c approval_policy="never"`。
//   • ⚠️ `codex exec resume` 只认 [SESSION_ID] [PROMPT] + -c/-m/-i/--json/--last/--all/
//     --skip-git-repo-check/--full-auto；**没有 -C、没有 -s、没有 -o、没有 --add-dir**
//     （实测传 -C 报 unexpected argument）。续聊的 cwd 只能靠 spawn 的 cwd。
//   • 非 git 目录必须带 --skip-git-repo-check，否则直接拒绝运行。
//   • `--json` → NDJSON 事件流：thread.started / turn.started / item.started /
//     item.completed / turn.completed；失败另加顶层 `error` + `turn.failed`。
//     ⚠️ item.completed 里也可能出现 item.type==="error" 的**告警**（如「此会话原模型与
//     当前模型不同」），那是正常续聊的提示，绝不可当成致命错误（实测 --last 续聊就带）。
//   • 退出码：0 成功 / 1 运行失败（stdout 仍是合法 JSON）/ 2 参数错误。
//   • 无 --json 时 stdout 就是纯文本答复，stderr 有元信息头（version/workdir/model/
//     provider/approval/sandbox/session id）—— 诊断只读它，不解析成结果。
//
// 红线（PROVIDER-CONTRACT.md §1/§8）：
//  - 本文件会被 build 内联进 dynamic 沙箱（new Function）：绝不出现 import.meta 字面量；
//    process 只经 typeof 守卫读取；宿主能力全部走 deps/attach(hostOpts)。
//  - 只允许 import '../core/bridge-kit.mjs' 与同目录 codex-*.mjs 片文件（片文件由 build
//    自动内联进同一作用域；主文件超 600 行红线所以必须拆）。
// import { createStatusEngine, createRunner, clampInt, isLimited, endpointHost } from '../core/bridge-kit.mjs'
// import { codexSetHost, codexResolveExePrefix, codexExeCandidates, codexReadConfig, codexModelsEndpoint, codexCachedModelOptions, codexCachedLiveModels, codexLiveModels, codexCatalogModels, codexBuiltinModels, codexHomeDir } from './codex-cli.mjs'
// import { codexModelsTool } from './codex-models.mjs'

function nowIso() { return new Date().toISOString() }

// 实测枚举（根命令 help + exec help）。
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']
const APPROVAL_POLICIES = ['untrusted', 'on-failure', 'on-request', 'never']
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh']

// 手动拉取（契约 §3.2）：面板只把 error 原文显示给用户，所以失败文案必须自带下一步。
// codex-cli 没有 models 子命令，live 清单只能走端点 HTTP —— 排查顺序就围绕端点/凭据写。
const REFRESH_TIMEOUT_MS = 20000
const REFRESH_HINT = '排查顺序：① 看 ~/.codex/config.toml 的 [model_providers.<当前 provider>] 里 base_url / experimental_bearer_token（或 auth.json 的 OPENAI_BASE_URL / OPENAI_API_KEY）是否指向可用端点；② 可用 CODEX_BRIDGE_MODELS_URL / CODEX_BRIDGE_MODELS_TOKEN 临时覆盖端点与凭据；③ 再点一次「拉取可用模型」（codex_models 默认 source=live 读的是同一份清单）。'

// ── 三工具 schema ────────────────────────────────────────────────────────────
const RUN_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The task instruction for codex. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — codex reads the repo itself). For follow-ups on the same topic, use codex_continue with latest=true or sessionId (codex keeps the thread context; state only what is new).' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'auto follows the DSH plan state; plan = read-only sandbox (no writes), accept-edits = workspace-write. Default auto. An explicit sandboxMode overrides this.' },
    model: { type: 'string', description: 'Optional codex model id (e.g. "minimax/minimax-m3.1-flash:free"). Omit to use the CLI Bridge settings default, or codex\'s own ~/.codex/config.toml model. Run codex_models first; the server rejects unknown ids with HTTP 400.' },
    sandboxMode: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Optional codex sandbox policy (-s). Overrides the mode-derived default and the settings panel value.' },
    reasoningEffort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh'], description: 'Optional model_reasoning_effort override (-c model_reasoning_effort="…"). Ignored by models that do not support it.' },
    cwd: { type: 'string', description: 'Working directory for codex (-C, and the spawn cwd). Defaults to the DSH workspace root.' },
    addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra writable directories (--add-dir). Ignored on resume (codex exec resume has no --add-dir).' },
    images: { type: 'array', items: { type: 'string' }, description: 'Image files to attach to the prompt (-i).' },
    timeoutSec: { type: 'integer', description: 'Execution timeout seconds (10-3600, default 900).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with codex_status. Set false to block for the final answer.' }
  }
}
const CONTINUE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing codex thread. State only what is new; codex preserves the thread context.' },
    sessionId: { type: 'string', description: 'codex thread id to resume (the thread_id from a prior codex_run result).' },
    latest: { type: 'boolean', description: 'Resume the most recent codex thread in this working directory (exec resume --last) instead of a specific id.' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'Execution mode; default auto. On resume codex has no -s flag, so the sandbox is applied via -c sandbox_mode="…".' },
    model: { type: 'string', description: 'Optional codex model id.' },
    sandboxMode: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Optional sandbox policy applied through -c sandbox_mode="…" (resume has no -s).' },
    reasoningEffort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh'], description: 'Optional model_reasoning_effort override.' },
    cwd: { type: 'string', description: 'Working directory (spawn cwd only — resume has no -C).' },
    images: { type: 'array', items: { type: 'string' }, description: 'Image files to attach (-i).' },
    timeoutSec: { type: 'integer', description: 'Execution timeout seconds (10-3600, default 900).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with codex_status. Set false to block.' }
  }
}
const STATUS_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }

function defineProvider (deps = {}) {
  const env = deps.env || {}
  let host = null
  let settingsRef = { binPath: '', defaultModel: '', sandboxMode: '', approvalPolicy: '' }
  codexSetHost(env, deps.nodeFs || null, deps.nodePath || null)

  /**
   * 取当前生效的偏好设置（三条来源按优先级合并，每次 buildArgv 重读 —— 面板改默认
   * 模型后无需重启即生效）：
   *   1) deps.readSettings()：MCP 形态（真 Node，每次现读设置文件）；
   *   2) host.getSettings('codex')：preset/dynamic 形态（attach 注入）；
   *   3) settingsRef：attach 时固化的一次性快照 / 缺省值。
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
    } catch (e) { /* 设置读失败 = 用缺省，不影响本次调用 */ }
    try {
      if (host && typeof host.getSettings === 'function') {
        const s = host.getSettings('codex')
        if (s && typeof s === 'object') Object.assign(out, s)
      }
    } catch (e) { /* 同上 */ }
    return out
  }

  function sandboxFor(mode, args, settings) {
    if (args && args.sandboxMode && SANDBOX_MODES.indexOf(String(args.sandboxMode)) >= 0) return String(args.sandboxMode)
    if (settings && settings.sandboxMode && SANDBOX_MODES.indexOf(String(settings.sandboxMode)) >= 0) return String(settings.sandboxMode)
    return mode === 'plan' ? 'read-only' : 'workspace-write'
  }

  const descriptor = {
    id: 'codex', label: 'CODEX', presetId: 'codex-first', defaultBackend: null, defaultMode: 'auto',
    exeName: 'codex', binEnvVars: ['CODEX_BIN', 'CODEX_CLI'], unavailableStatus: 'CODEX_UNAVAILABLE',

    // 单后端：model_provider/base_url 属于 codex 自身配置，桥不引入第二后端概念。
    backends() { return null },
    normalizeBackend() { return null },
    resolveBackend(args, target, preferred) { return null },

    // 实测 flag 集（exec 与 exec resume 的可用旗不同 —— 见文件头）。
    buildArgv(exePrefix, args, opts) {
      const o = opts || {}
      const a = args || {}
      const settings = currentSettings()
      const argv = Array.isArray(exePrefix) ? exePrefix.slice() : [String(exePrefix)]
      const resume = !!(a.sessionId || a.continueLatest || a.latest === true)
      argv.push('exec')
      if (resume) {
        argv.push('resume')
        if (a.sessionId) argv.push(String(a.sessionId))
        else argv.push('--last')
      }
      // --json 是所有折叠/解析的前提；--skip-git-repo-check 让非 git 目录也能跑。
      argv.push('--json', '--skip-git-repo-check')
      // -C 只有 exec 有；resume 的 cwd 由 spawn 的 cwd 决定（实测 resume 传 -C 直接报错）。
      const cwd = a.cwd ? String(a.cwd) : null
      if (cwd && !resume) argv.push('-C', cwd)

      let mode = a.mode || 'auto'
      if (mode === 'auto') mode = o.planActive ? 'plan' : 'accept-edits'
      const sandbox = sandboxFor(mode, a, settings)
      if (resume) argv.push('-c', 'sandbox_mode="' + sandbox + '"')
      else argv.push('-s', sandbox)

      const approval = (settings && settings.approvalPolicy && APPROVAL_POLICIES.indexOf(String(settings.approvalPolicy)) >= 0)
        ? String(settings.approvalPolicy)
        : ''
      // exec 没有 -a/--ask-for-approval；等价效果只能经 -c 覆盖（TOML 字符串值）。
      if (approval) argv.push('-c', 'approval_policy="' + approval + '"')

      const model = a.model || o.defaultModel || settings.defaultModel || ''
      if (model) argv.push('-m', String(model))
      if (a.reasoningEffort && REASONING_EFFORTS.indexOf(String(a.reasoningEffort)) >= 0) {
        argv.push('-c', 'model_reasoning_effort="' + String(a.reasoningEffort) + '"')
      }
      if (!resume && Array.isArray(a.addDirs)) for (const d of a.addDirs) { if (d) argv.push('--add-dir', String(d)) }
      if (Array.isArray(a.images)) for (const f of a.images) { if (f) argv.push('-i', String(f)) }
      // prompt 必须最后（位置参数）。
      argv.push(String(a.prompt))
      const timeoutSec = clampInt(a.timeoutSec, 900, 10, 3600)
      return { argv, mode, timeoutSec }
    },

    // NDJSON（--json）。宽容：坏行跳过；无任何 JSON 行返回 null（交 buildResult 走纯文本）。
    // 终止判据 = turn.completed + 退出码 0；顶层 error / turn.failed 才算致命。
    // ⚠️ item.completed 里 item.type==="error" 只是告警（实测续聊会带），绝不致命。
    parseJson(stdoutText) {
      const trimmed = String(stdoutText || '').trim()
      if (!trimmed) return null
      let sawJson = false
      let threadId = null
      let response = ''
      let usage = null
      let completed = false
      let fatal = null
      let turns = 0
      for (const raw of trimmed.split(/\r?\n/)) {
        const ln = raw.trim()
        if (ln.charAt(0) !== '{') continue
        let ev
        try { ev = JSON.parse(ln) } catch (e) { continue }
        if (!ev || typeof ev !== 'object') continue
        sawJson = true
        const t = ev.type
        if (t === 'thread.started') {
          if (typeof ev.thread_id === 'string') threadId = ev.thread_id
        } else if (t === 'turn.started') {
          turns += 1
        } else if (t === 'turn.completed') {
          completed = true
          if (ev.usage && typeof ev.usage === 'object') usage = ev.usage
        } else if (t === 'turn.failed') {
          const msg = ev.error && typeof ev.error.message === 'string' ? ev.error.message
            : (typeof ev.error === 'string' ? ev.error : 'turn failed')
          fatal = { message: msg }
        } else if (t === 'error') {
          // 顶层 error 事件：message 常常是嵌套 JSON 字符串（实测）。
          fatal = { message: typeof ev.message === 'string' ? ev.message : 'error event' }
        } else if (t === 'item.completed' && ev.item && typeof ev.item === 'object') {
          if (ev.item.type === 'agent_message' && typeof ev.item.text === 'string') response = ev.item.text
        }
      }
      if (!sawJson) return null
      return {
        type: completed ? 'turn.completed' : (fatal ? 'turn.failed' : 'incomplete'),
        threadId: threadId || null,
        response: String(response || ''),
        usage: usage || null,
        completed: completed,
        error: fatal,
        numTurns: turns || null
      }
    },

    // 统一结果对象（契约 §1）。成功必须同时满足：退出码 0 + 收到 turn.completed +
    // 无顶层错误事件。只看退出码不够（实测 400 时 stdout 仍是合法事件流，退出码 1）。
    buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
      const exitCode = outcome ? outcome.exitCode : null
      const stderr = stderrText ? String(stderrText).slice(-2000) : ''
      const mk = (over) => Object.assign({
        ok: false, status: 'ERROR', response: '', sessionId: null, durationSeconds: null,
        numTurns: null, totalTokens: null, duration: null, exitCode, mode, backend: backend || null, stderr
      }, over)
      const usageOf = (u) => {
        if (!u || typeof u !== 'object') return null
        const i = Number(u.input_tokens) || 0
        const o = Number(u.output_tokens) || 0
        return (i + o) > 0 ? i + o : null
      }
      if (parsed && typeof parsed === 'object') {
        const sessionId = parsed.threadId || null
        const totalTokens = usageOf(parsed.usage)
        if (parsed.error) {
          const msg = String(parsed.error.message || 'turn failed')
          return mk({
            status: 'TURN_FAILED', response: parsed.response || '', sessionId,
            numTurns: parsed.numTurns, totalTokens, errorMessage: msg,
            stderr: (stderr ? stderr + ' ' : '') + msg
          })
        }
        if (exitCode === 0 && parsed.completed) {
          return {
            ok: true, status: 'SUCCESS', response: parsed.response || '', sessionId,
            durationSeconds: null, numTurns: parsed.numTurns || 1, totalTokens,
            exitCode, mode, backend: backend || null, stderr
          }
        }
        if (exitCode === 0) {
          return mk({
            status: 'INCOMPLETE', response: parsed.response || '', sessionId, totalTokens,
            numTurns: parsed.numTurns,
            stderr: (stderr ? stderr + ' ' : '') + 'codex event stream ended without turn.completed (process exited 0). The run may have been interrupted; retry, and check `codex --version` if it persists.'
          })
        }
        return mk({
          status: exitCode === 2 ? 'BAD_ARGS' : 'ERROR',
          response: parsed.response || '', sessionId, numTurns: parsed.numTurns, totalTokens,
          stderr: (stderr ? stderr + ' ' : '') + 'codex exited ' + exitCode
        })
      }
      const text = String(stdoutText || '').trim()
      if (exitCode === 0) {
        return {
          ok: true, status: 'SUCCESS', response: text, sessionId: null,
          durationSeconds: null, numTurns: null, totalTokens: null, exitCode, mode,
          backend: backend || null, stderr
        }
      }
      return mk({
        status: exitCode === 2 ? 'BAD_ARGS' : 'ERROR',
        response: '',
        stderr: stderr || ('codex exited ' + exitCode),
        rawStdout: text.slice(-2000)
      })
    },

    // 实时步骤折叠（写 project.current/trail）。事件形态见文件头。
    // item 类型实测：command_execution / reasoning / agent_message / error(告警) /
    // file_change / mcp_tool_call / web_search —— 未知类型也按通用形态记账，绝不吞事件。
    foldStreamEvent(ev, p, summarizeArgs, maxArgLen, maxTrail) {
      if (!ev || typeof ev !== 'object') return
      const t = ev.type
      if (!t) return
      p.updatedAt = Date.now()
      const cap = maxTrail || 12
      const capLen = maxArgLen || 120
      const pushTrail = (entry) => { p.trail.push(entry); if (p.trail.length > cap) p.trail.shift() }
      if (t === 'thread.started') {
        p.current = { tool: 'session', args: { thread_id: String(ev.thread_id || '').slice(0, capLen) }, stepIndex: p.trail.length, since: nowIso() }
        return
      }
      if (t === 'turn.completed' || t === 'turn.failed') { p.current = null; return }
      if (t === 'error') {
        pushTrail({ stepIndex: p.trail.length, state: 'ERROR', tool: 'error', args: { message: String(ev.message || '').slice(0, capLen) }, at: nowIso() })
        p.current = null
        return
      }
      if (t !== 'item.started' && t !== 'item.completed') return
      const item = ev.item && typeof ev.item === 'object' ? ev.item : null
      if (!item) return
      const kind = String(item.type || 'item')
      const failed = kind === 'error' || item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)
      const state = t === 'item.started' ? 'ACTIVE' : (failed ? 'ERROR' : 'DONE')
      let tool = kind
      let args = null
      if (kind === 'command_execution') {
        tool = 'command'
        args = summarizeArgs({ command: item.command })
      } else if (kind === 'agent_message') {
        tool = 'agent_response'
        args = { text_delta: String(item.text || '').slice(0, capLen) }
      } else if (kind === 'reasoning') {
        tool = 'reasoning'
        args = { text_delta: String(item.text || item.summary || '').slice(0, capLen) }
      } else if (kind === 'file_change') {
        tool = 'file_change'
        const changes = Array.isArray(item.changes) ? item.changes.map((c) => (c && (c.path || c.file)) || '').filter(Boolean) : []
        args = summarizeArgs({ paths: changes.slice(0, 6) })
      } else if (kind === 'mcp_tool_call') {
        tool = 'mcp:' + String(item.server || '?') + '/' + String(item.tool || item.name || '?')
        args = summarizeArgs(item.arguments || null)
      } else if (kind === 'web_search') {
        tool = 'web_search'
        args = summarizeArgs({ query: item.query })
      } else if (kind === 'error') {
        tool = 'warning'
        args = { message: String(item.message || '').slice(0, capLen) }
      } else {
        args = summarizeArgs({ type: kind })
      }
      const key = item.id ? String(item.id) : null
      p.codexByItem = p.codexByItem || Object.create(null)
      const prior = key ? p.codexByItem[key] : null
      if (prior) {
        prior.state = state
        if (key) delete p.codexByItem[key]
        if (p.current && p.current.itemKey === key) p.current = null
        return
      }
      const entry = { stepIndex: p.trail.length, state, tool, args: args || null, at: nowIso() }
      pushTrail(entry)
      if (t === 'item.started') {
        if (key) p.codexByItem[key] = entry
        p.current = { tool, args: args || null, stepIndex: entry.stepIndex, since: nowIso(), itemKey: key }
      }
    },

    // 瞬时错误重试：codex 自己会重试网络，这里只兜「流断了但非限流」这一类。
    isTransientCliError(res) {
      if (!res || res.ok) return false
      if (isLimited(res)) return false
      if (res.status === 'INCOMPLETE') return true
      const hay = String(res.errorMessage || '') + ' ' + String(res.stderr || '')
      return /stream disconnected|connection reset|ECONNRESET|ETIMEDOUT|temporarily unavailable|overloaded|try again/i.test(hay)
    },

    failureHint(res) {
      if (!res || res.ok) return ''
      const st = String(res.status || '')
      if (st === 'CODEX_UNAVAILABLE') return '[诊断] 未找到 codex 可执行文件：请安装 Codex CLI，或在 CLI Bridge 设置面板填写 codex 可执行文件路径（也可设 CODEX_BIN）。'
      if (st === 'BAD_ARGS') return '[诊断] codex 拒绝了参数（exit 2）：请检查 model/sandboxMode 等取值；codex_models 可列出可用模型 id。'
      const hay = String(res.stderr || '') + ' ' + String(res.errorMessage || '') + ' ' + String(res.response || '')
      if (/not logged in|please run.*login|unauthorized|invalid api key|401|403/i.test(hay) && !/rate.?limit|quota|限流|额度/i.test(hay)) {
        return '[诊断] codex 凭据问题（未登录 / API key 无效）：请让用户执行 `codex login`，或检查 ~/.codex/config.toml 里 model_providers.<name> 的 base_url 与 experimental_bearer_token。这不是限流。'
      }
      if (/not a valid model|invalid model|model not found|unknown model|unsupported model/i.test(hay)) {
        return '[诊断] 模型 id 不被服务端接受：先用 codex_models（默认 source=live）列出该端点真实可用的 id，再传 model。注意 ~/.codex/models.json 与 model_catalog_json 只是本地目录，不代表服务端可用。'
      }
      if (/not inside a trusted directory|not a git repository|skip-git-repo-check/i.test(hay)) {
        return '[诊断] codex 拒绝了当前工作目录（非 git 仓库）：本桥已默认加 --skip-git-repo-check；若仍出现，说明 argv 被外部改写，请检查 buildArgv。'
      }
      if (/approval|sandbox|permission denied|operation not permitted/i.test(hay)) {
        return '[诊断] 沙箱/审批拒绝了操作：非交互 exec 无法弹出审批，请调高 sandboxMode（workspace-write → danger-full-access）或在设置面板改「沙箱策略」，然后重跑。'
      }
      if (/quota|额度|rate.?limit|insufficient|credit|balance|402/i.test(hay)) {
        return '[诊断] 端点额度可能耗尽：换一个（优先 :free）模型，或改用原生工具完成本任务；不要循环重试。'
      }
      return ''
    },

    isSuccessStatus(st) { return st === 'SUCCESS' },

    tools: {
      run: { name: 'codex_run', description: 'Dispatch a coding/build/debug/investigation task to the local OpenAI Codex CLI and return its final answer. Prefer this for implementation, edits, refactors, multi-file investigation and debugging in every mode. DSH fully controls codex: it always runs non-interactively (`codex exec --json`, approvals cannot block). Use read-only native tools only for quick lookups and for final build/test verification. In mode=auto the DSH plan state decides the sandbox (plan → read-only, otherwise workspace-write). Runs in the background by default (returns a jobId immediately; collect with job_output, watch progress with codex_status); set background=false to block for the final answer.', inputSchema: RUN_PARAMS },
      continue: { name: 'codex_continue', description: 'Continue an existing codex thread with a follow-up prompt, reusing codex context (`codex exec resume`). Pass sessionId (the thread_id from a prior codex_run result), or set latest=true to resume the most recent thread in this working directory. codex exec resume has no -C/-s, so the sandbox is applied via -c and the working directory comes from the bridge session registry. Same DSH-controlled, no-prompt execution as codex_run.', inputSchema: CONTINUE_PARAMS },
      status: { name: 'codex_status', description: 'Read a live snapshot of what the local codex agent is currently doing. Returns one section per project (working directory): running count, the current step (the command/text being produced, from the --json event stream), the recent step trail (commands, file changes, messages, errors), and the last completed run status + thread id. Optional cwd filters to a single project. Call this to check on an in-flight codex_run/codex_continue without waiting for it to finish.', inputSchema: STATUS_PARAMS }
    },

    // codex_models：宿主有 spawn/fetch 能力时注册（preset 注入 deps.process / MCP 注入
    // deps.nodeChild；dynamic 沙箱形态省略 —— 与 agy/opencode 同约定）。
    extraTools: (deps.process || deps.nodeChild || typeof deps.fetch === 'function')
      ? [codexModelsTool({ env, deps })]
      : [],

    settings: {
      keys: ['binPath', 'defaultModel', 'sandboxMode', 'approvalPolicy'],
      defaults: () => ({ binPath: '', defaultModel: '', sandboxMode: '', approvalPolicy: '' }),
      normalize: (raw) => {
        const r = raw && typeof raw === 'object' ? raw : {}
        const pick = (v) => (typeof v === 'string' ? String(v).trim() : '')
        const sandbox = pick(r.sandboxMode)
        const approval = pick(r.approvalPolicy)
        return {
          binPath: pick(r.binPath),
          defaultModel: pick(r.defaultModel),
          sandboxMode: SANDBOX_MODES.indexOf(sandbox) >= 0 ? sandbox : '',
          approvalPolicy: APPROVAL_POLICIES.indexOf(approval) >= 0 ? approval : ''
        }
      },
      // 面板是同步回调，且**不再自动探测**（契约 §3.2）：defaultModel 的候选只来自
      // 已缓存的 live 清单（codexCachedModelOptions 纯读，不 spawnSync、不发请求）。
      // 探测由用户点「拉取可用模型」→ settings.refreshModels() 显式触发。
      meta: (env2) => {
        const e = env2 && typeof env2 === 'object' ? env2 : env
        const opts = codexCachedModelOptions(e)
        const exeCandidates = codexExeCandidates(e)
        return {
          titleSuffix: 'Codex',
          fields: [
            {
              key: 'binPath', label: 'codex 可执行文件路径', type: 'select', allowCustom: true,
              options: exeCandidates.map((p) => ({ value: p, label: p })),
              placeholder: '留空 = CODEX_BIN / CODEX_CLI / PATH 的 codex',
              note: '留空即按 env › PATH 顺序解析；填 .mjs/.js 会经 node 启动（测试夹具形态）。'
            },
            {
              key: 'defaultModel', label: '默认模型', type: 'select', allowCustom: true,
              options: opts.options,
              // 面板据此渲染「手动拉取」按钮（契约 §3.2）；meta() 自身永不探测。
              refresh: { label: '拉取可用模型' },
              placeholder: '留空 = 由 ~/.codex/config.toml 的 model 决定',
              note: opts.note
            },
            {
              key: 'sandboxMode', label: '沙箱策略', type: 'select',
              options: [
                { value: '', label: '（跟随 mode / codex 自身 config）' },
                { value: 'read-only', label: 'read-only（只读，plan 模式默认）' },
                { value: 'workspace-write', label: 'workspace-write（可写工作区，默认）' },
                { value: 'danger-full-access', label: 'danger-full-access（无沙箱，慎用）' }
              ],
              note: '对应 codex 的 -s；续聊（resume）没有 -s，改经 -c sandbox_mode 生效。'
            },
            {
              key: 'approvalPolicy', label: '审批策略', type: 'select',
              options: [
                { value: '', label: '（不覆盖，用 codex 自身 config）' },
                { value: 'never', label: 'never（从不审批，推荐）' },
                { value: 'on-request', label: 'on-request' },
                { value: 'on-failure', label: 'on-failure' },
                { value: 'untrusted', label: 'untrusted' }
              ],
              note: '经 -c approval_policy="…" 传入 —— codex exec 没有 -a 旗（实测报 unexpected argument）。非交互场景建议 never。'
            }
          ]
        }
      },
      /**
       * 手动拉取（契约 §3.2）：面板「拉取可用模型」按钮 → keystone
       * POST /cli-bridge/settings/models → 这里。这是本 provider 唯一的面板探测入口。
       *
       * 复用 codexLiveModels（工具面同一个实现：GET {base_url}/models + Bearer），不写第二套；
       * 成功时它已把 payload 写回 CODEX_MODEL_CACHE，随后 meta() 直接命中。
       * 铁律：失败 = ok:false + 可操作错误 + 空 ids；绝不返回 {ok:true, ids:[]}，
       * 也绝不把 catalog/builtin（本地目录、非权威）混进这份「服务端可用清单」。
       */
      async refreshModels(settings, env2) {
        const e = (env2 && typeof env2 === 'object') ? env2 : env
        const res = await codexLiveModels(e, {
          refresh: true,
          fetch: deps.fetch,
          timeoutMs: REFRESH_TIMEOUT_MS
        })
        if (!res.ok) {
          return { ok: false, ids: [], source: 'live', error: String(res.error || 'live model list unavailable') + ' ' + REFRESH_HINT }
        }
        const ids = []
        const labels = {}
        for (const m of res.models || []) {
          if (!m || !m.id || ids.indexOf(m.id) >= 0) continue
          ids.push(m.id)
          labels[m.id] = m.free ? m.id + '  [free]' : m.id
        }
        if (!ids.length) {
          // 拿到 2xx 却没有任何可用 id：显式失败，绝不把空清单当成功（本项目 0.2.6~0.2.9 的坑）。
          return { ok: false, ids: [], source: 'live', error: '端点 ' + String(res.url || '') + ' 返回 0 个可用模型 id（响应已解析但没有可用项）。' + REFRESH_HINT }
        }
        return { ok: true, ids, labels, source: 'live' }
      },

      diagnose: (settings, env2) => {
        const s = settings && typeof settings === 'object' ? settings : {}
        const e = env2 && typeof env2 === 'object' ? env2 : env
        const bits = []
        bits.push(s.binPath ? 'bin=设置:' + s.binPath : 'bin=' + codexExeCandidates(e)[0])
        bits.push(s.defaultModel ? 'model=' + s.defaultModel : 'model=(codex config 自决)')
        const ep = codexModelsEndpoint(e)
        if (ep.ok) {
          const cached = codexCachedLiveModels(e)
          bits.push('endpoint=' + endpointHost(ep.url) + (cached && cached.ok ? ' live=' + cached.count : ' live=未缓存'))
        } else bits.push('endpoint=未配置')
        bits.push('sandbox=' + (s.sandboxMode || 'mode 派生'))
        bits.push('approval=' + (s.approvalPolicy || 'codex config'))
        const cfg = codexReadConfig(e)
        if (cfg.model) bits.push('cfg.model=' + cfg.model)
        bits.push('home=' + (codexHomeDir(e) || '?'))
        return bits.join(' · ')
      }
    },

    mcp: { version: '0.2.8' }
  }

  // 三形态共用的工具逻辑（kit 的 coreExecute 负责 jobs/超时/回退/瞬时重试）。
  descriptor.runToolLogic = async function (args, exec) {
    const a = args || {}
    const normalized = a.background === undefined ? Object.assign({}, a, { background: true }) : a
    return this.runner.coreExecute(normalized, exec)
  }
  descriptor.continueToolLogic = async function (args, exec) {
    const a = args || {}
    const mapped = {
      prompt: a.prompt, model: a.model, mode: a.mode, sandboxMode: a.sandboxMode,
      reasoningEffort: a.reasoningEffort, cwd: a.cwd, images: a.images,
      timeoutSec: a.timeoutSec,
      background: a.background === undefined ? true : a.background
    }
    if (a.sessionId) mapped.sessionId = String(a.sessionId)
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

  // MCP/测试形态复用同一套模型读取（与 extraTools 同源，避免两处实现漂移）。
  descriptor.listModels = async function (args) {
    return codexModelsTool({ env, deps }).logic(args || {})
  }
  descriptor.liveModels = codexLiveModels
  descriptor.catalogModels = codexCatalogModels
  descriptor.builtinModels = codexBuiltinModels

  descriptor.attach = function (hostOpts) {
    host = hostOpts || {}
    codexSetHost(env, deps.nodeFs || null, deps.nodePath || null)
    try {
      if (typeof host.getSettings === 'function') {
        const s = host.getSettings('codex')
        if (s && typeof s === 'object') settingsRef = descriptor.settings.normalize(s)
      }
    } catch (e) { /* 设置缺省不影响装配 */ }
    this.engine = createStatusEngine({ provider: this, publish: host.publish })
    const runner = createRunner(Object.assign({}, host, { provider: this, engine: this.engine }))
    this.runner = runner
    return runner
  }
  return descriptor
}

// ── inlined from providers/codex-cli.mjs ──
// providers/codex-cli.mjs — codex 事实层：配置发现 / 可执行探测 / 三层模型清单。
//
// 从 providers/codex.mjs 拆出（规则 §26：主文件必须留在 600 物理行内）。这里只放
// 与「本机 codex 装成什么样」有关的纯逻辑：~/.codex 布局、config.toml 最小 TOML 解析、
// 可执行候选、三层模型清单（实时 HTTP / 本地目录 / 内置定义）。不含状态机、不含 argv。
//
// 沙箱纪律（与 providers/*.mjs 同）：本文件会被 scripts/build.mjs 经模板的 EXTRA 标记
// 内联进同一个 dynamic 沙箱作用域 —— 因为 codex.mjs 主文件已超红线，必须走片文件：
//   1) 不得 import 任何模块（import 行会被剥掉，函数体留下但依赖丢失 → 运行期炸）；
//      Node 内建一律经 globalThis.process.getBuiltinModule + typeof 守卫。
//   2) 顶层标识符一律 codex 前缀，禁止与 bridge-kit / core/scheduling.mjs / codex.mjs
//      撞名（同一作用域重复声明 = 构建期 Identifier already declared）。
//   3) 不得出现 import.meta 字面量。
//   4) ⚠️ 注释里绝不写出占位标记字面量：build 做全局文本替换，注释里出现同样会被
//      替换成正文代码，把注释从中间劈开 → 生成物语法崩。
//
// 实测事实（codex-cli 0.98.0，本机 Windows）：
//   • 没有 `codex models` 子命令；`codex debug` 只有 app-server。故「实时模型清单」
//     只能走 HTTP（config.toml 里 model_providers.<active>.base_url + bearer token）。
//   • 用无效 model id 探测不会吐名录（只报 "xxx is not a valid model ID"）——
//     与 codebuddy/claude 的 400 名录机制不同，别照抄那套。
//   • GET {base_url}/models 实测 200，返回 { data: [ {id,name,pricing,context_length,…} ] }。
//   • ~/.codex/{model_catalog_json} 与 ~/.codex/models.json 都是 { models: [ {slug,…} ] }。

// ── 宿主能力（env / fs / path）───────────────────────────────────────────────
// keystone 的 settings 面板只用 createProvider(id,{env}) 构造描述符（不 attach、不注入
// nodeFs），所以这里必须能自己摸到 Node 内建；摸不到（dynamic 沙箱）时优雅缺席，
// 由调用方给出「本形态没有 fs」的明确错误，绝不静默返回空列表。
let codexHostEnv = {}
let codexHostFs = null
let codexHostPath = null

function codexSetHost(envObj, fsMod, pathMod) {
  if (envObj && typeof envObj === 'object') codexHostEnv = envObj
  if (fsMod && typeof fsMod.readFileSync === 'function') codexHostFs = fsMod
  if (pathMod && typeof pathMod.join === 'function') codexHostPath = pathMod
}

function codexProcess() {
  try {
    const p = globalThis.process
    return p && typeof p === 'object' ? p : null
  } catch (e) { return null }
}

function codexBuiltin(name) {
  try {
    const p = codexProcess()
    return (p && typeof p.getBuiltinModule === 'function') ? p.getBuiltinModule(name) : null
  } catch (e) { return null }
}

function codexFs() {
  if (codexHostFs) return codexHostFs
  const nf = codexBuiltin('node:fs')
  return nf && typeof nf.readFileSync === 'function' ? nf : null
}

function codexPathJoin() {
  const parts = Array.prototype.slice.call(arguments).filter((x) => x !== undefined && x !== null && x !== '')
  if (!parts.length) return ''
  const mod = codexHostPath || codexBuiltin('node:path')
  if (mod && typeof mod.join === 'function') return mod.join.apply(mod, parts)
  return parts.map((x) => String(x)).join('/')
}

function codexReadText(p) {
  if (!p) return null
  const fs = codexFs()
  if (!fs) return null
  try { return fs.readFileSync(p, 'utf8') } catch (e) { return null }
}

/** CODEX_HOME 覆盖 ~/.codex（CLI 自身语义）。 */
function codexHomeDir(env) {
  const e = env || codexHostEnv || {}
  if (e.CODEX_HOME) return String(e.CODEX_HOME)
  const home = e.USERPROFILE || e.HOME || ''
  return home ? codexPathJoin(home, '.codex') : ''
}

// ── config.toml 最小解析 ─────────────────────────────────────────────────────
// 只需要字符串标量与表头：本模块读的键是 model / model_provider / model_catalog_json，
// 以及 [model_providers.<name>] 下的 base_url / experimental_bearer_token。
// 数组（notify = [...]）、布尔、数字一律跳过 —— 宁可少读，也不猜错类型。
function codexParseToml(text) {
  const top = Object.create(null)
  const tables = Object.create(null)
  let cur = top
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.charAt(0) === '#') continue
    const hdr = /^\[([^\]]+)\]$/.exec(line)
    if (hdr) {
      const name = hdr[1].trim()
      if (!tables[name]) tables[name] = Object.create(null)
      cur = tables[name]
      continue
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    const rawVal = kv[2].trim()
    let str = null
    if (/^"(?:[^"\\]|\\.)*"$/.test(rawVal)) str = rawVal.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    else if (/^'[^']*'$/.test(rawVal)) str = rawVal.slice(1, -1)
    else if (/^[A-Za-z0-9_.:/@-]+$/.test(rawVal) && rawVal !== 'true' && rawVal !== 'false' && !/^-?[0-9]+(\.[0-9]+)?$/.test(rawVal)) str = rawVal
    if (str === null) continue
    cur[kv[1]] = str
  }
  return { top, tables }
}

/**
 * 汇总本机 codex 的生效配置。
 * @returns {{ home, configPath, configFound, providerName, baseUrl, token, model,
 *             catalogFile, authPath, authFound, authBaseUrl, authApiKey }}
 */
function codexReadConfig(env) {
  const e = env || codexHostEnv || {}
  const home = codexHomeDir(e)
  const configPath = home ? codexPathJoin(home, 'config.toml') : ''
  const configText = codexReadText(configPath)
  const parsed = configText ? codexParseToml(configText) : { top: Object.create(null), tables: Object.create(null) }
  const providerName = typeof parsed.top.model_provider === 'string' ? parsed.top.model_provider : ''
  const block = providerName && parsed.tables['model_providers.' + providerName]
    ? parsed.tables['model_providers.' + providerName]
    : Object.create(null)
  const authPath = home ? codexPathJoin(home, 'auth.json') : ''
  const authText = codexReadText(authPath)
  let auth = null
  try { auth = authText ? JSON.parse(authText) : null } catch (err) { auth = null }
  const authBaseUrl = auth && typeof auth.OPENAI_BASE_URL === 'string' ? auth.OPENAI_BASE_URL : ''
  const authApiKey = auth && typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY : ''
  const baseUrl = typeof block.base_url === 'string' && block.base_url ? block.base_url : authBaseUrl
  const token = typeof block.experimental_bearer_token === 'string' && block.experimental_bearer_token
    ? block.experimental_bearer_token
    : authApiKey
  return {
    home,
    configPath,
    configFound: configText !== null,
    providerName,
    baseUrl: String(baseUrl || ''),
    token: String(token || ''),
    model: typeof parsed.top.model === 'string' ? parsed.top.model : '',
    catalogFile: typeof parsed.top.model_catalog_json === 'string' ? parsed.top.model_catalog_json : '',
    authPath,
    authFound: auth !== null,
    authBaseUrl: String(authBaseUrl || ''),
    authApiKey: String(authApiKey || '')
  }
}

/** 实时模型清单的端点（base_url + /models）。缺 base_url 时明确失败，不猜端点。 */
function codexModelsEndpoint(env) {
  const e = env || codexHostEnv || {}
  const cfg = codexReadConfig(env)
  // 显式覆盖（诊断/测试/临时换端点用）：CODEX_BRIDGE_MODELS_URL 既可是完整 URL，
  // 也可是 base_url（自动补 /models）；token 同理可覆盖。
  const override = String(e.CODEX_BRIDGE_MODELS_URL || '').trim()
  const base = String(override || cfg.baseUrl || '').trim()
  const token = String(e.CODEX_BRIDGE_MODELS_TOKEN || cfg.token || '')
  if (!base) {
    return {
      ok: false, cfg, url: '', token: '', baseUrl: '', providerName: cfg.providerName,
      error: 'no base_url configured: ' + (cfg.configFound
        ? 'config.toml has no model_providers.' + (cfg.providerName || '<none>') + '.base_url and auth.json has no OPENAI_BASE_URL'
        : 'config.toml not found at ' + (cfg.configPath || '(unknown)')) +
        '. Codex CLI has no `models` subcommand, so a live list can only come from the provider HTTP API (/models).'
    }
  }
  const url = /\/models\/*$/.test(base) ? base : base.replace(/\/+$/, '') + '/models'
  return {
    ok: true,
    cfg,
    baseUrl: base,
    url,
    token,
    providerName: cfg.providerName
  }
}

// ── 可执行文件 ───────────────────────────────────────────────────────────────
/** 候选顺序：面板 binPath（调用方传入）> CODEX_BIN > CODEX_CLI > CODEX_CLI_PATH > PATH 名。 */
function codexExeCandidates(env) {
  const e = env || codexHostEnv || {}
  const out = []
  const push = (v) => { const s = String(v || '').trim(); if (s && out.indexOf(s) < 0) out.push(s) }
  push(e.CODEX_BIN)
  push(e.CODEX_CLI)
  push(e.CODEX_CLI_PATH)
  push('codex')
  return out
}

/** .mjs/.cjs/.js 目标经 node 包装（测试夹具与自定义入口都走这条）。 */
function codexResolveExePrefix(env, binPath) {
  const bin = String(binPath || '').trim() || codexExeCandidates(env)[0]
  if (/\.(mjs|cjs|js)$/i.test(bin)) {
    const p = codexProcess()
    return [p && p.execPath ? p.execPath : 'node', String(bin)]
  }
  return [String(bin)]
}

/**
 * Windows npm 全局安装的 `codex.cmd` 不能直接 spawn（CreateProcess 不解析 .cmd/.bat；
 * 走 shell 又会让含空格/引号的 prompt 被二次解释 —— 正是本桥刻意避免的形态）。
 * 与其抛出难懂 EINVAL，不如在解析阶段给一条可行动的错误。
 * @returns {string|null} 拒绝原因（null = 可以用）
 */
function codexShimRejectReason(binPath) {
  const bin = String(binPath || '').trim()
  if (!/\.(cmd|bat)$/i.test(bin)) return null
  return 'codex executable "' + bin + '" is a Windows .cmd/.bat shim, which cannot be spawned directly without a shell ' +
    '(and a shell would re-interpret the prompt). Point binPath / CODEX_BIN at the real codex.exe instead — ' +
    'for an npm global install that is under %APPDATA%\\npm\\node_modules\\@openai\\codex\\vendor\\<platform>\\codex.exe.'
}

// ── 模型清单：三层来源（顺序即权威性）────────────────────────────────────────
//   A live   —— GET {base_url}/models（服务端裁决，唯一权威）
//   B catalog—— config.toml 的 model_catalog_json（codex 自用的模型目录）
//   C builtin—— ~/.codex/models.json（CLI 内置定义）
// 红线：B/C 绝不允许冒充 A。清单项与结果对象都带 source，调用方据此展示。
function codexNormalizeModelItem(raw, source) {
  const r = raw && typeof raw === 'object' ? raw : null
  if (!r) return null
  const id = String(r.id || r.slug || r.model || r.name || '').trim()
  if (!id) return null
  let free = false
  if (r.pricing && typeof r.pricing === 'object') {
    const p = r.pricing.prompt
    if (p === 0 || p === '0' || p === '0.0') free = true
  }
  if (!free && /(?::free$|-free$)/i.test(id)) free = true
  const ctxNum = Number(r.context_window || r.context_length || r.max_context_window || 0)
  return {
    id,
    name: String(r.display_name || r.name || id),
    source,
    free,
    contextWindow: Number.isFinite(ctxNum) && ctxNum > 0 ? ctxNum : null,
    visibility: typeof r.visibility === 'string' ? r.visibility : null
  }
}

/** 解析 {data:[…]} 或 {models:[…]} 两种载荷。畸形载荷返回明确错误。 */
function codexParseModelsPayload(text, source) {
  let json = null
  try { json = JSON.parse(String(text || '')) } catch (e) {
    return { ok: false, models: [], error: 'models payload is not JSON: ' + String(text || '').slice(0, 160) }
  }
  const arr = json && Array.isArray(json.data) ? json.data
    : (json && Array.isArray(json.models) ? json.models : null)
  if (!arr) return { ok: false, models: [], error: 'models payload has neither .data nor .models array: ' + String(text || '').slice(0, 160) }
  const models = []
  const seen = Object.create(null)
  let hidden = 0
  for (const raw of arr) {
    const item = codexNormalizeModelItem(raw, source)
    if (!item || seen[item.id]) continue
    if (item.visibility && item.visibility !== 'list') { hidden += 1; continue }
    seen[item.id] = true
    models.push(item)
  }
  return { ok: true, models, hidden, total: arr.length }
}

// 进程内缓存（面板每次渲染都会来取，避免反复打网络 / 反复起子进程）。
const CODEX_MODEL_CACHE = { at: 0, url: '', payload: null }
const CODEX_MODEL_TTL_MS = 5 * 60 * 1000

function codexCacheNow() { return Date.now() }

/** 已缓存的实时清单（无则 null）。供同步面板路径做零阻塞快读。 */
function codexCachedLiveModels(env, nowMs) {
  const ep = codexModelsEndpoint(env)
  if (!ep.ok) return null
  const hit = CODEX_MODEL_CACHE
  const at = Number(nowMs) || Date.now()
  if (hit.payload && hit.url === ep.url && at - hit.at < CODEX_MODEL_TTL_MS) return hit.payload
  return null
}

function codexRememberLive(url, payload) {
  CODEX_MODEL_CACHE.at = codexCacheNow()
  CODEX_MODEL_CACHE.url = url
  CODEX_MODEL_CACHE.payload = payload
}

function codexFetchInit(token, signal) {
  const headers = { accept: 'application/json' }
  if (token) headers.authorization = 'Bearer ' + token
  const init = { method: 'GET', headers }
  // 面板「拉取可用模型」是 HTTP 请求上的同步等待：端点卡住时必须有上界，
  // 否则设置页会一直转圈（无 signal 能力的宿主就照旧直接请求）。
  if (signal) init.signal = signal
  return init
}

function codexDescribeFetchError(status, body) {
  const head = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (status === 401 || status === 403) {
    return 'HTTP ' + status + ' — the provider rejected the credential. Set model_providers.<name>.experimental_bearer_token (or auth.json OPENAI_API_KEY) for the endpoint you actually use. ' + head
  }
  return 'HTTP ' + status + (head ? ' — ' + head : '')
}

/** A 层（异步）：GET {base_url}/models。deps.fetch 可注入（测试），否则用全局 fetch。 */
async function codexLiveModels(env, opts) {
  const o = opts || {}
  const ep = codexModelsEndpoint(env)
  if (!ep.ok) return { ok: false, source: 'live', models: [], error: ep.error }
  const cached = codexCachedLiveModels(env, o.nowMs)
  if (cached && !o.refresh) return cached
  const f = o.fetch || ((typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') ? globalThis.fetch : null)
  if (!f) {
    return { ok: false, source: 'live', models: [], url: ep.url, error: 'no fetch capability in this host form, so the live model list from ' + ep.url + ' cannot be read. Use source="catalog" (config.toml model_catalog_json) or source="builtin" (~/.codex/models.json) explicitly — they are local and are NOT authoritative.' }
  }
  let res
  // 取清单是设置面板的一次同步等待（点按钮 → HTTP → 这里）：必须有上界。
  // 无 AbortController 的宿主退化为不带上界（照旧请求），不静默改变成功语义。
  const timeoutMs = Math.max(2000, Math.min(Number(o.timeoutMs) || 20000, 60000))
  const ctrl = (typeof AbortController === 'function') ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort() } catch (err) { } }, timeoutMs) : null
  try { res = await f(ep.url, codexFetchInit(ep.token, ctrl ? ctrl.signal : null)) } catch (e) {
    return { ok: false, source: 'live', models: [], url: ep.url, error: 'GET ' + ep.url + ' failed (timeout ' + timeoutMs + 'ms): ' + String(e && e.message || e) + '. Check network/proxy, or set CODEX_BRIDGE_MODELS_URL to the provider catalogue endpoint.' }
  } finally {
    if (timer) clearTimeout(timer)
  }
  let body = ''
  try { body = typeof res.text === 'function' ? await res.text() : JSON.stringify(res.json || {}) } catch (e) { body = '' }
  const status = Number(res && res.status) || 0
  if (!res || status < 200 || status >= 300) {
    return { ok: false, source: 'live', models: [], url: ep.url, error: 'GET ' + ep.url + ' → ' + codexDescribeFetchError(status, body) }
  }
  const parsed = codexParseModelsPayload(body, 'live')
  if (!parsed.ok) return { ok: false, source: 'live', models: [], url: ep.url, error: ep.url + ': ' + parsed.error }
  if (!parsed.models.length) {
    return { ok: false, source: 'live', models: [], url: ep.url, error: ep.url + ' returned 0 usable models (payload items=' + parsed.total + '). Refusing to report an empty list as if it were authoritative.' }
  }
  const payload = {
    ok: true, source: 'live', models: parsed.models, count: parsed.models.length,
    url: ep.url, baseUrl: ep.baseUrl, providerName: ep.providerName, fetchedAt: Date.now()
  }
  codexRememberLive(ep.url, payload)
  return payload
}

// 子进程探针脚本已删除：面板不再自动探测（契约 §3.2 手动拉取）。live 清单只在
// settings.refreshModels()（异步、用户点按钮）与时序工具 codex_models 里读取。

/** B 层：config.toml 的 model_catalog_json（相对 CODEX_HOME）。 */
function codexCatalogModels(env) {
  const cfg = codexReadConfig(env)
  const rel = cfg.catalogFile
  if (!rel) {
    return { ok: false, source: 'catalog', models: [], error: 'config.toml has no model_catalog_json key, so there is no local catalog to read (set it to a file name under ' + (cfg.home || 'CODEX_HOME') + ').' }
  }
  const p = /[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel) ? rel : codexPathJoin(cfg.home, rel)
  const text = codexReadText(p)
  if (text === null) return { ok: false, source: 'catalog', models: [], file: p, error: 'catalog file not readable: ' + p }
  const parsed = codexParseModelsPayload(text, 'catalog')
  if (!parsed.ok) return { ok: false, source: 'catalog', models: [], file: p, error: p + ': ' + parsed.error }
  if (!parsed.models.length) return { ok: false, source: 'catalog', models: [], file: p, error: p + ' contains 0 visible models' }
  return { ok: true, source: 'catalog', models: parsed.models, count: parsed.models.length, file: p }
}

/** C 层：~/.codex/models.json（CLI 内置定义）。 */
function codexBuiltinModels(env) {
  const cfg = codexReadConfig(env)
  if (!cfg.home) return { ok: false, source: 'builtin', models: [], error: 'CODEX_HOME/USERPROFILE unknown, cannot locate ~/.codex/models.json' }
  const p = codexPathJoin(cfg.home, 'models.json')
  const text = codexReadText(p)
  if (text === null) return { ok: false, source: 'builtin', models: [], file: p, error: 'builtin model definitions not readable: ' + p }
  const parsed = codexParseModelsPayload(text, 'builtin')
  if (!parsed.ok) return { ok: false, source: 'builtin', models: [], file: p, error: p + ': ' + parsed.error }
  if (!parsed.models.length) return { ok: false, source: 'builtin', models: [], file: p, error: p + ' contains 0 visible models' }
  return { ok: true, source: 'builtin', models: parsed.models, count: parsed.models.length, file: p }
}

/**
 * 面板下拉的候选池（契约 §3.2）：**纯读缓存**，绝不 spawnSync、绝不发请求、绝不碰本地目录。
 * 探测由 settings.refreshModels() 显式触发（用户点「拉取可用模型」），成功后写回同一份
 * CODEX_MODEL_CACHE，这里下次渲染直接命中 —— 面板首屏因此不会被网络拖慢。
 *
 * 为什么不再回落到 catalog/builtin：那两层是本地元数据，不是服务端可用清单；把它们填进
 * 这个下拉等于让用户以为「服务端就这些」（0.2.6~0.2.9 反复踩的坑）。宁可空着并说清
 * 「点按钮拉取」，也不展示可能已经过时的非权威列表 —— 需要本地目录请用 codex_models
 * 的 source="catalog"/"builtin" 显式查询（那里逐项标注来源）。
 */
function codexCachedModelOptions(env) {
  const live = codexCachedLiveModels(env)
  if (!live || !live.ok || !Array.isArray(live.models) || !live.models.length) {
    return {
      options: [], source: 'none', count: 0,
      note: '还没拉取过（或上次没拉到）：点「拉取可用模型」向端点取权威清单；空表示尚未拉取 / 端点或 token 未配好。可直接手动输入模型 id。'
    }
  }
  return {
    options: live.models.map((m) => ({ value: m.id, label: m.id + (m.free ? '  [free]' : '') })),
    source: 'live', count: live.count, url: live.url, fetchedAt: live.fetchedAt,
    note: '上次拉取到 ' + live.count + ' 个模型（源：' + live.url + '，免费标 [free]）。点「拉取可用模型」重新获取。'
  }
}

// ── inlined from providers/codex-models.mjs ──
// providers/codex-models.mjs — codex_models 工具定义（纯逻辑）。
//
// 从 providers/codex.mjs 再拆出：两个文件都要留在 600 物理行红线内（规则 §26）。
// scripts/build.mjs 会把 providers/codex-*.mjs 全部内联进 dynamic 沙箱的同一作用域，
// 所以沙箱里 codexCl* 系列函数天然可见；ESM 形态走本文件的 import。
// ⚠️ 注释里绝不写出占位标记字面量（build 全局替换会劈开注释 → 生成物语法崩）。
//
// 红线（用户明确要求，本仓铁律）：拿不到实时清单必须 ok:false + 可操作错误。
// 绝不把 catalog/builtin 冒充成 live，也绝不静默返回空数组。清单项必须带 source。
// import { codexLiveModels, codexCatalogModels, codexBuiltinModels } from './codex-cli.mjs'
const MODELS_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    source: {
      type: 'string',
      enum: ['live', 'catalog', 'builtin'],
      description: 'Which layer to read. live = GET {base_url}/models from the provider API configured in ~/.codex/config.toml — the only authoritative list. catalog = the file named by config.toml model_catalog_json. builtin = ~/.codex/models.json. Local layers are codex-local metadata, NOT a claim about what the server will accept.'
    },
    filter: { type: 'string', description: 'Optional case-insensitive substring filter on model id/name (e.g. "minimax" or "free").' },
    freeOnly: { type: 'boolean', description: 'Return only models that look free (:free suffix or pricing.prompt == 0).' },
    limit: { type: 'integer', description: 'Max models to return (default 80, 1-1000). The result always reports the full match count.' },
    refresh: { type: 'boolean', description: 'Bypass the 5-minute live cache and re-fetch.' }
  }
}

const MODELS_DESCRIPTION = 'List the models the local codex CLI can actually use, with the source of every id made explicit. Default source=live performs GET {base_url}/models against the provider endpoint configured in ~/.codex/config.toml (base_url + experimental_bearer_token, else auth.json OPENAI_BASE_URL/OPENAI_API_KEY) — codex-cli has no `models` subcommand and probing with an invalid model id does NOT print a roster, so this HTTP call is the only authoritative source. If it cannot be read, this tool returns ok:false with an actionable error and never invents or silently downgrades the list; pass source="catalog"/"builtin" only when you deliberately want the local (non-authoritative) catalog. Use this before codex_run when the model id matters, and prefer free models (:free / pricing 0) for routine work.'

function renderModels(args, value) {
  const v = value || {}
  if (!v.ok) return [{ type: 'text', text: 'codex_models failed: ' + String(v.error || 'unknown') }]
  const list = Array.isArray(v.models) ? v.models : []
  const lines = ['codex models [' + (v.source || '?') + '] (' + (v.count != null ? v.count : list.length) + ' matched' + (v.truncated ? ', showing ' + list.length : '') + '):']
  for (const m of list.slice(0, 60)) {
    const bits = []
    if (m.free) bits.push('free')
    if (m.contextWindow) bits.push(Math.round(m.contextWindow / 1000) + 'k ctx')
    lines.push('  ' + m.id + (bits.length ? '  [' + bits.join(',') + ']' : ''))
  }
  if (list.length > 60) lines.push('  … and ' + (list.length - 60) + ' more')
  if (v.source === 'live') lines.push('source: live — ' + String(v.url || ''))
  else lines.push('source: ' + String(v.source || '') + ' — ' + String(v.file || '') + ' (local, NOT authoritative for the server)')
  if (v.note) lines.push('note: ' + v.note)
  return [{ type: 'text', text: lines.join('\n') }]
}

function modelsErrorHint(source, extra) {
  const base = String(extra || 'unknown')
  if (source !== 'live') return base
  return base + ' — pass source="catalog" or source="builtin" to inspect the local, non-authoritative lists, or fix the endpoint/credential above and retry.'
}

/**
 * codex_models 工具定义。
 * @param {{env?:object, deps?:object}} ctx env 用来定位 CODEX_HOME；deps.fetch 可注入。
 */
function codexModelsTool(ctx) {
  const c = ctx || {}
  const env = c.env || {}
  const deps = c.deps || {}
  return {
    name: 'codex_models',
    description: MODELS_DESCRIPTION,
    inputSchema: MODELS_PARAMS,
    render: renderModels,
    async logic(args) {
      const a = args || {}
      const source = a.source || 'live'
      let res
      if (source === 'live') res = await codexLiveModels(env, { fetch: deps.fetch, refresh: a.refresh === true })
      else if (source === 'catalog') res = codexCatalogModels(env)
      else if (source === 'builtin') res = codexBuiltinModels(env)
      else return { ok: false, source, models: [], error: 'unknown source ' + JSON.stringify(String(source)) + ' (use live|catalog|builtin)' }

      if (!res.ok || !Array.isArray(res.models) || !res.models.length) {
        return { ok: false, source, models: [], error: modelsErrorHint(source, res.error) }
      }
      let list = res.models
      if (a.filter) {
        const q = String(a.filter).toLowerCase()
        list = list.filter((m) => String(m.id).toLowerCase().indexOf(q) >= 0 || String(m.name || '').toLowerCase().indexOf(q) >= 0)
      }
      if (a.freeOnly) list = list.filter((m) => m.free)
      if (!list.length) {
        return { ok: false, source, models: [], error: 'no models matched filter=' + JSON.stringify(String(a.filter || '')) + ' freeOnly=' + String(a.freeOnly === true) + ' on source=' + source + ' (that is an empty *filter result*, not an empty provider list)' }
      }
      const limit = Number.isFinite(Number(a.limit)) ? Math.max(1, Math.min(Math.floor(Number(a.limit)), 1000)) : 80
      const matched = list.length
      const truncated = matched > limit
      const models = list.slice(0, limit)
      const out = {
        ok: true, source,
        models, count: matched, truncated,
        freeCount: res.models.filter((m) => m.free).length
      }
      if (res.url) out.url = res.url
      if (res.file) out.file = res.file
      if (res.providerName) out.providerName = res.providerName
      if (res.fetchedAt) out.fetchedAt = res.fetchedAt
      if (truncated) out.note = 'showing ' + limit + ' of ' + matched + ' matched models; raise limit or narrow with filter/freeOnly.'
      return out
    }
  }
}

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
    // 调度门禁（0.2.0）：设置面板关掉 codex → 本形态不注册工具/政策段；fail-open。
    if (!isBridgeEnabled('codex', SCHED_ALL_IDS)) return
    const subprocess = ctx.subprocess
    const sandboxPolicy = ctx.get('sandboxPolicy')
    // 沙箱可能运行在无 process 的环境：typeof 守卫读 env（旧仓 dynamic 的等价面）。
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}

    const provider = defineProvider({ env })

    function publish(snapshot) {
      try {
        const collector = ctx.get('cliBridgeCollector')
        if (collector && typeof collector.mergeSnapshot === 'function') { collector.mergeSnapshot('codex', snapshot); return }
      } catch (e) { /* fall through to legacy alias */ }
      try {
        const legacy = ctx.get('codexCollector')
        if (legacy && typeof legacy.mergeSnapshot === 'function') legacy.mergeSnapshot(snapshot)
      } catch (e) { /* 灯数据尽力而为 */ }
    }

    // exe 优先级（与描述符同一套）：CODEX_BIN > CODEX_CLI > CODEX_CLI_PATH > PATH 的 codex。
    // .js/.mjs 目标经 process.execPath 包装（测试夹具形态）；绝对路径直接交 spawn；
    // .cmd/.bat shim 明确拒绝（无 shell spawn 不解析它，走 shell 会二次解释 prompt）。
    const exeCandidates = codexExeCandidates(env)
    async function resolveExe(backend, signal) {
      let bare = ''
      for (let i = 0; i < exeCandidates.length; i++) {
        const c = exeCandidates[i]
        const shim = codexShimRejectReason(c)
        if (shim) throw new Error(shim)
        if (/\.(mjs|cjs|js)$/i.test(c) && typeof process !== 'undefined' && process.execPath) return [process.execPath, c]
        if (/[\\/]/.test(c)) return c
        if (!bare) bare = c
      }
      return await subprocess.resolveExecutable(bare || exeCandidates[exeCandidates.length - 1], undefined, signal)
    }

    // cwd 兜底：CODEX_BRIDGE_CWD > sandboxPolicy.workspaceRoot > process.cwd() > '.'。
    function getCwdFallback() {
      if (env.CODEX_BRIDGE_CWD) return String(env.CODEX_BRIDGE_CWD)
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
      if (typeof process !== 'undefined' && typeof process.cwd === 'function') { try { return process.cwd() } catch (e) { /* 沙箱受限 */ } }
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

    // 浏览器指示灯轮询的 RPC 面（旧 dynamic/handle('<id>_status') verbatim 语义）。
    harness.handle('codex_status', function () { return provider.statusToolLogic({}) })

    const policyText = [
      'codex-first execution policy (local OpenAI Codex CLI bridge).',
      '',
      'Local agent CLI "codex" handles coding tasks under full DSH control. Every dispatch is `codex exec --json --skip-git-repo-check` (never interactive, so approvals cannot block). By default codex runs in the background and returns a jobId immediately; collect results via job_output and watch live progress via codex_status anytime.',
      '',
      'Decision table for tool selection:',
      '- Single read/glob/grep or short (<30s) command -> Native tools.',
      '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> codex_run.',
      '- Follow-ups on the same topic -> codex_continue (with latest=true or sessionId; codex keeps the thread).',
      '- Final build/test verification of codex output -> Native tools.',
      '',
      'Context protocol (one topic = one codex thread):',
      '- First dispatch on a topic: provide the task with a compact CONTEXT preamble (point to paths, do not paste file contents):',
      '  CONTEXT: 2-6 lines — goal; repo root; key paths; decisions/constraints; current state.',
      '  TASK: the complete instruction.',
      '- Follow-ups: call codex_continue and state only what is new.',
      '',
      'Sandbox & approval:',
      '- mode=auto follows the DSH plan state: plan -> read-only sandbox, otherwise workspace-write.',
      '- codex exec has NO -a/--ask-for-approval flag; approval policy goes through -c approval_policy="…" only when configured. On resume the sandbox also goes through -c ("codex exec resume" has no -s and no -C).',
      '- If the sandbox denies an operation, raise sandboxMode instead of looping retries.',
      '',
      'Execution & Fallback protocol:',
      '- Dispatch defaults to background=true (set background=false only to block). Collect via job_output.',
      '- On rate-limit or network failure, a confirmation dialog opens in BOTH foreground and background while in flight.',
      '- If result has fallback=true (status FALLBACK_TO_DSH), the user chose DSH-local: finish with native tools and NEVER call codex again for this task.',
      '- Never loop codex calls; never ask codex to call back into DSH.',
      '',
      'Models & credentials:',
      '- Omit model unless you have a reason: codex then uses the CLI Bridge settings default, or the model from ~/.codex/config.toml.',
      '- Credentials belong to codex (~/.codex/config.toml model_providers.<name>, auth.json): on auth failures ask the user to run `codex login`; do not retry in a loop.'
    ].join('\n')

    ctx.systemPrompt.section({
      name: 'codex:policy',
      order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
      text: policyText
    })
  }
}
