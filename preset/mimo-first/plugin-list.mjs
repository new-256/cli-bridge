// preset/mimo-first/plugin-list.mjs — cordis-mimo 预设的单源插件清单（PROVIDER-CONTRACT §5）。
//
// = 官方 standard 基线（standard-base.mjs）+ mimo 桥接行 + persona/委派差异（旧仓
// preset/mimo-first/agent.cordis.yml 的 persona 与 tool-subagent 委派文案 verbatim）。
// preset id 'cordis-mimo' 是旧会话头引用，不可变。
import { standardPluginRows, bridgeRow } from '../standard-base.mjs'

export const meta = {
  id: 'cordis-mimo',
  name: 'MiMo 执行代理',
  description: '完整编码 Agent（standard 全部能力），额外提供 mimo_run/mimo_continue 工具并注入"MiMo 优先"策略：各种模式下先把实现、编辑、调试、构建、跨文件排查派给本机 mimo CLI（Xiaomi MiMo Desktop / MiMoCode，DSH 完全控制、mimo 无提示改文件、默认后台执行），原生工具仅用于只读查询与最终验证。',
  order: 10
}

// 旧 agent.cordis.yml 的 tool-subagent（spawn/fork）委派指令文案 verbatim：
// 子 agent 在 MiMo-first 会话里优先把编码工作派给 mimo_run。
const MIMO_DELEGATION_PERSONA = 'Delegation directive: you are a child agent in a MiMo-first session. Before doing any coding, building, debugging, or multi-file investigation work yourself, check whether the mimo_run tool (or the MCP form mcp__mimo__mimo_run) is available to you; if it is, dispatch that work to mimo first per the MiMo-first policy, then verify its output with your own read-only tools. Reserve your own direct work for quick read-only lookups and final verification.'

export function buildPlugins(deps) {
  const rows = standardPluginRows()
  // persona 行：旧仓 mimo 的 prefix/suffix 与官方 standard 逐字一致（{{model}}/{{cwd}}），
  // 无差异；保留取回逻辑以便上游若分化时单点修改。
  const persona = rows.find((r) => r.id === 'persona')
  if (persona && persona.config) {
    persona.config.prefix = 'You are a coding agent powered by the {{model}} model.'
    persona.config.suffix = 'Your working directory is {{cwd}}.'
  }
  // 委派组：给 spawn/fork 两个 tool-subagent 行注入 MiMo-first 委派 persona（旧 yml）。
  const delegation = rows.find((r) => r.id === 'delegation')
  if (delegation && Array.isArray(delegation.config)) {
    for (const child of delegation.config) {
      if (child && child.name === '@deepseek-ai/dsh-tool-subagent' && child.config && (child.config.provider === 'spawn' || child.config.provider === 'fork')) {
        child.config.persona = MIMO_DELEGATION_PERSONA
      }
    }
  }
  rows.push(bridgeRow('mimo', deps && deps.bridgeName))
  return rows
}
