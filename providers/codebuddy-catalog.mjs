// providers/codebuddy-catalog.mjs — codebuddy 模型目录/积分/描述文件解析（纯逻辑）。
//
// 从 providers/codebuddy.mjs 拆出：主文件原 864 行远超 600 行红线（规则 §26）。
// 只放「模型目录相关」纯逻辑：静态表、描述文件候选路径、模型 id 抽取、积分倍率、
// 账号清单收割、目录渲染。不含 CLI 调用、状态机、凭据链。
//
// 沙箱纪律（与 providers/*.mjs 同）：本文件会被 scripts/build.mjs 经模板顶部的
// 第三个占位标记内联进同一个 dynamic 沙箱脚本作用域 —— 所以：
//   1) 不得 import 任何模块（import 行会被 stripModuleSyntax 剥掉，函数体留下但
//      依赖丢失 → 运行期 ReferenceError）；node 内建走 cbCatalog* 守卫；
//   2) 顶层标识符不得与 bridge-kit / codebuddy.mjs 剩余部分撞名（同一作用域重复
//      声明 = 构建期 Identifier already declared）；
//   3) 不得出现 import.meta 字面量；
//   4) ⚠️ 注释里绝不写出那个占位标记的字面量：build 做全局文本替换，注释中出现
//      同样会被替换成正文代码，把注释从中间劈开 → 生成物语法崩。

// ── 宿主能力注入（env / fs / path / sep）───────────────────────────────────
// 本模块函数搬自主文件的闭包，拿不到那边的 env / fsRead / pathJoin / pathSep。
// 由 codebuddy.mjs 在 defineProvider 里调 cbCatalogSetHost() 注入；未注入时退到
// getBuiltinModule 守卫（沙箱里没有 → 返回 null / 默认分隔符，绝不抛）。
// 名字一律带 cbCatalog_ 前缀：内联后与主文件的 fsRead/pathJoin 同处一个作用域。
// export 供 codebuddy-models-source.mjs 读取：ESM live binding，cbCatalogSetHost 后自动同步。
export let cbCatalogEnv = {}
let cbCatalogFs = null
let cbCatalogPathSep = "/"

export function cbCatalogSetHost(envObj, pathMod, fsMod) {
  if (envObj && typeof envObj === "object") cbCatalogEnv = envObj
  if (fsMod && typeof fsMod.readFileSync === "function") cbCatalogFs = fsMod
  if (pathMod && typeof pathMod.sep === "string") cbCatalogPathSep = pathMod.sep
  else if (/[A-Za-z]:[\\/]/.test(String((cbCatalogEnv && (cbCatalogEnv.USERPROFILE || cbCatalogEnv.APPDATA)) || ""))) cbCatalogPathSep = "\\"
}

export function cbCatalogRead(p, enc) {
  if (!p) return null
  try {
    if (cbCatalogFs && typeof cbCatalogFs.readFileSync === "function") return cbCatalogFs.readFileSync(p, enc || "utf8")
    const proc = globalThis.process
    const nf = (proc && typeof proc.getBuiltinModule === "function") ? proc.getBuiltinModule("node:fs") : null
    if (!nf || typeof nf.readFileSync !== "function") return null
    return nf.readFileSync(p, enc || "utf8")
  } catch (e) { return null }
}

export function cbCatalogPathJoin(...parts) {
  try {
    const proc = globalThis.process
    const np = (proc && typeof proc.getBuiltinModule === "function") ? proc.getBuiltinModule("node:path") : null
    if (np && typeof np.join === "function") return np.join(...parts)
  } catch (e) { }
  return parts.join("/")
}

// ── 以下常量与函数原样搬自 providers/codebuddy.mjs（行为 zero-change）────────

export const BACKEND_MODEL_IDS = {
  'codebuddy': ['hy4-preview', 'hy3', 'hy3-x', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3', 'minimax-m2.7', 'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro'],
  'codebuddy-intl': ['claude-sonnet-5', 'claude-sonnet-5-1m', 'claude-opus-5', 'claude-opus-4.8', 'claude-opus-4.8-1m', 'gemini-3.1-pro', 'gemini-3.5-flash', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'glm-5.3-ioa', 'glm-5.3-flash-ioa', 'glm-5.2-ioa', 'kimi-k3-ioa', 'kimi-k2.8-preview', 'kimi-k2.6-ioa', 'minimax-m3-ioa', 'minimax-m2.7-ioa', 'deepseek-v4.1-flash', 'deepseek-v4-pro-ioa'],
  // WorkBuddyAI 自制目录（product.json 顶层 37 项，按其 credits 排序：免费的在前）
  'codebuddy-en': ['hy3', 'gpt-5.1-codex-mini', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'minimax-m3', 'gemini-3.0-flash', 'fast-model', 'deepseek-v3-2-volc', 'balanced-model', 'kimi-k2.5', 'kimi-k2.6', 'default-model-lite', 'glm-5.3', 'glm-5.2', 'glm-5.0', 'gpt-5.1-codex', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gpt-5.3-codex', 'gemini-3.1-pro', 'gpt-5.6-terra', 'kimi-k3', 'gpt-5.4', 'primary-model', 'default-model', 'deep-model', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-luna'],
  // WorkBuddy 国内桌面自制目录（product.json：applicationName=WorkBuddy）
  'workbuddy': ['auto', 'hy4-preview', 'hy3', 'hy3-x', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3', 'minimax-m2.7', 'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro']
}

// 各后端真正生效的 product 描述文件位置（旧 core v1.6.1 verbatim）。
export const PRODUCT_DESCRIPTOR_ENV = {
  'codebuddy': { env: 'CODEBUDDY_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: null },
  'codebuddy-intl': { env: 'CODEBUDDY_INTL_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: null },
  'codebuddy-en': { env: 'CODEBUDDY_EN_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: '.workbuddy-ai' },
  'workbuddy': { env: 'WORKBUDDY_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: '.workbuddy' }
}

// 倍率跨命名匹配（账号清单 id → 描述文件 id，旧 core verbatim）。
export const CREDIT_ID_ALIASES = {
  'kimi-k3-1': ['kimi-k3', 'kimi-k3-ioa'],
  'hy3-x': ['hy3', 'hy3-ioa'],
  'default': ['codewise-default-model-v2'],
  'auto': ['hy3', 'hy3-ioa']
}

export const MODEL_DESCRIPTION = 'Optional model id. When unspecified, the user-preferred default model (plugin settings) is used if set, else the CLI default. Two layers decide: the PRODUCT FACE decides whether the id exists in its catalogue, then the ACCOUNT decides whether it is licensed. The free tier (hy3, deepseek-v4.1-flash at x0.00 credits; hy4-preview at x0.29) belongs to the npm CLI faces codebuddy/codebuddy-intl: hy4-preview, hy3, hy3-x, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3, minimax-m2.7, kimi-k3-1, kimi-k2.8-preview, kimi-k2.7, kimi-k2.6, deepseek-v4-pro. codebuddy-en (WorkBuddyAI) carries NO hy4-preview and NO deepseek-v4.1-flash; its only free model is hy3. International ids (claude-sonnet-5, gemini-3.1-pro, ...) are account-gated. Availability is per ACCOUNT: the CLI rejects an id outside the account catalogue with "400 service info not found" and one inside it but unlicensed with "400 only available for authorized users" (many catalogue flagships such as claude-opus-4.8, gpt-5.4 and gpt-6-astra are in this second group for a domestic account). Run the CLI with a deliberately invalid model id to print "Currently supported models for your account:" and get the authoritative list; the plugin caches that result and the settings panel lists exactly those ids with their credit multiplier (x0.00 = free), read live from the CLI descriptor so it stays in sync with CLI upgrades. Prefer the cheapest model that can do the job, and prefer a free (x0.00) one for routine work. Pass a model only when the task clearly benefits from a specific one.'

export const BACKEND_ENUM = ['codebuddy', 'codebuddy-intl', 'codebuddy-ioa', 'codebuddy-international', 'codebuddy-en', 'workbuddy-en', 'workbuddy-ai', 'workbuddy']

  export function accountConfigCandidates(backend, io) {
    const e = (io && io.env) || cbCatalogEnv
    const spec = PRODUCT_DESCRIPTOR_ENV[backend]
    if (!spec || !spec.accountDir) return []
    const home = e.USERPROFILE || e.HOME
    if (!home) return []
    const base = cbCatalogPathJoin(home, spec.accountDir.split('/').join(cbCatalogPathSep))
    return [
      cbCatalogPathJoin(base, 'cache', 'acc-product-config-v3.json'),
      cbCatalogPathJoin(base, 'local_storage', 'entry_d43e96994f944cfb77961c2ea7d04605.info'),
      cbCatalogPathJoin(base, 'local_storage', 'wb_entry_d43e96994f944cfb77961c2ea7d04605.info')
    ]
  }

  export function productDescriptorCandidates(backend, io) {
    const e = (io && io.env) || cbCatalogEnv
    const spec = PRODUCT_DESCRIPTOR_ENV[backend]
    if (!spec) return []
    const out = []
    for (const p of accountConfigCandidates(backend, io)) out.push(p)
    if (e[spec.env]) out.push(e[spec.env])
    const rels = spec.fallbackRel ? [spec.rel, spec.fallbackRel] : [spec.rel]
    const push = (root) => { if (root) for (const r of rels) out.push(cbCatalogPathJoin(root, ...r.split('/'))) }
    if (backend === 'codebuddy' || backend === 'codebuddy-intl') {
      push(e.APPDATA ? cbCatalogPathJoin(e.APPDATA, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code') : null)
    } else if (backend === 'codebuddy-en') {
      push('C:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli')
    } else if (backend === 'workbuddy') {
      push('C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli')
    }
    return out
  }

  export function normalizeProductConfig(raw) {
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

  export function extractModelIds(productJson) {
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

  export function parseCreditValue(raw) {
    if (typeof raw !== 'string') return null
    const s = raw.trim()
    let m = s.match(/^[xX×]\s*([0-9]+(?:\.[0-9]+)?)/)
    if (!m) m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*[xX×]/)
    if (!m) return null
    const n = Number(m[1])
    return Number.isFinite(n) ? n : null
  }

  export function formatCreditLabel(credits) {
    if (typeof credits !== 'number' || !Number.isFinite(credits)) return ''
    if (credits === 0) return '免费'
    return `x${credits.toFixed(2)}`
  }

  export function extractModelCredits(productJson) {
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

  export function lookupModelCredits(creditsMap, id) {
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

  export function backendModelCatalog(backend, io) {
    const known = BACKEND_MODEL_IDS[backend] || []
    const read = (io && io.readFileSync) || cbCatalogRead
    let fromFile = null
    let fromFileRich = null
    // 旧 v1.6.1 语义：第一份有内容的 + 第一份带促销的，优先后者。
    for (const p of productDescriptorCandidates(backend, io)) {
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
  export function rememberAccountCatalog(backend, ids) {
    if (Array.isArray(ids) && ids.length) ACCOUNT_CATALOG_CACHE.set(backend, ids.slice())
  }
  export function getAccountCatalog(backend) {
    const v = ACCOUNT_CATALOG_CACHE.get(backend)
    return v && v.length ? v.slice() : null
  }

  export function parseAccountModels(text) {
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
  export function modelCatalogDetailed(backend, io) {
    const o = io || {}
    const fromFile = backendModelCatalog(backend, o)
    const acct = (Array.isArray(o.accountModels) && o.accountModels.length) ? o.accountModels : getAccountCatalog(backend)
    const ids = []
    const authorized = new Set()
    if (acct) for (const id of acct) { if (!ids.includes(id)) ids.push(id); authorized.add(id) }
    for (const id of fromFile) if (!ids.includes(id)) ids.push(id)
    const read = o.readFileSync || cbCatalogRead
    let creditsMap = null
    for (const p of productDescriptorCandidates(backend, io)) {
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

  export function formatModelCatalogText(backend, io) {
    return modelCatalogDetailed(backend, io).map((x) => x.label).join(', ')
  }


export const BACKEND_AUTH_IDS = {
  'codebuddy': 'Tencent-Cloud.coding-copilot',
  'codebuddy-intl': 'Tencent-Cloud.coding-copilot',
  'codebuddy-en': 'workbuddy-desktop-ai',
  'workbuddy': 'workbuddy-desktop'
}

export const CREDENTIAL_KEYS = ['WORKBUDDY_TOKEN', 'WORKBUDDY_AI_TOKEN', 'CODEBUDDY_EN_TOKEN']

// ── 凭据读取（搬自 codebuddy.mjs；fs/path 走 cbCatalog* 守卫，env 经 io 或注入）
  export function readBackendAuthDomain(backend, io) {
    const o = io || {}
    const id = BACKEND_AUTH_IDS[backend]
    if (!id) return null
    try {
      const read = o.readFileSync || cbCatalogRead
      if (typeof read !== 'function') return null
      const e = o.env || env
      let dir = o.dir
      if (!dir) {
        dir = e.CODEBUDDY_AUTH_DIR ||
          cbCatalogPathJoin(e.LOCALAPPDATA || 'C:\\Users\\lcl\\AppData\\Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
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
  export function readDshWorkbuddyToken(io) {
    const e = (io && io.env) || cbCatalogEnv
    const read = (io && io.readFileSync) || cbCatalogRead
    const overrideDir = e.CODEBUDDY_CREDENTIALS_DIR || null
    const home = overrideDir || e.DSH_HOME || null
    if (!home) return null
    const files = [home + '\\.credentials.yaml', home + '\\.env', home + '/.credentials.yaml', home + '/.env']
    for (const f of files) {
      const text = read(f)
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
  export function resolveEnToken(settingToken, io) {
    const e = (io && io.env) || cbCatalogEnv
    const s = String(settingToken || '').trim()
    if (s) return { token: s, source: 'setting' }
    const envTok = e.CODEBUDDY_AUTH_TOKEN || ''
    if (String(envTok).trim()) return { token: String(envTok).trim(), source: 'env' }
    const fromStore = readDshWorkbuddyToken(io)
    if (fromStore) return { token: fromStore, source: 'dsh-store' }
    return { token: null, source: null }
  }

