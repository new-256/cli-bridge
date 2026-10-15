// mcp/version.mjs — MCP 工具面版本号单一来源。
//
// 历史问题：四个 provider 的 `meta.version` 与描述符的 `mcp.version` 各自硬编码
// 版本字面量（共 8 处），每次发布必须手工同步 —— 漏改一处就出现「统一 server 报
// 0.2.3、provider 面仍报 0.2.2」的自相矛盾输出（0.2.3 发布时即踩到）。
//
// 契约 §4 要求 provider version「独立跟随本包」—— 跟随 = 同源派生，不是各处抄写。
// 这里从包自身的 package.json 读一次，全包共用。失败时抛错而非静默回落：版本号
// 错误会误导排障，宁可大声失败（红线 7）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
let cached = null

export function packageVersion() {
  if (cached) return cached
  let parsed
  try { parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch (e) {
    throw new Error('mcp/version: cannot read package.json (' + String(e && e.message || e) + ')')
  }
  const v = parsed && parsed.version
  if (typeof v !== 'string' || !v) throw new Error('mcp/version: package.json has no version field')
  cached = v
  return v
}
