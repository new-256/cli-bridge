// preset/agy-first/plugin-list.mjs — ⚠️ Lead 冒烟夹具（provider-agy 任务会整体替换）。
import { standardPluginRows, bridgeRow, jsExpr } from '../standard-base.mjs'
export const meta = { id: 'cordis-agy', name: 'AGY 执行代理', description: 'smoke', order: 10 }
export function buildPlugins(deps) {
  const rows = standardPluginRows()
  const persona = rows.find((r) => r.id === 'persona')
  persona.config.prefix = 'You are an AI agent.'
  rows.push(bridgeRow('agy', deps.bridgeName))
  return rows
}