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

export function codexSetHost(envObj, fsMod, pathMod) {
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

export function codexPathJoin() {
  const parts = Array.prototype.slice.call(arguments).filter((x) => x !== undefined && x !== null && x !== '')
  if (!parts.length) return ''
  const mod = codexHostPath || codexBuiltin('node:path')
  if (mod && typeof mod.join === 'function') return mod.join.apply(mod, parts)
  return parts.map((x) => String(x)).join('/')
}

export function codexReadText(p) {
  if (!p) return null
  const fs = codexFs()
  if (!fs) return null
  try { return fs.readFileSync(p, 'utf8') } catch (e) { return null }
}

/** CODEX_HOME 覆盖 ~/.codex（CLI 自身语义）。 */
export function codexHomeDir(env) {
  const e = env || codexHostEnv || {}
  if (e.CODEX_HOME) return String(e.CODEX_HOME)
  const home = e.USERPROFILE || e.HOME || ''
  return home ? codexPathJoin(home, '.codex') : ''
}

// ── config.toml 最小解析 ─────────────────────────────────────────────────────
// 只需要字符串标量与表头：本模块读的键是 model / model_provider / model_catalog_json，
// 以及 [model_providers.<name>] 下的 base_url / experimental_bearer_token。
// 数组（notify = [...]）、布尔、数字一律跳过 —— 宁可少读，也不猜错类型。
export function codexParseToml(text) {
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
export function codexReadConfig(env) {
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
export function codexModelsEndpoint(env) {
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
export function codexExeCandidates(env) {
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
export function codexResolveExePrefix(env, binPath) {
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
export function codexShimRejectReason(binPath) {
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
export function codexNormalizeModelItem(raw, source) {
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
export function codexParseModelsPayload(text, source) {
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
export function codexCachedLiveModels(env, nowMs) {
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

function codexFetchInit(token) {
  const headers = { accept: 'application/json' }
  if (token) headers.authorization = 'Bearer ' + token
  return { method: 'GET', headers }
}

function codexDescribeFetchError(status, body) {
  const head = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (status === 401 || status === 403) {
    return 'HTTP ' + status + ' — the provider rejected the credential. Set model_providers.<name>.experimental_bearer_token (or auth.json OPENAI_API_KEY) for the endpoint you actually use. ' + head
  }
  return 'HTTP ' + status + (head ? ' — ' + head : '')
}

/** A 层（异步）：GET {base_url}/models。deps.fetch 可注入（测试），否则用全局 fetch。 */
export async function codexLiveModels(env, opts) {
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
  try { res = await f(ep.url, codexFetchInit(ep.token)) } catch (e) {
    return { ok: false, source: 'live', models: [], url: ep.url, error: 'GET ' + ep.url + ' failed: ' + String(e && e.message || e) + '. Check network/proxy, or set CODEX_BRIDGE_MODELS_URL to the provider catalogue endpoint.' }
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

// 子进程探针脚本：spawnSync 里不能 await，所以让子进程自己 async fetch 再打印。
// token/url 只经 env 传递（绝不进命令行，避免凭据出现在进程参数里被别的进程看到）。
// 子进程只回吐原始 body，解析仍由上面的 parse 统一做（单一解析实现，避免漂移）。
const CODEX_PROBE_SCRIPT = [
  'const url = process.env.CODEX_BRIDGE_PROBE_URL',
  'const token = process.env.CODEX_BRIDGE_PROBE_TOKEN || ""',
  'const ms = Number(process.env.CODEX_BRIDGE_PROBE_TIMEOUT || 8000)',
  'const headers = { accept: "application/json" }',
  'if (token) headers.authorization = "Bearer " + token',
  'const ctrl = new AbortController()',
  'const timer = setTimeout(() => { try { ctrl.abort() } catch (e) {} }, ms)',
  'fetch(url, { headers, signal: ctrl.signal })',
  '  .then(async (r) => { const b = await r.text(); process.stdout.write(JSON.stringify({ status: r.status, body: b })) })',
  '  .catch((e) => { process.stdout.write(JSON.stringify({ status: 0, error: String((e && e.message) || e) })) })',
  '  .finally(() => clearTimeout(timer))'
].join('\n')

/**
 * A 层（同步）：设置面板是同步回调，而 HTTP 客户端没有同步 API —— 用一个 node 子进程
 * 跑上面的探针脚本，spawnSync 拿回 body。结果进 5 分钟缓存（面板反复渲染不至于反复起进程）。
 */
export function codexLiveModelsSync(env, opts) {
  const o = opts || {}
  const ep = codexModelsEndpoint(env)
  if (!ep.ok) return { ok: false, source: 'live', models: [], error: ep.error }
  const cached = codexCachedLiveModels(env, o.nowMs)
  if (cached) return cached
  const proc = codexProcess()
  const child = codexBuiltin('node:child_process')
  if (!proc || !proc.execPath || !child || typeof child.spawnSync !== 'function') {
    return { ok: false, source: 'live', models: [], url: ep.url, error: 'no spawnSync capability to read ' + ep.url + ' synchronously' }
  }
  const r = child.spawnSync(proc.execPath, ['-e', CODEX_PROBE_SCRIPT], {
    encoding: 'utf8',
    timeout: Math.max(2000, Math.min(Number(o.timeoutMs) || 9000, 30000)),
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, proc.env, {
      CODEX_BRIDGE_PROBE_URL: ep.url,
      CODEX_BRIDGE_PROBE_TOKEN: ep.token,
      CODEX_BRIDGE_PROBE_TIMEOUT: String(Math.max(2000, Math.min(Number(o.timeoutMs) || 9000, 30000)) - 500)
    })
  })
  if (!r || r.error) {
    return { ok: false, source: 'live', models: [], url: ep.url, error: 'probe spawn failed: ' + String((r && r.error && (r.error.code || r.error.message)) || 'unknown') }
  }
  let out = null
  try { out = JSON.parse(String(r.stdout || '')) } catch (e) { out = null }
  if (!out) {
    return { ok: false, source: 'live', models: [], url: ep.url, error: 'probe produced no JSON (exit=' + r.status + '): ' + String(r.stderr || r.stdout || '').slice(0, 200) }
  }
  if (!out.status && out.error) return { ok: false, source: 'live', models: [], url: ep.url, error: 'GET ' + ep.url + ' failed: ' + String(out.error) }
  if (out.status < 200 || out.status >= 300) {
    return { ok: false, source: 'live', models: [], url: ep.url, error: 'GET ' + ep.url + ' → ' + codexDescribeFetchError(out.status, out.body) }
  }
  const parsed = codexParseModelsPayload(out.body, 'live')
  if (!parsed.ok) return { ok: false, source: 'live', models: [], url: ep.url, error: ep.url + ': ' + parsed.error }
  if (!parsed.models.length) {
    return { ok: false, source: 'live', models: [], url: ep.url, error: ep.url + ' returned 0 usable models (payload items=' + parsed.total + '). Refusing to report an empty list as authoritative.' }
  }
  const payload = {
    ok: true, source: 'live', models: parsed.models, count: parsed.models.length,
    url: ep.url, baseUrl: ep.baseUrl, providerName: ep.providerName, fetchedAt: Date.now()
  }
  codexRememberLive(ep.url, payload)
  return payload
}

/** B 层：config.toml 的 model_catalog_json（相对 CODEX_HOME）。 */
export function codexCatalogModels(env) {
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
export function codexBuiltinModels(env) {
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
 * 设置面板下拉的候选池。
 * 优先实时（缓存或同步探测）；实时拿不到时**明确标注**地退到本地目录，
 * 让用户至少有东西可选，同时 note 里说清「这不是服务端权威清单」。
 */
export function codexModelOptions(env, opts) {
  const o = opts || {}
  const live = o.skipLive ? null : (codexCachedLiveModels(env) || codexLiveModelsSync(env, { timeoutMs: o.timeoutMs }))
  if (live && live.ok && live.models.length) {
    return {
      options: live.models.map((m) => ({ value: m.id, label: m.id + (m.free ? '  [free]' : '') + '  [实时]' })),
      source: 'live', url: live.url, note: '实时清单来自 ' + live.url + '（' + live.count + ' 个，免费模型标 [free]）。'
    }
  }
  const cat = codexCatalogModels(env)
  if (cat.ok) {
    return {
      options: cat.models.map((m) => ({ value: m.id, label: m.id + '  [本地目录]' })),
      source: 'catalog', file: cat.file,
      note: '实时清单不可用（' + String((live && live.error) || '未探测') + '）。以下 ' + cat.count + ' 项来自 config.toml 的 model_catalog_json，仅代表 codex 本地目录，不是服务端权威清单。'
    }
  }
  const builtin = codexBuiltinModels(env)
  if (builtin.ok) {
    return {
      options: builtin.models.map((m) => ({ value: m.id, label: m.id + '  [内置定义]' })),
      source: 'builtin', file: builtin.file,
      note: '实时清单与本地目录都不可用（' + String((cat && cat.error) || '') + '）。以下来自 ~/.codex/models.json 内置定义，不是服务端权威清单。'
    }
  }
  return {
    options: [], source: 'none',
    note: '未能读取任何模型清单：' + String((live && live.error) || 'live unavailable') + '；可直接手动输入模型 id。'
  }
}
