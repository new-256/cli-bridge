// providers/registry.mjs — provider 注册表（keystone，Lead 单作者）。
//
// 静态导入三个 provider 描述符工厂；指示灯 host 半、统一 MCP 服务器、verify 都从这里
// 取数。描述符契约见 PROVIDER-CONTRACT.md §1。新增 provider = 加一行 import + 一项 defs。
import defineAgy from './agy.mjs'
import defineCodebuddy from './codebuddy.mjs'
import defineMimo from './mimo.mjs'

/** 稳定顺序（家级灯渲染顺序 = 此顺序）。 */
export const PROVIDER_IDS = ['agy', 'codebuddy', 'mimo']

const defs = {
  agy: defineAgy,
  codebuddy: defineCodebuddy,
  mimo: defineMimo
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
