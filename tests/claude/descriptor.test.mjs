// tests/claude/descriptor.test.mjs — providers/claude.mjs 描述符契约与解析语义。
// flag 与事件形态以本机实测 Claude Code 2.0.76（claude --help / -p json / stream-json）为准。
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import defineProvider, { parseSupportedModels, resolveExePrefix, claudeExeCandidates, splitExeSpec, resetModelsCache } from '../../providers/claude.mjs'
import { POLICY_TEXT } from '../../providers/claude-policy.mjs'

const FIX = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const provider = defineProvider({ env: {} })

// ── 契约字段（PROVIDER-CONTRACT.md §1）─────────────────────────────────────────
test('★ 契约字段齐备', () => {
  assert.equal(provider.id, 'claude')
  assert.equal(provider.label, 'CLAUDE')
  assert.equal(provider.presetId, 'claude-first')
  assert.equal(provider.defaultBackend, null)
  assert.equal(provider.defaultMode, 'auto')
  assert.equal(provider.exeName, 'claude')
  assert.deepEqual(provider.binEnvVars, ['CLAUDE_BIN', 'CLAUDE_CLI', 'CLAUDE_CODE_BIN'])
  assert.equal(provider.unavailableStatus, 'CLAUDE_UNAVAILABLE')
  for (const f of ['backends', 'normalizeBackend', 'resolveBackend', 'buildArgv', 'parseJson', 'buildResult', 'foldStreamEvent', 'runToolLogic', 'continueToolLogic', 'statusToolLogic', 'attach', 'listModels']) {
    assert.equal(typeof provider[f], 'function', f + ' must be a function')
  }
  assert.equal(provider.backends(), null)
  assert.equal(provider.normalizeBackend('anything'), null)
  assert.equal(provider.resolveBackend({}, {}, 'x'), null)
  assert.equal(provider.mcp.version, undefined, 'mcp.version comes from the host injection (mcp/version.mjs)')
  assert.deepEqual(provider.mcp, {})
})

test('三工具名与 schema 形状（claude_ 前缀，prompt 必填）', () => {
  assert.equal(provider.tools.run.name, 'claude_run')
  assert.equal(provider.tools.continue.name, 'claude_continue')
  assert.equal(provider.tools.status.name, 'claude_status')
  for (const k of ['run', 'continue', 'status']) {
    const t = provider.tools[k]
    assert.equal(t.inputSchema.type, 'object')
    assert.ok(t.description.length > 40)
  }
  assert.deepEqual(provider.tools.run.inputSchema.required, ['prompt'])
  assert.deepEqual(provider.tools.continue.inputSchema.required, ['prompt'])
  assert.deepEqual(provider.tools.run.inputSchema.properties.mode.enum, ['auto', 'plan', 'accept-edits', 'bypass'])
})

// ── 可执行文件解析 ────────────────────────────────────────────────────────────
test('claudeExeCandidates：binPath > env > PATH 兜底名，且去重', () => {
  const env = { CLAUDE_BIN: 'C:/env/claude.exe', CLAUDE_CLI: 'C:/env/claude.exe' }
  const list = claudeExeCandidates(env, 'C:/panel/claude.exe')
  assert.deepEqual(list.slice(0, 2), ['C:/panel/claude.exe', 'C:/env/claude.exe'])
  assert.equal(list[list.length - 1], 'claude', 'PATH 名字永远是最后兜底')
  assert.equal(list.filter((x) => x === 'C:/env/claude.exe').length, 1, 'dedupes')
})

test('resolveExePrefix：.mjs 目标经 node 包装；裸 exe 直通', () => {
  const p1 = resolveExePrefix({ CLAUDE_BIN: 'C:/fake/fake-claude.mjs' }, '')
  assert.equal(p1.length, 2)
  assert.ok(p1[0].includes('node'))
  assert.equal(p1[1], 'C:/fake/fake-claude.mjs')
  assert.deepEqual(resolveExePrefix({ CLAUDE_BIN: 'C:/native/claude.exe' }, ''), ['C:/native/claude.exe'])
  assert.deepEqual(resolveExePrefix({}, ''), ['claude'], '无 env/设置 → PATH 名')
})

test('splitExeSpec：三种形态（node / shell / binary）', () => {
  assert.equal(splitExeSpec('C:/a/claude.mjs').kind, 'node')
  const cmd = splitExeSpec('C:/npm/claude.cmd')
  assert.equal(cmd.kind, 'shell')
  assert.equal(cmd.shell, true, 'Windows 的 .cmd 必须 shell 执行')
  assert.equal(splitExeSpec('C:/native/claude.exe').shell, false)
})

// ── buildArgv ────────────────────────────────────────────────────────────────
test('buildArgv 默认：-p <prompt> + stream-json + verbose + skip-permissions', () => {
  const b = provider.buildArgv(['claude'], { prompt: 'Reply exactly: PONG' }, { planActive: false })
  assert.deepEqual(b.argv, ['claude', '-p', 'Reply exactly: PONG', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'])
  assert.equal(b.mode, 'bypass', 'auto + 非 plan 会话 → bypass（-p 无 TTY，不能等批准）')
  assert.equal(b.timeoutSec, 600)
})

test('buildArgv：auto + plan 会话 → --permission-mode plan（不叠加 bypass）', () => {
  const b = provider.buildArgv(['claude'], { prompt: 'p' }, { planActive: true })
  assert.equal(b.mode, 'plan')
  assert.ok(b.argv.includes('--permission-mode') && b.argv.includes('plan'))
  assert.ok(!b.argv.includes('--dangerously-skip-permissions'))
})

test('buildArgv：accept-edits 走 --permission-mode acceptEdits；bypass 走 skip-permissions', () => {
  const a = provider.buildArgv(['claude'], { prompt: 'p', mode: 'accept-edits' }, {})
  assert.equal(a.mode, 'accept-edits')
  assert.deepEqual(a.argv.slice(a.argv.indexOf('--permission-mode')), ['--permission-mode', 'acceptEdits'])
  const b = provider.buildArgv(['claude'], { prompt: 'p', mode: 'bypass' }, {})
  assert.ok(b.argv.includes('--dangerously-skip-permissions'))
})

test('buildArgv：非法 mode 回落 auto（不把脏值透传给 CLI）', () => {
  const b = provider.buildArgv(['claude'], { prompt: 'p', mode: 'yolo' }, { planActive: false })
  assert.equal(b.mode, 'bypass')
})

test('buildArgv：stream=false → 单行 json（不带 --verbose）', () => {
  const b = provider.buildArgv(['claude'], { prompt: 'p', stream: false }, {})
  assert.deepEqual(b.argv.slice(3, 5), ['--output-format', 'json'])
  assert.ok(!b.argv.includes('--verbose'))
})

test('buildArgv：model 优先级 参数 > 设置面板 > kit 注入', () => {
  const withPanel = defineProvider({ env: {}, readSettings: () => ({ partition: { defaultModel: 'panel-model' }, path: 'x' }) })
  const b1 = withPanel.buildArgv(['claude'], { prompt: 'p' }, { defaultModel: 'kit-model' })
  assert.equal(b1.argv[b1.argv.indexOf('--model') + 1], 'panel-model')
  const b2 = withPanel.buildArgv(['claude'], { prompt: 'p', model: 'call-model' }, { defaultModel: 'kit-model' })
  assert.equal(b2.argv[b2.argv.indexOf('--model') + 1], 'call-model')
  const b3 = provider.buildArgv(['claude'], { prompt: 'p' }, { defaultModel: 'kit-model' })
  assert.equal(b3.argv[b3.argv.indexOf('--model') + 1], 'kit-model')
  const b4 = provider.buildArgv(['claude'], { prompt: 'p' }, {})
  assert.ok(!b4.argv.includes('--model'), '无任何来源 → 不传 --model，交给 claude 自身配置')
})

test('buildArgv：预算/目录/工具白名单/系统提示/续聊参数', () => {
  const b = provider.buildArgv(['claude'], {
    prompt: 'p', maxBudgetUsd: 0.5, addDirs: ['C:/a', 'C:/b'], allowedTools: ['Read', 'Bash(git:*)'],
    disallowedTools: ['WebFetch'], systemPrompt: 'sys', appendSystemPrompt: 'app',
    sessionId: 'sid-1', forkSession: true
  }, {})
  const at = (f) => b.argv[b.argv.indexOf(f) + 1]
  assert.equal(at('--max-budget-usd'), '0.5')
  assert.deepEqual(b.argv.filter((x, i, arr) => arr[i - 1] === '--add-dir'), ['C:/a', 'C:/b'])
  assert.equal(at('--allowedTools'), 'Read,Bash(git:*)')
  assert.equal(at('--disallowedTools'), 'WebFetch')
  assert.equal(at('--system-prompt'), 'sys')
  assert.equal(at('--append-system-prompt'), 'app')
  assert.equal(at('--resume'), 'sid-1')
  assert.ok(b.argv.includes('--fork-session'))
})

test('buildArgv：latest 续聊用 --continue；fork 只在续聊时生效', () => {
  const b = provider.buildArgv(['claude'], { prompt: 'p', continueLatest: true }, {})
  assert.ok(b.argv.includes('--continue'))
  assert.ok(!b.argv.includes('--resume'))
  assert.ok(!b.argv.includes('--fork-session'), 'forkSession 无续聊目标时不透传')
  const b2 = provider.buildArgv(['claude'], { prompt: 'p', forkSession: true }, {})
  assert.ok(!b2.argv.includes('--fork-session'))
})

test('buildArgv：maxBudgetUsd 非正数/脏值不透传', () => {
  for (const v of [0, -1, 'abc', '', null]) {
    const b = provider.buildArgv(['claude'], { prompt: 'p', maxBudgetUsd: v }, {})
    assert.ok(!b.argv.includes('--max-budget-usd'), 'budget ' + JSON.stringify(v) + ' must be ignored')
  }
})

// ── parseJson ───────────────────────────────────────────────────────────────
test('parseJson：stream-json 多行只取最后一个 result 事件', () => {
  const text = [
    '{"type":"system","subtype":"init","session_id":"s1"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"FIRST"}',
    '{"type":"result","subtype":"success","is_error":false,"result":"LAST"}'
  ].join('\n')
  const r = provider.parseJson(text)
  assert.equal(r.result, 'LAST')
})

test('parseJson：单行 json / 前后杂日志 / 空输入', () => {
  assert.equal(provider.parseJson('{"type":"result","result":"X","is_error":false}').result, 'X')
  assert.equal(provider.parseJson('log line\n{"type":"result","result":"Y"}\n trailing').result, 'Y')
  assert.equal(provider.parseJson(''), null)
  assert.equal(provider.parseJson('no json here'), null)
  assert.equal(provider.parseJson('{"type":"assistant"}'), null, '无 result 事件即 null（交给 buildResult 判 PARSE_ERROR）')
})

// ── buildResult（成功判定陷阱，最关键的一组）───────────────────────────────────
function resultLine(fields) {
  return JSON.stringify(Object.assign({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 5505, duration_api_ms: 4772,
    num_turns: 1, result: 'PONG', session_id: '74c50a7a-1111', total_cost_usd: 0.0757,
    usage: { input_tokens: 22631, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 3 },
    modelUsage: { 'm-small': { inputTokens: 10, outputTokens: 2, costUSD: 0.001 }, 'deepseek-v4-pro[1m]': { inputTokens: 22631, outputTokens: 3, costUSD: 0.0679 } },
    permission_denials: []
  }, fields))
}

test('buildResult 成功：exit 0 + is_error false → SUCCESS 且字段齐全', () => {
  const line = resultLine({})
  const r = provider.buildResult(provider.parseJson(line), { exitCode: 0 }, 'bypass', '', line, null)
  assert.equal(r.ok, true)
  assert.equal(r.status, 'SUCCESS')
  assert.equal(r.response, 'PONG')
  assert.equal(r.sessionId, '74c50a7a-1111')
  assert.equal(r.numTurns, 1)
  assert.equal(r.durationSeconds, 5.5)
  assert.equal(r.totalTokens, 22631 + 100 + 3, 'input + cache_read + output')
  assert.equal(r.modelUsed, 'deepseek-v4-pro[1m]', 'modelUsage 里花费最大的那个')
  assert.equal(r.costUsd, 0.0757)
})

test('⚠️ 陷阱：is_error=true + exit 1（无效模型实测形态）必须判失败', () => {
  const line = resultLine({ is_error: true, subtype: 'success', result: 'API Error: 400 bad model' })
  const r = provider.buildResult(provider.parseJson(line), { exitCode: 1 }, 'bypass', '', line, null)
  assert.equal(r.ok, false)
  assert.equal(r.status, 'EXEC_ERROR')
  assert.equal(r.subtype, 'success', 'subtype 仍是 success —— 所以判定绝不能看 subtype 或 exit code 单值')
  assert.match(r.stderr, /API Error: 400/, 'is_error 正文必须进 stderr（供限流/指引判定）')
  assert.match(r.response, /API Error: 400/)
})

test('⚠️ 陷阱：is_error=true + exit 0 也必须判失败', () => {
  const line = resultLine({ is_error: true, result: 'API Error: 429 rate limit' })
  const r = provider.buildResult(provider.parseJson(line), { exitCode: 0 }, 'bypass', '', line, null)
  assert.equal(r.ok, false)
  assert.equal(r.status, 'EXEC_ERROR')
})

test('错误码映射：130 → ABORTED；error_max_turns → MAX_TURNS；exit 非 0 无 is_error → CLI_ERROR', () => {
  const aborted = provider.buildResult(provider.parseJson(resultLine({})), { exitCode: 130 }, 'bypass', '', '', null)
  assert.equal(aborted.status, 'ABORTED')
  assert.equal(aborted.ok, false)
  const maxTurns = provider.buildResult(provider.parseJson(resultLine({ is_error: true, subtype: 'error_max_turns' })), { exitCode: 1 }, 'bypass', '', '', null)
  assert.equal(maxTurns.status, 'MAX_TURNS')
  const cliErr = provider.buildResult(provider.parseJson(resultLine({ subtype: 'weird' })), { exitCode: 3 }, 'bypass', '', '', null)
  assert.equal(cliErr.status, 'CLI_ERROR')
  assert.equal(cliErr.ok, false)
})

test('buildResult 无 result 事件：exit 0 → PARSE_ERROR；exit≠0 → CLI_ERROR，均带 rawStdout', () => {
  const r1 = provider.buildResult(null, { exitCode: 0 }, 'bypass', 'errtxt', 'garbage', null)
  assert.equal(r1.status, 'PARSE_ERROR')
  assert.equal(r1.ok, false)
  assert.equal(r1.rawStdout, 'garbage')
  assert.match(r1.stderr, /errtxt/)
  const r2 = provider.buildResult(null, { exitCode: 2 }, 'bypass', '', 'usage: claude', null)
  assert.equal(r2.status, 'CLI_ERROR')
})

// ── foldStreamEvent（实时步骤）───────────────────────────────────────────────
function mkProject() { return { trail: [], current: null, updatedAt: 0 } }
const summarize = (o) => o || null

test('foldStreamEvent：init → current，tool_use → trail ACTIVE，tool_result → DONE，result → 清空', () => {
  const p = mkProject()
  provider.foldStreamEvent({ type: 'system', subtype: 'init', model: 'm1', permissionMode: 'bypassPermissions' }, p, summarize, 120, 12)
  assert.equal(p.current.tool, 'session')
  assert.equal(p.current.args.model, 'm1')
  provider.foldStreamEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }, p, summarize, 120, 12)
  assert.equal(p.trail.length, 1)
  assert.equal(p.trail[0].state, 'ACTIVE')
  assert.equal(p.trail[0].tool, 'Bash')
  assert.deepEqual(p.trail[0].args, { command: 'ls' })
  assert.equal(p.current.tool, 'Bash')
  provider.foldStreamEvent({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }, p, summarize, 120, 12)
  assert.equal(p.trail[0].state, 'DONE')
  assert.equal(p.current, null)
  provider.foldStreamEvent({ type: 'result', is_error: false }, p, summarize, 120, 12)
  assert.equal(p.current, null)
})

test('foldStreamEvent：tool_result is_error → ERROR；text/thinking → agent_response/reasoning', () => {
  const p = mkProject()
  provider.foldStreamEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file: 'a' } }] } }, p, summarize, 120, 12)
  provider.foldStreamEvent({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } }, p, summarize, 120, 12)
  assert.equal(p.trail[0].state, 'ERROR')
  provider.foldStreamEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } }, p, summarize, 120, 12)
  assert.equal(p.current.tool, 'agent_response')
  assert.equal(p.current.args.text_delta, 'answer')
  provider.foldStreamEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x'.repeat(300) }] } }, p, summarize, 40, 12)
  assert.equal(p.current.tool, 'reasoning')
  assert.equal(p.current.args.text_delta.length, 40, 'text_delta 截断到 maxArgLen')
})

test('foldStreamEvent：trail 上限裁剪 & 畸形事件不抛', () => {
  const p = mkProject()
  for (let i = 0; i < 20; i++) provider.foldStreamEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'T' + i, input: {} }] } }, p, summarize, 120, 5)
  assert.equal(p.trail.length, 5)
  assert.equal(p.trail[4].tool, 'T19')
  for (const bad of [null, {}, { type: 'assistant' }, { type: 'assistant', message: { content: 'x' } }, { type: 'unknown' }]) {
    assert.doesNotThrow(() => provider.foldStreamEvent(bad, p, summarize, 120, 12))
  }
})

// ── failureHint / isTransientCliError ────────────────────────────────────────
test('failureHint：400 拒绝时把服务端支持清单写进诊断', () => {
  const r = provider.buildResult(provider.parseJson(resultLine({
    is_error: true,
    result: 'API Error: 400 {"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed __probe_invalid__."}}'
  })), { exitCode: 1 }, 'bypass', '', '', null)
  const hint = provider.failureHint(r)
  assert.match(hint, /deepseek-flash, deepseek-v4-pro/)
  assert.match(hint, /claude_models/)
  assert.match(provider.failureHint({ ok: false, status: 'CLAUDE_UNAVAILABLE' }), /CLAUDE_BIN|安装/)
  assert.equal(provider.failureHint({ ok: true }), '')
})

test('isTransientCliError：过载/连接类才重试，模型名与凭据类不重试', () => {
  assert.equal(provider.isTransientCliError({ ok: true }), false)
  assert.equal(provider.isTransientCliError({ ok: false, status: 'EXEC_ERROR', stderr: 'API Error: 529 overloaded' }), true)
  assert.equal(provider.isTransientCliError({ ok: false, status: 'EXEC_ERROR', stderr: 'connection reset by peer' }), true)
  assert.equal(provider.isTransientCliError({ ok: false, status: 'EXEC_ERROR', stderr: 'The supported API model names are a, b' }), false)
  assert.equal(provider.isTransientCliError({ ok: false, status: 'EXEC_ERROR', stderr: '401 unauthorized' }), false)
  // kit 的 isLimited 命中（socket/rate limit 等）时走限流弹窗，不属于「静默重试」范畴。
  assert.equal(provider.isTransientCliError({ ok: false, status: 'EXEC_ERROR', stderr: 'socket hang up' }), false)
})

// ── extraTools / settings ───────────────────────────────────────────────────
test('claude_models：extraTools 常驻注册（三形态都暴露），schema 合法', () => {
  const et = provider.extraTools
  assert.equal(et.length, 1)
  assert.equal(et[0].name, 'claude_models')
  assert.equal(et[0].inputSchema.type, 'object')
  assert.deepEqual(et[0].inputSchema.required, [])
  assert.equal(typeof et[0].logic, 'function')
  assert.equal(typeof et[0].render, 'function')
  // 动态沙箱形态（deps 只有 env）也必须有它：探测能力来自 node child_process，不是 deps。
  assert.equal(defineProvider({ env: {} }).extraTools.length, 1)
})

test('settings：keys/defaults/normalize', () => {
  const s = provider.settings
  assert.deepEqual(s.keys, ['binPath', 'defaultModel', 'maxBudgetUsd'])
  assert.deepEqual(s.defaults(), { binPath: '', defaultModel: '', maxBudgetUsd: '' })
  assert.deepEqual(s.normalize({ binPath: ' C:/x ', defaultModel: ' m ', maxBudgetUsd: ' 0.5 ', junk: 'z' }), { binPath: 'C:/x', defaultModel: 'm', maxBudgetUsd: '0.5' })
  assert.deepEqual(s.normalize(null), { binPath: '', defaultModel: '', maxBudgetUsd: '' })
  assert.equal(s.normalize({ binPath: 42 }).binPath, '', '非字符串字段不进分区')
})

test('settings.meta：defaultModel 下拉来自实时探测（fixture），探测失败则空 + 明确说明', () => {
  resetModelsCache()
  const okEnv = { CLAUDE_BIN: FIX, USERPROFILE: '' }
  const meta = provider.settings.meta(okEnv)
  assert.equal(meta.titleSuffix, 'Claude Code')
  const modelField = meta.fields.find((f) => f.key === 'defaultModel')
  assert.deepEqual(modelField.options.map((o) => o.value), ['fake-model-alpha', 'fake-model-beta'])
  assert.ok(modelField.note.includes('服务端权威'))
  // 缓存生效：第二次调用拿到同一份结果（面板频繁渲染不会反复打网络）。
  const second = provider.settings.meta(okEnv)
  assert.deepEqual(second.fields.find((f) => f.key === 'defaultModel').options.map((o) => o.value), ['fake-model-alpha', 'fake-model-beta'])

  resetModelsCache()
  const badEnv = { CLAUDE_BIN: 'C:/definitely-not-here/claude.exe', USERPROFILE: '' }
  const meta2 = provider.settings.meta(badEnv)
  const f2 = meta2.fields.find((f) => f.key === 'defaultModel')
  assert.deepEqual(f2.options, [], '探测失败 → 空下拉（绝不塞配置里的别名冒充可用清单）')
  assert.match(f2.note, /未能获取服务端权威模型清单/)
  assert.equal(meta2.fields.find((f) => f.key === 'binPath').allowCustom, true)
})

test('settings.diagnose：一行文本包含 bin/model 来源', () => {
  const text = provider.settings.diagnose({ defaultModel: 'm1', maxBudgetUsd: '2' }, { CLAUDE_BIN: 'C:/x/claude.exe', USERPROFILE: '' })
  assert.match(text, /bin=/)
  assert.match(text, /model=m1/)
  assert.match(text, /maxBudget=\$2/)
})

// ── 工具逻辑（background 默认 true；continue 的 session/latest 语义）──────────
test('runToolLogic：background 缺省 true，显式 false 才前台', async () => {
  const seen = []
  const fake = { runner: { coreExecute: (a) => { seen.push(a); return a } } }
  await provider.runToolLogic.call(fake, { prompt: 'p' })
  await provider.runToolLogic.call(fake, { prompt: 'p', background: false })
  assert.equal(seen[0].background, true)
  assert.equal(seen[1].background, false)
})

test('continueToolLogic：sessionId → sessionId；latest → continueLatest；background 缺省 true', async () => {
  const seen = []
  const fake = { runner: { coreExecute: (a) => { seen.push(a); return a } } }
  await provider.continueToolLogic.call(fake, { prompt: 'p', sessionId: 'sid-9' })
  await provider.continueToolLogic.call(fake, { prompt: 'p', latest: true })
  await provider.continueToolLogic.call(fake, { prompt: 'p' })
  assert.equal(seen[0].sessionId, 'sid-9')
  assert.equal(seen[0].background, true)
  assert.equal(seen[1].continueLatest, true)
  assert.equal(seen[1].sessionId, undefined, 'latest 不得伪造 sessionId')
  assert.equal(seen[2].continueLatest, undefined)
})

// ── policy 文案（preset / dynamic 共用同一常量）──────────────────────────────
test('POLICY_TEXT：覆盖决策表/凭据归属/模型权威源', () => {
  assert.match(POLICY_TEXT, /claude-first execution policy/)
  assert.match(POLICY_TEXT, /claude_run/)
  assert.match(POLICY_TEXT, /claude_continue/)
  assert.match(POLICY_TEXT, /claude_models/)
  assert.match(POLICY_TEXT, /ANTHROPIC_\*_MODEL/)
  assert.match(POLICY_TEXT, /~\/\.claude\/settings\.json/)
  assert.match(POLICY_TEXT, /NEVER call claude again/, 'fallback=true 的纪律必须写进提示词')
})

test('parseSupportedModels：真实 400 报文与容错形态', () => {
  const real = 'API Error: 400 {"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed __clb_probe_invalid__. (request_id: e244)"}}'
  assert.deepEqual(parseSupportedModels(real), ['deepseek-flash', 'deepseek-v4-pro'])
  assert.deepEqual(parseSupportedModels('the supported API model names are gpt-5.4, claude-opus-4.8.'), ['gpt-5.4', 'claude-opus-4.8'], '句点结尾不清掉模型名内部的点')
  assert.equal(parseSupportedModels('nothing here'), null)
  assert.equal(parseSupportedModels('The supported API model names are __clb_probe_invalid__.'), null, '只剩探测名 → 无有效清单')
})
