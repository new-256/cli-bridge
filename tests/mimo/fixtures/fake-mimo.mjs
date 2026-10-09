// tests/mimo/fixtures/fake-mimo.mjs — 假 mimo CLI：打印 MiMo NDJSON 事件流后退出 0。
// 供 MCP 形态测试经 MIMO_BIN（.mjs → node 包装）spawn。事件形态与真实 MiMoCode 一致：
// session → tool → text，会话 id 走顶层 sessionID。
process.stdout.write('{"type":"session","timestamp":1790000000000,"properties":{"id":"ses_fake_1"}}\n')
process.stdout.write('{"type":"step_update","timestamp":1790000000001,"properties":{"tool":"read","arguments":{"filePath":"a.txt"},"state":"ACTIVE"}}\n')
process.stdout.write('{"type":"tool","timestamp":1790000000002,"properties":{"tool":"bash","arguments":{"command":"ls"}}}\n')
process.stdout.write('{"type":"text","timestamp":1790000000003,"sessionID":"ses_fake_1","text":"done"}\n')
process.stdout.write('{"type":"step_update","timestamp":1790000000004,"properties":{"tokens":{"total":123}}}\n')
