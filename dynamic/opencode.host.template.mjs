// dynamic/opencode.host.template.mjs — opencode 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=opencode）把 core/bridge-kit.mjs 与
// providers/opencode.mjs 分别内联进下方两个占位标记行（各占一行、行内仅此标记），
// 第三个占位标记行负责内联 providers/opencode-*.mjs 片文件（可执行探测/模型解析），
// 生成 dynamic/opencode.host.js。注意：标记字面量绝不能出现在本注释里 —— 构建做全局
// 替换，注释中出现同样会被替换成正文代码而炸掉语法。
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生
//    定时器 —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层
//    return 合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('opencode', snap)
//    推给家级灯；动态形态不宣告 mode（旧语义：普通模式灯仅在调用时临时显示）。
/*__KIT__*/
/*__PROVIDER__*/
/*__EXTRA__*/
/*__SCHED__*/

return {
  inject: ['tools', 'subprocess', 'systemPrompt', 'timer'],
  apply(ctx) {
    // 调度门禁（0.2.0）：设置面板关掉 opencode → 本形态不注册工具/政策段；fail-open。
    if (!isBridgeEnabled('opencode', SCHED_ALL_IDS)) return
    const subprocess = ctx.subprocess
    const sandboxPolicy = ctx.get('sandboxPolicy')
    // 沙箱可能运行在无 process 的环境：typeof 守卫读 env（旧仓 dynamic 的等价面）。
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}

    const provider = defineProvider({ env })

    function publish(snapshot) {
      try {
        const collector = ctx.get('cliBridgeCollector')
        if (collector && typeof collector.mergeSnapshot === 'function') { collector.mergeSnapshot('opencode', snapshot); return }
      } catch (e) { /* fall through to legacy alias */ }
      try {
        const legacy = ctx.get('opencodeCollector')
        if (legacy && typeof legacy.mergeSnapshot === 'function') legacy.mergeSnapshot(snapshot)
      } catch (e) { /* 灯数据尽力而为 */ }
    }

    // exe 优先级（与描述符同一套）：env OPENCODE_BIN/OPENCODE_CLI > 桌面版 V2 探测
    // > PATH 查找 opencode-cli（subprocess.resolveExecutable）。
    // 二进制名 opencode-cli（V2 桌面版），不做 opencode.exe 兜底（V1/V2 不能并存）。
    const exeCandidates = resolveExePrefix(env, '')
    async function resolveExe(backend, signal) {
      for (const c of exeCandidates) {
        if (/\.(mjs|cjs|js)$/i.test(c) && typeof process !== 'undefined' && process.execPath) return [process.execPath, c]
        return c
      }
      return await subprocess.resolveExecutable('opencode-cli', undefined, signal)
    }

    // cwd 兜底：OPENCODE_MCP_CWD > sandboxPolicy.workspaceRoot > process.cwd() > '.'。
    function getCwdFallback() {
      if (env.OPENCODE_MCP_CWD) return String(env.OPENCODE_MCP_CWD)
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
      if (typeof process !== 'undefined' && typeof process.cwd === 'function') { try { return process.cwd() } catch (e) {} }
      return '.'
    }

    provider.attach({ ctx, subprocess, resolveExe, getCwdFallback, publish })

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

    // 浏览器指示灯轮询的 RPC 面（旧 dynamic/handle('<id>_status') verbatim 语义）。
    harness.handle('opencode_status', function () { return provider.statusToolLogic({}) })

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
      '- Prefer a free model for routine work: pass a model id ending in -free (e.g. "opencode/nemotron-3-ultra-free") unless this task genuinely needs a frontier model.',
      '- Omit the model unless you have a reason: opencode then uses its own configured default (or the one chosen in CLI Bridge settings). Pass model in provider/model form to override.',
      '- Credentials are owned by opencode, not by this bridge: auth/API-key failures mean the user should run `opencode auth login`. Do not retry in a loop.'
    ].join('\n')

    ctx.systemPrompt.section({
      name: 'opencode:policy',
      order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
      text: policyText
    })
  }
}
