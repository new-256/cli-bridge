// providers/registry.mjs — provider 注册表（keystone，Lead 单作者）。
//
// 静态导入 provider 描述符工厂；指示灯 host 半、统一 MCP 服务器、verify 都从这里
// 取数。描述符契约见 PROVIDER-CONTRACT.md §1。新增 provider = 加一行 import + 一项 defs。
//
// 单一 id 轴（契约 §3.1）：本数组是全局唯一 provider 清单来源，调度面板、四形态门禁、
// preset 声明、MCP 工具面、status 视图全部由此派生，禁止第二处硬编码 id 列表。
import defineAgy from './agy.mjs'
import defineCodebuddy from './codebuddy.mjs'
import defineMimo from './mimo.mjs'
import defineOpencode from './opencode.mjs'

/** 稳定顺序（家级灯渲染顺序 = 此顺序；新增项一律追加在末尾，不重排既有顺序）。 */
export const PROVIDER_IDS = ['agy', 'codebuddy', 'mimo', 'opencode']

const defs = {
  agy: defineAgy,
  codebuddy: defineCodebuddy,
  mimo: defineMimo,
  opencode: defineOpencode
}

/**
 * 构造某 provider 的描述符实例。
 * @param {string} id PROVIDER_IDS 之一。
 * @param {object} [deps] 宿主形态注入（{ env, process, nodeFs, nodeChild, nodePath, log }）。
 * @returns descriptor（见 PROVIDER-CONTRACT.md §1）
 */
export function createProvider(id, deps) {
  const factory = defs[id]
  if (!factory) throw new Error('cli-bridge: unknown provider ' + JSON.stringify(id))
  return factory(deps || {})
}

/** 轻量元信息（不构造描述符也能拿到，用于路由/展示层预建骨架）。 */
export function providerMeta(id) {
  const d = createProvider(id, { env: {} })
  return { id: d.id, label: d.label, presetId: d.presetId, defaultBackend: d.defaultBackend || null }
}
