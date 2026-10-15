// tests/opencode/fixtures/fake-opencode-error.mjs — 假 opencode CLI：API key 无效。
// 形态取自本机实测的真实 401 输出（error.data.message），以退出码 1 结束 ——
// 退出码才是成败判据（不存在 result 事件可依赖）。
process.stdout.write(JSON.stringify({
  type: 'error',
  timestamp: 1792000202362,
  sessionID: '',
  error: { name: 'APIError', data: { message: 'Incorrect API key provided: sk-fake-******only.', statusCode: 401, isRetryable: false } }
}) + '\n')
process.exit(1)
