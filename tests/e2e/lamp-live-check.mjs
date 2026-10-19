// tests/e2e/lamp-live-check.mjs — 验证「状态灯」的数据链路真的会亮。
//
// 背景：CLI 连通测试是**裸跑 CLI**（直接 spawnSync），完全绕过 DSH 宿主的上报链，
// 所以状态灯不会亮 —— 那是测试方式的必然结果，不是桥接坏了。
// 本脚本改用 preset 形态 + 模拟宿主 ctx，真实执行一次任务，并捕获 <id>/status 事件，
// 证明「任务开始 → running、任务结束 → idle」这条链是通的。
//
// 用法：node tests/e2e/lamp-live-check.mjs [provider]   默认 claude
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const id = process.argv[2] || 'claude'
const WORK = mkdtempSync(join(tmpdir(), 'clb-lamp-'))
const presetDir = { agy: 'agy-first', claude: 'claude-first', codex: 'codex-first', opencode: 'opencode-first' }[id]
if (!presetDir) { console.log('未知 provider: ' + id); process.exit(1) }

const mod = await import('file:///' + join(ROOT, 'preset', presetDir, 'cli-bridge.mjs').replace(/\\/g, '/'))

// 模拟宿主：subprocess 换成真实子进程；emit 全部捕获
function mkHostCtx() {
  const events = []
  const registered = []
  const ctx = {
    session: { id: 'sess-lamp-' + id },
    get(name) {
      if (name === 'cliBridgeSettings') return {}
      return null
    },
    emit(ch, payload) { events.push({ ch, payload, at: Date.now() }) },
    effect(fn) { try { fn() } catch (e) { } return () => { } },
    setInterval() { return () => { } },
    interval() { return () => { } },
    timeout() { return () => { } },
    subprocess: {
      resolveExecutable: async (n) => n,
      spawn(spec) {

        // 宿主 subprocess.spawn 的入参形态实测是 { argv: [cmd, ...args], cwd, stdio }
        const argv = spec.argv || (spec.command ? [spec.command].concat(spec.args || []) : [])
        const cmd = argv[0]
        const args = argv.slice(1)
        // ⚠️ 必须遵守宿主的 stdio.stdin 约定（实测 spec.stdio.stdin === 'ignore'）。
        // 踩过的坑：桩里不管 stdio，stdin 就是个一直开着的 pipe —— claude 检测到有输入源
        // 会一直等 stdin，直到被打超时杀死，拿回 exitCode=null，于是**答对了也被判 CLI_ERROR**
        // （对照实验：stdin=ignore → exit 0/SUCCESS；stdin=pipe 不关 → exit null/CLI_ERROR）。
        const stdinMode = (spec.stdio && spec.stdio.stdin) || 'ignore'
        const child = spawn(cmd, args, {
          cwd: spec.cwd,
          env: spec.env || process.env,
          windowsHide: true,
          stdio: [stdinMode === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe']
        })
        let out = ''
        let err = ''
        const hardKill = setTimeout(() => { try { child.kill() } catch (e) { } }, 160000)
        child.stdout.on('data', (c) => { out += c })
        child.stderr.on('data', (c) => { err += c })
        const done = new Promise((resolve) => {
          child.on('close', (code) => { clearTimeout(hardKill); globalThis.__lastErr = err; resolve({ exitCode: code == null ? 1 : code }) })
          child.on('error', () => resolve({ exitCode: 1 }))
        })
        return {
          done,
          collected: {
            stdout: { readFrom: () => ({ text: out }) },
            stderr: { readFrom: () => ({ text: err }) }
          },
          terminate() { try { child.kill() } catch (e) { } }
        }
      }
    },
    tools: { register: (t) => { registered.push(t); return () => { } } },
    systemPrompt: { section: () => () => { } }
  }
  return { ctx, events, registered }
}

const host = mkHostCtx()
mod.apply(host.ctx)
const runTool = host.registered.find((t) => t.name === id + '_run')
if (!runTool) { console.log('未注册 ' + id + '_run'); process.exit(1) }

console.log('执行一次真实任务（' + id + '），观察 ' + id + '/status 事件…\n')
const res = await runTool.execute({ prompt: 'Reply with exactly: LAMP', timeoutSec: 150, background: false, cwd: WORK }, {})

const statusEvents = host.events.filter((e) => String(e.ch).endsWith('/status'))
console.log('捕获到 ' + statusEvents.length + ' 个状态事件：')
for (const e of statusEvents) {
  const snap = e.payload && e.payload.snapshot ? e.payload.snapshot : e.payload
  const parts = []
  if (snap && snap.state) parts.push('state=' + snap.state)
  if (snap && snap.project) parts.push('project=' + String(snap.project).slice(-24))
  if (snap && Array.isArray(snap.projects)) parts.push('projects=' + snap.projects.length)
  console.log('  ' + e.ch + '  ' + (parts.join(' ') || JSON.stringify(snap).slice(0, 110)))
}

const states = statusEvents.map((e) => {
  const s = e.payload && e.payload.snapshot ? e.payload.snapshot : e.payload
  return s && s.state ? String(s.state) : ''
})
const sawRunning = states.some((s) => /running|busy|active/i.test(s))
// 任务结束态实测是 ok / failed / idle（不是只有 idle），这里接受全部成熟态。
const sawSettled = states.some((s) => /^(ok|idle|failed|done|finished)$/i.test(s))

console.log('')
console.log('任务结果: ok=' + res.ok + ' status=' + res.status + ' response=' + JSON.stringify(String(res.response || '').slice(0, 40)))
console.log('  exitCode=' + (res.exitCode === undefined ? '(undef)' : res.exitCode) + ' errorMessage=' + JSON.stringify(String(res.errorMessage || '').slice(0, 200)))
console.log('  stderr片段=' + JSON.stringify(String(globalThis.__lastErr || '').slice(0, 300)))
console.log('灯链路: running=' + sawRunning + ' / 结束态=' + sawSettled)
const pass = !!res.ok && sawRunning && sawSettled
console.log(pass ? '\n✅ 状态上报链路通（灯会亮）' : '\n❌ 没有捕获到状态事件 —— 灯不会亮')
process.exit(pass ? 0 : 1)
