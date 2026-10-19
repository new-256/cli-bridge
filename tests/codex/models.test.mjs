// tests/codex/models.test.mjs — codex 事实层：配置发现 / 三层模型清单 / codex_models 工具。
//
// 红线（用户明确要求，本仓铁律）：
//   ① 拿不到实时清单必须 ok:false + 可操作错误；
//   ② 绝不把 catalog/builtin 冒充成 live，也绝不静默返回空数组；
//   ③ 清单项必须带 source。
// 这里逐条钉死，包括「0 个模型也算失败」这种容易被写松的分支。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  codexParseToml, codexReadConfig, codexModelsEndpoint, codexExeCandidates, codexResolveExePrefix,
  codexHomeDir, codexNormalizeModelItem, codexParseModelsPayload,
  codexCatalogModels, codexBuiltinModels, codexLiveModels,
  codexCachedModelOptions, codexCachedLiveModels
} from '../../providers/codex-cli.mjs'
import { codexModelsTool } from '../../providers/codex-models.mjs'
import { materializeCodexHome } from './helpers/fixture-home.mjs'

// 临时 CODEX_HOME（fake-auth.json → auth.json，见 helper 头注的发布安全红线）。
const HOME = materializeCodexHome()
const FIX_HOME = HOME.home
const fixtureEnv = (extra) => Object.assign({ CODEX_HOME: FIX_HOME, USERPROFILE: 'C:/Users/fixture' }, extra || {})

// 假 fetch（异步注入点）：记录调用次数，回放给定响应。
function fakeFetch(response, counter) {
  return async () => {
    if (counter) counter.calls += 1
    return {
      status: response.status,
      text: async () => (typeof response.body === 'string' ? response.body : JSON.stringify(response.body))
    }
  }
}

const LIVE_PAYLOAD = {
  data: [
    { id: 'fixture/free-model:free', name: 'Fixture Free', pricing: { prompt: '0', completion: '0' }, context_length: 128000 },
    { id: 'fixture/paid-model', name: 'Fixture Paid', pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 256000 },
    { id: 'fixture/zero-priced', name: 'Zero Priced', pricing: { prompt: 0, completion: 0 } }
  ]
}

// ── config.toml 最小解析 ─────────────────────────────────────────────────────
test('codexParseToml：字符串标量 + 表头；数组/布尔/数字一律跳过', () => {
  const toml = [
    '# comment',
    'model = "a/b:c"',
    "model_provider = 'custom'",
    'approval_policy = "never"',
    'notify = [ "C:\\\\x.exe", "turn-ended" ]',
    'some_bool = true',
    'some_num = 42',
    '',
    '[model_providers.custom]',
    'base_url = "https://example.test/api/v1"',
    'experimental_bearer_token = "tok-\\"quoted\\""',
    '',
    '[model_providers.custom.env]',
    'NESTED = "yes"'
  ].join('\n')
  const p = codexParseToml(toml)
  assert.equal(p.top.model, 'a/b:c')
  assert.equal(p.top.model_provider, 'custom')
  assert.equal(p.top.notify, undefined, 'array values are skipped')
  assert.equal(p.top.some_bool, undefined)
  assert.equal(p.top.some_num, undefined)
  assert.equal(p.tables['model_providers.custom'].base_url, 'https://example.test/api/v1')
  assert.equal(p.tables['model_providers.custom'].experimental_bearer_token, 'tok-"quoted"')
  assert.equal(p.tables['model_providers.custom.env'].NESTED, 'yes')
})

test('codexParseToml：空/畸形输入返回空表（不抛）', () => {
  // 解析结果用 null-prototype 对象（防 __proto__ 之类的键污染原型），故按 keys 断言。
  assert.deepEqual(Object.keys(codexParseToml('').top), [])
  assert.deepEqual(Object.keys(codexParseToml(null).top), [])
  assert.deepEqual(Object.keys(codexParseToml('garbage line without equals').top), [])
})

// ── 配置发现 ────────────────────────────────────────────────────────────────
test('codexHomeDir：CODEX_HOME 优先，否则 USERPROFILE/.codex', () => {
  assert.equal(codexHomeDir({ CODEX_HOME: 'C:/h' }), 'C:/h')
  assert.match(codexHomeDir({ USERPROFILE: 'C:/Users/u' }).replace(/\\/g, '/'), /C:\/Users\/u\/\.codex/)
  assert.equal(codexHomeDir({}), '')
})

test('codexReadConfig：从 CODEX_HOME 读到 provider/base_url/token/model/catalog', () => {
  const cfg = codexReadConfig(fixtureEnv())
  assert.equal(cfg.configFound, true)
  assert.equal(cfg.providerName, 'custom')
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:9/api/v1')
  assert.equal(cfg.token, 'fixture-token-not-a-secret')
  assert.equal(cfg.model, 'fixture/model-one')
  assert.equal(cfg.catalogFile, 'cc-switch-model-catalog.json')
  assert.equal(cfg.authFound, true)
})

test('codexReadConfig：只有 auth.json 时用 OPENAI_BASE_URL / OPENAI_API_KEY 兜底', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-authonly-'))
  try {
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://auth.test/v1' }), 'utf8')
    const cfg = codexReadConfig({ CODEX_HOME: home })
    assert.equal(cfg.configFound, false)
    assert.equal(cfg.baseUrl, 'https://auth.test/v1')
    assert.equal(cfg.token, 'k')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('codexModelsEndpoint：base_url + /models；显式覆盖支持完整 URL', () => {
  const ep = codexModelsEndpoint(fixtureEnv())
  assert.equal(ep.ok, true)
  assert.equal(ep.url, 'http://127.0.0.1:9/api/v1/models')
  const full = codexModelsEndpoint(fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://x.test/custom/models' }))
  assert.equal(full.url, 'https://x.test/custom/models')
  const base = codexModelsEndpoint(fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://x.test/custom/v2/' }))
  assert.equal(base.url, 'https://x.test/custom/v2/models')
})

test('codexModelsEndpoint：无 base_url 时明确失败并解释为什么只能走 HTTP', () => {
  const ep = codexModelsEndpoint({ CODEX_HOME: 'C:/definitely/not/here' })
  assert.equal(ep.ok, false)
  assert.match(ep.error, /base_url/)
  assert.match(ep.error, /config\.toml not found/)
  assert.match(ep.error, /no `models` subcommand/)
})

test('可执行候选：CODEX_BIN > CODEX_CLI > CODEX_CLI_PATH > PATH 名；.mjs 经 node 包装', () => {
  assert.deepEqual(codexExeCandidates({ CODEX_CLI: 'c2', CODEX_BIN: 'c1' }), ['c1', 'c2', 'codex'])
  assert.deepEqual(codexExeCandidates({}), ['codex'])
  const pref = codexResolveExePrefix({}, 'C:/fake/fake-codex.mjs')
  assert.equal(pref.length, 2)
  assert.ok(String(pref[0]).length > 0)
  assert.equal(pref[1], 'C:/fake/fake-codex.mjs')
  assert.deepEqual(codexResolveExePrefix({ CODEX_BIN: 'codex.exe' }, ''), ['codex.exe'])
})

// ── 载荷归一 ────────────────────────────────────────────────────────────────
test('codexNormalizeModelItem：id/name/free/contextWindow/visibility 归一', () => {
  assert.equal(codexNormalizeModelItem(null, 'live'), null)
  assert.equal(codexNormalizeModelItem({}, 'live'), null)
  const a = codexNormalizeModelItem({ id: 'x/y:free', pricing: { prompt: '0' } }, 'live')
  assert.equal(a.id, 'x/y:free')
  assert.equal(a.free, true)
  assert.equal(a.source, 'live')
  assert.equal(a.contextWindow, null)
  const b = codexNormalizeModelItem({ slug: 's', display_name: 'D', context_window: 1000, visibility: 'list' }, 'catalog')
  assert.deepEqual({ id: b.id, name: b.name, ctx: b.contextWindow, vis: b.visibility, src: b.source }, { id: 's', name: 'D', ctx: 1000, vis: 'list', src: 'catalog' })
})

test('codexParseModelsPayload：data/models 两种载荷；visibility 非 list 计入 hidden', () => {
  const fromData = codexParseModelsPayload(JSON.stringify(LIVE_PAYLOAD), 'live')
  assert.equal(fromData.ok, true)
  assert.equal(fromData.models.length, 3)
  const withHidden = codexParseModelsPayload(JSON.stringify({ models: [{ slug: 'a' }, { slug: 'b', visibility: 'hide' }] }), 'builtin')
  assert.equal(withHidden.models.length, 1)
  assert.equal(withHidden.hidden, 1)
  assert.equal(withHidden.total, 2)
  const bad = codexParseModelsPayload('not json', 'live')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /not JSON/)
  const wrongShape = codexParseModelsPayload('{"foo":1}', 'live')
  assert.equal(wrongShape.ok, false)
  assert.match(wrongShape.error, /neither \.data nor \.models/)
})

// ── B / C 层（本地）────────────────────────────────────────────────────────
test('codexCatalogModels：读 config 指向的目录，隐藏项被剔除，带 source/file', () => {
  const res = codexCatalogModels(fixtureEnv())
  assert.equal(res.ok, true)
  assert.equal(res.source, 'catalog')
  assert.equal(res.count, 2)
  assert.deepEqual(res.models.map((m) => m.id), ['fixture/free-model:free', 'fixture/paid-model'])
  assert.match(String(res.file).replace(/\\/g, '/'), /cc-switch-model-catalog\.json$/)
  assert.ok(res.models.every((m) => m.source === 'catalog'))
})

test('codexCatalogModels：缺 model_catalog_json / 文件不可读 → ok:false', () => {
  const noKey = codexCatalogModels({ CODEX_HOME: 'C:/nope' })
  assert.equal(noKey.ok, false)
  assert.match(noKey.error, /model_catalog_json/)
  const home = mkdtempSync(join(tmpdir(), 'codex-home-nocat-'))
  try {
    writeFileSync(join(home, 'config.toml'), 'model_catalog_json = "missing.json"\n', 'utf8')
    const missing = codexCatalogModels({ CODEX_HOME: home })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /not readable/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('codexBuiltinModels：读 ~/.codex/models.json', () => {
  const res = codexBuiltinModels(fixtureEnv())
  assert.equal(res.ok, true)
  assert.equal(res.source, 'builtin')
  assert.deepEqual(res.models.map((m) => m.id), ['builtin/one', 'builtin/two'])
  const none = codexBuiltinModels({ CODEX_HOME: 'C:/nope' })
  assert.equal(none.ok, false)
  assert.match(none.error, /not readable/)
})

// ── A 层（实时）────────────────────────────────────────────────────────────
test('codexLiveModels：200 载荷 → ok/source=live/free 标记/数量', async () => {
  const counter = { calls: 0 }
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://live.test/a/models' })
  const res = await codexLiveModels(env, { fetch: fakeFetch({ status: 200, body: LIVE_PAYLOAD }, counter) })
  assert.equal(res.ok, true)
  assert.equal(res.source, 'live')
  assert.equal(res.count, 3)
  assert.equal(res.url, 'https://live.test/a/models')
  assert.deepEqual(res.models.filter((m) => m.free).map((m) => m.id), ['fixture/free-model:free', 'fixture/zero-priced'])
  assert.equal(counter.calls, 1)
  // 5 分钟缓存：第二次不再打网络。
  const again = await codexLiveModels(env, { fetch: fakeFetch({ status: 200, body: LIVE_PAYLOAD }, counter) })
  assert.equal(again.count, 3)
  assert.equal(counter.calls, 1, 'cached: no second fetch')
  // refresh 强制重取。
  await codexLiveModels(env, { fetch: fakeFetch({ status: 200, body: LIVE_PAYLOAD }, counter), refresh: true })
  assert.equal(counter.calls, 2)
  assert.ok(codexCachedLiveModels(env), 'cache readable synchronously')
})

test('codexLiveModels：HTTP 401 → ok:false + 指向凭据位置的错误', async () => {
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://live.test/unauthorized/models' })
  const res = await codexLiveModels(env, { fetch: fakeFetch({ status: 401, body: '{"error":"no key"}' }) })
  assert.equal(res.ok, false)
  assert.match(res.error, /HTTP 401/)
  assert.match(res.error, /experimental_bearer_token/)
})

test('codexLiveModels：0 个模型也算失败（绝不把空列表当权威）', async () => {
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://live.test/empty/models' })
  const res = await codexLiveModels(env, { fetch: fakeFetch({ status: 200, body: { data: [] } }) })
  assert.equal(res.ok, false)
  assert.match(res.error, /0 usable models/)
  assert.match(res.error, /Refusing to report an empty list/)
})

test('codexLiveModels：畸形载荷 → ok:false（不猜）', async () => {
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://live.test/garbage/models' })
  const res = await codexLiveModels(env, { fetch: fakeFetch({ status: 200, body: '<html>nope</html>' }) })
  assert.equal(res.ok, false)
  assert.match(res.error, /not JSON/)
})

test('codexLiveModels：无 fetch 能力 → ok:false 并指引显式选择本地层', async () => {
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://live.test/nofetch/models' })
  // 模拟「沙箱里没有 fetch」：临时摘掉全局 fetch（注入点传 null 时才会回落到它）。
  const saved = globalThis.fetch
  globalThis.fetch = undefined
  try {
    const res = await codexLiveModels(env, { fetch: null })
    assert.equal(res.ok, false)
    assert.match(res.error, /no fetch capability/)
    assert.match(res.error, /source="catalog"/)
  } finally { globalThis.fetch = saved }
})

test('codexLiveModels：无 base_url → 直接失败（不发请求）', async () => {
  const env = { CODEX_HOME: 'C:/nope' }
  const res = await codexLiveModels(env, { fetch: fakeFetch({ status: 200, body: LIVE_PAYLOAD }) })
  assert.equal(res.ok, false)
  assert.match(res.error, /base_url/)
})

test('codexLiveModels：端点卡住时按时中止（面板点「拉取」不会一直转圈）', async () => {
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://slow.test/stuck/models' })
  const stuck = (url, init) => new Promise((resolve, reject) => {
    if (init && init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted by timeout')))
  })
  const t0 = Date.now()
  const res = await codexLiveModels(env, { fetch: stuck, timeoutMs: 2000 })
  assert.equal(res.ok, false)
  assert.equal(res.source, 'live')
  assert.match(res.error, /timeout 2000ms/)
  assert.ok(Date.now() - t0 < 15000, 'abort must fire near the requested timeout')
})

// ── 面板候选池（契约 §3.2：纯读缓存，绝不探测）────────────────────────────────
test('codexCachedModelOptions：未拉取 → 空候选 + 「点按钮拉取」说明（不做任何探测）', () => {
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'http://127.0.0.1:9/cache-none/models' })
  const opts = codexCachedModelOptions(env)
  assert.deepEqual(opts.options, [])
  assert.equal(opts.source, 'none')
  assert.match(opts.note, /拉取可用模型/)
  assert.match(opts.note, /还没拉取过/)
})

test('codexCachedModelOptions：live 拉取成功后命中缓存 → 候选带 [free] 标注与来源说明', async () => {
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://cache.test/hit/models' })
  await codexLiveModels(env, { fetch: fakeFetch({ status: 200, body: LIVE_PAYLOAD }) })
  const opts = codexCachedModelOptions(env)
  assert.equal(opts.source, 'live')
  assert.equal(opts.count, 3)
  assert.deepEqual(opts.options.map((o) => o.value), ['fixture/free-model:free', 'fixture/paid-model', 'fixture/zero-priced'])
  assert.match(opts.options[0].label, /\[free\]/)
  assert.equal(opts.options[1].label, 'fixture/paid-model')
  assert.match(opts.note, /上次拉取到 3 个模型/)
})

test('codexCachedModelOptions：本地目录/内置定义再齐全也不许填进面板下拉（非权威≠实时）', () => {
  // 前提：该 fixture CODEX_HOME 的 catalog 与 builtin 都可读。
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://cache.test/miss/models' })
  assert.equal(codexCatalogModels(env).ok, true)
  assert.equal(codexBuiltinModels(env).ok, true)
  // 但 live 缓存为空 ⇒ 面板下拉必须是空的（宁可空着，也不展示可能过时的本地目录）。
  assert.deepEqual(codexCachedModelOptions(env).options, [])
})

// ── codex_models 工具（三形态共用逻辑）──────────────────────────────────────
function toolFor(env, fetchImpl) {
  return codexModelsTool({ env, deps: { fetch: fetchImpl } })
}

test('codex_models：live 成功 → 结果带 source/url/count，freeOnly 过滤生效', async () => {
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://tool.test/live/models' })
  const tool = toolFor(env, fakeFetch({ status: 200, body: LIVE_PAYLOAD }))
  const all = await tool.logic({})
  assert.equal(all.ok, true)
  assert.equal(all.source, 'live')
  assert.equal(all.count, 3)
  assert.equal(all.url, 'https://tool.test/live/models')
  assert.ok(all.models.every((m) => m.source === 'live'))
  const free = await tool.logic({ freeOnly: true })
  assert.equal(free.count, 2)
  assert.ok(free.models.every((m) => m.free))
})

test('codex_models：filter 命中/未命中语义（未命中是过滤结果，不是空清单）', async () => {
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://tool.test/filter/models' })
  const tool = toolFor(env, fakeFetch({ status: 200, body: LIVE_PAYLOAD }))
  const hit = await tool.logic({ filter: 'paid' })
  assert.equal(hit.count, 1)
  assert.equal(hit.models[0].id, 'fixture/paid-model')
  const miss = await tool.logic({ filter: 'nothing-matches' })
  assert.equal(miss.ok, false)
  assert.match(miss.error, /empty \*filter result\*/)
})

test('codex_models：limit 截断但报全量 matched 数', async () => {
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://tool.test/limit/models' })
  const tool = toolFor(env, fakeFetch({ status: 200, body: LIVE_PAYLOAD }))
  const out = await tool.logic({ limit: 1 })
  assert.equal(out.models.length, 1)
  assert.equal(out.count, 3)
  assert.equal(out.truncated, true)
  assert.match(out.note, /showing 1 of 3/)
})

test('codex_models：source=catalog / builtin 明确标注来源', async () => {
  const env = fixtureEnv()
  const cat = await toolFor(env).logic({ source: 'catalog' })
  assert.equal(cat.ok, true)
  assert.equal(cat.source, 'catalog')
  assert.ok(cat.file)
  assert.equal(cat.count, 2)
  const builtin = await toolFor(env).logic({ source: 'builtin' })
  assert.equal(builtin.ok, true)
  assert.equal(builtin.source, 'builtin')
  assert.equal(builtin.count, 2)
})

test('codex_models：live 失败时错误里给出「可显式查本地层」的出路', async () => {
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://tool.test/down/models' })
  const tool = toolFor(env, fakeFetch({ status: 503, body: 'upstream down' }))
  const res = await tool.logic({})
  assert.equal(res.ok, false)
  assert.match(res.error, /HTTP 503/)
  assert.match(res.error, /source="catalog"/)
  assert.match(res.error, /non-authoritative/)
})

test('codex_models.render：成功/失败两态都可读', async () => {
  const env = fixtureEnv({ CODEX_BRIDGE_MODELS_URL: 'https://tool.test/render/models' })
  const tool = toolFor(env, fakeFetch({ status: 200, body: LIVE_PAYLOAD }))
  const ok = await tool.logic({})
  const okText = tool.render({}, ok)[0].text
  assert.match(okText, /codex models \[live\] \(3 matched/)
  assert.match(okText, /source: live — https:\/\/tool\.test\/render\/models/)
  const badText = tool.render({}, { ok: false, error: 'boom' })[0].text
  assert.match(badText, /codex_models failed: boom/)
})

test('cleanup', () => { HOME.cleanup() })
