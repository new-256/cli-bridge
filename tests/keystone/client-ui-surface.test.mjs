// tests/keystone/client-ui-surface.test.mjs — client.js（无框架 React 面）的静态红线。
//
// 历史事故（本次开发真实踩到）：一次 edit 因 old_string 不匹配而失败，后续步骤没复查，
// 渲染里引用的 dispatchToggle/dispMove/dispLabels 三个 handler 全部未定义 —— 面板一开
// 就 ReferenceError 白屏，而 node --check 只查语法查不出这种「用了没定义」的洞。
// 闸门：
//   1. client.js 必须过 node --check（语法）。
//   2. 渲染引用的每个标识符必须在文件里至少有一处 const/function 定义。
//   3. 调度卡必须有 _scheduling 提交与 view.scheduling 消费（后端契约两端对齐）。
//   4. 红线 4：__ModuleLoader__.load({ id }) 逐字不变（与 client-id.test 双保险）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'home-plugin', 'cli-bridge-indicator', 'lib', 'client.js'), 'utf8')

test('client.js 语法可过 node --check', () => {
  execFileSync(process.execPath, ['--check', join(ROOT, 'home-plugin', 'cli-bridge-indicator', 'lib', 'client.js')], { stdio: 'pipe' })
})

test('渲染引用的标识符都有定义（防「用了没声明」白屏）', () => {
  for (const sym of ['DispatchCard', 'dispToggle', 'dispMove', 'dispLabels', 'ProviderSettingsCard', 'SettingsPanel', 'Indicator', 'adopt', 'reload', 'save', 'setDisp']) {
    const declared = new RegExp('(^|\\s)(function|const|let|var)\\s+' + sym + '\\b', 'm').test(SRC)
    assert.ok(declared, sym + ' must be declared in client.js')
  }
})

test('调度卡两端契约：提交 _scheduling，消费 view.scheduling（enabled/priority/all/labels）', () => {
  assert.match(SRC, /body\._scheduling\s*=\s*\{\s*enabled:/, 'save() posts enabled first (array order = priority)')
  assert.match(SRC, /priority:\s*disp\.ord\.slice\(\)/, 'save() posts full ord as priority')
  assert.match(SRC, /v\.scheduling/, 'adopt() reads scheduling from view')
  assert.match(SRC, /sc\.enabled/, 'adopt() consumes scheduling.enabled')
  assert.match(SRC, /sc\.priority/, 'adopt() consumes scheduling.priority')
  assert.match(SRC, /sc\.all/, 'adopt() consumes scheduling.all (extensible provider list)')
  assert.match(SRC, /view\.scheduling\.labels/, 'dispatch card labels come from backend view (not hardcoded)')
})

test('红线 4：load id 逐字不动（scoped 包名）', () => {
  assert.ok(SRC.includes('window.__ModuleLoader__.load({'), 'loader call shape intact')
  assert.ok(SRC.includes('id: "@luchenglong/cli-bridge"'), 'load id byte-identical')
})
