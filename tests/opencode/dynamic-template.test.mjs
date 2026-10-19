// tests/opencode/dynamic-template.test.mjs — 动态沙箱宿主模板/生成物的形态纪律。
//
// 重点防线（0.2.9 真实缺陷的回归断言）：opencode 已拆出 providers/opencode-exe.mjs，
// 若模板缺少片文件占位标记，build 就不会内联该片 → 生成物里只有引用没有定义 →
// dynamic 形态 apply() 时 ReferenceError（candidateExePaths 未定义，已随 0.2.9 发布）。
// 所以这里断言的是「定义存在」，不是「字符串出现过」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TPL = fileURLToPath(new URL('../../dynamic/opencode.host.template.mjs', import.meta.url))
const OUT = fileURLToPath(new URL('../../dynamic/opencode.host.js', import.meta.url))

test('模板含且仅含一行 __KIT__ / __PROVIDER__ / __EXTRA__ / __SCHED__ 占位标记', () => {
  const src = readFileSync(TPL, 'utf8')
  const lines = src.split(/\r?\n/)
  const kit = lines.filter((l) => l.indexOf('/*__' + 'KIT__*/') >= 0)
  const prov = lines.filter((l) => l.indexOf('/*__' + 'PROVIDER__*/') >= 0)
  const extra = lines.filter((l) => l.indexOf('/*__' + 'EXTRA__*/') >= 0)
  const sched = lines.filter((l) => l.indexOf('/*__' + 'SCHED__*/') >= 0)
  assert.equal(kit.length, 1, 'exactly one kit placeholder line')
  assert.equal(prov.length, 1, 'exactly one provider placeholder line')
  assert.equal(extra.length, 1, 'exactly one fragment placeholder line')
  assert.equal(sched.length, 1, 'exactly one sched placeholder line')
  assert.equal(kit[0].trim(), '/*__' + 'KIT__*/')
  assert.equal(prov[0].trim(), '/*__' + 'PROVIDER__*/')
  assert.equal(extra[0].trim(), '/*__' + 'EXTRA__*/')
  assert.equal(sched[0].trim(), '/*__' + 'SCHED__*/')
})

test('模板自身禁模块语法与 import.meta（沙箱 new Function / build 全局替换纪律）', () => {
  const src = readFileSync(TPL, 'utf8')
  const body = src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l) && !/\/\*__[A-Z]+__\*\//.test(l)).join('\n')
  assert.ok(!/^\s*import\s/m.test(body), 'no import statements')
  assert.ok(!/^\s*export\s/m.test(body), 'no export statements')
  assert.ok(!body.includes('im' + 'port.meta'), 'no import.meta literal')
  assert.ok(!/\brequire\s*\(/.test(body), 'no require()')
  assert.match(body, /^\s*return\s*\{/m, 'top-level return { inject, apply } shape')
})

test('生成物存在、无残留占位、可 node --check（CJS 包装下顶层 return 合法）', () => {
  assert.ok(existsSync(OUT), 'dynamic/opencode.host.js generated — run node scripts/build.mjs --only=opencode')
  const out = readFileSync(OUT, 'utf8')
  assert.ok(!out.includes('/*__'), 'no placeholder residue in generated host')
  for (const sym of ['function defineProvider', 'function createRunner', 'function createStatusEngine']) {
    assert.ok(out.includes(sym), 'generated host inlines ' + sym)
  }
  for (const sym of ['function isBridgeEnabled', 'function resolveScheduling', 'const SCHED_ALL_IDS = [']) {
    assert.ok(out.includes(sym), 'generated host inlines ' + sym)
  }
  assert.ok(out.includes("isBridgeEnabled('opencode', SCHED_ALL_IDS)"), 'apply() guarded by scheduling')
  assert.ok(!/^\s*import\s[^(]*from/m.test(out), 'generated host has no residual imports')
  execFileSync(process.execPath, ['--check', OUT], { stdio: 'pipe' })
})

test('生成物真的内联了 opencode-*.mjs 片文件（有定义，不只是被引用）', () => {
  const out = readFileSync(OUT, 'utf8')
  // 0.2.9 缺陷：candidateExePaths 定义 0 次、出现 4 次 → dynamic 形态必炸。
  for (const sym of ['candidateExePaths', 'resolveExePrefix', 'parseModelList', 'sortModelsFreeFirst', 'fetchModelsDetailed', 'cachedModels', 'rememberModels']) {
    const decls = out.split('function ' + sym + '(').length - 1
    const mentions = out.split(sym).length - 1
    assert.equal(decls, 1, sym + ' 必须在生成物里有且只有一处 function 定义（0 = 片文件没被内联）')
    assert.ok(mentions > decls, sym + ' 应至少被引用一次')
  }
  // 片文件里的顶层 const 也不得缺席（缓存/正则都在片文件里）。
  assert.ok(out.includes('const MODEL_CACHE = { at: 0, models: [] }'), 'cache const inlined')
  assert.ok(out.includes('const MODEL_LINE_RE = '), 'model line regex inlined')
})

test('生成物保留沙箱接线面与手动拉取面（settings.meta 不探测）', () => {
  const out = readFileSync(OUT, 'utf8')
  assert.ok(out.includes("ctx.get('cliBridgeCollector')"), 'unified collector name')
  assert.ok(out.includes("name: 'opencode:policy'"), 'policy section registered')
  assert.ok(out.includes("refresh: { label: '拉取可用模型' }"), 'refresh marker survives build')
  // 面板渲染路径不再同步起 CLI：meta 里不得出现 fetchModelsSync 调用。
  assert.ok(!/meta:\s*\(env2\)[\s\S]{0,600}fetchModelsSync\(/.test(out), 'meta() must not spawn the CLI')
})
