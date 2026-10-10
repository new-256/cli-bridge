// tests/codebuddy/dynamic-template.test.mjs — 动态沙箱宿主模板/生成物形态纪律。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TPL = fileURLToPath(new URL('../../dynamic/codebuddy.host.template.mjs', import.meta.url))
const OUT = fileURLToPath(new URL('../../dynamic/codebuddy.host.js', import.meta.url))

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
  const body = src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l) && !/\/\*__[A-Z]+__\*\//.test(l)).join('\n')
  assert.ok(!/^\s*import\s/m.test(body), 'no import statements')
  assert.ok(!/^\s*export\s/m.test(body), 'no export statements')
  assert.ok(!body.includes('im' + 'port.meta'), 'no import.meta literal')
  assert.ok(!/\brequire\s*\(/.test(body), 'no require()')
  assert.match(body, /^\s*return\s*\{/m, 'top-level return { inject, apply } shape')
})

test('生成物存在、无残留占位、可 node --check（CJS 包装下顶层 return 合法）', () => {
  assert.ok(existsSync(OUT), 'dynamic/codebuddy.host.js generated — run node scripts/build.mjs --only=codebuddy')
  const out = readFileSync(OUT, 'utf8')
  assert.ok(!out.includes('/*__'), 'no placeholder residue in generated host')
  for (const sym of ['function defineProvider', 'function createRunner', 'function createStatusEngine', 'function renderStatus']) {
    assert.ok(out.includes(sym), 'generated host inlines ' + sym)
  }
  // 同名顶层 const 冲突防线（本迭代真实踩过：kit LIMIT_RE vs codebuddy LIMIT_RE）：
  // 生成物里 LIMIT_RE 只允许 kit 声明一处（codebuddy 侧必须 CODEBUDDY_ 前缀命名）。
  const limitDecls = out.split(/\r?\n/).filter((l) => /^const LIMIT_RE\s*=/.test(l))
  assert.equal(limitDecls.length, 1, 'exactly one kit LIMIT_RE declaration; provider must not shadow')
  assert.ok(/const CODEBUDDY_LIMIT_RE\s*=/.test(out), 'provider limit table uses prefixed name')
  // 调度单源内联（同上防线：scheduling 的 builtin 读取 helper 必须 sched 前缀命名，
  // 否则与 providers/codebuddy.mjs 的 builtinModule 重复声明 → 生成物语法炸）。
  for (const sym of ['function isBridgeEnabled', 'function resolveScheduling', 'const SCHED_ALL_IDS = [']) {
    assert.ok(out.includes(sym), 'generated host inlines ' + sym)
  }
  assert.ok(out.includes("isBridgeEnabled('codebuddy', SCHED_ALL_IDS)"), 'apply() guarded by scheduling')
  assert.equal(out.split(/\r?\n/).filter((l) => /^\s*function builtinModule\s*\(/.test(l)).length, 1, 'exactly one bare builtinModule (provider); scheduling must use sched-prefixed name (sloppy-mode redeclaration would silently shadow)')
  assert.ok(!/^\s*import\s[^(]*from/m.test(out), 'generated host has no residual imports')
  execFileSync(process.execPath, ['--check', OUT], { stdio: 'pipe' })
})

test('生成物保留沙箱接线面（harness.registerTool / handle / collector）', () => {
  const out = readFileSync(OUT, 'utf8')
  assert.ok(out.includes('harness.registerTool(ctx, harness.defineTool'), 'old dynamic tool surface')
  assert.ok(out.includes("harness.handle('codebuddy_status'"), 'RPC handler for browser light polling')
  assert.ok(out.includes("mergeSnapshot('codebuddy'"), 'keystone collector with provider id')
  assert.ok(out.includes("ctx.get('cliBridgeCollector')"), 'unified collector name (legacy alias fallback allowed)')
  assert.ok(out.includes("ctx.get('codebuddyCollector')"), 'legacy codebuddyCollector alias kept (旧仓兼容)')
})

test('沙箱纪律：EN 面凭据缺失经 preflight abort AUTH_REQUIRED（provider 已内联）', () => {
  const out = readFileSync(OUT, 'utf8')
  assert.ok(out.includes('AUTH_REQUIRED'), 'preflight abort status inlined')
  assert.ok(out.includes('protector key'), 'EN 面指引文案随 provider 进入生成物')
})
