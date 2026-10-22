// mcp/providers/codex.mjs — codex MCP 工具面（契约 §4）。
// framing/生命周期归 keystone 统一服务器 mcp/cli-bridge-mcp.mjs。
//
// 与 opencode/agy 面结构同构：直接 spawn codex（CODEX_BIN 覆盖；.js/.mjs 目标经
// process.execPath 包装，供测试夹具使用）。无 ctx.emit：状态走快照文件
// {homeDir}/cli-bridge-mcp-codex.json（bridge-kit buildMcpBridgePayload + 原子写 tmp→rename）。
//
// codex 面的两处特有事实（实测 codex-cli 0.98.0）：
//   • 续聊走 `codex exec resume <thread_id> <prompt>`，且 resume **不接受 -C/-s/-o/-add-dir**；
//     所以 cwd 只由 spawn 的 cwd 决定，argv 里的沙箱经 -c sandbox_mode 落地。
//   • 模型清单没有 CLI 子命令，只能走 HTTP /models（descriptor 的 codex_models 负责），
//     这里只做工具面转接，不复制解析逻辑。
import { spawn as nodeSpawn } from 'node:child_process'
import { resolveCwdWithSession } from '../session-cwd.mjs'
import { resolve as resolvePath } from 'node:path'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import defineProvider, { codexResolveExePrefix, codexExeCandidates } from '../../providers/codex.mjs'
import { codexShimRejectReason } from '../../providers/codex-cli.mjs'
import { createStatusEngine, createLineStream, buildMcpBridgePayload, isLimited, renderStatus } from '../../core/bridge-kit.mjs'
import { packageVersion } from '../version.mjs'

export const meta = { id: 'codex', label: 'CODEX', version: packageVersion() }

// ── 统一设置文件分区读（MCP 子进程无 ctx.get，只读 env/文件）───────────────────
// 与 opencode/mimo 面同规则：注入 descriptor 的 readSettings，使面板里指定的
// binPath/defaultModel/sandboxMode 在 MCP 形态同样生效（三形态行为一致）。
const SETTINGS_FILE_NAME = 'cli-bridge-settings.json'

function resolveSettingsFile(env) {
  try {
    if (env.CLI_BRIDGE_SETTINGS_FILE) return env.CLI_BRIDGE_SETTINGS_FILE
    if (env.DSH_HOME) return resolvePath(env.DSH_HOME, SETTINGS_FILE_NAME)
    if (process.platform === 'win32' && env.APPDATA) return resolvePath(env.APPDATA, 'DSH Desktop', 'dsh-home', SETTINGS_FILE_NAME)
    if (env.HOME) return resolvePath(env.HOME, '.dsh', SETTINGS_FILE_NAME)
  } catch (e) { /* 无 env 能力 */ }
  return null
}

function readPartition(env) {
  const p = resolveSettingsFile(env)
  if (!p) return { partition: null, path: null, home: null }
  try {
    const all = JSON.parse(readFileSync(p, 'utf8'))
    return { partition: (all && typeof all === 'object' && all.codex) ? all.codex : null, path: p, home: dirname(p) }
  } catch (e) {
    return { partition: null, path: p, home: dirname(p) }
  }
}

const provider = defineProvider({
  env: process.env,
  process,
  nodeChild: { spawn: nodeSpawn },
  readSettings: () => readPartition(process.env)
})

let lastIo = null
function publishSnapshot(snapshot) {
  const io = lastIo
  if (!io) return
  try {
    const target = io.path.join(io.homeDir, 'cli-bridge-mcp-codex.json')
    const payload = buildMcpBridgePayload(snapshot, process.pid, Date.now())
    const tmp = target + '.' + process.pid + '.tmp'
    try { io.fs.mkdirSync(io.path.dirname(target), { recursive: true }) } catch (e) { /* 目录已存在 */ }
    io.fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    io.fs.renameSync(tmp, target)
  } catch (e) { /* 灯数据尽力而为，绝不影响工具调用 */ }
}

// provider.engine 在 attach 后才存在；MCP 形态不 attach，用本模块的 engine。
const engine = createStatusEngine({ provider, publish: publishSnapshot })
provider.engine = engine

// ── exe / cwd 解析 ────────────────────────────────────────────────────────────
function exePrefix() {
  return codexResolveExePrefix(process.env, '')
}

    function resolveCwd(a) {
      if (a && a.cwd) return resolvePath(String(a.cwd))
      // 兜底链：用户 env 覆盖 → **会话真实目录** → process.cwd()。末两级很关键：
      // MCP server 由 DSH 以空 cwd 启动，process.cwd() 是 DSH 主进程目录而非用户项目，
      // 直接用会让 CLI 把整个项目判成「工作区外」（agy/claude/opencode/codex 都踩过）。
      const envCwd = process.env.CODEX_BRIDGE_CWD
      if (envCwd) return resolvePath(String(envCwd))
      return resolveCwdWithSession(null, '', resolvePath)
    }

function baseResult(over) {
  return Object.assign({
    ok: false, status: 'ERROR', response: '', sessionId: null, durationSeconds: null,
    numTurns: null, totalTokens: null, exitCode: null, mode: 'auto', backend: null, stderr: ''
  }, over)
}

// ── spawn（实时折叠走 bridge-kit 行流）────────────────────────────────────────
function runCodex(args) {
  return new Promise((resolve) => {
    const a = args || {}
    const built = provider.buildArgv(exePrefix(), a, { planActive: false, defaultMode: 'auto' })
    const cwd = resolveCwd(a)
    // .cmd/.bat shim：无 shell 的 spawn 解析不了它，走 shell 会二次解释 prompt。
    const shim = codexShimRejectReason(built.argv[0]) || codexShimRejectReason(built.argv[1])
    if (shim) {
      const res = baseResult({ status: 'CODEX_UNAVAILABLE', mode: built.mode, stderr: shim })
      engine.begin(cwd); engine.end(res, cwd)
      resolve(res)
      return
    }
    let child
    try {
      child = nodeSpawn(built.argv[0], built.argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      resolve(baseResult({ status: 'SPAWN_ERROR', mode: built.mode, stderr: String(e && e.message || e) }))
      return
    }
    engine.begin(cwd)
    let out = ''
    let err = ''
    let killed = false
    const timer = setTimeout(() => { killed = true; try { child.kill() } catch (e) { /* 已退出 */ } }, (built.timeoutSec + 60) * 1000)
    const stream = createLineStream((ln) => {
      const t = ln.trim()
      if (t.charAt(0) !== '{') return
      try { engine.foldEvent(JSON.parse(t), cwd) } catch (e) { /* 坏行跳过 */ }
    })
    child.stdout.on('data', (d) => {
      out += d
      if (out.length > 4000000) out = out.slice(-2000000)
      stream.pushChunk(String(d))
    })
    child.stderr.on('data', (d) => { err += d; if (err.length > 1000000) err = err.slice(-500000) })
    child.on('error', (e) => {
      clearTimeout(timer)
      stream.flush()
      const res = baseResult({ status: 'CODEX_UNAVAILABLE', mode: built.mode, stderr: 'codex spawn failed: ' + String(e && e.message || e) })
      engine.end(res, cwd)
      resolve(res)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      stream.flush()
      const outcome = { exitCode: killed ? 124 : code }
      let res = provider.buildResult(provider.parseJson(out), outcome, built.mode, err, out, null)
      if (killed && !res.ok) {
        res.status = 'HUNG_TIMEOUT'
        res.stderr = (res.stderr ? res.stderr + ' ' : '') + '[killed by DSH timeout guard after ' + built.timeoutSec + 's; if this was a long-running script (build/test) raise timeoutSec]'
      }
      engine.end(res, cwd)
      resolve(res)
    })
  })
}

function textResult(res) {
  if (res.fallback) {
    return 'codex unavailable (' + res.reason + '). Use native tools / the local model for this task; do not retry codex.'
  }
  const limited = !res.ok && isLimited(res)
  const head = 'codex ' + (res.ok ? 'OK' : 'FAILED') + ' [status=' + res.status +
    (res.sessionId ? ' session=' + res.sessionId : '') +
    (res.totalTokens != null ? ' tokens=' + res.totalTokens : '') + ']'
  const hint = typeof provider.failureHint === 'function' ? provider.failureHint(res) : ''
  let note = ''
  if (limited) note = '\n\n[Note: this looks like a rate-limit / network failure. Do NOT retry codex in a loop; finish the task with your own tools, or ask the user.]'
  const body = res.response || (res.stderr ? '[stderr] ' + res.stderr : (res.rawStdout ? '[raw] ' + res.rawStdout : ''))
  return head + (body ? '\n\n' + body : '') + (hint ? '\n\n' + hint : '') + note
}

// ── 工具面（与描述符同源：名字/schema 一律从 descriptor 取，禁止第二份定义）──────
function toolList(env) {
  const d = provider.tools
  const extra = provider.extraTools || []
  return [d.run, d.continue, d.status].concat(extra.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })))
    .map((t) => Object.assign({}, t))
}

export function tools(env) {
  return toolList(env)
}

export async function call(name, args, io) {
  if (io) lastIo = io
  if (!lastIo) return 'codex error: MCP io not initialized'
  const a = args || {}
  const d = provider.tools
  if (name === d.status.name) {
    const snap = provider.statusToolLogic(a)
    if (a.cwd) {
      // statusToolLogic 已经按 cwd 过滤并升格顶层字段，这里直接渲染。
    }
    return renderStatus(snap, provider)[0].text
  }
  if (name === (provider.extraTools[0] && provider.extraTools[0].name)) {
    const res = await provider.extraTools[0].logic(a)
    const rendered = provider.extraTools[0].render(a, res)
    return rendered[0].text
  }
  if (!a.prompt || !String(a.prompt).trim()) return 'codex error: prompt is required'
  const mapped = Object.assign({}, a)
  if (name === d.continue.name) {
    // continue 的会话语义：sessionId 优先，否则 latest → exec resume --last。
    if (!mapped.sessionId && mapped.latest) mapped.continueLatest = true
  }
  const res = await runCodex(mapped)
  return textResult(res)
}

export function check(env) {
  const ts = tools(env)
  const names = ts.map((t) => t.name)
  for (const t of ts) {
    if (!t.name || !t.description || !t.inputSchema || t.inputSchema.type !== 'object') throw new Error('codex mcp: bad tool def ' + JSON.stringify(t && t.name))
  }
  // MCP 面必须覆盖 descriptor 三件套（名字一致，提示词连续性红线）。
  for (const k of ['run', 'continue', 'status']) {
    if (!names.includes(provider.tools[k].name)) throw new Error('codex mcp: tools surface missing descriptor name ' + provider.tools[k].name)
  }
  // argv 契约漂移锁（实测 codex-cli 0.98.0 的旗集）。
  const b = provider.buildArgv(['codex'], { prompt: 'x' }, { planActive: false })
  for (const f of ['exec', '--json', '--skip-git-repo-check']) {
    if (b.argv.indexOf(f) < 0) throw new Error('codex mcp: argv contract drift: ' + f)
  }
  // ⚠️ codex exec 没有 -a；出现即参数错误（实测 clap: unexpected argument '-a'）。
  if (b.argv.indexOf('-a') >= 0 || b.argv.indexOf('--ask-for-approval') >= 0) throw new Error('codex mcp: codex exec rejects -a/--ask-for-approval; use -c approval_policy')
  // resume 子命令不接受 -C/-s/-L：argv 必须改成 -c sandbox_mode。
  const r = provider.buildArgv(['codex'], { prompt: 'x', sessionId: 'sid-1' }, { planActive: false })
  for (const f of ['resume', 'sid-1', '--json']) {
    if (r.argv.indexOf(f) < 0) throw new Error('codex mcp: resume argv contract drift: ' + f)
  }
  for (const f of ['-C', '-s', '--add-dir']) {
    if (r.argv.indexOf(f) >= 0) throw new Error('codex mcp: resume must not emit ' + f + ' (codex exec resume rejects it)')
  }
  if (r.argv.indexOf('-c') < 0 || String(r.argv[r.argv.indexOf('-c') + 1] || '').indexOf('sandbox_mode=') < 0) {
    throw new Error('codex mcp: resume must set the sandbox through -c sandbox_mode')
  }
  // 模型清单在 MCP 面必须点名真实端点而非本地目录（红线：不把本地目录冒充实时）。
  const mt = ts.find((t) => /_models$/.test(t.name))
  if (!mt) throw new Error('codex mcp: missing codex_models tool')
  if (!/live/.test(String(mt.description))) throw new Error('codex mcp: codex_models must document the live source')
  return true
}
