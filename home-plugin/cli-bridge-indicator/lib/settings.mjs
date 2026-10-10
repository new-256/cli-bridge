// home-plugin/cli-bridge-indicator/lib/settings.mjs — 统一设置读写（keystone）。
//
// 单一文件 {DSH_HOME}/cli-bridge-settings.json，按 provider id 分区：
//   { "agy": {...}, "codebuddy": {...}, "mimo": {...}, "_scheduling": {...}, "updatedAt": 123 }
// 分区契约（keys/secretKeys/defaults/normalize/meta/diagnose）见 PROVIDER-CONTRACT.md §3，
// 纯逻辑全部来自 providers/registry.mjs 的描述符；本文件只做落盘、掩码、清洗。
//
// `_scheduling` 区（0.2.0 调度）：顶层非 provider 区（下划线前缀 = 永不与 provider id
// 撞名；旧代码逐分区读取会整区忽略它 → 纯增量向后兼容）。{ enabled:[ids], priority:[ids] }
// = 启用集合 + 调用优先级（数组顺序即优先级）；清洗逻辑单源在 core/scheduling.mjs。
//
// token 语义（与 codebuddy v1.3.x 完全一致）：GET 永不回传明文（只回 {set,hint} 掩码）；
// POST 空串/缺省 = 保持现值；`<key>Clear: true` = 显式清除。

import { PROVIDER_IDS, createProvider } from '../../../providers/registry.mjs'
import { SCHEDULING_SECTION, normalizeScheduling } from '../../../core/scheduling.mjs'

export const SETTINGS_FILE_NAME = 'cli-bridge-settings.json'

function builtinModule(name) {
  try {
    const proc = globalThis.process
    return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule(name) : null
  } catch (e) { return null }
}

export function settingsPath(io) {
  const o = io || {}
  const proc = globalThis.process
  const env = o.env || (proc && proc.env) || {}
  try {
    if (env.CLI_BRIDGE_SETTINGS_FILE) return env.CLI_BRIDGE_SETTINGS_FILE
    const nodePath = builtinModule('node:path')
    if (nodePath && env.DSH_HOME) return nodePath.join(env.DSH_HOME, SETTINGS_FILE_NAME)
  } catch (e) { }
  return null
}

function descriptors(io) {
  const o = io || {}
  const map = Object.create(null)
  for (const id of PROVIDER_IDS) {
    try { map[id] = createProvider(id, { env: o.env }) } catch (e) { map[id] = null }
  }
  return map
}

// ── 旧包独立设置文件的一次性迁移读（keystone 职责：文件兼容属于落盘层）──────────
// codebuddy-first-bridge v1.3.x → {DSH_HOME}/codebuddy-bridge-settings.json（扁平同字段名；
//   旧 env 覆盖 CODEBUDDY_SETTINGS_FILE）
// mimo-first-bridge v1.x       → {APPDATA}/mimo-first-bridge/settings.json（键 backend/
//   desktopModel；旧 env 覆盖 MIMO_BRIDGE_SETTINGS；非 Windows 为 HOME/.config）
// 规则：统一文件缺失/无该分区值时回退读旧文件一次；统一文件一旦有值旧文件即失效；
// 永不写旧文件（用户在新面板保存后自然完成迁移）。
function envOf(io) {
  const o = io || {}
  if (o.env) return o.env
  const proc = globalThis.process
  return (proc && proc.env) || {}
}

function configBase(env) {
  const nodePath = builtinModule('node:path')
  if (process.platform === 'win32' && env.APPDATA) return nodePath ? nodePath.join(env.APPDATA, 'mimo-first-bridge', 'settings.json') : env.APPDATA + '/mimo-first-bridge/settings.json'
  const base = env.HOME ? (nodePath ? nodePath.join(env.HOME, '.config') : env.HOME + '/.config') : null
  return base ? (nodePath ? nodePath.join(base, 'mimo-first-bridge', 'settings.json') : base + '/mimo-first-bridge/settings.json') : null
}

const LEGACY_SOURCES = {
  codebuddy: (env) => env.CODEBUDDY_SETTINGS_FILE || (() => {
    const nodePath = builtinModule('node:path')
    return env.DSH_HOME ? (nodePath ? nodePath.join(env.DSH_HOME, 'codebuddy-bridge-settings.json') : env.DSH_HOME + '/codebuddy-bridge-settings.json') : null
  })(),
  mimo: (env) => env.MIMO_BRIDGE_SETTINGS || configBase(env)
}

function legacyPartitionSlice(id, io) {
  const o = io || {}
  try {
    const env = envOf(o)
    const file = LEGACY_SOURCES[id] ? LEGACY_SOURCES[id](env) : null
    if (!file) return null
    const nodeFs = o.legacyFs || builtinModule('node:fs')
    if (!nodeFs || !nodeFs.existsSync || !nodeFs.existsSync(file)) return null
    const parsed = JSON.parse(nodeFs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    let mapped = parsed
    if (id === 'mimo') {
      mapped = {}
      if (parsed.backend) mapped.preferredBackend = parsed.backend
      if (parsed.desktopModel) mapped.desktopModel = parsed.desktopModel
    }
    const out = {}
    for (const k of Object.keys(mapped)) if (mapped[k] !== undefined && mapped[k] !== null && mapped[k] !== '') out[k] = mapped[k]
    return Object.keys(out).length ? out : null
  } catch (e) { return null }
}

export function defaultSettings(io) {
  const map = descriptors(io)
  const out = Object.create(null)
  for (const id of PROVIDER_IDS) {
    const d = map[id]
    out[id] = d && d.settings && typeof d.settings.defaults === 'function' ? d.settings.defaults() : {}
  }
  return out
}

/** 清洗整份设置对象：只认已知 provider 分区 + 各自 keys；未知字段丢弃。 */
export function normalizeAll(raw, io) {
  const map = descriptors(io)
  const snap = Object.create(null)
  for (const id of PROVIDER_IDS) snap[id] = Object.assign({}, defaultSettings(io)[id])
  const touched = Object.create(null)
  for (const id of PROVIDER_IDS) touched[id] = Object.create(null)
  if (raw && typeof raw === 'object') {
    for (const id of PROVIDER_IDS) {
      const src = raw[id]
      if (src && typeof src === 'object') for (const k of Object.keys(src)) touched[id][k] = true
    }
  }
  if (!raw || typeof raw !== 'object') return applyLegacy(snap, map, io, touched)
  for (const id of PROVIDER_IDS) {
    const d = map[id]
    if (!d || !d.settings) continue
    const src = raw[id]
    if (!src || typeof src !== 'object') continue
    try {
      const cleaned = d.settings.normalize(src, (io && io.env) || undefined)
      if (cleaned && typeof cleaned === 'object') snap[id] = Object.assign(snap[id], cleaned)
    } catch (e) { }
  }
  if (typeof raw.updatedAt === 'number' && raw.updatedAt > 0) snap.updatedAt = raw.updatedAt
  const sched = normalizeScheduling(raw[SCHEDULING_SECTION], PROVIDER_IDS)
  snap[SCHEDULING_SECTION] = { enabled: sched.enabled, priority: sched.priority }
  return applyLegacy(snap, map, io, touched)
}

/** 生效调度（含派生 order）：任何来源（文件缺 _ 区/坏值）都回落全开 + 注册表顺序。 */
export function schedulingOf(snap, io) {
  return normalizeScheduling(snap && snap[SCHEDULING_SECTION], PROVIDER_IDS)
}

// 旧包设置文件的字段级回退：只补「统一文件里从未写过这个键」的字段（touched 记录原始
// 键存在性，显式保存过的默认值也算有值 → 旧文件对该字段永久失效）。
function applyLegacy(snap, map, io, touched) {
  for (const id of PROVIDER_IDS) {
    const d = map[id]
    if (!d || !d.settings) continue
    const legacy = legacyPartitionSlice(id, io)
    if (!legacy) continue
    const keys = Array.isArray(d.settings.keys) ? d.settings.keys : []
    const merged = Object.assign({}, snap[id])
    let changed = false
    for (const k of keys) {
      if (legacy[k] === undefined) continue
      if (!touched[id] || !touched[id][k]) { merged[k] = legacy[k]; changed = true }
    }
    if (!changed) continue
    try {
      const cleaned = d.settings.normalize(merged, (io && io.env) || undefined)
      if (cleaned && typeof cleaned === 'object') snap[id] = Object.assign(snap[id], cleaned)
    } catch (e) { }
  }
  return snap
}

export function readSettingsFile(io) {
  const o = io || {}
  try {
    const nodeFs = o.readFileSync || (builtinModule('node:fs') || {})
    const p = ('path' in o) ? o.path : settingsPath(o)
    if (typeof nodeFs.readFileSync !== 'function' || !p) return null
    return normalizeAll(JSON.parse(nodeFs.readFileSync(p, 'utf8')), o)
  } catch (e) { return null }
}

/** 当前生效设置：统一文件缺失时 = 默认值 + 旧包文件字段级回退（仍不写盘）。 */
export function effectiveSettings(io) {
  return readSettingsFile(io) || normalizeAll({}, io)
}

export function writeSettingsFile(value, io) {
  const o = io || {}
  const snap = normalizeAll(value, o)
  snap.updatedAt = Date.now()
  const p = ('path' in o) ? o.path : settingsPath(o)
  if (!p) return { ok: false, error: 'dsh-home not resolved (set DSH_HOME or CLI_BRIDGE_SETTINGS_FILE)' }
  const nodeFs = o.writeFileSync ? { writeFileSync: o.writeFileSync, renameSync: o.renameSync, mkdirSync: o.mkdirSync } : builtinModule('node:fs')
  if (!nodeFs || typeof nodeFs.writeFileSync !== 'function') return { ok: false, error: 'fs unavailable' }
  try {
    const nodePath = builtinModule('node:path')
    const dir = nodePath ? nodePath.dirname(p) : String(p).replace(/[\\/][^\\/]+$/, '')
    if (nodePath && typeof nodeFs.mkdirSync === 'function') { try { nodeFs.mkdirSync(dir, { recursive: true }) } catch (e) { } }
    const tmp = p + '.tmp-' + process.pid
    nodeFs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8')
    if (typeof nodeFs.renameSync === 'function') nodeFs.renameSync(tmp, p)
    else nodeFs.writeFileSync(p, JSON.stringify(snap, null, 2), 'utf8')
    return { ok: true, path: p }
  } catch (e) { return { ok: false, error: String(e && e.message || e) } }
}

/** token 掩码：只回是否已设置 + 尾 4 位，绝不把明文送回浏览器。 */
export function maskToken(tok) {
  const s = String(tok || '')
  if (!s) return { set: false, hint: '' }
  return { set: true, hint: s.length <= 8 ? '••••' : '••••' + s.slice(-4) }
}

/** GET /cli-bridge/settings 响应体：分区视图 + 元数据 + 诊断；secret 字段掩码。 */
export function settingsView(io) {
  const o = io || {}
  const map = descriptors(o)
  const fromFile = readSettingsFile(o)
  const snap = effectiveSettings(o)
  const providers = Object.create(null)
  for (const id of PROVIDER_IDS) {
    const d = map[id]
    if (!d || !d.settings) { providers[id] = { present: false }; continue }
    const sec = Array.isArray(d.settings.secretKeys) ? d.settings.secretKeys : []
    const view = { present: true, fileName: SETTINGS_FILE_NAME, persisted: fromFile !== null, values: Object.assign({}, snap[id]), secrets: Object.create(null) }
    for (const k of Object.keys(view.values)) {
      if (sec.indexOf(k) >= 0) { view.secrets[k] = maskToken(view.values[k]); delete view.values[k] }
    }
    try { if (d.settings.meta) view.meta = d.settings.meta(o.env) } catch (e) { }
    try { if (d.settings.diagnose) view.diagnosis = d.settings.diagnose(snap[id], o.env) } catch (e) { }
    providers[id] = view
  }
  const sched = normalizeScheduling(snap[SCHEDULING_SECTION], PROVIDER_IDS)
  const labels = Object.create(null)
  for (const id of PROVIDER_IDS) labels[id] = (map[id] && map[id].label) || id
  return {
    fileName: SETTINGS_FILE_NAME, updatedAt: snap.updatedAt || 0, providers,
    scheduling: {
      enabled: sched.enabled, priority: sched.priority, order: sched.order,
      all: PROVIDER_IDS.slice(), labels
    }
  }
}

/**
 * POST body（文本）→ { ok, value?|error? }：
 * body = { agy:{...}, codebuddy:{...}, mimo:{...}, <id>Clear:{key:true}? } 形式的分区对象。
 * 缺省字段 = 保持现值；secret 空串 = 保持现值，`<key>Clear:true` = 清除。
 */
export function parseSettingsBody(text, io) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty body' }
  let raw
  try { raw = JSON.parse(text) } catch (e) { return { ok: false, error: 'invalid JSON' } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'body must be an object' }
  const o = io || {}
  const map = descriptors(o)
  const cur = effectiveSettings(o)
  const next = Object.create(null)
  for (const id of PROVIDER_IDS) next[id] = Object.assign({}, cur[id] || {})
  // 保持语义：body 不带 _scheduling 时沿用现值（旧客户端/其它调用方 provider-only 提交
  // 绝不能把用户的调度配置悄悄重置）。
  if (cur[SCHEDULING_SECTION]) next[SCHEDULING_SECTION] = Object.assign({}, cur[SCHEDULING_SECTION])
  for (const id of Object.keys(raw)) {
    if (PROVIDER_IDS.indexOf(id) < 0) continue
    const d = map[id]
    if (!d || !d.settings) continue
    const part = raw[id]
    if (!part || typeof part !== 'object') return { ok: false, error: 'partition ' + id + ' must be an object' }
    const keys = Array.isArray(d.settings.keys) ? d.settings.keys : []
    const sec = Array.isArray(d.settings.secretKeys) ? d.settings.secretKeys : []
    for (const k of keys) {
      const v = part[k]
      if (v !== undefined && typeof v !== 'string') return { ok: false, error: 'field ' + id + '.' + k + ' must be a string' }
      if (typeof v !== 'string' || !v.trim()) {
        if (sec.indexOf(k) >= 0 && part[k + 'Clear'] !== true) continue // 保持现值
        if (sec.indexOf(k) >= 0) next[id][k] = ''                       // 显式清除
        continue
      }
      next[id][k] = v.trim()
    }
  }
  // 调度区：整区替换语义（面板每次提交完整 enabled+priority）；缺省 = 保持现值。
  // 类型严格：非对象/数组元素含未知 id 直接 400，避免半写坏配置。
  if (Object.prototype.hasOwnProperty.call(raw, SCHEDULING_SECTION)) {
    const sec = raw[SCHEDULING_SECTION]
    if (!sec || typeof sec !== 'object' || Array.isArray(sec)) return { ok: false, error: 'field _scheduling must be an object' }
    for (const key of ['enabled', 'priority']) {
      if (sec[key] === undefined) continue
      if (!Array.isArray(sec[key])) return { ok: false, error: 'field _scheduling.' + key + ' must be an array' }
      for (const x of sec[key]) {
        if (typeof x !== 'string' || PROVIDER_IDS.indexOf(x) < 0) return { ok: false, error: 'unknown provider id in _scheduling.' + key + ': ' + JSON.stringify(x) }
      }
    }
    if (sec.enabled !== undefined || sec.priority !== undefined) {
      const base = normalizeScheduling(cur[SCHEDULING_SECTION], PROVIDER_IDS)
      const merged = normalizeScheduling({
        enabled: Array.isArray(sec.enabled) ? sec.enabled : base.enabled,
        priority: Array.isArray(sec.priority) ? sec.priority : base.priority
      }, PROVIDER_IDS)
      next[SCHEDULING_SECTION] = { enabled: merged.enabled, priority: merged.priority }
    }
  }
  return { ok: true, value: normalizeAll(next, o) }
}
