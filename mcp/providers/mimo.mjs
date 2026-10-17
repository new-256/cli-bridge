// mcp/providers/mimo.mjs — mimo MCP 工具面（契约 §4；移植自旧 mimo-mcp-server.mjs 的
// runMimo/runDesktop/handleTool/TOOLS/renderResultText，framing/生命周期归 keystone
// 统一服务器 mcp/cli-bridge-mcp.mjs）。
//
// 旧语义保持：
//  - mimocode：直接 spawn mimo CLI（MIMO_BIN/MIMO_CLI > ~/.mimocode/bin/mimo[.exe] >
//    'mimo'；.mjs/.cjs/.js 目标经 process.execPath 包装，供测试 fixture 使用）。
//    实时折叠走 bridge-kit 行流 + engine.foldEvent（旧 foldStep 语义）。
//  - cwd 兜底 = env MIMO_MCP_CWD || MIMO_BRIDGE_CWD || process.cwd()（旧 CWD_FALLBACK；
//    旧仓曾硬编码机器绝对路径，新实现按 agy 定案改 process.cwd() 兜底）。
//  - 无 ctx.emit：状态走快照文件 {homeDir}/cli-bridge-mcp-mimo.json（keystone
//    indicator readMcpFile 只认 'cli-bridge-mcp-<id>.json' 模式，Lead 复核纠错定案）
//    （bridge-kit buildMcpBridgePayload + 原子写 tmp→rename；写失败静默，红线：绝不影响
//    工具结果）。旧 mcp-live.json 兼容读归 keystone，本面不写旧文件。
//  - 限流（isLimited）触发即落 fallbackResult（旧 handleTool verbatim：run 内部各退出
//    路径均已 engine.end，此处仅改返回值对象，绝不二次 engine.end —— 防 runs 虚标/计数下溢）。
//
// 2026-10 去 desktop 化：MiMo 免费 API 服务已被官方终止 + 本机 0 凭据 → 只走
// `mimo run`（MiMoCode CLI）。desktop 本地 HTTP 后端（BACKEND_DESKTOP / execute 分支 /
// preflight）全部移除；模型由用户在 CLI Bridge 设置里手动指定（defaultModel），
// 登录由用户在 CLI 侧 `mimo auth login` 自理。

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join as joinPath, resolve as resolvePath } from 'node:path'

import defineProvider, { resolveMimoExePrefix } from '../../providers/mimo.mjs'
import {
  createStatusEngine, createLineStream, buildMcpBridgePayload,
  fallbackResult, shortLabel, renderStatus
} from '../../core/bridge-kit.mjs'
import { packageVersion } from '../version.mjs'

export const meta = { id: 'mimo', label: 'MIMO', version: packageVersion() }

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

// ── exe / cwd 解析（与 descriptor resolveMimoExePrefix 单一真源同优先级）──────────
// MIMO_BIN/MIMO_CLI > 已知安装位置 ~/.mimocode/bin/mimo[.exe] > 'mimo'；
// .mjs/.cjs/.js 目标经 process.execPath 包装（供测试 fixture 使用）。
function exePrefix() {
  return resolveMimoExePrefix(process.env)
}
function resolveCwd(a) {
  if (a && a.cwd) return resolvePath(String(a.cwd))
  return process.env.MIMO_MCP_CWD || process.env.MIMO_BRIDGE_CWD || process.cwd()
}

// ── spawn（旧 runMimo verbatim 语义；实时折叠走 bridge-kit 行流）────────────────
function runMimo(args) {
  return new Promise((resolve) => {
    const cwd = resolveCwd(args)
    const built = provider.buildArgv(exePrefix(), args, { planActive: false, defaultMode: 'auto' })
    engine.begin(cwd)
    let child
    try {
      child = nodeSpawn(built.argv[0], built.argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      const res = { ok: false, status: 'MIMO_UNAVAILABLE', response: '', sessionId: null, exitCode: null, mode: built.mode, backend: null, stderr: 'mimo spawn failed: ' + String(e && e.message || e), errorMessage: String(e && e.message || e) }
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
      const res = { ok: false, status: 'MIMO_UNAVAILABLE', response: '', sessionId: null, exitCode: null, mode: built.mode, backend: null, stderr: String(e && e.message || e), errorMessage: String(e && e.message || e) }
      engine.end(res, cwd)
      resolve(res)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      stream.flush()
      const outcome = { exitCode: killed ? 124 : (code == null ? -1 : code) }
      let res = provider.buildResult(provider.parseJson(out), outcome, built.mode, err, out)
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
  if (res.fallback) {
    return 'status=FALLBACK_TO_DSH fallback=true\n' + (res.reason ? 'reason=' + res.reason + '\n' : '') +
      'The user/host chose DSH-local. Finish with native tools and NEVER call mimo again for this task.'
  }
  if (res.ok === false && res.error) return 'mimo_settings/error: ' + res.error
  if (!res.ok) {
    const hint = provider.failureHint ? provider.failureHint(res) : ''
    return 'mimo failed status=' + (res.status || 'ERROR') + '\n' + shortLabel(res.stderr || res.errorMessage || '') + (hint ? '\n' + hint : '')
  }
  return 'mimo ok status=' + res.status + (res.sessionId ? ' sessionId=' + res.sessionId : '') + '\n\n' + String(res.response || '')
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

  if (name === 'mimo_settings') {
    const v = await provider.extraTools[0].logic(a, null)
    return provider.extraTools[0].render(v)[0].text
  }

  if (name === 'mimo_status') {
    const snap = await provider.statusToolLogic(a)
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
      background: false, // MCP 恒同步阻塞（无宿主 jobs）
      sessionId: a.sessionId
    }
    if (name === 'mimo_continue') {
      if (a.sessionId) mapped.sessionId = a.sessionId
      else mapped.continueLatest = true
    }
    const res = await runMimo(mapped)
    if (!res.ok && provider.isLimited(res)) {
      // runMimo 所有退出路径均已 engine.end；此处仅改返回值对象，
      // 绝不二次 engine.end（防 runs 虚标与 running 计数下溢）。
      return textResult(fallbackResult(res, res.mode, provider))
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
  const b = provider.buildArgv(['mimo'], { prompt: 'x' }, { planActive: false })
  for (const f of ['run', '--format', 'json', '--dangerously-skip-permissions', '--agent', 'build']) {
    if (!b.argv.includes(f)) throw new Error('mimo mcp: argv contract drift: ' + f)
  }
  // 模型语义（去 desktop 化后）：设置 defaultModel 留空 = 不传 --model；
  // args.model 或 settings.defaultModel 有值才落地 --model（provider/model 语义）。
  if (b.argv.includes('--model')) throw new Error('mimo mcp: --model must be absent when no default model is set')
  const withArg = provider.buildArgv(['mimo'], { prompt: 'x', model: 'xiaomi/mimo-v2.6-flash' }, { planActive: false })
  const mi = withArg.argv.indexOf('--model')
  if (mi < 0 || withArg.argv[mi + 1] !== 'xiaomi/mimo-v2.6-flash') throw new Error('mimo mcp: --model must carry the provider/model argument')
  // 设置分区契约：defaultModel 单一键，默认空串（不写死模型）。
  const keys = provider.settings.keys
  if (keys.length !== 1 || keys[0] !== 'defaultModel') throw new Error('mimo mcp: settings.keys must be [defaultModel]')
  if (provider.settings.defaults().defaultModel !== '') throw new Error('mimo mcp: defaultModel default must be empty (mimo CLI self-decides)')
  if (provider.settings.normalize({ defaultModel: '  xiaomi/mimo-v2.6-pro  ', junk: 1 }).defaultModel !== 'xiaomi/mimo-v2.6-pro') {
    throw new Error('mimo mcp: settings.normalize must trim defaultModel and drop unknown keys')
  }
  // 单后端：无 backend 概念残留（旧 mimo-desktop 已取消）。
  if (provider.resolveBackend({ backend: 'mimo-desktop' }, null, null) != null) throw new Error('mimo mcp: backend must stay null after de-desktop-ification')
  return true
}
