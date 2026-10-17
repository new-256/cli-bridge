// dynamic/opencode.host.template.mjs — opencode 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=opencode）把 core/bridge-kit.mjs 与
// providers/opencode.mjs 分别内联进下方两个占位标记行（各占一行、行内仅此标记），
// 生成 dynamic/opencode.host.js。注意：标记字面量绝不能出现在本注释里 —— 构建做全局
// 替换，注释中出现同样会被替换成正文代码而炸掉语法。
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生
//    定时器 —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层
//    return 合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('opencode', snap)
//    推给家级灯；动态形态不宣告 mode（旧语义：普通模式灯仅在调用时临时显示）。
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

// providers/opencode.mjs — opencode provider descriptor（第四家 CLI，无旧包可迁）。
//
// 基线 = 本机实测 OpenCode V2 CLI v2.0.29（桌面版自带 opencode-cli.exe）+ 源码 emit 全集。
// 完整 CLI 事实表见 docs/HANDOVER.md §13；这里只留写代码时最容易踩的几条：
//   • 非交互 = `opencode run "<prompt>"`，prompt 是【位置参数】（run 子命令无 --prompt；
//     `-p` 是 --password）。`--format json` → NDJSON。`--auto` = 自动批准权限。
//   • ⚠️ V2 无 --dir（cwd 靠 spawn）、无 --variant（并入 --model#variant）。
//   • 退出码才是成败判据：0 成功 / 1 错误 / 130 SIGINT。
//   • ⚠️ 无 result/complete/init 事件；type 全集 = step_start/text/reasoning/tool_use/
//     step_finish/error。文本在 part.text，统计在 step_finish.part —— 两者是不同事件。
//
// 红线（PROVIDER-CONTRACT.md §8 + §1）：
//  - 本文件会被 build 内联进 dynamic 沙箱（new Function）：绝不出现 import.meta 字面量；
//    process 只经 deps 注入或 typeof 守卫读取；宿主能力全部走 deps/attach(hostOpts)。
//  - 只允许 import '../core/bridge-kit.mjs'。// import { createStatusEngine, createRunner, clampInt, isLimited } from '../core/bridge-kit.mjs'// import { candidateExePaths, EXE_BASENAMES } from './opencode-exe.mjs'

function nowIso() { return new Date().toISOString() }

// ── 可执行文件解析（env > 桌面版已知路径 > PATH）───────────────────────────────
// 二进制名是 opencode-cli.exe（不是 opencode.exe）：V2 桌面版自带，且 V1/V2 不能并存
// 安装（官方原话），故不做「opencode.exe 兜底」以免误命中另一个版本。
// 桌面版各版本目录形如 ...\ai.opencode.desktop\cli\<ver>-<arch>\opencode-cli.exe。

function schedBuiltin(name) {
  try {
    const proc = globalThis.process
    return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule(name) : null
  } catch (e) { return null }
}

/**
 * 探测本机 opencode 可执行文件候选路径（优先桌面版 V2）。
 * 纯函数、零副作用；无 fs 能力时返回空数组 —— 由调用方退回 PATH 查找。
 * @param {object} env 环境变量（读 APPDATA / LOCALAPPDATA / PROGRAMFILES / HOME）
 */
function resolveExePrefix(env, binPath) {
  const e = env || {}
  const bin = binPath || e.OPENCODE_BIN || e.OPENCODE_CLI || ''
  if (bin) {
    if (/\.(mjs|cjs|js)$/i.test(bin)) {
      const proc = globalThis.process
      const node = (proc && proc.execPath) ? proc.execPath : 'node'
      return [node, bin]
    }
    return [String(bin)]
  }
  const found = candidateExePaths(e)
  if (found.length) return [found[0]]
  return [EXE_BASENAMES[0]]
}

// ── 模型列表（`opencode models`；纯文本每行 provider/model）─────────────────────
// 同步版给 settings.meta（面板下拉）；异步版给 MCP 工具。解析宽容：只认
// provider/model 形态的行，其余（表头/说明/空行）一律丢弃。
const MODEL_LINE_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.#@+-]+)$/

function parseModelList(text) {
  const out = []
  const seen = Object.create(null)
  for (const raw of String(text || '').split(/\r?\n/)) {
    const ln = raw.trim()
    if (!ln) continue
    const m = ln.match(MODEL_LINE_RE)
    if (!m) continue
    const id = m[1] + '/' + m[2]
    if (seen[id]) continue
    seen[id] = true
    out.push({ id: id, provider: m[1], name: m[2], free: /(-free$|free)/i.test(m[2]) })
  }
  return out
}

/**
 * 同步抓取模型列表（供设置面板下拉）。失败返回空数组 —— 下拉退化为自由输入，
 * 绝不因探测失败影响面板渲染。仅 spawnSync 可用时生效（宿主形态）。
 */
function fetchModelsSync(env, binPath, timeoutMs) {
  try {
    const child = schedBuiltin('node:child_process')
    if (!child || typeof child.spawnSync !== 'function') return []
    const prefix = resolveExePrefix(env, binPath)
    const r = child.spawnSync(prefix[0], prefix.slice(1).concat(['models']), {
      encoding: 'utf8', timeout: clampInt(timeoutMs, 8000, 1000, 30000),
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    if (!r || r.error || r.status !== 0) return []
    return parseModelList(String(r.stdout || ''))
  } catch (e) { return [] }
}

// ── 三工具 schema ────────────────────────────────────────────────────────────
const RUN_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The task instruction for opencode. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — opencode reads the repo itself). For follow-ups on the same topic, use opencode_continue with latest=true or sessionId (opencode keeps session context; state only what is new).' },
    model: { type: 'string', description: 'Optional model in provider/model form (e.g. "opencode/big-pickle"). Prefer a -free model when the task does not need a frontier model. Omit to use the model chosen in the CLI Bridge settings panel, or (if unset there) opencode\'s own default.' },
    agent: { type: 'string', description: 'Optional opencode agent name (primary agents only; subagent names are rejected by opencode itself).' },
    cwd: { type: 'string', description: 'Working directory for opencode. Defaults to the DSH workspace root.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Optional file paths to attach to the message.' },
    title: { type: 'string', description: 'Optional session title (opencode truncates the prompt when omitted).' },
    timeoutSec: { type: 'integer', description: 'Execution timeout seconds (10-3600, default 600).' },
    autoApprove: { type: 'boolean', description: 'Default true: pass --auto so opencode auto-approves permissions and never blocks on a prompt. Set false to require explicit approval (opencode may then block and hit the timeout).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with opencode_status. Set false to block for the final answer.' }
  }
}
const CONTINUE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing opencode session. State only what is new; opencode preserves its session context.' },
    sessionId: { type: 'string', description: 'opencode session id to continue (from a prior opencode_run result).' },
    latest: { type: 'boolean', description: 'Continue the most recent opencode session instead of a specific id.' },
    model: { type: 'string', description: 'Optional model in provider/model form.' },
    agent: { type: 'string', description: 'Optional opencode agent name.' },
    cwd: { type: 'string', description: 'Working directory for opencode.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Optional file paths to attach.' },
    timeoutSec: { type: 'integer', description: 'Execution timeout seconds (10-3600, default 600).' },
    autoApprove: { type: 'boolean', description: 'Default true: pass --auto. Set false to require explicit approval.' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with opencode_status. Set false to block for the final answer.' }
  }
}
const STATUS_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }

// opencode_models（附加工具）：列出本机 opencode 可用模型（免费模型优先展示）。
const MODELS_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    freeOnly: { type: 'boolean', description: 'Return only free models (id ends with -free). Default false = all.' },
    provider: { type: 'string', description: 'Optional provider filter, e.g. "opencode" or "opencode-go".' }
  }
}
const MODELS_DESCRIPTION = 'List the models available to the local opencode CLI (from `opencode models`). Returns { ok, models: [{id, provider, name, free}], count }. Use this to pick a model before opencode_run, or to check which models are free. Prefer a -free model for routine work and reserve paid/frontier models for tasks that genuinely need them. If the CLI is missing or not logged in, this returns ok:false with an actionable error — it never silently invents a model list.'

function renderModels(value) {
  const v = value || {}
  if (!v.ok) return [{ type: 'text', text: 'opencode_models failed: ' + String(v.error || 'unknown') }]
  const list = Array.isArray(v.models) ? v.models : []
  if (!list.length) return [{ type: 'text', text: 'opencode_models: no models returned' }]
  const lines = ['opencode models (' + list.length + '):']
  for (const m of list.slice(0, 40)) lines.push('  ' + m.id + (m.free ? '  [free]' : ''))
  if (list.length > 40) lines.push('  … and ' + (list.length - 40) + ' more')
  const free = list.filter((m) => m.free).length
  lines.push('free: ' + free + ' / ' + list.length)
  return [{ type: 'text', text: lines.join('\n') }]
}

function defineProvider (deps = {}) {
  const env = deps.env || {}
  let host = null
  let settingsRef = { binPath: '', defaultModel: '', defaultAgent: '' }

  /**
   * 取当前生效的偏好设置。三条来源按优先级合并，每次 buildArgv 都重新读 ——
   * 面板改默认模型后无需重启即生效：
   *   1) `host.getSettings('opencode')` —— preset/dynamic 形态（attach 时由宿主注入）；
   *   2) `deps.readSettings()` —— MCP 形态（真 Node 进程，每次现读设置文件）；
   *   3) `settingsRef` —— attach 时固化的一次性快照 / 缺省值。
   * 三条都拿不到 → 缺省空值（= 不传 --model，交给 opencode 自身配置决定）。
   *
   * 历史坑：MCP 形态不 attach（自建 engine），只认 host.getSettings 会让面板设置的
   * defaultModel 在 MCP 面对 opencode_run 完全失效 —— 只有 args.model 才落地。
   * 三个形态行为不一致是缺陷，故此处统一把 readSettings 纳入（与 mimo 同构）。
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
        const s = host.getSettings('opencode')
        if (s && typeof s === 'object') Object.assign(out, s)
      }
    } catch (e) { }
    return out
  }

  const descriptor = {
    id: 'opencode', label: 'OPENCODE', presetId: 'opencode-first', defaultBackend: null, defaultMode: 'auto',
    exeName: 'opencode-cli', binEnvVars: ['OPENCODE_BIN', 'OPENCODE_CLI'], unavailableStatus: 'OPENCODE_UNAVAILABLE',

    // 单后端：opencode 自身选择 provider/model，桥不引入第二后端概念。
    backends() { return null },
    normalizeBackend() { return null },
    resolveBackend(args, target, preferred) { return null },

    // 实测 flag 集（V2.0.29）。
    buildArgv(exePrefix, args, opts) {
      const o = opts || {}
      const argv = Array.isArray(exePrefix) ? exePrefix.slice() : [String(exePrefix)]
      argv.push('run', String(args.prompt), '--format', 'json')
      if (args.autoApprove !== false) argv.push('--auto')
      const timeoutSec = clampInt(args.timeoutSec, 600, 10, 3600)
      // 模型优先级：调用参数 > 设置面板 defaultModel > 不传（交给 opencode 自身默认）。
      // 用户要求「不设默认 → 由 opencode 自决」，故 settingsRef.defaultModel 为空时不落地 --model。
      const model = args.model || currentSettings().defaultModel || ''
      if (model) argv.push('--model', String(model))
      const agent = args.agent || currentSettings().defaultAgent || ''
      if (agent) argv.push('--agent', String(agent))
      if (args.title) argv.push('--title', String(args.title))
      if (Array.isArray(args.files)) for (const f of args.files) { if (f) argv.push('--file', String(f)) }
      if (args.sessionId) argv.push('--session', String(args.sessionId))
      else if (args.continueLatest) argv.push('--continue')
      return { argv, mode: 'auto', timeoutSec }
    },

    // JSONL（每行一个 JSON 对象）。事件 type 取自 CLI 源码 emit 全集（实测一致）：
    // step_start / text / reasoning / tool_use / step_finish / error。
    // ⚠️ 不存在 result/complete/init 事件 —— 终止判据是「进程退出码」，不是某个终态事件。
    // ⚠️ 文本与统计在【不同】事件里：text.part.text 是回复正文，step_finish.part 只有
    //    cost/tokens。若直接取 step_finish 会得到「成功但正文为空」的结果。
    // ⚠️ 因此必须【正向】扫完整个流再决策：倒序会在读到 text 之前就命中末尾的
    //    step_finish 并返回，回填永远为空（第一版实现的真实 bug）。
    //   实测一次真实调用只产生 step_start + text（无 step_finish）—— 末段 text 兜底
    //   是活的必经分支，不是死代码。
    // 决策优先级：error > step_finish > 末段 text > 末条事件；命中前两者时把末段文本
    // 回填进 part.text，让 buildResult 统一从 part.text 读正文。
    // 无 JSON 时返回 null，由 buildResult 走纯文本兜底（绝不假造 status）。
    parseJson(stdoutText) {
      const trimmed = String(stdoutText || '').trim()
      if (!trimmed) return null
      const lines = trimmed.split(/\r?\n/).filter(Boolean)
      let lastText = null
      let lastTextStr = ''
      let terminal = null
      let fallback = null
      for (const raw of lines) {
        const ln = raw.trim()
        if (!ln.startsWith('{')) continue
        let obj
        try { obj = JSON.parse(ln) } catch (e) { continue }
        if (!obj || typeof obj !== 'object') continue
        const part = obj.part && typeof obj.part === 'object' ? obj.part : null
        if (obj.type === 'text' && part && typeof part.text === 'string') {
          lastText = obj
          lastTextStr = part.text
        } else if (obj.type === 'error') {
          terminal = obj
        } else if (obj.type === 'step_finish') {
          if (!terminal || terminal.type !== 'error') terminal = obj
        }
        fallback = obj
      }
      if (terminal) {
        const part = terminal.part && typeof terminal.part === 'object' ? terminal.part : null
        if (lastTextStr && !(part && typeof part.text === 'string')) {
          terminal.part = Object.assign({}, part || {}, { text: lastTextStr })
        }
        return terminal
      }
      return lastText || fallback
    },

    // 统一结果对象（契约 §1 buildResult 行）。
    // 事件负载一律在 part 里（CLI emit: {type,timestamp,sessionID,...data}，data = {part}）。
    // 终止判据 = exit code（0 成功 / 1 错误 / 130 SIGINT），不存在 result 事件可依赖。
    buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
      const exitCode = outcome ? outcome.exitCode : null
      const stderr = stderrText ? String(stderrText).slice(-2000) : ''
      if (parsed && typeof parsed === 'object') {
        const sessionId = typeof parsed.sessionID === 'string' ? parsed.sessionID
          : (typeof parsed.sessionId === 'string' ? parsed.sessionId : null)
        const part = parsed.part && typeof parsed.part === 'object' ? parsed.part : {}
        const errObj = parsed.error && typeof parsed.error === 'object' ? parsed.error : null
        const dataObj = errObj && errObj.data && typeof errObj.data === 'object' ? errObj.data : null
        const errMsg = dataObj && typeof dataObj.message === 'string' ? dataObj.message
          : (errObj && typeof errObj.message === 'string' ? errObj.message
            : (typeof parsed.error === 'string' ? parsed.error : ''))
        let response = ''
        if (typeof part.text === 'string') response = part.text
        else if (typeof parsed.response === 'string') response = parsed.response
        const isErrorEvent = parsed.type === 'error'
        let status
        if (exitCode === 130) status = 'ABORTED'
        else if (isErrorEvent) status = 'ERROR'
        else if (typeof parsed.status === 'string') status = parsed.status
        else status = exitCode === 0 ? 'SUCCESS' : 'ERROR'
        const tokens = part.tokens && typeof part.tokens === 'object' ? part.tokens : null
        let totalTokens = null
        if (tokens) {
          if (typeof tokens.total === 'number') totalTokens = tokens.total
          else if (typeof tokens.totalTokens === 'number') totalTokens = tokens.totalTokens
          else {
            let sum = 0
            let any = false
            for (const k of Object.keys(tokens)) {
              if (typeof tokens[k] === 'number') { sum += tokens[k]; any = true }
            }
            if (any) totalTokens = sum
          }
        }
        return {
          ok: exitCode === 0 && !isErrorEvent,
          status,
          response,
          sessionId,
          durationSeconds: null,
          numTurns: null,
          totalTokens,
          exitCode, mode, backend: backend || null,
          stderr: (stderr ? stderr + ' ' : '') + errMsg,
          cost: typeof part.cost === 'number' ? part.cost : null
        }
      }
      const text = String(stdoutText || '').trim()
      return {
        ok: exitCode === 0,
        status: exitCode === 0 ? 'SUCCESS' : 'ERROR',
        response: text,
        sessionId: null,
        durationSeconds: null, numTurns: null, totalTokens: null,
        exitCode, mode, backend: backend || null, stderr,
        rawStdout: text.slice(-2000)
      }
    },

    // 实时步骤折叠（写 project.current/trail）。
    // tool_use.part = { tool:"bash", state:{status,input,output,title,time}, … }
    // text.part     = { text:"…", time:{start,end} }
    foldStreamEvent(ev, p, summarizeArgs, maxArgLen, maxTrail) {
      if (!ev || typeof ev !== 'object') return
      const type = ev.type
      if (!type) return
      const part = ev.part && typeof ev.part === 'object' ? ev.part : {}
      p.updatedAt = Date.now()
      if (type === 'tool_use') {
        const tool = part.tool || part.name || 'tool'
        const st = part.state && typeof part.state === 'object' ? part.state : {}
        const args = summarizeArgs(st.input || part.input)
        const state = st.status === 'completed' ? 'DONE' : (st.status === 'failed' ? 'ERROR' : 'ACTIVE')
        const entry = { stepIndex: p.trail.length, state: state, tool: tool, args: args || null, at: nowIso() }
        p.trail.push(entry)
        const cap = maxTrail || 12
        if (p.trail.length > cap) p.trail.shift()
        if (p.current) p.current = null
      } else if (type === 'text' || type === 'reasoning') {
        const delta = typeof part.text === 'string' ? part.text : ''
        if (!delta) return
        const capLen = maxArgLen || 120
        p.current = { tool: type === 'reasoning' ? 'reasoning' : 'agent_response', args: { text_delta: String(delta).slice(0, capLen) }, stepIndex: p.trail.length, since: nowIso() }
      } else if (type === 'step_finish') {
        if (p.current) p.current = null
      }
    },

    isTransientCliError(res) {
      if (!res || res.ok) return false
      if (isLimited(res)) return false
      return res.status === 'ERROR_DURING_EXECUTION'
    },

    failureHint(res) {
      if (!res || res.ok) return ''
      const st = String(res.status || '')
      if (st === 'OPENCODE_UNAVAILABLE') return '[诊断] 未找到 opencode 可执行文件：请安装 OpenCode（桌面版自带 CLI），或在 CLI Bridge 设置面板填写 opencode 可执行文件路径。'
      const hay = String(res.stderr || '') + ' ' + String(res.response || '')
      if (/Incorrect API key|invalid_api_key|401|unauthorized|not logged|login/i.test(hay) && !/rate.?limit|quota|限流|额度/i.test(hay)) {
        return '[诊断] opencode 凭据问题（未登录 / API key 无效）：请让用户执行 `opencode auth login` 登录 provider。这不是限流。'
      }
      if (/No models available|no models|model not found|Unknown provider|not found.*model/i.test(hay)) {
        return '[诊断] opencode 没有可用模型或模型名无效：先用 opencode_models（或 `opencode models`）列出可用模型，再传 model。'
      }
      if (/quota|额度|exhausted|insufficient|credit|balance/i.test(hay)) {
        return '[诊断] opencode 额度可能耗尽：换一个（优先 -free）模型，或改用原生工具完成本任务。'
      }
      return ''
    },

    isSuccessStatus(st) { return st === 'SUCCESS' },

    tools: {
      run: { name: 'opencode_run', description: 'Dispatch a coding/build/debug/investigation task to the local opencode agent CLI and return its final answer. Prefer this for implementation, edits, refactors, multi-file investigation and debugging in every mode. DSH fully controls opencode: it always runs non-interactively with permissions auto-approved (opencode never blocks on a prompt). Use read-only native tools only for quick lookups and for final build/test verification. Runs in the background by default (returns a jobId immediately; collect with job_output); set background=false to block for the final answer.', inputSchema: RUN_PARAMS },
      continue: { name: 'opencode_continue', description: 'Continue an existing opencode session with a follow-up prompt, reusing opencode context. Pass sessionId from a prior opencode_run result, or set latest=true to continue the most recent opencode session. Same DSH-controlled, no-prompt execution as opencode_run.', inputSchema: CONTINUE_PARAMS },
      status: { name: 'opencode_status', description: 'Read a live snapshot of what the local opencode agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or agent_response thinking/typing), the recent step trail (tools executed, done/error), and the last completed run status + session id. Optional cwd filters to a single project. Call this to check on an in-flight opencode_run/opencode_continue without waiting for it to finish.', inputSchema: STATUS_PARAMS }
    },

    // opencode_models：宿主有 spawn 能力时注册（preset 注入 deps.process / MCP 注入
    // deps.nodeChild；dynamic 沙箱形态省略）。
    extraTools: (deps.process || deps.nodeChild) ? [{
      name: 'opencode_models',
      description: MODELS_DESCRIPTION,
      inputSchema: MODELS_PARAMS,
      render: renderModels,
      async logic(args) {
        return await descriptor.listModels(args || {})
      }
    }] : [],

    /**
     * 列出可用模型（三形态共用）。真实执行 `opencode models`；
     * CLI 缺失/未登录 → { ok:false, error }（绝不凭空造列表）。
     */
    async listModels(args) {
      const a = args || {}
      const child = deps.nodeChild
      if (!child || typeof child.spawn !== 'function') {
        // preset 形态：宿主 subprocess（attach 后可用）。
        if (!(host && host.subprocess)) return { ok: false, error: 'no spawn capability in this host form' }
      }
      const prefix = resolveExePrefix(env, currentSettings().binPath)
      const argv = prefix.slice(1).concat(['models'])
      const run = child && typeof child.spawn === 'function'
        ? spawnModelsNode(child, prefix[0], argv)
        : spawnModelsHost(argv)
      let res
      try { res = await run } catch (e) { return { ok: false, error: String(e && e.message || e) } }
      if (!res.ok) return res
      let list = res.models
      if (a.provider) {
        const pv = String(a.provider).toLowerCase()
        list = list.filter((m) => String(m.provider).toLowerCase() === pv)
      }
      if (a.freeOnly) list = list.filter((m) => m.free)
      // 免费模型优先展示（用户要求：优先用性能较好的免费模型），其次按字母序。
      list.sort((x, y) => (x.free === y.free ? String(x.id).localeCompare(String(y.id)) : (x.free ? -1 : 1)))
      return { ok: true, models: list, count: list.length }
    },

    // 设置分区：用户可选「用哪个 opencode（exe 路径）」+「默认模型」+「默认 agent」。
    settings: {
      keys: ['binPath', 'defaultModel', 'defaultAgent'],
      defaults: () => ({ binPath: '', defaultModel: '', defaultAgent: '' }),
      normalize: (raw) => {
        const r = raw && typeof raw === 'object' ? raw : {}
        const out = { binPath: '', defaultModel: '', defaultAgent: '' }
        for (const k of ['binPath', 'defaultModel', 'defaultAgent']) {
          if (typeof r[k] === 'string') out[k] = String(r[k]).trim()
        }
        return out
      },
      meta: (env2) => {
        const e = env2 && typeof env2 === 'object' ? env2 : {}
        const s = currentSettings()
        // 下拉选项：实时 `opencode models`（失败则退化为空 → 面板仍可自由输入）。
        const models = fetchModelsSync(e, s.binPath, 8000)
        const options = models.map((m) => ({ value: m.id, label: m.id + (m.free ? '  [free]' : '') }))
        // 默认给「可用 exe 路径」的下拉候选（env 覆盖 > 桌面版探测）。
        const exeCandidates = []
        if (e.OPENCODE_BIN || e.OPENCODE_CLI) exeCandidates.push(String(e.OPENCODE_BIN || e.OPENCODE_CLI))
        for (const p of candidateExePaths(e)) if (exeCandidates.indexOf(p) < 0) exeCandidates.push(p)
        return {
          titleSuffix: 'OpenCode',
          fields: [
            {
              key: 'binPath', label: 'opencode 可执行文件路径', type: 'select', allowCustom: true,
              options: exeCandidates.map((p) => ({ value: p, label: p })),
              placeholder: '留空 = 自动探测桌面版 / PATH',
              note: '检测到 ' + exeCandidates.length + ' 个候选；也可手动粘贴任意路径（含 .mjs 会经 node 启动）。'
            },
            {
              key: 'defaultModel', label: '默认模型', type: 'select', allowCustom: true,
              options: options,
              placeholder: '留空 = 由 opencode 自身配置决定',
              note: options.length
                ? '共 ' + options.length + ' 个可用模型，免费模型已排在前面（[free]）。调用时传 model 可覆盖本项。'
                : '未能读取模型列表（CLI 未安装/未登录/超时）—— 仍可手动输入 provider/model。'
            },
            {
              key: 'defaultAgent', label: '默认 agent', type: 'select', allowCustom: true,
              options: [{ value: 'build', label: 'build（默认，全权限）' }, { value: 'plan', label: 'plan（只读）' }],
              placeholder: '留空 = opencode 默认 agent',
              note: 'opencode 只接受 primary agent；subagent 名会被 opencode 自身拒绝并回退。'
            }
          ]
        }
      },
      diagnose: (settings, env2) => {
        const s = settings && typeof settings === 'object' ? settings : {}
        const e = env2 && typeof env2 === 'object' ? env2 : {}
        const bits = []
        const found = candidateExePaths(e)
        if (s.binPath) bits.push('bin=设置:' + s.binPath)
        else if (e.OPENCODE_BIN || e.OPENCODE_CLI) bits.push('bin=env:' + (e.OPENCODE_BIN || e.OPENCODE_CLI))
        else if (found.length) bits.push('bin=桌面版:' + found[0].split(/[\\/]/).slice(-3).join('/'))
        else bits.push('bin=PATH:opencode-cli')
        bits.push(s.defaultModel ? 'model=' + s.defaultModel : 'model=(opencode 自决)')
        if (s.defaultAgent) bits.push('agent=' + s.defaultAgent)
        return bits.join(' · ')
      }
    },

    mcp: { version: '0.2.2' }
  }

  // MCP/测试形态：真 child_process。
  function spawnModelsNode(child, exe, argv) {
    return new Promise((resolve) => {
      let c
      try { c = child.spawn(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
      catch (e) { resolve({ ok: false, error: 'spawn: ' + String(e && e.message || e) }); return }
      let out = ''
      let err = ''
      const timer = setTimeout(() => { try { c.kill() } catch (e) {} }, 15000)
      c.stdout.on('data', (d) => { out += d })
      c.stderr.on('data', (d) => { err += d })
      c.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: 'spawn: ' + String(e && e.message || e) }) })
      c.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) { resolve({ ok: false, error: '`opencode models` exited ' + code + ': ' + String(err || out).slice(0, 300) }); return }
        const list = parseModelList(out)
        if (!list.length) { resolve({ ok: false, error: 'no models parsed from output: ' + String(out).slice(0, 200) }); return }
        resolve({ ok: true, models: list })
      })
    })
  }

  // preset 形态：DSH subprocess。
  async function spawnModelsHost(argv) {
    try {
      const spec = { argv: [resolveExePrefix(env, currentSettings().binPath)[0]].concat(argv), stdio: { stdin: 'ignore', stdout: { maxBytes: 1000000 }, stderr: { maxBytes: 200000 } }, graceMs: 5000 }
      if (deps.process && typeof deps.process.cwd === 'function') spec.cwd = deps.process.cwd()
      const handle = host.subprocess.spawn(spec)
      const outcome = await handle.done
      const stdoutText = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
      const stderrText = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
      if (!outcome || outcome.exitCode !== 0) return { ok: false, error: '`opencode models` exited ' + (outcome && outcome.exitCode) + ': ' + String(stderrText || stdoutText).slice(0, 300) }
      const list = parseModelList(stdoutText)
      if (!list.length) return { ok: false, error: 'no models parsed from output: ' + String(stdoutText).slice(0, 200) }
      return { ok: true, models: list }
    } catch (e) { return { ok: false, error: String(e && e.message || e) } }
  }

  descriptor.runToolLogic = async function (args, exec) {
    const a = args || {}
    const normalized = a.background === undefined ? Object.assign({}, a, { background: true }) : a
    return this.runner.coreExecute(normalized, exec)
  }
  descriptor.continueToolLogic = async function (args, exec) {
    const a = args || {}
    const mapped = {
      prompt: a.prompt, model: a.model, agent: a.agent,
      cwd: a.cwd, files: a.files, timeoutSec: a.timeoutSec, autoApprove: a.autoApprove,
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
    // 宿主注入 getSettings 时才能把面板偏好带进 buildArgv（preset/dynamic 形态）。
    try {
      if (typeof host.getSettings === 'function') {
        const s = host.getSettings('opencode')
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


const SCHED_ALL_IDS = ["agy","codebuddy","mimo","opencode"]


return {
  inject: ['tools', 'subprocess', 'systemPrompt', 'timer'],
  apply(ctx) {
    // 调度门禁（0.2.0）：设置面板关掉 opencode → 本形态不注册工具/政策段；fail-open。
    if (!isBridgeEnabled('opencode', SCHED_ALL_IDS)) return
    const subprocess = ctx.subprocess
    const sandboxPolicy = ctx.get('sandboxPolicy')
    // 沙箱可能运行在无 process 的环境：typeof 守卫读 env（旧仓 dynamic 的等价面）。
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}

    const provider = defineProvider({ env })

    function publish(snapshot) {
      try {
        const collector = ctx.get('cliBridgeCollector')
        if (collector && typeof collector.mergeSnapshot === 'function') { collector.mergeSnapshot('opencode', snapshot); return }
      } catch (e) { /* fall through to legacy alias */ }
      try {
        const legacy = ctx.get('opencodeCollector')
        if (legacy && typeof legacy.mergeSnapshot === 'function') legacy.mergeSnapshot(snapshot)
      } catch (e) { /* 灯数据尽力而为 */ }
    }

    // exe 优先级（与描述符同一套）：env OPENCODE_BIN/OPENCODE_CLI > 桌面版 V2 探测
    // > PATH 查找 opencode-cli（subprocess.resolveExecutable）。
    // 二进制名 opencode-cli（V2 桌面版），不做 opencode.exe 兜底（V1/V2 不能并存）。
    const exeCandidates = resolveExePrefix(env, '')
    async function resolveExe(backend, signal) {
      for (const c of exeCandidates) {
        if (/\.(mjs|cjs|js)$/i.test(c) && typeof process !== 'undefined' && process.execPath) return [process.execPath, c]
        return c
      }
      return await subprocess.resolveExecutable('opencode-cli', undefined, signal)
    }

    // cwd 兜底：OPENCODE_MCP_CWD > sandboxPolicy.workspaceRoot > process.cwd() > '.'。
    function getCwdFallback() {
      if (env.OPENCODE_MCP_CWD) return String(env.OPENCODE_MCP_CWD)
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

    // 浏览器指示灯轮询的 RPC 面（旧 dynamic/handle('<id>_status') verbatim 语义）。
    harness.handle('opencode_status', function () { return provider.statusToolLogic({}) })

    const policyText = [
      'opencode-first execution policy (local opencode CLI bridge).',
      '',
      'Local agent CLI "opencode" handles coding tasks under full DSH control (permissions auto-approved, never blocks on a prompt). By default, opencode runs in the background and returns a jobId immediately; collect results via job_output and watch live progress via opencode_status anytime.',
      '',
      'Decision table for tool selection:',
      '- Single read/glob/grep or short (<30s) command -> Native tools.',
      '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> opencode_run.',
      '- Follow-ups on the same topic -> opencode_continue (with latest=true or sessionId; opencode preserves session context).',
      '- Final build/test verification of opencode output -> Native tools.',
      '',
      'Context protocol (one topic = one opencode session):',
      '- First dispatch on a topic: provide the task with a compact CONTEXT preamble (point to paths, do not paste file contents):',
      '  CONTEXT: 2-6 lines — goal; repo root; key paths; decisions/constraints; current state.',
      '  TASK: the complete instruction.',
      '- Follow-ups: call opencode_continue and state only what is new.',
      '',
      'Execution & Fallback protocol:',
      '- Dispatch defaults to background=true (set background=false only to block). Collect via job_output.',
      '- On rate-limit or network failure, a confirmation dialog opens in BOTH foreground and background while in flight.',
      '- If result has fallback=true (status FALLBACK_TO_DSH), the user chose DSH-local: finish with native tools and NEVER call opencode again for this task.',
      '- Never loop opencode calls; never ask opencode to call back into DSH.',
      '',
      'Model & credentials:',
      '- Prefer a free model for routine work: pass a model id ending in -free (e.g. "opencode/nemotron-3-ultra-free") unless this task genuinely needs a frontier model.',
      '- Omit the model unless you have a reason: opencode then uses its own configured default (or the one chosen in CLI Bridge settings). Pass model in provider/model form to override.',
      '- Credentials are owned by opencode, not by this bridge: auth/API-key failures mean the user should run `opencode auth login`. Do not retry in a loop.'
    ].join('\n')

    ctx.systemPrompt.section({
      name: 'opencode:policy',
      order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
      text: policyText
    })
  }
}
