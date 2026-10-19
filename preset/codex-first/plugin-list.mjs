// preset/codex-first/plugin-list.mjs — codex-first 预设的单源插件清单（PROVIDER-CONTRACT §5）。
//
// = 官方 standard 基线（standard-base.mjs）+ codex 桥接行 + persona 差异。
// preset id 直接用 'codex-first'（与 opencode-first 同构）：本包新增的 provider 无旧包
// 兼容包袱，不套用 agy 的 cordis-agy / mimo 的 cordis-mimo 旧前缀。
import { standardPluginRows, bridgeRow } from '../standard-base.mjs'

export const meta = {
  id: 'codex-first',
  name: 'Codex 执行代理',
  description: '完整编码 Agent（standard 全部能力），额外提供 codex_run/codex_continue 工具并注入"Codex 优先"策略：各种模式下先把实现、编辑、调试、构建、跨文件排查派给本机 OpenAI Codex CLI（DSH 完全控制、非交互不弹审批、默认后台执行），原生工具仅用于只读查询与最终验证。',
  order: 50
}

export function buildPlugins(deps) {
  const rows = standardPluginRows()
  // persona 段：prefix 与其它 preset 同构（dsh-persona 要求 prefix 必填）。
  // 不设置 suffix —— DSH 只注册 provider/model 两个模板变量，工作目录由
  // working-directory 服务以「不插值」的用户上下文提供；写 {{cwd}} 会让本预设整轮
  // 组装失败（2026-10-18 实测，别重蹈覆辙）。
  const persona = rows.find((r) => r.id === 'persona')
  if (persona && persona.config) {
    persona.config.prefix = 'You are a coding agent powered by the {{model}} model.'
    delete persona.config.suffix
  }
  rows.push(bridgeRow('codex', deps && deps.bridgeName))
  return rows
}
