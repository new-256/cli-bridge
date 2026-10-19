// tests/codebuddy/models-tool.test.mjs — codebuddy_models（实时模型清单）回归。
//
// 设计变更（0.2.6）：清单来源从「磁盘静态描述文件」改为**CLI 实时**：
//   A. account-live —— 起 CLI 用无效模型探测 400 报文里的「该账号当前支持」清单（权威）
//   B. cli-help     —— 解析 `--help` 声明的 roster（零网络，随 CLI 版本）
//   C. 静态表仅作倍率元数据，绝不冒充实时。
// 本测试用 `CODEBUDDY_BIN` 指向夹具，**不依赖本机真实 CLI**，可在任何机器复现。
//
// 红线（对照 workbuddy-auth 的静默降级，本仓禁止照抄）：
//   拿不到任何实时名册时必须 ok:false + 可操作错误，
//   绝不返回 { ok:true, models:[] } 或伪造列表。
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import defineProvider from '../../providers/codebuddy.mjs'
import { parseAccountModels } from '../../providers/codebuddy-catalog.mjs'
import { parseHelpModels } from '../../providers/codebuddy-models-source.mjs'

const FIX = (f) => fileURLToPath(new URL('./fixtures/' + f, import.meta.url))

// 带能力（preset/MCP 形态都注入 process 或 nodeChild/nodeFs）+ 指定夹具 CLI
const mk = (extraEnv = {}) => defineProvider({
  env: Object.assign({ CODEBUDDY_BIN: FIX('fake-cb-help.mjs') }, extraEnv),
  process
})

function modelsTool(p) {
  const et = (p.extraTools || []).find((t) => t.name === 'codebuddy_models')
  assert.ok(et, 'extraTools 必须暴露 codebuddy_models')
  return et
}

// ── 纯解析函数（零 I/O，锁折行与锚点行为）─────────────────────────────────────
test('parseHelpModels：名册折行 + 令牌中间断行都能稳定还原', () => {
  const help = '  --model <model>  Model for the current session.\n' +
    '        Currently supported: (hy4-preview, hy3, hy3-x,\n' +
    '                             step-5-preview, minimax-\n' +
    'm3-pay, kimi-k3-2, deepseek-v4-pro)\n'
  const ids = parseHelpModels(help)
  assert.equal(ids.length, 7, JSON.stringify(ids))
  assert.deepEqual(ids, ['hy4-preview', 'hy3', 'hy3-x', 'step-5-preview', 'minimax-m3-pay', 'kimi-k3-2', 'deepseek-v4-pro'])
  // 折行把 minimax-m3-pay 从中间断开 —— 必须还原成完整 id，且不能出现残片
  assert.ok(ids.includes('minimax-m3-pay'), 'wrapped token must be reassembled')
  assert.ok(!ids.includes('minimax-'), 'must not emit a truncated fragment')
  assert.ok(!ids.includes('m3-pay'), 'must not emit a truncated fragment')
})

test('parseHelpModels：无名册/空/畸形输入返回 []（不抛）', () => {
  for (const t of ['', null, undefined, 'no roster here', 'Currently supported: ()']) {
    assert.deepEqual(parseHelpModels(t), [])
  }
})

test('parseAccountModels：只认锚点后的 "- id" 行，遇到非列表行即停', () => {
  const txt = 'error 400\nCurrently supported models for your account:\n- a-1\n- b-2\n\nsome trailing noise\n- c-3\n'
  assert.deepEqual(parseAccountModels(txt), ['a-1', 'b-2'])
  assert.equal(parseAccountModels('no anchor'), null)
})

// ── 工具：实时来源 A（account-live 优先）──────────────────────────────────────
test('codebuddy_models：注册在 extraTools，schema 合法', () => {
  const et = modelsTool(mk())
  assert.equal(typeof et.logic, 'function')
  assert.equal(typeof et.render, 'function')
  assert.equal(et.inputSchema.type, 'object')
  assert.ok(et.description.length > 40)
  assert.ok(et.inputSchema.properties.backend)
  assert.ok(et.inputSchema.properties.freeOnly)
  assert.ok(et.inputSchema.properties.authorizedOnly)
})

test('codebuddy_models：账号探测成功 → source=account-live，清单来自 CLI 实时', async () => {
  const r = await modelsTool(mk()).logic({ backend: 'codebuddy' })
  assert.equal(r.ok, true, JSON.stringify(r.error || ''))
  assert.equal(r.source, 'account-live')
  assert.equal(r.backend, 'codebuddy')
  const ids = r.models.map((m) => m.id)
  assert.equal(ids.length, 19, '夹具名册 19 项')
  // 实机静态表里过时/缺失的 id，必须由实时源补正
  assert.ok(ids.includes('minimax-m3-pay'), 'renamed id present')
  assert.ok(ids.includes('kimi-k3-2'), 'renamed id present')
  assert.ok(ids.includes('step-5-preview') && ids.includes('space-bunny') && ids.includes('glm-5.3-flashx'), 'new ids present')
  assert.ok(!ids.includes('minimax-m3'), 'stale id must not appear')
  assert.ok(!ids.includes('kimi-k3-1'), 'stale id must not appear')
  for (const m of r.models) {
    assert.equal(typeof m.id, 'string')
    assert.equal(typeof m.authorized, 'boolean')
    assert.ok(m.credits === null || typeof m.credits === 'number')
  }
})

test('codebuddy_models：freeOnly / authorizedOnly 过滤生效', async () => {
  const et = modelsTool(mk())
  const free = await et.logic({ freeOnly: true })
  assert.equal(free.ok, true, JSON.stringify(free.error || ''))
  for (const m of free.models) assert.equal(m.credits, 0, 'freeOnly 只返回 x0.00')
  const auth = await et.logic({ authorizedOnly: true })
  assert.equal(auth.ok, true, JSON.stringify(auth.error || ''))
  for (const m of auth.models) assert.equal(m.authorized, true, 'authorizedOnly 只返回已授权')
})

// ── 红线：拿不到任何实时名册 → ok:false，绝不静默空列表 ──────────────────────
test('codebuddy_models：无任何实时来源 → ok:false + 可操作错误（严禁静默空数组）', async () => {
  const p = defineProvider({ env: { CODEBUDDY_BIN: FIX('fake-cb-noroster.mjs') }, process })
  const r = await p.extraTools.find((t) => t.name === 'codebuddy_models').logic({})
  assert.equal(r.ok, false, 'must fail loudly, not return an empty list')
  assert.equal(typeof r.error, 'string')
  assert.ok(r.error.length > 20, 'error must be actionable')
  assert.match(r.error, /CLI|roster|logged in/i)
})

test('codebuddy_models：render 正常与失败两路都不抛', async () => {
  const et = modelsTool(mk())
  const ok = await et.logic({})
  const outOk = et.render({}, ok)
  assert.ok(Array.isArray(outOk) && outOk[0] && typeof outOk[0].text === 'string')
  assert.match(outOk[0].text, /codebuddy models/)
  assert.match(outOk[0].text, /account-live/, 'source label must be explicit')
  const outBad = et.render({}, { ok: false, error: 'boom' })
  assert.match(outBad[0].text, /failed: boom/)
})

test('codebuddy_models：无 spawn/fs 能力的形态不注册（dynamic 沙箱）', () => {
  const p = defineProvider({ env: {} }) // 无 process / nodeChild / nodeFs
  const names = (p.extraTools || []).map((t) => t.name)
  assert.equal(names.includes('codebuddy_models'), false, 'dynamic 沙箱形态应省略该工具')
})
