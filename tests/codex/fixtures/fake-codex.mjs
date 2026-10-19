// tests/codex/fixtures/fake-codex.mjs — 假 codex CLI：打印真实形态的 --json 事件流。
//
// 事件形状逐字对齐 codex-cli 0.98.0 实测：thread.started / turn.started /
// item.started / item.completed / turn.completed（失败另加顶层 error + turn.failed）。
// 供 MCP 形态测试经 CODEX_BIN（.mjs → node 包装）spawn；不依赖机器上真装了 codex。
//
// 环境开关（测试用）：
//   CODEX_FAKE_MODE=ok|error|incomplete|plain|badargs
//   CODEX_FAKE_ECHO=1        在回复正文里带上收到的 prompt（验证位置参数没错位）
//   CODEX_FAKE_ARGV_FILE=<p> 把 argv 写成 JSON（验证 argv 契约）
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const mode = process.env.CODEX_FAKE_MODE || 'ok'
const THREAD_OK = '01a154f6-06c9-7011-a742-e532461b9b74'
const THREAD_LAST = '01a154f6-698f-7400-8d1b-02197a52b4f8'

if (process.env.CODEX_FAKE_ARGV_FILE) {
  try { writeFileSync(process.env.CODEX_FAKE_ARGV_FILE, JSON.stringify(argv), 'utf8') } catch (e) { /* 夹具尽力而为 */ }
}

// argv 形如 exec resume <sid|--last> --json … <prompt>；prompt 恒为最后一个参数。
const resumeAt = argv.indexOf('resume')
const resumeArg = resumeAt >= 0 ? String(argv[resumeAt + 1] || '') : ''
const isResume = resumeAt >= 0
const threadId = isResume ? (resumeArg && resumeArg !== '--last' ? resumeArg : THREAD_LAST) : THREAD_OK
const prompt = argv.length ? String(argv[argv.length - 1]) : ''

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n') }

if (mode === 'badargs') {
  process.stderr.write("error: unexpected argument '-a' found\n\nUsage: codex exec [OPTIONS] [PROMPT] [COMMAND]\n")
  process.exit(2)
}

if (mode === 'plain') {
  // 不带 --json 时的形态：stdout 就是纯文本答复。
  process.stderr.write('OpenAI Codex v0.98.0 (research preview)\n--------\nworkdir: C:\\fixture\nmodel: fixture/model-one\nprovider: custom\napproval: never\n')
  process.stdout.write('PLAIN_CODEX_OK\n')
  process.exit(0)
}

emit({ type: 'thread.started', thread_id: threadId })

if (mode === 'error') {
  emit({ type: 'turn.started' })
  emit({ type: 'error', message: String(process.env.CODEX_FAKE_ERROR || '__probe_invalid__ is not a valid model ID') })
  emit({ type: 'turn.failed', error: { message: String(process.env.CODEX_FAKE_ERROR || '__probe_invalid__ is not a valid model ID') } })
  process.exit(1)
}

if (mode === 'incomplete') {
  emit({ type: 'turn.started' })
  process.exit(0)
}

// ok：包含一次命令执行（item.started→item.completed 同一 id，验证折叠去重）、
// 一条【告警】item（type=error —— 实测续聊会带，绝不可当致命错）、以及 agent_message。
if (isResume) {
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'This session was recorded with model `a` but is resuming with `b`.' } })
}
emit({ type: 'turn.started' })
emit({ type: 'item.started', item: { id: 'item_cmd', type: 'command_execution', command: 'powershell.exe -Command "Get-Location"', aggregated_output: '', exit_code: null, status: 'in_progress' } })
emit({ type: 'item.completed', item: { id: 'item_cmd', type: 'command_execution', command: 'powershell.exe -Command "Get-Location"', aggregated_output: 'C:\\fixture\n', exit_code: 0, status: 'completed' } })
const text = process.env.CODEX_FAKE_ECHO === '1' ? 'FAKE_CODEX_OK prompt=' + prompt : 'FAKE_CODEX_OK'
emit({ type: 'item.completed', item: { id: 'item_msg', type: 'agent_message', text } })
emit({ type: 'turn.completed', usage: { input_tokens: 17205, cached_input_tokens: 7809, output_tokens: 3 } })
process.exit(0)
