// tests/agy/dynamic-template.test.mjs — 动态沙箱宿主模板/生成物的形态纪律。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TPL = fileURLToPath(new URL('../../dynamic/agy.host.template.mjs', import.meta.url))
const OUT = fileURLToPath(new URL('../../dynamic/agy.host.js', import.meta.url))

test('模板含且仅含一行 __KIT__ / 一行 __PROVIDER__ / 一行 __SCHED__ 占位标记', () => {
  const src = readFileSync(TPL, 'utf8')
  const lines = src.split(/\r?\n/)
  const kit = lines.filter((l) => l.indexOf('/*__' + 'KIT__*/') >= 0)
  const prov = lines.filter((l) => l.indexOf('/*__' + 'PROVIDER__*/') >= 0)
  const sched = lines.filter((l) => l.indexOf('/*__' + 'SCHED__*/') >= 0)
  assert.equal(kit.length, 1, 'exactly one kit placeholder line')
  assert.equal(prov.length, 1, 'exactly one provider placeholder line')
  assert.equal(sched.length, 1, 'exactly one sched placeholder line')
  assert.equal(kit[0].trim(), '/*__' + 'KIT__*/')
  assert.equal(prov[0].trim(), '/*__' + 'PROVIDER__*/')
  assert.equal(sched[0].trim(), '/*__' + 'SCHED__*/')
})

test('模板自身禁模块语法与 import.meta（沙箱 new Function / build 全局替换纪律）', () => {
  const src = readFileSync(TPL, 'utf8')
  // 去掉占位标记与注释行后再查，避免注释里叙述性提到 import 造成误报。
  const body = src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l) && !/\/\*__[A-Z]+__\*\//.test(l)).join('\n')
  assert.ok(!/^\s*import\s/m.test(body), 'no import statements')
  assert.ok(!/^\s*export\s/m.test(body), 'no export statements')
  assert.ok(!body.includes('im' + 'port.meta'), 'no import.meta literal')
  assert.ok(!/\brequire\s*\(/.test(body), 'no require()')
  assert.match(body, /^\s*return\s*\{/m, 'top-level return { inject, apply } shape')
})

test('生成物存在、无残留占位、可 node --check（CJS 包装下顶层 return 合法）', () => {
  assert.ok(existsSync(OUT), 'dynamic/agy.host.js generated — run node scripts/build.mjs --only=agy')
  const out = readFileSync(OUT, 'utf8')
  assert.ok(!out.includes('/*__'), 'no placeholder residue in generated host')
  // 内联后的关键符号必须在同一文件里（kit + provider 都进来了）
  for (const sym of ['function defineProvider', 'function createRunner', 'function createStatusEngine', 'function renderStatus']) {
    assert.ok(out.includes(sym), 'generated host inlines ' + sym)
  }
  // 调度单源也必须内联（沙箱禁 import，门禁只能在文件内自足）。
  for (const sym of ['function isBridgeEnabled', 'function resolveScheduling', 'const SCHED_ALL_IDS = [']) {
    assert.ok(out.includes(sym), 'generated host inlines ' + sym)
  }
  assert.ok(out.includes("isBridgeEnabled('agy', SCHED_ALL_IDS)"), 'apply() guarded by scheduling')
  assert.ok(!/^\s*import\s[^(]*from/m.test(out), 'generated host has no residual imports')
  const node = process.execPath
  execFileSync(node, ['--check', OUT], { stdio: 'pipe' })
})

test('生成物保留沙箱接线面（harness.registerTool / handle / collector）', () => {
  const out = readFileSync(OUT, 'utf8')
  assert.ok(out.includes('harness.registerTool(ctx, harness.defineTool'), 'old dynamic tool surface')
  assert.ok(out.includes("harness.handle('agy_status'"), 'RPC handler for browser light polling')
  assert.ok(out.includes("mergeSnapshot('agy'"), 'keystone collector with provider id')
  assert.ok(out.includes("ctx.get('cliBridgeCollector')"), 'unified collector name (legacy alias fallback allowed)')
})
