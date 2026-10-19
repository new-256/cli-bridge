// providers/codebuddy-models-source.mjs — codebuddy 的「模型清单探测 + 缓存」（第二片）.
//
// 从 codebuddy-catalog.mjs 抽出：探测要走子进程（同步/异步两条路），与纯解析逻辑内聚度低，
// 分开后两个文件都在 600 行红线内（规则 §26）。scripts/build.mjs 会把 providers/codebuddy-*.mjs
// 全部按字典序内联进 dynamic 沙箱同一作用域，所以这里仍可引用 catalog 的函数；ESM 形态走 import。
// 注意：注释里绝不写出口令标记字面量（build 全局替换会把注释劈开导致生成物语法崩）。

import { cbCatalogEnv, cbCatalogRead, cbCatalogPathJoin, parseAccountModels } from './codebuddy-catalog.mjs'

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
   * 同步版的账号探测（供设置面板用 —— 面板必须同步返回）。
   * 走 spawnSync + 超时；结果进 5 分钟缓存，避免每次渲染都打一次网络。
   *
   * ⚠️ 为什么面板不能用 `--help` 名册顶替：实测本机 CLI 2.167.0 的 help 文本**本身
   * 就是过时的** —— 它列 18 项且含已不存在的 `minimax-m3` / `kimi-k3-1`，缺真实的
   * `glm-5.3-flashx` / `minimax-m3-pay` / `kimi-k3-2`；而账号探测给出 19 项且全部有效。
   * 也就是说「CLI 声明」≠「服务端实际可用」，拿它当兜底会直接把错误清单展示给用户。
   * 故这里宁可空列表 + 明确提示，也不展示已知错误的 roster。
   * @returns {{ok:boolean, ids:string[], mode:string, error?:string}}
   */
  export function probeAccountModelsSync(env, opts) {
    const o = opts || {}
    const cands = cbCatalogCliCandidates(env)
    const extraEnv = o.envExtra || {}
    const reasons = []
    const timeout = Math.max(3000, Math.min(o.timeoutMs || 12000, 30000))
    for (const exe of cands) {
      const r = cliSpawnSync(exe, ['-p', 'hi', '--model', '__clb_probe_invalid__', '--output-format', 'text'], {
        timeout,
        env: Object.assign({}, (globalThis.process && globalThis.process.env) || {}, env || {}, extraEnv)
      })
      if (!r || r.error) { reasons.push(exe + ': ' + String((r && r.error && (r.error.code || r.error.message)) || 'spawn failed')); continue }
      const out = String(r.stdout || '') + String(r.stderr || '')
      const ids = parseAccountModels(out)
      if (ids && ids.length) return { ok: true, ids, mode: 'account-live', exe }
      const head = String(out).replace(/\s+/g, ' ').trim().slice(0, 140)
      reasons.push(exe + ': exit ' + r.status + ', no account roster' + (head ? ' — ' + head : ''))
    }
    return { ok: false, ids: [], mode: 'account-live', error: reasons.join('; ') || 'no CLI candidate to probe' }
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
            env: Object.assign({}, proc.env, env || {}, extraEnv)
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
    // 不传 load = 纯只读缓存（未命中返回 undefined）。设置面板靠这条避免每次渲染都 spawn。
    if (typeof load !== 'function') return undefined
    const v = load()
    if (v && v.ok && v.ids && v.ids.length) CLI_MODEL_CACHE.set(backend, { at, mode: v.mode, ids: v.ids.slice() })
    return v
  }

  /**
   * 手动拉取成功后回填缓存（契约 §3.2 的 refreshModels 用），让随后的 meta() 能直接命中。
   * 只接受非空 ids —— 空结果绝不入缓存，否则下次渲染会显示"有缓存但没内容"。
   */
  export function rememberCliModels(backend, ids, mode, nowMs) {
    if (!Array.isArray(ids) || !ids.length) return false
    CLI_MODEL_CACHE.set(backend, { at: Number(nowMs) || Date.now(), mode: mode || 'account-live', ids: ids.slice() })
    return true
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