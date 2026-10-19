// dynamic/agy.host.template.mjs — agy 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=agy）把 core/bridge-kit.mjs 与
// providers/agy.mjs 分别内联进下方两个占位标记行（各占一行、行内仅此标记），
// 生成 dynamic/agy.host.js。注意：标记字面量绝不能出现在本注释里 —— 构建做全局
// 替换，注释中出现同样会被替换成正文代码而炸掉语法。
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生
//    定时器 —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层
//    return 合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('agy', snap)
//    推给家级灯（旧 agyCollector 服务名在 keystone 里保留别名）；动态形态不宣告
//    mode（旧语义：普通模式灯仅在调用 agy 时临时显示）。
//  - agy_quota 与 5h 额度门禁在沙箱形态省略（deps 无 process/nodeChild → 描述符
//    静默降级；Lead 定案 4）。
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

// providers/agy.mjs — agy provider descriptor（真移植，替换 Lead 冒烟占位）。
//
// 移植基线：agy-first-bridge v1.7.1 preset/agy-first/agy-first-bridge.mjs 的内联逻辑
// （buildArgv / parseAgyJson / buildResult / foldStepUpdate / 额度门禁 / 三工具 schema），
// 语义逐字保持；与 provider 无关的骨架（状态引擎/行流/回退弹窗/展示层）在
// core/bridge-kit.mjs（PROVIDER-CONTRACT.md §1）。
//
// 红线（PROVIDER-CONTRACT.md §8 + Lead 定案）：
//  - 本文件会被 build 内联进 dynamic 沙箱（new Function）：绝不出现 import.meta 字面量；
//    process 只经 deps 注入或 typeof 守卫读取；宿主能力全部走 deps/attach(hostOpts)。
//  - 只允许 import '../core/bridge-kit.mjs'。
// import { createStatusEngine, createRunner, clampInt, isLimited } from '../core/bridge-kit.mjs'
// subprocess stdio 预算（与 bridge-kit createRunner 内部 stdio 一致；quota 脚本用）。
const STDIO = {
  stdin: 'ignore',
  stdout: { maxBytes: 4000000, spill: { maxBytes: 40000000 } },
  stderr: { maxBytes: 1000000, spill: { maxBytes: 8000000 } }
}

function nowIso() { return new Date().toISOString() }

// ── 三工具 schema（旧 preset verbatim；契约 §8：不许顺手改 schema）──────────────
const RUN_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The task instruction for agy. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — agy reads the repo itself). For follow-ups on the same topic, use agy_continue with latest=true or conversationId (agy keeps conversation context; state only what is new).' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'auto follows DSH plan state; plan = no writes; accept-edits = allow edits. Default auto.' },
    model: { type: 'string', description: 'Optional agy model id — pick from the Gemini pool or utility models per the model-selection policy (use agy_quota to see the recommended:true list). Do NOT pass a Claude/GPT (3p) model.' },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning effort.' },
    cwd: { type: 'string', description: 'Working directory for agy. Defaults to the DSH workspace root.' },
    addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to add to agy workspace.' },
    timeoutSec: { type: 'integer', description: 'Print timeout seconds (10-3600, default 600).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with agy_status. Set false to block for the final answer.' }
  }
}
const CONTINUE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing agy conversation. State only what is new; agy preserves its conversation context.' },
    conversationId: { type: 'string', description: 'agy conversation id to resume (from a prior agy_run result).' },
    latest: { type: 'boolean', description: 'Continue the most recent agy conversation instead of a specific id.' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'Execution mode; default auto.' },
    model: { type: 'string', description: 'Optional agy model id.' },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning effort.' },
    cwd: { type: 'string', description: 'Working directory for agy.' },
    timeoutSec: { type: 'integer', description: 'Print timeout seconds (10-3600, default 600).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with agy_status. Set false to block for the final answer.' }
  }
}
const STATUS_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }

// agy_quota（旧 preset quotaTool verbatim）：查 Google AI 套餐（Antigravity OAuth）池子额度。
const QUOTA_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { summary: { type: 'boolean', description: 'Return only a compact summary line (weekly buckets + top models).' } } }
const QUOTA_DESCRIPTION = 'Query the Google AI plan (Antigravity OAuth consumer) quota pool behind the local agy CLI. Reads the Windows credential manager entry (gemini:antigravity) that agy wrote at login, refreshes the access token, then calls Google Cloud Code quota APIs: fetchAvailableModels (per-model remaining pool percentage) and retrieveUserQuotaSummary (grouped plan buckets: weekly + 5h windows). Returns { ok, models: [{name, percentage, resetTime, displayName}], groups: [{displayName, buckets: [{bucketId, window, remainingFraction, resetTime}]}], tier }. GATING RULE: only the Gemini 5h window decides whether agy can run this task — agy_run/agy_continue already refuse silently below 10% of the 5h pool, so you normally do not need to pre-check. The weekly window is NOT a per-task gate: a drained weekly bucket only means agy is a poor choice for the rest of the week (pick another subagent or your own tools), never a reason to abort or shrink the current task. If the credential is missing the tool returns { ok:false, error } and agy_run still works normally.'

function renderQuota(args, value) {
  const v = value || {}
  if (!v.ok) return [{ type: 'text', text: 'agy_quota failed: ' + String(v.error || 'unknown') }]
  const lines = []
  lines.push('agy quota [tier=' + (v.tier || '?') + ']')
  if (Array.isArray(v.groups)) {
    for (const g of v.groups) {
      for (const b of (g.buckets || [])) {
        const pct = typeof b.remainingFraction === 'number' ? Math.round(b.remainingFraction * 100) : '?'
        lines.push('· ' + (b.bucketId || g.displayName || '') + ' [' + (b.window || '') + '] ' + pct + '%' + (b.resetTime ? ' reset=' + b.resetTime : ''))
      }
    }
  }
  if (Array.isArray(v.models) && v.models.length) {
    lines.push('models (pool %):')
    for (const m of v.models.slice(0, 10)) { lines.push('  ' + (m.displayName || m.name) + ' : ' + m.percentage + '%' + (m.recommended === false ? ' [3p: Claude/GPT 不推荐]' : '') + (m.resetTime ? ' (reset ' + m.resetTime + ')' : '')) }
    if (v.models.length > 10) lines.push('  … and ' + (v.models.length - 10) + ' more')
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function defineProvider (deps = {}) {
  const env = deps.env || {}
  let host = null // attach 后保存 hostOpts（preset/dynamic 形态提供 subprocess）
  let quotaCache = { at: 0, data: null } // 30 分钟缓存（旧 cachedQuotaCheck 语义）

  // ── 额度脚本执行（bin/agy-quota.mjs）─────────────────────────────────────────
  // 脚本定位（契约 §8 + Lead 定案 4）：CLI_BRIDGE_AGY_QUOTA > AGY_QUOTA_SCRIPT（旧兼容）
  // > deps.quotaScript（preset/MCP 宿主注入）。定位不到或无 spawn 能力 = 静默跳过门禁
  // （旧语义的宽容降级）。
  function quotaScriptPath() {
    return env.CLI_BRIDGE_AGY_QUOTA || env.AGY_QUOTA_SCRIPT || deps.quotaScript || null
  }
  function quotaCapable() {
    return !!quotaScriptPath() && !!(deps.nodeChild || (host && host.subprocess))
  }
  function execQuotaScript() {
    const scriptPath = quotaScriptPath()
    if (!scriptPath) return Promise.resolve({ ok: false, error: 'quota script not found (set CLI_BRIDGE_AGY_QUOTA or install the package bin/agy-quota.mjs)' })
    const node = (deps.process && deps.process.execPath) || 'node'
    if (deps.nodeChild) {
      // MCP/测试形态：真 child_process（旧 agy-mcp-server execQuota verbatim 语义）。
      return new Promise((resolve) => {
        let child
        try { child = deps.nodeChild.spawn(node, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
        catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); return }
        let out = ''
        let err = ''
        const timer = setTimeout(() => { try { child.kill() } catch (e) {} }, 60000)
        child.stdout.on('data', (d) => { out += d })
        child.stderr.on('data', (d) => { err += d })
        child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: 'spawn: ' + String(e && e.message || e) }) })
        child.on('close', (code) => {
          clearTimeout(timer)
          const m = out.match(/\{[\s\S]*\}/)
          if (!m) { resolve({ ok: false, error: 'no JSON output (exit=' + code + '): ' + (out + ' ' + err).slice(0, 300) }); return }
          try { resolve(JSON.parse(m[0])) } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }) }
        })
      })
    }
    if (host && host.subprocess) {
      // preset 形态：DSH subprocess（旧 preset execQuotaScript verbatim 语义）。
      return (async () => {
        try {
          const spec = { argv: [node, scriptPath], stdio: STDIO, graceMs: 5000 }
          if (deps.process && typeof deps.process.cwd === 'function') spec.cwd = deps.process.cwd()
          const handle = host.subprocess.spawn(spec)
          const outcome = await handle.done
          const stdoutText = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
          const stderrText = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
          const jsonMatch = String(stdoutText || '').match(/\{[\s\S]*\}/)
          if (!jsonMatch) return { ok: false, error: 'no JSON output (exit=' + (outcome && outcome.exitCode) + '): ' + (String(stdoutText).slice(0, 200) || String(stderrText).slice(0, 200)) }
          try { return JSON.parse(jsonMatch[0]) } catch (e) { return { ok: false, error: 'parse error: ' + e.message } }
        } catch (e) { return { ok: false, error: String(e && e.message || e) } }
      })()
    }
    return Promise.resolve({ ok: false, error: 'no spawn capability in this host form' })
  }
  async function cachedQuotaCheck() {
    const now = Date.now()
    if (quotaCache.data && now - quotaCache.at < 30 * 60 * 1000) return quotaCache.data
    let res = null
    try { res = await execQuotaScript() } catch (e) { res = { ok: false, error: String(e && e.message || e) } }
    quotaCache = { at: now, data: res }
    return res
  }
  // 5h 硬阻断（旧 v1.5.13 门禁 verbatim）：Gemini 5h 桶 <10% → QUOTA_BLOCKED（静默，
  // 不弹窗）；周用量不参与单次任务判断。预检失败不阻塞调用。
  async function quotaGate5h(args, exec) {
    if (!quotaCapable()) return null
    let q = null
    try { q = await cachedQuotaCheck() } catch (e) { return null }
    if (!q || !q.ok) return null
    const fiveHBuckets = (q.groups || []).flatMap((g) =>
      (g.buckets || [])
        .filter((b) => b.window === '5h' && (String(b.bucketId || '').toLowerCase().includes('gemini') || String(g.displayName || '').toLowerCase().includes('gemini')))
        .map((b) => ({ bucketId: b.bucketId, remainingFraction: b.remainingFraction, resetTime: b.resetTime }))
    )
    const low5h = fiveHBuckets.find((b) => typeof b.remainingFraction === 'number' && b.remainingFraction < 0.10)
    if (!low5h) return null
    let mode = (args && args.mode) || 'auto'
    if (mode === 'auto') {
      let planActive = false
      try { if (host && typeof host.planActiveFor === 'function') planActive = !!host.planActiveFor(exec) } catch (e) {}
      mode = planActive ? 'plan' : 'accept-edits'
    }
    return {
      ok: false, status: 'QUOTA_BLOCKED', response: '', conversationId: null, sessionId: null,
      durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode, backend: null,
      stderr: 'agy blocked: Gemini 5h pool quota < 10% (' + Math.round(low5h.remainingFraction * 100) + '%, reset ' + (low5h.resetTime || '?') + '). Use native tools; do not call agy.'
    }
  }

  const descriptor = {
    id: 'agy', label: 'AGY', presetId: 'cordis-agy', defaultBackend: null, defaultMode: 'auto',
    exeName: 'agy', binEnvVars: ['AGY_BIN', 'AGY_CLI'], unavailableStatus: 'AGY_UNAVAILABLE',

    // 单后端：backends() 恒 null；'agy'/'antigravity' 是历史别名，归一为 null；
    // 非法值同样返回 null（契约 §1：非法输入返回 null）。会话路由由 engine.resolveTarget
    // 完成（agy 的 backend 恒 null）。
    backends() { return null },
    normalizeBackend(v) {
      if (v === undefined || v === null) return null
      const s = String(v).trim().toLowerCase()
      if (s === '' || s === 'agy' || s === 'antigravity') return null
      return null
    },
    resolveBackend(args, target, preferred) { return null },

    // 旧 preset buildArgv(exe, args, planActive) verbatim 语义（execPrefix 可为
    // [nodeExe, binPath] 数组，runner 已归一）。
    buildArgv(exePrefix, args, opts) {
      const o = opts || {}
      const argv = Array.isArray(exePrefix) ? exePrefix.slice() : [String(exePrefix)]
      argv.push('-p', String(args.prompt), '--output-format', 'stream-json', '--dangerously-skip-permissions')
      const timeoutSec = clampInt(args.timeoutSec, 600, 10, 3600)
      argv.push('--print-timeout', timeoutSec + 's')
      let mode = args.mode || 'auto'
      if (mode === 'auto') mode = o.planActive ? 'plan' : 'accept-edits'
      if (mode === 'plan' || mode === 'accept-edits') argv.push('--mode', mode)
      if (args.model) argv.push('--model', String(args.model))
      if (args.effort) argv.push('--effort', String(args.effort))
      if (Array.isArray(args.addDirs)) for (const d of args.addDirs) { if (d) argv.push('--add-dir', String(d)) }
      if (args.conversationId) argv.push('--conversation', String(args.conversationId))
      else if (args.continueLatest) argv.push('--continue')
      return { argv, mode, timeoutSec }
    },

    // 旧 parseAgyJson verbatim：末 result 事件优先，容忍杂日志与整串 JSON。
    parseJson(stdoutText) {
      const trimmed = String(stdoutText || '').trim()
      if (!trimmed) return null
      const lines = trimmed.split(/\r?\n/).filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i].trim()
        if (!ln.startsWith('{')) continue
        try {
          const obj = JSON.parse(ln)
          if (obj && obj.event === 'result' && obj.result) return obj.result
          if (obj && obj.status && obj.response !== undefined) return obj
        } catch (e) {}
      }
      try { return JSON.parse(trimmed) } catch (e) {}
      return null
    },

    // 旧 buildResult verbatim + backend 字段 + sessionId/conversationId 双写
    //（agy 的会话字段名旧包是 conversationId；新契约统一 sessionId，两键同值以兼容
    //  旧 status 面板/测试与 keystone engine.end 的会话登记）。
    buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
      const exitCode = outcome ? outcome.exitCode : null
      // agy 超时/错误时信息在 result.error 字段（如 "timeout waiting for response"），
      // 必须并入 stderr 供 isLimited 归类（旧 v1.5.8 修复：网络挂起不再静默 FAILED）。
      const errText = parsed && typeof parsed.error === 'string' && parsed.error ? parsed.error : ''
      const stderr = (stderrText ? String(stderrText).slice(-2000) : '') + (errText ? (stderrText ? ' ' : '') + errText : '')
      if (parsed) {
        const conversationId = typeof parsed.conversation_id === 'string' ? parsed.conversation_id : null
        return {
          ok: exitCode === 0 && parsed.status === 'SUCCESS',
          status: typeof parsed.status === 'string' ? parsed.status : (exitCode === 0 ? 'UNKNOWN' : 'ERROR'),
          response: typeof parsed.response === 'string' ? parsed.response : '',
          conversationId,
          sessionId: conversationId,
          durationSeconds: typeof parsed.duration_seconds === 'number' ? parsed.duration_seconds : null,
          numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
          totalTokens: parsed.usage && typeof parsed.usage.total_tokens === 'number' ? parsed.usage.total_tokens : null,
          exitCode, mode, backend: backend || null, stderr
        }
      }
      return {
        ok: false, status: 'PARSE_ERROR', response: '',
        conversationId: null, sessionId: null,
        durationSeconds: null, numTurns: null, totalTokens: null,
        exitCode, mode, backend: backend || null, stderr,
        rawStdout: String(stdoutText || '').slice(-2000)
      }
    },

    // 旧 foldStepUpdate verbatim（step_update → project.current/trail）。
    // bridge-kit foldEvent 对每行 JSON 都调本函数，故这里自判 event==='step_update'。
    foldStreamEvent(ev, p, summarizeArgs, maxArgLen, maxTrail) {
      if (!ev || ev.event !== 'step_update') return
      const s = ev.step_update
      if (!s) return
      p.updatedAt = Date.now()
      if (s.step_type === 'tool') {
        const tool = s.tool_name || (s.tool_info && s.tool_info.name) || 'tool'
        const args = summarizeArgs(s.tool_info && s.tool_info.parameters)
        const entry = { stepIndex: s.step_index, state: s.state, tool: tool, args: args || null, at: nowIso() }
        p.trail.push(entry)
        const cap = maxTrail || 12
        if (p.trail.length > cap) p.trail.shift()
        if (s.state === 'ACTIVE') { p.current = { tool: tool, args: args || null, stepIndex: s.step_index, since: nowIso() } }
        else if (p.current && p.current.stepIndex === s.step_index) { p.current = null }
      } else if (s.step_type === 'agent_response' && s.state === 'ACTIVE' && s.text_delta) {
        const capLen = maxArgLen || 120
        p.current = { tool: 'agent_response', args: { text_delta: String(s.text_delta).slice(0, capLen) }, stepIndex: s.step_index, since: nowIso() }
      }
    },

    // 旧 agy 仓无此概念（codebuddy v1.1.4 引入）；保守版对齐 bridge-kit 语义：
    // CLI 自报 error_during_execution 且非限流/网络类 → 静默重试一次。
    isTransientCliError(res) {
      if (!res || res.ok) return false
      if (isLimited(res)) return false
      return res.status === 'ERROR_DURING_EXECUTION'
    },

    // 失败指引（契约 §1；定案：401/OAuth 类指引 agy login，额度类指引 agy_quota）。
    failureHint(res) {
      if (!res || res.ok) return ''
      const st = String(res.status || '')
      if (st === 'QUOTA_BLOCKED') return '[诊断] agy 未调用（Gemini 5h 池子额度 <10%）：请直接用原生工具完成本任务，本任务内不要再调 agy。'
      if (st === 'AGY_UNAVAILABLE') return '[诊断] 未找到 agy 可执行文件：请安装 agy CLI，或设置 AGY_BIN 指向其绝对路径。'
      const hay = String(res.stderr || '') + ' ' + String(res.response || '')
      if (/invalid_grant|unauthorized|401|not logged|login|oauth/i.test(hay) && !/rate.?limit|quota|限流|额度/i.test(hay)) {
        return '[诊断] agy 登录态/OAuth 凭据问题：请让用户在本机执行 `agy login` 重新登录后再试；可用 agy_quota 核对凭据与额度。这不是限流。'
      }
      if (/quota|额度|exhausted|insufficient|credit|balance/i.test(hay)) {
        return '[诊断] agy 池子额度可能耗尽：用 agy_quota 查看各池子余量（Gemini 5h 是唯一任务级门禁）；5h 低则改用原生工具完成本任务，不要循环调用 agy。'
      }
      return ''
    },

    isSuccessStatus(st) { return st === 'SUCCESS' },

    tools: {
      run: { name: 'agy_run', description: 'Dispatch a coding/build/debug/investigation task to the local agy agent CLI and return its final answer. Prefer this for implementation, edits, refactors, multi-file investigation and debugging in every mode. DSH fully controls agy: it always runs non-interactively with permissions auto-approved (agy never prompts). Use read-only native tools only for quick lookups and for final build/test verification. In mode=auto the DSH plan state decides agy plan vs accept-edits. Runs in the background by default (returns a jobId immediately; collect with job_output); set background=false to block for the final answer.', inputSchema: RUN_PARAMS },
      continue: { name: 'agy_continue', description: 'Continue an existing agy conversation with a follow-up prompt, reusing agy context. Pass conversationId from a prior agy_run result, or set latest=true to continue the most recent agy conversation. Same DSH-controlled, no-prompt execution as agy_run.', inputSchema: CONTINUE_PARAMS },
      status: { name: 'agy_status', description: 'Read a live snapshot of what the local agy agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or agent_response thinking/typing), the recent step trail (tools executed, done/error), and the last completed run status + conversation id. Optional cwd filters to a single project. Call this to check on an in-flight agy_run/agy_continue without waiting for it to finish.', inputSchema: STATUS_PARAMS }
    },

    // agy_quota 仅在宿主有 spawn 能力时注册（preset 注入 deps.process / MCP 注入
    // deps.nodeChild；dynamic 沙箱形态省略 —— Lead 定案 4）。
    extraTools: (deps.process || deps.nodeChild) ? [{
      name: 'agy_quota',
      description: QUOTA_DESCRIPTION,
      inputSchema: QUOTA_PARAMS,
      render: renderQuota,
      async logic(args) {
        const a = args || {}
        const res = await execQuotaScript()
        if (res && res.ok && a.summary) {
          const weekly = (res.groups || []).flatMap((g) => (g.buckets || []).filter((b) => b.window === 'weekly').map((b) => ({ g: g.displayName, id: b.bucketId, pct: Math.round((b.remainingFraction || 0) * 100), reset: b.resetTime })))
          const top = (res.models || []).slice(0, 4).map((m) => (m.displayName || m.name) + ' ' + m.percentage + '%').join(', ')
          return { ok: true, summary: { weekly, topModels: top }, models: res.models, groups: res.groups, tier: res.tier }
        }
        return res
      }
    }] : [],

    // agy 无设置分区字段（契约 §3）。
    settings: {
      keys: [],
      defaults: () => ({}),
      normalize: () => ({}),
      meta: () => ({ fields: [] }),
      diagnose: () => ''
    },

    mcp: { version: '0.2.2' }
  }

  // 三形态共用的工具逻辑。签名保持不变（keystone 与队友按此接线）。
  descriptor.runToolLogic = async function (args, exec) {
    const a = args || {}
    // 旧 agy preset/dynamic 语义：background 默认 true（仅显式 false 才前台阻塞）。
    const normalized = a.background === undefined ? Object.assign({}, a, { background: true }) : a
    const block = await quotaGate5h(normalized, exec)
    if (block) return block
    return this.runner.coreExecute(normalized, exec)
  }
  descriptor.continueToolLogic = async function (args, exec) {
    const a = args || {}
    const mapped = { prompt: a.prompt, mode: a.mode, model: a.model, effort: a.effort, cwd: a.cwd, timeoutSec: a.timeoutSec, background: a.background === undefined ? true : a.background }
    const cid = a.conversationId || a.sessionId || null
    if (cid) {
      mapped.conversationId = cid
      mapped.sessionId = cid // keystone engine.resolveTarget 按 sessionId 路由 cwd
    } else if (a.latest) {
      mapped.continueLatest = true
    }
    const block = await quotaGate5h(mapped, exec)
    if (block) return block
    return this.runner.coreExecute(mapped, exec)
  }
  // 旧 statusTool.execute verbatim：cwd 过滤到单项目。
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
  // 供 MCP/测试形态直接复用门禁与额度执行。
  descriptor.quotaGate5h = quotaGate5h
  descriptor.execQuotaScript = execQuotaScript
  descriptor.cachedQuotaCheck = cachedQuotaCheck

  descriptor.attach = function (hostOpts) {
    host = hostOpts || {}
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


const SCHED_ALL_IDS = ["agy","codebuddy","mimo","opencode","claude","codex"]


return {
  inject: ['tools', 'subprocess', 'systemPrompt', 'timer'],
  apply(ctx) {
    // 调度门禁（0.2.0）：设置面板关掉 agy → 本形态不注册工具/政策段；fail-open。
    if (!isBridgeEnabled('agy', SCHED_ALL_IDS)) return
    const subprocess = ctx.subprocess
    const planMode = ctx.get('planMode')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    // 沙箱可能运行在无 process 的环境：typeof 守卫读 env（旧仓 dynamic 的等价面）。
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}

    const provider = defineProvider({ env })

    function publish(snapshot) {
      try {
        const collector = ctx.get('cliBridgeCollector')
        if (collector && typeof collector.mergeSnapshot === 'function') { collector.mergeSnapshot('agy', snapshot); return }
      } catch (e) { /* fall through to legacy alias */ }
      try {
        const legacy = ctx.get('agyCollector')
        if (legacy && typeof legacy.mergeSnapshot === 'function') legacy.mergeSnapshot(snapshot)
      } catch (e) { /* 灯数据尽力而为 */ }
    }

    // exe：AGY_BIN/AGY_CLI env > PATH 查找 agy（subprocess.resolveExecutable）。
    async function resolveExe(backend, signal) {
      const bin = env.AGY_BIN || env.AGY_CLI || ''
      if (bin) {
        if (/\.(mjs|cjs|js)$/i.test(bin) && typeof process !== 'undefined' && process.execPath) return [process.execPath, bin]
        return bin
      }
      return await subprocess.resolveExecutable('agy', undefined, signal)
    }

    // 旧仓 CWD_FALLBACK 硬编码机器绝对路径；新语义：AGY_MCP_CWD > workspaceRoot > '.'
    //（沙箱无 process.cwd 可用时以 '.' 交给宿主进程工作目录兜底）。
    function getCwdFallback() {
      if (env.AGY_MCP_CWD) return String(env.AGY_MCP_CWD)
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
      if (typeof process !== 'undefined' && typeof process.cwd === 'function') { try { return process.cwd() } catch (e) {} }
      return '.'
    }

    function planActiveFor(exec) {
      try {
        if (planMode && exec && exec.agent) {
          const st = planMode.get(exec.agent)
          return !!(st && st.active)
        }
      } catch (e) {}
      return false
    }

    provider.attach({ ctx, subprocess, resolveExe, getCwdFallback, planActiveFor, publish })

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

    // 浏览器指示灯轮询的 RPC 面（旧 dynamic/handle('agy_status') verbatim 语义）。
    harness.handle('agy_status', function () { return provider.statusToolLogic({}) })

    // 旧 policy 文案 verbatim（提示词连续性红线）。
    const policyText = [
      'agy-first execution policy (local agy CLI bridge).',
      '',
      'Local agent CLI "agy" handles coding tasks under full DSH control (permissions auto-approved, never prompts). By default, agy runs in the background and returns a jobId immediately; collect results via job_output and watch live progress via agy_status anytime.',
      '',
      'Decision table for tool selection:',
      '- Single read/glob/grep or short (<30s) command -> Native tools.',
      '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> agy_run.',
      '- Follow-ups on the same topic -> agy_continue (with latest=true or conversationId; agy preserves session context).',
      '- Final build/test verification of agy output -> Native tools.',
      '- Image/video generation -> agy_run WITHOUT picking a model (agy selects the appropriate model).',
      '',
      'Context protocol (one topic = one agy conversation):',
      '- First dispatch on a topic: provide the task with a compact CONTEXT preamble (point to paths, do not paste file contents):',
      '  CONTEXT: 2-6 lines — goal; repo root; key paths; decisions/constraints; current state.',
      '  TASK: the complete instruction.',
      '- Follow-ups: call agy_continue and state only what is new.',
      '',
      'Execution & Fallback protocol:',
      '- Dispatch defaults to background=true (set background=false only to block). Collect via job_output.',
      '- On rate-limit or network failure, a confirmation dialog opens in BOTH foreground and background while in flight.',
      '- If result has fallback=true (status FALLBACK_TO_DSH), the user chose DSH-local: finish with native tools and NEVER call agy again for this task.',
      '- If status is QUOTA_BLOCKED (Gemini 5h pool <10%), finish natively. Never loop agy calls; never ask agy to call back into DSH.',
      '',
      'Model selection & Quota guard:',
      '- The Gemini 5h pool (<10% threshold) is enforced automatically as the sole per-task gate; do NOT pre-call agy_quota before every dispatch. Call agy_quota only when you want to compare model availability.',
      '- Use Gemini pool (gemini-*) or utility models (tab_*, chat_*). Never pass Claude or GPT (3p) models.',
      '- Weekly quota is NOT a per-task gate: low weekly quota only informs future planning, never aborts current work.'
    ].join('\n')

    ctx.systemPrompt.section({
      name: 'agy:policy',
      order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
      text: policyText
    })
  }
}
