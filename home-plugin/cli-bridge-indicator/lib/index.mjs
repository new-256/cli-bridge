// home-plugin/cli-bridge-indicator/lib/index.mjs — CLI Bridge 家级状态灯 host 半（唯一一盏灯）。
//
// 合并 agy-indicator / codebuddy-indicator / mimo-indicator 三个家级插件为单个 host 插件：
//   • 每 provider 一个数据桶（按项目 cwd 聚合），来自三个入口：
//       1) preset 形态：ctx.emit('<id>/status', { snapshot }) + ctx.emit('<id>/mode') 心跳租约
//       2) dynamic 形态：ctx.get('cliBridgeCollector').mergeSnapshot('<id>', snapshot)
//          （同时保留旧服务名 agyCollector/codebuddyCollector/mimoCollector 别名，
//           让「新灯 + 旧包 dynamic 形态」并存期不丢数据）
//       3) MCP 子进程：读 {dsh-home}/cli-bridge-mcp-<id>.json（新）+
//          旧包路径 plugins/agy-indicator/mcp-live.json / codebuddy-indicator-mcp.json /
//          plugins/mimo-indicator/mcp-live.json（兼容）
//   • 单一状态路由 GET /cli-bridge/status 返回
//     { updatedAt, providers: { agy:{...}, codebuddy:{...}, mimo:{...} } }；
//     同时保留三个旧路由（各返回自己的桶），浏览器旧 client / 其它工具不断流。
//   • 设置路由 GET/POST /cli-bridge/settings（统一文件 cli-bridge-settings.json，按
//     provider 分区；token 只回传掩码）。
//   • v1.2.0 同款声明制 preset：向 agentPresets 注册表登记 cordis-agy /
//     codebuddy-first / cordis-mimo（定义由 scripts/gen-preset-decl.mjs 从
//     preset/<id>/agent.cordis.yml 生成到 lib/preset-definitions/<id>.mjs）。
//     旧 DSH（≤0.1.6-alpha.2）上 agentPresets 服务永不出现 → 注入器挂起零副作用。
//
// 家级插件运行在 host 组合的 root realm；会话内插件的 ctx.emit 事件是 app 级广播，
// 不受 isolate realm（只隔离服务）影响。

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROVIDER_IDS, createProvider } from '../../../providers/registry.mjs'
import { MCP_BRIDGE_STALE_MS, normalizeMcpBridge, projectName } from '../../../core/bridge-kit.mjs'
import { settingsView, parseSettingsBody, readSettingsFile, writeSettingsFile, SETTINGS_FILE_NAME } from './settings.mjs'
import { declareBridgePresets } from './preset-declarations.mjs'

export const PRESET_TTL_MS = 75000
export const PROJECT_TTL_MS = 10 * 60 * 1000
export const MAX_PROJECTS = 24
export const MAX_SESSIONS = 64

export function detectDshHome(env) {
  const e = env || (typeof process !== 'undefined' && process.env ? process.env : {})
  if (e.DSH_HOME) return e.DSH_HOME
  if (e.APPDATA) return join(e.APPDATA, 'DSH Desktop', 'dsh-home')
  if (e.HOME) return join(e.HOME, '.dsh')
  return join('.', '.dsh')
}

// ── 可脱离 Cordis 单测的纯状态机 ──────────────────────────────────────────────
// opts: { now?, ttlMs?, projectTtlMs?, staleMs?, listPresetSessions?(id), isSuccessStatus?(id,st),
//         readMcpFile?(id) -> payload|null, ids? }
export function createIndicatorState(opts) {
  const o = opts || {}
  const now = typeof o.now === 'function' ? o.now : Date.now
  const ttlMs = o.ttlMs != null ? o.ttlMs : PRESET_TTL_MS
  const projectTtlMs = o.projectTtlMs != null ? o.projectTtlMs : PROJECT_TTL_MS
  const staleMs = o.staleMs != null ? o.staleMs : MCP_BRIDGE_STALE_MS
  const ids = Array.isArray(o.ids) && o.ids.length ? o.ids.slice() : PROVIDER_IDS.slice()
  const listPresetSessions = typeof o.listPresetSessions === 'function' ? o.listPresetSessions : null
  const isSuccess = typeof o.isSuccessStatus === 'function' ? o.isSuccessStatus : null
  const readMcpFile = typeof o.readMcpFile === 'function' ? o.readMcpFile : null

  // 每 provider 独立桶：projects / sessionLeases / 租约 / 单调序号
  const buckets = Object.create(null)
  let seqCounter = 0
  for (const id of ids) {
    buckets[id] = { projects: Object.create(null), sessionLeases: Object.create(null), presetActiveUntil: 0, lastModeAt: 0 }
  }

  function okStatus(id, st) {
    if (isSuccess) { try { return !!isSuccess(id, st) } catch (e) {} }
    return String(st) === 'SUCCESS'
  }

  function ensure(b, cwd) {
    const key = String(cwd || '')
    let p = b.projects[key]
    if (!p) {
      const keys = Object.keys(b.projects)
      if (keys.length >= MAX_PROJECTS) {
        const idle = keys.filter((k) => !b.projects[k].running)
        if (idle.length) {
          const victim = idle.sort((a, x) => (b.projects[a].updatedAt || 0) - (b.projects[x].updatedAt || 0))[0]
          delete b.projects[victim]
        }
      }
      p = { cwd: key, name: projectName(key), state: 'idle', running: 0, current: null, trail: [], lastStatus: null, lastAt: 0, lastSessionId: null, lastBackend: null, fallbackActive: false, runs: 0, totalTokens: 0, updatedAt: 0, seq: ++seqCounter }
      b.projects[key] = p
    }
    return p
  }

  function mergeSnapshot(id, snap) {
    const b = buckets[id]
    if (!b || !snap) return
    const list = Array.isArray(snap.projects) ? snap.projects : (snap.cwd ? [snap] : [])
    for (const src of list) {
      if (!src || !src.cwd) continue
      const p = ensure(b, src.cwd)
      const srcAt = Number(src.updatedAt) || 0
      if (src.name) p.name = src.name
      if (typeof src.running === 'number') p.running = src.running
      if (src.current !== undefined) p.current = src.current
      if (Array.isArray(src.trail)) p.trail = src.trail.slice(-12)
      if (src.lastStatus) p.lastStatus = src.lastStatus
      if (src.lastAt) p.lastAt = Number(src.lastAt) || p.lastAt
      if (src.lastSessionId) p.lastSessionId = src.lastSessionId
      if (src.lastBackend) p.lastBackend = src.lastBackend
      if (src.fallbackActive !== undefined) p.fallbackActive = !!src.fallbackActive
      if (typeof src.runs === 'number') p.runs = src.runs
      if (typeof src.totalTokens === 'number') p.totalTokens = src.totalTokens
      // state 是派生字段：外部快照只接受它作「运行中」提示，其余本地重算，
      // 避免陈旧/不一致的 state 把灯画错颜色（mimo ACCEPTED 被当 failed 的坑）。
      if (src.state === 'running') p.state = 'running'
      else if (!p.running) p.state = okStatus(id, p.lastStatus) ? 'ok' : (p.fallbackActive ? 'fallback' : (p.lastStatus ? 'failed' : 'idle'))
      p.seq = ++seqCounter
      p.updatedAt = srcAt || now()
    }
  }

  // <id>/mode 事件：active:true 续租（可选带 sessionId 记会话租约）；否则熄灭。
  function onMode(id, payload) {
    const b = buckets[id]
    if (!b) return
    try {
      const sid = payload && typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : null
      if (payload && payload.active) {
        b.presetActiveUntil = now() + ttlMs
        b.lastModeAt = now()
        if (sid) {
          b.sessionLeases[sid] = now() + ttlMs
          const leaseIds = Object.keys(b.sessionLeases)
          if (leaseIds.length > MAX_SESSIONS) {
            leaseIds.sort((a, x) => b.sessionLeases[a] - b.sessionLeases[x])
            for (let i = 0; i < leaseIds.length - MAX_SESSIONS; i++) delete b.sessionLeases[leaseIds[i]]
          }
        }
      } else if (sid) {
        delete b.sessionLeases[sid]
        if (Object.keys(b.sessionLeases).length === 0) b.presetActiveUntil = 0
      } else { b.presetActiveUntil = 0 }
    } catch (e) { }
  }

  function topOf(list) {
    // 顶层聚合只认「最近一次活动」那一个项目，不用 OR 抬历史 fallback（否则
    // 一个早已回退的陈旧项目永久把灯涂成琥珀）。排序确定：seq > updatedAt > cwd。
    let top = null
    for (const p of list) {
      if (!top) { top = p; continue }
      if ((p.seq || 0) !== (top.seq || 0)) { if ((p.seq || 0) > (top.seq || 0)) top = p; continue }
      if ((p.updatedAt || 0) !== (top.updatedAt || 0)) { if ((p.updatedAt || 0) > (top.updatedAt || 0)) top = p; continue }
      if (String(p.cwd) > String(top.cwd)) top = p
    }
    return top
  }

  function bucketSnapshot(id) {
    const b = buckets[id]
    if (!b) return { state: 'idle', running: 0, projects: [], presetActive: false, presetSessions: [], lastModeAt: 0 }
    // MCP 子进程快照（响应时读盘；客户端本就轮询，天然限频）
    if (readMcpFile) {
      try {
        const raw = readMcpFile(id)
        const norm = normalizeMcpBridge(raw, now(), staleMs)
        if (norm && Array.isArray(norm.projects)) mergeSnapshot(id, { projects: norm.projects })
      } catch (e) { }
    }
    const t = now()
    // 会话名单 = 实时枚举（权威）∪ preset 上报租约（兜底）
    const seen = Object.create(null)
    const presetSessions = []
    if (listPresetSessions) {
      try {
        const live = listPresetSessions(id)
        if (Array.isArray(live)) for (const sid of live) { if (typeof sid === 'string' && sid && !seen[sid]) { seen[sid] = 1; presetSessions.push(sid) } }
      } catch (e) { }
    }
    for (const sid of Object.keys(b.sessionLeases)) {
      if (t < b.sessionLeases[sid]) { if (!seen[sid]) { seen[sid] = 1; presetSessions.push(sid) } }
      else delete b.sessionLeases[sid]
    }
    const presetActive = t < b.presetActiveUntil || presetSessions.length > 0
    const list = Object.keys(b.projects).map((k) => b.projects[k]).sort((a, x) => (x.updatedAt || 0) - (a.updatedAt || 0))
    let running = 0
    for (const p of list) running += p.running || 0
    const top = topOf(list)
    const isStale = (p) => {
      if (p.running > 0) return false
      const at = Number(p.updatedAt) || Number(p.lastAt) || 0
      return !!at && (t - at) > projectTtlMs
    }
    const lastStatus = top ? top.lastStatus : null
    const fallbackActive = top ? !!top.fallbackActive : false
    const state = running > 0 ? 'running' : (lastStatus ? (okStatus(id, lastStatus) ? 'ok' : (fallbackActive ? 'fallback' : 'failed')) : (fallbackActive ? 'fallback' : 'idle'))
    return {
      state, running, lastStatus,
      lastAt: top ? (top.lastAt || 0) : 0,
      lastSessionId: top ? top.lastSessionId : null,
      lastBackend: top ? top.lastBackend : null,
      fallbackActive, presetActive, presetSessions, lastModeAt: b.lastModeAt,
      projects: list.map((p) => ({
        cwd: p.cwd, name: p.name || projectName(p.cwd), provider: id, state: p.state, running: p.running,
        current: p.current, trail: p.trail, lastStatus: p.lastStatus, lastAt: p.lastAt,
        lastSessionId: p.lastSessionId, lastBackend: p.lastBackend, fallbackActive: p.fallbackActive,
        runs: p.runs, totalTokens: p.totalTokens, updatedAt: p.updatedAt, stale: isStale(p)
      }))
    }
  }

  function snapshot() {
    const providers = Object.create(null)
    for (const id of ids) providers[id] = bucketSnapshot(id)
    return { updatedAt: now(), providers }
  }

  return { ids, mergeSnapshot, onMode, bucketSnapshot, snapshot, buckets }
}

// ── Cordis 插件面 ─────────────────────────────────────────────────────────────
export const name = 'cli-bridge-indicator'
export const inject = []

function jsonRes(res, code, obj) {
  try { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)) } catch (e) { }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); try { req.destroy() } catch (e) {} ; return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ── MCP 快照读盘工厂（可脱离 Cordis/真实 fs 单测；apply() 只注入 home）──────────
// opts: { home, joinFn?, fs? } → readMcpFile(id) → payload|null
// 新文件名 cli-bridge-mcp-<id>.json 优先；旧包名兼容（并存期旧 MCP/dynamic 形态仍写老路径）：
//   agy      <home>/plugins/agy-indicator/mcp-live.json（旧包 1.5.13 引入、1.6.2 修
//            DSH_HOME 锚定；AGY_MCP_LIVE_FILE 只是旧 server 写侧覆盖，读侧无需跟随）
//   codebuddy <home>/codebuddy-indicator-mcp.json
//   mimo     <home>/plugins/mimo-indicator/mcp-live.json
export const LEGACY_MCP_FILES = {
  agy: ['plugins', 'agy-indicator', 'mcp-live.json'],
  codebuddy: ['codebuddy-indicator-mcp.json'],
  mimo: ['plugins', 'mimo-indicator', 'mcp-live.json']
}
export function createMcpFileReader(opts) {
  const o = opts || {}
  const home = o.home
  const joinFn = typeof o.joinFn === 'function' ? o.joinFn : join
  const fsImpl = o.fs || { existsSync, readFileSync }
  if (!home) return () => null
  return function readMcpFile(id) {
    const legacy = LEGACY_MCP_FILES[id]
    const candidates = [joinFn(home, 'cli-bridge-mcp-' + id + '.json')]
      .concat(legacy ? [joinFn(home, ...legacy)] : [])
    for (const p of candidates) {
      try {
        if (!fsImpl.existsSync(p)) continue
        const data = JSON.parse(fsImpl.readFileSync(p, 'utf8'))
        // 兼容 mimo/agy 旧格式 {writtenAt, projects}
        if (data && Number(data.writtenAt) && !data.updatedAt) { data.updatedAt = data.writtenAt }
        return data
      } catch (e) { }
    }
    return null
  }
}

export function apply(ctx) {
  const home = detectDshHome()
  // 构造三个描述符只为拿元信息（isSuccessStatus/backends 等纯逻辑）；失败不致命。
  let descriptors = Object.create(null)
  for (const id of PROVIDER_IDS) { try { descriptors[id] = createProvider(id, { env: process.env }) } catch (e) { descriptors[id] = null } }

  function listPresetSessions(id) {
    try {
      const d = descriptors[id]
      if (!d || !d.presetId) return []
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
      if (!agents || typeof agents.list !== 'function') return []
      if (!presets || typeof presets.composedPreset !== 'function') return []
      const out = []
      for (const agent of agents.list()) {
        try {
          if (!agent || !agent.ctx) continue
          if (presets.composedPreset(agent.ctx) !== d.presetId) continue
          const sid = agent.id || (agent.session && agent.session.id)
          if (typeof sid === 'string' && sid) out.push(sid)
        } catch (e) { }
      }
      return out
    } catch (e) { return [] }
  }

  // MCP 快照读盘：新文件名优先，旧包文件名兼容（并存期旧包 dynamic/MCP 形态仍在写老路径）。
  // 表与读盘逻辑见 createMcpFileReader（可注入 fs/join，keystone 测试直接锁三旧路径）。
  const readMcpFile = createMcpFileReader({ home })

  function isSuccessStatus(id, st) {
    const d = descriptors[id]
    if (d && typeof d.isSuccessStatus === 'function') { try { return d.isSuccessStatus(st) } catch (e) { } }
    return String(st) === 'SUCCESS' || String(st) === 'ACCEPTED'
  }

  const st = createIndicatorState({ listPresetSessions, readMcpFile, isSuccessStatus })

  // 事件通道（preset 形态）+ 兼容服务通道（dynamic 形态）。
  for (const id of st.ids) {
    try {
      ctx.on(id + '/status', (payload) => {
        const snap = payload && typeof payload === 'object' && payload.snapshot ? payload.snapshot : payload
        st.mergeSnapshot(id, snap)
      })
    } catch (e) { }
    try { ctx.on(id + '/mode', (payload) => st.onMode(id, payload)) } catch (e) { }
  }
  const collector = {
    mergeSnapshot(id, snap) { st.mergeSnapshot(id, snap) },
    markMode(id) { st.onMode(id, { active: true }) }
  }
  try { ctx.provide('cliBridgeCollector', collector) } catch (e) { }
  for (const id of st.ids) {
    try {
      ctx.provide(id + 'Collector', {
        mergeSnapshot(snap) { st.mergeSnapshot(id, snap) },
        markMode() { st.onMode(id, { active: true }) }
      })
    } catch (e) { }
  }

  // 声明制 preset 注册（新 DSH；旧 DSH 注入器挂起零副作用）。
  try { declareBridgePresets(ctx, { descriptors }) } catch (e) { }

  // HTTP 路由：单一路由 + 三个旧路由（各返回自己的桶）+ 设置路由 + agy 额度（可选）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const ws = webCtx.get('webServer')
      if (!ws || typeof ws.register !== 'function') return
      webCtx.effect(() => ws.register({
        kind: 'exact', path: '/cli-bridge/status',
        handler: async (req, res) => jsonRes(res, 200, st.snapshot())
      }, 'cli-bridge: status route'))
      for (const id of st.ids) {
        webCtx.effect(() => ws.register({
          kind: 'exact', path: '/' + id + '-indicator/status',
          handler: async (req, res) => jsonRes(res, 200, st.bucketSnapshot(id))
        }, 'cli-bridge: legacy status ' + id))
      }
      webCtx.effect(() => ws.register({
        kind: 'exact', path: '/cli-bridge/settings',
        handler: (req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase()
          if (method === 'GET' || method === 'HEAD') {
            try { jsonRes(res, 200, settingsView({ env: process.env })) }
            catch (e) { jsonRes(res, 500, { error: String(e && e.message || e) }) }
            return
          }
          if (method !== 'POST') { jsonRes(res, 405, { error: 'method not allowed' }); return }
          readBody(req, 64 * 1024).then((text) => {
            const parsed = parseSettingsBody(text, { env: process.env })
            if (!parsed.ok) { jsonRes(res, 400, { error: parsed.error }); return }
            const written = writeSettingsFile(parsed.value, { env: process.env })
            if (!written.ok) { jsonRes(res, 500, { error: written.error }); return }
            jsonRes(res, 200, { ok: true, settings: settingsView({ env: process.env }) })
          }).catch((e) => jsonRes(res, 400, { error: String(e && e.message || e) }))
        }
      }, 'cli-bridge: settings route'))
      // agy 额度（可选增强，脚本缺失返回 { ok:false }）
      webCtx.effect(() => ws.register({
        kind: 'exact', path: '/agy-indicator/quota',
        handler: async (req, res) => { agyQuota(res); }
      }, 'cli-bridge: agy quota route'))
    })
  }
}

let quotaCache = { at: 0, data: null }
function agyQuota(res) {
  // 额度脚本定位：CLI_BRIDGE_AGY_QUOTA 显式覆盖 > 本包内 bin/agy-quota.mjs（由模块
  // 真实路径推导）。绝不硬编码用户桌面路径（历史教训：agy 旧版把
  // C:\Users\lcl\Desktop\agy-first-bridge 写死，换机即坏）。
  let script = process.env.CLI_BRIDGE_AGY_QUOTA || null
  if (!script) {
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      script = join(here, '..', '..', '..', 'bin', 'agy-quota.mjs')
    } catch (e) { }
  }
  if (!script || !existsSync(script)) { jsonRes(res, 200, { ok: false, error: 'quota script not found' }); return }
  const now = Date.now()
  if (quotaCache.data && now - quotaCache.at < 5 * 60 * 1000) { jsonRes(res, 200, quotaCache.data); return }
  import('node:child_process').then(({ execFile }) => {
    execFile('node', [script, '--summary'], { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      let out
      if (err) out = { ok: false, error: String(err.message || err) }
      else { const m = String(stdout || '').match(/\{[\s\S]*\}/); out = m ? JSON.parse(m[0]) : { ok: false, error: 'no JSON' } }
      quotaCache = { at: Date.now(), data: out }
      jsonRes(res, 200, out)
    })
  }).catch((e) => jsonRes(res, 200, { ok: false, error: String(e && e.message || e) }))
}
