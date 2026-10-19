// dynamic/codex.host.template.mjs — codex 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=codex）把 core/bridge-kit.mjs、providers/codex.mjs、
// providers/codex-*.mjs 片文件、core/scheduling.mjs 分别内联进下方四个占位标记行
// （各占一行、行内仅此标记），生成 dynamic/codex.host.js。
// 注意：标记字面量绝不能出现在本文件注释里 —— 构建做全局文本替换，注释中出现同样会被
// 替换成正文代码而炸掉语法（历史事故）。
//
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生
//    定时器 —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层
//    return 合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('codex', snap)
//    推给家级灯；动态形态不宣告 mode（普通模式灯仅在调用时临时显示）。
/*__KIT__*/
/*__PROVIDER__*/
/*__EXTRA__*/
/*__SCHED__*/

return {
  inject: ['tools', 'subprocess', 'systemPrompt', 'timer'],
  apply(ctx) {
    // 调度门禁（0.2.0）：设置面板关掉 codex → 本形态不注册工具/政策段；fail-open。
    if (!isBridgeEnabled('codex', SCHED_ALL_IDS)) return
    const subprocess = ctx.subprocess
    const sandboxPolicy = ctx.get('sandboxPolicy')
    // 沙箱可能运行在无 process 的环境：typeof 守卫读 env（旧仓 dynamic 的等价面）。
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}

    const provider = defineProvider({ env })

    function publish(snapshot) {
      try {
        const collector = ctx.get('cliBridgeCollector')
        if (collector && typeof collector.mergeSnapshot === 'function') { collector.mergeSnapshot('codex', snapshot); return }
      } catch (e) { /* fall through to legacy alias */ }
      try {
        const legacy = ctx.get('codexCollector')
        if (legacy && typeof legacy.mergeSnapshot === 'function') legacy.mergeSnapshot(snapshot)
      } catch (e) { /* 灯数据尽力而为 */ }
    }

    // exe 优先级（与描述符同一套）：CODEX_BIN > CODEX_CLI > CODEX_CLI_PATH > PATH 的 codex。
    // .js/.mjs 目标经 process.execPath 包装（测试夹具形态）；绝对路径直接交 spawn；
    // .cmd/.bat shim 明确拒绝（无 shell spawn 不解析它，走 shell 会二次解释 prompt）。
    const exeCandidates = codexExeCandidates(env)
    async function resolveExe(backend, signal) {
      let bare = ''
      for (let i = 0; i < exeCandidates.length; i++) {
        const c = exeCandidates[i]
        const shim = codexShimRejectReason(c)
        if (shim) throw new Error(shim)
        if (/\.(mjs|cjs|js)$/i.test(c) && typeof process !== 'undefined' && process.execPath) return [process.execPath, c]
        if (/[\\/]/.test(c)) return c
        if (!bare) bare = c
      }
      return await subprocess.resolveExecutable(bare || exeCandidates[exeCandidates.length - 1], undefined, signal)
    }

    // cwd 兜底：CODEX_BRIDGE_CWD > sandboxPolicy.workspaceRoot > process.cwd() > '.'。
    function getCwdFallback() {
      if (env.CODEX_BRIDGE_CWD) return String(env.CODEX_BRIDGE_CWD)
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
      if (typeof process !== 'undefined' && typeof process.cwd === 'function') { try { return process.cwd() } catch (e) { /* 沙箱受限 */ } }
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
    harness.handle('codex_status', function () { return provider.statusToolLogic({}) })

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
      '- codex exec has NO -a/--ask-for-approval flag; approval policy goes through -c approval_policy="…" only when configured. On resume the sandbox also goes through -c ("codex exec resume" has no -s and no -C).',
      '- If the sandbox denies an operation, raise sandboxMode instead of looping retries.',
      '',
      'Execution & Fallback protocol:',
      '- Dispatch defaults to background=true (set background=false only to block). Collect via job_output.',
      '- On rate-limit or network failure, a confirmation dialog opens in BOTH foreground and background while in flight.',
      '- If result has fallback=true (status FALLBACK_TO_DSH), the user chose DSH-local: finish with native tools and NEVER call codex again for this task.',
      '- Never loop codex calls; never ask codex to call back into DSH.',
      '',
      'Models & credentials:',
      '- Omit model unless you have a reason: codex then uses the CLI Bridge settings default, or the model from ~/.codex/config.toml.',
      '- Credentials belong to codex (~/.codex/config.toml model_providers.<name>, auth.json): on auth failures ask the user to run `codex login`; do not retry in a loop.'
    ].join('\n')

    ctx.systemPrompt.section({
      name: 'codex:policy',
      order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
      text: policyText
    })
  }
}
