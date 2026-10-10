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
import { createStatusEngine, createRunner, clampInt, shortLabel, summarizeArgs } from '../core/bridge-kit.mjs'

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

export default function defineProvider(deps = {}) {
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

    mcp: { version: '0.2.1' }
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
