// tests/keystone/client-id.test.mjs — 红线 4 的测试层镜像（verify.mjs 也查，这里双保险）。
// client.js 的 __ModuleLoader__.load({ id }) 必须逐字等于 package.json name。
// 历史事故：agy v1.6.1、codebuddy v1.1.8 —— id ≠ 包名 → client combo 加载失败 →
// DSH 启动致命屏 → 强制安全模式。任何改包名的提交必须同时改 client id，此测试把
// 「一起改」变成机器约束。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const client = readFileSync(join(ROOT, 'home-plugin', 'cli-bridge-indicator', 'lib', 'client.js'), 'utf8')

test('client registration id equals package name (REDLINE #4)', () => {
  const m = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)
  assert.ok(m, 'client.js must contain window.__ModuleLoader__.load({ id: ... })')
  assert.equal(m[1], pkg.name, 'client load id MUST equal package.json name exactly (scoped = full @scope/name); mismatch bricks the client combo')
})

test('client.js has no ES module syntax (plain script, loaded as text)', () => {
  assert.ok(!/^\s*(import|export)\s/m.test(client), 'client.js must stay a classic script (no top-level import/export)')
})

test('bundle patch row name equals package name', () => {
  const patch = readFileSync(join(ROOT, 'home-plugin', 'cli-bridge-indicator', 'cordis.patch.yml'), 'utf8')
  const names = [...patch.matchAll(/^\s*name:\s*'([^']+)'/gm)].map((x) => x[1])
  assert.ok(names.includes(pkg.name), 'cordis.patch.yml must carry an insert row named exactly like the package')
})

test('package has no @deepseek-ai/dsh peerDependencies (compat gate must pass trivially)', () => {
  const peers = pkg.peerDependencies || {}
  for (const k of Object.keys(peers)) {
    assert.ok(!/^@deepseek-ai\/dsh/.test(k), 'do not add dsh peerDependency: ' + k + ' (old bridges ship none; adding one arms the 0.2.x compatibility gate)')
  }
})

test('dsh client platform is web and bundle patch target exists', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
  const rel = String(pkg.dsh.bundle.patch).replace(/^\.\//, '')
  assert.ok(readFileSync(join(ROOT, rel), 'utf8').length > 0)
})
