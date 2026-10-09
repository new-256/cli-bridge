// tests/codebuddy/fixtures/fake-codebuddy.mjs — 伪 codebuddy CLI（自写 fixture，
// 不引用旧包 fixtures/auth|credentials 的任何内容 —— verify gate 9 红线）。
// 模拟 stream-json 输出：init → assistant tool_use → user tool_result → result。
// result 文本回显 process.cwd() 与 argv（供断言会话感知 cwd 回落、白名单护栏、
// --model/--resume/--continue 等旗标）；modelUsage 回报 --model 收到的模型名。
// 环境变量开关：
//   FAKE_CB_EXIT       退出码（默认 success→0，其余→1）
//   FAKE_CB_SUBTYPE    result.subtype（默认 success；如 error_during_execution）
//   FAKE_CB_STDERR     stderr 附写文本
//   FAKE_CB_ERROR      result.error 文本（buildResult 会并进 stderr）
//   FAKE_CB_COUNT_FILE 每次启动追加一行（spawn 次数断言用）
import { appendFileSync } from 'node:fs'

const modelArgIdx = process.argv.indexOf('--model')
const usedModel = modelArgIdx >= 0 ? process.argv[modelArgIdx + 1] : null
const subtype = process.env.FAKE_CB_SUBTYPE || 'success'
if (process.env.FAKE_CB_COUNT_FILE) {
  try { appendFileSync(process.env.FAKE_CB_COUNT_FILE, process.pid + ' ' + process.argv.slice(2).join(' ') + '\n') } catch (e) {}
}
const lines = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-s1' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x.ts' } }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } }),
  JSON.stringify({
    type: 'result',
    subtype: subtype,
    is_error: process.env.FAKE_CB_SUBTYPE ? true : false,
    result: 'cwd=' + process.cwd() + ' model=' + (usedModel || 'cli-default') + ' argv=' + process.argv.slice(2).join(' '),
    session_id: 'fake-s1',
    duration_ms: 1234,
    num_turns: 2,
    ...(usedModel ? { modelUsage: { [usedModel]: { inputTokens: 1, outputTokens: 1 } } } : {}),
    ...(process.env.FAKE_CB_ERROR ? { error: process.env.FAKE_CB_ERROR } : {}),
    usage: { input_tokens: 10, output_tokens: 5 }
  })
]
process.stdout.write(lines.join('\n') + '\n')
if (process.env.FAKE_CB_STDERR) process.stderr.write(process.env.FAKE_CB_STDERR + '\n')
const exitCode = Number(process.env.FAKE_CB_EXIT || 0)
if (process.env.FAKE_CB_HOLD_MS) {
  const t0 = Date.now()
  while (Date.now() - t0 < Number(process.env.FAKE_CB_HOLD_MS)) { /* 保活（挂起守卫用例） */ }
}
process.exit(subtype === 'success' && !process.env.FAKE_CB_EXIT ? exitCode : (exitCode || 1))
