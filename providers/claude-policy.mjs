// providers/claude-policy.mjs — claude 提示词策略段（preset 与 dynamic 两种宿主唯一来源）。
//
// 为什么单独成片：同一段策略文本要在 preset/claude-first/cli-bridge.mjs（ESM 导入）与
// dynamic/claude.host.template.mjs（沙箱内联，禁 import）两处出现；各写一份必然漂移
// （历史上 agy/opencode 两处文案已经出现过不一致）。本文件被 scripts/build.mjs 作为
// providers/claude-*.mjs 之一内联进沙箱同一作用域，故两形态共用同一个常量。
// ⚠️ 注释里绝不写出口令标记字面量（build 全局替换会把注释劈开）。

export const POLICY_TEXT = [
  'claude-first execution policy (local Claude Code CLI bridge).',
  '',
  'Local agent CLI "claude" handles coding tasks under full DSH control (non-interactive -p mode, permissions auto-approved so claude never blocks on a prompt). By default, claude runs in the background and returns a jobId immediately; collect results via job_output and watch live progress via claude_status anytime.',
  '',
  'Decision table for tool selection:',
  '- Single read/glob/grep or short (<30s) command -> Native tools.',
  '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> claude_run.',
  '- Follow-ups on the same topic -> claude_continue (with latest=true or sessionId; claude preserves session context via --resume).',
  '- Final build/test verification of claude output -> Native tools.',
  '',
  'Context protocol (one topic = one claude session):',
  '- First dispatch on a topic: provide the task with a compact CONTEXT preamble (point to paths, do not paste file contents):',
  '  CONTEXT: 2-6 lines — goal; repo root; key paths; decisions/constraints; current state.',
  '  TASK: the complete instruction.',
  '- Follow-ups: call claude_continue and state only what is new.',
  '',
  'Execution & Fallback protocol:',
  '- Dispatch defaults to background=true (set background=false only to block). Collect via job_output.',
  '- mode=auto follows the DSH plan state: in plan mode claude runs with --permission-mode plan (read-only), otherwise permissions are bypassed so long edits/builds never stall on an approval prompt.',
  '- On rate-limit or network failure, a confirmation dialog opens in BOTH foreground and background while in flight.',
  '- If result has fallback=true (status FALLBACK_TO_DSH), the user chose DSH-local: finish with native tools and NEVER call claude again for this task.',
  '- Never loop claude calls; never ask claude to call back into DSH.',
  '',
  'Model & credentials:',
  '- Which model ids actually work is decided by the ENDPOINT, not by this bridge: call claude_models to read the authoritative server-side roster (it probes the endpoint), then pass model. Never trust ANTHROPIC_*_MODEL entries in ~/.claude/settings.json as the usable set — they are alias mappings only.',
  '- Omit the model unless you have a reason: claude then uses its own configuration (or the model chosen in CLI Bridge settings). A rejected model surfaces as a run failure with the supported list in the diagnostic hint — fix the model, do not retry blindly.',
  '- Credentials are owned by claude, not by this bridge: base URL and auth token live in ~/.claude/settings.json (env block). On auth/401 failures tell the user to check that file or re-login; do not retry in a loop.'
].join('\n')
