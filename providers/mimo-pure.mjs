// providers/mimo-pure.mjs — mimo 的纯解析/结果构造（无宿主依赖）。
//
// 从 providers/mimo.mjs 拆出，让两个文件都留在 600 行红线内（规则 §26）。
// build 会把 providers/mimo-*.mjs 全部内联进 dynamic 沙箱同一作用域，故主文件
// 仍可直接调用这些函数；ESM 形态走本文件的 import。
// 注意：注释里绝不写出口令标记字面量（build 全局替换会把注释劈开）。

import { shortLabel, summarizeArgs } from '../core/bridge-kit.mjs'

export function parseMimoJson(stdoutText) {
  const trimmed = String(stdoutText || '').trim()
  if (!trimmed) return null
  const events = []
  const lines = trimmed.split(/\r?\n/)
  for (const raw of lines) {
    const ln = raw.trim()
    if (!ln.startsWith('{')) continue
    try {
      const obj = JSON.parse(ln)
      if (obj && typeof obj === 'object') events.push(obj)
    } catch (e) { /* tolerate log lines */ }
  }
  if (!events.length) {
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj === 'object') events.push(obj)
    } catch (e) {
      return { events: [], text: trimmed, sessionId: null, error: null, steps: [] }
    }
  }
  let sessionId = null
  let text = ''
  let errorMessage = null
  let errorName = null
  let numTurns = 0
  let totalTokens = null
  const steps = []
  const textParts = []
  for (const ev of events) {
    if (ev.sessionID && typeof ev.sessionID === 'string') sessionId = ev.sessionID
    if (ev.sessionId && typeof ev.sessionId === 'string') sessionId = ev.sessionId
    if (ev.session && typeof ev.session === 'object' && ev.session.id) sessionId = ev.session.id
    if (ev.type === 'session' && ev.properties && ev.properties.id) sessionId = ev.properties.id
    const t = ev.type
    const p = ev.properties || ev
    if (t === 'error') {
      const err = ev.error || p
      errorMessage = (err.data && err.data.message) || err.message || err.name || 'error'
      errorName = err.name || 'Error'
    } else if (t === 'text' || t === 'message' || t === 'assistant' || t === 'output') {
      const chunk = p.text || p.content || p.message || p.output || (typeof ev.text === 'string' ? ev.text : '')
      if (typeof chunk === 'string' && chunk) {
        textParts.push(chunk)
        steps.push({ at: Date.now(), kind: 'text', label: shortLabel(chunk) })
      }
    } else if (t === 'step-start' || t === 'step-finish' || t === 'step_update') {
      numTurns += 1
      if (p.tokens && typeof p.tokens === 'object') {
        const tt = p.tokens.total ?? p.tokens.input ?? p.tokens.output
        if (typeof tt === 'number') totalTokens = (totalTokens || 0) + tt
      }
      if (t === 'step_update') {
        const name = p.tool_name || p.tool || p.name
        if (name) steps.push({ at: Date.now(), kind: 'tool', label: shortLabel(name + ' ' + JSON.stringify(summarizeArgs(p.arguments || p.args || p.input) || {})) })
      }
    } else if (t === 'tool' || t === 'tool-call' || t === 'tool_use') {
      const name = p.tool || p.name || p.tool_name || 'tool'
      steps.push({ at: Date.now(), kind: 'tool', label: shortLabel(name + ' ' + JSON.stringify(summarizeArgs(p.arguments || p.args || p.input) || {})) })
    }
  }
  if (textParts.length) text = textParts.join('\n')
  else {
    const last = events[events.length - 1] || {}
    const r = last.result || last
    if (typeof r.response === 'string') text = r.response
    else if (typeof r.text === 'string') text = r.text
  }
  return { events, text, sessionId, error: errorMessage, errorName, numTurns, totalTokens, steps }
}

export function buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
  const MAX_TRAIL = 12
  const exitCode = outcome ? outcome.exitCode : null
  const errText = (parsed && parsed.error) ? String(parsed.error) : ''
  const stderr = (stderrText ? String(stderrText).slice(-2000) : '') + (errText ? (stderrText ? ' ' : '') + errText : '')
  const text = parsed && typeof parsed.text === 'string' ? parsed.text : ''
  const failed = exitCode !== 0 || !!(parsed && parsed.error)
  const be = (parsed && parsed.backend) || (outcome && outcome.backend) || backend || null
  if (parsed) {
    return {
      ok: !failed && (!!text || parsed.accepted === true),
      status: failed ? (parsed.errorName || 'ERROR') : (parsed.accepted && !text ? 'ACCEPTED' : (text ? 'SUCCESS' : 'EMPTY')),
      response: text,
      sessionId: parsed.sessionId || null,
      durationSeconds: null,
      numTurns: parsed.numTurns || null,
      totalTokens: parsed.totalTokens || null,
      exitCode, mode, backend: be,
      stderr,
      errorMessage: parsed.error || '',
      accepted: parsed.accepted === true,
      steps: Array.isArray(parsed.steps) ? parsed.steps.slice(-MAX_TRAIL) : []
    }
  }
  return {
    ok: false, status: 'PARSE_ERROR', response: '', sessionId: null,
    durationSeconds: null, numTurns: null, totalTokens: null,
    exitCode, mode, backend: be, stderr, errorMessage: '',
    rawStdout: String(stdoutText || '').slice(-2000)
  }
}
