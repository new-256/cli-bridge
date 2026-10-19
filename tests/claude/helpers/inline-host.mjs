// tests/claude/helpers/inline-host.mjs — 复刻 scripts/build.mjs 的 dynamic host 内联。
//
// 为什么需要它：dynamic/claude.host.js 由 `node scripts/build.mjs` 生成，而 build 的 id 轴
// 是 providers/registry.mjs 的 PROVIDER_IDS（keystone，由 Lead 统一接入 claude）。本测试
// 属于 provider 自身 scope，必须在「registry 尚未含 claude」的阶段也能验证模板可内联、可
// 语法通过 —— 否则模板缺陷只能在接入后才暴露。
//
// 转换规则与 scripts/build.mjs 的 stripModuleSyntax + buildDynamicHost 逐条对齐
//（keystone 仍是唯一事实来源；此处若有分歧，以 build.mjs 为准）。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROVIDER_IDS } from '../../../providers/registry.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export function stripModuleSyntax(src) {
  const collapsed = src.replace(
    /^\s*import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?\s*$/gms,
    (m) => '// ' + m.replace(/\s+/g, ' ').trim()
  )
  const out = collapsed
    .split('\n')
    .filter((l) => !/^\s*import\s[^(]*from\s*['"][^'"]+['"];?\s*$/.test(l) && !/^\s*import\s*['"]/.test(l))
    .join('\n')
    .replace(/^(\s*)export\s+(const|let|var|function|async function|class)\s/gm, '$1$2 ')
    .replace(/^(\s*)export\s+default\s+(async\s+)?function\s+([A-Za-z0-9_$]+)\s*/gm, '$1$2function $3 ')
    .replace(/^(\s*)export\s+default\s+(async\s+)?function\s*\(/gm, '$1$2function __default__(')
    .replace(/^(\s*)export\s*\{[^}]*\};?\s*$/gm, '')
  if (/^\s*(export\s+default|import\s|import\()/m.test(out)) {
    throw new Error('inline: unsupported module form left in source')
  }
  return out
}

/** 生成 claude 动态宿主的完整源（= build.mjs 对 claude 的产物，模拟 registry 已含 claude）。 */
export function buildClaudeHostSource() {
  const tpl = readFileSync(join(ROOT, 'dynamic/claude.host.template.mjs'), 'utf8')
  const kit = stripModuleSyntax(readFileSync(join(ROOT, 'core/bridge-kit.mjs'), 'utf8'))
  const prov = stripModuleSyntax(readFileSync(join(ROOT, 'providers/claude.mjs'), 'utf8'))
  const schedSrc = stripModuleSyntax(readFileSync(join(ROOT, 'core/scheduling.mjs'), 'utf8'))
  const ids = PROVIDER_IDS.indexOf('claude') < 0 ? PROVIDER_IDS.concat(['claude']) : PROVIDER_IDS.slice()
  const sched = schedSrc + '\nconst SCHED_ALL_IDS = ' + JSON.stringify(ids) + '\n'
  const extraFiles = readdirSync(join(ROOT, 'providers'))
    .filter((f) => f.startsWith('claude-') && f.endsWith('.mjs'))
    .sort()
  if (!extraFiles.length) throw new Error('inline: no providers/claude-*.mjs fragment found')
  const extra = extraFiles.map((f) => {
    const rel = 'providers/' + f
    return '// ── inlined from ' + rel + ' ──\n' + stripModuleSyntax(readFileSync(join(ROOT, rel), 'utf8'))
  }).join('\n')
  if (!tpl.includes('/*__KIT__*/') || !tpl.includes('/*__PROVIDER__*/')) throw new Error('inline: template missing kit/provider marker')
  if (!tpl.includes('/*__EXTRA__*/')) throw new Error('inline: template missing extra marker (claude-*.mjs fragments would be silently dropped)')
  let out = tpl.replace('/*__KIT__*/', () => kit).replace('/*__PROVIDER__*/', () => prov)
  out = out.replace('/*__EXTRA__*/', () => extra)
  out = out.replace('/*__SCHED__*/', () => sched)
  return out
}

/** 该片段文件是否真实存在（测试用它断言片文件清单稳定）。 */
export function fragmentExists(name) {
  return existsSync(join(ROOT, 'providers', name))
}
