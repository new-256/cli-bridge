// tests/opencode/fixtures/fake-opencode.mjs — 假 opencode CLI：打印真实形态的 NDJSON
// 事件流后以 0 退出。事件 type 与负载形状严格对齐 CLI 源码 emit 全集
// （step_start / text / reasoning / tool_use / step_finish / error；负载在 part 里，
//   顶层只带 type/timestamp/sessionID）。
// 供 MCP 形态测试经 OPENCODE_BIN（.mjs → node 包装）spawn。
const SID = 'ses_fake00000000000AAA'
const T = 1792000000000
function emit(type, data) {
  process.stdout.write(JSON.stringify(Object.assign({ type, timestamp: T, sessionID: SID }, data)) + '\n')
}

emit('step_start', { part: { id: 'prt_1', sessionID: SID, messageID: 'msg_1', type: 'step-start' } })
emit('tool_use', { part: { partID: 'prt_2', sessionID: SID, messageID: 'msg_1', type: 'tool', id: 't1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt', title: 'ls', time: { start: T, end: T + 10 } } } })
emit('text', { part: { id: 'prt_3', sessionID: SID, messageID: 'msg_1', type: 'text', text: 'FAKE_OPENCODE_OK', time: { start: T, end: T + 20 } } })
emit('step_finish', { part: { id: 'prt_4', sessionID: SID, messageID: 'msg_1', type: 'step-finish', reason: 'stop', cost: 0.0042, tokens: { input: 100, output: 23, reasoning: 0, cache: { read: 0, write: 0 } } } })
process.exit(0)
