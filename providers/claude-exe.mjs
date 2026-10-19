// providers/claude-exe.mjs — claude 可执行文件探测/包装（无宿主依赖的纯逻辑片）。
//
// 从 providers/claude.mjs 拆出，让两个文件都留在 600 行红线内（规则 §26）。
// scripts/build.mjs 会把 providers/claude-*.mjs 按文件名字典序内联进 dynamic 沙箱的
// 同一个作用域，所以沙箱里这些函数天然可见；ESM 形态走本文件的 import。
// ⚠️ 注释里绝不写出口令标记字面量（build 全局替换会把注释劈开 → 生成物语法崩）。
//
// 本机实测事实（Claude Code 2.0.76，Windows）：
//   • PATH 上的 `claude` 是原生 exe（.cherrystudio\bin\claude.exe）；官方原生 installer
//     给 claude.exe，npm 全局安装给 claude.cmd + node_modules/@anthropic-ai/claude-code/cli.js。
//   • Windows 上 Node 的 spawn 不能直接执行 .cmd/.bat（CreateProcess 只补 .exe），
//     必须 shell:true；.js/.mjs 目标必须经 node 包装。这两条决定下面的 splitExeSpec。

// 沙箱可能没有 fs/path：一律经 getBuiltinModule + typeof 守卫读取，读不到就退保守值。
function claudeBuiltin(name) {
  try {
    const proc = globalThis.process
    return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule(name) : null
  } catch (e) { return null }
}

// PATH 兜底名（Windows 由 CreateProcess 自动补 .exe）。
export const CLAUDE_EXE_BASENAME = 'claude'

// 用户可以显式指定可执行文件的既有环境变量（按优先级）。
export const CLAUDE_BIN_ENV_VARS = ['CLAUDE_BIN', 'CLAUDE_CLI', 'CLAUDE_CODE_BIN']

// 已知的本地安装位置（native installer / 官方 local 目录）；存在才收，不做版本猜测。
const CLAUDE_LOCAL_REL = [
  ['.claude', 'local', 'claude.exe'],
  ['.claude', 'local', 'claude'],
  ['.local', 'bin', 'claude.exe'],
  ['.local', 'bin', 'claude']
]

/**
 * 把「一个可执行文件路径」拆成 spawn 需要的形态。
 * .js/.cjs/.mjs → 经当前 node 启动（测试 fixture 与 npm 安装的 cli.js 都是这形态）；
 * .cmd/.bat    → 只能 shell 执行（Windows 限制），调用方必须带 shell:true；
 * 其余         → 直接执行（原生 exe / PATH 名字）。
 * @param {string} exe
 * @returns {{cmd: string, prefixArgs: string[], shell: boolean, kind: string}}
 */
export function splitExeSpec(exe) {
  const s = String(exe || '')
  if (/\.(mjs|cjs|js)$/i.test(s)) {
    const proc = globalThis.process
    const node = (proc && proc.execPath) ? proc.execPath : 'node'
    return { cmd: node, prefixArgs: [s], shell: false, kind: 'node' }
  }
  if (/\.(cmd|bat)$/i.test(s)) return { cmd: s, prefixArgs: [], shell: true, kind: 'shell' }
  return { cmd: s, prefixArgs: [], shell: false, kind: 'binary' }
}

/** shell:true 下的命令行拼装（只用于参数集合固定的探测调用，不拼装用户 prompt）。 */
export function quoteShellArg(a) {
  const s = String(a)
  return /[\s"&|<>^()]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/**
 * 候选可执行文件列表（顺序 = 优先级）：设置面板 binPath > env 变量 > 已知本地安装 > PATH 名字。
 * 纯函数、零副作用；无 fs 能力时只返回设置/env/PATH 名，绝不抛。
 * @param {object} env 环境变量
 * @param {string} [binPath] 设置面板里显式填写的路径
 * @returns {string[]}
 */
export function claudeExeCandidates(env, binPath) {
  const e = env || {}
  const out = []
  const push = (p) => { const v = String(p || '').trim(); if (v && out.indexOf(v) < 0) out.push(v) }
  if (binPath) push(binPath)
  for (const k of CLAUDE_BIN_ENV_VARS) if (e[k]) push(e[k])
  const fs = claudeBuiltin('node:fs')
  const path = claudeBuiltin('node:path')
  const home = e.USERPROFILE || e.HOME || ''
  if (fs && path && typeof fs.existsSync === 'function' && typeof path.join === 'function' && home) {
    for (const rel of CLAUDE_LOCAL_REL) {
      const p = path.join.apply(path, [home].concat(rel))
      try { if (fs.existsSync(p)) push(p) } catch (err) { }
    }
  }
  push(CLAUDE_EXE_BASENAME)
  return out
}

/**
 * 探测时优先尝试的候选（去掉 PATH 兜底名——它由 spawn 的 PATH 搜索处理，且不是绝对路径）。
 * @returns {string[]}
 */
export function claudeProbeCandidates(env, binPath) {
  return claudeExeCandidates(env, binPath).filter((c) => c !== CLAUDE_EXE_BASENAME)
}

/**
 * buildArgv 需要的前缀数组：设置 binPath > env > 本地安装 > PATH 名字。
 * .js/.mjs 目标返回 [node, file]。宿主形态（preset/dynamic）也会用它做 existsSync 校验。
 * @returns {string[]}
 */
export function resolveExePrefix(env, binPath) {
  const cands = claudeExeCandidates(env, binPath)
  const spec = splitExeSpec(cands[0] || CLAUDE_EXE_BASENAME)
  return [spec.cmd].concat(spec.prefixArgs)
}

/** PATH 里的 claude 是否真的可执行（仅诊断用：返回路径或空串）。 */
export function claudePathHint(env) {
  const e = env || {}
  for (const k of CLAUDE_BIN_ENV_VARS) if (e[k]) return String(e[k])
  const cands = claudeExeCandidates(e, '')
  return cands.length ? String(cands[0]) : ''
}
