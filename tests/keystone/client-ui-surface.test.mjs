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
  for (const sym of ['DispatchCard', 'dispToggle', 'dispMove', 'dispLabels', 'ProviderSettingsCard', 'SettingsPanel', 'Indicator', 'adopt', 'reload', 'save', 'setDisp', 'tab', 'setTab', 'tabs', 'activeMeta', 'activeOn', 'rankOf', 'orderedMeta', 'fresh', 'providerMetas', 'PRESET_ID_OF', 'FALLBACK_LABEL']) {
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

test('过渡窗口护栏：宿主无 scheduling 视图时卡片禁用且不提交 _scheduling', () => {
  // 新 client.js 会先于宿主热加载到浏览器；旧宿主静默丢 _scheduling → 必须禁用交互 +
  // 跳过提交 + 红字提示，绝不「假成功」。
  assert.match(SRC, /const schedSupported = !!\(view && view\.scheduling\)/, 'save() probes host capability')
  assert.match(SRC, /if \(schedSupported\) body\._scheduling =/, 'POST omits _scheduling for old host')
  assert.match(SRC, /supported: !!\(view && view\.scheduling\)/, 'DispatchCard receives capability flag')
  assert.match(SRC, /props\.supported !== false/, 'card defaults to supported when prop absent')
  assert.match(SRC, /disabled: !supported/, 'checkbox disabled without host support')
  assert.match(SRC, /idx === 0 \|\| !supported/, 'move up disabled without host support')
  assert.match(SRC, /kind: schedSupported \? "ok" : "err"/, 'save message honest about host support')
})

test('红线 4：load id 逐字不动（scoped 包名）', () => {
  assert.ok(SRC.includes('window.__ModuleLoader__.load({'), 'loader call shape intact')
  assert.ok(SRC.includes('id: "@luchenglong/cli-bridge"'), 'load id byte-identical')
})

test('0.2.1 指示灯修复：pill 行只渲染新鲜项目（stale 过滤）', () => {
  // 历史 bug：stale:true 的项目（>10min 无活动）仍被渲染成常亮灯（✗ AGY 永远挂着）。
  assert.match(SRC, /\.filter\(function \(p\) \{ return !p\.stale; \}\)/, 'pill row filters stale projects')
  assert.match(SRC, /if \(fresh\.length\)/, 'pills render from fresh list only')
  assert.match(SRC, /fresh\[i\]\.cwd/, 'Pill iterates fresh entries')
})

test('横向标签页模式（0.2.2）：点名字切换，页面不长；扩展 = 多一个 tab', () => {
  assert.match(SRC, /clbs-tabs/, 'horizontal tab bar container rendered')
  assert.match(SRC, /\.clbs-tabs\{display:flex;gap:6px;flex-wrap:wrap/, 'tabs wrap when providers grow (4th/5th CLI needs no layout change)')
  // hook 顺序红线：tab 状态必须与其它 hook 一起声明，且在 `if (!view)` 早期 return 之前，
  // 否则 view 加载瞬间 hook 数量变化 → React 崩面板。
  const hookPos = SRC.indexOf('react.useState("global")')
  const earlyReturn = SRC.indexOf('if (!view) {')
  assert.ok(hookPos > 0, 'tab state declared')
  assert.ok(earlyReturn > 0 && hookPos < earlyReturn, 'tab hook before early return')
  assert.match(SRC, /tab === "global"/, 'global tab shows only the dispatch card')
  assert.match(SRC, /clbs-tab-dot" \+ \(on \? "" : " clbs-tab-dot-off"\)/, 'tab dot reflects enabled state')
  assert.match(SRC, /activeMeta \? react\.createElement\(ProviderSettingsCard/, 'per-CLI tab renders a single card')
  assert.doesNotMatch(SRC, /clbs-cards/, 'vertical grid stacking removed (page length must not grow per provider)')
})

test('CLI 卡头状态 chip 保留（与调度视图同源派生）', () => {
  assert.match(SRC, /clbs-chip clbs-chip-on/, 'enabled chip')
  assert.match(SRC, /clbs-chip clbs-chip-off/, 'disabled chip')
  assert.match(SRC, /clbs-chip clbs-chip-rank/, 'priority rank chip')
  assert.match(SRC, /on: activeOn, rank: rankOf\[activeMeta\.id\]/, 'card receives scheduling-derived flags')
})


