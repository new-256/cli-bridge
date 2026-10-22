// tests/keystone/session-cwd.test.mjs
// 锁定「MCP 形态的 cwd 兜底链」：会话目录必须来自 DSH_SESSION_ID，而不是 process.cwd()。
//
// 事故背景（2026-10-23）：DSH 的 mcp-client 以 config.cwd=""（空）启动 stdio server，
// 于是 MCP 进程 cwd = DSH 主进程目录。provider 原来直接 `|| process.cwd()` 兜底，
// 导致 CLI 把用户项目整个判成「工作区外」→ codex 的 -s workspace-write 直接拒绝写入，
// agy/claude/opencode 也都按各自 project 边界报错。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveSessionCwd, resolveCwdWithSession, resetSessionCwdCache } from '../../mcp/session-cwd.mjs'

/** 造一个假 dsh-home，写入指定会话的 projcache（内含真实 cwd）。 */
function makeHome(sessionId, cwd) {
  const home = mkdtempSync(join(tmpdir(), 'clb-scwd-'))
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', sessionId + '.json'), JSON.stringify({
    version: 4,
    record: { identity: { cwd }, rows: {} }
  }), 'utf8')
  return home
}

const SID = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const realCwd = 'C:\\Users\\x\\Desktop\\RealProject'

test('resolveSessionCwd：从 projcache 读到会话真实 cwd', () => {
  resetSessionCwdCache()
  const home = makeHome(SID, realCwd)
  try {
    const got = resolveSessionCwd({ DSH_HOME: home, DSH_SESSION_ID: SID }, 1)
    assert.equal(got.replace(/\\/g, '/'), realCwd.replace(/\\/g, '/'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('resolveSessionCwd：没有 DSH_SESSION_ID → 空串（让调用方继续兜底，绝不瞎猜）', () => {
  resetSessionCwdCache()
  assert.equal(resolveSessionCwd({ DSH_HOME: 'C:\\whatever' }, 1), '')
  assert.equal(resolveSessionCwd({}, 1), '')
})

test('resolveSessionCwd：会话不存在 → 空串，不抛异常', () => {
  resetSessionCwdCache()
  const home = mkdtempSync(join(tmpdir(), 'clb-scwd-empty-'))
  try {
    assert.equal(resolveSessionCwd({ DSH_HOME: home, DSH_SESSION_ID: SID }, 1), '')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('resolveSessionCwd：磁盘文件损坏也不抛，返回空串', () => {
  resetSessionCwdCache()
  const home = mkdtempSync(join(tmpdir(), 'clb-scwd-bad-'))
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', SID + '.json'), '{not json', 'utf8')
  try {
    assert.equal(resolveSessionCwd({ DSH_HOME: home, DSH_SESSION_ID: SID }, 1), '')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('resolveSessionCwd：60s 内命中缓存（不重复读盘）', () => {
  resetSessionCwdCache()
  const home = makeHome(SID, realCwd)
  try {
    const first = resolveSessionCwd({ DSH_HOME: home, DSH_SESSION_ID: SID }, 1000)
    assert.ok(first)
    // 缓存期内即便 home 被删，也应仍返回缓存值
    rmSync(home, { recursive: true, force: true })
    const second = resolveSessionCwd({ DSH_HOME: home, DSH_SESSION_ID: SID }, 5000)
    assert.equal(second, first, 'TTL 内应命中缓存')
  } finally { try { rmSync(home, { recursive: true, force: true }) } catch (e) { } }
})

test('resolveCwdWithSession：优先级 args.cwd > env 覆盖 > 会话目录 > process.cwd()', () => {
  resetSessionCwdCache()
  const home = makeHome(SID, realCwd)
  const prev = process.env.CLAUDE_MCP_CWD
  try {
    // 1) 显式参数最高
    assert.equal(resolveCwdWithSession({ cwd: 'C:/explicit' }, 'CLAUDE_MCP_CWD'), 'C:/explicit')
    // 2) env 覆盖次之
    process.env.CLAUDE_MCP_CWD = 'C:/from-env'
    assert.equal(resolveCwdWithSession({}, 'CLAUDE_MCP_CWD'), 'C:/from-env')
    // 3) 都没有 → 会话目录（这里通过 DSH_* 环境驱动真实解析）
    delete process.env.CLAUDE_MCP_CWD
    const prevHome = process.env.DSH_HOME
    const prevSid = process.env.DSH_SESSION_ID
    process.env.DSH_HOME = home
    process.env.DSH_SESSION_ID = SID
    resetSessionCwdCache()
    const viaSession = resolveCwdWithSession({}, 'CLAUDE_MCP_CWD')
    assert.equal(viaSession.replace(/\\/g, '/'), realCwd.replace(/\\/g, '/'), '应回落到会话真实目录')
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome
    if (prevSid === undefined) delete process.env.DSH_SESSION_ID; else process.env.DSH_SESSION_ID = prevSid
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_MCP_CWD; else process.env.CLAUDE_MCP_CWD = prev
    rmSync(home, { recursive: true, force: true })
    resetSessionCwdCache()
  }
})

test('MCP 各 provider 都接上了会话 cwd 兜底（防回归）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  for (const id of ['agy', 'codebuddy', 'mimo', 'opencode', 'claude', 'codex']) {
    const src = readFileSync(join(root, 'mcp', 'providers', id + '.mjs'), 'utf8')
    assert.ok(src.includes('session-cwd.mjs'), id + ' 必须 import session-cwd')
    assert.ok(
      src.includes('resolveSessionCwd') || src.includes('resolveCwdWithSession'),
      id + ' 必须使用会话 cwd 解析'
    )
    // 绝不允许再出现裸 process.cwd() 兜底（那正是事故根因）
    const bareFallback = /(?:\|\||\?\?)\s*process\.cwd\(\)/.test(src.replace(/\/\/.*$/gm, ''))
    if (id === 'codebuddy') {
      // codebuddy 保留最终 process.cwd() 兜底，但必须在会话解析之后
      assert.ok(/resolveSessionCwd[\s\S]{0,80}process\.cwd\(\)/.test(src), 'codebuddy 的 process.cwd() 必须排在会话解析之后')
    } else {
      assert.ok(!bareFallback, id + ' 不应再有裸 process.cwd() 兜底')
    }
  }
})
