// mcp/mimo-mcp-server.mjs — 兼容入口：等价 node mcp/cli-bridge-mcp.mjs --provider=mimo。
// 旧包（mimo-first-bridge）的用户迁移时只需把 MCP 配置的 args 换成本文件路径，
// 其余（env 变量名等）保持 mimo 侧语义不变。原参数全部保留，前面插入 --provider。
const argv = process.argv.slice(0)
process.argv = [argv[0], argv[1], '--provider=mimo'].concat(argv.slice(2))
await import('./cli-bridge-mcp.mjs')