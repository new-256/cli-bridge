// preset/claude-first/cli-bridge.mjs — claude-first preset 的桥接插件（preset 宿主形态）。
//
// PROVIDER-CONTRACT.md §5：本模块只做「宿主接线」——构造描述符、attach、注册三工具 +
// claude_models、心跳/事件发布、claude:policy 提示词段。全部执行/状态语义在
// providers/claude.mjs + core/bridge-kit.mjs。
//
// preset id 'claude-first' 由 plugin-list.mjs 单源声明（本文件不含 id 字面量清单）。
//
// 本模块是宿主进程内真 ESM：可 import node: 内建与包内相对路径；禁止 import
// @deepseek-ai/*（解析根够不到 harness 包，历史论证 —— 契约 §8）。
import { existsSync } from 'node:fs'

import defineProvider, { claudeExeCandidates } from '../../providers/claude.mjs'
import { POLICY_TEXT } from '../../providers/claude-policy.mjs'
import { renderResult, renderStatus } from '../../core/bridge-kit.mjs'
import { isBridgeEnabled } from '../../core/scheduling.mjs'
import { PROVIDER_IDS } from '../../providers/registry.mjs'

export const name = 'cli-bridge-claude'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'timer']

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

export function apply(ctx) {
  // 调度门禁：用户在设置面板关掉 claude → 本形态不注册任何工具/政策段/心跳。
  // 每次会话装配时现读文件（改设置下次会话即生效，无需重启宿主）；fail-open。
  if (!isBridgeEnabled('claude', PROVIDER_IDS)) return
  const subprocess = ctx.subprocess
  const sandboxPolicy = ctx.get('sandboxPolicy')

  const provider = defineProvider({ process, env: process.env })

  // 状态快照 → 家级灯（keystone 听 'claude/status'，事件是 app 级广播）。
  function publish(snapshot) {
    try { ctx.emit('claude/status', { snapshot }) } catch (e) { /* ignore */ }
  }

  // cwd 兜底：显式 cwd 参数 > env CLAUDE_MCP_CWD > 沙箱 workspaceRoot > process.cwd()。
  function getCwdFallback() {
    if (process.env.CLAUDE_MCP_CWD) return String(process.env.CLAUDE_MCP_CWD)
    if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
    return process.cwd()
  }

  // 设置面板分区（每次 getSettings 现读 ctx.get，面板改默认模型后下一次调用即生效）。
  function panelSettings() {
    try {
      const s = ctx.get && ctx.get('cliBridgeSettings')
      return (s && s.claude) || null
    } catch (e) { return null }
  }

  // exe 解析优先级（与描述符 claudeExeCandidates 同一套）：
  //   面板 binPath > env CLAUDE_BIN/CLAUDE_CLI/CLAUDE_CODE_BIN > 已知本地安装 > PATH 名 claude。
  // .js/.mjs 目标经 process.execPath 包装（返回数组前缀，buildArgv 接受）。
  // ⚠️ npm 全局安装会在 Windows 给 claude.cmd —— 本形态经 DSH subprocess 启动，.cmd 能否
  // 执行取决于宿主；探测不到原生 exe 时如实落到 resolveExecutable，失败会明确报
  // CLAUDE_UNAVAILABLE/SPAWN_ERROR（绝不静默改走别的后端）。
  const binPathSetting = (() => {
    const s = panelSettings()
    const v = s ? s.binPath : ''
    return typeof v === 'string' ? v : ''
  })()
  const exeCandidates = claudeExeCandidates(process.env, binPathSetting)

  async function resolveExe(backend, signal) {
    for (const c of exeCandidates) {
      if (!c) continue
      if (/\.(mjs|cjs|js)$/i.test(c)) return [process.execPath, c]
      try { if (existsSync(c)) return c } catch (e) { }
    }
    return await subprocess.resolveExecutable('claude', undefined, signal)
  }

  provider.attach({
    ctx, subprocess, resolveExe, getCwdFallback, publish,
    getSettings: () => {
      const s = panelSettings()
      return s && typeof s === 'object' ? s : {}
    }
  })

  // 宣告 claude 优先模式：家级灯据此决定常驻显示（presetActive）。挂载即宣告 +
  // 每 30s 心跳续租（TTL 75s，契约 §2）。
  function announceMode() {
    try {
      const sid = (ctx.session && ctx.session.id) || ctx.sessionId || null
      ctx.emit('claude/mode', sid ? { active: true, sessionId: sid } : { active: true })
    } catch (e) { /* ignore */ }
  }
  announceMode()
  try { const t = ctx.setInterval ? ctx.setInterval(announceMode, 30000) : null; if (t && ctx.effect) ctx.effect(() => () => { try { t() } catch (e) {} }) } catch (e) {}

  // ── 工具注册（执行进描述符三逻辑 + extraTools）──────────────────────────────
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

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'claude:policy',
    order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
    text: POLICY_TEXT
  }))
}
