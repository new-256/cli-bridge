// tests/codex/helpers/verify-refresh-models.mjs — 真机手动验证：settings.refreshModels。
//
// 与设置面板「拉取可用模型」按钮走同一个函数（keystone: descriptor.settings.refreshModels(
// 分区, process.env)）。live 清单来自 ~/.codex/config.toml 里 base_url 的 GET /models。
// 只做人工/发布前验证，不进自动化套件（会真的打网络）。
//
// 跑法：node tests/codex/helpers/verify-refresh-models.mjs
import process from 'node:process'

import defineProvider from '../../../providers/codex.mjs'

const descriptor = defineProvider({ env: process.env, process })

const before = descriptor.settings.meta(process.env).fields.find((f) => f.key === 'defaultModel')
console.log('meta（拉取前）: options=' + before.options.length + ' refresh=' + JSON.stringify(before.refresh))

const t0 = Date.now()
const res = await descriptor.settings.refreshModels({}, process.env)
console.log('refreshModels 返回（' + (Date.now() - t0) + 'ms）:')
// 469 个 id 全打出来太长：打印 ok/source/error + 数量 + 前 12 个 + 末尾 5 个。
const shown = res.ok
  ? { ok: res.ok, source: res.source, count: res.ids.length, first12: res.ids.slice(0, 12), last5: res.ids.slice(-5) }
  : res
console.log(JSON.stringify(shown, null, 2))

const after = descriptor.settings.meta(process.env).fields.find((f) => f.key === 'defaultModel')
console.log('meta（拉取后）: options=' + after.options.length)
const wroteBack = res.ok && after.options.length === res.ids.length
console.log(wroteBack ? '✓ 成功并写回缓存（meta 无需再探测即命中）' : '✗ 未写回缓存 / 或本就失败')
process.exit(wroteBack || !res.ok ? 0 : 1)
