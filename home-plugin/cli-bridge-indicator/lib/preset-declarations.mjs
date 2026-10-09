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

export const PKG_NAME = '@luchenglong/cli-bridge'

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

async function loadPluginList(id) {
  const abs = join(ROOT, 'preset', id, 'plugin-list.mjs')
  if (!existsSync(abs)) return null
  const mod = await import(pathToFileURL(abs).href)
  if (!mod || typeof mod.buildPlugins !== 'function' || !mod.meta) return null
  return mod
}

/**
 * 生成某 provider 的 agentPresets 定义（真函数已落地；不含任何 DSH 活对象）。
 * @returns {Promise<{id,name,description,order,plugins}|null>}
 */
export async function buildPresetDefinition(id) {
  const mod = await loadPluginList(id)
  if (!mod) return null
  const meta = mod.meta
  const plugins = realize(mod.buildPlugins({ bridgeName: PKG_NAME + '/preset-' + id }) || [], [])
  return { id: meta.id, name: meta.name || meta.id, description: meta.description || '', order: meta.order != null ? meta.order : 10, plugins }
}

/**
 * 在 indicator 的 ctx 上挂「agentPresets 就绪 → 注册三个 preset」等待器。
 * 返回每个 provider 的注册状态数组（诊断用）；任何异常都不外抛。
 */
export function declareBridgePresets(ctx, opts) {
  const ids = (opts && opts.ids) || PROVIDER_IDS_FALLBACK
  const out = []
  if (typeof ctx.inject !== 'function') return out
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

export const PROVIDER_IDS_FALLBACK = ['agy', 'codebuddy', 'mimo']
