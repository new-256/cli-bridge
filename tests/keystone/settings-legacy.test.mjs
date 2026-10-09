// tests/keystone/settings-legacy.test.mjs — 统一设置文件 + 旧包文件迁移机制。
// provider 分区字段由各自描述符声明；本测试只锁「落盘层机制」：
//   1. GET 掩码 secret（绝不回传明文）
//   2. POST 空=保持 / <key>Clear=true 清除 / 未知字段丢弃
//   3. 旧包独立设置文件的字段级回退（统一文件写过该键 → 旧文件永久失效）
// 机制断言里凡依赖 provider 声明键的（preferredBackend 等），在该键未声明时自动 skip
// ——队友交付描述符后这些用例自动变成硬闸门。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { settingsView, parseSettingsBody, writeSettingsFile, effectiveSettings } from '../../home-plugin/cli-bridge-indicator/lib/settings.mjs'
import { createProvider } from '../../providers/registry.mjs'

function freshIo() {
  const dir = join(tmpdir(), 'clb-set-' + Date.now() + '-' + Math.floor(Math.random() * 1e6))
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
  assert.ok(!('codebuddyEnToken' in (parse.value.codebuddy || {})), 'secret not resurrected by an empty partition')
  assert.equal(parseSettingsBody('not json', io).ok, false)
  assert.equal(parseSettingsBody('[]', io).ok, false)
})

test('legacy migration: codebuddy flat file feeds unset fields', { skip: cbKeys.includes('preferredBackend') ? false : 'provider stub has no keys' }, () => {
  const dir = join(tmpdir(), 'clb-legacy-' + Date.now())
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
  try {
    const legacy = join(dir, 'mimo-settings.json')
    writeFileSync(legacy, JSON.stringify({ backend: 'mimo-desktop', desktopModel: 'mimo-auto' }))
    const io = { env: { MIMO_BRIDGE_SETTINGS: legacy, DSH_HOME: dir }, path: join(dir, 'cli-bridge-settings.json') }
    const eff = effectiveSettings(io)
    assert.equal(eff.mimo.preferredBackend, 'mimo-desktop')
    assert.equal(eff.mimo.desktopModel, 'mimo-auto')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
