// providers/codebuddy-schemas.mjs — 三工具 JSON Schema（纯数据，零依赖）。
//
// 旧 preset/codebuddy-first verbatim（契约 §8 红线）：字段名/枚举/描述一字不改。
// 放这里是为了让 catalog 与主描述符都留在 600 行红线内（规则 §26）。
// ⚠️ 注释里绝不写出口令标记字面量（build 全局替换会把注释劈开）。

import { BACKEND_ENUM, MODEL_DESCRIPTION } from './codebuddy-catalog.mjs'

// ── 三工具 schema（旧 preset/codebuddy-first verbatim；契约 §8 红线）────────────
// 纯数据，无依赖 —— 放这里是为了让主描述符留在 600 行红线内（规则 §26）。
export const RUN_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The full task/instruction for codebuddy. Be complete and self-contained.' },
    backend: { type: 'string', enum: BACKEND_ENUM, description: 'Which CLI face to dispatch to. codebuddy (default; domestic CodeBuddy npm CLI, product endpoint www.codebuddy.ai) for coding work; codebuddy-intl = CodeBuddy INTERNATIONAL face of the same npm CLI (product.ioa.json catalogue: claude-sonnet-5 / claude-opus-5 / gemini-3.1-pro / gpt-6-astra / hy3-ioa ...; aliases codebuddy-ioa / codebuddy-international) when the account is an international CodeBuddy account; codebuddy-en = WorkBuddy international edition (the WorkBuddyAI desktop bundled CLI at C:\\Program Files\\WorkBuddyAI, product endpoint www.workbuddy.ai; needs codebuddyEnToken unless DSH already holds a workbuddy key) — aliases workbuddy-en / workbuddy-ai also accepted; workbuddy = WorkBuddy domestic desktop CLI (product endpoint copilot.tencent.com, zero config), the office-scenario face: documents/slides/spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies. New calls without a backend follow the user-preferred default backend (plugin settings). Continuing a session routes back to its owning backend automatically.' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'auto follows DSH plan state; plan = no writes; accept-edits = allow edits. Default auto.' },
    model: { type: 'string', description: MODEL_DESCRIPTION },
    effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' },
    maxTurns: { type: 'integer', description: 'Optional max agentic turns (1-500, default unlimited).' },
    cwd: { type: 'string', description: 'Working directory for codebuddy. Defaults to the DSH workspace root.' },
    addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to add to codebuddy workspace.' },
    timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' },
    background: { type: 'boolean', description: 'Run as a background job and return a jobId immediately.' }
  }
}
export const CONTINUE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing codebuddy conversation.' },
    sessionId: { type: 'string', description: 'codebuddy session id to resume (from a prior codebuddy_run result).' },
    latest: { type: 'boolean', description: 'Continue the most recent codebuddy conversation instead of a specific id.' },
    backend: { type: 'string', enum: BACKEND_ENUM, description: 'Which CLI face to resume on. codebuddy-en = WorkBuddy international (WorkBuddyAI desktop CLI; aliases workbuddy-en / workbuddy-ai accepted), workbuddy = WorkBuddy domestic desktop CLI. When omitted, the backend that owns the sessionId is used automatically; brand-new conversations follow the user-preferred default backend (plugin settings).' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'Execution mode; default auto.' },
    model: { type: 'string', description: 'Optional model id (two layers: product face carries it, account licenses it; the credit multiplier of each id comes from the CLI descriptor — see codebuddy_run).' },
    effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' },
    maxTurns: { type: 'integer', description: 'Optional max agentic turns.' },
    cwd: { type: 'string', description: "Working directory for codebuddy; when resuming, defaults to the resumed session's project directory." },
    timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' },
    background: { type: 'boolean', description: 'Run as a background job and return a jobId immediately.' }
  }
}
export const STATUS_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }
