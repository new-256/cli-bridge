// tests/opencode/descriptor.test.mjs — providers/opencode.mjs 描述符契约与解析语义。
// flag 与事件形态以本机实测 opencode 1.19.0 `run --help` + 源码 emit 全集为准。
import test from 'node:test'
import assert from 'node:assert/strict'

import defineProvider, { candidateExePaths, resolveExePrefix, parseModelList } from '../../providers/opencode.mjs'

const provider = defineProvider({ env: {} })

// ── 可执行文件解析（env > 桌面版已知路径 > PATH）───────────────────────────────
test('exeName 是 opencode-cli（V2 桌面版二进制名，不是 opencode.exe）', () => {
  assert.equal(provider.exeName, 'opencode-cli')
})

test('candidateExePaths：无 fs 能力时返回空数组（沙箱安全，不炸）', () => {
  // 传空 env → 无根目录可探 → 空数组（真实 fs 存在但无候选根）。
  assert.deepEqual(candidateExePaths({}), [])
})

test('resolveExePrefix：env OPENCODE_BIN 优先', () => {
  assert.deepEqual(resolveExePrefix({ OPENCODE_BIN: 'C:/custom/opencode-cli.exe' }, ''), ['C:/custom/opencode-cli.exe'])
  // 设置面板的 binPath 又高于 env。
  assert.deepEqual(resolveExePrefix({ OPENCODE_BIN: 'C:/env.exe' }, 'C:/panel.exe'), ['C:/panel.exe'])
})

test('resolveExePrefix：.mjs 目标经 node 包装（测试 fixture 形态）', () => {
  const p = resolveExePrefix({}, 'C:/fake/fake-opencode.mjs')
  assert.equal(p.length, 2)
  assert.ok(p[0].includes('node'), 'first element is the node executable')
  assert.equal(p[1], 'C:/fake/fake-opencode.mjs')
})

test('resolveExePrefix：无 env 无探测结果 → 退回二进制名', () => {
  const p = resolveExePrefix({}, '')
  assert.ok(Array.isArray(p) && p.length === 1)
  assert.equal(typeof p[0], 'string')
})

// ── 模型列表解析 ─────────────────────────────────────────────────────────────
test('parseModelList：只认 provider/model 行，其余丢弃，去重', () => {
  const out = parseModelList([
    'opencode/big-pickle',
    'opencode/nemotron-3-ultra-free',
    'opencode/big-pickle',
    '',
    '   ',
    'Available models:',
    'not a model',
    'opencode-go/glm-5.3'
  ].join('\n'))
  assert.deepEqual(out.map((m) => m.id), ['opencode/big-pickle', 'opencode/nemotron-3-ultra-free', 'opencode-go/glm-5.3'])
})

test('parseModelList：-free 后缀标记 free', () => {
  const out = parseModelList('opencode/a-free\nopencode/b\nopencode-go/cat-jam-free')
  assert.equal(out[0].free, true)
  assert.equal(out[1].free, false)
  assert.equal(out[2].provider, 'opencode-go')
})

test('parseModelList：空/畸形输入返回空数组（不抛）', () => {
  assert.deepEqual(parseModelList(''), [])
  assert.deepEqual(parseModelList(null), [])
  assert.deepEqual(parseModelList('no slashes here'), [])
})

test('契约 ★ 字段齐备（PROVIDER-CONTRACT.md §1）', () => {
  assert.equal(provider.id, 'opencode')
  assert.equal(provider.label, 'OPENCODE')
  assert.equal(provider.presetId, 'opencode-first')
  assert.equal(provider.defaultBackend, null)
  assert.equal(provider.defaultMode, 'auto')
  assert.equal(provider.exeName, 'opencode-cli')
  assert.deepEqual(provider.binEnvVars, ['OPENCODE_BIN', 'OPENCODE_CLI'])
  assert.equal(provider.unavailableStatus, 'OPENCODE_UNAVAILABLE')
  for (const f of ['backends', 'normalizeBackend', 'resolveBackend', 'buildArgv', 'parseJson', 'buildResult', 'runToolLogic', 'continueToolLogic', 'statusToolLogic', 'attach']) {
    assert.equal(typeof provider[f], 'function', f + ' must be a function')
  }
  assert.equal(provider.tools.run.name, 'opencode_run')
  assert.equal(provider.tools.continue.name, 'opencode_continue')
  assert.equal(provider.tools.status.name, 'opencode_status')
})

test('单后端归一：任何取值都是 null', () => {
  assert.equal(provider.backends(), null)
  for (const v of ['opencode', 'OPENCODE', 'agy', '', null, undefined]) {
    assert.equal(provider.normalizeBackend(v), null, 'normalizeBackend(' + String(v) + ')')
  }
  assert.equal(provider.resolveBackend({}, {}, null), null)
})

// ── buildArgv（实测 flag 集）─────────────────────────────────────────────────
test('buildArgv 基础形态：run <prompt> --format json --auto', () => {
  const b = provider.buildArgv('opencode', { prompt: 'do it' }, { planActive: false })
  assert.deepEqual(b.argv, ['opencode', 'run', 'do it', '--format', 'json', '--auto'])
  assert.equal(b.timeoutSec, 600)
})

test('buildArgv：prompt 是 run 的位置参数（不是 -p；-p 是 --password）', () => {
  const b = provider.buildArgv('opencode', { prompt: 'x' }, {})
  assert.equal(b.argv[0], 'opencode')
  assert.equal(b.argv[1], 'run')
  assert.equal(b.argv[2], 'x')
  assert.ok(!b.argv.includes('-p'), 'must not emit -p (that is --password in opencode run)')
  assert.ok(!b.argv.includes('--prompt'), 'run subcommand has no --prompt')
})

test('buildArgv：autoApprove=false 时不带 --auto（尊重显式要求）', () => {
  const b = provider.buildArgv('opencode', { prompt: 'x', autoApprove: false }, {})
  assert.ok(!b.argv.includes('--auto'))
})

test('buildArgv：model/agent/title/files 逐项落地', () => {
  const b = provider.buildArgv('opencode', {
    prompt: 'x', model: 'opencode/big-pickle', agent: 'build',
    title: 'T', files: ['a.txt', '', 'b.txt']
  }, {})
  assert.ok(b.argv.includes('--model') && b.argv.includes('opencode/big-pickle'))
  assert.ok(b.argv.includes('--agent') && b.argv.includes('build'))
  assert.ok(b.argv.includes('--title') && b.argv.includes('T'))
  const files = b.argv.filter((x) => x === '--file')
  assert.equal(files.length, 2, 'empty file entries skipped')
})

test('buildArgv：不传 variant（V2 已并入 --model 的 # 后缀，无 --variant flag）', () => {
  const b = provider.buildArgv('opencode', { prompt: 'x', variant: 'high' }, {})
  assert.ok(!b.argv.includes('--variant'), 'V2 has no --variant flag; variant goes into --model#variant')
})

test('buildArgv：不传 --dir（V2 无此 flag，cwd 靠 spawn 工作目录）', () => {
  const b = provider.buildArgv('opencode', { prompt: 'x', cwd: 'C:/proj' }, {})
  assert.ok(!b.argv.includes('--dir'))
})

test('buildArgv：未指定模型时不落地 --model（用户要求：由 opencode 自身决定）', () => {
  const b = provider.buildArgv('opencode', { prompt: 'x' }, {})
  assert.ok(!b.argv.includes('--model'))
})

test('buildArgv：sessionId → --session；continueLatest → --continue', () => {
  assert.deepEqual(
    provider.buildArgv('opencode', { prompt: 'x', sessionId: 'ses_1' }, {}).argv.slice(-2),
    ['--session', 'ses_1']
  )
  assert.ok(provider.buildArgv('opencode', { prompt: 'x', continueLatest: true }, {}).argv.includes('--continue'))
})

test('buildArgv：timeoutSec 夹紧到 10..3600，默认 600', () => {
  assert.equal(provider.buildArgv('opencode', { prompt: 'x', timeoutSec: 1 }, {}).timeoutSec, 10)
  assert.equal(provider.buildArgv('opencode', { prompt: 'x', timeoutSec: 99999 }, {}).timeoutSec, 3600)
  assert.equal(provider.buildArgv('opencode', { prompt: 'x', timeoutSec: 900 }, {}).timeoutSec, 900)
})

test('buildArgv 数组前缀（OPENCODE_BIN 为 .mjs 时 [nodeExe, bin]）保留两项', () => {
  const b = provider.buildArgv(['node', 'fake.mjs'], { prompt: 'x' }, {})
  assert.deepEqual(b.argv.slice(0, 2), ['node', 'fake.mjs'])
  assert.equal(b.argv[2], 'run')
})

// ── parseJson（事件在 part 里；无 result 事件）─────────────────────────────────
test('parseJson：step_finish 优先（带 cost/tokens）', () => {
  const ndjson = [
    '{"type":"step_start","timestamp":1,"sessionID":"s","part":{"id":"p1"}}',
    '{"type":"text","timestamp":2,"sessionID":"s","part":{"id":"p2","text":"hello"}}',
    '{"type":"step_finish","timestamp":3,"sessionID":"s","part":{"id":"p3","cost":0.01,"tokens":{"input":1,"output":2}}}'
  ].join('\n')
  const p = provider.parseJson(ndjson)
  assert.equal(p.type, 'step_finish')
  assert.equal(p.sessionID, 's')
})

test('parseJson：error 事件最优先（即使它出现在最后）', () => {
  const ndjson = [
    '{"type":"text","timestamp":1,"sessionID":"s","part":{"text":"partial"}}',
    '{"type":"error","timestamp":2,"sessionID":"s","error":{"type":"unknown","message":"boom"}}'
  ].join('\n')
  assert.equal(provider.parseJson(ndjson).type, 'error')
})

test('parseJson：无 step_finish/error 时回落到末段 text 事件', () => {
  const ndjson = [
    '{"type":"text","timestamp":1,"sessionID":"s","part":{"text":"first"}}',
    '{"type":"tool_use","timestamp":2,"sessionID":"s","part":{"tool":"bash"}}'
  ].join('\n')
  const p = provider.parseJson(ndjson)
  assert.equal(p.type, 'text', 'text beats bare tool_use as the response carrier')
  assert.equal(p.part.text, 'first')
})

test('parseJson：非 JSON（纯文本输出）返回 null → 走纯文本兜底', () => {
  assert.equal(provider.parseJson('not json at all'), null)
  assert.equal(provider.parseJson(''), null)
  assert.equal(provider.parseJson(null), null)
})

test('parseJson：容忍夹杂的非 JSON 日志行', () => {
  const ndjson = 'opencode starting...\n{"type":"text","timestamp":1,"sessionID":"s","part":{"text":"ok"}}\ndone\n'
  assert.equal(provider.parseJson(ndjson).part.text, 'ok')
})

// ── buildResult ─────────────────────────────────────────────────────────────
test('buildResult：成功（exit 0 + text 事件）→ ok，文本取 part.text', () => {
  const parsed = { type: 'text', timestamp: 1, sessionID: 'ses_A', part: { text: 'BRIDGE_OK', time: {} } }
  const r = provider.buildResult(parsed, { exitCode: 0 }, 'auto', '', '', null)
  assert.equal(r.ok, true)
  assert.equal(r.status, 'SUCCESS')
  assert.equal(r.response, 'BRIDGE_OK', 'response comes from part.text, not top-level text')
  assert.equal(r.sessionId, 'ses_A')
  assert.equal(r.exitCode, 0)
})

test('buildResult：step_finish 的 tokens 求和为 totalTokens', () => {
  const parsed = { type: 'step_finish', timestamp: 1, sessionID: 's', part: { cost: 0.42, tokens: { input: 100, output: 23, reasoning: 0 } } }
  const r = provider.buildResult(parsed, { exitCode: 0 }, 'auto', '', '', null)
  assert.equal(r.ok, true)
  assert.equal(r.totalTokens, 123)
  assert.equal(r.cost, 0.42)
})

test('buildResult：error 事件 + exit 1 → 失败，message 进 stderr', () => {
  const parsed = { type: 'error', timestamp: 1, sessionID: 's', error: { name: 'APIError', data: { message: 'Incorrect API key provided: sk-fake-***.' } } }
  const r = provider.buildResult(parsed, { exitCode: 1 }, 'auto', '', '', null)
  assert.equal(r.ok, false)
  assert.equal(r.status, 'ERROR')
  assert.match(r.stderr, /Incorrect API key/)
  assert.match(provider.failureHint(r), /opencode auth login/)
})

test('buildResult：exit 130 = SIGINT 中断（ABORTED，既非成功也非限流）', () => {
  const parsed = { type: 'text', timestamp: 1, sessionID: 's', part: { text: 'partial' } }
  const r = provider.buildResult(parsed, { exitCode: 130 }, 'auto', '', '', null)
  assert.equal(r.status, 'ABORTED')
  assert.equal(r.ok, false)
})

test('buildResult：无 JSON → 纯文本兜底，绝不假造 status', () => {
  const r = provider.buildResult(null, { exitCode: 0 }, 'auto', '', 'plain text answer', null)
  assert.equal(r.ok, true)
  assert.equal(r.status, 'SUCCESS')
  assert.equal(r.response, 'plain text answer')
  assert.equal(r.sessionId, null)
  assert.equal(r.totalTokens, null, 'no fabricated token counts')
})

test('buildResult：退出码优先于事件（exit 1 且无 error 事件也算失败）', () => {
  const parsed = { type: 'text', timestamp: 1, sessionID: 's', part: { text: 'x' } }
  assert.equal(provider.buildResult(parsed, { exitCode: 1 }, 'auto', '', '', null).ok, false)
})

// ── foldStreamEvent ─────────────────────────────────────────────────────────
test('foldStreamEvent：tool_use 入 trail，负载在 part.state.input', () => {
  const p = { trail: [], current: null, updatedAt: 0 }
  provider.foldStreamEvent({
    type: 'tool_use', timestamp: 1, sessionID: 's',
    part: { tool: 'bash', state: { status: 'completed', input: { command: 'ls -la' } } }
  }, p, (x) => x, 120, 12)
  assert.equal(p.trail.length, 1)
  assert.equal(p.trail[0].tool, 'bash')
  assert.equal(p.trail[0].state, 'DONE')
  assert.deepEqual(p.trail[0].args, { command: 'ls -la' })
})

test('foldStreamEvent：tool 失败态标 ERROR', () => {
  const p = { trail: [], current: null, updatedAt: 0 }
  provider.foldStreamEvent({ type: 'tool_use', part: { tool: 'edit', state: { status: 'failed' } } }, p, (x) => x, 120, 12)
  assert.equal(p.trail[0].state, 'ERROR')
})

test('foldStreamEvent：text/reasoning 驱动 current，step_finish 清空 current', () => {
  const p = { trail: [], current: null, updatedAt: 0 }
  provider.foldStreamEvent({ type: 'text', part: { text: 'thinking out loud' } }, p, (x) => x, 120, 12)
  assert.equal(p.current.tool, 'agent_response')
  assert.equal(p.current.args.text_delta, 'thinking out loud')
  provider.foldStreamEvent({ type: 'step_finish', part: {} }, p, (x) => x, 120, 12)
  assert.equal(p.current, null, 'step_finish clears a dangling current')
})

test('foldStreamEvent：无关/畸形事件不炸', () => {
  const p = { trail: [], current: null, updatedAt: 0 }
  for (const ev of [null, undefined, {}, { type: 'unknown' }, 'string']) provider.foldStreamEvent(ev, p, (x) => x, 120, 12)
  assert.equal(p.trail.length, 0)
})

// ── settings / failureHint ─────────────────────────────────────────────────
test('settings 分区：normalize 丢弃未知键，diagnose 反映 exe 来源与模型', () => {
  assert.deepEqual(Object.keys(provider.settings.defaults()).sort(), ['binPath', 'defaultAgent', 'defaultModel'])
  const n = provider.settings.normalize({ binPath: ' C:/oc.exe ', junk: 1 })
  assert.deepEqual(n, { binPath: 'C:/oc.exe', defaultModel: '', defaultAgent: '' })
  // diagnose 反映真实生效来源：env 覆盖 > 桌面版探测 > PATH。
  assert.match(provider.settings.diagnose({}, { OPENCODE_BIN: 'C:/x.exe' }), /bin=env:C:\/x\.exe/)
  assert.match(provider.settings.diagnose({ binPath: 'C:/p.exe' }, {}), /bin=设置:C:\/p\.exe/)
  assert.match(provider.settings.diagnose({}, {}), /bin=/)
  // 未设默认模型时明确显示「由 opencode 自决」（用户要求：不硬编码默认）。
  assert.match(provider.settings.diagnose({ defaultModel: '' }, {}), /opencode 自决/)
  assert.match(provider.settings.diagnose({ defaultModel: 'opencode/big-pickle' }, {}), /model=opencode\/big-pickle/)
})

test('settings.meta：binPath/defaultModel/defaultAgent 均为可自定义下拉', () => {
  const meta = provider.settings.meta({})
  const keys = meta.fields.map((f) => f.key)
  assert.deepEqual(keys, ['binPath', 'defaultModel', 'defaultAgent'])
  for (const f of meta.fields) {
    assert.equal(f.type, 'select', f.key + ' must be a select')
    assert.equal(f.allowCustom, true, f.key + ' must allow custom input')
    assert.ok(Array.isArray(f.options), f.key + ' options must be an array')
  }
  // 模型选项失败时退化为自由输入，不抛异常（CLI 未安装/未登录场景下不能崩面板）。
  assert.doesNotThrow(() => provider.settings.meta({}))
})

test('failureHint：未安装 → 指引安装；无模型 → 指引 opencode models', () => {
  assert.match(provider.failureHint({ ok: false, status: 'OPENCODE_UNAVAILABLE' }), /安装 OpenCode|设置面板/)
  assert.match(provider.failureHint({ ok: false, status: 'ERROR', stderr: 'No models available' }), /opencode_models|opencode models/)
  assert.match(provider.failureHint({ ok: false, status: 'ERROR', stderr: 'Incorrect API key provided' }), /opencode auth login/)
  assert.equal(provider.failureHint({ ok: true }), '')
})
