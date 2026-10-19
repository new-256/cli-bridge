// tests/mimo/dynamic-template.test.mjs — 动态沙箱宿主模板/生成物的形态纪律。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TPL = fileURLToPath(new URL('../../dynamic/mimo.host.template.mjs', import.meta.url))
const OUT = fileURLToPath(new URL('../../dynamic/mimo.host.js', import.meta.url))

test('模板含且仅含一行 __KIT__ / __PROVIDER__ / __EXTRA__ / __SCHED__ 占位标记', () => {
  const src = readFileSync(TPL, 'utf8')
  const lines = src.split(/\r?\n/)
  const kit = lines.filter((l) => l.indexOf('/*__' + 'KIT__*/') >= 0)
  const prov = lines.filter((l) => l.indexOf('/*__' + 'PROVIDER__*/') >= 0)
  const extra = lines.filter((l) => l.indexOf('/*__' + 'EXTRA__*/') >= 0)
  const sched = lines.filter((l) => l.indexOf('/*__' + 'SCHED__*/') >= 0)
  assert.equal(kit.length, 1, 'exactly one kit placeholder line')
  assert.equal(prov.length, 1, 'exactly one provider placeholder line')
  // 0.2.9 回归：mimo 已拆出 providers/mimo-pure.mjs，模板漏掉 EXTRA 占位会让片文件
  // 完全不进生成物 → dynamic 形态 apply() 时 ReferenceError（parseMimoJson 未定义）。
  assert.equal(extra.length, 1, 'exactly one fragment placeholder line')
  assert.equal(sched.length, 1, 'exactly one sched placeholder line')
  assert.equal(kit[0].trim(), '/*__' + 'KIT__*/')
  assert.equal(prov[0].trim(), '/*__' + 'PROVIDER__*/')
  assert.equal(extra[0].trim(), '/*__' + 'EXTRA__*/')
  assert.equal(sched[0].trim(), '/*__' + 'SCHED__*/')
})

test('生成物真的内联了 mimo-*.mjs 片文件（有定义，不只是被引用）', () => {
  const out = readFileSync(OUT, 'utf8')
  // 断言「定义数」而不是「出现次数」：0.2.9 的缺陷正是「出现 4 次、定义 0 次」，
  // 只查 mentions 的断言全绿也挡不住。这条是这个缺陷的永久防线。
  for (const sym of ['parseMimoJson', 'buildResult', 'parseMimoModels', 'fetchMimoModelsDetailed', 'cachedMimoModels']) {
    const decls = out.split('function ' + sym + '(').length - 1
    const mentions = out.split(sym).length - 1
    assert.equal(decls, 1, sym + ' 必须在生成物里有且只有一处 function 定义（0 = 片文件没被内联）')
    assert.ok(mentions > decls, sym + ' 应至少被引用一次')
  }
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
  assert.ok(existsSync(OUT), 'dynamic/mimo.host.js generated — run node scripts/build.mjs --only=mimo')
  const out = readFileSync(OUT, 'utf8')
  assert.ok(!out.includes('/*__'), 'no placeholder residue in generated host')
  for (const sym of ['function defineProvider', 'function createRunner', 'function createStatusEngine', 'function renderStatus']) {
    assert.ok(out.includes(sym), 'generated host inlines ' + sym)
  }
  // 同名顶层 const 冲突防线（本次迭代真实踩过：kit LIMIT_RE vs mimo LIMIT_RE）：
  // 生成物里 LIMIT_RE 只允许 kit 声明一处（mimo 侧必须带前缀命名）。
  const limitDecls = out.split(/\r?\n/).filter((l) => /^const LIMIT_RE\s*=/.test(l))
  assert.equal(limitDecls.length, 1, 'exactly one kit LIMIT_RE declaration; provider must not shadow')
  // 调度单源内联 + apply() 门禁存在。
  for (const sym of ['function isBridgeEnabled', 'function resolveScheduling', 'const SCHED_ALL_IDS = [']) {
    assert.ok(out.includes(sym), 'generated host inlines ' + sym)
  }
  assert.ok(out.includes("isBridgeEnabled('mimo', SCHED_ALL_IDS)"), 'apply() guarded by scheduling')
  assert.ok(!/^\s*import\s[^(]*from/m.test(out), 'generated host has no residual imports')
  const node = process.execPath
  execFileSync(node, ['--check', OUT], { stdio: 'pipe' })
})

test('生成物保留沙箱接线面（harness.registerTool / handle / collector）', () => {
  const out = readFileSync(OUT, 'utf8')
  assert.ok(out.includes('harness.registerTool(ctx, harness.defineTool'), 'old dynamic tool surface')
  assert.ok(out.includes("harness.handle('mimo_status'"), 'RPC handler for browser light polling')
  assert.ok(out.includes("mergeSnapshot('mimo'"), 'keystone collector with provider id')
  assert.ok(out.includes("ctx.get('cliBridgeCollector')"), 'unified collector name (legacy alias fallback allowed)')
  assert.ok(out.includes("ctx.get('mimoCollector')"), 'legacy mimoCollector alias kept (旧仓兼容)')
})

test('沙箱单后端纪律：无桌面回读、无裸 fetch（去桌面化后仅 spawn 路径）', () => {
  const out = readFileSync(OUT, 'utf8')
  // 去 desktop 化：preflight/桌面 HTTP 回读全部移除，生成物不得残留桌面 abort 状态。
  assert.ok(!out.includes('DESKTOP_UN' + 'REACHABLE'), 'no desktop preflight abort status')
  assert.ok(!/desktopFetch|desktopHealth|desktopSendTurn|newDesktopSessionId/.test(out), 'no desktop HTTP helpers')
  assert.ok(!/\/v1\/health|\/v1\/sessions/.test(out), 'no desktop local API routes')
  // 模型语义内联：defaultModel 空 = 不传 --model（mimo CLI 自决）。
  assert.ok(out.includes("argv.push('--model'"), 'model flag is conditional')
  assert.ok(out.includes('defaultModel'), 'defaultModel setting inlined')
})
