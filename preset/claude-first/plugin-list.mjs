// preset/claude-first/plugin-list.mjs — claude-first 预设的单源插件清单（PROVIDER-CONTRACT §5）。
//
// = 官方 standard 基线（standard-base.mjs）+ claude 桥接行 + persona 差异。
// preset id 'claude-first'：本包新增 provider，无旧包兼容包袱，id 直接用 provider id + '-first'
// （与 opencode-first 同构；cordis-agy / cordis-mimo 的 cordis-* 前缀是旧包历史遗留，不可套用）。
import { standardPluginRows, bridgeRow } from '../standard-base.mjs'

export const meta = {
  id: 'claude-first',
  name: 'Claude Code 执行代理',
  description: '完整编码 Agent（standard 全部能力），额外提供 claude_run/claude_continue 工具并注入"claude 优先"策略：各种模式下先把实现、编辑、调试、构建、跨文件排查派给本机 Claude Code CLI（DSH 完全控制、claude 无提示改文件、默认后台执行），原生工具仅用于只读查询与最终验证。模型清单以服务端权威探测为准（claude_models）。',
  order: 50
}

export function buildPlugins(deps) {
  const rows = standardPluginRows()
  // persona 段：prefix 必填；**不设 suffix** —— DSH 只注册 provider/model 两个提示词变量，
  // 写 {{cwd}} 会在组装期抛 unknown prompt variable，使整个预设不可用（工作目录由
  // working-directory 服务以不插值的用户上下文提供）。
  const persona = rows.find((r) => r.id === 'persona')
  if (persona && persona.config) {
    persona.config.prefix = 'You are a coding agent powered by the {{model}} model.'
    delete persona.config.suffix
  }
  // 桥接行：第二参数由 build（scripts/build.mjs）注入裸包说明符，绝不在这里写死路径。
  rows.push(bridgeRow('claude', deps && deps.bridgeName))
  return rows
}
