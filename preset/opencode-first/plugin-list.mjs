// preset/opencode-first/plugin-list.mjs — opencode-first 预设的单源插件清单（PROVIDER-CONTRACT §5）。
//
// = 官方 standard 基线（standard-base.mjs）+ opencode 桥接行 + persona 差异。
// preset id 'opencode-first'：本包新增的第四家 CLI，无旧包兼容包袱，故 id 直接用
// provider id + '-first'（与 codebuddy-first 同构；agy/mimo 的 cordis-* 前缀是旧包
// 历史遗留，不可套用到新 provider 上）。
import { standardPluginRows, bridgeRow } from '../standard-base.mjs'

export const meta = {
  id: 'opencode-first',
  name: 'OpenCode 执行代理',
  description: '完整编码 Agent（standard 全部能力），额外提供 opencode_run/opencode_continue 工具并注入"opencode 优先"策略：各种模式下先把实现、编辑、调试、构建、跨文件排查派给本机 opencode CLI（DSH 完全控制、opencode 无提示改文件、默认后台执行），原生工具仅用于只读查询与最终验证。',
  order: 40
}

export function buildPlugins(deps) {
  const rows = standardPluginRows()
  // persona 段：与三家旧 preset 同构（dsh-persona 要求 prefix 必填 + suffix 可选）。
  const persona = rows.find((r) => r.id === 'persona')
  if (persona && persona.config) {
    persona.config.prefix = 'You are a coding agent powered by the {{model}} model.'
    persona.config.suffix = 'Your working directory is {{cwd}}.'
  }
  rows.push(bridgeRow('opencode', deps && deps.bridgeName))
  return rows
}
