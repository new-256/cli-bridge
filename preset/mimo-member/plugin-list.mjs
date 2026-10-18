// preset/mimo-member/plugin-list.mjs — cordis-mimo 的【成员预设】单源清单（PROVIDER-CONTRACT §5）。
//
// 为什么需要它（2026-10-18 实测结论）：
//   dsh-tool-subagent 0.2.1 起，config 里的 `persona` / `toolFilter` 会在 apply() 里
//   **显式 throw**（"tool-subagent: persona is no longer supported; configure persona
//   and tool plugins in an Agent Preset and select it with agentPreset (spawn only)"）。
//   mimo 预设此前把委派指令写在 tool-subagent.config.persona 上 ⇒ 整个 preset 挂载失败
//   （与 dsh-kexi-crypto v1.9.21 踩的是同一个坑）。
//   新契约：角色人格只能是**独立的 Agent Preset**，由委派行经 `agentPreset` 选择。
//
// 本预设就是那个成员预设：人格（旧委派指令 verbatim）+ mimo 桥接工具面（子 agent 必须
// 能调 mimo_run，否则"派活"无从谈起）+ 只读文件面（够做只读查询与最终验证）。
// 由 preset-declarations.mjs 在**主预设之前**注册 —— 委派行的 validate() 会对每个
// agentPreset id 调 presets.readDocument(id)，未注册即抛 agent-preset/not-found。
//
// 它不是独立会话入口：直接选择它只会得到一个只能派活、不能自己改文件的子代理。
import { bridgeRow } from '../standard-base.mjs'

/** Preset identity —— 旧会话头不可引用它（成员预设是本次新增），但委派行按此 id 选择。 */
export const meta = {
  id: 'cordis-mimo-member',
  name: 'MiMo 子代理（内部预设·勿直接选择）',
  description: 'MiMo-first 会话里被委派的子 agent 所用成员预设：只挂 mimo 桥接工具与只读文件面，人格要求把编码工作派给 mimo_run。仅供 cordis-mimo 的委派行经 agentPreset 选择，不是独立会话入口；直接选择它只会得到一个只能派活、不能自己改文件的子代理。',
  order: 501
}

/** 旧 agent.cordis.yml 的 spawn/fork 委派指令文案 verbatim（0.2.1 起只能放进 persona）。 */
export const MIMO_DELEGATION_PERSONA = 'Delegation directive: you are a child agent in a MiMo-first session. Before doing any coding, building, debugging, or multi-file investigation work yourself, check whether the mimo_run tool (or the MCP form mcp__mimo__mimo_run) is available to you; if it is, dispatch that work to mimo first per the MiMo-first policy, then verify its output with your own read-only tools. Reserve your own direct work for quick read-only lookups and final verification.'

export function buildPlugins(deps) {
  return [
    // 人格：委派指令。prefix 必填；suffix 不设（DSH 只注册 provider/model 两个提示词变量，
    // 工作目录由 working-directory 服务以不插值的用户上下文提供）。
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
      prefix: MIMO_DELEGATION_PERSONA,
      includeRuntimeContext: true,
    } },
    // 只读文件面：旧 toolFilter 白名单的新表达 —— 写/改工具直接不存在，比黑名单更严格
    // （成员纪律：改文件一律经 mimo_run）。
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: {
      read: true, readImage: true, write: false, edit: false,
    } },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: {
      sampleOverCapGlobResults: false,
    } },
    // 桥接工具面：子 agent 必须能调 mimo_run/mimo_continue/ mimo_status。
    bridgeRow('mimo', deps && deps.bridgeName),
  ]
}
