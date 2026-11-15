// preset/standard-base.mjs — 官方 standard preset 的忠实移植基线（keystone 单源）。
//
// 六个 provider preset 都 = 本基线 + 各自桥接行 + 各自的 persona/门禁差异。基线内容对齐
// 官方 dsh-web-app presets/standard.patch.yml（当前实装 0.2.2-rc.3）：行序、id、config
// 逐项一致（上游改版后由 tests/keystone/preset-config-contract.test.mjs 与安装树 schema
// 现场比对防漂移；0.2.2-rc.3 删除了 dsh-tool-subagent-control/list-agents 子路径导出，
// 旧转录行导致全部 6 个预设挂载失败 — 2026-11-15 事故）。
//
// 与上游的两点**有意**差异（勿“修正”回去）：
//   1. 不设 skill-filesystem 的 customSkillDirs：上游该行用
//      createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')
//      指向 dsh 安装树，但本包 preset 的 baseUrl 继承自 profile 而非 dsh 安装树
//      （profiles/web 下无法解析该包）→ 表达式抛错会拖垮整个 preset 挂载。
//   2. tool-plugin-manager 恒 disabled: true：桥接代理不该让模型自改自己的组合
//      （上游为 !!js "!ctx.get('profileContext')"，web profile 等效）。
//
// `!!js` 表达式的 JS 字面量等价物是 { __jsExpr: "…" } —— 这是 loader interpolate 的
// 原生输入形态（agentPresets.register 直接接受，见 codebuddy-first v1.2.0 实测），
// **不要**把它编译成真函数。

/** YAML `!!js expr` 的 JS 字面量等价物（loader interpolate 的原生输入形态）。 */
export function jsExpr(expr) {
  return { __jsExpr: String(expr) }
}

// 官方 standard preset 的 plan-mode 段全文（0.1.7-rc.1，块标量内容，段间双换行）。
export const PLAN_MODE_SECTION = [
  'You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user\'s conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.',
  'Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.',
  'The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.',
  'Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.',
  'Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.',
  'When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.',
].join('\n\n') + '\n'

/**
 * 官方 standard preset 的插件行表（不含 persona 差异与桥接行）。
 * persona 行返回【副本】供 provider 修改 prefix；其余行按原样返回。
 * @returns {object[]}
 */
export function standardPluginRows() {
  return [
    // persona 只留 prefix。DSH 的提示词循环只注册 provider/model 两个变量
    // （dsh-agent-loop），工作目录由 working-directory 服务以「不执行插值的用户
    // 上下文」提供。写 {{cwd}} 会在组装期抛 unknown prompt variable，导致整个
    // 预设不可用（2026-10-18 实测）。官方 presets 全部不带 suffix。
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
      prefix: 'You are a coding agent powered by the {{model}} model.',
    } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: jsExpr("process.platform === 'win32'") },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: jsExpr("process.platform !== 'win32'") },
    // 与上游一致：不随 edit 再放出 apply_patch 工具（edit 已覆盖其全部能力）。
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    {
      id: 'planning', name: 'cordis:group', group: true,
      isolate: { planMode: true },
      config: [
        { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', config: { section: PLAN_MODE_SECTION } },
      ],
    },
    {
      id: 'compaction', name: 'cordis:group', group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: {
          thresholdChars: 8192, headChars: 4096, tailChars: 1024,
        } },
      ],
    },
    {
      id: 'delegation', name: 'cordis:group', group: true,
      isolate: { workflowEngine: true },
      // 2026-10-18：移除 backgroundMode —— dsh-tool-subagent 0.2.1 已删除该字段。
      // 2026-11-15（DSH 0.2.2-rc.3）：modelSelectionSettings 亦被删除，上游改用
      // modelSelection/modelDiscovery；list-agents 子路径导出已下线（该能力并入
      // dsh-tool-subagent-control 主模块），对应行整行删除。
      // schemastery 校验保留未知键（无 strict 开关）但无人读取 ⇒ 静默忽略，
      // 运行时不报错，只能靠静态闸门（tests/keystone/preset-config-contract.test.mjs）拦。
      // 当前 schema 接受：provider / toolName / modelSelection / modelDiscovery /
      // agentOptions / agentPreset / allowedAgentPresets / maxDepth。
      config: [
        // 与上游一致：不放出 interrupt_agent 工具（子 agent 中断由宿主接管）。
        { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control', config: {
          interrupt: false,
        } },
        { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: {
          provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true,
        } },
        { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: {
          provider: 'fork', toolName: 'subagent_fork',
        } },
        { id: 'tool-subagent-codex', name: '@deepseek-ai/dsh-tool-subagent', disabled: true, config: {
          provider: 'codex', toolName: 'subagent_codex', maxDepth: 'provider-managed',
        } },
        { id: 'tool-subagent-claude-code', name: '@deepseek-ai/dsh-tool-subagent', disabled: true, config: {
          provider: 'claude-code', toolName: 'subagent_claude_code', maxDepth: 'provider-managed',
        } },
        { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
        { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
        // tool-ralph 行已移除：ralph 能力由 @deepseek-ai/dsh-experimental-ralph-bundle
        // 以 bundle 形式按需注入，与上游 standard 对齐（2026-11-15）。
      ],
    },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    { id: 'tool-office', name: '@deepseek-ai/dsh-tool-office' },
    { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: true },
    { id: 'tool-plugin-market', name: '@deepseek-ai/dsh-plugin-market/tools', disabled: true },
  ]
}

/** 桥接行（每个 preset 的唯一增量）。deps.bridgeName 必须等于 package.json 的 exports 子路径。 */
export function bridgeRow(id, bridgeName) {
  return { id: 'cli-bridge-' + id, name: bridgeName || ('@luchenglong/cli-bridge/preset-' + id) }
}
