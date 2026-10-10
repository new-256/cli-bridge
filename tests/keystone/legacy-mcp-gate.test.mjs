// tests/keystone/legacy-mcp-gate.test.mjs
// 家级 bin\ 三个旧版自托管 MCP 服务器的调度门禁（0.2.0 四形态的第四条真实生效面）。
// 物料源：deploy/legacy-mcp/README.md（helper）+ bin\ 三服务器 tools/list|tools/call 接线。
// 本机没有 dsh-home 部署（CI/其他机器）时整体 skip —— 这是运行时接线测试，不 fake。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const APPDATA = process.env.APPDATA || (process.platform === 'win32' ? 'C:\\Users\\Default\\AppData\\Roaming' : '')
const DHOME = process.env.DSH_HOME || join(APPDATA, 'DSH Desktop', 'dsh-home')
const BIN = join(DHOME, 'bin')
const HERE = existsSync(join(BIN, 'cli-bridge-scheduling.mjs'))
const S = join(BIN, '__sched-repo-test-tmp__.json')

const SERVERS = {
  agy: join(BIN, 'agy-mcp-server.mjs'),
  codebuddy: join(BIN, 'codebuddy-mcp-server.mjs'),
  mimo: join(BIN, 'mimo-mcp', 'mcp', 'mimo-mcp-server.mjs')
}

function rpc(file, calls, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, env || {})
    })
    let buf = ''
    const errs = []
    const timer = setTimeout(() => { child.kill(); reject(new Error('rpc timeout: ' + file + ' stderr=' + errs.join('').slice(0, 400))) }, 20000)
    child.stdout.on('data', (d) => {
      buf += d.toString()
      const out = []
      for (const l of buf.split('\n')) { if (l.trim()) { try { out.push(JSON.parse(l)) } catch (e) { /* 非 JSON 行忽略 */ } } }
      const last = out[out.length - 1]
      if (last && calls.has(last.id)) { calls.delete(last.id); if (calls.size === 0) { clearTimeout(timer); child.kill(); resolve(out) } }
    })
    child.stderr.on('data', (d) => errs.push(d.toString()))
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
    if (calls.has(3)) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: calls.get(3) }) + '\n')
    }
  })
}

function setScheduling(enabled) {
  if (enabled === null) { rmSync(S, { force: true }); return }
  writeFileSync(S, JSON.stringify({ agy: {}, _scheduling: { enabled: enabled, priority: ['agy', 'codebuddy', 'mimo'] } }), 'utf8')
}

test('legacy gate: helper 语义（enabled 缺省/显式空/子集/钉住/坏文件 fail-open）', async (t) => {
  if (!HERE) return t.skip('dsh-home bin not deployed here')
  const { bridgeEnabled } = await import(pathToFileURL(join(BIN, 'cli-bridge-scheduling.mjs')).href)
  setScheduling(null)
  const base = { CLI_BRIDGE_SETTINGS_FILE: S }
  assert.equal(bridgeEnabled('agy', base), true, '无文件 = 全开（fail-open）')
  setScheduling(['agy'])
  assert.equal(bridgeEnabled('agy', base), true)
  assert.equal(bridgeEnabled('mimo', base), false)
  setScheduling([])
  assert.equal(bridgeEnabled('agy', base), false, '显式 [] = 全关')
  assert.equal(bridgeEnabled('codebuddy', Object.assign({ CLI_BRIDGE_PROVIDER: 'codebuddy' }, base)), true, '钉住最高优先')
  assert.equal(bridgeEnabled('agy', Object.assign({ CLI_BRIDGE_PROVIDER: 'codebuddy' }, base)), false)
  writeFileSync(S, '{ broken json', 'utf8')
  assert.equal(bridgeEnabled('mimo', base), true, '坏文件 = fail-open')
  setScheduling(null)
})

for (const id of ['agy', 'codebuddy', 'mimo']) {
  test(`legacy gate: ${id} 服务器 tools/list 面板过滤`, async (t) => {
    if (!HERE) return t.skip('dsh-home bin not deployed here')
    const env = { CLI_BRIDGE_SETTINGS_FILE: S }
    setScheduling(null)
    const open = await rpc(SERVERS[id], new Map([[2, true]]), env)
    assert.ok(open[open.length - 1].result.tools.length > 0, '缺省全开必有工具')
    setScheduling([id])
    const mine = await rpc(SERVERS[id], new Map([[2, true]]), env)
    const otherId = id === 'agy' ? 'mimo' : 'agy'
    const other = await rpc(SERVERS[otherId], new Map([[2, true]]), env)
    assert.ok(mine[mine.length - 1].result.tools.length > 0, id + ' 在 enabled 中 → 有工具')
    assert.equal(other[other.length - 1].result.tools.length, 0, otherId + ' 不在 enabled → 空工具面')
    setScheduling(null)
  })
}

test('legacy gate: 关闭面 tools/call 被拒（agy 走 -32602，mimo 走 isError 文案）', async (t) => {
  if (!HERE) return t.skip('dsh-home bin not deployed here')
  const env = { CLI_BRIDGE_SETTINGS_FILE: S }
  setScheduling(['mimo'])
  const calls = new Map([[3, { name: 'agy_status', arguments: {} }]])
  const r = await rpc(SERVERS.agy, calls, env)
  const msg = r.find((m) => m.id === 3)
  assert.ok(msg.error && msg.error.code === -32602, 'agy: Unknown tool 错误码')
  setScheduling(['agy'])
  const calls2 = new Map([[3, { name: 'mimo_status', arguments: {} }]])
  const r2 = await rpc(SERVERS.mimo, calls2, env)
  const msg2 = r2.find((m) => m.id === 3)
  assert.ok(!(msg2.result && msg2.result.isError === false), 'mimo: 被拒（isError 或 error）')
  setScheduling(null)
})

test('legacy gate: 钉住单面 env 覆盖面板（agy 关但 CLI_BRIDGE_PROVIDER=agy → 仍暴露）', async (t) => {
  if (!HERE) return t.skip('dsh-home bin not deployed here')
  setScheduling(['mimo'])
  const r = await rpc(SERVERS.agy, new Map([[2, true]]), { CLI_BRIDGE_SETTINGS_FILE: S, CLI_BRIDGE_PROVIDER: 'agy' })
  assert.ok(r[r.length - 1].result.tools.length > 0, '钉住优先于面板关闭')
  setScheduling(null)
})
