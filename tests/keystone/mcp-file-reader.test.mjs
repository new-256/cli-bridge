// tests/keystone/mcp-file-reader.test.mjs — MCP 快照读盘兼容表回归锁。
// 背景：合并初版 legacyMcpFiles.agy 误留空数组（agy 旧包 1.5.13 起就在写
// <home>/plugins/agy-indicator/mcp-live.json，1.6.2 专修过路径锚定）。本测试把
// 三家旧路径 + 新名优先 + writtenAt 归一 全部钉死，防止再漂移。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createMcpFileReader, LEGACY_MCP_FILES } from '../../home-plugin/cli-bridge-indicator/lib/index.mjs'

function fakeFs(files) {
  return {
    existsSync: (p) => p in files,
    readFileSync: (p) => { if (!(p in files)) throw new Error('ENOENT ' + p); return files[p] }
  }
}

test('三家旧路径逐字锁定（agy 1.5.13/1.6.2 桥文件不得再缺席）', () => {
  assert.deepEqual(LEGACY_MCP_FILES.agy, ['plugins', 'agy-indicator', 'mcp-live.json'])
  assert.deepEqual(LEGACY_MCP_FILES.codebuddy, ['codebuddy-indicator-mcp.json'])
  assert.deepEqual(LEGACY_MCP_FILES.mimo, ['plugins', 'mimo-indicator', 'mcp-live.json'])
})

test('新文件名优先于旧包文件名', () => {
  const home = 'C:/home'
  const read = createMcpFileReader({
    home,
    joinFn: path.posix.join,
    fs: fakeFs({
      'C:/home/cli-bridge-mcp-agy.json': JSON.stringify({ updatedAt: 222, projects: [] }),
      'C:/home/plugins/agy-indicator/mcp-live.json': JSON.stringify({ writtenAt: 111, projects: [] })
    })
  })
  const data = read('agy')
  assert.equal(data.updatedAt, 222, 'new file wins')
})

test('旧包文件名兼容读取 + writtenAt 归一为 updatedAt（三家同格式）', () => {
  for (const [id, legacy] of Object.entries(LEGACY_MCP_FILES)) {
    const home = 'C:/home'
    const legacyPath = path.posix.join(home, ...legacy)
    const read = createMcpFileReader({
      home,
      joinFn: path.posix.join,
      fs: fakeFs({ [legacyPath]: JSON.stringify({ writtenAt: 555, provider: id, projects: [{ cwd: 'C:/x', running: 1 }] }) })
    })
    const data = read(id)
    assert.ok(data, id + ' legacy file read')
    assert.equal(data.updatedAt, 555, id + ' writtenAt normalized')
    assert.equal(data.projects[0].running, 1)
  }
})

test('无文件 → null；坏 JSON → null 不抛', () => {
  const read = createMcpFileReader({
    home: 'C:/home',
    joinFn: path.posix.join,
    fs: fakeFs({ 'C:/home/cli-bridge-mcp-agy.json': '{oops', 'C:/home/plugins/agy-indicator/mcp-live.json': '{also-oops' })
  })
  assert.equal(read('agy'), null, 'corrupt new AND legacy file → null, never throws')
  assert.equal(read('codebuddy'), null, 'absent files → null')
  assert.equal(createMcpFileReader({ fs: fakeFs({}) })('agy'), null, 'no home → null')
})
