// tests/codex/descriptor.test.mjs — providers/codex.mjs 描述符契约与解析语义。
//
// 全部 flag/事件形态以 codex-cli 0.98.0 本机实测为准（见 providers/codex.mjs 头注）：
// 最关键的两条反面事实是「exec 不接受 -a」与「resume 不接受 -C/-s/--add-dir」，
// 这里用断言把它们钉死，防止将来凭想象加旗。
import test from 'node:test'
import assert from 'node:assert/strict'

import defineProvider from '../../providers/codex.mjs'

// 空 env：不探测真实 ~/.codex，保证密闭。
const provider = defineProvider({ env: {} })

// ── 真实抓到的三条事件流（逐字来自本机运行）────────────────────────────────────
const SUCCESS_STREAM = [
  '{"type":"thread.started","thread_id":"01a154f6-06c9-7011-a742-e532461b9b74"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}',
  '{"type":"turn.completed","usage":{"input_tokens":17205,"cached_input_tokens":7809,"output_tokens":3}}'
].join('\n')

// 续聊实测：thread.started 后先来一条 item.completed(item.type=error) 的**告警**，
// 然后是 turn.started / agent_message / turn.completed —— 告警绝不能当致命错。
const WARN_RESUME_STREAM = [
  '{"type":"thread.started","thread_id":"01a154f6-698f-7400-8d1b-02197a52b4f8"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"This session was recorded with model `__probe_invalid__` but is resuming with `minimax/minimax-m3.1-flash:free`."}}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"PONG_LAST"}}',
  '{"type":"turn.completed","usage":{"input_tokens":31227,"cached_input_tokens":17197,"output_tokens":168}}'
].join('\n')

// 无效模型实测：stdout 仍是合法事件流，但只有 thread.started/turn.started/error/
// turn.failed（**没有** turn.completed），退出码 1。
const ERROR_STREAM = [
  '{"type":"thread.started","thread_id":"01a154f6-698f-7400-8d1b-02197a52b4f8"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"{\\"error\\":{\\"message\\":\\"__probe_invalid__ is not a valid model ID\\",\\"code\\":400}}"}',
  '{"type":"turn.failed","error":{"message":"__probe_invalid__ is not a valid model ID"}}'
].join('\n')

test('契约 ★ 字段齐备（PROVIDER-CONTRACT.md §1）', () => {
  assert.equal(provider.id, 'codex')
  assert.equal(provider.label, 'CODEX')
  assert.equal(provider.presetId, 'codex-first')
  assert.equal(provider.defaultBackend, null)
  assert.equal(provider.defaultMode, 'auto')
  assert.equal(provider.exeName, 'codex')
  assert.deepEqual(provider.binEnvVars, ['CODEX_BIN', 'CODEX_CLI'])
  assert.equal(provider.unavailableStatus, 'CODEX_UNAVAILABLE')
  for (const f of ['backends', 'normalizeBackend', 'resolveBackend', 'buildArgv', 'parseJson', 'buildResult', 'foldStreamEvent', 'runToolLogic', 'continueToolLogic', 'statusToolLogic', 'attach']) {
    assert.equal(typeof provider[f], 'function', f + ' must be a function')
  }
  assert.equal(provider.tools.run.name, 'codex_run')
  assert.equal(provider.tools.continue.name, 'codex_continue')
  assert.equal(provider.tools.status.name, 'codex_status')
  assert.equal(provider.mcp.version, '0.2.8')
})

test('单后端归一：任何取值都是 null', () => {
  assert.equal(provider.backends(), null)
  for (const v of ['codex', 'CODEX', 'openai', '', null, undefined]) {
    assert.equal(provider.normalizeBackend(v), null, 'normalizeBackend(' + String(v) + ')')
  }
  assert.equal(provider.resolveBackend({}, {}, null), null)
})

// ── buildArgv（实测 flag 集）─────────────────────────────────────────────────
test('buildArgv 基础形态：exec --json --skip-git-repo-check -s … <prompt>', () => {
  const b = provider.buildArgv('codex', { prompt: 'do it' }, { planActive: false })
  assert.deepEqual(b.argv, ['codex', 'exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', 'do it'])
  assert.equal(b.mode, 'accept-edits')
  assert.equal(b.timeoutSec, 900)
})

test('buildArgv：prompt 必须是最后一个位置参数（codex exec 语义）', () => {
  const b = provider.buildArgv(['codex'], { prompt: 'x', mode: 'plan', model: 'm', cwd: 'C:/w', addDirs: ['C:/a'], images: ['i.png'] }, {})
  assert.equal(b.argv[b.argv.length - 1], 'x')
})

test('buildArgv：绝不出现 -a / --ask-for-approval（codex exec 实测直接报错）', () => {
  const cases = [
    { prompt: 'x' },
    { prompt: 'x', mode: 'plan' },
    { prompt: 'x', sessionId: 'sid' },
    { prompt: 'x', latest: true }
  ]
  for (const c of cases) {
    const b = provider.buildArgv(['codex'], c, {})
    assert.ok(b.argv.indexOf('-a') < 0, '-a must never be emitted')
    assert.ok(b.argv.indexOf('--ask-for-approval') < 0, '--ask-for-approval must never be emitted')
  }
})

test('buildArgv：-C 只给 exec；cwd 由 spawn 承担（resume 传 -C 实测报错）', () => {
  const exec = provider.buildArgv(['codex'], { prompt: 'x', cwd: 'C:/work' }, {})
  assert.ok(exec.argv.includes('-C') && exec.argv.includes('C:/work'))
  const resume = provider.buildArgv(['codex'], { prompt: 'x', cwd: 'C:/work', sessionId: 'sid-1' }, {})
  assert.ok(!resume.argv.includes('-C'), 'resume must not emit -C')
})

test('buildArgv 续聊：resume <sid> … <prompt>，沙箱改走 -c sandbox_mode', () => {
  const b = provider.buildArgv(['codex'], { prompt: 'more', sessionId: 'abc-123' }, {})
  assert.deepEqual(b.argv.slice(0, 4), ['codex', 'exec', 'resume', 'abc-123'])
  assert.ok(b.argv.includes('--json') && b.argv.includes('--skip-git-repo-check'))
  assert.ok(!b.argv.includes('-s'), 'resume has no -s')
  const at = b.argv.indexOf('-c')
  assert.ok(at >= 0, '-c present')
  assert.match(b.argv[at + 1], /^sandbox_mode="(read-only|workspace-write|danger-full-access)"$/)
  assert.equal(b.argv[b.argv.length - 1], 'more')
})

test('buildArgv 续聊：latest=true → exec resume --last <prompt>', () => {
  const b = provider.buildArgv(['codex'], { prompt: 'again', continueLatest: true }, {})
  assert.deepEqual(b.argv.slice(0, 4), ['codex', 'exec', 'resume', '--last'])
  assert.equal(b.argv[b.argv.length - 1], 'again')
})

test('buildArgv：add-dir 只在 exec（resume 无 --add-dir）', () => {
  const exec = provider.buildArgv(['codex'], { prompt: 'x', addDirs: ['C:/a', '', 'C:/b'] }, {})
  assert.deepEqual(exec.argv.filter((x) => x === '--add-dir').length, 2)
  assert.ok(exec.argv.includes('C:/a') && exec.argv.includes('C:/b'))
  const resume = provider.buildArgv(['codex'], { prompt: 'x', latest: true, addDirs: ['C:/a'] }, {})
  assert.ok(!resume.argv.includes('--add-dir'))
})

test('buildArgv：mode=plan → read-only 沙箱（plan 模式禁写）', () => {
  const b = provider.buildArgv(['codex'], { prompt: 'x', mode: 'plan' }, {})
  assert.equal(b.argv[b.argv.indexOf('-s') + 1], 'read-only')
  // planActive 时 auto 也落 read-only。
  const viaPlan = provider.buildArgv(['codex'], { prompt: 'x' }, { planActive: true })
  assert.equal(viaPlan.mode, 'plan')
  assert.equal(viaPlan.argv[viaPlan.argv.indexOf('-s') + 1], 'read-only')
})

test('buildArgv：sandboxMode 参数 > 设置 > mode 派生', () => {
  const p = defineProvider({ env: {}, readSettings: () => ({ partition: { sandboxMode: 'danger-full-access' } }) })
  const fromSetting = p.buildArgv(['codex'], { prompt: 'x' }, {})
  assert.equal(fromSetting.argv[fromSetting.argv.indexOf('-s') + 1], 'danger-full-access')
  const fromArg = p.buildArgv(['codex'], { prompt: 'x', sandboxMode: 'read-only' }, {})
  assert.equal(fromArg.argv[fromArg.argv.indexOf('-s') + 1], 'read-only')
})

test('buildArgv：model 优先级 = 参数 > opts.defaultModel > 设置', () => {
  const p = defineProvider({ env: {}, readSettings: () => ({ partition: { defaultModel: 'from-settings' } }) })
  assert.equal(p.buildArgv(['codex'], { prompt: 'x' }, {}).argv[p.buildArgv(['codex'], { prompt: 'x' }, {}).argv.indexOf('-m') + 1], 'from-settings')
  const viaOpts = p.buildArgv(['codex'], { prompt: 'x' }, { defaultModel: 'from-opts' })
  assert.equal(viaOpts.argv[viaOpts.argv.indexOf('-m') + 1], 'from-opts')
  const viaArg = p.buildArgv(['codex'], { prompt: 'x', model: 'from-arg' }, { defaultModel: 'from-opts' })
  assert.equal(viaArg.argv[viaArg.argv.indexOf('-m') + 1], 'from-arg')
})

test('buildArgv：审批策略与 reasoningEffort 走 -c（TOML 字符串）', () => {
  const p = defineProvider({ env: {}, readSettings: () => ({ partition: { approvalPolicy: 'never' } }) })
  const b = p.buildArgv(['codex'], { prompt: 'x', reasoningEffort: 'high' }, {})
  assert.ok(b.argv.includes('approval_policy="never"'))
  assert.ok(b.argv.includes('model_reasoning_effort="high"'))
  // 非法取值不进 argv（不做静默近似）。
  const bad = p.buildArgv(['codex'], { prompt: 'x', reasoningEffort: 'ultra' }, {})
  assert.ok(!bad.argv.some((x) => String(x).indexOf('model_reasoning_effort') >= 0))
  const noSetting = defineProvider({ env: {} }).buildArgv(['codex'], { prompt: 'x' }, {})
  assert.ok(!noSetting.argv.some((x) => String(x).indexOf('approval_policy') >= 0))
})

test('buildArgv：images 落地为 -i（exec 与 resume 都支持）', () => {
  const b = provider.buildArgv(['codex'], { prompt: 'x', images: ['a.png', '', 'b.png'] }, {})
  assert.deepEqual(b.argv.filter((x) => x === '-i').length, 2)
  const r = provider.buildArgv(['codex'], { prompt: 'x', latest: true, images: ['a.png'] }, {})
  assert.ok(r.argv.includes('-i') && r.argv.includes('a.png'))
})

test('buildArgv：timeoutSec 夹在 10..3600，缺省 900', () => {
  assert.equal(provider.buildArgv(['codex'], { prompt: 'x' }, {}).timeoutSec, 900)
  assert.equal(provider.buildArgv(['codex'], { prompt: 'x', timeoutSec: 3 }, {}).timeoutSec, 10)
  assert.equal(provider.buildArgv(['codex'], { prompt: 'x', timeoutSec: 99999 }, {}).timeoutSec, 3600)
})

// ── parseJson ────────────────────────────────────────────────────────────────
test('parseJson：真实成功流 → threadId/response/usage/completed', () => {
  const p = provider.parseJson(SUCCESS_STREAM)
  assert.equal(p.type, 'turn.completed')
  assert.equal(p.threadId, '01a154f6-06c9-7011-a742-e532461b9b74')
  assert.equal(p.response, 'PONG')
  assert.equal(p.completed, true)
  assert.equal(p.error, null)
  assert.equal(p.numTurns, 1)
  assert.deepEqual(p.usage, { input_tokens: 17205, cached_input_tokens: 7809, output_tokens: 3 })
})

test('parseJson：续聊的 item.type=error 只是告警，不得判成致命错', () => {
  const p = provider.parseJson(WARN_RESUME_STREAM)
  assert.equal(p.completed, true)
  assert.equal(p.error, null, 'warning item must not be fatal')
  assert.equal(p.response, 'PONG_LAST')
})

test('parseJson：顶层 error + turn.failed → error 有值、completed=false', () => {
  const p = provider.parseJson(ERROR_STREAM)
  assert.equal(p.completed, false)
  assert.equal(p.error.message, '__probe_invalid__ is not a valid model ID')
  assert.equal(p.type, 'turn.failed')
})

test('parseJson：无 JSON（纯文本模式）→ null，交 buildResult 走文本兜底', () => {
  assert.equal(provider.parseJson('PONG\n'), null)
  assert.equal(provider.parseJson(''), null)
  assert.equal(provider.parseJson(null), null)
})

test('parseJson：坏行/非 JSON 行跳过，不抛', () => {
  const text = 'MCP node_repl starting\n' + SUCCESS_STREAM + '\n{ not json\n'
  const p = provider.parseJson(text)
  assert.equal(p.response, 'PONG')
})

test('parseJson：末条 agent_message 胜出（多次消息取最后一条）', () => {
  const text = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"id":"b","type":"agent_message","text":"second"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}'
  ].join('\n')
  assert.equal(provider.parseJson(text).response, 'second')
})

// ── buildResult ──────────────────────────────────────────────────────────────
test('buildResult：成功（退出码 0 + turn.completed）', () => {
  const res = provider.buildResult(provider.parseJson(SUCCESS_STREAM), { exitCode: 0 }, 'accept-edits', '', SUCCESS_STREAM, null)
  assert.equal(res.ok, true)
  assert.equal(res.status, 'SUCCESS')
  assert.equal(res.response, 'PONG')
  assert.equal(res.sessionId, '01a154f6-06c9-7011-a742-e532461b9b74')
  assert.equal(res.totalTokens, 17208)
  assert.equal(res.numTurns, 1)
  assert.equal(res.mode, 'accept-edits')
})

test('buildResult：退出码 1 + 400 → TURN_FAILED（不能只看退出码/文本）', () => {
  const res = provider.buildResult(provider.parseJson(ERROR_STREAM), { exitCode: 1 }, 'auto', 'ERROR codex_api: error=http 400 Bad Request', ERROR_STREAM, null)
  assert.equal(res.ok, false)
  assert.equal(res.status, 'TURN_FAILED')
  assert.match(res.errorMessage, /not a valid model ID/)
  assert.match(res.stderr, /400/)
})

test('buildResult：退出码 0 但没有 turn.completed → INCOMPLETE（不可当成功）', () => {
  const text = '{"type":"thread.started","thread_id":"t"}\n{"type":"turn.started"}'
  const res = provider.buildResult(provider.parseJson(text), { exitCode: 0 }, 'auto', '', text, null)
  assert.equal(res.ok, false)
  assert.equal(res.status, 'INCOMPLETE')
  assert.match(res.stderr, /turn\.completed/)
})

test('buildResult：退出码 2 → BAD_ARGS（参数错误，可行动）', () => {
  const res = provider.buildResult(null, { exitCode: 2 }, 'auto', "error: unexpected argument '-a' found", '', null)
  assert.equal(res.ok, false)
  assert.equal(res.status, 'BAD_ARGS')
})

test('buildResult：纯文本模式（无 JSON）→ exit 0 时 stdout 即答复', () => {
  const res = provider.buildResult(null, { exitCode: 0 }, 'auto', 'OpenAI Codex v0.98.0 (research preview)', 'PONG\n', null)
  assert.equal(res.ok, true)
  assert.equal(res.status, 'SUCCESS')
  assert.equal(res.response, 'PONG')
  assert.equal(res.sessionId, null)
})

test('buildResult：纯文本 + 非 0 → ERROR 且保留 rawStdout', () => {
  const res = provider.buildResult(null, { exitCode: 1 }, 'auto', 'boom', 'partial', null)
  assert.equal(res.ok, false)
  assert.equal(res.status, 'ERROR')
  assert.equal(res.rawStdout, 'partial')
})

// ── foldStreamEvent（实时步骤）───────────────────────────────────────────────
function mkProject() { return { current: null, trail: [], updatedAt: 0 } }

test('foldStreamEvent：thread.started → current 记录 thread_id', () => {
  const p = mkProject()
  provider.foldStreamEvent({ type: 'thread.started', thread_id: 'abc' }, p, null, 120, 12)
  assert.equal(p.current.tool, 'session')
  assert.equal(p.current.args.thread_id, 'abc')
})

test('foldStreamEvent：item.started→item.completed 同一 id 只记一条 trail 且状态收敛', () => {
  const p = mkProject()
  const item = { id: 'c1', type: 'command_execution', command: 'ls' }
  provider.foldStreamEvent({ type: 'item.started', item }, p, (a) => a, 120, 12)
  assert.equal(p.trail.length, 1)
  assert.equal(p.trail[0].state, 'ACTIVE')
  assert.equal(p.trail[0].tool, 'command')
  assert.equal(p.current.tool, 'command')
  provider.foldStreamEvent({ type: 'item.completed', item: Object.assign({}, item, { exit_code: 0, status: 'completed' }) }, p, (a) => a, 120, 12)
  assert.equal(p.trail.length, 1, 'completed 事件不应产生重复 trail')
  assert.equal(p.trail[0].state, 'DONE')
  assert.equal(p.current, null)
})

test('foldStreamEvent：失败的命令记 ERROR；告警 item 记 warning', () => {
  const p = mkProject()
  provider.foldStreamEvent({ type: 'item.completed', item: { id: 'x', type: 'command_execution', command: 'bad', exit_code: 1 } }, p, (a) => a, 120, 12)
  assert.equal(p.trail[0].state, 'ERROR')
  provider.foldStreamEvent({ type: 'item.completed', item: { id: 'w', type: 'error', message: 'warning text' } }, p, (a) => a, 120, 12)
  assert.equal(p.trail[1].tool, 'warning')
})

test('foldStreamEvent：agent_message/reasoning/file_change/mcp 各自归类', () => {
  const p = mkProject()
  provider.foldStreamEvent({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'hi' } }, p, (a) => a, 120, 12)
  provider.foldStreamEvent({ type: 'item.completed', item: { id: '2', type: 'reasoning', text: 'think' } }, p, (a) => a, 120, 12)
  provider.foldStreamEvent({ type: 'item.completed', item: { id: '3', type: 'file_change', changes: [{ path: 'a.mjs' }] } }, p, (a) => a, 120, 12)
  provider.foldStreamEvent({ type: 'item.completed', item: { id: '4', type: 'mcp_tool_call', server: 'node_repl', tool: 'eval' } }, p, (a) => a, 120, 12)
  assert.deepEqual(p.trail.map((e) => e.tool), ['agent_response', 'reasoning', 'file_change', 'mcp:node_repl/eval'])
})

test('foldStreamEvent：trail 受 maxTrail 限制；turn.completed 清 current', () => {
  const p = mkProject()
  for (let i = 0; i < 30; i++) provider.foldStreamEvent({ type: 'item.completed', item: { id: 'i' + i, type: 'agent_message', text: 't' } }, p, (a) => a, 120, 5)
  assert.equal(p.trail.length, 5)
  provider.foldStreamEvent({ type: 'turn.completed', usage: {} }, p, (a) => a, 120, 5)
  assert.equal(p.current, null)
})

// ── 失败分类与指引 ──────────────────────────────────────────────────────────
test('isTransientCliError：INCOMPLETE / 流断连 可重试；限流类不重试', () => {
  assert.equal(provider.isTransientCliError({ ok: false, status: 'INCOMPLETE' }), true)
  assert.equal(provider.isTransientCliError({ ok: false, status: 'ERROR', stderr: 'stream disconnected before completion' }), true)
  assert.equal(provider.isTransientCliError({ ok: false, status: 'ERROR', stderr: 'rate limit exceeded 429' }), false)
  assert.equal(provider.isTransientCliError({ ok: true, status: 'SUCCESS' }), false)
})

test('failureHint：模型/凭据/沙箱/不可用 各有可行动指引', () => {
  assert.match(provider.failureHint({ ok: false, status: 'CODEX_UNAVAILABLE' }), /CODEX_BIN/)
  assert.match(provider.failureHint({ ok: false, status: 'TURN_FAILED', errorMessage: 'x is not a valid model ID' }), /codex_models/)
  assert.match(provider.failureHint({ ok: false, status: 'TURN_FAILED', stderr: '401 Unauthorized' }), /codex login/)
  assert.match(provider.failureHint({ ok: false, status: 'ERROR', stderr: 'sandbox denied: operation not permitted' }), /sandboxMode/)
  assert.match(provider.failureHint({ ok: false, status: 'BAD_ARGS' }), /exit 2/)
  assert.equal(provider.failureHint({ ok: true, status: 'SUCCESS' }), '')
})

// ── settings.meta / settings.refreshModels（契约 §3.2 手动拉取）────────────────
// 假 fetch：只在 refreshModels / codex_models 被调用时才该有流量；meta() 一次都不许有。
function fetchSpy(response, stats) {
  return async () => {
    stats.calls += 1
    return {
      status: response.status,
      text: async () => (typeof response.body === 'string' ? response.body : JSON.stringify(response.body))
    }
  }
}
const LIVE_PAYLOAD = {
  data: [
    { id: 'live/free-model:free', pricing: { prompt: 0, completion: 0 } },
    { id: 'live/paid-model', pricing: { prompt: '0.000001', completion: '0.000002' } }
  ]
}

test('settings.meta：只读缓存、绝不探测（★ 不发请求），字段带 refresh 标记', () => {
  const stats = { calls: 0 }
  // 端点配得像真的，且 fetch 会成功 —— 若 meta() 偷偷探测，calls 就不再是 0。
  const p = defineProvider({ env: {}, fetch: fetchSpy({ status: 200, body: LIVE_PAYLOAD }, stats) })
  const env = { CODEX_BRIDGE_MODELS_URL: 'https://meta.test/never-probe/models' }
  const m = p.settings.meta(env)
  assert.equal(m.titleSuffix, 'Codex')
  const keys = m.fields.map((f) => f.key)
  assert.deepEqual(keys, ['binPath', 'defaultModel', 'sandboxMode', 'approvalPolicy'])
  const model = m.fields.find((f) => f.key === 'defaultModel')
  assert.equal(model.type, 'select')
  assert.equal(model.allowCustom, true)
  assert.deepEqual(model.options, [], '未拉取 → 空下拉（不会自动探测）')
  assert.deepEqual(model.refresh, { label: '拉取可用模型' })
  assert.match(model.note, /拉取可用模型/)
  assert.match(model.note, /还没拉取过/)
  assert.equal(stats.calls, 0, '★ meta() 绝不能发请求/起进程')
  const sandbox = m.fields.find((f) => f.key === 'sandboxMode')
  assert.ok(sandbox.options.some((o) => o.value === 'danger-full-access'))
})

test('settings.refreshModels：成功 → ok:true + ids + labels（[free] 标注）+ 写回缓存（meta 命中）', async () => {
  const stats = { calls: 0 }
  const p = defineProvider({ env: {}, fetch: fetchSpy({ status: 200, body: LIVE_PAYLOAD }, stats) })
  const env = { CODEX_BRIDGE_MODELS_URL: 'https://refresh.test/ok/models' }
  const r = await p.settings.refreshModels({}, env)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.ids, ['live/free-model:free', 'live/paid-model'])
  assert.equal(r.source, 'live')
  assert.match(r.labels['live/free-model:free'], /\[free\]/)
  assert.equal(r.labels['live/paid-model'], 'live/paid-model')
  assert.equal(stats.calls, 1)
  // 写回缓存的效果：随后 meta() 直接命中，且不再发请求。
  const model = p.settings.meta(env).fields.find((f) => f.key === 'defaultModel')
  assert.deepEqual(model.options.map((o) => o.value), ['live/free-model:free', 'live/paid-model'])
  assert.match(model.note, /上次拉取到 2 个模型/)
  assert.equal(stats.calls, 1, '★ meta() 命中缓存时不许再发请求')
})

test('settings.refreshModels：无 base_url → ok:false + 空 ids + 可操作错误', async () => {
  const p = defineProvider({ env: {} })
  const r = await p.settings.refreshModels({}, {})
  assert.equal(r.ok, false)
  assert.deepEqual(r.ids, [])
  assert.equal(r.source, 'live')
  assert.match(r.error, /base_url/)
  assert.match(r.error, /排查顺序/, '错误必须告诉用户下一步怎么做')
})

test('settings.refreshModels：端点 401 → 错误指向 token 且带排查步骤', async () => {
  const p = defineProvider({ env: {}, fetch: fetchSpy({ status: 401, body: 'bad token' }, { calls: 0 }) })
  const r = await p.settings.refreshModels({}, { CODEX_BRIDGE_MODELS_URL: 'https://refresh.test/401/models' })
  assert.equal(r.ok, false)
  assert.deepEqual(r.ids, [])
  assert.match(r.error, /HTTP 401/)
  assert.match(r.error, /credential/)
  assert.match(r.error, /排查顺序/)
})

test('settings.refreshModels：端点回 2xx 但零可用项 → 仍然 ok:false（绝不 ok:true 空清单）', async () => {
  const p = defineProvider({ env: {}, fetch: fetchSpy({ status: 200, body: { data: [] } }, { calls: 0 }) })
  const r = await p.settings.refreshModels({}, { CODEX_BRIDGE_MODELS_URL: 'https://refresh.test/empty/models' })
  assert.equal(r.ok, false)
  assert.deepEqual(r.ids, [])
  assert.match(r.error, /0 usable models/)
})

test('settings.normalize：未知键丢弃、枚举非法归零、字符串 trim', () => {
  const out = provider.settings.normalize({ binPath: ' C:/codex.exe ', defaultModel: ' m ', sandboxMode: 'bogus', approvalPolicy: 'never', evil: 'x' })
  assert.deepEqual(out, { binPath: 'C:/codex.exe', defaultModel: 'm', sandboxMode: '', approvalPolicy: 'never' })
  assert.deepEqual(provider.settings.normalize(null), { binPath: '', defaultModel: '', sandboxMode: '', approvalPolicy: '' })
})

test('settings.meta：无 CODEX_HOME/端点时 defaultModel 候选项为空（说明由 §3.2 的 note 负责）', () => {
  const m = provider.settings.meta({})
  const keys = m.fields.map((f) => f.key)
  assert.deepEqual(keys, ['binPath', 'defaultModel', 'sandboxMode', 'approvalPolicy'])
  const model = m.fields.find((f) => f.key === 'defaultModel')
  assert.equal(model.type, 'select')
  assert.deepEqual(model.options, [])
  // 空下拉的原因写在 note 里，而不是靠自动探测去"猜"。
  assert.match(model.note, /拉取可用模型/)
})

test('settings.diagnose：一行文本带 bin/model/endpoint/sandbox/approval', () => {
  const d = provider.settings.diagnose({}, {})
  assert.equal(typeof d, 'string')
  assert.ok(d.indexOf('\n') < 0, 'single line')
  assert.match(d, /bin=/)
  assert.match(d, /sandbox=/)
  assert.match(d, /approval=/)
})

// ── 工具面与模型清单（无宿主配置时的失败语义）────────────────────────────────
test('三个工具 schema 都是 object 且必填 prompt（status 除外）', () => {
  for (const k of ['run', 'continue']) {
    const t = provider.tools[k]
    assert.equal(t.inputSchema.type, 'object')
    assert.deepEqual(t.inputSchema.required, ['prompt'])
    assert.ok(t.description.length > 40)
  }
  assert.equal(provider.tools.status.inputSchema.type, 'object')
})

test('extraTools：有 spawn 能力才注册 codex_models；裸 env 形态省略', () => {
  const bare = defineProvider({ env: {} })
  assert.deepEqual(bare.extraTools, [])
  const withChild = defineProvider({ env: {}, nodeChild: { spawn() {} } })
  assert.equal(withChild.extraTools.length, 1)
  assert.equal(withChild.extraTools[0].name, 'codex_models')
  assert.equal(typeof withChild.extraTools[0].logic, 'function')
  assert.equal(typeof withChild.extraTools[0].render, 'function')
})

test('listModels：没有 base_url 时必须 ok:false + 可操作错误（绝不空数组冒充清单）', async () => {
  const p = defineProvider({ env: {}, nodeChild: { spawn() {} } })
  const res = await p.listModels({ source: 'live' })
  assert.equal(res.ok, false)
  assert.deepEqual(res.models, [])
  assert.match(res.error, /base_url/)
  assert.match(res.error, /source="catalog"/)
})

test('listModels：未知 source 明确报错', async () => {
  const p = defineProvider({ env: {}, nodeChild: { spawn() {} } })
  const res = await p.listModels({ source: 'server' })
  assert.equal(res.ok, false)
  assert.match(res.error, /unknown source/)
})

// ── attach / engine 装配 ────────────────────────────────────────────────────
test('attach：装配 runner+engine，并把 getSettings 的偏好读进 buildArgv', () => {
  const p = defineProvider({ env: {} })
  const published = []
  const runner = p.attach({
    ctx: null, subprocess: null, publish: (s) => published.push(s),
    getSettings: () => ({ defaultModel: 'from-host', sandboxMode: 'read-only' })
  })
  assert.equal(typeof runner.coreExecute, 'function')
  assert.equal(typeof p.engine.statusSnapshot, 'function')
  const b = p.buildArgv(['codex'], { prompt: 'x' }, {})
  assert.equal(b.argv[b.argv.indexOf('-m') + 1], 'from-host')
  assert.equal(b.argv[b.argv.indexOf('-s') + 1], 'read-only')
})
