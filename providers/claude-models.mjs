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
// 落盘/缓存：面板（settings.meta）是同步回调，必须 spawnSync；探测一次约 3-5s，
// 故结果进 5 分钟缓存（与 codebuddy catalog 同策略），避免每次渲染都打网络。

import { claudeExeCandidates, claudeProbeCandidates, splitExeSpec, quoteShellArg } from './claude-exe.mjs'

// 故意无效的探测模型名（服务端必然拒绝；保持带前缀，便于日志辨认来源）。
export const PROBE_MODEL = '__clb_probe_invalid__'
export const MODELS_TTL_MS = 5 * 60 * 1000

// 探测结果缓存：key（后端/端点标识） → { at, ids }
const modelsCache = new Map()

/** 清空探测缓存（测试与「模型变更后刷新」用）。 */
export function resetModelsCache() { modelsCache.clear(); syncModelsCache.clear() }

// 缓存键 = 候选可执行文件集合（同一台机器可能切换 CLAUDE_BIN / 面板路径，键必须跟着变，
// 否则会把「上一个 exe 的探测结果」错配给新 exe）。
function candidateKey(env, binPath) {
  const list = claudeProbeCandidates(env, binPath)
  return list.length ? list.join('|') : 'claude'
}

/**
 * 缓存包装：TTL 内直接返回上次成功结果；失败不写缓存（下次仍然重试，绝不把失败固化）。
 * @param {string} key
 * @param {() => Promise<object>|object} load
 * @param {number} [nowMs]
 */
export function cachedModels(key, load, nowMs) {
  const at = Number(nowMs) || Date.now()
  const hit = modelsCache.get(key)
  if (hit && at - hit.at < MODELS_TTL_MS) return hit.value
  return Promise.resolve().then(load).then((v) => {
    if (v && v.ok && Array.isArray(v.ids) && v.ids.length) modelsCache.set(key, { at, value: v })
    return v
  })
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
export function probeArgv() {
  return ['-p', 'hi', '--model', PROBE_MODEL, '--output-format', 'json', '--no-session-persistence']
}

/** 探测失败时的可操作文案（区分「没找到 CLI」与「CLI 跑了但服务端没报清单」）。 */
function probeFailureText(reasons, tried) {
  const head = '无法获取服务端权威模型清单（已尝试探测 ' + tried + ' 个候选可执行文件）'
  const body = reasons.join('; ')
  return head + (body ? ': ' + body : '') +
    '。请确认 claude CLI 已安装且端点/凭据可用（claude 在 ~/.claude/settings.json 的 env 里读 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN），或在设置面板填写正确的可执行文件路径后重试。'
}

/**
 * 同步探测（供 settings.meta 面板下拉；无 spawnSync 能力 → 明确 ok:false）。
 * @param {object} env
 * @param {{binPath?: string, timeoutMs?: number}} [opts]
 * @returns {{ok: boolean, ids: string[], mode: string, exe?: string, error?: string}}
 */
export function probeSupportedModelsSync(env, opts) {
  const o = opts || {}
  const child = (function () { try { const p = globalThis.process; return (p && typeof p.getBuiltinModule === 'function') ? p.getBuiltinModule('node:child_process') : null } catch (x) { return null } })()
  if (!child || typeof child.spawnSync !== 'function') {
    return { ok: false, ids: [], mode: 'account-live', error: 'no spawnSync capability in this host form' }
  }
  const cands = claudeProbeCandidates(env, o.binPath)
  const probeList = cands.length ? cands : ['claude']
  const timeout = Math.max(3000, Math.min(Number(o.timeoutMs) || 12000, 30000))
  const reasons = []
  const proc = globalThis.process
  for (const exe of probeList) {
    const spec = splitExeSpec(exe)
    const argv = spec.prefixArgs.concat(probeArgv())
    const cmd = spec.shell ? [spec.cmd].concat(argv).map(quoteShellArg).join(' ') : spec.cmd
    const r = child.spawnSync(cmd, spec.shell ? [] : argv, {
      encoding: 'utf8', timeout, windowsHide: true, shell: !!spec.shell,
      env: Object.assign({}, (proc && proc.env) || {}, {})
    })
    if (!r || r.error) { reasons.push(exe + ': ' + String((r && r.error && (r.error.code || r.error.message)) || 'spawn failed')); continue }
    const got = extractProbeIds(r.stdout, r.stderr)
    if (got.ids && got.ids.length) return { ok: true, ids: got.ids, mode: 'account-live', exe }
    const head = String(got.errorText || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    reasons.push(exe + ': exit ' + r.status + '，未解析出可用模型清单' + (head ? ' — ' + head : ''))
  }
  return { ok: false, ids: [], mode: 'account-live', error: probeFailureText(reasons, probeList.length) }
}

// 同步探测缓存（面板每次渲染都会取，避免反复 spawnSync 打网络）。
const syncModelsCache = new Map()
// 失败结果的反向缓存 TTL：成功缓存 5 分钟；失败只缓存 60 秒。
// 为什么必须有反向缓存：面板是同步回调，CLI 缺失/未登录时一次 spawnSync 可能阻塞数秒，
// 每次渲染都重探会让设置面板卡顿。60 秒足够让用户装好 CLI/登录后立刻看到新结果，
// 又不会把「当时读不到」长期固化成假象（状态照旧 ok:false + 可操作错误，语义不变）。
const NEGATIVE_TTL_MS = 60 * 1000

/**
 * 带缓存的同步探测（settings.meta 专用；面板是同步回调，只能 spawnSync）。
 * 成功/失败都进缓存（TTL 不同），失败语义保持不变：ok:false + 可操作错误。
 * @returns {{ok: boolean, ids: string[], mode: string, exe?: string, error?: string}}
 */
export function probeSupportedModelsSyncCached(env, opts) {
  const o = opts || {}
  const key = 'sync:claude:' + candidateKey(env, o.binPath)
  const at = Date.now()
  const hit = syncModelsCache.get(key)
  if (hit) {
    const ttl = hit.value && hit.value.ok ? MODELS_TTL_MS : NEGATIVE_TTL_MS
    if (at - hit.at < ttl) return hit.value
  }
  const v = probeSupportedModelsSync(env, o)
  syncModelsCache.set(key, { at, value: v })
  return v
}

/**
 * 异步探测（MCP / preset / dynamic 三形态共用）：起一次真实 CLI 调用，解析 400 报文。
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
      const argv = spec.prefixArgs.concat(probeArgv())
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
      c.stdout.on('data', (d) => { out += d; if (out.length > 400000) out = out.slice(-200000) })
      c.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000) })
      c.on('error', (e) => {
        clearTimeout(timer)
        reasons.push(exe + ': ' + String((e && e.code) || (e && e.message) || 'spawn error'))
        attempt()
      })
      c.on('close', (code) => {
        clearTimeout(timer)
        const got = extractProbeIds(out, err)
        if (got.ids && got.ids.length) { resolve({ ok: true, ids: got.ids, mode: 'account-live', exe }); return }
        const head = String(got.errorText || '').replace(/\s+/g, ' ').trim().slice(0, 160)
        reasons.push(exe + ': exit ' + code + '，未解析出可用模型清单' + (head ? ' — ' + head : ''))
        attempt()
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
export async function listAccountModels(env, opts) {
  const o = opts || {}
  const key = 'claude:' + candidateKey(env, o.binPath)
  if (o.refresh) modelsCache.delete(key)
  const probe = await cachedModels(key, () => probeSupportedModels(env, o))
  const cfg = readConfiguredModels(env)
  const configured = cfg.models || []
  if (!probe.ok) {
    return {
      ok: false,
      source: 'account-live',
      models: [],
      count: 0,
      error: String(probe.error || 'probe failed'),
      diagnostic: {
        configured: configured,
        settingsPath: cfg.path,
        note: 'ANTHROPIC_*_MODEL 只是用户配置的别名映射，不是服务端可用全集；因此不作为 models 返回。'
      }
    }
  }
  const ids = probe.ids.slice()
  const byId = new Map(configured.map((m) => [m.id, m]))
  const byIdLoose = new Map(configured.map((m) => [String(m.id).toLowerCase().replace(/\[.*\]$/, ''), m]))
  return {
    ok: true,
    source: 'account-live',
    models: ids.map((id) => {
      const hit = byId.get(id) || byIdLoose.get(String(id).toLowerCase())
      return { id, source: 'account-live', configuredAs: hit ? hit.key : null }
    }),
    count: ids.length,
    ext: { exe: probe.exe || null, mode: probe.mode },
    diagnostic: { settingsPath: cfg.path, configured: configured }
  }
}
