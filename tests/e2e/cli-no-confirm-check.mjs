// 核对四家 CLI 在"非交互调用"下是否都不需要用户点确认。
// 判定依据 = buildArgv 里是否带了免批准/免确认的旗（各家旗不同）。
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

const CASES = {
  agy: ['--dangerously-skip-permissions', '--mode accept-edits'],
  claude: ['--dangerously-skip-permissions'],
  codex: ['approval_policy="never"'],
  opencode: ['--auto']
}

const rows = []
for (const id of Object.keys(CASES)) {
  const mod = await import('file:///' + join(ROOT, 'providers', id + '.mjs').replace(/\\/g, '/'))
  const d = mod.default({ env: process.env, process })
  const argv = d.buildArgv([d.exeName || id], { prompt: 'x' }, { planActive: false, probeProxy: () => ({ alive: false, detail: 't' }) }).argv
  const flat = argv.join(' ')
  const missing = CASES[id].filter((needle) => !flat.includes(needle))
  rows.push({ id, ok: missing.length === 0, missing, argv: flat })
}

console.log('=== 非交互（无人可点确认）下的免批准核对 ===')
for (const r of rows) {
  console.log('  ' + r.id.padEnd(9) + (r.ok ? ' 免确认=YES' : ' 免确认=NO  缺: ' + r.missing.join(' + ')))
  console.log('      ' + r.argv.slice(0, 150))
}
const bad = rows.filter((r) => !r.ok)
console.log('\n' + (bad.length ? '有缺失: ' + bad.map((r) => r.id).join(', ') : '四家全部无需用户确认'))
process.exit(bad.length ? 1 : 0)
