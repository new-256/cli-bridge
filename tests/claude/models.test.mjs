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
  probeSupportedModels, probeSupportedModelsSync, listAccountModels, resetModelsCache, MODELS_TTL_MS
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

test('probeSupportedModelsSync：面板用的同步探测同样解析 400 报文', () => {
  const r = probeSupportedModelsSync({ CLAUDE_BIN: FIX }, {})
  assert.equal(r.ok, true)
  assert.deepEqual(r.ids, ['fake-model-alpha', 'fake-model-beta'])
})

test('listAccountModels：成功时 models 来自服务端，configuredAs 只是标注', async () => {
  resetModelsCache()
  const home = mkHome({ ANTHROPIC_MODEL: 'fake-model-alpha', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'not-supported-anywhere' })
  try {
    const r = await listAccountModels({ CLAUDE_BIN: FIX, USERPROFILE: home }, {})
    assert.equal(r.ok, true)
    assert.equal(r.source, 'account-live')
    assert.deepEqual(r.models.map((m) => m.id), ['fake-model-alpha', 'fake-model-beta'])
    assert.equal(r.models[0].configuredAs, 'ANTHROPIC_MODEL')
    assert.equal(r.models[1].configuredAs, null)
    // 配置里那个「服务端不支持」的名字绝不能出现在 models 里。
    assert.ok(!r.models.some((m) => m.id === 'not-supported-anywhere'))
    // 但它作为诊断线索保留（并注明非权威）。
    assert.ok(r.diagnostic.configured.some((m) => m.id === 'not-supported-anywhere'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('listAccountModels：探测失败 → ok:false + 配置线索（绝不当成可用清单返回）', async () => {
  resetModelsCache()
  const home = mkHome({ ANTHROPIC_MODEL: 'looks-like-a-model' })
  try {
    const r = await listAccountModels({ CLAUDE_BIN: 'C:/nope/claude.exe', USERPROFILE: home }, {})
    assert.equal(r.ok, false)
    assert.deepEqual(r.models, [])
    assert.equal(r.count, 0)
    assert.match(r.error, /无法获取服务端权威模型清单/)
    assert.deepEqual(r.diagnostic.configured.map((m) => m.id), ['looks-like-a-model'])
    assert.match(r.diagnostic.note, /不是服务端可用全集/)
  } finally { rmSync(home, { recursive: true, force: true }) }
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
