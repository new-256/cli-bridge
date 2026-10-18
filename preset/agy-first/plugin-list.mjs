// preset/agy-first/plugin-list.mjs — cordis-agy 预设的单源插件清单（PROVIDER-CONTRACT §5）。
//
// = 官方 standard 基线（standard-base.mjs）+ agy 桥接行 + persona 差异（旧仓
// preset-cordis-agy 的 persona 文案 verbatim）。preset id 'cordis-agy' 是旧会话头
// 引用（agy-first-bridge v1.7.1 cordis.patch.yml），不可变。
import { standardPluginRows, bridgeRow } from '../standard-base.mjs'

export const meta = {
  id: 'cordis-agy',
  name: 'AGY 执行代理',
  description: '完整编码 Agent（standard 全部能力），额外提供 agy_run/agy_continue 工具并注入"agy 优先"策略：各种模式下先把实现、编辑、调试、构建、跨文件排查派给本机 agy CLI（DSH 完全控制、agy 无提示改文件、默认后台执行），原生工具仅用于只读查询与最终验证。',
  order: 10
}

export function buildPlugins(deps) {
  const rows = standardPluginRows()
  // 旧仓 agent.cordis.yml persona 段 verbatim（v1.5.15：dsh-persona 要求
  // prefix 必填 + suffix 可选；旧单 text: 字段被 schema 拒绝）。
  // 2026-10-18：不再设置 suffix —— 当前 DSH 只注册 provider/model 两个提示词变量，
  // 工作目录由 working-directory 服务作为不插值的用户上下文提供，写 {{cwd}} 会让
  // 本预设整轮组装失败（unknown prompt variable）。delete 兼防基座再引入 suffix。
  const persona = rows.find((r) => r.id === 'persona')
  if (persona && persona.config) {
    persona.config.prefix = 'You are a coding agent powered by the {{model}} model.'
    delete persona.config.suffix
  }
  rows.push(bridgeRow('agy', deps && deps.bridgeName))
  return rows
}
