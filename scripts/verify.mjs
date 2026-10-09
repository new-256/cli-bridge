#!/usr/bin/env node
// scripts/verify.mjs — 发布前静态红线检查（keystone）。
//
// 背景（历史事故 agy v1.6.1 / codebuddy v1.1.8）：client.js 的注册 id 一旦与包名不
// 一致，整个 client combo 加载失败 → DSH 启动致命屏 → 强制安全模式。npm publish
// 之后才发现 = 必须发新版本撤销，成本极高。本脚本在 prepack/check 里把这些不变量
// 变成机器闸门：
//   1. client.js 的 load({ id }) === package.json name（红线 4）
//   2. bundle patch 行的 name === package.json name
//   3. package.json exports 指向的文件全部存在
//   4. presets 的桥接说明符 === name + '/preset-<id>' 且在 exports 里
//   5. provider 描述符可加载、必备字段齐全（含 tools/settings）
//   6. dsh 字段齐全（client.platform=web、bundle.patch 路径存在）
// 任一失败 → exit 1 并逐条列出。

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const ok = []

function read(rel) { try { return readFileSync(join(ROOT, rel), 'utf8') } catch (e) { return null } }

const pkg = JSON.parse(read('package.json') || '{}')
if (!pkg.name) { console.error('verify: package.json unreadable'); process.exit(1) }
ok.push('package ' + pkg.name + '@' + pkg.version)

// 1. client id 红线
const client = read('home-plugin/cli-bridge-indicator/lib/client.js')
if (client === null) errors.push('client.js missing')
else {
  const m = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)
  if (!m) errors.push('client.js: no __ModuleLoader__.load({ id }) found')
  else if (m[1] !== pkg.name) errors.push('REDLINE client id mismatch: client.js registers "' + m[1] + '" but package name is "' + pkg.name + '" (client combo will fail to load → bricked page)')
  else ok.push('client id === package name (' + m[1] + ')')
}

// 2. bundle patch 行 name
const patch = read('home-plugin/cli-bridge-indicator/cordis.patch.yml')
if (patch === null) errors.push('cordis.patch.yml missing')
else {
  const names = [...patch.matchAll(/^\s*name:\s*'([^']+)'/gm)].map((x) => x[1])
  if (!names.includes(pkg.name)) errors.push('cordis.patch.yml: no row with name ' + pkg.name + ' (rows: ' + names.join(', ') + ')')
  else ok.push('bundle patch row name ok')
}

// 3. exports 文件存在
for (const [spec, rel] of Object.entries(pkg.exports || {})) {
  const p = String(rel).replace(/^\.\//, '')
  if (!existsSync(join(ROOT, p))) errors.push('exports[' + JSON.stringify(spec) + '] -> ' + rel + ' missing')
}
ok.push('exports targets exist (' + Object.keys(pkg.exports || {}).length + ')')

// 4. preset 桥接说明符
const { PROVIDER_IDS, createProvider } = await import(pathToFileURL(join(ROOT, 'providers', 'registry.mjs')).href)
for (const id of PROVIDER_IDS) {
  const exportKey = './preset-' + id
  if (!pkg.exports || !pkg.exports[exportKey]) errors.push('package.json exports[' + exportKey + '] missing (preset bridge row needs it)')
}

// 5. 描述符完整性
for (const id of PROVIDER_IDS) {
  let d
  try { d = createProvider(id, { env: {} }) } catch (e) { errors.push('provider ' + id + ': load failed ' + String(e && e.message || e)); continue }
  const need = ['id', 'label', 'presetId', 'backends', 'normalizeBackend', 'resolveBackend', 'buildArgv', 'parseJson', 'buildResult', 'unavailableStatus', 'tools', 'settings', 'runToolLogic', 'attach']
  for (const k of need) if (d[k] === undefined) errors.push('provider ' + id + ': descriptor missing "' + k + '"')
  for (const t of ['run', 'continue', 'status']) {
    const tool = d.tools && d.tools[t]
    if (!tool || !tool.name || !tool.description || !tool.inputSchema) errors.push('provider ' + id + ': tools.' + t + ' invalid')
  }
  if (d.id !== id) errors.push('provider ' + id + ': descriptor.id = ' + JSON.stringify(d.id))
  if (!d.tools || !d.tools.run || !d.tools.run.name.startsWith(id + '_')) errors.push('provider ' + id + ': tool names must keep <id>_ prefix (prompt continuity)')
  ok.push('provider ' + id + ' descriptor ok (' + [d.tools.run.name, d.tools.continue.name, d.tools.status.name].join(',') + ')')
}

// 6. dsh 字段
if (!pkg.dsh || !pkg.dsh.client || pkg.dsh.client.platform !== 'web') errors.push('package.json dsh.client.platform must be "web"')
const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
if (!patchRel || !existsSync(join(ROOT, String(patchRel).replace(/^\.\//, '')))) errors.push('package.json dsh.bundle.patch target missing')

// 7. 生成物存在（dynamic host / agent yml 至少 plugin-list 在；fresh clone 需先 build）
for (const id of PROVIDER_IDS) {
  if (!read('preset/' + ({ agy: 'agy-first', codebuddy: 'codebuddy-first', mimo: 'mimo-first' })[id] + '/plugin-list.mjs')) errors.push('preset/' + id + ' plugin-list.mjs missing')
}

if (errors.length) {
  console.error('verify: FAILED\n' + errors.map((e) => '  ✗ ' + e).join('\n'))
  process.exit(1)
}
console.log('verify: OK\n' + ok.map((e) => '  ✓ ' + e).join('\n'))
