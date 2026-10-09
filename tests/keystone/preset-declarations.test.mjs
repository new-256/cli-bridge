// tests/keystone/preset-declarations.test.mjs — Form-A 自注册消费路径的红线测试。
//
// 历史教训：本模块的 loadPluginList 曾声明了 PRESET_DIRS 映射却漏用（provider id
// 'agy' ≠ 目录名 'agy-first'），三个 preset 全部静默注册失败 —— 单靠 build/verify
// 抓不到（它们各自用对了映射）。这个测试锁死「运行时消费路径」：
//   1) buildPresetDefinition(id) 必须真能 import 到 plugin-list（目录映射正确）；
//   2) {__jsExpr} 字面量必须原样透传（绝不能被编译成真函数 —— 注册表跨 realm
//      JSON 化会静默丢函数，loader 的 disabled/if 表达式随之失效）；
//   3) 桥接行 name 必须是裸子路径 '@luchenglong/cli-bridge/preset-<id>'。
// 只对「已交付的 provider」断言；未交付的跳过（队友并行落盘时不红）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPresetDefinition, PKG_NAME } from '../../home-plugin/cli-bridge-indicator/lib/preset-declarations.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PRESET_DIRS = { agy: 'agy-first', codebuddy: 'codebuddy-first', mimo: 'mimo-first' }
const delivered = Object.keys(PRESET_DIRS).filter((id) => existsSync(join(ROOT, 'preset', PRESET_DIRS[id], 'plugin-list.mjs')))

test('package name is the scoped cli-bridge name', () => {
  assert.equal(PKG_NAME, '@luchenglong/cli-bridge')
})

for (const id of delivered) {
  test(`buildPresetDefinition('${id}') resolves plugin-list via PRESET_DIRS`, async () => {
    const def = await buildPresetDefinition(id)
    assert.ok(def, 'definition must not be null (path resolution broken?)')
    assert.ok(def.id, 'definition.id present')
    assert.ok(Array.isArray(def.plugins) && def.plugins.length > 1, 'plugins array present')
    assert.ok(typeof def.order === 'number', 'order is a number')
  })

  test(`buildPresetDefinition('${id}'): bridge row uses bare subpath, jsExpr stays object`, async () => {
    const def = await buildPresetDefinition(id)
    const bridge = def.plugins.find((r) => r.id === 'cli-bridge-' + id)
    assert.ok(bridge, 'bridge row (cli-bridge-' + id + ') present')
    assert.equal(bridge.name, PKG_NAME + '/preset-' + id, 'bridge row name = package export subpath')
    assert.ok(!bridge.name.startsWith('.'), 'bridge row name must NOT be a relative path')
    // jsExpr 透传：全树扫描，任何 {__jsExpr:string} 必须仍是 plain object。
    const stack = [def.plugins]
    while (stack.length) {
      const node = stack.pop()
      if (Array.isArray(node)) { for (const x of node) stack.push(x); continue }
      if (node && typeof node === 'object') {
        if (Object.prototype.hasOwnProperty.call(node, '__jsExpr')) {
          assert.equal(typeof node.__jsExpr, 'string', 'jsExpr value stays a string')
        }
        for (const k of Object.keys(node)) {
          const v = node[k]
          assert.notEqual(typeof v, 'function', 'no function anywhere (jsExpr must never be compiled; registry JSON round-trip would silently drop it)')
          if (v && typeof v === 'object') stack.push(v)
        }
      }
    }
  })
}

if (!delivered.length) {
  test('preset-declarations: no plugin-list delivered yet (skipped)', (t) => { t.skip('awaiting provider commits') })
}
