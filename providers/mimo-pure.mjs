// providers/mimo-pure.mjs — mimo 的纯逻辑片文件（无宿主依赖）：事件解析 / 结果构造 +
// 「怎么问本机 mimo 要模型清单」链路。
//
// 从 providers/mimo.mjs 拆出，让两个文件都留在 600 行红线内（规则 §26）。
// build 会把 providers/mimo-*.mjs 全部内联进 dynamic 沙箱同一作用域，故主文件
// 仍可直接调用这些函数；ESM 形态走本文件的 import。
// 沙箱纪律：禁用 import.meta 字面量；fs/path/child_process 一律经
// globalThis.process.getBuiltinModule + typeof 守卫读取（沙箱可能没有 node 能力）。
// 注意：注释里绝不写出口令标记字面量（build 全局替换会把注释劈开）。

import { shortLabel, summarizeArgs, clampInt } from '../core/bridge-kit.mjs'

// Node 内建探测（沙箱纪律：getBuiltinModule + typeof 守卫）。
// 名字带 mimo 前缀：本文件会与 bridge-kit / core/scheduling.mjs【文本内联进同一个动态
// 沙箱脚本作用域】，撞名即「Identifier already declared」构建错误。
function mimoBuiltin(name) {
  try {
    const proc = globalThis.process
    return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule(name) : null
  } catch (e) { return null }
}

// ── 可执行文件解析（env MIMO_BIN/MIMO_CLI > 已知安装位置 > PATH 名字）───────────
// MiMoCode CLI 官方便携安装目录：<USERPROFILE|HOME>/.mimocode/bin/mimo[.exe]。
// 沙箱内可能没有 fs —— 全部读取走 typeof 守卫，读不到就返回空数组（退回 PATH 查找）。
const MIMO_EXE_DIR = ['.mimocode', 'bin']

/** 探测本机 mimo 可执行文件候选路径（官方便携安装位置）；无 fs 能力时返回空数组。 */
export function mimoCandidateExePaths(env) {
  const e = env || {}
  const out = []
  const fs = mimoBuiltin('node:fs')
  if (!fs || typeof fs.existsSync !== 'function') return out
  const path = mimoBuiltin('node:path')
  const join = (path && typeof path.join === 'function') ? ((a, b) => path.join(a, b)) : ((a, b) => a + '/' + b)
  for (const k of ['USERPROFILE', 'HOME']) {
    if (!e[k]) continue
    const dir = join(join(String(e[k]), MIMO_EXE_DIR[0]), MIMO_EXE_DIR[1])
    for (const base of ['mimo.exe', 'mimo']) {
      const exe = join(dir, base)
      try { if (fs.existsSync(exe) && out.indexOf(exe) < 0) out.push(exe) } catch (err) { /* 探测失败静默跳过 */ }
    }
  }
  return out
}

/**
 * 解析本次调用使用的 exe 前缀（数组或字符串）。
 * 优先级：binPath（显式路径）> env MIMO_BIN/MIMO_CLI > 已知安装位置 > PATH 名字。
 */
export function resolveMimoExePrefix(env, binPath) {
  const e = env || {}
  const bin = binPath || e.MIMO_BIN || e.MIMO_CLI || ''
  if (bin) {
    if (/\.(mjs|cjs|js)$/i.test(bin)) {
      const proc = globalThis.process
      return [(proc && proc.execPath) ? proc.execPath : 'node', bin]
    }
    return [String(bin)]
  }
  const found = mimoCandidateExePaths(e)
  return found.length ? [found[0]] : ['mimo']
}

// ── 模型列表（`mimo models`；设置面板下拉用）───────────────────────────────────
// 实测输出形如每行 `provider/model — window 1M, compacts at 900K`（分隔符是中文破折号
// U+2014）。模型名自身含连字符（xiaomi/mimo-v2.6-pro-ultraspeed），所以只认「行首的
// provider/model」，其后一律当描述文本；表头/说明/空行一律丢弃，绝不抛。
const MIMO_MODEL_ID_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.@#+-]+)(?=$|[\s—–:|,])/

/** 解析 `mimo models` 文本输出为 [{id, provider, name, note}]（去重、保序）。 */
export function parseMimoModels(text) {
  const out = []
  const seen = Object.create(null)
  for (const raw of String(text || '').split(/\r?\n/)) {
    // 去掉列表记号（• * - 1. 等）与行首空白，避免把记号当 provider 名。
    const ln = raw.replace(/^[^A-Za-z0-9]+/, '').trim()
    if (!ln) continue
    const m = ln.match(MIMO_MODEL_ID_RE)
    if (!m) continue
    const id = m[1]
    if (seen[id]) continue
    seen[id] = true
    const slash = id.indexOf('/')
    out.push({ id: id, provider: id.slice(0, slash), name: id.slice(slash + 1), note: ln.slice(id.length).replace(/^[\s—–:|,-]+/, '').trim() })
  }
  return out
}

// 诊断文本压成一行（CLI 的 stderr/stdout 常带换行与表格）。
function mimoOneLine(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  const cap = max || 200
  return s.length > cap ? s.slice(0, cap) + '…' : s
}

/**
 * 真正跑一次 `mimo models`，**带可操作失败原因**（契约 §3.2：失败必须 ok:false）。
 *
 * 为什么不沿用「失败返回空数组」：空数组区分不了「没装 CLI」「没登录 / 免费 API 已终止」
 * 「超时」「输出格式变了」，而面板与用户下一步动作完全不同。
 * @returns {{ok:boolean, models:Array, exe:string, error?:string}}
 */
export function fetchMimoModelsDetailed(env, timeoutMs) {
  const prefix = resolveMimoExePrefix(env)
  const exe = prefix.join(' ')
  const child = mimoBuiltin('node:child_process')
  if (!child || typeof child.spawnSync !== 'function') {
    return { ok: false, models: [], exe: exe, error: '当前宿主没有子进程能力（spawnSync 不可用）—— 请在有 Node 子进程能力的形态（DSH 主进程 / MCP 进程）里点「拉取可用模型」' }
  }
  let r = null
  try {
    r = child.spawnSync(prefix[0], prefix.slice(1).concat(['models']), {
      encoding: 'utf8', timeout: clampInt(timeoutMs, 20000, 2000, 60000),
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (e) {
    return { ok: false, models: [], exe: exe, error: '启动 `' + exe + ' models` 失败：' + mimoOneLine(e && e.message || e) }
  }
  if (!r) return { ok: false, models: [], exe: exe, error: '`' + exe + ' models` 没有任何返回（spawnSync 返回 null），请确认可执行文件路径' }
  if (r.error) {
    const code = String(r.error.code || '')
    if (code === 'ENOENT') {
      return { ok: false, models: [], exe: exe, error: '未找到 mimo 可执行文件（' + exe + '）—— 请安装 MiMoCode CLI（官方便携安装位置 ~/.mimocode/bin/mimo.exe），或设置 MIMO_BIN 指向其绝对路径' }
    }
    if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
      return { ok: false, models: [], exe: exe, error: '`' + exe + ' models` 超时 —— 网络或鉴权可能卡住：请先在终端手动跑一次 `mimo models` 确认，必要时执行 `mimo auth login`' }
    }
    return { ok: false, models: [], exe: exe, error: '`' + exe + ' models` 启动失败（' + (code || 'unknown') + '）：' + mimoOneLine(r.error.message || r.error) }
  }
  const stdout = String(r.stdout || '')
  const stderr = String(r.stderr || '')
  const models = parseMimoModels(stdout)
  if (models.length) return { ok: true, models: models, exe: exe }
  if (r.status !== 0) {
    return { ok: false, models: [], exe: exe, error: '`mimo models` 退出码 ' + r.status + '：' + mimoOneLine(stderr || stdout) + ' —— 若提示未登录 / 免费 API 已终止，请先在终端执行 `mimo auth login`' }
  }
  return { ok: false, models: [], exe: exe, error: '`mimo models` 成功退出但没有解析到任何 provider/model 行' + (stdout ? '（输出开头：' + mimoOneLine(stdout, 160) + '）' : '（输出为空）') + ' —— 请先在终端手动跑一次 `mimo models` 确认输出格式与登录状态' }
}

/** 兼容薄封装：失败返回空数组（旧语义，供不关心原因的调用方）。 */
export function fetchMimoModelsSync(env, timeoutMs) {
  const d = fetchMimoModelsDetailed(env, timeoutMs)
  return d.ok ? d.models : []
}

// ── 手动拉取缓存（契约 §3.2）─────────────────────────────────────────────────
// `meta()` 每次面板渲染都会被调用：**只读本缓存，绝不 spawn**。缓存只存在进程内存里
// （宿主进程重启即失效，不会把过时清单落盘成"配置"）；用户点按钮才刷新它。
const MIMO_MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MIMO_MODEL_CACHE = { at: 0, models: [] }

/** 读缓存（未拉过 / 已过期 → 空数组，面板据此提示「点按钮拉取」）。 */
export function cachedMimoModels(nowMs) {
  const at = Number(nowMs) || Date.now()
  if (!MIMO_MODEL_CACHE.models.length) return []
  if (at - MIMO_MODEL_CACHE.at >= MIMO_MODEL_CACHE_TTL_MS) return []
  return MIMO_MODEL_CACHE.models.slice()
}

/** 手动拉取成功后回填缓存；空清单绝不入缓存（否则下次渲染"有缓存但没内容"）。 */
export function rememberMimoModels(models, nowMs) {
  if (!Array.isArray(models) || !models.length) return false
  MIMO_MODEL_CACHE.models = models.slice()
  MIMO_MODEL_CACHE.at = Number(nowMs) || Date.now()
  return true
}

export function parseMimoJson(stdoutText) {
  const trimmed = String(stdoutText || '').trim()
  if (!trimmed) return null
  const events = []
  const lines = trimmed.split(/\r?\n/)
  for (const raw of lines) {
    const ln = raw.trim()
    if (!ln.startsWith('{')) continue
    try {
      const obj = JSON.parse(ln)
      if (obj && typeof obj === 'object') events.push(obj)
    } catch (e) { /* tolerate log lines */ }
  }
  if (!events.length) {
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj === 'object') events.push(obj)
    } catch (e) {
      return { events: [], text: trimmed, sessionId: null, error: null, steps: [] }
    }
  }
  let sessionId = null
  let text = ''
  let errorMessage = null
  let errorName = null
  let numTurns = 0
  let totalTokens = null
  const steps = []
  const textParts = []
  for (const ev of events) {
    if (ev.sessionID && typeof ev.sessionID === 'string') sessionId = ev.sessionID
    if (ev.sessionId && typeof ev.sessionId === 'string') sessionId = ev.sessionId
    if (ev.session && typeof ev.session === 'object' && ev.session.id) sessionId = ev.session.id
    if (ev.type === 'session' && ev.properties && ev.properties.id) sessionId = ev.properties.id
    const t = ev.type
    const p = ev.properties || ev
    if (t === 'error') {
      const err = ev.error || p
      errorMessage = (err.data && err.data.message) || err.message || err.name || 'error'
      errorName = err.name || 'Error'
    } else if (t === 'text' || t === 'message' || t === 'assistant' || t === 'output') {
      const chunk = p.text || p.content || p.message || p.output || (typeof ev.text === 'string' ? ev.text : '')
      if (typeof chunk === 'string' && chunk) {
        textParts.push(chunk)
        steps.push({ at: Date.now(), kind: 'text', label: shortLabel(chunk) })
      }
    } else if (t === 'step-start' || t === 'step-finish' || t === 'step_update') {
      numTurns += 1
      if (p.tokens && typeof p.tokens === 'object') {
        const tt = p.tokens.total ?? p.tokens.input ?? p.tokens.output
        if (typeof tt === 'number') totalTokens = (totalTokens || 0) + tt
      }
      if (t === 'step_update') {
        const name = p.tool_name || p.tool || p.name
        if (name) steps.push({ at: Date.now(), kind: 'tool', label: shortLabel(name + ' ' + JSON.stringify(summarizeArgs(p.arguments || p.args || p.input) || {})) })
      }
    } else if (t === 'tool' || t === 'tool-call' || t === 'tool_use') {
      const name = p.tool || p.name || p.tool_name || 'tool'
      steps.push({ at: Date.now(), kind: 'tool', label: shortLabel(name + ' ' + JSON.stringify(summarizeArgs(p.arguments || p.args || p.input) || {})) })
    }
  }
  if (textParts.length) text = textParts.join('\n')
  else {
    const last = events[events.length - 1] || {}
    const r = last.result || last
    if (typeof r.response === 'string') text = r.response
    else if (typeof r.text === 'string') text = r.text
  }
  return { events, text, sessionId, error: errorMessage, errorName, numTurns, totalTokens, steps }
}

export function buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
  const MAX_TRAIL = 12
  const exitCode = outcome ? outcome.exitCode : null
  const errText = (parsed && parsed.error) ? String(parsed.error) : ''
  const stderr = (stderrText ? String(stderrText).slice(-2000) : '') + (errText ? (stderrText ? ' ' : '') + errText : '')
  const text = parsed && typeof parsed.text === 'string' ? parsed.text : ''
  const failed = exitCode !== 0 || !!(parsed && parsed.error)
  const be = (parsed && parsed.backend) || (outcome && outcome.backend) || backend || null
  if (parsed) {
    return {
      ok: !failed && (!!text || parsed.accepted === true),
      status: failed ? (parsed.errorName || 'ERROR') : (parsed.accepted && !text ? 'ACCEPTED' : (text ? 'SUCCESS' : 'EMPTY')),
      response: text,
      sessionId: parsed.sessionId || null,
      durationSeconds: null,
      numTurns: parsed.numTurns || null,
      totalTokens: parsed.totalTokens || null,
      exitCode, mode, backend: be,
      stderr,
      errorMessage: parsed.error || '',
      accepted: parsed.accepted === true,
      steps: Array.isArray(parsed.steps) ? parsed.steps.slice(-MAX_TRAIL) : []
    }
  }
  return {
    ok: false, status: 'PARSE_ERROR', response: '', sessionId: null,
    durationSeconds: null, numTurns: null, totalTokens: null,
    exitCode, mode, backend: be, stderr, errorMessage: '',
    rawStdout: String(stdoutText || '').slice(-2000)
  }
}
