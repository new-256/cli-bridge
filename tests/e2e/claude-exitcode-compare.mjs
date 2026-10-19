// 对照实验：同一组 argv，在不同 spawn 方式下 exit code 是否不同。
// 目的：判定 lamp-live-check 里的 CLI_ERROR 是「我的桩问题」还是「真实行为」。
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import defClaude from '../../providers/claude.mjs'

const WORK = mkdtempSync(join(tmpdir(), 'clb-cmp-'))
const p = defClaude({ env: process.env, process })
const built = p.buildArgv(['claude'], { prompt: 'Reply with exactly: LAMP', cwd: WORK }, { probeProxy: () => ({ alive: true, detail: 'A' }) })
console.log('argv: ' + JSON.stringify(built.argv))
console.log('cwd : ' + WORK)

function summarize(label, code, stdout, stderr) {
  const parsed = p.parseJson(String(stdout || ''))
  const res = p.buildResult(parsed, { exitCode: code }, built.mode, String(stderr || ''), String(stdout || ''), null)
  console.log('\n[' + label + ']')
  console.log('  exit=' + code + '  ok=' + res.ok + '  status=' + res.status + '  response=' + JSON.stringify(String(res.response || '').slice(0, 40)))
  const lines = String(stdout || '').split(/\r?\n/).filter(Boolean)
  const last = lines[lines.length - 1] || ''
  console.log('  result 事件 is_error=' + (() => { try { return JSON.parse(last).is_error } catch (e) { return '(parse fail)' } })())
  console.log('  stdout 行数=' + lines.length)
}

// A: spawnSync，stdio 默认（pipe，父进程立刻读完）
const a = spawnSync(built.argv[0], built.argv.slice(1), { encoding: 'utf8', timeout: 180000, windowsHide: true, cwd: WORK })
summarize('A spawnSync 默认', a.status, a.stdout, a.stderr)

// B: spawn + stdin ignore（模拟宿主 stdio.stdin='ignore'）
await new Promise((resolve) => {
  const c = spawn(built.argv[0], built.argv.slice(1), { cwd: WORK, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  let o = ''
  let e = ''
  c.stdout.on('data', (d) => { o += d })
  c.stderr.on('data', (d) => { e += d })
  c.on('close', (code) => { summarize('B spawn stdin=ignore', code, o, e); resolve() })
})

// C: spawn + stdin pipe 但从不关闭（模拟"没实现 stdio.stdin"的桩）
await new Promise((resolve) => {
  const c = spawn(built.argv[0], built.argv.slice(1), { cwd: WORK, windowsHide: true, env: process.env })
  let o = ''
  let e = ''
  c.stdout.on('data', (d) => { o += d })
  c.stderr.on('data', (d) => { e += d })
  const t = setTimeout(() => { try { c.kill() } catch (x) { } }, 120000)
  c.on('close', (code) => { clearTimeout(t); summarize('C spawn stdin=pipe(不关)', code, o, e); resolve() })
})
