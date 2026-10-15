#!/usr/bin/env node
// scripts/deploy.mjs — 本地部署暂存（安全版）。
//
// 先跑 build（生成物就位），再把工作树打包到目标目录（排除 .git/node_modules/tests/探针），
// 默认 {DSH_HOME}/staging/cli-bridge/，供停服后手工接线。
//
// ⚠️ 本脚本【不】改 profile 的 package.json / bundles 列表（红线 2：切换运行时接线
// 必须先停 DSH 后端；本次整合的交付决定是「不切」）。挂载步骤见输出提示与 README。
//
// 用法：node scripts/deploy.mjs [--target=<dir>] [--clean]

import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function detectDshHome() {
  const e = process.env
  if (e.DSH_HOME) return e.DSH_HOME
  if (process.platform === 'win32' && e.APPDATA) return join(e.APPDATA, 'DSH Desktop', 'dsh-home')
  if (e.HOME) return join(e.HOME, '.dsh')
  return join(ROOT, '.dsh')
}

const arg = process.argv.find((a) => a.startsWith('--target='))
const target = resolve(arg ? arg.slice('--target='.length) : join(detectDshHome(), 'staging', 'cli-bridge'))
if (target === ROOT) { console.error('deploy: refusing to deploy onto the repo root'); process.exit(1) }
// 目标在仓库内部（含 .tmp）会让 cpSync「复制进自身子目录」直接 EINVAL；提前拦截并给出人话。
const sep = process.platform === 'win32' ? '\\' : '/'
if (target.startsWith(ROOT + sep) || ROOT.startsWith(target + sep)) {
  console.error('deploy: target must be OUTSIDE the repo (got ' + target + '); default is {DSH_HOME}/staging/cli-bridge')
  process.exit(1)
}

const b = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { stdio: 'inherit' })
if (b.status !== 0) { console.error('deploy: build failed'); process.exit(1) }

if (process.argv.includes('--clean') && existsSync(target)) rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

const skip = new Set(['.git', 'node_modules', 'tests', '.probe', '.tmp', 'runtime-data'])
cpSync(ROOT, target, {
  recursive: true,
  filter: (src) => {
    if (src === ROOT) return true
    const rel = src.slice(ROOT.length + 1).split(/[\\/]/)[0]
    return !skip.has(rel)
  }
})

const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
const clientSize = statSync(join(target, 'home-plugin', 'cli-bridge-indicator', 'lib', 'client.js')).size
if (clientSize < 1000) { console.error('deploy: staged client.js looks truncated (' + clientSize + 'B)'); process.exit(1) }

console.log('deploy: staged ' + pkg.name + '@' + pkg.version + ' -> ' + target)
console.log('下一步（手工接线；执行前先停止 DSH 后端）：')
console.log('  1. profile package.json 加依赖 "file:' + target.replace(/\\/g, '/') + '"，删除三个旧桥接包条目')
console.log('  2. bundles 列表加入 ' + pkg.name)
console.log('  3. 重启 DSH，验证 GET /cli-bridge/status 与标题栏三盏 pill')
