// tests/codebuddy/helpers/env.mjs — codebuddy 测试共用小工具。
// 教训（mimo 侧真实事故）：withEnv 必须是 async 版 —— 同步版在 await 之后就还原
// env，并发跑批会把测试值写进真实设置文件。所有碰 env 的用例都必须显式钉
// CLI_BRIDGE_SETTINGS_FILE / CODEBUDDY_SETTINGS_FILE / CODEBUDDY_AUTH_DIR 指向
// tmp，绝不依赖「默认不会碰真文件」。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIX = (f) => fileURLToPath(new URL('../fixtures/' + f, import.meta.url))

export async function withEnv(vars, fn) {
  const prev = {}
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k]
    if (vars[k] === null) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try {
    return await fn()
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

export function freshTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix || 'cbtest-'))
}

// mock subprocess 用的成功 NDJSON（与 fixture 同构：init → tool_use → tool_result
// → result；tokens 10+5=15，modelUsage 单模型 hy3）。
export const CB_NDJSON = [
  '{"type":"system","subtype":"init","session_id":"fake-s1"}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"x.ts"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":false}]}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"fake-s1","duration_ms":1234,"num_turns":2,"modelUsage":{"hy3":{"inputTokens":1,"outputTokens":1}},"usage":{"input_tokens":10,"output_tokens":5}}'
].join('\n') + '\n'

export const CB_NDJSON_TRANSIENT = CB_NDJSON.replace('"subtype":"success","is_error":false', '"subtype":"error_during_execution","is_error":true')
