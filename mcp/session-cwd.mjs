// mcp/session-cwd.mjs — MCP 形态下解析「会话工作区」。
//
// 为什么需要（真实事故，2026-10-23）：
// 用户反馈「agent 委派任务时 agy/opencode/claude/codex 报错：无权编辑工作区外的内容」。
// 根因不在 CLI 沙箱本身，而在**工作区边界被定错了**：
//   MCP 各 provider 的 cwd 兜底是 `process.env.<ID>_MCP_CWD || process.cwd()`，
//   而 DSH 的 mcp-client 启动 stdio server 时 `config.cwd` 默认是空字符串
//   （@deepseek-ai/dsh-mcp-client 里 `cwd: z.string().default("")`），
//   于是 MCP 进程的 cwd = **DSH 主进程的目录**（dsh-home / 安装目录），而不是用户的会话目录。
//   结果：CLI 认为"工作区"是那个目录，用户项目里的一切都在"工作区外"——
//   codex 的 `-s workspace-write` 直接拒绝写入，其余各家也按各自的 project 边界拒绝。
//
// 修法：DSH 给子进程提供了 `DSH_SESSION_ID`（实测存在），会话的 cwd 存在
// projcache 的 `record.identity.cwd` 里。据此把兜底链补成：
//   args.cwd（调用方显式传，最可靠）→ <ID>_MCP_CWD（用户配置）
//   → 本模块（会话真实目录）→ process.cwd()（最后兜底）
//
// 约束：本模块零依赖（只用 node:fs / node:path），且必须容错——任何读取失败都返回 ''，
// 由调用方继续往下兜底，绝不抛异常打断工具调用。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CACHE_TTL_MS = 60 * 1000
let cache = { at: 0, sid: '', cwd: '' }

/** 从 projcache 里按会话 id 取 cwd。读不到返回 ''。 */
function cwdFromProjcache(dshHome, sessionId) {
  if (!dshHome || !sessionId) return ''
  const base = join(dshHome, 'storages', 'session_projcache', 'sessions')
  // 会话 id 在磁盘上可能是 `<id>.json` 或 `session-<uuid>.json` 两种形态
  const plain = sessionId.replace(/^session-/, '')
  const cands = [
    join(base, sessionId + '.json'),
    join(base, 'session-' + plain + '.json'),
    join(base, plain + '.json')
  ]
  for (const f of cands) {
    try {
      if (!existsSync(f)) continue
      const j = JSON.parse(readFileSync(f, 'utf8'))
      const c = j && j.record && j.record.identity && j.record.identity.cwd
      if (typeof c === 'string' && c) return c
    } catch (e) { /* 单文件失败继续试下一个 */ }
  }
  return ''
}

/**
 * 解析当前 DSH 会话的工作目录。
 * @param {object} [env] 默认 process.env（便于测试注入）
 * @param {number} [nowMs] 便于测试注入时间
 * @returns {string} 会话 cwd；无法确定时返回 ''
 */
export function resolveSessionCwd(env, nowMs) {
  const e = env || (typeof process !== 'undefined' ? process.env : {}) || {}
  const sid = String(e.DSH_SESSION_ID || '')
  if (!sid) return ''
  const at = Number(nowMs) || Date.now()
  if (cache.sid === sid && at - cache.at < CACHE_TTL_MS) return cache.cwd

  const home = String(e.DSH_HOME || '')
  let cwd = cwdFromProjcache(home, sid)
  // projcache 没命中时退一步：会话存储目录名里编码了 cwd（--C-Users-...--），
  // 但它只覆盖有事件落盘的会话，且解码易错 —— 仅在 projcache 缺失时尝试。
  if (!cwd && home) cwd = cwdFromSessionDirs(home, sid)

  cache = { at, sid, cwd }
  return cwd
}

/** 会话事件目录名把 cwd 编码成 `--C-Users-lcl-Desktop-Foo--`。仅在 projcache 缺失时用。 */
function cwdFromSessionDirs(dshHome, sessionId) {
  const base = join(dshHome, 'sessions')
  try {
    if (!existsSync(base)) return ''
    for (const dirName of readdirSync(base)) {
      if (!dirName.startsWith('--') || !dirName.endsWith('--')) continue
      const inner = join(base, dirName)
      let entries = []
      try { entries = readdirSync(inner) } catch (e) { continue }
      if (!entries.includes(sessionId)) continue
      // `--C-Users-lcl-Desktop-Foo-Bar--` → C:\Users\lcl\Desktop\Foo\Bar
      // 编码规则：盘符与反斜杠被替换成 '-', 空格等特殊字符被编码成 ~XXXX~（此处不做还原）
      const raw = dirName.slice(2, -2)
      const decoded = decodeSessionDirName(raw)
      if (decoded) return decoded
    }
  } catch (e) { }
  return ''
}

/**
 * 解码 DSH 会话目录名。已知编码：`C:` → `C`，`\` 与 `/` → `-`，特殊字符 → `~HEX~`。
 * 反解有歧义（`-` 既是分隔符也可能属于目录名），故只在能明确判定盘符时返回，否则放弃。
 */
function decodeSessionDirName(raw) {
  const m = /^([A-Za-z])-(.+)$/.exec(raw)
  if (!m) return ''
  const drive = m[1].toUpperCase() + ':\\'
  const rest = m[2].replace(/~([0-9A-Fa-f]{4})~/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  // 剩余的 '-' 视作路径分隔符（与 DSH 编码一致）
  return drive + rest.split('-').join('\\')
}

/** 供测试重置缓存。 */
export function resetSessionCwdCache() { cache = { at: 0, sid: '', cwd: '' } }

/**
 * 各 MCP provider 共用的 cwd 兜底链。
 * 顺序：调用方显式 args.cwd → 用户 env 覆盖 → 会话真实目录 → process.cwd()。
 * @param {object} a 工具入参
 * @param {string} envKey 该 provider 的 cwd 覆盖环境变量名（如 CLAUDE_MCP_CWD）
 * @param {(p: string) => string} [resolvePathFn] 路径规范化（各 provider 自带）
 */
export function resolveCwdWithSession(a, envKey, resolvePathFn) {
  const rp = typeof resolvePathFn === 'function' ? resolvePathFn : (x) => x
  if (a && a.cwd) return rp(String(a.cwd))
  const env = (typeof process !== 'undefined' && process.env) || {}
  if (envKey && env[envKey]) return rp(String(env[envKey]))
  const sessionCwd = resolveSessionCwd(env)
  if (sessionCwd) return rp(sessionCwd)
  return (typeof process !== 'undefined' && process.cwd) ? process.cwd() : ''
}
