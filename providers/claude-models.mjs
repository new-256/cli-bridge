// providers/claude-models.mjs — claude 模型清单探测（账号实时权威源，纯逻辑 + 最小 spawn）。
//
// 从 providers/claude.mjs 拆出（规则 §26：单文件 600 行红线）。build 会把
// providers/claude-*.mjs 按字典序内联进 dynamic 沙箱同一作用域；ESM 形态走 import。
// ⚠️ 注释里绝不写出口令标记字面量。
//
// 为什么必须「探测」而不是读配置（本机 Claude Code 2.0.76 + 第三方 Anthropic 兼容端点实测）：
//   传一个故意无效的模型名 → 服务端返回 400，CLI 把报文塞进 result 事件：
//     {"type":"result","subtype":"success","is_error":true,
//      "result":"API Error: 400 {\"error\":{\"message\":\"The supported API model names are
//                deepseek-flash, deepseek-v4-pro, but you passed __clb_probe_invalid__.\"}}"}
//   → 这条 "The supported API model names are X, Y" 就是该端点/该 key 的权威可用清单。
//   ~/.claude/settings.json 的 env.ANTHROPIC_DEFAULT_*_MODEL 只是「别名映射」，
//   不是服务端可用全集 —— 红线：绝不把它冒充成可用清单，也绝不静默返回空数组。
//
// 缓存与「谁探测」（契约 §3.2 手动拉取）：
//   • settings.meta() 是同步回调，且**不再自动探测** —— 它只调 readCachedModels() 读这里的
//     缓存（纯读、不 spawn、不联网）；没命中就留空，由 note 提示用户点「拉取可用模型」。
//   • 探测只有一条路：settings.refreshModels() → 异步 probeSupportedModels()（用户显式触发）。
//     成功后经 cachedModels() 写回同一个缓存，下次 meta() 直接命中 —— 面板首屏不再被拖慢。
//   • 5 分钟 TTL 只约束**工具调用**（claude_models 的重复调用）；面板展示的是「上次拉取到的
//     权威清单」，过期也照旧展示，但 note 会标注拉取时间（宁可显式标旧，也不让下拉莫名清空）。

import { claudeExeCandidates, claudeProbeCandidates, splitExeSpec, quoteShellArg } from './claude-exe.mjs'

// 故意无效的探测模型名（服务端必然拒绝；保持带前缀，便于日志辨认来源）。
export const PROBE_MODEL = '__clb_probe_invalid__'
export const MODELS_TTL_MS = 5 * 60 * 1000

// 探测结果缓存：key（后端/端点标识） → { at, value }
const modelsCache = new Map()

/** 清空探测缓存（测试与「模型变更后刷新」用）。 */
export function resetModelsCache() { modelsCache.clear() }

// 缓存键 = 候选可执行文件集合（同一台机器可能切换 CLAUDE_BIN / 面板路径，键必须跟着变，
// 否则会把「上一个 exe 的探测结果」错配给新 exe）。
function candidateKey(env, binPath) {
  const list = claudeProbeCandidates(env, binPath)
  return list.length ? list.join('|') : 'claude'
}

/** 缓存的键（面板读缓存与工具探测必须用同一把键，否则写进去读不出来）。 */
export function modelsCacheKey(env, binPath) {
  return 'claude:' + candidateKey(env, binPath)
}

/** 缓存里只可能存「成功的权威清单」；失败绝不入缓存（否则会把坏状态固化）。 */
function isUsableProbe(v) {
  return !!(v && v.ok === true && Array.isArray(v.ids) && v.ids.length)
}

/**
 * 缓存包装（异步工具路径）：TTL 内直接返回上次成功结果；失败不写缓存。
 * @param {string} key
 * @param {() => Promise<object>|object} load
 * @param {number} [nowMs]
 */
export function cachedModels(key, load, nowMs) {
  const at = Number(nowMs) || Date.now()
  const hit = modelsCache.get(key)
  if (hit && at - hit.at < MODELS_TTL_MS) return hit.value
  return Promise.resolve().then(load).then((v) => {
    if (isUsableProbe(v)) modelsCache.set(key, { at, value: v })
    return v
  })
}

/**
 * 只读缓存（settings.meta 专用）：纯读、不 spawn、不联网。
 * 与 cachedModels 的区别：这里**不受 TTL 限制** —— 面板展示的是「上次真正拉取到的那份
 * 服务端清单」，附 ageMs 让 note 如实标注新旧；空/过期与否都不该凭空清空用户看到的下拉。
 *
 * 为什么要「精确键未命中 → 取最近一次成功结果」：keystone 渲染面板时只把 env 传给
 * meta()，**拿不到面板里保存的 binPath**（settingsView 里 createProvider 只带 env），
 * 而缓存键含候选 exe 集合 → 用户一旦填过 binPath，精确键必然错开，下拉会在拉取成功后
 * 仍然空着（看起来像按钮没起作用）。这不算降级：清单是 claude 自己 settings.json 里
 * 端点+凭据裁决的，与走哪个候选 exe 无关（exe 只决定探测能否跑起来），且 note 会带上
 * 「N 分钟前拉取 / 源 account-live」，用户看到的是真实的探测结果与真实的年龄。
 * @param {object} env
 * @param {{binPath?: string, nowMs?: number}} [opts]
 * @returns {{ids: string[], mode: string, exe: (string|null), at: number, ageMs: number}|null}
 */
export function readCachedModels(env, opts) {
  const o = opts || {}
  const at = Number(o.nowMs) || Date.now()
  const exact = modelsCache.get(modelsCacheKey(env, o.binPath))
  let hit = isUsableProbe(exact && exact.value) ? exact : null
  if (!hit) {
    for (const entry of modelsCache.values()) {
      if (!isUsableProbe(entry.value)) continue
      if (!hit || entry.at > hit.at) hit = entry
    }
  }
  if (!hit) return null
  return {
    ids: hit.value.ids.slice(),
    mode: hit.value.mode || 'account-live',
    exe: hit.value.exe || null,
    at: hit.at,
    ageMs: Math.max(0, at - hit.at)
  }
}

/**
 * 从 400 报文里解析「服务端支持的模型名」。
 * 主格式（实测）：`The supported API model names are A, B, but you passed Z.`
 * 兼容：句尾直接是句号（无 "but you passed"）、JSON 转义形态、大小写差异。
 * @param {string} text
 * @returns {string[]|null} 无该锚点返回 null（调用方必须据此报错，不得伪造清单）
 */
export function parseSupportedModels(text) {
  const s = String(text || '')
  if (!s) return null
  const anchorRe = /the supported API model names are\s+/i
  const m = anchorRe.exec(s)
  if (!m) return null
  const tail = s.slice(m.index + m[0].length)
  // ① 有 "but you passed" → 这是清单的确定右边界（模型名里可以有 '.'，不能按句点切）。
  let body = ''
  const end = /,?\s*but you passed/i.exec(tail)
  if (end) body = tail.slice(0, end.index)
  else {
    // ② 无右边界锚点：截到引号/换行/行尾，再 chomp 单个句点。
    const stop = tail.search(/["\r\n]/)
    body = (stop >= 0 ? tail.slice(0, stop) : tail).replace(/[.\s]+$/, '')
  }
  const ids = []
  for (const raw of body.split(/\s*,\s*|\s+and\s+/i)) {
    const id = String(raw || '').trim().replace(/^["'`[]+|["'`\]]+$/g, '')
    if (!id) continue
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/.test(id)) continue
    if (id === PROBE_MODEL) continue
    if (ids.indexOf(id) < 0) ids.push(id)
  }
  return ids.length ? ids : null
}

/**
 * 从探测进程的完整输出里挖出模型清单。
 * CLI 的 stdout 是 result 事件 JSON（is_error:true）；它的 result 字段里才是 400 报文，
 * 且报文自身是 JSON 字符串（转义）。顺序：raw 文本 → 每行 JSON 的 result 字段。
 * @param {string} stdoutText
 * @param {string} [stderrText]
 * @returns {{ids: string[]|null, errorText: string, sawResult: boolean}}
 */
export function extractProbeIds(stdoutText, stderrText) {
  const out = String(stdoutText || '')
  const err = String(stderrText || '')
  const lines = out.split(/\r?\n/).filter(Boolean)
  let errorText = ''
  let sawResult = false
  for (const ln of lines) {
    const t = ln.trim()
    if (!t.startsWith('{')) continue
    let obj
    try { obj = JSON.parse(t) } catch (e) { continue }
    if (!obj || obj.type !== 'result') continue
    sawResult = true
    if (typeof obj.result === 'string' && obj.result) errorText = obj.result
    else if (obj.is_error && typeof obj.error === 'string') errorText = obj.error
  }
  if (!errorText) errorText = err || out
  const ids = parseSupportedModels(errorText) || parseSupportedModels(out) || parseSupportedModels(err)
  return { ids: ids || null, errorText: errorText.slice(0, 800), sawResult }
}

/** ~/.claude/settings.json 路径（CLAUDE_CONFIG_DIR 可覆盖配置根，本机实测存在）。 */
export function claudeConfigDir(env) {
  const e = env || {}
  if (e.CLAUDE_CONFIG_DIR) return String(e.CLAUDE_CONFIG_DIR)
  const home = e.USERPROFILE || e.HOME || ''
  if (!home) return ''
  const path = (function () { try { const p = globalThis.process; return (p && typeof p.getBuiltinModule === 'function') ? p.getBuiltinModule('node:path') : null } catch (x) { return null } })()
  if (!path || typeof path.join !== 'function') return ''
  return path.join(home, '.claude')
}

/**
 * 读 ~/.claude/settings.json 的 env 块里「用户配置的模型名」。
 * ⚠️ 这是别名映射（ANTHROPIC_DEFAULT_OPUS_MODEL 之类），**不是**服务端可用全集：
 * 只作为诊断/解释线索返回，绝不塞进 ok:true 的模型清单。
 * @returns {{ok: boolean, path: string, models: Array<{id: string, key: string}>, error: string}}
 */
export function readConfiguredModels(env) {
  const dir = claudeConfigDir(env)
  if (!dir) return { ok: false, path: '', models: [], error: 'cannot resolve home directory (no USERPROFILE/HOME/CLAUDE_CONFIG_DIR)' }
  const fs = (function () { try { const p = globalThis.process; return (p && typeof p.getBuiltinModule === 'function') ? p.getBuiltinModule('node:fs') : null } catch (x) { return null } })()
  const path = (function () { try { const p = globalThis.process; return (p && typeof p.getBuiltinModule === 'function') ? p.getBuiltinModule('node:path') : null } catch (x) { return null } })()
  if (!fs || !path) return { ok: false, path: '', models: [], error: 'no fs capability in this host form' }
  const file = path.join(dir, 'settings.json')
  let raw
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    return { ok: false, path: file, models: [], error: 'cannot read ' + file + ': ' + String(e && e.message || e) }
  }
  const envBlock = raw && raw.env && typeof raw.env === 'object' ? raw.env : {}
  const models = []
  const seen = Object.create(null)
  for (const key of Object.keys(envBlock)) {
    if (!/^(ANTHROPIC_(MODEL|DEFAULT_[A-Z]+_MODEL|DEFAULT_[A-Z]+_MODEL_NAME|SMALL_FAST_MODEL))$/i.test(key)) continue
    const v = envBlock[key]
    if (typeof v !== 'string' || !v.trim()) continue
    const id = v.trim()
    if (seen[id]) continue
    seen[id] = true
    models.push({ id, key })
  }
  return { ok: true, path: file, models, error: '' }
}

/** 探测 argv（不含 exe 前缀）：固定参数集，绝不拼装用户 prompt。 */
/**
 * 探测用的 argv。`baseUrl` 非空时用 `--settings` 覆盖 ANTHROPIC_BASE_URL ——
 * 这是 cc-switch proxy 模式唯一可行的访问方式（直连第三方网关缺 session 头必 400）。
 * 只覆盖 base_url，不碰用户的 ~/.claude/settings.json。
 */
export function probeArgv(baseUrl) {
  const argv = ['-p', 'hi', '--model', PROBE_MODEL, '--output-format', 'json', '--no-session-persistence']
  if (baseUrl) argv.push('--settings', JSON.stringify({ env: { ANTHROPIC_BASE_URL: String(baseUrl) } }))
  return argv
}

/** 探测失败时的可操作文案（区分「没找到 CLI」与「CLI 跑了但服务端没报清单」）。 */
function probeFailureText(reasons, tried) {
  const head = '无法获取服务端权威模型清单（已尝试探测 ' + tried + ' 个候选可执行文件）'
  const body = reasons.join('; ')
  return head + (body ? ': ' + body : '') +
    '。请确认 claude CLI 已安装且端点/凭据可用（claude 在 ~/.claude/settings.json 的 env 里读 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN），或在设置面板填写正确的可执行文件路径后重试。'
}

/**
 * 异步探测（唯一探测实现：MCP / preset / dynamic 三形态 + 面板「拉取可用模型」共用）：
 * 起一次真实 CLI 调用，解析 400 报文。
 * 铁律：只认探测结果；失败 = ok:false + 可操作错误，绝不回落到配置文件/静态表。
 * @param {object} env
 * @param {{binPath?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, ids: string[], mode: string, exe?: string, error?: string}>}
 */
export function probeSupportedModels(env, opts) {
  const o = opts || {}
  const child = (function () { try { const p = globalThis.process; return (p && typeof p.getBuiltinModule === 'function') ? p.getBuiltinModule('node:child_process') : null } catch (x) { return null } })()
  if (!child || typeof child.spawn !== 'function') {
    return Promise.resolve({ ok: false, ids: [], mode: 'account-live', error: 'no spawn capability in this host form' })
  }
  const cands = claudeProbeCandidates(env, o.binPath)
  const probeList = cands.length ? cands : ['claude']
  const proc = globalThis.process
  const env2 = Object.assign({}, (proc && proc.env) || {})
  return new Promise((resolve) => {
    let idx = 0
    const reasons = []
    const attempt = () => {
      if (idx >= probeList.length) {
        resolve({ ok: false, ids: [], mode: 'account-live', error: probeFailureText(reasons, probeList.length) })
        return
      }
      const exe = probeList[idx++]
      const spec = splitExeSpec(exe)
      const argv = spec.prefixArgs.concat(probeArgv(o.baseUrl))
      let c
      try {
        const spawnCmd = spec.shell ? [spec.cmd].concat(argv).map(quoteShellArg).join(' ') : spec.cmd
        c = child.spawn(spawnCmd, spec.shell ? [] : argv, {
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: !!spec.shell, env: env2
        })
      } catch (e) { reasons.push(exe + ': spawn threw ' + String(e && e.message || e)); attempt(); return }
      let out = ''
      let err = ''
      const timer = setTimeout(() => { try { c.kill() } catch (e) { } }, Math.max(5000, Math.min(Number(o.timeoutMs) || 30000, 90000)))
      // 一个候选只允许结算一次：spawn 失败时 'error' 与 'close' 会先后都触发，
      // 两个回调各调一次 attempt() 会把后面的候选整个跳过（idx 多走一格）——
      // 实测后果是「binPath 填错 → 明明 CLAUDE_BIN 里那个能跑，探测却直接失败」。
      let settled = false
      const nextCandidate = (reason) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (reason) reasons.push(reason)
        attempt()
      }
      c.stdout.on('data', (d) => { out += d; if (out.length > 400000) out = out.slice(-200000) })
      c.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000) })
      c.on('error', (e) => {
        nextCandidate(exe + ': ' + String((e && e.code) || (e && e.message) || 'spawn error'))
      })
      c.on('close', (code) => {
        if (settled) return
        const got = extractProbeIds(out, err)
        if (got.ids && got.ids.length) {
          settled = true
          clearTimeout(timer)
          resolve({ ok: true, ids: got.ids, mode: 'account-live', exe })
          return
        }
        const head = String(got.errorText || '').replace(/\s+/g, ' ').trim().slice(0, 160)
        nextCandidate(exe + ': exit ' + code + '，未解析出可用模型清单' + (head ? ' — ' + head : ''))
      })
    }
    attempt()
  })
}

/**
 * 组装 claude_models 的返回值（三形态共用；工具逻辑与 MCP 面共用这一份，杜绝两处漂移）。
 * 成功 = 服务端清单（source: account-live）；失败 = ok:false + configured 诊断线索
 * （配置里那串名字只作「你可能想用哪个」的提示，明确标注非权威）。
 * @param {object} env
 * @param {{binPath?: string, timeoutMs?: number, refresh?: boolean}} [opts]
 */
/**
 * 列出可用模型 —— **合并两个来源**，而不是只认服务端报文。
 *
 * 为什么必须合并（真实事故）：服务端「无效模型触发 400」只回吐**基础模型名**。
 * 实测 DeepSeek 的 Anthropic 兼容端点报 `deepseek-flash, deepseek-v4-pro`，
 * 但用户实际配置在用的 `deepseek-v4-pro[1M]` / `deepseek-v4-flash` 逐个实测都是 200 ——
 * 它们只是带上下文窗口后缀/命名变体，服务端报文不列。若只信报文，用户会看到一份
 * 「比我配的还少」的清单，等于给错答案。
 *
 * 因此：configured（`~/.claude/settings.json` 的 env，cc-switch 等工具写入的**最终生效**
 * 配置）+ account-live（服务端报文）取并集，逐项标注来源；configured 排在前面。
 *
 * 且 configured **不依赖探测成功** —— 端点若根本不支持 400 技巧（如某些代理对任何
 * 模型都先校验 session），我们仍能把用户配置的模型给出来，而不是返回空。
 */
export async function listAccountModels(env, opts) {
  const o = opts || {}
  const key = modelsCacheKey(env, o.binPath)
  if (o.refresh) modelsCache.delete(key)
  const probe = await cachedModels(key, () => probeSupportedModels(env, o))
  const cfg = readConfiguredModels(env)
  const configured = cfg.models || []

  // 大小写不敏感 + 忽略 [1m]/[1M] 这类后缀后做去重键，避免同一模型重复占两行。
  const dk = (id) => String(id).trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
  const seen = new Set()
  const models = []
  for (const m of configured) {
    const k = dk(m.id)
    if (seen.has(k)) continue
    seen.add(k)
    models.push({ id: m.id, source: 'configured', configuredAs: m.key })
  }
  const probeIds = probe && probe.ok ? (probe.ids || []) : []
  for (const id of probeIds) {
    const k = dk(id)
    if (seen.has(k)) continue
    seen.add(k)
    models.push({ id, source: 'account-live', configuredAs: null })
  }

  if (!models.length) {
    return {
      ok: false, source: 'none', models: [], count: 0,
      error: String((probe && probe.error) || 'no configured models and probe returned nothing') +
        (cfg.error ? '；settings.json: ' + cfg.error : ''),
      diagnostic: { configured, settingsPath: cfg.path, probeError: (probe && probe.error) || null }
    }
  }
  // source 汇总：两个来源都有效时标注合并，便于面板/工具如实显示。
  const source = (configured.length && probeIds.length) ? 'configured+account-live'
    : (configured.length ? 'configured' : 'account-live')
  return {
    ok: true,
    source,
    models,
    count: models.length,
    ext: { exe: (probe && probe.exe) || null, mode: (probe && probe.mode) || null },
    diagnostic: {
      settingsPath: cfg.path,
      configured,
      probeError: (probe && !probe.ok) ? String(probe.error || 'probe failed') : null
    }
  }
}
