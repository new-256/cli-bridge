// tests/claude/dynamic-template.test.mjs — 动态沙箱宿主模板/内联形态纪律。
// dynamic/claude.host.js 由 build 生成（registry 由 Lead 接入），故这里用
// helpers/inline-host.mjs 复刻同一套内联规则做机器验证（规则以 scripts/build.mjs 为准）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { buildClaudeHostSource } from './helpers/inline-host.mjs'

const TPL = fileURLToPath(new URL('../../dynamic/claude.host.template.mjs', import.meta.url))
const MARK = (name) => '/*__' + name + '__*/'

test('模板含且仅含一行 KIT / PROVIDER / EXTRA / SCHED 占位标记', () => {
  const lines = readFileSync(TPL, 'utf8').split(/\r?\n/)
  for (const name of ['KIT', 'PROVIDER', 'EXTRA', 'SCHED']) {
    const hit = lines.filter((l) => l.indexOf(MARK(name)) >= 0)
    assert.equal(hit.length, 1, 'exactly one ' + name + ' placeholder line')
    assert.equal(hit[0].trim(), MARK(name), name + ' placeholder must be alone on its line')
  }
})

test('模板自身禁模块语法与 import.meta（沙箱 new Function / build 全局替换纪律）', () => {
  const src = readFileSync(TPL, 'utf8')
  const body = src.split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l) && l.indexOf('/*__') < 0)
    .join('\n')
  assert.ok(!/^\s*import\s/m.test(body), 'no import statements')
  assert.ok(!/^\s*export\s/m.test(body), 'no export statements')
  assert.ok(!body.includes('im' + 'port.meta'), 'no import.meta literal')
  assert.ok(!/\brequire\s*\(/.test(body), 'no require()')
  assert.match(body, /^\s*return\s*\{/m, 'top-level return { inject, apply } shape')
  assert.match(body, /isBridgeEnabled\('claude', SCHED_ALL_IDS\)/, 'apply() guarded by scheduling')
})

test('内联产物：无占位残留、关键符号齐全、无残留 import', () => {
  const out = buildClaudeHostSource()
  assert.ok(!out.includes('/*__'), 'no placeholder residue in generated host')
  for (const sym of [
    'function defineProvider', 'function createRunner', 'function createStatusEngine', 'function renderStatus',
    'function claudeExeCandidates', 'function splitExeSpec', 'function parseSupportedModels',
    'function listAccountModels', 'const POLICY_TEXT =', 'function isBridgeEnabled', 'const SCHED_ALL_IDS = ['
  ]) {
    assert.ok(out.includes(sym), 'generated host inlines ' + sym)
  }
  assert.ok(out.includes('return {\n  inject:'), 'template body preserved after inlining')
  assert.ok(!/^\s*import\s[^(]*from/m.test(out), 'generated host has no residual imports')
  assert.ok(!/^\s*export\s/m.test(out), 'generated host has no residual exports')
})

test('内联产物：顶层声明不撞名（kit / provider / 片文件同一作用域）', () => {
  const out = buildClaudeHostSource()
  const decls = (re) => out.split(/\r?\n/).filter((l) => re.test(l)).length
  assert.equal(decls(/^const LIMIT_RE\s*=/), 1, 'exactly one kit LIMIT_RE')
  assert.equal(decls(/^const PROBE_MODEL\s*=/), 1, 'claude-models PROBE_MODEL declared once')
  assert.equal(decls(/^const MODE_ENUM\s*=/), 1)
  assert.equal(decls(/^const POLICY_TEXT\s*=/), 1)
  assert.equal(decls(/^function defineProvider\s*\(/), 1, 'provider factory declared once (export default stripped)')
  assert.equal(decls(/^function isBridgeEnabled\s*\(/), 1, 'scheduling declared once')
  // 沙箱里的 builtin 守卫必须按来源加前缀（sloppy 模式下同名函数会互相覆盖）。
  assert.equal(decls(/^function claudeBuiltin\s*\(/), 1)
  assert.equal(decls(/^function schedBuiltinModule\s*\(/), 1)
})

test('内联产物：可 node --check（CJS 包装下顶层 return 合法）', () => {
  const out = buildClaudeHostSource()
  const dir = mkdtempSync(join(tmpdir(), 'clb-claude-host-'))
  try {
    // 必须写成 .js：.mjs 会按 ESM 解析，顶层 return 变成语法错误（与生成物形态不符）。
    const f = join(dir, 'claude.host.check.js')
    writeFileSync(f, out, 'utf8')
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('内联产物保留沙箱接线面（注册三件套 + extraTools + handle + collector）', () => {
  const out = buildClaudeHostSource()
  assert.ok(out.includes('harness.registerTool(ctx, harness.defineTool('), 'dynamic tool surface')
  assert.ok(out.includes('for (const et of (provider.extraTools || []))'), 'extraTools registered in sandbox')
  assert.ok(out.includes("harness.handle('claude_status'"), 'RPC handler for browser light polling')
  assert.ok(out.includes("mergeSnapshot('claude'"), 'keystone collector with provider id')
  assert.ok(out.includes("ctx.get('cliBridgeCollector')"), 'unified collector name')
  assert.ok(out.includes("ctx.get('claudeCollector')"), 'legacy claudeCollector alias kept')
  assert.ok(out.includes("name: 'claude:policy'"), 'policy section registered in sandbox')
  assert.ok(out.includes('text: POLICY_TEXT'), 'policy text comes from the shared fragment')
})
