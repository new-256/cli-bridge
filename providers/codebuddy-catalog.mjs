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
let cbCatalogEnv = {}
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

  // ── 实时模型清单（CLI 是一手权威来源，对齐 workbuddy-auth 的「权威白名单」思路）──
  //
  // 为什么不再以静态表/磁盘描述文件为主：实测本机 codebuddy CLI --
  //   • 账号实时清单（用无效模型触发 400 报文）= 19 项
  //   • CLI `--help` 声明的 roster         = 19 项，与账号清单完全一致
  //   • 我们原先读的 product.ioa.json 静态表 = 16 项，且 2 个 id 已过时
  //     （minimax-m3 → minimax-m3-pay、kimi-k3-1 → kimi-k3-2），另缺 4 个新模型。
  //   静态表是「随包冻结」的，必然落后于 CLI，故只保留作倍率元数据与最后兜底。
  //
  // 两级实时来源（都不静默冒充权威数据，各带 source 标签）：
  //   A. account-live —— 起 CLI 用无效模型探测「该账号当前支持」的清单（需该面已登录，
  //      一次网络往返；对照 workbuddy-auth 的 agents[cli].models 白名单语义）。
  //   B. cli-help     —— 解析 `--help` 的 "Currently supported: (...)"（零网络、随 CLI
  //      版本自动更新；产品面级 roster）。
  // 静态表仅作 credit 元数据与 descriptor-static 兜底标签，绝不冒充实时。

  /** 解析 CLI `--help` 里声明的模型 roster。空/畸形输入返回 []。
   *  ⚠️ 名册很长时 yargs 会在任意列**折行**（实测把 `minimax-m3-pay` 从中间断成
   *  `minimax-` + `m3-pay`），若按行/按逗号直接切会丢项或产生残片（同一命令两次运行
   *  给出 18/19 两种结果）。故先去掉括号内所有空白再按逗号切：逗号是唯一分隔符，
   *  折行插入的空白一律视为噪声。 */
  export function parseHelpModels(helpText) {
    const m = /Currently supported:\s*\(([^)]+)\)/.exec(String(helpText || ''))
    if (!m) return []
    const out = []
    for (const raw of m[1].replace(/\s+/g, '').split(',')) {
      const id = raw.trim()
      if (id && /^[A-Za-z0-9_.\-]+$/.test(id) && out.indexOf(id) < 0) out.push(id)
    }
    return out
  }

  /** 解析 codebuddy CLI 的可执行候选（env > npm 全局 shim > PATH 名）。 */
  export function cbCatalogCliCandidates(env) {
    const e = env || cbCatalogEnv || {}
    const out = []
    const push = (p) => { if (p && out.indexOf(p) < 0) out.push(p) }
    if (e.CODEBUDDY_BIN) push(String(e.CODEBUDDY_BIN))
    const joinP = (a, b) => cbCatalogPathJoin(a, b)
    if (e.APPDATA) push(joinP(joinP(e.APPDATA, 'npm'), 'codebuddy.cmd'))
    if (e.APPDATA) push(joinP(joinP(e.APPDATA, 'npm'), 'codebuddy'))
    push('codebuddy')
    return out
  }

  const CLI_MODEL_CACHE = new Map() // backend → { at, mode, ids }
  const CLI_MODEL_TTL_MS = 5 * 60 * 1000

  // Windows .cmd/.bat 需要经 shell（Node 安全限制），但 `shell:true` + args 数组会触发
  // DEP0190（参数不转义）。这里统一做法：把命令与参数拼成【一个】字符串交给 shell，
  // 参数各自按 Windows 规则加引号 —— 既避开 DEP0190，又保证含空格参数不被拆开。
  function quoteWinArg(a) {
    const s = String(a)
    if (s === '') return '""'
    if (!/[\s"&|<>^]/.test(s)) return s
    return '"' + s.replace(/"/g, '\\"') + '"'
  }
  function cliCommandLine(exe, args) {
    return [exe].concat(args || []).map(quoteWinArg).join(' ')
  }

  /** 把候选拆成 { cmd, prefixArgs }：.mjs/.js/.cjs 目标经 node 包装（测试夹具与自定义
   *  入口都靠这条），其余原样。 */
  function splitExeSpec(exe) {
    if (/\.(mjs|cjs|js)$/i.test(String(exe))) {
      const proc = globalThis.process
      return { cmd: (proc && proc.execPath) ? proc.execPath : 'node', prefixArgs: [String(exe)] }
    }
    return { cmd: String(exe), prefixArgs: [] }
  }

  function cliSpawnSync(exe, args, opts) {
    const proc = globalThis.process
    const child = (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('node:child_process') : null
    if (!child || typeof child.spawnSync !== 'function') return null
    const base = Object.assign({
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    }, opts || {})
    const spec = splitExeSpec(exe)
    const argv = spec.prefixArgs.concat(args || [])
    const isCmd = /\.(cmd|bat)$/i.test(spec.cmd)
    if (isCmd) base.shell = true
    try {
      // shell 形态不带 args 数组（否则 DEP0190）；非 shell 形态正常传数组。
      return isCmd
        ? child.spawnSync(cliCommandLine(spec.cmd, argv), base)
        : child.spawnSync(spec.cmd, argv, base)
    } catch (e) { return null }
  }

  /**
   * 同步取「CLI 声明的 roster」（零网络，随 CLI 版本走）。
   * @returns {{ok:boolean, ids:string[], mode:string, error?:string}}
   */
  export function fetchHelpModelsSync(env, opts) {
    const o = opts || {}
    const cands = cbCatalogCliCandidates(env)
    let lastErr = null
    for (const exe of cands) {
      const r = cliSpawnSync(exe, ['--help'], { timeout: Math.max(1000, Math.min(o.timeoutMs || 12000, 30000)) })
      if (!r || r.error) { lastErr = 'spawn failed: ' + String((r && r.error && r.error.message) || 'unavailable'); continue }
      const text = String(r.stdout || '') + String(r.stderr || '')
      const ids = parseHelpModels(text)
      if (ids.length) return { ok: true, ids, mode: 'cli-help', exe }
      lastErr = 'no roster in --help output'
    }
    return { ok: false, ids: [], mode: 'cli-help', error: lastErr || 'codebuddy CLI not found (set CODEBUDDY_BIN)' }
  }

  /**
   * 异步探测「该账号当前支持」的清单：用无效模型触发 CLI 的 400 报文。
   * 对齐 workbuddy-auth 的权威白名单语义（服务器告诉我们这个账号能用什么）。
   * @returns {Promise<{ok:boolean, ids:string[], mode:string, error?:string}>}
   */
  export function probeAccountModels(env, opts) {
    const o = opts || {}
    const cands = cbCatalogCliCandidates(env)
    const proc = globalThis.process
    const child = (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('node:child_process') : null
    if (!child || typeof child.spawn !== 'function') {
      return Promise.resolve({ ok: false, ids: [], mode: 'account-live', error: 'no spawn capability in this host form' })
    }
    const extraEnv = o.envExtra || {}
    return new Promise((resolve) => {
      let idx = 0
      // 记录每个候选的真实结局：区分「压根没找到 CLI」与「CLI 跑了但没吐账号名录」
      // （后者通常是该面未登录 / 端点拒了）—— 报错文案必须能指导下一步，不能一律
      // 说 "CLI not found"（本轮就踩到：codebuddy-en 无 token 时被误报成找不到 CLI）。
      const reasons = []
      const attempt = () => {
        if (idx >= cands.length) {
          resolve({
            ok: false, ids: [], mode: 'account-live',
            error: reasons.length ? reasons.join('; ') : 'no CLI candidate to probe',
            notFound: reasons.every((r) => /not found|ENOENT|spawn/i.test(r))
          })
          return
        }
        const exe = cands[idx++]
        let c
        try {
          // .cmd/.bat 需经 shell（Windows 安全限制）；.mjs/.js 经 node 包装。
          // 与 cliSpawnSync 同一规则：shell 形态把命令拼成单字符串（避免 DEP0190）。
          const spec = splitExeSpec(exe)
          const isCmd = /\.(cmd|bat)$/i.test(spec.cmd)
          const probeArgs = spec.prefixArgs.concat(['-p', 'hi', '--model', '__clb_probe_invalid__', '--output-format', 'text'])
          const opts = {
            stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
            env: Object.assign({}, proc.env, extraEnv)
          }
          c = isCmd
            ? child.spawn(cliCommandLine(spec.cmd, probeArgs), Object.assign({ shell: true }, opts))
            : child.spawn(spec.cmd, probeArgs, opts)
        } catch (e) { reasons.push(exe + ': spawn threw ' + String(e && e.message || e)); attempt(); return }
        let out = ''
        const timer = setTimeout(() => { try { c.kill() } catch (e) { } }, Math.max(5000, Math.min(o.timeoutMs || 30000, 90000)))
        const onData = (d) => { out += d; if (out.length > 400000) out = out.slice(-200000) }
        c.stdout.on('data', onData)
        c.stderr.on('data', onData)
        c.on('error', (e) => {
          clearTimeout(timer)
          reasons.push(exe + ': ' + String((e && e.code) || (e && e.message) || 'spawn error'))
          attempt()
        })
        c.on('close', (code) => {
          clearTimeout(timer)
          const ids = parseAccountModels(out)
          if (ids && ids.length) { resolve({ ok: true, ids, mode: 'account-live', exe }); return }
          const head = String(out).replace(/\s+/g, ' ').trim().slice(0, 160)
          reasons.push(exe + ': exit ' + code + ', no account roster' + (head ? ' — ' + head : ''))
          attempt()
        })
      }
      attempt()
    })
  }

  /** 缓存读写（面板每次渲染都会取，避免反复起进程）。 */
  export function cachedCliModels(backend, load, nowMs) {
    const at = Number(nowMs) || Date.now()
    const hit = CLI_MODEL_CACHE.get(backend)
    if (hit && at - hit.at < CLI_MODEL_TTL_MS) return hit
    const v = typeof load === 'function' ? load() : load
    if (v && v.ok && v.ids && v.ids.length) CLI_MODEL_CACHE.set(backend, { at, mode: v.mode, ids: v.ids.slice() })
    return v
  }

  /** 读统一设置文件里 codebuddy 分区的 preferredBackend（meta 需要它才知道列哪个面）。 */
  export function currentPreferredBackend() {
    try {
      const e = cbCatalogEnv || {}
      const p = cbCatalogRead(e.CLI_BRIDGE_SETTINGS_FILE || cbCatalogPathJoin(
        e.DSH_HOME || (e.APPDATA ? cbCatalogPathJoin(e.APPDATA, 'DSH Desktop', 'dsh-home') : ''), 'cli-bridge-settings.json'))
      if (!p) return null
      const all = JSON.parse(p)
      const v = all && all.codebuddy && all.codebuddy.preferredBackend
      return typeof v === 'string' && v ? v : null
    } catch (err) { return null }
  }

  // CLI 报错里解析「该账号当前支持的模型」（旧 core parseAccountModels verbatim）。
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

// ── 三工具 schema（旧 preset/codebuddy-first verbatim；契约 §8 红线）────────────
// 纯数据，无依赖 —— 放这里是为了让主描述符留在 600 行红线内（规则 §26）。
export const RUN_PARAMS = {
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
export const CONTINUE_PARAMS = {
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
export const STATUS_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }
