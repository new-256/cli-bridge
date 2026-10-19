// dynamic/claude.host.template.mjs — claude 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=claude）把 core/bridge-kit.mjs、providers/claude.mjs、
// providers/claude-*.mjs 片文件（含 claude-policy.mjs）与 core/scheduling.mjs 分别内联进下方
// 四个占位标记行（各占一行、行内仅此标记），生成 dynamic/claude.host.js。
// 注意：标记字面量绝不能出现在本注释里 —— 构建做全局替换，注释中出现同样会被替换成正文
// 代码而炸掉语法。
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生定时器
//    —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层 return
//    合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('claude', snap) 推给
//    家级灯（旧 claudeCollector 别名保留兼容）；动态形态不宣告 mode。
/*__KIT__*/
/*__PROVIDER__*/
/*__EXTRA__*/
/*__SCHED__*/

return {
  inject: ['tools', 'subprocess', 'systemPrompt', 'timer'],
  apply(ctx) {
    // 调度门禁：设置面板关掉 claude → 本形态不注册工具/政策段；fail-open。
    if (!isBridgeEnabled('claude', SCHED_ALL_IDS)) return
    const subprocess = ctx.subprocess
    const sandboxPolicy = ctx.get('sandboxPolicy')
    // 沙箱可能运行在无 process 的环境：typeof 守卫读 env（旧仓 dynamic 的等价面）。
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}

    const provider = defineProvider({ env })

    function publish(snapshot) {
      try {
        const collector = ctx.get('cliBridgeCollector')
        if (collector && typeof collector.mergeSnapshot === 'function') { collector.mergeSnapshot('claude', snapshot); return }
      } catch (e) { /* fall through to legacy alias */ }
      try {
        const legacy = ctx.get('claudeCollector')
        if (legacy && typeof legacy.mergeSnapshot === 'function') legacy.mergeSnapshot(snapshot)
      } catch (e) { /* 灯数据尽力而为 */ }
    }

    // exe 优先级（与描述符同一套）：env CLAUDE_BIN/CLAUDE_CLI/CLAUDE_CODE_BIN > 已知本地安装
    // > PATH 名 claude（subprocess.resolveExecutable 兜底）。动态沙箱拿不到设置面板值。
    const exeCandidates = claudeExeCandidates(env, '')
    async function resolveExe(backend, signal) {
      for (const c of exeCandidates) {
        if (!c) continue
        if (/\.(mjs|cjs|js)$/i.test(c) && typeof process !== 'undefined' && process.execPath) return [process.execPath, c]
        return c
      }
      return await subprocess.resolveExecutable('claude', undefined, signal)
    }

    // cwd 兜底：CLAUDE_MCP_CWD > sandboxPolicy.workspaceRoot > process.cwd() > '.'。
    function getCwdFallback() {
      if (env.CLAUDE_MCP_CWD) return String(env.CLAUDE_MCP_CWD)
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
    // 附加工具（claude_models）：render 适配 harness 契约 render(args, value)。
    for (const et of (provider.extraTools || [])) {
      harness.registerTool(ctx, harness.defineTool({
        name: et.name,
        description: et.description,
        parameters: et.inputSchema,
        output: { schema: OUTPUT_SCHEMA, render: function (args, value) { return et.render ? et.render(args, value) : renderResult(value, provider) } },
        execute: function (args, exec) { return et.logic(args, exec) }
      }))
    }

    // 浏览器指示灯轮询的 RPC 面（旧 dynamic handle('<id>_status') verbatim 语义）。
    harness.handle('claude_status', function () { return provider.statusToolLogic({}) })

    ctx.systemPrompt.section({
      name: 'claude:policy',
      order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
      text: POLICY_TEXT
    })
  }
}
