// scripts/build.mjs — 派生产物生成器（keystone）。
//
// 生成物（勿手改；`--check` 模式漂移即失败，npm test 里的 build-sync 测试调用它）：
//   1. dynamic/<id>.host.js            ← dynamic/<id>.host.template.mjs
//      把 core/bridge-kit.mjs 内联进 /*__KIT__*/、providers/<id>.mjs 内联进
//      /*__PROVIDER__*/（动态沙箱禁止 import，只能文本注入；单标记替换防递归错乱）。
//      注入时剥离两段的 `import ... from '...mjs'` 行并把 `export ` 关键字去掉。
//   2. preset/<id>/agent.cordis.yml    ← preset/<id>/plugin-list.mjs（唯一权威源）
//      纯 JS 插件清单落地为 legacy 目录形态 YAML（{__jsExpr} → !!js 块）。
//      两者同源生成，结构性消除「yml 与声明制漂移」这一历史风险。
//   3. home-plugin/cli-bridge-indicator/lib/preset-definitions/<id>.mjs
//      ← 同上（声明制形态：插件数组直接给 agentPresets.register 消费）。
//      ⚠️ 这一份由 preset-declarations.mjs 直接 import plugin-list，本脚本不再复制；
//      保留目录仅作兼容占位（旧版生成物清理）。
//
// 用法：node scripts/build.mjs [--check]

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ids = ['agy', 'codebuddy', 'mimo']
const PKG = '@luchenglong/cli-bridge'

const MODE = process.argv.includes('--check') ? 'check' : 'write'
const drift = []

function read(rel) { return readFileSync(join(ROOT, rel), 'utf8') }

function emit(rel, content) {
  const abs = join(ROOT, rel)
  if (MODE === 'check') {
    const cur = existsSync(abs) ? readFileSync(abs, 'utf8') : null
    if (cur !== content) drift.push(rel)
    return
  }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  console.log('generated ' + rel)
}

// ── 1. dynamic host（文本内联，沙箱禁 import）──────────────────────────────────
function stripModuleSyntax(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*import\s[^(]*from\s*['"][^'"]+['"];?\s*$/.test(l) && !/^\s*import\s*['"]/.test(l))
    .join('\n')
    .replace(/^export\s+(const|let|var|function|async function|class)\s/gm, '$1 ')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
}

function buildDynamicHost(id) {
  const tplRel = 'dynamic/' + id + '.host.template.mjs'
  if (!existsSync(join(ROOT, tplRel))) return null
  const tpl = read(tplRel)
  const kit = stripModuleSyntax(read('core/bridge-kit.mjs'))
  const prov = stripModuleSyntax(read('providers/' + id + '.mjs'))
  if (!tpl.includes('/*__KIT__*/') || !tpl.includes('/*__PROVIDER__*/')) {
    throw new Error(tplRel + ' missing /*__KIT__*/ or /*__PROVIDER__*/ placeholder')
  }
  return tpl.replace('/*__KIT__*/', () => kit).replace('/*__PROVIDER__*/', () => prov)
}

for (const id of ids) {
  const out = buildDynamicHost(id)
  if (out) emit('dynamic/' + id + '.host.js', out)
}

// ── 2. agent.cordis.yml ← plugin-list.mjs ─────────────────────────────────────
function yamlString(v) {
  const s = String(v)
  if (s === '' || /[:#\n'"\[\]{}&*!|>%@`]/.test(s) || /^\s|\s$/.test(s)) {
    return "'" + s.replace(/'/g, "''") + "'"
  }
  return s
}

function yamlBlockScalar(s, indent) {
  const lines = String(s).split('\n')
  return '|\n' + lines.map((l) => indent + l).join('\n')
}

function yamlEntry(entry, indent) {
  // 递归序列化一个插件条目（id/name/config/disabled/plugins/isolate...）。
  const pad = ' '.repeat(indent)
  const lines = [pad + '- id: ' + yamlString(entry.id)]
  if (entry.name) lines.push(pad + '  name: ' + yamlString(entry.name))
  if (entry.entry) lines.push(pad + '  entry: ' + yamlString(entry.entry))
  if (entry.if !== undefined) lines.push(pad + '  if: ' + yamlString(entry.if))
  const rest = Object.keys(entry).filter((k) => ['id', 'name', 'entry', 'if', 'config', 'plugins'].indexOf(k) < 0)
  for (const k of rest) {
    const v = entry[k]
    if (v && typeof v === 'object' && typeof v.__jsExpr === 'string') lines.push(pad + '  ' + k + ': !!js |-\n' + pad + '  ' + v.__jsExpr)
    else if (typeof v === 'boolean' || typeof v === 'number') lines.push(pad + '  ' + k + ': ' + String(v))
    else if (typeof v === 'string') lines.push(pad + '  ' + k + ': ' + yamlString(v))
  }
  if (entry.config) lines.push(yamlConfig(entry.config, pad + '  '))
  if (Array.isArray(entry.plugins)) {
    lines.push(pad + '  plugins: ' + (entry.plugins.length ? '' : '[]'))
    for (const child of entry.plugins) lines.push(yamlEntry(child, indent + 4))
  }
  return lines.join('\n')
}

function yamlConfig(config, indent) {
  const pad = ' '.repeat(indent.length)
  const lines = [pad + 'config:']
  for (const k of Object.keys(config)) {
    const v = config[k]
    if (v && typeof v === 'object' && v.__jsExpr) lines.push(pad + '  ' + k + ': !!js ' + String(v.__jsExpr))
    else if (Array.isArray(v)) lines.push(pad + '  ' + k + ': ' + JSON.stringify(v))
    else if (typeof v === 'boolean' || typeof v === 'number') lines.push(pad + '  ' + k + ': ' + String(v))
    else if (v && typeof v === 'object') { lines.push(pad + '  ' + k + ':'); lines.push(yamlInlineObject(v, indent + 2)) }
    else lines.push(pad + '  ' + k + ': ' + yamlString(v))
  }
  return lines.join('\n')
}

function yamlInlineObject(obj, indent) {
  const pad = ' '.repeat(indent)
  const lines = []
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (v && typeof v === 'object' && v.__jsExpr) lines.push(pad + k + ': !!js ' + String(v.__jsExpr))
    else if (v && typeof v === 'object') { lines.push(pad + k + ':'); lines.push(yamlInlineObject(v, indent + 2)) }
    else if (typeof v === 'string') lines.push(pad + k + ': ' + yamlString(v))
    else lines.push(pad + k + ': ' + String(v))
  }
  return lines.join('\n')
}

async function loadPluginList(id) {
  const rel = 'preset/' + id + '/plugin-list.mjs'
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return null
  const mod = await import(pathToFileURL(abs).href)
  return mod
}

for (const id of ids) {
  const mod = await loadPluginList(id)
  if (!mod || typeof mod.buildPlugins !== 'function') continue
  const meta = mod.meta || {}
  const plugins = mod.buildPlugins({ bridgeName: PKG + '/preset-' + id })
  const head = [
    '// 生成物 — 由 node scripts/build.mjs 从 preset/' + id + '/plugin-list.mjs 生成，勿手改。',
    '// legacy 目录形态（$DSH_HOME/.agent-presets/' + meta.id + '/）；新 DSH 走声明制',
    '// （home-plugin/cli-bridge-indicator/lib/preset-declarations.mjs 直接 import 同一源）。',
    ''
  ].join('\n')
  const body = plugins.map((e) => yamlEntry(e, 0)).join('\n')
  emit('preset/' + id + '/agent.cordis.yml', head + body + '\n')
  emit('preset/' + id + '/preset.yml', [
    'name: ' + yamlString(meta.name || meta.id),
    'description: ' + yamlString(meta.description || ''),
    'order: ' + String(meta.order != null ? meta.order : 10),
    ''
  ].join('\n'))
}

if (drift.length) {
  console.error('[build] drift detected: ' + drift.join(', ') + ' — run `node scripts/build.mjs`')
  process.exit(1)
}
if (MODE === 'check') console.log('[build] up to date')
