// scripts/build.mjs — 派生产物生成器（keystone）。
//
// 生成物（勿手改；`--check` 模式漂移即失败，npm test 里的 build-sync 测试调用它）：
//   1. dynamic/<id>.host.js            ← dynamic/<id>.host.template.mjs
//      把 core/bridge-kit.mjs 内联进 /*__KIT__*/、providers/<id>.mjs 内联进
//      /*__PROVIDER__*/、core/scheduling.mjs（+SCHED_ALL_IDS 常量）内联进
//      /*__SCHED__*/（动态沙箱禁止 import，只能文本注入；单标记替换防递归错乱）。
//      注入时剥离各段的 `import ... from '...mjs'` 行并把 `export ` 关键字去掉。
//   2. preset/<id>/agent.cordis.yml    ← preset/<id>/plugin-list.mjs（唯一权威源）
//      纯 JS 插件清单落地为 legacy 目录形态 YAML（{__jsExpr} → !!js 块）。
//      两者同源生成，结构性消除「yml 与声明制漂移」这一历史风险。
//   3. home-plugin/cli-bridge-indicator/lib/preset-definitions/<id>.mjs
//      ← 同上（声明制形态：插件数组直接给 agentPresets.register 消费）。
//      ⚠️ 这一份由 preset-declarations.mjs 直接 import plugin-list，本脚本不再复制；
//      保留目录仅作兼容占位（旧版生成物清理）。
//
// 用法：node scripts/build.mjs [--check]

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { PROVIDER_IDS } from '../providers/registry.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 单一 id 轴：新 provider 只改 registry（PROVIDER-CONTRACT.md §3.1），build 派生
// 物（dynamic 宿主 / SCHED_ALL_IDS 内联 / legacy YAML / plugin-list）自动跟上。
const ids = PROVIDER_IDS
const PKG = '@luchenglong/cli-bridge'

const MODE = process.argv.includes('--check') ? 'check' : 'write'
// --only=<id> 让单个 provider 的作者只生成/校验自己的派生物，避免并发写他人产物。
const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const ONLY = onlyArg ? onlyArg.slice('--only='.length) : null
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
function stripModuleSyntax(src, label) {
  // 多行 import（`import {\n a, b\n} from '...'`）在单行过滤下会残留 `import ` 前缀并
  // 触发下面的守卫误报 —— 先把跨行 import 折叠成一行再过滤（与单行同规则）。
  const collapsed = src.replace(
    /^\s*import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?\s*$/gms,
    (m) => '// ' + m.replace(/\s+/g, ' ').trim()
  )
  const out = collapsed
    .split('\n')
    .filter((l) => !/^\s*import\s[^(]*from\s*['"][^'"]+['"];?\s*$/.test(l) && !/^\s*import\s*['"]/.test(l))
    .join('\n')
    // 缩进形态也要剥：`export function f()` 可能带前导空格（从 descriptor 闭包里
    // 搬出来的函数保留原缩进），只匹配行首会漏掉 → 残留 export 在脚本体里直接语法错。
    .replace(/^(\s*)export\s+(const|let|var|function|async function|class)\s/gm, '$1$2 ')
    .replace(/^(\s*)export\s+default\s+(async\s+)?function\s+([A-Za-z0-9_$]+)\s*/gm, '$1$2function $3 ')
    .replace(/^(\s*)export\s+default\s+(async\s+)?function\s*\(/gm, '$1$2function __default__(')
    .replace(/^(\s*)export\s*\{[^}]*\};?\s*$/gm, '')
  // 内联目标是「脚本体」：残留的 export default/import 说明源用了本转换器不支持
  // 的形态。静默产出坏代码会让 dynamic host 在沙箱里炸得莫名其妙，必须大声失败。
  if (/^\s*(export\s+default|import\s|import\()/m.test(out)) {
    throw new Error('build: ' + (label || 'source') + ' 用了沙箱内联不支持的模块形态（provider 需具名 `export default function defineProvider(...)`；bridge-kit 不得 import）')
  }
  return out
}

function buildDynamicHost(id) {
  const tplRel = 'dynamic/' + id + '.host.template.mjs'
  if (!existsSync(join(ROOT, tplRel))) return null
  const tpl = read(tplRel)
  const kit = stripModuleSyntax(read('core/bridge-kit.mjs'), 'core/bridge-kit.mjs')
  const prov = stripModuleSyntax(read('providers/' + id + '.mjs'), 'providers/' + id + '.mjs')
  // 调度单源（0.2.0）：core/scheduling.mjs 无 import，可安全内联进沙箱作用域。
  // SCHED_ALL_IDS 由构建注入（全量 provider 清单）—— 沙箱禁 import，拿不到 registry。
  // 模板没有 /*__SCHED__*/ 占位（旧模板）→ 不注入，保持向后兼容。
  const sched = stripModuleSyntax(read('core/scheduling.mjs'), 'core/scheduling.mjs')
    + '\nconst SCHED_ALL_IDS = ' + JSON.stringify(ids) + '\n'
  // 可选的多段内联：providers/<id>-*.mjs（如 <id>-catalog.mjs、<id>-models-tool.mjs）。
  // 语义与 __SCHED__ 同构（模板没有该占位符 → 不注入，向后兼容）。
  // 目的：providers/<id>.mjs 超 600 行红线时把纯逻辑拆出去，沙箱里仍是**单脚本**。
  // 支持多个片文件（按文件名字典序拼接）而不是写死一个：每撞一次 600 行红线就改一次
  // 构建器的做法不可持续，泛用性与顺序确定性都要有。
  const extraFiles = readdirSync(join(ROOT, 'providers'))
    .filter((f) => f.startsWith(id + '-') && f.endsWith('.mjs'))
    .sort()
  const extra = extraFiles.length
    ? extraFiles.map((f) => {
        const rel = 'providers/' + f
        return '// ── inlined from ' + rel + ' ──\n' + stripModuleSyntax(read(rel), rel)
      }).join('\n')
    : null
  if (!tpl.includes('/*__KIT__*/') || !tpl.includes('/*__PROVIDER__*/')) {
    throw new Error(tplRel + ' missing /*__KIT__*/ or /*__PROVIDER__*/ placeholder')
  }
  let out = tpl.replace('/*__KIT__*/', () => kit).replace('/*__PROVIDER__*/', () => prov)
  // __EXTRA__ 放在 KIT/PROVIDER 之后替换：避免其内容里若含同名占位符被二次展开。
  if (out.includes('/*__EXTRA__*/')) {
    if (!extra) throw new Error(tplRel + ': __EXTRA__ placeholder present but no providers/' + id + '-*.mjs fragment found')
    out = out.replace('/*__EXTRA__*/', () => extra)
  } else if (tpl.includes('/*__EXTRA__*/')) throw new Error(tplRel + ': __EXTRA__ placeholder vanished after other replacements')
  if (out.includes('/*__SCHED__*/')) out = out.replace('/*__SCHED__*/', () => sched)
  else if (tpl.includes('/*__SCHED__*/')) throw new Error(tplRel + ': __SCHED__ placeholder vanished after other replacements')
  return out
}

for (const id of ids) {
  if (ONLY && id !== ONLY) continue
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

function yamlEntry(entry, indent) {
  // 递归序列化一个插件条目。字段序与官方 patch.yml 习惯一致：
  // id → name → entry → group → isolate → disabled/if → config。
  const pad = ' '.repeat(indent)
  const lines = [pad + '- id: ' + yamlString(entry.id)]
  if (entry.name !== undefined) lines.push(pad + '  name: ' + yamlString(entry.name))
  if (entry.entry !== undefined) lines.push(pad + '  entry: ' + yamlString(entry.entry))
  if (entry.group === true) lines.push(pad + '  group: true')
  if (entry.isolate && typeof entry.isolate === 'object') {
    lines.push(pad + '  isolate:')
    for (const k of Object.keys(entry.isolate)) lines.push(pad + '    ' + k + ': ' + String(entry.isolate[k]))
  }
  for (const k of ['disabled', 'if']) {
    if (entry[k] === undefined) continue
    const v = entry[k]
    if (v && typeof v === 'object' && typeof v.__jsExpr === 'string') lines.push(pad + '  ' + k + ": !!js '" + String(v.__jsExpr).replace(/'/g, "''") + "'")
    else lines.push(pad + '  ' + k + ': ' + String(v))
  }
  if (entry.config !== undefined) {
    if (Array.isArray(entry.config)) {
      lines.push(pad + '  config:')
      if (!entry.config.length) lines[lines.length - 1] = pad + '  config: []'
      for (const child of entry.config) lines.push(yamlEntry(child, indent + 4))
    } else if (entry.config && typeof entry.config === 'object') {
      lines.push(yamlConfig(entry.config, indent + 2))
    } else {
      lines.push(pad + '  config: ' + yamlString(entry.config))
    }
  }
  return lines.join('\n')
}

function yamlValue(v) {
  // '' 返回值 = 「值是嵌套结构/多行文本，需换行展开」；否则返回 ' 标量' 后缀。
  if (v && typeof v === 'object' && typeof v.__jsExpr === 'string') return " !!js '" + String(v.__jsExpr).replace(/'/g, "''") + "'"
  if (Array.isArray(v)) return v.length ? '' : ' []'
  if (v && typeof v === 'object') return ''
  if (typeof v === 'string') { if (v.indexOf('\n') >= 0) return ''; return ' ' + yamlString(v) }
  return ' ' + String(v)
}

// 多行字符串 → YAML 块标量（'|' 保留结尾单换行；'|-' 裁掉）。行内引号折叠会改变
// 文本语义（plan-mode 段含逐字换行），必须用块标量原样落地。
function yamlBlockKey(key, v, keyPad, valPad) {
  const clip = v.endsWith('\n') ? '|' : '|-'
  const body = (clip === '|' ? v.replace(/\n$/, '') : v).split('\n')
  const lines = [keyPad + key + ': ' + clip]
  for (const l of body) lines.push(l === '' ? '' : valPad + l)
  return lines
}

function yamlConfig(config, indent) {
  // indent：'config:' 键本身的列；子键 +2。
  const pad = ' '.repeat(indent)
  const lines = [pad + 'config:']
  for (const k of Object.keys(config)) {
    const v = config[k]
    const inline = yamlValue(v)
    if (inline !== '') { lines.push(pad + '  ' + k + ':' + inline); continue }
    if (typeof v === 'string') { lines.push(...yamlBlockKey(k, v, pad + '  ', pad + '    ')); continue }
    if (Array.isArray(v)) {
      lines.push(pad + '  ' + k + ':')
      for (const item of v) {
        if (item && typeof item === 'object' && !item.__jsExpr) {
          const keys = Object.keys(item)
          lines.push(pad + '    - ' + keys[0] + ': ' + yamlString(item[keys[0]]))
          for (let i = 1; i < keys.length; i++) lines.push(pad + '      ' + keys[i] + ': ' + yamlString(item[keys[i]]))
        } else lines.push(pad + '    - ' + yamlString(item))
      }
    } else {
      lines.push(pad + '  ' + k + ':')
      lines.push(yamlInlineObject(v, indent + 4))
    }
  }
  return lines.join('\n')
}

function yamlInlineObject(obj, indent) {
  const pad = ' '.repeat(indent)
  const lines = []
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    const inline = yamlValue(v)
    if (inline !== '') lines.push(pad + k + ':' + inline)
    else if (typeof v === 'string') lines.push(...yamlBlockKey(k, v, pad, pad + '  '))
    else {
      lines.push(pad + k + ':')
      if (Array.isArray(v)) { for (const item of v) lines.push(pad + '  - ' + yamlString(item)) }
      else lines.push(yamlInlineObject(v, indent + 2))
    }
  }
  return lines.join('\n')
}

const PRESET_DIRS = { agy: 'agy-first', codebuddy: 'codebuddy-first', mimo: 'mimo-first', opencode: 'opencode-first' }

async function loadPluginList(id) {
  const rel = 'preset/' + PRESET_DIRS[id] + '/plugin-list.mjs'
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return null
  const mod = await import(pathToFileURL(abs).href)
  return mod
}

for (const id of ids) {
  if (ONLY && id !== ONLY) continue
  const mod = await loadPluginList(id)
  if (!mod || typeof mod.buildPlugins !== 'function') continue
  const dir = PRESET_DIRS[id]
  const meta = mod.meta || {}
  const plugins = mod.buildPlugins({ bridgeName: PKG + '/preset-' + id })
  const head = [
    '# 生成物 — 由 node scripts/build.mjs 从 preset/' + dir + '/plugin-list.mjs 生成，勿手改。',
    '# legacy 目录形态（$DSH_HOME/.agent-presets/' + meta.id + '/）；新 DSH 走声明制',
    '# （home-plugin/cli-bridge-indicator/lib/preset-declarations.mjs 直接 import 同一源）。',
    ''
  ].join('\n')
  const body = plugins.map((e) => yamlEntry(e, 0)).join('\n')
  emit('preset/' + dir + '/agent.cordis.yml', head + body + '\n')
  emit('preset/' + dir + '/preset.yml', [
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
