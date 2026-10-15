// tests/keystone/settings-legacy.test.mjs — 统一设置文件 + 旧包文件迁移机制。
// provider 分区字段由各自描述符声明；本测试只锁「落盘层机制」：
//   1. GET 掩码 secret（绝不回传明文）
//   2. POST 空=保持 / <key>Clear=true 清除 / 未知字段丢弃
//   3. 旧包独立设置文件的字段级回退（统一文件写过该键 → 旧文件永久失效）
// 机制断言里凡依赖 provider 声明键的（preferredBackend 等），在该键未声明时自动 skip
// ——队友交付描述符后这些用例自动变成硬闸门。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { settingsView, parseSettingsBody, writeSettingsFile, readSettingsFile, effectiveSettings } from '../../home-plugin/cli-bridge-indicator/lib/settings.mjs'
import { createProvider, PROVIDER_IDS } from '../../providers/registry.mjs'

function freshIo() {
  const dir = join(tmpdir(), 'clb-set-' + Date.now() + '-' + Math.floor(Math.random() * 1e6))
  mkdirSync(dir, { recursive: true })
  return { dir, unified: join(dir, 'cli-bridge-settings.json'), io: { env: { DSH_HOME: dir }, path: join(dir, 'cli-bridge-settings.json') } }
}

const cb = createProvider('codebuddy', { env: {} })
const cbKeys = (cb.settings && cb.settings.keys) || []
const cbSecrets = (cb.settings && cb.settings.secretKeys) || []

test('GET view: secrets masked, never plaintext', { skip: cbSecrets.includes('codebuddyEnToken') ? false : 'codebuddy descriptor secret keys not delivered yet' }, () => {
  const { dir, unified } = freshIo()
  try {
    writeFileSync(unified, JSON.stringify({ codebuddy: { codebuddyEnToken: 'super-secret-XYZW1234', preferredBackend: 'codebuddy' } }))
    const io = { env: { DSH_HOME: dir }, path: unified }
    const v = settingsView(io)
    assert.ok(!('codebuddyEnToken' in v.providers.codebuddy.values), 'token must not appear in values')
    assert.equal(v.providers.codebuddy.secrets.codebuddyEnToken.set, true)
    assert.ok(v.providers.codebuddy.secrets.codebuddyEnToken.hint.endsWith('234'), 'mask shows tail')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST semantics: empty keeps, Clear erases, junk dropped', () => {
  const { io } = freshIo()
  const parse = parseSettingsBody('{"mimo":{"nonexistent":"x"},"codebuddy":{}}', io)
  assert.equal(parse.ok, true)
  assert.ok(parse.value.mimo && !('nonexistent' in parse.value.mimo), 'unknown fields dropped')
  // 空分区绝不【引入】secret 值：真实 descriptor 声明了 codebuddyEnToken（默认 ''），
  // 「保持现值」语义会把键原样带进 next（值必须为空/缺失，二者对下游 maskToken 等价）。
  assert.ok(!parse.value.codebuddy || !parse.value.codebuddy.codebuddyEnToken, 'empty partition must not carry a non-empty secret')
  assert.equal(parseSettingsBody('not json', io).ok, false)
  assert.equal(parseSettingsBody('[]', io).ok, false)
})

test('POST semantics: set → keep-on-empty → clear-on-ExplicitClear (full secret lifecycle)', () => {
  const { dir, unified } = freshIo()
  try {
    const io = { env: { DSH_HOME: dir }, path: unified }
    // 1) 显式写入 token
    const p1 = parseSettingsBody('{"codebuddy":{"codebuddyEnToken":"tok-abc-7890"}}', io)
    assert.equal(p1.ok, true)
    writeSettingsFile(p1.value, io)
    // 2) 空分区 POST → 保持现值（绝不(blank)掉）
    const p2 = parseSettingsBody('{"codebuddy":{"preferredBackend":"workbuddy"}}', io)
    assert.equal(p2.value.codebuddy.codebuddyEnToken, 'tok-abc-7890', 'empty secret field keeps current value')
    assert.equal(p2.value.codebuddy.preferredBackend, 'workbuddy')
    writeSettingsFile(p2.value, io)
    // 3) Clear → 清除且落盘后不回退
    const p3 = parseSettingsBody('{"codebuddy":{"codebuddyEnTokenClear":true}}', io)
    assert.equal(p3.value.codebuddy.codebuddyEnToken, '', 'explicit clear blanks the secret')
    writeSettingsFile(p3.value, io)
    const v = settingsView(io)
    assert.equal(v.providers.codebuddy.secrets.codebuddyEnToken.set, false, 'view shows cleared')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('legacy migration: codebuddy flat file feeds unset fields', { skip: cbKeys.includes('preferredBackend') ? false : 'provider stub has no keys' }, () => {
  const dir = join(tmpdir(), 'clb-legacy-' + Date.now())
  mkdirSync(dir, { recursive: true })
  try {
    const legacy = join(dir, 'codebuddy-bridge-settings.json')
    writeFileSync(legacy, JSON.stringify({ preferredBackend: 'workbuddy', defaultModel: 'glm-5.3', codebuddyEnToken: 'tok-abc12345' }))
    const io = { env: { CODEBUDDY_SETTINGS_FILE: legacy, DSH_HOME: dir }, path: join(dir, 'cli-bridge-settings.json') }
    const eff = effectiveSettings(io)
    assert.equal(eff.codebuddy.preferredBackend, 'workbuddy')
    assert.equal(eff.codebuddy.defaultModel, 'glm-5.3')
    // 统一文件保存后旧值该键不再回退（写了 preferredBackend=codebuddy → 新值生效）
    writeSettingsFile({ codebuddy: Object.assign({}, eff.codebuddy, { preferredBackend: 'codebuddy' }) }, io)
    const eff2 = effectiveSettings(io)
    assert.equal(eff2.codebuddy.preferredBackend, 'codebuddy')
    assert.equal(eff2.codebuddy.defaultModel, 'glm-5.3', 'field never saved falls back to legacy still')
    assert.ok(existsSync(io.path))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('legacy migration: mimo backend/desktopModel key mapping', { skip: (() => { const m = createProvider('mimo', { env: {} }); return (m.settings && m.settings.keys || []).includes('preferredBackend') ? false : 'provider stub has no keys' })() }, () => {
  const dir = join(tmpdir(), 'clb-legacy-mimo-' + Date.now())
  mkdirSync(dir, { recursive: true })
  try {
    const legacy = join(dir, 'mimo-settings.json')
    writeFileSync(legacy, JSON.stringify({ backend: 'mimo-desktop', desktopModel: 'mimo-auto' }))
    const io = { env: { MIMO_BRIDGE_SETTINGS: legacy, DSH_HOME: dir }, path: join(dir, 'cli-bridge-settings.json') }
    const eff = effectiveSettings(io)
    assert.equal(eff.mimo.preferredBackend, 'mimo-desktop')
    assert.equal(eff.mimo.desktopModel, 'mimo-auto')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── _scheduling 区（0.2.0）：读写、视图、校验、保持语义 ──────────────────────
// 单一 id 轴（契约 §3.1）：期望值一律从 registry 派生，禁止硬编码 id 列表 —— 新增
// provider 时本文件零改动，否则每次扩 provider 都要改测试（= 第二处 id 真相源）。
test('scheduling: 文件无 _ 区 → 视图缺省全开（all/labels 恒有）', () => {
  const { io } = freshIo()
  const v = settingsView(io)
  assert.deepEqual(v.scheduling.enabled, PROVIDER_IDS.slice())
  assert.deepEqual(v.scheduling.order, PROVIDER_IDS.slice())
  assert.deepEqual(v.scheduling.all, PROVIDER_IDS.slice())
  assert.equal(v.scheduling.labels.agy, 'AGY')
})

test('scheduling: 文件 _ 区被 normalizeAll 保留并在视图里派生 order', () => {
  const { dir, unified } = freshIo()
  try {
    writeFileSync(unified, JSON.stringify({ _scheduling: { enabled: ['mimo', 'agy'], priority: ['mimo', 'agy', 'codebuddy'] } }))
    const io = { env: { DSH_HOME: dir }, path: unified }
    const v = settingsView(io)
    assert.deepEqual(v.scheduling.enabled, ['mimo', 'agy'])
    assert.deepEqual(v.scheduling.order, ['mimo', 'agy'], 'order = priority ∩ enabled')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('scheduling: POST 整区替换 + 类型严格（未知 id / 非数组 / 非对象 → 400）', () => {
  const { io } = freshIo()
  const ok = parseSettingsBody('{"_scheduling":{"enabled":["codebuddy"],"priority":["codebuddy","agy","mimo"]}}', io)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value._scheduling.enabled, ['codebuddy'])
  for (const bad of [
    '{"_scheduling":"nope"}',
    '{"_scheduling":[]}',
    '{"_scheduling":{"enabled":"agy"}}',
    '{"_scheduling":{"enabled":["ghost"]}}',
    '{"_scheduling":{"priority":[7]}}'
  ]) {
    assert.equal(parseSettingsBody(bad, io).ok, false, 'must reject ' + bad)
  }
})

test('scheduling: provider-only POST 保持 _ 区现值（绝不悄悄重置）', () => {
  const { dir, unified } = freshIo()
  try {
    const io = { env: { DSH_HOME: dir }, path: unified }
    const p1 = parseSettingsBody('{"_scheduling":{"enabled":["agy"],"priority":["agy","mimo","codebuddy"]}}', io)
    writeSettingsFile(p1.value, io)
    const p2 = parseSettingsBody('{"agy":{}}', io)
    assert.equal(p2.ok, true)
    assert.deepEqual(p2.value._scheduling.enabled, ['agy'], 'kept across provider-only submit')
    // priority 被 normalize 补齐了注册表里的全部 id（漏写的排末尾），故按前缀比对。
    assert.deepEqual(p2.value._scheduling.priority.slice(0, 3), ['agy', 'mimo', 'codebuddy'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('scheduling: 写盘 → 读回闭环；enabled 显式空数组=全关被尊重', () => {
  const { dir, unified } = freshIo()
  try {
    const io = { env: { DSH_HOME: dir }, path: unified }
    const p = parseSettingsBody('{"_scheduling":{"enabled":[]}}', io)
    assert.equal(p.ok, true)
    writeSettingsFile(p.value, io)
    const snap = readSettingsFile(io)
    assert.deepEqual(snap._scheduling.enabled, [], 'explicit all-off survives round-trip')
    const v = settingsView(io)
    assert.deepEqual(v.scheduling.enabled, [])
    assert.deepEqual(v.scheduling.order, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
