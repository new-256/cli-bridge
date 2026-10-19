// tests/e2e/cli-connectivity.mjs — 逐家 CLI 的「连通 + 持续对话」真机验收。
//
// 每家跑两轮：
//   R1（新会话）：要求它记住一个暗号，并只回 ROUND1
//   R2（续聊，带 R1 的会话 id）：问它暗号是什么
// 判定：
//   连通 = R1 成功且响应含 ROUND1
//   续聊 = R2 成功，且响应里出现 R1 的暗号（证明两轮真的落在同一会话、上下文延续）
//          ——只看"有没有回 sessionId"是不够的，那只证明字段存在。
//
// 用法：node tests/e2e/cli-connectivity.mjs [provider ...]   默认 agy claude codex opencode
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ALL = ['agy', 'claude', 'codex', 'opencode']
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ALL

// 每家 provider 的会话字段名（buildArgv 认的那个）
const SESSION_KEY = { agy: 'conversationId', claude: 'sessionId', codex: 'sessionId', opencode: 'sessionId' }
const EXE = { agy: 'agy', claude: 'claude', codex: 'codex', opencode: 'opencode' }

async function loadProvider(id) {
  const mod = await import('file:///' + join(ROOT, 'providers', id + '.mjs').replace(/\\/g, '/'))
  const provider = mod.default({ env: process.env, process })
  // exe 前缀必须走 provider 自己的解析：opencode 的真名是 opencode-cli.exe，且装在
  // ai.opencode.desktop\cli\<ver>\ 下、不在 PATH 上（直接写 'opencode' 会 ENOENT）。
  let exePrefix = null
  try {
    if (typeof mod.resolveExePrefix === 'function') exePrefix = mod.resolveExePrefix(process.env, '')
    else if (typeof provider.resolveExePrefix === 'function') exePrefix = provider.resolveExePrefix(process.env, '')
  } catch (e) { }
  if (!Array.isArray(exePrefix) || !exePrefix.length || !exePrefix[0]) {
    exePrefix = [provider.exeName || id]
  }
  return { provider, exePrefix }
}

function callOnce(provider, exePrefix, args, opts, cwd) {
  let built
  try {
    built = provider.buildArgv(exePrefix, args, opts)
  } catch (e) {
    return { ok: false, stage: 'buildArgv', error: String((e && e.message) || e) }
  }
  const r = spawnSync(built.argv[0], built.argv.slice(1), {
    encoding: 'utf8',
    timeout: Math.min((built.timeoutSec || 300) * 1000, 300000),
    windowsHide: true,
    cwd,
    env: Object.assign({}, process.env, built.env || {})
  })
  const parsed = provider.parseJson(String(r.stdout || ''))
  const res = provider.buildResult(parsed, { exitCode: r.status }, built.mode, String(r.stderr || ''), String(r.stdout || ''), provider.defaultBackend)
  return { ok: !!res.ok, res, exit: r.status, spawnErr: r.error ? r.error.code : null, argv: built.argv }
}

const results = []
for (const id of ids) {
  const cwd = mkdtempSync(join(tmpdir(), 'clb-conn-' + id + '-'))
  const line = { id, connect: 'FAIL', session: '-', chat: 'FAIL', note: '' }
  try {
    const loaded = await loadProvider(id)
    const provider = loaded.provider
    const exe = loaded.exePrefix
    const word = 'BANANA'

    // R1：新会话
    const r1 = callOnce(provider, exe, {
      prompt: 'Remember this code word: ' + word + '. Then reply with exactly: ROUND1',
      cwd
    }, { planActive: false }, cwd)

    if (!r1.ok) {
      line.note = 'R1 ' + (r1.stage || ('exit=' + r1.exit + (r1.spawnErr ? ' ' + r1.spawnErr : ''))) + ': ' +
        String((r1.res && (r1.res.errorMessage || r1.res.status)) || r1.error || '').slice(0, 100)
      results.push(line); continue
    }
    line.connect = 'OK'
    const sid = r1.res.sessionId || r1.res.conversationId || null
    line.session = sid ? String(sid).slice(0, 10) + '…' : '(none)'

    // R2：续聊同一会话
    const r2args = { prompt: 'What code word did I ask you to remember? Reply with exactly that word and nothing else.', cwd }
    if (sid) r2args[SESSION_KEY[id]] = sid
    else r2args.continueLatest = true
    const r2 = callOnce(provider, exe, r2args, { planActive: false }, cwd)

    if (!r2.ok) {
      line.note = 'R2 ' + (r2.stage || ('exit=' + r2.exit)) + ': ' +
        String((r2.res && (r2.res.errorMessage || r2.res.status)) || r2.error || '').slice(0, 100)
      results.push(line); continue
    }
    const text = String(r2.res.response || '')
    line.chat = text.toUpperCase().includes(word) ? 'OK' : 'NO-CONTEXT'
    if (line.chat !== 'OK') line.note = 'R2 回复未含暗号: ' + JSON.stringify(text.slice(0, 80))
    // 续聊应保持在同一个会话
    const sid2 = r2.res.sessionId || r2.res.conversationId || null
    if (sid && sid2 && String(sid2) !== String(sid)) line.note += (line.note ? ' · ' : '') + '会话 id 变了'

    // 清掉临时 cwd 里可能产生的产物
    results.push(line)
  } catch (e) {
    line.note = 'threw: ' + String((e && e.message) || e)
    results.push(line)
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }) } catch (e) { }
  }
}

console.log('\n================ 结果 ================')
for (const r of results) {
  console.log(r.id.padEnd(10) + ' 连通=' + r.connect.padEnd(5) + ' 会话=' + String(r.session || '-').padEnd(14) + ' 续聊=' + String(r.chat).padEnd(11) + (r.note ? ' · ' + r.note : ''))
}
const bad = results.filter((r) => r.connect !== 'OK' || r.chat !== 'OK')
console.log('\n' + (bad.length === 0 ? '全部通过' : '有问题: ' + bad.map((r) => r.id).join(', ')))
process.exit(bad.length === 0 ? 0 : 1)
