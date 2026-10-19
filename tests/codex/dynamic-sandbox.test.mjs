// tests/codex/dynamic-sandbox.test.mjs — 动态沙箱形态：模板纪律 + 真内联执行。
//
// 为什么不用「等 build 产物」：dynamic/codex.host.js 由 `node scripts/build.mjs` 生成，
// 而 build 只遍历 providers/registry.mjs 的 PROVIDER_IDS —— 接入是 Lead 的活。本测试
// 自己在内存里按 scripts/build.mjs 的同一套规则内联（stripModuleSyntax + 四个占位标记），
// 然后用 new Function 真跑一遍沙箱脚本 —— 比只 check 语法更能抓住「片文件漏内联 /
// 顶层标识符撞名 / 注释被占位符劈开」这类真故障。
//
// ⚠️ 本文件里的 stripModuleSyntax 是 scripts/build.mjs 的镜像副本；build.mjs 若改规则，
// 这里必须同步（改不动就说明规则有第二份实现，本身也是缺陷）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TPL = join(ROOT, 'dynamic/codex.host.template.mjs')
const OUT = join(ROOT, 'dynamic/codex.host.js')
const PROVIDERS = join(ROOT, 'providers')

// ── scripts/build.mjs 的同一套转换（镜像）────────────────────────────────────
function stripModuleSyntax(src, label) {
  const collapsed = src.replace(
    /^\s*import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?\s*$/gms,
    (m) => '// ' + m.replace(/\s+/g, ' ').trim()
  )
  const out = collapsed
    .split('\n')
    .filter((l) => !/^\s*import\s[^(]*from\s*['"][^'"]+['"];?\s*$/.test(l) && !/^\s*import\s*['"]/.test(l))
    .join('\n')
    .replace(/^(\s*)export\s+(const|let|var|function|async function|class)\s/gm, '$1$2 ')
    .replace(/^(\s*)export\s+default\s+(async\s+)?function\s+([A-Za-z0-9_$]+)\s*/gm, '$1$2function $3 ')
    .replace(/^(\s*)export\s+default\s+(async\s+)?function\s*\(/gm, '$1$2function __default__(')
    .replace(/^(\s*)export\s*\{[^}]*\};?\s*$/gm, '')
  if (/^\s*(export\s+default|import\s|import\()/m.test(out)) throw new Error('inline-unsupported module syntax: ' + label)
  return out
}

function buildHostSource() {
  const tpl = readFileSync(TPL, 'utf8')
  const kit = stripModuleSyntax(readFileSync(join(ROOT, 'core/bridge-kit.mjs'), 'utf8'), 'bridge-kit')
  const prov = stripModuleSyntax(readFileSync(join(PROVIDERS, 'codex.mjs'), 'utf8'), 'codex.mjs')
  const frags = readdirSync(PROVIDERS).filter((f) => f.startsWith('codex-') && f.endsWith('.mjs')).sort()
  const extra = frags.map((f) => '// ── inlined from providers/' + f + ' ──\n' + stripModuleSyntax(readFileSync(join(PROVIDERS, f), 'utf8'), f)).join('\n')
  const sched = stripModuleSyntax(readFileSync(join(ROOT, 'core/scheduling.mjs'), 'utf8'), 'scheduling')
    + '\nconst SCHED_ALL_IDS = ' + JSON.stringify(['agy', 'codebuddy', 'mimo', 'opencode', 'codex']) + '\n'
  let out = tpl.replace('/*__KIT__*/', () => kit).replace('/*__PROVIDER__*/', () => prov)
  out = out.replace('/*__EXTRA__*/', () => extra)
  out = out.replace('/*__SCHED__*/', () => sched)
  return { src: out, frags }
}

// ── mock 沙箱宿主 ────────────────────────────────────────────────────────────
// 沙箱里的调度门禁经 core/scheduling.mjs 读 process.env.CLI_BRIDGE_SETTINGS_FILE（真机
// 上这个文件存在，且 enabled 里没有 codex —— 不隔离的话本测试会被门禁短路）。
const SETTINGS_DIR = mkdtempSync(join(tmpdir(), 'clb-codex-sandbox-settings-'))
const SETTINGS_FILE = join(SETTINGS_DIR, 'cli-bridge-settings.json')
process.env.CLI_BRIDGE_SETTINGS_FILE = SETTINGS_FILE
function writeScheduling(section) {
  writeFileSync(SETTINGS_FILE, JSON.stringify(section ? { _scheduling: section } : {}), 'utf8')
}
writeScheduling(null)

const STREAM = [
  '{"type":"thread.started","thread_id":"01a154f6-06c9-7011-a742-e532461b9b74"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"ls"}}',
  '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"ls","exit_code":0}}',
  '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"SANDBOX_OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
].join('\n')

function mkHarness() {
  const tools = []
  const handlers = Object.create(null)
  return {
    harness: {
      registerTool(ctx, tool) { tools.push(tool); return () => { } },
      defineTool(t) { return t },
      handle(name, fn) { handlers[name] = fn }
    },
    tools,
    handlers
  }
}

function mkCtx() {
  const snapshots = []
  const sections = []
  const collector = { mergeSnapshot(id, snap) { snapshots.push({ id, snap }) } }
  // 实时折叠靠 ctx.interval 轮询 stdout 缓冲：这里把 tick 收起来，在进程退出前跑一次，
  // 否则 trail 永远是空的（沙箱形态没有别的折叠入口）。
  const ticks = []
  const ctx = {
    get(name) {
      if (name === 'sandboxPolicy') return { workspaceRoot: 'C:/fake-workspace' }
      if (name === 'cliBridgeCollector') return collector
      return undefined
    },
    subprocess: {
      resolveExecutable: async (n) => 'C:/fake/' + n + '.exe',
      spawn() {
        let done = null
        const handle = {
          collected: { stdout: { readFrom: () => ({ text: STREAM }) }, stderr: { readFrom: () => ({ text: '' }) } },
          terminate() { },
          done: new Promise((resolve) => { done = resolve })
        }
        setTimeout(() => {
          for (const tick of ticks) { try { tick() } catch (e) { /* 折叠尽力而为 */ } }
          done({ exitCode: 0 })
        }, 0)
        return handle
      }
    },
    interval(fn) { ticks.push(fn); return () => { } },
    timeout() { return () => { } },
    systemPrompt: { section(s) { sections.push(s); return () => { } }, getSectionOrder: () => 2800 }
  }
  return { ctx, snapshots, sections }
}

// ── 测试 ────────────────────────────────────────────────────────────────────
test('模板含且仅含四个占位标记行，且注释里不出现标记字面量', () => {
  const src = readFileSync(TPL, 'utf8')
  const lines = src.split(/\r?\n/)
  for (const name of ['KIT', 'PROVIDER', 'EXTRA', 'SCHED']) {
    const mark = '/*__' + name + '__*/'
    const hits = lines.filter((l) => l.indexOf(mark) >= 0)
    assert.equal(hits.length, 1, 'exactly one ' + name + ' placeholder line')
    assert.equal(hits[0].trim(), mark)
  }
  // 占位符只能出现在那四行占位行上：别处（注释/字符串）出现会被 build 全局替换劈开。
  const nonPlaceholder = lines.filter((l) => /\/\*__[A-Z]+__\*\//.test(l) && !/^\/\*__[A-Z]+__\*\/$/.test(l.trim()))
  assert.deepEqual(nonPlaceholder, [])
})

test('模板自身禁模块语法与 import.meta（沙箱 new Function 纪律）', () => {
  const src = readFileSync(TPL, 'utf8')
  const body = src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n')
  assert.ok(!/^\s*import\s/m.test(body), 'no import statements')
  assert.ok(!/^\s*export\s/m.test(body), 'no export statements')
  assert.ok(!body.includes('im' + 'port.meta'), 'no import.meta literal')
  assert.ok(!/\brequire\s*\(/.test(body), 'no require()')
  assert.match(body, /^\s*return\s*\{/m, 'top-level return { inject, apply } shape')
})

test('片文件齐全且按字典序内联（codex.mjs 超红线后的约定）', () => {
  const { frags, src } = buildHostSource()
  assert.deepEqual(frags, ['codex-cli.mjs', 'codex-models.mjs'])
  for (const f of frags) assert.ok(src.indexOf('// ── inlined from providers/' + f + ' ──') > 0, f + ' inlined')
  // 主文件若再涨回 600 行以上，这里就是停机闸门。
  assert.ok(readFileSync(join(PROVIDERS, 'codex.mjs'), 'utf8').split(/\r?\n/).length <= 600, 'providers/codex.mjs within 600 physical lines')
})

test('生成物无残留占位符 / 无模块语句 / 可 node --check', () => {
  const { src } = buildHostSource()
  assert.ok(src.indexOf('/*__') < 0, 'no placeholder residue')
  assert.ok(!/^\s*import\s[^(]*from/m.test(src), 'no residual imports')
  assert.ok(!/^\s*export\s/m.test(src), 'no residual exports')
  const dir = mkdtempSync(join(tmpdir(), 'clb-codex-host-'))
  try {
    const p = join(dir, 'codex.host.js')
    writeFileSync(p, src, 'utf8')
    // 生成物是 CJS 包装（顶层 return 合法）——node 按 .js 解析。
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('沙箱脚本真执行：apply 注册三工具 + codex_status RPC + policy 段', () => {
  const { src } = buildHostSource()
  const factory = new Function('harness', src)
  const { harness, tools, handlers } = mkHarness()
  const mod = factory(harness)
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('tools'))

  const { ctx, sections } = mkCtx()
  mod.apply(ctx)

  assert.deepEqual(tools.map((t) => t.name), ['codex_run', 'codex_continue', 'codex_status'])
  for (const t of tools) {
    assert.equal(t.parameters.type, 'object')
    assert.equal(typeof t.execute, 'function')
  }
  assert.equal(typeof handlers.codex_status, 'function', 'browser light RPC registered')
  const snap = handlers.codex_status()
  assert.equal(snap.provider, 'codex')

  const pol = sections.find((s) => s.name === 'codex:policy')
  assert.ok(pol, 'policy section registered')
  assert.match(pol.text, /codex-first execution policy/)
  assert.match(pol.text, /codex_run/)
})

test('沙箱脚本真执行：codex_run 走完执行编排并把状态推给家级灯 collector', async () => {
  const { src } = buildHostSource()
  const factory = new Function('harness', src)
  const { harness, tools } = mkHarness()
  const mod = factory(harness)
  const { ctx, snapshots } = mkCtx()
  mod.apply(ctx)

  const run = tools.find((t) => t.name === 'codex_run')
  const res = await run.execute({ prompt: 'go', background: false }, { agent: {}, signal: null })
  assert.equal(res.ok, true)
  assert.equal(res.status, 'SUCCESS')
  assert.equal(res.response, 'SANDBOX_OK')
  assert.equal(res.sessionId, '01a154f6-06c9-7011-a742-e532461b9b74')
  assert.ok(snapshots.length >= 1, 'collector received snapshots')
  assert.equal(snapshots[snapshots.length - 1].id, 'codex')
  const last = snapshots[snapshots.length - 1].snap
  assert.equal(last.provider, 'codex')
  assert.ok(Array.isArray(last.projects) && last.projects.length > 0)
  assert.equal(last.projects[0].lastStatus, 'SUCCESS')
  // 折叠出的实时步骤也必须留在快照里（tool 名来自 command_execution → command）。
  assert.ok(last.projects[0].trail.length >= 1)
  assert.equal(last.projects[0].trail[0].tool, 'command')
})

test('沙箱里 codex_models 缺席（裸 env 形态）而三工具仍在', () => {
  const { src } = buildHostSource()
  const factory = new Function('harness', src)
  const { harness, tools } = mkHarness()
  const mod = factory(harness)
  const { ctx } = mkCtx()
  writeScheduling(null)
  mod.apply(ctx)
  assert.deepEqual(tools.map((t) => t.name), ['codex_run', 'codex_continue', 'codex_status'])
})

test('调度门禁：enabled 里没有 codex → apply 一个工具/政策段都不注册', () => {
  const { src } = buildHostSource()
  const factory = new Function('harness', src)
  const { harness, tools, handlers } = mkHarness()
  const mod = factory(harness)
  const { ctx, sections } = mkCtx()
  writeScheduling({ enabled: ['agy', 'codebuddy', 'opencode'], priority: ['agy', 'codebuddy', 'opencode'] })
  try {
    mod.apply(ctx)
    assert.deepEqual(tools, [], 'gated off: no tools')
    assert.deepEqual(sections, [], 'gated off: no policy section')
    assert.equal(handlers.codex_status, undefined, 'gated off: no status RPC')
  } finally { writeScheduling(null) }
})

test('若已生成 dynamic/codex.host.js（Lead 接入后），生成物必须与模板同源且可 check', (t) => {
  if (!existsSync(OUT)) {
    t.diagnostic('dynamic/codex.host.js 尚未生成（Lead 接入 registry 后由 node scripts/build.mjs 产出）——跳过产物比对')
    return
  }
  const out = readFileSync(OUT, 'utf8')
  assert.ok(out.indexOf('/*__') < 0, 'no placeholder residue')
  for (const sym of ['function defineProvider', 'function createRunner', 'function createStatusEngine', 'function renderStatus', 'function codexModelsTool']) {
    assert.ok(out.indexOf(sym) >= 0, 'generated host inlines ' + sym)
  }
  assert.ok(out.indexOf("harness.handle('codex_status'") >= 0)
  assert.ok(out.indexOf("mergeSnapshot('codex'") >= 0)
  assert.ok(out.indexOf("isBridgeEnabled('codex', SCHED_ALL_IDS)") >= 0)
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', OUT], { stdio: 'pipe' }))
})
