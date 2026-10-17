// providers/opencode-exe.mjs — opencode 可执行探测与模型列表解析（无宿主依赖）。
//
// 从 providers/opencode.mjs 拆出，让两个文件都留在 600 行红线内（规则 §26）。
// build 会把 providers/opencode-*.mjs 全部内联进 dynamic 沙箱同一作用域。
// ⚠️ 注释里绝不写出口令标记字面量（build 全局替换会把注释劈开）。

import { clampInt } from '../core/bridge-kit.mjs'

// Node 内建守卫（沙箱可能没有 fs/path；读不到返回 null，调用方退到保守值）。
function schedBuiltin(name) {
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
  const fs = schedBuiltin('node:fs')
  const path = schedBuiltin('node:path')
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
