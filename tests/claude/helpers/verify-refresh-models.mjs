// tests/claude/helpers/verify-refresh-models.mjs — 真机手动验证：settings.refreshModels。
//
// 这是设置面板「拉取可用模型」按钮背后**完全相同**的函数（keystone 也是 createProvider 后
// 直接调 descriptor.settings.refreshModels(分区, process.env)），所以它跑通 = 按钮能拿到清单。
// 只做人工/发布前验证，不进 node --test 的自动化套件（会真的起 CLI、打网络）。
//
// 跑法：node tests/claude/helpers/verify-refresh-models.mjs
import process from 'node:process'

import defineProvider from '../../../providers/claude.mjs'

const descriptor = defineProvider({ env: process.env, process })

const before = descriptor.settings.meta(process.env).fields.find((f) => f.key === 'defaultModel')
console.log('meta（拉取前）: options=' + before.options.length + ' refresh=' + JSON.stringify(before.refresh))

const t0 = Date.now()
const res = await descriptor.settings.refreshModels({}, process.env)
console.log('refreshModels 返回（' + (Date.now() - t0) + 'ms）:')
console.log(JSON.stringify(res, null, 2))

const after = descriptor.settings.meta(process.env).fields.find((f) => f.key === 'defaultModel')
console.log('meta（拉取后）: options=' + after.options.length +
  ' | ' + after.note)
const wroteBack = res.ok && after.options.length === res.ids.length
console.log(wroteBack ? '✓ 成功并写回缓存（meta 无需再探测即命中）' : '✗ 未写回缓存 / 或本就失败')
process.exit(wroteBack || !res.ok ? 0 : 1)
