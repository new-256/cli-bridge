// 抓「写工作区外」失败时的原始报错文本，用于定位根因。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'claude', 'opencode']

const base = mkdtempSync(join(tmpdir(), 'clb-sbx2-'))
const wsA = join(base, 'wsA')
const wsB = join(base, 'wsB')
mkdirSync(wsA); mkdirSync(wsB)

for (const id of ids) {
  const mod = await import('file:///' + join(ROOT, 'providers', id + '.mjs').replace(/\\/g, '/'))
  const provider = mod.default({ env: process.env, process })
  let exe = [provider.exeName || id]
  try {
    const r = typeof mod.resolveExePrefix === 'function' ? mod.resolveExePrefix(process.env, '') : null
    if (Array.isArray(r) && r.length && r[0]) exe = r
  } catch (e) { }

  const target = join(wsB, 'out-' + id + '.txt')
  const prompt = 'Create a new text file at this exact absolute path: ' + target +
    ' with the content OK. Use your file-writing tool. Do not explain, just do it.'
  const built = provider.buildArgv(exe, { prompt, cwd: wsA }, { planActive: false, probeProxy: () => ({ alive: true, detail: 'ALIVE' }) })
  const r = spawnSync(built.argv[0], built.argv.slice(1), {
    encoding: 'utf8', timeout: 240000, windowsHide: true, cwd: wsA,
    stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env)
  })

  console.log('\n════════ ' + id + ' (exit ' + r.status + ', 写区外=' + (existsSync(target) ? '成功' : '失败') + ') ════════')
  console.log('argv: ' + built.argv.slice(1, -1).join(' '))

  // 提取关键报错行
  const all = (String(r.stdout || '') + '\n' + String(r.stderr || ''))
  const lines = all.split(/\r?\n/).filter((l) => l.trim())
  const KEY = /denied|outside|workspace|sandbox|permission|not allowed|approve|approval|拒绝|无法|沙箱|路径|path/i
  const hits = lines.filter((l) => KEY.test(l))
  if (hits.length) {
    console.log('--- 关键行 ---')
    for (const l of hits.slice(0, 8)) console.log('  ' + l.trim().slice(0, 300))
  } else {
    console.log('--- 无关键词命中，原始尾部 ---')
    for (const l of lines.slice(-10)) console.log('  ' + l.trim().slice(0, 300))
  }
}
try { rmSync(base, { recursive: true, force: true }) } catch (e) { }
