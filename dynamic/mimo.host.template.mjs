// dynamic/mimo.host.template.mjs — mimo 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=mimo）把 core/bridge-kit.mjs 与
// providers/mimo.mjs 分别内联进下方两个占位标记行（各占一行、行内仅此标记），
// 生成 dynamic/mimo.host.js。注意：标记字面量绝不能出现在本注释里 —— 构建做全局
// 替换，注释中出现同样会被替换成正文代码而炸掉语法。
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生
//    定时器 —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层
//    return 合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('mimo', snap)
//    推给家级灯（旧 mimoCollector 服务名在 keystone 里保留别名）；动态形态不宣告
//    mode（旧语义：普通模式灯仅在调用 mimo 时临时显示）。
//  - mimo-desktop 在沙箱的形态（契约 §9）：无 fs 发现 desktop-api.json，且多数沙箱
//    无 fetch —— 描述符 preflight 直接 abort 为 DESKTOP_UNREACHABLE 并提示改用
//    backend=mimocode（旧仓返回 DESKTOP_UNSUPPORTED 的替代；语义升级，Lead 定案）。
//    宿主若注入了 globalThis.fetch 且给出 MIMO_DESKTOP_PORT/MIMO_DESKTOP_TOKEN env，
//    委托 execute 仍可走通（fetch 路径全部 typeof 守卫）。
//  - mimo_settings 在沙箱不持久化（无 nodeFs → 描述符回显语义；旧 dynamic echo 形态）。
//  - exe 解析（旧动态候选无 existsSync 校验，盲取候选 [0] 易 spawn 失败）：升级走
//    agy 模板同款链路 —— MIMO_BIN/MIMO_CLI env > subprocess.resolveExecutable(PATH)。
/*__KIT__*/
/*__PROVIDER__*/

return {
  inject: ['tools', 'subprocess', 'systemPrompt', 'timer'],
  apply(ctx) {
    const subprocess = ctx.subprocess
    const planMode = ctx.get('planMode')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    // 沙箱可能运行在无 process 的环境：typeof 守卫读 env（旧仓 dynamic 的等价面）。
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}

    const provider = defineProvider({ env })

    function publish(snapshot) {
      try {
        const collector = ctx.get('cliBridgeCollector')
        if (collector && typeof collector.mergeSnapshot === 'function') { collector.mergeSnapshot('mimo', snapshot); return }
      } catch (e) { /* fall through to legacy alias */ }
      try {
        const legacy = ctx.get('mimoCollector')
        if (legacy && typeof legacy.mergeSnapshot === 'function') legacy.mergeSnapshot(snapshot)
      } catch (e) { /* 灯数据尽力而为 */ }
    }

    // exe：MIMO_BIN/MIMO_CLI env > PATH 查找 mimo（subprocess.resolveExecutable）。
    // mimo-desktop 后端不 spawn：返回占位字符串让 kit 直达 delegates→execute/preflight。
    async function resolveExe(backend, signal) {
      if (backend === 'mimo-desktop') return 'mimo'
      const bin = env.MIMO_BIN || env.MIMO_CLI || ''
      if (bin) {
        if (/\.(mjs|cjs|js)$/i.test(bin) && typeof process !== 'undefined' && process.execPath) return [process.execPath, bin]
        return bin
      }
      return await subprocess.resolveExecutable('mimo', undefined, signal)
    }

    // 旧仓 CWD_FALLBACK 硬编码机器绝对路径；新语义：MIMO_MCP_CWD > MIMO_BRIDGE_CWD >
    // workspaceRoot > process.cwd > '.'（沙箱无 process.cwd 可用时以 '.' 兜底）。
    function getCwdFallback() {
      if (env.MIMO_MCP_CWD) return String(env.MIMO_MCP_CWD)
      if (env.MIMO_BRIDGE_CWD) return String(env.MIMO_BRIDGE_CWD)
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
      if (typeof process !== 'undefined' && typeof process.cwd === 'function') { try { return process.cwd() } catch (e) {} }
      return '.'
    }

    // 预选链（沙箱无 fs 读设置文件）：env MIMO_BRIDGE_BACKEND / MIMO_BACKEND。
    function getPreferredBackend() {
      return env.MIMO_BRIDGE_BACKEND || env.MIMO_BACKEND || null
    }

    function planActiveFor(exec) {
      try {
        if (planMode && exec && exec.agent) {
          const st = planMode.get(exec.agent)
          return !!(st && st.active)
        }
      } catch (e) {}
      return false
    }

    provider.attach({ ctx, subprocess, resolveExe, getCwdFallback, getPreferredBackend, planActiveFor, publish })

    const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

    harness.registerTool(ctx, harness.defineTool({
      name: provider.tools.run.name,
      description: provider.tools.run.description,
      parameters: provider.tools.run.inputSchema,
      output: { schema: OUTPUT_SCHEMA, render: function (args, value) { return renderResult(value, provider) } },
      execute: function (args, exec) { return provider.runToolLogic(args, exec) }
    }))
    harness.registerTool(ctx, harness.defineTool({
      name: provider.tools.continue.name,
      description: provider.tools.continue.description,
      parameters: provider.tools.continue.inputSchema,
      output: { schema: OUTPUT_SCHEMA, render: function (args, value) { return renderResult(value, provider) } },
      execute: function (args, exec) { return provider.continueToolLogic(args, exec) }
    }))
    harness.registerTool(ctx, harness.defineTool({
      name: provider.tools.status.name,
      description: provider.tools.status.description,
      parameters: provider.tools.status.inputSchema,
      output: { schema: OUTPUT_SCHEMA, render: function (args, value) { return renderStatus(value, provider) } },
      execute: function (args) { return provider.statusToolLogic(args) }
    }))
    // mimo_settings：沙箱无 nodeFs → 描述符内部自动降级为回显（不持久化）。
    for (const et of provider.extraTools) {
      harness.registerTool(ctx, harness.defineTool({
        name: et.name,
        description: et.description,
        parameters: et.inputSchema,
        output: { schema: OUTPUT_SCHEMA, render: function (args, value) { return (et.render || function (a2, v2) { return renderResult(v2, provider) })(args, value) } },
        execute: function (args, exec) { return et.logic(args, exec) }
      }))
    }

    // 浏览器指示灯轮询的 RPC 面（旧 dynamic/handle('mimo_status') 语义）。
    harness.handle('mimo_status', function () { return provider.statusToolLogic({}) })

    // 旧 policy 文案 verbatim（提示词连续性红线）。
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

    ctx.systemPrompt.section({
      name: 'mimo:policy',
      order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
      text: policyText
    })
  }
}
