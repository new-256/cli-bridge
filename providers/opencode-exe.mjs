// providers/opencode-exe.mjs — opencode 可执行探测 / 模型清单解析 / 手动拉取缓存（无宿主依赖）。
//
// 从 providers/opencode.mjs 拆出，让两个文件都留在 600 行红线内（规则 §26）。
// build 会把 providers/opencode-*.mjs 全部内联进 dynamic 沙箱同一作用域。
// ⚠️ 注释里绝不写出口令标记字面量（build 全局替换会把注释劈开）。
//
// 本文件的三块职责（高内聚：全部围绕「怎么问本机 opencode」）：
//   1. 可执行文件候选探测（桌面版已知路径）与 exe 前缀解析；
//   2. `opencode models` 文本 → 结构化模型清单；
//   3. 契约 §3.2 的手动拉取：带原因的同步探测 + 面板展示缓存（meta 只读缓存，绝不 spawn）。

import { clampInt } from '../core/bridge-kit.mjs'

// Node 内建守卫（沙箱可能没有 fs/path；读不到返回 null，调用方退到保守值）。
// 名字带 exe 前缀：本文件与 providers/opencode.mjs 会被内联进【同一个】沙箱脚本作用域。
function exeBuiltin(name) {
  try {
    const proc = globalThis.process
    return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule(name) : null
  } catch (e) { return null }
}

// 二进制名是 opencode-cli.exe（V2 桌面版），不做 opencode.exe 兜底（V1/V2 不能并存）。
export const EXE_BASENAMES = ['opencode-cli', 'opencode']
export const DESKTOP_CLI_REL = ['ai.opencode.desktop', 'cli']
// 桌面版目录形如 ...\ai.opencode.desktop\cli\<ver>-<arch>\opencode-cli.exe。
// 沙箱内可能没有 fs —— 全部读取走 typeof 守卫，读不到就返回空数组（退回 PATH 查找）。

export function candidateExePaths(env) {
  const e = env || {}
  const out = []
  const fs = exeBuiltin('node:fs')
  const path = exeBuiltin('node:path')
  if (!fs || typeof fs.readdirSync !== 'function' || !path || typeof path.join !== 'function') return out
  const roots = []
  for (const k of ['APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES']) if (e[k]) roots.push(String(e[k]))
  const home = e.HOME || e.USERPROFILE
  if (home && !roots.length) roots.push(String(home))
  for (const root of roots) {
    const cliDir = path.join.apply(path, [root].concat(DESKTOP_CLI_REL))
    let versions = []
    try { versions = fs.readdirSync(cliDir, { withFileTypes: true }) } catch (err) { continue }
    // 版本目录按 semver 降序（新版本优先）；解析失败的排末尾。
    const dirs = versions.filter((d) => d && d.isDirectory && d.isDirectory()).map((d) => d.name)
    const key = (n) => {
      const m = String(n).match(/(\d+)\.(\d+)\.(\d+)/)
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1]
    }
    dirs.sort((a, b) => {
      const ka = key(a), kb = key(b)
      for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i]
      return 0
    })
    for (const d of dirs) {
      for (const base of EXE_BASENAMES) {
        const exe = path.join(cliDir, d, base + (String(e.OS || '').toLowerCase().startsWith('win') || e.APPDATA ? '.exe' : ''))
        try { if (fs.existsSync(exe)) out.push(exe) } catch (err) { }
      }
    }
  }
  return out
}

/**
 * 解析本次调用使用的 exe 前缀（数组或字符串）。
 * 优先级：binPath 设置 > env OPENCODE_BIN/OPENCODE_CLI > 桌面版探测 > PATH 名字。
 * @param {object} env
 * @param {string} [binPath] 设置面板里的显式路径（可空）
 */
export function resolveExePrefix(env, binPath) {
  const e = env || {}
  const bin = binPath || e.OPENCODE_BIN || e.OPENCODE_CLI || ''
  if (bin) {
    if (/\.(mjs|cjs|js)$/i.test(bin)) {
      const proc = globalThis.process
      const node = (proc && proc.execPath) ? proc.execPath : 'node'
      return [node, bin]
    }
    return [String(bin)]
  }
  const found = candidateExePaths(e)
  if (found.length) return [found[0]]
  return [EXE_BASENAMES[0]]
}

// ── 模型列表（`opencode models`；纯文本每行 provider/model）─────────────────────
// 解析宽容：只认 provider/model 形态的行，其余（表头/说明/空行）一律丢弃。
const MODEL_LINE_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.#@+-]+)$/

export function parseModelList(text) {
  const out = []
  const seen = Object.create(null)
  for (const raw of String(text || '').split(/\r?\n/)) {
    const ln = raw.trim()
    if (!ln) continue
    const m = ln.match(MODEL_LINE_RE)
    if (!m) continue
    const id = m[1] + '/' + m[2]
    if (seen[id]) continue
    seen[id] = true
    out.push({ id: id, provider: m[1], name: m[2], free: /(-free$|free)/i.test(m[2]) })
  }
  return out
}

/** 免费模型优先展示（用户要求：优先用性能较好的免费模型），其次按字母序。 */
export function sortModelsFreeFirst(list) {
  return (Array.isArray(list) ? list.slice() : []).sort((x, y) => (
    x.free === y.free ? String(x.id).localeCompare(String(y.id)) : (x.free ? -1 : 1)
  ))
}

// 诊断文本压成一行（CLI 的 stderr/stdout 常带换行与表格）。
function exeOneLine(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  const cap = max || 200
  return s.length > cap ? s.slice(0, cap) + '…' : s
}

/**
 * 真正跑一次 `opencode models`，**带可操作失败原因**（契约 §3.2：失败必须 ok:false）。
 *
 * 为什么不复用「失败返回空数组」的旧写法：空数组无法区分「没装 CLI」「没登录」
 * 「超时」「输出格式变了」四种结局，而面板/工具都必须能告诉用户下一步做什么。
 * @returns {{ok:boolean, models:Array, exe:string, error?:string}}
 */
export function fetchModelsDetailed(env, binPath, timeoutMs) {
  const prefix = resolveExePrefix(env, binPath)
  const exe = prefix.join(' ')
  const child = exeBuiltin('node:child_process')
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
    return { ok: false, models: [], exe: exe, error: '启动 `' + exe + ' models` 失败：' + exeOneLine(e && e.message || e) }
  }
  if (!r) return { ok: false, models: [], exe: exe, error: '`' + exe + ' models` 没有任何返回（spawnSync 返回 null），请确认可执行文件路径' }
  if (r.error) {
    const code = String(r.error.code || '')
    if (code === 'ENOENT') {
      return { ok: false, models: [], exe: exe, error: '未找到 opencode 可执行文件（' + exe + '）—— 请安装 OpenCode（桌面版自带 CLI），或在设置里填写「opencode 可执行文件路径」，或设置 OPENCODE_BIN 环境变量' }
    }
    if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
      return { ok: false, models: [], exe: exe, error: '`' + exe + ' models` 超时 —— 网络或鉴权可能卡住：请先在终端手动跑一次 `opencode models` 确认，必要时执行 `opencode auth login`' }
    }
    return { ok: false, models: [], exe: exe, error: '`' + exe + ' models` 启动失败（' + (code || 'unknown') + '）：' + exeOneLine(r.error.message || r.error) }
  }
  const stdout = String(r.stdout || '')
  const stderr = String(r.stderr || '')
  const models = parseModelList(stdout)
  if (models.length) return { ok: true, models: models, exe: exe }
  if (r.status !== 0) {
    return { ok: false, models: [], exe: exe, error: '`opencode models` 退出码 ' + r.status + '：' + exeOneLine(stderr || stdout) + ' —— 若提示未登录/无凭据，请先在终端执行 `opencode auth login`' }
  }
  return { ok: false, models: [], exe: exe, error: '`opencode models` 成功退出但没有解析到任何 provider/model 行' + (stdout ? '（输出开头：' + exeOneLine(stdout, 160) + '）' : '（输出为空）') + ' —— 请先在终端手动跑一次 `opencode models` 确认输出格式与登录状态' }
}

/** 兼容薄封装：失败返回空数组（旧语义，供不关心原因的调用方）。 */
export function fetchModelsSync(env, binPath, timeoutMs) {
  const d = fetchModelsDetailed(env, binPath, timeoutMs)
  return d.ok ? d.models : []
}

// ── 手动拉取缓存（契约 §3.2）─────────────────────────────────────────────────
// `meta()` 每次面板渲染都会被调用：**只读本缓存，绝不 spawn**。缓存只存在进程内存里
// （宿主进程重启即失效，不会把过时清单落盘成"配置"）；用户点按钮才刷新它。
const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MODEL_CACHE = { at: 0, models: [] }

/** 读缓存（未拉过 / 已过期 → 空数组，面板据此提示「点按钮拉取」）。 */
export function cachedModels(nowMs) {
  const at = Number(nowMs) || Date.now()
  if (!MODEL_CACHE.models.length) return []
  if (at - MODEL_CACHE.at >= MODEL_CACHE_TTL_MS) return []
  return MODEL_CACHE.models.slice()
}

/** 手动拉取成功后回填缓存；空清单绝不入缓存（否则下次渲染"有缓存但没内容"）。 */
export function rememberModels(models, nowMs) {
  if (!Array.isArray(models) || !models.length) return false
  MODEL_CACHE.models = models.slice()
  MODEL_CACHE.at = Number(nowMs) || Date.now()
  return true
}
