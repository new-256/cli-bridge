// preset/opencode-first/cli-bridge.mjs — opencode-first preset 的桥接插件（preset 宿主形态）。
//
// PROVIDER-CONTRACT.md §5：本模块只做「宿主接线」——构造描述符、attach、注册三工具、
// 心跳/事件发布、opencode:policy 提示词段。全部执行/状态语义在
// providers/opencode.mjs + core/bridge-kit.mjs。
//
// preset id 'opencode-first' 由 plugin-list.mjs 单源声明。
//
// 本模块是宿主进程内真 ESM：可 import node: 内建与包内相对路径；禁止 import
// @deepseek-ai/*（解析根够不到 harness 包，历史论证 —— 契约 §8）。
import { existsSync } from 'node:fs'

import defineProvider, { resolveExePrefix } from '../../providers/opencode.mjs'
import { renderResult, renderStatus } from '../../core/bridge-kit.mjs'
import { isBridgeEnabled } from '../../core/scheduling.mjs'
import { PROVIDER_IDS } from '../../providers/registry.mjs'

export const name = 'cli-bridge-opencode'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'timer']

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

export function apply(ctx) {
  // 调度门禁（0.2.0）：用户在设置面板关掉 opencode → 本形态不注册任何工具/政策段/心跳。
  // 每次会话装配时现读文件（改设置下次会话即生效，无需重启宿主）；fail-open。
  if (!isBridgeEnabled('opencode', PROVIDER_IDS)) return
  const subprocess = ctx.subprocess
  const sandboxPolicy = ctx.get('sandboxPolicy')

  const provider = defineProvider({ process, env: process.env })

  // 状态快照 → 家级灯（keystone 听 'opencode/status'，事件是 app 级广播）。
  function publish(snapshot) {
    try { ctx.emit('opencode/status', { snapshot }) } catch (e) { /* ignore */ }
  }

  // cwd 兜底：显式 cwd 参数 > env OPENCODE_MCP_CWD > 沙箱 workspaceRoot > process.cwd()。
  function getCwdFallback() {
    if (process.env.OPENCODE_MCP_CWD) return String(process.env.OPENCODE_MCP_CWD)
    if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
    return process.cwd()
  }

  // exe 解析优先级（与描述符 resolveExePrefix 同一套）：
  //   面板 binPath（getSettings）> env OPENCODE_BIN/OPENCODE_CLI > 桌面版 V2 探测 > PATH。
  // 二进制名 opencode-cli（V2 桌面版），不做 opencode.exe 兜底（V1/V2 不能并存）。
  // .js/.mjs 目标经 process.execPath 包装（返回数组前缀，buildArgv 接受）。
  const binPathSetting = (() => {
    try {
      const s = ctx.get && ctx.get('cliBridgeSettings')
      const v = s && s.opencode ? s.opencode.binPath : ''
      return typeof v === 'string' ? v : ''
    } catch (e) { return '' }
  })()
  const candidates = resolveExePrefix(process.env, binPathSetting)

  async function resolveExe(backend, signal) {
    for (const c of candidates) {
      if (/\.(mjs|cjs|js)$/i.test(c)) return [process.execPath, c]
      // 绝对路径/已存在的文件直接用（桌面版探测结果）。
      try { if (existsSync(c)) return c } catch (e) { }
    }
    return await subprocess.resolveExecutable('opencode-cli', undefined, signal)
  }

  provider.attach({ ctx, subprocess, resolveExe, getCwdFallback, publish })

  // 宣告 opencode 优先模式：家级灯据此决定常驻显示（presetActive）。挂载即宣告 +
  // 每 30s 心跳续租（TTL 75s，契约 §2）。
  function announceMode() {
    try {
      const sid = (ctx.session && ctx.session.id) || ctx.sessionId || null
      ctx.emit('opencode/mode', sid ? { active: true, sessionId: sid } : { active: true })
    } catch (e) { /* ignore */ }
  }
  announceMode()
  try { const t = ctx.setInterval ? ctx.setInterval(announceMode, 30000) : null; if (t && ctx.effect) ctx.effect(() => () => { try { t() } catch (e) {} }) } catch (e) {}

  // ── 工具注册（执行进描述符三逻辑）────────────────────────────────────────────
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
  for (const et of provider.extraTools || []) {
    ctx.effect(() => ctx.tools.register({
      name: et.name,
      description: et.description,
      parameters: et.inputSchema,
      output: { schema: OUTPUT_SCHEMA, render: et.render || ((args, value) => renderResult(value, provider)) },
      execute: (args, exec) => et.logic(args, exec)
    }))
  }

  // policy 段（新 provider 无旧文案可 verbatim 继承；按实测 CLI 能力撰写）。
  const policyText = [
    'opencode-first execution policy (local opencode CLI bridge).',
    '',
    'Local agent CLI "opencode" handles coding tasks under full DSH control (permissions auto-approved, never blocks on a prompt). By default, opencode runs in the background and returns a jobId immediately; collect results via job_output and watch live progress via opencode_status anytime.',
    '',
    'Decision table for tool selection:',
    '- Single read/glob/grep or short (<30s) command -> Native tools.',
    '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> opencode_run.',
    '- Follow-ups on the same topic -> opencode_continue (with latest=true or sessionId; opencode preserves session context).',
    '- Final build/test verification of opencode output -> Native tools.',
    '',
    'Context protocol (one topic = one opencode session):',
    '- First dispatch on a topic: provide the task with a compact CONTEXT preamble (point to paths, do not paste file contents):',
    '  CONTEXT: 2-6 lines — goal; repo root; key paths; decisions/constraints; current state.',
    '  TASK: the complete instruction.',
    '- Follow-ups: call opencode_continue and state only what is new.',
    '',
    'Execution & Fallback protocol:',
    '- Dispatch defaults to background=true (set background=false only to block). Collect via job_output.',
    '- On rate-limit or network failure, a confirmation dialog opens in BOTH foreground and background while in flight.',
    '- If result has fallback=true (status FALLBACK_TO_DSH), the user chose DSH-local: finish with native tools and NEVER call opencode again for this task.',
    '- Never loop opencode calls; never ask opencode to call back into DSH.',
    '',
    'Model & credentials:',
    '- Prefer a free model for routine work: call opencode_models (or pass a model id ending in -free, e.g. "opencode/nemotron-3-ultra-free") unless this task genuinely needs a frontier model. Free models are listed first by opencode_models.',
    '- Omit the model unless you have a reason: opencode then uses its own configured default (or the one chosen in CLI Bridge settings). Pass model in provider/model form to override.',
    '- Credentials are owned by opencode, not by this bridge: if a run fails for auth/API-key reasons, tell the user to run `opencode auth login`. Do not retry in a loop.',
    '- An unknown provider/model surfaces as a run failure, not a silent fallback — use opencode_models to check availability first.'
  ].join('\n')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'opencode:policy',
    order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
    text: policyText
  }))
}
