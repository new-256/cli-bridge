// tests/claude/helpers/verify-real-cli.mjs — 真实 CLI 验收脚本（**不进 node --test**）。
//
// 用途：把描述符的 buildArgv / parseJson / buildResult 直接对着本机真实 Claude Code 跑一遍，
// 证明 argv 契约与输出解析不是「照文档写的」。会真实产生少量 API 费用（约 $0.08/次），
// 故不放进密闭测试套件；按需手动执行：
//   node tests/claude/helpers/verify-real-cli.mjs [claude可执行文件路径]
//
// 退出码：0 全部通过；1 任一断言失败（输出会指出是哪条）。
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

import defineProvider from '../../../providers/claude.mjs'

const exe = process.argv[2] || process.env.CLAUDE_BIN || 'claude'
const provider = defineProvider({ env: process.env })
const log = (s) => process.stdout.write(s + '\n')

function run(argv, label) {
  const t0 = Date.now()
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 240000, windowsHide: true })
  log('\n=== ' + label + ' (' + (Date.now() - t0) + 'ms, exit=' + r.status + ') ===')
  log('argv: ' + JSON.stringify(argv))
  log('stdout: ' + String(r.stdout || '').slice(0, 600))
  if (r.stderr) log('stderr: ' + String(r.stderr || '').slice(0, 400))
  return r
}

// ① 成功路径：-p + stream-json + verbose
const built = provider.buildArgv([exe], { prompt: 'Reply exactly: PONG' }, { planActive: false })
const r1 = run(built.argv, 'run (stream-json)')
const res1 = provider.buildResult(provider.parseJson(r1.stdout), { exitCode: r1.status }, built.mode, r1.stderr, r1.stdout, null)
log('result: ' + JSON.stringify({ ok: res1.ok, status: res1.status, response: res1.response, sessionId: res1.sessionId, modelUsed: res1.modelUsed, tokens: res1.totalTokens, model: built.mode }))
assert.equal(res1.ok, true, 'run must succeed with the real CLI')
assert.match(String(res1.response), /PONG/, 'response must contain the requested token')
assert.ok(res1.sessionId, 'result event must expose session_id')

// ② 续聊：--resume <真实 session_id>
const built2 = provider.buildArgv([exe], { prompt: 'Reply exactly: PONG2', sessionId: res1.sessionId }, {})
const r2 = run(built2.argv, 'run (--resume)')
const res2 = provider.buildResult(provider.parseJson(r2.stdout), { exitCode: r2.status }, built2.mode, r2.stderr, r2.stdout, null)
log('result: ' + JSON.stringify({ ok: res2.ok, status: res2.status, response: res2.response, sessionId: res2.sessionId }))
assert.equal(res2.ok, true, 'resume must succeed')
assert.equal(res2.sessionId, res1.sessionId, 'resume must keep the same session id')
assert.match(String(res2.response), /PONG2/)

// ③ 成功判定陷阱 + 诊断：故意无效模型（服务端 400，exit 1，stdout 仍是合法 JSON）
const built3 = provider.buildArgv([exe], { prompt: 'hi', model: '__clb_probe_invalid__' }, {})
const r3 = run(built3.argv, 'run (invalid model → probe shape)')
const res3 = provider.buildResult(provider.parseJson(r3.stdout), { exitCode: r3.status }, built3.mode, r3.stderr, r3.stdout, null)
log('result: ' + JSON.stringify({ ok: res3.ok, status: res3.status, exitCode: res3.exitCode, subtype: res3.subtype }))
log('failureHint: ' + provider.failureHint(res3))
assert.equal(res3.ok, false, 'is_error=true must never be reported as success')
assert.notEqual(res3.status, 'PARSE_ERROR', 'stdout was valid JSON, so it is not a parse error')
assert.match(provider.failureHint(res3), /支持的模型/, 'hint must surface the server-side supported model list')

// ④ 全部 flag 是否被 CLI 接受（零成本：仍用无效模型，只关心 flag 解析是否通过）。
//    若某个 flag 名/取值不被支持，commander 会在 stderr 报 unknown option 且不产出 result 事件。
const built4 = provider.buildArgv([exe], {
  prompt: 'hi', mode: 'accept-edits', model: '__clb_probe_invalid__', maxBudgetUsd: 0.5,
  addDirs: [process.cwd()], allowedTools: ['Read'], disallowedTools: ['Bash'],
  systemPrompt: 'you are a test', appendSystemPrompt: 'be terse', noSessionPersistence: true
}, {})
const r4 = run(built4.argv, 'run (all flags accepted)')
assert.ok(!/unknown option|error: option/i.test(String(r4.stderr || '')), 'no unsupported flag: ' + String(r4.stderr || '').slice(0, 300))
assert.ok(provider.parseJson(r4.stdout), 'CLI still produced a result event → every flag was accepted')
for (const f of ['--permission-mode', '--max-budget-usd', '--add-dir', '--allowedTools', '--disallowedTools', '--system-prompt', '--append-system-prompt', '--no-session-persistence']) {
  assert.ok(built4.argv.indexOf(f) >= 0, 'argv missing ' + f)
}

log('\nALL REAL-CLI CHECKS PASSED')
