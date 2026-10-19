// 真实端到端验证：claude 修复后能否跑通（修复前直连 opencode 端点必 400 MissingSessionID）。
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import defClaude from '../../providers/claude.mjs'

const CWD = tmpdir()
const p = defClaude({ env: process.env, process })

const built = p.buildArgv(['claude'], { prompt: 'Reply with exactly: PONG', cwd: CWD }, {})
console.log('argv: ' + JSON.stringify(built.argv))

const r = spawnSync(built.argv[0], built.argv.slice(1), {
  encoding: 'utf8', timeout: (built.timeoutSec || 300) * 1000, windowsHide: true, cwd: CWD
})
console.log('exit=' + r.status + (r.error ? ' err=' + r.error.code : ''))
const parsed = p.parseJson(String(r.stdout || ''))
const res = p.buildResult(parsed, { exitCode: r.status }, built.mode, String(r.stderr || ''), String(r.stdout || ''), null)
console.log('ok=' + res.ok + '  status=' + res.status + '  response=' + JSON.stringify(String(res.response || '').slice(0, 80)))
if (!res.ok) console.log('errorMessage=' + String(res.errorMessage || '').slice(0, 300))
process.exit(res.ok ? 0 : 1)
