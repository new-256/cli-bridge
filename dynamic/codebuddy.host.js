// dynamic/codebuddy.host.template.mjs — codebuddy 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=codebuddy）把 core/bridge-kit.mjs 与
// providers/codebuddy.mjs 分别内联进下方两个占位标记行（各占一行、行内仅此标记），
// 生成 dynamic/codebuddy.host.js。注意：标记字面量绝不能出现在本注释里 —— 构建做全局
// 替换，注释中出现同样会被替换成正文代码而炸掉语法。
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生
//    定时器 —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层
//    return 合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('codebuddy', snap)
//    推给家级灯（旧 codebuddyCollector 服务名在 keystone 里保留别名）；动态形态不宣告
//    mode（旧语义：普通模式灯仅在调用 codebuddy 时临时显示）。
//  - exe 解析保持旧动态三面语义（各产品面登录互斥、不跨面回退）：workbuddy /
//    codebuddy-en 用各自的 Program Files 候选（WORKBUDDY_BIN / CODEBUDDY_EN_BIN 覆盖）；
//    npm 面走 CODEBUDDY_BIN > subprocess.resolveExecutable(PATH) > npm 全局 bin 脚本。
//  - 设置：沙箱经 getBuiltinModule('node:fs') 读一次统一设置文件（apply 时一次，
//    旧 dynamic 语义）；不可得时回退旧扁平文件，再不可得用默认值。EN 面无凭据且
//    无 fs（descriptor 的 dsh-store 通道缺席）→ preflight 确定性 abort 给提示即可。
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

// providers/codebuddy.mjs — codebuddy provider descriptor（真移植，替换 Lead 冒烟占位）。
//
// 移植基线：codebuddy-first-bridge v1.6.x core/codebuddy-core.mjs 的纯逻辑
// （后端注册表/端点对齐/凭据链/模型目录/buildArgv/parseCodebuddyJson/buildResult/
// foldEvent/settings 清洗/三工具 schema）与 preset/codebuddy-first 内联语义，
// 逐字保持（PROVIDER-CONTRACT.md §8 红线：工具入参语义与 schema 不许漂移）。
// 与 provider 无关的骨架（状态引擎/行流/回退弹窗/展示层）在 core/bridge-kit.mjs。
//
// TODO（Lead 定案，0.1.0 不做）：旧包 credits/促销面板的 modelPromotions /
// isPromotionActive / activePromotionFor（约 200 行）不进统一设置面板；本版
// modelCatalogDetailed 只给「倍率 + 授权」两标（无促销角标），行为差异在设置面板
// 单列，运行面（buildArgv/CLI 选择）不受影响。
//
// 红线（PROVIDER-CONTRACT.md §8）：
//  - 本文件会被 build 内联进 dynamic 沙箱（new Function）：绝不出现元环境字面量；
//    process/env/fs 只经 deps 注入或 typeof 守卫读取；宿主能力全部走 attach(hostOpts)。
//  - 只允许 import '../core/bridge-kit.mjs' 一行。
//  - isLimited 用本文件自定义的中文限流表（旧 core verbatim），不用 kit 通用表。

// ── 提示词策略段（旧 preset POLICY_TEXT verbatim；systemPrompt order 5）────────
const POLICY_TEXT = [
  'codebuddy-first execution policy (local codebuddy CLI bridge, with fallback + live indicator + live status tool).',
  '',
  'A local sub-agent CLI named "codebuddy" (Tencent CodeBuddy Code) is available through the codebuddy_run and codebuddy_continue tools. DSH fully controls codebuddy: every invocation runs non-interactively with permissions auto-approved (--permission-mode bypassPermissions), so codebuddy never prompts and DSH decides all of its work. A header status light shows when codebuddy is working — one light per project (working directory), so parallel runs in different projects are tracked separately; call codebuddy_status any time to see what codebuddy is doing right now (per project: current tool/step, recent trail, and cumulative usage).',
  '',
  'Priority rule for EVERY mode (normal, plan, accept-edits, subagent/workflow/ralph delegation, and goal rounds):',
  '- For any real work — implementing features, editing/refactoring code, debugging, running builds, or multi-file investigation — prefer dispatching the task to codebuddy_run FIRST with a complete, self-contained prompt.',
  '- Use native read/write/shell tools mainly for quick read-only lookups and for the final build/test verification of what codebuddy produced.',
  '- In plan mode, call codebuddy_run with mode=auto (or mode=plan); in accept-edits/normal mode codebuddy_run applies edits directly.',
  '- When you delegate to a DSH subagent or workflow, instruct that delegate to also prefer codebuddy_run.',
  '- For long-running tasks, call codebuddy_run with background=true and collect the result with job_output; use codebuddy_status to watch progress.',
  '',
  'Fallback protocol: when codebuddy is rate-limited or the network is down, codebuddy_run/codebuddy_continue automatically pop a confirmation dialog asking the user whether to use the DSH local API config. If the returned result has fallback=true (status FALLBACK_TO_DSH), the user chose to fall back: complete the task with native DSH tools / the local model and DO NOT call codebuddy again for this task. If ok=false without fallback, report the codebuddy error. Never loop codebuddy calls; never ask codebuddy to call back into DSH.',
  '',
  'Model selection: codebuddy_run takes an optional model. When unspecified, the CLI default applies unless the user set a preferred default model in the plugin settings (then that is injected automatically per call). Which models ACTUALLY WORK depends on the ACCOUNT, and the authoritative live list comes from the server: running the CLI with a nonexistent model returns 400 followed by "Currently supported models for your account:" and one "- <id>" per line (core exposes parseAccountModels for this; the plugin caches the result automatically and the settings panel shows exactly those ids, with the credit multiplier of each). Do NOT trust the bundled product descriptor as a menu of usable models: it lists ids with an "-ioa" suffix (glm-5.3-ioa) and expensive flagships (claude-opus-4.8, gpt-5.4, gpt-6-astra) that are present in the catalogue but NOT licensed for this account, and picking one fails with 400 "only available for authorized users". The four backends are also not one pool: "codebuddy" and "codebuddy-intl" are the npm CLI and offer its catalogue - including the free tier (hy3 and deepseek-v4.1-flash cost x0.00 credits; hy4-preview costs x0.29 but is frequently free on promotional accounts); "codebuddy-en" (WorkBuddyAI) has its OWN catalogue which does NOT contain hy4-preview or deepseek-v4.1-flash - it offers hy3 (free), gpt-5.1-codex-mini, gemini-3.1-flash-lite, gemini-2.5-flash, minimax-m3, gemini-3.0-flash, deepseek-v3-2-volc, kimi-k2.5/2.6, glm-5.0/5.2/5.3, gpt-5.3-codex, gpt-5.4/5.5, gpt-5.6-sol/terra/luna and the role aliases (fast/balanced/primary/deep-model); "workbuddy" (domestic desktop) has a further catalogue (auto, hy4-preview, hy3, deepseek-v4.1-flash, glm-5.x, kimi-k2.6/2.7/2.8-preview/k3-1, minimax-m3/m2.7, deepseek-v4-pro). Within a face availability is still gated per ACCOUNT: an id outside the account catalogue fails with "400 model [...] service info not found", and one inside it but unlicensed fails with "400 model [...] is only available for authorized users". International ids (claude-sonnet-5, claude-opus-5, gemini-3.1-pro, ...) are per-account gated and return the latter for a domestic account. COST: every id carries a credit multiplier in the credits field of its descriptor (x0.00 means free, x3.31 means 3.31x the base rate); the settings panel shows each candidate with its multiplier and reads it live from the CLI descriptor, so it stays in sync when the CLI is upgraded. Measured free (x0.00) models for this account: hy3 and deepseek-v4.1-flash (both npm faces) and hy3 for WorkBuddyAI; hy4-preview is x0.29 on npm faces. Prefer the cheapest model that can do the job and use a free one for routine work; do not silently upgrade to an expensive id when the task is simple. To get the exact live list for a CLI, run it with a deliberately invalid model id - the reply prints "Currently supported models for your account:" followed by one "- <id>" per line (core exposes parseAccountModels for this). Pass a model only when the task clearly benefits from a specific one; the default is usually right. Optional effort: minimal/low/medium/high/xhigh/max. Optional maxTurns caps agentic turns (default unlimited).',
  '',
  'Backends: codebuddy_run/codebuddy_continue take an optional backend parameter choosing which CLI face of the same engine (Tencent CodeBuddy Code) runs the task. "codebuddy" is the domestic CodeBuddy (npm CLI @tencent-ai/codebuddy-code, product endpoint www.codebuddy.ai) — default for coding work. "codebuddy-intl" is the INTERNATIONAL face of that SAME npm CLI (product.ioa.json catalogue: claude-sonnet-5, claude-opus-5, gemini-3.1-pro, gpt-6-astra, hy3-ioa …); use it when the account is an international CodeBuddy account. Its aliases "codebuddy-ioa" and "codebuddy-international" are accepted and normalized to codebuddy-intl. "codebuddy-en" is the WorkBuddy INTERNATIONAL edition — the CLI bundled with the WorkBuddyAI desktop app (C:\\Program Files\\WorkBuddyAI, product endpoint www.workbuddy.ai); the aliases "workbuddy-en" and "workbuddy-ai" are also accepted and normalized to codebuddy-en. "workbuddy" is the CLI bundled with the domestic WorkBuddy desktop app (product endpoint copilot.tencent.com, zero config) — the office-scenario face: documents, slides, spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies. When the user asks for office/document/IM work, dispatch with backend="workbuddy"; for international accounts use "codebuddy-intl" (CodeBuddy 国际版) or "codebuddy-en" (WorkBuddy 国际版 / WorkBuddyAI). Sessions are kept per backend (login domains are exclusive), and continuing a session automatically routes back to the backend that owns it (explicit backend wins). A user-preferred default backend (plugin settings) applies when a call is new (no session) and no explicit backend is given.'
].join('\n')

// ── 限流/网络/认证失败判定（旧 core verbatim）。仅匹配 stderr + status；数字码
// 加词边界（避免 "1500" 命中 500、"4013" 命中 401）。中文码（流量/受限/金额/
// 余额/额度/认证/连接/断开 等）为 codebuddy 面专属，必须逐字保留。
// 命名纪律（mimo 同款）：本文件顶层名绝不与 core/bridge-kit.mjs 顶层导出同名 ——
// dynamic 形态把 kit 与 provider 内联进同一脚本作用域，同名 const 直接炸语法
// （LIMIT_RE 在 kit L33 已有，故此处带 CODEBUDDY_ 前缀）。
const CODEBUDDY_LIMIT_RE = /rate.?limit|ratelimit|\b429\b|too many|quota|insufficient|credit|balance|exhausted|exceed|\bnetwork\b|offline|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|\btimeouts?\b|timed out|unavailable|\b50[023]\b|\b40[13]\b|unauthorized|invalid api|api key|proxy|socket|tls|ssl|\bdns\b|网络|超时|限流|流量|受限|配额|金额|余额|额度|认证|连接|断开/i

// ── 后端注册表（旧 core verbatim：端点按登录域自动对齐）───────────────────────
const BACKENDS = ['codebuddy', 'codebuddy-intl', 'codebuddy-en', 'workbuddy']

const BACKEND_ENDPOINTS = {
  'codebuddy': 'https://www.codebuddy.ai/v2',
  'codebuddy-intl': 'https://www.codebuddy.ai/v2',
  'codebuddy-en': 'https://www.workbuddy.ai/v2',
  'workbuddy': 'https://copilot.tencent.com/v2'
}

const AUTH_DOMAIN_ENDPOINTS = {
  'www.codebuddy.cn': 'https://www.codebuddy.cn/v2',
  'www.codebuddy.ai': 'https://www.codebuddy.ai/v2',
  'www.workbuddy.ai': 'https://www.workbuddy.ai/v2',
  'copilot.tencent.com': 'https://copilot.tencent.com/v2'
}

const BACKEND_AUTH_IDS = {
  'codebuddy': 'Tencent-Cloud.coding-copilot',
  'codebuddy-intl': 'Tencent-Cloud.coding-copilot',
  'codebuddy-en': 'workbuddy-desktop-ai',
  'workbuddy': 'workbuddy-desktop'
}

const BACKEND_LABELS = {
  'codebuddy': 'CodeBuddy 国内版（npm CLI）',
  'codebuddy-intl': 'CodeBuddy 国际版（npm CLI · 国际面）',
  'codebuddy-en': 'WorkBuddy 国际版（WorkBuddyAI 桌面 CLI）',
  'workbuddy': 'WorkBuddy 国内版（桌面 CLI）'
}

const BACKEND_ALIASES = {
  'workbuddy-en': 'codebuddy-en',
  'workbuddy-ai': 'codebuddy-en',
  'codebuddy-ioa': 'codebuddy-intl',
  'codebuddy-international': 'codebuddy-intl',
  'codebuddy-oversea': 'codebuddy-intl'
}

const DEFAULT_BACKEND = 'codebuddy'

const SETTINGS_KEYS = ['preferredBackend', 'defaultModel', 'codebuddyEnToken', 'endpointOverride']

// codebuddy-en 凭据的第三条通道：DSH 凭据库里可能已有的 workbuddy key（旧 core verbatim）。
const CREDENTIAL_KEYS = ['WORKBUDDY_TOKEN', 'WORKBUDDY_AI_TOKEN', 'CODEBUDDY_EN_TOKEN']

// 离线/读不到描述文件时的回退静态表（真机按账号实测快照，2026-09）。
const BACKEND_MODEL_IDS = {
  'codebuddy': ['hy4-preview', 'hy3', 'hy3-x', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3', 'minimax-m2.7', 'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro'],
  'codebuddy-intl': ['claude-sonnet-5', 'claude-sonnet-5-1m', 'claude-opus-5', 'claude-opus-4.8', 'claude-opus-4.8-1m', 'gemini-3.1-pro', 'gemini-3.5-flash', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'glm-5.3-ioa', 'glm-5.3-flash-ioa', 'glm-5.2-ioa', 'kimi-k3-ioa', 'kimi-k2.8-preview', 'kimi-k2.6-ioa', 'minimax-m3-ioa', 'minimax-m2.7-ioa', 'deepseek-v4.1-flash', 'deepseek-v4-pro-ioa'],
  // WorkBuddyAI 自制目录（product.json 顶层 37 项，按其 credits 排序：免费的在前）
  'codebuddy-en': ['hy3', 'gpt-5.1-codex-mini', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'minimax-m3', 'gemini-3.0-flash', 'fast-model', 'deepseek-v3-2-volc', 'balanced-model', 'kimi-k2.5', 'kimi-k2.6', 'default-model-lite', 'glm-5.3', 'glm-5.2', 'glm-5.0', 'gpt-5.1-codex', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gpt-5.3-codex', 'gemini-3.1-pro', 'gpt-5.6-terra', 'kimi-k3', 'gpt-5.4', 'primary-model', 'default-model', 'deep-model', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-luna'],
  // WorkBuddy 国内桌面自制目录（product.json：applicationName=WorkBuddy）
  'workbuddy': ['auto', 'hy4-preview', 'hy3', 'hy3-x', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3', 'minimax-m2.7', 'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro']
}

// 各后端真正生效的 product 描述文件位置（旧 core v1.6.1 verbatim）。
const PRODUCT_DESCRIPTOR_ENV = {
  'codebuddy': { env: 'CODEBUDDY_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: null },
  'codebuddy-intl': { env: 'CODEBUDDY_INTL_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: null },
  'codebuddy-en': { env: 'CODEBUDDY_EN_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: '.workbuddy-ai' },
  'workbuddy': { env: 'WORKBUDDY_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: '.workbuddy' }
}

// 倍率跨命名匹配（账号清单 id → 描述文件 id，旧 core verbatim）。
const CREDIT_ID_ALIASES = {
  'kimi-k3-1': ['kimi-k3', 'kimi-k3-ioa'],
  'hy3-x': ['hy3', 'hy3-ioa'],
  'default': ['codewise-default-model-v2'],
  'auto': ['hy3', 'hy3-ioa']
}

const MODEL_DESCRIPTION = 'Optional model id. When unspecified, the user-preferred default model (plugin settings) is used if set, else the CLI default. Two layers decide: the PRODUCT FACE decides whether the id exists in its catalogue, then the ACCOUNT decides whether it is licensed. The free tier (hy3, deepseek-v4.1-flash at x0.00 credits; hy4-preview at x0.29) belongs to the npm CLI faces codebuddy/codebuddy-intl: hy4-preview, hy3, hy3-x, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3, minimax-m2.7, kimi-k3-1, kimi-k2.8-preview, kimi-k2.7, kimi-k2.6, deepseek-v4-pro. codebuddy-en (WorkBuddyAI) carries NO hy4-preview and NO deepseek-v4.1-flash; its only free model is hy3. International ids (claude-sonnet-5, gemini-3.1-pro, ...) are account-gated. Availability is per ACCOUNT: the CLI rejects an id outside the account catalogue with "400 service info not found" and one inside it but unlicensed with "400 only available for authorized users" (many catalogue flagships such as claude-opus-4.8, gpt-5.4 and gpt-6-astra are in this second group for a domestic account). Run the CLI with a deliberately invalid model id to print "Currently supported models for your account:" and get the authoritative list; the plugin caches that result and the settings panel lists exactly those ids with their credit multiplier (x0.00 = free), read live from the CLI descriptor so it stays in sync with CLI upgrades. Prefer the cheapest model that can do the job, and prefer a free (x0.00) one for routine work. Pass a model only when the task clearly benefits from a specific one.'

const BACKEND_ENUM = ['codebuddy', 'codebuddy-intl', 'codebuddy-ioa', 'codebuddy-international', 'codebuddy-en', 'workbuddy-en', 'workbuddy-ai', 'workbuddy']

// ── 三工具 schema（旧 preset/codebuddy-first verbatim；契约 §8）────────────────
const RUN_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The full task/instruction for codebuddy. Be complete and self-contained.' },
    backend: { type: 'string', enum: BACKEND_ENUM, description: 'Which CLI face to dispatch to. codebuddy (default; domestic CodeBuddy npm CLI, product endpoint www.codebuddy.ai) for coding work; codebuddy-intl = CodeBuddy INTERNATIONAL face of the same npm CLI (product.ioa.json catalogue: claude-sonnet-5 / claude-opus-5 / gemini-3.1-pro / gpt-6-astra / hy3-ioa ...; aliases codebuddy-ioa / codebuddy-international) when the account is an international CodeBuddy account; codebuddy-en = WorkBuddy international edition (the WorkBuddyAI desktop bundled CLI at C:\\Program Files\\WorkBuddyAI, product endpoint www.workbuddy.ai; needs codebuddyEnToken unless DSH already holds a workbuddy key) — aliases workbuddy-en / workbuddy-ai also accepted; workbuddy = WorkBuddy domestic desktop CLI (product endpoint copilot.tencent.com, zero config), the office-scenario face: documents/slides/spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies. New calls without a backend follow the user-preferred default backend (plugin settings). Continuing a session routes back to its owning backend automatically.' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'auto follows DSH plan state; plan = no writes; accept-edits = allow edits. Default auto.' },
    model: { type: 'string', description: MODEL_DESCRIPTION },
    effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' },
    maxTurns: { type: 'integer', description: 'Optional max agentic turns (1-500, default unlimited).' },
    cwd: { type: 'string', description: 'Working directory for codebuddy. Defaults to the DSH workspace root.' },
    addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to add to codebuddy workspace.' },
    timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' },
    background: { type: 'boolean', description: 'Run as a background job and return a jobId immediately.' }
  }
}
const CONTINUE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing codebuddy conversation.' },
    sessionId: { type: 'string', description: 'codebuddy session id to resume (from a prior codebuddy_run result).' },
    latest: { type: 'boolean', description: 'Continue the most recent codebuddy conversation instead of a specific id.' },
    backend: { type: 'string', enum: BACKEND_ENUM, description: 'Which CLI face to resume on. codebuddy-en = WorkBuddy international (WorkBuddyAI desktop CLI; aliases workbuddy-en / workbuddy-ai accepted), workbuddy = WorkBuddy domestic desktop CLI. When omitted, the backend that owns the sessionId is used automatically; brand-new conversations follow the user-preferred default backend (plugin settings).' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'Execution mode; default auto.' },
    model: { type: 'string', description: 'Optional model id (two layers: product face carries it, account licenses it; the credit multiplier of each id comes from the CLI descriptor — see codebuddy_run).' },
    effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' },
    maxTurns: { type: 'integer', description: 'Optional max agentic turns.' },
    cwd: { type: 'string', description: "Working directory for codebuddy; when resuming, defaults to the resumed session's project directory." },
    timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' },
    background: { type: 'boolean', description: 'Run as a background job and return a jobId immediately.' }
  }
}
const STATUS_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }

function defineProvider (deps = {}) {
  const env = deps.env || {}
  let host = null // attach 后保存 hostOpts（preset/dynamic/MCP 形态宿主能力）

  // 宿主 fs/path 访问的统一入口：deps 注入优先；dynamic 内联体（无 import，运行在
  // 后端 Node 上下文）回退到 getBuiltinModule —— 与旧 core builtinModule() 的
  // typeof 守卫模式一致（这是旧 dynamic 端点修复生效的同一条通道，缺了它默认
  // 后端会回到 401 老病）。两者皆不可用时自然降级：读不到文件 = 静态表兜底。
  function builtinModule(name) {
    try {
      const proc = globalThis.process
      return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule(name) : null
    } catch (e) { return null }
  }
  function fsRead(p) {
    const nf = deps.nodeFs || builtinModule('node:fs')
    if (!nf || typeof nf.readFileSync !== 'function') return null
    try { return nf.readFileSync(p, 'utf8') } catch (e) { return null }
  }
  function pathJoin(...parts) {
    const np = deps.nodePath || builtinModule('node:path')
    if (np && typeof np.join === 'function') return np.join(...parts)
    return parts.join('/')
  }
  const pathSep = (deps.nodePath && deps.nodePath.sep) || (/[A-Za-z]:[\\/]/.test(env.USERPROFILE || env.APPDATA || '') ? '\\' : '/')

  // ── 端点/登录域（旧 core endpointHost verbatim：非法 URL 容错）───────────────
  function endpointHost(url) {
    const s = String(url || '').trim()
    if (!s) return ''
    try { return new URL(s).hostname.toLowerCase() } catch (e) { }
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(s)
    return m ? m[1].toLowerCase() : ''
  }

  function resolveEndpoint(explicitBaseUrl, authDomain) {
    const explicit = String(explicitBaseUrl || '').trim()
    if (explicit) return explicit
    const d = String(authDomain || '').trim().toLowerCase()
    if (d && AUTH_DOMAIN_ENDPOINTS[d]) return AUTH_DOMAIN_ENDPOINTS[d]
    return null
  }

  function isBackend(v) { return BACKENDS.indexOf(v) >= 0 }

  // 后端名规范化（v1.3.3 verbatim）：别名 + 大小写不敏感；非后端名原样返回。
  function normalizeBackend(v) {
    if (typeof v !== 'string') return v
    const lower = v.trim().toLowerCase()
    const aliased = BACKEND_ALIASES[lower] || lower
    return BACKENDS.indexOf(aliased) >= 0 ? aliased : v
  }

  // 后端解析优先级（旧 core verbatim）：显式 > 会话归属 > 用户偏好 > 默认。
  function resolveBackend(args, target, preferredBackend) {
    if (args && isBackend(normalizeBackend(args.backend))) return normalizeBackend(args.backend)
    if (target && target.backend && isBackend(normalizeBackend(target.backend))) return normalizeBackend(target.backend)
    if (preferredBackend && isBackend(normalizeBackend(preferredBackend))) return normalizeBackend(preferredBackend)
    return DEFAULT_BACKEND
  }

  // 本次调用的端点/凭据 env 注入（旧 core endpointEnv verbatim 三规则）。
  function endpointEnv(backend, explicitBaseUrl, authDomain, authToken) {
    const out = {}
    const endpoint = resolveEndpoint(explicitBaseUrl, authDomain)
    const product = BACKEND_ENDPOINTS[backend]
    if (endpoint && endpointHost(endpoint) !== endpointHost(product)) {
      out.CODEBUDDY_BASE_URL = endpoint
    }
    if (backend === 'codebuddy-en') {
      const tok = String(authToken || '').trim()
      if (tok) out.CODEBUDDY_AUTH_TOKEN = tok
    }
    return Object.keys(out).length ? out : null
  }

  // 可操作提示（旧 core endpointMismatchHint 三分支 verbatim）。
  function endpointMismatchHint(backend, authDomain, hasToken) {
    if (backend === 'codebuddy-en' && !hasToken) {
      return 'codebuddy-en（WorkBuddy 国际版）没有可用凭据。国际版的登录 token 被桌面 App 的 protector key 封装，该密钥不落盘、headless CLI 无法自行读取（CLI 自身报 category:"missing-key"）。桥接会依次尝试：插件设置 codebuddyEnToken → 环境变量 CODEBUDDY_AUTH_TOKEN → DSH 凭据库（.credentials.yaml / .env 里的 WORKBUDDY_TOKEN）——三者皆空。请在 DSH 里配好 workbuddy provider 的 key，或把国际版 token 填入插件设置；也可直接用 backend="workbuddy"（国内版桌面 CLI，免配置）。'
    }
    if (backend === 'codebuddy-intl') {
      return 'codebuddy-intl（CodeBuddy 国际版）使用同一个 npm CLI，但国际面模型由服务端按账号授权放行：未授权时 CLI 返回 400「model [...] is only available for authorized users」。若你用的是国内账号，请改用 backend="codebuddy"（国内面模型清单）或 backend="codebuddy-en"（WorkBuddy 国际版）。'
    }
    const d = String(authDomain || '').trim().toLowerCase()
    if (d && endpointHost(resolveEndpoint(null, d)) !== endpointHost(BACKEND_ENDPOINTS[backend])) {
      return backend + ' 的登录域是 ' + d + '，与产品端点 ' + BACKEND_ENDPOINTS[backend] + ' 不一致；桥接层已自动注入 CODEBUDDY_BASE_URL=' + AUTH_DOMAIN_ENDPOINTS[d] + '。若仍 401，请重新登录对应客户端。'
    }
    return null
  }

  // 从 auth 库读某后端登录域（旧 core readBackendAuthDomain verbatim 语义；fs 经
  // deps 注入。io 可覆盖 readFileSync/dir/env，供测试夹具与 MCP 面注入真实 fs）。
  function readBackendAuthDomain(backend, io) {
    const o = io || {}
    const id = BACKEND_AUTH_IDS[backend]
    if (!id) return null
    try {
      const read = o.readFileSync || fsRead
      if (typeof read !== 'function') return null
      const e = o.env || env
      let dir = o.dir
      if (!dir) {
        dir = e.CODEBUDDY_AUTH_DIR ||
          pathJoin(e.LOCALAPPDATA || 'C:\\Users\\lcl\\AppData\\Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
      }
      const sep = String(dir).indexOf('\\') >= 0 ? '\\' : '/'
      const txt = read(dir + sep + id + '.info', 'utf8')
      if (txt == null) return null
      const raw = JSON.parse(txt)
      const d = raw && raw.auth && raw.auth.domain
      return typeof d === 'string' && d.trim() ? d.trim() : null
    } catch (e) { return null }
  }

  // DSH 凭据库第三通道（旧 core readDshWorkbuddyToken verbatim 语义；CODEBUDDY_
  // CREDENTIALS_DIR 覆盖测试夹具；fs 经 deps 注入）。
  function readDshWorkbuddyToken() {
    const overrideDir = env.CODEBUDDY_CREDENTIALS_DIR || null
    const home = overrideDir || env.DSH_HOME || null
    if (!home) return null
    const files = [home + '\\.credentials.yaml', home + '\\.env', home + '/.credentials.yaml', home + '/.env']
    for (const f of files) {
      const text = fsRead(f)
      if (!text) continue
      for (const key of CREDENTIAL_KEYS) {
        const m = text.match(new RegExp('^[ \\t]*' + key + '[ \\t]*[:=][ \\t]*(.+)$', 'm'))
        if (!m) continue
        const v = m[1].trim().replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim()
        // 只接受看起来是真实 token 的值（避免把 $VAR 引用或占位符当凭据）。
        if (v.length >= 40 && !v.startsWith('$') && !/^<.*>$/.test(v)) return v
      }
    }
    return null
  }

  // codebuddy-en 凭据链（旧 core verbatim）：设置面板 > CODEBUDDY_AUTH_TOKEN >
  // DSH 凭据库。dynamic 沙箱无 fs → 第三通道自然缺席（旧 dynamic 本也有限）。
  function resolveEnToken(settingToken) {
    const s = String(settingToken || '').trim()
    if (s) return { token: s, source: 'setting' }
    const envTok = env.CODEBUDDY_AUTH_TOKEN || ''
    if (String(envTok).trim()) return { token: String(envTok).trim(), source: 'env' }
    const fromStore = readDshWorkbuddyToken()
    if (fromStore) return { token: fromStore, source: 'dsh-store' }
    return { token: null, source: null }
  }

  // ── 模型目录（面板/诊断用；无促销角标版，见头注 TODO）───────────────────────
  function accountConfigCandidates(backend) {
    const spec = PRODUCT_DESCRIPTOR_ENV[backend]
    if (!spec || !spec.accountDir) return []
    const home = env.USERPROFILE || env.HOME
    if (!home) return []
    const base = pathJoin(home, spec.accountDir.split('/').join(pathSep))
    return [
      pathJoin(base, 'cache', 'acc-product-config-v3.json'),
      pathJoin(base, 'local_storage', 'entry_d43e96994f944cfb77961c2ea7d04605.info'),
      pathJoin(base, 'local_storage', 'wb_entry_d43e96994f944cfb77961c2ea7d04605.info')
    ]
  }

  function productDescriptorCandidates(backend) {
    const spec = PRODUCT_DESCRIPTOR_ENV[backend]
    if (!spec) return []
    const out = []
    for (const p of accountConfigCandidates(backend)) out.push(p)
    if (env[spec.env]) out.push(env[spec.env])
    const rels = spec.fallbackRel ? [spec.rel, spec.fallbackRel] : [spec.rel]
    const push = (root) => { if (root) for (const r of rels) out.push(pathJoin(root, ...r.split('/'))) }
    if (backend === 'codebuddy' || backend === 'codebuddy-intl') {
      push(env.APPDATA ? pathJoin(env.APPDATA, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code') : null)
    } else if (backend === 'codebuddy-en') {
      push('C:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli')
    } else if (backend === 'workbuddy') {
      push('C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli')
    }
    return out
  }

  function normalizeProductConfig(raw) {
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!obj) return null
      if (Array.isArray(obj)) {
        // 数组形态：从后往前找第一个带 data 的条目（末尾最新）。
        for (let i = obj.length - 1; i >= 0; i--) {
          const e = obj[i]
          if (e && typeof e === 'object' && e.data && typeof e.data === 'object') return e.data
        }
        return null
      }
      if (typeof obj !== 'object') return null
      if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.models) && !Array.isArray(obj.agents)) return obj.data
      return obj
    } catch (e) { return null }
  }

  function extractModelIds(productJson) {
    try {
      const obj = normalizeProductConfig(productJson)
      if (!obj || typeof obj !== 'object') return null
      const pick = (arr) => {
        if (!Array.isArray(arr) || !arr.length) return null
        const ids = arr.map((m) => (typeof m === 'string' ? m : m && m.id)).filter((s) => typeof s === 'string' && s.trim())
        return ids.length ? [...new Set(ids)] : null
      }
      const agents = Array.isArray(obj.agents) ? obj.agents : []
      const cli = agents.find((a) => a && a.name === 'cli')
      const fromCli = cli ? pick(cli.models) : null
      const fromTop = pick(obj.models)
      if (fromCli && fromTop) return fromTop.length > fromCli.length ? fromTop : fromCli
      return fromCli || fromTop || null
    } catch (e) { return null }
  }

  function parseCreditValue(raw) {
    if (typeof raw !== 'string') return null
    const s = raw.trim()
    let m = s.match(/^[xX×]\s*([0-9]+(?:\.[0-9]+)?)/)
    if (!m) m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*[xX×]/)
    if (!m) return null
    const n = Number(m[1])
    return Number.isFinite(n) ? n : null
  }

  function formatCreditLabel(credits) {
    if (typeof credits !== 'number' || !Number.isFinite(credits)) return ''
    if (credits === 0) return '免费'
    return `x${credits.toFixed(2)}`
  }

  function extractModelCredits(productJson) {
    try {
      const obj = normalizeProductConfig(productJson)
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.models)) return null
      const map = new Map()
      for (const m of obj.models) {
        if (!m || typeof m !== 'object') continue
        const id = typeof m.id === 'string' ? m.id.trim() : ''
        if (!id) continue
        const n = parseCreditValue(m.credits)
        if (n !== null) map.set(id, n)
      }
      return map.size ? map : null
    } catch (e) { return null }
  }

  function lookupModelCredits(creditsMap, id) {
    if (!creditsMap || typeof id !== 'string') return null
    const norm = id.trim()
    const cands = [norm]
    if (norm.endsWith('-ioa')) cands.push(norm.slice(0, -4))
    else cands.push(norm + '-ioa')
    if (CREDIT_ID_ALIASES[norm]) cands.push(...CREDIT_ID_ALIASES[norm])
    for (const c of cands) {
      if (creditsMap.has(c)) {
        const v = creditsMap.get(c)
        if (typeof v === 'number') return v
      }
    }
    return null
  }

  function backendModelCatalog(backend, io) {
    const known = BACKEND_MODEL_IDS[backend] || []
    const read = (io && io.readFileSync) || fsRead
    let fromFile = null
    let fromFileRich = null
    // 旧 v1.6.1 语义：第一份有内容的 + 第一份带促销的，优先后者。
    for (const p of productDescriptorCandidates(backend)) {
      let txt = null
      try { txt = read ? read(p, 'utf8') : null } catch (e) { continue }
      if (txt == null) continue
      const ids = extractModelIds(txt)
      if (ids && ids.length) {
        if (!fromFile) fromFile = ids
        const obj = normalizeProductConfig(txt)
        if (!fromFileRich && obj && Array.isArray(obj.modelPromotions)) fromFileRich = ids
      }
      if (fromFileRich) break
    }
    if (!fromFile) return known
    return fromFileRich || fromFile
  }

  // 服务端回吐的账号清单缓存（进程内，旧 core verbatim）。
  const ACCOUNT_CATALOG_CACHE = new Map()
  function rememberAccountCatalog(backend, ids) {
    if (Array.isArray(ids) && ids.length) ACCOUNT_CATALOG_CACHE.set(backend, ids.slice())
  }
  function getAccountCatalog(backend) {
    const v = ACCOUNT_CATALOG_CACHE.get(backend)
    return v && v.length ? v.slice() : null
  }

  // CLI 报错里解析「该账号当前支持的模型」（旧 core parseAccountModels verbatim）。
  function parseAccountModels(text) {
    const s = String(text || '')
    const anchor = s.indexOf('Currently supported models for your account')
    if (anchor < 0) return null
    const tail = s.slice(anchor)
    const ids = []
    for (const line of tail.split(/\r?\n/)) {
      const m = /^\s*[-*]\s+(\S+)\s*$/.exec(line)
      if (!m) {
        if (ids.length) break
        continue
      }
      if (!ids.includes(m[1])) ids.push(m[1])
    }
    return ids.length ? ids : null
  }

  // 带倍率/授权的详细清单（无促销角标，旧 v1.6.1 的 0.1.0 子集；排序规则 verbatim：
  // 已授权在前 → 有倍率升序 → 无倍率殿后）。
  function modelCatalogDetailed(backend, io) {
    const o = io || {}
    const fromFile = backendModelCatalog(backend, o)
    const acct = (Array.isArray(o.accountModels) && o.accountModels.length) ? o.accountModels : getAccountCatalog(backend)
    const ids = []
    const authorized = new Set()
    if (acct) for (const id of acct) { if (!ids.includes(id)) ids.push(id); authorized.add(id) }
    for (const id of fromFile) if (!ids.includes(id)) ids.push(id)
    const read = o.readFileSync || fsRead
    let creditsMap = null
    for (const p of productDescriptorCandidates(backend)) {
      let txt = null
      try { txt = read ? read(p, 'utf8') : null } catch (e) { continue }
      if (txt == null) continue
      const map = extractModelCredits(txt)
      if (map) { creditsMap = map; break }
    }
    const items = ids.map((id) => {
      const base = lookupModelCredits(creditsMap, id)
      const credits = base
      const hasCredits = typeof credits === 'number'
      const suffix = formatCreditLabel(credits)
      const marks = []
      if (suffix) marks.push(suffix)
      if (acct && !authorized.has(id)) marks.push('未授权')
      return {
        id,
        credits,
        baseCredits: base,
        free: hasCredits && credits === 0,
        hasCredits,
        authorized: acct ? authorized.has(id) : null,
        promotion: null,
        label: marks.length ? `${id} · ${marks.join(' · ')}` : id
      }
    })
    const rank = (x) => (x.authorized === false ? 1 : 0)
    const withC = items.filter((x) => x.hasCredits).sort((a, b) => rank(a) - rank(b) || a.credits - b.credits)
    const withoutC = items.filter((x) => !x.hasCredits).sort((a, b) => rank(a) - rank(b))
    return [...withC, ...withoutC]
  }

  function formatModelCatalogText(backend, io) {
    return modelCatalogDetailed(backend, io).map((x) => x.label).join(', ')
  }

  // ── 设置清洗（旧 normalizeBridgeSettings verbatim；updatedAt 透传）───────────
  function normalizeSettings(raw) {
    const snap = { preferredBackend: DEFAULT_BACKEND, defaultModel: '', codebuddyEnToken: '', endpointOverride: '' }
    if (!raw || typeof raw !== 'object') return snap
    if (typeof raw.preferredBackend === 'string') {
      const nb = normalizeBackend(raw.preferredBackend)
      if (typeof nb === 'string' && BACKENDS.indexOf(nb) >= 0) snap.preferredBackend = nb
    }
    if (typeof raw.defaultModel === 'string') snap.defaultModel = raw.defaultModel.trim()
    if (typeof raw.codebuddyEnToken === 'string') snap.codebuddyEnToken = raw.codebuddyEnToken.trim()
    if (typeof raw.endpointOverride === 'string') snap.endpointOverride = raw.endpointOverride.trim()
    if (typeof raw.updatedAt === 'number' && raw.updatedAt > 0) snap.updatedAt = raw.updatedAt
    return snap
  }

  // 诊断（旧 diagnoseBackend verbatim；fs/env 走 deps）。
  function diagnoseBackend(backend, settings, io) {
    const o = io || {}
    const e = o.env || env
    const s = settings || normalizeSettings(null)
    const authDomain = readBackendAuthDomain(backend, Object.assign({ env: e }, o))
    const override = String(s.endpointOverride || '').trim()
    const byDomain = resolveEndpoint(null, authDomain)
    const endpoint = override || byDomain || BACKEND_ENDPOINTS[backend] || null
    const endpointSource = override ? 'override' : (byDomain ? 'auth-domain' : 'product')
    const tok = resolveEnToken(backend === 'codebuddy-en' ? s.codebuddyEnToken : null)
    return {
      backend: backend,
      authDomain: authDomain,
      endpoint: endpoint,
      endpointSource: endpointSource,
      tokenSource: backend === 'codebuddy-en' ? tok.source : 'not-needed',
      tokenHint: tok.source === 'setting' ? '来自设置面板'
        : tok.source === 'env' ? '来自环境变量 CODEBUDDY_AUTH_TOKEN'
          : tok.source === 'dsh-store' ? '来自 DSH 凭据库（自动复用 WORKBUDDY_TOKEN）'
            : backend === 'codebuddy-en' ? '缺失：国际版 token 不落盘，需在设置面板填写或先在 DSH 配 workbuddy provider'
              : '无需填写（国内版由 CLI 自行登录）',
      mismatch: endpointMismatchHint(backend, authDomain, !!tok.token) !== null,
      hint: endpointMismatchHint(backend, authDomain, !!tok.token) || null,
      defaultModel: String(s.defaultModel || '').trim() || '(CLI 默认)'
    }
  }

  // ── 结果判定（旧 isLimited/isTransientCliError/failureHint verbatim）─────────
  function isLimitedCodebuddy(res) {
    if (!res || res.ok) return false
    // 前置凭据缺失：配置问题，不是限流（弹窗重试不会让 token 出现）。
    if (res.status === 'AUTH_REQUIRED') return false
    if (res.status === 'SPAWN_ERROR' || res.status === 'CODEBUDDY_UNAVAILABLE' || res.status === 'HUNG_TIMEOUT') return true
    const hay = String(res.stderr || '') + ' ' + String(res.status || '')
    // 401/端点域不匹配：需要用户换登录域，不归限流类（旧 v1.3.0 verbatim）。
    if (/401 authentication failed|differs from the current product endpoint/i.test(hay)) return false
    return CODEBUDDY_LIMIT_RE.test(hay)
  }

  function isTransientCliError(res) {
    if (!res || res.ok) return false
    if (isLimitedCodebuddy(res)) return false
    return res.status === 'ERROR_DURING_EXECUTION'
  }

  function failureHint(res) {
    if (!res || res.ok) return ''
    // AUTH_REQUIRED：stderr 已带完整指引，透传（旧 v1.3.1 verbatim）。
    if (res.status === 'AUTH_REQUIRED') return '[诊断] ' + String(res.stderr || '')
    if (isTransientCliError(res)) {
      return res.retried
        ? '[诊断] codebuddy CLI 侧瞬时错误（error_during_execution，CLI 未给出原因），已自动重试 1 次仍失败。可换 model 再试一次；若仍失败请改用原生工具完成，或告知用户。'
        : '[诊断] codebuddy CLI 侧瞬时错误（error_during_execution，CLI 未给出原因）。直接重试同一请求通常即可通过；也可显式指定 model。不要据此认为任务本身有问题。'
    }
    if (res.status === 'PARSE_ERROR') {
      return '[诊断] 未能从 codebuddy 输出解析出 result 事件（进程可能被中断或输出被截断）。可重试；持续出现请检查 codebuddy CLI 版本。'
    }
    if (/401 authentication failed|differs from the current product endpoint/i.test(String(res.stderr || ''))) {
      return '[诊断] 认证失败（401）：请求被送到的端点与当前 CLI 登录域不匹配（国际/国内登录互斥）。请让用户在对应产品域完成 `codebuddy` CLI 登录后重试；这不是限流，重试与回退都无效。'
    }
    return ''
  }

  // stream-json 解析（旧 parseCodebuddyJson verbatim）。
  function parseCodebuddyJson(stdoutText) {
    const trimmed = String(stdoutText || '').trim()
    if (!trimmed) return null
    const lines = trimmed.split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i].trim()
      if (!ln.startsWith('{')) continue
      try {
        const obj = JSON.parse(ln)
        if (obj && obj.type === 'result') return obj
      } catch (e) {}
    }
    try { return JSON.parse(trimmed) } catch (e) {}
    return null
  }

  // result 事件 → 统一结果对象（旧 buildResult verbatim，含账号清单收割）。
  function buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
    const bk = backend || 'codebuddy'
    const exitCode = outcome ? outcome.exitCode : null
    const errText = parsed && typeof parsed.error === 'string' && parsed.error ? parsed.error : ''
    const stderr = (stderrText ? String(stderrText).slice(-2000) : '') + (errText ? (stderrText ? ' ' : '') + errText : '')
    // v1.6.0：顺手收割服务端回吐的「本账号可用模型」清单（失败静默）。
    try {
      const harvest = parseAccountModels(stderr) || parseAccountModels(String(stdoutText || ''))
      if (harvest && harvest.length) rememberAccountCatalog(bk, harvest)
    } catch (e) { /* 收割失败不影响主流程 */ }
    if (parsed && parsed.type === 'result') {
      const isOk = exitCode === 0 && parsed.is_error === false && parsed.subtype === 'success'
      let modelUsed = null
      try {
        if (parsed.modelUsage && typeof parsed.modelUsage === 'object') {
          const names = Object.keys(parsed.modelUsage)
          if (names.length) modelUsed = names.join('+')
        }
      } catch (e) { }
      return {
        ok: isOk,
        status: String(parsed.subtype || (isOk ? 'SUCCESS' : 'ERROR')).toUpperCase(),
        response: typeof parsed.result === 'string' ? parsed.result : '',
        sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
        durationSeconds: typeof parsed.duration_ms === 'number' ? parsed.duration_ms / 1000 : null,
        numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
        totalTokens: (parsed.usage && typeof parsed.usage.input_tokens === 'number' && typeof parsed.usage.output_tokens === 'number')
          ? (parsed.usage.input_tokens + parsed.usage.output_tokens) : null,
        exitCode: exitCode,
        mode: mode,
        backend: bk,
        modelUsed: modelUsed,
        stderr: stderr
      }
    }
    return {
      ok: false,
      status: 'PARSE_ERROR',
      response: '',
      sessionId: null,
      durationSeconds: null,
      numTurns: null,
      totalTokens: null,
      exitCode: exitCode,
      mode: mode,
      backend: bk,
      stderr: stderr,
      rawStdout: String(stdoutText || '').slice(-2000)
    }
  }

  // 统一 argv 构造（旧 buildArgv verbatim；env 端点/凭据注入在本 provider 内完成，
  // 因为 kit 只透传 opts，宿主三形态都从本函数的返回值取 built.env 下发 spawn）。
  function buildArgvCodebuddy(prefix, args, opts) {
    const o = opts || {}
    const argv = [prefix[0], ...prefix.slice(1), '-p', String(args.prompt), '--output-format', 'stream-json']
    let mode = args.mode || o.defaultMode || 'auto'
    if (mode === 'auto') mode = o.planActive ? 'plan' : 'bypassPermissions'
    if (mode === 'plan') {
      argv.push('--permission-mode', 'plan')
      argv.push('--allowedTools', 'Bash')
    } else {
      mode = 'bypassPermissions'
      argv.push('--permission-mode', 'bypassPermissions')
    }
    // 模型优先级：显式 args.model > 用户偏好 defaultModel > CLI 默认。
    const model = args.model || o.defaultModel
    if (model) argv.push('--model', String(model))
    if (args.effort) argv.push('--effort', String(args.effort))
    if (args.maxTurns !== undefined && args.maxTurns !== null) argv.push('--max-turns', String(clampInt(args.maxTurns, 50, 1, 500)))
    if (Array.isArray(args.addDirs)) for (const d of args.addDirs) { if (d) argv.push('--add-dir', String(d)) }
    if (args.sessionId) argv.push('--resume', String(args.sessionId))
    else if (args.continueLatest) argv.push('--continue')
    const timeoutSec = clampInt(args.timeoutSec, 300, 10, 3600)
    // 端点/凭据注入（旧 preset/dynamic/MCP 三形态一致语义，宿主不必自算）：
    // authDomain 只在有 fs 能力的宿主读得到；dynamic 沙箱 → 沿用 CLI 自身端点。
    const bk = o.backend || DEFAULT_BACKEND
    const settings = o.settings || null
    const authDomain = readBackendAuthDomain(bk, {})
    const tok = resolveEnToken(bk === 'codebuddy-en' && settings ? settings.codebuddyEnToken : null)
    const inject = endpointEnv(bk, settings ? settings.endpointOverride : null, authDomain, tok.token)
    return { argv: argv, timeoutSec: timeoutSec, mode: mode, env: o.env || inject }
  }

  // 流事件折叠（旧 foldEvent 主体 verbatim；project 状态由 kit engine 持有）。
  function foldStreamEvent(ev, p, summarizeArgs, MAX_ARG_LEN, MAX_TRAIL) {
    if (!ev || !ev.type) return
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_use') {
          p._stepCounter = (p._stepCounter || 0) + 1
          const stepIndex = p._stepCounter
          if (!p._toolMap) p._toolMap = {}
          p._toolMap[block.id] = { stepIndex: stepIndex, name: block.name }
          const args = summarizeArgs(block.input)
          p.trail.push({ stepIndex: stepIndex, state: 'ACTIVE', tool: block.name, args: args, at: new Date().toISOString() })
          if (p.trail.length > MAX_TRAIL) p.trail.shift()
          p.current = { tool: block.name, args: args, stepIndex: stepIndex, since: new Date().toISOString() }
        } else if (block.type === 'thinking') {
          p.current = { tool: 'thinking', args: { text: String(block.thinking || '').slice(0, MAX_ARG_LEN) }, stepIndex: 0, since: new Date().toISOString() }
        } else if (block.type === 'text') {
          p.current = { tool: 'typing', args: { text: String(block.text || '').slice(0, MAX_ARG_LEN) }, stepIndex: 0, since: new Date().toISOString() }
        }
      }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_result' && p._toolMap && p._toolMap[block.tool_use_id]) {
          const rec = p._toolMap[block.tool_use_id]
          p.trail.push({ stepIndex: rec.stepIndex, state: block.is_error ? 'ERROR' : 'DONE', tool: rec.name, args: null, at: new Date().toISOString() })
          if (p.trail.length > MAX_TRAIL) p.trail.shift()
          if (p.current && p.current.stepIndex === rec.stepIndex) p.current = null
        }
      }
    }
  }

  const descriptor = {
    id: 'codebuddy',
    label: 'CB',
    presetId: 'codebuddy-first',
    defaultBackend: DEFAULT_BACKEND,
    defaultMode: 'auto',
    exeName: 'codebuddy',
    binEnvVars: ['CODEBUDDY_BIN', 'CODEBUDDY_EN_BIN', 'WORKBUDDY_BIN'],
    unavailableStatus: 'CODEBUDDY_UNAVAILABLE',
    // 旧 renderResult verbatim 语义：标头用具体 backend（'workbuddy OK'），仅当结果
    // 无 backend 字段时回落 'codebuddy'（= provider.id）。agy/mimo 旧包标头硬编码
    // provider 名，不设此旗。
    backendLabel: true,

    backends: () => BACKENDS.slice(),
    normalizeBackend,
    resolveBackend,

    buildArgv: buildArgvCodebuddy,
    parseJson: parseCodebuddyJson,
    buildResult,
    foldStreamEvent,
    isLimited: isLimitedCodebuddy,
    isTransientCliError,
    failureHint,

    // codebuddy-en 无凭据的确定性前置（v1.3.1 语义，经 kit preflight 钩子实现）：
    // 三通道皆空 → 直接 AUTH_REQUIRED（可操作指引进 stderr），不白跑一次 spawn。
    // 其它后端一律放行。dynamic 沙箱无 fs → dsh-store 通道缺席，abort 提示即可。
    preflight({ args, backend, engine, o }) {
      if (backend !== 'codebuddy-en') return null
      const settings = (o && o.getSettings && o.getSettings()) || null
      const tok = resolveEnToken(settings ? settings.codebuddyEnToken : null)
      if (tok.token) return null
      const authDomain = readBackendAuthDomain('codebuddy-en', {})
      const hint = endpointMismatchHint('codebuddy-en', authDomain, false)
      return {
        abort: {
          ok: false,
          status: 'AUTH_REQUIRED',
          response: '',
          sessionId: null,
          durationSeconds: null,
          numTurns: null,
          totalTokens: null,
          exitCode: null,
          mode: (args && args.mode) || descriptor.defaultMode || 'auto',
          backend: 'codebuddy-en',
          stderr: hint
        }
      }
    },

    tools: {
      run: {
        name: 'codebuddy_run',
        description: 'Dispatch a coding/build/debug/investigation task to the local codebuddy agent CLI and return its final answer. Prefer this for implementation, edits, refactors, multi-file investigation and debugging in every mode. DSH fully controls codebuddy: it always runs non-interactively with permissions auto-approved (codebuddy never prompts). Use read-only native tools only for quick lookups and for final build/test verification. In mode=auto the DSH plan state decides plan vs bypassPermissions. Set background=true for long tasks and collect the result via job_output.',
        inputSchema: RUN_PARAMS
      },
      continue: {
        name: 'codebuddy_continue',
        description: 'Continue an existing codebuddy conversation with a follow-up prompt, reusing codebuddy context. Pass sessionId from a prior codebuddy_run result, or set latest=true to continue the most recent codebuddy conversation. Same DSH-controlled, no-prompt execution as codebuddy_run.',
        inputSchema: CONTINUE_PARAMS
      },
      status: {
        name: 'codebuddy_status',
        description: 'Read a live snapshot of what the local codebuddy agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or agent_response thinking/typing), the recent step trail (tools executed, done/error), the last completed run status + session id, and per-project cumulative usage (runs + total tokens, since codebuddy exposes no quota API). Optional cwd filters to a single project. Call this to check on an in-flight codebuddy_run/codebuddy_continue without waiting for it to finish.',
        inputSchema: STATUS_PARAMS
      }
    },

    extraTools: [],

    // 设置分区（契约 §3）：keystone 统一文件 {codebuddy:{...}}；旧扁平文件的字段
    // 级迁移由 keystone LEGACY_SOURCES 承担（字段名逐字相同）。
    settings: {
      keys: SETTINGS_KEYS,
      secretKeys: ['codebuddyEnToken'],
      defaults: () => normalizeSettings(null),
      normalize: (raw) => normalizeSettings(raw),
      meta() {
        // defaultModel 下拉 = 默认后端（codebuddy 面）的带倍率目录（升级 CLI 后
        // 自动同步）；其余三面目录不同，字段允许自定义输入即可覆盖。促销角标为
        // 0.1.0 有意省略（见头注 TODO）。
        const options = modelCatalogDetailed(DEFAULT_BACKEND, {}).map((x) => ({ value: x.id, label: x.label }))
        return {
          titleSuffix: 'CodeBuddy',
          fields: [
            {
              key: 'preferredBackend', label: '默认后端', type: 'select',
              options: BACKENDS.map((b) => ({ value: b, label: BACKEND_LABELS[b] })),
              note: '新会话未显式指定 backend 时用这里选的后端；单次调用可覆盖。codebuddy-en 需要 codebuddyEnToken 或 DSH 已配 workbuddy key。'
            },
            {
              key: 'defaultModel', label: '默认模型', type: 'select', allowCustom: true, placeholder: '(CLI 默认)',
              options,
              note: '账号实际可用性以服务端实时裁决（400 报文回吐权威清单，桥接自动缓存）。优先选能完成任务里最便宜的，日常任务优先免费（x0.00）。'
            },
            { key: 'codebuddyEnToken', label: 'WorkBuddy 国际版 Token', type: 'secret', note: '仅 backend="codebuddy-en" 需要。国际版登录 token 被 protector key 封装不落盘，只能手工提供；留空则自动尝试 DSH 凭据库的 WORKBUDDY_TOKEN。' },
            { key: 'endpointOverride', label: '端点覆盖', type: 'text', placeholder: 'https://…/v2', note: '一般留空：端点按登录域自动对齐（www.codebuddy.cn 等）。仅在需要强制指定 API 端点时填写，且必须自带 /v2。' }
          ]
        }
      },
      diagnose(snap) {
        const s = normalizeSettings(snap)
        const lines = []
        const seen = new Set()
        // 默认后端一行；codebuddy-en 是 4 面里唯一需要凭据的，恒附一行状态。
        for (const b of [s.preferredBackend, 'codebuddy-en']) {
          if (seen.has(b)) continue
          seen.add(b)
          const d = diagnoseBackend(b, s, {})
          lines.push(b + ': ' + (d.endpoint || '?') + '（登录域 ' + (d.authDomain || '未读到') + '，' + d.tokenHint + '）')
          if (d.hint) lines.push('  ⚠ ' + d.hint)
        }
        return lines.join('\n')
      }
    },

    mcp: { version: '0.2.1' }
  }

  // 三形态共用的工具逻辑（签名保持 keystone/队友接线契约不变）。
  descriptor.runToolLogic = async function (args, exec) {
    return this.runner.coreExecute(args, exec)
  }
  // 旧 preset continueTool.execute verbatim 映射（sessionId 优先，否则 latest）。
  descriptor.continueToolLogic = async function (args, exec) {
    const a = args || {}
    const mapped = { prompt: a.prompt, backend: a.backend, mode: a.mode, model: a.model, effort: a.effort, maxTurns: a.maxTurns, cwd: a.cwd, timeoutSec: a.timeoutSec, background: a.background }
    if (a.sessionId) mapped.sessionId = a.sessionId
    else if (a.latest) mapped.continueLatest = true
    return this.runner.coreExecute(mapped, exec)
  }
  // 旧 statusTool.execute verbatim：cwd 过滤 + 单项目聚合覆写（含 runs/totalTokens）。
  descriptor.statusToolLogic = function (args) {
    const a = args || {}
    const snap = this.engine.statusSnapshot()
    if (a.cwd) {
      const key = String(a.cwd)
      snap.projects = snap.projects.filter((p) => p.cwd === key)
      const g = snap.projects[0]
      if (g) { snap.state = g.state; snap.running = g.running; snap.current = g.current; snap.trail = g.trail; snap.lastStatus = g.lastStatus; snap.lastAt = g.lastAt; snap.lastSessionId = g.lastSessionId; snap.lastBackend = g.lastBackend; snap.fallbackActive = g.fallbackActive; snap.runs = g.runs; snap.totalTokens = g.totalTokens; snap.updatedAt = g.updatedAt }
    }
    return snap
  }

  // 供 preset/dynamic/MCP/测试形态复用的领域函数（不 import home-plugin，全部经
  // 描述符暴露；MCP 面据 buildArgv/parseJson/buildResult/isLimited/failureHint 组
  // 装真实 spawn 执行，语义与旧 mcp/codebuddy-mcp-server.mjs 一致）。
  descriptor.policyText = POLICY_TEXT
  descriptor.limits = { LIMIT_RE: CODEBUDDY_LIMIT_RE }
  descriptor.backendLabels = BACKEND_LABELS
  descriptor.backendEndpoints = BACKEND_ENDPOINTS
  descriptor.authDomainEndpoints = AUTH_DOMAIN_ENDPOINTS
  descriptor.backendAuthIds = BACKEND_AUTH_IDS
  descriptor.staticModelIds = BACKEND_MODEL_IDS
  descriptor.endpointHost = endpointHost
  descriptor.resolveEndpoint = resolveEndpoint
  descriptor.endpointEnv = endpointEnv
  descriptor.endpointMismatchHint = endpointMismatchHint
  descriptor.resolveEnToken = resolveEnToken
  descriptor.readDshWorkbuddyToken = readDshWorkbuddyToken
  descriptor.readBackendAuthDomain = readBackendAuthDomain
  descriptor.diagnoseBackend = diagnoseBackend
  descriptor.backendModelCatalog = backendModelCatalog
  descriptor.modelCatalogDetailed = modelCatalogDetailed
  descriptor.formatModelCatalogText = formatModelCatalogText
  descriptor.parseAccountModels = parseAccountModels
  descriptor.rememberAccountCatalog = rememberAccountCatalog
  descriptor.getAccountCatalog = getAccountCatalog
  descriptor.normalizeProductConfig = normalizeProductConfig
  descriptor.extractModelIds = extractModelIds
  descriptor.extractModelCredits = extractModelCredits
  descriptor.parseCreditValue = parseCreditValue
  descriptor.formatCreditLabel = formatCreditLabel
  descriptor.lookupModelCredits = lookupModelCredits
  descriptor.normalizeSettings = normalizeSettings

  descriptor.attach = function (hostOpts) {
    host = hostOpts || {}
    this.engine = createStatusEngine({ provider: this, publish: host.publish })
    const runner = createRunner(Object.assign({}, host, { provider: this, engine: this.engine }))
    this.runner = runner
    return runner
  }
  descriptor.hostOptions = () => host
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
    // 调度门禁（0.2.0）：设置面板关掉 codebuddy → 本形态不注册工具/政策段；fail-open。
    if (!isBridgeEnabled('codebuddy', SCHED_ALL_IDS)) return
    const subprocess = ctx.subprocess
    const planMode = ctx.get('planMode')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    // 沙箱可能运行在无 process 的环境：typeof 守卫读 env（旧仓 dynamic 的等价面）。
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}

    const provider = defineProvider({ env })

    function publish(snapshot) {
      try {
        const collector = ctx.get('cliBridgeCollector')
        if (collector && typeof collector.mergeSnapshot === 'function') { collector.mergeSnapshot('codebuddy', snapshot); return }
      } catch (e) { /* fall through to legacy alias */ }
      try {
        const legacy = ctx.get('codebuddyCollector')
        if (legacy && typeof legacy.mergeSnapshot === 'function') legacy.mergeSnapshot(snapshot)
      } catch (e) { /* 灯数据尽力而为 */ }
    }

    // 设置快照（apply 时一次，旧 dynamic 语义）：统一文件 codebuddy 分区 >
    // 旧扁平文件（字段级迁移的只读兜底）> 默认。全程容错，失败不炸 apply。
    const settingsSnapshot = (function () {
      const def = provider.normalizeSettings(null)
      try {
        const proc = (typeof process !== 'undefined') ? process : null
        const nodeFs = proc && typeof proc.getBuiltinModule === 'function' ? proc.getBuiltinModule('node:fs') : null
        const nodePath = proc && typeof proc.getBuiltinModule === 'function' ? proc.getBuiltinModule('node:path') : null
        if (!nodeFs || typeof nodeFs.readFileSync !== 'function') return def
        const join = nodePath ? nodePath.join.bind(nodePath) : ((...p) => p.join('/'))
        const readJson = (p) => { try { return JSON.parse(nodeFs.readFileSync(p, 'utf8')) } catch (e) { return null } }
        const unifiedFile = env.CLI_BRIDGE_SETTINGS_FILE || (env.DSH_HOME ? join(env.DSH_HOME, 'cli-bridge-settings.json') : null)
        const unified = unifiedFile ? readJson(unifiedFile) : null
        if (unified && unified.codebuddy && typeof unified.codebuddy === 'object') return provider.normalizeSettings(unified.codebuddy)
        const legacyFile = env.CODEBUDDY_SETTINGS_FILE || (env.DSH_HOME ? join(env.DSH_HOME, 'codebuddy-bridge-settings.json') : null)
        const legacy = legacyFile ? readJson(legacyFile) : null
        if (legacy && typeof legacy === 'object') return provider.normalizeSettings(legacy)
      } catch (e) { /* 无 fs：默认值，端点走 CLI 自身 */ }
      return def
    })()

    // exe：旧动态三面候选 verbatim（nodeExe 仅在有 process 时有真值，否则退回
    // 字符串 'node' —— 旧 dynamic 同款守卫）。
    async function resolveExe(backend, signal) {
      const nodeExe = (typeof process !== 'undefined' && process.execPath) || 'node'
      if (backend === 'workbuddy') {
        return [nodeExe, env.WORKBUDDY_BIN || 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy']
      }
      if (backend === 'codebuddy-en') {
        return [nodeExe, env.CODEBUDDY_EN_BIN || 'C:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy']
      }
      try {
        const exe = await subprocess.resolveExecutable('codebuddy', undefined, signal)
        if (!/\.(cmd|bat)$/i.test(exe)) return exe
      } catch (e) {}
      const binPath = env.CODEBUDDY_BIN || ((env.APPDATA || 'C:\\Users\\lcl\\AppData\\Roaming') + '\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy')
      return [nodeExe, binPath]
    }

    // 旧仓 CWD_FALLBACK 硬编码机器绝对路径：本形态保持旧 dynamic verbatim 行为
    // （Lead 定案：与旧 dynamic 逐字一致；CODEBUDDY_MCP_CWD 优先仅为 MCP 面语义，
    // 旧 dynamic 不读它）。
    function getCwdFallback() {
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
      if (typeof process !== 'undefined' && typeof process.cwd === 'function') { try { return process.cwd() } catch (e) {} }
      return 'C:\\Users\\lcl\\Desktop\\codebuddy-bridge'
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

    provider.attach({
      ctx,
      subprocess,
      resolveExe,
      getCwdFallback,
      getPreferredBackend: function () { return settingsSnapshot.preferredBackend || provider.defaultBackend },
      getSettings: function () { return settingsSnapshot },
      planActiveFor,
      publish
    })

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
    for (const et of provider.extraTools) {
      harness.registerTool(ctx, harness.defineTool({
        name: et.name,
        description: et.description,
        parameters: et.inputSchema,
        output: { schema: OUTPUT_SCHEMA, render: function (args, value) { return et.render ? et.render(value) : renderResult(value, provider) } },
        execute: function (args, exec) { return et.logic(args, exec) }
      }))
    }

    // 浏览器指示灯轮询的 RPC 面（旧 dynamic/handle('codebuddy_status') 语义）。
    harness.handle('codebuddy_status', function () { return provider.statusToolLogic({}) })

    // 旧 policy 文案 verbatim（提示词连续性红线；name/order 沿用旧 preset 的 5，
    // 动态与 preset 两形态注入同一段全文，provider.policyText 单源）。
    ctx.systemPrompt.section({
      name: 'codebuddy:policy',
      order: 5,
      text: provider.policyText
    })
  }
}
