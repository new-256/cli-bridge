// preset/codex-first/cli-bridge.mjs — codex-first preset 的桥接插件（preset 宿主形态）。
//
// PROVIDER-CONTRACT.md §5：本模块只做「宿主接线」——构造描述符、attach、注册三工具
// （+ codex_models）、心跳/事件发布、codex:policy 提示词段。全部执行/状态语义在
// providers/codex.mjs + core/bridge-kit.mjs。
//
// preset id 'codex-first' 由 plugin-list.mjs 单源声明。
//
// 本模块是宿主进程内真 ESM：可 import node: 内建与包内相对路径；禁止 import
// @deepseek-ai/*（解析根够不到 harness 包，历史论证 —— 契约 §8）。
import { existsSync } from 'node:fs'

import defineProvider, { codexResolveExePrefix, codexExeCandidates } from '../../providers/codex.mjs'
import { codexShimRejectReason } from '../../providers/codex-cli.mjs'
import { renderResult, renderStatus } from '../../core/bridge-kit.mjs'
import { isBridgeEnabled } from '../../core/scheduling.mjs'
import { PROVIDER_IDS } from '../../providers/registry.mjs'

export const name = 'cli-bridge-codex'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'timer']

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

export function apply(ctx) {
  // 调度门禁（0.2.0）：用户在设置面板关掉 codex → 本形态不注册任何工具/政策段/心跳。
  // 每次会话装配时现读文件（改设置下次会话即生效，无需重启宿主）；fail-open。
  if (!isBridgeEnabled('codex', PROVIDER_IDS)) return
  const subprocess = ctx.subprocess
  const sandboxPolicy = ctx.get('sandboxPolicy')

  const provider = defineProvider({ process, env: process.env })

  // 状态快照 → 家级灯（keystone 听 'codex/status'，事件是 app 级广播）。
  function publish(snapshot) {
    try { ctx.emit('codex/status', { snapshot }) } catch (e) { /* ignore */ }
  }

  // cwd 兜底：显式 cwd 参数 > env CODEX_BRIDGE_CWD > 沙箱 workspaceRoot > process.cwd()。
  //（不用 CODEX_HOME —— 那是 codex 自己的配置目录，语义不同，误用会把工作区指到 ~/.codex。）
  function getCwdFallback() {
    if (process.env.CODEX_BRIDGE_CWD) return String(process.env.CODEX_BRIDGE_CWD)
    if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
    return process.cwd()
  }

  // exe 解析优先级（与描述符同一套）：面板 binPath（getSettings）> CODEX_BIN >
  // CODEX_CLI > CODEX_CLI_PATH > PATH 里的 codex。.js/.mjs 目标经 node 包装。
  const binPathSetting = (() => {
    try {
      const s = ctx.get && ctx.get('cliBridgeSettings')
      const v = s && s.codex ? s.codex.binPath : ''
      return typeof v === 'string' ? v : ''
    } catch (e) { return '' }
  })()
  const candidates = codexResolveExePrefix(process.env, binPathSetting)

  async function resolveExe(backend, signal) {
    let bare = ''
    for (const c of candidates) {
      // .cmd/.bat shim 直接给出可行动错误：无 shell 时 spawn 不解析它，走 shell 又会
      // 二次解释 prompt —— 与其抛难懂的 EINVAL，不如在解析阶段说清楚。
      const shim = codexShimRejectReason(c)
      if (shim) throw new Error(shim)
      if (/\.(mjs|cjs|js)$/i.test(c)) return [process.execPath, c]
      if (/[\\/]/.test(c)) { try { if (existsSync(c)) return c } catch (e) { /* 继续下一个候选 */ } continue }
      if (!bare) bare = c
    }
    // PATH 兜底：第一个裸名候选（CODEX_BIN 也可能是裸名，如 'codex-alt'）。
    return await subprocess.resolveExecutable(bare || codexExeCandidates(process.env).slice(-1)[0], undefined, signal)
  }

  provider.attach({ ctx, subprocess, resolveExe, getCwdFallback, publish })

  // 宣告 codex 优先模式：家级灯据此决定常驻显示（presetActive）。挂载即宣告 +
  // 每 30s 心跳续租（TTL 75s，契约 §2）。
  function announceMode() {
    try {
      const sid = (ctx.session && ctx.session.id) || ctx.sessionId || null
      ctx.emit('codex/mode', sid ? { active: true, sessionId: sid } : { active: true })
    } catch (e) { /* ignore */ }
  }
  announceMode()
  try {
    const t = ctx.setInterval ? ctx.setInterval(announceMode, 30000) : null
    if (t && ctx.effect) ctx.effect(() => () => { try { t() } catch (e) { /* ignore */ } })
  } catch (e) { /* 心跳尽力而为 */ }

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
    'codex-first execution policy (local OpenAI Codex CLI bridge).',
    '',
    'Local agent CLI "codex" handles coding tasks under full DSH control. Every dispatch is `codex exec --json --skip-git-repo-check` (never interactive, so approvals cannot block). By default codex runs in the background and returns a jobId immediately; collect results via job_output and watch live progress via codex_status anytime.',
    '',
    'Decision table for tool selection:',
    '- Single read/glob/grep or short (<30s) command -> Native tools.',
    '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> codex_run.',
    '- Follow-ups on the same topic -> codex_continue (with latest=true or sessionId; codex keeps the thread).',
    '- Final build/test verification of codex output -> Native tools.',
    '',
    'Context protocol (one topic = one codex thread):',
    '- First dispatch on a topic: provide the task with a compact CONTEXT preamble (point to paths, do not paste file contents):',
    '  CONTEXT: 2-6 lines — goal; repo root; key paths; decisions/constraints; current state.',
    '  TASK: the complete instruction.',
    '- Follow-ups: call codex_continue and state only what is new.',
    '',
    'Sandbox & approval:',
    '- mode=auto follows the DSH plan state: plan -> read-only sandbox, otherwise workspace-write.',
    '- codex exec has NO -a/--ask-for-approval flag; the bridge sets approval policy through -c approval_policy="…" only when the settings panel defines one. On resume the sandbox also goes through -c ("codex exec resume" has no -s and no -C).',
    '- If a run fails because the sandbox denied an operation, raise sandboxMode (workspace-write -> danger-full-access) instead of looping retries.',
    '',
    'Execution & Fallback protocol:',
    '- Dispatch defaults to background=true (set background=false only to block). Collect via job_output.',
    '- On rate-limit or network failure, a confirmation dialog opens in BOTH foreground and background while in flight.',
    '- If result has fallback=true (status FALLBACK_TO_DSH), the user chose DSH-local: finish with native tools and NEVER call codex again for this task.',
    '- Never loop codex calls; never ask codex to call back into DSH.',
    '',
    'Models & credentials:',
    '- Run codex_models (default source=live) to see what the configured endpoint really serves; ~/.codex/models.json and model_catalog_json are local catalog metadata, NOT a claim about server availability.',
    '- Omit model unless you have a reason: codex then uses the CLI Bridge settings default, or ~/.codex/config.toml model.',
    '- Credentials belong to codex (~/.codex/config.toml model_providers.<name>, auth.json): on auth failures tell the user to run `codex login` or fix the provider block; do not retry in a loop.'
  ].join('\n')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'codex:policy',
    order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
    text: policyText
  }))
}
