// preset/codebuddy-first/plugin-list.mjs — codebuddy-first 预设的单源插件清单（PROVIDER-CONTRACT §5）。
//
// = 官方 standard 基线（standard-base.mjs）+ codebuddy 桥接行；persona 保持 standard
// 默认（旧包 preset/codebuddy-first/agent.cordis.yml 就没有 persona 定制 —— 不顺手加）。
// preset id 'codebuddy-first' 是旧会话头引用（codebuddy-first-bridge 的
// preset.yml name: CodeBuddy-First 执行代理），不可变。
import { standardPluginRows, bridgeRow } from '../standard-base.mjs'

export const meta = {
  id: 'codebuddy-first',
  name: 'CodeBuddy-First 执行代理',
  description: '完整编码 Agent（standard 全部能力），额外提供 codebuddy_run/codebuddy_continue 工具并注入"codebuddy 优先"策略：各种模式下先把实现、编辑、调试、构建、跨文件排查派给本机 codebuddy CLI（DSH 完全控制、codebuddy 无提示改文件），原生工具仅用于只读查询与最终验证。',
  order: 10
}

export function buildPlugins(deps) {
  const rows = standardPluginRows()
  rows.push(bridgeRow('codebuddy', deps && deps.bridgeName))
  return rows
}
