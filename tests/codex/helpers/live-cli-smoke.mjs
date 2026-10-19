// tests/codex/helpers/live-cli-smoke.mjs — 真 CLI 冒烟（不参与 node --test 自动发现）。
//
// 目的：证明 providers/codex.mjs 的 buildArgv/parseJson/buildResult 与**真实** codex CLI
// 对得上（假 exe 只能证形态，证不了本机版本的真实旗集与事件流）。
//
// 用法：node tests/codex/helpers/live-cli-smoke.mjs
// 需要：本机装了 codex（或设 CODEX_BIN）。会真的调用模型（消耗少量额度）。
//
// 关键纪律（任务卡要求）：用 node spawnSync、**不经过 shell**、prompt 作为单个 argv 元素
// —— 这正是 DSH subprocess 的调用形态，能暴露引号/空格被二次解释之类的问题。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import defineProvider from '../../../providers/codex.mjs'

const provider = defineProvider({ env: process.env, process, nodeChild: { spawn() { } } })
const cwd = mkdtempSync(join(tmpdir(), 'clb-codex-live-'))
const evidence = []

function run(label, args) {
  const built = provider.buildArgv(['codex'], args, { planActive: false })
  const t0 = Date.now()
  const r = spawnSync(built.argv[0], built.argv.slice(1), {
    cwd, encoding: 'utf8', timeout: (built.timeoutSec + 60) * 1000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const outcome = { exitCode: r.status }
  const res = provider.buildResult(provider.parseJson(r.stdout), outcome, built.mode, r.stderr, r.stdout, null)
  evidence.push({
    label,
    argv: built.argv,
    elapsedMs: Date.now() - t0,
    exitCode: r.status,
    spawnError: r.error ? String(r.error.message) : null,
    status: res.status,
    ok: res.ok,
    sessionId: res.sessionId,
    totalTokens: res.totalTokens,
    response: String(res.response || '').slice(0, 120),
    stderrHead: String(r.stderr || '').split(/\r?\n/).slice(0, 3).join(' | '),
    stdoutHead: String(r.stdout || '').split(/\r?\n/).slice(0, 2).join(' | ')
  })
  return res
}

let failure = null
try {
  console.log('[live] cwd=' + cwd)
  const first = run('exec', { prompt: 'Reply exactly: PONG', timeoutSec: 300 })
  console.log('[live] exec → status=' + first.status + ' ok=' + first.ok + ' session=' + first.sessionId + ' response=' + JSON.stringify(first.response))
  if (!first.ok) throw new Error('exec failed: ' + first.status + ' / ' + String(first.stderr || '').slice(0, 300))
  if (!/PONG/.test(String(first.response))) throw new Error('exec response is not PONG: ' + JSON.stringify(first.response))
  if (!first.sessionId) throw new Error('exec produced no thread id (sessionId)')

  const second = run('resume', { prompt: 'Reply exactly: PONG2', sessionId: first.sessionId, timeoutSec: 300 })
  console.log('[live] resume → status=' + second.status + ' ok=' + second.ok + ' session=' + second.sessionId + ' response=' + JSON.stringify(second.response))
  if (!second.ok) throw new Error('resume failed: ' + second.status + ' / ' + String(second.stderr || '').slice(0, 300))
  if (!/PONG2/.test(String(second.response))) throw new Error('resume response is not PONG2: ' + JSON.stringify(second.response))
  if (second.sessionId !== first.sessionId) throw new Error('resume changed the thread id: ' + first.sessionId + ' → ' + second.sessionId)
} catch (e) {
  failure = e
} finally {
  console.log('\n=== evidence ===')
  console.log(JSON.stringify(evidence, null, 2))
  try { rmSync(cwd, { recursive: true, force: true }) } catch (e) { /* 清理尽力而为 */ }
}

if (failure) {
  console.error('\n[live] FAILED: ' + String(failure && failure.message || failure))
  process.exit(1)
}
console.log('\n[live] PASS — real codex exec + exec resume round-trip matches buildArgv/parseJson/buildResult')
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(0)
