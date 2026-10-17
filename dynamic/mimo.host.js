// dynamic/mimo.host.template.mjs — mimo 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=mimo）把 core/bridge-kit.mjs 与
// providers/mimo.mjs 分别内联进下方两个占位标记行（各占一行、行内仅此标记），
// 生成 dynamic/mimo.host.js。注意：标记字面量绝不能出现在本注释里 —— 构建做全局
// 替换，注释中出现同样也会被替换成正文代码而炸掉语法。
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生
//    定时器 —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层
//    return 合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('mimo', snap)
//    推给家级灯（旧 mimoCollector 服务名在 keystone 里保留别名）；动态形态不宣告
//    mode（旧语义：普通模式灯仅在调用 mimo 时临时显示）。
//  - mimo_settings 在沙箱不持久化（无 nodeFs → 描述符回显语义；旧 dynamic echo 形态）。
//  - 单后端（本地 mimo CLI / MiMoCode）：exe 解析走 agy 模板同款链路 ——
//    MIMO_BIN/MIMO_CLI env > 已知安装位置 > subprocess.resolveExecutable(PATH)。
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

// providers/mimo.mjs — mimo provider descriptor（单后端：本地 mimo CLI / MiMoCode）。
//
// 移植基线：mimo-first-bridge v1.x 仓 core/mimo-core.mjs + core/runtime-settings.mjs +
// preset/mimo-first/mimo-first-bridge.mjs 的内联逻辑（buildArgv / parseMimoJson /
// buildResult / 三工具 schema / mimo_settings），语义逐字保持；与 provider 无关的骨架
// （状态引擎/行流/回退弹窗/展示层/超时护栏）在 core/bridge-kit.mjs（契约 §1）。
//
// 2026-10 去 desktop 化（用户定案：MiMo 免费 API 服务已被官方终止 + 本机 0 凭据）：
//  1. 取消 mimo-desktop 后端 —— 只走 `mimo run`（MiMoCode CLI，官方便携安装位置
//     ~/.mimocode/bin/mimo.exe）；登录由用户在 CLI 侧 `mimo auth login` 自理。
//  2. 模型由用户在设置里手动指定（settings.defaultModel，不写死默认值）；留空 =
//     不传 --model，交给 mimo CLI 自身默认。可用模型以 `mimo models` 实测为准
//     （xiaomi/mimo-v2.6-flash / -pro / -pro-ultraspeed 等）。
//  3. 是否启用 mimo 由调度（_scheduling.enabled）控制；本描述符不含任何开关。
//
// 红线（PROVIDER-CONTRACT.md §8 + Lead 定案）：本文件会被 build 内联进 dynamic 沙箱
// （new Function）—— 绝不出现 import.meta 字面量；process/fs/child_process 只经
// globalThis.process.getBuiltinModule + typeof 守卫读取；只允许 import bridge-kit。// import { createStatusEngine, createRunner, clampInt, shortLabel, summarizeArgs } from '../core/bridge-kit.mjs'// import { parseMimoJson, buildResult } from './mimo-pure.mjs'
// ── 单后端归一（旧 mimo-core 双后端 verbatim 的收缩形态）───────────────────────
// mimo-desktop 取消后不再有第二后端：backends() 恒 null；任何输入（含历史别名
// mimocode / mimo-cli / desktop / 空串 / 非法值）一律归一为 null。会话路由由
// engine.resolveTarget（cwd + sessionId）完成，backend 恒 null。
const DEFAULT_TIMEOUT_SEC = 600

// 旧 LIMIT_RE（比 kit 版多 free-API/登录/第三方等 MiMo 文案；provider.isLimited 覆盖）。
// 命名 MIMO_ 前缀：dynamic 内联时 kit 也声明顶层 LIMIT_RE，同名会在同一脚本作用域
// 触发「Identifier already declared」构建错误（scripts/build.mjs 文本拼接的固有约束）。
const MIMO_LIMIT_RE = /rate.?limit|ratelimit|429|too many|quota|insufficient|credit|balance|exhausted|exceed|network|offline|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|timeout|timed out|unavailable|503|502|500|401|403|unauthorized|invalid api|api key|connection|proxy|socket|tls|ssl|dns|free API service has ended|sign in|configure a third-party|网络|超时|限流|流量|受限|配额|金额|余额|额度|认证|连接|断开|登录|第三方/i

// ── Node 内建探测（沙箱纪律：getBuiltinModule + typeof 守卫）───────────────────
// 名字带 mimo 前缀：本文件会与 bridge-kit / core/scheduling.mjs【文本内联进同一个动态
// 沙箱脚本作用域】，撞名即「Identifier already declared」构建错误。
function mimoBuiltin(name) {
  try {
    const proc = globalThis.process
    return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule(name) : null
  } catch (e) { return null }
}

// ── 可执行文件解析（env MIMO_BIN/MIMO_CLI > 已知安装位置 > PATH 名字）───────────
// MiMoCode CLI 官方便携安装目录：<USERPROFILE|HOME>/.mimocode/bin/mimo[.exe]。
// 沙箱内可能没有 fs —— 全部读取走 typeof 守卫，读不到就返回空数组（退回 PATH 查找）。
const MIMO_EXE_DIR = ['.mimocode', 'bin']

/** 探测本机 mimo 可执行文件候选路径（官方便携安装位置）；无 fs 能力时返回空数组。 */
function mimoCandidateExePaths(env) {
  const e = env || {}
  const out = []
  const fs = mimoBuiltin('node:fs')
  if (!fs || typeof fs.existsSync !== 'function') return out
  const path = mimoBuiltin('node:path')
  const join = (path && typeof path.join === 'function') ? ((a, b) => path.join(a, b)) : ((a, b) => a + '/' + b)
  for (const k of ['USERPROFILE', 'HOME']) {
    if (!e[k]) continue
    const dir = join(join(String(e[k]), MIMO_EXE_DIR[0]), MIMO_EXE_DIR[1])
    for (const base of ['mimo.exe', 'mimo']) {
      const exe = join(dir, base)
      try { if (fs.existsSync(exe) && out.indexOf(exe) < 0) out.push(exe) } catch (err) { /* 探测失败静默跳过 */ }
    }
  }
  return out
}

/**
 * 解析本次调用使用的 exe 前缀（数组或字符串）。
 * 优先级：binPath（显式路径）> env MIMO_BIN/MIMO_CLI > 已知安装位置 > PATH 名字。
 */
function resolveMimoExePrefix(env, binPath) {
  const e = env || {}
  const bin = binPath || e.MIMO_BIN || e.MIMO_CLI || ''
  if (bin) {
    if (/\.(mjs|cjs|js)$/i.test(bin)) {
      const proc = globalThis.process
      return [(proc && proc.execPath) ? proc.execPath : 'node', bin]
    }
    return [String(bin)]
  }
  const found = mimoCandidateExePaths(e)
  return found.length ? [found[0]] : ['mimo']
}

// ── 模型列表（`mimo models`；设置面板下拉用）───────────────────────────────────
// 实测输出形如每行 `provider/model — window 1M, compacts at 900K`（分隔符是中文破折号
// U+2014）。模型名自身含连字符（xiaomi/mimo-v2.6-pro-ultraspeed），所以只认「行首的
// provider/model」，其后一律当描述文本；表头/说明/空行一律丢弃，绝不抛。
const MIMO_MODEL_ID_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.@#+-]+)(?=$|[\s—–:|,])/

/** 解析 `mimo models` 文本输出为 [{id, provider, name, note}]（去重、保序）。 */
function parseMimoModels(text) {
  const out = []
  const seen = Object.create(null)
  for (const raw of String(text || '').split(/\r?\n/)) {
    // 去掉列表记号（• * - 1. 等）与行首空白，避免把记号当 provider 名。
    const ln = raw.replace(/^[^A-Za-z0-9]+/, '').trim()
    if (!ln) continue
    const m = ln.match(MIMO_MODEL_ID_RE)
    if (!m) continue
    const id = m[1]
    if (seen[id]) continue
    seen[id] = true
    const slash = id.indexOf('/')
    out.push({ id: id, provider: id.slice(0, slash), name: id.slice(slash + 1), note: ln.slice(id.length).replace(/^[\s—–:|,-]+/, '').trim() })
  }
  return out
}

/**
 * 同步抓取模型列表（供设置面板下拉）。失败返回空数组 —— 下拉退化为自由输入，
 * 绝不因探测失败影响面板渲染。仅 spawnSync 可用时生效（宿主形态）。
 */
function fetchMimoModelsSync(env, timeoutMs) {
  try {
    const child = mimoBuiltin('node:child_process')
    if (!child || typeof child.spawnSync !== 'function') return []
    const prefix = resolveMimoExePrefix(env)
    const r = child.spawnSync(prefix[0], prefix.slice(1).concat(['models']), { encoding: 'utf8', timeout: clampInt(timeoutMs, 8000, 1000, 30000), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (!r || r.error || r.status !== 0) return []
    return parseMimoModels(String(r.stdout || ''))
  } catch (e) { return [] }
}

// ── 三工具 schema（旧 preset verbatim；desktop 专属入参已随之后端取消而删除）────
const MODEL_DESC = 'provider/model 格式，如 xiaomi/mimo-v2.6-flash；留空用设置里的默认模型'
const RUN_PARAMS = {
  type: 'object', additionalProperties: true, required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The task instruction for mimo. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — mimo reads the repo itself). For follow-ups on the same topic, use mimo_continue with latest=true or sessionId (mimo keeps conversation context; state only what is new).' },
    mode: { type: 'string', enum: ['auto', 'plan', 'build', 'compose', 'accept-edits'], description: 'auto follows DSH plan state (plan vs build); plan = read-only analysis (--agent plan); build = full tools (--agent build); compose = compose workflow.' },
    model: { type: 'string', description: MODEL_DESC },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning effort, mapped to mimo --variant (low→minimal, high→high).' },
    cwd: { type: 'string', description: 'Working directory for mimo (--dir).' },
    timeoutSec: { type: 'integer', description: 'Hard timeout seconds (10-3600, default 600). Grace +60s on top.' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with mimo_status. Set false to block for the final answer.' },
    sessionId: { type: 'string', description: 'Optional mimo session id to resume (--session). Follow-ups on the same topic normally go through mimo_continue.' },
    title: { type: 'string', description: 'Optional session title.' }
  }
}
const CONTINUE_PARAMS = {
  type: 'object', additionalProperties: true, required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing mimo session. State only what is new; mimo preserves its conversation context.' },
    sessionId: { type: 'string', description: 'mimo session id to resume (--session).' },
    latest: { type: 'boolean', description: 'Continue the most recent mimo session (--continue).' },
    mode: { type: 'string', enum: ['auto', 'plan', 'build', 'compose', 'accept-edits'], description: 'Execution mode.' },
    model: { type: 'string', description: MODEL_DESC },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning effort.' },
    cwd: { type: 'string', description: 'Working directory for mimo.' },
    timeoutSec: { type: 'integer', description: 'Hard timeout seconds (10-3600, default 600).' },
    background: { type: 'boolean', description: 'Defaults to true (background job).' }
  }
}
const STATUS_PARAMS = { type: 'object', additionalProperties: true, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }
const SETTINGS_PARAMS = { type: 'object', additionalProperties: true, required: [], properties: { model: { type: 'string', description: MODEL_DESC } } }
const SETTINGS_DESCRIPTION = 'Read or change the default mimo model (settings). Call with model=<provider/model> to save it as the default for subsequent mimo_run/mimo_continue; call with no args to read current settings. Persisted to the settings file; a per-call `model` argument on mimo_run/mimo_continue overrides it for that call only. Available models are listed by `mimo models` on this machine (mimo CLI must be installed and logged in).'

function renderSettings(value) {
  const s = value || {}
  const lines = [
    'mimo settings',
    '  settings file  : ' + (s.settingsPath || '(unknown)'),
    '  default model  : ' + (s.defaultModel || '(unset — 不传 --model)'),
    '  effective      : ' + (s.effective || '(unknown)'),
    '  exe            : ' + (s.exe || '(unknown)'),
    '  saved          : ' + (s.saved ? 'yes' : 'no')
  ]
  if (s.saveError) lines.push('  save error     : ' + s.saveError)
  if (s.note) lines.push('  note           : ' + s.note)
  return [{ type: 'text', text: lines.join('\n') }]
}
// ── 可纯函数化的 mimo-core 语义（descriptor 方法 + 独立导出双份）───────────────

function defineProvider (deps = {}) {
  const env = deps.env || {}
  const nodeFs = deps.nodeFs || null
  const nodePath = deps.nodePath || null
  let host = null // attach 后保存 hostOpts（preset/dynamic 形态提供 getSettings）
  let settingsRef = { defaultModel: '' }

  /** 取当前生效的偏好设置。三条来源按优先级合并，每次 buildArgv 都重新读 ——
   *  面板改默认模型后无需重启即生效：
   *   1) `host.getSettings('mimo')` —— preset/dynamic 形态（attach 时由宿主注入）；
   *   2) `deps.readSettings()` —— MCP 形态（真 Node 进程，每次现读设置文件）；
   *   3) `settingsRef` —— attach 时固化的一次性快照 / 缺省值。
   *  三条都拿不到 → 缺省 `{defaultModel:''}`（= 不传 --model，交给 mimo CLI 自决）。
   *
   *  历史坑：MCP 形态不 attach（自建 engine），只认 host.getSettings 会让面板设置的
   *  defaultModel 在 MCP 面对 mimo_run 完全失效 —— 只有 args.model 才落地。
   *  三个形态行为不一致是缺陷，故此处统一把 readSettings 纳入。 */
  function currentSettings() {
    const out = Object.assign({}, settingsRef)
    try {
      if (typeof deps.readSettings === 'function') {
        const r = deps.readSettings()
        if (r && typeof r === 'object') {
          // 宿主可返回 { partition, path, home } 或直接返回分区对象（宽松兼容）。
          const part = ('partition' in r || 'path' in r || 'home' in r) ? r.partition : r
          if (part && typeof part === 'object') Object.assign(out, part)
        }
      }
    } catch (e) { }
    try {
      if (host && typeof host.getSettings === 'function') {
        const s = host.getSettings('mimo')
        if (s && typeof s === 'object') Object.assign(out, s)
      }
    } catch (e) { }
    return out
  }

  // 模型优先级：调用参数 > 宿主注入设置 > runner opts 透传 > 空（不传 --model）。
  // 用户要求「不设默认 → 由 mimo CLI 自决」，故空值绝不落地 --model。
  function effectiveModel(args, opts) {
    const o = opts || {}
    const fromArg = (args && args.model && String(args.model).trim()) || ''
    if (fromArg) return fromArg
    const fromSettings = (currentSettings().defaultModel || '').trim()
    if (fromSettings) return fromSettings
    const fromOpts = (o.settings && o.settings.defaultModel) || o.defaultModel
    return fromOpts ? String(fromOpts).trim() : ''
  }

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

  const descriptor = {
    id: 'mimo', label: 'MIMO', presetId: 'cordis-mimo', defaultBackend: null, defaultMode: 'auto',
    exeName: 'mimo', binEnvVars: ['MIMO_BIN', 'MIMO_CLI'], unavailableStatus: 'MIMO_UNAVAILABLE',

    // 单后端：backends() 恒 null；历史别名（mimocode/mimo-cli/desktop）与非法值一律
    // 归一为 null（契约 §1：非法输入返回 null）。
    backends() { return null },
    normalizeBackend() { return null },
    resolveBackend(args, target, preferred) { return null },

    // 旧 preset buildArgv(exe, args, planActive) verbatim 语义（execPrefix 可为
    // [nodeExe, binPath] 数组，runner 已归一）。
    buildArgv(exePrefix, args, opts) {
      const o = opts || {}
      const timeoutSec = clampInt(args.timeoutSec, DEFAULT_TIMEOUT_SEC, 10, 3600)
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
      // 模型：调用参数 > 设置 defaultModel > 不传（mimo CLI 自身默认）。
      const model = effectiveModel(args, o)
      if (model) argv.push('--model', String(model))
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

    // 旧 foldStepUpdate 语义 verbatim（识别 tool/text/error 事件），trail 条目同时带
    // kit 展示层字段（stepIndex/tool/state/args）与旧字段（kind/label），这样
    // renderStatus 与 MCP 快照映射（buildMcpBridgePayload）都能直接渲染。
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
      if (st === 'MIMO_UNAVAILABLE') return '[诊断] 未找到 mimo 可执行文件：请安装 MiMoCode CLI（mimo，官方便携安装位置 ~/.mimocode/bin/mimo.exe），或设置 MIMO_BIN 指向其绝对路径。'
      const hay = String(res.stderr || '') + ' ' + String(res.errorMessage || '') + ' ' + String(res.response || '')
      if (/free API service has ended|sign in|configure a third-party|登录|第三方|免费/i.test(hay)) {
        return '[诊断] MiMo 免费 API 已终止，请在 mimo CLI 用 `mimo auth login` 登录或配置第三方 API，并在 CLI Bridge 设置里指定模型。'
      }
      if (/model not found|unknown model|no models available|invalid model|unknown provider/i.test(hay)) {
        return '[诊断] mimo 模型不可用或模型名无效：先在本机运行 `mimo models` 列出可用模型，再把 provider/model 填进 CLI Bridge 的「默认模型」设置（或本次调用的 model 参数）。'
      }
      return ''
    },

    // ACCEPTED 计入成功态（指示灯不红；契约 §1）；desktop 取消后不再产生 ACCEPTED，
    // 但成功态集合逐字保持不变（兼容旧会话/测试语义）。
    isSuccessStatus(st) {
      if (!st) return false
      return st === 'SUCCESS' || st === 'ACCEPTED'
    },

    tools: {
      run: { name: 'mimo_run', description: 'Dispatch a coding/build/debug/investigation task to the local mimo agent CLI (Xiaomi MiMoCode) and return its final answer. DSH fully controls mimo (--dangerously-skip-permissions; mimo never prompts). On rate-limit/network failure DSH pops a fallback dialog; fallback=true means finish with native tools. Runs in the background by default (returns a jobId immediately; collect with job_output); set background=false to block for the final answer. While it runs, call mimo_status to watch what mimo is doing live.', inputSchema: RUN_PARAMS },
      continue: { name: 'mimo_continue', description: 'Continue an existing mimo session with a follow-up prompt. Pass sessionId or set latest=true. Same DSH-controlled, no-prompt execution and same fallback dialog as mimo_run.', inputSchema: CONTINUE_PARAMS },
      status: { name: 'mimo_status', description: 'Read a live snapshot of what the local mimo agent is currently doing. Returns one section per project (working directory): running count, current step, recent step trail, last completed run status + session id, per-project runs/token usage. Call this to check on an in-flight mimo_run/mimo_continue without waiting for it to finish.', inputSchema: STATUS_PARAMS }
    },

    // mimo_settings：入参键保持旧 prompt 连续性（backend/desktopModel → model），落统一
    // 分区 defaultModel（迁移映射 keystone 已做）。写盘仅在宿主注入 nodeFs + nodePath 时
    // 可用；否则回显（dynamic 沙箱旧 echo 语义）。
    extraTools: [{
      name: 'mimo_settings',
      description: SETTINGS_DESCRIPTION,
      inputSchema: SETTINGS_PARAMS,
      render: renderSettings,
      async logic(args) {
        const a = args || {}
        const live = liveSettings()
        const cur = Object.assign({ defaultModel: '' }, live.partition || {})
        let settingsPath = live.path || null
        let saved = false, saveError = null
        const home = live.home || deps.dshHome || null
        const patch = (typeof a.model === 'string' && a.model.trim()) ? { defaultModel: a.model.trim() } : null
        if (patch && nodeFs && nodePath && (settingsPath || home)) {
          try { settingsPath = await writePartition(nodeFs, nodePath, settingsPath, home, env, cur, patch); saved = true } catch (e) { saveError = String(e && e.message || e) }
        }
        const merged = Object.assign({}, cur)
        if (patch) merged.defaultModel = patch.defaultModel
        return {
          ok: !saveError,
          settingsPath: settingsPath || '(unified; not writable in this host)',
          defaultModel: merged.defaultModel || '',
          effective: merged.defaultModel ? ('settings:' + merged.defaultModel) : '(unset — 不传 --model，mimo CLI 自决)',
          exe: resolveMimoExePrefix(env).join(' '),
          saved, saveError,
          note: '默认模型在设置面板或本工具里指定（provider/model）；mimo_run/mimo_continue 的 model 参数可单次覆盖。可用模型：在本机运行 `mimo models` 查看。'
        }
      }
    }],

    // 设置分区（契约 §3）：keystone 读写/GUI；本处纯逻辑。diagnose/meta 必须同步。
    settings: {
      keys: ['defaultModel'],
      defaults: () => ({ defaultModel: '' }),
      normalize(raw) {
        const src = raw && typeof raw === 'object' ? raw : {}
        return { defaultModel: (typeof src.defaultModel === 'string' && src.defaultModel.trim()) ? src.defaultModel.trim() : '' }
      },
      meta(envArg) {
        const e = envArg && typeof envArg === 'object' ? envArg : env
        // 下拉选项：实时 `mimo models`（失败则退化为空 → 面板仍可自由输入）。
        let options = []
        try {
          options = fetchMimoModelsSync(e, 8000).map((m) => ({ value: m.id, label: m.id }))
        } catch (err) { options = [] }
        return {
          titleSuffix: 'MiMo',
          fields: [{
            key: 'defaultModel', label: '默认模型', type: 'select', allowCustom: true,
            options: options,
            placeholder: '留空 = 不传 --model（由 mimo CLI 自身默认决定）',
            note: options.length
              ? '共 ' + options.length + ' 个可用模型（来自 `mimo models`）。mimo_run/mimo_continue 的 model 参数可单次覆盖。'
              : '未能读取模型列表（mimo CLI 未安装/未登录/超时）—— 仍可手动输入 provider/model，如 xiaomi/mimo-v2.6-flash。'
          }]
        }
      },
      // 同步一行诊断：当前模型 + exe 来源（env > 已知安装位置 > PATH）。
      diagnose(settings, envArg) {
        const s = settings && typeof settings === 'object' ? settings : {}
        const e = envArg && typeof envArg === 'object' ? envArg : env
        const model = s.defaultModel ? 'model=' + s.defaultModel : 'model=(未设置 → 不传 --model)'
        if (e.MIMO_BIN || e.MIMO_CLI) return model + ' · bin=env:' + (e.MIMO_BIN || e.MIMO_CLI)
        const found = mimoCandidateExePaths(e)
        return model + ' · ' + (found.length ? 'bin=' + found[0] : 'bin=PATH:mimo')
      }
    },

    // MCP 形态扩展：**不含 version**。历史：四处 `mcp: { version: '0.2.2' }` 与
    // mcp/version.mjs 的 packageVersion() 双源，漏改一处就出现「统一 server 报 0.2.3、
    // provider 面仍报 0.2.2」的自相矛盾输出；且 mcp/version.mjs 依赖 import.meta + node:fs，
    // 其函数体无法随本文件内联进 dynamic 沙箱（build 文本拼接会丢实现/炸语法）。
    // 定案：版本号单一来源 = mcp/version.mjs 的 packageVersion()，由 MCP 面（mcp/providers/
    // mimo.mjs 的 meta.version）读取；描述符不复制 version 字面量，宿主如需注入可经 deps.mcp。
    mcp: (deps.mcp && typeof deps.mcp === 'object') ? Object.assign({}, deps.mcp) : {}
  }

  // 统一分区写入（tmp→rename 原子写；与 keystone lib/settings.mjs 同文件同分区规则，
  // 本工具自实现落盘 —— 不 import home-plugin；宿主给出 settingsPath 或 dshHome）。
  async function writePartition(fsMod, pathMod, knownPath, home, environment, cur, patch) {
    const file = knownPath || environment.CLI_BRIDGE_SETTINGS_FILE || (home ? pathMod.join(home, 'cli-bridge-settings.json') : null)
    if (!file) throw new Error('dsh-home not resolved (set DSH_HOME or CLI_BRIDGE_SETTINGS_FILE)')
    let all = {}
    try { all = JSON.parse(fsMod.readFileSync(file, 'utf8')) } catch (e) { all = {} }
    if (!all || typeof all !== 'object') all = {}
    const next = Object.assign({}, all)
    const part = Object.assign({}, cur, next.mimo || {})
    if (patch && patch.defaultModel) part.defaultModel = patch.defaultModel
    next.mimo = descriptor.settings.normalize(part)
    next.updatedAt = Date.now()
    try { fsMod.mkdirSync(pathMod.dirname(file), { recursive: true }) } catch (e) { }
    const tmp = file + '.tmp-' + ((typeof process !== 'undefined' && process.pid) || 'mimo')
    fsMod.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fsMod.renameSync(tmp, file)
    return file
  }

  // 三形态共用的工具逻辑。签名保持不变（keystone 与队友按此接线）。
  // 旧 mimo preset 语义：background 默认 true（仅显式 false 才前台阻塞）。
  descriptor.runToolLogic = async function (args, exec) {
    const a = args || {}
    const normalized = a.background === undefined ? Object.assign({}, a, { background: true }) : a
    return this.runner.coreExecute(normalized, exec)
  }
  descriptor.continueToolLogic = async function (args, exec) {
    const a = args || {}
    const mapped = { prompt: a.prompt, mode: a.mode, model: a.model, effort: a.effort, cwd: a.cwd, timeoutSec: a.timeoutSec, background: a.background, sessionId: a.sessionId }
    if (a.sessionId) mapped.sessionId = a.sessionId
    else if (a.latest) mapped.continueLatest = true
    return this.runToolLogic(mapped, exec)
  }
  // 旧 statusTool.execute verbatim：cwd 过滤到单项目（Object.assign 形式与 opencode 一致）。
  descriptor.statusToolLogic = async function (args) {
    const a = args || {}
    const snap = this.engine.statusSnapshot()
    if (a.cwd) {
      const key = String(a.cwd)
      snap.projects = (snap.projects || []).filter((p) => p.cwd === key)
      const g = snap.projects[0]
      if (g) {
        Object.assign(snap, {
          state: g.state, running: g.running, current: g.current, trail: g.trail,
          lastStatus: g.lastStatus, lastAt: g.lastAt, lastSessionId: g.lastSessionId,
          lastOk: g.lastOk, lastFailed: g.lastFailed, fallbackActive: g.fallbackActive,
          runs: g.runs, totalTokens: g.totalTokens, updatedAt: g.updatedAt
        })
      }
    }
    return snap
  }
  // 工厂装配（provider 无关骨架 + 描述符）；宿主注入 getSettings 时把面板偏好带进 buildArgv。
  descriptor.attach = function (hostOpts) {
    host = hostOpts || {}
    try {
      if (typeof host.getSettings === 'function') {
        const s = host.getSettings('mimo')
        if (s && typeof s === 'object') settingsRef = descriptor.settings.normalize(s)
      }
    } catch (e) { }
    this.engine = createStatusEngine({ provider: this, publish: host.publish })
    const runner = createRunner(Object.assign({}, host, { provider: this, engine: this.engine }))
    this.runner = runner
    return runner
  }
  // 测试/宿主可见的纯函数面（不进协议字段）。currentSettings/liveSettings/writePartition 是
  // 闭包函数，不依赖 attach（未 attach 时 host 为 null → 走 deps 注入或默认空值），测试可
  // 直接调用；writePartition 需要调用方自行传入可用的 fs/path 模块。
  descriptor._internals = { MIMO_LIMIT_RE, parseMimoJson, buildResult,
    mimoCandidateExePaths, resolveMimoExePrefix, parseMimoModels, fetchMimoModelsSync,
    currentSettings, liveSettings, writePartition
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

    // exe：MIMO_BIN/MIMO_CLI env > 已知安装位置 > PATH 查找 mimo
    // （subprocess.resolveExecutable）。与 descriptor 的 resolveMimoExePrefix 同一套
    // 优先级；.js/.mjs 目标经 process.execPath 包装（供测试 fixture 使用）。
    async function resolveExe(backend, signal) {
      const prefix = resolveMimoExePrefix(env)
      if (prefix.length && prefix[0]) {
        const head = String(prefix[0])
        if (prefix.length > 1) return prefix
        if (/\.(mjs|cjs|js)$/i.test(head) && typeof process !== 'undefined' && process.execPath) return [process.execPath, head]
        return head
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

    // 设置分区（descriptor 的 host.getSettings('mimo') 契约：直接返回分区对象
    // { defaultModel } 或空对象）。每次调用重读统一设置文件 —— 面板改默认模型后
    // 无需重启即生效；读不到（沙箱无 fs / 文件缺失）回落 {} = 不传 --model。
    function getSettings() {
      try {
        const proc = (typeof process !== 'undefined') ? process : null
        const nodeFs = (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('node:fs') : null
        if (!nodeFs || typeof nodeFs.readFileSync !== 'function') return {}
        const nodePath = (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('node:path') : null
        const join = nodePath ? nodePath.join.bind(nodePath) : ((...p) => p.join('/'))
        const file = env.CLI_BRIDGE_SETTINGS_FILE || (env.DSH_HOME ? join(env.DSH_HOME, 'cli-bridge-settings.json') : null)
        if (!file) return {}
        const all = JSON.parse(nodeFs.readFileSync(file, 'utf8'))
        if (all && typeof all === 'object' && all.mimo && typeof all.mimo === 'object') return all.mimo
      } catch (e) { /* 读不到：回落空分区（默认模型为空 → 不传 --model） */ }
      return {}
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

    provider.attach({ ctx, subprocess, resolveExe, getCwdFallback, getSettings, planActiveFor, publish })

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

    // 提示词连续性（契约 §8）：决策表 / 上下文协议 / 回退协议三段保留旧语义；后端段与
    // 模型段随「去 desktop 化 + 模型手动指定」重写（免费 API 已终止 + mimo auth login）。
    // 与 preset/mimo-first/cli-bridge.mjs 的 policy 段保持同文。
    const policyText = [
      'mimo-first execution policy (Xiaomi MiMo: MiMoCode CLI).',
      '',
      'Local `mimo` CLI (MiMoCode) handles coding tasks under full DSH control (--dangerously-skip-permissions, never prompts).',
      '',
      'Model:',
      '- The model is chosen in the CLI Bridge settings panel (provider/model form, e.g. xiaomi/mimo-v2.6-flash) — this bridge does not pick one.',
      '- Leave the setting empty to pass no --model, letting the mimo CLI use its own default. A per-call `model` argument overrides the setting for that call only.',
      '- List available models with `mimo models` on this machine.',
      '',
      'Credentials:',
      "- Xiaomi MiMo's free API service has ENDED. The user must run `mimo auth login` (or configure a third-party API) on this machine before dispatch works.",
      '- If a run fails with sign-in / free-API-ended errors, tell the user to log in. Do not retry in a loop.',
      '',
      'By default, dispatch runs in the background and returns a jobId immediately; collect via job_output and watch live progress via mimo_status.',
      '',
      'Decision table for tool selection:',
      '- Single read/glob/grep or short (<30s) command -> Native tools.',
      '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> mimo_run.',
      '- Follow-ups on the same topic -> mimo_continue (with latest=true or sessionId; context is preserved).',
      '- Final build/test verification of mimo output -> Native tools.',
      '- Plan / read-only analysis -> mimo_run with mode=plan.',
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
