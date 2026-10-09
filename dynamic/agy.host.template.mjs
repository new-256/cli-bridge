// dynamic/agy.host.template.mjs — ⚠️ Lead 冒烟夹具（provider-agy 任务会整体替换）。
/*__KIT__*/
/*__PROVIDER__*/
const provider = defineProvider({ env: typeof process !== "undefined" ? process.env : {} })
harness.registerTool(provider.tools.run, (a) => provider.attach({ ctx, subprocess, resolveExe: async () => "agy", getCwdFallback: () => "." , publish: () => {} }).coreExecute(a, null))