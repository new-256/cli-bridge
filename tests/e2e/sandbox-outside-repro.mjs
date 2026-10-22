// 复现「委派任务时 CLI 无权编辑工作区外内容」：
// 让每家 CLI 在 wsA（cwd）里运行，但要求它写 wsB（cwd 的兄弟目录）里的文件。
// 判定：wsB 里文件是否真的被创建 + CLI 是否报成功。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'claude', 'opencode', 'agy']

const base = mkdtempSync(join(tmpdir(), 'clb-sbx-'))
const wsA = join(base, 'wsA')   // 工作区（cwd）
const wsB = join(base, 'wsB')   // 工作区外
mkdirSync(wsA); mkdirSync(wsB)
console.log('工作区(cwd): ' + wsA)
console.log('目标(区外): ' + wsB + '\n')

const results = []
for (const id of ids) {
  const mod = await import('file:///' + join(ROOT, 'providers', id + '.mjs').replace(/\\/g, '/'))
  const provider = mod.default({ env: process.env, process })
  let exe = [provider.exeName || id]
  try {
    const r = typeof mod.resolveExePrefix === 'function' ? mod.resolveExePrefix(process.env, '') : null
    if (Array.isArray(r) && r.length && r[0]) exe = r
  } catch (e) { }

  const target = join(wsB, 'out-' + id + '.txt')
  const prompt = 'Create a new text file at this exact absolute path: ' + target + ' with the content OK. ' +
    'Use your file-writing tool. Do not explain, just do it.'

  let built
  try {
    built = provider.buildArgv(exe, { prompt, cwd: wsA }, { planActive: false, probeProxy: () => ({ alive: true, detail: 'ALIVE' }) })
  } catch (e) {
    results.push({ id, stage: 'buildArgv', err: String(e.message).slice(0, 120) }); continue
  }

  const r = spawnSync(built.argv[0], built.argv.slice(1), {
    encoding: 'utf8', timeout: 240000, windowsHide: true, cwd: wsA,
    stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env)
  })
  const parsed = provider.parseJson(String(r.stdout || ''))
  const res = provider.buildResult(parsed, { exitCode: r.status }, built.mode, String(r.stderr || ''), String(r.stdout || ''), null)
  const made = existsSync(target)
  const content = made ? readFileSync(target, 'utf8').slice(0, 40).trim() : ''
  const blob = String(r.stdout || '') + String(r.stderr || '')
  const sandboxHit = /outside|workspace|sandbox|denied|permission|not allowed|无法|拒绝/i.test(blob)

  results.push({
    id,
    ok: res.ok,
    status: res.status,
    exit: r.status,
    made,
    content,
    sandboxHit,
    argvTail: built.argv.filter((x) => /^-s$|workspace-write|danger-full|add-dir|--auto$|skip-permissions|accept-edits/.test(x)).join(' ')
  })
}

console.log('================ 结果 ================')
for (const x of results) {
  if (x.stage) { console.log(x.id.padEnd(10) + ' buildArgv 失败: ' + x.err); continue }
  console.log(x.id.padEnd(10) + ' 写区外=' + (x.made ? '成功' : '失败') +
    '  CLI=' + (x.ok ? 'ok' : String(x.status)) + '(exit ' + x.exit + ')' +
    '  提到沙箱/越界=' + x.sandboxHit)
  console.log('           参数: ' + (x.argvTail || '(无沙箱相关参数)'))
}
try { rmSync(base, { recursive: true, force: true }) } catch (e) { }
