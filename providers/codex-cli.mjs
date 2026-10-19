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

function codexFetchInit(token, signal) {
  const headers = { accept: 'application/json' }
  if (token) headers.authorization = 'Bearer ' + token
  const init = { method: 'GET', headers }
  // 面板「拉取可用模型」是 HTTP 请求上的同步等待：端点卡住时必须有上界，
  // 否则设置页会一直转圈（无 signal 能力的宿主就照旧直接请求）。
  if (signal) init.signal = signal
  return init
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
  // 取清单是设置面板的一次同步等待（点按钮 → HTTP → 这里）：必须有上界。
  // 无 AbortController 的宿主退化为不带上界（照旧请求），不静默改变成功语义。
  const timeoutMs = Math.max(2000, Math.min(Number(o.timeoutMs) || 20000, 60000))
  const ctrl = (typeof AbortController === 'function') ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort() } catch (err) { } }, timeoutMs) : null
  try { res = await f(ep.url, codexFetchInit(ep.token, ctrl ? ctrl.signal : null)) } catch (e) {
    return { ok: false, source: 'live', models: [], url: ep.url, error: 'GET ' + ep.url + ' failed (timeout ' + timeoutMs + 'ms): ' + String(e && e.message || e) + '. Check network/proxy, or set CODEX_BRIDGE_MODELS_URL to the provider catalogue endpoint.' }
  } finally {
    if (timer) clearTimeout(timer)
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

// 子进程探针脚本已删除：面板不再自动探测（契约 §3.2 手动拉取）。live 清单只在
// settings.refreshModels()（异步、用户点按钮）与时序工具 codex_models 里读取。

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
 * 面板下拉的候选池（契约 §3.2）：**纯读缓存**，绝不 spawnSync、绝不发请求、绝不碰本地目录。
 * 探测由 settings.refreshModels() 显式触发（用户点「拉取可用模型」），成功后写回同一份
 * CODEX_MODEL_CACHE，这里下次渲染直接命中 —— 面板首屏因此不会被网络拖慢。
 *
 * 为什么不再回落到 catalog/builtin：那两层是本地元数据，不是服务端可用清单；把它们填进
 * 这个下拉等于让用户以为「服务端就这些」（0.2.6~0.2.9 反复踩的坑）。宁可空着并说清
 * 「点按钮拉取」，也不展示可能已经过时的非权威列表 —— 需要本地目录请用 codex_models
 * 的 source="catalog"/"builtin" 显式查询（那里逐项标注来源）。
 */
export function codexCachedModelOptions(env) {
  const live = codexCachedLiveModels(env)
  if (!live || !live.ok || !Array.isArray(live.models) || !live.models.length) {
    return {
      options: [], source: 'none', count: 0,
      note: '还没拉取过（或上次没拉到）：点「拉取可用模型」向端点取权威清单；空表示尚未拉取 / 端点或 token 未配好。可直接手动输入模型 id。'
    }
  }
  return {
    options: live.models.map((m) => ({ value: m.id, label: m.id + (m.free ? '  [free]' : '') })),
    source: 'live', count: live.count, url: live.url, fetchedAt: live.fetchedAt,
    note: '上次拉取到 ' + live.count + ' 个模型（源：' + live.url + '，免费标 [free]）。点「拉取可用模型」重新获取。'
  }
}
