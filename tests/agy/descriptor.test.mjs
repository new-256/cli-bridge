// tests/agy/descriptor.test.mjs — providers/agy.mjs 描述符契约与移植语义。
import test from 'node:test'
import assert from 'node:assert/strict'

import defineProvider from '../../providers/agy.mjs'

const provider = defineProvider({ env: {} })

test('契约 ★ 字段齐备（PROVIDER-CONTRACT.md §1）', () => {
  assert.equal(provider.id, 'agy')
  assert.equal(provider.label, 'AGY')
  assert.equal(provider.presetId, 'cordis-agy')
  assert.equal(provider.defaultBackend, null)
  assert.equal(provider.defaultMode, 'auto')
  assert.equal(provider.exeName, 'agy')
  assert.deepEqual(provider.binEnvVars, ['AGY_BIN', 'AGY_CLI'])
  assert.equal(provider.unavailableStatus, 'AGY_UNAVAILABLE')
  for (const f of ['backends', 'normalizeBackend', 'resolveBackend', 'buildArgv', 'parseJson', 'buildResult', 'runToolLogic', 'continueToolLogic', 'statusToolLogic', 'attach']) {
    assert.equal(typeof provider[f], 'function', f + ' must be a function')
  }
  assert.equal(provider.tools.run.name, 'agy_run')
  assert.equal(provider.tools.continue.name, 'agy_continue')
  assert.equal(provider.tools.status.name, 'agy_status')
})

test('单后端归一：任何取值都是 null（agy 无多后端）', () => {
  assert.equal(provider.backends(), null)
  for (const v of ['agy', 'antigravity', 'AGY', 'codebuddy', '', null, undefined]) {
    assert.equal(provider.normalizeBackend(v), null, 'normalizeBackend(' + String(v) + ')')
  }
  assert.equal(provider.resolveBackend({}, {}, null), null)
})

test('settings 分区为空实现（契约 §3：agy 无字段）', () => {
  assert.deepEqual(provider.settings.keys, [])
  assert.deepEqual(provider.settings.defaults(), {})
  assert.deepEqual(provider.settings.normalize({ any: 1 }, {}), {})
  assert.deepEqual(provider.settings.meta({}), { fields: [] })
  assert.equal(provider.settings.diagnose({}, {}), '')
})

// ── buildArgv（旧 preset verbatim）────────────────────────────────────────────
test('buildArgv 基础旗标：stream-json + 免提示 + 默认 timeout/mode', () => {
  const b = provider.buildArgv('agy', { prompt: 'do it' }, { planActive: false })
  assert.deepEqual(b.argv.slice(0, 6), ['agy', '-p', 'do it', '--output-format', 'stream-json', '--dangerously-skip-permissions'])
  assert.ok(b.argv.includes('--print-timeout') && b.argv.includes('600s'))
  assert.equal(b.argv[b.argv.indexOf('--mode') + 1], 'accept-edits')
  assert.equal(b.timeoutSec, 600)
  assert.equal(b.mode, 'accept-edits')
})

test('buildArgv 数组前缀（AGY_BIN 为 .mjs 时 [nodeExe, bin]）保留两项', () => {
  const b = provider.buildArgv(['node', 'fake-agy.mjs'], { prompt: 'x' }, {})
  assert.deepEqual(b.argv.slice(0, 2), ['node', 'fake-agy.mjs'])
  assert.equal(b.argv[2], '-p')
})

test('buildArgv auto 模式跟随 DSH plan 态', () => {
  assert.equal(provider.buildArgv('agy', { prompt: 'x' }, { planActive: true }).mode, 'plan')
  assert.equal(provider.buildArgv('agy', { prompt: 'x' }, { planActive: false }).mode, 'accept-edits')
  const b = provider.buildArgv('agy', { prompt: 'x' }, { planActive: true })
  assert.equal(b.argv[b.argv.indexOf('--mode') + 1], 'plan')
})

test('buildArgv 显式 mode 覆盖 plan 推断；非法 mode 不发 --mode（旧语义）', () => {
  assert.equal(provider.buildArgv('agy', { prompt: 'x', mode: 'plan' }, { planActive: true }).mode, 'plan')
  assert.equal(provider.buildArgv('agy', { prompt: 'x', mode: 'accept-edits' }, { planActive: true }).mode, 'accept-edits')
  const b = provider.buildArgv('agy', { prompt: 'x', mode: 'bogus' }, {})
  assert.equal(b.mode, 'bogus')
  assert.ok(!b.argv.includes('--mode'), 'unknown mode must not emit --mode')
})

test('buildArgv timeoutSec 夹取（10..3600，默认 600）与 --print-timeout 同步', () => {
  const cases = [[undefined, 600], [5, 10], [99999, 3600], ['42.7', 42], ['abc', 600], [0, 10]]
  for (const [input, want] of cases) {
    const b = provider.buildArgv('agy', { prompt: 'x', timeoutSec: input }, {})
    assert.equal(b.timeoutSec, want, 'timeoutSec ' + String(input))
    assert.equal(b.argv[b.argv.indexOf('--print-timeout') + 1], want + 's')
  }
})

test('buildArgv model/effort/addDirs（假值跳过）', () => {
  const b = provider.buildArgv('agy', { prompt: 'x', model: 'gemini-3-pro', effort: 'high', addDirs: ['a', '', null, 'b'] }, {})
  assert.equal(b.argv[b.argv.indexOf('--model') + 1], 'gemini-3-pro')
  assert.equal(b.argv[b.argv.indexOf('--effort') + 1], 'high')
  const dirs = []
  for (let i = 0; i < b.argv.length; i++) if (b.argv[i] === '--add-dir') dirs.push(b.argv[i + 1])
  assert.deepEqual(dirs, ['a', 'b'])
  const b2 = provider.buildArgv('agy', { prompt: 'x', addDirs: 'not-an-array' }, {})
  assert.ok(!b2.argv.includes('--add-dir'))
})

test('buildArgv 会话续接：--conversation 与 --continue 互斥（旧优先级）', () => {
  const withId = provider.buildArgv('agy', { prompt: 'x', conversationId: 'conv-9', continueLatest: true }, {})
  assert.ok(withId.argv.includes('--conversation') && withId.argv.includes('conv-9'))
  assert.ok(!withId.argv.includes('--continue'), 'conversationId wins over continueLatest')
  const latest = provider.buildArgv('agy', { prompt: 'x', continueLatest: true }, {})
  assert.ok(latest.argv.includes('--continue') && !latest.argv.includes('--conversation'))
})

// ── parseJson（旧 parseAgyJson verbatim）──────────────────────────────────────
test('parseJson 取末尾 result 事件，容忍前面杂日志与半行', () => {
  const stdout = [
    'some banner text',
    '{"event":"step_update","step_update":{"step_type":"tool"}}',
    '{"event":"result","result":{"status":"SUCCESS","response":"ok","conversation_id":"c1"}}',
    '{"event":"resu' // 半行（截断）必须被忽略
  ].join('\n')
  const parsed = provider.parseJson(stdout)
  assert.equal(parsed.status, 'SUCCESS')
  assert.equal(parsed.response, 'ok')
  assert.equal(parsed.conversation_id, 'c1')
})

test('parseJson 兼容裸 {status,response} 行与整串 JSON', () => {
  assert.equal(provider.parseJson('{"status":"SUCCESS","response":"x"}').response, 'x')
  assert.equal(provider.parseJson(JSON.stringify({ status: 'SUCCESS', response: 'y' })).response, 'y')
  assert.equal(provider.parseJson(''), null)
  assert.equal(provider.parseJson('totally not json'), null)
})

// ── buildResult ──────────────────────────────────────────────────────────────
test('buildResult：SUCCESS + sessionId/conversationId 双写同值（契约统一 + 旧字段兼容）', () => {
  const parsed = provider.parseJson('{"event":"result","result":{"status":"SUCCESS","response":"done","conversation_id":"conv-1","duration_seconds":3,"num_turns":2,"usage":{"total_tokens":42}}}')
  const res = provider.buildResult(parsed, { exitCode: 0 }, 'accept-edits', '', '', null)
  assert.equal(res.ok, true)
  assert.equal(res.status, 'SUCCESS')
  assert.equal(res.conversationId, 'conv-1')
  assert.equal(res.sessionId, 'conv-1')
  assert.equal(res.durationSeconds, 3)
  assert.equal(res.numTurns, 2)
  assert.equal(res.totalTokens, 42)
  assert.equal(res.exitCode, 0)
  assert.equal(res.mode, 'accept-edits')
})

test('buildResult：exit!=0 → ok=false；无 conversation_id → 两字段皆 null', () => {
  const res = provider.buildResult({ status: 'ERROR', response: 'boom' }, { exitCode: 1 }, 'plan', '', '', 'x')
  assert.equal(res.ok, false)
  assert.equal(res.status, 'ERROR')
  assert.equal(res.conversationId, null)
  assert.equal(res.sessionId, null)
})

test('buildResult：status 缺失按 exitCode 推 UNKNOWN/ERROR（旧语义）', () => {
  assert.equal(provider.buildResult({ response: 'r' }, { exitCode: 0 }, 'plan', '', '', null).status, 'UNKNOWN')
  assert.equal(provider.buildResult({ response: 'r' }, { exitCode: 2 }, 'plan', '', '', null).status, 'ERROR')
})

test('buildResult：result.error 并入 stderr（旧 v1.5.8 修复，供 isLimited 归类）', () => {
  const res = provider.buildResult({ status: 'ERROR', response: '', error: 'timeout waiting for response' }, { exitCode: 0 }, 'plan', 'real stderr', '', null)
  assert.ok(res.stderr.includes('real stderr'))
  assert.ok(res.stderr.includes('timeout waiting for response'))
})

test('buildResult：parsed=null → PARSE_ERROR + rawStdout 尾部', () => {
  const res = provider.buildResult(null, { exitCode: 0 }, 'plan', '', 'garbage out', null)
  assert.equal(res.status, 'PARSE_ERROR')
  assert.equal(res.ok, false)
  assert.equal(res.rawStdout, 'garbage out')
})

// ── foldStreamEvent（旧 foldStepUpdate verbatim）──────────────────────────────
function mkProject() {
  return { cwd: 'C:/w', name: 'w', provider: 'agy', state: 'running', running: 1, lastStatus: null, lastAt: 0, lastSessionId: null, lastBackend: null, lastOk: false, lastFailed: false, fallbackActive: false, current: null, trail: [], runs: 0, totalTokens: 0, updatedAt: 0 }
}
const summarize = (params) => {
  if (!params || typeof params !== 'object') return undefined
  const out = {}
  for (const k of Object.keys(params)) {
    let v = params[k]
    if (typeof v === 'string' && v.length > 120) v = v.slice(0, 120) + '…'
    out[k] = v
  }
  return out
}

test('foldStreamEvent 只处理 step_update，其余事件忽略', () => {
  const p = mkProject()
  const before = p.updatedAt
  provider.foldStreamEvent({ event: 'result', result: {} }, p, summarize, 120, 12)
  assert.equal(p.updatedAt, before)
  assert.equal(p.trail.length, 0)
})

test('foldStreamEvent tool ACTIVE → current + trail；DONE 同 step → 清 current', () => {
  const p = mkProject()
  provider.foldStreamEvent({ event: 'step_update', step_update: { step_type: 'tool', step_index: 0, state: 'ACTIVE', tool_name: 'read', tool_info: { name: 'read', parameters: { file_path: 'a.txt' } } } }, p, summarize, 120, 12)
  assert.equal(p.current.tool, 'read')
  assert.deepEqual(p.current.args, { file_path: 'a.txt' })
  assert.equal(p.trail.length, 1)
  provider.foldStreamEvent({ event: 'step_update', step_update: { step_type: 'tool', step_index: 0, state: 'DONE', tool_name: 'read' } }, p, summarize, 120, 12)
  assert.equal(p.current, null)
  assert.equal(p.trail.length, 2)
})

test('foldStreamEvent 其他 step 的 DONE 不误清 current', () => {
  const p = mkProject()
  provider.foldStreamEvent({ event: 'step_update', step_update: { step_type: 'tool', step_index: 3, state: 'ACTIVE', tool_name: 'write' } }, p, summarize, 120, 12)
  provider.foldStreamEvent({ event: 'step_update', step_update: { step_type: 'tool', step_index: 1, state: 'DONE', tool_name: 'read' } }, p, summarize, 120, 12)
  assert.equal(p.current && p.current.tool, 'write')
})

test('foldStreamEvent agent_response ACTIVE → 截断 text_delta 作为 current', () => {
  const p = mkProject()
  const long = 'x'.repeat(200)
  provider.foldStreamEvent({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: 5, state: 'ACTIVE', text_delta: long } }, p, summarize, 120, 12)
  assert.equal(p.current.tool, 'agent_response')
  assert.equal(p.current.args.text_delta.length, 120)
})

test('foldStreamEvent trail 超过上限丢最旧（旧 MAX_TRAIL 环形语义）', () => {
  const p = mkProject()
  for (let i = 0; i < 15; i++) {
    provider.foldStreamEvent({ event: 'step_update', step_update: { step_type: 'tool', step_index: i, state: 'DONE', tool_name: 't' + i } }, p, summarize, 120, 12)
  }
  assert.equal(p.trail.length, 12)
  assert.equal(p.trail[0].tool, 't3')
})

// ── isTransientCliError / failureHint ────────────────────────────────────────
test('isTransientCliError：仅非限流的 ERROR_DURING_EXECUTION 为真', () => {
  assert.equal(provider.isTransientCliError(null), false)
  assert.equal(provider.isTransientCliError({ ok: true, status: 'SUCCESS' }), false)
  assert.equal(provider.isTransientCliError({ ok: false, status: 'ERROR_DURING_EXECUTION', stderr: 'tool crashed internally' }), true)
  // 限流/网络类不是瞬态（交给 isLimited 弹窗路径），且 AGY_UNAVAILABLE 含 'unavailable'
  assert.equal(provider.isTransientCliError({ ok: false, status: 'ERROR_DURING_EXECUTION', stderr: 'rate limit exceeded' }), false)
  assert.equal(provider.isTransientCliError({ ok: false, status: 'AGY_UNAVAILABLE' }), false)
  assert.equal(provider.isTransientCliError({ ok: false, status: 'PARSE_ERROR' }), false)
})

test('failureHint：四类指引 + 成功/未知为空', () => {
  assert.equal(provider.failureHint({ ok: true }), '')
  assert.match(provider.failureHint({ ok: false, status: 'QUOTA_BLOCKED' }), /不要再调 agy/)
  assert.match(provider.failureHint({ ok: false, status: 'AGY_UNAVAILABLE' }), /AGY_BIN/)
  assert.match(provider.failureHint({ ok: false, status: 'ERROR', stderr: '401 authentication failed: invalid_grant' }), /agy login/)
  assert.match(provider.failureHint({ ok: false, status: 'ERROR', stderr: 'quota exhausted for this project' }), /agy_quota/)
  assert.equal(provider.failureHint({ ok: false, status: 'PARSE_ERROR', stderr: 'output truncated' }), '')
})

test('isSuccessStatus 仅 SUCCESS（无 mimo 式 ACCEPTED）', () => {
  assert.equal(provider.isSuccessStatus('SUCCESS'), true)
  assert.equal(provider.isSuccessStatus('ACCEPTED'), false)
  assert.equal(provider.isSuccessStatus(null), false)
})

// ── extraTools 注册条件（Lead 定案 4）────────────────────────────────────────
test('extraTools：有 spawn 能力才有 agy_quota；dynamic 沙箱形态省略', () => {
  assert.equal(provider.extraTools.length, 0, '无 process/nodeChild → 无 quota 工具')
  const withProcess = defineProvider({ env: {}, process })
  assert.equal(withProcess.extraTools.length, 1)
  assert.equal(withProcess.extraTools[0].name, 'agy_quota')
  assert.equal(withProcess.extraTools[0].inputSchema.type, 'object')
  const withNodeChild = defineProvider({ env: {}, nodeChild: { spawn: () => { throw new Error('no') } } })
  assert.equal(withNodeChild.extraTools.length, 1)
})

test('工具 schema verbatim 红线：required 与关键枚举不漂移', () => {
  assert.deepEqual(provider.tools.run.inputSchema.required, ['prompt'])
  assert.deepEqual(provider.tools.run.inputSchema.properties.mode.enum, ['auto', 'plan', 'accept-edits'])
  assert.deepEqual(provider.tools.run.inputSchema.properties.effort.enum, ['low', 'medium', 'high'])
  assert.equal(provider.tools.run.inputSchema.properties.background.type, 'boolean')
  assert.deepEqual(provider.tools.continue.inputSchema.properties.latest.type, 'boolean')
  assert.deepEqual(provider.tools.status.inputSchema.properties.cwd.type, 'string')
  assert.deepEqual(Object.keys(provider.tools.status.inputSchema.properties), ['cwd'])
  // 旧 agy 工具面独有的 addDirs / timeoutSec 语义保持
  assert.equal(provider.tools.run.inputSchema.properties.addDirs.type, 'array')
  assert.match(provider.tools.run.inputSchema.properties.timeoutSec.description, /10-3600/)
})

// ── 额度门禁降级路径（Lead 定案 4：定位不到脚本/无 spawn 能力 = 静默跳过）───────
test('quotaGate5h：无脚本定位或无 spawn 能力 → null（放行，宽容降级）', async () => {
  const noSpawn = defineProvider({ env: {} })
  assert.equal(await noSpawn.quotaGate5h({ prompt: 'x' }, undefined), null)
  const hasPathNoSpawn = defineProvider({ env: { CLI_BRIDGE_AGY_QUOTA: 'C:/somewhere/agy-quota.mjs' } })
  assert.equal(await hasPathNoSpawn.quotaGate5h({ prompt: 'x' }, undefined), null, 'path but no nodeChild/subprocess')
})

test('quotaGate5h：脚本失败/无 JSON → null（预检失败不阻塞调用）', async () => {
  const p = defineProvider({
    env: { CLI_BRIDGE_AGY_QUOTA: 'C:/fake/agy-quota.mjs' },
    nodeChild: { spawn: () => { throw new Error('spawn boom') } }
  })
  assert.equal(await p.quotaGate5h({ prompt: 'x' }, undefined), null)
})

test('execQuotaScript：脚本缺失时报错对象而非抛出（旧 ok:false 语义）', async () => {
  const p = defineProvider({ env: {} })
  const res = await p.execQuotaScript()
  assert.equal(res.ok, false)
  assert.match(res.error, /quota script not found/)
})

// ── buildArgv 旗标矩阵（多点补充：组合全旗标一次成型）─────────────────────────
test('buildArgv 全旗标组合：顺序稳定、addDirs 逐项、续接互斥一次覆盖', () => {
  const b = provider.buildArgv(['agy'], {
    prompt: 'p', mode: 'plan', model: 'gemini-3-pro', effort: 'low',
    addDirs: ['d1', 'd2'], conversationId: 'c7', timeoutSec: 90
  }, { planActive: true })
  const argv = b.argv
  assert.equal(argv[0], 'agy')
  assert.deepEqual(argv.slice(1, 6), ['-p', 'p', '--output-format', 'stream-json', '--dangerously-skip-permissions'])
  assert.equal(argv[argv.indexOf('--print-timeout') + 1], '90s')
  assert.ok(argv.indexOf('--mode') < argv.indexOf('--model'), 'mode precedes model (旧顺序)')
  const dirIdx = argv.reduce((acc, v, i) => (v === '--add-dir' ? acc.concat(i) : acc), [])
  assert.equal(dirIdx.length, 2)
  assert.deepEqual(dirIdx.map((i) => argv[i + 1]), ['d1', 'd2'])
  assert.ok(argv.includes('--conversation') && !argv.includes('--continue'))
  assert.equal(b.mode, 'plan')
})
