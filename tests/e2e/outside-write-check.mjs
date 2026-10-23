// tests/e2e/outside-write-check.mjs
// 验证「与 agy 同等自由权限」：CLI 能否写**工作目录之外**的文件。
// 这是用户反馈的核心诉求（"其他 CLI 要有与 agy 一样自由的权限"）。
//
// 方法：cwd = wsA，要求 CLI 写 wsA 的兄弟目录 wsB 里的文件。
//   成功 = 文件真的出现在 wsB。
// 注意：即使 cwd 正确，先前 codex 的 -s workspace-write 也会拒绝这种写入。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'agy']

const base = mkdtempSync(join(tmpdir(), 'clb-out-'))
const wsA = join(base, 'wsA')   // 工作目录（cwd）
const wsB = join(base, 'wsB')   // 工作目录之外
mkdirSync(wsA); mkdirSync(wsB)
console.log('工作目录(cwd): ' + wsA)
console.log('目标(区外)  : ' + wsB + '\n')

const rows = []
for (const id of ids) {
  const mod = await import('file:///' + join(ROOT, 'providers', id + '.mjs').replace(/\\/g, '/'))
  const provider = mod.default({ env: process.env, process })
  let exe = [provider.exeName || id]
  try {
    const r = typeof mod.resolveExePrefix === 'function' ? mod.resolveExePrefix(process.env, '') : null
    if (Array.isArray(r) && r.length && r[0]) exe = r
  } catch (e) { }

  const target = join(wsB, 'out-' + id + '.txt')
  const built = provider.buildArgv(exe, {
    prompt: 'Create a new text file at this exact absolute path: ' + target + ' containing OK. Use your file tool. Then reply DONE.',
    cwd: wsA
  }, { planActive: false, probeProxy: () => ({ alive: false, detail: 'skip' }) })

  const r = spawnSync(built.argv[0], built.argv.slice(1), {
    encoding: 'utf8', timeout: 240000, windowsHide: true, cwd: wsA,
    stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env)
  })
  const parsed = provider.parseJson(String(r.stdout || ''))
  const res = provider.buildResult(parsed, { exitCode: r.status }, built.mode, String(r.stderr || ''), String(r.stdout || ''), null)
  const made = existsSync(target)
  const sandboxFlags = built.argv.filter((x) => /^(read-only|workspace-write|danger-full-access)$/.test(x) || /dangerously-skip|--auto$|bypassPermissions/.test(x)).join(' ')
  rows.push({ id, made, ok: res.ok, status: res.status, exit: r.status, sandboxFlags })
}

console.log('============ 结果 ============')
for (const x of rows) {
  console.log(x.id.padEnd(11) + ' 写区外=' + (x.made ? '✅ 成功' : '❌ 失败') +
    '   CLI=' + (x.ok ? 'ok' : String(x.status)) + '(exit ' + x.exit + ')' +
    '   权限参数: ' + (x.sandboxFlags || '(无)'))
}
const allOk = rows.every((x) => x.made)
console.log('\n' + (allOk ? '✅ 全部可写工作区外（与 agy 同等自由）' : '⚠ 有 CLI 仍被限制'))
try { rmSync(base, { recursive: true, force: true }) } catch (e) { }
process.exitCode = allOk ? 0 : 1
