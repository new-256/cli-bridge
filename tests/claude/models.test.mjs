// tests/claude/models.test.mjs — 模型清单「服务端权威探测」语义（红线：不许静默降级）。
// 全部走 fixture 假 CLI（FAKE_CLAUDE_MODE 切换端点行为），不依赖本机真装了 claude。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PROBE_MODEL, parseSupportedModels, extractProbeIds, readConfiguredModels, probeArgv,
  probeSupportedModels, listAccountModels, resetModelsCache, readCachedModels, modelsCacheKey, MODELS_TTL_MS
} from '../../providers/claude-models.mjs'

const FIX = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))

function mkHome(envBlock) {
  const home = mkdtempSync(join(tmpdir(), 'clb-claude-home-'))
  if (envBlock) {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: envBlock }), 'utf8')
  }
  return home
}

test('PROBE_MODEL 与 probeArgv：参数集固定（json + 不落会话）', () => {
  assert.equal(PROBE_MODEL, '__clb_probe_invalid__')
  assert.deepEqual(probeArgv(), ['-p', 'hi', '--model', '__clb_probe_invalid__', '--output-format', 'json', '--no-session-persistence'])
})

test('parseSupportedModels：多种报文形态', () => {
  assert.deepEqual(parseSupportedModels('The supported API model names are a-1, b-2, but you passed zz.'), ['a-1', 'b-2'])
  assert.deepEqual(parseSupportedModels('the supported api model names are just-one.'), ['just-one'])
  // JSON 转义形态（CLI 把报文塞进 result 字符串时的真实样子）
  const escaped = JSON.stringify({ error: { message: 'The supported API model names are x-1, y-2, but you passed __clb_probe_invalid__.' } })
  assert.deepEqual(parseSupportedModels(escaped), ['x-1', 'y-2'])
  // 带点的模型名不能被句点切断
  assert.deepEqual(parseSupportedModels('The supported API model names are gpt-5.4, claude-opus-4.8, but you passed z.'), ['gpt-5.4', 'claude-opus-4.8'])
  assert.equal(parseSupportedModels(''), null)
  assert.equal(parseSupportedModels('The supported API model names are __clb_probe_invalid__.'), null)
})

test('extractProbeIds：从 result 事件的 result 字段里挖清单', () => {
  const line = JSON.stringify({
    type: 'result', is_error: true,
    result: 'API Error: 400 {"error":{"message":"The supported API model names are m1, m2, but you passed x."}}'
  })
  const got = extractProbeIds(line + '\n', '')
  assert.deepEqual(got.ids, ['m1', 'm2'])
  assert.equal(got.sawResult, true)
  assert.match(got.errorText, /API Error: 400/)
  // 无锚点 → ids null（调用方必须报错）
  const bad = extractProbeIds('{"type":"result","is_error":true,"result":"boom"}', '')
  assert.equal(bad.ids, null)
})

test('readConfiguredModels：只收 ANTHROPIC_*_MODEL 类键，且明确是别名映射', () => {
  const home = mkHome({
    ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-secret',
    ANTHROPIC_MODEL: 'pro[1M]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'pro[1M]',
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'flash',
    UNRELATED: 'nope'
  })
  try {
    const r = readConfiguredModels({ USERPROFILE: home })
    assert.equal(r.ok, true)
    assert.deepEqual(r.models.map((m) => m.id), ['pro[1M]', 'pro', 'flash'])
    assert.deepEqual(r.models.map((m) => m.key), ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'])
    assert.ok(!JSON.stringify(r).includes('sk-secret'), '凭据绝不进模型清单')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('readConfiguredModels：文件缺失 → ok:false + 错误（不抛）', () => {
  const home = mkHome(null)
  try {
    const r = readConfiguredModels({ USERPROFILE: home })
    assert.equal(r.ok, false)
    assert.match(r.error, /cannot read/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('probeSupportedModels：fixture 返回 400 → 权威清单（异步）', async () => {
  const r = await probeSupportedModels({ CLAUDE_BIN: FIX }, {})
  assert.equal(r.ok, true)
  assert.deepEqual(r.ids, ['fake-model-alpha', 'fake-model-beta'])
  assert.equal(r.mode, 'account-live')
})

test('probeSupportedModels：端点接受无效模型（拿不到权威清单）→ ok:false 并说明', async () => {
  const prev = process.env.FAKE_CLAUDE_MODE
  process.env.FAKE_CLAUDE_MODE = 'probe-accepts'
  try {
    const r = await probeSupportedModels({ CLAUDE_BIN: FIX }, {})
    assert.equal(r.ok, false)
    assert.deepEqual(r.ids, [])
    assert.match(r.error, /无法获取服务端权威模型清单/)
    assert.match(r.error, /未解析出可用模型清单/)
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_MODE
    else process.env.FAKE_CLAUDE_MODE = prev
  }
})

test('probeSupportedModels：可执行文件不存在 → ok:false（不是空数组成功）', async () => {
  const r = await probeSupportedModels({ CLAUDE_BIN: 'C:/nope/claude.mjs' }, {})
  assert.equal(r.ok, false)
  assert.equal(Array.isArray(r.ids), true)
  assert.equal(r.ids.length, 0)
  assert.match(r.error, /CLAUDE_BIN|设置面板|已尝试探测/)
})

test('probeSupportedModels：首个候选 spawn 失败时继续试下一个（error+close 双触发不得吃掉候选）', async () => {
  // 回归钉子：spawn 失败会同时触发 'error' 与 'close'，两个回调各推进一次候选指针
  // 就会把后面那个**能跑**的候选整个跳过 —— 表现为「binPath 填错 → 明明有 CLAUDE_BIN 也失败」。
  const r = await probeSupportedModels({ CLAUDE_BIN: FIX }, { binPath: 'C:/nope/dead-claude.mjs' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.exe, FIX)
  assert.deepEqual(r.ids, ['fake-model-alpha', 'fake-model-beta'])
})

test('readCachedModels：面板用的「纯读缓存」——没拉过 = null，拉过才命中，且不做任何探测', async () => {
  resetModelsCache()
  const env = { CLAUDE_BIN: FIX, USERPROFILE: '' }
  // ★ 这是「meta 不自动探测」的结构性保证：CLI 明明可探测，但缓存空 → 只返回 null，
  //   调用方（settings.meta）因此拿到空下拉，而不是被同步探测拖慢。
  assert.equal(readCachedModels(env, {}), null)
  const got = await listAccountModels(env, {})
  assert.equal(got.ok, true)
  const hit = readCachedModels(env, {})
  assert.deepEqual(hit.ids, ['fake-model-alpha', 'fake-model-beta'])
  assert.equal(hit.mode, 'account-live')
  assert.ok(hit.ageMs >= 0 && Number.isFinite(hit.ageMs))
  // 缓存键跟着可执行文件集合走（工具路径据此重探）；但面板读缓存允许跨键兜底 ——
  // 清单由 claude 自己 settings.json 的端点裁决，与走哪个候选 exe 无关（见函数注释）。
  assert.notEqual(modelsCacheKey(env, ''), modelsCacheKey({ CLAUDE_BIN: 'C:/nope/claude.exe' }, ''))
  assert.deepEqual(
    readCachedModels({ CLAUDE_BIN: 'C:/nope/claude.exe', USERPROFILE: '' }, {}).ids,
    ['fake-model-alpha', 'fake-model-beta']
  )
  // 返回的是副本：调用方改它不得污染缓存。
  hit.ids.push('injected')
  assert.deepEqual(readCachedModels(env, {}).ids, ['fake-model-alpha', 'fake-model-beta'])
  // 整个缓存为空时仍然是 null（绝不凭空造清单）。
  resetModelsCache()
  assert.equal(readCachedModels(env, {}), null)
})

test('listAccountModels：配置来源在前、服务端来源补充，各带 source 标注', async () => {
  resetModelsCache()
  const home = mkHome({ ANTHROPIC_MODEL: 'fake-model-alpha', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'not-supported-anywhere' })
  try {
    const r = await listAccountModels({ CLAUDE_BIN: FIX, USERPROFILE: home }, {})
    assert.equal(r.ok, true)
    // 两个来源都有效 → 合并标注。
    assert.equal(r.source, 'configured+account-live')
    // 配置来源在前（用户实际在用），服务端独有的补后，重复项去重。
    assert.deepEqual(r.models.map((m) => m.id), ['fake-model-alpha', 'not-supported-anywhere', 'fake-model-beta'])
    assert.equal(r.models[0].source, 'configured')
    assert.equal(r.models[0].configuredAs, 'ANTHROPIC_MODEL')
    assert.equal(r.models[2].source, 'account-live')
    assert.equal(r.models[2].configuredAs, null)
    // 服务端没报的名字仍可出现（配置来源），但**必须**标成 configured ——
    // 这是红线的当前形态：允许出现，绝不冒充服务端权威。
    const odd = r.models.find((m) => m.id === 'not-supported-anywhere')
    assert.ok(odd, 'configured model must be listed')
    assert.equal(odd.source, 'configured', 'must NOT impersonate account-live')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('listAccountModels：无配置且探测失败 → ok:false + 可操作错误（绝不返回空清单当成功）', async () => {
  resetModelsCache()
  // USERPROFILE 指向不存在的目录 → 没有 configured 来源；probe 也失败 → 无任何来源。
  const r = await listAccountModels({ CLAUDE_BIN: 'C:/nope/claude.exe', USERPROFILE: 'X:\\__no_home__' }, {})
  assert.equal(r.ok, false)
  assert.deepEqual(r.models, [])
  assert.equal(r.count, 0)
  assert.ok(String(r.error).length > 20, 'error must be actionable')
  assert.equal(r.source, 'none')
  resetModelsCache()
})

test('listAccountModels：TTL 缓存命中（第二次不再起进程），refresh 强制重探', async () => {
  resetModelsCache()
  const env = { CLAUDE_BIN: FIX, USERPROFILE: '' }
  const t0 = Date.now()
  const a = await listAccountModels(env, {})
  const firstMs = Date.now() - t0
  assert.equal(a.ok, true)
  const t1 = Date.now()
  const b = await listAccountModels(env, {})
  const secondMs = Date.now() - t1
  assert.deepEqual(b.models.map((m) => m.id), a.models.map((m) => m.id))
  assert.ok(secondMs < firstMs, 'cached call must be faster (first=' + firstMs + 'ms, second=' + secondMs + 'ms)')
  const c = await listAccountModels(env, { refresh: true })
  assert.equal(c.ok, true)
  assert.ok(MODELS_TTL_MS >= 60000, 'TTL 至少 1 分钟（面板每次渲染都会取）')
})
