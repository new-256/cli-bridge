// Lead 端到端验收：用 provider 的 buildArgv 真实调用 claude / codex，
// 再用 parseJson + buildResult 判定，验证「描述符 → 真 CLI → 结果对象」整链路。
// 不进 node --test（会真花钱/真联网），属手动验收脚本。
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import defClaude from '../../providers/claude.mjs'
import defCodex from '../../providers/codex.mjs'

const CWD = tmpdir()
const PROMPT = 'Reply with exactly: PONG'

function run(label, provider, exePrefix, args, opts) {
  console.log('\n=== ' + label + ' ===')
  const built = provider.buildArgv(exePrefix, args, Object.assign({ defaultMode: 'auto' }, opts))
  console.log('  argv: ' + JSON.stringify(built.argv.slice(0, 10)))
  const r = spawnSync(built.argv[0], built.argv.slice(1), {
    encoding: 'utf8', timeout: (built.timeoutSec || 300) * 1000, windowsHide: true,
    cwd: CWD, env: Object.assign({}, process.env, built.env || {})
  })
  console.log('  exit=' + r.status + (r.error ? ' err=' + r.error.code : ''))
  const parsed = provider.parseJson(String(r.stdout || ''))
  const res = provider.buildResult(parsed, { exitCode: r.status }, built.mode, String(r.stderr || ''), String(r.stdout || ''), provider.defaultBackend)
  console.log('  ok=' + res.ok + '  status=' + res.status + '  sessionId=' + (res.sessionId ? res.sessionId.slice(0, 12) + '…' : 'null'))
  console.log('  response=' + JSON.stringify(String(res.response || '').slice(0, 60)))
  if (!res.ok) console.log('  errorMessage=' + String(res.errorMessage || '').slice(0, 200))
  return res
}

const claude = defClaude({ env: process.env, process })
run('claude / run', claude, ['claude'], { prompt: PROMPT, cwd: CWD }, { backend: null, settings: {} })

const codex = defCodex({ env: process.env, process })
run('codex / run', codex, ['codex'], { prompt: PROMPT, cwd: CWD }, { backend: null, settings: {} })

// 模型清单工具（两条都在此验证：一条实时、一条兜底语义）
console.log('\n=== claude_models ===')
const cm = (claude.extraTools || []).find((t) => t.name === 'claude_models')
if (cm) {
  const v = await cm.logic({})
  console.log('  ok=' + v.ok + ' source=' + v.source + ' count=' + ((v.models || []).length))
  console.log('  ids=' + (v.models || []).map((m) => m.id || m).slice(0, 8).join(', '))
  if (!v.ok) console.log('  error=' + String(v.error || '').slice(0, 220))
}

console.log('\n=== codex_models ===')
const xm = (codex.extraTools || []).find((t) => t.name === 'codex_models')
if (xm) {
  const v = await xm.logic({})
  console.log('  ok=' + v.ok + ' source=' + v.source + ' count=' + ((v.models || []).length))
  console.log('  ids=' + (v.models || []).map((m) => m.id || m).slice(0, 8).join(', '))
  if (!v.ok) console.log('  error=' + String(v.error || '').slice(0, 220))
}
