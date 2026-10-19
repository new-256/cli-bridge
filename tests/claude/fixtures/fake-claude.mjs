// tests/claude/fixtures/fake-claude.mjs — 假 Claude Code CLI（密闭测试用，零依赖）。
//
// 行为严格对齐本机实测 Claude Code 2.0.76 的 stdout 形态：
//   • `--output-format json`        → 单行 result 事件
//   • `--output-format stream-json` → system(init) / assistant(tool_use) /
//                                     user(tool_result) / assistant(text) / result 多行
//   • 无效模型探测（--model __clb_probe_invalid__）→ 服务端 400 报文塞进 result，
//     is_error:true 且 **exit 1**，subtype 仍然是 "success"（真实怪癖，必须保留）
// 环境开关（用环境变量而不是 argv 构造分支，避免 argv 契约被测试反向污染）：
//   FAKE_CLAUDE_MODE=probe-accepts  → 端点接受无效模型（探测拿不到权威清单的场景）
//   FAKE_CLAUDE_MODE=rate-limit     → is_error:true + exit 0（成功判定陷阱的另一半）
//   FAKE_CLAUDE_MODE=no-result      → 输出垃圾（PARSE_ERROR 路径）
const argv = process.argv.slice(2)
const has = (f) => argv.indexOf(f) >= 0
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }
const MODE = process.env.FAKE_CLAUDE_MODE || 'ok'
const SID = 'sid_fake_claude_0001'
const PROBE_MODEL = '__clb_probe_invalid__'

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n') }

function resultEvent(fields) {
  return Object.assign({
    type: 'result', subtype: 'success', is_error: false,
    duration_ms: 1200, duration_api_ms: 1000, num_turns: 1,
    session_id: SID, total_cost_usd: 0.0123,
    usage: { input_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 30, output_tokens: 8 },
    modelUsage: { 'fake-model-alpha': { inputTokens: 150, outputTokens: 8, costUSD: 0.0123 } },
    permission_denials: []
  }, fields)
}

const asked = valueOf('--model')
const isProbe = asked === PROBE_MODEL

if (MODE === 'no-result') {
  process.stdout.write('not json at all\n')
  process.exit(0)
}

if (isProbe) {
  if (MODE === 'probe-accepts') {
    out(resultEvent({ result: 'PONG' }))
    process.exit(0)
  }
  if (MODE === 'rate-limit') {
    out(resultEvent({ is_error: true, result: 'API Error: 429 rate limit exceeded, retry later' }))
    process.exit(0) // 陷阱：退出码 0 但 is_error=true
  }
  // 真实形态：400 报文（自身是 JSON 字符串，转义后塞进 result 字段），exit 1。
  const apiError = 'API Error: 400 ' + JSON.stringify({
    error: {
      message: 'The supported API model names are fake-model-alpha, fake-model-beta, but you passed ' + PROBE_MODEL + '. (request_id: fake-request-id)',
      type: 'invalid_request_error', param: null, code: 'invalid_request_error'
    }
  })
  out(resultEvent({ is_error: true, result: apiError, total_cost_usd: 0, modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 } }))
  process.exit(1)
}

if (MODE === 'rate-limit') {
  out(resultEvent({ is_error: true, result: 'API Error: 429 rate limit exceeded, retry later', session_id: SID }))
  process.exit(0)
}

const text = 'FAKE_CLAUDE_OK'
const stream = valueOf('--output-format') === 'stream-json'
if (stream) {
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: SID, tools: ['Read', 'Bash'], model: 'fake-model-alpha', permissionMode: 'bypassPermissions', claude_code_version: '2.0.76', apiKeySource: 'ANTHROPIC_API_KEY' })
  out({ type: 'assistant', message: { role: 'assistant', model: 'fake-model-alpha', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] }, parent_tool_use_id: null, session_id: SID })
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt' }] }, parent_tool_use_id: null, session_id: SID })
  out({ type: 'assistant', message: { role: 'assistant', model: 'fake-model-alpha', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: SID })
}
out(resultEvent({ result: text, num_turns: 1 }))
process.exit(0)
