// providers/codex-models.mjs — codex_models 工具定义（纯逻辑）。
//
// 从 providers/codex.mjs 再拆出：两个文件都要留在 600 物理行红线内（规则 §26）。
// scripts/build.mjs 会把 providers/codex-*.mjs 全部内联进 dynamic 沙箱的同一作用域，
// 所以沙箱里 codexCl* 系列函数天然可见；ESM 形态走本文件的 import。
// ⚠️ 注释里绝不写出占位标记字面量（build 全局替换会劈开注释 → 生成物语法崩）。
//
// 红线（用户明确要求，本仓铁律）：拿不到实时清单必须 ok:false + 可操作错误。
// 绝不把 catalog/builtin 冒充成 live，也绝不静默返回空数组。清单项必须带 source。

import { codexLiveModels, codexCatalogModels, codexBuiltinModels } from './codex-cli.mjs'

const MODELS_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    source: {
      type: 'string',
      enum: ['live', 'catalog', 'builtin'],
      description: 'Which layer to read. live = GET {base_url}/models from the provider API configured in ~/.codex/config.toml — the only authoritative list. catalog = the file named by config.toml model_catalog_json. builtin = ~/.codex/models.json. Local layers are codex-local metadata, NOT a claim about what the server will accept.'
    },
    filter: { type: 'string', description: 'Optional case-insensitive substring filter on model id/name (e.g. "minimax" or "free").' },
    freeOnly: { type: 'boolean', description: 'Return only models that look free (:free suffix or pricing.prompt == 0).' },
    limit: { type: 'integer', description: 'Max models to return (default 80, 1-1000). The result always reports the full match count.' },
    refresh: { type: 'boolean', description: 'Bypass the 5-minute live cache and re-fetch.' }
  }
}

const MODELS_DESCRIPTION = 'List the models the local codex CLI can actually use, with the source of every id made explicit. Default source=live performs GET {base_url}/models against the provider endpoint configured in ~/.codex/config.toml (base_url + experimental_bearer_token, else auth.json OPENAI_BASE_URL/OPENAI_API_KEY) — codex-cli has no `models` subcommand and probing with an invalid model id does NOT print a roster, so this HTTP call is the only authoritative source. If it cannot be read, this tool returns ok:false with an actionable error and never invents or silently downgrades the list; pass source="catalog"/"builtin" only when you deliberately want the local (non-authoritative) catalog. Use this before codex_run when the model id matters, and prefer free models (:free / pricing 0) for routine work.'

function renderModels(args, value) {
  const v = value || {}
  if (!v.ok) return [{ type: 'text', text: 'codex_models failed: ' + String(v.error || 'unknown') }]
  const list = Array.isArray(v.models) ? v.models : []
  const lines = ['codex models [' + (v.source || '?') + '] (' + (v.count != null ? v.count : list.length) + ' matched' + (v.truncated ? ', showing ' + list.length : '') + '):']
  for (const m of list.slice(0, 60)) {
    const bits = []
    if (m.free) bits.push('free')
    if (m.contextWindow) bits.push(Math.round(m.contextWindow / 1000) + 'k ctx')
    lines.push('  ' + m.id + (bits.length ? '  [' + bits.join(',') + ']' : ''))
  }
  if (list.length > 60) lines.push('  … and ' + (list.length - 60) + ' more')
  if (v.source === 'live') lines.push('source: live — ' + String(v.url || ''))
  else lines.push('source: ' + String(v.source || '') + ' — ' + String(v.file || '') + ' (local, NOT authoritative for the server)')
  if (v.note) lines.push('note: ' + v.note)
  return [{ type: 'text', text: lines.join('\n') }]
}

function modelsErrorHint(source, extra) {
  const base = String(extra || 'unknown')
  if (source !== 'live') return base
  return base + ' — pass source="catalog" or source="builtin" to inspect the local, non-authoritative lists, or fix the endpoint/credential above and retry.'
}

/**
 * codex_models 工具定义。
 * @param {{env?:object, deps?:object}} ctx env 用来定位 CODEX_HOME；deps.fetch 可注入。
 */
export function codexModelsTool(ctx) {
  const c = ctx || {}
  const env = c.env || {}
  const deps = c.deps || {}
  return {
    name: 'codex_models',
    description: MODELS_DESCRIPTION,
    inputSchema: MODELS_PARAMS,
    render: renderModels,
    async logic(args) {
      const a = args || {}
      const source = a.source || 'live'
      let res
      if (source === 'live') res = await codexLiveModels(env, { fetch: deps.fetch, refresh: a.refresh === true })
      else if (source === 'catalog') res = codexCatalogModels(env)
      else if (source === 'builtin') res = codexBuiltinModels(env)
      else return { ok: false, source, models: [], error: 'unknown source ' + JSON.stringify(String(source)) + ' (use live|catalog|builtin)' }

      if (!res.ok || !Array.isArray(res.models) || !res.models.length) {
        return { ok: false, source, models: [], error: modelsErrorHint(source, res.error) }
      }
      let list = res.models
      if (a.filter) {
        const q = String(a.filter).toLowerCase()
        list = list.filter((m) => String(m.id).toLowerCase().indexOf(q) >= 0 || String(m.name || '').toLowerCase().indexOf(q) >= 0)
      }
      if (a.freeOnly) list = list.filter((m) => m.free)
      if (!list.length) {
        return { ok: false, source, models: [], error: 'no models matched filter=' + JSON.stringify(String(a.filter || '')) + ' freeOnly=' + String(a.freeOnly === true) + ' on source=' + source + ' (that is an empty *filter result*, not an empty provider list)' }
      }
      const limit = Number.isFinite(Number(a.limit)) ? Math.max(1, Math.min(Math.floor(Number(a.limit)), 1000)) : 80
      const matched = list.length
      const truncated = matched > limit
      const models = list.slice(0, limit)
      const out = {
        ok: true, source,
        models, count: matched, truncated,
        freeCount: res.models.filter((m) => m.free).length
      }
      if (res.url) out.url = res.url
      if (res.file) out.file = res.file
      if (res.providerName) out.providerName = res.providerName
      if (res.fetchedAt) out.fetchedAt = res.fetchedAt
      if (truncated) out.note = 'showing ' + limit + ' of ' + matched + ' matched models; raise limit or narrow with filter/freeOnly.'
      return out
    }
  }
}
