// tests/codebuddy/mcp-provider.test.mjs — MCP 形态（mcp/providers/codebuddy.mjs）。
// CODEBUDDY_BIN 指向 fixture（.mjs → 经 process.execPath 包装）真 spawn，hermetic。
// 纪律（Lead 坑 1）：io.env 独立构造 + 全局 env 用 async withEnv 钉死设置/凭据触点，
// 绝不读真实 %APPDATA% 凭据目录；快照文件名锁 = cli-bridge-mcp-codebuddy.json（坑 3）。
// 注：设置文件的 codebuddyEnToken 分区不在这里做端到端（readSettings 有 5s 模块缓存，
// 用例顺序会污染缓存）；其清洗语义已由 descriptor.test 的 normalizeSettings 覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'

import { meta, tools, call, check } from '../../mcp/providers/codebuddy.mjs'
import { FIX, withEnv, freshTmp } from './helpers/env.mjs'

const CB_BIN = FIX('fake-codebuddy.mjs')

// 每个用例独立 io：homeDir/root 都是运行时 mkdtemp；env 全部钉死。
function mkIo(extraEnv = {}) {
  const homeDir = freshTmp('cbtest-mcp-home-')
  const root = freshTmp('cbtest-mcp-root-')
  const countFile = join(root, 'spawn-count.log')
  const io = {
    homeDir,
    fs: { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync },
    path: { join, dirname, resolve, sep },
    env: Object.assign({
      CODEBUDDY_BIN: CB_BIN,
      CODEBUDDY_MCP_CWD: root,
      CLI_BRIDGE_SETTINGS_FILE: join(homeDir, 'nonexist.json'),
      LOCALAPPDATA: join(homeDir, 'appdata'),
      APPDATA: homeDir,
      DSH_HOME: homeDir,
      CODEBUDDY_CREDENTIALS_DIR: join(homeDir, 'creds'),
      CODEBUDDY_AUTH_TOKEN: '',
      CODEBUDDY_AUTH_DIR: join(homeDir, 'authdir'),
      FAKE_CB_COUNT_FILE: countFile
    }, extraEnv),
    log: () => {},
    root,
    countFile,
    _cleanup: () => {
      try { rmSync(homeDir, { recursive: true, force: true }) } catch (e) {}
      try { rmSync(root, { recursive: true, force: true }) } catch (e) {}
    }
  }
  return io
}

// 与 mkIo.io.env 一致的全局钉（子进程继承 process.env：FAKE_CB_* 与计数文件要经
// 真 env 传给 fixture；MCP 面自身读的是 io.env，两者保持同源）。
function globalPin(io, extra = {}) {
  return Object.assign({
    CLI_BRIDGE_SETTINGS_FILE: io.env.CLI_BRIDGE_SETTINGS_FILE,
    CODEBUDDY_SETTINGS_FILE: io.env.CLI_BRIDGE_SETTINGS_FILE,
    CODEBUDDY_AUTH_TOKEN: null,
    DSH_HOME: io.homeDir,
    CODEBUDDY_CREDENTIALS_DIR: io.env.CODEBUDDY_CREDENTIALS_DIR,
    LOCALAPPDATA: io.env.LOCALAPPDATA,
    CODEBUDDY_AUTH_DIR: io.env.CODEBUDDY_AUTH_DIR,
    FAKE_CB_COUNT_FILE: io.countFile
  }, extra)
}

function spawnLines(io) {
  try { return readFileSync(io.countFile, 'utf8').trim().split(/\r?\n/).filter(Boolean) } catch (e) { return [] }
}
function spawnCount(io) { return spawnLines(io).length }

test('meta 契约形态', () => {
  assert.equal(meta.id, 'codebuddy')
  assert.equal(meta.label, 'CODEBUDDY')
  // 版本跟随本包（契约 §4）：不钉字面量，否则每次发布都要改测试。
  assert.match(meta.version, /^\d+\.\d+\.\d+/, 'meta.version follows the package version')
})

test('tools(env) 三件套 + schema 合法 + check() 守卫通过', () => {
  const ts = tools({})
  assert.deepEqual(ts.map((t) => t.name), ['codebuddy_run', 'codebuddy_continue', 'codebuddy_status'])
  for (const t of ts) {
    assert.equal(t.inputSchema.type, 'object')
    assert.ok(t.description.length > 40)
  }
  // 两 faces 差异钉（契约 §8）：MCP 面 mode 无 auto、无 background 属性。
  assert.deepEqual(ts[0].inputSchema.properties.mode.enum, ['plan', 'accept-edits'])
  assert.equal('background' in ts[0].inputSchema.properties, false)
  assert.equal(check({}), true)
})

test('call(codebuddy_run) fixture → OK 文本 + 快照 cli-bridge-mcp-codebuddy.json（非 legacy 名）', async () => {
  const io = mkIo()
  await withEnv(globalPin(io), async () => {
    const text = await call('codebuddy_run', { prompt: 'do something', model: 'hy3' }, io)
    assert.match(text, /^codebuddy OK \[status=SUCCESS mode=bypassPermissions model=hy3 session=fake-s1/, text.slice(0, 160))
    assert.match(text, /cwd=/)
    const snapPath = join(io.homeDir, 'cli-bridge-mcp-codebuddy.json')
    assert.ok(existsSync(snapPath), 'exact snapshot file name (keystone mcpBridgeFileName)')
    assert.equal(existsSync(join(io.homeDir, 'cli-bridge-codebuddy.json')), false, 'legacy wrong name must NOT be written (防漂移锁)')
    const snap = JSON.parse(readFileSync(snapPath, 'utf8'))
    assert.equal(snap.source, 'mcp')
    assert.equal(snap.provider, 'codebuddy')
    assert.equal(snap.pid, process.pid)
    assert.ok(snap.updatedAt > 0)
    assert.equal(snap.projects[0].lastStatus, 'SUCCESS')
    assert.equal(snap.projects[0].lastSessionId, 'fake-s1')
    // NDJSON tool_use 折叠进 trail（实时状态面在 MCP 形态同样生效）
    assert.ok(snap.projects[0].trail.map((e) => e.tool).includes('Read'))
    // --model 透传进真实 argv
    assert.match(spawnLines(io)[0] || '', /--model hy3/)
  })
  io._cleanup()
})

test('白名单三态：未设置放行（默认兼容）/ 圈内放行 / 圈外拒绝且不 spawn', async () => {
  const io = mkIo()
  await withEnv(globalPin(io), async () => {
    // 未设置 CODEBUDDY_MCP_ALLOWED_ROOTS → 放行
    const open = await call('codebuddy_run', { prompt: 'no whitelist' }, io)
    assert.match(open, /^codebuddy OK/, open.slice(0, 120))
  })
  io._cleanup()

  const io2 = mkIo()
  io2.env.CODEBUDDY_MCP_ALLOWED_ROOTS = io2.root
  const subDir = join(io2.root, 'sub')
  mkdirSync(subDir)
  await withEnv(Object.assign(globalPin(io2), { CODEBUDDY_MCP_ALLOWED_ROOTS: io2.root }), async () => {
    const inside = await call('codebuddy_run', { prompt: 'inside', cwd: subDir }, io2)
    assert.match(inside, /^codebuddy OK/, inside.slice(0, 200))
    const outsideDir = freshTmp('cbtest-outside-')
    const outside = await call('codebuddy_run', { prompt: 'outside', cwd: outsideDir }, io2)
    assert.match(outside, /FAILED \[status=CWD_BLOCKED/)
    assert.match(outside, /is outside CODEBUDDY_MCP_ALLOWED_ROOTS/)
    assert.equal(spawnCount(io2), 1, 'blocked call never spawns')
    try { rmSync(outsideDir, { recursive: true, force: true }) } catch (e) {}
    // 垃圾路径不崩（纯字符串 resolve，不触 fs）
    const junk = await call('codebuddy_run', { prompt: 'junk', cwd: '\u0001garbage path ~~' }, io2)
    assert.match(junk, /CWD_BLOCKED/)
    assert.equal(spawnCount(io2), 1)
  })
  io2._cleanup()
})

test('EN 面无凭据 → AUTH_REQUIRED 文本早退（零 spawn；不弹窗，含 workbuddy 指引）', async () => {
  const io = mkIo()
  await withEnv(globalPin(io), async () => {
    const text = await call('codebuddy_run', { prompt: 'x', backend: 'codebuddy-en' }, io)
    assert.match(text, /^codebuddy-en FAILED \[status=AUTH_REQUIRED mode=accept-edits\]/, text.slice(0, 160))
    assert.match(text, /protector key/)
    assert.match(text, /也可直接用 backend="workbuddy"/)
    assert.equal(spawnCount(io), 0)
  })
  io._cleanup()
})

test('限流 stderr → FAILED + rate-limit 附注（描述符中文表；不自动重试）', async () => {
  const io = mkIo({ FAKE_CB_SUBTYPE: 'error_during_execution', FAKE_CB_STDERR: '请求过于频繁，已触发流量限制' })
  await withEnv(globalPin(io, { FAKE_CB_SUBTYPE: 'error_during_execution', FAKE_CB_STDERR: '请求过于频繁，已触发流量限制' }), async () => {
    const text = await call('codebuddy_run', { prompt: 'x' }, io)
    assert.match(text, /FAILED \[status=ERROR_DURING_EXECUTION/, text.slice(0, 160))
    assert.match(text, /\[Note: this looks like a rate-limit/)
    assert.equal(spawnCount(io), 1, '限流不自动重试（那是瞬时的地盘）')
  })
  io._cleanup()
})

test('瞬时错误（无原因 error_during_execution）→ 自动重试一次；continue --resume 不重试', async () => {
  const io = mkIo({ FAKE_CB_SUBTYPE: 'error_during_execution', FAKE_CB_STDERR: 'internal hiccup, no reason' })
  await withEnv(globalPin(io, { FAKE_CB_SUBTYPE: 'error_during_execution', FAKE_CB_STDERR: 'internal hiccup, no reason' }), async () => {
    const text = await call('codebuddy_run', { prompt: 'x' }, io)
    assert.match(text, /retried=1/)
    assert.equal(spawnCount(io), 2, '恰好重试 1 次')
    // continue + sessionId：会话状态可能已被前次改动 → 不自动重试
    const linesBefore = spawnCount(io)
    const c = await call('codebuddy_continue', { prompt: 'more', sessionId: 'sess-42' }, io)
    assert.match(c, /FAILED/)
    assert.equal(spawnCount(io), linesBefore + 1, '续接零重试')
    assert.match(spawnLines(io)[spawnCount(io) - 1], /--resume sess-42/)
  })
  io._cleanup()
})

test('prompt 必填（错误也是文本，不抛）', async () => {
  const io = mkIo()
  assert.equal(await call('codebuddy_run', {}, io), 'codebuddy error: prompt is required')
  assert.equal(await call('codebuddy_run', { prompt: '  ' }, io), 'codebuddy error: prompt is required')
  io._cleanup()
})

test('call(codebuddy_status) 聚合文本（旧 statusText verbatim 面）', async () => {
  const io = mkIo()
  await withEnv(globalPin(io), async () => {
    const empty = await call('codebuddy_status', {}, io)
    assert.match(empty, /^codebuddy status: (idle|ok|running|failed)/)
    await call('codebuddy_run', { prompt: 'seed status' }, io)
    const after = await call('codebuddy_status', {}, io)
    assert.match(after, /codebuddy status: ok/)
    assert.match(after, /last=SUCCESS fake-s1/)
    assert.match(after, /runs, 15 tokens/)
  })
  io._cleanup()
})
