// tests/mimo/descriptor.test.mjs — providers/mimo.mjs 描述符契约与移植语义。
// 2026-10 去 desktop 化：单后端（backends() 恒 null），模型由 settings.defaultModel
// 手动指定（留空 = 不传 --model，交 mimo CLI 自身默认）；登录走 mimo auth login。
import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import defineProvider, { parseMimoModels, fetchMimoModelsSync } from '../../providers/mimo.mjs'

const provider = defineProvider({ env: {} })
// 真实格式的假 `mimo models` 输出（含中文破折号 U+2014、逗号描述、多连字符模型名）。
const FIX = (f) => fileURLToPath(new URL('./fixtures/' + f, import.meta.url))

test('契约 ★ 字段齐备（PROVIDER-CONTRACT.md §1）', () => {
  assert.equal(provider.id, 'mimo')
  assert.equal(provider.label, 'MIMO')
  assert.equal(provider.presetId, 'cordis-mimo')
  assert.equal(provider.defaultBackend, null)
  assert.equal(provider.defaultMode, 'auto')
  assert.equal(provider.exeName, 'mimo')
  assert.deepEqual(provider.binEnvVars, ['MIMO_BIN', 'MIMO_CLI'])
  assert.equal(provider.unavailableStatus, 'MIMO_UNAVAILABLE')
  // 去 desktop 化后 delegates/preflight/execute 已移除（非 spawn 单后端，无桌面回读）。
  for (const f of ['backends', 'normalizeBackend', 'resolveBackend', 'buildArgv', 'parseJson', 'buildResult', 'runToolLogic', 'continueToolLogic', 'statusToolLogic', 'attach', 'foldStreamEvent', 'isLimited', 'failureHint', 'isSuccessStatus']) {
    assert.equal(typeof provider[f], 'function', f + ' must be a function')
  }
  assert.equal(provider.tools.run.name, 'mimo_run')
  assert.equal(provider.tools.continue.name, 'mimo_continue')
  assert.equal(provider.tools.status.name, 'mimo_status')
  assert.equal(provider.extraTools[0].name, 'mimo_settings')
  // 描述符不再复制版本字面量（单一来源 = mcp/version.mjs 的 packageVersion()）。
  assert.deepEqual(provider.mcp, {})
})

test('单后端归一：backends() 恒 null，任何输入归一为 null', () => {
  assert.equal(provider.backends(), null)
  for (const v of ['mimocode', 'mimo-code', 'CLI', 'mimo-cli', ' MiMoCode ', 'mimo', 'MIMO', 'agy', '', null, undefined, 42, {}]) {
    assert.equal(provider.normalizeBackend(v), null, 'normalizeBackend(' + String(v) + ')')
  }
  // resolveBackend 也恒 null（arg > preferred > default 链条整体作废）。
  assert.equal(provider.resolveBackend({ backend: 'mimocode' }, null, 'mimocode'), null)
  assert.equal(provider.resolveBackend({}, {}, null), null)
  assert.equal(provider.resolveBackend(null, null, null), null)
})

// ── buildArgv（旧 core L213-241 verbatim）────────────────────────────────────
test('buildArgv mimocode 基础旗标：run + --format json + 免提示 + 默认 build', () => {
  const b = provider.buildArgv('mimo', { prompt: 'do it' }, { planActive: false })
  assert.deepEqual(b.argv.slice(0, 5), ['mimo', 'run', 'do it', '--format', 'json'])
  assert.ok(b.argv.includes('--dangerously-skip-permissions'))
  assert.equal(b.argv[b.argv.indexOf('--agent') + 1], 'build')
  assert.equal(b.timeoutSec, 600)
})

test('buildArgv auto 跟随 DSH plan 态；accept-edits 映射 build', () => {
  const planB = provider.buildArgv('mimo', { prompt: 'x' }, { planActive: true })
  assert.equal(planB.argv[planB.argv.indexOf('--agent') + 1], 'plan')
  assert.equal(planB.mode, 'plan')
  const b = provider.buildArgv('mimo', { prompt: 'x', mode: 'accept-edits' }, {})
  assert.ok(b.argv.join(' ').includes('--agent build'))
})

test('buildArgv 全旗标组合：--model/--variant/--dir/--session/--title 顺序稳定', () => {
  const b = provider.buildArgv(['mimo'], {
    prompt: 'p', mode: 'plan', model: 'mimo/mimo', effort: 'low',
    cwd: 'C:\\x', sessionId: 'ses_1', title: 'T', timeoutSec: 90
  }, {})
  const argv = b.argv
  assert.equal(argv[0], 'mimo')
  assert.deepEqual(argv.slice(1, 4), ['run', 'p', '--format'])
  assert.ok(argv.indexOf('--agent') < argv.indexOf('--model'), 'agent precedes model')
  assert.equal(argv[argv.indexOf('--model') + 1], 'mimo/mimo')
  assert.equal(argv[argv.indexOf('--variant') + 1], 'minimal', 'effort low→minimal')
  assert.equal(argv[argv.indexOf('--dir') + 1], 'C:\\x')
  assert.equal(argv[argv.indexOf('--session') + 1], 'ses_1')
  assert.equal(argv[argv.indexOf('--title') + 1], 'T')
  assert.ok(!argv.includes('--continue'), '--session wins over --continue')
  assert.equal(b.timeoutSec, 90)
})

test('buildArgv effort 映射：high→high、medium 不发 --variant（旧语义）', () => {
  assert.ok(!provider.buildArgv('mimo', { prompt: 'x', effort: 'medium' }, {}).argv.includes('--variant'))
  const hi = provider.buildArgv('mimo', { prompt: 'x', effort: 'high' }, {}).argv
  assert.equal(hi[hi.indexOf('--variant') + 1], 'high')
})

test('buildArgv continueLatest → --continue', () => {
  assert.ok(provider.buildArgv('mimo', { prompt: 'x', continueLatest: true }, {}).argv.includes('--continue'))
})

test('buildArgv timeoutSec 夹取（10..3600，默认 600）', () => {
  const cases = [[undefined, 600], [5, 10], [99999, 3600], ['42.7', 42], ['abc', 600], [0, 10]]
  for (const [input, want] of cases) {
    const b = provider.buildArgv('mimo', { prompt: 'x', timeoutSec: input }, {})
    assert.equal(b.timeoutSec, want, 'timeoutSec(' + String(input) + ')')
  }
})

// ── defaultModel（用户定案：模型在设置里手动指定，不写死默认值）─────────────────
test('buildArgv：未指定模型时不落地 --model（用户要求：由 mimo CLI 自身默认决定）', () => {
  const b = provider.buildArgv('mimo', { prompt: 'x' }, {})
  assert.ok(!b.argv.includes('--model'), 'no --model when nothing is configured')
})

test('buildArgv：显式 args.model 落地 --model', () => {
  const b = provider.buildArgv('mimo', { prompt: 'x', model: 'xiaomi/mimo-v2.6-flash' }, {})
  assert.equal(b.argv[b.argv.indexOf('--model') + 1], 'xiaomi/mimo-v2.6-flash')
})

test('buildArgv：opts.defaultModel 落地 --model（面板默认模型注入通道）', () => {
  const b = provider.buildArgv('mimo', { prompt: 'x' }, { defaultModel: 'xiaomi/mimo-v2.6-pro' })
  assert.equal(b.argv[b.argv.indexOf('--model') + 1], 'xiaomi/mimo-v2.6-pro')
})

test('buildArgv：opts.settings.defaultModel 也生效（宿主经 getSettings 的等价形态）', () => {
  const b = provider.buildArgv('mimo', { prompt: 'x' }, { settings: { defaultModel: 'xiaomi/mimo-v2.6-pro-ultraspeed' } })
  assert.equal(b.argv[b.argv.indexOf('--model') + 1], 'xiaomi/mimo-v2.6-pro-ultraspeed')
})

test('buildArgv：args.model 压过 opts.defaultModel（显式调用优先）', () => {
  const b = provider.buildArgv('mimo', { prompt: 'x', model: 'xiaomi/from-arg' }, { defaultModel: 'xiaomi/from-settings' })
  assert.equal(b.argv[b.argv.indexOf('--model') + 1], 'xiaomi/from-arg')
})

test('buildArgv：空串/纯空白的 model 与 defaultModel 一律不落地 --model', () => {
  for (const args of [{ prompt: 'x', model: '' }, { prompt: 'x', model: '   ' }, { prompt: 'x', model: null }]) {
    assert.ok(!provider.buildArgv('mimo', args, {}).argv.includes('--model'), JSON.stringify(args))
  }
  for (const opts of [{ defaultModel: '' }, { defaultModel: '   ' }, { defaultModel: null }, { settings: {} }, { settings: { defaultModel: '' } }]) {
    assert.ok(!provider.buildArgv('mimo', { prompt: 'x' }, opts).argv.includes('--model'), JSON.stringify(opts))
  }
})

test('attach 后 getSettings 注入的 defaultModel 实时生效（改面板无需重启）', () => {
  let panelModel = ''
  const p = defineProvider({ env: {} })
  p.attach({ getSettings: () => ({ defaultModel: panelModel }), publish: () => {} })
  // attach 时面板为空 → 不落地。
  assert.ok(!p.buildArgv('mimo', { prompt: 'x' }, {}).argv.includes('--model'))
  // 面板改默认模型 → 下一次 buildArgv 立即读到（每次调用重读 settingsRef）。
  panelModel = 'xiaomi/mimo-v2.6-flash'
  assert.equal(p.buildArgv('mimo', { prompt: 'x' }, {}).argv[p.buildArgv('mimo', { prompt: 'x' }, {}).argv.indexOf('--model') + 1], 'xiaomi/mimo-v2.6-flash')
  // 面板再清空 → 重新不落地（不被 attach 时的初值钉死）。
  panelModel = ''
  assert.ok(!p.buildArgv('mimo', { prompt: 'x' }, {}).argv.includes('--model'))
})

// ── parseMimoModels（`mimo models` 实测输出；设置面板下拉数据源）──────────────
test('parseMimoModels：真实输出格式（中文破折号 + 逗号描述）逐字段切分', () => {
  const out = parseMimoModels([
    'Available models:',
    'xiaomi/mimo-v2.6-flash — window 1.05M, compacts at 944K',
    'xiaomi/mimo-v2.6-pro — window 1.05M, compacts at 944K',
    'xiaomi/mimo-v2.6-pro-ultraspeed — window 1.05M, compacts at 944K'
  ].join('\n'))
  assert.deepEqual(out.map((m) => m.id), ['xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-pro-ultraspeed'])
  assert.deepEqual(out[0], { id: 'xiaomi/mimo-v2.6-flash', provider: 'xiaomi', name: 'mimo-v2.6-flash', note: 'window 1.05M, compacts at 944K' })
  // 模型名自身含多个连字符，必须整体保留为 name（不按连字符再切）。
  assert.equal(out[2].name, 'mimo-v2.6-pro-ultraspeed')
  assert.equal(out[2].note, 'window 1.05M, compacts at 944K')
})

test('parseMimoModels：短横破折号 U+2013 与列表记号（• -）同样兼容', () => {
  const out = parseMimoModels([
    '• xiaomi/mimo-v2.6-flash – window 1.05M',
    '- xiaomi/mimo-v2.6-pro | window 1.05M'
  ].join('\n'))
  assert.deepEqual(out.map((m) => m.id), ['xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro'])
  assert.equal(out[0].note, 'window 1.05M')
  assert.equal(out[1].note, 'window 1.05M')
})

test('parseMimoModels：数字编号行首被整体丢弃（行首清洗只吃非字母数字前缀）', () => {
  // 真实形态约束：行首清洗是 raw.replace(/^[^A-Za-z0-9]+/, '') —— '1. ' 里的 '1' 是
  // 字母数字，清洗停在 '1. xiaomi/...'，随后的 '1' 被当成 provider 名、'.' 破坏
  // provider/model 形态 → 整行不匹配被丢弃。这是已知边界：编号行必须在宿主侧先剥掉。
  const out = parseMimoModels([
    '1. xiaomi/mimo-v2.6-flash — window 1.05M',
    '2. xiaomi/mimo-v2.6-pro — window 1.05M'
  ].join('\n'))
  assert.deepEqual(out, [], 'numbered lines are not silently mis-parsed — they are dropped')
  // 无编号的同类行正常解析（证明不是整体坏掉）。
  const clean = parseMimoModels([
    'xiaomi/mimo-v2.6-flash — window 1.05M',
    'xiaomi/mimo-v2.6-pro — window 1.05M'
  ].join('\n'))
  assert.deepEqual(clean.map((m) => m.id), ['xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro'])
})

test('parseMimoModels：模型名后无描述时 note 为空串；: 分隔同样兼容', () => {
  const out = parseMimoModels('mimo/mimo-auto\nxiaomi/mimo-v2.6-flash: window 1.05M')
  assert.deepEqual(out.map((m) => m.id), ['mimo/mimo-auto', 'xiaomi/mimo-v2.6-flash'])
  assert.equal(out[0].note, '')
  assert.equal(out[0].provider, 'mimo')
  assert.equal(out[1].note, 'window 1.05M')
})

test('parseMimoModels：去重、丢表头/说明/空行；空与畸形输入返回空数组（不抛）', () => {
  const out = parseMimoModels([
    'xiaomi/mimo-v2.6-flash',
    'xiaomi/mimo-v2.6-flash',
    '',
    '   ',
    'Available models:',
    'not a model',
    'plain text without slash'
  ].join('\n'))
  assert.deepEqual(out.map((m) => m.id), ['xiaomi/mimo-v2.6-flash'])
  assert.deepEqual(parseMimoModels(''), [])
  assert.deepEqual(parseMimoModels(null), [])
  assert.deepEqual(parseMimoModels(undefined), [])
  assert.deepEqual(parseMimoModels(42), [])
})

test('fetchMimoModelsSync：探测失败（exit 非 0）返回空数组且不抛', () => {
  // 真实 Node 宿主有 child_process：MIMO_BIN 指向不存在的 fixture → spawnSync 失败。
  // 面板下拉必须退化为自由输入（空数组），绝不能因探测失败抛异常或伪造列表。
  const out = fetchMimoModelsSync({ MIMO_BIN: join(tmpdir(), 'definitely-not-mimo-xyz.mjs') }, 2000)
  assert.deepEqual(out, [])
})

test('fetchMimoModelsSync：超时夹紧到 1000..30000 且非法入参不抛', () => {
  // clampInt(timeoutMs, 8000, 1000, 30000)：非法值一律回退默认 8000，绝不抛。
  assert.doesNotThrow(() => fetchMimoModelsSync({}, 'abc'))
  assert.doesNotThrow(() => fetchMimoModelsSync(null, null))
  assert.doesNotThrow(() => fetchMimoModelsSync({}, -5))
})

// 契约 §3.2：settings.meta 只读缓存、绝不探测。同文件内 node:test 顺序执行，故
// 「未拉取 → options 为空」必须排在下面的 refreshModels 用例之前（否则缓存已被填上）。
test('settings.meta：只读缓存（未拉取时 options 为空），字段带 refresh 标记', () => {
  // MIMO_BIN 指向一个能输出模型清单的假 CLI：meta() 仍然不得起进程（只认缓存）。
  const m = provider.settings.meta({ MIMO_BIN: FIX('fake-mimo-models.mjs') })
  assert.equal(m.titleSuffix, 'MiMo')
  assert.deepEqual(m.fields.map((f) => f.key), ['defaultModel'])
  assert.equal(m.fields[0].type, 'select')
  assert.equal(m.fields[0].allowCustom, true)
  assert.deepEqual(m.fields[0].options, [], 'meta() must not probe: cache empty before a manual pull')
  assert.deepEqual(m.fields[0].refresh, { label: '拉取可用模型' })
  assert.match(m.fields[0].note, /拉取可用模型/)
  // 面板渲染绝不因探测失败而抛（关掉自动探测后这条更是硬约束）。
  assert.doesNotThrow(() => provider.settings.meta({}))
})

// ── settings.refreshModels（契约 §3.2：用户点按钮才拉取）───────────────────────
test('refreshModels：CLI 不存在 → ok:false + 可操作错误（绝不 ok:true / 空清单）', async () => {
  const r = await provider.settings.refreshModels({}, { MIMO_BIN: join(tmpdir(), 'definitely-not-mimo-xyz.exe') })
  assert.equal(r.ok, false)
  assert.deepEqual(r.ids, [])
  assert.equal(r.source, 'mimo-models')
  assert.match(r.error, /未找到 mimo 可执行文件/)
  // 错误必须可行动：告诉用户装 CLI 或设 MIMO_BIN，而不是一句 "failed"。
  assert.match(r.error, /安装 MiMoCode CLI|MIMO_BIN/)
})

test('refreshModels：CLI 跑通但没有模型行 → ok:false 且指引手动确认（不伪造清单）', async () => {
  const r = await provider.settings.refreshModels({}, { MIMO_BIN: FIX('fake-mimo-echo.mjs') })
  assert.equal(r.ok, false)
  assert.deepEqual(r.ids, [])
  assert.match(r.error, /没有解析到任何 provider\/model 行/)
})

test('refreshModels：成功 → ids/labels/source 就位，并写回缓存供 meta 命中', async () => {
  const r = await provider.settings.refreshModels({}, { MIMO_BIN: FIX('fake-mimo-models.mjs') })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'mimo-models')
  assert.deepEqual(r.ids, ['xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro'])
  assert.equal(r.labels['xiaomi/mimo-v2.6-pro'], 'xiaomi/mimo-v2.6-pro')
  // 缓存命中：随后的 meta() 直接给出选项（不再起进程）。
  const m = provider.settings.meta({})
  assert.deepEqual(m.fields[0].options.map((o) => o.value), ['xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro'])
  assert.match(m.fields[0].note, /共 2 个可用模型/)
})

// ── parseJson / buildResult（旧 core verbatim）───────────────────────────────
test('parseMimoJson：sessionID/text/error/step_update tokens', () => {
  const p = provider.parseJson([
    '{"type":"session","properties":{"id":"ses_a"}}',
    '{"type":"tool","properties":{"tool":"bash","arguments":{"command":"ls"}}}',
    '{"type":"text","text":"Hello","sessionID":"ses_b"}',
    '{"type":"step_update","properties":{"tokens":{"total":42}}}'
  ].join('\n'))
  assert.equal(p.sessionId, 'ses_b')
  assert.equal(p.text, 'Hello')
  assert.equal(p.totalTokens, 42)
})

test('buildResult：成功 SUCCESS；error → failed + errorName；accepted 无 text → ACCEPTED', () => {
  const ok = provider.buildResult(provider.parseJson('{"type":"text","text":"PONG","sessionID":"ses_x"}'), { exitCode: 0 }, 'build', '', '', 'mimocode')
  assert.equal(ok.ok, true)
  assert.equal(ok.status, 'SUCCESS')
  assert.equal(ok.sessionId, 'ses_x')
  const err = provider.buildResult(provider.parseJson('{"type":"error","sessionID":"ses_e","error":{"name":"UnknownError","data":{"message":"boom"}}}'), { exitCode: 1 }, 'build', '', '', 'mimocode')
  assert.equal(err.ok, false)
  assert.equal(err.status, 'UnknownError')
  // ACCEPTED 成功态集合逐字保留（去 desktop 化后不再产生，但契约 §1 语义不变）。
  const acc = provider.buildResult({ text: '', sessionId: 's', accepted: true }, { exitCode: 0 }, 'auto', '', '', 'mimocode')
  assert.equal(acc.ok, true)
  assert.equal(acc.status, 'ACCEPTED')
})

test('isSuccessStatus：ACCEPTED 计入成功态（指示灯不红，契约 §1）', () => {
  assert.equal(provider.isSuccessStatus('SUCCESS'), true)
  assert.equal(provider.isSuccessStatus('ACCEPTED'), true)
  assert.equal(provider.isSuccessStatus('ERROR'), false)
  assert.equal(provider.isSuccessStatus(null), false)
})

// ── isLimited（mimo 专属 LIMIT_RE 覆盖 kit 版）───────────────────────────────
test('isLimited：MiMo 免费 API/登录/第三方文案命中；普通异常不命中', () => {
  const free = { ok: false, status: 'UnknownError', stderr: 'MiMo free API service has ended. Sign in or configure a third-party API.' }
  assert.equal(provider.isLimited(free), true, 'free-API wording must be limited')
  assert.equal(provider.isLimited({ ok: false, stderr: '请先登录' }), true)
  assert.equal(provider.isLimited({ ok: false, stderr: 'TypeError: x is not a function' }), false)
  assert.equal(provider.isLimited({ ok: false, status: 'MIMO_UNAVAILABLE' }), true)
  assert.equal(provider.isLimited({ ok: false, status: 'HUNG_TIMEOUT' }), true)
  assert.equal(provider.isLimited({ ok: true, status: 'SUCCESS' }), false)
})

// ── failureHint（去 desktop 化后的三条诊断文案）──────────────────────────────
test('failureHint：MIMO_UNAVAILABLE 指引安装/MIMO_BIN；free-API 指引登录与设置模型', () => {
  assert.match(provider.failureHint({ ok: false, status: 'MIMO_UNAVAILABLE' }), /MIMO_BIN/)
  assert.match(provider.failureHint({ ok: false, status: 'X', stderr: 'free API service has ended' }), /mimo auth login/)
  assert.match(provider.failureHint({ ok: false, status: 'X', stderr: 'free API service has ended' }), /设置|默认模型/)
  assert.match(provider.failureHint({ ok: false, status: 'X', errorMessage: '请先登录' }), /mimo auth login/)
  assert.match(provider.failureHint({ ok: false, status: 'X', stderr: 'configure a third-party' }), /mimo auth login/)
  assert.equal(provider.failureHint({ ok: true }), '')
})

test('failureHint：模型不可用指引 `mimo models` 与默认模型设置', () => {
  for (const msg of ['model not found', 'unknown model', 'no models available', 'invalid model', 'unknown provider']) {
    const hint = provider.failureHint({ ok: false, status: 'ERROR', stderr: msg })
    assert.match(hint, /mimo models/, 'hint must name `mimo models` for: ' + msg)
    assert.match(hint, /默认模型|model 参数/, 'hint must point at settings/model arg')
  }
  // 无关失败 → 无诊断（不制造噪音）。
  assert.equal(provider.failureHint({ ok: false, status: 'ERROR', stderr: 'SyntaxError: unexpected token' }), '')
})

// ── settings 分区（契约 §3）─────────────────────────────────────────────────
test('settings.keys 是 defaultModel（用户手动指定模型；不写死默认值）', () => {
  assert.deepEqual(provider.settings.keys, ['defaultModel'])
  assert.deepEqual(provider.settings.defaults(), { defaultModel: '' })
  assert.deepEqual(provider.settings.normalize({ defaultModel: '  xiaomi/mimo-v2.6-flash  ', junk: 1, updatedAt: 123 }), { defaultModel: 'xiaomi/mimo-v2.6-flash' })
  // 缺失/非字符串/纯空白 → 空串（不传 --model，交 mimo CLI 自决）。
  assert.deepEqual(provider.settings.normalize({}), { defaultModel: '' })
  assert.deepEqual(provider.settings.normalize({ defaultModel: '   ' }), { defaultModel: '' })
  assert.deepEqual(provider.settings.normalize({ defaultModel: 42 }), { defaultModel: '' })
  assert.deepEqual(provider.settings.normalize(null), { defaultModel: '' })
})

test('settings.meta：字段形状与 placeholder 稳定（不依赖任何探测结果）', () => {
  const m = provider.settings.meta()
  assert.equal(m.titleSuffix, 'MiMo')
  assert.deepEqual(m.fields.map((f) => f.key), ['defaultModel'])
  assert.equal(m.fields[0].type, 'select')
  assert.equal(m.fields[0].allowCustom, true)
  assert.ok(Array.isArray(m.fields[0].options), 'options must be an array')
  assert.match(m.fields[0].placeholder, /留空/)
  // CLI 不存在时也绝不抛（缓存是进程级共享的，此处不断言空 —— 空态断言在前面的
  // 「只读缓存」用例里，那里保证缓存尚未被填充）。
  assert.doesNotThrow(() => provider.settings.meta({ MIMO_BIN: join(tmpdir(), 'definitely-not-mimo-xyz.exe') }))
  assert.doesNotThrow(() => provider.settings.meta({}))
})

test('settings.diagnose：模型与 exe 来源同步可见（未设置模型须明示不传 --model）', () => {
  assert.match(provider.settings.diagnose({ defaultModel: '' }, {}), /model=\(未设置/)
  assert.match(provider.settings.diagnose({ defaultModel: 'xiaomi/mimo-v2.6-flash' }, {}), /model=xiaomi\/mimo-v2\.6-flash/)
  assert.match(provider.settings.diagnose({}, { MIMO_BIN: 'C:/mimo.exe' }), /bin=env:C:\/mimo\.exe/)
  assert.equal(typeof provider.settings.diagnose(null), 'string')
})

// ── mimo_settings 附加工具（model 读写；写盘仅宿主有 nodeFs 时可用）──────────
test('mimo_settings 读：无 model 入参 → 回显当前默认模型（不抛、不写盘）', async () => {
  const v = await provider.extraTools[0].logic({})
  assert.equal(v.ok, true)
  assert.equal(v.defaultModel, '')
  assert.match(v.effective, /不传 --model/)
  assert.match(v.note, /mimo models/)
  const rendered = provider.extraTools[0].render(v)[0].text
  assert.match(rendered, /mimo settings/)
  assert.match(rendered, /default model  : \(unset/)
})

test('mimo_settings 写：model 入参在无 fs 宿主只回显不落盘（saved=false）', async () => {
  const v = await provider.extraTools[0].logic({ model: 'xiaomi/mimo-v2.6-flash' })
  assert.equal(v.ok, true)
  assert.equal(v.defaultModel, 'xiaomi/mimo-v2.6-flash')
  assert.match(v.effective, /settings:xiaomi\/mimo-v2\.6-flash/)
  assert.equal(v.saved, false, 'no nodeFs injected → echo only, never pretend to persist')
  assert.match(v.note, /mimo models/)
})

test('mimo_settings schema 只有 model 入参（旧 backend/桌面模型语义已删除）', () => {
  const props = provider.extraTools[0].inputSchema.properties
  assert.deepEqual(Object.keys(props), ['model'])
  assert.match(provider.extraTools[0].description, /default mimo model/)
})

// ── _internals 纯函数面（测试/宿主可用）─────────────────────────────────────
test('_internals 暴露纯函数面（测试/宿主可用）', () => {
  const I = provider._internals
  assert.equal(typeof I.parseMimoJson, 'function')
  assert.equal(typeof I.buildResult, 'function')
  assert.equal(typeof I.mimoCandidateExePaths, 'function')
  assert.equal(typeof I.resolveMimoExePrefix, 'function')
  assert.equal(typeof I.parseMimoModels, 'function')
  assert.equal(typeof I.fetchMimoModelsSync, 'function')
  assert.equal(typeof I.fetchMimoModelsDetailed, 'function')
  assert.equal(typeof I.cachedMimoModels, 'function')
  assert.equal(typeof I.rememberMimoModels, 'function')
  assert.equal(typeof I.currentSettings, 'function')
  assert.equal(typeof I.liveSettings, 'function')
  assert.equal(typeof I.writePartition, 'function')
  assert.ok(I.MIMO_LIMIT_RE instanceof RegExp)
})

test('_internals.mimoCandidateExePaths：空 env 返回空数组（不炸）', () => {
  assert.deepEqual(provider._internals.mimoCandidateExePaths({}), [])
})

test('_internals.resolveMimoExePrefix：env MIMO_BIN 优先，.mjs 经 node 包装', () => {
  assert.deepEqual(provider._internals.resolveMimoExePrefix({ MIMO_BIN: 'C:/custom/mimo.exe' }, ''), ['C:/custom/mimo.exe'])
  const p = provider._internals.resolveMimoExePrefix({}, 'C:/fake/fake-mimo.mjs')
  assert.equal(p.length, 2)
  assert.equal(p[1], 'C:/fake/fake-mimo.mjs')
  // 无 env 无 binPath → 退回二进制名。
  const fallback = provider._internals.resolveMimoExePrefix({}, '')
  assert.ok(Array.isArray(fallback) && fallback.length === 1)
  assert.equal(typeof fallback[0], 'string')
})
