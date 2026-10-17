// tests/codebuddy/models-tool.test.mjs — codebuddy_models（0.2.5 新增工具）回归。
//
// 红线（对照 workbuddy-auth 的静默降级，本仓禁止照抄）：
//   拿不到模型目录时必须 ok:false + 可操作错误，
//   绝不返回 { ok:true, models:[] } 或伪造列表。
import test from 'node:test'
import assert from 'node:assert/strict'
import defineProvider from '../../providers/codebuddy.mjs'

// 宿主形态带能力（preset/MCP 都注入 process 或 nodeChild/nodeFs）→ 工具注册。
const mk = (extraEnv = {}) => defineProvider({ env: extraEnv, process })

function modelsTool(p) {
  const et = (p.extraTools || []).find((t) => t.name === 'codebuddy_models')
  assert.ok(et, 'extraTools 必须暴露 codebuddy_models')
  return et
}

test('codebuddy_models：注册在 extraTools，schema 合法', () => {
  const p = mk()
  const et = modelsTool(p)
  assert.equal(typeof et.logic, 'function')
  assert.equal(typeof et.render, 'function')
  assert.equal(et.inputSchema.type, 'object')
  assert.ok(et.description.length > 40)
  // 三个可选过滤参数都在
  assert.ok(et.inputSchema.properties.backend)
  assert.ok(et.inputSchema.properties.freeOnly)
  assert.ok(et.inputSchema.properties.authorizedOnly)
})

test('codebuddy_models：有目录 → ok=true，条目字段完整', async () => {
  const p = mk()
  const r = await modelsTool(p).logic({})
  assert.equal(r.ok, true, JSON.stringify(r.error || ''))
  assert.ok(Array.isArray(r.models) && r.models.length > 0, '应列出模型')
  assert.equal(typeof r.backend, 'string')
  assert.ok(r.backend.length > 0)
  for (const m of r.models) {
    assert.equal(typeof m.id, 'string')
    assert.ok(m.id.length > 0)
    assert.equal(typeof m.authorized, 'boolean')
    assert.ok(m.credits === null || typeof m.credits === 'number', 'credits 是数字或 null')
  }
})

test('codebuddy_models：backend 指定生效', async () => {
  const p = mk()
  const r = await modelsTool(p).logic({ backend: 'codebuddy-en' })
  assert.equal(r.ok, true, JSON.stringify(r.error || ''))
  assert.equal(r.backend, 'codebuddy-en')
})

test('codebuddy_models：freeOnly 只返回 x0.00', async () => {
  const p = mk()
  const r = await modelsTool(p).logic({ freeOnly: true })
  assert.equal(r.ok, true, JSON.stringify(r.error || ''))
  for (const m of r.models) assert.equal(m.credits, 0, 'freeOnly 必须过滤掉非零倍率')
})

test('codebuddy_models：authorizedOnly 只返回已授权', async () => {
  const p = mk()
  const r = await modelsTool(p).logic({ authorizedOnly: true })
  assert.equal(r.ok, true, JSON.stringify(r.error || ''))
  for (const m of r.models) assert.equal(m.authorized, true, 'authorizedOnly 必须过滤未授权')
})

test('codebuddy_models：拿不到目录 → ok:false + 可操作错误（严禁静默空数组）', async () => {
  // 未知/无静态表的 backend：目录为空时必须明确失败。
  const p = mk()
  const r = await modelsTool(p).logic({ backend: 'codebuddy-ioa' })
  if (r.ok) {
    // 若该面确实有目录，则不允许是空列表
    assert.ok(r.models.length > 0, 'ok:true 时绝不能返回空列表')
  } else {
    assert.equal(typeof r.error, 'string')
    assert.ok(r.error.length > 20, '错误信息必须可操作（说明装什么 / 怎么办）')
  }
})

test('codebuddy_models：render 正常与失败两路都不抛', async () => {
  const p = mk()
  const et = modelsTool(p)
  const ok = await et.logic({})
  const outOk = et.render({}, ok)
  assert.ok(Array.isArray(outOk) && outOk[0] && typeof outOk[0].text === 'string')
  assert.match(outOk[0].text, /codebuddy models/)
  const outBad = et.render({}, { ok: false, error: 'boom' })
  assert.match(outBad[0].text, /failed: boom/)
})

test('codebuddy_models：无 spawn/fs 能力的形态不注册（dynamic 沙箱）', () => {
  const p = defineProvider({ env: {} }) // 无 process / nodeChild / nodeFs
  const names = (p.extraTools || []).map((t) => t.name)
  assert.equal(names.includes('codebuddy_models'), false, 'dynamic 沙箱形态应省略该工具')
})
