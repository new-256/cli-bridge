// dynamic/mimo.host.template.mjs — mimo 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=mimo）把 core/bridge-kit.mjs 与
// providers/mimo.mjs 分别内联进下方两个占位标记行（各占一行、行内仅此标记），
// 生成 dynamic/mimo.host.js。注意：标记字面量绝不能出现在本注释里 —— 构建做全局
// 替换，注释中出现同样也会被替换成正文代码而炸掉语法。
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生
//    定时器 —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层
//    return 合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('mimo', snap)
//    推给家级灯（旧 mimoCollector 服务名在 keystone 里保留别名）；动态形态不宣告
//    mode（旧语义：普通模式灯仅在调用 mimo 时临时显示）。
//  - mimo_settings 在沙箱不持久化（无 nodeFs → 描述符回显语义；旧 dynamic echo 形态）。
//  - 单后端（本地 mimo CLI / MiMoCode）：exe 解析走 agy 模板同款链路 ——
//    MIMO_BIN/MIMO_CLI env > 已知安装位置 > subprocess.resolveExecutable(PATH)。
/*__KIT__*/
/*__PROVIDER__*/
/*__SCHED__*/

return {
  inject: ['tools', 'subprocess', 'systemPrompt', 'timer'],
  apply(ctx) {
    // 调度门禁（0.2.0）：设置面板关掉 mimo → 本形态不注册工具/政策段；fail-open。
    if (!isBridgeEnabled('mimo', SCHED_ALL_IDS)) return
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

    // exe：MIMO_BIN/MIMO_CLI env > 已知安装位置 > PATH 查找 mimo
    // （subprocess.resolveExecutable）。与 descriptor 的 resolveMimoExePrefix 同一套
    // 优先级；.js/.mjs 目标经 process.execPath 包装（供测试 fixture 使用）。
    async function resolveExe(backend, signal) {
      const prefix = resolveMimoExePrefix(env)
      if (prefix.length && prefix[0]) {
        const head = String(prefix[0])
        if (prefix.length > 1) return prefix
        if (/\.(mjs|cjs|js)$/i.test(head) && typeof process !== 'undefined' && process.execPath) return [process.execPath, head]
        return head
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

    // 设置分区（descriptor 的 host.getSettings('mimo') 契约：直接返回分区对象
    // { defaultModel } 或空对象）。每次调用重读统一设置文件 —— 面板改默认模型后
    // 无需重启即生效；读不到（沙箱无 fs / 文件缺失）回落 {} = 不传 --model。
    function getSettings() {
      try {
        const proc = (typeof process !== 'undefined') ? process : null
        const nodeFs = (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('node:fs') : null
        if (!nodeFs || typeof nodeFs.readFileSync !== 'function') return {}
        const nodePath = (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('node:path') : null
        const join = nodePath ? nodePath.join.bind(nodePath) : ((...p) => p.join('/'))
        const file = env.CLI_BRIDGE_SETTINGS_FILE || (env.DSH_HOME ? join(env.DSH_HOME, 'cli-bridge-settings.json') : null)
        if (!file) return {}
        const all = JSON.parse(nodeFs.readFileSync(file, 'utf8'))
        if (all && typeof all === 'object' && all.mimo && typeof all.mimo === 'object') return all.mimo
      } catch (e) { /* 读不到：回落空分区（默认模型为空 → 不传 --model） */ }
      return {}
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

    provider.attach({ ctx, subprocess, resolveExe, getCwdFallback, getSettings, planActiveFor, publish })

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
    // render 适配：harness 契约是 render(args, value)，extraTools[].render 是
    // renderSettings(value) 单参 —— 直接透传会把 args 当 value（渲染全空）。
    for (const et of provider.extraTools) {
      harness.registerTool(ctx, harness.defineTool({
        name: et.name,
        description: et.description,
        parameters: et.inputSchema,
        output: { schema: OUTPUT_SCHEMA, render: function (args, value) { return et.render ? et.render(value) : renderResult(value, provider) } },
        execute: function (args, exec) { return et.logic(args, exec) }
      }))
    }

    // 浏览器指示灯轮询的 RPC 面（旧 dynamic/handle('mimo_status') 语义）。
    harness.handle('mimo_status', function () { return provider.statusToolLogic({}) })

    // 提示词连续性（契约 §8）：决策表 / 上下文协议 / 回退协议三段保留旧语义；后端段与
    // 模型段随「去 desktop 化 + 模型手动指定」重写（免费 API 已终止 + mimo auth login）。
    // 与 preset/mimo-first/cli-bridge.mjs 的 policy 段保持同文。
    const policyText = [
      'mimo-first execution policy (Xiaomi MiMo: MiMoCode CLI).',
      '',
      'Local `mimo` CLI (MiMoCode) handles coding tasks under full DSH control (--dangerously-skip-permissions, never prompts).',
      '',
      'Model:',
      '- The model is chosen in the CLI Bridge settings panel (provider/model form, e.g. xiaomi/mimo-v2.6-flash) — this bridge does not pick one.',
      '- Leave the setting empty to pass no --model, letting the mimo CLI use its own default. A per-call `model` argument overrides the setting for that call only.',
      '- List available models with `mimo models` on this machine.',
      '',
      'Credentials:',
      "- Xiaomi MiMo's free API service has ENDED. The user must run `mimo auth login` (or configure a third-party API) on this machine before dispatch works.",
      '- If a run fails with sign-in / free-API-ended errors, tell the user to log in. Do not retry in a loop.',
      '',
      'By default, dispatch runs in the background and returns a jobId immediately; collect via job_output and watch live progress via mimo_status.',
      '',
      'Decision table for tool selection:',
      '- Single read/glob/grep or short (<30s) command -> Native tools.',
      '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> mimo_run.',
      '- Follow-ups on the same topic -> mimo_continue (with latest=true or sessionId; context is preserved).',
      '- Final build/test verification of mimo output -> Native tools.',
      '- Plan / read-only analysis -> mimo_run with mode=plan.',
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
