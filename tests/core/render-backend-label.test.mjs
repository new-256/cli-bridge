// tests/core/render-backend-label.test.mjs — renderResult 标头命名回归锁。
// 背景（takeover Q1）：旧 codebuddy renderResult 标头是 `v.backend || 'codebuddy'`
// （v1.1.0 专修：workbuddy 运行显示 "workbuddy OK"）；旧 agy/mimo 标头硬编码
// 'agy '/'mimo '。合并 kit 初版统一 provider.id 优先 → preset/dynamic 面上
// workbuddy/intl/en 运行全渲染 "codebuddy OK"（观感漂移；MCP 面自带 textResult 无此问题）。
// 修复 = descriptor 旗标 backendLabel（opt-in），agy/mimo 不开 → 零漂移。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../../providers/registry.mjs'
import { renderResult, fallbackLabels } from '../../core/bridge-kit.mjs'

function mkRes(b, over) {
  return Object.assign({ ok: true, status: 'SUCCESS', mode: 'auto', response: 'x', backend: b }, over || {})
}
function head(p, b, over) { return renderResult(mkRes(b, over), p)[0].text.split(' [')[0] }

test('codebuddy：具体 backend 标头 verbatim（旧 v1.1.0 语义）', () => {
  const p = createProvider('codebuddy', { env: {} })
  assert.equal(p.backendLabel, true, 'descriptor 显式开旗')
  assert.equal(head(p, 'codebuddy'), 'codebuddy OK')
  assert.equal(head(p, 'workbuddy'), 'workbuddy OK')
  assert.equal(head(p, 'codebuddy-intl'), 'codebuddy-intl OK')
  assert.equal(head(p, 'codebuddy-en'), 'codebuddy-en OK')
  assert.equal(head(p, null), 'codebuddy OK', '无 backend 字段 → 回落 provider.id（旧 || codebuddy 同义）')
})

test('codebuddy：回退/后台行同用 backend 标头（旧 renderResult 全行一致）', () => {
  const p = createProvider('codebuddy', { env: {} })
  const fb = renderResult(mkRes('workbuddy', { ok: false, fallback: true, reason: 'ERROR' }), p)[0].text
  assert.match(fb, /^workbuddy 回退：.*不要再调 workbuddy/, fb.slice(0, 60))
  const bg = renderResult(mkRes('workbuddy', { background: true, jobId: '9' }), p)[0].text
  assert.match(bg, /^workbuddy dispatched in background/, bg.slice(0, 60))
})

test('agy/mimo：不开旗 → provider.id 恒定（旧包硬编码标头零漂移）', () => {
  for (const id of ['agy', 'mimo']) {
    const p = createProvider(id, { env: {} })
    assert.ok(!p.backendLabel, id + ' 无 backendLabel 旗')
    assert.equal(head(p, 'workbuddy'), id + ' OK', id + ' 标头不受 backend 字段影响')
    assert.equal(head(p, null), id + ' OK')
  }
})

test('fallbackLabels：重试文案恒 provider.id（旧 RETRY_LABEL 常量 verbatim）', () => {
  const p = createProvider('codebuddy', { env: {} })
  assert.deepEqual(fallbackLabels(p), {
    fallback: '使用 DSH 本地 API 配置（回退）',
    retry: '重试 codebuddy 一次',
    cancel: '不回退（返回错误）'
  })
})
