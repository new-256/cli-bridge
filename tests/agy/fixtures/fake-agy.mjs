// tests/agy/fixtures/fake-agy.mjs — 假 agy CLI：打印 NDJSON 步骤与终态 result 后退出。
// 供 MCP 形态测试经 AGY_BIN（.mjs → node 包装）spawn。
process.stdout.write('{"event":"step_update","step_update":{"step_type":"tool","step_index":0,"state":"ACTIVE","tool_name":"read","tool_info":{"name":"read","parameters":{"file_path":"a.txt"}}}}\n')
process.stdout.write('{"event":"step_update","step_update":{"step_type":"tool","step_index":0,"state":"DONE","tool_name":"read"}}\n')
process.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done","conversation_id":"conv-fake-1","duration_seconds":1.5,"num_turns":2,"usage":{"total_tokens":123}}}\n')
