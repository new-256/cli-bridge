// dynamic/agy.host.template.mjs — agy 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=agy）把 core/bridge-kit.mjs 与
// providers/agy.mjs 分别内联进下方两个占位标记行（各占一行、行内仅此标记），
// 生成 dynamic/agy.host.js。注意：标记字面量绝不能出现在本注释里 —— 构建做全局
// 替换，注释中出现同样会被替换成正文代码而炸掉语法。
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生
//    定时器 —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层
//    return 合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('agy', snap)
//    推给家级灯（旧 agyCollector 服务名在 keystone 里保留别名）；动态形态不宣告
//    mode（旧语义：普通模式灯仅在调用 agy 时临时显示）。
//  - agy_quota 与 5h 额度门禁在沙箱形态省略（deps 无 process/nodeChild → 描述符
//    静默降级；Lead 定案 4）。
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
        if (collector && typeof collector.mergeSnapshot === 'function') { collector.mergeSnapshot('agy', snapshot); return }
      } catch (e) { /* fall through to legacy alias */ }
      try {
        const legacy = ctx.get('agyCollector')
        if (legacy && typeof legacy.mergeSnapshot === 'function') legacy.mergeSnapshot(snapshot)
      } catch (e) { /* 灯数据尽力而为 */ }
    }

    // exe：AGY_BIN/AGY_CLI env > PATH 查找 agy（subprocess.resolveExecutable）。
    async function resolveExe(backend, signal) {
      const bin = env.AGY_BIN || env.AGY_CLI || ''
      if (bin) {
        if (/\.(mjs|cjs|js)$/i.test(bin) && typeof process !== 'undefined' && process.execPath) return [process.execPath, bin]
        return bin
      }
      return await subprocess.resolveExecutable('agy', undefined, signal)
    }

    // 旧仓 CWD_FALLBACK 硬编码机器绝对路径；新语义：AGY_MCP_CWD > workspaceRoot > '.'
    //（沙箱无 process.cwd 可用时以 '.' 交给宿主进程工作目录兜底）。
    function getCwdFallback() {
      if (env.AGY_MCP_CWD) return String(env.AGY_MCP_CWD)
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
      if (typeof process !== 'undefined' && typeof process.cwd === 'function') { try { return process.cwd() } catch (e) {} }
      return '.'
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

    provider.attach({ ctx, subprocess, resolveExe, getCwdFallback, planActiveFor, publish })

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

    // 浏览器指示灯轮询的 RPC 面（旧 dynamic/handle('agy_status') verbatim 语义）。
    harness.handle('agy_status', function () { return provider.statusToolLogic({}) })

    // 旧 policy 文案 verbatim（提示词连续性红线）。
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

    ctx.systemPrompt.section({
      name: 'agy:policy',
      order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
      text: policyText
    })
  }
}
