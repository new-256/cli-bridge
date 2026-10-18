// home-plugin/cli-bridge-indicator/lib/preset-declarations.mjs — 声明制 preset 注册（keystone）。
//
// v1.2.0 Form-A 修复的三合一版：indicator 以自身为载体，向 agentPresets 注册表登记
// cordis-agy / codebuddy-first / cordis-mimo 三个 preset（各自 = 对应 preset/<id>/plugin-list.mjs
// 的单源定义）。旧 DSH（≤0.1.6-alpha.2）上 agentPresets 服务永不出现 → ctx.inject 注入器
// 挂起零副作用（cordis 语义：等待不是失败，loader 不收集等待中的注入器）——这正是
// 我们不用 bundle-patch preset 行的原因（旧 loader 把行 import 失败当致命错误，整包拒挂）。
//
// plugin-list.mjs 是三个 preset 的唯一权威源（PROVIDER-CONTRACT.md §5）；这里运行时
// import 它（宿主是真 Node）。动态 import 失败（provider 任务未交付/文件损坏）只影响
// 该 preset 的注册，绝不让状态灯本业崩溃 —— 逐 provider 独立 try。
//
// 注意：本文件 import 的 plugin-list 在 **host realm** 执行，其 buildPlugins 返回的
// 数组随后交给 agentPresets.register()；__jsExpr 占位逐字透传（loader 的原生输入
// 形态），不做求值。

import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveScheduling } from '../../../core/scheduling.mjs'
import { PROVIDER_IDS } from '../../../providers/registry.mjs'

export const PKG_NAME = '@luchenglong/cli-bridge'

// preset 目录名映射（与 scripts/build.mjs 的 PRESET_DIRS 一致；目录名带 -first 后缀是
// 三个旧包时代的遗留布局，provider id 不带 —— 这里不映射就永远找不到 plugin-list）。
const PRESET_DIRS = { agy: 'agy-first', codebuddy: 'codebuddy-first', mimo: 'mimo-first', opencode: 'opencode-first' }

// 【成员预设】0.2.1 起 dsh-tool-subagent 的 config 不再接受 persona/toolFilter（apply()
// 里显式 throw），角色人格只能作为独立 Agent Preset 存在、由委派行经 agentPreset 选择。
// key = provider id（决定它是否随该 provider 的启用面注册，与主预设的启用语义一致）；
// value = { id: 预设身份（委派行按它选择）, dir: preset/<dir>/plugin-list.mjs }。
// ⚠ 必须**先于**对应 provider 的主预设注册：主预设委派行的 validate() 会对每个
// agentPreset id 调 presets.readDocument(id)，未注册即抛 agent-preset/not-found，
// 而 apply() 一抛就拖垮整组预设挂载（这正是 mimo 在 0.2.1 上挂载失败的根因链）。
const MEMBER_PRESETS = { mimo: { id: 'cordis-mimo-member', dir: 'mimo-member' } }

/** 只读视图：provider id → 成员预设 id（测试与诊断从它派生，避免第二处硬编码）。 */
export function memberPresetIds(ids) {
  const list = ids || []
  return Object.entries(MEMBER_PRESETS)
    .filter(([providerId]) => list.includes(providerId))
    .map(([, member]) => member.id)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

function realize(v, seen) {
  // { __jsExpr: string } 是 loader interpolate 的【原生输入形态】（codebuddy v1.2.0
  // 实测：agentPresets.register 原样接受，由 loader 在激活时求值）—— 必须逐字透传，
  // 绝不能在这里编译成真函数：注册表会 JSON 化跨 realm 传递，函数会静默丢失。
  if (!v || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => realize(x, seen))
  if (Object.prototype.hasOwnProperty.call(v, '__jsExpr') && typeof v.__jsExpr === 'string') {
    return { __jsExpr: v.__jsExpr }
  }
  if (seen.indexOf(v) >= 0) return v
  seen.push(v)
  const out = Object.create(null)
  for (const k of Object.keys(v)) out[k] = realize(v[k], seen)
  return out
}

/** 按 preset 目录名加载单源 plugin-list（provider 预设与成员预设共用）。 */
async function loadPluginListDir(dir) {
  const abs = join(ROOT, 'preset', dir, 'plugin-list.mjs')
  if (!existsSync(abs)) return null
  const mod = await import(pathToFileURL(abs).href)
  if (!mod || typeof mod.buildPlugins !== 'function' || !mod.meta) return null
  return mod
}

async function loadPluginList(id) {
  return loadPluginListDir(PRESET_DIRS[id] || id)
}

/**
 * 按【目录名】生成 agentPresets 定义（真函数已落地；不含任何 DSH 活对象）。
 * bridgeName 决定桥接行的入口子路径：provider 预设用 '/preset-<id>'，成员预设用
 * 其所属 provider 的同一入口（子 agent 要能调到该 provider 的 run 工具）。
 * @returns {Promise<{id,name,description,order,plugins}|null>}
 */
async function buildDefinitionFromDir(dir, bridgeName) {
  const mod = await loadPluginListDir(dir)
  if (!mod) return null
  const meta = mod.meta
  const plugins = realize(mod.buildPlugins({ bridgeName }) || [], [])
  return { id: meta.id, name: meta.name || meta.id, description: meta.description || '', order: meta.order != null ? meta.order : 10, plugins }
}

/**
 * 生成某 provider 的 agentPresets 定义。
 * @returns {Promise<{id,name,description,order,plugins}|null>}
 */
export async function buildPresetDefinition(id) {
  return buildDefinitionFromDir(PRESET_DIRS[id] || id, PKG_NAME + '/preset-' + id)
}

/**
 * 注册某 provider 的成员预设（先行注册）。只注册启用面里的 provider，与主预设一致。
 * @param ctx - 指示灯插件的 context。
 * @param out - 与主预设共用的诊断数组。
 * @param ids - 已启用（按调度顺序）的 provider id 列表。
 */
function declareMemberPresets(ctx, out, ids) {
  if (typeof ctx.inject !== 'function') return
  for (const [providerId, member] of Object.entries(MEMBER_PRESETS)) {
    if (!ids.includes(providerId)) continue
    try {
      ctx.inject(['agentPresets'], (child) => {
        child.effect(() => {
          let disposer = null
          const registering = (async () => {
            try {
              const def = await buildDefinitionFromDir(member.dir, PKG_NAME + '/preset-' + providerId)
              if (!def) { out.push({ id: member.id, ok: false, error: 'plugin-list missing' }); return }
              disposer = await child.agentPresets.register(def)
              out.push({ id: member.id, ok: true, member: true })
            } catch (e) {
              out.push({ id: member.id, ok: false, error: String(e && e.message || e) })
              try {
                if (child.logger && typeof child.logger.warn === 'function') {
                  child.logger.warn('cli-bridge: member preset ' + member.id + ' registration skipped: ' + (e && e.message || e))
                }
              } catch (_) { }
            }
          })()
          return async () => {
            try { await registering } catch (_) { }
            if (typeof disposer === 'function') {
              try { await disposer() } catch (_) { }
            }
            disposer = null
          }
        }, 'cli-bridge: member preset declaration ' + member.id)
      })
    } catch (e) {
      out.push({ id: member.id, ok: false, error: String(e && e.message || e) })
    }
  }
}

/**
 * 在 indicator 的 ctx 上挂「agentPresets 就绪 → 注册启用面的 preset」等待器。
 * 返回每个 provider 的注册状态数组（诊断用）；任何异常都不外抛。
 *
 * 调度语义（0.2.5 起按 enabled 过滤注册，用户定案）：
 *   只注册**启用面**的 preset —— 未启用的 provider 不出现在预设目录里。
 *   0.2.0 曾是「恒常注册、禁用只影响 apply()」，但用户明确要求：停用的 CLI 不该在
 *   预设列表里占位（选中它等于立刻撞到一个零注册的桥，纯噪音）。
 *   代价：停用后旧会话头若仍指向该 preset，进入该会话会找不到预设 —— 这是停用的
 *   应有语义；重新启用即恢复（注册表在宿主启动时重建）。
 *   opts.ids 显式传入时跳过调度过滤与排序（测试/手工可控）。
 */
export function declareBridgePresets(ctx, opts) {
  let ids = (opts && opts.ids) || PROVIDER_IDS_FALLBACK
  if (!opts || !opts.ids) {
    try {
      const sched = resolveScheduling(PROVIDER_IDS_FALLBACK, opts && opts.io)
      // 只取 order（= priority ∩ enabled），不再补禁用项到尾部。
      ids = sched.order.slice()
    } catch (e) { /* 调度不可得 = 缺省全量注册，绝不因读不到配置而清空预设 */ }
  }
  const out = []
  if (typeof ctx.inject !== 'function') return out
  // 成员预设先注册：主预设委派行的 validate() 会经 presets.readDocument(id) 校验
  // agentPreset 引用存在，未注册即抛 agent-preset/not-found。
  declareMemberPresets(ctx, out, ids)
  for (const id of ids) {
    try {
      ctx.inject(['agentPresets'], (child) => {
        child.effect(() => {
          let disposer = null
          const registering = (async () => {
            try {
              const def = await buildPresetDefinition(id)
              if (!def) { out.push({ id, ok: false, error: 'plugin-list missing' }); return }
              disposer = await child.agentPresets.register(def)
              out.push({ id, ok: true })
            } catch (e) {
              // 重复注册（双实例/用户手工声明行撞 id）等：本份放弃即可，
              // 绝不向宿主树抛错。
              out.push({ id, ok: false, error: String(e && e.message || e) })
              try {
                if (child.logger && typeof child.logger.warn === 'function') {
                  child.logger.warn('cli-bridge: preset ' + id + ' registration skipped: ' + (e && e.message || e))
                }
              } catch (_) { }
            }
          })()
          return async () => {
            try { await registering } catch (_) { }
            if (typeof disposer === 'function') {
              try { await disposer() } catch (_) { }
            }
            disposer = null
          }
        }, 'cli-bridge: preset declaration ' + id)
      })
    } catch (e) {
      out.push({ id, ok: false, error: String(e && e.message || e) })
    }
  }
  return out
}

// 单一 id 轴 = registry.PROVIDER_IDS（PROVIDER-CONTRACT.md §3.1）：新 provider 进注册表，
// preset 声明自动跟上；本模块与 settings.mjs 同 realm（host 半启动时已把 registry 加载进
// 进程），导入 registry 不引入新依赖面。导出名保留 FALLBACK 供旧引用兼容。
export const PROVIDER_IDS_FALLBACK = PROVIDER_IDS.slice()

