// mcp/providers/codebuddy.mjs — agy MCP 工具面。
// ⚠️ PLACEHOLDER（Lead 图占位）：真实移植见 PROVIDER-CONTRACT.md §4 + §7-codebuddy。
import { createProvider } from '../../providers/registry.mjs'
export const meta = { id: 'codebuddy', label: 'CODEBUDDY', version: '0.1.0' }
let runtime = null
function ensure(io) {
  if (runtime) return runtime
  const d = createProvider('codebuddy', { env: io.env, process })
  runtime = { descriptor: d }
  return runtime
}
export function tools(env) {
  const d = createProvider('codebuddy', { env })
  return [d.tools.run, d.tools.continue, d.tools.status].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
}
export async function call(name, args, io) {
  const r = ensure(io)
  const d = r.descriptor
  const exec = null
  let res
  if (name === 'codebuddy_status') res = d.statusToolLogic(args)
  else res = await d.runToolLogic(args, exec)
  return JSON.stringify(res).slice(0, 8000)
}
export function check(env) { return true }