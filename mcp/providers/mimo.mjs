// mcp/providers/mimo.mjs — mimo MCP 工具面（契约 §4；移植自旧 mimo-mcp-server.mjs 的
// runMimo/runDesktop/handleTool/TOOLS/renderResultText，framing/生命周期归 keystone
// 统一服务器 mcp/cli-bridge-mcp.mjs）。
//
// 旧语义保持：
//  - mimocode：直接 spawn mimo CLI（MIMO_BIN/MIMO_CLI > ~/.mimocode/bin/mimo[.exe] >
//    'mimo'；.mjs/.cjs/.js 目标经 process.execPath 包装，供测试 fixture 使用）。
//    实时折叠走 bridge-kit 行流 + engine.foldEvent（旧 foldStep 语义）。
//  - mimo-desktop：委托 provider.execute（provider.delegates('mimo-desktop')=true）；
//    非 spawn 走本地 HTTP。begin/end 由本模块做（MCP 无 kit runner）。
//  - cwd 兜底 = env MIMO_MCP_CWD || MIMO_BRIDGE_CWD || process.cwd()（旧 CWD_FALLBACK；
//    旧仓曾硬编码机器绝对路径，新实现按 agy 定案改 process.cwd() 兜底）。
//  - 无 ctx.emit：状态走快照文件 {homeDir}/cli-bridge-mcp-mimo.json（keystone
//    indicator readMcpFile 只认 'cli-bridge-mcp-<id>.json' 模式，Lead 复核纠错定案）
//    （bridge-kit buildMcpBridgePayload + 原子写 tmp→rename；写失败静默，红线：绝不影响
//    工具结果）。旧 mcp-live.json 兼容读归 keystone，本面不写旧文件。
//  - 限流（isLimited）触发即落 fallbackResult（旧 handleTool verbatim：run 内部各退出
//    路径均已 engine.end，此处仅改返回值对象，绝不二次 engine.end —— 防 runs 虚标/计数下溢）。

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join as joinPath, resolve as resolvePath } from 'node:path'

import defineProvider from '../../providers/mimo.mjs'
import {
  createStatusEngine, createLineStream, buildMcpBridgePayload,
  fallbackResult, shortLabel, renderStatus
} from '../../core/bridge-kit.mjs'

export const meta = { id: 'mimo', label: 'MIMO', version: '0.2.1' }

const BACKEND_DESKTOP = 'mimo-desktop'
const SETTINGS_FILE_NAME = 'cli-bridge-settings.json'

// 统一设置文件分区读（与 preset 同规则；MCP 子进程无 ctx.get，只读 env/文件）。
function resolveSettingsFile(env) {
  try {
    if (env.CLI_BRIDGE_SETTINGS_FILE) return env.CLI_BRIDGE_SETTINGS_FILE
    if (env.DSH_HOME) return joinPath(env.DSH_HOME, SETTINGS_FILE_NAME)
    if (process.platform === 'win32' && env.APPDATA) return joinPath(env.APPDATA, 'DSH Desktop', 'dsh-home', SETTINGS_FILE_NAME)
    if (env.HOME) return joinPath(env.HOME, '.dsh', SETTINGS_FILE_NAME)
  } catch (e) { }
  return null
}
function readPartition(env) {
  const p = resolveSettingsFile(env)
  if (!p) return { partition: null, path: null, home: null }
  try {
    const all = JSON.parse(readFileSync(p, 'utf8'))
    return { partition: (all && typeof all === 'object' && all.mimo) ? all.mimo : null, path: p, home: dirname(p) }
  } catch (e) {
    return { partition: null, path: p, home: dirname(p) }
  }
}

const provider = defineProvider({
  env: process.env,
  process,
  nodeFs: { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync },
  nodeChild: { spawn: nodeSpawn },
  nodePath: { join: joinPath, dirname },
  readSettings: () => readPartition(process.env)
})

let lastIo = null
function publishSnapshot(snapshot) {
  const io = lastIo
  if (!io) return
  try {
    // 文件名必须 'cli-bridge-mcp-<id>.json'：keystone indicator 的 readMcpFile 按此模式
    // 枚举（agy 面同款）；写成别的名字 MCP 形态活动永远进不了状态灯（Lead 复核纠错）。
    const target = io.path.join(io.homeDir, 'cli-bridge-mcp-mimo.json')
    const payload = buildMcpBridgePayload(snapshot, process.pid, Date.now())
    const tmp = target + '.' + process.pid + '.tmp'
    try { io.fs.mkdirSync(io.path.dirname(target), { recursive: true }) } catch (e) { }
    io.fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    io.fs.renameSync(tmp, target)
  } catch (e) { /* 灯数据尽力而为，绝不影响工具调用 */ }
}
// MCP 形态不 attach（无 ctx.subprocess），用本模块自持 engine。
const engine = createStatusEngine({ provider, publish: publishSnapshot })
provider.engine = engine

// ── exe / cwd 解析（旧 resolveMimoExe + CWD_FALLBACK verbatim 语义）──────────────
function exePrefix() {
  const env = process.env
  const candidates = []
  if (env.MIMO_BIN) candidates.push(env.MIMO_BIN)
  if (env.MIMO_CLI) candidates.push(env.MIMO_CLI)
  if (env.USERPROFILE) candidates.push(env.USERPROFILE + '\\.mimocode\\bin\\mimo.exe')
  if (env.HOME) {
    candidates.push(env.HOME + '\\.mimocode\\bin\\mimo.exe')
    candidates.push(env.HOME + '/.mimocode/bin/mimo')
  }
  for (const exe of candidates) {
    try { if (exe && existsSync(exe)) return /\.(mjs|cjs|js)$/i.test(exe) ? [process.execPath, exe] : [exe] } catch (e) { }
  }
  const bin = env.MIMO_BIN || env.MIMO_CLI || ''
  if (bin) return /\.(mjs|cjs|js)$/i.test(bin) ? [process.execPath, bin] : [bin]
  return ['mimo']
}
function resolveCwd(a) {
  if (a && a.cwd) return resolvePath(String(a.cwd))
  return process.env.MIMO_MCP_CWD || process.env.MIMO_BRIDGE_CWD || process.cwd()
}
function preferredBackendFromEnv() {
  const env = process.env
  return env.MIMO_BRIDGE_BACKEND || env.MIMO_BACKEND || (readPartition(env).partition || {}).preferredBackend || null
}

// ── spawn（旧 runMimo verbatim 语义；实时折叠走 bridge-kit 行流）────────────────
function runMimo(args) {
  return new Promise((resolve) => {
    const cwd = resolveCwd(args)
    const built = provider.buildArgv(exePrefix(), args, { planActive: false, defaultMode: 'auto', backend: 'mimocode' })
    engine.begin(cwd)
    let child
    try {
      child = nodeSpawn(built.argv[0], built.argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      const res = { ok: false, status: 'MIMO_UNAVAILABLE', response: '', sessionId: null, exitCode: null, mode: built.mode, backend: 'mimocode', stderr: 'mimo spawn failed: ' + String(e && e.message || e), errorMessage: String(e && e.message || e) }
      engine.end(res, cwd)
      resolve(res)
      return
    }
    let out = ''
    let err = ''
    let killed = false
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGTERM') } catch (e) { } }, (built.timeoutSec + 60) * 1000)
    const stream = createLineStream((ln) => {
      const t = ln.trim()
      if (!t.startsWith('{')) return
      try { engine.foldEvent(JSON.parse(t), cwd) } catch (e) { }
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
      const res = { ok: false, status: 'MIMO_UNAVAILABLE', response: '', sessionId: null, exitCode: null, mode: built.mode, backend: 'mimocode', stderr: String(e && e.message || e), errorMessage: String(e && e.message || e) }
      engine.end(res, cwd)
      resolve(res)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      stream.flush()
      const outcome = { exitCode: killed ? 124 : (code == null ? -1 : code) }
      let res = provider.buildResult(provider.parseJson(out), outcome, built.mode, err, out, 'mimocode')
      if (killed && !res.ok) {
        res.status = 'HUNG_TIMEOUT'
        res.stderr = (res.stderr ? res.stderr + ' ' : '') + '[killed by DSH timeout guard after ' + built.timeoutSec + 's; if this was a long-running script (build/test) raise timeoutSec]'
      }
      engine.end(res, cwd)
      resolve(res)
    })
  })
}

// ── 文本渲染（旧 renderResultText verbatim；契约 §4：错误也是文本）───────────────
function textResult(res) {
  if (!res) return '(no result)'
  const b = res.backend ? ' backend=' + res.backend : ''
  if (res.fallback) {
    return 'status=FALLBACK_TO_DSH fallback=true' + b + '\n' + (res.reason ? 'reason=' + res.reason + '\n' : '') +
      'The user/host chose DSH-local. Finish with native tools and NEVER call mimo again for this task.'
  }
  if (res.ok === false && res.error) return 'mimo_settings/error' + b + ': ' + res.error
  if (!res.ok) {
    const hint = provider.failureHint ? provider.failureHint(res) : ''
    return 'mimo failed status=' + (res.status || 'ERROR') + b + '\n' + shortLabel(res.stderr || res.errorMessage || '') + (hint ? '\n' + hint : '')
  }
  return 'mimo ok status=' + res.status + b + (res.sessionId ? ' sessionId=' + res.sessionId : '') + '\n\n' + String(res.response || '')
}

// ── 工具面（旧 MCP TOOLS verbatim：含 sessionId 关键注释与 mimo_settings）────────
// 直接复用描述符的 schema/description（三形态单一真源）；MCP 面去掉 background 参数
// （stdio 调用恒为同步阻塞，无宿主 jobs 服务）—— 旧 MCP 的 run/continue 本就无 background。
function stripBackground(schema) {
  const copy = JSON.parse(JSON.stringify(schema))
  if (copy.properties) delete copy.properties.background
  return copy
}

export function tools(env) {
  const run = { name: provider.tools.run.name, description: provider.tools.run.description, inputSchema: stripBackground(provider.tools.run.inputSchema) }
  const cont = { name: provider.tools.continue.name, description: provider.tools.continue.description, inputSchema: stripBackground(provider.tools.continue.inputSchema) }
  const status = { name: provider.tools.status.name, description: provider.tools.status.description, inputSchema: provider.tools.status.inputSchema }
  const settings = provider.extraTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))[0]
  return [run, cont, status, settings]
}

export async function call(name, args, io) {
  if (io) lastIo = io
  const a = args || {}
  const runtimeBackend = provider.resolveBackend(a, null, preferredBackendFromEnv())

  if (name === 'mimo_settings') {
    const v = await provider.extraTools[0].logic(a, null)
    return provider.extraTools[0].render(v)[0].text
  }

  if (name === 'mimo_status') {
    const snap = await provider.statusToolLogic(a)
    snap.defaultBackend = runtimeBackend
    snap.backend = runtimeBackend
    return renderStatus(snap, provider)[0].text
  }

  if (name === 'mimo_run' || name === 'mimo_continue') {
    if (!a.prompt || !String(a.prompt).trim()) return 'mimo error: prompt is required'
    const mapped = {
      prompt: a.prompt,
      mode: a.mode,
      model: a.model,
      effort: a.effort,
      cwd: a.cwd,
      timeoutSec: a.timeoutSec,
      title: a.title,
      backend: a.backend,
      background: false, // MCP 恒同步阻塞（无宿主 jobs）
      // 【关键】desktop 后端的 sessionId 必须转发。旧 handleTool 此处曾是白名单转发，
      // 漏了 sessionId（只在 mimo_continue 分支补）→ mimo_run 传 sessionId 被静默丢弃
      // → 永远 newDesktopSessionId 造新 id → 因 Desktop API 不能创建会话，mimo_run 在
      // desktop 后端下完全不可用。
      sessionId: a.sessionId
    }
    if (name === 'mimo_continue') {
      if (a.sessionId) mapped.sessionId = a.sessionId
      else mapped.continueLatest = true
    }
    const backend = provider.resolveBackend(mapped, null, preferredBackendFromEnv())
    let res
    if (backend === BACKEND_DESKTOP) {
      const pf = provider.preflight({ backend })
      if (pf && pf.abort) {
        res = pf.abort
        engine.begin(resolveCwd(mapped))
        engine.end(res, resolveCwd(mapped))
      } else {
        const cwd = resolveCwd(mapped)
        const built = provider.buildArgv(exePrefix(), mapped, { planActive: false, defaultMode: 'auto', backend })
        engine.begin(cwd)
        res = await provider.execute({ args: mapped, cwd, built, backend })
        engine.end(res, cwd)
      }
    } else {
      res = await runMimo(mapped)
    }
    if (!res.ok && provider.isLimited(res)) {
      // runMimo / desktop 分支所有退出路径均已 engine.end；此处仅改返回值对象，
      // 绝不二次 engine.end（防 runs 虚标与 running 计数下溢）。
      res = fallbackResult(res, res.mode, provider)
      res.backend = backend
    }
    return textResult(res)
  }

  return 'mimo error: unknown tool: ' + name
}

// ── 自检（keystone --check 调用；argv 契约防漂移）───────────────────────────────
export function check(env) {
  const ts = tools(env || process.env)
  const names = ts.map((t) => t.name)
  for (const req of ['mimo_run', 'mimo_continue', 'mimo_status', 'mimo_settings']) {
    if (!names.includes(req)) throw new Error('mimo mcp: missing tool ' + req)
  }
  for (const t of ts) {
    if (!t.name || !t.description || !t.inputSchema || t.inputSchema.type !== 'object') throw new Error('mimo mcp: bad tool def ' + JSON.stringify(t && t.name))
  }
  // MCP 面必须覆盖描述符三件套 + settings（名字一致，提示词连续性红线）。
  for (const k of ['run', 'continue', 'status']) {
    if (!names.includes(provider.tools[k].name)) throw new Error('mimo mcp: tools surface missing descriptor name ' + provider.tools[k].name)
  }
  // mimocode argv 契约（旧 core verbatim）。
  const b = provider.buildArgv(['mimo'], { prompt: 'x' }, { planActive: false, backend: 'mimocode' })
  for (const f of ['run', '--format', 'json', '--dangerously-skip-permissions', '--agent', 'build']) {
    if (!b.argv.includes(f)) throw new Error('mimo mcp: argv contract drift: ' + f)
  }
  // mimo-desktop 空壳（非 spawn 路径，交 execute）。
  const d = provider.buildArgv(['mimo'], { prompt: 'x' }, { planActive: false, backend: BACKEND_DESKTOP })
  if (d.argv.length !== 0) throw new Error('mimo mcp: desktop buildArgv must be empty shell')
  // delegates 规则：只有 desktop 委托。
  if (provider.delegates(BACKEND_DESKTOP) !== true || provider.delegates('mimocode') !== false) throw new Error('mimo mcp: delegates contract drift')
  return true
}
