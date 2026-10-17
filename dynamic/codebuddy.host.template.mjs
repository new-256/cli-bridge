// dynamic/codebuddy.host.template.mjs — codebuddy 动态沙箱宿主模板（cordis_define code.host 源）。
//
// 构建（node scripts/build.mjs --only=codebuddy）把 core/bridge-kit.mjs 与
// providers/codebuddy.mjs 分别内联进下方两个占位标记行（各占一行、行内仅此标记），
// 生成 dynamic/codebuddy.host.js。注意：标记字面量绝不能出现在本注释里 —— 构建做全局
// 替换，注释中出现同样会被替换成正文代码而炸掉语法。
// 沙箱纪律（旧仓 dynamic/host.js 头注 verbatim 精神）：
//  - 禁 import/require、无 TypeScript；无 AbortController/process 裸引用/Buffer/原生
//    定时器 —— process 只经 typeof 守卫探测；宿主能力全部来自注入的 harness.*/ctx。
//  - 顶层 return { inject, apply } 为动态宿主约定形态（生成物是 .js/CJS 包装，顶层
//    return 合法；本模板文件是 .mjs，不要直接 node --check 模板本身，只 check 生成物）。
//  - 无 ctx.emit：状态经 ctx.get('cliBridgeCollector').mergeSnapshot('codebuddy', snap)
//    推给家级灯（旧 codebuddyCollector 服务名在 keystone 里保留别名）；动态形态不宣告
//    mode（旧语义：普通模式灯仅在调用 codebuddy 时临时显示）。
//  - exe 解析保持旧动态三面语义（各产品面登录互斥、不跨面回退）：workbuddy /
//    codebuddy-en 用各自的 Program Files 候选（WORKBUDDY_BIN / CODEBUDDY_EN_BIN 覆盖）；
//    npm 面走 CODEBUDDY_BIN > subprocess.resolveExecutable(PATH) > npm 全局 bin 脚本。
//  - 设置：沙箱经 getBuiltinModule('node:fs') 读一次统一设置文件（apply 时一次，
//    旧 dynamic 语义）；不可得时回退旧扁平文件，再不可得用默认值。EN 面无凭据且
//    无 fs（descriptor 的 dsh-store 通道缺席）→ preflight 确定性 abort 给提示即可。
/*__KIT__*/
/*__PROVIDER__*/
/*__EXTRA__*/
/*__SCHED__*/

return {
  inject: ['tools', 'subprocess', 'systemPrompt', 'timer'],
  apply(ctx) {
    // 调度门禁（0.2.0）：设置面板关掉 codebuddy → 本形态不注册工具/政策段；fail-open。
    if (!isBridgeEnabled('codebuddy', SCHED_ALL_IDS)) return
    const subprocess = ctx.subprocess
    const planMode = ctx.get('planMode')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    // 沙箱可能运行在无 process 的环境：typeof 守卫读 env（旧仓 dynamic 的等价面）。
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}

    const provider = defineProvider({ env })

    function publish(snapshot) {
      try {
        const collector = ctx.get('cliBridgeCollector')
        if (collector && typeof collector.mergeSnapshot === 'function') { collector.mergeSnapshot('codebuddy', snapshot); return }
      } catch (e) { /* fall through to legacy alias */ }
      try {
        const legacy = ctx.get('codebuddyCollector')
        if (legacy && typeof legacy.mergeSnapshot === 'function') legacy.mergeSnapshot(snapshot)
      } catch (e) { /* 灯数据尽力而为 */ }
    }

    // 设置快照（apply 时一次，旧 dynamic 语义）：统一文件 codebuddy 分区 >
    // 旧扁平文件（字段级迁移的只读兜底）> 默认。全程容错，失败不炸 apply。
    const settingsSnapshot = (function () {
      const def = provider.normalizeSettings(null)
      try {
        const proc = (typeof process !== 'undefined') ? process : null
        const nodeFs = proc && typeof proc.getBuiltinModule === 'function' ? proc.getBuiltinModule('node:fs') : null
        const nodePath = proc && typeof proc.getBuiltinModule === 'function' ? proc.getBuiltinModule('node:path') : null
        if (!nodeFs || typeof nodeFs.readFileSync !== 'function') return def
        const join = nodePath ? nodePath.join.bind(nodePath) : ((...p) => p.join('/'))
        const readJson = (p) => { try { return JSON.parse(nodeFs.readFileSync(p, 'utf8')) } catch (e) { return null } }
        const unifiedFile = env.CLI_BRIDGE_SETTINGS_FILE || (env.DSH_HOME ? join(env.DSH_HOME, 'cli-bridge-settings.json') : null)
        const unified = unifiedFile ? readJson(unifiedFile) : null
        if (unified && unified.codebuddy && typeof unified.codebuddy === 'object') return provider.normalizeSettings(unified.codebuddy)
        const legacyFile = env.CODEBUDDY_SETTINGS_FILE || (env.DSH_HOME ? join(env.DSH_HOME, 'codebuddy-bridge-settings.json') : null)
        const legacy = legacyFile ? readJson(legacyFile) : null
        if (legacy && typeof legacy === 'object') return provider.normalizeSettings(legacy)
      } catch (e) { /* 无 fs：默认值，端点走 CLI 自身 */ }
      return def
    })()

    // exe：旧动态三面候选 verbatim（nodeExe 仅在有 process 时有真值，否则退回
    // 字符串 'node' —— 旧 dynamic 同款守卫）。
    async function resolveExe(backend, signal) {
      const nodeExe = (typeof process !== 'undefined' && process.execPath) || 'node'
      if (backend === 'workbuddy') {
        return [nodeExe, env.WORKBUDDY_BIN || 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy']
      }
      if (backend === 'codebuddy-en') {
        return [nodeExe, env.CODEBUDDY_EN_BIN || 'C:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy']
      }
      try {
        const exe = await subprocess.resolveExecutable('codebuddy', undefined, signal)
        if (!/\.(cmd|bat)$/i.test(exe)) return exe
      } catch (e) {}
      const binPath = env.CODEBUDDY_BIN || ((env.APPDATA || 'C:\\Users\\lcl\\AppData\\Roaming') + '\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy')
      return [nodeExe, binPath]
    }

    // 旧仓 CWD_FALLBACK 硬编码机器绝对路径：本形态保持旧 dynamic verbatim 行为
    // （Lead 定案：与旧 dynamic 逐字一致；CODEBUDDY_MCP_CWD 优先仅为 MCP 面语义，
    // 旧 dynamic 不读它）。
    function getCwdFallback() {
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) return sandboxPolicy.workspaceRoot
      if (typeof process !== 'undefined' && typeof process.cwd === 'function') { try { return process.cwd() } catch (e) {} }
      return 'C:\\Users\\lcl\\Desktop\\codebuddy-bridge'
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

    provider.attach({
      ctx,
      subprocess,
      resolveExe,
      getCwdFallback,
      getPreferredBackend: function () { return settingsSnapshot.preferredBackend || provider.defaultBackend },
      getSettings: function () { return settingsSnapshot },
      planActiveFor,
      publish
    })

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
    for (const et of provider.extraTools) {
      harness.registerTool(ctx, harness.defineTool({
        name: et.name,
        description: et.description,
        parameters: et.inputSchema,
        output: { schema: OUTPUT_SCHEMA, render: function (args, value) { return et.render ? et.render(value) : renderResult(value, provider) } },
        execute: function (args, exec) { return et.logic(args, exec) }
      }))
    }

    // 浏览器指示灯轮询的 RPC 面（旧 dynamic/handle('codebuddy_status') 语义）。
    harness.handle('codebuddy_status', function () { return provider.statusToolLogic({}) })

    // 旧 policy 文案 verbatim（提示词连续性红线；name/order 沿用旧 preset 的 5，
    // 动态与 preset 两形态注入同一段全文，provider.policyText 单源）。
    ctx.systemPrompt.section({
      name: 'codebuddy:policy',
      order: 5,
      text: provider.policyText
    })
  }
}
