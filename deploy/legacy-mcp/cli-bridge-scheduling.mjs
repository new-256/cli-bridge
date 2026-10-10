// dsh-home/bin/cli-bridge-scheduling.mjs — 家级 MCP 薄封装的调度门禁共享 helper。
//
// 背景（0.2.0 CLI 调度）：三条 MCP 注册（mcp-agy-global / mcp-codebuddy-global /
// mcp-mimo-global）跑的是 dsh-home\bin\ 下的自包含旧副本，不依赖 @luchenglong/
// cli-bridge 包，因此读不到包内 core/scheduling.mjs。本文件是那份逻辑的**最小落地
// 副本**，语义与包内单源逐字一致：
//   • 读 {DSH_HOME}/cli-bridge-settings.json 顶层 `_scheduling` 区（面板勾选写这里）；
//   • enabled 缺省 / 文件缺失 / JSON 损坏 / 无法定位 DSH_HOME → 全部启用（fail-open：
//     读不到配置永远不等于关掉桥，行为与门禁上线前逐字一致）；
//   • env CLI_BRIDGE_PROVIDER 钉住单面时最高优先（薄封装兼容语义）。
// 唯一写者 = 设置面板（经 indicator POST /cli-bridge/settings）；本文件只读。
//
// 每次 tools/list 与 tools/call 现读，长驻子进程无需重启即可跟上面板改动。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SECTION = '_scheduling'

// 本文件在 dsh-home\bin\ 下 → 家根 = 上一级；MCP 子进程未必带 DSH_HOME env，路径自推最稳。
let HOME_FROM_FILE = ''
try { HOME_FROM_FILE = join(dirname(fileURLToPath(import.meta.url)), '..') } catch (e) { }

function settingsPath(env) {
  try {
    if (env.CLI_BRIDGE_SETTINGS_FILE) return String(env.CLI_BRIDGE_SETTINGS_FILE)
    const h = env.DSH_HOME || env.CODEBUDDY_INDICATOR_DIR || HOME_FROM_FILE || ''
    if (h) return join(String(h), 'cli-bridge-settings.json')
  } catch (e) { }
  return null
}

function readSection(env) {
  const p = settingsPath(env)
  if (!p) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    const sec = raw && typeof raw === 'object' ? raw[SECTION] : null
    return sec && typeof sec === 'object' && !Array.isArray(sec) ? sec : null
  } catch (e) { return null }
}

/**
 * 本 provider 面是否应暴露工具。
 * @param {string} id 'agy' | 'codebuddy' | 'mimo'
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
export function bridgeEnabled(id, env) {
  const e = env || process.env
  try {
    const pinned = String(e.CLI_BRIDGE_PROVIDER || '').trim()
    if (pinned) return pinned === id
    const sec = readSection(e)
    if (!sec || !Array.isArray(sec.enabled)) return true // 没配 = 全开（fail-open）
    if (sec.enabled.length === 0) return false           // 显式全关
    return sec.enabled.indexOf(id) >= 0
  } catch (err) { return true }                          // 任何异常 = 保持原行为
}

/** 过滤工具面：未启用 → 空数组（tools/list 空面 + tools/call 走 Unknown tool）。 */
export function filterTools(id, tools, env) {
  return bridgeEnabled(id, env) ? tools : []
}
