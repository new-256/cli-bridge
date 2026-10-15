// preset/codebuddy-first/cli-bridge.mjs — codebuddy-first preset 的桥接插件（preset 宿主形态）。
//
// PROVIDER-CONTRACT.md §5：本模块只做「宿主接线」——构造描述符、attach、注册三工具、
// 心跳/事件发布、codebuddy:policy 提示词段。全部执行/状态语义在
// providers/codebuddy.mjs + core/bridge-kit.mjs。
//
// 移植基线：codebuddy-first-bridge v1.6.x preset/codebuddy-first/codebuddy-first-bridge.mjs
// 的 apply()：resolveExe 三面候选链、CWD_FALLBACK、心跳（SELF_SESSION_ID 兜底通道 +
// 30s 续租 + dispose 撤销）、noteSession、systemPrompt order 5 —— 全部 verbatim。
//
// 沙箱论证：本插件只注册工具与提示段，不发服务、不开端口、不写盘（设置文件由
// 家级指示灯路由单一写者负责）——无需 isolate 包装（旧包同款结论，逐字保留）。
//
// 本模块是宿主进程内真 ESM：可 import node: 内建与包内相对路径；禁止 import
// @deepseek-ai/*（解析根够不到 harness 包，历史论证 —— 契约 §8）。
import fs from 'node:fs'
import path from 'node:path'

import defineProvider from '../../providers/codebuddy.mjs'
import { renderResult, renderStatus } from '../../core/bridge-kit.mjs'
import { isBridgeEnabled } from '../../core/scheduling.mjs'
import { PROVIDER_IDS } from '../../providers/registry.mjs'
// 统一设置文件（keystone 单源：含旧 codebuddy-bridge-settings.json 字段级迁移）。
import { readSettingsFile, effectiveSettings } from '../../home-plugin/cli-bridge-indicator/lib/settings.mjs'

export const name = 'cli-bridge-codebuddy'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'timer']

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }
// 旧 preset CWD_FALLBACK verbatim（机器默认路径，Lead 定案保留：动态解析工作目录
// 只在 keystone indicator 侧做，preset 形态行为与旧包逐字一致）。
const CWD_FALLBACK = 'C:\\Users\\lcl\\Desktop\\codebuddy-bridge'

export function apply(ctx, config) {
  // 调度门禁（0.2.0）：用户关掉 codebuddy → 本形态不注册工具/政策段/心跳；fail-open。
  if (!isBridgeEnabled('codebuddy', PROVIDER_IDS)) return
  const subprocess = ctx.subprocess
  const planMode = ctx.get('planMode')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const cfg = config || {}

  const provider = defineProvider({ process, env: process.env, nodeFs: fs, nodePath: path })

  // 设置读数：每次现读统一文件（面板保存即时生效，无需重启）；文件缺失/损坏 →
  // effectiveSettings（默认值 + 旧包文件字段级回退）。行 config 只做最后兜底。
  function codebuddySettings() {
    try {
      const snap = readSettingsFile() || effectiveSettings()
      const part = snap && snap.codebuddy
      if (part && typeof part === 'object') return part
    } catch (e) { /* 无 fs / 定位失败：落到行 config */ }
    return provider.normalizeSettings(cfg)
  }

  // 状态快照 → 家级灯（keystone 听 'codebuddy/status'，事件是 app 级广播；旧 payload 形态）。
  function publish(snapshot) {
    try { ctx.emit('codebuddy/status', { snapshot }) } catch (e) { /* ignore */ }
  }

  // 旧 preset resolveExe verbatim（L265-284）：三个后端各有独立安装包，明确报错
  // 而不跨面回退（各产品面登录互斥，混用会污染同一会话存储）。
  //   codebuddy    npm 全局包 @tencent-ai/codebuddy-code：PATH → CODEBUDDY_BIN →
  //                npm 全局 bin（.cmd shim 走 node+bin，规避 CVE-2024-27980 后
  //                spawn .cmd/.bat 的 EINVAL）。
  //   codebuddy-en WorkBuddy AI 国际版自带 CLI：CODEBUDDY_EN_BIN → C:\Program Files\WorkBuddyAI\…
  //   workbuddy    WorkBuddy 国内版桌面自带 CLI：WORKBUDDY_BIN → C:\Program Files\WorkBuddy\…
  async function resolveExe(backend, execSignal) {
    const nodeExe = process.execPath || 'node'
    if (backend === 'workbuddy') {
      const wbBin = process.env.WORKBUDDY_BIN || 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy'
      return [nodeExe, wbBin]
    }
    if (backend === 'codebuddy-en') {
      const enBin = process.env.CODEBUDDY_EN_BIN || 'C:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy'
      return [nodeExe, enBin]
    }
    try {
      const exe = await subprocess.resolveExecutable('codebuddy', undefined, execSignal)
      // npm 安装的 codebuddy 只有 .cmd shim，Node 直接 spawn .cmd/.bat 会 EINVAL
      // （CVE-2024-27980 加固后）；命中 .cmd/.bat 时改走 node + bin 脚本。
      if (!/\.(cmd|bat)$/i.test(exe)) return exe
    } catch (e) {}
    // 回退：node 直接跑 npm 全局 bin 脚本（codebuddy 通常不在 DSH 进程 PATH 里）。
    const binPath = process.env.CODEBUDDY_BIN || (process.env.APPDATA || 'C:\\Users\\lcl\\AppData\\Roaming') + '\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy'
    return [nodeExe, binPath]
  }

  // 旧 planActiveFor verbatim：DSH plan 态决定 codebuddy 的 --permission-mode。
  function planActiveFor(exec) {
    try {
      if (planMode && exec && exec.agent) {
        const st = planMode.get(exec.agent)
        return !!(st && st.active)
      }
    } catch (e) {}
    return false
  }

  provider.attach({
    ctx,
    subprocess,
    resolveExe,
    getCwdFallback: function () {
      return (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) || CWD_FALLBACK
    },
    planActiveFor,
    defaultMode: 'auto',
    getSettings: codebuddySettings,
    getPreferredBackend: function () {
      const s = codebuddySettings()
      return (s && s.preferredBackend) || provider.defaultBackend
    },
    publish
  })

  // ── 模式宣告心跳（旧 preset verbatim）─────────────────────────────────────────
  // 本会话身份（兜底通道）：host 侧首选自己实时枚举 agents.list() +
  // agentPresets.composedPreset() 判定哪些会话是 codebuddy-first；这里的上报是
  // 那条通道失灵时的备份。apply() 阶段 agent 通常尚未就位（preset 正在被组合
  // 进去），所以：① 先试 agents.currentInitiator()；② 拿不到就等第一次工具调用，
  // 从 exec.agent 补记。全程防御：取不到就退化为不带 sessionId 的旧全局语义。
  let SELF_SESSION_ID = null
  function sessionIdOf(agent) {
    if (!agent) return null
    const sid = agent.id || (agent.session && agent.session.id)
    return typeof sid === 'string' && sid ? sid : null
  }
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents && typeof agents.currentInitiator === 'function') SELF_SESSION_ID = sessionIdOf(agents.currentInitiator())
  } catch (e) { }

  function announceMode(active) {
    try {
      const payload = { active: active !== false }
      if (SELF_SESSION_ID) payload.sessionId = SELF_SESSION_ID
      ctx.emit('codebuddy/mode', payload)
    } catch (e) { }
  }
  // 第一次工具调用时补记会话身份（apply 阶段拿不到的情况）。
  function noteSession(exec) {
    if (SELF_SESSION_ID) return
    try {
      const sid = sessionIdOf(exec && exec.agent)
      if (sid) { SELF_SESSION_ID = sid; announceMode(true) }
    } catch (e) { }
  }
  announceMode(true)
  try {
    const t = ctx.setInterval ? ctx.setInterval(function () { announceMode(true) }, 30000) : null
    if (ctx.effect) ctx.effect(() => () => {
      try { if (t) t() } catch (e) { }
      announceMode(false)
    })
  } catch (e) { }

  // ── 工具注册（schema 经描述符 verbatim；执行进描述符三逻辑）───────────────────
  const runTool = {
    name: provider.tools.run.name,
    description: provider.tools.run.description,
    parameters: provider.tools.run.inputSchema,
    output: { schema: OUTPUT_SCHEMA, render: (args, value) => renderResult(value, provider) },
    execute(args, exec) { noteSession(exec); return provider.runToolLogic(args, exec) }
  }
  const continueTool = {
    name: provider.tools.continue.name,
    description: provider.tools.continue.description,
    parameters: provider.tools.continue.inputSchema,
    output: { schema: OUTPUT_SCHEMA, render: (args, value) => renderResult(value, provider) },
    execute(args, exec) { noteSession(exec); return provider.continueToolLogic(args, exec) }
  }
  const statusTool = {
    name: provider.tools.status.name,
    description: provider.tools.status.description,
    parameters: provider.tools.status.inputSchema,
    output: { schema: OUTPUT_SCHEMA, render: (args, value) => renderStatus(value, provider) },
    execute(args) { return provider.statusToolLogic(args) }
  }
  for (const tool of [runTool, continueTool, statusTool]) ctx.tools.register(tool)

  // 提示词策略段（旧 preset verbatim：name 'codebuddy:policy'，order 5，
  // POLICY_TEXT 全文在 providers/codebuddy.mjs —— 提示词连续性红线）。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'codebuddy:policy',
    order: 5,
    text: provider.policyText
  }))
}
