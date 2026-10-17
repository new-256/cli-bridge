// tests/mimo/fixtures/fake-mimo-echo.mjs — 假 mimo CLI：把收到的 argv 原样回报为 MiMo
// NDJSON 文本事件，退出 0。供 MCP 形态测试验证 model 参数是否真的落到 spawn 命令行上
// （fixture 本身不解析 flag，只回报 process.argv 原样）。
const argv = process.argv.slice(2).join(' ')
process.stdout.write('{"type":"session","properties":{"id":"ses_echo_1"}}\n')
process.stdout.write('{"type":"text","sessionID":"ses_echo_1","text":' + JSON.stringify('argv=[' + argv + ']') + '}\n')
