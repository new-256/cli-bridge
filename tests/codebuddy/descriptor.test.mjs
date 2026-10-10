// tests/codebuddy/descriptor.test.mjs — providers/codebuddy.mjs 描述符契约与移植语义。
// 全部 fs 触点走运行时 mkdtemp（不引用旧包 fixtures/auth|credentials —— gate 9）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import defineProvider from '../../providers/codebuddy.mjs'
import { summarizeArgs, MAX_ARG_LEN, MAX_TRAIL } from '../../core/bridge-kit.mjs'
import { freshTmp } from './helpers/env.mjs'

// 造一个受控 env 的 provider（deps 注入面，测试与真机登录态解耦）。
function mk(extraEnv = {}, extraFs = {}) {
  return defineProvider(Object.assign({ env: extraEnv }, extraFs))
}

test('契约 ★ 字段齐备（PROVIDER-CONTRACT.md §1）', () => {
  const p = mk()
  assert.equal(p.id, 'codebuddy')
  assert.equal(p.label, 'CB')
  assert.equal(p.presetId, 'codebuddy-first')
  assert.equal(p.defaultBackend, 'codebuddy')
  assert.equal(p.defaultMode, 'auto')
  assert.equal(p.exeName, 'codebuddy')
  assert.deepEqual(p.binEnvVars, ['CODEBUDDY_BIN', 'CODEBUDDY_EN_BIN', 'WORKBUDDY_BIN'])
  assert.equal(p.unavailableStatus, 'CODEBUDDY_UNAVAILABLE')
  assert.equal(p.mcp.version, '0.2.2')
  assert.deepEqual(p.extraTools, [])
  for (const f of ['backends', 'normalizeBackend', 'resolveBackend', 'buildArgv', 'parseJson', 'buildResult', 'foldStreamEvent', 'isLimited', 'isTransientCliError', 'failureHint', 'preflight', 'runToolLogic', 'continueToolLogic', 'statusToolLogic', 'attach', 'hostOptions']) {
    assert.equal(typeof p[f], 'function', f + ' must be a function')
  }
  assert.equal(p.tools.run.name, 'codebuddy_run')
  assert.equal(p.tools.continue.name, 'codebuddy_continue')
  assert.equal(p.tools.status.name, 'codebuddy_status')
  for (const k of ['run', 'continue', 'status']) {
    assert.equal(p.tools[k].inputSchema.type, 'object')
    assert.ok(p.tools[k].description.length > 40, k + ' description present')
  }
  assert.deepEqual(p.settings.keys, ['preferredBackend', 'defaultModel', 'codebuddyEnToken', 'endpointOverride'])
  assert.deepEqual(p.settings.secretKeys, ['codebuddyEnToken'])
})

// ── backend 别名归一表（旧 core v1.3.3 verbatim，测试钉住）────────────────────
test('backends() 与 normalizeBackend 全枚举', () => {
  const p = mk()
  assert.deepEqual(p.backends(), ['codebuddy', 'codebuddy-intl', 'codebuddy-en', 'workbuddy'])
  assert.equal(p.normalizeBackend('workbuddy-en'), 'codebuddy-en')
  assert.equal(p.normalizeBackend('workbuddy-ai'), 'codebuddy-en')
  assert.equal(p.normalizeBackend('codebuddy-ioa'), 'codebuddy-intl')
  assert.equal(p.normalizeBackend('codebuddy-international'), 'codebuddy-intl')
  assert.equal(p.normalizeBackend('codebuddy-oversea'), 'codebuddy-intl')
  assert.equal(p.normalizeBackend(' CODEBUDDY-INTL '), 'codebuddy-intl')
  assert.equal(p.normalizeBackend('workbuddy'), 'workbuddy')
  // 非后端名原样透传（旧语义：normalizeBackend 不吞未知值）
  assert.equal(p.normalizeBackend('bogus'), 'bogus')
  assert.equal(p.normalizeBackend(''), '')
  assert.equal(p.normalizeBackend(null), null)
  assert.equal(p.normalizeBackend(undefined), undefined)
})

test('resolveBackend：arg > 会话归属 > 偏好 > 默认（旧优先级 verbatim）', () => {
  const p = mk()
  assert.equal(p.resolveBackend({ backend: 'workbuddy-ai' }, { backend: 'codebuddy' }, 'workbuddy'), 'codebuddy-en')
  assert.equal(p.resolveBackend({}, { backend: 'codebuddy-ioa' }, 'workbuddy'), 'codebuddy-intl')
  assert.equal(p.resolveBackend({}, null, 'workbuddy'), 'workbuddy')
  assert.equal(p.resolveBackend({}, null, 'bogus'), 'codebuddy')
  assert.equal(p.resolveBackend({}, null, null), 'codebuddy')
  assert.equal(p.resolveBackend({ backend: 'bogus' }, null, 'workbuddy'), 'workbuddy')
})

// ── buildArgv 矩阵（旧 core L1402-1420 verbatim）──────────────────────────────
test('buildArgv 默认面：-p + stream-json + bypassPermissions，mode/timeout 默认', () => {
  const b = mk().buildArgv(['node', 'cb.mjs'], { prompt: 'do it' }, {})
  assert.deepEqual(b.argv.slice(0, 6), ['node', 'cb.mjs', '-p', 'do it', '--output-format', 'stream-json'])
  assert.ok(b.argv.join(' ').includes('--permission-mode bypassPermissions'))
  assert.equal(b.argv.includes('--allowedTools'), false)
  assert.equal(b.mode, 'bypassPermissions')
  assert.equal(b.timeoutSec, 300)
})

test('buildArgv plan：--permission-mode plan + --allowedTools Bash（DSH plan 态）', () => {
  const b = mk().buildArgv(['cb'], { prompt: 'x' }, { planActive: true })
  assert.ok(b.argv.includes('--permission-mode') && b.argv[b.argv.indexOf('--permission-mode') + 1] === 'plan')
  assert.ok(b.argv.includes('--allowedTools') && b.argv[b.argv.indexOf('--allowedTools') + 1] === 'Bash')
  assert.equal(b.mode, 'plan')
})

test('buildArgv 显式 mode：accept-edits 映射 bypassPermissions；plan 优先于 DSH 态', () => {
  const p = mk()
  assert.equal(p.buildArgv(['cb'], { prompt: 'x', mode: 'accept-edits' }, {}).mode, 'bypassPermissions')
  const planB = p.buildArgv(['cb'], { prompt: 'x', mode: 'plan' }, { planActive: false })
  assert.equal(planB.mode, 'plan')
})

test('buildArgv 旗标组合：model 优先级 / effort / max-turns clamp / add-dir 多个 / resume 与 continue', () => {
  const p = mk()
  const b = p.buildArgv(['cb'], {
    prompt: 'p', model: 'glm-5.3', effort: 'xhigh', maxTurns: 9999,
    addDirs: ['D:\\a', '', 'D:\\b'], sessionId: 'sess-9', timeoutSec: 120
  }, { defaultModel: 'hy3' })
  assert.equal(b.argv[b.argv.indexOf('--model') + 1], 'glm-5.3', '显式 model 压过 defaultModel')
  assert.equal(b.argv[b.argv.indexOf('--effort') + 1], 'xhigh')
  assert.equal(b.argv[b.argv.indexOf('--max-turns') + 1], '500', 'clamp 上界')
  const dirs = []
  b.argv.forEach((a, i) => { if (a === '--add-dir') dirs.push(b.argv[i + 1]) })
  assert.deepEqual(dirs, ['D:\\a', 'D:\\b'], '空串跳过')
  assert.ok(b.argv.includes('--resume') && b.argv[b.argv.indexOf('--resume') + 1] === 'sess-9')
  assert.equal(b.argv.includes('--continue'), false, 'sessionId 优先于 continueLatest')
  assert.equal(b.timeoutSec, 120)
  const b2 = p.buildArgv(['cb'], { prompt: 'p', continueLatest: true }, { defaultModel: 'hy3' })
  assert.equal(b2.argv[b2.argv.indexOf('--model') + 1], 'hy3', '无显式 model 时注入 defaultModel')
  assert.ok(b2.argv.includes('--continue'))
})

test('buildArgv clamp 边界：maxTurns 0→1，timeoutSec 5→10 / 99999→3600', () => {
  const p = mk()
  assert.equal(p.buildArgv(['cb'], { prompt: 'x', maxTurns: 0 }, {}).argv.slice(-2).join(' ').includes('--max-turns 1'), true)
  assert.equal(p.buildArgv(['cb'], { prompt: 'x', timeoutSec: 5 }, {}).timeoutSec, 10)
  assert.equal(p.buildArgv(['cb'], { prompt: 'x', timeoutSec: 99999 }, {}).timeoutSec, 3600)
})

test('buildArgv 端点/凭据注入（auth 域 www.codebuddy.cn ≠ product 域 → CODEBUDDY_BASE_URL）', () => {
  const dir = freshTmp('cbtest-auth-')
  writeFileSync(join(dir, 'Tencent-Cloud.coding-copilot.info'), JSON.stringify({ auth: { domain: 'www.codebuddy.cn' } }), 'utf8')
  const p = mk({ CODEBUDDY_AUTH_DIR: dir })
  const b = p.buildArgv(['cb'], { prompt: 'x' }, { backend: 'codebuddy' })
  assert.ok(b.env && b.env.CODEBUDDY_BASE_URL === 'https://www.codebuddy.cn/v2', JSON.stringify(b.env))
  const same = p.buildArgv(['cb'], { prompt: 'x' }, { backend: 'codebuddy', settings: { endpointOverride: 'https://www.codebuddy.ai/v2' } })
  assert.equal(same.env, null, 'override 指回 product 域 → 不注入')
})

// ── parseJson / buildResult（旧 verbatim）─────────────────────────────────────
const RESULT_OK = '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s-1","duration_ms":1500,"num_turns":3,"modelUsage":{"hy3":{"a":1}},"usage":{"input_tokens":10,"output_tokens":5}}'

test('parseJson 反向扫 result + 整段 JSON 回退 + 非 JSON null', () => {
  const p = mk()
  assert.equal(p.parseJson('noise\n' + RESULT_OK + '\ntrailing').session_id, 's-1')
  assert.equal(p.parseJson(RESULT_OK).subtype, 'success')
  assert.equal(p.parseJson('not json at all'), null)
  assert.equal(p.parseJson(''), null)
})

test('buildResult SUCCESS 全字段（tokens=in+out，modelUsage 键 join，duration ms→s）', () => {
  const r = mk().buildResult(JSON.parse(RESULT_OK), { exitCode: 0 }, 'bypassPermissions', '', '', 'codebuddy')
  assert.equal(r.ok, true)
  assert.equal(r.status, 'SUCCESS')
  assert.equal(r.response, 'done')
  assert.equal(r.sessionId, 's-1')
  assert.equal(r.durationSeconds, 1.5)
  assert.equal(r.numTurns, 3)
  assert.equal(r.totalTokens, 15)
  assert.equal(r.modelUsed, 'hy3')
  assert.equal(r.mode, 'bypassPermissions')
  assert.equal(r.stderr, '')
})

test('buildResult 非零退出/失败 subtype/error 字段并入 stderr', () => {
  const parsed = JSON.parse(RESULT_OK.replace('"subtype":"success","is_error":false', '"subtype":"error_during_execution","is_error":true').replace(',"result":"done"', ',"result":"","error":"boom"'))
  const r = mk().buildResult(parsed, { exitCode: 1 }, 'plan', 'tail', '', 'workbuddy')
  assert.equal(r.ok, false)
  assert.equal(r.status, 'ERROR_DURING_EXECUTION')
  assert.match(r.stderr, /boom/)
  assert.match(r.stderr, /tail/)
  assert.equal(r.backend, 'workbuddy')
})

test('buildResult PARSE_ERROR：null parsed + rawStdout 尾部', () => {
  const r = mk().buildResult(null, { exitCode: 2 }, 'plan', '', 'x'.repeat(3000) + 'TAIL', 'codebuddy')
  assert.equal(r.status, 'PARSE_ERROR')
  assert.equal(r.ok, false)
  assert.ok(r.rawStdout.endsWith('TAIL') && r.rawStdout.length === 2000)
})

test('buildResult 顺手收割账号清单（parseAccountModels 锚点，旧 verbatim）', () => {
  const p = mk()
  const stderrText = 'Error: 400 model [claude-opus-5] service info not found\nCurrently supported models for your account:\n  - hy3\n  - glm-5.3\n\n(trailing junk)'
  const r = p.buildResult({ type: 'other' }, { exitCode: 1 }, 'plan', stderrText, '', 'codebuddy')
  assert.equal(r.status, 'PARSE_ERROR')
  assert.deepEqual(p.getAccountCatalog('codebuddy'), ['hy3', 'glm-5.3'])
  assert.deepEqual(p.parseAccountModels('no anchor here'), null)
})

// ── 失败判定链（旧 verbatim 中文限流表）───────────────────────────────────────
test('isLimited：中文码命中；AUTH_REQUIRED/401 放行；SPAWN 类受限', () => {
  const p = mk()
  assert.equal(p.isLimited({ ok: true }), false)
  assert.equal(p.isLimited({ ok: false, status: 'AUTH_REQUIRED', stderr: '没有可用凭据' }), false)
  assert.equal(p.isLimited({ ok: false, status: 'SPAWN_ERROR', stderr: '' }), true)
  assert.equal(p.isLimited({ ok: false, status: 'CODEBUDDY_UNAVAILABLE', stderr: '' }), true)
  assert.equal(p.isLimited({ ok: false, status: 'HUNG_TIMEOUT', stderr: '' }), true)
  assert.equal(p.isLimited({ ok: false, status: 'ERROR', stderr: '请求过于频繁，已触发流量限制' }), true)
  assert.equal(p.isLimited({ ok: false, status: 'ERROR', stderr: '账户余额不足' }), true)
  assert.equal(p.isLimited({ ok: false, status: 'ERROR', stderr: '401 authentication failed' }), false)
  assert.equal(p.isLimited({ ok: false, status: 'ERROR', stderr: 'token differs from the current product endpoint' }), false)
  assert.equal(p.isLimited({ ok: false, status: 'PARSE_ERROR', stderr: 'plain' }), false)
})

test('isTransientCliError：仅非限流的 ERROR_DURING_EXECUTION', () => {
  const p = mk()
  assert.equal(p.isTransientCliError({ ok: false, status: 'ERROR_DURING_EXECUTION', stderr: '' }), true)
  assert.equal(p.isTransientCliError({ ok: false, status: 'ERROR_DURING_EXECUTION', stderr: '429 too many requests' }), false)
  assert.equal(p.isTransientCliError({ ok: true, status: 'SUCCESS' }), false)
})

test('failureHint 四分支 verbatim（AUTH_REQUIRED/瞬时×2/PARSE_ERROR/401）', () => {
  const p = mk()
  assert.equal(p.failureHint({ ok: true }), '')
  assert.equal(p.failureHint({ ok: false, status: 'AUTH_REQUIRED', stderr: '指南' }), '[诊断] 指南')
  const t1 = p.failureHint({ ok: false, status: 'ERROR_DURING_EXECUTION', stderr: '' })
  assert.match(t1, /瞬时错误.*直接重试同一请求通常即可通过/)
  assert.equal(p.failureHint({ ok: false, status: 'ERROR_DURING_EXECUTION', stderr: '', retried: true }), '[诊断] codebuddy CLI 侧瞬时错误（error_during_execution，CLI 未给出原因），已自动重试 1 次仍失败。可换 model 再试一次；若仍失败请改用原生工具完成，或告知用户。')
  assert.match(p.failureHint({ ok: false, status: 'PARSE_ERROR', stderr: '' }), /未能从 codebuddy 输出解析出 result 事件/)
  assert.match(p.failureHint({ ok: false, status: 'X', stderr: '401 authentication failed' }), /认证失败（401）.*不是限流，重试与回退都无效/)
})

// ── EN 面 preflight（确定性早退，不白跑 spawn）───────────────────────────────
test('preflight：非 EN 放行；EN 无凭据 abort=AUTH_REQUIRED（含 protector key 指引）', () => {
  // 隔离：auth 目录指到不存在的路径，绝不读真机 %LOCALAPPDATA%（Lead 坑 1 同款纪律）。
  const p = mk({ LOCALAPPDATA: process.cwd() + '\\no-such-auth-' + process.pid })
  assert.equal(p.preflight({ args: {}, backend: 'codebuddy', o: {} }), null)
  const abort = p.preflight({ args: { mode: 'auto' }, backend: 'codebuddy-en', o: { getSettings: () => ({ codebuddyEnToken: '' }) } })
  assert.ok(abort && abort.abort)
  assert.equal(abort.abort.ok, false)
  assert.equal(abort.abort.status, 'AUTH_REQUIRED')
  assert.equal(abort.abort.backend, 'codebuddy-en')
  assert.match(abort.abort.stderr, /protector key/)
  assert.match(abort.abort.stderr, /也可直接用 backend="workbuddy"/)
})

test('resolveEnToken 三通道优先级：setting > CODEBUDDY_AUTH_TOKEN > DSH 凭据库', () => {
  const home = freshTmp('cbtest-store-')
  // 假 token 串（测试自造，非真实凭据 —— gate-9 卫生注记）；单类字符故意不过
  // 三分类判定，杜绝任何形态被误认成真凭据。
  writeFileSync(join(home, '.credentials.yaml'), 'WORKBUDDY_TOKEN: ' + 'a'.repeat(42) + '\nOTHER_KEY: short\n', 'utf8')
  const storeOnly = mk({ CODEBUDDY_CREDENTIALS_DIR: home })
  assert.deepEqual(storeOnly.resolveEnToken(''), { token: 'a'.repeat(42), source: 'dsh-store' })
  const withEnvTok = mk({ CODEBUDDY_CREDENTIALS_DIR: home, CODEBUDDY_AUTH_TOKEN: 'env-token-1' })
  assert.equal(withEnvTok.resolveEnToken('').source, 'env')
  assert.deepEqual(withEnvTok.resolveEnToken('  setting-tok  '), { token: 'setting-tok', source: 'setting' })
  // 占位/短值被拒（≥40 且非 $ 引用）
  const decoy = mk({ CODEBUDDY_CREDENTIALS_DIR: freshTmp('cbtest-empty-') })
  assert.equal(decoy.readDshWorkbuddyToken(), null)
})

// ── endpointEnv / mismatch（旧 verbatim 三规则/三分支）────────────────────────
test('endpointEnv：跨域注入 BASE_URL；EN 注入 AUTH_TOKEN；同域 null', () => {
  const p = mk()
  assert.deepEqual(p.endpointEnv('codebuddy', null, 'www.codebuddy.cn', null), { CODEBUDDY_BASE_URL: 'https://www.codebuddy.cn/v2' })
  assert.equal(p.endpointEnv('codebuddy', null, 'www.codebuddy.ai', null), null)
  // 'tok'/'ignored' 均为测试自造串，非真实凭据（gate-9 卫生注记，Lead 建议）。
  assert.deepEqual(p.endpointEnv('codebuddy-en', null, 'www.workbuddy.ai', 'tok'), { CODEBUDDY_AUTH_TOKEN: 'tok' })
  assert.deepEqual(p.endpointEnv('codebuddy-en', null, 'copilot.tencent.com', 'tok'), { CODEBUDDY_BASE_URL: 'https://copilot.tencent.com/v2', CODEBUDDY_AUTH_TOKEN: 'tok' })
  // workbuddy 面被非 copilot 登录域调用时同样注入对齐（与 EN 面同规则，token 仅 EN 注入）。
  assert.deepEqual(p.endpointEnv('workbuddy', null, 'www.codebuddy.ai', 'ignored'), { CODEBUDDY_BASE_URL: 'https://www.codebuddy.ai/v2' }, '非 EN 不注入 CODEBUDDY_AUTH_TOKEN')
  assert.equal(p.endpointEnv('workbuddy', null, 'copilot.tencent.com', 'ignored'), null)
})

test('endpointMismatchHint 三分支 verbatim', () => {
  const p = mk()
  const en = p.endpointMismatchHint('codebuddy-en', null, false)
  assert.match(en, /没有可用凭据.*protector key/s)
  assert.ok(en.endsWith('也可直接用 backend="workbuddy"（国内版桌面 CLI，免配置）。'))
  assert.equal(p.endpointMismatchHint('codebuddy-en', null, true), null)
  assert.match(p.endpointMismatchHint('codebuddy-intl', null, true), /only available for authorized users/)
  const mm = p.endpointMismatchHint('codebuddy', 'www.codebuddy.cn', false)
  assert.equal(mm, 'codebuddy 的登录域是 www.codebuddy.cn，与产品端点 https://www.codebuddy.ai/v2 不一致；桥接层已自动注入 CODEBUDDY_BASE_URL=https://www.codebuddy.cn/v2。若仍 401，请重新登录对应客户端。')
  assert.equal(p.endpointMismatchHint('codebuddy', 'www.codebuddy.ai', false), null)
})

// ── settings（清洗 + meta + diagnose）────────────────────────────────────────
test('settings.normalize：bogus→默认、别名清洗、trim、secret 保留、updatedAt 透传', () => {
  const p = mk()
  const d = p.settings.defaults()
  assert.deepEqual(d, { preferredBackend: 'codebuddy', defaultModel: '', codebuddyEnToken: '', endpointOverride: '' })
  const s = p.settings.normalize({ preferredBackend: 'codebuddy-ioa', defaultModel: ' hy3 ', codebuddyEnToken: '  tok  ', endpointOverride: '', bogus: 1, updatedAt: 123 })
  assert.equal(s.preferredBackend, 'codebuddy-intl')
  assert.equal(s.defaultModel, 'hy3')
  assert.equal(s.codebuddyEnToken, 'tok')
  assert.equal(s.endpointOverride, '')
  assert.equal(s.bogus, undefined)
  assert.equal(s.updatedAt, 123)
  assert.equal(p.settings.normalize({ preferredBackend: 'nope' }).preferredBackend, 'codebuddy')
})

test('settings.meta：4 字段形态 + defaultModel 选项来自目录（免费档在前）', () => {
  const p = mk()
  const m = p.settings.meta()
  assert.equal(m.titleSuffix, 'CodeBuddy')
  assert.deepEqual(m.fields.map((f) => f.key), ['preferredBackend', 'defaultModel', 'codebuddyEnToken', 'endpointOverride'])
  assert.equal(m.fields[1].type, 'select')
  assert.equal(m.fields[1].allowCustom, true)
  const values = m.fields[1].options.map((o) => o.value)
  assert.ok(values.includes('hy3') && values.includes('hy4-preview'))
})

test('settings.diagnose：默认后端 + EN 恒附一行；token 缺失指引进输出', () => {
  const p = mk({ LOCALAPPDATA: process.cwd() + '\\definitely-not-a-real-auth-dir-' + process.pid })
  const txt = p.settings.diagnose({ preferredBackend: 'workbuddy', codebuddyEnToken: '' })
  assert.match(txt, /^workbuddy: https:\/\/copilot\.tencent\.com\/v2/)
  assert.match(txt, /codebuddy-en:.*protector key|codebuddy-en.*缺失/s)
  const withTok = p.settings.diagnose({ preferredBackend: 'codebuddy', codebuddyEnToken: 'abc' })
  assert.match(withTok, /来自设置面板/)
})

// ── 模型目录（简化版：无促销角标，Lead 定案）─────────────────────────────────
test('目录纯函数：normalizeProductConfig/extractModelIds/credits 解析 verbatim', () => {
  const p = mk()
  assert.deepEqual(p.normalizeProductConfig({ data: { models: [1] } }), { models: [1] })
  assert.deepEqual(p.normalizeProductConfig([{ t: 1 }, { data: { models: [] } }]), { models: [] })
  assert.equal(p.normalizeProductConfig('junk'), null)
  const prod = JSON.stringify({
    models: [{ id: 'hy3', credits: 'x0.00' }, { id: 'hy4-preview', credits: '0.29x' }, { id: 'gpt-5.4', credits: 'x3.31' }],
    agents: [{ name: 'cli', models: ['hy3'] }]
  })
  assert.deepEqual(p.extractModelIds(prod), ['hy3', 'hy4-preview', 'gpt-5.4'], 'top(3) > cli(1) → 取更长')
  const cm = p.extractModelCredits(prod)
  assert.equal(p.parseCreditValue('x0.29'), 0.29)
  assert.equal(p.parseCreditValue('0.29×'), 0.29)
  assert.equal(p.parseCreditValue('n/a'), null)
  assert.equal(p.formatCreditLabel(0), '免费')
  assert.equal(p.formatCreditLabel(1.5), 'x1.50')
  assert.equal(p.lookupModelCredits(cm, 'hy3'), 0)
  assert.equal(p.lookupModelCredits(cm, 'hy4-preview'), 0.29)
  const alias = new Map([['kimi-k3', 0.27]])
  assert.equal(p.lookupModelCredits(alias, 'kimi-k3-1'), 0.27, 'CREDIT_ID_ALIASES 跨命名匹配')
})

test('backendModelCatalog：CODEBUDDY_MODELS_FILE 注入文件优先、损坏文件回静态表', () => {
  const dir = freshTmp('cbtest-models-')
  const good = join(dir, 'product.json')
  writeFileSync(good, JSON.stringify({ models: [{ id: 'zzz-1' }, { id: 'zzz-2' }] }), 'utf8')
  const p = mk({ CODEBUDDY_MODELS_FILE: good })
  assert.deepEqual(p.backendModelCatalog('codebuddy', {}), ['zzz-1', 'zzz-2'])
  const broken = mk({ CODEBUDDY_MODELS_FILE: join(dir, 'nope.json') })
  assert.equal(broken.backendModelCatalog('codebuddy', {}).slice(0, 3).join(','), 'hy4-preview,hy3,hy3-x', '静态表回退')
  const det = p.modelCatalogDetailed('codebuddy', { accountModels: ['zzz-2', 'nope-9'] })
  assert.equal(det[0].id, 'zzz-2', '已授权在前')
  assert.equal(det.find((x) => x.id === 'zzz-1').authorized, false)
  assert.equal(det.find((x) => x.id === 'zzz-1').label, 'zzz-1 · 未授权')
  assert.equal(det.find((x) => x.id === 'zzz-2').promotion, null, '促销角标 0.1.0 有意省略')
})

// ── foldStreamEvent（kit 传 helper，provider 不 import 执行细节）──────────────
test('foldStreamEvent：tool_use→ACTIVE+current，tool_result→DONE+清除，thinking/typing', () => {
  const p = mk()
  const pr = { trail: [], current: null, _stepCounter: 0 }
  p.foldStreamEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }] } }, pr, summarizeArgs, MAX_ARG_LEN, MAX_TRAIL)
  assert.equal(pr.trail.length, 1)
  assert.equal(pr.trail[0].state, 'ACTIVE')
  assert.equal(pr.current.tool, 'Read')
  assert.equal(pr.current.stepIndex, 1)
  p.foldStreamEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } }, pr, summarizeArgs, MAX_ARG_LEN, MAX_TRAIL)
  assert.equal(pr.trail[1].state, 'DONE')
  assert.equal(pr.current, null)
  p.foldStreamEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }, pr, summarizeArgs, MAX_ARG_LEN, MAX_TRAIL)
  assert.equal(pr.current.tool, 'thinking')
  p.foldStreamEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'typing...' }] } }, pr, summarizeArgs, MAX_ARG_LEN, MAX_TRAIL)
  assert.equal(pr.current.tool, 'typing')
  p.foldStreamEvent({ type: 'irrelevant' }, pr, summarizeArgs, MAX_ARG_LEN, MAX_TRAIL)
})

// ── POLICY_TEXT 防漂移锁（Lead 要求：长度 + 首尾锚点 + Backends 前单空行）────
test('POLICY_TEXT 字节锚：长度 6970 + 首尾 + Backends 前单空行', () => {
  const t = mk().policyText
  assert.equal(t.length, 6970)
  assert.ok(t.startsWith('codebuddy-first execution policy'))
  assert.ok(t.endsWith('A user-preferred default backend (plugin settings) applies when a call is new (no session) and no explicit backend is given.'))
  assert.ok(t.includes('\n\nBackends: codebuddy_run'), 'Backends 段前恰好一个空行')
  assert.ok(!t.includes('\n\n\nBackends'), '不得出现双空行（v0.1.0 漂移已修）')
  assert.ok(t.includes('Fallback protocol') && t.includes('Model selection:') && t.includes('--permission-mode bypassPermissions'))
})

// ── tools schema 细节钉（枚举/必填/无 background on continue 之外的漂移）─────
test('tools schema：required/enum/无多余键（契约 §8 红线快照）', () => {
  const p = mk()
  assert.deepEqual(p.tools.run.inputSchema.required, ['prompt'])
  assert.equal(p.tools.run.inputSchema.additionalProperties, false)
  assert.deepEqual(p.tools.run.inputSchema.properties.backend.enum, ['codebuddy', 'codebuddy-intl', 'codebuddy-ioa', 'codebuddy-international', 'codebuddy-en', 'workbuddy-en', 'workbuddy-ai', 'workbuddy'])
  assert.deepEqual(p.tools.run.inputSchema.properties.mode.enum, ['auto', 'plan', 'accept-edits'])
  assert.deepEqual(p.tools.continue.inputSchema.properties.mode.enum, ['auto', 'plan', 'accept-edits'])
  assert.ok('background' in p.tools.run.inputSchema.properties && 'background' in p.tools.continue.inputSchema.properties)
  assert.deepEqual(p.tools.status.inputSchema.properties.cwd.type, 'string')
})
