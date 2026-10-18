// preset/mimo-first/plugin-list.mjs — cordis-mimo 预设的单源插件清单（PROVIDER-CONTRACT §5）。
//
// = 官方 standard 基线（standard-base.mjs）+ mimo 桥接行 + 委派差异。
// preset id 'cordis-mimo' 是旧会话头引用，不可变。
import { standardPluginRows, bridgeRow } from '../standard-base.mjs'

export const meta = {
  id: 'cordis-mimo',
  name: 'MiMo 执行代理',
  description: '完整编码 Agent（standard 全部能力），额外提供 mimo_run/mimo_continue 工具并注入"MiMo 优先"策略：各种模式下先把实现、编辑、调试、构建、跨文件排查派给本机 mimo CLI（Xiaomi MiMo Desktop / MiMoCode，DSH 完全控制、mimo 无提示改文件、默认后台执行），原生工具仅用于只读查询与最终验证。',
  order: 10
}

/**
 * 子 agent 所用的成员预设 id（人格与工具面在 preset/mimo-member/plugin-list.mjs）。
 * 0.2.1 起角色人格不能再写在 dsh-tool-subagent 行上，只能由 agentPreset 指向独立预设。
 */
export const MEMBER_PRESET_ID = 'cordis-mimo-member'

export function buildPlugins(deps) {
  const rows = standardPluginRows()
  // persona 行：prefix 与官方 standard 逐字一致（{{model}}）。
  // 2026-10-18：不再设置 suffix —— DSH 只注册 provider/model 两个变量，工作目录由
  // working-directory 服务以不插值的用户上下文提供，{{cwd}} 会让本预设整轮组装失败。
  const persona = rows.find((r) => r.id === 'persona')
  if (persona && persona.config) {
    persona.config.prefix = 'You are a coding agent powered by the {{model}} model.'
    delete persona.config.suffix
  }
  // 委派组：0.2.1 起人格与工具面属于【独立成员预设】，委派行只用 agentPreset 选择它。
  const delegation = rows.find((r) => r.id === 'delegation')
  if (delegation && Array.isArray(delegation.config)) {
    for (const child of delegation.config) {
      if (!child || child.name !== '@deepseek-ai/dsh-tool-subagent' || !child.config) continue
      // persona/toolFilter 会被 dsh-tool-subagent 的 apply() 直接 throw，写进去就是
      // 整个预设挂载失败 —— 一律删除（人格已迁到成员预设）。
      delete child.config.persona
      delete child.config.toolFilter
      // agentPreset 只有 in-process spawn 支持；fork 与外部后端会拒绝它，故只给 spawn。
      if (child.config.provider === 'spawn') child.config.agentPreset = MEMBER_PRESET_ID
    }
  }
  rows.push(bridgeRow('mimo', deps && deps.bridgeName))
  return rows
}
