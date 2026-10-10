// dynamic/mimo.host.template.mjs — mimo 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=mimo）把 core/bridge-kit.mjs 与
// providers/mimo.mjs 分别内联进下方两个占位标记行（各占一行、行内仅此标记），
// 生成 dynamic/mimo.host.js。注意：标记字面量绝不能出现在本注释里 —— 构建做全局
// 替换，注释中出现同样会被替换成正文代码而炸掉语法。
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生
//    定时器 —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层
//    return 合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('mimo', snap)
//    推给家级灯（旧 mimoCollector 服务名在 keystone 里保留别名）；动态形态不宣告
//    mode（旧语义：普通模式灯仅在调用 mimo 时临时显示）。
//  - mimo-desktop 在沙箱的形态（契约 §9）：无 fs 发现 desktop-api.json，且多数沙箱
//    无 fetch —— 描述符 preflight 直接 abort 为 DESKTOP_UNREACHABLE 并提示改用
//    backend=mimocode（旧仓返回 DESKTOP_UNSUPPORTED 的替代；语义升级，Lead 定案）。
//    宿主若注入了 globalThis.fetch 且给出 MIMO_DESKTOP_PORT/MIMO_DESKTOP_TOKEN env，
//    委托 execute 仍可走通（fetch 路径全部 typeof 守卫）。
//  - mimo_settings 在沙箱不持久化（无 nodeFs → 描述符回显语义；旧 dynamic echo 形态）。
//  - exe 解析（旧动态候选无 existsSync 校验，盲取候选 [0] 易 spawn 失败）：升级走
//    agy 模板同款链路 —— MIMO_BIN/MIMO_CLI env > subprocess.resolveExecutable(PATH)。
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

// providers/mimo.mjs — mimo provider descriptor（真移植，替换 Lead 冒烟占位）。
//
// 移植基线：mimo-first-bridge v1.x Xiaomi MiMo-bridge 仓 core/mimo-core.mjs +
// core/runtime-settings.mjs + preset/mimo-first/mimo-first-bridge.mjs 的内联逻辑
// （双后端 mimocode/mimo-desktop、buildArgv/parseMimoJson/buildResult/桌面回合编排/
// 三工具 schema/mimo_settings），语义逐字保持；与 provider 无关的骨架（状态引擎/行流/
// 回退弹窗/展示层/超时护栏）在 core/bridge-kit.mjs（PROVIDER-CONTRACT.md §1）。
//
// 红线（PROVIDER-CONTRACT.md §8 + Lead 定案）：
//  - 本文件会被 build 内联进 dynamic 沙箱（new Function）：绝不出现 import.meta 字面量；
//    process/fs/child_process 只经 deps 注入或 typeof/globalThis 守卫读取；原生定时器
//    （setTimeout/AbortController）只在 typeof 守卫下使用（沙箱缺省时自动降级）。
//  - 只允许 import '../core/bridge-kit.mjs'。
//  - mimo-desktop 走本地 HTTP（非 spawn）：delegates(backend) 只认 desktop，execute 自己
//    复刻旧回合编排；mimocode 不写 execute 分支 → kit 通用 pipeline 带 jobs/重试/弹窗。

// ── 后端常量与别名归一（旧 mimo-core verbatim）────────────────────────────────
const BACKEND_MIMOCODE = 'mimocode'
const BACKEND_DESKTOP = 'mimo-desktop'
const BACKENDS = [BACKEND_MIMOCODE, BACKEND_DESKTOP]
const DEFAULT_BACKEND = BACKEND_MIMOCODE

// 旧 LIMIT_RE（比 kit 版多 free-API/登录/第三方等 MiMo 文案；provider.isLimited 覆盖）。
// 命名 MIMO_ 前缀：dynamic 内联时 kit 也声明顶层 LIMIT_RE，同名会在同一脚本作用域
// 触发「Identifier already declared」构建错误（scripts/build.mjs 文本拼接的固有约束）。
const MIMO_LIMIT_RE = /rate.?limit|ratelimit|429|too many|quota|insufficient|credit|balance|exhausted|exceed|network|offline|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|timeout|timed out|unavailable|503|502|500|401|403|unauthorized|invalid api|api key|connection|proxy|socket|tls|ssl|dns|free API service has ended|sign in|configure a third-party|网络|超时|限流|流量|受限|配额|金额|余额|额度|认证|连接|断开|登录|第三方/i

const DEFAULT_TIMEOUT_SEC = 600

// Desktop-local API 路径构造器（旧 DESKTOP_API verbatim）。
const DESKTOP_API = {
  healthPath: '/v1/health',
  sessionsPath: '/v1/sessions',
  turnsPath: (id) => '/v1/sessions/' + encodeURIComponent(String(id)) + '/turns',
  eventsPath: (id, dir) => '/v1/sessions/' + encodeURIComponent(String(id)) + '/events' + (dir ? ('?dir=' + encodeURIComponent(String(dir))) : '')
}

// 工具三件套 schema（旧 preset ctx.tools.register parameters verbatim，转 JSON Schema
// 形态对齐 agy 描述符约定；required 进顶层数组，其余字段语义逐字保持）。
const RUN_PARAMS = {
  type: 'object',
  additionalProperties: true,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The task instruction for mimo. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — mimo reads the repo itself). For follow-ups on the same topic, use mimo_continue with latest=true or sessionId (mimo keeps conversation context; state only what is new).' },
    mode: { type: 'string', enum: ['auto', 'plan', 'build', 'compose', 'accept-edits'], description: 'auto follows DSH plan state (plan vs build); plan = read-only analysis (--agent plan); build = full tools (--agent build); compose = compose workflow.' },
    backend: { type: 'string', enum: BACKENDS, description: 'Dispatch backend for THIS call only. Default comes from settings preselection (plugin config.backend / MIMO_BRIDGE_BACKEND / settings file): mimocode = local `mimo` CLI (MiMoCode); mimo-desktop = Xiaomi MiMo Desktop client local API. Prefer the preselected default; override only when necessary.' },
    model: { type: 'string', description: 'Optional mimo model id as provider/model (e.g. mimo/mimo). For mimo-desktop, desktop model id (e.g. mimo-auto).' },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning effort, mapped to mimo --variant (low→minimal, high→high). mimocode only.' },
    cwd: { type: 'string', description: 'Working directory for mimo (--dir / desktop directory).' },
    timeoutSec: { type: 'integer', description: 'Hard timeout seconds (10-3600, default 600). Grace +60s on top.' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with mimo_status. Set false to block for the final answer.' },
    // desktop 后端**不能创建会话**（API 对任意 id 都回 202 但不落库），所以必须能
    // 显式指定一个**已存在**的 Desktop 会话 id，否则每次都生成自造 id → 静默空操作。
    sessionId: { type: 'string', description: 'mimo-desktop only: id of an ALREADY EXISTING MiMo Desktop session (see the Desktop app). Omit for mimocode.' },
    title: { type: 'string', description: 'Optional session title.' }
  }
}
const CONTINUE_PARAMS = {
  type: 'object',
  additionalProperties: true,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing mimo session. State only what is new; mimo preserves its conversation context.' },
    sessionId: { type: 'string', description: 'mimo session id to resume (--session).' },
    latest: { type: 'boolean', description: 'Continue the most recent mimo session (--continue).' },
    backend: { type: 'string', enum: BACKENDS, description: 'Dispatch backend for THIS call only (see mimo_run.backend). Prefer the preselected default.' },
    mode: { type: 'string', enum: ['auto', 'plan', 'build', 'compose', 'accept-edits'], description: 'Execution mode.' },
    model: { type: 'string', description: 'Optional mimo model id as provider/model.' },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning effort.' },
    cwd: { type: 'string', description: 'Working directory for mimo.' },
    timeoutSec: { type: 'integer', description: 'Hard timeout seconds (10-3600, default 600).' },
    background: { type: 'boolean', description: 'Defaults to true (background job).' }
  }
}
const STATUS_PARAMS = { type: 'object', additionalProperties: true, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }
const SETTINGS_PARAMS = {
  type: 'object',
  additionalProperties: true,
  required: [],
  properties: {
    backend: { type: 'string', enum: BACKENDS, description: 'If set, save this as the default backend.' },
    desktopModel: { type: 'string', description: 'Optional desktop model id (mimo-desktop backend only), e.g. mimo-auto.' }
  }
}
const SETTINGS_DESCRIPTION = 'Read or change the preselected dispatch backend (settings). backend=mimocode (local mimo CLI / MiMoCode) or mimo-desktop (Xiaomi MiMo Desktop client). Call with only backend to set the default for subsequent mimo_run/mimo_continue; call with no args to read current settings. Persisted to the settings file; plugin config and MIMO_BRIDGE_BACKEND env still override when set.'

function renderSettings(value) {
  const s = value || {}
  const lines = [
    'mimo settings',
    '  settings file  : ' + (s.settingsPath || '(unknown)'),
    '  file backend   : ' + (s.fileBackend || '(unset)'),
    '  config backend : ' + (s.configBackend || '(unset)'),
    '  env backend    : ' + (s.envBackend || '(unset)'),
    '  effective      : ' + (s.effectiveBackend || '(unknown)'),
    '  desktop model  : ' + (s.desktopModel || '(default)'),
    '  desktop api    : ' + (s.desktopAvailable
      ? 'available' + (s.desktopApiFile ? ' (' + s.desktopApiFile + ')' : '')
      : 'unavailable' + (s.desktopError ? ' — ' + s.desktopError : '')),
    '  backends       : ' + ((Array.isArray(s.backends) && s.backends.length ? s.backends.join(' | ') : BACKENDS.join(' | ')))
  ]
  if (s.note) lines.push('  note           : ' + s.note)
  return [{ type: 'text', text: lines.join('\n') }]
}

// ── 可纯函数化的 mimo-core 语义（descriptor 方法 + 独立导出双份）───────────────
function normalizeBackend(v) {
  if (v == null || v === '') return null
  const s = String(v).trim().toLowerCase()
  if (s === 'mimocode' || s === 'mimo-code' || s === 'cli' || s === 'mimo-cli') return BACKEND_MIMOCODE
  if (s === 'mimo-desktop' || s === 'desktop' || s === 'mimo_desktop' || s === 'xiaomi-mimo' || s === 'xiaomi-mimo-desktop') return BACKEND_DESKTOP
  return null
}

function parseMimoJson(stdoutText) {
  const trimmed = String(stdoutText || '').trim()
  if (!trimmed) return null
  const MAX_ARG_LEN = 120
  const MAX_TRAIL = 12
  const events = []
  const lines = trimmed.split(/\r?\n/)
  for (const raw of lines) {
    const ln = raw.trim()
    if (!ln.startsWith('{')) continue
    try {
      const obj = JSON.parse(ln)
      if (obj && typeof obj === 'object') events.push(obj)
    } catch (e) { /* tolerate log lines */ }
  }
  if (!events.length) {
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj === 'object') events.push(obj)
    } catch (e) {
      return { events: [], text: trimmed, sessionId: null, error: null, steps: [] }
    }
  }
  let sessionId = null
  let text = ''
  let errorMessage = null
  let errorName = null
  let numTurns = 0
  let totalTokens = null
  const steps = []
  const textParts = []
  for (const ev of events) {
    if (ev.sessionID && typeof ev.sessionID === 'string') sessionId = ev.sessionID
    if (ev.sessionId && typeof ev.sessionId === 'string') sessionId = ev.sessionId
    if (ev.session && typeof ev.session === 'object' && ev.session.id) sessionId = ev.session.id
    if (ev.type === 'session' && ev.properties && ev.properties.id) sessionId = ev.properties.id
    const t = ev.type
    if (t === 'error') {
      const err = ev.error || ev.properties || {}
      errorMessage = (err.data && err.data.message) || err.message || err.name || 'error'
      errorName = err.name || 'Error'
    } else if (t === 'text' || t === 'message' || t === 'assistant' || t === 'output') {
      const p = ev.properties || ev
      const chunk = p.text || p.content || p.message || p.output || (typeof ev.text === 'string' ? ev.text : '')
      if (typeof chunk === 'string' && chunk) {
        textParts.push(chunk)
        steps.push({ at: Date.now(), kind: 'text', label: shortLabel(chunk) })
      }
    } else if (t === 'step-start' || t === 'step-finish' || t === 'step_update') {
      numTurns += 1
      const p = ev.properties || ev
      if (p.tokens && typeof p.tokens === 'object') {
        const tt = p.tokens.total ?? p.tokens.input ?? p.tokens.output
        if (typeof tt === 'number') totalTokens = (totalTokens || 0) + tt
      }
      if (t === 'step_update' && (p.tool_name || p.tool || p.name)) {
        steps.push({
          at: Date.now(),
          kind: 'tool',
          label: shortLabel((p.tool_name || p.tool || p.name) + ' ' + JSON.stringify(summarizeArgs(p.arguments || p.args || p.input) || {}))
        })
      }
    } else if (t === 'tool' || t === 'tool-call' || t === 'tool_use') {
      const p = ev.properties || ev
      const name = p.tool || p.name || p.tool_name || 'tool'
      steps.push({
        at: Date.now(),
        kind: 'tool',
        label: shortLabel(name + ' ' + JSON.stringify(summarizeArgs(p.arguments || p.args || p.input) || {}))
      })
    }
  }
  if (textParts.length) text = textParts.join('\n')
  else {
    const last = events[events.length - 1] || {}
    const r = last.result || last
    if (typeof r.response === 'string') text = r.response
    else if (typeof r.text === 'string') text = r.text
  }
  return { events, text, sessionId, error: errorMessage, errorName, numTurns, totalTokens, steps }
}

function buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
  const MAX_TRAIL = 12
  const exitCode = outcome ? outcome.exitCode : null
  const errText = (parsed && parsed.error) ? String(parsed.error) : ''
  const stderr = (stderrText ? String(stderrText).slice(-2000) : '') + (errText ? (stderrText ? ' ' : '') + errText : '')
  const text = parsed && typeof parsed.text === 'string' ? parsed.text : ''
  const failed = exitCode !== 0 || !!(parsed && parsed.error)
  const be = (parsed && parsed.backend) || (outcome && outcome.backend) || backend || null
  if (parsed) {
    return {
      ok: !failed && (!!text || parsed.accepted === true),
      status: failed ? (parsed.errorName || 'ERROR') : (parsed.accepted && !text ? 'ACCEPTED' : (text ? 'SUCCESS' : 'EMPTY')),
      response: text,
      sessionId: parsed.sessionId || null,
      durationSeconds: null,
      numTurns: parsed.numTurns || null,
      totalTokens: parsed.totalTokens || null,
      exitCode, mode, backend: be,
      stderr,
      errorMessage: parsed.error || '',
      accepted: parsed.accepted === true,
      steps: Array.isArray(parsed.steps) ? parsed.steps.slice(-MAX_TRAIL) : []
    }
  }
  return {
    ok: false, status: 'PARSE_ERROR', response: '', sessionId: null,
    durationSeconds: null, numTurns: null, totalTokens: null,
    exitCode, mode, backend: be, stderr, errorMessage: '',
    rawStdout: String(stdoutText || '').slice(-2000)
  }
}

function desktopResult(ok, opts) {
  const o = opts || {}
  return {
    ok: !!ok,
    fallback: false,
    status: o.status || (ok ? (o.accepted ? 'ACCEPTED' : 'SUCCESS') : 'ERROR'),
    response: o.response || '',
    sessionId: o.sessionId || null,
    durationSeconds: null,
    numTurns: null,
    totalTokens: null,
    exitCode: o.exitCode != null ? o.exitCode : (ok ? 0 : 1),
    mode: o.mode || 'auto',
    backend: BACKEND_DESKTOP,
    stderr: o.stderr || '',
    errorMessage: o.errorMessage || '',
    accepted: o.accepted === true,
    steps: []
  }
}

function buildDesktopTurnBody(args) {
  const a = args || {}
  const message = String(a.prompt != null ? a.prompt : (a.message != null ? a.message : ''))
  const model = String(a.model || a.desktopModel || 'mimo-auto')
  const body = { message, model }
  const directory = a.directory || a.cwd
  if (directory) body.directory = String(directory)
  return body
}

function newDesktopSessionId() {
  // ses_ + 18-ish random chars, same shape as Desktop API ids
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 18; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return 'ses_' + s
}

function extractDesktopText(j) {
  if (!j || typeof j !== 'object') return { text: '', sessionId: null, error: null }
  const sessionId = j.sessionID || j.sessionId || (j.session && j.session.id) || null
  if (j.type === 'error' || j.error) {
    const err = j.error || j
    const msg = (err.data && err.data.message) || err.message || err.name || 'error'
    return { text: '', sessionId, error: String(msg) }
  }
  let text = ''
  if (typeof j.text === 'string') text = j.text
  else if (typeof j.message === 'string') text = j.message
  else if (typeof j.content === 'string') text = j.content
  else if (typeof j.response === 'string') text = j.response
  else if (Array.isArray(j.parts)) {
    for (const p of j.parts) {
      if (p && typeof p.text === 'string') text += (text ? '\n' : '') + p.text
    }
  } else if (j.data && typeof j.data.text === 'string') text = j.data.text
  return { text, sessionId, error: null }
}

function parseDesktopEvents(stdoutOrJson) {
  const raw = String(stdoutOrJson || '').trim()
  if (!raw) return { text: '', sessionId: null, error: null }
  try {
    const j = JSON.parse(raw)
    return extractDesktopText(j)
  } catch (e) { }
  const texts = []
  for (const line of raw.split(/\r?\n/)) {
    const ln = line.trim()
    if (!ln.startsWith('{')) continue
    try {
      const r = extractDesktopText(JSON.parse(ln))
      if (r.text) texts.push(r.text)
      if (r.error) return { text: texts.join('\n'), sessionId: r.sessionId, error: r.error }
    } catch (e) { }
  }
  return { text: texts.join('\n'), sessionId: null, error: null }
}

function defineProvider (deps = {}) {
  const env = deps.env || {}
  const nodeFs = deps.nodeFs || null
  const nodePath = deps.nodePath || null

  // ── Desktop-local API discovery（旧 runtime-settings.loadRuntime 桌面段语义）───
  // fs 缺失（dynamic 沙箱）→ 只认 MIMO_DESKTOP_PORT/TOKEN env；都没有 → 不可用。
  function discoverDesktop() {
    const d = { available: false, baseUrl: null, token: null, apiFile: null, error: null }
    if (env.MIMO_DESKTOP_PORT && env.MIMO_DESKTOP_TOKEN) {
      return { available: true, baseUrl: 'http://127.0.0.1:' + env.MIMO_DESKTOP_PORT, token: String(env.MIMO_DESKTOP_TOKEN), apiFile: null, error: null }
    }
    const candidates = []
    if (env.MIMO_DESKTOP_API_FILE) candidates.push(env.MIMO_DESKTOP_API_FILE)
    const joinP = (...segs) => (nodePath ? nodePath.join(...segs) : segs.join('/'))
    if (env.APPDATA) candidates.push(joinP(env.APPDATA, 'Xiaomi MiMo', 'desktop-api.json'))
    if (env.HOME) {
      candidates.push(joinP(env.HOME, '.config', 'Xiaomi MiMo', 'desktop-api.json'))
      candidates.push(joinP(env.HOME, 'Library', 'Application Support', 'Xiaomi MiMo', 'desktop-api.json'))
    }
    if (!nodeFs) {
      d.error = 'desktop-api.json not readable (no fs in this host; set MIMO_DESKTOP_PORT/MIMO_DESKTOP_TOKEN)'
      return d
    }
    for (const p of candidates) {
      try {
        if (!p || !nodeFs.existsSync || !nodeFs.existsSync(p)) continue
        const j = JSON.parse(nodeFs.readFileSync(p, 'utf8'))
        if (j && j.port && j.token) {
          return { available: true, baseUrl: 'http://127.0.0.1:' + j.port, token: String(j.token), apiFile: p, error: null }
        }
      } catch (e) {
        d.error = String(e && e.message || e)
      }
    }
    if (!d.error) d.error = 'desktop-api.json not found (start Xiaomi MiMo Desktop)'
    return d
  }

  function fetchFn() {
    return (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') ? globalThis.fetch.bind(globalThis) : null
  }

  // desktopFetch（旧 runtime-settings verbatim；AbortController/setTimeout 守卫，
  // 沙箱缺省时退化为无超时 fetch —— 仍可用）。
  async function desktopFetch(method, path, body, timeoutMs) {
    const fetch = fetchFn()
    if (!fetch) { const e = new Error('fetch not available in this host'); e.code = 'DESKTOP_UNAVAILABLE'; throw e }
    const d = desktop
    if (!d || !d.available || !d.baseUrl) {
      const e = new Error('MiMo Desktop API unavailable: ' + (d && d.error || 'not configured'))
      e.code = 'DESKTOP_UNAVAILABLE'
      throw e
    }
    const url = d.baseUrl + path
    const ms = timeoutMs == null ? 8000 : timeoutMs
    let ctrl = null
    let timer = null
    const init = {
      method: method || 'GET',
      headers: { Authorization: 'Bearer ' + d.token, 'Content-Type': 'application/json' }
    }
    if (body != null) init.body = typeof body === 'string' ? body : JSON.stringify(body)
    if (typeof AbortController === 'function' && typeof setTimeout === 'function' && typeof clearTimeout === 'function') {
      ctrl = new AbortController()
      init.signal = ctrl.signal
      timer = setTimeout(() => { try { ctrl.abort() } catch (e) {} }, ms)
    }
    try {
      const res = await fetch(url, init)
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch (e) { }
      return { status: res.status, ok: res.ok, text, json }
    } finally {
      if (timer != null) clearTimeout(timer)
    }
  }

  async function desktopHealth() {
    try {
      const r = await desktopFetch('GET', DESKTOP_API.healthPath)
      return { ok: r.ok, status: r.status, body: r.json || r.text }
    } catch (e) {
      return { ok: false, status: 0, error: String(e && e.message || e) }
    }
  }

  async function desktopListSessions(limit) {
    const r = await desktopFetch('GET', DESKTOP_API.sessionsPath + '?limit=' + (limit || 10))
    return r.json
  }

  async function desktopSendTurn(sessionId, args) {
    const id = sessionId || newDesktopSessionId()
    const body = buildDesktopTurnBody(args)
    const r = await desktopFetch('POST', DESKTOP_API.turnsPath(id), body, 15000)
    // 【实测事故】Desktop API 对**任意** session id 都无条件返回 202 {"ok":true} ——
    // 它不校验目标会话是否存在。实测：向自造 id POST 得到 202，但
    //   GET /v1/sessions 计数不变（19→19），会话从未创建，任务从未执行。
    // 因此 202 不能作为成功判据，必须回读会话列表确认目标 id 确实存在，
    // 否则桥接层会把"静默丢弃"报告成 ACCEPTED，用户在 Desktop UI 里什么都看不到。
    const accepted = r.status === 202 || (r.json && r.json.ok === true)
    let verified = null
    if (accepted) {
      try {
        const list = await desktopListSessions(200)
        if (Array.isArray(list)) verified = list.some((s) => s && String(s.id) === String(id))
        else verified = null
      } catch (e) { verified = null }
    }
    return {
      id, status: r.status, ok: r.ok, body: r.json || r.text,
      accepted, verified,
      // 仅当回读确认存在（或回读不可用）才算真正投递成功
      delivered: accepted && verified !== false
    }
  }

  async function desktopReadEvents(sessionId, dir, timeoutMs) {
    try {
      const r = await desktopFetch('GET', DESKTOP_API.eventsPath(sessionId, dir), null, timeoutMs || 2500)
      return parseDesktopEvents(r.text || (r.json ? JSON.stringify(r.json) : ''))
    } catch (e) {
      return { text: '', sessionId, error: String(e && e.message || e) }
    }
  }

  // 每次调用前刷一次发现结果（Desktop 可能中途启动/退出；env-only 形态零开销）。
  let desktop = discoverDesktop()

  // ── 统一设置分区读取（keystone 落盘；descriptor 只读）。宿主注入 deps.readSettings
  //    动态读取（preset/MCP 每次取最新文件值），或静态 deps.settings（测试/dynamic）。
  function liveSettings() {
    if (typeof deps.readSettings === 'function') {
      try {
        const r = deps.readSettings()
        if (r && typeof r === 'object') {
          // 宿主可返回 { partition, path, home } 或直接返回分区对象（宽松兼容）。
          if ('partition' in r || 'path' in r || 'home' in r) {
            return { partition: r.partition || null, path: r.path || null, home: r.home || null }
          }
          return { partition: r, path: deps.settingsPath || null, home: deps.dshHome || null }
        }
      } catch (e) { }
    }
    return { partition: (deps.settings && typeof deps.settings === 'object') ? deps.settings : null, path: deps.settingsPath || null, home: deps.dshHome || null }
  }
  function partitionSettings() {
    return liveSettings().partition || null
  }
  function fileBackend() {
    const s = partitionSettings()
    if (s && s.preferredBackend) return s.preferredBackend
    return null
  }
  function desktopModelChain(cfg) {
    const s = partitionSettings()
    return (cfg && cfg.desktopModel) || (s && s.desktopModel) || env.MIMO_DESKTOP_MODEL || 'mimo-auto'
  }

  const descriptor = {
    id: 'mimo', label: 'MIMO', presetId: 'cordis-mimo', defaultBackend: DEFAULT_BACKEND, defaultMode: 'auto',
    exeName: 'mimo', binEnvVars: ['MIMO_BIN', 'MIMO_CLI'], unavailableStatus: 'MIMO_UNAVAILABLE',

    backends() { return BACKENDS },
    normalizeBackend,

    // 预选优先级（旧 resolveBackend 语义）：工具参数 > 插件 config > env > 设置文件 > 默认。
    // keystone runner 已把 config/env/file 折进 getPreferredBackend()，这里只补 arg 级。
    resolveBackend(args, target, preferred) {
      const b = normalizeBackend(args && args.backend)
      if (b) return b
      return normalizeBackend(preferred) || descriptor.defaultBackend
    },

    // 委托规则（Lead 定案）：只有 desktop 走 provider.execute；mimocode 落 kit 通用管线。
    delegates(backend) { return backend === BACKEND_DESKTOP },

    buildArgv(exePrefix, args, opts) {
      const o = opts || {}
      const timeoutSec = clampInt(args.timeoutSec, DEFAULT_TIMEOUT_SEC, 10, 3600)
      // mimo-desktop：非 spawn 路径，空壳交给 execute（kit 委托前会调本函数）。
      if (o.backend === BACKEND_DESKTOP) {
        return { argv: [], mode: args.mode || 'auto', timeoutSec }
      }
      const argv = Array.isArray(exePrefix) ? exePrefix.slice() : [String(exePrefix)]
      argv.push('run')
      if (args.prompt != null && String(args.prompt).length) argv.push(String(args.prompt))
      argv.push('--format', 'json', '--dangerously-skip-permissions')
      let mode = args.mode || o.defaultMode || 'auto'
      if (mode === 'auto') mode = o.planActive ? 'plan' : 'build'
      if (mode === 'accept-edits') mode = 'build'
      // mimo --agent: build | plan | compose
      const agent = args.agent || mode
      if (agent === 'plan' || agent === 'build' || agent === 'compose') argv.push('--agent', agent)
      // mimocode 用 --model provider/model（桌面模型链只在 desktop execute 内使用）。
      if (args.model) argv.push('--model', String(args.model))
      // effort (low/medium/high) maps to mimo --variant; pass-through if already a variant name
      let variant = args.variant || args.effort
      if (variant === 'low') variant = 'minimal'
      else if (variant === 'medium') variant = undefined
      else if (variant === 'high') variant = 'high'
      if (variant) argv.push('--variant', String(variant))
      if (args.cwd) argv.push('--dir', String(args.cwd))
      if (args.sessionId) argv.push('--session', String(args.sessionId))
      else if (args.continueLatest) argv.push('--continue')
      if (args.title) argv.push('--title', String(args.title))
      return { argv, timeoutSec, mode: agent }
    },

    parseJson: parseMimoJson,
    buildResult,

    // 旧 foldStepUpdate 语义 verbatim（识别 tool/text/error 事件），但 trail 条目同时
    // 带 kit 展示层字段（stepIndex/tool/state/args）与旧字段（kind/label），
    // 这样 renderStatus 与 MCP 快照映射（buildMcpBridgePayload）都能直接渲染。
    foldStreamEvent(ev, p, summarizeArgsFn, maxArgLen, maxTrail) {
      if (!ev || typeof ev !== 'object') return
      const t = ev.type
      const pr = ev.properties || ev
      const cap = maxTrail || 12
      const idx = p.trail ? p.trail.length : 0
      let entry = null
      if (t === 'tool' || t === 'tool-call' || t === 'tool_use' || t === 'step_update') {
        const name = pr.tool_name || pr.tool || pr.name
        if (name) {
          const args = (summarizeArgsFn || summarizeArgs)(pr.arguments || pr.args || pr.input) || null
          const state = pr.state || pr.status || 'ACTIVE'
          entry = {
            at: Date.now(), kind: 'tool', stepIndex: idx, tool: String(name), args, state,
            label: shortLabel(name + ' ' + JSON.stringify(args || {}))
          }
          if (state === 'ACTIVE') p.current = { tool: String(name), args, stepIndex: idx, since: entry.at }
          else if (p.current && p.current.tool === String(name) && p.current.stepIndex === idx) p.current = null
        }
      } else if (t === 'text' || t === 'message') {
        const chunk = pr.text || pr.content || ''
        if (typeof chunk === 'string' && chunk) {
          const capLen = maxArgLen || 120
          entry = { at: Date.now(), kind: 'text', stepIndex: idx, tool: 'agent_response', args: { text: chunk.slice(0, capLen) }, state: 'ACTIVE', label: shortLabel(chunk) }
          p.current = { tool: 'agent_response', args: entry.args, stepIndex: idx, since: entry.at }
        }
      } else if (t === 'error') {
        const err = pr.error || pr
        const msg = (err.data && err.data.message) || err.message || 'error'
        entry = { at: Date.now(), kind: 'error', stepIndex: idx, tool: 'error', args: { message: String(msg).slice(0, maxArgLen || 120) }, state: 'FAILED', label: shortLabel(msg) }
      }
      if (entry && p.trail) {
        p.trail.push(entry)
        while (p.trail.length > cap) p.trail.shift()
      }
    },

    // 旧 LIMIT_RE 覆盖（kit 版不含 free API/登录/第三方等 MiMo 文案）。
    isLimited(res) {
      if (!res || res.ok) return false
      if (res.status === 'SPAWN_ERROR' || res.status === 'MIMO_UNAVAILABLE' || res.status === 'HUNG_TIMEOUT') return true
      const hay = String(res.stderr || '') + ' ' + String(res.response || '') + ' ' + String(res.status || '') + ' ' + String(res.errorMessage || '')
      return MIMO_LIMIT_RE.test(hay)
    },

    failureHint(res) {
      if (!res || res.ok) return ''
      const st = String(res.status || '')
      if (st === 'MIMO_UNAVAILABLE') return '[诊断] 未找到 mimo 可执行文件：请安装 MiMoCode CLI（mimo），或设置 MIMO_BIN 指向其绝对路径；也可改用 backend=mimo-desktop 走 MiMo Desktop 客户端。'
      if (st === 'DESKTOP_UNREACHABLE') return '[诊断] MiMo Desktop 本地 API 不可达/本宿主不支持 HTTP：请启动 Xiaomi MiMo Desktop 后重试，或改用 backend=mimocode（本地 mimo CLI）。'
      if (st === 'DESKTOP_SESSION_NOT_CREATED') return '[诊断] MiMo Desktop API 无法创建会话：请在 Desktop 应用中新建或选用现有会话，把它的 id 传给 sessionId 参数。'
      if (/free API service has ended|sign in|configure a third-party|登录|第三方/i.test(String(res.stderr || '') + String(res.errorMessage || ''))) {
        return '[诊断] MiMo 免费 API 服务疑似已停止或未登录：请在 mimo CLI 完成登录/配置第三方模型（configure a third-party），或改用 backend=mimo-desktop 走 Desktop 登录态。'
      }
      return ''
    },

    // ACCEPTED 计入成功态（指示灯不红；契约 §1）。
    isSuccessStatus(st) {
      if (!st) return false
      return st === 'SUCCESS' || st === 'ACCEPTED'
    },

    // 桌面可达性前置检查（契约 §9）：dynamic 无 fetch / 无发现 → abort 提示 mimocode。
    // 有 fs 时做一次健康探测缓存（异步进行中先放行 —— preflight 是同步钩子）。
    preflight({ backend }) {
      if (backend !== BACKEND_DESKTOP) return null
      desktop = discoverDesktop()
      if (!fetchFn()) {
        return {
          abort: desktopResult(false, {
            status: 'DESKTOP_UNREACHABLE',
            mode: 'auto',
            errorMessage: '当前宿主无 HTTP fetch 能力（dynamic 沙箱），mimo-desktop 不可用。请改用 backend=mimocode，或在 DSH 正式宿主（preset/MCP 形态）中使用桌面后端。'
          })
        }
      }
      if (!desktop.available) {
        return {
          abort: desktopResult(false, {
            status: 'DESKTOP_UNREACHABLE',
            mode: 'auto',
            stderr: String(desktop.error || 'not configured'),
            errorMessage: 'MiMo Desktop client unavailable. Start Xiaomi MiMo Desktop, or use backend=mimocode.'
          })
        }
      }
      return null
    },

    // mimo-desktop 委托执行（旧 runDesktop verbatim 编排；engine.begin/end 由 kit 做）。
    async execute({ args, cwd, built }) {
      desktop = discoverDesktop()
      const a = args || {}
      const sessionId = a.sessionId || newDesktopSessionId()
      const mode = built && built.mode ? built.mode : (a.mode || 'auto')
      try {
        const health = await desktopHealth()
        if (!health.ok) {
          return desktopResult(false, {
            status: 'DESKTOP_UNAVAILABLE',
            sessionId,
            mode,
            stderr: String(health.error || health.body || 'desktop api not ready'),
            errorMessage: 'MiMo Desktop client unavailable. Start Xiaomi MiMo Desktop and retry, or set backend=mimocode.'
          })
        }
        const s = partitionSettings()
        const turn = await desktopSendTurn(sessionId, {
          prompt: a.prompt,
          model: a.model || desktopModelChain(s),
          directory: cwd
        })
        const okTurn = turn.delivered === true
        let text = ''
        if (okTurn) {
          try {
            const ev = await desktopReadEvents(sessionId, cwd, 2500)
            text = ev.text || ''
          } catch (e) { }
        }
        return desktopResult(okTurn, {
          status: okTurn ? (text ? 'SUCCESS' : 'ACCEPTED') : 'DESKTOP_SESSION_NOT_CREATED',
          response: text || (okTurn
            ? '(Desktop turn accepted; watch Desktop UI or call mimo_continue for the reply)'
            : ''),
          sessionId,
          accepted: okTurn,
          mode,
          stderr: okTurn ? '' : 'Desktop API returned ' + turn.status + ' but session ' + turn.id + ' does not exist',
          errorMessage: okTurn ? '' : ('MiMo Desktop 未创建会话（API 返回 ' + turn.status +
            ' 但会话列表中不存在 ' + turn.id + '）。任务未执行。' +
            'MiMo Desktop API 无法创建会话，请在 Xiaomi MiMo Desktop 应用中新建（或选用现有）' +
            '会话，再把它的 id 传给 mimo_run 的 sessionId 参数。')
        })
      } catch (e) {
        return desktopResult(false, {
          status: 'DESKTOP_ERROR',
          sessionId,
          mode,
          stderr: String(e && e.message || e),
          errorMessage: String(e && e.message || e)
        })
      }
    },

    tools: {
      run: { name: 'mimo_run', description: 'Dispatch a coding/build/debug/investigation task to the local mimo agent CLI (Xiaomi MiMo Desktop / MiMoCode) and return its final answer. DSH fully controls mimo (--dangerously-skip-permissions; mimo never prompts). On rate-limit/network failure DSH pops a fallback dialog; fallback=true means finish with native tools. Runs in the background by default (returns a jobId immediately; collect with job_output); set background=false to block for the final answer. While it runs, call mimo_status to watch what mimo is doing live.', inputSchema: RUN_PARAMS },
      continue: { name: 'mimo_continue', description: 'Continue an existing mimo session with a follow-up prompt. Pass sessionId or set latest=true. Same DSH-controlled, no-prompt execution and same fallback dialog as mimo_run.', inputSchema: CONTINUE_PARAMS },
      status: { name: 'mimo_status', description: 'Read a live snapshot of what the local mimo agent is currently doing. Returns one section per project (working directory): running count, current step, recent step trail, last completed run status + session id, per-project runs/token usage. Call this to check on an in-flight mimo_run/mimo_continue without waiting for it to finish.', inputSchema: STATUS_PARAMS }
    },

    // mimo_settings：入参键保持旧 prompt 连续性（backend/desktopModel），落统一分区
    // preferredBackend/desktopModel（迁移映射 keystone 已做）。写盘仅在宿主注入
    // nodeFs + nodePath + settingsWrite 时可用；否则回显（dynamic 沙箱旧 echo 语义）。
    extraTools: [{
      name: 'mimo_settings',
      description: SETTINGS_DESCRIPTION,
      inputSchema: SETTINGS_PARAMS,
      render: renderSettings,
      async logic(args, exec) {
        const a = args || {}
        const live = liveSettings()
        const cur = Object.assign({ preferredBackend: DEFAULT_BACKEND, desktopModel: 'mimo-auto' }, live.partition || {})
        let settingsPath = live.path || null
        let saved = false
        let saveError = null
        const fsMod = nodeFs
        const pathMod = nodePath
        const home = live.home || deps.dshHome || null
        if ((a.backend || a.desktopModel) && fsMod && pathMod && (settingsPath || home)) {
          try {
            settingsPath = await writePartition(fsMod, pathMod, settingsPath, home, env, cur, a)
            saved = true
          } catch (e) { saveError = String(e && e.message || e) }
        }
        const merged = Object.assign({}, cur)
        if (a.backend) merged.preferredBackend = a.backend
        if (a.desktopModel) merged.desktopModel = a.desktopModel
        const rt = discoverDesktop()
        return {
          ok: !saveError,
          settingsPath: settingsPath || '(unified; not writable in this host)',
          fileBackend: merged.preferredBackend || null,
          configBackend: (deps.config && deps.config.backend) || null,
          envBackend: env.MIMO_BRIDGE_BACKEND || env.MIMO_BACKEND || null,
          effectiveBackend: descriptor.resolveBackend({ backend: a.backend }, null, normalizeBackend(env.MIMO_BRIDGE_BACKEND || env.MIMO_BACKEND) || merged.preferredBackend),
          desktopModel: merged.desktopModel || 'mimo-auto',
          desktopAvailable: !!rt.available,
          desktopError: rt.error || null,
          desktopApiFile: rt.apiFile || null,
          saved,
          saveError,
          backends: BACKENDS,
          note: 'Preselect via settings file / plugin config.backend / MIMO_BRIDGE_BACKEND. Per-call `backend` overrides only that call.'
        }
      }
    }],

    // 设置分区（契约 §3）：keystone 读写/GUI；本处纯逻辑。diagnose/meta 必须同步。
    settings: {
      keys: ['preferredBackend', 'desktopModel'],
      defaults: () => ({ preferredBackend: DEFAULT_BACKEND, desktopModel: 'mimo-auto' }),
      normalize(raw) {
        const src = raw && typeof raw === 'object' ? raw : {}
        const out = { preferredBackend: DEFAULT_BACKEND, desktopModel: 'mimo-auto' }
        const b = normalizeBackend(src.preferredBackend)
        if (b) out.preferredBackend = b
        if (typeof src.desktopModel === 'string' && src.desktopModel.trim()) out.desktopModel = src.desktopModel.trim()
        return out
      },
      meta() {
        return {
          titleSuffix: 'MiMo',
          fields: [
            { key: 'preferredBackend', label: '预选后端', type: 'select', options: [{ value: 'mimocode', label: 'MiMoCode CLI（本地 mimo 命令，DSH 完全控制）' }, { value: 'mimo-desktop', label: 'MiMo Desktop 客户端（本地 API，共享其登录/模型/会话 UI）' }], note: 'mimo_run/mimo_continue 默认走这里选的后端；单次调用可用 backend 参数覆盖。' },
            { key: 'desktopModel', label: '桌面模型', type: 'text', allowCustom: true, placeholder: 'mimo-auto', note: '仅 mimo-desktop 后端使用（Desktop 里的模型 id，如 mimo-auto）。' }
          ]
        }
      },
      // 同步一行诊断：探测缓存 + 惰性 health 后台刷新（结果进缓存，下次面板可见）。
      diagnose(settings) {
        const rt = discoverDesktop()
        const f = fetchFn()
        if (!f) return ''
        if (!rt.available) return '桌面 API 未发现（' + (rt.error || '未配置') + '）；mimocode 后端不受影响'
        const s = settings && settings.preferredBackend || partitionSettings() && partitionSettings().preferredBackend || DEFAULT_BACKEND
        try {
          f(rt.baseUrl + DESKTOP_API.healthPath, { headers: { Authorization: 'Bearer ' + rt.token } })
            .then((r) => { desktopHealthCache = { ok: r.ok, at: Date.now() } })
            .catch(() => { desktopHealthCache = { ok: false, at: Date.now() } })
        } catch (e) { desktopHealthCache = { ok: false, at: Date.now() } }
        if (desktopHealthCache.at && Date.now() - desktopHealthCache.at < 60000) {
          return desktopHealthCache.ok
            ? ('桌面 API 在线（' + rt.baseUrl + '）；当前预选 ' + s)
            : ('桌面 API 不可达（检查 MiMo Desktop 是否在运行）；当前预选 ' + s + '，可改用 mimocode')
        }
        desktopHealthCache = { ok: null, at: Date.now() }
        return '桌面 API 已发现（' + rt.baseUrl + (rt.apiFile ? '' : '，env 配置') + '）；健康检测中…；当前预选 ' + s
      }
    },

    mcp: { version: '0.2.0' }
  }

  let desktopHealthCache = { ok: null, at: 0 }

  // 统一分区写入（tmp→rename 原子写；与 keystone lib/settings.mjs 同文件同分区规则，
  // 本工具自实现落盘 —— 不 import home-plugin；宿主给出 settingsPath 或 dshHome）。
  async function writePartition(fsMod, pathMod, knownPath, home, environment, cur, patch) {
    const SETTINGS_FILE_NAME = 'cli-bridge-settings.json'
    const file = knownPath || environment.CLI_BRIDGE_SETTINGS_FILE || (home ? pathMod.join(home, SETTINGS_FILE_NAME) : null)
    if (!file) throw new Error('dsh-home not resolved (set DSH_HOME or CLI_BRIDGE_SETTINGS_FILE)')
    let all = {}
    try { all = JSON.parse(fsMod.readFileSync(file, 'utf8')) } catch (e) { all = {} }
    if (!all || typeof all !== 'object') all = {}
    const next = Object.assign({}, all)
    const part = Object.assign({}, cur, next.mimo || {})
    if (patch.backend) part.preferredBackend = normalizeBackend(patch.backend) || patch.backend
    if (patch.desktopModel) part.desktopModel = patch.desktopModel
    next.mimo = descriptor.settings.normalize(part)
    next.updatedAt = Date.now()
    try { fsMod.mkdirSync(pathMod.dirname(file), { recursive: true }) } catch (e) { }
    const tmp = file + '.tmp-' + ((typeof process !== 'undefined' && process.pid) || 'mimo')
    fsMod.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fsMod.renameSync(tmp, file)
    return file
  }

  // 三形态共用的工具逻辑。签名保持不变（keystone 与队友按此接线）。
  descriptor.runToolLogic = async function (args, exec) {
    const a = args || {}
    // 旧 mimo preset 语义：background 默认 true（仅显式 false 才前台阻塞）。
    const normalized = a.background === undefined ? Object.assign({}, a, { background: true }) : a
    return this.runner.coreExecute(normalized, exec)
  }
  descriptor.continueToolLogic = async function (args, exec) {
    const a = args || {}
    const mapped = {
      prompt: a.prompt,
      mode: a.mode,
      model: a.model,
      effort: a.effort,
      cwd: a.cwd,
      timeoutSec: a.timeoutSec,
      background: a.background,
      backend: a.backend,
      // 【关键】desktop 后端的 sessionId 必须转发（白名单转发漏了它会导致
      // mimo_run 传 sessionId 被静默丢弃 → 永远造新 id → desktop 后端不可用）。
      sessionId: a.sessionId
    }
    if (a.sessionId) mapped.sessionId = a.sessionId
    else if (a.latest) mapped.continueLatest = true
    return this.runToolLogic(mapped, exec)
  }
  descriptor.statusToolLogic = async function (args) {
    const a = args || {}
    const snap = this.engine.statusSnapshot()
    if (a.cwd) {
      const key = String(a.cwd)
      snap.projects = (snap.projects || []).filter((p) => p.cwd === key)
      const g = snap.projects[0]
      if (g) {
        snap.state = g.state
        snap.running = g.running
        snap.current = g.current
        snap.trail = g.trail
        snap.lastStatus = g.lastStatus
        snap.lastAt = g.lastAt
        snap.lastSessionId = g.lastSessionId
        snap.fallbackActive = g.fallbackActive
        snap.runs = g.runs
        snap.totalTokens = g.totalTokens
        snap.updatedAt = g.updatedAt
      }
    }
    return snap
  }

  // 工厂装配（provider 无关骨架 + 描述符）：宿主形态通过 deps 注入 runner 依赖。
  descriptor.attach = function (hostOpts) {
    this.engine = createStatusEngine({ provider: this, publish: hostOpts.publish })
    const runner = createRunner(Object.assign({}, hostOpts, { provider: this, engine: this.engine }))
    this.runner = runner
    return runner
  }

  // 测试/宿主可见的纯函数面（不进协议字段）。
  descriptor._internals = {
    BACKENDS, BACKEND_MIMOCODE, BACKEND_DESKTOP, DEFAULT_BACKEND, MIMO_LIMIT_RE,
    DESKTOP_API, parseMimoJson, buildResult, desktopResult, buildDesktopTurnBody,
    newDesktopSessionId, parseDesktopEvents, normalizeBackend, discoverDesktop,
    desktopFetch, desktopHealth, desktopSendTurn, desktopReadEvents
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


const SCHED_ALL_IDS = ["agy","codebuddy","mimo"]


return {
  inject: ['tools', 'subprocess', 'systemPrompt', 'timer'],
  apply(ctx) {
    // 调度门禁（0.2.0）：设置面板关掉 mimo → 本形态不注册工具/政策段；fail-open。
    if (!isBridgeEnabled('mimo', SCHED_ALL_IDS)) return
    const subprocess = ctx.subprocess
    const planMode = ctx.get('planMode')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    // 沙箱可能运行在无 process 的环境：typeof 守卫读 env（旧仓 dynamic 的等价面）。
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}

    const provider = defineProvider({ env })

    function publish(snapshot) {
      try {
        const collector = ctx.get('cliBridgeCollector')
        if (collector && typeof collector.mergeSnapshot === 'function') { collector.mergeSnapshot('mimo', snapshot); return }
      } catch (e) { /* fall through to legacy alias */ }
      try {
        const legacy = ctx.get('mimoCollector')
        if (legacy && typeof legacy.mergeSnapshot === 'function') legacy.mergeSnapshot(snapshot)
      } catch (e) { /* 灯数据尽力而为 */ }
    }

    // exe：MIMO_BIN/MIMO_CLI env > PATH 查找 mimo（subprocess.resolveExecutable）。
    // mimo-desktop 后端不 spawn：返回占位字符串让 kit 直达 delegates→execute/preflight。
    async function resolveExe(backend, signal) {
      if (backend === 'mimo-desktop') return 'mimo'
      const bin = env.MIMO_BIN || env.MIMO_CLI || ''
      if (bin) {
        if (/\.(mjs|cjs|js)$/i.test(bin) && typeof process !== 'undefined' && process.execPath) return [process.execPath, bin]
        return bin
      }
      return await subprocess.resolveExecutable('mimo', undefined, signal)
    }

    // 旧仓 CWD_FALLBACK 硬编码机器绝对路径；新语义：MIMO_MCP_CWD > MIMO_BRIDGE_CWD >
    // workspaceRoot > process.cwd > '.'（沙箱无 process.cwd 可用时以 '.' 兜底）。
    function getCwdFallback() {
      if (env.MIMO_MCP_CWD) return String(env.MIMO_MCP_CWD)
      if (env.MIMO_BRIDGE_CWD) return String(env.MIMO_BRIDGE_CWD)
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
      if (typeof process !== 'undefined' && typeof process.cwd === 'function') { try { return process.cwd() } catch (e) {} }
      return '.'
    }

    // 预选链（沙箱无 fs 读设置文件）：env MIMO_BRIDGE_BACKEND / MIMO_BACKEND。
    function getPreferredBackend() {
      return env.MIMO_BRIDGE_BACKEND || env.MIMO_BACKEND || null
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

    provider.attach({ ctx, subprocess, resolveExe, getCwdFallback, getPreferredBackend, planActiveFor, publish })

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
    // mimo_settings：沙箱无 nodeFs → 描述符内部自动降级为回显（不持久化）。
    // render 适配：harness 契约是 render(args, value)，extraTools[].render 是
    // renderSettings(value) 单参 —— 直接透传会把 args 当 value（渲染全空）。
    for (const et of provider.extraTools) {
      harness.registerTool(ctx, harness.defineTool({
        name: et.name,
        description: et.description,
        parameters: et.inputSchema,
        output: { schema: OUTPUT_SCHEMA, render: function (args, value) { return et.render ? et.render(value) : renderResult(value, provider) } },
        execute: function (args, exec) { return et.logic(args, exec) }
      }))
    }

    // 浏览器指示灯轮询的 RPC 面（旧 dynamic/handle('mimo_status') 语义）。
    harness.handle('mimo_status', function () { return provider.statusToolLogic({}) })

    // 旧 policy 文案 verbatim（提示词连续性红线）。
    const policyText = [
      'mimo-first execution policy (Xiaomi MiMo: MiMoCode CLI or MiMo Desktop client).',
      '',
      'Local backends (selectable in settings: backend = mimocode | mimo-desktop):',
      '- mimocode (default): local `mimo` CLI (MiMoCode). Full DSH control (--dangerously-skip-permissions, never prompts).',
      '- mimo-desktop: Xiaomi MiMo Desktop client local API (running Desktop app; uses its login/model/session UI).',
      '',
      'By default, dispatch runs in the background and returns a jobId immediately; collect via job_output and watch live progress via mimo_status.',
      '',
      'Decision table for tool selection:',
      '- Single read/glob/grep or short (<30s) command -> Native tools.',
      '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> mimo_run.',
      '- Follow-ups on the same topic -> mimo_continue (with latest=true or sessionId; context is preserved).',
      '- Final build/test verification of mimo output -> Native tools.',
      '- Plan / read-only analysis -> mimo_run with mode=plan.',
      '- Desktop-native work (Desktop session UI, shared Desktop login/model) -> prefer backend=mimo-desktop (or preselect it in settings).',
      '',
      'Backend preselection (settings):',
      '- Default backend is configured OUT-OF-BAND (plugin config.backend / env MIMO_BRIDGE_BACKEND / settings file).',
      '- Per-call `backend` argument overrides the default only when necessary.',
      '- Do NOT invent a backend every call — use the preselected default.',
      '',
      'Context protocol (one topic = one mimo session):',
      '- First dispatch on a topic: compact CONTEXT preamble (point to paths, do not paste file contents).',
      '- Follow-ups: call mimo_continue and state only what is new.',
      '',
      'Execution & Fallback protocol:',
      '- Dispatch defaults to background=true. Collect via job_output.',
      '- On rate-limit/network/auth failure, a confirmation dialog offers DSH-local fallback.',
      '- If result has fallback=true (status FALLBACK_TO_DSH), finish with native tools and NEVER call mimo again for this task.',
      '- Never loop mimo calls; never ask mimo to call back into DSH.'
    ].join('\n')

    ctx.systemPrompt.section({
      name: 'mimo:policy',
      order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
      text: policyText
    })
  }
}
