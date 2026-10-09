// home-plugin/cli-bridge-indicator/lib/settings.mjs — 统一设置读写（keystone）。
//
// 单一文件 {DSH_HOME}/cli-bridge-settings.json，按 provider id 分区：
//   { "agy": {...}, "codebuddy": {...}, "mimo": {...}, "updatedAt": 123 }
// 分区契约（keys/secretKeys/defaults/normalize/meta/diagnose）见 PROVIDER-CONTRACT.md §3，
// 纯逻辑全部来自 providers/registry.mjs 的描述符；本文件只做落盘、掩码、清洗。
//
// token 语义（与 codebuddy v1.3.x 完全一致）：GET 永不回传明文（只回 {set,hint} 掩码）；
// POST 空串/缺省 = 保持现值；`<key>Clear: true` = 显式清除。

import { PROVIDER_IDS, createProvider } from '../../../providers/registry.mjs'

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
  if (!raw || typeof raw !== 'object') return snap
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
  const snap = fromFile || defaultSettings(o)
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
  return { fileName: SETTINGS_FILE_NAME, updatedAt: snap.updatedAt || 0, providers }
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
  const cur = readSettingsFile(o) || defaultSettings(o)
  const next = Object.create(null)
  for (const id of PROVIDER_IDS) next[id] = Object.assign({}, cur[id] || {})
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
  return { ok: true, value: normalizeAll(next, o) }
}
