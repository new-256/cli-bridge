// preset/mimo-first/cli-bridge.mjs — cordis-mimo preset 的桥接插件（preset 宿主形态）。
//
// PROVIDER-CONTRACT.md §5：本模块只做「宿主接线」——构造描述符、attach、注册三工具
// （+mimo_settings）、心跳/事件发布、mimo:policy 提示词段。全部执行/状态语义在
// providers/mimo.mjs + core/bridge-kit.mjs。
//
// 移植基线：mimo-first-bridge v1.x preset/mimo-first/mimo-first-bridge.mjs 的 apply()。
// preset id 'cordis-mimo' 由 plugin-list.mjs 单源声明（旧会话头引用，不可变）。
//
// 本模块是宿主进程内真 ESM：可 import node: 内建与包内相对路径；禁止 import
// @deepseek-ai/*（解析根够不到 harness 包，历史论证 —— 契约 §8）。
import fs from 'node:fs'
import path from 'node:path'

import defineProvider from '../../providers/mimo.mjs'
import { renderResult, renderStatus } from '../../core/bridge-kit.mjs'

export const name = 'cli-bridge-mimo'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'timer']

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }
const SETTINGS_FILE_NAME = 'cli-bridge-settings.json'
const BACKEND_DESKTOP = 'mimo-desktop'

// 统一设置文件路径解析（与 home-plugin/lib/settings.mjs 同规则，本模块不 import keystone，
// 只复刻只读逻辑）：CLI_BRIDGE_SETTINGS_FILE > DSH_HOME/<file>。解析不到 → null（回退默认）。
function resolveSettingsFile(env) {
  try {
    if (env.CLI_BRIDGE_SETTINGS_FILE) return env.CLI_BRIDGE_SETTINGS_FILE
    if (env.DSH_HOME) return path.join(env.DSH_HOME, SETTINGS_FILE_NAME)
  } catch (e) { }
  return null
}
function readPartition(env) {
  const p = resolveSettingsFile(env)
  if (!p) return { partition: null, path: null, home: null }
  try {
    const all = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { partition: (all && typeof all === 'object' && all.mimo) ? all.mimo : null, path: p, home: path.dirname(p) }
  } catch (e) {
    return { partition: null, path: p, home: path.dirname(p) }
  }
}

// 旧 resolveMimoExe 候选链 verbatim（MIMO_BIN > MIMO_CLI > ~/.mimocode/bin/mimo[.exe]）。
function mimoExeFromEnvCandidates(env) {
  const candidates = []
  if (env.MIMO_BIN) candidates.push(env.MIMO_BIN)
  if (env.MIMO_CLI) candidates.push(env.MIMO_CLI)
  if (env.USERPROFILE) candidates.push(env.USERPROFILE + '\\.mimocode\\bin\\mimo.exe')
  if (env.HOME) {
    candidates.push(env.HOME + '\\.mimocode\\bin\\mimo.exe')
    candidates.push(env.HOME + '/.mimocode/bin/mimo')
  }
  for (const exe of candidates) {
    try { if (exe && fs.existsSync(exe)) return exe } catch (e) { }
  }
  return null
}

export function apply(ctx, config) {
  const subprocess = ctx.subprocess
  const planMode = ctx.get('planMode')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const timer = ctx.timer
  const env = process.env
  const cfg = config || {}

  // 预选链（旧 loadRuntime 语义）：config.backend > env > 统一设置文件。工具参数级在
  // descriptor.resolveBackend 内处理（arg 优先），这里给 runner 的是「非 arg」的最高优先源。
  function preferredBackend() {
    const b = cfg.backend || env.MIMO_BRIDGE_BACKEND || env.MIMO_BACKEND || (readPartition(env).partition || {}).preferredBackend
    return b || null
  }

  const provider = defineProvider({
    process,
    env,
    config: cfg,
    nodeFs: fs,
    nodePath: path,
    readSettings: () => readPartition(env)
  })

  // 状态快照 → 家级灯（keystone 听 'mimo/status'，事件是 app 级广播）。
  // 附带 defaultBackend/backend 便利字段（旧 mimo/status payload，契约容忍额外键）。
  function publish(snapshot) {
    try {
      const snap = Object.assign({ defaultBackend: preferredBackend() || provider.defaultBackend, backend: preferredBackend() || provider.defaultBackend }, snapshot)
      ctx.emit('mimo/status', { snapshot: snap })
    } catch (e) { /* ignore */ }
  }

  // 旧仓 CWD_FALLBACK 语义：MIMO_MCP_CWD > MIMO_BRIDGE_CWD > workspaceRoot > process.cwd() > '.'。
  function getCwdFallback() {
    if (env.MIMO_MCP_CWD) return String(env.MIMO_MCP_CWD)
    if (env.MIMO_BRIDGE_CWD) return String(env.MIMO_BRIDGE_CWD)
    if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
    return process.cwd()
  }

  // exe：mimo-desktop 走本地 HTTP 非 spawn → 返回占位 'mimo'（永不 throw，让 kit 落到
  // delegates→execute）；mimocode 走 MIMO_BIN/MIMO_CLI > PATH 候选 > subprocess 查找（
  // 找不到 throw → kit 发 MIMO_UNAVAILABLE + 回退弹窗）。
  async function resolveExe(backend, signal) {
    if (backend === BACKEND_DESKTOP) return 'mimo'
    const fromCandidates = mimoExeFromEnvCandidates(env)
    if (fromCandidates) {
      if (/\.(mjs|cjs|js)$/i.test(fromCandidates)) return [process.execPath, fromCandidates]
      return fromCandidates
    }
    return await subprocess.resolveExecutable('mimo', undefined, signal)
  }

  // 旧 planActiveFor verbatim：DSH plan 态决定 mimo 的 --agent（auto→plan|build）。
  function planActiveFor(exec) {
    try {
      if (planMode && exec && exec.agent) {
        const st = planMode.get(exec.agent)
        return !!(st && st.active)
      }
    } catch (e) { }
    return false
  }

  provider.attach({
    ctx,
    subprocess,
    resolveExe,
    getCwdFallback,
    planActiveFor,
    getPreferredBackend: preferredBackend,
    getSettings: () => (readPartition(env).partition || {}),
    publish
  })

  // 宣告 mimo 优先模式：家级灯据此决定常驻显示（presetActive）。挂载即宣告 +
  // 每 30s 心跳续租（TTL 75s，契约 §2）。旧 payload 带 backend，新契约要 sessionId；都带。
  function announceMode() {
    try {
      const sid = (ctx.session && ctx.session.id) || ctx.sessionId || null
      const bk = preferredBackend() || provider.defaultBackend
      const payload = { active: true, backend: bk }
      if (sid) payload.sessionId = sid
      ctx.emit('mimo/mode', payload)
    } catch (e) { /* ignore */ }
  }
  announceMode()
  try {
    if (timer && typeof timer.interval === 'function') {
      ctx.effect(() => timer.interval(announceMode, 30 * 1000))
    } else if (ctx.setInterval) {
      const t = ctx.setInterval(announceMode, 30000)
      if (t && ctx.effect) ctx.effect(() => () => { try { t() } catch (e) { } })
    }
  } catch (e) { }

  // ── 工具注册（schema verbatim 旧 preset；执行进描述符逻辑）──────────────────────
  ctx.effect(() => ctx.tools.register({
    name: provider.tools.run.name,
    description: provider.tools.run.description,
    parameters: provider.tools.run.inputSchema,
    output: { schema: OUTPUT_SCHEMA, render: (args, value) => renderResult(value, provider) },
    execute: (args, exec) => provider.runToolLogic(args, exec)
  }))
  ctx.effect(() => ctx.tools.register({
    name: provider.tools.continue.name,
    description: provider.tools.continue.description,
    parameters: provider.tools.continue.inputSchema,
    output: { schema: OUTPUT_SCHEMA, render: (args, value) => renderResult(value, provider) },
    execute: (args, exec) => provider.continueToolLogic(args, exec)
  }))
  ctx.effect(() => ctx.tools.register({
    name: provider.tools.status.name,
    description: provider.tools.status.description,
    parameters: provider.tools.status.inputSchema,
    output: { schema: OUTPUT_SCHEMA, render: (args, value) => renderStatus(value, provider) },
    execute: (args) => provider.statusToolLogic(args)
  }))
  // mimo_settings：preset 有 nodeFs → 可持久化（描述符工厂恒给出该 extraTool）。
  // 注意 render 适配：harness 契约是 render(args, value)，extraTools[].render 是
  // renderSettings(value) 单参 —— 直接透传会把 args 当 value（渲染全空）。
  for (const et of provider.extraTools) {
    ctx.effect(() => ctx.tools.register({
      name: et.name,
      description: et.description,
      parameters: et.inputSchema,
      output: { schema: OUTPUT_SCHEMA, render: et.render ? ((a, v) => et.render(v)) : ((a, v) => renderResult(v, provider)) },
      execute: (args, exec) => et.logic(args, exec)
    }))
  }

  // 旧 policy 文案 verbatim（契约 §8：提示词连续性，不许顺手改）。
  const policyText = [
    'mimo-first execution policy (Xiaomi MiMo: MiMoCode CLI or MiMo Desktop client).',
    '',
    'Local backends (selectable in settings: backend = mimocode | mimo-desktop):',
    '- mimocode (default): local `mimo` CLI (MiMoCode). Full DSH control (--dangerously-skip-permissions, never prompts).',
    '- mimo-desktop: Xiaomi MiMo Desktop client local API (running Desktop app; uses its login/model/session UI).',
    '',
    'By default, dispatch runs in the background and returns a jobId immediately; collect via job_output and watch live progress via mimo_status.',
    '',
    'Decision table for tool selection:',
    '- Single read/glob/grep or short (<30s) command -> Native tools.',
    '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> mimo_run.',
    '- Follow-ups on the same topic -> mimo_continue (with latest=true or sessionId; context is preserved).',
    '- Final build/test verification of mimo output -> Native tools.',
    '- Plan / read-only analysis -> mimo_run with mode=plan.',
    '- Desktop-native work (Desktop session UI, shared Desktop login/model) -> prefer backend=mimo-desktop (or preselect it in settings).',
    '',
    'Backend preselection (settings):',
    '- Default backend is configured OUT-OF-BAND (plugin config.backend / env MIMO_BRIDGE_BACKEND / settings file).',
    '- Per-call `backend` argument overrides the default only when necessary.',
    '- Do NOT invent a backend every call — use the preselected default.',
    '',
    'Context protocol (one topic = one mimo session):',
    '- First dispatch on a topic: compact CONTEXT preamble (point to paths, do not paste file contents).',
    '- Follow-ups: call mimo_continue and state only what is new.',
    '',
    'Execution & Fallback protocol:',
    '- Dispatch defaults to background=true. Collect via job_output.',
    '- On rate-limit/network/auth failure, a confirmation dialog offers DSH-local fallback.',
    '- If result has fallback=true (status FALLBACK_TO_DSH), finish with native tools and NEVER call mimo again for this task.',
    '- Never loop mimo calls; never ask mimo to call back into DSH.'
  ].join('\n')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'mimo:policy',
    order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
    text: policyText
  }))
}
