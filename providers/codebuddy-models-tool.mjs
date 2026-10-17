// providers/codebuddy-models-tool.mjs — codebuddy_models 工具定义（纯逻辑）。
//
// 从 codebuddy-catalog.mjs 再拆出：两个文件都要留在 600 行红线内（规则 §26）。
// scripts/build.mjs 会把 providers/codebuddy-*.mjs 全部内联进 dynamic 沙箱的同一个
// 作用域，所以这里仍可引用 catalog 的函数（沙箱内天然可见）；ESM 形态走本文件的 import。
// ⚠️ 注释里绝不写出口令标记字面量（build 全局替换会劈开注释 → 生成物语法崩）。

import { currentPreferredBackend, probeAccountModels, fetchHelpModelsSync } from './codebuddy-catalog.mjs'

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
        const srcLabel = v.source === 'account-live'
          ? 'account-live (authoritative for this account)'
          : 'cli-help (installed CLI roster, not the licensed subset)'
        lines.push('source: ' + srcLabel)
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
        let ids = null
        let source = null
        let note = ''
        if (probe.ok && probe.ids.length) {
          ids = probe.ids
          source = 'account-live'
        } else {
          // ② CLI 声明的 roster（零网络，随 CLI 版本更新）。
          const help = fetchHelpModelsSync(env, { timeoutMs: a.timeoutMs })
          if (help.ok && help.ids.length) {
            ids = help.ids
            source = 'cli-help'
            note = 'account probe unavailable (' + String(probe.error || 'not logged in for this face') +
              '); showing the roster the installed CLI declares. It reflects the CLI version, not the licensed subset of this account.'
          }
        }
        if (!ids || !ids.length) {
          return {
            ok: false, backend,
            error: 'no live model roster could be read for backend "' + backend + '". ' +
              'Account probe: ' + String(probe.error || 'failed') + '. ' +
              'Install/fix the codebuddy CLI (CODEBUDDY_BIN) and make sure this face is logged in, then retry.'
          }
        }

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
          source, note: note || undefined,
          probedAt: Date.now()
        }
      }
  }
}

