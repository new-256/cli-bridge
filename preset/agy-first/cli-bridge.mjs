// preset/agy-first/cli-bridge.mjs — cordis-agy preset 的桥接插件（preset 宿主形态）。
//
// PROVIDER-CONTRACT.md §5：本模块只做「宿主接线」——构造描述符、attach、注册三工具
// （+agy_quota）、心跳/事件发布、agy:policy 提示词段。全部执行/状态语义在
// providers/agy.mjs + core/bridge-kit.mjs。
//
// 移植基线：agy-first-bridge v1.7.1 preset/agy-first/agy-first-bridge.mjs 的 apply()。
// preset id 'cordis-agy' 由 plugin-list.mjs 单源声明（旧会话头引用，不可变）。
//
// 本模块是宿主进程内真 ESM：可 import node: 内建与包内相对路径；禁止 import
// @deepseek-ai/*（解析根够不到 harness 包，历史论证 —— 契约 §8）。
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import defineProvider from '../../providers/agy.mjs'
import { renderResult, renderStatus } from '../../core/bridge-kit.mjs'
import { isBridgeEnabled } from '../../core/scheduling.mjs'
import { PROVIDER_IDS } from '../../providers/registry.mjs'

export const name = 'cli-bridge-agy'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'timer']

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

// 额度脚本定位（契约 §8）：env CLI_BRIDGE_AGY_QUOTA > AGY_QUOTA_SCRIPT（旧兼容）>
// 本包 bin/agy-quota.mjs（相对本模块推导；存在才注入）。描述符内部同样优先读 env。
function resolveQuotaScript() {
  const e = process.env.CLI_BRIDGE_AGY_QUOTA || process.env.AGY_QUOTA_SCRIPT || ''
  if (e && existsSync(e)) return e
  // fileURLToPath 而非 .pathname：路径含空格（"DSH Desktop"）时 .pathname 给出
  // 百分号编码（%20）导致脚本永远打不开（旧仓注释里踩过的坑，逐字保留教训）。
  try {
    const p = fileURLToPath(new URL('../../bin/agy-quota.mjs', import.meta.url))
    return existsSync(p) ? p : null
  } catch (e2) { return null }
}

export function apply(ctx) {
  // 调度门禁（0.2.0）：用户在设置面板关掉 agy → 本形态不注册任何工具/政策段/心跳。
  // 每次会话装配时现读文件（改设置下次会话即生效，无需重启宿主）；fail-open。
  if (!isBridgeEnabled('agy', PROVIDER_IDS)) return
  const subprocess = ctx.subprocess
  const planMode = ctx.get('planMode')
  const sandboxPolicy = ctx.get('sandboxPolicy')

  const provider = defineProvider({
    process,
    env: process.env,
    quotaScript: resolveQuotaScript()
  })

  // 状态快照 → 家级灯（keystone 听 'agy/status'，事件是 app 级广播）。
  function publish(snapshot) {
    try { ctx.emit('agy/status', { snapshot }) } catch (e) { /* ignore */ }
  }

  // 旧仓 CWD_FALLBACK 硬编码 'C:\\Users\\lcl\\Desktop\\DSH'（机器特定，他机必坏）。
  // 新语义：显式 cwd 参数 > env AGY_MCP_CWD > 沙箱 workspaceRoot > process.cwd()。
  function getCwdFallback() {
    if (process.env.AGY_MCP_CWD) return String(process.env.AGY_MCP_CWD)
    if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
    return process.cwd()
  }

  // 旧仓 exe 解析逻辑：AGY_BIN（旧包兼容名 AGY_CLI）> PATH 查找 agy > 报错。
  // .js/.mjs 目标经 process.execPath 包装（返回数组前缀，buildArgv 接受）。
  async function resolveExe(backend, signal) {
    const bin = process.env.AGY_BIN || process.env.AGY_CLI || ''
    if (bin) {
      if (/\.(mjs|cjs|js)$/i.test(bin)) return [process.execPath, bin]
      return bin
    }
    return await subprocess.resolveExecutable('agy', undefined, signal)
  }

  // 旧 planActiveFor verbatim：DSH plan 态决定 agy 的 --mode。
  function planActiveFor(exec) {
    try {
      if (planMode && exec && exec.agent) {
        const st = planMode.get(exec.agent)
        return !!(st && st.active)
      }
    } catch (e) {}
    return false
  }

  provider.attach({ ctx, subprocess, resolveExe, getCwdFallback, planActiveFor, publish })

  // 宣告 agy 优先模式：家级灯据此决定常驻显示（presetActive）。挂载即宣告 +
  // 每 30s 心跳续租（TTL 75s，契约 §2）。
  function announceMode() {
    try {
      const sid = (ctx.session && ctx.session.id) || ctx.sessionId || null
      ctx.emit('agy/mode', sid ? { active: true, sessionId: sid } : { active: true })
    } catch (e) { /* ignore */ }
  }
  announceMode()
  try { const t = ctx.setInterval ? ctx.setInterval(announceMode, 30000) : null; if (t && ctx.effect) ctx.effect(() => () => { try { t() } catch (e) {} }) } catch (e) {}

  // ── 工具注册（schema verbatim 旧 preset；执行进描述符三逻辑）──────────────────
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
  // agy_quota：preset 形态有 process/subprocess → 恒注册（描述符工厂决定）。
  for (const et of provider.extraTools) {
    ctx.effect(() => ctx.tools.register({
      name: et.name,
      description: et.description,
      parameters: et.inputSchema,
      output: { schema: OUTPUT_SCHEMA, render: et.render || ((args, value) => renderResult(value, provider)) },
      execute: (args, exec) => et.logic(args, exec)
    }))
  }

  // 旧 policy 文案 verbatim（契约 §8：提示词连续性，不许顺手改）。
  const policyText = [
    'agy-first execution policy (local agy CLI bridge).',
    '',
    'Local agent CLI "agy" handles coding tasks under full DSH control (permissions auto-approved, never prompts). By default, agy runs in the background and returns a jobId immediately; collect results via job_output and watch live progress via agy_status anytime.',
    '',
    'Decision table for tool selection:',
    '- Single read/glob/grep or short (<30s) command -> Native tools.',
    '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> agy_run.',
    '- Follow-ups on the same topic -> agy_continue (with latest=true or conversationId; agy preserves session context).',
    '- Final build/test verification of agy output -> Native tools.',
    '- Image/video generation -> agy_run WITHOUT picking a model (agy selects the appropriate model).',
    '',
    'Context protocol (one topic = one agy conversation):',
    '- First dispatch on a topic: provide the task with a compact CONTEXT preamble (point to paths, do not paste file contents):',
    '  CONTEXT: 2-6 lines — goal; repo root; key paths; decisions/constraints; current state.',
    '  TASK: the complete instruction.',
    '- Follow-ups: call agy_continue and state only what is new.',
    '',
    'Execution & Fallback protocol:',
    '- Dispatch defaults to background=true (set background=false only to block). Collect via job_output.',
    '- On rate-limit or network failure, a confirmation dialog opens in BOTH foreground and background while in flight.',
    '- If result has fallback=true (status FALLBACK_TO_DSH), the user chose DSH-local: finish with native tools and NEVER call agy again for this task.',
    '- If status is QUOTA_BLOCKED (Gemini 5h pool <10%), finish natively. Never loop agy calls; never ask agy to call back into DSH.',
    '',
    'Model selection & Quota guard:',
    '- The Gemini 5h pool (<10% threshold) is enforced automatically as the sole per-task gate; do NOT pre-call agy_quota before every dispatch. Call agy_quota only when you want to compare model availability.',
    '- Use Gemini pool (gemini-*) or utility models (tab_*, chat_*). Never pass Claude or GPT (3p) models.',
    '- Weekly quota is NOT a per-task gate: low weekly quota only informs future planning, never aborts current work.'
  ].join('\n')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'agy:policy',
    order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
    text: policyText
  }))
}
