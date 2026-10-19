#!/usr/bin/env node
// scripts/register-global-mcp.mjs — 把 CLI Bridge 的聚合 MCP 注册为 DSH **家级**（所有会话可见）。
//
// 为什么需要这一步：本包的 provider 工具只在两种情况下存在 ——
//   ① 用了本包的 agent preset（claude-first 等）；② 注册了 MCP。
// 普通会话（standard preset）两者都没有，于是「装了插件却看不到任何工具」，状态灯也永远不亮。
// 这就是本脚本存在的理由。
//
// 设计取舍：
//   • 直接指向 npm 已安装包内的 mcp/cli-bridge-mcp.mjs，**不复制副本** —— 升级包后重启即生效，
//     不会出现「bin 里是旧副本、包是新版」的版本漂移。
//   • command 用 DSH 自带 node.exe 的绝对路径，不依赖 PATH。
//   • 写入前备份、写入后立即用 yaml 解析校验，校验失败自动回滚（家级补丁写错会让所有会话起不来）。
//   • 幂等：已存在同 id 条目则跳过。
//
// 用法：
//   node scripts/register-global-mcp.mjs            # 注册（或报告已注册）
//   node scripts/register-global-mcp.mjs --dry-run  # 只报告将要做什么
//   node scripts/register-global-mcp.mjs --remove   # 撤销注册
//
// 之后必须重启 DSH（host 组合变更热加载不可靠）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ENTRY_ID = 'mcp-cli-bridge-global'
const SERVER_NAME = 'cli'
const TOOL_TIMEOUT_MS = 900000

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry-run')
const REMOVE = args.has('--remove')

function fail(msg) { console.error('✗ ' + msg); process.exit(1) }
function info(msg) { console.log('  ' + msg) }

/** 定位 dsh-home：优先 DSH_HOME，其次 Windows 默认位置。 */
export function detectDshHome(env = process.env) {
  const cands = []
  if (env.DSH_HOME) cands.push(env.DSH_HOME)
  if (env.APPDATA) cands.push(path.join(env.APPDATA, 'DSH Desktop', 'dsh-home'))
  if (env.HOME) cands.push(path.join(env.HOME, '.dsh'))
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch (e) { } }
  return ''
}

const dshHome = detectDshHome()
if (!dshHome) fail('找不到 dsh-home（试过 DSH_HOME / %APPDATA%\\DSH Desktop\\dsh-home / ~/.dsh）')
info('dsh-home: ' + dshHome)

const patchFile = path.join(dshHome, 'cordis.patch.yml')
if (!fs.existsSync(patchFile)) fail('找不到家级补丁: ' + patchFile)

// 已安装包内的 MCP 入口。**优先用 DSH 里已安装的那份**（稳定路径，随 npm 升级生效）；
// 只有找不到安装包时才回落到本脚本所在仓库（开发态）。若直接写仓库路径，一旦仓库被移动
// 或换台机器就会失效 —— 家级配置必须指向稳定位置。
function findInstalledEntry() {
  const profilesDir = path.join(dshHome, 'profiles')
  const cands = []
  try {
    for (const p of fs.readdirSync(profilesDir)) {
      cands.push(path.join(profilesDir, p, 'node_modules', '@luchenglong', 'cli-bridge', 'mcp', 'cli-bridge-mcp.mjs'))
    }
  } catch (e) { }
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch (e) { } }
  return ''
}
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoEntry = path.join(pkgRoot, 'mcp', 'cli-bridge-mcp.mjs')
const mcpEntry = findInstalledEntry() || repoEntry
if (!fs.existsSync(mcpEntry)) fail('找不到 MCP 入口（安装包与本仓库都没有）: ' + mcpEntry)
info('MCP 入口: ' + mcpEntry + (mcpEntry === repoEntry ? '  ⚠ 取的是仓库路径（未在 dsh-home 里找到已安装包）' : '  (已安装包)'))

// DSH 自带 node（避免 PATH 依赖）；找不到就回落到 process.execPath
const dshNode = path.join(path.dirname(dshHome), 'backend', 'node.exe')
const nodeExe = fs.existsSync(dshNode) ? dshNode : process.execPath
info('node: ' + nodeExe)

// yaml 解析器：优先用 DSH 自带依赖，其次包内 peer
async function loadYaml() {
  const cands = [
    path.join(path.dirname(dshHome), 'backend', 'dsh', 'node_modules', 'yaml', 'index.js'),
    'yaml'
  ]
  for (const c of cands) {
    try { const m = await import(c.startsWith('/') || /^[A-Za-z]:/.test(c) ? 'file:///' + c.replace(/\\/g, '/') : c); return m.default || m } catch (e) { }
  }
  try { return await import('yaml') } catch (e) { }
  return null
}
const YAML = await loadYaml()

const original = fs.readFileSync(patchFile, 'utf8')
const already = original.includes(ENTRY_ID)

if (REMOVE) {
  if (!already) { info('未注册，无需撤销'); process.exit(0) }
  // 删除从注释块起到条目结束（以 "- id: <ENTRY_ID>" 所在 insert 块为单位）
  const lines = original.split('\n')
  const out = []
  let skipping = false
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (!skipping && ln.includes('- id: ' + ENTRY_ID)) {
      // 往回删掉本块已有的 "- insert:" 行
      while (out.length && /^\s*-\s*insert:\s*$/.test(out[out.length - 1])) out.pop()
      skipping = true
      continue
    }
    if (skipping) {
      if (/^\s{0,6}\S/.test(ln) && !/^\s*$/.test(ln) && !/^\s+(config|failOnStartupError|name|args|command|serverName|transport|toolCallTimeoutMs)/.test(ln) && !/^\s{8,}/.test(ln) && !/^\s*#/.test(ln)) skipping = false
      else { continue }
    }
    out.push(ln)
  }
  const nextText = out.join('\n').replace(/\n{3,}/g, '\n\n')
  if (DRY) { info('[dry-run] 将删除条目 ' + ENTRY_ID); process.exit(0) }
  fs.writeFileSync(patchFile + '.bak-remove-' + Date.now(), original, 'utf8')
  fs.writeFileSync(patchFile, nextText, 'utf8')
  info('✓ 已撤销注册（已备份）')
  info('  ⚠ 需重启 DSH 生效')
  process.exit(0)
}

if (already) {
  info('✓ 已注册 ' + ENTRY_ID + '（幂等，未重复写入）')
  info('  ⚠ 若刚改过包版本，重启 DSH 即可加载新版')
  process.exit(0)
}

const block = [
  '',
  '# ══════════════════════════════════════════════════════════════════════════',
  '# CLI Bridge 全局 MCP（家级/host 层）—— 由 scripts/register-global-mcp.mjs 写入',
  '# 把六家 CLI 以【一个聚合 MCP】接进所有会话：',
  '#   mcp__' + SERVER_NAME + '__{agy,codebuddy,mimo,opencode,claude,codex}_{run,continue,status}',
  '# 直接指向安装包内的入口，不复制副本 —— 升级包后重启 DSH 即生效，无版本漂移。',
  '# ⚠ DSH 自带的 subagent_claude_code / subagent_codex 不走本 MCP，',
  '#   它们的调用不会点亮 CLI Bridge 的状态灯（两套实现彼此独立）。',
  '# ⚠ 改此条目后必须重启 DSH（host 组合变更热加载不可靠）。',
  '# ══════════════════════════════════════════════════════════════════════════',
  '- insert:',
  '    - id: ' + ENTRY_ID,
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: ' + SERVER_NAME,
  '        transport: stdio',
  "        command: '" + nodeExe + "'",
  "        args: ['" + mcpEntry + "']",
  '        toolCallTimeoutMs: ' + TOOL_TIMEOUT_MS,
  '      failOnStartupError: false',
  ''
].join('\n')

if (DRY) { info('[dry-run] 将追加注册块到 ' + patchFile); process.exit(0) }

const bak = patchFile + '.bak-before-cli-bridge-mcp-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
fs.writeFileSync(bak, original, 'utf8')
info('已备份: ' + path.basename(bak))

const nextText = original.replace(/\s*$/, '\n') + block
fs.writeFileSync(patchFile, nextText, 'utf8')

// 校验：解析失败或找不到条目 → 回滚（家级补丁坏了会导致所有会话启动失败）
if (YAML) {
  try {
    const doc = YAML.parse(fs.readFileSync(patchFile, 'utf8'))
    let found = null
    const walk = (o) => {
      if (!o || found) return
      if (Array.isArray(o)) return o.forEach(walk)
      if (typeof o === 'object') { if (o.id === ENTRY_ID) { found = o; return } Object.values(o).forEach(walk) }
    }
    walk(doc)
    if (!found) throw new Error('解析后找不到 ' + ENTRY_ID)
    info('✓ YAML 校验通过，条目已就位（serverName=' + found.config.serverName + '）')
  } catch (e) {
    fs.writeFileSync(patchFile, original, 'utf8')
    fail('YAML 校验失败，已回滚: ' + e.message)
  }
} else {
  info('⚠ 未找到 yaml 解析器，跳过结构校验（已保留备份）')
}

info('')
info('✓ 注册完成。现在重启 DSH 使家级组合生效。')
info('  重启后任意会话应能看到 20+ 个 mcp__' + SERVER_NAME + '__* 工具')
info('  （被调度禁用的 provider 不会出现 —— 见设置面板「CLI 调度」）')
