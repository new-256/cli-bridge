// providers/codebuddy-models-tool.mjs — codebuddy_models 工具定义（纯逻辑）。
//
// 从 codebuddy-catalog.mjs 再拆出：两个文件都要留在 600 行红线内（规则 §26）。
// scripts/build.mjs 会把 providers/codebuddy-*.mjs 全部内联进 dynamic 沙箱的同一个
// 作用域，所以这里仍可引用 catalog 的函数（沙箱内天然可见）；ESM 形态走本文件的 import。
// ⚠️ 注释里绝不写出口令标记字面量（build 全局替换会劈开注释 → 生成物语法崩）。

import { currentPreferredBackend, probeAccountModels, fetchHelpModelsSync } from './codebuddy-models-source.mjs'

// ── codebuddy_models 工具定义（搬自主文件；纯逻辑，依赖经 ctx 注入）────────────
// ctx = { env, deps, resolveBackend, modelCatalogDetailed, getAccountCatalog }
export function codebuddyModelsTool(ctx) {
  const c = ctx || {}
  const deps = c.deps || {}
  const env = c.env || {}
  return {
      name: 'codebuddy_models',
      description: 'List the models the local codebuddy CLI can use for a given backend, read LIVE from the CLI. Primary source: an account probe (runs the CLI with a deliberately invalid model id, which makes the server print "Currently supported models for your account") — this is the authoritative licensed list for THIS account. If that face is not logged in, it falls back to the roster the installed CLI declares in --help and says so in the source field. Credit multipliers (x0.00 = free) come from the product descriptor as metadata. Returns ok:false with an actionable error when no live roster can be read — it never presents a frozen static table as if it were live.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: [],
        properties: {
          backend: { type: 'string', enum: c.BACKEND_ENUM, description: 'Which product face to list (default: the preferred backend).' },
          freeOnly: { type: 'boolean', description: 'Return only x0.00 (free) models.' },
          authorizedOnly: { type: 'boolean', description: 'Return only ids the current account is licensed for (harvested from a prior run).' }
        }
      },
      render: (args, value) => {
        const v = value || {}
        if (!v.ok) return [{ type: 'text', text: 'codebuddy_models failed: ' + String(v.error || 'unknown') }]
        const list = Array.isArray(v.models) ? v.models : []
        if (!list.length) return [{ type: 'text', text: 'codebuddy_models: no models matched (backend=' + (v.backend || '?') + ')' }]
        const lines = ['codebuddy models [' + v.backend + '] (' + list.length + '):']
        for (const m of list.slice(0, 40)) {
          const flags = []
          if (m.authorized) flags.push('authorized')
          if (m.credits === 0) flags.push('free')
          lines.push('  ' + m.id + (m.creditLabel ? '  ' + m.creditLabel : '') + (flags.length ? '  [' + flags.join(',') + ']' : ''))
        }
        if (list.length > 40) lines.push('  … and ' + (list.length - 40) + ' more')
        // 只有一种来源：账号实时（服务端裁决）。不再有 cli-help 兜底分支，
        // 因为 CLI 的 --help 名册实测会滞后服务端并含已废弃 id。
        lines.push('source: account-live (authoritative for this account)')
        if (v.note) lines.push('note: ' + v.note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      async logic(args) {
        const a = args || {}
        const preferred = currentPreferredBackend() || (deps.settings && deps.settings.preferredBackend) || null
        const backend = c.normalizeBackend(a.backend) || c.resolveBackend({}, null, preferred)

        // ① 账号实时（最权威，对照 workbuddy-auth 的 agents[cli] 白名单语义）。
        //    该面未登录/无 token 时探测会失败 —— 失败就**明确降级到 CLI 名册并标注**，
        //    绝不把静态表冒充成账号可用清单。
        const extraEnv = (c.faceEnv && c.faceEnv(backend)) || {}
        const probe = await probeAccountModels(env, { envExtra: extraEnv, timeoutMs: a.timeoutMs })

        // 唯一权威源 = 账号探测（服务端裁决）。**不再回落 CLI `--help` 名册**：
        // 实测 CLI 2.167.0 的 help 文本本身就过时（18 项、含已废弃的 minimax-m3 /
        // kimi-k3-1、缺 3 个真实模型），拿它兜底等于把错误清单当结果交付。
        // 探测失败就明确失败，并附上「CLI 声明了 N 项」作为诊断线索（只作提示，不展示
        // 那些 id），符合红线：开发期禁止静默降级。
        if (!probe.ok || !probe.ids || !probe.ids.length) {
          let hint = ''
          try {
            const help = fetchHelpModelsSync(env, { timeoutMs: a.timeoutMs })
            if (help.ok && help.ids.length) {
              hint = ' The installed CLI declares ' + help.ids.length + ' models via --help, but that roster is a static ' +
                'build-time list and has been observed to lag the server (it can contain retired ids). It is NOT shown here ' +
                'because it is not authoritative for this account.'
            }
          } catch (e) { }
          return {
            ok: false, backend,
            error: 'no account model roster for backend "' + backend + '": ' + String(probe.error || 'probe failed') +
              '. Make sure this product face is logged in (run the codebuddy CLI and complete login), or set CODEBUDDY_BIN ' +
              'to the right executable, then retry.' + hint
          }
        }
        const ids = probe.ids
        const source = 'account-live'

        // ③ 倍率/授权元数据（来自描述文件；仅作标注，不参与「是否可用」判定）。
        let detail = []
        try { detail = c.modelCatalogDetailed(backend, { env, accountModels: ids }) || [] } catch (e) { detail = [] }
        const byId = new Map(detail.map((x) => [x.id, x]))
        let list = ids.map((id) => {
          const d = byId.get(id)
          return {
            id,
            authorized: d ? !!d.authorized : (source === 'account-live'),
            credits: d && typeof d.credits === 'number' ? d.credits : null,
            creditLabel: (d && (d.creditLabel || d.label)) || '',
            label: (d && d.label) || id
          }
        })
        if (a.authorizedOnly) list = list.filter((m) => m.authorized)
        if (a.freeOnly) list = list.filter((m) => m.credits === 0)
        return {
          ok: true, backend, models: list, count: list.length,
          source, note: (typeof note !== 'undefined' ? note : undefined),
          probedAt: Date.now()
        }
      }
  }
}

